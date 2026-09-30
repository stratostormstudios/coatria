/** Effective privilege boundary for the operator-only registrar. Never a worker
 * pool. Independent LOGIN verification is required after provisioning. */
export const HIGGSFIELD_REFERENCE_REGISTRAR_ROLE='coatria_higgsfield_reference_registrar_v1';
export const REFERENCE_REGISTRAR_CONTRACT={
 schema_migrations:{SELECT:'*'},
 companies:{SELECT:['id'],UPDATE:['created_at']},
 memberships:{SELECT:['company_id','user_id','role','access_revoked_at'],UPDATE:['joined_at']},
 studio_projects:{SELECT:['id','company_id','revision','status','ai_policy','production_path','contract_version','gates'],UPDATE:['updated_at']},
 higgsfield_connections:{SELECT:['company_id','id','revision','status','connected_by','tools'],UPDATE:['updated_at']},
 project_storage_connections:{SELECT:['id','company_id','revision','status','created_by'],UPDATE:['created_at']},
 project_storage_bindings:{SELECT:['id','company_id','project_id','connection_id','revision'],UPDATE:['created_at']},
 higgsfield_reference_services:{SELECT:'*',INSERT:'*'},
 higgsfield_reference_service_projects:{SELECT:'*',INSERT:'*'},
 higgsfield_reference_service_enrollments:{SELECT:'*',INSERT:'*'}
};
export const REFERENCE_REGISTRAR_LOCK_TABLES=['companies','memberships','studio_projects','higgsfield_connections','project_storage_connections','project_storage_bindings'];
export const REFERENCE_REGISTRAR_LOCK_BODY="BEGIN\n IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN\n  RAISE EXCEPTION 'Reference registrar authority rows are read only' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND";
export const REFERENCE_REGISTRAR_ENROLLMENT_BODY="BEGIN\n IF NEW IS DISTINCT FROM OLD THEN\n  RAISE EXCEPTION 'reference enrollment identity is immutable' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND";
const migrations=['039_higgsfield_references.sql','040_higgsfield_reference_inspection_authority.sql','041_higgsfield_model_contracts.sql','042_coordinated_reference_preparation.sql','043_higgsfield_reference_services.sql','044_higgsfield_reference_enrollments.sql'];
const userSchema="n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'";
export class HiggsfieldReferenceRegistrarDatabaseError extends Error{constructor(code){super(code);this.name='HiggsfieldReferenceRegistrarDatabaseError';this.code=code;}}
/** @param {string} code @returns {never} */
const fail=code=>{throw new HiggsfieldReferenceRegistrarDatabaseError(code);};
/** @param {{query:(sql:string,values?:any[])=>Promise<{rows:any[]}>}} db
 * @param {{provisioning?:boolean}} options SET ROLE allowed only in the owner
 * transaction before creating the independent registrar LOGIN connection. */
