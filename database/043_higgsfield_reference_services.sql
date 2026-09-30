-- Operator-enrolled, finite service identities. Session/agent APIs cannot insert
-- qualification facts or mint a service credential. No row activates a host.
CREATE TABLE higgsfield_reference_services (
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 enrolled_by uuid NOT NULL REFERENCES users(id),
 release_sha256 text NOT NULL CHECK(release_sha256~'^[a-f0-9]{64}$'),
 qualification_sha256 text NOT NULL CHECK(qualification_sha256~'^[a-f0-9]{64}$'),
 profile_sha256 text NOT NULL CHECK(profile_sha256~'^[a-f0-9]{64}$'),
 provider_connection_id uuid NOT NULL,provider_connection_revision integer NOT NULL CHECK(provider_connection_revision>0),
 catalog_sha256 text NOT NULL CHECK(catalog_sha256~'^[a-f0-9]{64}$'),
 upload_hosts jsonb NOT NULL CHECK(jsonb_typeof(upload_hosts)='array' AND jsonb_array_length(upload_hosts) BETWEEN 1 AND 8),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
 revoked_at timestamptz,revoked_by uuid REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(company_id,id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '60 minutes'),CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE TABLE higgsfield_reference_service_projects (
 service_id uuid NOT NULL,company_id uuid NOT NULL,project_id uuid NOT NULL,
 storage_binding_id uuid NOT NULL,storage_binding_revision integer NOT NULL CHECK(storage_binding_revision>0),
 storage_connection_id uuid NOT NULL,storage_connection_revision integer NOT NULL CHECK(storage_connection_revision>0),
 PRIMARY KEY(service_id,project_id),UNIQUE(company_id,project_id,service_id),
 FOREIGN KEY(company_id,service_id) REFERENCES higgsfield_reference_services(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,storage_binding_id) REFERENCES project_storage_bindings(company_id,project_id,id),
 FOREIGN KEY(company_id,storage_connection_id) REFERENCES project_storage_connections(company_id,id)
);
CREATE TABLE higgsfield_reference_service_leases (
 service_id uuid NOT NULL,company_id uuid NOT NULL,project_id uuid NOT NULL,reference_id uuid NOT NULL,
 lease_id uuid PRIMARY KEY,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 lease jsonb NOT NULL CHECK(jsonb_typeof(lease)='object'),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),UNIQUE(service_id,lease_id),
 FOREIGN KEY(company_id,project_id,service_id) REFERENCES higgsfield_reference_service_projects(company_id,project_id,service_id),
 FOREIGN KEY(company_id,project_id,reference_id) REFERENCES higgsfield_references(company_id,project_id,id)
);
CREATE TABLE higgsfield_reference_service_calls (
 service_id uuid NOT NULL REFERENCES higgsfield_reference_services(id),request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('claim','read-proxy','inspection','allocate','begin-put','complete-put','confirm','fail')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('started','completed')),response jsonb,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),finished_at timestamptz,
 PRIMARY KEY(service_id,request_id),CHECK((status='completed')=(response IS NOT NULL) AND (status='completed')=(finished_at IS NOT NULL))
);
CREATE TABLE higgsfield_reference_service_reads (
 service_id uuid NOT NULL REFERENCES higgsfield_reference_services(id),lease_id uuid PRIMARY KEY,
 request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(service_id,request_id) REFERENCES higgsfield_reference_service_calls(service_id,request_id),
 FOREIGN KEY(service_id,lease_id) REFERENCES higgsfield_reference_service_leases(service_id,lease_id)
);
-- Claims under the new broker identity cannot reset or jump an attempt count.
-- The app role remains denied UPDATE(inspection_attempts) independently.
CREATE FUNCTION guard_higgsfield_reference_broker_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='coatria_higgsfield_reference_broker_v1' AND (
  NEW.inspection_attempts IS DISTINCT FROM OLD.inspection_attempts OR
  (NEW.status='inspecting' AND NEW.inspection_authority IS NOT NULL AND
   (OLD.status<>'inspecting' OR NEW.lease_id IS DISTINCT FROM OLD.lease_id OR
    (OLD.lease_expires_at<=clock_timestamp() AND NEW.lease_expires_at>clock_timestamp())))) THEN
  IF NOT (NEW.inspection_attempts=OLD.inspection_attempts+1 AND NEW.inspection_attempts<=3
   AND OLD.inspection_authority IS NOT NULL AND OLD.approved_by IS NULL AND OLD.revoked_at IS NULL
   AND OLD.status IN ('proposed','inspecting') AND (OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp())
   AND NEW.status='inspecting' AND NEW.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id
   AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=OLD.inspect_expires_at
   AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds') THEN
   RAISE EXCEPTION 'reference inspection attempt transition rejected' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER higgsfield_reference_broker_attempts BEFORE UPDATE ON higgsfield_references
 FOR EACH ROW EXECUTE FUNCTION guard_higgsfield_reference_broker_attempts();
CREATE FUNCTION guard_higgsfield_reference_service_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','response','finished_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','response','finished_at'])
  OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)
  OR (NEW IS DISTINCT FROM OLD AND NOT (OLD.status='started' AND NEW.status='completed')) THEN
  RAISE EXCEPTION 'reference service receipt is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER higgsfield_reference_service_call_immutable BEFORE UPDATE ON higgsfield_reference_service_calls
 FOR EACH ROW EXECUTE FUNCTION guard_higgsfield_reference_service_call();
CREATE FUNCTION guard_higgsfield_reference_service_stop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='coatria_runtime_v1' AND NOT (
  OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at<=clock_timestamp() AND NEW.revoked_by IS NOT NULL
  AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
  AND (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revision','updated_at'])
 ) THEN RAISE EXCEPTION 'reference service can only be stopped' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER higgsfield_reference_service_stop BEFORE UPDATE ON higgsfield_reference_services
 FOR EACH ROW EXECUTE FUNCTION guard_higgsfield_reference_service_stop();
