-- Short-lived executor credentials are bound to one immutable archive policy.
-- Envelopes never appear in API responses or deployment presets.
CREATE TABLE company_runtime_executor_credentials (
 id uuid PRIMARY KEY,company_id uuid NOT NULL,kind text NOT NULL DEFAULT 'archive' CHECK(kind='archive'),
 configuration_id uuid NOT NULL,client_id uuid NOT NULL,
 token_hash text NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 sealed jsonb NOT NULL CHECK(jsonb_typeof(sealed)='object' AND octet_length(sealed::text)<20000),
 expires_at timestamptz NOT NULL,created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,revoked_by uuid REFERENCES users(id),
 FOREIGN KEY(company_id,kind,configuration_id) REFERENCES company_runtime_configurations(company_id,kind,id),
 UNIQUE(company_id,configuration_id,client_id),CHECK(expires_at>created_at),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE UNIQUE INDEX company_runtime_executor_active ON company_runtime_executor_credentials(company_id,configuration_id) WHERE revoked_at IS NULL;
CREATE FUNCTION coatria_executor_credential_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Executor credential history is immutable' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-'revoked_at'-'revoked_by') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
  RAISE EXCEPTION 'Only first revocation is permitted' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER company_runtime_executor_immutable BEFORE UPDATE OR DELETE ON company_runtime_executor_credentials FOR EACH ROW EXECUTE FUNCTION coatria_executor_credential_immutable();
