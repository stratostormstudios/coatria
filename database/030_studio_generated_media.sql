-- WITHHELD FOUNDATION: no production migration until version-aware services,
-- registration/QC and explicit rollout guards are reviewed. No grants or data
-- backfill. Legacy JSON, frame contracts, manifests and request hashes stay put.
CREATE FUNCTION studio_generated_keys(value jsonb, names text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
 SELECT COALESCE(jsonb_typeof(value)='object' AND value ?& names AND value-names='{}'::jsonb,false)
$$;
CREATE FUNCTION studio_generated_integer(value jsonb, low numeric, high numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN jsonb_typeof(value)='number' THEN value::numeric BETWEEN low AND high AND trunc(value::numeric)=value::numeric ELSE false END
$$;
CREATE FUNCTION studio_generated_color_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((studio_generated_keys(value,ARRAY['mode']) AND value->>'mode'='not_required') OR
 (studio_generated_keys(value,ARRAY['mode','space','primaries','transfer','range']) AND value->>'mode'='exact'
 AND value->>'space'=ANY(ARRAY['gbr','bt709','bt2020nc','bt2020c','smpte170m'])
 AND value->>'primaries'=ANY(ARRAY['bt709','bt2020','smpte170m','smpte432'])
 AND value->>'transfer'=ANY(ARRAY['bt709','iec61966-2-1','linear','smpte2084','arib-std-b67','smpte170m'])
 AND value->>'range'=ANY(ARRAY['pc','tv'])),false)
$$;
CREATE FUNCTION studio_generated_spec_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
DECLARE k text; fmt text; codec text; audio jsonb; rate jsonb;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' OR octet_length(value::text)>16384 THEN RETURN false; END IF;
 k:=value->>'kind';fmt:=value->>'format';codec:=value->>'codec';
 IF k='image' THEN
  IF NOT studio_generated_keys(value,ARRAY['kind','format','width','height','color']) OR fmt IS NULL OR fmt<>ALL(ARRAY['png','jpeg','webp']) THEN RETURN false; END IF;
 ELSIF k='video' THEN
  IF NOT studio_generated_keys(value,ARRAY['kind','format','codec','width','height','color','frameRate','audio']) THEN RETURN false; END IF;
  IF NOT COALESCE((fmt='mp4' AND codec=ANY(ARRAY['h264','hevc','av1','mpeg4'])) OR (fmt='mov' AND codec=ANY(ARRAY['h264','hevc','mpeg4','prores'])),false) THEN RETURN false; END IF;
  rate:=value->'frameRate';
  IF NOT studio_generated_keys(rate,ARRAY['mode','numerator','denominator']) OR rate->>'mode' IS DISTINCT FROM 'constant'
   OR NOT studio_generated_integer(rate->'numerator',1,1000000000) OR NOT studio_generated_integer(rate->'denominator',1,1000000000) THEN RETURN false; END IF;
  -- Persist the normalized form emitted by the shared v2 parser.
  IF (rate->>'numerator')::bigint>240*(rate->>'denominator')::bigint OR gcd((rate->>'numerator')::bigint,(rate->>'denominator')::bigint)<>1 THEN RETURN false; END IF;
  audio:=value->'audio';
  IF studio_generated_keys(audio,ARRAY['mode']) AND audio->>'mode'='none' THEN NULL;
  ELSIF studio_generated_keys(audio,ARRAY['mode','codec','sampleRateHz','channels']) AND audio->>'mode'='required' THEN
   IF NOT studio_generated_integer(audio->'sampleRateHz',1,384000) OR NOT studio_generated_integer(audio->'channels',1,8)
    OR NOT COALESCE((fmt='mp4' AND audio->>'codec'=ANY(ARRAY['aac','mp3'])) OR (fmt='mov' AND audio->>'codec'=ANY(ARRAY['aac','mp3','pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'])),false) THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
 ELSIF k='audio' THEN
  RETURN studio_generated_keys(value,ARRAY['kind','format','codec','sampleRateHz','channels'])
   AND studio_generated_integer(value->'sampleRateHz',1,384000) AND studio_generated_integer(value->'channels',1,8)
   AND COALESCE((fmt='mp3' AND codec='mp3') OR (fmt='wav' AND codec=ANY(ARRAY['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'])),false);
 ELSE RETURN false; END IF;
 IF NOT studio_generated_integer(value->'width',1,16384) OR NOT studio_generated_integer(value->'height',1,16384) THEN RETURN false; END IF;
 RETURN (value->>'width')::bigint*(value->>'height')::bigint<=67108864 AND studio_generated_color_valid(value->'color');
END $$;

-- Canonical JSON only for the bounded integer-valued specification/work unit.
-- ASCII key ordering matches generatedSpecificationCanonical; valid Unicode is
-- retained. trim_scale avoids JSONB numeric scale changing an integer's hash.
CREATE FUNCTION studio_generated_canonical(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||studio_generated_canonical(item),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) AS entry(key,item);
 WHEN 'array' THEN SELECT '['||COALESCE(string_agg(studio_generated_canonical(item),',' ORDER BY position),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item,position);
 WHEN 'number' THEN result:=trim_scale(value::numeric)::text;
 ELSE result:=value::text;
 END CASE;
 RETURN result;
END $$;

ALTER TABLE studio_projects ADD COLUMN contract_version smallint NOT NULL DEFAULT 1,
 ADD CONSTRAINT studio_projects_contract_version CHECK(contract_version IN(1,2)),
 ADD CONSTRAINT studio_projects_generated_spec CHECK(contract_version=1 OR (production_path='higgsfield' AND studio_generated_spec_valid(spec)));
CREATE FUNCTION studio_generated_project_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.contract_version IS DISTINCT FROM OLD.contract_version OR (OLD.contract_version=2 AND ROW(NEW.id,NEW.company_id,NEW.spec) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.spec)) THEN
  RAISE EXCEPTION 'Generated project requirements are immutable' USING ERRCODE='23514';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER studio_generated_project_immutable BEFORE UPDATE ON studio_projects FOR EACH ROW EXECUTE FUNCTION studio_generated_project_immutable();

ALTER TABLE studio_shots ADD COLUMN media_kind text NOT NULL DEFAULT 'legacy_frames',ADD COLUMN duration_min_ms integer,ADD COLUMN duration_max_ms integer,
 ALTER COLUMN frame_start DROP NOT NULL,ALTER COLUMN frame_end DROP NOT NULL,ALTER COLUMN handles DROP NOT NULL,
 DROP CONSTRAINT studio_shots_check,
 ADD CONSTRAINT studio_shots_typed_unit CHECK(
  (media_kind='legacy_frames' AND frame_start IS NOT NULL AND frame_end IS NOT NULL AND handles IS NOT NULL AND frame_start>=0 AND frame_end>=frame_start AND frame_end-frame_start<=100000 AND handles BETWEEN 0 AND 1000 AND duration_min_ms IS NULL AND duration_max_ms IS NULL)
  OR (media_kind='image' AND frame_start IS NULL AND frame_end IS NULL AND handles IS NULL AND duration_min_ms IS NULL AND duration_max_ms IS NULL AND disciplines='[]'::jsonb)
  OR (media_kind IN('video','audio') AND frame_start IS NULL AND frame_end IS NULL AND handles IS NULL AND duration_min_ms IS NOT NULL AND duration_max_ms IS NOT NULL AND duration_min_ms BETWEEN 1 AND 3600000 AND duration_max_ms BETWEEN duration_min_ms AND 3600000 AND disciplines='[]'::jsonb));
CREATE FUNCTION studio_generated_unit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p record;
BEGIN
 SELECT contract_version,spec INTO p FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id FOR KEY SHARE;
 IF NOT FOUND OR (p.contract_version=1 AND NEW.media_kind<>'legacy_frames') OR (p.contract_version=2 AND NEW.media_kind IS DISTINCT FROM p.spec->>'kind') THEN RAISE EXCEPTION 'Deliverable does not match its project contract' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (OLD.media_kind<>'legacy_frames' OR NEW.media_kind<>'legacy_frames') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Generated deliverable requirements are immutable' USING ERRCODE='23514';END IF;
 IF p.contract_version=2 AND (NEW.code!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$' OR length(NEW.description) NOT BETWEEN 1 AND 2000 OR btrim(NEW.description)='') THEN RAISE EXCEPTION 'Generated deliverable text is invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_generated_unit_guard BEFORE INSERT OR UPDATE ON studio_shots FOR EACH ROW EXECUTE FUNCTION studio_generated_unit_guard();
CREATE UNIQUE INDEX studio_generated_unit_code ON studio_shots(company_id,project_id,lower(code)) WHERE media_kind<>'legacy_frames';
CREATE FUNCTION studio_generated_work_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version smallint; previous_version smallint;
BEGIN
 SELECT contract_version INTO version FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id FOR KEY SHARE;
 IF TG_OP='UPDATE' THEN SELECT contract_version INTO previous_version FROM studio_projects WHERE company_id=OLD.company_id AND id=OLD.project_id FOR KEY SHARE;END IF;
 IF (version=2 AND NEW.execution='dcc') OR ((version=2 OR previous_version=2) AND TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Generated work cannot use or change a DCC contract' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_generated_work_guard BEFORE INSERT OR UPDATE ON studio_work_items FOR EACH ROW EXECUTE FUNCTION studio_generated_work_guard();
CREATE FUNCTION studio_generated_legacy_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM studio_projects WHERE company_id=NEW.company_id AND id=NEW.project_id AND contract_version=2) THEN RAISE EXCEPTION 'This legacy operation does not support generated contracts' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER studio_execution_legacy_contract BEFORE INSERT OR UPDATE ON studio_execution_jobs FOR EACH ROW EXECUTE FUNCTION studio_generated_legacy_only();
CREATE TRIGGER studio_promotion_legacy_contract BEFORE INSERT OR UPDATE ON studio_media_promotions FOR EACH ROW EXECUTE FUNCTION studio_generated_legacy_only();

ALTER TABLE studio_artifacts ADD COLUMN contract_version smallint NOT NULL DEFAULT 1,
 ADD CONSTRAINT studio_artifacts_contract_version CHECK(contract_version IN(1,2)),
 ADD CONSTRAINT studio_artifacts_work_identity UNIQUE(company_id,project_id,id,work_item_id);
CREATE FUNCTION studio_generated_artifact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.contract_version IS DISTINCT FROM OLD.contract_version OR (OLD.contract_version=2 AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Generated artifacts are immutable' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER studio_generated_artifact_immutable BEFORE UPDATE ON studio_artifacts FOR EACH ROW EXECUTE FUNCTION studio_generated_artifact_immutable();
CREATE TABLE studio_generated_artifact_sources (
 company_id uuid NOT NULL,project_id uuid NOT NULL,artifact_id uuid NOT NULL,work_item_id uuid NOT NULL,
 archive_id uuid NOT NULL,request_id uuid NOT NULL,job_id uuid NOT NULL,output_id uuid NOT NULL,storage_version_id uuid NOT NULL,
 spec_sha256 text NOT NULL CHECK(spec_sha256~'^[a-f0-9]{64}$'),manifest_text text NOT NULL CHECK(octet_length(manifest_text) BETWEEN 2 AND 131072),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256=encode(sha256(convert_to(manifest_text,'UTF8')),'hex')),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=32768),
 observed_media jsonb NOT NULL CHECK(jsonb_typeof(observed_media)='object' AND octet_length(observed_media::text)<=32768),
 file_facts jsonb NOT NULL CHECK(studio_generated_keys(file_facts,ARRAY['bytes','sha256','contentType']) AND octet_length(file_facts::text)<=1024),
 archive_approved_by uuid NOT NULL REFERENCES users(id),registered_by uuid NOT NULL REFERENCES users(id),registered_agent_id uuid,registered_run_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,project_id,artifact_id),UNIQUE(company_id,project_id,output_id),UNIQUE(company_id,archive_id),UNIQUE(company_id,storage_version_id),
 UNIQUE(company_id,project_id,artifact_id,spec_sha256,manifest_sha256),CHECK((registered_agent_id IS NULL)=(registered_run_id IS NULL)),
 FOREIGN KEY(company_id,project_id,artifact_id,work_item_id) REFERENCES studio_artifacts(company_id,project_id,id,work_item_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,archive_id) REFERENCES higgsfield_output_archives(company_id,project_id,id),
 FOREIGN KEY(company_id,archive_id) REFERENCES higgsfield_archive_fetches(company_id,archive_id),
 FOREIGN KEY(company_id,project_id,request_id) REFERENCES higgsfield_job_receipts(company_id,project_id,request_id),
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES higgsfield_jobs(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,output_id) REFERENCES higgsfield_job_outputs(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,storage_version_id) REFERENCES project_storage_versions(company_id,project_id,id),
 FOREIGN KEY(company_id,storage_version_id) REFERENCES project_storage_verifications(company_id,version_id),
 FOREIGN KEY(company_id,registered_agent_id) REFERENCES agents(company_id,id),FOREIGN KEY(company_id,registered_run_id) REFERENCES agent_runs(company_id,id)
);
CREATE FUNCTION studio_generated_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 -- Whole-project/tenant deletion can cascade; an individual evidence row may not.
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM studio_projects WHERE company_id=OLD.company_id AND id=OLD.project_id) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Generated evidence is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER studio_generated_source_immutable BEFORE UPDATE OR DELETE ON studio_generated_artifact_sources FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();

