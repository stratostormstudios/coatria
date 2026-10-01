/** Durable preparation control plane. Every method requires a caller-owned
 * transaction. Commit an intent before external work; no bytes or provider I/O
 * belong here. Runtime resolution is a trusted, database-only server dependency.
 * The default has no processor and cannot authorize execution. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {ApiError,fail,hashToken,id} from './security';
import {authorizeProjectStorageActor} from './project-storage';
import {managedAgentAuthorityPrincipals,managedAgentAuthoritySql} from './studio-hosting';
import {assertStudioTaskAction} from './studio';
import {IMAGE_PREPARATION_RECIPE_HASH} from './higgsfield-image-preparation';
import {IMAGE_PREPARATION_POLICY,preparationDimensions} from './higgsfield-image-preparation-policy';
import {
 PROJECT_IMAGE_PREPARATION_LIMITS as limits,projectImagePreparationProposalInput,
 projectImagePreparationApproveInput,projectImagePreparationRevokeInput,
 projectImagePreparationListInput,projectImagePreparationProcessorSchema,
 type ProjectImagePreparationActor as Actor,type ProjectImagePreparationProcessor as Processor,
 type ProjectImagePreparationDTO as Preparation,type ProjectImagePreparationLease as Lease,
 type ProjectImagePreparationPage as Page,type ProjectImagePreparationSource as Source,
 type ProjectImagePreparationSourceSnapshot as SourceSnapshot,
} from './project-image-preparations-protocol';

type Row=Record<string,any>;
export type ProjectImagePreparationOptions={runtime?:(db:PoolClient,companyId:string,projectId:string,processorId?:string)=>Promise<Processor|null>};
const caps=['storage.read','studio.read','studio.write','tasks.write'];
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)fail(400,'Use the exact file, revisions and explicit preparation consent.','VALIDATION_ERROR');return result.data;};
function canonical(value:unknown):string {
 if(value instanceof Date)return JSON.stringify(value.toISOString());
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 return JSON.stringify(value);
}
export const projectImagePreparationDigest=(value:unknown)=>hashToken(canonical(value));
const digest=projectImagePreparationDigest;
const plain=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const iso=(value:Date|string|null)=>value?new Date(value).toISOString():null;
const changed=(code='IMAGE_PREPARATION_AUTHORITY_CHANGED'):never=>fail(409,'The approved preparation changed. Review a new exact proposal.',code);
const safeSource=(s:SourceSnapshot):Source=>({versionId:s.versionId,fileId:s.fileId,name:s.name,version:s.version,bytes:s.bytes,sha256:s.sha256,contentType:s.contentType});
const memberSnapshot=(m:Row)=>({userId:m.user_id,role:m.role,joinedAt:m.joined_at});
const semanticProject=(p:Row)=>{const {updated_at:_,...facts}=p;return plain(facts);};
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const nameKey=(value:string)=>value.normalize('NFC').toLowerCase();

async function companyLock(db:PoolClient,companyId:string,busyIsError=true){
 if(!(await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[id(companyId)])).rowCount)fail(404,'Company not found.');
 // An authenticated agent tool may already own its run row. Never wait here
 // while a worker owns the company slot and is waiting for that same run.
 const acquired=(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['project-image-preparation:'+companyId])).rows[0].acquired;
 if(!acquired&&busyIsError)fail(409,'Another preparation operation is committing. Retry the same operation ID.','IMAGE_PREPARATION_BUSY');return Boolean(acquired);
}
async function principals(db:PoolClient,companyId:string,users:string[],agentId?:string){
 const ids=[...users];
 if(agentId){const agent=(await db.query('SELECT created_by FROM agents WHERE company_id=$1 AND id=$2',[companyId,id(agentId)])).rows[0];if(!agent)changed();ids.push(agent.created_by,...await managedAgentAuthorityPrincipals(db,companyId,agentId));}
 const unique=[...new Set(ids)].sort();unique.forEach(id);
 const members=(await db.query('SELECT user_id,role,joined_at::text AS joined_at,access_revoked_at FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[companyId,unique])).rows;
 if(members.length!==unique.length||members.some(m=>m.role==='removed'||m.access_revoked_at!==null))fail(403,'Current company access is required.','IMAGE_PREPARATION_MEMBERSHIP_REQUIRED');
 return members;
}
function requireAdmin(members:Row[],userId:string){const member=members.find(m=>m.user_id===userId);if(!member||!['owner','admin'].includes(member.role))fail(403,'A current company administrator is required.','IMAGE_PREPARATION_ADMIN_REQUIRED');return member;}
async function actor(db:PoolClient,value:Actor,admin=false){
 id(value.companyId);id(value.userId);if(Boolean(value.agentId)!==Boolean(value.runId))fail(403,'Use an authenticated agent run.','AGENT_RUN_REQUIRED');
 await authorizeProjectStorageActor(db,value,'storage.read',admin);
 const members=await principals(db,value.companyId,[value.userId],value.agentId);
 if(admin)requireAdmin(members,value.userId);
 if(value.agentId){
  const a=await agentFacts(db,value.companyId,value.agentId,value.runId!,value.userId,true);
  for(const m of members)requireAdmin(members,m.user_id);
  return a;
 }
 return null;
}
async function agentFacts(db:PoolClient,companyId:string,agentId:string,runId:string,userId:string,live=false){
 const r=(await db.query(`SELECT a.*,r.capabilities AS run_capabilities,r.requested_by,r.status AS run_status,
 r.lease_token_hash,r.lease_expires_at,r.lease_expires_at>clock_timestamp() AS live_lease
 FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id
 WHERE a.company_id=$1 AND a.id=$2 AND r.id=$3 AND r.requested_by=$4
 AND a.status='active' AND a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} FOR SHARE OF a,r`,[companyId,agentId,runId,userId])).rows[0];
 if(!r||caps.some(c=>!r.capabilities.includes(c)||!r.run_capabilities.includes(c))||live&&(r.run_status!=='running'||!r.lease_token_hash||!r.live_lease)||!live&&!['running','succeeded'].includes(r.run_status))fail(403,'Preparation needs the assigned agent and its current approved grants.','AGENT_CAPABILITY_REQUIRED');
 return {agentId,runId,requestedBy:userId,sponsorId:r.created_by,credentialSha256:r.token_hash,managedCredentialSha256:r.managed_token_hash??null,expiresAt:iso(r.expires_at),capabilities:[...r.capabilities].sort(),runCapabilities:[...r.run_capabilities].sort(),invocationAccess:r.invocation_access};
}
async function project(db:PoolClient,companyId:string,projectId:string){
 const p=(await db.query('SELECT * FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,id(projectId)])).rows[0];
 if(!p)fail(404,'Project not found.');
 if(p.status==='delivered'||p.ai_policy!=='allowed'||p.production_path!=='higgsfield'||['brief','estimate','production'].some(g=>p.gates[g]?.decision!=='approved'))changed('IMAGE_PREPARATION_PROJECT_CHANGED');
 return p;
}
async function work(db:PoolClient,companyId:string,projectId:string,workId:string,proposing?:Actor){
 await db.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[companyId]);
 const w=(await db.query(`SELECT w.*,t.status,t.revision AS task_revision,t.title,t.description,t.assignee_id,t.agent_run_id,
 b.agent_id AS role_agent_id,b.human_id AS role_human_id FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
 LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
 WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3 FOR SHARE OF w,t`,[companyId,projectId,id(workId)])).rows[0];
 if(!w)fail(404,'Preparation task not found in this project.');
 if(!['references','generation'].includes(w.stage)||!['agent','creative'].includes(w.execution)||!['todo','doing'].includes(w.status))changed('IMAGE_PREPARATION_WORK_CHANGED');
 let a:Row|undefined,r:Row|undefined;
 if(proposing?.agentId){
  if(w.status!=='doing'||w.role_agent_id!==proposing.agentId||w.agent_run_id!==proposing.runId)fail(403,'Reserve the assigned task for this agent run first.','STUDIO_TASK_RESERVATION_REQUIRED');
  a=(await db.query('SELECT * FROM agents WHERE company_id=$1 AND id=$2',[companyId,proposing.agentId])).rows[0];
  r=(await db.query('SELECT * FROM agent_runs WHERE company_id=$1 AND id=$2',[companyId,proposing.runId])).rows[0];
 }
 await assertStudioTaskAction(db,companyId,w.task_id,'project_image_preparation_propose',{},r,a);
 return plain(w);
}
async function storage(db:PoolClient,companyId:string,projectId:string){
 const b=(await db.query(`SELECT b.*,c.revision AS connection_revision,c.status AS connection_status,c.created_by AS sponsor,
 c.secret_envelope IS NOT NULL AS credentials FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id
 WHERE b.company_id=$1 AND b.project_id=$2 FOR SHARE OF b,c`,[companyId,projectId])).rows[0];
 if(!b||b.connection_status!=='configured'||!b.credentials)changed('IMAGE_PREPARATION_STORAGE_CHANGED');return b;
}
async function source(db:PoolClient,companyId:string,projectId:string,versionId:string,bindingId:string):Promise<SourceSnapshot>{
 const v=(await db.query(`SELECT v.*,f.name,f.binding_id,ok.sha256 AS verified_sha256,ok.provider_etag FROM project_storage_versions v
 JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)
 JOIN project_storage_verifications ok ON (ok.company_id,ok.project_id,ok.version_id)=(v.company_id,v.project_id,v.id)
 WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3 AND ok.bytes=v.bytes AND (v.sha256 IS NULL OR v.sha256=ok.sha256)
 FOR SHARE OF v,f,ok`,[companyId,projectId,id(versionId)])).rows[0];
 if(!v||v.binding_id!==bindingId)fail(404,'Verified image version not found in this project.');
 if(!['image/png','image/jpeg','image/webp'].includes(v.content_type)||Number(v.bytes)<1||Number(v.bytes)>limits.sourceMaxBytes)changed('IMAGE_PREPARATION_SOURCE_UNSUPPORTED');
 return {versionId:v.id,fileId:v.file_id,name:v.name,version:v.version,bytes:Number(v.bytes),sha256:v.verified_sha256,contentType:v.content_type,objectKey:v.object_key,providerEtag:v.provider_etag};
}
async function destination(db:PoolClient,companyId:string,projectId:string,folderId:string|null,name:string){
 const path:Row[]=[],seen=new Set<string>();let next=folderId;
 while(next){
  if(seen.has(next)||path.length>=12)changed('IMAGE_PREPARATION_DESTINATION_CHANGED');seen.add(next);
  const f=(await db.query('SELECT id,parent_id,name,name_key,binding_id FROM project_storage_folders WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE',[companyId,projectId,next])).rows[0];
  if(!f)fail(404,'Destination folder not found in this project.');path.push(f);next=f.parent_id;
 }
 if((await db.query(`SELECT id FROM project_storage_folders WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4
 UNION ALL SELECT id FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4 LIMIT 1`,[companyId,projectId,folderId,nameKey(name)])).rowCount)fail(409,'Use a new filename for the derivative.','STORAGE_NAME_CONFLICT');
 return {folderId,name,path};
}
async function approval(db:PoolClient,r:Row){return (await db.query('SELECT * FROM project_image_preparation_approvals WHERE company_id=$1 AND preparation_id=$2',[r.company_id,r.id])).rows[0] as Row|undefined;}
async function readRow(db:PoolClient,companyId:string,preparationId:string){const r=(await db.query('SELECT * FROM project_image_preparations WHERE company_id=$1 AND id=$2',[id(companyId),id(preparationId)])).rows[0];if(!r)fail(404,'Preparation not found.');return r;}
async function lockedRow(db:PoolClient,companyId:string,preparationId:string,extraUsers:string[]=[]){
 await companyLock(db,companyId);
 const scope=await readRow(db,companyId,preparationId),a=await approval(db,scope);
 const members=await principals(db,companyId,[scope.proposed_by,scope.storage_sponsor_id,...extraUsers,...a?[a.approved_by]:[]],scope.proposed_agent_id??undefined);
 if(scope.proposed_agent_id){
  await db.query('SELECT id FROM agents WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,scope.proposed_agent_id]);
  await db.query('SELECT id FROM agent_runs WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,scope.proposed_run_id]);
 }
 await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,scope.project_id]);
 const r=(await db.query('SELECT * FROM project_image_preparations WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,preparationId])).rows[0];if(!r)fail(404,'Preparation not found.');return {r,a,members};
}
async function view(db:PoolClient,r:Row,evidence?:{a:Row|null;d:Row|null}):Promise<Preparation>{
 const a=evidence?evidence.a:await approval(db,r),d=evidence?evidence.d:(await db.query('SELECT * FROM project_image_preparation_derivations WHERE company_id=$1 AND preparation_id=$2',[r.company_id,r.id])).rows[0];
 return {id:r.id,projectId:r.project_id,workItemId:r.work_item_id,projectRevision:r.project_revision,status:r.status,revision:r.revision,requestHash:r.request_hash,purpose:r.purpose,
 source:safeSource(r.source_snapshot),destinationFolderId:r.destination_folder_id,destinationName:r.destination_name,bindingId:r.storage_binding_id,bindingRevision:r.storage_binding_revision,
 storageConnectionId:r.storage_connection_id,storageConnectionRevision:r.storage_connection_revision,recipeSha256:r.recipe_sha256,proposedBy:r.proposed_by,proposedAgentId:r.proposed_agent_id,
 createdAt:iso(r.created_at)!,updatedAt:iso(r.updated_at)!,attempt:r.attempt,claimedAt:iso(r.claimed_at),cleanupConfirmedAt:iso(r.cleanup_confirmed_at),revokedAt:iso(r.revoked_at),diagnosticCode:r.diagnostic_code,
 approval:a?{approvedBy:a.approved_by,approvedAt:iso(a.approved_at)!,expiresAt:iso(a.expires_at)!,approvalHash:a.approval_hash,processor:a.processor_snapshot,maxCostMicrousd:Number(a.max_cost_microusd),processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true}:null,
 derivation:d?{sourceVersionId:d.source_version_id,outputFileId:d.output_file_id,outputVersionId:d.output_version_id,uploadId:d.upload_id,recipeSha256:d.recipe_sha256,sourceSha256:d.source_sha256,sourceBytes:Number(d.source_bytes),outputSha256:d.output_sha256,outputBytes:Number(d.output_bytes),outputWidth:d.output_width,outputHeight:d.output_height,receiptSha256:d.receipt_sha256,createdAt:iso(d.created_at)!}:null};
}
async function once(db:PoolClient,value:Actor,clientId:string,operation:string,data:unknown,run:()=>Promise<Row>){
 const actorKey=value.agentId?'agent:'+value.agentId:'human:'+value.userId,hash=digest({operation,data});
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`project-image-request:${value.companyId}:${actorKey}:${clientId}`]);
 const old=(await db.query('SELECT request_hash,response FROM project_image_preparation_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[value.companyId,actorKey,clientId])).rows[0];
 if(old){if(old.request_hash!==hash)fail(409,'This operation ID was already used for different details.','IDEMPOTENCY_CONFLICT');return {preparation:await view(db,await readRow(db,value.companyId,old.response.id)),replayed:true};}
 const r=await run();await db.query('INSERT INTO project_image_preparation_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[value.companyId,actorKey,clientId,hash,JSON.stringify({id:r.id})]);
 return {preparation:await view(db,r),replayed:false};
}
async function receipt(db:PoolClient,r:Row,actionId:string,operation:string,phase:string,detail:Row={}){await db.query('INSERT INTO project_image_preparation_receipts(company_id,project_id,preparation_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',[r.company_id,r.project_id,r.id,actionId,operation,phase,JSON.stringify(detail)]);}
async function facts(db:PoolClient,r:Row,members:Row[]){
 const p=await project(db,r.company_id,r.project_id);
 if(!same(semanticProject(p),r.project_snapshot)||p.revision!==r.project_revision)changed('IMAGE_PREPARATION_PROJECT_CHANGED');
 const b=await storage(db,r.company_id,r.project_id);requireAdmin(members,b.sponsor);
 if(b.id!==r.storage_binding_id||b.revision!==r.storage_binding_revision||b.connection_id!==r.storage_connection_id||b.connection_revision!==r.storage_connection_revision||b.sponsor!==r.storage_sponsor_id)changed('IMAGE_PREPARATION_STORAGE_CHANGED');
 if(!same(await source(db,r.company_id,r.project_id,r.source_version_id,b.id),r.source_snapshot))changed('IMAGE_PREPARATION_SOURCE_CHANGED');
 if(!same(await destination(db,r.company_id,r.project_id,r.destination_folder_id,r.destination_name),r.destination_snapshot))changed('IMAGE_PREPARATION_DESTINATION_CHANGED');
 if(!same(await work(db,r.company_id,r.project_id,r.work_item_id),r.work_snapshot))changed('IMAGE_PREPARATION_WORK_CHANGED');
 const old=r.proposer_snapshot,expected=members.filter(m=>old.members.some((s:Row)=>s.userId===m.user_id)).map(memberSnapshot);
 if(!same(expected,old.members))changed();
 if(r.proposed_agent_id){
  const a=await agentFacts(db,r.company_id,r.proposed_agent_id,r.proposed_run_id,r.proposed_by);
  if(!same(a,old.agent))changed();for(const m of expected)requireAdmin(members,m.userId);
 }
 if(r.recipe_sha256!==IMAGE_PREPARATION_RECIPE_HASH||limits.sourceMaxBytes!==IMAGE_PREPARATION_POLICY.sourceMaxBytes||limits.outputMaxBytes!==IMAGE_PREPARATION_POLICY.outputMaxBytes)changed('IMAGE_PREPARATION_RECIPE_CHANGED');
 return {p,b};
}
async function runtime(db:PoolClient,r:Row,options:ProjectImagePreparationOptions,processorId:string,expected?:Processor){
 const resolved=projectImagePreparationProcessorSchema.safeParse(await options.runtime?.(db,r.company_id,r.project_id,processorId));
 if(!resolved.success)fail(503,'A qualified image preparation processor is unavailable.','IMAGE_PREPARATION_UNAVAILABLE');
 const value=resolved.data;
 if(value.id!==processorId||value.recipeSha256!==r.recipe_sha256||!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[value.expiresAt])).rows[0].valid||expected&&!same(value,expected))changed('IMAGE_PREPARATION_PROCESSOR_CHANGED');return value;
}
export async function proposeProjectImagePreparation(db:PoolClient,value:Actor,input:unknown){
 const data=parse(projectImagePreparationProposalInput,input);await actor(db,value);await companyLock(db,value.companyId);
 return once(db,value,data.clientId,'propose',data,async()=>{
  const preview=(await db.query('SELECT c.created_by FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE b.company_id=$1 AND b.project_id=$2',[value.companyId,data.projectId])).rows[0];
  if(!preview)fail(404,'Project storage not found.');
  const members=await principals(db,value.companyId,[value.userId,preview.created_by],value.agentId);requireAdmin(members,preview.created_by);
  const p=await project(db,value.companyId,data.projectId);if(p.revision!==data.projectRevision)changed('IMAGE_PREPARATION_PROJECT_CHANGED');
  const w=await work(db,value.companyId,p.id,data.workItemId,value),b=await storage(db,value.companyId,p.id);if(b.sponsor!==preview.created_by)changed();
  const s=await source(db,value.companyId,p.id,data.sourceVersionId,b.id);if(s.sha256!==data.sourceSha256||s.bytes!==data.sourceBytes)changed('IMAGE_PREPARATION_SOURCE_CHANGED');
  const dest=await destination(db,value.companyId,p.id,data.destinationFolderId,data.destinationName),a=value.agentId?await agentFacts(db,value.companyId,value.agentId,value.runId!,value.userId,true):null;
  if((await db.query("SELECT count(*)::int n FROM project_image_preparations WHERE company_id=$1 AND status IN ('proposed','queued')",[value.companyId])).rows[0].n>=limits.maxQueuedPerCompany)fail(409,'Review or revoke queued preparations before adding more.','IMAGE_PREPARATION_QUEUE_FULL');
  const proposed={members:members.map(memberSnapshot),agent:a},snapshot=semanticProject(p);
  const hash=digest({version:1,companyId:value.companyId,project:snapshot,work:w,source:s,destination:dest,bindingId:b.id,bindingRevision:b.revision,connectionId:b.connection_id,connectionRevision:b.connection_revision,storageSponsorId:b.sponsor,recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,purpose:data.purpose,proposedBy:value.userId,proposer:proposed});
  return (await db.query(`INSERT INTO project_image_preparations(company_id,project_id,work_item_id,project_revision,project_snapshot,work_snapshot,source_version_id,source_snapshot,destination_folder_id,destination_name,destination_snapshot,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,storage_sponsor_id,recipe_sha256,request_hash,purpose,proposed_by,proposed_agent_id,proposed_run_id,proposer_snapshot)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,[value.companyId,p.id,data.workItemId,p.revision,JSON.stringify(snapshot),JSON.stringify(w),s.versionId,JSON.stringify(s),data.destinationFolderId,data.destinationName,JSON.stringify(dest),b.id,b.revision,b.connection_id,b.connection_revision,b.sponsor,IMAGE_PREPARATION_RECIPE_HASH,hash,data.purpose,value.userId,value.agentId??null,value.runId??null,JSON.stringify(proposed)])).rows[0];
 });
}
export async function getProjectImagePreparation(db:PoolClient,value:Actor,preparationId:string){await actor(db,value);return {preparation:await view(db,await readRow(db,value.companyId,preparationId))};}
export async function listProjectImagePreparations(db:PoolClient,value:Actor,input:unknown):Promise<Page>{
 const data=parse(projectImagePreparationListInput,input);await actor(db,value);
 if(!(await db.query('SELECT 1 FROM studio_projects WHERE company_id=$1 AND id=$2',[value.companyId,data.projectId])).rowCount)fail(404,'Project not found.');
 if(data.after&&(await readRow(db,value.companyId,data.after)).project_id!==data.projectId)fail(404,'Preparation not found in this project.');
 const rows=(await db.query(`SELECT p.*,row_to_json(a) AS approval_row,row_to_json(d) AS derivation_row FROM project_image_preparations p
 LEFT JOIN project_image_preparation_approvals a ON a.company_id=p.company_id AND a.preparation_id=p.id
 LEFT JOIN project_image_preparation_derivations d ON d.company_id=p.company_id AND d.preparation_id=p.id
 WHERE p.company_id=$1 AND p.project_id=$2 AND ($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT $4`,[value.companyId,data.projectId,data.after??null,data.limit+1])).rows;
 const preparations=[];for(const r of rows.slice(0,data.limit))preparations.push(await view(db,r,{a:r.approval_row,d:r.derivation_row}));return {preparations,hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?preparations.at(-1)!.id:null};
}
export async function approveProjectImagePreparation(db:PoolClient,value:Actor,preparationId:string,input:unknown,options:ProjectImagePreparationOptions={}){
 const data=parse(projectImagePreparationApproveInput,input);await actor(db,value,true);await companyLock(db,value.companyId);
 return once(db,value,data.clientId,'approve:'+id(preparationId),data,async()=>{
  const {r,members}=await lockedRow(db,value.companyId,preparationId,[value.userId]);
  if(r.status!=='proposed'||r.revision!==data.revision||r.request_hash!==data.requestHash)changed('IMAGE_PREPARATION_REVISION_CONFLICT');await facts(db,r,members);
  const processor=await runtime(db,r,options,data.processorId);if(processor.qualificationSha256!==data.qualificationSha256)changed('IMAGE_PREPARATION_PROCESSOR_CHANGED');
  const fresh=await lockedRow(db,value.companyId,preparationId,[value.userId]);if(!same(fresh.r,r))changed();await facts(db,fresh.r,fresh.members);
  const times=(await db.query("WITH instant AS (SELECT clock_timestamp() AS now) SELECT now::text AS approved,LEAST(now+($1::int*interval '1 minute'),$2::timestamptz)::text AS expires FROM instant",[data.expiresInMinutes,processor.expiresAt])).rows[0];
  const approver=memberSnapshot(requireAdmin(fresh.members,value.userId));
  const hash=digest({requestHash:r.request_hash,approvedBy:value.userId,approver,approvedAt:times.approved,expiresAt:times.expires,processor,maxCostMicrousd:data.maxCostMicrousd,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true});
  await db.query(`INSERT INTO project_image_preparation_approvals(company_id,project_id,preparation_id,approved_by,approved_at,expires_at,approval_hash,processor_snapshot,approver_snapshot,max_cost_microusd,processing_consent,derivative_write_consent,adoption_consent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,true)`,[r.company_id,r.project_id,r.id,value.userId,times.approved,times.expires,hash,JSON.stringify(processor),JSON.stringify(approver),data.maxCostMicrousd]);
  await receipt(db,r,randomUUID(),'approve','returned',{approvalHash:hash});
  return (await db.query("UPDATE project_image_preparations SET status='queued',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *",[r.company_id,r.id])).rows[0];
 });
}
export async function revokeProjectImagePreparation(db:PoolClient,value:Actor,preparationId:string,input:unknown){
 const data=parse(projectImagePreparationRevokeInput,input);await actor(db,value,true);await companyLock(db,value.companyId);
 return once(db,value,data.clientId,'revoke:'+id(preparationId),data,async()=>{
  // Revocation must still work after another sponsor or source is revoked.
  const scope=await readRow(db,value.companyId,preparationId);await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[value.companyId,scope.project_id]);
  const r=(await db.query('SELECT * FROM project_image_preparations WHERE company_id=$1 AND id=$2 FOR UPDATE',[value.companyId,preparationId])).rows[0];
  if(r.revision!==data.revision||r.status==='revoked')changed('IMAGE_PREPARATION_REVISION_CONFLICT');
  await receipt(db,r,randomUUID(),'revoke','revoked',{revokedBy:value.userId,note:data.note});
  return (await db.query("UPDATE project_image_preparations SET status='revoked',revoked_by=$3,revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *",[value.companyId,r.id,value.userId])).rows[0];
 });
}
async function currentApproval(db:PoolClient,r:Row,a:Row|undefined,members:Row[]){
 if(!a)return changed('IMAGE_PREPARATION_APPROVAL_EXPIRED');
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[a.expires_at])).rows[0].valid)changed('IMAGE_PREPARATION_APPROVAL_EXPIRED');
 if(!same(memberSnapshot(requireAdmin(members,a.approved_by)),a.approver_snapshot))changed();
 await facts(db,r,members);
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[a.expires_at])).rows[0].valid)changed('IMAGE_PREPARATION_APPROVAL_EXPIRED');return a;
}
async function approvedFacts(db:PoolClient,r:Row,a:Row|undefined,members:Row[],options:ProjectImagePreparationOptions){
 const approved=await currentApproval(db,r,a,members),processor=await runtime(db,r,options,approved.processor_snapshot.id,approved.processor_snapshot);
 // Resolution and row-lock waits consume time. A cached membership/lease is
 // not commit authority; repeat the complete admission after that boundary.
 const fresh=await lockedRow(db,r.company_id,r.id);if(!same(fresh.r,r))changed();await currentApproval(db,fresh.r,fresh.a,fresh.members);
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[processor.expiresAt])).rows[0].valid)changed('IMAGE_PREPARATION_PROCESSOR_CHANGED');
 if(r.lease_id&&!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[r.lease_expires_at])).rows[0].valid)changed('IMAGE_PREPARATION_LEASE_ENDED');
 return processor;
}
function leaseFor(r:Row,processor:Processor):Lease{return {companyId:r.company_id,projectId:r.project_id,preparationId:r.id,leaseId:r.lease_id,requestHash:r.request_hash,expiresAt:iso(r.lease_expires_at)!,claimedAt:iso(r.claimed_at)!,recipeSha256:r.recipe_sha256,source:safeSource(r.source_snapshot),processor};}
export async function claimProjectImagePreparation(db:PoolClient,scope:{companyId:string;projectIds:string[]},options:ProjectImagePreparationOptions={}):Promise<Lease|null>{
 id(scope.companyId);if(!Array.isArray(scope.projectIds)||!scope.projectIds.length||scope.projectIds.length>32)fail(400,'Use a bounded explicit project scope.');scope.projectIds.forEach(id);
 if(!options.runtime)return null;if(!await companyLock(db,scope.companyId,false))return null;
 const active=(await db.query('SELECT * FROM project_image_preparations WHERE company_id=$1 AND attempt=1 AND cleanup_confirmed_at IS NULL FOR UPDATE',[scope.companyId])).rows[0];
 if(active){
  if(scope.projectIds.includes(active.project_id)&&['reading','transforming','validating','storing','verifying'].includes(active.status)&&!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[active.lease_expires_at])).rows[0].valid){
   const uncertain=['transforming','storing','verifying'].includes(active.status);await receipt(db,active,randomUUID(),'claim',uncertain?'uncertain':'blocked',{code:'IMAGE_PREPARATION_LEASE_EXPIRED'});
   await db.query('UPDATE project_image_preparations SET status=$3,diagnostic_code=$4,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[scope.companyId,active.id,uncertain?'uncertain':'blocked','IMAGE_PREPARATION_LEASE_EXPIRED']);
  }
  return null; // Expiry is never proof that a native process or write stopped.
 }
 const queued=(await db.query("SELECT id FROM project_image_preparations WHERE company_id=$1 AND project_id=ANY($2::uuid[]) AND status='queued' ORDER BY created_at,id LIMIT $3",[scope.companyId,scope.projectIds,limits.maxQueuedPerCompany])).rows;
 for(const item of queued){
  try{
   const {r,a,members}=await lockedRow(db,scope.companyId,item.id);if(r.status!=='queued')continue;
   const processor=await approvedFacts(db,r,a,members,options),leaseId=randomUUID();
   await receipt(db,r,leaseId,'claim','returned',{approvalHash:a!.approval_hash,processorId:processor.id});
   const claimed=(await db.query("WITH instant AS (SELECT clock_timestamp() AS now) UPDATE project_image_preparations SET status='reading',attempt=1,lease_id=$3,claimed_at=instant.now,lease_expires_at=LEAST(instant.now+interval '120 seconds',$4::timestamptz),revision=revision+1,updated_at=instant.now FROM instant WHERE company_id=$1 AND id=$2 RETURNING project_image_preparations.*",[scope.companyId,r.id,leaseId,a!.expires_at])).rows[0];return leaseFor(claimed,processor);
  }catch(error){
   if(!(error instanceof ApiError))throw error;
   const r=await readRow(db,scope.companyId,item.id);await receipt(db,r,randomUUID(),'claim','blocked',{code:'IMAGE_PREPARATION_AUTHORITY_CHANGED'});
   await db.query("UPDATE project_image_preparations SET status='blocked',diagnostic_code='IMAGE_PREPARATION_AUTHORITY_CHANGED',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND status='queued'",[scope.companyId,item.id]);
  }
 }
 return null;
}
export async function authorizeProjectImagePreparation(db:PoolClient,lease:Lease,options:ProjectImagePreparationOptions={}){
 id(lease.leaseId);const {r,a,members}=await lockedRow(db,lease.companyId,lease.preparationId);
 if(!['reading','transforming','validating','storing','verifying'].includes(r.status)||r.lease_id!==lease.leaseId||r.project_id!==lease.projectId||r.request_hash!==lease.requestHash||!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[r.lease_expires_at])).rows[0].valid)changed('IMAGE_PREPARATION_LEASE_ENDED');
 const processor=await approvedFacts(db,r,a,members,options);if(!same(leaseFor(r,processor),lease))changed('IMAGE_PREPARATION_LEASE_CHANGED');return {r,approval:a!,processor};
}
export async function beginProjectImagePreparationPhase(db:PoolClient,lease:Lease,operation:'transform',options:ProjectImagePreparationOptions={}){
 const {r}=await authorizeProjectImagePreparation(db,lease,options);
 if(operation!=='transform'||r.status!=='reading'||r.action_id||r.transform_result)changed('IMAGE_PREPARATION_PHASE_CONFLICT');
 const actionId=randomUUID();await receipt(db,r,actionId,'transform','intent',{recipeSha256:r.recipe_sha256,sourceSha256:r.source_snapshot.sha256});
 await db.query("UPDATE project_image_preparations SET status='transforming',action_id=$3,action_operation='transform',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,r.id,actionId]);return {actionId};
}
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const transformResult=z.object({operation:z.literal('transform'),sourceVersionId:z.string().uuid(),sourceSha256:sha,sourceBytes:z.number().int().positive().max(limits.sourceMaxBytes),
 source:z.object({format:z.enum(['png','jpeg','webp']),width:z.number().int().positive().max(limits.sourceMaxDimension),height:z.number().int().positive().max(limits.sourceMaxDimension),orientation:z.number().int().min(1).max(8)}).strict(),
 recipeSha256:sha,processor:projectImagePreparationProcessorSchema,
 output:z.object({sha256:sha,bytes:z.number().int().positive().max(limits.outputMaxBytes),width:z.number().int().positive().max(limits.outputMaxDimension),height:z.number().int().positive().max(limits.outputMaxDimension),format:z.literal('png'),pixelFormat:z.literal('rgba8'),metadataRemoved:z.literal(true)}).strict()}).strict();
export async function completeProjectImagePreparationPhase(db:PoolClient,lease:Lease,actionId:string,input:unknown,options:ProjectImagePreparationOptions={}){
 const value=parse(transformResult,input),{r,processor}=await authorizeProjectImagePreparation(db,lease,options);
 if(r.status!=='transforming'||r.action_operation!=='transform'||r.action_id!==id(actionId)||r.transform_result)changed('IMAGE_PREPARATION_PHASE_CONFLICT');
 const s=r.source_snapshot;
 if(value.sourceVersionId!==s.versionId||value.sourceSha256!==s.sha256||value.sourceBytes!==s.bytes||value.recipeSha256!==r.recipe_sha256||!same(value.processor,processor)||'image/'+value.source.format!==s.contentType||value.source.width*value.source.height>limits.sourceMaxPixels)changed('IMAGE_PREPARATION_RESULT_CHANGED');
 const swapped=value.source.orientation>=5,dimensions=preparationDimensions(swapped?value.source.height:value.source.width,swapped?value.source.width:value.source.height);
 if(value.output.width!==dimensions.width||value.output.height!==dimensions.height)changed('IMAGE_PREPARATION_RESULT_CHANGED');
 const {operation:_,...evidence}=value,hash=digest(evidence);await receipt(db,r,actionId,'transform','returned',{transformSha256:hash});
 const updated=(await db.query("UPDATE project_image_preparations SET status='validating',transform_result=$3,transform_sha256=$4,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *",[r.company_id,r.id,JSON.stringify(evidence),hash])).rows[0];
 return {preparation:await view(db,updated)};
}
/** Failure reporting can retain uncertainty after authority ends. It cannot
 * authorize more work, clear a lease, free a slot, or publish an output. */
