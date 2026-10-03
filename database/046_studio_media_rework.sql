-- Internal QC correction is an explicit opt-in, not a client revision round.
-- It consumes the existing lifetime coordination budget and grants no provider execution.
ALTER TABLE studio_coordination_policies ADD COLUMN media_rework boolean NOT NULL DEFAULT false;
ALTER TABLE studio_dispatches ADD COLUMN media_rework_review_id uuid;
ALTER TABLE studio_dispatches ADD CONSTRAINT studio_rework_markers_exclusive CHECK(planning_rework_review_id IS NULL OR media_rework_review_id IS NULL);
CREATE TABLE studio_media_rework_dispatches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,review_id uuid NOT NULL,
 task_id uuid NOT NULL,task_revision integer NOT NULL CHECK(task_revision>0),
 artifact_id uuid NOT NULL,artifact_version integer NOT NULL CHECK(artifact_version>0),round_id uuid,
 source_child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,child_run_id uuid NOT NULL,
 coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision>0),approved_by uuid NOT NULL REFERENCES users(id),
 parent_attempt integer NOT NULL CHECK(parent_attempt>0),parent_started_at timestamptz NOT NULL,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,review_id),
 UNIQUE(company_id,artifact_id),UNIQUE(company_id,child_run_id),
 CHECK(source_child_run_id<>child_run_id AND parent_run_id<>child_run_id AND parent_run_id<>source_child_run_id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_coordination_policies(company_id,project_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id,child_run_id) REFERENCES studio_dispatches(company_id,project_id,work_item_id,run_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id,source_child_run_id) REFERENCES studio_dispatches(company_id,project_id,work_item_id,run_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,review_id,artifact_id) REFERENCES studio_reviews(company_id,project_id,id,artifact_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,review_id) REFERENCES studio_generated_review_evidence(company_id,project_id,review_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,artifact_id,work_item_id) REFERENCES studio_artifacts(company_id,project_id,id,work_item_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,round_id) REFERENCES studio_generated_revision_rounds(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,specialist_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX studio_media_rework_project ON studio_media_rework_dispatches(company_id,project_id,created_at DESC,child_run_id DESC);
CREATE TRIGGER studio_media_rework_immutable BEFORE UPDATE OR DELETE ON studio_media_rework_dispatches FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
ALTER TABLE studio_dispatches ADD CONSTRAINT studio_media_rework_marker_fk FOREIGN KEY(company_id,media_rework_review_id) REFERENCES studio_media_rework_dispatches(company_id,review_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_studio_media_rework() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM studio_reviews v
  JOIN studio_generated_review_evidence e ON e.company_id=v.company_id AND e.project_id=v.project_id AND e.review_id=v.id AND e.artifact_id=v.artifact_id
  JOIN studio_artifacts a ON a.company_id=v.company_id AND a.project_id=v.project_id AND a.id=v.artifact_id
  JOIN studio_generated_artifact_sources s ON s.company_id=a.company_id AND s.project_id=a.project_id AND s.artifact_id=a.id
  JOIN studio_work_items w ON w.company_id=a.company_id AND w.project_id=a.project_id AND w.id=a.work_item_id
  JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN studio_projects project ON project.company_id=w.company_id AND project.id=w.project_id
  JOIN studio_coordination_policies p ON p.company_id=w.company_id AND p.project_id=w.project_id
  JOIN agent_runs source ON source.company_id=w.company_id AND source.id=NEW.source_child_run_id
  JOIN agent_runs task_source ON task_source.company_id=w.company_id AND task_source.id=(NEW.source_snapshot#>>'{taskSource,runId}')::uuid
  JOIN agent_runs parent ON parent.company_id=w.company_id AND parent.id=NEW.parent_run_id
  JOIN agent_runs child ON child.company_id=w.company_id AND child.id=NEW.child_run_id
  JOIN studio_dispatches dispatched ON dispatched.company_id=child.company_id AND dispatched.run_id=child.id
  WHERE v.company_id=NEW.company_id AND v.project_id=NEW.project_id AND v.id=NEW.review_id AND v.artifact_id=NEW.artifact_id
   AND v.decision='changes_requested' AND e.attestation_version=1 AND a.version=NEW.artifact_version AND a.contract_version=2
   AND w.id=NEW.work_item_id AND w.task_id=NEW.task_id AND w.stage='generation' AND w.execution='creative'
   AND project.contract_version=2 AND project.production_path='higgsfield' AND project.ai_policy='allowed' AND project.status<>'delivered'
   AND project.gates#>>'{brief,decision}'='approved' AND project.gates#>>'{estimate,decision}'='approved' AND project.gates#>>'{production,decision}'='approved'
   AND t.status='todo' AND t.revision=NEW.task_revision+1 AND t.agent_run_id IS NULL AND t.assignee_id IS NULL
   AND b.agent_id=NEW.specialist_agent_id AND b.human_id IS NULL
   AND p.media_rework AND p.status='active' AND p.expires_at>clock_timestamp() AND p.revision=NEW.policy_revision
   AND p.coordinator_agent_id=NEW.coordinator_agent_id AND p.approved_by=NEW.approved_by AND p.allowed_role_keys ? w.role_key
   AND (NEW.coordinator_agent_id<>NEW.specialist_agent_id OR p.coordinator_generation)
   AND child.agent_id=NEW.specialist_agent_id AND child.requested_by=NEW.approved_by
   AND child.status='queued' AND child.max_attempts=1 AND child.attempts=0 AND child.started_at IS NULL
   AND child.capabilities='["studio.read","studio.write","tasks.write","creative.read","creative.write","storage.read"]'::jsonb AND child.created_at>=transaction_timestamp()
   AND parent.agent_id=NEW.coordinator_agent_id AND parent.requested_by=NEW.approved_by AND parent.attempts=NEW.parent_attempt AND parent.started_at=NEW.parent_started_at
   AND parent.status='running' AND parent.lease_expires_at>clock_timestamp()
   AND dispatched.project_id=NEW.project_id AND dispatched.work_item_id=NEW.work_item_id AND dispatched.created_at>=transaction_timestamp() AND dispatched.planning_rework_review_id IS NULL
   AND source.agent_id=NEW.specialist_agent_id AND source.status IN('succeeded','failed','cancelled') AND source.finished_at IS NOT NULL
   AND task_source.agent_id=NEW.specialist_agent_id AND task_source.status IN('succeeded','failed','cancelled') AND task_source.finished_at IS NOT NULL
   AND (task_source.id=source.id OR EXISTS(SELECT 1 FROM studio_generated_followups f WHERE f.company_id=NEW.company_id AND f.project_id=NEW.project_id AND f.work_item_id=NEW.work_item_id AND f.child_run_id=task_source.id AND f.source_child_run_id=source.id AND f.archive_id=s.archive_id))
   AND s.source_snapshot->>'runId'=source.id::text AND s.source_snapshot->>'agentId'=NEW.specialist_agent_id::text AND s.source_snapshot->>'roleAgentId'=NEW.specialist_agent_id::text AND s.source_snapshot->'roleHumanId'='null'::jsonb
   AND v.reviewed_by IS DISTINCT FROM a.produced_by AND v.reviewed_by IS DISTINCT FROM a.agent_sponsor_id AND v.reviewed_by IS DISTINCT FROM s.registered_by AND v.reviewed_by::text IS DISTINCT FROM s.source_snapshot->>'providerSponsorId'
   AND e.spec_sha256=s.spec_sha256 AND e.manifest_sha256=s.manifest_sha256
   AND (SELECT id FROM studio_artifacts WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND work_item_id=NEW.work_item_id ORDER BY version DESC LIMIT 1)=NEW.artifact_id
   AND (SELECT id FROM studio_reviews WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND artifact_id=NEW.artifact_id ORDER BY created_at DESC,id DESC LIMIT 1)=NEW.review_id
   AND NEW.round_id IS NOT DISTINCT FROM (SELECT id FROM studio_generated_revision_rounds WHERE company_id=NEW.company_id AND project_id=NEW.project_id ORDER BY number DESC LIMIT 1)
   AND NEW.round_id IS NOT DISTINCT FROM (SELECT round_id FROM studio_generated_revision_work WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND work_item_id=NEW.work_item_id)
   AND (SELECT count(*) FROM (
    SELECT d.child_run_id FROM studio_coordination_dispatches d WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.child_run_id=NEW.source_child_run_id AND d.specialist_agent_id=NEW.specialist_agent_id
    UNION ALL SELECT m.child_run_id FROM studio_media_rework_dispatches m JOIN studio_dispatches d ON d.company_id=m.company_id AND d.run_id=m.child_run_id AND d.media_rework_review_id=m.review_id
    WHERE m.company_id=NEW.company_id AND m.project_id=NEW.project_id AND m.work_item_id=NEW.work_item_id AND m.child_run_id=NEW.source_child_run_id AND m.specialist_agent_id=NEW.specialist_agent_id
   ) lineage)=1
   AND NEW.source_snapshot->>'projectId'=NEW.project_id::text AND NEW.source_snapshot->>'workItemId'=NEW.work_item_id::text AND NEW.source_snapshot->>'reviewId'=NEW.review_id::text
   AND NEW.source_snapshot->>'taskId'=NEW.task_id::text AND (NEW.source_snapshot->>'taskRevision')::integer=NEW.task_revision
   AND NEW.source_snapshot->>'artifactId'=NEW.artifact_id::text AND (NEW.source_snapshot->>'artifactVersion')::integer=NEW.artifact_version
   AND NEW.source_snapshot->>'roundId' IS NOT DISTINCT FROM NEW.round_id::text
   AND NEW.source_snapshot->>'sourceChildRunId'=NEW.source_child_run_id::text AND NEW.source_snapshot->>'specialistAgentId'=NEW.specialist_agent_id::text
   AND NEW.source_snapshot->>'reviewedBy'=v.reviewed_by::text AND (NEW.source_snapshot->>'reviewedAt')::timestamptz=date_trunc('milliseconds',v.created_at) AND NEW.source_snapshot->>'reviewNote'=v.note
   AND NEW.source_snapshot->>'roleKey'=w.role_key AND NEW.source_snapshot->>'title'=t.title AND NEW.source_snapshot->>'description'=t.description
   AND NEW.source_snapshot->>'gatesSha256'=encode(sha256(convert_to(studio_generated_canonical(project.gates),'UTF8')),'hex')
   AND NEW.source_snapshot->>'specSha256'=s.spec_sha256 AND NEW.source_snapshot->>'manifestSha256'=s.manifest_sha256
   AND NEW.source_snapshot->>'storageVersionId'=s.storage_version_id::text AND NEW.source_snapshot->>'fileSha256'=s.file_facts->>'sha256'
   AND NEW.source_snapshot#>>'{source,runId}'=source.id::text AND NEW.source_snapshot#>>'{source,agentId}'=source.agent_id::text AND NEW.source_snapshot#>>'{source,status}'=source.status
   AND (NEW.source_snapshot#>>'{source,attempt}')::integer=source.attempts AND (NEW.source_snapshot#>>'{source,startedAt}')::timestamptz IS NOT DISTINCT FROM date_trunc('milliseconds',source.started_at) AND (NEW.source_snapshot#>>'{source,finishedAt}')::timestamptz=date_trunc('milliseconds',source.finished_at)
   AND NEW.source_snapshot#>>'{taskSource,agentId}'=task_source.agent_id::text AND NEW.source_snapshot#>>'{taskSource,status}'=task_source.status
   AND (NEW.source_snapshot#>>'{taskSource,attempt}')::integer=task_source.attempts AND (NEW.source_snapshot#>>'{taskSource,startedAt}')::timestamptz IS NOT DISTINCT FROM date_trunc('milliseconds',task_source.started_at) AND (NEW.source_snapshot#>>'{taskSource,finishedAt}')::timestamptz=date_trunc('milliseconds',task_source.finished_at)
 ) THEN RAISE EXCEPTION 'Media correction must bind the current independently rejected artifact and exact source runs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_media_rework_guard BEFORE INSERT ON studio_media_rework_dispatches FOR EACH ROW EXECUTE FUNCTION guard_studio_media_rework();

CREATE FUNCTION guard_studio_media_rework_marker() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.media_rework_review_id IS NOT NULL THEN RAISE EXCEPTION 'Media correction marker requires its new ledger receipt' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF OLD.media_rework_review_id IS NOT DISTINCT FROM NEW.media_rework_review_id THEN
  IF OLD.media_rework_review_id IS NOT NULL AND ROW(OLD.company_id,OLD.project_id,OLD.work_item_id,OLD.run_id) IS DISTINCT FROM ROW(NEW.company_id,NEW.project_id,NEW.work_item_id,NEW.run_id) THEN RAISE EXCEPTION 'Media correction dispatch identity is immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF OLD.media_rework_review_id IS NOT NULL OR NEW.media_rework_review_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM studio_media_rework_dispatches m JOIN agent_runs r ON r.company_id=m.company_id AND r.id=m.child_run_id
  WHERE m.company_id=NEW.company_id AND m.project_id=NEW.project_id AND m.work_item_id=NEW.work_item_id AND m.child_run_id=NEW.run_id AND m.review_id=NEW.media_rework_review_id
   AND m.created_at>=transaction_timestamp() AND NEW.created_at>=transaction_timestamp() AND r.status='queued' AND r.attempts=0 AND r.started_at IS NULL
 ) THEN RAISE EXCEPTION 'Media correction marker is immutable and requires a new exact dispatch' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_media_rework_marker_guard BEFORE INSERT OR UPDATE ON studio_dispatches FOR EACH ROW EXECUTE FUNCTION guard_studio_media_rework_marker();
CREATE FUNCTION studio_media_rework_marker_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM studio_dispatches d WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.run_id=NEW.child_run_id AND d.media_rework_review_id=NEW.review_id AND d.planning_rework_review_id IS NULL) THEN RAISE EXCEPTION 'Media correction requires its exact dispatch marker' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_media_rework_marker_check AFTER INSERT ON studio_media_rework_dispatches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_media_rework_marker_check();

-- A partial unique index, not a count-only trigger, closes concurrent proposal
-- attempts. Exact API receipt replay never inserts another request.
ALTER TABLE higgsfield_requests ADD COLUMN media_rework_review_id uuid;
ALTER TABLE higgsfield_requests ADD CONSTRAINT higgsfield_media_rework_fk FOREIGN KEY(company_id,media_rework_review_id) REFERENCES studio_media_rework_dispatches(company_id,review_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX higgsfield_media_rework_proposal_once ON higgsfield_requests(company_id,run_id) WHERE media_rework_review_id IS NOT NULL;
CREATE FUNCTION guard_higgsfield_media_rework_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE marker uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.media_rework_review_id IS DISTINCT FROM NEW.media_rework_review_id OR (OLD.media_rework_review_id IS NOT NULL AND ROW(OLD.company_id,OLD.project_id,OLD.work_item_id,OLD.run_id,OLD.agent_id,OLD.requested_by,OLD.task_revision,OLD.role_agent_id,OLD.role_human_id,OLD.client_id,OLD.request_hash,OLD.tool,OLD.arguments,OLD.note) IS DISTINCT FROM ROW(NEW.company_id,NEW.project_id,NEW.work_item_id,NEW.run_id,NEW.agent_id,NEW.requested_by,NEW.task_revision,NEW.role_agent_id,NEW.role_human_id,NEW.client_id,NEW.request_hash,NEW.tool,NEW.arguments,NEW.note)) THEN RAISE EXCEPTION 'Media correction proposal identity is immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT media_rework_review_id INTO marker FROM studio_dispatches WHERE company_id=NEW.company_id AND run_id=NEW.run_id;
 IF NEW.media_rework_review_id IS NOT NULL AND NEW.media_rework_review_id IS DISTINCT FROM marker THEN RAISE EXCEPTION 'Media correction proposal marker conflicts' USING ERRCODE='23514';END IF;
 NEW.media_rework_review_id:=marker;
 IF marker IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM studio_media_rework_dispatches m JOIN tasks t ON t.company_id=m.company_id AND t.id=m.task_id
  JOIN agent_runs r ON r.company_id=m.company_id AND r.id=m.child_run_id
  WHERE m.company_id=NEW.company_id AND m.project_id=NEW.project_id AND m.work_item_id=NEW.work_item_id AND m.child_run_id=NEW.run_id AND m.review_id=marker
   AND m.specialist_agent_id=NEW.agent_id AND NEW.role_agent_id=m.specialist_agent_id AND NEW.role_human_id IS NULL AND NEW.requested_by=m.approved_by
   AND t.status='doing' AND t.agent_run_id=m.child_run_id AND t.revision=m.task_revision+2 AND NEW.task_revision=t.revision
   AND r.status='running' AND r.lease_expires_at>clock_timestamp() AND NEW.status='proposed'
 ) THEN RAISE EXCEPTION 'Media correction proposal requires its exact claimed task' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER higgsfield_media_rework_proposal_guard BEFORE INSERT OR UPDATE ON higgsfield_requests FOR EACH ROW EXECUTE FUNCTION guard_higgsfield_media_rework_proposal();

-- Preserve all verified archive, receipt, byte, specification and step checks.
-- Only the exact original-or-correction producer lookup changes.
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
 -- Choose the archive producer by exact run identity, never the latest run.
 BEGIN
 SELECT lineage.* INTO STRICT dispatch FROM (
  SELECT d.child_run_id,d.specialist_agent_id FROM studio_coordination_dispatches d WHERE d.company_id=NEW.company_id AND d.project_id=NEW.project_id AND d.work_item_id=NEW.work_item_id AND d.child_run_id=NEW.source_child_run_id
  UNION ALL
  SELECT m.child_run_id,m.specialist_agent_id FROM studio_media_rework_dispatches m JOIN studio_dispatches d ON d.company_id=m.company_id AND d.project_id=m.project_id AND d.work_item_id=m.work_item_id AND d.run_id=m.child_run_id AND d.media_rework_review_id=m.review_id
  WHERE m.company_id=NEW.company_id AND m.project_id=NEW.project_id AND m.work_item_id=NEW.work_item_id AND m.child_run_id=NEW.source_child_run_id
 ) lineage;
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RAISE EXCEPTION 'Generated continuation requires one exact original or correction producer' USING ERRCODE='23514';
 END;
 SELECT * INTO policy FROM studio_coordination_policies WHERE company_id=NEW.company_id AND project_id=NEW.project_id FOR SHARE;
 SELECT * INTO source_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.source_child_run_id FOR SHARE;
 SELECT * INTO parent_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.parent_run_id FOR SHARE;
 SELECT * INTO child_run FROM agent_runs WHERE company_id=NEW.company_id AND id=NEW.child_run_id FOR SHARE;
 IF p.contract_version IS DISTINCT FROM 2 OR p.production_path IS DISTINCT FROM 'higgsfield' OR w.stage IS DISTINCT FROM 'generation' OR w.execution IS DISTINCT FROM 'creative' OR w.task_id IS DISTINCT FROM NEW.task_id OR unit.media_kind IS DISTINCT FROM p.spec->>'kind'
  OR dispatch.child_run_id IS DISTINCT FROM NEW.source_child_run_id OR dispatch.specialist_agent_id IS DISTINCT FROM NEW.specialist_agent_id
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
