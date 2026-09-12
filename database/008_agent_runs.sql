ALTER TABLE agents ADD COLUMN invocation_access text NOT NULL DEFAULT 'none' CHECK(invocation_access IN ('none','members','admins'));
ALTER TABLE agents ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(capabilities)='array' AND capabilities<@'["workspace.read","tasks.write","infrastructure.read","hiring.read","office.write","layout.propose","rooms.propose","hiring.propose"]'::jsonb);
ALTER TABLE agents ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days');

CREATE TABLE agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL,requested_by uuid NOT NULL REFERENCES users(id),conversation_id uuid NOT NULL,parent_id uuid,
 client_id uuid NOT NULL,payload_hash text NOT NULL CHECK(length(payload_hash)=64),prompt text NOT NULL CHECK(length(prompt) BETWEEN 1 AND 6000),
 capabilities jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(capabilities)='array'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts=3),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),worker_id text,lease_token_hash text,lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),started_at timestamptz,finished_at timestamptz,
 result text NOT NULL DEFAULT '' CHECK(length(result)<=12000),error text NOT NULL DEFAULT '' CHECK(length(error)<=2000),artifact_url text,result_message_id uuid,
 UNIQUE(company_id,id),UNIQUE(company_id,requested_by,client_id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES conversations(company_id,id),
 FOREIGN KEY(company_id,conversation_id,parent_id) REFERENCES messages(company_id,conversation_id,id),
 FOREIGN KEY(company_id,conversation_id,result_message_id) REFERENCES messages(company_id,conversation_id,id),
 CHECK((status='running' AND worker_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'running' AND worker_id IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX agent_runs_queue_idx ON agent_runs(agent_id,status,available_at,created_at);
CREATE INDEX agent_runs_channel_idx ON agent_runs(company_id,conversation_id,created_at DESC,id);
CREATE TABLE agent_run_claims (
 company_id uuid NOT NULL,agent_id uuid NOT NULL,claim_id uuid NOT NULL,worker_id text NOT NULL,run_id uuid,attempt integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(agent_id,claim_id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) ON DELETE CASCADE,
 CHECK((run_id IS NULL AND attempt IS NULL) OR (run_id IS NOT NULL AND attempt BETWEEN 1 AND 3))
);
CREATE TABLE agent_run_receipts (
 company_id uuid NOT NULL,run_id uuid NOT NULL,client_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('complete','fail')),
 payload_hash text NOT NULL CHECK(length(payload_hash)=64),lease_token_hash text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(run_id,client_id),
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) ON DELETE CASCADE
);
