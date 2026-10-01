-- Explicit reference-to-generation continuation. Existing policies, proposal
-- hashes and prepared_image_v1 inspection authority remain unchanged.
ALTER TABLE studio_coordination_policies ADD COLUMN reference_generation_continuations boolean NOT NULL DEFAULT false;

CREATE TABLE studio_reference_generation_handoffs (
 id uuid PRIMARY KEY,company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,task_id uuid NOT NULL,
 initial_parent_run_id uuid NOT NULL,source_child_run_id uuid NOT NULL,coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),policy_revision integer NOT NULL CHECK(policy_revision>0),
 project_revision integer NOT NULL CHECK(project_revision>0),task_revision integer NOT NULL CHECK(task_revision>0),
 reference_id uuid NOT NULL,reference_request_hash text NOT NULL CHECK(reference_request_hash~'^[a-f0-9]{64}$'),
 preparation_id uuid NOT NULL,preparation_revision integer NOT NULL CHECK(preparation_revision>0),
 source_version_id uuid NOT NULL,source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),source_bytes bigint NOT NULL CHECK(source_bytes BETWEEN 1 AND 33554432),
 output_version_id uuid NOT NULL,output_sha256 text NOT NULL CHECK(output_sha256~'^[a-f0-9]{64}$'),output_bytes bigint NOT NULL CHECK(output_bytes BETWEEN 1 AND 10485760),
 recipe_sha256 text NOT NULL CHECK(recipe_sha256~'^[a-f0-9]{64}$'),derivation_sha256 text NOT NULL CHECK(derivation_sha256~'^[a-f0-9]{64}$'),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND pg_column_size(source_snapshot)<=131072),
 handoff_sha256 text NOT NULL CHECK(handoff_sha256~'^[a-f0-9]{64}$' AND handoff_sha256=encode(sha256(convert_to(studio_generated_canonical(source_snapshot),'UTF8')),'hex')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,id,reference_id),
 UNIQUE(company_id,source_child_run_id),UNIQUE(company_id,reference_id),
 CHECK(source_version_id<>output_version_id AND initial_parent_run_id<>source_child_run_id),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_coordination_dispatches(company_id,project_id,work_item_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,initial_parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,source_child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,specialist_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,reference_id) REFERENCES higgsfield_references(company_id,project_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparations(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,preparation_id) REFERENCES project_image_preparation_derivations(company_id,preparation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,source_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,output_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE higgsfield_references ADD COLUMN generation_handoff_id uuid,ADD COLUMN generation_inspection_adoption_id uuid,
 ADD CONSTRAINT higgsfield_reference_generation_handoff FOREIGN KEY(company_id,project_id,generation_handoff_id,id)
 REFERENCES studio_reference_generation_handoffs(company_id,project_id,id,reference_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION guard_reference_generation_discriminator() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.generation_inspection_adoption_id IS NOT NULL THEN RAISE EXCEPTION 'Inspection adoption is a separate owner transition' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 IF NEW.generation_handoff_id IS DISTINCT FROM OLD.generation_handoff_id THEN RAISE EXCEPTION 'Reference generation lineage is immutable' USING ERRCODE='42501';END IF;
 IF NEW.generation_inspection_adoption_id IS DISTINCT FROM OLD.generation_inspection_adoption_id THEN
  IF OLD.generation_inspection_adoption_id IS NOT NULL OR NEW.generation_inspection_adoption_id IS NULL OR OLD.generation_handoff_id IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.studio_reference_generation_inspection_adoptions adoption
    JOIN public.studio_reference_generation_handoffs handoff ON (handoff.company_id,handoff.project_id,handoff.id)=(adoption.company_id,adoption.project_id,adoption.handoff_id)
    JOIN public.project_image_preparations preparation ON (preparation.company_id,preparation.project_id,preparation.id)=(handoff.company_id,handoff.project_id,handoff.preparation_id)
    JOIN public.memberships adopter ON adopter.company_id=adoption.company_id AND adopter.user_id=adoption.approved_by
    WHERE adoption.company_id=OLD.company_id AND adoption.project_id=OLD.project_id AND adoption.reference_id=OLD.id
     AND adoption.id=NEW.generation_inspection_adoption_id AND adoption.handoff_id=OLD.generation_handoff_id
     AND adoption.reference_revision=OLD.revision AND adoption.request_hash=OLD.request_hash
     AND adoption.expires_at>clock_timestamp() AND adoption.expires_at<=OLD.inspect_expires_at
     AND adopter.role IN ('owner','admin') AND adopter.access_revoked_at IS NULL
     AND adoption.approver_snapshot->>'role'=adopter.role AND (adoption.approver_snapshot->>'joinedAt')::timestamptz=adopter.joined_at
     AND preparation.status='ready' AND preparation.revision=handoff.preparation_revision AND preparation.revoked_at IS NULL AND preparation.cleanup_confirmed_at IS NOT NULL)
  THEN RAISE EXCEPTION 'Inspection adoption cannot be replaced or detached from its exact ready source' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_generation_discriminator_immutable BEFORE INSERT OR UPDATE ON higgsfield_references FOR EACH ROW EXECUTE FUNCTION guard_reference_generation_discriminator();
ALTER TABLE higgsfield_references ENABLE ALWAYS TRIGGER reference_generation_discriminator_immutable;

CREATE FUNCTION validate_reference_generation_handoff() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r record;p record;w record;t record;binding record;d record;policy record;run record;parent record;a record;i record;coordinator record;coordinator_installation record;prep record;derivation record;verified record;expected_work jsonb;
BEGIN
 SELECT * INTO r FROM higgsfield_references WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.reference_id;
 SELECT * INTO p FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id;
 SELECT * INTO w FROM studio_work_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.work_item_id;
 SELECT * INTO t FROM tasks WHERE company_id=NEW.company_id AND id=NEW.task_id;
 SELECT * INTO binding FROM studio_role_bindings WHERE company_id=NEW.company_id AND role_key=w.role_key;
 SELECT * INTO d FROM studio_coordination_dispatches WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND work_item_id=NEW.work_item_id;
 SELECT * INTO policy FROM studio_coordination_policies WHERE company_id=NEW.company_id AND project_id=NEW.project_id;
 SELECT * INTO run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.source_child_run_id;
 SELECT * INTO parent FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.initial_parent_run_id;
 SELECT * INTO a FROM agents WHERE company_id=NEW.company_id AND id=NEW.specialist_agent_id;
 SELECT * INTO i FROM plugin_installations WHERE company_id=NEW.company_id AND agent_id=NEW.specialist_agent_id;
 SELECT * INTO coordinator FROM agents WHERE company_id=NEW.company_id AND id=NEW.coordinator_agent_id;
 SELECT * INTO coordinator_installation FROM plugin_installations WHERE company_id=NEW.company_id AND agent_id=NEW.coordinator_agent_id;
 SELECT * INTO prep FROM project_image_preparations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.preparation_id;
 SELECT * INTO derivation FROM project_image_preparation_derivations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND preparation_id=NEW.preparation_id;
 SELECT * INTO verified FROM project_storage_verifications WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND version_id=NEW.output_version_id;
 IF NOT (r.id IS NOT NULL AND r.generation_handoff_id=NEW.id AND r.created_at>=transaction_timestamp() AND r.status='proposed' AND r.revision=1
  AND r.inspection_authority IS NULL AND r.approved_by IS NULL AND r.revoked_at IS NULL AND r.lease_id IS NULL AND r.action_id IS NULL
  AND r.work_item_id=NEW.work_item_id AND r.project_revision=NEW.project_revision AND r.request_hash=NEW.reference_request_hash
  AND r.proposed_run_id=NEW.source_child_run_id AND r.proposed_agent_id=NEW.specialist_agent_id AND r.proposed_by=NEW.requested_by
  AND p.contract_version=2 AND p.production_path='higgsfield' AND p.ai_policy='allowed' AND p.status<>'delivered' AND p.revision=NEW.project_revision
  AND p.gates#>>'{brief,decision}'='approved' AND p.gates#>>'{estimate,decision}'='approved' AND p.gates#>>'{production,decision}'='approved'
  AND w.stage='generation' AND w.execution='creative' AND w.task_id=NEW.task_id AND t.status='doing' AND t.agent_run_id=NEW.source_child_run_id AND t.revision=NEW.task_revision AND t.assignee_id IS NULL
  AND binding.agent_id=NEW.specialist_agent_id AND binding.human_id IS NULL
  AND r.work_snapshot->>'workItemId'=w.id::text AND r.work_snapshot->>'taskId'=t.id::text AND r.work_snapshot->>'taskRevision'=t.revision::text
  AND r.work_snapshot->>'stage'=w.stage AND r.work_snapshot->>'roleKey'=w.role_key AND r.work_snapshot->>'roleAgentId'=binding.agent_id::text
  AND r.work_snapshot->>'roleHumanId' IS NULL AND r.work_snapshot->>'status'=t.status
  AND r.work_snapshot->>'taskContentHash'=encode(sha256(convert_to(studio_generated_canonical(jsonb_build_object('title',t.title,'description',t.description)),'UTF8')),'hex')
  AND d.child_run_id=NEW.source_child_run_id AND d.parent_run_id=NEW.initial_parent_run_id AND d.specialist_agent_id=NEW.specialist_agent_id AND d.coordinator_agent_id=NEW.coordinator_agent_id
  AND d.policy_revision=NEW.policy_revision AND policy.revision=NEW.policy_revision AND policy.reference_generation_continuations=true AND policy.status='active' AND policy.expires_at>clock_timestamp()
  AND policy.approved_by=NEW.requested_by AND policy.coordinator_agent_id=NEW.coordinator_agent_id AND policy.allowed_role_keys ? w.role_key
  AND run.status='running' AND run.purpose='task' AND run.agent_id=NEW.specialist_agent_id AND run.requested_by=NEW.requested_by AND run.max_attempts=1 AND run.attempts=1
  AND run.started_at IS NOT NULL AND run.lease_token_hash IS NOT NULL AND run.lease_expires_at>clock_timestamp()
  AND parent.agent_id=NEW.coordinator_agent_id AND parent.requested_by=NEW.requested_by AND (parent.status='succeeded' OR (parent.status='running' AND parent.lease_token_hash IS NOT NULL AND parent.lease_expires_at>clock_timestamp()))
  AND (parent.status<>'succeeded' OR EXISTS(SELECT 1 FROM agent_run_receipts WHERE company_id=NEW.company_id AND run_id=parent.id AND kind='complete' AND response#>>'{run,id}'=parent.id::text AND response#>>'{run,status}'='succeeded'))
  AND a.status='active' AND a.expires_at>clock_timestamp() AND a.invocation_access<>'none'
  AND prep.status='ready' AND prep.revision=NEW.preparation_revision AND prep.revoked_at IS NULL AND prep.cleanup_confirmed_at IS NOT NULL
  AND derivation.source_version_id=NEW.source_version_id AND derivation.source_sha256=NEW.source_sha256 AND derivation.source_bytes=NEW.source_bytes
  AND derivation.output_version_id=NEW.output_version_id AND derivation.output_sha256=NEW.output_sha256 AND derivation.output_bytes=NEW.output_bytes
  AND derivation.recipe_sha256=NEW.recipe_sha256 AND derivation.receipt_sha256=NEW.derivation_sha256
  AND r.source_version_id=NEW.source_version_id AND r.proxy_version_id=NEW.output_version_id
  AND r.source_snapshot->>'sha256'=NEW.source_sha256 AND r.source_snapshot->>'bytes'=NEW.source_bytes::text
  AND r.proxy_snapshot->>'sha256'=NEW.output_sha256 AND r.proxy_snapshot->>'bytes'=NEW.output_bytes::text
  AND verified.sha256=NEW.output_sha256 AND verified.bytes=NEW.output_bytes) IS TRUE THEN
  RAISE EXCEPTION 'Reference generation handoff requires its exact live original dispatch and verified derivative' USING ERRCODE='23514';
 END IF;
 expected_work:=r.work_snapshot||jsonb_build_object('title',t.title,'description',t.description);
 IF NOT (NEW.source_snapshot->'schemaVersion'='1'::jsonb AND NEW.source_snapshot->'project'=r.project_snapshot AND NEW.source_snapshot->'work'=expected_work
  AND (r.project_snapshot-ARRAY['created_at','due_date'])=(to_jsonb(p)-ARRAY['revision','updated_at','created_at','due_date'])
  AND (r.project_snapshot->>'created_at')::timestamptz=date_trunc('milliseconds',p.created_at)
  AND left(r.project_snapshot->>'due_date',10) IS NOT DISTINCT FROM p.due_date::text
  AND NEW.source_snapshot#>>'{producer,runId}'=run.id::text AND NEW.source_snapshot#>>'{producer,agentId}'=a.id::text
  AND NEW.source_snapshot#>>'{producer,requestedBy}'=run.requested_by::text AND NEW.source_snapshot#>>'{producer,sponsorId}'=a.created_by::text
  AND NEW.source_snapshot#>>'{producer,tokenHash}'=a.token_hash
  AND NEW.source_snapshot#>'{producer,capabilities}'=(SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements_text(a.capabilities))
  AND NEW.source_snapshot#>'{producer,runCapabilities}'=(SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements_text(run.capabilities))
  AND NEW.source_snapshot#>'{producer,attempts}'=to_jsonb(run.attempts)
  AND (NEW.source_snapshot#>>'{producer,startedAt}')::timestamptz=date_trunc('milliseconds',run.started_at)
  AND NEW.source_snapshot#>'{producer,installation}'=CASE WHEN i.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',i.id,'revision',i.revision) END
  AND NEW.source_snapshot#>>'{coordinator,runId}'=parent.id::text AND NEW.source_snapshot#>>'{coordinator,agentId}'=coordinator.id::text
  AND NEW.source_snapshot#>>'{coordinator,requestedBy}'=parent.requested_by::text AND NEW.source_snapshot#>>'{coordinator,sponsorId}'=coordinator.created_by::text
  AND NEW.source_snapshot#>>'{coordinator,tokenHash}'=coordinator.token_hash
  AND NEW.source_snapshot#>'{coordinator,capabilities}'=(SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements_text(coordinator.capabilities))
  AND NEW.source_snapshot#>'{coordinator,runCapabilities}'=(SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements_text(parent.capabilities))
  AND NEW.source_snapshot#>'{coordinator,attempts}'=to_jsonb(parent.attempts)
  AND (NEW.source_snapshot#>>'{coordinator,startedAt}')::timestamptz=date_trunc('milliseconds',parent.started_at)
  AND NEW.source_snapshot#>'{coordinator,installation}'=CASE WHEN coordinator_installation.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',coordinator_installation.id,'revision',coordinator_installation.revision) END
  AND NEW.source_snapshot#>'{policy,revision}'=to_jsonb(policy.revision) AND NEW.source_snapshot#>>'{policy,coordinatorAgentId}'=policy.coordinator_agent_id::text
  AND NEW.source_snapshot#>>'{policy,approvedBy}'=policy.approved_by::text AND NEW.source_snapshot#>'{policy,authoritySnapshot}'=policy.authority_snapshot
  AND (NEW.source_snapshot#>>'{policy,expiresAt}')::timestamptz=date_trunc('milliseconds',policy.expires_at)) IS TRUE THEN
  RAISE EXCEPTION 'Reference generation snapshot does not match its relational source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_generation_handoff_guard BEFORE INSERT ON studio_reference_generation_handoffs FOR EACH ROW EXECUTE FUNCTION validate_reference_generation_handoff();

CREATE TABLE studio_reference_generation_inspection_adoptions (
 id uuid PRIMARY KEY,company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,reference_id uuid NOT NULL,handoff_id uuid NOT NULL,
 reference_revision integer NOT NULL CHECK(reference_revision>0),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),handoff_sha256 text NOT NULL CHECK(handoff_sha256~'^[a-f0-9]{64}$'),
 approved_by uuid NOT NULL REFERENCES users(id),approver_snapshot jsonb NOT NULL CHECK(jsonb_typeof(approver_snapshot)='object' AND pg_column_size(approver_snapshot)<=16384),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 approval_hash text NOT NULL CHECK(approval_hash~'^[a-f0-9]{64}$'),inspection_consent boolean NOT NULL CHECK(inspection_consent IS TRUE),max_attempts integer NOT NULL DEFAULT 1 CHECK(max_attempts=1),
 UNIQUE(company_id,id),UNIQUE(company_id,reference_id),UNIQUE(company_id,reference_id,id),UNIQUE(company_id,handoff_id),
 CHECK(expires_at>approved_at AND expires_at<=approved_at+interval '60 minutes'),
 FOREIGN KEY(company_id,project_id,handoff_id,reference_id) REFERENCES studio_reference_generation_handoffs(company_id,project_id,id,reference_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE higgsfield_references ADD CONSTRAINT higgsfield_reference_generation_adoption
 FOREIGN KEY(company_id,id,generation_inspection_adoption_id) REFERENCES studio_reference_generation_inspection_adoptions(company_id,reference_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION validate_reference_generation_inspection_adoption() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE h record;r record;run record;parent record;m record;p record;t record;
BEGIN
 SELECT * INTO h FROM studio_reference_generation_handoffs WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.handoff_id;
 SELECT * INTO r FROM higgsfield_references WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.reference_id;
 SELECT * INTO run FROM agent_runs WHERE company_id=NEW.company_id AND id=h.source_child_run_id;
 SELECT * INTO parent FROM agent_runs WHERE company_id=NEW.company_id AND id=h.initial_parent_run_id;
 SELECT * INTO m FROM memberships WHERE company_id=NEW.company_id AND user_id=NEW.approved_by;
 SELECT * INTO p FROM studio_coordination_policies WHERE company_id=NEW.company_id AND project_id=NEW.project_id;
 SELECT * INTO t FROM tasks WHERE company_id=NEW.company_id AND id=h.task_id;
 IF NOT (h.id IS NOT NULL AND h.work_item_id=NEW.work_item_id AND h.reference_id=NEW.reference_id AND h.handoff_sha256=NEW.handoff_sha256
  AND r.generation_handoff_id=h.id AND r.revision=NEW.reference_revision AND r.request_hash=NEW.request_hash AND r.request_hash=h.reference_request_hash
  AND r.status='proposed' AND r.inspection_authority IS NULL AND r.inspection_attempts=0 AND r.lease_id IS NULL AND r.approved_by IS NULL AND r.revoked_at IS NULL AND r.action_id IS NULL
  AND NEW.approved_at>=transaction_timestamp() AND NEW.approved_at<=clock_timestamp() AND NEW.expires_at>clock_timestamp() AND NEW.expires_at<=r.inspect_expires_at AND NEW.expires_at<=p.expires_at
  AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL AND NEW.approver_snapshot->>'userId'=m.user_id::text AND NEW.approver_snapshot->>'role'=m.role
  AND (NEW.approver_snapshot->>'joinedAt')::timestamptz=m.joined_at
  AND p.reference_generation_continuations AND p.status='active' AND p.revision=h.policy_revision AND p.expires_at>clock_timestamp()
  AND p.approved_by=h.requested_by AND p.coordinator_agent_id=h.coordinator_agent_id
  AND p.authority_snapshot=h.source_snapshot#>'{policy,authoritySnapshot}'
  AND date_trunc('milliseconds',p.expires_at)=(h.source_snapshot#>>'{policy,expiresAt}')::timestamptz
  AND run.status='succeeded' AND run.max_attempts=1 AND run.attempts=1 AND run.finished_at IS NOT NULL AND run.result_message_id IS NOT NULL
  AND run.agent_id=h.specialist_agent_id AND run.requested_by=h.requested_by
  AND date_trunc('milliseconds',run.started_at)=(h.source_snapshot#>>'{producer,startedAt}')::timestamptz
  AND parent.agent_id=h.coordinator_agent_id AND parent.requested_by=h.requested_by AND parent.attempts=(h.source_snapshot#>>'{coordinator,attempts}')::integer
  AND date_trunc('milliseconds',parent.started_at)=(h.source_snapshot#>>'{coordinator,startedAt}')::timestamptz
  AND ((parent.status='running' AND parent.lease_token_hash IS NOT NULL AND parent.lease_expires_at>clock_timestamp()) OR (parent.status='succeeded' AND parent.finished_at IS NOT NULL AND parent.result_message_id IS NOT NULL))
  AND t.status='doing' AND t.agent_run_id=run.id AND t.revision=h.task_revision) IS TRUE
  OR NOT EXISTS(SELECT 1 FROM agent_run_receipts WHERE company_id=NEW.company_id AND run_id=run.id AND kind='complete' AND response#>>'{run,id}'=run.id::text AND response#>>'{run,status}'='succeeded')
  OR (parent.status='succeeded' AND NOT EXISTS(SELECT 1 FROM agent_run_receipts WHERE company_id=NEW.company_id AND run_id=parent.id AND kind='complete' AND response#>>'{run,id}'=parent.id::text AND response#>>'{run,status}'='succeeded')) THEN
  RAISE EXCEPTION 'Inspection adoption requires exact successful generation handoff and finite owner consent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_generation_adoption_guard BEFORE INSERT ON studio_reference_generation_inspection_adoptions FOR EACH ROW EXECUTE FUNCTION validate_reference_generation_inspection_adoption();

-- This view is an intentionally narrow owner-executed metadata projection.
-- The dedicated broker receives no base preparation/derivation table access.
CREATE VIEW studio_reference_generation_adoption_facts WITH(security_barrier=true) AS
 SELECT a.company_id,a.project_id,a.handoff_id,a.reference_id,p.id AS preparation_id,p.status AS preparation_status,p.revision AS preparation_revision,
 p.revoked_at,p.cleanup_confirmed_at,d.source_version_id,d.source_sha256,d.source_bytes,d.output_version_id,d.output_sha256,d.output_bytes,d.recipe_sha256,d.receipt_sha256 AS derivation_sha256
 FROM studio_reference_generation_inspection_adoptions a
 JOIN studio_reference_generation_handoffs h ON (h.company_id,h.project_id,h.id,h.reference_id)=(a.company_id,a.project_id,a.handoff_id,a.reference_id)
 JOIN project_image_preparations p ON (p.company_id,p.project_id,p.id)=(h.company_id,h.project_id,h.preparation_id)
 JOIN project_image_preparation_derivations d ON (d.company_id,d.project_id,d.preparation_id)=(p.company_id,p.project_id,p.id);

CREATE TABLE studio_reference_generation_followups (
 company_id uuid NOT NULL,project_id uuid NOT NULL,handoff_id uuid NOT NULL,work_item_id uuid NOT NULL,task_id uuid NOT NULL,
 source_child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,child_run_id uuid NOT NULL,coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision>0),approved_by uuid NOT NULL REFERENCES users(id),initial_task_revision integer NOT NULL CHECK(initial_task_revision>0),
 reference_id uuid NOT NULL,reference_revision integer NOT NULL CHECK(reference_revision>0),reference_approval_hash text NOT NULL CHECK(reference_approval_hash~'^[a-f0-9]{64}$'),media_id uuid NOT NULL,
 claim_request_id uuid NOT NULL,proposal_request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,child_run_id),UNIQUE(company_id,project_id,child_run_id),UNIQUE(company_id,handoff_id),UNIQUE(company_id,reference_id),
 CHECK(source_child_run_id<>parent_run_id AND source_child_run_id<>child_run_id AND parent_run_id<>child_run_id AND claim_request_id<>proposal_request_id),
 FOREIGN KEY(company_id,project_id,handoff_id,reference_id) REFERENCES studio_reference_generation_handoffs(company_id,project_id,id,reference_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,source_child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,reference_id) REFERENCES higgsfield_reference_confirmations(company_id,reference_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_reference_generation_followup_steps (
 company_id uuid NOT NULL,project_id uuid NOT NULL,child_run_id uuid NOT NULL,request_id uuid NOT NULL,
 step text NOT NULL CHECK(step IN ('claim','proposal')),
 PRIMARY KEY(company_id,request_id),UNIQUE(company_id,child_run_id,step),
 FOREIGN KEY(company_id,project_id,child_run_id) REFERENCES studio_reference_generation_followups(company_id,project_id,child_run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION reference_generation_followup_steps_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO studio_reference_generation_followup_steps(company_id,project_id,child_run_id,request_id,step) VALUES
 (NEW.company_id,NEW.project_id,NEW.child_run_id,NEW.claim_request_id,'claim'),(NEW.company_id,NEW.project_id,NEW.child_run_id,NEW.proposal_request_id,'proposal');
 RETURN NULL;
END $$;
CREATE TRIGGER reference_generation_followup_steps_insert AFTER INSERT ON studio_reference_generation_followups FOR EACH ROW EXECUTE FUNCTION reference_generation_followup_steps_insert();
CREATE FUNCTION validate_reference_generation_followup_step() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected uuid;
BEGIN
 SELECT CASE NEW.step WHEN 'claim' THEN claim_request_id WHEN 'proposal' THEN proposal_request_id END INTO expected
 FROM studio_reference_generation_followups WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND child_run_id=NEW.child_run_id;
 IF expected IS DISTINCT FROM NEW.request_id THEN RAISE EXCEPTION 'Generation continuation step is not its exact request' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_generation_followup_step_guard BEFORE INSERT ON studio_reference_generation_followup_steps FOR EACH ROW EXECUTE FUNCTION validate_reference_generation_followup_step();
CREATE FUNCTION validate_reference_generation_followup() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE h record;r record;confirmation record;policy record;source_run record;parent record;child record;t record;
BEGIN
 SELECT * INTO h FROM studio_reference_generation_handoffs WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.handoff_id;
 SELECT * INTO r FROM higgsfield_references WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.reference_id;
 SELECT * INTO confirmation FROM higgsfield_reference_confirmations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND reference_id=NEW.reference_id;
 SELECT * INTO policy FROM studio_coordination_policies WHERE company_id=NEW.company_id AND project_id=NEW.project_id;
 SELECT * INTO source_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.source_child_run_id;
 SELECT * INTO parent FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.parent_run_id;
 SELECT * INTO child FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.child_run_id;
 SELECT * INTO t FROM tasks WHERE company_id=NEW.company_id AND id=NEW.task_id;
 IF NOT (h.id IS NOT NULL AND h.work_item_id=NEW.work_item_id AND h.task_id=NEW.task_id AND h.source_child_run_id=NEW.source_child_run_id
  AND h.specialist_agent_id=NEW.specialist_agent_id AND h.coordinator_agent_id=NEW.coordinator_agent_id AND h.policy_revision=NEW.policy_revision
  AND policy.revision=NEW.policy_revision AND policy.reference_generation_continuations AND policy.status='active' AND policy.expires_at>clock_timestamp()
  AND policy.approved_by=NEW.approved_by AND policy.coordinator_agent_id=NEW.coordinator_agent_id AND policy.runs_started<policy.max_runs
  AND r.generation_handoff_id=h.id AND r.status='confirmed' AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()
  AND r.revision=NEW.reference_revision AND r.approval_hash=NEW.reference_approval_hash AND confirmation.approval_hash=r.approval_hash AND confirmation.request_hash=h.reference_request_hash
  AND confirmation.media_id=NEW.media_id AND confirmation.bytes=h.output_bytes AND confirmation.sha256=h.output_sha256
  AND source_run.status='succeeded' AND source_run.max_attempts=1 AND source_run.attempts=1 AND source_run.finished_at IS NOT NULL AND source_run.result_message_id IS NOT NULL
  AND parent.status='running' AND parent.agent_id=NEW.coordinator_agent_id AND parent.requested_by=NEW.approved_by AND parent.lease_token_hash IS NOT NULL AND parent.lease_expires_at>clock_timestamp()
  AND child.status='queued' AND child.agent_id=NEW.specialist_agent_id AND child.requested_by=NEW.approved_by AND child.max_attempts=1 AND child.attempts=0 AND child.started_at IS NULL AND child.created_at>=transaction_timestamp()
  AND t.status='doing' AND t.agent_run_id=NEW.source_child_run_id AND t.revision=NEW.initial_task_revision AND t.revision=h.task_revision
  AND (NEW.coordinator_agent_id<>NEW.specialist_agent_id OR policy.coordinator_generation)) IS TRUE
  OR NOT EXISTS(SELECT 1 FROM studio_reference_generation_inspection_adoptions a
   JOIN studio_reference_generation_adoption_facts f ON (f.company_id,f.project_id,f.handoff_id,f.reference_id)=(a.company_id,a.project_id,a.handoff_id,a.reference_id)
   WHERE a.company_id=NEW.company_id AND a.project_id=NEW.project_id AND a.handoff_id=h.id AND a.reference_id=r.id AND a.id=r.generation_inspection_adoption_id
    AND f.preparation_status='ready' AND f.preparation_revision=h.preparation_revision AND f.revoked_at IS NULL AND f.cleanup_confirmed_at IS NOT NULL
    AND f.source_version_id=h.source_version_id AND f.source_sha256=h.source_sha256 AND f.source_bytes=h.source_bytes
    AND f.output_version_id=h.output_version_id AND f.output_sha256=h.output_sha256 AND f.output_bytes=h.output_bytes
    AND f.recipe_sha256=h.recipe_sha256 AND f.derivation_sha256=h.derivation_sha256)
  OR NOT EXISTS(SELECT 1 FROM agent_run_receipts WHERE company_id=NEW.company_id AND run_id=source_run.id AND kind='complete' AND response#>>'{run,id}'=source_run.id::text AND response#>>'{run,status}'='succeeded')
  OR NOT EXISTS(SELECT 1 FROM studio_dispatches WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND work_item_id=NEW.work_item_id AND run_id=NEW.child_run_id AND created_at>=transaction_timestamp()) THEN
  RAISE EXCEPTION 'Generation continuation requires exact confirmed reference and fresh single-attempt dispatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_generation_followup_guard BEFORE INSERT ON studio_reference_generation_followups FOR EACH ROW EXECUTE FUNCTION validate_reference_generation_followup();

-- Update guards, no DELETE grants/triggers: owner company cascades still work.
DO $immutable$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['studio_reference_generation_handoffs','studio_reference_generation_inspection_adoptions','studio_reference_generation_followups','studio_reference_generation_followup_steps'] LOOP
  EXECUTE format('CREATE TRIGGER reference_generation_immutable BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_project_image_preparation_immutable()',relation);
  EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER reference_generation_immutable',relation);
 END LOOP;
END $immutable$;

-- Legacy prepared-image attempts keep their existing three-attempt contract.
-- The new explicitly adopted path has one attempt and never extends either
-- the original reference expiry or the owner's finite adoption deadline.
CREATE OR REPLACE FUNCTION guard_higgsfield_reference_broker_attempts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE adoption record;maximum integer;deadline timestamptz;durable boolean;
BEGIN
 IF current_user<>'coatria_higgsfield_reference_broker_v1' THEN RETURN NEW;END IF;
 durable:=OLD.inspection_authority IS NOT NULL;maximum:=3;deadline:=OLD.inspect_expires_at;
 IF OLD.generation_handoff_id IS NOT NULL THEN
  SELECT a.* INTO adoption FROM public.studio_reference_generation_inspection_adoptions a
  JOIN public.memberships m ON m.company_id=a.company_id AND m.user_id=a.approved_by
  WHERE a.company_id=OLD.company_id AND a.project_id=OLD.project_id AND a.reference_id=OLD.id
   AND a.id=OLD.generation_inspection_adoption_id AND a.handoff_id=OLD.generation_handoff_id AND a.request_hash=OLD.request_hash AND a.max_attempts=1 AND a.inspection_consent
   AND a.expires_at>clock_timestamp() AND a.expires_at<=OLD.inspect_expires_at
   AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL
   AND a.approver_snapshot->>'userId'=m.user_id::text AND a.approver_snapshot->>'role'=m.role
   AND (a.approver_snapshot->>'joinedAt')::timestamptz=m.joined_at;
  durable:=adoption.id IS NOT NULL AND OLD.inspection_authority IS NULL;maximum:=1;deadline:=adoption.expires_at;
 END IF;
 IF NEW.inspection_attempts IS DISTINCT FROM OLD.inspection_attempts OR
  (NEW.status='inspecting' AND (NEW.inspection_authority IS NOT NULL OR NEW.generation_handoff_id IS NOT NULL) AND
   (OLD.status<>'inspecting' OR NEW.lease_id IS DISTINCT FROM OLD.lease_id OR
    (OLD.lease_expires_at<=clock_timestamp() AND NEW.lease_expires_at>clock_timestamp()))) THEN
  IF NOT (durable AND NEW.inspection_attempts=OLD.inspection_attempts+1 AND NEW.inspection_attempts<=maximum
   AND OLD.approved_by IS NULL AND OLD.revoked_at IS NULL AND OLD.status IN ('proposed','inspecting')
   AND (OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp())
   AND NEW.status='inspecting' AND NEW.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id
   AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=OLD.inspect_expires_at
   AND NEW.lease_expires_at<=deadline AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds') IS TRUE THEN
   RAISE EXCEPTION 'reference inspection attempt transition rejected' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Preserve original archive provenance; a continued request retains its actual
-- producer run. Only validated immutable lineage can connect it to the initial
-- dispatch. Every other original archive/request/verification check is retained.
CREATE OR REPLACE FUNCTION studio_generated_followup_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p record;w record;unit record;task record;dispatch record;policy record;source_run record;parent_run record;child_run record;archive record;request record;receipt record;job record;output record;version record;verified record;fetched record;upload record;artifact record;expected_work jsonb;
BEGIN
 -- This checks relationships at receipt creation. Current lease, capabilities,
 -- gates, sponsorship and revocation must still be rechecked by every service
 -- action and cached replay; immutable historical evidence is not authority.
 SELECT * INTO p FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id;
 SELECT * INTO w FROM studio_work_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.work_item_id;
 SELECT * INTO unit FROM studio_shots WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=w.shot_id;
 SELECT * INTO task FROM tasks WHERE company_id=NEW.company_id AND id=NEW.task_id FOR SHARE;
 SELECT * INTO dispatch FROM studio_coordination_dispatches WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND work_item_id=NEW.work_item_id;
 SELECT * INTO policy FROM studio_coordination_policies WHERE company_id=NEW.company_id AND project_id=NEW.project_id FOR SHARE;
 SELECT * INTO source_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.source_child_run_id FOR SHARE;
 SELECT * INTO parent_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.parent_run_id FOR SHARE;
 SELECT * INTO child_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.child_run_id FOR SHARE;
 IF p.contract_version IS DISTINCT FROM 2 OR p.production_path IS DISTINCT FROM 'higgsfield' OR w.stage IS DISTINCT FROM 'generation' OR w.execution IS DISTINCT FROM 'creative' OR w.task_id IS DISTINCT FROM NEW.task_id OR unit.media_kind IS DISTINCT FROM p.spec->>'kind'
  OR (dispatch.child_run_id IS DISTINCT FROM NEW.source_child_run_id AND NOT EXISTS (
   SELECT 1 FROM public.studio_reference_generation_followups continued
   JOIN public.studio_reference_generation_handoffs handoff ON handoff.company_id=continued.company_id AND handoff.project_id=continued.project_id AND handoff.id=continued.handoff_id
   JOIN public.higgsfield_requests produced ON produced.company_id=continued.company_id AND produced.project_id=continued.project_id AND produced.id=NEW.request_id
   WHERE continued.company_id=NEW.company_id AND continued.project_id=NEW.project_id AND continued.work_item_id=NEW.work_item_id
    AND continued.child_run_id=NEW.source_child_run_id AND continued.source_child_run_id=dispatch.child_run_id
    AND continued.specialist_agent_id=NEW.specialist_agent_id AND continued.task_id=NEW.task_id
    AND handoff.source_child_run_id=dispatch.child_run_id AND handoff.initial_parent_run_id=dispatch.parent_run_id
    AND produced.run_id=continued.child_run_id AND produced.client_id=continued.proposal_request_id AND produced.reference_ids=ARRAY[continued.reference_id]
  )) OR dispatch.specialist_agent_id IS DISTINCT FROM NEW.specialist_agent_id
  OR source_run.agent_id IS DISTINCT FROM NEW.specialist_agent_id OR source_run.status IS NULL OR source_run.status NOT IN('succeeded','failed','cancelled')
  OR parent_run.agent_id IS DISTINCT FROM NEW.coordinator_agent_id OR parent_run.requested_by IS DISTINCT FROM NEW.approved_by
  OR child_run.agent_id IS DISTINCT FROM NEW.specialist_agent_id OR child_run.requested_by IS DISTINCT FROM NEW.approved_by OR child_run.max_attempts IS DISTINCT FROM 1
  OR task.revision IS DISTINCT FROM NEW.initial_task_revision OR task.agent_run_id IS DISTINCT FROM NEW.source_child_run_id OR task.status IS NULL OR task.status NOT IN('todo','doing')
  OR policy.generated_continuations IS DISTINCT FROM true OR policy.revision IS DISTINCT FROM NEW.policy_revision OR policy.coordinator_agent_id IS DISTINCT FROM NEW.coordinator_agent_id OR policy.approved_by IS DISTINCT FROM NEW.approved_by
 THEN RAISE EXCEPTION 'Generated continuation does not match its initial dispatch and reviewed task' USING ERRCODE='23514';END IF;
 SELECT * INTO archive FROM higgsfield_output_archives WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.archive_id FOR SHARE;
 SELECT * INTO request FROM higgsfield_requests WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.request_id FOR SHARE;
 SELECT * INTO receipt FROM higgsfield_job_receipts WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND request_id=NEW.request_id;
 SELECT * INTO job FROM higgsfield_jobs WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.job_id FOR SHARE;
 SELECT * INTO output FROM higgsfield_job_outputs WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.output_id;
 SELECT * INTO version FROM project_storage_versions WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.storage_version_id;
 SELECT * INTO verified FROM project_storage_verifications WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND version_id=NEW.storage_version_id;
 SELECT * INTO fetched FROM higgsfield_archive_fetches WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND archive_id=NEW.archive_id;
 SELECT * INTO upload FROM project_storage_uploads WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=archive.upload_id FOR SHARE;
 IF archive.status IS DISTINCT FROM 'verified' OR archive.revoked_at IS NOT NULL OR archive.approved_by IS NULL OR archive.request_id IS DISTINCT FROM NEW.request_id OR archive.job_id IS DISTINCT FROM NEW.job_id OR archive.output_id IS DISTINCT FROM NEW.output_id OR archive.version_id IS DISTINCT FROM NEW.storage_version_id
  OR request.status IS DISTINCT FROM 'returned' OR request.run_id IS DISTINCT FROM NEW.source_child_run_id OR request.agent_id IS DISTINCT FROM NEW.specialist_agent_id OR request.role_agent_id IS DISTINCT FROM NEW.specialist_agent_id OR request.role_human_id IS NOT NULL OR request.work_item_id IS DISTINCT FROM NEW.work_item_id OR request.requested_by IS DISTINCT FROM source_run.requested_by OR request.tool IS DISTINCT FROM 'generate_'||(p.spec->>'kind')
  OR receipt.outcome IS DISTINCT FROM 'jobs' OR receipt.request_hash IS DISTINCT FROM request.request_hash OR receipt.approved_by IS DISTINCT FROM request.approved_by OR receipt.connection_id IS DISTINCT FROM request.connection_id OR receipt.connection_revision IS DISTINCT FROM request.connection_revision OR archive.provider_connection_revision IS DISTINCT FROM receipt.connection_revision
  OR job.status IS DISTINCT FROM 'completed' OR job.request_id IS DISTINCT FROM NEW.request_id OR job.connection_id IS DISTINCT FROM archive.provider_connection_id OR job.connection_id IS DISTINCT FROM request.connection_id OR job.kind IS DISTINCT FROM p.spec->>'kind'
  OR output.job_id IS DISTINCT FROM NEW.job_id OR output.kind IS DISTINCT FROM job.kind OR output.locator_identity IS DISTINCT FROM archive.locator_identity
  OR upload.status IS DISTINCT FROM 'ready' OR upload.archive_id IS DISTINCT FROM NEW.archive_id OR upload.version_id IS DISTINCT FROM NEW.storage_version_id OR upload.action_id IS NOT NULL OR upload.provider_etag IS DISTINCT FROM verified.provider_etag OR upload.actor_user_id IS DISTINCT FROM archive.approved_by
  OR fetched.locator_identity IS DISTINCT FROM output.locator_identity OR fetched.bytes IS DISTINCT FROM NEW.file_bytes OR fetched.sha256 IS DISTINCT FROM NEW.file_sha256 OR version.bytes IS DISTINCT FROM NEW.file_bytes OR (version.sha256 IS NOT NULL AND version.sha256 IS DISTINCT FROM NEW.file_sha256) OR verified.bytes IS DISTINCT FROM NEW.file_bytes OR verified.sha256 IS DISTINCT FROM NEW.file_sha256
  OR fetched.media->>'kind' IS DISTINCT FROM p.spec->>'kind' OR fetched.media->>'verification' IS DISTINCT FROM 'full_decode' OR fetched.media->'inspectionVersion' IS DISTINCT FROM '1'::jsonb OR fetched.media->'bytes' IS DISTINCT FROM to_jsonb(NEW.file_bytes) OR fetched.media->>'sha256' IS DISTINCT FROM NEW.file_sha256 OR fetched.media->>'contentType' IS DISTINCT FROM version.content_type
 THEN RAISE EXCEPTION 'Generated continuation source does not match its exact verified archive' USING ERRCODE='23514';END IF;
 IF archive.source_snapshot->>'requestId' IS DISTINCT FROM NEW.request_id::text OR archive.source_snapshot->>'requestHash' IS DISTINCT FROM request.request_hash OR archive.source_snapshot->>'receiptHash' IS DISTINCT FROM receipt.source_sha256 OR archive.source_snapshot->>'contract' IS DISTINCT FROM receipt.contract
  OR archive.source_snapshot->>'providerConnectionId' IS DISTINCT FROM request.connection_id::text OR archive.source_snapshot->'requestConnectionRevision' IS DISTINCT FROM to_jsonb(request.connection_revision) OR archive.source_snapshot->>'providerJobId' IS DISTINCT FROM job.provider_job_id::text
  OR archive.source_snapshot->>'kind' IS DISTINCT FROM output.kind OR archive.source_snapshot->>'model' IS DISTINCT FROM job.model OR archive.source_snapshot->>'outputId' IS DISTINCT FROM NEW.output_id::text OR archive.source_snapshot->'ordinal' IS DISTINCT FROM to_jsonb(output.ordinal) OR archive.source_snapshot->>'outputIdentity' IS DISTINCT FROM output.locator_identity
  OR archive.source_snapshot->>'requestedBy' IS DISTINCT FROM request.requested_by::text OR archive.source_snapshot->>'agentId' IS DISTINCT FROM NEW.specialist_agent_id::text OR archive.source_snapshot->>'runId' IS DISTINCT FROM NEW.source_child_run_id::text OR archive.source_snapshot->>'approvedBy' IS DISTINCT FROM receipt.approved_by::text
  OR archive.source_snapshot->>'workItemId' IS DISTINCT FROM NEW.work_item_id::text OR archive.source_snapshot->>'taskId' IS DISTINCT FROM NEW.task_id::text OR archive.source_snapshot->>'roleKey' IS DISTINCT FROM w.role_key OR archive.source_snapshot->>'roleAgentId' IS DISTINCT FROM request.role_agent_id::text OR archive.source_snapshot->>'roleHumanId' IS DISTINCT FROM request.role_human_id::text
 THEN RAISE EXCEPTION 'Generated continuation original attribution conflicts with the archive' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM project_storage_files f JOIN project_storage_bindings b ON b.company_id=f.company_id AND b.project_id=f.project_id AND b.id=f.binding_id WHERE f.company_id=NEW.company_id AND f.project_id=NEW.project_id AND f.id=version.file_id AND b.id=archive.storage_binding_id AND b.connection_id=archive.storage_connection_id) THEN RAISE EXCEPTION 'Generated continuation storage identity conflicts' USING ERRCODE='23514';END IF;
 expected_work:=jsonb_build_object('kind',unit.media_kind,'code',unit.code,'description',unit.description);
 IF unit.media_kind IN('video','audio') THEN expected_work:=expected_work||jsonb_build_object('durationMs',jsonb_build_object('min',unit.duration_min_ms,'max',unit.duration_max_ms));END IF;
 IF NEW.spec_sha256 IS DISTINCT FROM encode(sha256(convert_to(studio_generated_canonical(jsonb_build_object('schemaVersion',2,'kind','generated_specification','spec',p.spec,'workUnit',expected_work)),'UTF8')),'hex') THEN RAISE EXCEPTION 'Generated continuation specification hash conflicts' USING ERRCODE='23514';END IF;
 IF NEW.artifact_id IS NOT NULL THEN
  SELECT * INTO artifact FROM studio_generated_artifact_sources WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND artifact_id=NEW.artifact_id;
  IF artifact.work_item_id IS DISTINCT FROM NEW.work_item_id OR artifact.archive_id IS DISTINCT FROM NEW.archive_id OR artifact.request_id IS DISTINCT FROM NEW.request_id OR artifact.job_id IS DISTINCT FROM NEW.job_id OR artifact.output_id IS DISTINCT FROM NEW.output_id OR artifact.storage_version_id IS DISTINCT FROM NEW.storage_version_id OR artifact.spec_sha256 IS DISTINCT FROM NEW.spec_sha256 OR artifact.manifest_sha256 IS DISTINCT FROM NEW.artifact_sha256 THEN RAISE EXCEPTION 'Generated continuation artifact is not the pinned source' USING ERRCODE='23514';END IF;
 END IF;
 IF (SELECT count(*) FROM studio_generated_followup_steps WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND child_run_id=NEW.child_run_id)<>3 THEN RAISE EXCEPTION 'Generated continuation needs all three pinned steps' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
