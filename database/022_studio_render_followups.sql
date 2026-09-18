-- One explicit post-render continuation for an original delegated specialist.
-- This does not approve a renderer, promote media, or accept its quality.
CREATE TABLE studio_coordination_followups (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,execution_job_id uuid NOT NULL,
 parent_run_id uuid NOT NULL,source_child_run_id uuid NOT NULL,child_run_id uuid NOT NULL,
 coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,policy_revision integer NOT NULL CHECK(policy_revision>0),
 execution_manifest_sha256 text NOT NULL CHECK(execution_manifest_sha256~'^[a-f0-9]{64}$'),
 artifact_id uuid NOT NULL,artifact_sha256 text NOT NULL CHECK(artifact_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,execution_job_id),UNIQUE(company_id,child_run_id),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_coordination_dispatches(company_id,project_id,work_item_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,execution_job_id) REFERENCES studio_execution_jobs(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,artifact_id) REFERENCES studio_artifacts(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,source_child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,specialist_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
