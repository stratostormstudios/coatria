-- Studio structure and exact version/review/delivery receipts; no credentials,
-- paid workers or rendering capability are created by applying this migration.
ALTER TABLE agents DROP CONSTRAINT agents_capabilities_check;
ALTER TABLE agents ADD CONSTRAINT agents_capabilities_check CHECK(jsonb_typeof(capabilities)='array' AND capabilities<@'["workspace.read","tasks.write","infrastructure.read","hiring.read","office.write","layout.propose","rooms.propose","hiring.propose","studio.read","studio.write"]'::jsonb);
CREATE TABLE studio_profiles (
 company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
 template_id text NOT NULL,template_version integer NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE studio_role_bindings (
 company_id uuid NOT NULL REFERENCES studio_profiles(company_id) ON DELETE CASCADE,role_key text NOT NULL,
 agent_id uuid,human_id uuid REFERENCES users(id),PRIMARY KEY(company_id,role_key),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,CHECK(agent_id IS NULL OR human_id IS NULL)
);
CREATE TABLE studio_projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES studio_profiles(company_id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),client_name text NOT NULL CHECK(length(client_name) BETWEEN 1 AND 160),
 brief text NOT NULL CHECK(length(brief) BETWEEN 1 AND 12000),due_date date,spec jsonb NOT NULL CHECK(jsonb_typeof(spec)='object'),
 ai_policy text NOT NULL CHECK(ai_policy IN ('unknown','allowed','restricted')),
 status text NOT NULL DEFAULT 'intake' CHECK(status IN ('intake','planning','production','review','delivery','delivered')),
 gates jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(gates)='object'),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX studio_projects_page ON studio_projects(company_id,id);
CREATE TABLE studio_shots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,
 code text NOT NULL,description text NOT NULL,frame_start integer NOT NULL,frame_end integer NOT NULL,handles integer NOT NULL,
 disciplines jsonb NOT NULL,UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,code),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 CHECK(frame_start>=0 AND frame_end>=frame_start AND frame_end-frame_start<=100000 AND handles BETWEEN 0 AND 1000)
);
CREATE TABLE studio_work_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,shot_id uuid,
 logical_key text NOT NULL,task_id uuid NOT NULL,stage text NOT NULL,role_key text NOT NULL,
 execution text NOT NULL CHECK(execution IN ('agent','dcc','human')),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,logical_key),UNIQUE(task_id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,shot_id) REFERENCES studio_shots(company_id,project_id,id)
);
CREATE TABLE studio_dependencies (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,predecessor_id uuid NOT NULL,
 PRIMARY KEY(company_id,project_id,work_item_id,predecessor_id),CHECK(work_item_id<>predecessor_id),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,predecessor_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE studio_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,
 name text NOT NULL,version integer NOT NULL CHECK(version>0),url text NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),metadata jsonb NOT NULL,
 produced_by uuid NOT NULL REFERENCES users(id),produced_agent_id uuid,agent_sponsor_id uuid REFERENCES users(id),run_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,work_item_id,version),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,produced_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,artifact_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','changes_requested')),note text NOT NULL,technical_qc boolean NOT NULL,
 reviewed_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,project_id,artifact_id) REFERENCES studio_artifacts(company_id,project_id,id) ON DELETE CASCADE
);
CREATE INDEX studio_reviews_latest ON studio_reviews(company_id,project_id,artifact_id,created_at DESC,id);
CREATE TABLE studio_gate_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,gate text NOT NULL,decision text NOT NULL,note text NOT NULL,delivery_id uuid,
 recorded_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE
);
CREATE TABLE studio_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,name text NOT NULL,manifest jsonb NOT NULL,note text NOT NULL,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','acknowledged')),created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE
);
ALTER TABLE studio_gate_events ADD FOREIGN KEY(company_id,project_id,delivery_id) REFERENCES studio_deliveries(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE studio_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,actor_key,client_id)
);
CREATE TABLE studio_dispatches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,run_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,run_id),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) ON DELETE CASCADE
);
CREATE INDEX studio_dispatches_work ON studio_dispatches(company_id,project_id,work_item_id,created_at DESC);
