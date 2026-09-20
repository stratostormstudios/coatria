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
-- Row locks require UPDATE on at least one column; immutable identity cannot be changed.
GRANT UPDATE(created_at) ON companies TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON agent_runs TO coatria_storage_gateway_v1;
GRANT UPDATE(last_seen_at) ON agents TO coatria_storage_gateway_v1;
GRANT UPDATE(joined_at) ON memberships TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON studio_coordination_policies,studio_review_policies TO coatria_storage_gateway_v1;
GRANT UPDATE(updated_at) ON plugin_installations TO coatria_storage_gateway_v1;
GRANT UPDATE(created_at) ON project_storage_connections TO coatria_storage_gateway_v1;
GRANT INSERT ON project_storage_upload_parts,project_storage_verifications TO coatria_storage_gateway_v1;
GRANT UPDATE(status,provider_upload_id,provider_descriptor,provider_etag,verification_grant_id,active_part,action_id,action_expires_at,updated_at) ON project_storage_uploads TO coatria_storage_gateway_v1;
ALTER ROLE coatria_storage_gateway_v1 SET statement_timeout='15s';
ALTER ROLE coatria_storage_gateway_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_storage_gateway_v1 SET search_path=pg_catalog,public;
