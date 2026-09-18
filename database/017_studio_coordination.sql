-- Administrator-approved delegation. The lifetime budget never resets on policy edits.
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_max_attempts_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_max_attempts_check CHECK(max_attempts IN (1,3));
CREATE TABLE studio_coordination_policies (
 company_id uuid NOT NULL,project_id uuid NOT NULL,coordinator_agent_id uuid NOT NULL,
 approved_by uuid NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('active','paused')),allowed_role_keys jsonb NOT NULL CHECK(jsonb_typeof(allowed_role_keys)='array'),
 profile_revision integer NOT NULL CHECK(profile_revision>0),authority_snapshot jsonb NOT NULL CHECK(jsonb_typeof(authority_snapshot)='object'),
 max_runs integer NOT NULL CHECK(max_runs BETWEEN 1 AND 100),runs_started integer NOT NULL DEFAULT 0 CHECK(runs_started BETWEEN 0 AND 100),
 max_concurrent_runs integer NOT NULL CHECK(max_concurrent_runs BETWEEN 1 AND 3),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,project_id),CHECK(runs_started<=max_runs),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_coordination_dispatches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,parent_run_id uuid NOT NULL,child_run_id uuid NOT NULL,
 coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,policy_revision integer NOT NULL CHECK(policy_revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,project_id,work_item_id),UNIQUE(company_id,child_run_id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_coordination_policies(company_id,project_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,specialist_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
