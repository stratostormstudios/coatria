-- Server-owned, leased-run inference. No provider or plaintext lease secrets.
CREATE TABLE studio_inference_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL,run_id uuid NOT NULL,host_id uuid NOT NULL,provision_id uuid NOT NULL,
 request_id uuid NOT NULL,step integer NOT NULL CHECK(step BETWEEN 0 AND 19),request_hash text NOT NULL CHECK(length(request_hash)=64),
 agent_sponsor_id uuid NOT NULL REFERENCES users(id),agent_token_hash text NOT NULL CHECK(length(agent_token_hash)=64),lease_token_hash text NOT NULL CHECK(length(lease_token_hash)=64),
 installation_id uuid NOT NULL,installation_revision integer NOT NULL CHECK(installation_revision>0),preset_hash text NOT NULL CHECK(length(preset_hash)=64),
 endpoint_id text NOT NULL,model_id text NOT NULL,limits jsonb NOT NULL,request_body jsonb NOT NULL CHECK(octet_length(request_body::text)<=1048576),
 reserved_tokens integer NOT NULL CHECK(reserved_tokens>0),used_tokens integer,
 status text NOT NULL DEFAULT 'submitting' CHECK(status IN ('submitting','queued','running','succeeded','failed','uncertain','cancel_requested','cancelled','expired')),
 provider_job_id text,submitted_at timestamptz,deadline_at timestamptz NOT NULL,cancel_requested_at timestamptz,cancel_request_id uuid,
 output jsonb CHECK(output IS NULL OR octet_length(output::text)<=1048576),model_calls jsonb NOT NULL DEFAULT '[]',error_code text,
 poll_lease_id uuid,poll_lease_expires_at timestamptz,last_reconciled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,run_id,step),UNIQUE(company_id,agent_id,request_id),UNIQUE(endpoint_id,provider_job_id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,host_id) REFERENCES studio_managed_hosts(company_id,id),
 FOREIGN KEY(company_id,provision_id) REFERENCES studio_host_provisions(company_id,id)
);
CREATE INDEX studio_inference_jobs_reconcile ON studio_inference_jobs(last_reconciled_at,id) WHERE status IN ('submitting','queued','running','uncertain','cancel_requested');
CREATE UNIQUE INDEX studio_inference_jobs_cancel_request ON studio_inference_jobs(company_id,agent_id,cancel_request_id) WHERE cancel_request_id IS NOT NULL;
CREATE TABLE studio_inference_reservations (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,inference_id uuid NOT NULL,provision_id uuid NOT NULL,
 amount_microusd bigint NOT NULL CHECK(amount_microusd>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,inference_id),FOREIGN KEY(company_id,inference_id) REFERENCES studio_inference_jobs(company_id,id),
 FOREIGN KEY(company_id,provision_id) REFERENCES studio_host_provisions(company_id,id)
);
CREATE TABLE studio_inference_tool_receipts (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,agent_id uuid NOT NULL,run_id uuid NOT NULL,inference_id uuid NOT NULL,
 request_id uuid NOT NULL,tool text NOT NULL,arguments_hash text NOT NULL CHECK(length(arguments_hash)=64),response jsonb NOT NULL CHECK(octet_length(response::text)<=262144),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,agent_id,request_id),
 FOREIGN KEY(company_id,inference_id) REFERENCES studio_inference_jobs(company_id,id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) ON DELETE CASCADE
);
