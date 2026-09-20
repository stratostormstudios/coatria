-- Project storage is separate from replaceable, metadata-only drive indices.
CREATE TABLE IF NOT EXISTS project_storage_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 name text NOT NULL,provider text NOT NULL DEFAULT 'runpod' CHECK(provider='runpod'),region text NOT NULL CHECK(region IN ('EU-CZ-1','EU-RO-1','EUR-IS-1','EUR-NO-1','US-CA-2','US-GA-2','US-IL-1','US-KS-2','US-MD-1','US-MO-1','US-MO-2','US-NC-1','US-NC-2','US-NE-1','US-WA-1')),
 volume_id text NOT NULL,secret_envelope jsonb,status text NOT NULL DEFAULT 'configured' CHECK(status IN ('configured','revoked')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),CHECK((status='configured')=(secret_envelope IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS project_storage_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,connection_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,FOREIGN KEY(company_id,connection_id) REFERENCES project_storage_connections(company_id,id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(company_id,project_id),UNIQUE(company_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS project_storage_folders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,binding_id uuid NOT NULL,parent_id uuid,name text NOT NULL,name_key text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,project_id,binding_id) REFERENCES project_storage_bindings(company_id,project_id,id) ON DELETE CASCADE,UNIQUE(company_id,project_id,id),FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,parent_id) REFERENCES project_storage_folders(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_storage_folder_name ON project_storage_folders(company_id,project_id,COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),name_key);
CREATE TABLE IF NOT EXISTS project_storage_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,binding_id uuid NOT NULL,parent_id uuid,name text NOT NULL,name_key text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,project_id,binding_id) REFERENCES project_storage_bindings(company_id,project_id,id) ON DELETE CASCADE,FOREIGN KEY(company_id,project_id,parent_id) REFERENCES project_storage_folders(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(company_id,project_id,id),FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS project_storage_file_name ON project_storage_files(company_id,project_id,COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),name_key);
-- Insert-only versions: a display path never chooses a physical object key.
CREATE TABLE IF NOT EXISTS project_storage_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,file_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=107374182400),sha256 text CHECK(sha256~'^[a-f0-9]{64}$'),content_type text NOT NULL,object_key text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,project_id,file_id) REFERENCES project_storage_files(company_id,project_id,id) ON DELETE CASCADE,UNIQUE(company_id,project_id,id),UNIQUE(company_id,file_id,version),UNIQUE(company_id,object_key),CHECK(object_key='coatria/companies/'||company_id::text||'/projects/'||project_id::text||'/objects/'||id::text),FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS project_storage_uploads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,version_id uuid NOT NULL,actor_key text NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),actor_agent_id uuid,run_id uuid,client_id uuid NOT NULL,request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'allocated' CHECK(status IN ('allocated','initiating','uploading','completing','verifying','ready','cancelled','failed','uncertain')),provider_upload_id text,provider_descriptor jsonb,part_bytes integer NOT NULL CHECK(part_bytes>=5242880 AND part_bytes<=500000000),provider_etag text,verification_grant_id uuid,active_part integer CHECK(active_part BETWEEN 1 AND 10000),action_id uuid,action_expires_at timestamptz,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,project_id,version_id) REFERENCES project_storage_versions(company_id,project_id,id) ON DELETE CASCADE,UNIQUE(company_id,version_id),UNIQUE(company_id,actor_key,client_id),UNIQUE(company_id,id),UNIQUE(company_id,project_id,id,version_id),FOREIGN KEY(company_id,actor_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS project_storage_upload_parts (
 company_id uuid NOT NULL,upload_id uuid NOT NULL,part_number integer NOT NULL CHECK(part_number BETWEEN 1 AND 10000),bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=500000000),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),provider_etag text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,upload_id,part_number),FOREIGN KEY(company_id,upload_id) REFERENCES project_storage_uploads(company_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS project_storage_verifications (
 company_id uuid NOT NULL,project_id uuid NOT NULL,version_id uuid NOT NULL,bytes bigint NOT NULL CHECK(bytes>0),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),provider_etag text NOT NULL,gateway_receipt_id uuid NOT NULL,verified_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,version_id),FOREIGN KEY(company_id,project_id,version_id) REFERENCES project_storage_versions(company_id,project_id,id) ON DELETE CASCADE,UNIQUE(company_id,gateway_receipt_id)
);
CREATE TABLE IF NOT EXISTS project_storage_folder_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,binding_id uuid NOT NULL,binding_revision integer NOT NULL,plan_hash text NOT NULL,folders jsonb NOT NULL CHECK(jsonb_typeof(folders)='array' AND jsonb_array_length(folders)<=200),created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 FOREIGN KEY(company_id,project_id,binding_id) REFERENCES project_storage_bindings(company_id,project_id,id) ON DELETE CASCADE,UNIQUE(company_id,project_id,id),FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS project_storage_plan_applications (
 company_id uuid NOT NULL,project_id uuid NOT NULL,plan_id uuid NOT NULL,applied_by uuid NOT NULL REFERENCES users(id),applied_agent_id uuid,run_id uuid,applied_at timestamptz NOT NULL DEFAULT now(),result jsonb NOT NULL,PRIMARY KEY(company_id,plan_id),FOREIGN KEY(company_id,project_id,plan_id) REFERENCES project_storage_folder_plans(company_id,project_id,id) ON DELETE CASCADE,FOREIGN KEY(company_id,applied_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS project_storage_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,actor_key,client_id)
);
CREATE TABLE IF NOT EXISTS project_storage_access_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,version_id uuid NOT NULL,actor_key text NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id),agent_id uuid,run_id uuid,
 agent_token_hash text CHECK(agent_token_hash~'^[a-f0-9]{64}$'),agent_lease_hash text CHECK(agent_lease_hash~'^[a-f0-9]{64}$'),
 connection_id uuid NOT NULL,connection_revision integer NOT NULL CHECK(connection_revision>0),upload_id uuid,
 token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),operation text NOT NULL CHECK(operation IN ('read','upload')),
 gateway_grant_id uuid NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT project_storage_access_agent_lease CHECK((agent_id IS NULL)=(agent_token_hash IS NULL) AND (agent_id IS NULL)=(agent_lease_hash IS NULL) AND (agent_id IS NULL)=(run_id IS NULL)),
 FOREIGN KEY(company_id,project_id,version_id) REFERENCES project_storage_versions(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,connection_id) REFERENCES project_storage_connections(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,upload_id,version_id) REFERENCES project_storage_uploads(company_id,project_id,id,version_id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(company_id,gateway_grant_id),CHECK((operation='upload')=(upload_id IS NOT NULL)),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_capabilities_check;
ALTER TABLE agents ADD CONSTRAINT agents_capabilities_check CHECK(jsonb_typeof(capabilities)='array' AND capabilities <@ '["workspace.read","tasks.write","infrastructure.read","hiring.read","office.write","layout.propose","rooms.propose","hiring.propose","studio.read","studio.write","studio.execute","studio.review","creative.read","creative.write","storage.read","storage.write","storage.organize"]'::jsonb);
