/** Operator-only, transaction-owning image registrar. A caller supplies a fresh
 * independently authenticated registrar client and destroys it after uncertainty.
 * No token generation/publication, activation, provider I/O or mutation retry. */
import {assertImagePreparationRegistrarDatabase} from '../../src/lib/project-image-preparation-database.mjs';
import {ImagePreparationEnrollmentError,imagePreparationEnrollmentFailure as fail,parseImagePreparationEnrollmentRequest,imagePreparationEnrollmentHash,imagePreparationEnrollmentCanonical as canonical,imagePreparationEnrollmentLockKey} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
import {enrollImagePreparationService as insertEnrollment,verifiedImagePreparationServiceEnrollment} from '../../src/lib/project-image-preparation-enrollment.js';
import {verifiedImagePreparationGateway} from '../../src/lib/project-image-preparation-gateway-binding.js';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../../src/lib/higgsfield-image-preparation.js';

/** @typedef {import('../../src/lib/project-image-preparation-enrollment-contract.mjs').ImagePreparationEnrollmentRequest} Request */
/** @typedef {{query:(sql:string,values?:any[])=>Promise<{rows:any[],rowCount?:number|null}>}} Database */
/** @typedef {{status:'committed'|'absent',serviceId:string,requestId:string,requestHash:string,active:boolean,reason?:'revoked'|'expired'|'authority_changed'|'recipe_changed'}} Result */
const authority=()=>fail('IMAGE_PREPARATION_ENROLLMENT_AUTHORITY_ENDED');
const conflict=()=>fail('IMAGE_PREPARATION_ENROLLMENT_CONFLICT');
const same=(a,b)=>canonical(a)===canonical(b);

/** Both operations serialize before looking for absence, including after a
 * lost original COMMIT response. No service-row UPDATE privilege is borrowed.
 * @param {Database} db @param {Request} request */
async function lockEnrollment(db,request){
 const company=(await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[request.companyId])).rows[0];
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[imagePreparationEnrollmentLockKey(request)]);
 return Boolean(company);
}
/** Check all unique identities, including a token already assigned to another
 * service. Partial/cross-company/cross-request history is a conflict, not absent.
 * @param {Database} db @param {Request} request */
async function existing(db,request){
 const services=(await db.query(`SELECT *,to_char(sponsor_joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sponsor_joined_at
  FROM project_image_preparation_services WHERE id=$1 OR token_hash=$2`,[request.serviceId,request.tokenHash])).rows;
 const enrollments=(await db.query('SELECT service_id,company_id,request_id,request_hash,identity FROM project_image_preparation_service_enrollments WHERE service_id=$1 OR (company_id=$2 AND request_id=$3)',[request.serviceId,request.companyId,request.requestId])).rows;
 const projects=(await db.query('SELECT * FROM project_image_preparation_service_projects WHERE service_id=$1 ORDER BY project_id',[request.serviceId])).rows;
 if(!services.length&&!enrollments.length&&!projects.length)return null;
 if(services.length!==1||enrollments.length!==1||projects.length!==request.projects.length)conflict();
 try{const saved=verifiedImagePreparationServiceEnrollment(services[0],projects,enrollments[0]);if(!same(saved,request))conflict();}catch{conflict();}
 return services[0];
}
/** Metadata previews find all sponsors; their ordered membership locks precede
 * project/storage locks. The contract pins an exact role/epoch only for enroller;
 * other sponsors retain current role/revocation checks, not invented old epochs.
 * @param {Database} db @param {Request} request */
