-- Official remote MCP authorization is company scoped. Tokens never enter tool results.
-- New creative grants are explicit opt-ins; existing agent and run grants remain unchanged.
ALTER TABLE agents DROP CONSTRAINT agents_capabilities_check;
ALTER TABLE agents ADD CONSTRAINT agents_capabilities_check CHECK(jsonb_typeof(capabilities)='array' AND capabilities<@'["workspace.read","tasks.write","infrastructure.read","hiring.read","office.write","layout.propose","rooms.propose","hiring.propose","studio.read","studio.write","studio.execute","studio.review","creative.read","creative.write"]'::jsonb);
CREATE TABLE higgsfield_oauth_attempts (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id),
 state_hash text NOT NULL UNIQUE CHECK(length(state_hash)=64), sealed jsonb NOT NULL,
 expected_revision integer NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX higgsfield_oauth_company ON higgsfield_oauth_attempts(company_id,created_at);
CREATE TABLE higgsfield_connections (
 company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE, id uuid NOT NULL UNIQUE,
 revision integer NOT NULL DEFAULT 1, status text NOT NULL CHECK(status IN ('connected','disconnected','reconnect_required')),
 connected_by uuid NOT NULL REFERENCES users(id), sealed jsonb, expires_at timestamptz NOT NULL,
 tools jsonb NOT NULL DEFAULT '[]', connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE higgsfield_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, project_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id), agent_id uuid, run_id uuid, client_id uuid NOT NULL,
 project_revision integer NOT NULL, connection_revision integer NOT NULL, tool text NOT NULL CHECK(tool IN ('generate_image','generate_video','generate_audio')),
 arguments jsonb NOT NULL, note text NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','dispatching','returned','uncertain','rejected')),
 approved_by uuid REFERENCES users(id), dispatched_at timestamptz, result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,requested_by,client_id), FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX higgsfield_project_requests ON higgsfield_requests(company_id,project_id,created_at,id);
