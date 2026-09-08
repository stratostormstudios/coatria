-- Apply with the database owner after migrations and after creating the runtime
-- login role. Deliberately not a numbered migration: no secrets or roles are
-- provisioned by ordinary application schema migrations.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coatria_runtime_v1;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM coatria_runtime_v1;
REVOKE ALL(id,name,email,password_hash,role_title,avatar_color,created_at,email_verified_at) ON users FROM coatria_runtime_v1;
GRANT USAGE ON SCHEMA public TO coatria_runtime_v1;
GRANT SELECT ON users, schema_migrations TO coatria_runtime_v1;
GRANT INSERT(name,email,password_hash,role_title,avatar_color) ON users TO coatria_runtime_v1;
GRANT UPDATE(name,password_hash,role_title,avatar_color) ON users TO coatria_runtime_v1;
GRANT SELECT,INSERT,UPDATE,DELETE ON
 sessions,companies,memberships,invitations,rooms,presence,messages,agents,tasks,
 contributions,activity,skills,skill_versions,drives,drive_files,openings,
 applications,rate_limits,call_peers,call_signals,task_authors
 TO coatria_runtime_v1;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO coatria_runtime_v1;
ALTER ROLE coatria_runtime_v1 SET statement_timeout='15s';
ALTER ROLE coatria_runtime_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_runtime_v1 SET search_path=pg_catalog,public;
