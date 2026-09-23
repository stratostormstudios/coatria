-- New reviewed authority only. Existing policies, immutable request hashes and
-- distinct-specialist receipts keep their prior meaning.
ALTER TABLE studio_coordination_policies ADD COLUMN coordinator_generation boolean NOT NULL DEFAULT false;

-- Keep the three distinct run IDs and every original source/evidence check.
-- Replace only the identity inequality with the narrower deferred authority
-- check below, so one reviewed identity may execute sequential responsibilities.
ALTER TABLE studio_generated_followups DROP CONSTRAINT studio_generated_followups_check2;

CREATE FUNCTION studio_coordinator_generation_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p record;w record;policy record;binding record;parent record;child record;
BEGIN
 IF NEW.coordinator_agent_id<>NEW.specialist_agent_id THEN RETURN NULL;END IF;
 SELECT * INTO p FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id;
 SELECT * INTO w FROM studio_work_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.work_item_id;
 SELECT * INTO policy FROM studio_coordination_policies WHERE company_id=NEW.company_id AND project_id=NEW.project_id FOR SHARE;
 SELECT * INTO binding FROM studio_role_bindings WHERE company_id=NEW.company_id AND role_key=w.role_key;
 SELECT * INTO parent FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.parent_run_id FOR SHARE;
 SELECT * INTO child FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.child_run_id FOR SHARE;
 IF p.contract_version IS DISTINCT FROM 2 OR p.production_path IS DISTINCT FROM 'higgsfield'
  OR w.stage IS DISTINCT FROM 'generation' OR w.execution IS DISTINCT FROM 'creative'
  OR policy.coordinator_generation IS DISTINCT FROM true OR policy.status IS DISTINCT FROM 'active'
  OR policy.revision IS DISTINCT FROM NEW.policy_revision OR policy.coordinator_agent_id IS DISTINCT FROM NEW.coordinator_agent_id
  OR NOT COALESCE(policy.allowed_role_keys ? w.role_key,false)
  OR binding.agent_id IS DISTINCT FROM NEW.specialist_agent_id OR binding.human_id IS NOT NULL
  OR NEW.parent_run_id=NEW.child_run_id
  OR parent.agent_id IS DISTINCT FROM NEW.coordinator_agent_id OR parent.requested_by IS DISTINCT FROM policy.approved_by OR parent.status IS DISTINCT FROM 'running'
  OR child.agent_id IS DISTINCT FROM NEW.specialist_agent_id OR child.requested_by IS DISTINCT FROM policy.approved_by OR child.max_attempts IS DISTINCT FROM 1 OR child.status IS DISTINCT FROM 'queued'
 THEN RAISE EXCEPTION 'Coordinator generation requires an exact reviewed generated-work child' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_coordinator_generation_dispatch_check AFTER INSERT ON studio_coordination_dispatches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_coordinator_generation_check();
CREATE CONSTRAINT TRIGGER studio_coordinator_generation_followup_check AFTER INSERT ON studio_generated_followups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_coordinator_generation_check();
