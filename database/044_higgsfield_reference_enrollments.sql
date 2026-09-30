-- Trusted operator enrollment provenance. This migration creates no login or
-- grants. Registration inserts service, exact project scope and this immutable
-- identity in one transaction; a service without this row is not enrolled.
-- A company cascades to both services and storage. Keep the exact storage
-- tuples mandatory at COMMIT without making that cascade depend on trigger
-- order. Standalone storage deletion remains forbidden while scope references
-- it; this changes constraint timing, not ON DELETE behavior or privileges.
DO $reference_storage_fks$
DECLARE target record; matched integer; constraint_name text;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('public.project_storage_bindings'::regclass,ARRAY['company_id','project_id','storage_binding_id']::text[],ARRAY['company_id','project_id','id']::text[]),
  ('public.project_storage_connections'::regclass,ARRAY['company_id','storage_connection_id']::text[],ARRAY['company_id','id']::text[])
 ) AS expected(referenced_table,local_columns,referenced_columns)
 LOOP
  SELECT count(*),min(c.conname) INTO matched,constraint_name
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.higgsfield_reference_service_projects'::regclass
   AND c.contype='f' AND c.confrelid=target.referenced_table
   AND c.confupdtype='a' AND c.confdeltype='a' AND c.confmatchtype='s' AND c.convalidated
   AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.position)=target.local_columns
   AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.position)=target.referenced_columns;
  IF matched<>1 THEN RAISE EXCEPTION 'Expected one exact reference service storage constraint' USING ERRCODE='23514'; END IF;
  EXECUTE format('ALTER TABLE public.higgsfield_reference_service_projects ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',constraint_name);
 END LOOP;
END
$reference_storage_fks$;
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
