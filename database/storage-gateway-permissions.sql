-- Apply as owner after creating a dedicated coatria_storage_gateway_v1 login
-- through your secrets manager. This file never creates a password or a role.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coatria_storage_gateway_v1;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM coatria_storage_gateway_v1;
GRANT USAGE ON SCHEMA public TO coatria_storage_gateway_v1;
GRANT SELECT ON schema_migrations,companies,memberships,agents,agent_runs,studio_managed_hosts,plugin_installations,
 agent_mission_cycles,agent_missions,studio_coordination_dispatches,studio_coordination_followups,studio_coordination_policies,studio_role_bindings,studio_profiles,studio_review_policies,studio_planning_reviews,studio_projects,studio_work_items,studio_dependencies,tasks,studio_execution_jobs,studio_execution_manifests,studio_media_promotions,studio_media_files,studio_media_verifications,studio_artifacts,studio_reviews,studio_dispatches,
 project_storage_connections,project_storage_bindings,project_storage_files,project_storage_versions,
 project_storage_uploads,project_storage_upload_parts,project_storage_verifications,project_storage_access_receipts
 TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,agent_id,host_id,installation_id,token_hash,revoked_at,expires_at,host_epoch,installation_revision,enrolled_by) ON studio_host_credentials TO coatria_storage_gateway_v1;
-- Classification only: generated continuations are never allowed file transfers.
-- Do not grant source snapshots, artifact evidence or canonical step identifiers.
GRANT SELECT(company_id,child_run_id) ON studio_generated_followups TO coatria_storage_gateway_v1;
-- External client capabilities are separate from membership and agent grants.
-- Only exact approved file facts and mutable source availability are exposed.
GRANT SELECT(id,company_id,project_id,delivery_id,recipient_user_id,created_by,status,package_hash,expires_at) ON studio_client_deliveries TO coatria_storage_gateway_v1;
-- Only revision topology and pinned file identities. Draft plans and client notes remain private.
GRANT SELECT(id,company_id,project_id) ON studio_deliveries,studio_shots TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,project_id,number,plan_sha256) ON studio_generated_revision_rounds TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,delivery_id,round_id) ON studio_generated_delivery_rounds TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,round_id,work_item_id) ON studio_generated_revision_work TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,round_id,unit_id,generation_work_item_id,qc_work_item_id,action,artifact_id,review_id,storage_version_id,manifest_sha256,file_sha256) ON studio_generated_revision_items TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,share_id,file_id,artifact_id,review_id,storage_version_id,storage_name,storage_sha256,storage_bytes,storage_content_type) ON studio_client_delivery_files TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,token_hash,expires_at,service_binding_id,service_provision_id) ON studio_client_storage_grants TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,project_id,provision_id,configuration_hash,origin,verified_by,verified_at,expires_at,revoked_at) ON project_gateway_bindings TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,service,phase,provider_status,stop_requested_at,pod_id,expires_at,last_reconciled_at,preset,plan,plan_hash,created_by) ON trusted_service_provisions TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,kind,configuration_id,revision,state) ON company_runtime_selections TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,kind,configuration_hash,expires_at) ON company_runtime_configurations TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,artifact_id,archive_id,request_id,job_id,output_id,storage_version_id,archive_approved_by,file_facts) ON studio_generated_artifact_sources TO coatria_storage_gateway_v1;
GRANT SELECT(id,company_id,project_id,request_id,job_id,output_id,version_id,upload_id,locator_identity,approved_by,provider_connection_id,storage_binding_id,storage_connection_id,storage_connection_snapshot,status,revoked_at) ON higgsfield_output_archives TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,id,request_id,connection_id,status) ON higgsfield_jobs TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,id,connection_id,status) ON higgsfield_requests TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,id,job_id,locator_identity) ON higgsfield_job_outputs TO coatria_storage_gateway_v1;
GRANT SELECT(company_id,project_id,archive_id,locator_identity,bytes,sha256) ON higgsfield_archive_fetches TO coatria_storage_gateway_v1;
-- Row locks require UPDATE on at least one column; immutable identity cannot be changed.
GRANT UPDATE(created_at) ON companies TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON agent_runs TO coatria_storage_gateway_v1;
GRANT UPDATE(last_seen_at) ON agents TO coatria_storage_gateway_v1;
GRANT UPDATE(joined_at) ON memberships TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON studio_coordination_policies,studio_review_policies TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON plugin_installations TO coatria_storage_gateway_v1;
GRANT UPDATE(created_at) ON project_storage_connections TO coatria_storage_gateway_v1;
GRANT UPDATE(created_at) ON studio_client_deliveries,studio_projects,tasks,higgsfield_output_archives,higgsfield_jobs,higgsfield_requests,project_storage_files,project_storage_bindings TO coatria_storage_gateway_v1;
GRANT INSERT ON project_storage_upload_parts,project_storage_verifications TO coatria_storage_gateway_v1;
GRANT UPDATE(status,provider_upload_id,provider_descriptor,provider_etag,verification_grant_id,active_part,action_id,action_expires_at,updated_at) ON project_storage_uploads TO coatria_storage_gateway_v1;
ALTER ROLE coatria_storage_gateway_v1 SET statement_timeout='15s';
ALTER ROLE coatria_storage_gateway_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_storage_gateway_v1 SET search_path=pg_catalog,public;
