/** Operator-only enrollment. No token generation, network provider operation,
 * worker enablement or automatic retry. The caller owns a fresh PG client. */
import {assertHiggsfieldReferenceRegistrarDatabase} from '../../src/lib/higgsfield-reference-registrar-database.mjs';
import {compatibleReferenceCatalogDigest} from '../../src/lib/higgsfield-reference-catalog.js';
import {ReferenceEnrollmentError,referenceEnrollmentFailure as fail,parseReferenceEnrollmentRequest,referenceEnrollmentHash,referenceEnrollmentCanonical as canonical,referenceEnrollmentCatalogHash,referenceEnrollmentLockKey} from '../../src/lib/higgsfield-reference-enrollment-contract.mjs';

/** @typedef {import('../../src/lib/higgsfield-reference-enrollment-contract.mjs').ReferenceEnrollmentRequest} Request */
/** @typedef {{query:(sql:string,values?:any[])=>Promise<{rows:any[],rowCount?:number|null}>}} Database */
/** @typedef {{status:'committed'|'absent',serviceId:string,requestId:string,requestHash:string,active:boolean,reason?:string}} Result */
const iso=value=>new Date(value).toISOString();
const authority=()=>fail('REFERENCE_ENROLLMENT_AUTHORITY');
const conflict=()=>fail('REFERENCE_ENROLLMENT_CONFLICT');
const same=(a,b)=>canonical(a)===canonical(b);

/** @param {Database} db @param {Request} request */
async function lockEnrollment(db,request){
 const company=(await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[request.companyId])).rows[0];
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[referenceEnrollmentLockKey(request)]);
 return !!company;
}
/** Reads immutable enrollment fields only after the original enrollment's
 * transaction lock has been acquired. Missing rows before that lock prove nothing.
 * @param {Database} db @param {Request} request */
async function existing(db,request){
 const services=(await db.query('SELECT *,expires_at>clock_timestamp() AS live FROM higgsfield_reference_services WHERE id=$1 OR token_hash=$2',[request.serviceId,request.tokenHash])).rows;
 const records=(await db.query('SELECT * FROM higgsfield_reference_service_enrollments WHERE service_id=$1 OR request_id=$2',[request.serviceId,request.requestId])).rows;
 const projects=(await db.query('SELECT * FROM higgsfield_reference_service_projects WHERE service_id=$1 ORDER BY project_id',[request.serviceId])).rows;
 if(!services.length&&!records.length&&!projects.length)return null;
 if(services.length!==1||records.length!==1||projects.length!==request.projects.length)conflict();
 const s=services[0],e=records[0];
 const identity={id:request.serviceId,company_id:request.companyId,token_hash:request.tokenHash,enrolled_by:request.enrolledBy,release_sha256:request.releaseSha256,qualification_sha256:request.qualificationSha256,profile_sha256:request.profileSha256,provider_connection_id:request.provider.connectionId,provider_connection_revision:request.provider.connectionRevision,catalog_sha256:request.provider.catalogSha256};
 if(Object.entries(identity).some(([key,value])=>s[key]!==value)||iso(s.expires_at)!==request.expiresAt||!same(s.upload_hosts,request.uploadHosts)||e.service_id!==request.serviceId||e.company_id!==request.companyId||e.request_id!==request.requestId||e.request_hash!==referenceEnrollmentHash(request)||!same(e.identity,request))conflict();
 const expected=request.projects.map(p=>({service_id:request.serviceId,company_id:request.companyId,project_id:p.projectId,storage_binding_id:p.storageBindingId,storage_binding_revision:p.storageBindingRevision,storage_connection_id:p.storageConnectionId,storage_connection_revision:p.storageConnectionRevision})).sort((a,b)=>a.project_id.localeCompare(b.project_id));
 if(!same(projects,expected))conflict();
 return s;
}

