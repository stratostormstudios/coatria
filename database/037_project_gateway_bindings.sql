-- Verification epochs are immutable. Revoked rows remain to prevent fallback
-- to the legacy global gateway after a project has used managed routing.
CREATE TABLE project_gateway_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,
 provision_id uuid NOT NULL,configuration_hash text NOT NULL CHECK(configuration_hash~'^[a-f0-9]{64}$'),
 origin text NOT NULL CHECK(origin~'^https://[a-z0-9-]+-4190\.proxy\.runpod\.net$'),
 verified_by uuid NOT NULL REFERENCES users(id),verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 FOREIGN KEY(company_id,project_id) REFERENCES studio_projects(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,provision_id) REFERENCES trusted_service_provisions(company_id,id),
 UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,id,provision_id),CHECK(expires_at>verified_at)
);
CREATE UNIQUE INDEX project_gateway_binding_active ON project_gateway_bindings(company_id,project_id) WHERE revoked_at IS NULL;
ALTER TABLE project_storage_access_receipts ADD COLUMN service_binding_id uuid,ADD COLUMN service_provision_id uuid;
ALTER TABLE project_storage_access_receipts ADD CONSTRAINT storage_receipt_gateway_epoch CHECK((service_binding_id IS NULL)=(service_provision_id IS NULL));
ALTER TABLE project_storage_access_receipts ADD CONSTRAINT storage_receipt_gateway_binding FOREIGN KEY(company_id,project_id,service_binding_id,service_provision_id) REFERENCES project_gateway_bindings(company_id,project_id,id,provision_id) ON DELETE CASCADE;
ALTER TABLE studio_client_storage_grants ADD COLUMN service_binding_id uuid,ADD COLUMN service_provision_id uuid;
ALTER TABLE studio_client_storage_grants ADD CONSTRAINT client_receipt_gateway_epoch CHECK((service_binding_id IS NULL)=(service_provision_id IS NULL));
ALTER TABLE studio_client_storage_grants ADD CONSTRAINT client_receipt_gateway_binding FOREIGN KEY(company_id,project_id,service_binding_id,service_provision_id) REFERENCES project_gateway_bindings(company_id,project_id,id,provision_id) ON DELETE CASCADE;
