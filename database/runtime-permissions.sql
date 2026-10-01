-- Apply with the database owner after migrations and after creating the runtime
-- login role. Deliberately not a numbered migration: no secrets or roles are
-- provisioned by ordinary application schema migrations.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coatria_runtime_v1;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM coatria_runtime_v1;
REVOKE ALL(id,name,email,password_hash,role_title,avatar_color,avatar_id,created_at,email_verified_at) ON users FROM coatria_runtime_v1;
GRANT USAGE ON SCHEMA public TO coatria_runtime_v1;
GRANT SELECT ON users, schema_migrations TO coatria_runtime_v1;
GRANT INSERT(name,email,password_hash,role_title,avatar_color,avatar_id) ON users TO coatria_runtime_v1;
GRANT UPDATE(name,password_hash,role_title,avatar_color,avatar_id) ON users TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE,DELETE ON
 sessions,companies,memberships,invitations,rooms,presence,messages,agents,tasks,
 contributions,activity,skills,skill_versions,drives,drive_files,openings,
 applications,rate_limits,call_peers,call_signals,task_authors,
 conversations,conversation_events,conversation_reads,message_reactions,conversation_requests,
 agent_runs,agent_run_claims,agent_run_receipts,agent_tool_receipts,agent_proposals,agent_presence,plugin_installations,agent_missions,agent_mission_cycles,
 studio_profiles,studio_role_bindings,studio_projects,studio_shots,studio_work_items,studio_dependencies,studio_dispatches,
 studio_execution_connectors,studio_execution_jobs,studio_execution_claims,studio_execution_requests,
 studio_staffing_proposals,studio_managed_hosts,studio_host_credentials,studio_host_requests
 TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_artifacts,studio_reviews,studio_gate_events,studio_requests TO coatria_runtime_v1;
