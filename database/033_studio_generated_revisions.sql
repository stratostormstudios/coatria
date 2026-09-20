-- Creative revision rounds retain the approved technical contract and every
-- earlier task, media source, client package and receipt. Applying schema starts
-- no work. Only the application owner applies an exact reviewed plan.
CREATE TABLE studio_generated_revision_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,
 source_share_id uuid NOT NULL,source_receipt_id uuid NOT NULL,source_delivery_id uuid NOT NULL,
 package_sha256 text NOT NULL CHECK(package_sha256~'^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(studio_generated_canonical(snapshot))<=262144),
 plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$' AND plan_sha256=encode(sha256(convert_to(studio_generated_canonical(snapshot),'UTF8')),'hex')),
 created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,created_run_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,id,plan_sha256),CHECK((created_agent_id IS NULL)=(created_run_id IS NULL)),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id),
 FOREIGN KEY(company_id,project_id,source_share_id) REFERENCES studio_client_deliveries(company_id,project_id,id),
 FOREIGN KEY(company_id,source_share_id,source_receipt_id) REFERENCES studio_client_delivery_receipts(company_id,share_id,id),
 FOREIGN KEY(company_id,project_id,source_delivery_id) REFERENCES studio_deliveries(company_id,project_id,id),
 FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id),FOREIGN KEY(company_id,created_run_id) REFERENCES agent_runs(company_id,id)
);
CREATE INDEX studio_generated_revision_plan_page ON studio_generated_revision_plans(company_id,project_id,id);
CREATE TRIGGER studio_generated_revision_plan_immutable BEFORE UPDATE OR DELETE ON studio_generated_revision_plans FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();

CREATE TABLE studio_generated_revision_rounds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,number integer NOT NULL CHECK(number BETWEEN 1 AND 20),
 plan_id uuid NOT NULL,plan_sha256 text NOT NULL,source_receipt_id uuid NOT NULL,previous_round_id uuid,
 approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,number),UNIQUE(company_id,project_id,plan_id),UNIQUE(company_id,project_id,source_receipt_id),
 FOREIGN KEY(company_id,project_id,plan_id,plan_sha256) REFERENCES studio_generated_revision_plans(company_id,project_id,id,plan_sha256),
 FOREIGN KEY(company_id,project_id,previous_round_id) REFERENCES studio_generated_revision_rounds(company_id,project_id,id),
 CHECK((number=1)=(previous_round_id IS NULL))
);
CREATE TRIGGER studio_generated_revision_round_immutable BEFORE UPDATE OR DELETE ON studio_generated_revision_rounds FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
CREATE TABLE studio_generated_revision_work (
 company_id uuid NOT NULL,project_id uuid NOT NULL,round_id uuid NOT NULL,work_item_id uuid NOT NULL,
 PRIMARY KEY(company_id,project_id,work_item_id),UNIQUE(company_id,project_id,round_id,work_item_id),
 FOREIGN KEY(company_id,project_id,round_id) REFERENCES studio_generated_revision_rounds(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id)
);
CREATE TRIGGER studio_generated_revision_work_immutable BEFORE UPDATE OR DELETE ON studio_generated_revision_work FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
CREATE TABLE studio_generated_revision_items (
 company_id uuid NOT NULL,project_id uuid NOT NULL,round_id uuid NOT NULL,unit_id uuid NOT NULL,action text NOT NULL CHECK(action IN('regenerate','carry')),
 generation_work_item_id uuid NOT NULL,qc_work_item_id uuid NOT NULL,artifact_id uuid,review_id uuid,storage_version_id uuid,manifest_sha256 text,file_sha256 text,
 PRIMARY KEY(company_id,project_id,round_id,unit_id),
 FOREIGN KEY(company_id,project_id,round_id) REFERENCES studio_generated_revision_rounds(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,unit_id) REFERENCES studio_shots(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,generation_work_item_id) REFERENCES studio_work_items(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,qc_work_item_id) REFERENCES studio_work_items(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,artifact_id,storage_version_id) REFERENCES studio_generated_artifact_sources(company_id,project_id,artifact_id,storage_version_id),
 FOREIGN KEY(company_id,project_id,review_id,artifact_id) REFERENCES studio_reviews(company_id,project_id,id,artifact_id),
 CHECK((action='regenerate' AND artifact_id IS NULL AND review_id IS NULL AND storage_version_id IS NULL AND manifest_sha256 IS NULL AND file_sha256 IS NULL) OR
  (action='carry' AND artifact_id IS NOT NULL AND review_id IS NOT NULL AND storage_version_id IS NOT NULL AND manifest_sha256 IS NOT NULL AND file_sha256 IS NOT NULL AND manifest_sha256~'^[a-f0-9]{64}$' AND file_sha256~'^[a-f0-9]{64}$'))
);
CREATE TRIGGER studio_generated_revision_item_immutable BEFORE UPDATE OR DELETE ON studio_generated_revision_items FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
CREATE TABLE studio_generated_delivery_rounds (
 company_id uuid NOT NULL,project_id uuid NOT NULL,delivery_id uuid NOT NULL,round_id uuid NOT NULL,
 PRIMARY KEY(company_id,project_id,delivery_id),
 FOREIGN KEY(company_id,project_id,delivery_id) REFERENCES studio_deliveries(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,round_id) REFERENCES studio_generated_revision_rounds(company_id,project_id,id)
);
CREATE TRIGGER studio_generated_delivery_round_immutable BEFORE UPDATE OR DELETE ON studio_generated_delivery_rounds FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();

