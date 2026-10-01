-- Explicit opt-in extension to storage-gateway-permissions.sql. Apply that base
-- template first, then this file, then the image-preparation gateway preflight.
-- Creates no LOGIN and activates no host, service, provider or runtime selection.
-- Only trusted byte-result writes are added. Existing generic gateway writes
-- retain their separate contract; decoder hosts must never receive this role.

GRANT SELECT(id,company_id,project_id,work_item_id,project_revision,project_snapshot,work_snapshot,source_version_id,source_snapshot,destination_folder_id,destination_name,destination_snapshot,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,storage_sponsor_id,recipe_sha256,request_hash,purpose,proposed_by,proposed_agent_id,proposed_run_id,proposer_snapshot,status,revision,lease_id,lease_expires_at,claimed_at,attempt,action_id,action_operation,transform_result,transform_sha256,cleanup_confirmed_at,diagnostic_code,revoked_by,revoked_at,created_at,updated_at,continuation_mode) ON public.project_image_preparations TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON public.project_image_preparations TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,preparation_id,approved_by,approved_at,approver_snapshot,expires_at,approval_hash,processor_snapshot,max_cost_microusd,processing_consent,derivative_write_consent,adoption_consent) ON public.project_image_preparation_approvals TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,preparation_id,file_id,version_id,upload_id,binding_revision_before,binding_revision_after,output_sha256,output_bytes,store_action_id,created_at) ON public.project_image_preparation_allocations TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,token_hash,enrolled_by,sponsor_role,sponsor_joined_at,location,release_sha256,qualification_sha256,profile_sha256,source_commit,closure_sha256,recipe_sha256,transport,created_at,expires_at,revoked_at,revoked_by,revision,updated_at) ON public.project_image_preparation_services TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON public.project_image_preparation_services TO coatria_storage_gateway_v1;
GRANT SELECT(service_id,company_id,project_id,project_revision,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,gateway_binding_id,gateway_provision_id,gateway_configuration_sha256,gateway_origin,gateway_expires_at) ON public.project_image_preparation_service_projects TO coatria_storage_gateway_v1;
GRANT SELECT(service_id,company_id,project_id,preparation_id,lease_id,request_hash,lease,created_at) ON public.project_image_preparation_service_leases TO coatria_storage_gateway_v1;
GRANT SELECT(id,service_id,company_id,project_id,preparation_id,lease_id,request_id,request_hash,token_hash,operation,action_id,version_id,upload_id,bytes,sha256,content_type,expected_etag,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,gateway_binding_id,gateway_provision_id,gateway_configuration_sha256,gateway_origin,expires_at,created_at) ON public.project_image_preparation_byte_grants TO coatria_storage_gateway_v1;
GRANT SELECT(service_id,company_id,request_id,request_hash,identity) ON public.project_image_preparation_service_enrollments TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,preparation_id,action_id,operation,phase) ON public.project_image_preparation_receipts TO coatria_storage_gateway_v1;
GRANT SELECT(grant_id,status) ON public.project_image_preparation_byte_results TO coatria_storage_gateway_v1;
GRANT INSERT(grant_id,status) ON public.project_image_preparation_byte_results TO coatria_storage_gateway_v1;
GRANT UPDATE(status,public_result,provider_result,observed_bytes,observed_sha256,observed_etag,finished_at) ON public.project_image_preparation_byte_results TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,run_id,kind,response) ON public.agent_run_receipts TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,agent_id,run_id,tool,response) ON public.agent_tool_receipts TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,work_item_id,run_id,authority_version,coordination) ON public.studio_image_preparation_dispatches TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,review_id,decision,project_revision_before,project_revision_after,task_revision) ON public.studio_planning_review_decisions TO coatria_storage_gateway_v1;
GRANT SELECT(task_id,user_id) ON public.task_authors TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,task_id,agent_id) ON public.contributions TO coatria_storage_gateway_v1;
GRANT SELECT(id,name) ON public.users TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,project_id,parent_id,name,name_key,binding_id) ON public.project_storage_folders TO coatria_storage_gateway_v1;
GRANT UPDATE(created_at) ON public.project_storage_folders TO coatria_storage_gateway_v1;
GRANT UPDATE(id) ON public.studio_work_items TO coatria_storage_gateway_v1;
GRANT UPDATE(created_at) ON public.studio_role_bindings TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON public.studio_profiles TO coatria_storage_gateway_v1;
GRANT UPDATE(created_at) ON public.project_storage_versions TO coatria_storage_gateway_v1;

-- PostgreSQL row locks require an UPDATE grant. These seven columns are inert:
-- the ALWAYS invoker guard rejects any actual change by this identity.
CREATE OR REPLACE FUNCTION public.coatria_image_preparation_gateway_lock_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Preparation gateway authority rows are read only' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.coatria_image_preparation_gateway_lock_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.project_image_preparations;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.project_image_preparations FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.project_image_preparations ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.project_image_preparation_services;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.project_image_preparation_services FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.project_image_preparation_services ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.project_storage_folders;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.project_storage_folders FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.project_storage_folders ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.studio_work_items;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.studio_work_items FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.studio_work_items ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.studio_role_bindings;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.studio_role_bindings FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.studio_role_bindings ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.studio_profiles;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.studio_profiles FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.studio_profiles ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
DROP TRIGGER IF EXISTS coatria_image_preparation_gateway_lock_guard ON public.project_storage_versions;
CREATE TRIGGER coatria_image_preparation_gateway_lock_guard BEFORE UPDATE ON public.project_storage_versions FOR EACH ROW EXECUTE FUNCTION public.coatria_image_preparation_gateway_lock_guard('coatria_storage_gateway_v1');
ALTER TABLE public.project_storage_versions ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard;
