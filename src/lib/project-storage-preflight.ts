/** Read-only startup assertion for the separate trusted storage gateway.
 * Mirrors database/storage-gateway-permissions.sql. Checks effective catalog
 * authority at startup; it does not qualify provider connectivity, TLS, RLS,
 * trusted function bodies, later administrator changes or the deployed host. */
export const PROJECT_STORAGE_GATEWAY_ROLE='coatria_storage_gateway_v1';
type Db={query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Privilege='SELECT'|'INSERT'|'UPDATE'|'REFERENCES';
type Contract=Partial<Record<Privilege,'*'|readonly string[]>>;
const contract:Readonly<Record<string,Contract>>={
 schema_migrations:{"SELECT":"*"},
 companies:{"SELECT":"*","UPDATE":["created_at"]},
 memberships:{"SELECT":"*","UPDATE":["joined_at"]},
 agents:{"SELECT":"*","UPDATE":["last_seen_at"]},
 agent_runs:{"SELECT":"*","UPDATE":["updated_at"]},
 studio_managed_hosts:{"SELECT":"*"},
 plugin_installations:{"SELECT":"*","UPDATE":["updated_at"]},
 agent_mission_cycles:{"SELECT":"*"},
 agent_missions:{"SELECT":"*"},
 studio_coordination_dispatches:{"SELECT":"*"},
 studio_coordination_followups:{"SELECT":"*"},
 studio_coordination_policies:{"SELECT":"*","UPDATE":["updated_at"]},
 studio_role_bindings:{"SELECT":"*"},
 studio_profiles:{"SELECT":"*"},
 studio_review_policies:{"SELECT":"*","UPDATE":["updated_at"]},
 studio_planning_reviews:{"SELECT":"*"},
 studio_projects:{"SELECT":"*","UPDATE":["created_at"]},
 studio_work_items:{"SELECT":"*"},
 studio_dependencies:{"SELECT":"*"},
 tasks:{"SELECT":"*","UPDATE":["created_at"]},
 studio_execution_jobs:{"SELECT":"*"},
 studio_execution_manifests:{"SELECT":"*"},
 studio_media_promotions:{"SELECT":"*"},
 studio_media_files:{"SELECT":"*"},
 studio_media_verifications:{"SELECT":"*"},
 studio_artifacts:{"SELECT":"*"},
 studio_reviews:{"SELECT":"*"},
 studio_dispatches:{"SELECT":"*"},
 project_storage_connections:{"SELECT":"*","UPDATE":["created_at"]},
 project_storage_bindings:{"SELECT":"*","UPDATE":["created_at"]},
 project_storage_files:{"SELECT":"*","UPDATE":["created_at"]},
 project_storage_versions:{"SELECT":"*"},
 project_storage_uploads:{"SELECT":"*","UPDATE":["status","provider_upload_id","provider_descriptor","provider_etag","verification_grant_id","active_part","action_id","action_expires_at","updated_at"]},
 project_storage_upload_parts:{"SELECT":"*","INSERT":"*"},
 project_storage_verifications:{"SELECT":"*","INSERT":"*"},
 project_storage_access_receipts:{"SELECT":"*"},
 studio_host_credentials:{"SELECT":["company_id","agent_id","host_id","installation_id","token_hash","revoked_at","expires_at","host_epoch","installation_revision","enrolled_by"]},
 studio_generated_followups:{"SELECT":["company_id","child_run_id"]},
 studio_client_deliveries:{"SELECT":["id","company_id","project_id","delivery_id","recipient_user_id","created_by","status","package_hash","expires_at"],"UPDATE":["created_at"]},
 studio_deliveries:{"SELECT":["id","company_id","project_id"]},
 studio_shots:{"SELECT":["id","company_id","project_id"]},
 studio_generated_revision_rounds:{"SELECT":["id","company_id","project_id","number","plan_sha256"]},
 studio_generated_delivery_rounds:{"SELECT":["company_id","project_id","delivery_id","round_id"]},
 studio_generated_revision_work:{"SELECT":["company_id","project_id","round_id","work_item_id"]},
 studio_generated_revision_items:{"SELECT":["company_id","project_id","round_id","unit_id","generation_work_item_id","qc_work_item_id","action","artifact_id","review_id","storage_version_id","manifest_sha256","file_sha256"]},
 studio_client_delivery_files:{"SELECT":["company_id","project_id","share_id","file_id","artifact_id","review_id","storage_version_id","storage_name","storage_sha256","storage_bytes","storage_content_type"]},
 studio_client_storage_grants:{"SELECT":["company_id","project_id","share_id","recipient_user_id","storage_version_id","connection_id","connection_revision","package_hash","token_hash","expires_at"]},
 studio_generated_artifact_sources:{"SELECT":["company_id","project_id","artifact_id","archive_id","request_id","job_id","output_id","storage_version_id","archive_approved_by","file_facts"]},
 higgsfield_output_archives:{"SELECT":["id","company_id","project_id","request_id","job_id","output_id","version_id","upload_id","locator_identity","approved_by","provider_connection_id","storage_binding_id","storage_connection_id","storage_connection_snapshot","status","revoked_at"],"UPDATE":["created_at"]},
 higgsfield_jobs:{"SELECT":["company_id","project_id","id","request_id","connection_id","status"],"UPDATE":["created_at"]},
 higgsfield_requests:{"SELECT":["company_id","project_id","id","connection_id","status"],"UPDATE":["created_at"]},
 higgsfield_job_outputs:{"SELECT":["company_id","project_id","id","job_id","locator_identity"]},
 higgsfield_archive_fetches:{"SELECT":["company_id","project_id","archive_id","locator_identity","bytes","sha256"]},
};
const migrations=[
 '001_initial.sql','002_calls.sql','003_agent_submission_summary.sql','004_identity_and_review_boundaries.sql','005_personal_avatars.sql','006_presence_interactions.sql',
 '007_conversations.sql','008_agent_runs.sql','009_agent_tools.sql','010_plugin_installations.sql','011_agent_missions.sql','012_studio.sql','013_studio_execution.sql',
 '014_studio_staffing.sql','015_studio_hosting.sql','016_studio_media.sql','017_studio_coordination.sql','018_studio_review_policy.sql','019_studio_host_provisioning.sql',
 '020_studio_client_delivery.sql','021_studio_inference.sql','022_studio_render_followups.sql','023_studio_creative_assets.sql','024_higgsfield_connections.sql',
 '025_studio_higgsfield_pipeline.sql','026_higgsfield_work_bindings.sql','027_project_storage.sql','028_higgsfield_jobs.sql','029_higgsfield_archives.sql','030_studio_generated_media.sql','031_studio_generated_followups.sql',
 '032_studio_generated_client_delivery.sql','033_studio_generated_revisions.sql','034_studio_coordinator_generation.sql',
];
export class ProjectStorageGatewayPreflightError extends Error{
 constructor(readonly code:'STORAGE_DB_IDENTITY'|'STORAGE_DB_ROLE'|'STORAGE_DB_SCHEMA'|'STORAGE_DB_MIGRATIONS'|'STORAGE_DB_PRIVILEGES'|'STORAGE_DB_CHECK_FAILED'){super(code);this.name='ProjectStorageGatewayPreflightError';}
}
function fail(code:ProjectStorageGatewayPreflightError['code']):never{throw new ProjectStorageGatewayPreflightError(code);}
const userSchema="n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'";
const privileges:Privilege[]=['SELECT','INSERT','UPDATE','REFERENCES'];

export async function assertProjectStorageGatewayDatabase(db:Db){
 try{
  const identity=(await db.query(`SELECT current_user::text AS current_user,session_user::text AS session_user,
   r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   current_setting('server_version_num')::integer AS version,
   EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS member_of_role,
   d.datdba=r.oid AS owns_database,pg_catalog.has_database_privilege(current_user,d.oid,'CREATE') AS database_create,
   pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS public_usage
   FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!identity||identity.current_user!==PROJECT_STORAGE_GATEWAY_ROLE||identity.session_user!==PROJECT_STORAGE_GATEWAY_ROLE)fail('STORAGE_DB_IDENTITY');
  if(identity.rolcanlogin!==true||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','member_of_role','owns_database','database_create'].some(key=>identity[key]!==false))fail('STORAGE_DB_ROLE');
  if(identity.public_usage!==true)fail('STORAGE_DB_SCHEMA');
  const schema=(await db.query(`SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE ${userSchema}
   AND (n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) LIMIT 1`)).rows;
  if(schema.length)fail('STORAGE_DB_SCHEMA');
  const saved=(await db.query('SELECT name FROM public.schema_migrations WHERE name=ANY($1::text[])',[migrations])).rows;
  if(new Set(saved.map(row=>row.name)).size!==migrations.length)fail('STORAGE_DB_MIGRATIONS');
  const tablePrivileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER',...Number(identity.version)>=170000?['MAINTAIN']:[]];
  const tables=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
   c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,p.privilege,
   pg_catalog.has_table_privilege(current_user,c.oid,p.privilege) AS allowed,
   pg_catalog.has_table_privilege(current_user,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN unnest($1::text[]) p(privilege) WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[tablePrivileges])).rows;
  const found=new Set<string>();
  for(const row of tables){
   const spec=row.schema==='public'&&typeof row.name==='string'?contract[row.name]:undefined;
   if(spec){found.add(row.name as string);if(row.kind!=='r')fail('STORAGE_DB_SCHEMA');}
   const expected=spec?.[row.privilege as Privilege]==='*';
   if(row.owned!==false||row.grantable!==false||row.allowed!==expected)fail('STORAGE_DB_PRIVILEGES');
  }
  if(Object.keys(contract).some(name=>!found.has(name)))fail('STORAGE_DB_SCHEMA');
  const columns=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,a.attname AS column,p.privilege,
   pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege) AS allowed,
   pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   CROSS JOIN unnest($1::text[]) p(privilege) WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[privileges])).rows;
  const foundColumns=new Set<string>();
  for(const row of columns){
   const spec=row.schema==='public'&&typeof row.name==='string'?contract[row.name]?.[row.privilege as Privilege]:undefined;
   const expected=spec==='*'||Array.isArray(spec)&&spec.includes(row.column);
   if(row.grantable!==false||row.allowed!==expected)fail('STORAGE_DB_PRIVILEGES');
   foundColumns.add(`${row.schema}.${row.name}.${row.column}.${row.privilege}`);
  }
  for(const [table,spec]of Object.entries(contract))for(const privilege of privileges){const required=spec[privilege];if(Array.isArray(required)&&required.some(column=>!foundColumns.has(`public.${table}.${column}.${privilege}`)))fail('STORAGE_DB_SCHEMA');}
  const escaped=(await db.query(`SELECT 'sequence' AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE ${userSchema} AND c.relkind='S' AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    OR pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE'))
   UNION ALL SELECT 'function' AS kind FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE ${userSchema} AND (p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    OR p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) LIMIT 1`)).rows;
  if(escaped.length)fail('STORAGE_DB_PRIVILEGES');
  return {status:'passed' as const,role:PROJECT_STORAGE_GATEWAY_ROLE,contractVersion:1 as const,migrationFloor:34 as const,checkedMigrations:migrations.length,
   boundary:'Authenticated dedicated LOGIN, role attributes/memberships, database/schema creation and ownership, effective non-system relation/column grants and grant options, sequence access, and owned or callable SECURITY DEFINER non-system functions.'};
 }catch(error){if(error instanceof ProjectStorageGatewayPreflightError)throw error;fail('STORAGE_DB_CHECK_FAILED');}
}

