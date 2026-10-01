-- Separate opt-in original-image planning; existing prepared-image markers do
-- not acquire transformation, provider, storage-write or approval authority.
ALTER TABLE studio_dispatches ADD COLUMN original_preparation_profile text
 CHECK(original_preparation_profile IS NULL OR original_preparation_profile='original_image_v1');
CREATE FUNCTION guard_original_image_dispatch_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.original_preparation_profile IS DISTINCT FROM OLD.original_preparation_profile THEN
  RAISE EXCEPTION 'A committed dispatch cannot change its original-image profile' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER original_image_dispatch_profile_immutable BEFORE UPDATE ON studio_dispatches
 FOR EACH ROW EXECUTE FUNCTION guard_original_image_dispatch_profile();
ALTER TABLE studio_dispatches ENABLE ALWAYS TRIGGER original_image_dispatch_profile_immutable;
ALTER TABLE studio_coordination_policies DROP CONSTRAINT studio_coordination_policies_reference_preparation_profil_check;
ALTER TABLE studio_coordination_policies ADD CONSTRAINT studio_coordination_policies_reference_preparation_profile_check
 CHECK(reference_preparation_profile IS NULL OR reference_preparation_profile IN ('prepared_image_v1','original_image_v1'));
CREATE TABLE studio_image_preparation_dispatches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,run_id uuid NOT NULL,
 authority_version integer NOT NULL DEFAULT 1 CHECK(authority_version=1),
 coordination jsonb CHECK(coordination IS NULL OR (jsonb_typeof(coordination)='object' AND coordination->>'version'='1') IS TRUE),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,run_id),
 FOREIGN KEY(company_id,project_id,work_item_id,run_id) REFERENCES studio_dispatches(company_id,project_id,work_item_id,run_id) ON DELETE CASCADE
);
CREATE FUNCTION validate_original_image_preparation_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id
  JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
  JOIN memberships m ON m.company_id=r.company_id AND m.user_id=r.requested_by
  WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.run_id=NEW.run_id
   AND d.original_preparation_profile='original_image_v1'
   AND d.created_at>=transaction_timestamp() AND r.created_at>=transaction_timestamp()
   AND r.status='queued' AND r.max_attempts=1 AND r.attempts=0 AND r.started_at IS NULL AND r.purpose='task'
   AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL
   AND p.contract_version=2 AND p.production_path='higgsfield' AND w.stage='references' AND w.execution='agent'
 ) THEN RAISE EXCEPTION 'Reference preparation requires a new approved task dispatch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM studio_reference_preparation_dispatches WHERE company_id=NEW.company_id AND run_id=NEW.run_id) THEN RAISE EXCEPTION 'Preparation profiles cannot overlap' USING ERRCODE='23514'; END IF;
 IF NEW.coordination IS NULL AND EXISTS(SELECT 1 FROM studio_coordination_dispatches WHERE company_id=NEW.company_id AND child_run_id=NEW.run_id) THEN RAISE EXCEPTION 'Coordinated preparation requires exact parent authority' USING ERRCODE='23514'; END IF;
 IF NEW.coordination IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM studio_coordination_dispatches d
  JOIN studio_coordination_policies p ON p.company_id=d.company_id AND p.project_id=d.project_id
  JOIN agent_runs child ON child.company_id=d.company_id AND child.id=d.child_run_id
  JOIN agent_runs parent ON parent.company_id=d.company_id AND parent.id=d.parent_run_id
  JOIN agents a ON a.company_id=d.company_id AND a.id=d.coordinator_agent_id
  JOIN plugin_installations i ON i.company_id=a.company_id AND i.agent_id=a.id
  WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.child_run_id=NEW.run_id
   AND d.created_at>=transaction_timestamp() AND d.coordinator_agent_id<>d.specialist_agent_id
   AND p.reference_preparation_profile='original_image_v1' AND p.status='active' AND p.expires_at>clock_timestamp()
   AND p.revision=d.policy_revision AND p.coordinator_agent_id=d.coordinator_agent_id
   AND child.max_attempts=1 AND child.requested_by=p.approved_by AND parent.requested_by=p.approved_by
   AND parent.status='running' AND parent.lease_expires_at>clock_timestamp()
   AND NEW.coordination->>'parentRunId'=parent.id::text
   AND (NEW.coordination->>'parentAttempt')::integer=parent.attempts
   AND (NEW.coordination->>'parentStartedAt')::timestamptz=date_trunc('milliseconds',parent.started_at)
   AND NEW.coordination->>'coordinatorAgentId'=a.id::text
   AND NEW.coordination->>'coordinatorSponsorId'=a.created_by::text
   AND NEW.coordination->>'coordinatorCredentialSha256'=a.token_hash
   AND NEW.coordination#>>'{coordinatorInstallation,id}'=i.id::text
   AND (NEW.coordination#>>'{coordinatorInstallation,revision}')::integer=i.revision
   AND (NEW.coordination->>'policyRevision')::integer=p.revision
   AND NEW.coordination->>'approvedBy'=p.approved_by::text
   AND (NEW.coordination->>'expiresAt')::timestamptz=p.expires_at
   AND NEW.coordination->>'authoritySha256'~'^[a-f0-9]{64}$'
 ) THEN RAISE EXCEPTION 'Reference preparation requires exact fresh coordinator authority' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER original_image_preparation_dispatch_guard BEFORE INSERT ON studio_image_preparation_dispatches
 FOR EACH ROW EXECUTE FUNCTION validate_original_image_preparation_dispatch();
CREATE TRIGGER original_image_preparation_dispatch_immutable BEFORE UPDATE ON studio_image_preparation_dispatches
 FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
ALTER TABLE studio_image_preparation_dispatches ENABLE ALWAYS TRIGGER original_image_preparation_dispatch_guard;
ALTER TABLE studio_image_preparation_dispatches ENABLE ALWAYS TRIGGER original_image_preparation_dispatch_immutable;
-- No runtime grants or processor configuration; cascades remain available.
