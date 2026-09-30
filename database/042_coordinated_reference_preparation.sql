-- Existing policies and direct-human markers remain unchanged and default off.
ALTER TABLE studio_coordination_policies ADD COLUMN reference_preparation_profile text
 CHECK(reference_preparation_profile IS NULL OR reference_preparation_profile='prepared_image_v1');
ALTER TABLE studio_reference_preparation_dispatches ADD COLUMN coordination jsonb
 CHECK(coordination IS NULL OR (jsonb_typeof(coordination)='object' AND coordination->>'version'='1'));
CREATE OR REPLACE FUNCTION validate_reference_preparation_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id
  JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
  JOIN memberships m ON m.company_id=r.company_id AND m.user_id=r.requested_by
  WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.run_id=NEW.run_id
   AND d.created_at>=transaction_timestamp() AND r.created_at>=transaction_timestamp()
   AND r.status='queued' AND r.attempts=0 AND r.started_at IS NULL AND r.purpose='task'
   AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL
   AND p.contract_version=2 AND p.production_path='higgsfield' AND w.stage='references' AND w.execution='agent'
 ) THEN RAISE EXCEPTION 'Reference preparation requires a new approved task dispatch' USING ERRCODE='23514'; END IF;
 IF NEW.coordination IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM studio_coordination_dispatches d
  JOIN studio_coordination_policies p ON p.company_id=d.company_id AND p.project_id=d.project_id
  JOIN agent_runs child ON child.company_id=d.company_id AND child.id=d.child_run_id
  JOIN agent_runs parent ON parent.company_id=d.company_id AND parent.id=d.parent_run_id
  JOIN agents a ON a.company_id=d.company_id AND a.id=d.coordinator_agent_id
  JOIN plugin_installations i ON i.company_id=a.company_id AND i.agent_id=a.id
  WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.child_run_id=NEW.run_id
   AND d.created_at>=transaction_timestamp() AND d.coordinator_agent_id<>d.specialist_agent_id
   AND p.reference_preparation_profile='prepared_image_v1' AND p.status='active' AND p.expires_at>clock_timestamp()
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
-- No additional table/column grants. Markers remain SELECT/INSERT only; neither
-- policy approval nor an agent run can mutate a committed marker's provenance.