async function currentAuthority(db,request){
 const connectionIds=[...new Set(request.projects.map(p=>p.storageConnectionId))].sort(),projectIds=request.projects.map(p=>p.projectId).sort();
 const previewStorage=(await db.query('SELECT id,created_by FROM project_storage_connections WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[request.companyId,connectionIds])).rows;
 const previewGateways=(await db.query(`SELECT b.id,b.project_id,b.provision_id,b.verified_by,p.created_by FROM project_gateway_bindings b
  JOIN trusted_service_provisions p ON p.company_id=b.company_id AND p.id=b.provision_id
  WHERE b.company_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.id`,[request.companyId,request.projects.map(p=>p.gateway.bindingId)])).rows;
 if(previewStorage.length!==connectionIds.length||previewGateways.length!==projectIds.length)authority();
 for(const p of request.projects)if(!previewGateways.some(g=>g.id===p.gateway.bindingId&&g.project_id===p.projectId&&g.provision_id===p.gateway.provisionId))authority();
 const sponsors=[...new Set([request.enrolledBy,...previewStorage.map(c=>c.created_by),...previewGateways.flatMap(g=>[g.created_by,g.verified_by])])].sort();
 const members=(await db.query(`SELECT user_id,role,to_char(joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS joined_at
  FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE`,[request.companyId,sponsors])).rows;
 const enroller=members.find(m=>m.user_id===request.enrolledBy);
 if(members.length!==sponsors.length||!enroller||enroller.role!==request.enroller.role||enroller.joined_at!==request.enroller.joinedAt)authority();
 const projects=(await db.query('SELECT id,revision,status,production_path,ai_policy,contract_version,gates FROM studio_projects WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[request.companyId,projectIds])).rows;
 if(projects.length!==projectIds.length||projects.some(p=>p.revision!==request.projects.find(v=>v.projectId===p.id)?.projectRevision||p.status==='delivered'||p.production_path!=='higgsfield'||p.ai_policy!=='allowed'||p.contract_version!==2||['brief','estimate','production'].some(g=>p.gates?.[g]?.decision!=='approved')))authority();
 const storage=(await db.query('SELECT id,revision,status,created_by FROM project_storage_connections WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[request.companyId,connectionIds])).rows;
 if(storage.length!==connectionIds.length||storage.some(c=>c.status!=='configured'||c.created_by!==previewStorage.find(p=>p.id===c.id)?.created_by||request.projects.some(p=>p.storageConnectionId===c.id&&p.storageConnectionRevision!==c.revision)))authority();
 const bindings=(await db.query('SELECT id,project_id,connection_id,revision FROM project_storage_bindings WHERE company_id=$1 AND project_id=ANY($2::uuid[]) ORDER BY project_id FOR SHARE',[request.companyId,projectIds])).rows;
 if(bindings.length!==projectIds.length||bindings.some(b=>{const p=request.projects.find(p=>p.projectId===b.project_id);return !p||b.id!==p.storageBindingId||b.revision!==p.storageBindingRevision||b.connection_id!==p.storageConnectionId;}))authority();
 const gateways=(await db.query(`SELECT b.id,b.project_id,b.provision_id,b.verified_by,p.created_by FROM project_gateway_bindings b
  JOIN trusted_service_provisions p ON p.company_id=b.company_id AND p.id=b.provision_id
  WHERE b.company_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.id`,[request.companyId,request.projects.map(p=>p.gateway.bindingId)])).rows;
 if(!same(gateways,previewGateways))authority();
 for(const p of [...request.projects].sort((a,b)=>a.projectId.localeCompare(b.projectId))){
  const gateway=await verifiedImagePreparationGateway(db,request.companyId,p.projectId);
  if(!gateway||gateway.bindingId!==p.gateway.bindingId||gateway.provisionId!==p.gateway.provisionId||gateway.configurationHash!==p.gateway.configurationSha256||gateway.origin!==p.gateway.origin||gateway.expiresAt!==p.gateway.expiresAt)authority();
 }
}
/** @param {Database} db @param {Request} request */
async function deadline(db,request){
 const row=(await db.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '60 minutes' AND $2::timestamptz<=clock_timestamp() AS live",[request.expiresAt,request.qualification.acceptedAt])).rows[0];
 if(row?.live!==true)fail('IMAGE_PREPARATION_ENROLLMENT_EXPIRED');
}
/** Revocation of service/gateway rows uses separate authority. The registrar
 * cannot lock those rows: repeat current reads after all supported lock waits.
 * This reports final observation-time authority; broker checks every real action.
 * @param {Database} db @param {Request} request @param {any} saved @returns {Promise<Result>} */
async function reconciled(db,request,saved){
 const base={status:'committed',serviceId:request.serviceId,requestId:request.requestId,requestHash:imagePreparationEnrollmentHash(request)};
 if(saved.revoked_at)return {...base,active:false,reason:'revoked'};
 if(request.recipeSha256!==IMAGE_PREPARATION_RECIPE_HASH)return {...base,active:false,reason:'recipe_changed'};
 try{await currentAuthority(db,request);await deadline(db,request);}catch(error){if(error instanceof ImagePreparationEnrollmentError&&['IMAGE_PREPARATION_ENROLLMENT_AUTHORITY_ENDED','IMAGE_PREPARATION_ENROLLMENT_EXPIRED'].includes(error.code))return {...base,active:false,reason:error.code==='IMAGE_PREPARATION_ENROLLMENT_EXPIRED'?'expired':'authority_changed'};throw error;}
 const fresh=(await db.query('SELECT revoked_at,expires_at>clock_timestamp() AS live FROM project_image_preparation_services WHERE id=$1 AND company_id=$2',[request.serviceId,request.companyId])).rows[0];
 if(!fresh||fresh.revoked_at)return {...base,active:false,reason:'revoked'};
 if(fresh.live!==true)return {...base,active:false,reason:'expired'};
 return {...base,active:true};
}
/** @param {Database} db @param {unknown} input @param {boolean} reconcile @returns {Promise<Result>} */
async function run(db,input,reconcile){
 const request=parseImagePreparationEnrollmentRequest(input,{allowExpired:reconcile});
 if(!reconcile&&request.recipeSha256!==IMAGE_PREPARATION_RECIPE_HASH)fail('IMAGE_PREPARATION_ENROLLMENT_RECIPE_CHANGED');
 let transaction=false,committing=false;
 try{
  await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
  for(const setting of ["SET LOCAL search_path=pg_catalog,public","SET LOCAL lock_timeout='5s'","SET LOCAL statement_timeout='10s'","SET LOCAL idle_in_transaction_session_timeout='15s'"])await db.query(setting);
  await assertImagePreparationRegistrarDatabase(db);
  const company=await lockEnrollment(db,request),saved=await existing(db,request);let result;
  if(saved)result=await reconciled(db,request,saved);
  else if(reconcile)result={status:'absent',serviceId:request.serviceId,requestId:request.requestId,requestHash:imagePreparationEnrollmentHash(request),active:false};
  else{
   if(!company)authority();await currentAuthority(db,request);await deadline(db,request);
   // Reuse the existing three-table insertion contract only after stronger
   // collision and ordered authority admission; no mutation is retried here.
   await insertEnrollment(/** @type {import('pg').PoolClient} */(db),request);
   const committed=await existing(db,request);if(!committed)conflict();
   result=await reconciled(db,request,committed);
  }
  committing=true;await db.query('COMMIT');transaction=false;return result;
 }catch(error){
  if(transaction)try{await db.query('ROLLBACK');}catch{/* Caller must destroy the client; no mutation retry. */}
  if(committing)fail('IMAGE_PREPARATION_ENROLLMENT_COMMIT_UNKNOWN');
  if(error instanceof ImagePreparationEnrollmentError)throw error;
  if(error?.code==='23505')conflict();
  fail(reconcile?'IMAGE_PREPARATION_ENROLLMENT_RECONCILE_UNKNOWN':'IMAGE_PREPARATION_ENROLLMENT_FAILED');
 }
}
/** @param {Database} db @param {unknown} request @returns {Promise<Result>} */
export const enrollImagePreparationService=(db,request)=>run(db,request,false);
/** Read-only under the original transaction lock. Never inserts absent history.
 * @param {Database} db @param {unknown} request @returns {Promise<Result>} */
export const reconcileImagePreparationService=(db,request)=>run(db,request,true);