/** No provider/storage IO under these locks. Previews find sponsor IDs only;
 * exact metadata is reread after sorted membership and authority row locks.
 * @param {Database} db @param {Request} request */
async function currentAuthority(db,request){
 const connectionIds=[...new Set(request.projects.map(p=>p.storageConnectionId))].sort();
 const previewProvider=(await db.query('SELECT id,connected_by FROM higgsfield_connections WHERE company_id=$1',[request.companyId])).rows[0];
 const previewStorage=(await db.query('SELECT id,created_by FROM project_storage_connections WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[request.companyId,connectionIds])).rows;
 if(!previewProvider||previewProvider.id!==request.provider.connectionId||previewStorage.length!==connectionIds.length)authority();
 const sponsors=[...new Set([request.enrolledBy,previewProvider.connected_by,...previewStorage.map(c=>c.created_by)])].sort();
 const members=(await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE",[request.companyId,sponsors])).rows;
 if(members.length!==sponsors.length)authority();
 const projectIds=request.projects.map(p=>p.projectId).sort();
 const projects=(await db.query('SELECT id,company_id,revision,status,ai_policy,production_path,contract_version,gates FROM studio_projects WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[request.companyId,projectIds])).rows;
 if(projects.length!==projectIds.length||projects.some(p=>p.revision!==request.projects.find(r=>r.projectId===p.id)?.projectRevision||p.status==='delivered'||p.ai_policy!=='allowed'||p.production_path!=='higgsfield'||p.contract_version!==2||['brief','estimate','production'].some(g=>p.gates?.[g]?.decision!=='approved')))authority();
 const provider=(await db.query('SELECT company_id,id,revision,status,connected_by,tools FROM higgsfield_connections WHERE company_id=$1 FOR SHARE',[request.companyId])).rows[0];
 if(!provider||provider.id!==request.provider.connectionId||provider.revision!==request.provider.connectionRevision||provider.connected_by!==previewProvider.connected_by||provider.status!=='connected'||referenceEnrollmentCatalogHash(provider.tools)!==request.provider.catalogSha256)authority();
 try{compatibleReferenceCatalogDigest(provider.tools);}catch{authority();}
 const storage=(await db.query('SELECT id,company_id,revision,status,created_by FROM project_storage_connections WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[request.companyId,connectionIds])).rows;
 if(storage.length!==connectionIds.length||storage.some(c=>c.status!=='configured'||c.created_by!==previewStorage.find(p=>p.id===c.id)?.created_by||request.projects.some(p=>p.storageConnectionId===c.id&&p.storageConnectionRevision!==c.revision)))authority();
 const bindings=(await db.query('SELECT id,company_id,project_id,connection_id,revision FROM project_storage_bindings WHERE company_id=$1 AND project_id=ANY($2::uuid[]) ORDER BY project_id FOR SHARE',[request.companyId,projectIds])).rows;
 if(bindings.length!==projectIds.length||bindings.some(b=>{const p=request.projects.find(p=>p.projectId===b.project_id);return !p||b.id!==p.storageBindingId||b.revision!==p.storageBindingRevision||b.connection_id!==p.storageConnectionId;}))authority();
}

/** @param {Database} db @param {Request} request */
async function deadline(db,request){
 const row=(await db.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '60 minutes' AS valid",[request.expiresAt])).rows[0];
 if(row?.valid!==true)fail('REFERENCE_ENROLLMENT_EXPIRED');
}
/** @param {Database} db @param {Request} request @param {any} saved @returns {Promise<Result>} */
async function reconciled(db,request,saved){
 const base={status:'committed',serviceId:request.serviceId,requestId:request.requestId,requestHash:referenceEnrollmentHash(request)};
 if(saved.revoked_at)return {...base,active:false,reason:'revoked'};
 try{await currentAuthority(db,request);await deadline(db,request);}catch(error){if(error instanceof ReferenceEnrollmentError&&['REFERENCE_ENROLLMENT_AUTHORITY','REFERENCE_ENROLLMENT_EXPIRED'].includes(error.code))return {...base,active:false,reason:error.code==='REFERENCE_ENROLLMENT_EXPIRED'?'expired':'authority_changed'};throw error;}
 // Revocation needs no enrollment lock. Observe it again after authority waits.
 const fresh=(await db.query('SELECT revoked_at,expires_at>clock_timestamp() AS live FROM higgsfield_reference_services WHERE id=$1',[request.serviceId])).rows[0];
 return {...base,active:!!fresh&&!fresh.revoked_at&&fresh.live===true,...!fresh||fresh.revoked_at?{reason:'revoked'}:fresh.live!==true?{reason:'expired'}:{}};
}

/** @param {Database} db @param {unknown} input @param {boolean} reconcile @returns {Promise<Result>} */
async function run(db,input,reconcile){
 const request=parseReferenceEnrollmentRequest(input,{allowExpired:reconcile});
 let transaction=false,committing=false;
 try{
  await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
  await db.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SET LOCAL idle_in_transaction_session_timeout='20s'");
  await assertHiggsfieldReferenceRegistrarDatabase(db);
  const company=await lockEnrollment(db,request),saved=await existing(db,request);
  let result;
  if(saved)result=await reconciled(db,request,saved);
  else if(reconcile)result={status:'absent',serviceId:request.serviceId,requestId:request.requestId,requestHash:referenceEnrollmentHash(request),active:false};
  else{
   if(!company)authority();await currentAuthority(db,request);await deadline(db,request);
   await db.query('INSERT INTO higgsfield_reference_services(id,company_id,token_hash,enrolled_by,release_sha256,qualification_sha256,profile_sha256,provider_connection_id,provider_connection_revision,catalog_sha256,upload_hosts,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[request.serviceId,request.companyId,request.tokenHash,request.enrolledBy,request.releaseSha256,request.qualificationSha256,request.profileSha256,request.provider.connectionId,request.provider.connectionRevision,request.provider.catalogSha256,JSON.stringify(request.uploadHosts),request.expiresAt]);
   for(const p of [...request.projects].sort((a,b)=>a.projectId.localeCompare(b.projectId)))await db.query('INSERT INTO higgsfield_reference_service_projects(service_id,company_id,project_id,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision) VALUES($1,$2,$3,$4,$5,$6,$7)',[request.serviceId,request.companyId,p.projectId,p.storageBindingId,p.storageBindingRevision,p.storageConnectionId,p.storageConnectionRevision]);
   await db.query('INSERT INTO higgsfield_reference_service_enrollments(service_id,company_id,request_id,request_hash,identity) VALUES($1,$2,$3,$4,$5)',[request.serviceId,request.companyId,request.requestId,referenceEnrollmentHash(request),JSON.stringify(request)]);
   await deadline(db,request);result={status:'committed',serviceId:request.serviceId,requestId:request.requestId,requestHash:referenceEnrollmentHash(request),active:true};
  }
  committing=true;await db.query('COMMIT');transaction=false;return result;
 }catch(error){
  if(transaction)try{await db.query('ROLLBACK');}catch{/* Caller closes its client; no mutation retry. */}
  if(committing)fail('REFERENCE_ENROLLMENT_COMMIT_UNKNOWN');
  if(error instanceof ReferenceEnrollmentError)throw error;
  if(error?.code==='23505')conflict();
  fail(reconcile?'REFERENCE_ENROLLMENT_RECONCILE_UNKNOWN':'REFERENCE_ENROLLMENT_FAILED');
 }
}
/** @param {Database} db @param {unknown} request @returns {Promise<Result>} */
export const enrollReferenceService=(db,request)=>run(db,request,false);
/** Reconciliation is read-only even if the exact tuple is absent.
 * @param {Database} db @param {unknown} request @returns {Promise<Result>} */
export const reconcileReferenceService=(db,request)=>run(db,request,true);
