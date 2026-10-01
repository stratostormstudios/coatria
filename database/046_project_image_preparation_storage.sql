-- M3 records one derivative allocation and one finite multipart write. It does
-- not qualify a processor, enable a worker, or create any runtime permission.
CREATE TABLE project_image_preparation_allocations (
 company_id uuid NOT NULL, project_id uuid NOT NULL, preparation_id uuid NOT NULL,
 file_id uuid NOT NULL, version_id uuid NOT NULL, upload_id uuid NOT NULL,
 binding_revision_before integer NOT NULL CHECK(binding_revision_before>0),
 binding_revision_after integer NOT NULL CHECK(binding_revision_after::bigint=binding_revision_before::bigint+1),
 output_sha256 text NOT NULL CHECK(output_sha256~'^[a-f0-9]{64}$'),
 output_bytes bigint NOT NULL CHECK(output_bytes BETWEEN 1 AND 10485760),
 store_action_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,preparation_id), UNIQUE(company_id,project_id,preparation_id),
 UNIQUE(company_id,file_id), UNIQUE(company_id,version_id), UNIQUE(company_id,upload_id), UNIQUE(company_id,store_action_id),
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparations(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,preparation_id) REFERENCES project_image_preparation_approvals(company_id,project_id,preparation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,file_id) REFERENCES project_storage_files(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,upload_id,version_id) REFERENCES project_storage_uploads(company_id,project_id,id,version_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER project_image_preparation_allocation_immutable BEFORE UPDATE ON project_image_preparation_allocations FOR EACH ROW EXECUTE FUNCTION guard_project_image_preparation_immutable();
ALTER TABLE project_image_preparation_allocations ENABLE ALWAYS TRIGGER project_image_preparation_allocation_immutable;
-- As in 045, owner-controlled company cascades remain possible; no DELETE grant
-- or preparation access is created for an existing human or agent role.

CREATE FUNCTION validate_project_image_preparation_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM project_image_preparations p
  JOIN project_image_preparation_approvals a ON (a.company_id,a.project_id,a.preparation_id)=(p.company_id,p.project_id,p.id)
  JOIN memberships m ON m.company_id=a.company_id AND m.user_id=a.approved_by
  JOIN project_storage_bindings b ON (b.company_id,b.project_id,b.id)=(p.company_id,p.project_id,p.storage_binding_id)
  JOIN project_storage_connections c ON (c.company_id,c.id)=(b.company_id,b.connection_id)
  JOIN project_storage_versions v ON (v.company_id,v.project_id,v.id)=(p.company_id,p.project_id,NEW.version_id)
  JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)
  JOIN project_storage_uploads u ON (u.company_id,u.project_id,u.id,u.version_id)=(v.company_id,v.project_id,NEW.upload_id,v.id)
  WHERE (p.company_id,p.project_id,p.id)=(NEW.company_id,NEW.project_id,NEW.preparation_id)
   AND p.status='validating' AND p.revoked_at IS NULL AND p.lease_id IS NOT NULL AND p.lease_expires_at>clock_timestamp()
   AND a.expires_at>clock_timestamp() AND a.processing_consent AND a.derivative_write_consent AND a.adoption_consent
   AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL
   AND a.approver_snapshot->>'userId'=m.user_id::text AND a.approver_snapshot->>'role'=m.role
   AND (a.approver_snapshot->>'joinedAt')::timestamptz=m.joined_at
   AND p.transform_result->'processor'=a.processor_snapshot AND p.transform_result->>'recipeSha256'=p.recipe_sha256
   AND p.transform_result#>>'{output,sha256}'=NEW.output_sha256 AND p.transform_result#>>'{output,bytes}'=NEW.output_bytes::text
   AND p.storage_binding_revision=NEW.binding_revision_before AND b.revision=NEW.binding_revision_after
   AND c.id=p.storage_connection_id AND c.revision=p.storage_connection_revision AND c.created_by=p.storage_sponsor_id AND c.status='configured'
   AND v.id<>p.source_version_id AND v.file_id=NEW.file_id AND v.file_id::text<>p.source_snapshot->>'fileId'
   AND v.version=1 AND v.content_type='image/png' AND v.sha256=NEW.output_sha256 AND v.bytes=NEW.output_bytes
   AND f.binding_id=p.storage_binding_id AND f.parent_id IS NOT DISTINCT FROM p.destination_folder_id AND f.name=p.destination_name
   AND f.created_by=a.approved_by AND f.created_agent_id IS NULL AND f.run_id IS NULL
   AND v.created_by=a.approved_by AND v.created_agent_id IS NULL AND v.run_id IS NULL
   AND u.status='allocated' AND u.archive_id IS NULL AND u.actor_key='preparation:'||p.id::text
   AND u.actor_user_id=a.approved_by AND u.actor_agent_id IS NULL AND u.run_id IS NULL
   AND u.client_id=p.id AND u.request_hash=p.request_hash
   AND u.part_bytes=67108864 AND u.provider_upload_id IS NULL AND u.provider_descriptor IS NULL AND u.provider_etag IS NULL
   AND u.verification_grant_id IS NULL AND u.active_part IS NULL AND u.action_id IS NULL AND u.action_expires_at IS NULL
   AND u.expires_at>clock_timestamp() AND u.expires_at<=p.lease_expires_at AND u.expires_at<=a.expires_at
   AND NOT EXISTS(SELECT 1 FROM project_storage_versions other WHERE other.company_id=v.company_id AND other.file_id=v.file_id AND other.id<>v.id)
   AND NOT EXISTS(SELECT 1 FROM project_storage_upload_parts part WHERE part.company_id=u.company_id AND part.upload_id=u.id)
   AND NOT EXISTS(SELECT 1 FROM project_storage_verifications ok WHERE ok.company_id=v.company_id AND ok.version_id=v.id)
   AND EXISTS(SELECT 1 FROM project_image_preparation_receipts intent WHERE intent.company_id=p.company_id AND intent.project_id=p.project_id AND intent.preparation_id=p.id
    AND intent.action_id=NEW.store_action_id AND intent.operation='store' AND intent.phase='intent')
 ) THEN RAISE EXCEPTION 'Preparation allocation requires its exact approved new derivative and one binding revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_allocation_guard BEFORE INSERT ON project_image_preparation_allocations FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_allocation();

