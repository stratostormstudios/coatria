-- Explicit, opt-in submitted planning handoff. Existing rows retain exact-task
-- authority; no role, grant, processor or permission is created here.
ALTER TABLE project_image_preparations ADD COLUMN continuation_mode text NOT NULL DEFAULT 'exact_task_v1'
 CHECK(continuation_mode IN ('exact_task_v1','submitted_plan_v1'));
ALTER TABLE project_image_preparations ADD CONSTRAINT project_image_preparation_handoff_shape CHECK(
 continuation_mode='exact_task_v1' OR (
  proposed_agent_id IS NOT NULL AND proposed_run_id IS NOT NULL
  AND work_snapshot->>'stage'='references' AND work_snapshot->>'execution'='agent'
  AND work_snapshot->>'status'='doing' AND work_snapshot->>'role_agent_id'=proposed_agent_id::text
  AND work_snapshot->>'agent_run_id'=proposed_run_id::text AND work_snapshot->>'assignee_id' IS NULL
  AND proposer_snapshot#>>'{agent,runIdentity,attempt}'='1'
  AND proposer_snapshot#>>'{agent,runIdentity,maxAttempts}'='1'
  AND proposer_snapshot#>>'{agent,runIdentity,startedAt}' IS NOT NULL
 ) IS TRUE
);
-- 045 compares every column except its explicit mutable phase fields, so the
-- added continuation mode is covered by the existing ALWAYS immutable guard.

-- Record only newly committed decision transitions; historical decisions stay
-- null and cannot authorize a preparation against an inferred project revision.
ALTER TABLE studio_planning_review_decisions ADD COLUMN project_revision_before integer,
 ADD COLUMN project_revision_after integer,
 ADD CONSTRAINT studio_planning_review_project_transition CHECK(
  (project_revision_before IS NULL AND project_revision_after IS NULL)
  OR (project_revision_before IS NOT NULL AND project_revision_after IS NOT NULL
   AND project_revision_before>0 AND project_revision_after=project_revision_before+1)
 );
CREATE TRIGGER studio_planning_review_decision_immutable BEFORE UPDATE ON studio_planning_review_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
ALTER TABLE studio_planning_review_decisions ENABLE ALWAYS TRIGGER studio_planning_review_decision_immutable;
-- No DELETE trigger or grant: company/project cascades remain possible.
