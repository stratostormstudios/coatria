-- Finite operator enrollment and transport evidence for the existing 045/046
-- preparation state machine. No role, credential, processor or grant activation.
CREATE TABLE project_image_preparation_services (
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),enrolled_by uuid NOT NULL REFERENCES users(id),
 sponsor_role text NOT NULL CHECK(sponsor_role IN ('owner','admin')),sponsor_joined_at timestamptz NOT NULL,
 location text NOT NULL CHECK(length(location) BETWEEN 1 AND 200),
 release_sha256 text NOT NULL CHECK(release_sha256~'^[a-f0-9]{64}$'),qualification_sha256 text NOT NULL CHECK(qualification_sha256~'^[a-f0-9]{64}$'),
 profile_sha256 text NOT NULL CHECK(profile_sha256~'^[a-f0-9]{64}$'),source_commit text NOT NULL CHECK(source_commit~'^[a-f0-9]{40}$'),
 closure_sha256 text NOT NULL CHECK(closure_sha256~'^[a-f0-9]{64}$'),recipe_sha256 text NOT NULL CHECK(recipe_sha256~'^[a-f0-9]{64}$'),
 transport text NOT NULL CHECK(transport='linux_binary_v1'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
 revoked_at timestamptz,revoked_by uuid REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(company_id,id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '60 minutes'),CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE TABLE project_image_preparation_service_projects (
 service_id uuid NOT NULL,company_id uuid NOT NULL,project_id uuid NOT NULL,project_revision integer NOT NULL CHECK(project_revision>0),
 storage_binding_id uuid NOT NULL,storage_binding_revision integer NOT NULL CHECK(storage_binding_revision>0),
 storage_connection_id uuid NOT NULL,storage_connection_revision integer NOT NULL CHECK(storage_connection_revision>0),
 gateway_binding_id uuid NOT NULL,gateway_provision_id uuid NOT NULL,gateway_configuration_sha256 text NOT NULL CHECK(gateway_configuration_sha256~'^[a-f0-9]{64}$'),
 gateway_origin text NOT NULL CHECK(length(gateway_origin) BETWEEN 1 AND 512),gateway_expires_at timestamptz NOT NULL,
 PRIMARY KEY(service_id,project_id),UNIQUE(company_id,project_id,service_id),
 FOREIGN KEY(company_id,service_id) REFERENCES project_image_preparation_services(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,storage_binding_id) REFERENCES project_storage_bindings(company_id,project_id,id),
 FOREIGN KEY(company_id,storage_connection_id) REFERENCES project_storage_connections(company_id,id)
);
CREATE TABLE project_image_preparation_service_enrollments (
 service_id uuid PRIMARY KEY,company_id uuid NOT NULL,request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object' AND octet_length(identity::text)<=65536),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(company_id,request_id),FOREIGN KEY(company_id,service_id) REFERENCES project_image_preparation_services(company_id,id) ON DELETE CASCADE,
 CHECK(identity->>'serviceId'=service_id::text AND identity->>'companyId'=company_id::text AND identity->>'requestId'=request_id::text)
);
CREATE TABLE project_image_preparation_service_leases (
 service_id uuid NOT NULL,company_id uuid NOT NULL,project_id uuid NOT NULL,preparation_id uuid NOT NULL,
 lease_id uuid PRIMARY KEY,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 lease jsonb NOT NULL CHECK(jsonb_typeof(lease)='object' AND octet_length(lease::text)<=32768),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(service_id,lease_id),UNIQUE(company_id,project_id,preparation_id,lease_id),UNIQUE(company_id,preparation_id),
 FOREIGN KEY(company_id,project_id,service_id) REFERENCES project_image_preparation_service_projects(company_id,project_id,service_id),
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparations(company_id,project_id,id)
);
CREATE TABLE project_image_preparation_service_calls (
 service_id uuid NOT NULL REFERENCES project_image_preparation_services(id),request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('readiness','claim','authorize','source','begin-transform','complete-transform','reserve-output','begin-store','complete-store','byte-capability','publish','fail')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),deadline_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('started','completed')),response jsonb,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),finished_at timestamptz,
 PRIMARY KEY(service_id,request_id),CHECK((status='completed')=(response IS NOT NULL) AND (status='completed')=(finished_at IS NOT NULL)),
 CHECK(response IS NULL OR octet_length(response::text)<=65536)
);
CREATE TABLE project_image_preparation_byte_grants (
 id uuid PRIMARY KEY,service_id uuid NOT NULL,company_id uuid NOT NULL,project_id uuid NOT NULL,preparation_id uuid NOT NULL,lease_id uuid NOT NULL,
 request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN ('read-source','initiate','part','complete','read-output')),action_id uuid,
 version_id uuid NOT NULL,upload_id uuid,bytes bigint NOT NULL CHECK(bytes>0),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 content_type text NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),expected_etag text CHECK(length(expected_etag) BETWEEN 1 AND 256),
 storage_binding_id uuid NOT NULL,storage_binding_revision integer NOT NULL CHECK(storage_binding_revision>0),storage_connection_id uuid NOT NULL,storage_connection_revision integer NOT NULL CHECK(storage_connection_revision>0),
 gateway_binding_id uuid NOT NULL,gateway_provision_id uuid NOT NULL,gateway_configuration_sha256 text NOT NULL CHECK(gateway_configuration_sha256~'^[a-f0-9]{64}$'),gateway_origin text NOT NULL CHECK(length(gateway_origin) BETWEEN 1 AND 512),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(preparation_id,lease_id,operation),
 FOREIGN KEY(service_id,lease_id) REFERENCES project_image_preparation_service_leases(service_id,lease_id),
 FOREIGN KEY(company_id,project_id,preparation_id,lease_id) REFERENCES project_image_preparation_service_leases(company_id,project_id,preparation_id,lease_id),
 FOREIGN KEY(service_id,request_id) REFERENCES project_image_preparation_service_calls(service_id,request_id),
 FOREIGN KEY(company_id,project_id,version_id) REFERENCES project_storage_versions(company_id,project_id,id),
 CHECK((operation IN ('read-source','read-output'))=(action_id IS NULL)),
 CHECK((operation IN ('read-source','read-output'))=(expected_etag IS NOT NULL)),
 CHECK((operation='read-source')=(upload_id IS NULL)),CHECK(bytes<=CASE WHEN operation='read-source' THEN 33554432 ELSE 10485760 END),
 CHECK(operation='read-source' OR content_type='image/png'),CHECK(expires_at>created_at AND expires_at<=created_at+interval '120 seconds')
);
-- Gateway alone writes these results. Control consumes them; a processor's
-- echoed DTO is not provider evidence. A started row is never automatically retried.
CREATE TABLE project_image_preparation_byte_results (
 grant_id uuid PRIMARY KEY REFERENCES project_image_preparation_byte_grants(id),
 status text NOT NULL CHECK(status IN ('started','completed')),public_result jsonb,provider_result jsonb,
 observed_bytes bigint CHECK(observed_bytes>0),observed_sha256 text CHECK(observed_sha256~'^[a-f0-9]{64}$'),observed_etag text CHECK(length(observed_etag) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),finished_at timestamptz,
 CHECK((status='completed')=(public_result IS NOT NULL) AND (status='completed')=(finished_at IS NOT NULL)),
 CHECK(public_result IS NULL OR jsonb_typeof(public_result)='object' AND octet_length(public_result::text)<=32768),
 CHECK(provider_result IS NULL OR jsonb_typeof(provider_result)='object' AND octet_length(provider_result::text)<=32768)
);

