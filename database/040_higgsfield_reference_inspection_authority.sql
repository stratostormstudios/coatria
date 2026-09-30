-- Explicit human dispatch selection, never inferred from prompt text or added
-- retrospectively to a running/completed request. The existing planning path
-- does not insert this marker and retains its original authority contract.
ALTER TABLE studio_dispatches ADD CONSTRAINT studio_dispatches_exact_scope UNIQUE(company_id,project_id,work_item_id,run_id);
CREATE TABLE studio_reference_preparation_dispatches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,run_id uuid NOT NULL,
 authority_version integer NOT NULL DEFAULT 1 CHECK(authority_version=1),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,run_id),
 FOREIGN KEY(company_id,project_id,work_item_id,run_id) REFERENCES studio_dispatches(company_id,project_id,work_item_id,run_id) ON DELETE CASCADE
);
CREATE FUNCTION validate_reference_preparation_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
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
 ) THEN RAISE EXCEPTION 'Reference preparation requires a new explicit human task dispatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_preparation_dispatch_guard BEFORE INSERT ON studio_reference_preparation_dispatches FOR EACH ROW EXECUTE FUNCTION validate_reference_preparation_dispatch();
ALTER TABLE higgsfield_references ADD COLUMN inspection_authority jsonb,
 ADD COLUMN inspection_authority_sha256 text,
 ADD COLUMN inspection_attempts integer NOT NULL DEFAULT 0 CHECK(inspection_attempts BETWEEN 0 AND 3),
 ADD CONSTRAINT reference_inspection_authority_shape CHECK (
  (inspection_authority IS NULL AND inspection_authority_sha256 IS NULL) OR
  (inspection_authority IS NOT NULL AND jsonb_typeof(inspection_authority)='object' AND inspection_authority->>'version'='1'
   AND inspection_authority->>'mode'='prepared_image_v1' AND proposed_agent_id IS NOT NULL AND proposed_run_id IS NOT NULL
   AND inspection_authority_sha256 IS NOT NULL AND inspection_authority_sha256~'^[a-f0-9]{64}$')
 );
