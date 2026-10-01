-- Operator-only template. No role creation, password, host activation or live grant.
-- Never apply this identity to a processor or ordinary application pool.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coatria_image_preparation_registrar_v1;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM coatria_image_preparation_registrar_v1;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM coatria_image_preparation_registrar_v1;
DO $grants$ DECLARE entry record; BEGIN
 FOR entry IN SELECT c.relname,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname LOOP
 EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM %I',entry.columns,entry.relname,'coatria_image_preparation_registrar_v1');
 END LOOP; END $grants$;
GRANT USAGE ON SCHEMA public TO coatria_image_preparation_registrar_v1;
GRANT SELECT ON schema_migrations TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id) ON companies TO coatria_image_preparation_registrar_v1;
GRANT UPDATE(created_at) ON companies TO coatria_image_preparation_registrar_v1;
GRANT SELECT(company_id,user_id,role,access_revoked_at,joined_at) ON memberships TO coatria_image_preparation_registrar_v1;
GRANT UPDATE(joined_at) ON memberships TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id,company_id,revision,status,ai_policy,production_path,contract_version,gates) ON studio_projects TO coatria_image_preparation_registrar_v1;
GRANT UPDATE(updated_at) ON studio_projects TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id,company_id,revision,status,created_by) ON project_storage_connections TO coatria_image_preparation_registrar_v1;
GRANT UPDATE(created_at) ON project_storage_connections TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id,company_id,project_id,connection_id,revision) ON project_storage_bindings TO coatria_image_preparation_registrar_v1;
GRANT UPDATE(created_at) ON project_storage_bindings TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id,company_id,project_id,provision_id,configuration_hash,origin,verified_by,verified_at,expires_at,revoked_at) ON project_gateway_bindings TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id,company_id,service,phase,provider_status,stop_requested_at,pod_id,expires_at,last_reconciled_at,preset,plan,plan_hash,created_by) ON trusted_service_provisions TO coatria_image_preparation_registrar_v1;
GRANT SELECT(company_id,kind,configuration_id,revision,state) ON company_runtime_selections TO coatria_image_preparation_registrar_v1;
GRANT SELECT(id,company_id,kind,configuration_hash,expires_at) ON company_runtime_configurations TO coatria_image_preparation_registrar_v1;
GRANT SELECT ON project_image_preparation_services TO coatria_image_preparation_registrar_v1;
GRANT INSERT ON project_image_preparation_services TO coatria_image_preparation_registrar_v1;
GRANT SELECT ON project_image_preparation_service_projects TO coatria_image_preparation_registrar_v1;
GRANT INSERT ON project_image_preparation_service_projects TO coatria_image_preparation_registrar_v1;
GRANT SELECT ON project_image_preparation_service_enrollments TO coatria_image_preparation_registrar_v1;
GRANT INSERT ON project_image_preparation_service_enrollments TO coatria_image_preparation_registrar_v1;
CREATE OR REPLACE FUNCTION public.coatria_image_preparation_registrar_lock_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Preparation authority rows are read only' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END
$guard$;
DROP TRIGGER IF EXISTS coatria_image_preparation_registrar_lock_guard ON public.companies;
CREATE TRIGGER coatria_image_preparation_registrar_lock_guard BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_registrar_lock_guard('coatria_image_preparation_registrar_v1');
ALTER TABLE public.companies ENABLE ALWAYS TRIGGER coatria_image_preparation_registrar_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_registrar_lock_guard ON public.memberships;
CREATE TRIGGER coatria_image_preparation_registrar_lock_guard BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_registrar_lock_guard('coatria_image_preparation_registrar_v1');
ALTER TABLE public.memberships ENABLE ALWAYS TRIGGER coatria_image_preparation_registrar_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_registrar_lock_guard ON public.studio_projects;
CREATE TRIGGER coatria_image_preparation_registrar_lock_guard BEFORE UPDATE ON public.studio_projects FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_registrar_lock_guard('coatria_image_preparation_registrar_v1');
ALTER TABLE public.studio_projects ENABLE ALWAYS TRIGGER coatria_image_preparation_registrar_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_registrar_lock_guard ON public.project_storage_connections;
CREATE TRIGGER coatria_image_preparation_registrar_lock_guard BEFORE UPDATE ON public.project_storage_connections FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_registrar_lock_guard('coatria_image_preparation_registrar_v1');
ALTER TABLE public.project_storage_connections ENABLE ALWAYS TRIGGER coatria_image_preparation_registrar_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_registrar_lock_guard ON public.project_storage_bindings;
CREATE TRIGGER coatria_image_preparation_registrar_lock_guard BEFORE UPDATE ON public.project_storage_bindings FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_registrar_lock_guard('coatria_image_preparation_registrar_v1');
ALTER TABLE public.project_storage_bindings ENABLE ALWAYS TRIGGER coatria_image_preparation_registrar_lock_guard;
ALTER ROLE coatria_image_preparation_registrar_v1 SET statement_timeout='10s';
ALTER ROLE coatria_image_preparation_registrar_v1 SET idle_in_transaction_session_timeout='15s';
ALTER ROLE coatria_image_preparation_registrar_v1 SET search_path=pg_catalog,public;