CREATE FUNCTION guard_image_preparation_service_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'preparation service evidence is immutable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_preparation_service_project_immutable BEFORE UPDATE ON project_image_preparation_service_projects FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_immutable();
CREATE TRIGGER image_preparation_service_enrollment_immutable BEFORE UPDATE ON project_image_preparation_service_enrollments FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_immutable();
CREATE TRIGGER image_preparation_service_lease_immutable BEFORE UPDATE ON project_image_preparation_service_leases FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_immutable();
CREATE TRIGGER image_preparation_byte_grant_immutable BEFORE UPDATE ON project_image_preparation_byte_grants FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_immutable();
ALTER TABLE project_image_preparation_service_projects ENABLE ALWAYS TRIGGER image_preparation_service_project_immutable;
ALTER TABLE project_image_preparation_service_enrollments ENABLE ALWAYS TRIGGER image_preparation_service_enrollment_immutable;
ALTER TABLE project_image_preparation_service_leases ENABLE ALWAYS TRIGGER image_preparation_service_lease_immutable;
ALTER TABLE project_image_preparation_byte_grants ENABLE ALWAYS TRIGGER image_preparation_byte_grant_immutable;
CREATE FUNCTION guard_image_preparation_service_stop() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD AND NOT (
  OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at<=clock_timestamp() AND NEW.revoked_by IS NOT NULL
  AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
  AND (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revision','updated_at'])
 ) THEN RAISE EXCEPTION 'preparation service can only be stopped' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_preparation_service_stop BEFORE UPDATE ON project_image_preparation_services FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_stop();
ALTER TABLE project_image_preparation_services ENABLE ALWAYS TRIGGER image_preparation_service_stop;
CREATE FUNCTION guard_image_preparation_service_result() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'started' THEN RAISE EXCEPTION 'preparation operation must start before external work' USING ERRCODE='23514';END IF;
 ELSIF (to_jsonb(NEW)-TG_ARGV::text[]) IS DISTINCT FROM (to_jsonb(OLD)-TG_ARGV::text[])
  OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)
  OR (NEW IS DISTINCT FROM OLD AND NOT (OLD.status='started' AND NEW.status='completed')) THEN
  RAISE EXCEPTION 'preparation operation result is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_preparation_service_call_result BEFORE INSERT OR UPDATE ON project_image_preparation_service_calls FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_result('status','response','finished_at');
