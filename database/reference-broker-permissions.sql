-- Operator-only grants after migration 043 and creation of the dedicated LOGIN.
-- Never apply to the web runtime, archive worker or storage gateway. OAuth
-- refresh stays on the controlled application path; this role cannot read it.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coatria_higgsfield_reference_broker_v1;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM coatria_higgsfield_reference_broker_v1;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM coatria_higgsfield_reference_broker_v1;
DO $reference_grants$
DECLARE entry record;
BEGIN
 FOR entry IN SELECT c.relname,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) AS columns
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname
 LOOP
  EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM %I',entry.columns,entry.relname,'coatria_higgsfield_reference_broker_v1');
 END LOOP;
END
$reference_grants$;
GRANT USAGE ON SCHEMA public TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON schema_migrations TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id) ON companies TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(created_at) ON companies TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,user_id,role,access_revoked_at,joined_at) ON memberships TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(joined_at) ON memberships TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,name,email,role_title,avatar_color,avatar_id,email_verified_at) ON users TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_projects TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON studio_projects TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_role_bindings TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(created_at) ON studio_role_bindings TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_work_items TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON tasks TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON tasks TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_dependencies TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_dispatches TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_reference_preparation_dispatches TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_reference_generation_handoffs TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_reference_generation_inspection_adoptions TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_reference_generation_adoption_facts TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,company_id,project_id,number,plan_sha256) ON studio_generated_revision_rounds TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,project_id,round_id,work_item_id) ON studio_generated_revision_work TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,company_id,created_by,token_hash,managed_token_hash,invocation_access,capabilities,status,expires_at) ON agents TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(last_seen_at) ON agents TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,company_id,agent_id,requested_by,purpose,status,capabilities,attempts,max_attempts,started_at,finished_at,result_message_id,lease_token_hash,lease_expires_at) ON agent_runs TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON agent_runs TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,run_id,kind,response) ON agent_run_receipts TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,agent_id,run_id,tool,response) ON agent_tool_receipts TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,company_id,agent_id,revision) ON plugin_installations TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON plugin_installations TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,agent_id,host_id,installation_id,token_hash,revoked_at,expires_at,host_epoch,installation_revision,enrolled_by) ON studio_host_credentials TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,company_id,created_by,status,expires_at,lease_expires_at,lease_epoch) ON studio_managed_hosts TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_coordination_dispatches TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON studio_coordination_policies TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON studio_coordination_policies TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,revision) ON studio_profiles TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON studio_profiles TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,child_run_id) ON studio_coordination_followups TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,child_run_id) ON studio_generated_followups TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,run_id) ON agent_mission_cycles TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(id,company_id,project_id,work_item_id,task_id,producer_agent_id,producer_run_id,task_revision,reviewer_agent_id,reviewer_run_id) ON studio_planning_reviews TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,review_id,decision) ON studio_planning_review_decisions TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(company_id,id,revision,status,connected_by,tools) ON higgsfield_connections TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON higgsfield_connections TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON project_storage_connections TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(created_at) ON project_storage_connections TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON project_storage_bindings TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(created_at) ON project_storage_bindings TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON project_storage_files TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON project_storage_versions TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON project_storage_verifications TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_references TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(status,revision,lease_id,lease_expires_at,action_id,action_operation,diagnostic_code,updated_at,inspection_attempts) ON higgsfield_references TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_inspections TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_inspections TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_receipts TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_receipts TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_transports TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_transports TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_confirmations TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_confirmations TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_services TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(updated_at) ON higgsfield_reference_services TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_service_projects TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT(service_id,company_id,request_id,request_hash,identity) ON higgsfield_reference_service_enrollments TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_service_leases TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_service_leases TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_service_calls TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_service_calls TO coatria_higgsfield_reference_broker_v1;
GRANT SELECT ON higgsfield_reference_service_reads TO coatria_higgsfield_reference_broker_v1;
GRANT INSERT ON higgsfield_reference_service_reads TO coatria_higgsfield_reference_broker_v1;
GRANT UPDATE(status,response,finished_at) ON higgsfield_reference_service_calls TO coatria_higgsfield_reference_broker_v1;
-- UPDATE on an inert column is required for SELECT row locks. The invoker
-- trigger rejects actual row changes by this principal, including timestamps.
-- Other principals keep their existing behavior and permissions.
CREATE OR REPLACE FUNCTION public.coatria_reference_broker_readonly_lock_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Reference broker authority rows are read only' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END
$guard$;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.companies;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.companies ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.memberships;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.memberships ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.studio_projects;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.studio_projects FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.studio_projects ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.studio_role_bindings;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.studio_role_bindings FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.studio_role_bindings ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.tasks;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.agents;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.agents ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.agent_runs;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.agent_runs ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.plugin_installations;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.plugin_installations FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.plugin_installations ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.higgsfield_connections;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.higgsfield_connections FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.higgsfield_connections ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.project_storage_connections;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.project_storage_connections FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.project_storage_connections ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.project_storage_bindings;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.project_storage_bindings FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.project_storage_bindings ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
ALTER ROLE coatria_higgsfield_reference_broker_v1 SET statement_timeout='15s';
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.higgsfield_reference_services;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.higgsfield_reference_services FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.higgsfield_reference_services ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
ALTER ROLE coatria_higgsfield_reference_broker_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_higgsfield_reference_broker_v1 SET search_path=pg_catalog,public;
DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.studio_coordination_policies;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.studio_coordination_policies FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.studio_coordination_policies ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;

DROP TRIGGER IF EXISTS coatria_reference_broker_lock_guard ON public.studio_profiles;
CREATE TRIGGER coatria_reference_broker_lock_guard BEFORE UPDATE ON public.studio_profiles FOR EACH ROW EXECUTE FUNCTION public.coatria_reference_broker_readonly_lock_guard('coatria_higgsfield_reference_broker_v1');
ALTER TABLE public.studio_profiles ENABLE ALWAYS TRIGGER coatria_reference_broker_lock_guard;
