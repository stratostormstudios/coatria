-- Scoped tools store durable receipts separately from worker leases. No model credentials are stored.
CREATE TABLE agent_tool_receipts (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL, run_id uuid NOT NULL, request_id uuid NOT NULL,
 tool text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,agent_id,request_id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_tool_receipts_run_idx ON agent_tool_receipts(company_id,run_id,created_at);
CREATE TABLE agent_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL, run_id uuid NOT NULL, requested_by uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('layout','room','opening')), data jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
 reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, result jsonb,
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id),
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id), UNIQUE(company_id,id)
);
CREATE INDEX agent_proposals_company_idx ON agent_proposals(company_id,status,created_at DESC,id);
CREATE TABLE agent_presence (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, agent_id uuid NOT NULL,
 room_id uuid, x double precision NOT NULL CHECK(x BETWEEN -20 AND 20), z double precision NOT NULL CHECK(z BETWEEN -20 AND 20),
 status text NOT NULL CHECK(status IN ('available','focus','away')), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,agent_id), FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,room_id) REFERENCES rooms(company_id,id)
);
ALTER TABLE tasks ADD COLUMN created_agent_id uuid REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN agent_run_id uuid REFERENCES agent_runs(id);
ALTER TABLE tasks ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE INDEX tasks_agent_run_idx ON tasks(company_id,agent_run_id) WHERE agent_run_id IS NOT NULL;