export async function assertHiggsfieldReferenceRegistrarDatabase(db,options={}){
 try{
  const role=(await db.query(`SELECT current_user::text AS current_user,session_user::text AS session_user,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   current_setting('server_version_num')::integer AS version,EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS member_of_role,
   d.datdba=r.oid AS owns_database,pg_catalog.has_database_privilege(current_user,d.oid,'CREATE') AS database_create,
   pg_catalog.has_database_privilege(current_user,d.oid,'CONNECT') AS can_connect,pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS public_usage
   FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!role||role.current_user!==HIGGSFIELD_REFERENCE_REGISTRAR_ROLE||!options.provisioning&&role.session_user!==HIGGSFIELD_REFERENCE_REGISTRAR_ROLE)fail('REFERENCE_REGISTRAR_DB_IDENTITY');
  if(role.rolcanlogin!==true||role.can_connect!==true||['rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','member_of_role','owns_database','database_create'].some(k=>role[k]!==false))fail('REFERENCE_REGISTRAR_DB_ROLE');
  if(role.public_usage!==true||(await db.query(`SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${userSchema} AND (n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) LIMIT 1`)).rows.length)fail('REFERENCE_REGISTRAR_DB_SCHEMA');
  const saved=(await db.query('SELECT name FROM public.schema_migrations WHERE name=ANY($1::text[])',[migrations])).rows;if(new Set(saved.map(r=>r.name)).size!==migrations.length)fail('REFERENCE_REGISTRAR_DB_MIGRATIONS');
  const privileges=['SELECT','INSERT','UPDATE','REFERENCES'],tablePrivileges=[...privileges,'DELETE','TRUNCATE','TRIGGER',...Number(role.version)>=170000?['MAINTAIN']:[]];
  const tables=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,p.privilege,
   pg_catalog.has_table_privilege(current_user,c.oid,p.privilege) AS allowed,pg_catalog.has_table_privilege(current_user,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($1::text[]) p(privilege)
   WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[tablePrivileges])).rows,found=new Set();
  for(const row of tables){const spec=row.schema==='public'?REFERENCE_REGISTRAR_CONTRACT[row.name]:undefined;if(spec){found.add(row.name);if(row.kind!=='r')fail('REFERENCE_REGISTRAR_DB_SCHEMA');}if(row.owned!==false||row.grantable!==false||row.allowed!==(spec?.[row.privilege]==='*'))fail('REFERENCE_REGISTRAR_DB_PRIVILEGES');}
  if(Object.keys(REFERENCE_REGISTRAR_CONTRACT).some(name=>!found.has(name)))fail('REFERENCE_REGISTRAR_DB_SCHEMA');
  const columns=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,a.attname AS column,p.privilege,pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege) AS allowed,
   pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN unnest($1::text[]) p(privilege)
   WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[privileges])).rows,foundColumns=new Set();
  for(const row of columns){const spec=row.schema==='public'?REFERENCE_REGISTRAR_CONTRACT[row.name]?.[row.privilege]:undefined;if(row.grantable!==false||row.allowed!==(spec==='*'||Array.isArray(spec)&&spec.includes(row.column)))fail('REFERENCE_REGISTRAR_DB_PRIVILEGES');foundColumns.add(`${row.schema}.${row.name}.${row.column}.${row.privilege}`);}
  for(const [table,spec]of Object.entries(REFERENCE_REGISTRAR_CONTRACT))for(const privilege of privileges){const required=spec[privilege];if(Array.isArray(required)&&required.some(c=>!foundColumns.has(`public.${table}.${c}.${privilege}`)))fail('REFERENCE_REGISTRAR_DB_SCHEMA');}
  if((await db.query(`SELECT 'sequence' AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchema} AND c.relkind='S'
   AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE'))
   UNION ALL SELECT 'function' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${userSchema}
   AND (p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) LIMIT 1`)).rows.length)fail('REFERENCE_REGISTRAR_DB_PRIVILEGES');
  const guards=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgqual IS NULL AS no_when,t.tgattr::text AS update_columns,p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.proretset,p.prokind,
   p.prorettype='pg_catalog.trigger'::regtype AS trigger_return,pn.nspname AS function_schema,p.proname AS function_name,l.lanname,encode(t.tgargs,'escape') AS arguments
   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE n.nspname='public' AND t.tgname IN ('coatria_reference_registrar_lock_guard','higgsfield_reference_enrollment_immutable')`)).rows;
  const expected=[...REFERENCE_REGISTRAR_LOCK_TABLES.map(table=>({table,trigger:'coatria_reference_registrar_lock_guard',function:'coatria_reference_registrar_readonly_lock_guard',body:REFERENCE_REGISTRAR_LOCK_BODY,args:HIGGSFIELD_REFERENCE_REGISTRAR_ROLE+'\\000'})),{table:'higgsfield_reference_service_enrollments',trigger:'higgsfield_reference_enrollment_immutable',function:'guard_higgsfield_reference_enrollment',body:REFERENCE_REGISTRAR_ENROLLMENT_BODY,args:''}];
  if(guards.length!==expected.length)fail('REFERENCE_REGISTRAR_DB_GUARD');
  for(const e of expected){const g=guards.find(v=>v.relname===e.table&&v.tgname===e.trigger);if(!g||g.tgenabled!=='A'||g.tgtype!==19||g.no_when!==true||g.update_columns!==''||g.prosecdef!==false||g.prosrc.replaceAll('\r\n','\n').trim()!==e.body||g.arguments!==e.args||JSON.stringify(g.proconfig)!==JSON.stringify(['search_path=pg_catalog, public'])||g.function_schema!=='public'||g.function_name!==e.function||g.lanname!=='plpgsql'||g.pronargs!==0||g.proretset!==false||g.prokind!=='f'||g.trigger_return!==true)fail('REFERENCE_REGISTRAR_DB_GUARD');}
  return {status:'passed',role:HIGGSFIELD_REFERENCE_REGISTRAR_ROLE,contractVersion:1,independentLogin:!options.provisioning,checkedMigrations:migrations.length};
 }catch(error){if(error instanceof HiggsfieldReferenceRegistrarDatabaseError)throw error;fail('REFERENCE_REGISTRAR_DB_CHECK_FAILED');}
}
