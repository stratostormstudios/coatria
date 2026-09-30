-- Trusted operator enrollment provenance. This migration creates no login or
-- grants. Registration inserts service, exact project scope and this immutable
-- identity in one transaction; a service without this row is not enrolled.
CREATE TABLE higgsfield_reference_service_enrollments (
 service_id uuid PRIMARY KEY,
 company_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object' AND pg_column_size(identity)<=65536),
 CHECK((identity->>'serviceId') IS NOT DISTINCT FROM service_id::text),
 CHECK((identity->>'companyId') IS NOT DISTINCT FROM company_id::text),
 CHECK((identity->>'requestId') IS NOT DISTINCT FROM request_id::text),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(company_id,service_id),
 FOREIGN KEY(company_id,service_id) REFERENCES higgsfield_reference_services(company_id,id) ON DELETE CASCADE
);
CREATE FUNCTION guard_higgsfield_reference_enrollment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'reference enrollment identity is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER higgsfield_reference_enrollment_immutable BEFORE UPDATE ON higgsfield_reference_service_enrollments
 FOR EACH ROW EXECUTE FUNCTION guard_higgsfield_reference_enrollment();
ALTER TABLE higgsfield_reference_service_enrollments ENABLE ALWAYS TRIGGER higgsfield_reference_enrollment_immutable;
-- No DELETE trigger: owner-controlled company/service cascades remain possible.
-- Ordinary runtime, broker, worker and registrar roles receive no DELETE grant.
