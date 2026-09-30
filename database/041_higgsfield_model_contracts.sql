-- Current company-specific provider metadata. This is compatibility evidence,
-- not authority to disclose media or spend credits. Unsupported observations
-- replace earlier support rather than leaving an obsolete cache usable.
CREATE TABLE higgsfield_model_contracts (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 model_id text NOT NULL CHECK(model_id~'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'),
 connection_id uuid NOT NULL,connection_revision integer NOT NULL CHECK(connection_revision>0),
 catalog_sha256 text NOT NULL CHECK(catalog_sha256~'^[a-f0-9]{64}$'),
 descriptor jsonb,descriptor_sha256 text,
 observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '15 minutes',
 PRIMARY KEY(company_id,model_id),
 CHECK((descriptor IS NULL)=(descriptor_sha256 IS NULL)),
 CHECK(descriptor IS NULL OR (jsonb_typeof(descriptor)='object' AND descriptor_sha256~'^[a-f0-9]{64}$')),
 CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '15 minutes')
);
ALTER TABLE higgsfield_requests ADD COLUMN model_snapshot jsonb,
 ADD CONSTRAINT higgsfield_request_model_shape CHECK(model_snapshot IS NULL OR (jsonb_typeof(model_snapshot)='object' AND reference_snapshot IS NOT NULL));
