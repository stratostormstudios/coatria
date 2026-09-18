-- Explicit, separately granted machine review of bounded planning submissions.
ALTER TABLE agents DROP CONSTRAINT agents_capabilities_check;
ALTER TABLE agents ADD CONSTRAINT agents_capabilities_check CHECK(jsonb_typeof(capabilities)='array' AND capabilities<@'["workspace.read","tasks.write","infrastructure.read","hiring.read","office.write","layout.propose","rooms.propose","hiring.propose","studio.read","studio.write","studio.execute","studio.review"]'::jsonb);
CREATE TABLE studio_review_policies (
 company_id uuid NOT NULL,project_id uuid NOT NULL,coordinator_agent_id uuid NOT NULL,reviewer_agent_id uuid NOT NULL,
 approved_by uuid NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),status text NOT NULL CHECK(status IN ('active','paused')),
 allowed_stages jsonb NOT NULL CHECK(jsonb_typeof(allowed_stages)='array' AND allowed_stages<@'["estimate","breakdown","ingest"]'::jsonb),allow_shared_sponsor boolean NOT NULL DEFAULT false,
 authority_snapshot jsonb NOT NULL CHECK(jsonb_typeof(authority_snapshot)='object'),profile_revision integer NOT NULL,
 max_reviews integer NOT NULL CHECK(max_reviews BETWEEN 1 AND 100),reviews_started integer NOT NULL DEFAULT 0 CHECK(reviews_started BETWEEN 0 AND 100),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,project_id),CHECK(reviews_started<=max_reviews),CHECK(coordinator_agent_id<>reviewer_agent_id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,reviewer_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_planning_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,task_id uuid NOT NULL,task_revision integer NOT NULL CHECK(task_revision>0),policy_revision integer NOT NULL,
 parent_run_id uuid NOT NULL,reviewer_run_id uuid NOT NULL,reviewer_agent_id uuid NOT NULL,producer_agent_id uuid NOT NULL,producer_run_id uuid NOT NULL,
 submission jsonb NOT NULL CHECK(jsonb_typeof(submission)='object'),submission_sha256 text NOT NULL CHECK(submission_sha256~'^[a-f0-9]{64}$'),brief_sha256 text NOT NULL CHECK(brief_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,project_id,work_item_id,task_revision),UNIQUE(company_id,project_id,work_item_id,producer_run_id),UNIQUE(company_id,reviewer_run_id),CHECK(reviewer_agent_id<>producer_agent_id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_review_policies(company_id,project_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,reviewer_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,producer_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,producer_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,reviewer_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_planning_review_reads (
 company_id uuid NOT NULL,review_id uuid NOT NULL,run_id uuid NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,review_id),
 FOREIGN KEY(company_id,review_id) REFERENCES studio_planning_reviews(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_planning_review_decisions (
 company_id uuid NOT NULL,review_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN ('approve','changes_requested','reject')),note text NOT NULL CHECK(length(note) BETWEEN 20 AND 4000),
 task_revision integer NOT NULL,decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,review_id),
 FOREIGN KEY(company_id,review_id) REFERENCES studio_planning_reviews(company_id,id) ON DELETE CASCADE
);
ALTER TABLE tasks ADD COLUMN approved_agent_id uuid,ADD COLUMN machine_review_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_machine_reviewer_fk FOREIGN KEY(company_id,approved_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE tasks ADD CONSTRAINT tasks_machine_review_fk FOREIGN KEY(company_id,machine_review_id) REFERENCES studio_planning_reviews(company_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE tasks ADD CONSTRAINT tasks_machine_review_consistent CHECK((approved_agent_id IS NULL)=(machine_review_id IS NULL) AND (approved_agent_id IS NULL OR approved_by IS NULL));
