-- A completed provider job does not authorize storage writes. These immutable
-- proposals acquire separate, finite human archive authority on approval.
-- PostgreSQL row locks require UPDATE on some column. This inert timestamp lets
-- the archive worker fence role rows without permission to reassign any role.
ALTER TABLE studio_role_bindings ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TABLE higgsfield_output_archives (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,
 request_id uuid NOT NULL,job_id uuid NOT NULL,output_id uuid NOT NULL,locator_identity text NOT NULL CHECK(locator_identity~'^[a-f0-9]{64}$'),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),provider_connection_id uuid NOT NULL,provider_connection_revision integer NOT NULL CHECK(provider_connection_revision>0),
 storage_binding_id uuid NOT NULL,storage_binding_revision integer NOT NULL CHECK(storage_binding_revision>0),storage_connection_id uuid NOT NULL,storage_connection_revision integer NOT NULL CHECK(storage_connection_revision>0),storage_connection_snapshot jsonb NOT NULL CHECK(jsonb_typeof(storage_connection_snapshot)='object'),
 destination_parent_id uuid,destination_file_id uuid,destination_name text NOT NULL,destination_name_key text NOT NULL,destination_ancestors jsonb NOT NULL CHECK(jsonb_typeof(destination_ancestors)='array' AND jsonb_array_length(destination_ancestors)<=12),
 max_bytes bigint NOT NULL CHECK(max_bytes>0 AND max_bytes<=107374182400),project_revision integer NOT NULL CHECK(project_revision>0),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 proposed_by uuid NOT NULL REFERENCES users(id),proposed_agent_id uuid,proposed_run_id uuid,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','queued','fetching','uploading','verifying','verified','uncertain','blocked','cancelled','failed')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 approved_by uuid REFERENCES users(id),approved_at timestamptz,expires_at timestamptz,approved_project_revision integer,approved_binding_revision integer,
 revoked_by uuid REFERENCES users(id),revoked_at timestamptz,
 lease_id uuid,lease_expires_at timestamptz,attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
 upload_id uuid,version_id uuid,diagnostic_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,id),
 CHECK((proposed_agent_id IS NULL)=(proposed_run_id IS NULL)),CHECK((lease_id IS NULL)=(lease_expires_at IS NULL)),CHECK((upload_id IS NULL)=(version_id IS NULL)),
 CHECK((approved_by IS NULL)=(approved_at IS NULL) AND (approved_by IS NULL)=(expires_at IS NULL) AND (approved_by IS NULL)=(approved_project_revision IS NULL) AND (approved_by IS NULL)=(approved_binding_revision IS NULL)),
 CHECK(expires_at IS NULL OR (expires_at>approved_at AND expires_at<=approved_at+interval '24 hours')),
 CHECK((revoked_by IS NULL)=(revoked_at IS NULL)),
 FOREIGN KEY(company_id,project_id,request_id) REFERENCES higgsfield_job_receipts(company_id,project_id,request_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES higgsfield_jobs(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,output_id) REFERENCES higgsfield_job_outputs(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,storage_binding_id) REFERENCES project_storage_bindings(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,storage_connection_id) REFERENCES project_storage_connections(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,destination_parent_id) REFERENCES project_storage_folders(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,destination_file_id) REFERENCES project_storage_files(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,proposed_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,proposed_run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,upload_id,version_id) REFERENCES project_storage_uploads(company_id,project_id,id,version_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX higgsfield_archives_due ON higgsfield_output_archives(status,lease_expires_at,id) WHERE status IN ('queued','fetching','uploading','verifying');
CREATE TABLE higgsfield_archive_fetches (
 company_id uuid NOT NULL,project_id uuid NOT NULL,archive_id uuid NOT NULL,locator_identity text NOT NULL CHECK(locator_identity~'^[a-f0-9]{64}$'),
 bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=107374182400),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),media jsonb NOT NULL CHECK(jsonb_typeof(media)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,archive_id),FOREIGN KEY(company_id,project_id,archive_id) REFERENCES higgsfield_output_archives(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE higgsfield_archive_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,archive_id uuid NOT NULL,action_id uuid NOT NULL,
 operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 80),phase text NOT NULL CHECK(phase IN ('intent','returned','uncertain','blocked','cancelled','failed')),
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,archive_id,action_id,phase),FOREIGN KEY(company_id,project_id,archive_id) REFERENCES higgsfield_output_archives(company_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE higgsfield_archive_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,actor_key,client_id)
);
ALTER TABLE project_storage_uploads ADD COLUMN archive_id uuid,
 ADD CONSTRAINT project_storage_upload_archive_fk FOREIGN KEY(company_id,project_id,archive_id) REFERENCES higgsfield_output_archives(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT project_storage_upload_archive_actor CHECK((archive_id IS NULL AND actor_key NOT LIKE 'archive:%') OR (archive_id IS NOT NULL AND actor_key='archive:'||archive_id::text AND actor_agent_id IS NULL AND run_id IS NULL));
CREATE UNIQUE INDEX project_storage_upload_archive_once ON project_storage_uploads(company_id,archive_id) WHERE archive_id IS NOT NULL;
