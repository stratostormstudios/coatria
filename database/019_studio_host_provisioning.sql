-- Reviewed CPU provisioning saga. Provider secrets never appear in receipts.
CREATE TABLE studio_host_provisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),plan_hash text NOT NULL CHECK(plan_hash~'^[a-f0-9]{64}$'),preset jsonb NOT NULL CHECK(jsonb_typeof(preset)='object'),
 phase text NOT NULL DEFAULT 'planned' CHECK(phase IN ('planned','approved','submitting','uncertain','provisioning','running','stopping','stopped','failed','needs_attention')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),host_id uuid,pod_id text UNIQUE,pod_name text NOT NULL UNIQUE,
 sealed_host_token jsonb,expected_environment_hashes jsonb,expires_at timestamptz,submitted_at timestamptz,stop_requested_at timestamptz,
 provider_status text,error_code text,last_reconciled_at timestamptz,lease_id uuid,lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,created_by,client_id),
 FOREIGN KEY(company_id,host_id) REFERENCES studio_managed_hosts(company_id,id)
);
CREATE UNIQUE INDEX studio_host_provisions_one_live_company ON studio_host_provisions(company_id) WHERE phase IN ('approved','submitting','uncertain','provisioning','running','stopping','needs_attention');
CREATE INDEX studio_host_provisions_reconcile ON studio_host_provisions(updated_at,id) WHERE phase IN ('approved','submitting','uncertain','provisioning','running','stopping','needs_attention');
CREATE TABLE studio_host_compute_reservations (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,provision_id uuid NOT NULL,
 amount_microusd bigint NOT NULL CHECK(amount_microusd>0),approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,provision_id),FOREIGN KEY(company_id,provision_id) REFERENCES studio_host_provisions(company_id,id)
);
CREATE TABLE studio_host_provision_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,
 provision_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('start','stop')),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,user_id,client_id),
 FOREIGN KEY(company_id,provision_id) REFERENCES studio_host_provisions(company_id,id)
);
