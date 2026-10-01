-- Platform deployment authority is separate from company membership. Only the
-- database administrator seeds/revokes these grants; the application reads them.
CREATE TABLE platform_operator_grants (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 capability text NOT NULL DEFAULT 'company_runtime:configure' CHECK(capability='company_runtime:configure'),
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 CHECK(expires_at>granted_at)
);

-- Row locks require UPDATE privilege in PostgreSQL. This narrow read-only
-- definer allows revocation to serialize with an operator action without
-- allowing the runtime role to mint, renew or revoke an operator grant.
CREATE FUNCTION coatria_lock_platform_runtime_operator(actor uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE grant_row public.platform_operator_grants%ROWTYPE;
BEGIN
 SELECT * INTO grant_row FROM public.platform_operator_grants WHERE user_id=actor FOR SHARE;
 RETURN FOUND AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION coatria_lock_platform_runtime_operator(uuid) FROM PUBLIC;

CREATE TABLE company_runtime_configurations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),
 kind text NOT NULL CHECK(kind IN ('managed_agent','archive','gateway')),
 phase text NOT NULL CHECK(phase IN ('preflight','service')),
 preset jsonb NOT NULL CHECK(jsonb_typeof(preset)='object' AND octet_length(preset::text)<=200000),
 configuration_hash text NOT NULL CHECK(configuration_hash~'^[a-f0-9]{64}$'),
 worker_volume_id text,expires_at timestamptz NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,kind,id),CHECK(expires_at>created_at),
 CHECK((kind='managed_agent' AND phase='service' AND worker_volume_id IS NOT NULL) OR (kind<>'managed_agent' AND worker_volume_id IS NULL))
);
CREATE INDEX company_runtime_volume_history ON company_runtime_configurations(worker_volume_id,company_id) WHERE worker_volume_id IS NOT NULL;
CREATE TABLE company_runtime_selections (
 company_id uuid NOT NULL,kind text NOT NULL,configuration_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('active','revoked')),
 selected_by uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,kind),
 FOREIGN KEY(company_id,kind,configuration_id) REFERENCES company_runtime_configurations(company_id,kind,id)
);
CREATE TABLE company_runtime_requests (
 company_id uuid NOT NULL REFERENCES companies(id),user_id uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('managed_agent','archive','gateway')),
 operation text NOT NULL CHECK(operation IN ('select','revoke')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,user_id,client_id)
);
CREATE FUNCTION coatria_runtime_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Company runtime history is immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER company_runtime_configurations_immutable BEFORE UPDATE OR DELETE ON company_runtime_configurations FOR EACH ROW EXECUTE FUNCTION coatria_runtime_history_immutable();
CREATE TRIGGER company_runtime_requests_immutable BEFORE UPDATE OR DELETE ON company_runtime_requests FOR EACH ROW EXECUTE FUNCTION coatria_runtime_history_immutable();