CREATE FUNCTION studio_generated_revision_plan_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE share record;receipt record;project record;entry jsonb;unit record;file record;artifact record;qc record;delivery record;prior_round uuid;
BEGIN
 SELECT * INTO share FROM studio_client_deliveries WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.source_share_id;
 SELECT * INTO receipt FROM studio_client_delivery_receipts WHERE company_id=NEW.company_id AND share_id=NEW.source_share_id AND id=NEW.source_receipt_id;
 SELECT * INTO project FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id;
 SELECT * INTO delivery FROM studio_deliveries WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.source_delivery_id;
 SELECT round_id INTO prior_round FROM studio_generated_delivery_rounds WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND delivery_id=NEW.source_delivery_id;
 IF project.contract_version IS DISTINCT FROM 2 OR share.package_snapshot->>'schemaVersion' IS DISTINCT FROM '2' OR share.delivery_id IS DISTINCT FROM NEW.source_delivery_id
  OR share.package_hash IS DISTINCT FROM NEW.package_sha256 OR receipt.kind IS DISTINCT FROM 'changes_requested' OR receipt.package_hash IS DISTINCT FROM share.package_hash OR receipt.actor_user_id IS DISTINCT FROM share.recipient_user_id
  OR NEW.snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.snapshot->>'projectId' IS DISTINCT FROM NEW.project_id::text
  OR NEW.snapshot->'source' IS DISTINCT FROM jsonb_build_object('shareId',share.id,'receiptId',receipt.id,'deliveryId',delivery.id,'packageSha256',share.package_hash,'sourceManifestSha256',share.source_manifest_hash,'clientUserId',receipt.actor_user_id,'note',receipt.note,'roundId',prior_round)
  OR jsonb_typeof(NEW.snapshot->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.snapshot->'items') IS DISTINCT FROM (SELECT count(*)::integer FROM studio_shots WHERE company_id=NEW.company_id AND project_id=NEW.project_id)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'items') i WHERE i->>'action'='regenerate')
  OR (SELECT count(DISTINCT i->>'unitId') FROM jsonb_array_elements(NEW.snapshot->'items') i)<>jsonb_array_length(NEW.snapshot->'items')
 THEN RAISE EXCEPTION 'Revision plan does not match its exact client response and complete scope' USING ERRCODE='23514';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'items') LOOP
  SELECT * INTO unit FROM studio_shots WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=(entry->>'unitId')::uuid;
  SELECT * INTO file FROM studio_client_delivery_files WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND share_id=share.id AND artifact_id=(entry->'base'->>'artifactId')::uuid AND storage_version_id=(entry->'base'->>'storageVersionId')::uuid;
  SELECT * INTO artifact FROM studio_artifacts WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=file.artifact_id;
  SELECT w.* INTO qc FROM studio_work_items w JOIN studio_dependencies d ON d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id AND d.predecessor_id=artifact.work_item_id WHERE w.company_id=NEW.company_id AND w.project_id=NEW.project_id AND w.id=(entry->'base'->>'qcWorkItemId')::uuid AND w.stage='qc' AND w.shot_id=unit.id;
  IF unit.id IS NULL OR file.file_id IS NULL OR qc.id IS NULL OR entry->>'code' IS DISTINCT FROM unit.code OR entry->>'description' IS DISTINCT FROM unit.description OR entry->>'mediaKind' IS DISTINCT FROM unit.media_kind
   OR entry->'base'->>'generationWorkItemId' IS DISTINCT FROM artifact.work_item_id::text OR entry->'base'->>'manifestSha256' IS DISTINCT FROM artifact.sha256 OR entry->'base'->>'fileSha256' IS DISTINCT FROM file.storage_sha256 OR entry->'base'->>'reviewId' IS DISTINCT FROM file.review_id::text
   OR (entry->>'action' IS DISTINCT FROM 'regenerate' AND entry->>'action' IS DISTINCT FROM 'carry') OR jsonb_typeof(entry->'instructions') IS DISTINCT FROM 'string' OR (entry->>'action'='regenerate' AND length(btrim(entry->>'instructions')) NOT BETWEEN 1 AND 4000) OR (entry->>'action'='carry' AND entry->>'instructions' IS DISTINCT FROM '')
  THEN RAISE EXCEPTION 'Revision item is not pinned to the exact delivered evidence' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_generated_revision_plan_check AFTER INSERT ON studio_generated_revision_plans DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_revision_plan_check();

