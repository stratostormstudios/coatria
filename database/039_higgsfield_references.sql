-- An exact prepared proxy is not an original and inspection is not permission
-- to share it. Reference transfer authority is a separate finite human approval.
ALTER TABLE higgsfield_requests ADD COLUMN reference_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN reference_snapshot jsonb,
 ADD CONSTRAINT higgsfield_request_references_shape CHECK(cardinality(reference_ids)<=8 AND array_position(reference_ids,NULL) IS NULL AND ((cardinality(reference_ids)=0 AND reference_snapshot IS NULL) OR (cardinality(reference_ids)>0 AND reference_snapshot IS NOT NULL AND jsonb_typeof(reference_snapshot)='object')));
CREATE TABLE higgsfield_references (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,
 project_revision integer NOT NULL CHECK(project_revision>0),project_snapshot jsonb NOT NULL CHECK(jsonb_typeof(project_snapshot)='object'),project_sha256 text NOT NULL CHECK(project_sha256~'^[a-f0-9]{64}$'),work_snapshot jsonb NOT NULL CHECK(jsonb_typeof(work_snapshot)='object'),
 proxy_version_id uuid NOT NULL,source_version_id uuid,proxy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(proxy_snapshot)='object'),source_snapshot jsonb CHECK(source_snapshot IS NULL OR jsonb_typeof(source_snapshot)='object'),
 storage_binding_id uuid NOT NULL,storage_binding_revision integer NOT NULL CHECK(storage_binding_revision>0),storage_connection_id uuid NOT NULL,storage_connection_revision integer NOT NULL CHECK(storage_connection_revision>0),storage_sponsor_id uuid NOT NULL REFERENCES users(id),
 provider_connection_id uuid NOT NULL,provider_connection_revision integer NOT NULL CHECK(provider_connection_revision>0),provider_sponsor_id uuid NOT NULL REFERENCES users(id),catalog_sha256 text NOT NULL CHECK(catalog_sha256~'^[a-f0-9]{64}$'),
 role text NOT NULL CHECK(role IN ('image','start_image','end_image')),purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 1000),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 proposed_by uuid NOT NULL REFERENCES users(id),proposed_agent_id uuid,proposed_run_id uuid,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','inspecting','awaiting_approval','queued','reading','allocating','allocated','uploading','uploaded','confirming','confirmed','uncertain','blocked','failed','revoked')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 inspect_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
 approved_by uuid REFERENCES users(id),approved_at timestamptz,expires_at timestamptz,approval_hash text CHECK(approval_hash~'^[a-f0-9]{64}$'),qualification_sha256 text CHECK(qualification_sha256~'^[a-f0-9]{64}$'),
 revoked_by uuid REFERENCES users(id),revoked_at timestamptz,lease_id uuid,lease_expires_at timestamptz,action_id uuid,action_operation text CHECK(action_operation IN ('allocate','put','confirm')),diagnostic_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,project_id,id),
 CHECK((source_version_id IS NULL)=(source_snapshot IS NULL)),CHECK(source_version_id IS NULL OR source_version_id<>proxy_version_id),
 CHECK((proposed_agent_id IS NULL)=(proposed_run_id IS NULL)),CHECK((lease_id IS NULL)=(lease_expires_at IS NULL)),CHECK((action_id IS NULL)=(action_operation IS NULL)),
 CHECK((approved_by IS NULL)=(approved_at IS NULL) AND (approved_by IS NULL)=(expires_at IS NULL) AND (approved_by IS NULL)=(approval_hash IS NULL) AND (approved_by IS NULL)=(qualification_sha256 IS NULL)),
 CHECK(expires_at IS NULL OR (expires_at>approved_at AND expires_at<=approved_at+interval '60 minutes')),CHECK((revoked_by IS NULL)=(revoked_at IS NULL)),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,proxy_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,source_version_id) REFERENCES project_storage_versions(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,storage_binding_id) REFERENCES project_storage_bindings(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,storage_connection_id) REFERENCES project_storage_connections(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,proposed_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,proposed_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX higgsfield_references_due ON higgsfield_references(status,lease_expires_at,id) WHERE status IN ('proposed','inspecting','queued','reading','allocating','allocated','uploading','uploaded','confirming');
CREATE TABLE higgsfield_reference_inspections (
 company_id uuid NOT NULL,project_id uuid NOT NULL,reference_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),profile_sha256 text NOT NULL CHECK(profile_sha256~'^[a-f0-9]{64}$'),inspection_hash text NOT NULL CHECK(inspection_hash~'^[a-f0-9]{64}$'),descriptor jsonb NOT NULL CHECK(jsonb_typeof(descriptor)='object'),inspected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,reference_id),FOREIGN KEY(company_id,project_id,reference_id) REFERENCES higgsfield_references(company_id,project_id,id) ON DELETE CASCADE
);
-- Only the server broker may decrypt this narrowly scoped transport capability.
CREATE TABLE higgsfield_reference_transports (
 company_id uuid NOT NULL,project_id uuid NOT NULL,reference_id uuid NOT NULL,media_id uuid NOT NULL,sealed jsonb NOT NULL CHECK(jsonb_typeof(sealed)='object'),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,reference_id),UNIQUE(company_id,media_id),FOREIGN KEY(company_id,project_id,reference_id) REFERENCES higgsfield_references(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE higgsfield_reference_confirmations (
 company_id uuid NOT NULL,project_id uuid NOT NULL,reference_id uuid NOT NULL,media_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),approval_hash text NOT NULL CHECK(approval_hash~'^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,reference_id),UNIQUE(company_id,media_id),FOREIGN KEY(company_id,project_id,reference_id) REFERENCES higgsfield_references(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE higgsfield_reference_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,reference_id uuid NOT NULL,action_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('inspect','approve','revoke','allocate','put','confirm','claim')),phase text NOT NULL CHECK(phase IN ('intent','returned','uncertain','blocked','failed','revoked')),
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,reference_id,action_id,phase),FOREIGN KEY(company_id,project_id,reference_id) REFERENCES higgsfield_references(company_id,project_id,id) ON DELETE CASCADE
);
-- A phase may never acquire a second provider-changing intent, even after lease loss.
CREATE UNIQUE INDEX higgsfield_reference_phase_once ON higgsfield_reference_receipts(company_id,reference_id,operation) WHERE phase='intent' AND operation IN ('allocate','put','confirm');
CREATE TABLE higgsfield_reference_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,actor_key,client_id)
);
