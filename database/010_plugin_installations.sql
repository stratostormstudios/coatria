-- Curated manifests and provider/model identifiers are public metadata. Provider
-- credentials stay on the operator's worker and are never accepted by this table.
ALTER TABLE agent_runs ADD COLUMN purpose text NOT NULL DEFAULT 'task' CHECK(purpose IN ('task','connection_test'));
CREATE TABLE plugin_installations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL, installed_by uuid NOT NULL REFERENCES users(id), client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 plugin_id text NOT NULL CHECK(length(plugin_id) BETWEEN 1 AND 80),
 manifest_version text NOT NULL CHECK(length(manifest_version) BETWEEN 1 AND 40),
 runtime_config jsonb NOT NULL CHECK(jsonb_typeof(runtime_config)='object'),
 character jsonb NOT NULL CHECK(jsonb_typeof(character)='object'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id), UNIQUE(company_id,agent_id), UNIQUE(company_id,installed_by,client_id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE
);
CREATE INDEX plugin_installations_company_idx ON plugin_installations(company_id,created_at DESC,id DESC);