CREATE FUNCTION studio_generated_revision_round_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE plan record;previous integer;entry jsonb;item record;generation record;qc record;work_count integer;changed_count integer;
BEGIN
 SELECT * INTO plan FROM studio_generated_revision_plans WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.plan_id;
 SELECT number INTO previous FROM studio_generated_revision_rounds WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.previous_round_id;
 IF NEW.source_receipt_id IS DISTINCT FROM plan.source_receipt_id OR NEW.previous_round_id::text IS DISTINCT FROM plan.snapshot->'source'->>'roundId' OR NEW.number<>coalesce(previous,0)+1
  OR NOT EXISTS(SELECT 1 FROM memberships WHERE company_id=NEW.company_id AND user_id=NEW.approved_by AND role IN('owner','admin'))
  OR (SELECT count(*) FROM studio_generated_revision_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND round_id=NEW.id)<>jsonb_array_length(plan.snapshot->'items')
 THEN RAISE EXCEPTION 'Revision round is not the complete approved next scope' USING ERRCODE='23514';END IF;
 changed_count:=0;
 FOR entry IN SELECT value FROM jsonb_array_elements(plan.snapshot->'items') LOOP
  SELECT * INTO item FROM studio_generated_revision_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND round_id=NEW.id AND unit_id=(entry->>'unitId')::uuid;
  SELECT * INTO generation FROM studio_work_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=item.generation_work_item_id;
  SELECT * INTO qc FROM studio_work_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=item.qc_work_item_id;
  IF item.action IS DISTINCT FROM entry->>'action' OR generation.shot_id IS DISTINCT FROM item.unit_id OR generation.stage IS DISTINCT FROM 'generation' OR generation.execution IS DISTINCT FROM 'creative' OR qc.shot_id IS DISTINCT FROM item.unit_id OR qc.stage IS DISTINCT FROM 'qc' OR qc.execution IS DISTINCT FROM 'human'
   OR NOT EXISTS(SELECT 1 FROM studio_dependencies WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND work_item_id=qc.id AND predecessor_id=generation.id)
  THEN RAISE EXCEPTION 'Revision work does not match the approved item' USING ERRCODE='23514';END IF;
  IF item.action='carry' THEN
   IF item.generation_work_item_id::text IS DISTINCT FROM entry->'base'->>'generationWorkItemId' OR item.qc_work_item_id::text IS DISTINCT FROM entry->'base'->>'qcWorkItemId' OR item.artifact_id::text IS DISTINCT FROM entry->'base'->>'artifactId' OR item.review_id::text IS DISTINCT FROM entry->'base'->>'reviewId' OR item.storage_version_id::text IS DISTINCT FROM entry->'base'->>'storageVersionId' OR item.manifest_sha256 IS DISTINCT FROM entry->'base'->>'manifestSha256' OR item.file_sha256 IS DISTINCT FROM entry->'base'->>'fileSha256' THEN RAISE EXCEPTION 'Carried media is not the exact source package version' USING ERRCODE='23514';END IF;
  ELSE
   changed_count:=changed_count+1;
   IF generation.id::text=entry->'base'->>'generationWorkItemId' OR qc.id::text=entry->'base'->>'qcWorkItemId'
    OR (SELECT count(*) FROM studio_generated_revision_work WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND round_id=NEW.id AND work_item_id IN(generation.id,qc.id))<>2
   THEN RAISE EXCEPTION 'Revised production requires fresh work identities' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 SELECT count(*) INTO work_count FROM studio_generated_revision_work WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND round_id=NEW.id;
 IF work_count<>3+3*changed_count OR EXISTS(SELECT 1 FROM studio_generated_revision_work rw JOIN studio_work_items w ON w.company_id=rw.company_id AND w.project_id=rw.project_id AND w.id=rw.work_item_id WHERE rw.company_id=NEW.company_id AND rw.project_id=NEW.project_id AND rw.round_id=NEW.id AND w.logical_key NOT LIKE 'revision:'||NEW.id::text||':%') THEN RAISE EXCEPTION 'Revision task graph is incomplete or reuses old work' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_generated_revision_round_check AFTER INSERT ON studio_generated_revision_rounds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_revision_round_check();

