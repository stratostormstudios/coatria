-- Pilot host identity and encrypted per-agent enrollment. No provider secrets.
ALTER TABLE agents ADD COLUMN managed_token_hash text CHECK(managed_token_hash IS NULL OR managed_token_hash~'^[a-f0-9]{64}$');
CREATE TABLE studio_managed_hosts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,request_hash text NOT NULL CHECK(length(request_hash)=64),token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),max_agents integer NOT NULL CHECK(max_agents BETWEEN 1 AND 11),provider_ids jsonb NOT NULL CHECK(jsonb_typeof(provider_ids)='array'),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_seen_at timestamptz,
 lease_owner uuid,lease_epoch integer NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),lease_expires_at timestamptz,revoked_at timestamptz,
 UNIQUE(company_id,id),UNIQUE(company_id,created_by,client_id)
);
CREATE TABLE studio_host_credentials (
 company_id uuid NOT NULL,agent_id uuid NOT NULL,host_id uuid NOT NULL,installation_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),installation_revision integer NOT NULL CHECK(installation_revision>0),host_epoch integer NOT NULL CHECK(host_epoch>=0),
 token_hash text NOT NULL CHECK(length(token_hash)=64),key_id text NOT NULL,nonce text NOT NULL,auth_tag text NOT NULL,ciphertext text NOT NULL,
 configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),configuration_hash text NOT NULL CHECK(length(configuration_hash)=64),
 enrolled_by uuid NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,
 PRIMARY KEY(company_id,agent_id),
 FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,host_id) REFERENCES studio_managed_hosts(company_id,id),
 FOREIGN KEY(company_id,installation_id) REFERENCES plugin_installations(company_id,id) ON DELETE CASCADE
);
CREATE INDEX studio_host_credentials_host ON studio_host_credentials(company_id,host_id,agent_id);
CREATE TABLE studio_host_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,
 host_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('enroll','revoke')),request_hash text NOT NULL CHECK(length(request_hash)=64),response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,user_id,client_id),
 FOREIGN KEY(company_id,host_id) REFERENCES studio_managed_hosts(company_id,id)
);
