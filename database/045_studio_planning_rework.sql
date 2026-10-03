-- Explicit planning corrections consume the existing lifetime specialist budget.
-- Original work-item dispatch receipts retain their original primary key.
ALTER TABLE studio_coordination_policies ADD COLUMN planning_rework boolean NOT NULL DEFAULT false;
ALTER TABLE studio_dispatches ADD COLUMN planning_rework_review_id uuid;
CREATE TABLE studio_planning_rework_dispatches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,review_id uuid NOT NULL,
 task_id uuid NOT NULL,task_revision integer NOT NULL CHECK(task_revision>1),
 parent_attempt integer NOT NULL CHECK(parent_attempt>0),parent_started_at timestamptz NOT NULL,
 parent_run_id uuid NOT NULL,child_run_id uuid NOT NULL,source_child_run_id uuid NOT NULL,reviewer_run_id uuid NOT NULL,
 coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,policy_revision integer NOT NULL CHECK(policy_revision>0),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,review_id),UNIQUE(company_id,child_run_id),
 CHECK(parent_run_id<>child_run_id AND source_child_run_id<>child_run_id AND reviewer_run_id<>child_run_id),
 CHECK(coordinator_agent_id<>specialist_agent_id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_coordination_policies(company_id,project_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id,child_run_id) REFERENCES studio_dispatches(company_id,project_id,work_item_id,run_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id,source_child_run_id) REFERENCES studio_dispatches(company_id,project_id,work_item_id,run_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,review_id) REFERENCES studio_planning_review_decisions(company_id,review_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,reviewer_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,specialist_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE studio_dispatches ADD CONSTRAINT studio_planning_rework_marker_fk FOREIGN KEY(company_id,planning_rework_review_id) REFERENCES studio_planning_rework_dispatches(company_id,review_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION guard_studio_planning_rework() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Planning correction lineage is immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM companies WHERE id=OLD.company_id) THEN RAISE EXCEPTION 'Planning correction lineage is immutable' USING ERRCODE='42501'; END IF;
  RETURN OLD;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM studio_planning_reviews v JOIN studio_planning_review_decisions d ON d.company_id=v.company_id AND d.review_id=v.id
  JOIN studio_work_items w ON w.company_id=v.company_id AND w.project_id=v.project_id AND w.id=v.work_item_id
  JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN studio_coordination_policies p ON p.company_id=v.company_id AND p.project_id=v.project_id
  JOIN agent_runs child ON child.company_id=p.company_id AND child.id=NEW.child_run_id
  JOIN agent_runs parent ON parent.company_id=p.company_id AND parent.id=NEW.parent_run_id
  JOIN studio_dispatches dispatched ON dispatched.company_id=child.company_id AND dispatched.run_id=child.id
  WHERE v.company_id=NEW.company_id AND v.id=NEW.review_id AND v.project_id=NEW.project_id AND v.work_item_id=NEW.work_item_id
   AND v.task_id=NEW.task_id AND d.decision='changes_requested' AND d.task_revision=NEW.task_revision AND d.task_revision=v.task_revision+1
   AND v.producer_run_id=NEW.source_child_run_id AND v.reviewer_run_id=NEW.reviewer_run_id AND v.producer_agent_id=NEW.specialist_agent_id
   AND t.status='todo' AND t.revision=NEW.task_revision AND t.agent_run_id IS NULL AND t.assignee_id IS NULL
   AND t.title=v.submission#>>'{task,title}' AND t.description=v.submission#>>'{task,description}'
   AND w.stage IN ('estimate','breakdown') AND w.execution='agent' AND b.agent_id=NEW.specialist_agent_id
   AND p.planning_rework AND p.status='active' AND p.expires_at>clock_timestamp() AND p.revision=NEW.policy_revision
   AND p.coordinator_agent_id=NEW.coordinator_agent_id AND p.allowed_role_keys ? w.role_key
   AND child.agent_id=NEW.specialist_agent_id AND child.requested_by=p.approved_by
   AND child.status='queued' AND child.max_attempts=1 AND child.attempts=0 AND child.started_at IS NULL
   AND child.capabilities='["studio.read","studio.write","tasks.write"]'::jsonb AND child.created_at>=transaction_timestamp()
   AND parent.agent_id=NEW.coordinator_agent_id AND parent.attempts=NEW.parent_attempt AND parent.started_at=NEW.parent_started_at AND parent.status='running' AND parent.lease_expires_at>clock_timestamp()
   AND dispatched.created_at>=transaction_timestamp() AND dispatched.project_id=NEW.project_id AND dispatched.work_item_id=NEW.work_item_id
   AND NEW.source_snapshot->>'taskId'=NEW.task_id::text AND (NEW.source_snapshot->>'taskRevision')::integer=NEW.task_revision
   AND (SELECT count(*) FROM agent_runs r WHERE r.company_id=NEW.company_id AND r.id IN (NEW.source_child_run_id,NEW.reviewer_run_id) AND r.status='succeeded' AND r.started_at IS NOT NULL AND r.finished_at IS NOT NULL AND r.result_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM agent_run_receipts receipt WHERE receipt.company_id=r.company_id AND receipt.run_id=r.id AND receipt.kind='complete' AND receipt.response#>>'{run,status}'='succeeded' AND receipt.response#>>'{run,id}'=r.id::text AND receipt.response#>>'{run,resultMessageId}'=r.result_message_id::text))=2
   AND NEW.source_snapshot->>'submissionSha256'=v.submission_sha256 AND NEW.source_snapshot->>'briefSha256'=v.brief_sha256
 ) THEN RAISE EXCEPTION 'Planning correction must bind one reviewed current submission' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_planning_rework_guard BEFORE INSERT OR UPDATE OR DELETE ON studio_planning_rework_dispatches FOR EACH ROW EXECUTE FUNCTION guard_studio_planning_rework();
CREATE FUNCTION guard_studio_planning_rework_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.planning_rework_review_id IS NOT DISTINCT FROM NEW.planning_rework_review_id THEN RETURN NEW; END IF;
 IF OLD.planning_rework_review_id IS NOT NULL OR NEW.planning_rework_review_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM studio_planning_rework_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.child_run_id
  WHERE d.company_id=NEW.company_id AND d.child_run_id=NEW.run_id AND d.review_id=NEW.planning_rework_review_id
   AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.created_at>=transaction_timestamp()
   AND r.status='queued' AND r.attempts=0 AND r.started_at IS NULL
 ) THEN RAISE EXCEPTION 'Planning correction marker is immutable and requires a new exact dispatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_planning_rework_marker_guard BEFORE UPDATE ON studio_dispatches FOR EACH ROW EXECUTE FUNCTION guard_studio_planning_rework_marker();
