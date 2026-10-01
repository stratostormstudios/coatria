/** Read-only dedicated broker startup boundary. It proves effective database
 * privileges at this instant, not provider, host, runtime or tenant qualification.
 * Keep the SQL grant file and this allowlist in lockstep. */
export const HIGGSFIELD_REFERENCE_BROKER_ROLE='coatria_higgsfield_reference_broker_v1';
export const REFERENCE_BROKER_CONTRACT={
 "schema_migrations": {
  "SELECT": "*"
 },
 "companies": {
  "SELECT": [
   "id"
  ],
  "UPDATE": [
   "created_at"
  ]
 },
 "memberships": {
  "SELECT": [
   "company_id",
   "user_id",
   "role",
   "access_revoked_at",
   "joined_at"
  ],
  "UPDATE": [
   "joined_at"
  ]
 },
 "users": {
  "SELECT": [
   "id",
   "name",
   "email",
   "role_title",
   "avatar_color",
   "avatar_id",
   "email_verified_at"
  ]
 },
 "studio_projects": {
  "SELECT": "*",
  "UPDATE": [
   "updated_at"
  ]
 },
 "studio_role_bindings": {
  "SELECT": "*",
  "UPDATE": [
   "created_at"
  ]
 },
 "studio_work_items": {
  "SELECT": "*"
 },
 "tasks": {
  "SELECT": "*",
  "UPDATE": [
   "updated_at"
  ]
 },
 "studio_dependencies": {
  "SELECT": "*"
 },
 "studio_dispatches": {
  "SELECT": "*"
 },
 "studio_reference_preparation_dispatches": {
  "SELECT": "*"
 },
 "studio_reference_generation_handoffs": {"SELECT":"*"},
 "studio_reference_generation_inspection_adoptions": {"SELECT":"*"},
 "studio_reference_generation_adoption_facts": {"SELECT":"*"},
 "studio_generated_revision_rounds": {
  "SELECT": [
   "id",
   "company_id",
   "project_id",
   "number",
   "plan_sha256"
  ]
 },
 "studio_generated_revision_work": {
  "SELECT": [
   "company_id",
   "project_id",
   "round_id",
   "work_item_id"
  ]
 },
 "agents": {
  "SELECT": [
   "id",
   "company_id",
   "created_by",
   "token_hash",
   "managed_token_hash",
   "invocation_access",
   "capabilities",
   "status",
   "expires_at"
  ],
  "UPDATE": [
   "last_seen_at"
  ]
 },
 "agent_runs": {
  "SELECT": [
   "id",
   "company_id",
   "agent_id",
   "requested_by",
   "purpose",
   "status",
   "capabilities",
   "attempts",
   "max_attempts",
   "started_at",
   "finished_at",
   "result_message_id",
   "lease_token_hash",
   "lease_expires_at"
  ],
  "UPDATE": [
   "updated_at"
  ]
 },
 "agent_run_receipts": {
  "SELECT": [
   "company_id",
   "run_id",
   "kind",
   "response"
  ]
 },
 "agent_tool_receipts": {
  "SELECT": [
   "company_id",
   "agent_id",
   "run_id",
   "tool",
   "response"
  ]
 },
 "plugin_installations": {
  "SELECT": [
   "id",
   "company_id",
   "agent_id",
   "revision"
  ],
  "UPDATE": [
   "updated_at"
  ]
 },
 "studio_host_credentials": {
  "SELECT": [
   "company_id",
   "agent_id",
   "host_id",
   "installation_id",
   "token_hash",
   "revoked_at",
   "expires_at",
   "host_epoch",
   "installation_revision",
   "enrolled_by"
  ]
 },
 "studio_managed_hosts": {
  "SELECT": [
   "id",
   "company_id",
   "created_by",
   "status",
   "expires_at",
   "lease_expires_at",
   "lease_epoch"
  ]
 },
 "studio_coordination_dispatches": {
  "SELECT": "*"
 },
 "studio_coordination_followups": {
  "SELECT": [
   "company_id",
   "child_run_id"
  ]
 },
 "studio_generated_followups": {
  "SELECT": [
   "company_id",
   "child_run_id"
  ]
 },
 "agent_mission_cycles": {
  "SELECT": [
   "company_id",
   "run_id"
  ]
 },
 "studio_planning_reviews": {
  "SELECT": [
   "id",
   "company_id",
   "project_id",
   "work_item_id",
   "task_id",
   "producer_agent_id",
   "producer_run_id",
   "task_revision",
   "reviewer_agent_id",
   "reviewer_run_id"
  ]
 },
 "studio_planning_review_decisions": {
  "SELECT": [
   "company_id",
   "review_id",
   "decision"
  ]
 },
 "higgsfield_connections": {
  "SELECT": [
   "company_id",
   "id",
   "revision",
   "status",
   "connected_by",
   "tools"
  ],
  "UPDATE": [
   "updated_at"
  ]
 },
 "project_storage_connections": {
  "SELECT": "*",
  "UPDATE": [
   "created_at"
  ]
 },
 "project_storage_bindings": {
  "SELECT": "*",
  "UPDATE": [
   "created_at"
  ]
 },
 "project_storage_files": {
  "SELECT": "*"
 },
 "project_storage_versions": {
  "SELECT": "*"
 },
 "project_storage_verifications": {
  "SELECT": "*"
 },
 "higgsfield_references": {
  "SELECT": "*",
  "UPDATE": [
   "status",
   "revision",
   "lease_id",
   "lease_expires_at",
   "action_id",
   "action_operation",
   "diagnostic_code",
   "updated_at",
   "inspection_attempts"
  ]
 },
 "higgsfield_reference_inspections": {
  "SELECT": "*",
  "INSERT": "*"
 },
 "higgsfield_reference_receipts": {
  "SELECT": "*",
  "INSERT": "*"
 },
 "higgsfield_reference_transports": {
  "SELECT": "*",
  "INSERT": "*"
 },
 "higgsfield_reference_confirmations": {
  "SELECT": "*",
  "INSERT": "*"
 },
 "higgsfield_reference_services": {
  "SELECT": "*",
  "UPDATE": [
   "updated_at"
  ]
 },
 "higgsfield_reference_service_projects": {
  "SELECT": "*"
 },
 "higgsfield_reference_service_enrollments": {
  "SELECT": ["service_id","company_id","request_id","request_hash","identity"]
 },
 "higgsfield_reference_service_leases": {
  "SELECT": "*",
  "INSERT": "*"
 },
 "higgsfield_reference_service_calls": {
  "SELECT": "*",
  "INSERT": "*",
  "UPDATE": [
   "status",
   "response",
   "finished_at"
  ]
 },
 "studio_coordination_policies": {
  "SELECT": "*",
  "UPDATE": [
   "updated_at"
  ]
 },
 "studio_profiles": {
  "SELECT": [
   "company_id",
   "revision"
  ],
  "UPDATE": ["updated_at"]
 },
 "higgsfield_reference_service_reads": {
  "SELECT": "*",
  "INSERT": "*"
 }
};
const lockTables=["companies","memberships","studio_projects","studio_role_bindings","tasks","agents","agent_runs","plugin_installations","higgsfield_connections","project_storage_connections","project_storage_bindings","higgsfield_reference_services","studio_coordination_policies","studio_profiles"];
export const REFERENCE_BROKER_LOCK_BODY="BEGIN\n IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN\n  RAISE EXCEPTION 'Reference broker authority rows are read only' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND";
const migrations=['039_higgsfield_references.sql','040_higgsfield_reference_inspection_authority.sql','041_higgsfield_model_contracts.sql','042_coordinated_reference_preparation.sql','043_higgsfield_reference_services.sql','044_higgsfield_reference_enrollments.sql','045_project_image_preparations.sql','046_project_image_preparation_storage.sql','047_project_image_preparation_handoff.sql','048_project_image_preparation_dispatch.sql','049_studio_reference_generation_continuations.sql'];
// Frozen migration 043/049 bodies, not loaded from mutable migration files at runtime.
export const REFERENCE_BROKER_STATE_GUARDS=[
  {
    "table": "higgsfield_references",
    "trigger": "higgsfield_reference_broker_attempts",
    "function": "guard_higgsfield_reference_broker_attempts",
    "body": "DECLARE adoption record;maximum integer;deadline timestamptz;durable boolean;\nBEGIN\n IF current_user<>'coatria_higgsfield_reference_broker_v1' THEN RETURN NEW;END IF;\n durable:=OLD.inspection_authority IS NOT NULL;maximum:=3;deadline:=OLD.inspect_expires_at;\n IF OLD.generation_handoff_id IS NOT NULL THEN\n  SELECT a.* INTO adoption FROM public.studio_reference_generation_inspection_adoptions a\n  JOIN public.memberships m ON m.company_id=a.company_id AND m.user_id=a.approved_by\n  WHERE a.company_id=OLD.company_id AND a.project_id=OLD.project_id AND a.reference_id=OLD.id\n   AND a.id=OLD.generation_inspection_adoption_id AND a.handoff_id=OLD.generation_handoff_id AND a.request_hash=OLD.request_hash AND a.max_attempts=1 AND a.inspection_consent\n   AND a.expires_at>clock_timestamp() AND a.expires_at<=OLD.inspect_expires_at\n   AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL\n   AND a.approver_snapshot->>'userId'=m.user_id::text AND a.approver_snapshot->>'role'=m.role\n   AND (a.approver_snapshot->>'joinedAt')::timestamptz=m.joined_at;\n  durable:=adoption.id IS NOT NULL AND OLD.inspection_authority IS NULL;maximum:=1;deadline:=adoption.expires_at;\n END IF;\n IF NEW.inspection_attempts IS DISTINCT FROM OLD.inspection_attempts OR\n  (NEW.status='inspecting' AND (NEW.inspection_authority IS NOT NULL OR NEW.generation_handoff_id IS NOT NULL) AND\n   (OLD.status<>'inspecting' OR NEW.lease_id IS DISTINCT FROM OLD.lease_id OR\n    (OLD.lease_expires_at<=clock_timestamp() AND NEW.lease_expires_at>clock_timestamp()))) THEN\n  IF NOT (durable AND NEW.inspection_attempts=OLD.inspection_attempts+1 AND NEW.inspection_attempts<=maximum\n   AND OLD.approved_by IS NULL AND OLD.revoked_at IS NULL AND OLD.status IN ('proposed','inspecting')\n   AND (OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp())\n   AND NEW.status='inspecting' AND NEW.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id\n   AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=OLD.inspect_expires_at\n   AND NEW.lease_expires_at<=deadline AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds') IS TRUE THEN\n   RAISE EXCEPTION 'reference inspection attempt transition rejected' USING ERRCODE='42501';\n  END IF;\n END IF;\n RETURN NEW;\nEND",
    "config": [
      "search_path=pg_catalog, public"
    ]
  },
  {
    "table": "higgsfield_reference_service_calls",
    "trigger": "higgsfield_reference_service_call_immutable",
    "function": "guard_higgsfield_reference_service_call",
    "body": "BEGIN\n IF (to_jsonb(NEW)-ARRAY['status','response','finished_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','response','finished_at'])\n  OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)\n  OR (NEW IS DISTINCT FROM OLD AND NOT (OLD.status='started' AND NEW.status='completed')) THEN\n  RAISE EXCEPTION 'reference service receipt is immutable' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND",
    "config": null
  },
  {
    "table": "higgsfield_reference_services",
    "trigger": "higgsfield_reference_service_stop",
    "function": "guard_higgsfield_reference_service_stop",
    "body": "BEGIN\n IF current_user='coatria_runtime_v1' AND NOT (\n  OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at<=clock_timestamp() AND NEW.revoked_by IS NOT NULL\n  AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at\n  AND (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revision','updated_at'])\n ) THEN RAISE EXCEPTION 'reference service can only be stopped' USING ERRCODE='42501'; END IF;\n RETURN NEW;\nEND",
    "config": null
  }
];
const adoptionViewDefinition="SELECT a.company_id, a.project_id, a.handoff_id, a.reference_id, p.id AS preparation_id, p.status AS preparation_status, p.revision AS preparation_revision, p.revoked_at, p.cleanup_confirmed_at, d.source_version_id, d.source_sha256, d.source_bytes, d.output_version_id, d.output_sha256, d.output_bytes, d.recipe_sha256, d.receipt_sha256 AS derivation_sha256 FROM studio_reference_generation_inspection_adoptions a JOIN studio_reference_generation_handoffs h ON h.company_id = a.company_id AND h.project_id = a.project_id AND h.id = a.handoff_id AND h.reference_id = a.reference_id JOIN project_image_preparations p ON p.company_id = h.company_id AND p.project_id = h.project_id AND p.id = h.preparation_id JOIN project_image_preparation_derivations d ON d.company_id = p.company_id AND d.project_id = p.project_id AND d.preparation_id = p.id;";
const userSchema="n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'";
export class HiggsfieldReferenceDatabaseError extends Error{
 constructor(code){super(code);this.name='HiggsfieldReferenceDatabaseError';this.code=code;}
}
/** @param {string} code @returns {never} */
const fail=code=>{throw new HiggsfieldReferenceDatabaseError(code);};
/** @param {{query:(sql:string,values?:any[])=>Promise<{rows:any[]}>}} db
 * @param {{provisioning?:boolean}} options Provisioning checks grants by SET ROLE
 * only before COMMIT; every runtime check requires the independent LOGIN. */
