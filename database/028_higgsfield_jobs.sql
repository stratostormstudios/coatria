-- Existing policies retain their exact reviewed stages. References are opt-in.
ALTER TABLE studio_review_policies DROP CONSTRAINT studio_review_policies_allowed_stages_check;
ALTER TABLE studio_review_policies ADD CONSTRAINT studio_review_policies_allowed_stages_check
 CHECK(jsonb_typeof(allowed_stages)='array' AND allowed_stages<@'["estimate","breakdown","ingest","references"]'::jsonb);

-- Never infer the provider account identity for historical requests.
ALTER TABLE higgsfield_requests ADD COLUMN connection_id uuid,
 ADD CONSTRAINT higgsfield_requests_project_identity UNIQUE(company_id,project_id,id);

CREATE TABLE higgsfield_job_receipts (
 request_id uuid PRIMARY KEY,company_id uuid NOT NULL,project_id uuid NOT NULL,
 connection_id uuid NOT NULL,connection_revision integer NOT NULL CHECK(connection_revision>0),
 approved_by uuid NOT NULL REFERENCES users(id),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 contract text NOT NULL,source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('jobs','choice','rejected','unsupported')),
 diagnostic_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,request_id),
 FOREIGN KEY(company_id,project_id,request_id) REFERENCES higgsfield_requests(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE higgsfield_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,request_id uuid NOT NULL,
 connection_id uuid NOT NULL,provider_job_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('image','video','audio')),model text,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','unresolved','blocked','conflict')),
 diagnostic_code text,poll_attempts integer NOT NULL DEFAULT 0 CHECK(poll_attempts BETWEEN 0 AND 1440),
 next_poll_at timestamptz,poll_lease_id uuid,poll_lease_expires_at timestamptz,
 deadline_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,request_id,provider_job_id),UNIQUE(company_id,connection_id,provider_job_id),
 CHECK((poll_lease_id IS NULL)=(poll_lease_expires_at IS NULL)),
 FOREIGN KEY(company_id,project_id,request_id) REFERENCES higgsfield_job_receipts(company_id,project_id,request_id) ON DELETE CASCADE
);
CREATE INDEX higgsfield_jobs_due ON higgsfield_jobs(next_poll_at,id) WHERE next_poll_at IS NOT NULL;
CREATE TABLE higgsfield_job_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('submission','poll')),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 status text NOT NULL,provider_status text,diagnostic_code text,
 output_identities jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(output_identities)='array'),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,job_id,source,source_sha256),
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES higgsfield_jobs(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE higgsfield_job_outputs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 7),kind text NOT NULL CHECK(kind IN ('image','video','audio')),
 locator_identity text NOT NULL CHECK(locator_identity~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,job_id,ordinal),
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES higgsfield_jobs(company_id,project_id,id) ON DELETE CASCADE
);
-- Signed URLs are private transport material. No locator enters public DTOs or
-- agent history, and observing a URL grants no authority to fetch/archive it.
CREATE TABLE higgsfield_output_locators (
 output_id uuid PRIMARY KEY,company_id uuid NOT NULL,project_id uuid NOT NULL,sealed jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,project_id,output_id) REFERENCES higgsfield_job_outputs(company_id,project_id,id) ON DELETE CASCADE
);
-- Exact responses remain recoverable when a provider changes its output
-- contract. Hashes alone cannot recover unknown job IDs. No public read API.
CREATE TABLE higgsfield_provider_responses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,request_id uuid NOT NULL,job_id uuid,
 source text NOT NULL CHECK(source IN ('submission','poll')),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 sealed jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,request_id,source,source_sha256),
 CHECK((source='submission' AND job_id IS NULL) OR (source='poll' AND job_id IS NOT NULL)),
 FOREIGN KEY(company_id,project_id,request_id) REFERENCES higgsfield_requests(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES higgsfield_jobs(company_id,project_id,id) ON DELETE CASCADE
);
