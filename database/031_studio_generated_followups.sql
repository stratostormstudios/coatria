-- A separately reviewed opt-in. Existing policies and receipt hashes do not
-- acquire continuation authority when this migration is applied.
ALTER TABLE studio_coordination_policies ADD COLUMN generated_continuations boolean NOT NULL DEFAULT false;

CREATE TABLE studio_generated_followups (
 company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,task_id uuid NOT NULL,
 source_child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,child_run_id uuid NOT NULL,
 coordinator_agent_id uuid NOT NULL,specialist_agent_id uuid NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision>0),approved_by uuid NOT NULL REFERENCES users(id),
 archive_id uuid NOT NULL,request_id uuid NOT NULL,job_id uuid NOT NULL,output_id uuid NOT NULL,storage_version_id uuid NOT NULL,
 spec_sha256 text NOT NULL CHECK(spec_sha256~'^[a-f0-9]{64}$'),file_sha256 text NOT NULL CHECK(file_sha256~'^[a-f0-9]{64}$'),
 file_bytes bigint NOT NULL CHECK(file_bytes BETWEEN 1 AND 107374182400),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=131072),
 source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$' AND source_sha256=encode(sha256(convert_to(studio_generated_canonical(source_snapshot),'UTF8')),'hex')),
 initial_task_revision integer NOT NULL CHECK(initial_task_revision>0),
 artifact_id uuid,artifact_sha256 text CHECK(artifact_sha256~'^[a-f0-9]{64}$'),
 claim_request_id uuid NOT NULL,registration_request_id uuid NOT NULL,submission_request_id uuid NOT NULL,
 registration_name text NOT NULL CHECK(length(btrim(registration_name)) BETWEEN 1 AND 160),
 registration_notes text NOT NULL CHECK(length(registration_notes)<=4000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,child_run_id),UNIQUE(company_id,project_id,child_run_id),
 CONSTRAINT studio_generated_followup_source_once UNIQUE(company_id,work_item_id,source_child_run_id),
 CONSTRAINT studio_generated_followup_output_once UNIQUE(company_id,output_id),
 CHECK(source_child_run_id<>parent_run_id AND source_child_run_id<>child_run_id AND parent_run_id<>child_run_id),
 CHECK(coordinator_agent_id<>specialist_agent_id),CHECK((artifact_id IS NULL)=(artifact_sha256 IS NULL)),
 CHECK(claim_request_id<>registration_request_id AND claim_request_id<>submission_request_id AND registration_request_id<>submission_request_id),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_coordination_dispatches(company_id,project_id,work_item_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,task_id) REFERENCES tasks(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,source_child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,parent_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,child_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,coordinator_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,specialist_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,archive_id) REFERENCES higgsfield_output_archives(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,archive_id) REFERENCES higgsfield_archive_fetches(company_id,archive_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,request_id) REFERENCES higgsfield_requests(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES higgsfield_jobs(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,output_id) REFERENCES higgsfield_job_outputs(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,storage_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,storage_version_id) REFERENCES project_storage_verifications(company_id,version_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,artifact_id,spec_sha256,artifact_sha256) REFERENCES studio_generated_artifact_sources(company_id,project_id,artifact_id,spec_sha256,manifest_sha256) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX studio_generated_followups_project ON studio_generated_followups(company_id,project_id,created_at DESC,child_run_id DESC);
CREATE TRIGGER studio_generated_followups_immutable BEFORE UPDATE OR DELETE ON studio_generated_followups FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();

-- A real unique index across all three step roles is required. Three separate
-- column indexes, or a snapshot-based SELECT in a trigger, cannot guarantee
-- cross-column uniqueness under concurrent transactions/isolation levels.
CREATE TABLE studio_generated_followup_steps (
 company_id uuid NOT NULL,project_id uuid NOT NULL,child_run_id uuid NOT NULL,request_id uuid NOT NULL,
 step text NOT NULL CHECK(step IN('claim','registration','submission')),
 PRIMARY KEY(company_id,request_id),UNIQUE(company_id,child_run_id,step),
 FOREIGN KEY(company_id,project_id,child_run_id) REFERENCES studio_generated_followups(company_id,project_id,child_run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER studio_generated_followup_steps_immutable BEFORE UPDATE OR DELETE ON studio_generated_followup_steps FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
CREATE FUNCTION studio_generated_followup_steps_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO studio_generated_followup_steps(company_id,project_id,child_run_id,request_id,step) VALUES
 (NEW.company_id,NEW.project_id,NEW.child_run_id,NEW.claim_request_id,'claim'),
 (NEW.company_id,NEW.project_id,NEW.child_run_id,NEW.registration_request_id,'registration'),
 (NEW.company_id,NEW.project_id,NEW.child_run_id,NEW.submission_request_id,'submission');
 RETURN NULL;
END $$;
CREATE TRIGGER studio_generated_followup_steps_insert AFTER INSERT ON studio_generated_followups FOR EACH ROW EXECUTE FUNCTION studio_generated_followup_steps_insert();
CREATE FUNCTION studio_generated_followup_step_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected uuid;
BEGIN
 SELECT CASE NEW.step WHEN 'claim' THEN claim_request_id WHEN 'registration' THEN registration_request_id WHEN 'submission' THEN submission_request_id END INTO expected
 FROM studio_generated_followups WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND child_run_id=NEW.child_run_id;
 IF expected IS DISTINCT FROM NEW.request_id THEN RAISE EXCEPTION 'Generated continuation step is not its exact pinned request' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_generated_followup_step_check AFTER INSERT ON studio_generated_followup_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_followup_step_check();

CREATE FUNCTION studio_generated_followup_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
CREATE CONSTRAINT TRIGGER studio_generated_followup_check AFTER INSERT ON studio_generated_followups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_followup_check();
