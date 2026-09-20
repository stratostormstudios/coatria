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
GRANT SELECT,INSERT ON studio_execution_inputs,studio_execution_job_inputs,studio_execution_manifests,studio_staffing_applications TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_media_files,studio_media_verifications,studio_media_promotions,studio_media_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_deliveries TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE ON studio_coordination_policies TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_coordination_dispatches,studio_coordination_followups,studio_generated_followups,studio_generated_followup_steps TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE ON studio_review_policies,studio_host_provisions TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_planning_reviews,studio_planning_review_reads,studio_planning_review_decisions,studio_host_compute_reservations,studio_host_provision_requests TO coatria_runtime_v1;
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
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO coatria_runtime_v1;
ALTER ROLE coatria_runtime_v1 SET statement_timeout='15s';
ALTER ROLE coatria_runtime_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_runtime_v1 SET search_path=pg_catalog,public;