-- Generated-media evidence is append-only. Storage workers receive no studio
-- publication or independent-review authority from these web runtime grants.
GRANT SELECT,INSERT ON studio_generated_artifact_sources,studio_generated_review_evidence TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_generated_revision_plans,studio_generated_revision_rounds,studio_generated_revision_items,studio_generated_revision_work,studio_generated_delivery_rounds TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_execution_inputs,studio_execution_job_inputs,studio_execution_manifests,studio_staffing_applications TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_media_files,studio_media_verifications,studio_media_promotions,studio_media_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_deliveries TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE ON studio_coordination_policies TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_coordination_dispatches,studio_coordination_followups,studio_generated_followups,studio_generated_followup_steps TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_reference_generation_handoffs,studio_reference_generation_inspection_adoptions,studio_reference_generation_followups,studio_reference_generation_followup_steps TO coatria_runtime_v1;
GRANT SELECT ON studio_reference_generation_adoption_facts TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE ON studio_review_policies,studio_host_provisions TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_planning_reviews,studio_planning_review_reads,studio_planning_review_decisions,studio_host_compute_reservations,studio_host_provision_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON trusted_service_provisions TO coatria_runtime_v1;
GRANT UPDATE(phase,revision,pod_id,expected_environment_hashes,submitted_at,stop_requested_at,lease_id,lease_expires_at,provider_status,error_code,last_reconciled_at,updated_at) ON trusted_service_provisions TO coatria_runtime_v1;
GRANT SELECT,INSERT ON trusted_service_reservations,trusted_service_requests TO coatria_runtime_v1;
GRANT SELECT ON platform_operator_grants TO coatria_runtime_v1;
GRANT EXECUTE ON FUNCTION coatria_lock_platform_runtime_operator(uuid) TO coatria_runtime_v1;
GRANT SELECT,INSERT ON company_runtime_configurations,company_runtime_selections,company_runtime_requests,company_runtime_executor_credentials,project_gateway_bindings TO coatria_runtime_v1;
GRANT UPDATE(configuration_id,revision,state,selected_by,updated_at) ON company_runtime_selections TO coatria_runtime_v1;
GRANT UPDATE(revoked_at,revoked_by) ON company_runtime_executor_credentials TO coatria_runtime_v1;
GRANT UPDATE(revoked_at) ON project_gateway_bindings TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_client_deliveries,studio_client_delivery_files,studio_client_delivery_receipts,studio_client_delivery_requests,studio_client_storage_grants TO coatria_runtime_v1;
GRANT UPDATE(status,revision,revoked_at) ON studio_client_deliveries TO coatria_runtime_v1;
GRANT UPDATE(status) ON studio_deliveries TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_inference_jobs,studio_inference_reservations,studio_inference_tool_receipts TO coatria_runtime_v1;
GRANT UPDATE(status,provider_job_id,submitted_at,cancel_requested_at,cancel_request_id,output,model_calls,used_tokens,error_code,poll_lease_id,poll_lease_expires_at,last_reconciled_at,updated_at) ON studio_inference_jobs TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_generations,studio_generation_receipts,studio_storage_references,studio_creative_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON higgsfield_oauth_attempts,higgsfield_connections,higgsfield_requests TO coatria_runtime_v1;
GRANT UPDATE(consumed_at) ON higgsfield_oauth_attempts TO coatria_runtime_v1;
GRANT UPDATE(id,revision,status,connected_by,sealed,expires_at,tools,connected_at,updated_at) ON higgsfield_connections TO coatria_runtime_v1;
GRANT UPDATE(status,approved_by,dispatched_at,result,error_code,updated_at) ON higgsfield_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON project_storage_connections,project_storage_bindings,project_storage_folders,project_storage_files,project_storage_versions,project_storage_uploads,project_storage_upload_parts,project_storage_verifications,project_storage_folder_plans,project_storage_plan_applications,project_storage_requests,project_storage_access_receipts TO coatria_runtime_v1;
GRANT UPDATE(status,secret_envelope,revision) ON project_storage_connections TO coatria_runtime_v1;
GRANT UPDATE(revision) ON project_storage_bindings TO coatria_runtime_v1;
GRANT UPDATE(parent_id,name,name_key) ON project_storage_folders,project_storage_files TO coatria_runtime_v1;
GRANT UPDATE(status,provider_upload_id,provider_descriptor,provider_etag,verification_grant_id,active_part,action_id,action_expires_at,updated_at) ON project_storage_uploads TO coatria_runtime_v1;
GRANT SELECT,INSERT ON higgsfield_job_receipts,higgsfield_jobs,higgsfield_job_observations,higgsfield_job_outputs,higgsfield_output_locators TO coatria_runtime_v1;
GRANT INSERT ON higgsfield_provider_responses TO coatria_runtime_v1;
GRANT UPDATE(status,diagnostic_code,poll_attempts,next_poll_at,poll_lease_id,poll_lease_expires_at,updated_at) ON higgsfield_jobs TO coatria_runtime_v1;
-- The web control plane proposes/approves/revokes; only the separate archive
-- worker may allocate an archive upload or insert received-byte evidence.
GRANT SELECT,INSERT ON higgsfield_output_archives,higgsfield_archive_receipts,higgsfield_archive_requests TO coatria_runtime_v1;
GRANT SELECT ON higgsfield_archive_fetches TO coatria_runtime_v1;
GRANT UPDATE(status,revision,approved_by,approved_at,expires_at,approved_project_revision,approved_binding_revision,revoked_by,revoked_at,lease_id,lease_expires_at,diagnostic_code,updated_at) ON higgsfield_output_archives TO coatria_runtime_v1;
-- Reference metadata and the OAuth broker stay in the control plane. The
-- runtime can record broker allocations/confirmations, but cannot invent image
-- inspection evidence. No existing archive-worker role gains reference access.
GRANT SELECT,INSERT ON higgsfield_references,higgsfield_reference_receipts,higgsfield_reference_requests,higgsfield_reference_transports,higgsfield_reference_confirmations TO coatria_runtime_v1;
GRANT SELECT ON higgsfield_reference_inspections TO coatria_runtime_v1;
-- Operator-enrolled service qualification is immutable to application users.
-- An administrator can stop an existing service, never enroll or extend it.
GRANT SELECT ON higgsfield_reference_services,higgsfield_reference_service_projects TO coatria_runtime_v1;
GRANT SELECT(service_id,company_id,request_id,request_hash,identity) ON higgsfield_reference_service_enrollments TO coatria_runtime_v1;
GRANT UPDATE(revoked_at,revoked_by,revision,updated_at) ON higgsfield_reference_services TO coatria_runtime_v1;
-- Exact explicit dispatch and inspection authority are immutable once saved.
GRANT SELECT,INSERT ON studio_reference_preparation_dispatches TO coatria_runtime_v1;
GRANT SELECT,INSERT ON higgsfield_model_contracts TO coatria_runtime_v1;
GRANT UPDATE(connection_id,connection_revision,catalog_sha256,descriptor,descriptor_sha256,observed_at,expires_at) ON higgsfield_model_contracts TO coatria_runtime_v1;
GRANT UPDATE(status,revision,approved_by,approved_at,expires_at,approval_hash,qualification_sha256,revoked_by,revoked_at,lease_id,lease_expires_at,action_id,action_operation,diagnostic_code,updated_at) ON higgsfield_references TO coatria_runtime_v1;
GRANT UPDATE(generation_inspection_adoption_id) ON higgsfield_references TO coatria_runtime_v1;
-- Image preparation is a web control-plane proposal, finite human approval or
-- revocation. Existing web storage grants do not confer processor authority.
GRANT SELECT ON project_image_preparations,project_image_preparation_approvals,project_image_preparation_requests,project_image_preparation_receipts,project_image_preparation_allocations,project_image_preparation_derivations,studio_image_preparation_dispatches TO coatria_runtime_v1;
-- Public readiness and human consent resolve an existing registrar identity in
-- the same app transaction. This cannot enroll, revoke or extend a service.
GRANT SELECT ON project_image_preparation_services,project_image_preparation_service_projects TO coatria_runtime_v1;
GRANT SELECT(service_id,company_id,request_id,request_hash,identity) ON project_image_preparation_service_enrollments TO coatria_runtime_v1;
-- FOR SHARE needs one UPDATE column. The 050 ALWAYS stop guard rejects every
-- real created_at change; no service transition or credential column is writable.
GRANT UPDATE(created_at) ON project_image_preparation_services TO coatria_runtime_v1;
GRANT INSERT(company_id,project_id,work_item_id,project_revision,project_snapshot,work_snapshot,source_version_id,source_snapshot,destination_folder_id,destination_name,destination_snapshot,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,storage_sponsor_id,recipe_sha256,request_hash,purpose,proposed_by,proposed_agent_id,proposed_run_id,proposer_snapshot,continuation_mode) ON project_image_preparations TO coatria_runtime_v1;
GRANT INSERT ON project_image_preparation_approvals TO coatria_runtime_v1;
GRANT INSERT(company_id,actor_key,client_id,request_hash,response) ON project_image_preparation_requests TO coatria_runtime_v1;
GRANT INSERT(company_id,project_id,preparation_id,action_id,operation,phase,detail) ON project_image_preparation_receipts TO coatria_runtime_v1;
GRANT UPDATE(status,revision,revoked_by,revoked_at,updated_at) ON project_image_preparations TO coatria_runtime_v1;
GRANT INSERT(company_id,project_id,work_item_id,run_id,authority_version,coordination) ON studio_image_preparation_dispatches TO coatria_runtime_v1;
-- Column grants cannot distinguish a control receipt from a worker intent, or
-- an approval from a processor transition. Keep both guarded by the actual
-- SQL role. No new role, SECURITY DEFINER function or worker grant is created.
CREATE OR REPLACE FUNCTION public.coatria_runtime_preparation_control_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF current_user=TG_ARGV[0] THEN
  IF TG_TABLE_NAME='project_image_preparation_receipts' THEN
   IF NOT ((NEW.operation='approve' AND NEW.phase='returned') OR (NEW.operation='revoke' AND NEW.phase='revoked')) THEN
    RAISE EXCEPTION 'The web runtime cannot record preparation worker evidence' USING ERRCODE='42501';
   END IF;
  ELSIF NEW IS DISTINCT FROM OLD AND NOT (
   NEW.revision=OLD.revision+1 AND (
    (OLD.status='proposed' AND NEW.status='queued' AND NEW.revoked_at IS NULL AND NEW.revoked_by IS NULL)
    OR (OLD.status<>'revoked' AND NEW.status='revoked' AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL)
   )
  ) THEN
   RAISE EXCEPTION 'The web runtime cannot advance preparation worker state' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END
$guard$;
DROP TRIGGER IF EXISTS coatria_runtime_preparation_control ON public.project_image_preparations;
CREATE TRIGGER coatria_runtime_preparation_control BEFORE UPDATE ON public.project_image_preparations FOR EACH ROW EXECUTE FUNCTION public.coatria_runtime_preparation_control_guard('coatria_runtime_v1');
ALTER TABLE public.project_image_preparations ENABLE ALWAYS TRIGGER coatria_runtime_preparation_control;
DROP TRIGGER IF EXISTS coatria_runtime_preparation_control ON public.project_image_preparation_receipts;
CREATE TRIGGER coatria_runtime_preparation_control BEFORE INSERT ON public.project_image_preparation_receipts FOR EACH ROW EXECUTE FUNCTION public.coatria_runtime_preparation_control_guard('coatria_runtime_v1');
ALTER TABLE public.project_image_preparation_receipts ENABLE ALWAYS TRIGGER coatria_runtime_preparation_control;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO coatria_runtime_v1;
ALTER ROLE coatria_runtime_v1 SET statement_timeout='15s';
ALTER ROLE coatria_runtime_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_runtime_v1 SET search_path=pg_catalog,public;
