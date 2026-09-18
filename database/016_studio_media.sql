-- Immutable expected files and independent server-byte verification receipts.
CREATE TABLE studio_media_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL,
 output_path text NOT NULL,kind text NOT NULL CHECK(kind IN ('image','scene','cache','media','report')),frame integer,
 sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=20971520),
 blob_pathname text NOT NULL UNIQUE,content_type text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,job_id,id),UNIQUE(company_id,job_id,output_path),
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES studio_execution_jobs(company_id,project_id,id) ON DELETE CASCADE
);
CREATE INDEX studio_media_files_job ON studio_media_files(company_id,job_id,id);
CREATE TABLE studio_media_verifications (
 company_id uuid NOT NULL,file_id uuid NOT NULL,etag text NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
 bytes bigint NOT NULL,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,file_id),
 FOREIGN KEY(company_id,file_id) REFERENCES studio_media_files(company_id,id) ON DELETE CASCADE
);
CREATE TABLE studio_media_promotions (
 company_id uuid NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL,artifact_id uuid NOT NULL,
 manifest_text text NOT NULL,manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[0-9a-f]{64}$'),
 promoted_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,job_id),
 FOREIGN KEY(company_id,project_id,job_id) REFERENCES studio_execution_jobs(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,artifact_id) REFERENCES studio_artifacts(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE studio_media_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,actor_key,client_id)
);
