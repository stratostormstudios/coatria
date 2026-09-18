-- Official-Higgsfield observations and external storage metadata only.
-- No provider credentials, executable instructions, media bytes or signed URLs.
CREATE TABLE studio_storage_references (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid,
 drive_id uuid NOT NULL,drive_name text NOT NULL,path text NOT NULL,bytes bigint NOT NULL CHECK(bytes>=0 AND bytes<=9007199254740991),modified_at timestamptz NOT NULL,indexed_at timestamptz NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),purpose text NOT NULL CHECK(purpose IN ('source','reference','output','archive')),
 created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,drive_id) REFERENCES drives(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX studio_storage_references_page ON studio_storage_references(company_id,project_id,id);
CREATE TABLE studio_generations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid,
 provider text NOT NULL DEFAULT 'higgsfield' CHECK(provider='higgsfield'),provider_job_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('image','video','audio','3d')),model text NOT NULL CHECK(length(model) BETWEEN 1 AND 160),prompt text NOT NULL CHECK(length(prompt)<=12000),reference_bindings jsonb NOT NULL CHECK(jsonb_typeof(reference_bindings)='array'),identity_hash text NOT NULL CHECK(identity_hash~'^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,provider_job_id),UNIQUE(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,project_id,work_item_id) REFERENCES studio_work_items(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX studio_generations_page ON studio_generations(company_id,project_id,id);
CREATE TABLE studio_generation_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,generation_id uuid NOT NULL,
 source_tool text NOT NULL CHECK(source_tool IN ('generate_image','generate_image_batch','generate_video','generate_video_batch','generate_audio','generate_audio_batch','execute_preset','jobs_wait','job_display')),
 observed_status text NOT NULL CHECK(observed_status IN ('pending','waiting','queued','dna','script','visuals','vision','flow','in_progress','ip_detect','completed','canceled','failed','nsfw','ip_detected','lookup_failed')),
 observed_at timestamptz NOT NULL,outputs jsonb NOT NULL CHECK(jsonb_typeof(outputs)='array'),note text NOT NULL CHECK(length(note)<=2000),
 evidence_source text NOT NULL DEFAULT 'imported_report' CHECK(evidence_source='imported_report'),
 imported_by uuid NOT NULL REFERENCES users(id),imported_agent_id uuid,run_id uuid,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,project_id,id),
 FOREIGN KEY(company_id,project_id,generation_id) REFERENCES studio_generations(company_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,imported_agent_id) REFERENCES agents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX studio_generation_receipts_history ON studio_generation_receipts(company_id,generation_id,received_at,id);
CREATE TABLE studio_creative_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_key text NOT NULL,client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,actor_key,client_id)
);