export async function failProjectImagePreparation(db:PoolClient,lease:Lease,code:string){
 await companyLock(db,lease.companyId);const r=(await db.query('SELECT * FROM project_image_preparations WHERE company_id=$1 AND id=$2 FOR UPDATE',[lease.companyId,id(lease.preparationId)])).rows[0];
 if(!r||r.lease_id!==id(lease.leaseId)||r.request_hash!==lease.requestHash||r.project_id!==lease.projectId)changed('IMAGE_PREPARATION_LEASE_ENDED');
 if(!['reading','transforming','validating','storing','verifying'].includes(r.status))return {preparation:await view(db,r)};
 const diagnostic=['PREPARATION_TIMEOUT','PREPARATION_ABORTED','PREPARATION_CLEANUP_FAILED','PREPARATION_DECODE_FAILED','PREPARATION_OUTPUT_INVALID','PREPARATION_BYTES_CHANGED','PREPARATION_LIMIT_EXCEEDED','PREPARATION_UNSUPPORTED'].includes(code)?code:'IMAGE_PREPARATION_FAILED';
 const uncertain=['transforming','storing','verifying'].includes(r.status);await receipt(db,r,randomUUID(),r.action_operation??'claim',uncertain?'uncertain':'failed',{code:diagnostic});
 const updated=(await db.query('UPDATE project_image_preparations SET status=$3,diagnostic_code=$4,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *',[r.company_id,r.id,uncertain?'uncertain':'failed',diagnostic])).rows[0];return {preparation:await view(db,updated)};
}