ALTER TABLE project_image_preparation_receipts DROP CONSTRAINT project_image_preparation_receipts_operation_check;
ALTER TABLE project_image_preparation_receipts ADD CONSTRAINT project_image_preparation_receipts_operation_check
 CHECK(operation IN ('claim','approve','revoke','read','transform','validate','allocation','store','store_initiate','store_part','store_complete','verify','publish','cleanup'));
CREATE UNIQUE INDEX project_image_preparation_multipart_intent_once ON project_image_preparation_receipts(company_id,preparation_id,operation)
 WHERE phase='intent' AND operation IN ('store_initiate','store_part','store_complete');
CREATE FUNCTION validate_project_image_preparation_multipart_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.operation IN ('store_initiate','store_part','store_complete') AND NEW.phase='returned' AND NOT EXISTS(
  SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND preparation_id=NEW.preparation_id
   AND action_id=NEW.action_id AND operation=NEW.operation AND phase='intent'
 ) THEN RAISE EXCEPTION 'Preparation multipart result requires its exact prior intent' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_multipart_receipt_guard BEFORE INSERT ON project_image_preparation_receipts FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_multipart_receipt();

-- Preparation outputs are at most 10 MiB and use one 64 MiB-capacity part.
-- Other project uploads retain their existing multipart behavior.
CREATE FUNCTION validate_project_image_preparation_upload_part() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM project_image_preparation_allocations WHERE company_id=NEW.company_id AND upload_id=NEW.upload_id)
  AND NOT EXISTS(SELECT 1 FROM project_image_preparation_allocations WHERE company_id=NEW.company_id AND upload_id=NEW.upload_id
   AND NEW.part_number=1 AND output_bytes=NEW.bytes AND output_sha256=NEW.sha256)
 THEN RAISE EXCEPTION 'Preparation upload requires its one exact output part' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_upload_part_guard BEFORE INSERT ON project_storage_upload_parts FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_upload_part();

-- Additive guard: every existing 045 derivation check still runs unchanged.
CREATE FUNCTION validate_project_image_preparation_derivation_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM project_image_preparation_allocations a
  WHERE (a.company_id,a.project_id,a.preparation_id)=(NEW.company_id,NEW.project_id,NEW.preparation_id)
   AND a.file_id=NEW.output_file_id AND a.version_id=NEW.output_version_id AND a.upload_id=NEW.upload_id
   AND a.output_sha256=NEW.output_sha256 AND a.output_bytes=NEW.output_bytes
 ) THEN RAISE EXCEPTION 'Preparation derivation requires its exact immutable allocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_image_preparation_derivation_allocation_guard BEFORE INSERT ON project_image_preparation_derivations FOR EACH ROW EXECUTE FUNCTION validate_project_image_preparation_derivation_allocation();
