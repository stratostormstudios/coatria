-- Account-bound access to an exact approved private-media package. A share UUID
-- is a locator, never a bearer credential. No email is sent by this migration.
CREATE TABLE studio_client_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,delivery_id uuid NOT NULL,
 recipient_user_id uuid NOT NULL REFERENCES users(id),recipient_name text NOT NULL,
 identity_basis text NOT NULL CHECK(identity_basis='account_confirmed_out_of_band'),email_verified_at_creation boolean NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),expires_at timestamptz NOT NULL,revoked_at timestamptz,
 source_manifest_hash text NOT NULL CHECK(source_manifest_hash~'^[0-9a-f]{64}$'),package_hash text NOT NULL CHECK(package_hash~'^[0-9a-f]{64}$'),
 package_snapshot jsonb NOT NULL CHECK(jsonb_typeof(package_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(company_id,project_id,id),UNIQUE(company_id,id),
 CHECK(recipient_user_id<>created_by),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 FOREIGN KEY(company_id,project_id,delivery_id) REFERENCES studio_deliveries(company_id,project_id,id) ON DELETE CASCADE
);
CREATE INDEX studio_client_deliveries_project ON studio_client_deliveries(company_id,project_id,id);
CREATE INDEX studio_client_deliveries_recipient ON studio_client_deliveries(recipient_user_id,id);
CREATE TABLE studio_client_delivery_files (
 company_id uuid NOT NULL,project_id uuid NOT NULL,share_id uuid NOT NULL,file_id uuid NOT NULL,artifact_id uuid NOT NULL,
 PRIMARY KEY(company_id,share_id,file_id),
 FOREIGN KEY(company_id,project_id,share_id) REFERENCES studio_client_deliveries(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,file_id) REFERENCES studio_media_files(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,project_id,artifact_id) REFERENCES studio_artifacts(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_client_delivery_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,share_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN ('portal_opened','download_access_issued','acknowledged','changes_requested','revoked')),
 file_id uuid,note text,package_hash text NOT NULL CHECK(package_hash~'^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,share_id,id),FOREIGN KEY(company_id,share_id) REFERENCES studio_client_deliveries(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,share_id,file_id) REFERENCES studio_client_delivery_files(company_id,share_id,file_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='download_access_issued')=(file_id IS NOT NULL)),CHECK(note IS NULL OR length(note) BETWEEN 1 AND 4000)
);
CREATE UNIQUE INDEX studio_client_delivery_one_response ON studio_client_delivery_receipts(company_id,share_id) WHERE kind IN ('acknowledged','changes_requested');
CREATE INDEX studio_client_delivery_receipts_page ON studio_client_delivery_receipts(company_id,share_id,id);
CREATE TABLE studio_client_delivery_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_user_id uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,actor_user_id,client_id)
);
