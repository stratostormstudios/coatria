-- Fixed trusted archive/gateway CPU services. No agent enrollment or general
-- infrastructure commands. Secrets remain in server environment/provider env.
CREATE TABLE trusted_service_provisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),
 service text NOT NULL CHECK(service IN ('archive','gateway')),created_by uuid NOT NULL REFERENCES users(id),
 client_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 preset jsonb NOT NULL CHECK(jsonb_typeof(preset)='object'),plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),plan_hash text NOT NULL CHECK(plan_hash~'^[a-f0-9]{64}$'),
 phase text NOT NULL DEFAULT 'planned' CHECK(phase IN ('planned','approved','submitting','uncertain','provisioning','running','stopping','stopped','failed','needs_attention')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),pod_name text NOT NULL UNIQUE,pod_id text UNIQUE,
 expected_environment_hashes jsonb,expires_at timestamptz NOT NULL,submitted_at timestamptz,stop_requested_at timestamptz,
 lease_id uuid,lease_expires_at timestamptz,provider_status text,error_code text,last_reconciled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),UNIQUE(company_id,created_by,client_id),CHECK((lease_id IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX trusted_services_one_active ON trusted_service_provisions(company_id,service) WHERE phase IN ('approved','submitting','uncertain','provisioning','running','stopping','needs_attention');
CREATE INDEX trusted_services_reconcile ON trusted_service_provisions(last_reconciled_at,id) WHERE phase IN ('approved','submitting','uncertain','provisioning','running','stopping','needs_attention');
CREATE TABLE trusted_service_reservations (
 company_id uuid NOT NULL,provision_id uuid NOT NULL,service text NOT NULL CHECK(service IN ('archive','gateway')),
 amount_microusd bigint NOT NULL CHECK(amount_microusd>0),approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,provision_id),FOREIGN KEY(company_id,provision_id) REFERENCES trusted_service_provisions(company_id,id)
);
CREATE TABLE trusted_service_requests (
 company_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,provision_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('start','stop')),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,user_id,client_id),FOREIGN KEY(company_id,provision_id) REFERENCES trusted_service_provisions(company_id,id)
);