export async function assertHiggsfieldReferenceDatabase(db,options={}){
 try{
  const r=(await db.query(`SELECT current_user::text AS current_user,session_user::text AS session_user,
   r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   current_setting('server_version_num')::integer AS version,
   EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS member_of_role,
   d.datdba=r.oid AS owns_database,pg_catalog.has_database_privilege(current_user,d.oid,'CREATE') AS database_create,
   pg_catalog.has_database_privilege(current_user,d.oid,'CONNECT') AS can_connect,
   pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS public_usage
   FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!r||r.current_user!==HIGGSFIELD_REFERENCE_BROKER_ROLE||(!options.provisioning&&r.session_user!==HIGGSFIELD_REFERENCE_BROKER_ROLE))fail('REFERENCE_DB_IDENTITY');
  if(r.rolcanlogin!==true||r.can_connect!==true||['rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','member_of_role','owns_database','database_create'].some(k=>r[k]!==false))fail('REFERENCE_DB_ROLE');
  if(r.public_usage!==true)fail('REFERENCE_DB_SCHEMA');
  if((await db.query(`SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${userSchema} AND (n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) LIMIT 1`)).rows.length)fail('REFERENCE_DB_SCHEMA');
  const saved=(await db.query('SELECT name FROM public.schema_migrations WHERE name=ANY($1::text[])',[migrations])).rows;
  if(new Set(saved.map(row=>row.name)).size!==migrations.length)fail('REFERENCE_DB_MIGRATIONS');
  const privileges=['SELECT','INSERT','UPDATE','REFERENCES'];
  const tablePrivileges=[...privileges,'DELETE','TRUNCATE','TRIGGER',...Number(r.version)>=170000?['MAINTAIN']:[]];
  const tables=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
   c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,p.privilege,
   pg_catalog.has_table_privilege(current_user,c.oid,p.privilege) AS allowed,
   pg_catalog.has_table_privilege(current_user,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN unnest($1::text[]) p(privilege) WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[tablePrivileges])).rows;
  const found=new Set();
  for(const row of tables){
   const spec=row.schema==='public'?REFERENCE_BROKER_CONTRACT[row.name]:undefined;
   if(spec){found.add(row.name);if(row.kind!==(row.name==='studio_reference_generation_adoption_facts'?'v':'r'))fail('REFERENCE_DB_SCHEMA');}
   if(row.owned!==false||row.grantable!==false||row.allowed!==(spec?.[row.privilege]==='*'))fail('REFERENCE_DB_PRIVILEGES');
  }
  if(Object.keys(REFERENCE_BROKER_CONTRACT).some(name=>!found.has(name)))fail('REFERENCE_DB_SCHEMA');
  // One exact owner-defined view exposes only already-adopted derivation facts.
  // A replacement view cannot turn this exception into general storage access.
  const adoptionView=(await db.query(`SELECT pg_get_viewdef(c.oid,true) AS definition,c.reloptions FROM pg_catalog.pg_class c
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='studio_reference_generation_adoption_facts' AND c.relkind='v'`)).rows[0];
  if(!adoptionView||adoptionView.definition.replace(/\s+/g,' ').trim()!==adoptionViewDefinition||JSON.stringify(adoptionView.reloptions)!==JSON.stringify(['security_barrier=true']))fail('REFERENCE_DB_ADOPTION_VIEW');
  const columns=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,a.attname AS column,p.privilege,
   pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege) AS allowed,
   pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   CROSS JOIN unnest($1::text[]) p(privilege) WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[privileges])).rows;
  const foundColumns=new Set();
  for(const row of columns){
   const spec=row.schema==='public'?REFERENCE_BROKER_CONTRACT[row.name]?.[row.privilege]:undefined;
   const expected=spec==='*'||Array.isArray(spec)&&spec.includes(row.column);
   if(row.grantable!==false||row.allowed!==expected)fail('REFERENCE_DB_PRIVILEGES');
   foundColumns.add(`${row.schema}.${row.name}.${row.column}.${row.privilege}`);
  }
  for(const[table,spec]of Object.entries(REFERENCE_BROKER_CONTRACT))for(const privilege of privileges){
   const required=spec[privilege];if(Array.isArray(required)&&required.some(c=>!foundColumns.has(`public.${table}.${c}.${privilege}`)))fail('REFERENCE_DB_SCHEMA');
  }
  const escaped=(await db.query(`SELECT 'sequence' AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE ${userSchema} AND c.relkind='S' AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE'))
   UNION ALL SELECT 'function' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE ${userSchema} AND (p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) LIMIT 1`)).rows;
  if(escaped.length)fail('REFERENCE_DB_PRIVILEGES');
  const guards=(await db.query(`SELECT c.relname,t.tgenabled,t.tgtype,t.tgqual IS NULL AS no_when,t.tgattr::text AS update_columns,p.prosrc,p.prosecdef,p.proconfig,
   encode(t.tgargs,'escape') AS arguments FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
   WHERE n.nspname='public' AND t.tgname='coatria_reference_broker_lock_guard'
    AND pn.nspname='public' AND p.proname='coatria_reference_broker_readonly_lock_guard'`)).rows;
  for(const table of lockTables){
   const g=guards.find(v=>v.relname===table);
   if(!g||g.tgenabled!=='A'||g.tgtype!==19||g.no_when!==true||g.update_columns!==''||g.prosecdef!==false||g.prosrc.replaceAll('\r\n','\n').trim()!==REFERENCE_BROKER_LOCK_BODY||g.arguments!==HIGGSFIELD_REFERENCE_BROKER_ROLE+'\\000'||JSON.stringify(g.proconfig)!==JSON.stringify(['search_path=pg_catalog, public']))fail('REFERENCE_DB_LOCK_GUARD');
  }
  const stateGuards=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgqual IS NULL AS no_when,t.tgattr::text AS update_columns,p.prosecdef,p.prosrc,p.proconfig,p.pronargs,p.proretset,
   p.prokind,p.prorettype='pg_catalog.trigger'::regtype AS trigger_return,pn.nspname AS function_schema,p.proname AS function_name,l.lanname,
   encode(t.tgargs,'escape') AS arguments FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
   JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE n.nspname='public' AND t.tgname=ANY($1::text[])`,[REFERENCE_BROKER_STATE_GUARDS.map(g=>g.trigger)])).rows;
  if(stateGuards.length!==REFERENCE_BROKER_STATE_GUARDS.length)fail('REFERENCE_DB_STATE_GUARD');
  for(const expected of REFERENCE_BROKER_STATE_GUARDS){
   const g=stateGuards.find(row=>row.relname===expected.table&&row.tgname===expected.trigger);
   if(!g||!['A','O'].includes(g.tgenabled)||g.tgtype!==19||g.no_when!==true||g.update_columns!==''||g.prosecdef!==false||g.prosrc.replaceAll('\r\n','\n').trim()!==expected.body||
    g.function_schema!=='public'||g.function_name!==expected.function||g.lanname!=='plpgsql'||g.pronargs!==0||g.proretset!==false||
    g.prokind!=='f'||g.trigger_return!==true||g.arguments!==''||JSON.stringify(g.proconfig)!==JSON.stringify(expected.config))fail('REFERENCE_DB_STATE_GUARD');
  }
  return {status:'passed',role:HIGGSFIELD_REFERENCE_BROKER_ROLE,contractVersion:1,independentLogin:!options.provisioning,checkedMigrations:migrations.length};
 }catch(error){if(error instanceof HiggsfieldReferenceDatabaseError)throw error;fail('REFERENCE_DB_CHECK_FAILED');}
}
