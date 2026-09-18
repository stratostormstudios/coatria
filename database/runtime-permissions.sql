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
 studio_profiles,studio_role_bindings,studio_projects,studio_shots,studio_work_items,studio_dependencies,studio_requests,studio_dispatches,
 studio_execution_connectors,studio_execution_jobs,studio_execution_claims,studio_execution_requests,
 studio_staffing_proposals,studio_managed_hosts,studio_host_credentials,studio_host_requests
 TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_artifacts,studio_reviews,studio_gate_events TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_execution_inputs,studio_execution_job_inputs,studio_execution_manifests,studio_staffing_applications TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_media_files,studio_media_verifications,studio_media_promotions,studio_media_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_deliveries TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE ON studio_coordination_policies TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_coordination_dispatches TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE ON studio_review_policies,studio_host_provisions TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_planning_reviews,studio_planning_review_reads,studio_planning_review_decisions,studio_host_compute_reservations,studio_host_provision_requests TO coatria_runtime_v1;
GRANT SELECT,INSERT ON studio_client_deliveries,studio_client_delivery_files,studio_client_delivery_receipts,studio_client_delivery_requests TO coatria_runtime_v1;
GRANT UPDATE(status,revision,revoked_at) ON studio_client_deliveries TO coatria_runtime_v1;
GRANT UPDATE(status) ON studio_deliveries TO coatria_runtime_v1;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO coatria_runtime_v1;
ALTER ROLE coatria_runtime_v1 SET statement_timeout='15s';
ALTER ROLE coatria_runtime_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_runtime_v1 SET search_path=pg_catalog,public;