CREATE FUNCTION studio_generated_unique_json_keys(value json) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item json;
BEGIN
 IF json_typeof(value)='object' THEN
  IF EXISTS(SELECT 1 FROM json_each(value) GROUP BY key COLLATE "C" HAVING count(*)>1) THEN RETURN false;END IF;
  FOR item IN SELECT entry.value FROM json_each(value) AS entry LOOP IF NOT studio_generated_unique_json_keys(item) THEN RETURN false;END IF;END LOOP;
 ELSIF json_typeof(value)='array' THEN
  FOR item IN SELECT json_array_elements(value) LOOP IF NOT studio_generated_unique_json_keys(item) THEN RETURN false;END IF;END LOOP;
 END IF;RETURN true;
END $$;

CREATE FUNCTION studio_generated_source_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE artifact_key uuid; a record; s record; p record; w record; unit record; archive record; fetched record; output record; job record; request record; receipt record; upload record; version record; verified record; manifest jsonb; expected_work jsonb; facts jsonb;
BEGIN
 IF TG_TABLE_NAME='studio_artifacts' THEN artifact_key:=NEW.id;ELSE artifact_key:=NEW.artifact_id;END IF;
 SELECT * INTO a FROM studio_artifacts WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=artifact_key;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO p FROM studio_projects WHERE company_id=a.company_id AND id=a.project_id;
 IF a.contract_version<>p.contract_version THEN RAISE EXCEPTION 'Artifact contract does not match its project' USING ERRCODE='23514';END IF;
 -- Existing runtime roles have no grants on the new companion tables. Their
 -- legacy inserts must not read new evidence tables or require new privileges.
 IF a.contract_version=1 THEN
  IF TG_TABLE_NAME='studio_generated_artifact_sources' THEN RAISE EXCEPTION 'Legacy artifacts cannot acquire generated evidence' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO s FROM studio_generated_artifact_sources WHERE company_id=a.company_id AND project_id=a.project_id AND artifact_id=a.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Artifact contract requires its exact generated source companion' USING ERRCODE='23514';END IF;
 SELECT * INTO w FROM studio_work_items WHERE company_id=a.company_id AND project_id=a.project_id AND id=a.work_item_id;
 SELECT * INTO unit FROM studio_shots WHERE company_id=a.company_id AND project_id=a.project_id AND id=w.shot_id;
 IF w.execution IS DISTINCT FROM 'creative' OR w.stage IS DISTINCT FROM 'generation' OR unit.media_kind IS DISTINCT FROM p.spec->>'kind' THEN RAISE EXCEPTION 'Generated source must target its generation deliverable' USING ERRCODE='23514';END IF;
 SELECT * INTO archive FROM higgsfield_output_archives WHERE company_id=a.company_id AND project_id=a.project_id AND id=s.archive_id FOR SHARE;
 SELECT * INTO fetched FROM higgsfield_archive_fetches WHERE company_id=a.company_id AND archive_id=s.archive_id;
 SELECT * INTO output FROM higgsfield_job_outputs WHERE company_id=a.company_id AND project_id=a.project_id AND id=s.output_id;
 SELECT * INTO job FROM higgsfield_jobs WHERE company_id=a.company_id AND project_id=a.project_id AND id=s.job_id FOR SHARE;
 SELECT * INTO request FROM higgsfield_requests WHERE company_id=a.company_id AND project_id=a.project_id AND id=s.request_id FOR SHARE;
 SELECT * INTO receipt FROM higgsfield_job_receipts WHERE company_id=a.company_id AND project_id=a.project_id AND request_id=s.request_id;
 SELECT * INTO upload FROM project_storage_uploads WHERE company_id=a.company_id AND project_id=a.project_id AND id=archive.upload_id FOR SHARE;
 SELECT * INTO version FROM project_storage_versions WHERE company_id=a.company_id AND project_id=a.project_id AND id=s.storage_version_id;
 SELECT * INTO verified FROM project_storage_verifications WHERE company_id=a.company_id AND project_id=a.project_id AND version_id=s.storage_version_id;
 IF archive.status IS DISTINCT FROM 'verified' OR archive.revoked_at IS NOT NULL OR archive.approved_by IS DISTINCT FROM s.archive_approved_by OR archive.version_id IS DISTINCT FROM s.storage_version_id OR archive.request_id IS DISTINCT FROM s.request_id OR archive.job_id IS DISTINCT FROM s.job_id OR archive.output_id IS DISTINCT FROM s.output_id
  OR upload.status IS DISTINCT FROM 'ready' OR upload.archive_id IS DISTINCT FROM s.archive_id OR upload.version_id IS DISTINCT FROM s.storage_version_id OR upload.action_id IS NOT NULL
  OR job.status IS DISTINCT FROM 'completed' OR job.request_id IS DISTINCT FROM s.request_id OR job.connection_id IS DISTINCT FROM archive.provider_connection_id OR job.kind IS DISTINCT FROM output.kind
  OR output.job_id IS DISTINCT FROM s.job_id OR output.kind IS DISTINCT FROM p.spec->>'kind' OR output.locator_identity IS DISTINCT FROM archive.locator_identity
  OR request.status IS DISTINCT FROM 'returned' OR request.work_item_id IS DISTINCT FROM s.work_item_id OR request.connection_id IS DISTINCT FROM job.connection_id
  OR receipt.outcome IS DISTINCT FROM 'jobs' OR receipt.connection_id IS DISTINCT FROM job.connection_id OR receipt.connection_revision IS DISTINCT FROM request.connection_revision OR receipt.request_hash IS DISTINCT FROM request.request_hash OR receipt.approved_by IS DISTINCT FROM request.approved_by
  OR s.source_snapshot IS DISTINCT FROM archive.source_snapshot OR s.observed_media IS DISTINCT FROM fetched.media OR fetched.locator_identity IS DISTINCT FROM output.locator_identity
  OR fetched.project_id IS DISTINCT FROM a.project_id OR fetched.bytes IS DISTINCT FROM verified.bytes OR fetched.sha256 IS DISTINCT FROM verified.sha256 OR version.bytes IS DISTINCT FROM verified.bytes OR (version.sha256 IS NOT NULL AND version.sha256 IS DISTINCT FROM verified.sha256)
  OR verified.provider_etag IS DISTINCT FROM upload.provider_etag THEN RAISE EXCEPTION 'Generated source evidence does not match the verified archive' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM project_storage_files f JOIN project_storage_bindings b ON b.company_id=f.company_id AND b.project_id=f.project_id AND b.id=f.binding_id WHERE f.company_id=a.company_id AND f.project_id=a.project_id AND f.id=version.file_id AND b.id=archive.storage_binding_id AND b.connection_id=archive.storage_connection_id) THEN RAISE EXCEPTION 'Generated source storage identity changed' USING ERRCODE='23514';END IF;
 facts:=jsonb_build_object('bytes',verified.bytes,'sha256',verified.sha256,'contentType',version.content_type);
 IF s.file_facts IS DISTINCT FROM facts OR fetched.media->'bytes' IS DISTINCT FROM to_jsonb(verified.bytes) OR fetched.media->>'sha256' IS DISTINCT FROM verified.sha256 OR fetched.media->>'contentType' IS DISTINCT FROM version.content_type OR fetched.media->>'kind' IS DISTINCT FROM p.spec->>'kind' OR fetched.media->>'verification' IS DISTINCT FROM 'full_decode' OR fetched.media->'inspectionVersion' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'Generated byte and inspection facts conflict' USING ERRCODE='23514';END IF;
 IF s.source_snapshot->>'requestId' IS DISTINCT FROM request.id::text OR s.source_snapshot->>'requestHash' IS DISTINCT FROM receipt.request_hash OR s.source_snapshot->>'receiptHash' IS DISTINCT FROM receipt.source_sha256 OR s.source_snapshot->>'contract' IS DISTINCT FROM receipt.contract OR s.source_snapshot->>'providerConnectionId' IS DISTINCT FROM receipt.connection_id::text OR s.source_snapshot->'requestConnectionRevision' IS DISTINCT FROM to_jsonb(receipt.connection_revision) OR s.source_snapshot->>'providerJobId' IS DISTINCT FROM job.provider_job_id::text OR s.source_snapshot->>'outputId' IS DISTINCT FROM output.id::text OR s.source_snapshot->>'outputIdentity' IS DISTINCT FROM output.locator_identity OR s.source_snapshot->>'workItemId' IS DISTINCT FROM w.id::text OR s.source_snapshot->>'kind' IS DISTINCT FROM output.kind
  OR s.source_snapshot->>'requestedBy' IS DISTINCT FROM request.requested_by::text OR s.source_snapshot->>'agentId' IS DISTINCT FROM request.agent_id::text OR s.source_snapshot->>'runId' IS DISTINCT FROM request.run_id::text OR s.source_snapshot->>'approvedBy' IS DISTINCT FROM receipt.approved_by::text
  OR s.source_snapshot->'ordinal' IS DISTINCT FROM to_jsonb(output.ordinal) OR s.source_snapshot->>'model' IS DISTINCT FROM job.model OR s.source_snapshot->>'roleAgentId' IS DISTINCT FROM request.role_agent_id::text OR s.source_snapshot->>'roleHumanId' IS DISTINCT FROM request.role_human_id::text OR s.source_snapshot->>'taskId' IS DISTINCT FROM w.task_id::text OR s.source_snapshot->>'roleKey' IS DISTINCT FROM w.role_key
  OR a.produced_by::text IS DISTINCT FROM s.source_snapshot->>'requestedBy' OR a.produced_agent_id::text IS DISTINCT FROM s.source_snapshot->>'agentId' OR a.run_id::text IS DISTINCT FROM s.source_snapshot->>'runId' OR a.agent_sponsor_id::text IS DISTINCT FROM s.source_snapshot->>'agentSponsorId' THEN RAISE EXCEPTION 'Generated original attribution conflicts with its adopted source' USING ERRCODE='23514';END IF;
 IF s.registered_agent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE company_id=a.company_id AND id=s.registered_run_id AND agent_id=s.registered_agent_id AND requested_by=s.registered_by) THEN RAISE EXCEPTION 'Generated registrar run identity conflicts' USING ERRCODE='23514';END IF;
 expected_work:=jsonb_build_object('kind',unit.media_kind,'code',unit.code,'description',unit.description);
 IF unit.media_kind IN('video','audio') THEN expected_work:=expected_work||jsonb_build_object('durationMs',jsonb_build_object('min',unit.duration_min_ms,'max',unit.duration_max_ms));END IF;
 IF s.spec_sha256<>encode(sha256(convert_to(studio_generated_canonical(jsonb_build_object('schemaVersion',2,'kind','generated_specification','spec',p.spec,'workUnit',expected_work)),'UTF8')),'hex') THEN RAISE EXCEPTION 'Generated specification hash conflicts with immutable requirements' USING ERRCODE='23514';END IF;
 BEGIN manifest:=s.manifest_text::jsonb;IF NOT studio_generated_unique_json_keys(s.manifest_text::json) THEN RAISE EXCEPTION 'Generated manifest has duplicate keys' USING ERRCODE='23514';END IF;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Generated manifest is invalid JSON' USING ERRCODE='23514';END;
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object' OR a.sha256 IS DISTINCT FROM s.manifest_sha256 OR a.url IS DISTINCT FROM '/api/companies/'||a.company_id::text||'/studio/projects/'||a.project_id::text||'/generated-artifacts/'||a.id::text||'/manifest'
  OR NOT (manifest @> jsonb_build_object('schemaVersion',2,'kind','verified_generated_media','mediaKind',p.spec->>'kind','companyId',a.company_id,'projectId',a.project_id,'artifactId',a.id,'workItemId',w.id,'archiveId',s.archive_id,'archiveApprovedBy',s.archive_approved_by,'requestId',s.request_id,'jobId',s.job_id,'outputId',s.output_id,'storageVersionId',s.storage_version_id,'specSha256',s.spec_sha256))
  OR manifest->'source' IS DISTINCT FROM s.source_snapshot OR manifest->'media' IS DISTINCT FROM s.observed_media OR manifest->'file' IS DISTINCT FROM facts THEN RAISE EXCEPTION 'Generated manifest conflicts with its authoritative source projection' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_generated_artifact_companion AFTER INSERT OR UPDATE ON studio_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_source_check();