CREATE TRIGGER image_preparation_byte_result BEFORE INSERT OR UPDATE ON project_image_preparation_byte_results FOR EACH ROW EXECUTE FUNCTION guard_image_preparation_service_result('status','public_result','provider_result','observed_bytes','observed_sha256','observed_etag','finished_at');
ALTER TABLE project_image_preparation_service_calls ENABLE ALWAYS TRIGGER image_preparation_service_call_result;
ALTER TABLE project_image_preparation_byte_results ENABLE ALWAYS TRIGGER image_preparation_byte_result;
CREATE FUNCTION validate_image_preparation_service_lease() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM project_image_preparations p JOIN project_image_preparation_approvals a ON a.company_id=p.company_id AND a.preparation_id=p.id
  JOIN project_image_preparation_services s ON s.company_id=p.company_id AND s.id=NEW.service_id
  WHERE p.company_id=NEW.company_id AND p.project_id=NEW.project_id AND p.id=NEW.preparation_id AND p.lease_id=NEW.lease_id
   AND p.status='reading' AND p.attempt=1 AND p.revoked_at IS NULL AND p.lease_expires_at>clock_timestamp()
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()
   AND a.processor_snapshot->>'id'=s.id::text AND a.processor_snapshot=NEW.lease->'processor'
   AND NEW.request_hash=p.request_hash AND NEW.lease->>'companyId'=p.company_id::text AND NEW.lease->>'projectId'=p.project_id::text
   AND NEW.lease->>'preparationId'=p.id::text AND NEW.lease->>'leaseId'=p.lease_id::text AND NEW.lease->>'requestHash'=p.request_hash
   AND NEW.lease->>'recipeSha256'=p.recipe_sha256 AND (NEW.lease->>'expiresAt')::timestamptz=date_trunc('milliseconds',p.lease_expires_at)
   AND (NEW.lease->>'claimedAt')::timestamptz=date_trunc('milliseconds',p.claimed_at)
   AND NEW.lease->'source'=p.source_snapshot-ARRAY['objectKey','providerEtag']) THEN
  RAISE EXCEPTION 'preparation service lease differs from exact claim' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_preparation_service_lease_guard BEFORE INSERT ON project_image_preparation_service_leases FOR EACH ROW EXECUTE FUNCTION validate_image_preparation_service_lease();