-- Append-only also means a sealed round cannot gain extra work through a later
-- INSERT. The round check validates its initial complete graph; these bounded
-- deferred checks preserve its cardinality on every mapping insertion.
CREATE FUNCTION studio_generated_revision_mapping_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_items integer;expected_work integer;prepared jsonb;round record;
BEGIN
 SELECT r.*,p.snapshot INTO round FROM studio_generated_revision_rounds r JOIN studio_generated_revision_plans p ON p.company_id=r.company_id AND p.project_id=r.project_id AND p.id=r.plan_id WHERE r.company_id=NEW.company_id AND r.project_id=NEW.project_id AND r.id=NEW.round_id;
 IF TG_TABLE_NAME='studio_generated_delivery_rounds' THEN
  SELECT manifest INTO prepared FROM studio_deliveries WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.delivery_id;
  IF prepared->'revisionRound' IS DISTINCT FROM jsonb_build_object('roundId',round.id,'number',round.number,'planSha256',round.plan_sha256) THEN RAISE EXCEPTION 'Delivery cannot be relabeled as another production round' USING ERRCODE='23514';END IF;
 ELSE
  expected_items:=jsonb_array_length(round.snapshot->'items');
  SELECT 3+3*count(*)::integer INTO expected_work FROM jsonb_array_elements(round.snapshot->'items') i WHERE i->>'action'='regenerate';
  IF (SELECT count(*) FROM studio_generated_revision_items WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND round_id=NEW.round_id)<>expected_items
   OR (SELECT count(*) FROM studio_generated_revision_work WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND round_id=NEW.round_id)<>expected_work
  THEN RAISE EXCEPTION 'A sealed revision graph cannot gain or lose work' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_generated_revision_work_check AFTER INSERT ON studio_generated_revision_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_revision_mapping_check();
CREATE CONSTRAINT TRIGGER studio_generated_revision_item_check AFTER INSERT ON studio_generated_revision_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_revision_mapping_check();
CREATE CONSTRAINT TRIGGER studio_generated_delivery_round_check AFTER INSERT ON studio_generated_delivery_rounds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_revision_mapping_check();
