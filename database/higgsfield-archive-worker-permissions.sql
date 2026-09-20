-- Apply as database owner after 029 and after creating this dedicated LOGIN
-- through your secrets manager. No password/role is created by this script.
-- This role runs the separately approved archival worker, never the web API,
-- ordinary transfer gateway, provider generation/polling or agent runtime.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coatria_higgsfield_archive_worker_v1;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM coatria_higgsfield_archive_worker_v1;
-- Table REVOKE does not remove historical column grants. Reapplication must
-- remove those too, including a mistakenly widened credential/identity grant.
DO $archive_grants$
DECLARE entry record;
BEGIN
 FOR entry IN SELECT c.relname,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) AS columns
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname
 LOOP
  EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM %I',entry.columns,entry.relname,'coatria_higgsfield_archive_worker_v1');
 END LOOP;
END
$archive_grants$;
GRANT USAGE ON SCHEMA public TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT ON schema_migrations TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(id) ON companies TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(company_id,user_id,role) ON memberships TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(id,company_id,revision,status,ai_policy,gates,production_path) ON studio_projects TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(company_id,role_key,agent_id,human_id) ON studio_role_bindings TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(id,company_id,project_id,task_id,role_key,stage,execution) ON studio_work_items TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(id,company_id,created_by) ON agents TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT ON higgsfield_jobs,higgsfield_job_receipts,higgsfield_job_outputs,higgsfield_output_locators TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT(id,company_id,project_id,status,requested_by,agent_id,run_id,approved_by,request_hash,connection_id,connection_revision,work_item_id,role_agent_id,role_human_id) ON higgsfield_requests TO coatria_higgsfield_archive_worker_v1;
-- Account identity/status only. OAuth sealed tokens and private provider
-- response journals are intentionally unavailable to this worker.
GRANT SELECT(company_id,id,revision,status,connected_by) ON higgsfield_connections TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT ON project_storage_connections,project_storage_bindings,project_storage_folders,project_storage_files,project_storage_versions,project_storage_uploads,project_storage_upload_parts,project_storage_verifications TO coatria_higgsfield_archive_worker_v1;
GRANT SELECT ON higgsfield_output_archives,higgsfield_archive_fetches,higgsfield_archive_receipts TO coatria_higgsfield_archive_worker_v1;
-- FOR SHARE/UPDATE needs a column UPDATE grant. None of these inert timestamp
-- grants permit changing membership, gates, roles, accounts or source identity.
GRANT UPDATE(created_at) ON companies,studio_role_bindings,project_storage_connections,project_storage_folders,project_storage_files TO coatria_higgsfield_archive_worker_v1;
GRANT UPDATE(joined_at) ON memberships TO coatria_higgsfield_archive_worker_v1;
GRANT UPDATE(updated_at) ON studio_projects,higgsfield_jobs,higgsfield_requests,higgsfield_connections TO coatria_higgsfield_archive_worker_v1;
GRANT UPDATE(revision) ON project_storage_bindings TO coatria_higgsfield_archive_worker_v1;
GRANT INSERT ON project_storage_files,project_storage_versions,project_storage_uploads,project_storage_upload_parts,project_storage_verifications,higgsfield_archive_fetches,higgsfield_archive_receipts TO coatria_higgsfield_archive_worker_v1;
GRANT UPDATE(status,provider_upload_id,provider_descriptor,provider_etag,active_part,action_id,action_expires_at,updated_at) ON project_storage_uploads TO coatria_higgsfield_archive_worker_v1;
GRANT UPDATE(status,lease_id,lease_expires_at,attempt_count,upload_id,version_id,diagnostic_code,updated_at) ON higgsfield_output_archives TO coatria_higgsfield_archive_worker_v1;
ALTER ROLE coatria_higgsfield_archive_worker_v1 SET statement_timeout='15s';
ALTER ROLE coatria_higgsfield_archive_worker_v1 SET idle_in_transaction_session_timeout='20s';
ALTER ROLE coatria_higgsfield_archive_worker_v1 SET search_path=pg_catalog,public;