CREATE FUNCTION validate_image_preparation_byte_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p project_image_preparations; a project_image_preparation_approvals; allocation project_image_preparation_allocations; s project_image_preparation_services; scope project_image_preparation_service_projects; call project_image_preparation_service_calls;
BEGIN
 SELECT * INTO p FROM project_image_preparations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.preparation_id;
 SELECT * INTO a FROM project_image_preparation_approvals WHERE company_id=NEW.company_id AND preparation_id=NEW.preparation_id;
 SELECT * INTO s FROM project_image_preparation_services WHERE company_id=NEW.company_id AND id=NEW.service_id;
 SELECT * INTO scope FROM project_image_preparation_service_projects WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND service_id=NEW.service_id;
 SELECT * INTO call FROM project_image_preparation_service_calls WHERE service_id=NEW.service_id AND request_id=NEW.request_id;
 IF NOT (p.id IS NOT NULL AND a.preparation_id IS NOT NULL AND s.id IS NOT NULL AND scope.service_id IS NOT NULL AND call.request_id IS NOT NULL
  AND call.operation='byte-capability' AND call.status='started' AND call.deadline_at>clock_timestamp()
  AND p.attempt=1 AND p.lease_id=NEW.lease_id AND p.request_hash=NEW.request_hash AND p.revoked_at IS NULL AND p.cleanup_confirmed_at IS NULL
  AND s.revoked_at IS NULL AND a.processor_snapshot->>'id'=s.id::text
  AND NEW.expires_at<=LEAST(p.lease_expires_at,a.expires_at,s.expires_at,scope.gateway_expires_at,call.deadline_at,(a.processor_snapshot->>'expiresAt')::timestamptz)
  AND NEW.expires_at>clock_timestamp() AND NEW.storage_binding_id=p.storage_binding_id AND NEW.storage_connection_id=p.storage_connection_id
  AND NEW.storage_connection_revision=p.storage_connection_revision
  AND NEW.gateway_binding_id=scope.gateway_binding_id AND NEW.gateway_provision_id=scope.gateway_provision_id
  AND NEW.gateway_configuration_sha256=scope.gateway_configuration_sha256 AND NEW.gateway_origin=scope.gateway_origin) IS TRUE THEN
  RAISE EXCEPTION 'preparation capability authority changed' USING ERRCODE='23514';END IF;
 IF NEW.operation='read-source' THEN
  IF NOT (p.status='reading' AND NEW.version_id=p.source_version_id AND NEW.storage_binding_revision=p.storage_binding_revision
   AND NEW.bytes=(p.source_snapshot->>'bytes')::bigint AND NEW.sha256=p.source_snapshot->>'sha256'
   AND NEW.content_type=p.source_snapshot->>'contentType' AND NEW.expected_etag=p.source_snapshot->>'providerEtag') IS TRUE THEN
   RAISE EXCEPTION 'preparation source capability changed' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO allocation FROM project_image_preparation_allocations WHERE company_id=p.company_id AND preparation_id=p.id;
  IF NOT (allocation.preparation_id IS NOT NULL AND NEW.version_id=allocation.version_id AND NEW.upload_id=allocation.upload_id
   AND NEW.storage_binding_revision=allocation.binding_revision_after AND NEW.bytes=allocation.output_bytes AND NEW.sha256=allocation.output_sha256
   AND ((NEW.operation='read-output' AND p.status='verifying' AND NEW.expected_etag IS NOT NULL)
    OR (NEW.operation<>'read-output' AND p.status='storing' AND EXISTS(SELECT 1 FROM project_storage_uploads u
     WHERE u.company_id=p.company_id AND u.id=allocation.upload_id AND u.action_id=NEW.action_id AND u.action_expires_at>clock_timestamp())
     AND EXISTS(SELECT 1 FROM project_image_preparation_receipts r WHERE r.company_id=p.company_id AND r.preparation_id=p.id AND r.action_id=NEW.action_id AND r.operation='store_'||NEW.operation AND r.phase='intent')))) IS TRUE THEN
   RAISE EXCEPTION 'preparation derivative capability changed' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_preparation_byte_grant_guard BEFORE INSERT ON project_image_preparation_byte_grants FOR EACH ROW EXECUTE FUNCTION validate_image_preparation_byte_grant();
ALTER TABLE project_image_preparation_service_leases ENABLE ALWAYS TRIGGER image_preparation_service_lease_guard;
ALTER TABLE project_image_preparation_byte_grants ENABLE ALWAYS TRIGGER image_preparation_byte_grant_guard;
CREATE FUNCTION validate_image_preparation_byte_result() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE grant_row project_image_preparation_byte_grants;
BEGIN
 SELECT * INTO grant_row FROM project_image_preparation_byte_grants WHERE id=NEW.grant_id;
 IF grant_row.id IS NULL THEN RAISE EXCEPTION 'preparation transport grant is missing' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF grant_row.expires_at<=clock_timestamp() OR NEW.provider_result IS NOT NULL OR NEW.observed_bytes IS NOT NULL OR NEW.observed_sha256 IS NOT NULL OR NEW.observed_etag IS NOT NULL THEN
   RAISE EXCEPTION 'preparation transport must start empty within its grant' USING ERRCODE='23514';END IF;
 ELSIF NEW.status='completed' THEN
  IF NOT ((grant_row.operation IN ('read-source','read-output'))=(NEW.provider_result IS NULL)
   AND (grant_row.operation NOT IN ('read-source','read-output','part') OR (NEW.observed_bytes=grant_row.bytes AND NEW.observed_sha256=grant_row.sha256))
   AND (grant_row.operation NOT IN ('read-source','read-output') OR NEW.observed_etag=grant_row.expected_etag)
   AND (grant_row.operation<>'complete' OR NEW.observed_etag IS NOT NULL)) IS TRUE THEN
   RAISE EXCEPTION 'preparation transport result differs from exact bytes' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_preparation_byte_result_guard BEFORE INSERT OR UPDATE ON project_image_preparation_byte_results FOR EACH ROW EXECUTE FUNCTION validate_image_preparation_byte_result();
ALTER TABLE project_image_preparation_byte_results ENABLE ALWAYS TRIGGER image_preparation_byte_result_guard;
