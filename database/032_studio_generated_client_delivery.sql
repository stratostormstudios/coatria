-- Exact generated storage versions extend the existing authenticated client
-- portal. No provider call, anonymous invitation or company membership is added.
CREATE FUNCTION studio_client_share_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.package_snapshot->>'schemaVersion'='2' OR NEW.package_snapshot->>'schemaVersion'='2' THEN
  IF (to_jsonb(NEW)-'status'-'revision'-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'revision'-'revoked_at')
   OR OLD.status='revoked' AND NEW.status<>'revoked'
  THEN RAISE EXCEPTION 'Client invitation account and package identity are immutable' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_client_share_immutable BEFORE UPDATE ON studio_client_deliveries FOR EACH ROW EXECUTE FUNCTION studio_client_share_immutable();
ALTER TABLE studio_generated_artifact_sources ADD CONSTRAINT studio_generated_source_storage_identity UNIQUE(company_id,project_id,artifact_id,storage_version_id);
ALTER TABLE studio_client_delivery_files
 ADD COLUMN storage_version_id uuid,
 ADD COLUMN storage_sha256 text,
 ADD COLUMN storage_bytes bigint,
 ADD COLUMN storage_content_type text,
 ADD COLUMN storage_name text,
 ADD COLUMN review_id uuid,
 ADD COLUMN media_file_id uuid GENERATED ALWAYS AS (CASE WHEN storage_version_id IS NULL THEN file_id ELSE NULL END) STORED;
