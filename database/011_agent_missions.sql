-- Every autonomous cycle is an ordinary scoped durable run requested by the
-- administrator who created the mission. No autonomous privilege or identity.
CREATE TABLE agent_missions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,request_hash text NOT NULL CHECK(length(request_hash)=64),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),objective text NOT NULL CHECK(length(objective) BETWEEN 1 AND 3000),
 interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 15 AND 1440),
 max_cycles integer NOT NULL CHECK(max_cycles BETWEEN 1 AND 100),cycles_started integer NOT NULL DEFAULT 0 CHECK(cycles_started BETWEEN 0 AND 100),
 status text NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused','completed')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_run_id uuid,reviewed_run_id uuid,pause_reason text NOT NULL DEFAULT '' CHECK(length(pause_reason)<=1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,created_by,client_id),FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id),
 FOREIGN KEY(company_id,last_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,reviewed_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,CHECK(cycles_started<=max_cycles)
);
CREATE INDEX agent_missions_due_idx ON agent_missions(company_id,agent_id,status,next_run_at,id);
CREATE TABLE agent_mission_cycles (
 company_id uuid NOT NULL,mission_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 100),
 run_id uuid NOT NULL,client_id uuid NOT NULL,trigger text NOT NULL CHECK(trigger IN ('scheduled','manual')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,mission_id,ordinal),
 UNIQUE(company_id,mission_id,client_id),UNIQUE(company_id,run_id),
 FOREIGN KEY(company_id,mission_id) REFERENCES agent_missions(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