CREATE CONSTRAINT TRIGGER studio_generated_source_companion AFTER INSERT ON studio_generated_artifact_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_source_check();

ALTER TABLE studio_reviews ADD CONSTRAINT studio_reviews_artifact_identity UNIQUE(company_id,project_id,id,artifact_id);
CREATE FUNCTION studio_generated_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD AND EXISTS(SELECT 1 FROM studio_artifacts WHERE contract_version=2 AND ((company_id=OLD.company_id AND project_id=OLD.project_id AND id=OLD.artifact_id) OR (company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.artifact_id))) THEN RAISE EXCEPTION 'Generated reviews are immutable' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER studio_generated_review_immutable BEFORE UPDATE ON studio_reviews FOR EACH ROW EXECUTE FUNCTION studio_generated_review_immutable();
CREATE TABLE studio_generated_review_evidence (
 company_id uuid NOT NULL,project_id uuid NOT NULL,review_id uuid NOT NULL,artifact_id uuid NOT NULL,
 spec_sha256 text NOT NULL,manifest_sha256 text NOT NULL,attestation_version smallint NOT NULL CHECK(attestation_version=1),
 technical_match jsonb NOT NULL CHECK(studio_generated_keys(technical_match,ARRAY['matches','issues','limitations']) AND jsonb_typeof(technical_match->'matches')='boolean' AND jsonb_typeof(technical_match->'issues')='array' AND jsonb_typeof(technical_match->'limitations')='array' AND octet_length(technical_match::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,project_id,review_id),
 FOREIGN KEY(company_id,project_id,review_id,artifact_id) REFERENCES studio_reviews(company_id,project_id,id,artifact_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,artifact_id,spec_sha256,manifest_sha256) REFERENCES studio_generated_artifact_sources(company_id,project_id,artifact_id,spec_sha256,manifest_sha256)
);
CREATE TRIGGER studio_generated_review_immutable BEFORE UPDATE OR DELETE ON studio_generated_review_evidence FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
CREATE FUNCTION studio_generated_review_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review_key uuid; reviewer_role text; r record; a record; e record; s record;
BEGIN
 IF TG_TABLE_NAME='studio_reviews' THEN review_key:=NEW.id;ELSE review_key:=NEW.review_id;END IF;
 SELECT * INTO r FROM studio_reviews WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=review_key;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO a FROM studio_artifacts WHERE company_id=r.company_id AND project_id=r.project_id AND id=r.artifact_id;
 IF a.contract_version=1 THEN
  IF TG_TABLE_NAME='studio_generated_review_evidence' THEN RAISE EXCEPTION 'Legacy reviews cannot acquire generated evidence' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO e FROM studio_generated_review_evidence WHERE company_id=r.company_id AND project_id=r.project_id AND review_id=r.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Generated review requires its exact evidence companion' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM studio_generated_artifact_sources WHERE company_id=r.company_id AND project_id=r.project_id AND artifact_id=r.artifact_id;
 SELECT role INTO reviewer_role FROM memberships WHERE company_id=r.company_id AND user_id=r.reviewed_by FOR SHARE;
 IF r.reviewed_by IN(a.produced_by,a.agent_sponsor_id,s.registered_by) OR r.reviewed_by::text=s.source_snapshot->>'providerSponsorId' OR reviewer_role IS NULL OR reviewer_role NOT IN('owner','admin') THEN RAISE EXCEPTION 'Generated review requires an independent human administrator' USING ERRCODE='23514';END IF;
 IF (e.technical_match->>'matches')::boolean IS DISTINCT FROM (jsonb_array_length(e.technical_match->'issues')=0) OR (r.decision='approved' AND (NOT r.technical_qc OR e.technical_match->'matches'<>'true'::jsonb)) THEN RAISE EXCEPTION 'Generated review evidence conflicts with its decision' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_generated_review_companion AFTER INSERT OR UPDATE ON studio_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_review_check();
CREATE CONSTRAINT TRIGGER studio_generated_review_evidence_companion AFTER INSERT ON studio_generated_review_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_generated_review_check();
