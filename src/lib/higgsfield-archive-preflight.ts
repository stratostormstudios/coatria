/** Read-only startup checks for the trusted archive service. The ACL check covers
 * catalog boundary below at one point in time, not provider connectivity, RLS,
 * trusted function bodies, database administrator changes or OS isolation. */
import {constants} from 'node:fs';
import {access,lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
export const HIGGSFIELD_ARCHIVE_WORKER_ROLE='coatria_higgsfield_archive_worker_v1';
type Db={query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Privilege='SELECT'|'INSERT'|'UPDATE'|'REFERENCES';
type Contract=Partial<Record<Privilege,'*'|readonly string[]>>;
const contract:Readonly<Record<string,Contract>>={
 schema_migrations:{SELECT:'*'},companies:{SELECT:['id'],UPDATE:['created_at']},
 memberships:{SELECT:['company_id','user_id','role'],UPDATE:['joined_at']},
 studio_projects:{SELECT:['id','company_id','revision','status','ai_policy','gates','production_path'],UPDATE:['updated_at']},
 studio_role_bindings:{SELECT:['company_id','role_key','agent_id','human_id'],UPDATE:['created_at']},
 studio_work_items:{SELECT:['id','company_id','project_id','task_id','role_key','stage','execution']},
 agents:{SELECT:['id','company_id','created_by']},
 higgsfield_jobs:{SELECT:'*',UPDATE:['updated_at']},higgsfield_job_receipts:{SELECT:'*'},higgsfield_job_outputs:{SELECT:'*'},higgsfield_output_locators:{SELECT:'*'},
 higgsfield_requests:{SELECT:['id','company_id','project_id','status','requested_by','agent_id','run_id','approved_by','request_hash','connection_id','connection_revision','work_item_id','role_agent_id','role_human_id'],UPDATE:['updated_at']},
 higgsfield_connections:{SELECT:['company_id','id','revision','status','connected_by'],UPDATE:['updated_at']},
 project_storage_connections:{SELECT:'*',UPDATE:['created_at']},project_storage_bindings:{SELECT:'*',UPDATE:['revision']},project_storage_folders:{SELECT:'*',UPDATE:['created_at']},
 project_storage_files:{SELECT:'*',INSERT:'*',UPDATE:['created_at']},project_storage_versions:{SELECT:'*',INSERT:'*'},
 project_storage_uploads:{SELECT:'*',INSERT:'*',UPDATE:['status','provider_upload_id','provider_descriptor','provider_etag','active_part','action_id','action_expires_at','updated_at']},
 project_storage_upload_parts:{SELECT:'*',INSERT:'*'},project_storage_verifications:{SELECT:'*',INSERT:'*'},
 higgsfield_output_archives:{SELECT:'*',UPDATE:['status','lease_id','lease_expires_at','attempt_count','upload_id','version_id','diagnostic_code','updated_at']},
 higgsfield_archive_fetches:{SELECT:'*',INSERT:'*'},higgsfield_archive_receipts:{SELECT:'*',INSERT:'*'},
};
const migrations=[
 '001_initial.sql','002_calls.sql','003_agent_submission_summary.sql','004_identity_and_review_boundaries.sql','005_personal_avatars.sql','006_presence_interactions.sql',
 '007_conversations.sql','008_agent_runs.sql','009_agent_tools.sql','010_plugin_installations.sql','011_agent_missions.sql','012_studio.sql','013_studio_execution.sql',
 '014_studio_staffing.sql','015_studio_hosting.sql','016_studio_media.sql','017_studio_coordination.sql','018_studio_review_policy.sql','019_studio_host_provisioning.sql',
 '020_studio_client_delivery.sql','021_studio_inference.sql','022_studio_render_followups.sql','023_studio_creative_assets.sql','024_higgsfield_connections.sql',
 '025_studio_higgsfield_pipeline.sql','026_higgsfield_work_bindings.sql','027_project_storage.sql','028_higgsfield_jobs.sql','029_higgsfield_archives.sql',
];
export class HiggsfieldArchivePreflightError extends Error{
 constructor(readonly code:'ARCHIVE_DB_IDENTITY'|'ARCHIVE_DB_ROLE'|'ARCHIVE_DB_SCHEMA'|'ARCHIVE_DB_MIGRATIONS'|'ARCHIVE_DB_PRIVILEGES'|'ARCHIVE_DB_CHECK_FAILED'|'ARCHIVE_SCRATCH_INVALID'){super(code);this.name='HiggsfieldArchivePreflightError';}
}
function fail(code:HiggsfieldArchivePreflightError['code']):never{throw new HiggsfieldArchivePreflightError(code);}
const userSchema="n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'";
const privileges:Privilege[]=['SELECT','INSERT','UPDATE','REFERENCES'];

/** No probe file is created. Use the canonical path for subsequent worker IO;
 * mode alone does not prove that the service account can use a directory. */
export async function assertHiggsfieldArchiveScratchRoot(root:string){
 try{
  if(!root||!isAbsolute(root))fail('ARCHIVE_SCRATCH_INVALID');
  const supplied=await lstat(root);if(!supplied.isDirectory()||supplied.isSymbolicLink())fail('ARCHIVE_SCRATCH_INVALID');
  const canonical=await realpath(root),info=await lstat(canonical);
  if(!info.isDirectory()||info.isSymbolicLink()||process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid?.()))fail('ARCHIVE_SCRATCH_INVALID');
  await access(canonical,constants.R_OK|constants.W_OK|constants.X_OK);return canonical;
 }catch{fail('ARCHIVE_SCRATCH_INVALID');}
}

export async function assertHiggsfieldArchiveDatabase(db:Db){
 try{
  const identity=(await db.query(`SELECT current_user::text AS current_user,session_user::text AS session_user,
   r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   current_setting('server_version_num')::integer AS version,
   EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS member_of_role,
   d.datdba=r.oid AS owns_database,pg_catalog.has_database_privilege(current_user,d.oid,'CREATE') AS database_create,
   pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS public_usage
   FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!identity||identity.current_user!==HIGGSFIELD_ARCHIVE_WORKER_ROLE||identity.session_user!==HIGGSFIELD_ARCHIVE_WORKER_ROLE)fail('ARCHIVE_DB_IDENTITY');
  if(identity.rolcanlogin!==true||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','member_of_role','owns_database','database_create'].some(key=>identity[key]!==false))fail('ARCHIVE_DB_ROLE');
  if(identity.public_usage!==true)fail('ARCHIVE_DB_SCHEMA');
  const schema=(await db.query(`SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE ${userSchema}
   AND (n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) LIMIT 1`)).rows;
  if(schema.length)fail('ARCHIVE_DB_SCHEMA');
  const saved=(await db.query('SELECT name FROM public.schema_migrations WHERE name=ANY($1::text[])',[migrations])).rows;
  if(new Set(saved.map(row=>row.name)).size!==migrations.length)fail('ARCHIVE_DB_MIGRATIONS');
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
   if(spec){found.add(row.name as string);if(row.kind!=='r')fail('ARCHIVE_DB_SCHEMA');}
   const expected=spec?.[row.privilege as Privilege]==='*';
   if(row.owned!==false||row.grantable!==false||row.allowed!==expected)fail('ARCHIVE_DB_PRIVILEGES');
  }
  if(Object.keys(contract).some(name=>!found.has(name)))fail('ARCHIVE_DB_SCHEMA');
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
   if(row.grantable!==false||row.allowed!==expected)fail('ARCHIVE_DB_PRIVILEGES');
   foundColumns.add(`${row.schema}.${row.name}.${row.column}.${row.privilege}`);
  }
  for(const [table,spec]of Object.entries(contract))for(const privilege of privileges){const required=spec[privilege];if(Array.isArray(required)&&required.some(column=>!foundColumns.has(`public.${table}.${column}.${privilege}`)))fail('ARCHIVE_DB_SCHEMA');}
  const escaped=(await db.query(`SELECT 'sequence' AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE ${userSchema} AND c.relkind='S' AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    OR pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE'))
   UNION ALL SELECT 'function' AS kind FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE ${userSchema} AND (p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    OR p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) LIMIT 1`)).rows;
  if(escaped.length)fail('ARCHIVE_DB_PRIVILEGES');
  return {status:'passed' as const,role:HIGGSFIELD_ARCHIVE_WORKER_ROLE,contractVersion:1 as const,migrationFloor:29 as const,checkedMigrations:migrations.length,
   boundary:'Authenticated dedicated LOGIN, role attributes/memberships, database/schema creation and ownership, effective non-system relation/column grants and grant options, sequence access, and owned or callable SECURITY DEFINER non-system functions.'};
 }catch(error){if(error instanceof HiggsfieldArchivePreflightError)throw error;fail('ARCHIVE_DB_CHECK_FAILED');}
}
