-- Reviewed execution profiles and durable DCC job receipts. No renderer,
-- worker process, storage mount, provider account or paid capacity is created.
ALTER TABLE agents DROP CONSTRAINT agents_capabilities_check;
ALTER TABLE agents ADD CONSTRAINT agents_capabilities_check CHECK(jsonb_typeof(capabilities)='array' AND capabilities<@'["workspace.read","tasks.write","infrastructure.read","hiring.read","office.write","layout.propose","rooms.propose","hiring.propose","studio.read","studio.write","studio.execute"]'::jsonb);
CREATE TABLE studio_execution_connectors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 name text NOT NULL,token_hash text NOT NULL UNIQUE,profiles jsonb NOT NULL CHECK(jsonb_typeof(profiles)='array'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','revoked')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,last_seen_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(company_id,id)
);
CREATE TABLE studio_execution_inputs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,
 name text NOT NULL,kind text NOT NULL CHECK(kind IN ('scene','cache','image_sequence','media')),
 storage_key text NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes>0),
 registered_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE
);
CREATE TABLE studio_execution_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,connector_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),requested_agent_id uuid,requested_run_id uuid,approved_by uuid REFERENCES users(id),
 profile jsonb NOT NULL,spec jsonb NOT NULL,input_snapshot jsonb NOT NULL,
 frame_start integer NOT NULL,frame_end integer NOT NULL,output_kind text NOT NULL CHECK(output_kind IN ('image_sequence','scene','cache','media')),
 status text NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN ('awaiting_approval','queued','running','succeeded','failed','failed_uncertain','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),worker_id text,claim_id uuid,lease_token_hash text,lease_expires_at timestamptz,
 started_at timestamptz,deadline_at timestamptz,finished_at timestamptz,failure_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,project_id,id),UNIQUE(company_id,connector_id,id),CHECK(frame_start>=0 AND frame_end>=frame_start AND frame_end-frame_start<1000),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,connector_id) REFERENCES studio_execution_connectors(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,requested_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,requested_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX studio_execution_one_pending_work ON studio_execution_jobs(company_id,work_item_id) WHERE status IN ('awaiting_approval','queued','running');
CREATE INDEX studio_execution_queue ON studio_execution_jobs(company_id,connector_id,created_at,id) WHERE status='queued';
CREATE TABLE studio_execution_job_inputs (
 company_id uuid NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL,input_id uuid NOT NULL,
 PRIMARY KEY(company_id,job_id,input_id),
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES studio_execution_jobs(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,input_id) REFERENCES studio_execution_inputs(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_execution_claims (
 company_id uuid NOT NULL,connector_id uuid NOT NULL,claim_id uuid NOT NULL,worker_id text NOT NULL,job_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,connector_id,claim_id),
 FOREIGN KEY(company_id,connector_id) REFERENCES studio_execution_connectors(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,connector_id,job_id) REFERENCES studio_execution_jobs(company_id,connector_id,id) ON DELETE CASCADE
);
CREATE TABLE studio_execution_manifests (
 job_id uuid PRIMARY KEY,company_id uuid NOT NULL,connector_id uuid NOT NULL,manifest jsonb NOT NULL,manifest_hash text NOT NULL CHECK(length(manifest_hash)=64),
 verification_source text NOT NULL DEFAULT 'connector_reported' CHECK(verification_source='connector_reported'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,connector_id,job_id) REFERENCES studio_execution_jobs(company_id,connector_id,id) ON DELETE CASCADE
);
CREATE TABLE studio_execution_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,actor_key,client_id)
);
