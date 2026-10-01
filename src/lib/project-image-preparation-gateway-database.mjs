/** Explicit opt-in trusted gateway extension. No grants or runtime activation.
 * The ordinary storage preflight continues to reject this added authority. */
import {PROJECT_STORAGE_GATEWAY_ROLE,PROJECT_STORAGE_GATEWAY_CONTRACT,PROJECT_STORAGE_GATEWAY_MIGRATIONS,assertProjectStorageGatewayDatabaseContract} from './project-storage-preflight.js';
import {IMAGE_PREPARATION_STATE_GUARDS} from './project-image-preparation-database.mjs';

export const IMAGE_PREPARATION_GATEWAY_DELTA={
  "project_image_preparations": {
    "SELECT": [
      "id",
      "company_id",
      "project_id",
      "work_item_id",
      "project_revision",
      "project_snapshot",
      "work_snapshot",
      "source_version_id",
      "source_snapshot",
      "destination_folder_id",
      "destination_name",
      "destination_snapshot",
      "storage_binding_id",
      "storage_binding_revision",
      "storage_connection_id",
      "storage_connection_revision",
      "storage_sponsor_id",
      "recipe_sha256",
      "request_hash",
      "purpose",
      "proposed_by",
      "proposed_agent_id",
      "proposed_run_id",
      "proposer_snapshot",
      "status",
      "revision",
      "lease_id",
      "lease_expires_at",
      "claimed_at",
      "attempt",
      "action_id",
      "action_operation",
      "transform_result",
      "transform_sha256",
      "cleanup_confirmed_at",
      "diagnostic_code",
      "revoked_by",
      "revoked_at",
      "created_at",
      "updated_at",
      "continuation_mode"
    ],
    "UPDATE": [
      "updated_at"
    ]
  },
  "project_image_preparation_approvals": {
    "SELECT": [
      "company_id",
      "project_id",
      "preparation_id",
      "approved_by",
      "approved_at",
      "approver_snapshot",
      "expires_at",
      "approval_hash",
      "processor_snapshot",
      "max_cost_microusd",
      "processing_consent",
      "derivative_write_consent",
      "adoption_consent"
    ]
  },
  "project_image_preparation_allocations": {
    "SELECT": [
      "company_id",
      "project_id",
      "preparation_id",
      "file_id",
      "version_id",
      "upload_id",
      "binding_revision_before",
      "binding_revision_after",
      "output_sha256",
      "output_bytes",
      "store_action_id",
      "created_at"
    ]
  },
  "project_image_preparation_services": {
    "SELECT": [
      "id",
      "company_id",
      "token_hash",
      "enrolled_by",
      "sponsor_role",
      "sponsor_joined_at",
      "location",
      "release_sha256",
      "qualification_sha256",
      "profile_sha256",
      "source_commit",
      "closure_sha256",
      "recipe_sha256",
      "transport",
      "created_at",
      "expires_at",
      "revoked_at",
      "revoked_by",
      "revision",
      "updated_at"
    ],
    "UPDATE": [
      "updated_at"
    ]
  },
  "project_image_preparation_service_projects": {
    "SELECT": [
      "service_id",
      "company_id",
      "project_id",
      "project_revision",
      "storage_binding_id",
      "storage_binding_revision",
      "storage_connection_id",
      "storage_connection_revision",
      "gateway_binding_id",
      "gateway_provision_id",
      "gateway_configuration_sha256",
      "gateway_origin",
      "gateway_expires_at"
    ]
  },
  "project_image_preparation_service_leases": {
    "SELECT": [
      "service_id",
      "company_id",
      "project_id",
      "preparation_id",
      "lease_id",
      "request_hash",
      "lease",
      "created_at"
    ]
  },
  "project_image_preparation_byte_grants": {
    "SELECT": [
      "id",
      "service_id",
      "company_id",
      "project_id",
      "preparation_id",
      "lease_id",
      "request_id",
      "request_hash",
      "token_hash",
      "operation",
      "action_id",
      "version_id",
      "upload_id",
      "bytes",
      "sha256",
      "content_type",
      "expected_etag",
      "storage_binding_id",
      "storage_binding_revision",
      "storage_connection_id",
      "storage_connection_revision",
      "gateway_binding_id",
      "gateway_provision_id",
      "gateway_configuration_sha256",
      "gateway_origin",
      "expires_at",
      "created_at"
    ]
  },
  "project_image_preparation_service_enrollments": {
    "SELECT": [
      "service_id",
      "company_id",
      "request_id",
      "request_hash",
      "identity"
    ]
  },
  "project_image_preparation_receipts": {
    "SELECT": [
      "company_id",
      "preparation_id",
      "action_id",
      "operation",
      "phase"
    ]
  },
  "project_image_preparation_byte_results": {
    "SELECT": [
      "grant_id",
      "status"
    ],
    "INSERT": [
      "grant_id",
      "status"
    ],
    "UPDATE": [
      "status",
      "public_result",
      "provider_result",
      "observed_bytes",
      "observed_sha256",
      "observed_etag",
      "finished_at"
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
  "studio_image_preparation_dispatches": {
    "SELECT": [
      "company_id",
      "project_id",
      "work_item_id",
      "run_id",
      "authority_version",
      "coordination"
    ]
  },
  "studio_planning_review_decisions": {
    "SELECT": [
      "company_id",
      "review_id",
      "decision",
      "project_revision_before",
      "project_revision_after",
      "task_revision"
    ]
  },
  "task_authors": {
    "SELECT": [
      "task_id",
      "user_id"
    ]
  },
  "contributions": {
    "SELECT": [
      "company_id",
      "task_id",
      "agent_id"
    ]
  },
  "users": {
    "SELECT": [
      "id",
      "name"
    ]
  },
  "project_storage_folders": {
    "SELECT": [
      "id",
      "company_id",
      "project_id",
      "parent_id",
      "name",
      "name_key",
      "binding_id"
    ],
    "UPDATE": [
      "created_at"
    ]
  },
  "studio_work_items": {
    "UPDATE": [
      "id"
    ]
  },
  "studio_role_bindings": {
    "UPDATE": [
      "created_at"
    ]
  },
  "studio_profiles": {
    "UPDATE": [
      "updated_at"
    ]
  },
  "project_storage_versions": {
    "UPDATE": [
      "created_at"
    ]
  }
};
export const IMAGE_PREPARATION_GATEWAY_LOCK_TABLES=Object.freeze(["project_image_preparations","project_image_preparation_services","project_storage_folders","studio_work_items","studio_role_bindings","studio_profiles","project_storage_versions"]);
export const IMAGE_PREPARATION_GATEWAY_LOCK_BODY="BEGIN\n IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN\n  RAISE EXCEPTION 'Preparation gateway authority rows are read only' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND";

for(const spec of Object.values(IMAGE_PREPARATION_GATEWAY_DELTA)){for(const columns of Object.values(spec))Object.freeze(columns);Object.freeze(spec);}Object.freeze(IMAGE_PREPARATION_GATEWAY_DELTA);
const contract=Object.fromEntries(Object.entries(PROJECT_STORAGE_GATEWAY_CONTRACT).map(([table,spec])=>[table,{...spec}]));
for(const [table,spec] of Object.entries(IMAGE_PREPARATION_GATEWAY_DELTA)){
 const target=contract[table]??={};
 for(const [privilege,columns] of Object.entries(spec)){const current=target[privilege];target[privilege]=current==='*'?'*':Object.freeze([...new Set([...(current??[]),...columns])]);}
}
for(const spec of Object.values(contract))Object.freeze(spec);
export const IMAGE_PREPARATION_GATEWAY_CONTRACT=Object.freeze(contract);
const migrations=Object.freeze([...PROJECT_STORAGE_GATEWAY_MIGRATIONS,'050_project_image_preparation_services.sql']);
export class ImagePreparationGatewayDatabaseError extends Error{constructor(code){super(code);this.name='ImagePreparationGatewayDatabaseError';this.code=code;}}
/** @param {string} code @returns {never} */
const fail=code=>{throw new ImagePreparationGatewayDatabaseError(code);};
/** Requires a dedicated, independently authenticated LOGIN. SET ROLE is never
 * a runtime qualification. All checks are read-only and use shipped constants.
 * @param {{query:(sql:string,values?:any[])=>Promise<{rows:any[]}>}} db */
export async function assertImagePreparationGatewayDatabase(db){
 try{
  const result=await assertProjectStorageGatewayDatabaseContract(db,IMAGE_PREPARATION_GATEWAY_CONTRACT,migrations);
  const extra=(await db.query("SELECT r.rolinherit,pg_catalog.has_database_privilege(current_user,current_database(),'CONNECT') AS can_connect FROM pg_catalog.pg_roles r WHERE r.rolname=current_user")).rows[0];
  if(!extra||extra.rolinherit!==false||extra.can_connect!==true)fail('IMAGE_PREPARATION_GATEWAY_DB_ROLE');
  const guards=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgqual IS NULL AS no_when,t.tgattr::text AS update_columns,p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.proretset,p.prokind,p.prorettype='pg_catalog.trigger'::regtype AS trigger_return,pn.nspname AS function_schema,p.proname AS function_name,l.lanname,encode(t.tgargs,'escape') AS arguments FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public'`)).rows;
  const name='coatria_image_preparation_gateway_lock_guard';
  const expected=[...IMAGE_PREPARATION_GATEWAY_LOCK_TABLES.map(table=>({table,trigger:name,function:name,body:IMAGE_PREPARATION_GATEWAY_LOCK_BODY,args:PROJECT_STORAGE_GATEWAY_ROLE+'\\000',type:19})),...IMAGE_PREPARATION_STATE_GUARDS];
  for(const e of expected){const g=guards.find(v=>v.relname===e.table&&v.tgname===e.trigger);if(!g||g.tgenabled!==(e.enabled??'A')||g.tgtype!==e.type||g.no_when!==true||g.update_columns!==''||g.prosecdef!==(e.definer??false)||typeof g.prosrc!=='string'||g.prosrc.replaceAll('\r\n','\n').trim()!==e.body||g.arguments!==e.args||JSON.stringify(g.proconfig)!==JSON.stringify(e.config??['search_path=pg_catalog, public'])||g.function_schema!=='public'||g.function_name!==e.function||g.lanname!=='plpgsql'||g.pronargs!==0||g.proretset!==false||g.prokind!=='f'||g.trigger_return!==true)fail('IMAGE_PREPARATION_GATEWAY_DB_GUARD');}
  return {...result,mode:'image-preparation',contractVersion:1,migrationFloor:50,independentLogin:true,checkedGuards:expected.length};
 }catch(error){if(error instanceof ImagePreparationGatewayDatabaseError)throw error;if(error?.name==='ProjectStorageGatewayPreflightError')throw error;fail('IMAGE_PREPARATION_GATEWAY_DB_CHECK_FAILED');}
}