ALTER TABLE studio_client_delivery_files DROP CONSTRAINT studio_client_delivery_files_company_id_file_id_fkey;
ALTER TABLE studio_client_delivery_files
 ADD CONSTRAINT studio_client_file_legacy_source FOREIGN KEY(company_id,media_file_id) REFERENCES studio_media_files(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT studio_client_file_generated_source FOREIGN KEY(company_id,project_id,artifact_id,storage_version_id) REFERENCES studio_generated_artifact_sources(company_id,project_id,artifact_id,storage_version_id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT studio_client_file_generated_review FOREIGN KEY(company_id,project_id,review_id,artifact_id) REFERENCES studio_reviews(company_id,project_id,id,artifact_id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT studio_client_file_review_evidence FOREIGN KEY(company_id,project_id,review_id) REFERENCES studio_generated_review_evidence(company_id,project_id,review_id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT studio_client_file_source_shape CHECK(
  (storage_version_id IS NULL AND storage_sha256 IS NULL AND storage_bytes IS NULL AND storage_content_type IS NULL AND storage_name IS NULL AND review_id IS NULL) OR
  (storage_version_id IS NOT NULL AND file_id=storage_version_id AND review_id IS NOT NULL AND storage_sha256 IS NOT NULL AND storage_sha256~'^[a-f0-9]{64}$' AND storage_bytes IS NOT NULL AND storage_bytes>0 AND storage_bytes<=107374182400 AND storage_content_type IS NOT NULL AND length(storage_content_type) BETWEEN 1 AND 120 AND storage_name IS NOT NULL AND length(storage_name) BETWEEN 1 AND 200 AND position('/' in storage_name)=0 AND position(chr(92) in storage_name)=0 AND storage_name!~'[[:cntrl:]]')),
 ADD CONSTRAINT studio_client_file_project_identity UNIQUE(company_id,project_id,share_id,file_id);

CREATE FUNCTION studio_client_generated_file_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE package jsonb; prepared jsonb; source record; entry jsonb; count_entries integer;
BEGIN
 SELECT package_snapshot INTO package FROM studio_client_deliveries WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.share_id;
 IF NEW.storage_version_id IS NULL THEN
  IF package->>'schemaVersion' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Generated client packages require generated storage grants' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO source FROM studio_generated_artifact_sources WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND artifact_id=NEW.artifact_id;
 SELECT d.manifest INTO prepared FROM studio_client_deliveries s JOIN studio_deliveries d ON d.company_id=s.company_id AND d.project_id=s.project_id AND d.id=s.delivery_id WHERE s.company_id=NEW.company_id AND s.project_id=NEW.project_id AND s.id=NEW.share_id;
 SELECT count(*) INTO count_entries FROM jsonb_array_elements(package->'files') f WHERE f->>'fileId'=NEW.file_id::text;
 SELECT f INTO entry FROM jsonb_array_elements(package->'files') f WHERE f->>'fileId'=NEW.file_id::text LIMIT 1;
 IF package->>'schemaVersion' IS DISTINCT FROM '2' OR count_entries<>1 OR source.storage_version_id IS DISTINCT FROM NEW.storage_version_id
  OR (SELECT count(*) FROM jsonb_array_elements(prepared->'reviewReceipts') r WHERE r->>'id'=NEW.review_id::text AND r->>'artifactId'=NEW.artifact_id::text)<>1
  OR source.file_facts->>'sha256' IS DISTINCT FROM NEW.storage_sha256 OR (source.file_facts->>'bytes')::bigint IS DISTINCT FROM NEW.storage_bytes OR source.file_facts->>'contentType' IS DISTINCT FROM NEW.storage_content_type
  OR entry->>'artifactId' IS DISTINCT FROM NEW.artifact_id::text OR entry->>'storageVersionId' IS DISTINCT FROM NEW.storage_version_id::text
  OR entry->>'path' IS DISTINCT FROM NEW.storage_name OR entry->>'transport' IS DISTINCT FROM 'project_storage' OR entry->'frame' IS DISTINCT FROM 'null'::jsonb
  OR entry->>'sha256' IS DISTINCT FROM NEW.storage_sha256 OR (entry->>'bytes')::bigint IS DISTINCT FROM NEW.storage_bytes OR entry->>'contentType' IS DISTINCT FROM NEW.storage_content_type
 THEN RAISE EXCEPTION 'Client file must pin its exact generated artifact and package facts' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_client_generated_file_check AFTER INSERT ON studio_client_delivery_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_client_generated_file_check();
CREATE TRIGGER studio_client_file_immutable BEFORE UPDATE OR DELETE ON studio_client_delivery_files FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();

CREATE TABLE studio_client_storage_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,share_id uuid NOT NULL,
 recipient_user_id uuid NOT NULL REFERENCES users(id),storage_version_id uuid NOT NULL,
 connection_id uuid NOT NULL,connection_revision integer NOT NULL CHECK(connection_revision>0),
 package_hash text NOT NULL CHECK(package_hash~'^[a-f0-9]{64}$'),token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '60 seconds'),
 FOREIGN KEY(company_id,project_id,share_id,storage_version_id) REFERENCES studio_client_delivery_files(company_id,project_id,share_id,file_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,connection_id) REFERENCES project_storage_connections(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(company_id,id)
);
CREATE INDEX studio_client_storage_grants_share ON studio_client_storage_grants(company_id,share_id,expires_at);
CREATE FUNCTION studio_client_storage_grant_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE share record; file record;
BEGIN
 SELECT recipient_user_id,package_hash,expires_at,status INTO share FROM studio_client_deliveries WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.share_id;
 SELECT storage_version_id INTO file FROM studio_client_delivery_files WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND share_id=NEW.share_id AND file_id=NEW.storage_version_id;
 IF share.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id OR share.package_hash IS DISTINCT FROM NEW.package_hash OR share.status IS DISTINCT FROM 'active'
  OR NEW.expires_at>share.expires_at OR file.storage_version_id IS DISTINCT FROM NEW.storage_version_id
 THEN RAISE EXCEPTION 'Client storage access must pin its exact active account grant and file' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER studio_client_storage_grant_check AFTER INSERT ON studio_client_storage_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_client_storage_grant_check();
CREATE TRIGGER studio_client_storage_grants_immutable BEFORE UPDATE OR DELETE ON studio_client_storage_grants FOR EACH ROW EXECUTE FUNCTION studio_generated_append_only();
