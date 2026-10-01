-- M2 metadata/control plane only. Creates no login, grant, processor, host or
-- execution path. Inspection/sharing and archive authority are not preparation.
CREATE TABLE project_image_preparations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, project_id uuid NOT NULL, work_item_id uuid NOT NULL,
 project_revision integer NOT NULL CHECK(project_revision>0),
 project_snapshot jsonb NOT NULL CHECK(jsonb_typeof(project_snapshot)='object' AND pg_column_size(project_snapshot)<=65536),
 work_snapshot jsonb NOT NULL CHECK(jsonb_typeof(work_snapshot)='object' AND pg_column_size(work_snapshot)<=32768),
 source_version_id uuid NOT NULL,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND pg_column_size(source_snapshot)<=16384),
 destination_folder_id uuid, destination_name text NOT NULL CHECK(length(destination_name) BETWEEN 5 AND 160 AND lower(right(destination_name,4))='.png'),
 destination_snapshot jsonb NOT NULL CHECK(jsonb_typeof(destination_snapshot)='object' AND pg_column_size(destination_snapshot)<=32768),
 storage_binding_id uuid NOT NULL, storage_binding_revision integer NOT NULL CHECK(storage_binding_revision>0),
 storage_connection_id uuid NOT NULL, storage_connection_revision integer NOT NULL CHECK(storage_connection_revision>0),
 storage_sponsor_id uuid NOT NULL REFERENCES users(id), recipe_sha256 text NOT NULL CHECK(recipe_sha256~'^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'), purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 1000),
 proposed_by uuid NOT NULL REFERENCES users(id), proposed_agent_id uuid, proposed_run_id uuid,
 proposer_snapshot jsonb NOT NULL CHECK(jsonb_typeof(proposer_snapshot)='object' AND pg_column_size(proposer_snapshot)<=32768),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','queued','reading','transforming','validating','storing','verifying','ready','uncertain','blocked','failed','revoked')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), lease_id uuid, lease_expires_at timestamptz, claimed_at timestamptz,
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt IN (0,1)), action_id uuid,
 action_operation text CHECK(action_operation IN ('read','transform','validate','allocation','store','verify','publish','cleanup')),
 transform_result jsonb CHECK(transform_result IS NULL OR (jsonb_typeof(transform_result)='object' AND pg_column_size(transform_result)<=32768)),
 transform_sha256 text CHECK(transform_sha256~'^[a-f0-9]{64}$'), cleanup_confirmed_at timestamptz,
 diagnostic_code text CHECK(diagnostic_code~'^[A-Z][A-Z0-9_]{0,119}$'), revoked_by uuid REFERENCES users(id), revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id), UNIQUE(company_id,project_id,id),
 CHECK((proposed_agent_id IS NULL)=(proposed_run_id IS NULL)), CHECK((lease_id IS NULL)=(lease_expires_at IS NULL)),
 CHECK((action_id IS NULL)=(action_operation IS NULL)), CHECK((revoked_by IS NULL)=(revoked_at IS NULL)),
 CHECK((transform_result IS NULL)=(transform_sha256 IS NULL)), CHECK((attempt=0)=(claimed_at IS NULL)),
 CHECK(lease_id IS NULL OR (attempt=1 AND lease_expires_at>claimed_at AND lease_expires_at<=claimed_at+interval '120 seconds')),
 CHECK(cleanup_confirmed_at IS NULL OR (claimed_at IS NOT NULL AND cleanup_confirmed_at>=claimed_at)),
 CHECK((status='revoked')=(revoked_at IS NOT NULL)),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,source_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,source_version_id) REFERENCES project_storage_verifications(company_id,version_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,destination_folder_id) REFERENCES project_storage_folders(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,storage_binding_id) REFERENCES project_storage_bindings(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,storage_connection_id) REFERENCES project_storage_connections(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,proposed_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,proposed_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX project_image_preparations_due ON project_image_preparations(company_id,created_at,id)
 WHERE status IN ('queued','reading','transforming','validating','storing','verifying');
-- Even an uncertain/revoked attempt retains the processing slot until trusted
-- cleanup is recorded. Expiry alone is not proof of descendant termination.
CREATE UNIQUE INDEX project_image_preparations_one_active ON project_image_preparations(company_id)
 WHERE attempt=1 AND cleanup_confirmed_at IS NULL;

CREATE TABLE project_image_preparation_approvals (
 company_id uuid NOT NULL, project_id uuid NOT NULL, preparation_id uuid NOT NULL,
 approved_by uuid NOT NULL REFERENCES users(id), approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approver_snapshot jsonb NOT NULL CHECK(jsonb_typeof(approver_snapshot)='object' AND pg_column_size(approver_snapshot)<=16384),
 expires_at timestamptz NOT NULL, approval_hash text NOT NULL CHECK(approval_hash~'^[a-f0-9]{64}$'),
 processor_snapshot jsonb NOT NULL CHECK(jsonb_typeof(processor_snapshot)='object' AND pg_column_size(processor_snapshot)<=16384),
 max_cost_microusd bigint NOT NULL CHECK(max_cost_microusd BETWEEN 0 AND 1000000),
 processing_consent boolean NOT NULL CHECK(processing_consent IS TRUE),
 derivative_write_consent boolean NOT NULL CHECK(derivative_write_consent IS TRUE),
 adoption_consent boolean NOT NULL CHECK(adoption_consent IS TRUE),
 PRIMARY KEY(company_id,preparation_id), UNIQUE(company_id,project_id,preparation_id),
 CHECK(expires_at>approved_at AND expires_at<=approved_at+interval '3600 seconds'),
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparations(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE project_image_preparation_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, project_id uuid NOT NULL, preparation_id uuid NOT NULL, action_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('claim','approve','revoke','read','transform','validate','allocation','store','verify','publish','cleanup')),
 phase text NOT NULL CHECK(phase IN ('intent','returned','uncertain','blocked','failed','revoked')),
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object' AND pg_column_size(detail)<=32768),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,preparation_id,action_id,phase),
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparations(company_id,project_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_image_preparation_intent_once ON project_image_preparation_receipts(company_id,preparation_id,operation)
 WHERE phase='intent' AND operation IN ('transform','allocation','store');
CREATE FUNCTION validate_project_image_preparation_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.operation='cleanup' AND NEW.phase='returned' AND NOT EXISTS(
  SELECT 1 FROM project_image_preparations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.preparation_id
   AND attempt=1 AND cleanup_confirmed_at IS NULL AND (transform_result IS NOT NULL OR status IN ('uncertain','blocked','failed','revoked'))
 ) THEN RAISE EXCEPTION 'Preparation cleanup cannot precede its processor terminal state' USING ERRCODE='23514'; END IF;
 IF NEW.phase='returned' AND NEW.operation IN ('transform','allocation','store') AND NOT EXISTS(
  SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.preparation_id
   AND action_id=NEW.action_id AND operation=NEW.operation AND phase='intent'
 ) THEN RAISE EXCEPTION 'Preparation result requires its exact prior intent' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_receipt_guard BEFORE INSERT ON project_image_preparation_receipts FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_receipt();
CREATE TABLE project_image_preparation_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, actor_key text NOT NULL CHECK(length(actor_key) BETWEEN 1 AND 100), client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'), response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND pg_column_size(response)<=131072),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,actor_key,client_id)
);
CREATE TABLE project_image_preparation_derivations (
 company_id uuid NOT NULL, project_id uuid NOT NULL, preparation_id uuid NOT NULL, source_version_id uuid NOT NULL,
 output_file_id uuid NOT NULL, output_version_id uuid NOT NULL, upload_id uuid NOT NULL,
 recipe_sha256 text NOT NULL CHECK(recipe_sha256~'^[a-f0-9]{64}$'), source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 source_bytes bigint NOT NULL CHECK(source_bytes BETWEEN 1 AND 33554432), output_sha256 text NOT NULL CHECK(output_sha256~'^[a-f0-9]{64}$'),
 output_bytes bigint NOT NULL CHECK(output_bytes BETWEEN 1 AND 10485760), output_width integer NOT NULL CHECK(output_width BETWEEN 1 AND 2048), output_height integer NOT NULL CHECK(output_height BETWEEN 1 AND 2048),
 processor_snapshot jsonb NOT NULL CHECK(jsonb_typeof(processor_snapshot)='object' AND pg_column_size(processor_snapshot)<=16384),
 transform_evidence jsonb NOT NULL CHECK(jsonb_typeof(transform_evidence)='object' AND pg_column_size(transform_evidence)<=32768),
 receipt_sha256 text NOT NULL CHECK(receipt_sha256~'^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,preparation_id), UNIQUE(company_id,output_version_id), UNIQUE(company_id,output_file_id), UNIQUE(company_id,upload_id),
 CHECK(source_version_id<>output_version_id),
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparations(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparation_approvals(company_id,project_id,preparation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,source_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,output_file_id) REFERENCES project_storage_files(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,output_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,output_version_id) REFERENCES project_storage_verifications(company_id,version_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,upload_id,output_version_id) REFERENCES project_storage_uploads(company_id,project_id,id,version_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION guard_project_image_preparation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Preparation evidence is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_approval_immutable BEFORE UPDATE ON project_image_preparation_approvals FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
CREATE TRIGGER project_image_preparation_receipt_immutable BEFORE UPDATE ON project_image_preparation_receipts FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
CREATE TRIGGER project_image_preparation_request_immutable BEFORE UPDATE ON project_image_preparation_requests FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
CREATE TRIGGER project_image_preparation_derivation_immutable BEFORE UPDATE ON project_image_preparation_derivations FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
ALTER TABLE project_image_preparation_approvals ENABLE ALWAYS TRIGGER project_image_preparation_approval_immutable;
ALTER TABLE project_image_preparation_receipts ENABLE ALWAYS TRIGGER project_image_preparation_receipt_immutable;
ALTER TABLE project_image_preparation_requests ENABLE ALWAYS TRIGGER project_image_preparation_request_immutable;
ALTER TABLE project_image_preparation_derivations ENABLE ALWAYS TRIGGER project_image_preparation_derivation_immutable;
-- No DELETE triggers: owner-controlled company cascades remain possible.
-- No runtime/worker DELETE grants are created or implied by this migration.

CREATE FUNCTION validate_project_image_preparation_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status<>'proposed' OR NEW.revision<>1 OR NEW.attempt<>0 OR NEW.lease_id IS NOT NULL OR NEW.action_id IS NOT NULL
  OR NEW.transform_result IS NOT NULL OR NEW.cleanup_confirmed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
  RAISE EXCEPTION 'A preparation starts as an unapproved proposal' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM project_storage_versions v
  JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)
  JOIN project_storage_verifications ok ON (ok.company_id,ok.project_id,ok.version_id)=(v.company_id,v.project_id,v.id)
  JOIN project_storage_bindings b ON (b.company_id,b.project_id,b.id)=(f.company_id,f.project_id,f.binding_id)
  JOIN project_storage_connections c ON (c.company_id,c.id)=(b.company_id,b.connection_id)
  WHERE (v.company_id,v.project_id,v.id)=(NEW.company_id,NEW.project_id,NEW.source_version_id)
   AND v.bytes BETWEEN 1 AND 33554432 AND ok.bytes=v.bytes AND (v.sha256 IS NULL OR v.sha256=ok.sha256)
   AND v.content_type IN ('image/png','image/jpeg','image/webp')
   AND b.id=NEW.storage_binding_id AND b.revision=NEW.storage_binding_revision AND c.id=NEW.storage_connection_id
   AND c.revision=NEW.storage_connection_revision AND c.created_by=NEW.storage_sponsor_id AND c.status='configured'
   AND NEW.source_snapshot->>'versionId'=v.id::text AND NEW.source_snapshot->>'fileId'=v.file_id::text
   AND NEW.source_snapshot->>'name'=f.name AND NEW.source_snapshot->>'version'=v.version::text
   AND NEW.source_snapshot->>'bytes'=v.bytes::text AND NEW.source_snapshot->>'sha256'=ok.sha256
   AND NEW.source_snapshot->>'contentType'=v.content_type AND NEW.source_snapshot->>'objectKey'=v.object_key
   AND NEW.source_snapshot->>'providerEtag'=ok.provider_etag
 ) THEN RAISE EXCEPTION 'Preparation requires exact verified source facts' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_source_guard BEFORE INSERT ON project_image_preparations FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_source();

CREATE FUNCTION validate_project_image_preparation_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p project_image_preparations; s jsonb;
BEGIN
 SELECT * INTO p FROM project_image_preparations WHERE (company_id,project_id,id)=(NEW.company_id,NEW.project_id,NEW.preparation_id) FOR UPDATE;
 s:=NEW.processor_snapshot;
 IF p.id IS NULL OR p.status<>'proposed' OR p.revoked_at IS NOT NULL OR NEW.approved_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM memberships WHERE company_id=NEW.company_id AND user_id=NEW.approved_by AND role IN ('owner','admin') AND access_revoked_at IS NULL
   AND NEW.approver_snapshot->>'userId'=user_id::text AND NEW.approver_snapshot->>'role'=role
   AND (NEW.approver_snapshot->>'joinedAt')::timestamptz=joined_at)
  OR NOT ((s->>'id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND length(s->>'location') BETWEEN 1 AND 200 AND s->>'qualificationSha256'~'^[a-f0-9]{64}$'
   AND s->>'releaseSha256'~'^[a-f0-9]{64}$' AND s->>'profileSha256'~'^[a-f0-9]{64}$'
   AND s->>'sourceCommit'~'^[a-f0-9]{40}$' AND s->>'closureSha256'~'^[a-f0-9]{64}$'
   AND s->>'transport' IN ('linux_binary_v1','vercel_binary_v1') AND s->>'recipeSha256'=p.recipe_sha256
   AND s->>'expiresAt' IS NOT NULL) IS TRUE)
 THEN RAISE EXCEPTION 'Preparation requires current finite human processing approval' USING ERRCODE='23514'; END IF;
 IF (s->>'expiresAt')::timestamptz<NEW.expires_at THEN RAISE EXCEPTION 'Preparation outlives its selected processor' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_approval_guard BEFORE INSERT ON project_image_preparation_approvals FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_approval();

CREATE FUNCTION guard_project_image_preparation_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a project_image_preparation_approvals; result jsonb;
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','revision','lease_id','lease_expires_at','claimed_at','attempt','action_id','action_operation','diagnostic_code','revoked_by','revoked_at','updated_at','transform_result','transform_sha256','cleanup_confirmed_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','lease_id','lease_expires_at','claimed_at','attempt','action_id','action_operation','diagnostic_code','revoked_by','revoked_at','updated_at','transform_result','transform_sha256','cleanup_confirmed_at'])
  OR NEW.revision<OLD.revision OR NEW.attempt<OLD.attempt
  OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at)
  OR (OLD.transform_result IS NOT NULL AND (NEW.transform_result IS DISTINCT FROM OLD.transform_result OR NEW.transform_sha256 IS DISTINCT FROM OLD.transform_sha256))
  OR (OLD.cleanup_confirmed_at IS NOT NULL AND NEW.cleanup_confirmed_at IS DISTINCT FROM OLD.cleanup_confirmed_at)
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)) THEN
  RAISE EXCEPTION 'Preparation source, recipe and completed evidence are immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='proposed' AND NEW.status IN ('queued','blocked','failed','revoked')) OR
  (OLD.status='queued' AND NEW.status IN ('reading','blocked','failed','revoked')) OR
  (OLD.status='reading' AND NEW.status IN ('transforming','blocked','failed','revoked')) OR
  (OLD.status='transforming' AND NEW.status IN ('validating','uncertain','blocked','failed','revoked')) OR
  (OLD.status='validating' AND NEW.status IN ('storing','blocked','failed','revoked')) OR
  (OLD.status='storing' AND NEW.status IN ('verifying','uncertain','blocked','failed','revoked')) OR
  (OLD.status='verifying' AND NEW.status IN ('ready','uncertain','blocked','failed','revoked')) OR
  (OLD.status IN ('ready','uncertain','blocked','failed') AND NEW.status='revoked')
 ) THEN RAISE EXCEPTION 'Preparation phase transition rejected' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM project_image_preparation_approvals WHERE company_id=NEW.company_id AND preparation_id=NEW.id;
 IF NEW.status IN ('queued','reading','transforming','validating','storing','verifying','ready') AND
  (a.preparation_id IS NULL OR a.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Preparation approval ended' USING ERRCODE='23514'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('transforming','validating','storing','verifying','ready') AND
  NOT ((OLD.lease_id IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()
   AND (NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id OR (NEW.status='ready' AND NEW.lease_id IS NULL))) IS TRUE)
 THEN RAISE EXCEPTION 'Preparation phase admission requires its current lease' USING ERRCODE='23514'; END IF;
 IF NEW.attempt<>OLD.attempt AND NOT (OLD.attempt=0 AND NEW.attempt=1 AND OLD.status='queued' AND NEW.status='reading'
  AND NEW.claimed_at<=clock_timestamp() AND NEW.claimed_at>=OLD.created_at AND NEW.lease_id IS NOT NULL
  AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=a.expires_at) THEN RAISE EXCEPTION 'Preparation can claim exactly one finite attempt' USING ERRCODE='23514'; END IF;
 IF NEW.lease_id IS NOT NULL AND (NEW.lease_expires_at>a.expires_at OR NEW.attempt<>1
  OR (OLD.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id)
  OR (OLD.lease_id IS NOT NULL AND OLD.lease_expires_at<=clock_timestamp() AND NEW.lease_expires_at>clock_timestamp())
  OR (OLD.attempt=1 AND OLD.lease_id IS NULL)) THEN RAISE EXCEPTION 'Preparation lease cannot be replaced' USING ERRCODE='23514'; END IF;
 IF NEW.action_id IS DISTINCT FROM OLD.action_id AND NEW.action_id IS NOT NULL AND
  (OLD.action_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.id
   AND action_id=NEW.action_id AND operation=NEW.action_operation AND phase='intent')) THEN
  RAISE EXCEPTION 'Preparation action requires its committed intent identity' USING ERRCODE='23514';
 END IF;
 IF NEW.status='transforming' AND NOT ((NEW.action_id IS NOT NULL AND NEW.action_operation='transform') IS TRUE) THEN
  RAISE EXCEPTION 'A transform needs its exact action intent' USING ERRCODE='23514';
 END IF;
 IF NEW.status='transforming' AND NEW.cleanup_confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'A cleaned preparation cannot restart its processor' USING ERRCODE='23514'; END IF;
 IF NEW.transform_result IS DISTINCT FROM OLD.transform_result THEN
  result:=NEW.transform_result;
  IF OLD.transform_result IS NOT NULL OR OLD.status<>'transforming' OR NEW.status<>'validating' OR OLD.action_operation<>'transform'
   OR OLD.action_id IS NULL OR OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp()
   OR NOT ((result->>'sourceVersionId'=NEW.source_version_id::text AND result->>'sourceSha256'=NEW.source_snapshot->>'sha256'
    AND result->>'sourceBytes'=NEW.source_snapshot->>'bytes' AND result->>'recipeSha256'=NEW.recipe_sha256
    AND result->'processor'=a.processor_snapshot AND result#>>'{output,format}'='png' AND result#>>'{output,pixelFormat}'='rgba8'
    AND result#>'{output,metadataRemoved}'='true'::jsonb AND result#>>'{output,sha256}'~'^[a-f0-9]{64}$'
    AND (result#>>'{output,bytes}')::bigint BETWEEN 1 AND 10485760
    AND (result#>>'{output,width}')::integer BETWEEN 1 AND 2048 AND (result#>>'{output,height}')::integer BETWEEN 1 AND 2048
    AND result#>>'{source,format}' IN ('png','jpeg','webp') AND (result#>>'{source,orientation}')::integer BETWEEN 1 AND 8
    AND (result#>>'{source,width}')::integer BETWEEN 1 AND 8192 AND (result#>>'{source,height}')::integer BETWEEN 1 AND 8192
    AND (result#>>'{source,width}')::bigint*(result#>>'{source,height}')::bigint<=32000000) IS TRUE)
   OR NOT EXISTS(SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.id AND action_id=OLD.action_id AND operation='transform' AND phase='returned')
  THEN RAISE EXCEPTION 'Preparation transform evidence does not match the finite job' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status IN ('validating','storing','verifying','ready') AND NEW.transform_result IS NULL THEN RAISE EXCEPTION 'Preparation transform evidence is required' USING ERRCODE='23514'; END IF;
 IF NEW.cleanup_confirmed_at IS DISTINCT FROM OLD.cleanup_confirmed_at AND (NEW.cleanup_confirmed_at IS NULL OR NEW.cleanup_confirmed_at>clock_timestamp()
  OR (NEW.transform_result IS NULL AND NEW.status NOT IN ('uncertain','blocked','failed','revoked'))
  OR NOT EXISTS(SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.id AND operation='cleanup' AND phase='returned'))
 THEN RAISE EXCEPTION 'Preparation cleanup requires its own trusted receipt' USING ERRCODE='23514'; END IF;
 IF NEW.status='ready' AND (NEW.cleanup_confirmed_at IS NULL OR NOT EXISTS(SELECT 1 FROM project_image_preparation_derivations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND preparation_id=NEW.id))
 THEN RAISE EXCEPTION 'Preparation cannot be ready without its verified derivation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_update_guard BEFORE UPDATE ON project_image_preparations FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_update();
ALTER TABLE project_image_preparations ENABLE ALWAYS TRIGGER project_image_preparation_update_guard;

CREATE FUNCTION validate_project_image_preparation_derivation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM project_image_preparations p
  JOIN project_image_preparation_approvals a ON (a.company_id,a.project_id,a.preparation_id)=(p.company_id,p.project_id,p.id)
  JOIN project_storage_versions v ON (v.company_id,v.project_id,v.id)=(p.company_id,p.project_id,NEW.output_version_id)
  JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)
  JOIN project_storage_uploads u ON (u.company_id,u.project_id,u.id,u.version_id)=(v.company_id,v.project_id,NEW.upload_id,v.id)
  JOIN project_storage_verifications ok ON (ok.company_id,ok.project_id,ok.version_id)=(v.company_id,v.project_id,v.id)
  WHERE (p.company_id,p.project_id,p.id)=(NEW.company_id,NEW.project_id,NEW.preparation_id)
   AND p.status='verifying' AND p.revoked_at IS NULL AND p.lease_id IS NOT NULL AND p.lease_expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()
   AND p.source_version_id=NEW.source_version_id AND p.source_snapshot->>'sha256'=NEW.source_sha256 AND p.source_snapshot->>'bytes'=NEW.source_bytes::text
   AND p.recipe_sha256=NEW.recipe_sha256 AND p.transform_result=NEW.transform_evidence AND a.processor_snapshot=NEW.processor_snapshot
   AND p.transform_result#>>'{output,sha256}'=NEW.output_sha256 AND p.transform_result#>>'{output,bytes}'=NEW.output_bytes::text
   AND p.transform_result#>>'{output,width}'=NEW.output_width::text AND p.transform_result#>>'{output,height}'=NEW.output_height::text
   AND v.file_id=NEW.output_file_id AND v.file_id::text<>p.source_snapshot->>'fileId' AND v.version=1 AND v.content_type='image/png'
   AND f.binding_id=p.storage_binding_id AND f.parent_id IS NOT DISTINCT FROM p.destination_folder_id AND f.name=p.destination_name
   AND u.status='ready' AND u.archive_id IS NULL AND u.actor_key='preparation:'||p.id::text AND u.actor_user_id=a.approved_by AND u.actor_agent_id IS NULL AND u.run_id IS NULL
   AND v.bytes=NEW.output_bytes AND v.sha256=NEW.output_sha256 AND ok.bytes=v.bytes AND ok.sha256=v.sha256 AND ok.provider_etag=u.provider_etag
 ) THEN RAISE EXCEPTION 'Preparation derivation needs its exact separate verified output' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_derivation_guard BEFORE INSERT ON project_image_preparation_derivations FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_derivation();
