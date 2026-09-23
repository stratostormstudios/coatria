/** Transactional archive control plane. Worker authority is the separately
 * approved archive record, never a forged user session or extended agent run. */
import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {fail,hashToken,id} from './security';
import {authorizeProjectStorageActor} from './project-storage';
import {companyHiggsfieldArchiveAvailability} from './higgsfield-archive-config';
import {higgsfieldArchiveProposalInput,higgsfieldArchiveListInput,higgsfieldArchiveApproveInput,higgsfieldArchiveRevokeInput,type HiggsfieldArchiveActor,type HiggsfieldArchive,type HiggsfieldArchivePage} from './higgsfield-archive-protocol';

type Row=Record<string,any>;
const active=['queued','fetching','uploading','verifying'];
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)fail(400,'Use the exact archive source, destination, revisions and finite limits.','VALIDATION_ERROR');return result.data;};
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const digest=(value:unknown)=>hashToken(canonical(value));
const iso=(value:Date|string|null)=>value?new Date(value).toISOString():null;
const changed=(code:string):never=>fail(409,'The reviewed archive authority changed. Review a new archive request.',code);
async function actorAuthority(db:PoolClient,actor:HiggsfieldArchiveActor,mode:'read'|'propose'|'admin'){
 await authorizeProjectStorageActor(db,actor,'storage.read',mode==='admin');
 if(actor.agentId&&mode==='propose'){
  const row=(await db.query('SELECT a.capabilities,r.capabilities AS run_capabilities FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id WHERE a.company_id=$1 AND a.id=$2 AND r.id=$3 AND r.requested_by=$4 FOR SHARE OF a,r',[actor.companyId,actor.agentId,actor.runId,actor.userId])).rows[0];
  if(!row?.capabilities.includes('creative.write')||!row.run_capabilities.includes('creative.write'))fail(403,'Archive proposals require explicit creative.write and storage.read grants on the current agent and run.','AGENT_CAPABILITY_REQUIRED');
 }
}
async function once(db:PoolClient,actor:HiggsfieldArchiveActor,clientId:string,operation:string,data:unknown,run:()=>Promise<Row>){
 const key=actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId,hash=digest({operation,data});
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-archive:${actor.companyId}:${key}:${clientId}`]);
 const old=(await db.query('SELECT request_hash,response FROM higgsfield_archive_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,key,clientId])).rows[0];
 if(old){if(old.request_hash!==hash)fail(409,'This archive operation ID was used for different details.','IDEMPOTENCY_CONFLICT');return {...old.response,replayed:true};}
 const result=await run();await db.query('INSERT INTO higgsfield_archive_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.companyId,key,clientId,hash,JSON.stringify(result)]);return {...result,replayed:false};
}
async function currentAdmin(db:PoolClient,companyId:string,userIds:string[]){
 const unique=[...new Set(userIds)].sort(),rows=(await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') ORDER BY user_id FOR SHARE",[companyId,unique])).rows;
 if(rows.length!==unique.length)changed('HIGGSFIELD_ARCHIVE_SPONSOR_UNAVAILABLE');
}
async function currentProject(db:PoolClient,companyId:string,projectId:string){
 const row=(await db.query('SELECT id,revision,status,ai_policy,gates,production_path FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,projectId])).rows[0];
 if(!row)fail(404,'Project not found.');
 if(row.status==='delivered'||row.ai_policy!=='allowed'||['brief','estimate','production'].some(gate=>row.gates[gate]?.decision!=='approved'))changed('HIGGSFIELD_ARCHIVE_PROJECT_CHANGED');return row;
}
async function currentSource(db:PoolClient,companyId:string,project:Row,jobId:string,outputId:string){
 // Immutable receipt/output tables need no UPDATE privilege just to lock them.
 const row=(await db.query(`SELECT o.id,o.kind,o.ordinal,o.locator_identity,o.job_id,j.request_id,j.provider_job_id,j.connection_id AS job_connection_id,j.kind AS job_kind,j.model,j.status AS job_status,
 r.status AS request_status,r.requested_by,r.agent_id,r.run_id,r.approved_by,r.request_hash,r.connection_id,r.connection_revision,r.work_item_id,r.role_agent_id,r.role_human_id,a.created_by AS agent_sponsor_id,
 receipt.connection_id AS receipt_connection_id,receipt.connection_revision AS receipt_connection_revision,receipt.approved_by AS receipt_approved_by,receipt.request_hash AS receipt_request_hash,receipt.source_sha256,receipt.outcome,receipt.contract,
 EXISTS(SELECT 1 FROM higgsfield_output_locators l WHERE l.company_id=o.company_id AND l.project_id=o.project_id AND l.output_id=o.id) AS locator_present
 FROM higgsfield_job_outputs o JOIN higgsfield_jobs j ON j.company_id=o.company_id AND j.project_id=o.project_id AND j.id=o.job_id
 JOIN higgsfield_requests r ON r.company_id=j.company_id AND r.project_id=j.project_id AND r.id=j.request_id
 JOIN higgsfield_job_receipts receipt ON receipt.company_id=r.company_id AND receipt.project_id=r.project_id AND receipt.request_id=r.id
 LEFT JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id
 WHERE o.company_id=$1 AND o.project_id=$2 AND j.id=$3 AND o.id=$4 FOR SHARE OF j,r`,[companyId,project.id,jobId,outputId])).rows[0];
 if(!row)fail(404,'Completed adopted provider output not found in this project.');
 if(row.job_status!=='completed'||row.request_status!=='returned'||row.outcome!=='jobs'||!row.approved_by||!row.locator_present||row.kind!==row.job_kind||row.job_connection_id!==row.connection_id||row.receipt_connection_id!==row.connection_id||row.receipt_connection_revision!==row.connection_revision||row.receipt_approved_by!==row.approved_by||row.receipt_request_hash!==row.request_hash)changed('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');
 const provider=(await db.query('SELECT id,revision,status,connected_by FROM higgsfield_connections WHERE company_id=$1 FOR SHARE',[companyId])).rows[0];
 if(!provider||provider.id!==row.connection_id||provider.status!=='connected')changed('HIGGSFIELD_ARCHIVE_PROVIDER_CHANGED');
 await currentAdmin(db,companyId,[row.approved_by,provider.connected_by]);
 let work:Row|null=null;
 if(row.work_item_id){
  await db.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[companyId]);
  work=(await db.query('SELECT w.id,w.task_id,w.role_key,w.stage,w.execution,b.agent_id,b.human_id FROM studio_work_items w LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3',[companyId,project.id,row.work_item_id])).rows[0];
  if(!work||work.stage!=='generation'||work.execution!=='creative'||(work.agent_id??null)!==row.role_agent_id||(work.human_id??null)!==row.role_human_id)changed('HIGGSFIELD_ARCHIVE_WORK_CHANGED');
 }else if(project.production_path==='higgsfield')changed('HIGGSFIELD_ARCHIVE_WORK_CHANGED');
 const source={requestId:row.request_id,requestHash:row.request_hash,receiptHash:row.source_sha256,contract:row.contract,providerConnectionId:row.connection_id,requestConnectionRevision:row.connection_revision,providerSponsorId:provider.connected_by,providerJobId:row.provider_job_id,kind:row.kind,model:row.model,outputId:row.id,ordinal:row.ordinal,outputIdentity:row.locator_identity,requestedBy:row.requested_by,agentId:row.agent_id,runId:row.run_id,agentSponsorId:row.agent_sponsor_id??null,approvedBy:row.approved_by,workItemId:row.work_item_id,roleAgentId:row.role_agent_id,roleHumanId:row.role_human_id,taskId:work?.task_id??null,roleKey:work?.role_key??null};
 return {source,provider,output:{id:row.id,job_id:row.job_id,kind:row.kind,ordinal:row.ordinal,locator_identity:row.locator_identity}};
}
const storageSnapshot=(row:Row)=>({id:row.id,region:row.region,volumeId:row.volume_id,sponsorId:row.created_by,revision:row.revision});
async function currentDestination(db:PoolClient,companyId:string,projectId:string,input:{bindingId:string;parentId:string|null;fileId:string|null;name:string},archive?:Row,exclusiveBinding=false){
 const binding=(await db.query(`SELECT * FROM project_storage_bindings WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR ${exclusiveBinding?'UPDATE':'SHARE'}`,[companyId,projectId,input.bindingId])).rows[0];
 if(!binding)fail(404,'Project storage binding not found.');
 const storageConnection=(await db.query('SELECT id,company_id,name,provider,region,volume_id,status,revision,created_by,secret_envelope IS NOT NULL AS credentials_present FROM project_storage_connections WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,binding.connection_id])).rows[0];
 if(!storageConnection||storageConnection.status!=='configured'||!storageConnection.credentials_present)changed('HIGGSFIELD_ARCHIVE_STORAGE_CHANGED');
 await currentAdmin(db,companyId,[storageConnection.created_by]);
 const ancestors:Row[]=[],seen=new Set<string>();let parent=input.parentId;
 while(parent){
  if(seen.has(parent)||ancestors.length>=12)changed('HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED');seen.add(parent);
  const folder=(await db.query('SELECT id,parent_id,name,name_key,binding_id FROM project_storage_folders WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE',[companyId,projectId,parent])).rows[0];
  if(!folder||folder.binding_id!==binding.id)changed('HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED');
  ancestors.unshift({id:folder.id,parentId:folder.parent_id,name:folder.name,nameKey:folder.name_key});parent=folder.parent_id;
 }
 let allowedFile=input.fileId;
 if(archive?.version_id){
  const owned=(await db.query("SELECT v.file_id FROM project_storage_versions v JOIN project_storage_uploads u ON u.company_id=v.company_id AND u.project_id=v.project_id AND u.version_id=v.id WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3 AND u.id=$4 AND u.archive_id=$5 AND u.actor_key=$6 AND u.actor_agent_id IS NULL AND u.run_id IS NULL AND u.actor_user_id=$7",[companyId,projectId,archive.version_id,archive.upload_id,archive.id,'archive:'+archive.id,archive.approved_by])).rows[0];
  if(!owned||allowedFile&&allowedFile!==owned.file_id)changed('HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED');allowedFile=owned.file_id;
 }
 const collisions=(await db.query("SELECT id,binding_id,parent_id,name,'folder' AS kind FROM project_storage_folders WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4 UNION ALL SELECT id,binding_id,parent_id,name,'file' AS kind FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4",[companyId,projectId,input.parentId,input.name.normalize('NFC').toLowerCase()])).rows;
 if(allowedFile){if(collisions.length!==1||collisions[0].kind!=='file'||collisions[0].id!==allowedFile||collisions[0].binding_id!==binding.id||collisions[0].name!==input.name)changed('HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED');}
 else if(collisions.length)changed('HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED');
 return {binding,storageConnection,ancestors};
}
async function archiveRow(db:PoolClient,companyId:string,archiveId:string,lock=false){
 const row=(await db.query(`SELECT * FROM higgsfield_output_archives WHERE company_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[companyId,id(archiveId)])).rows[0];if(!row)fail(404,'Archive request not found.');return row;
}
async function facts(db:PoolClient,archive:Row,exclusiveBinding=false){
 const project=await currentProject(db,archive.company_id,archive.project_id),source=await currentSource(db,archive.company_id,project,archive.job_id,archive.output_id);
 if(source.source.requestId!==archive.request_id||source.output.locator_identity!==archive.locator_identity||source.provider.id!==archive.provider_connection_id||digest(source.source)!==digest(archive.source_snapshot))changed('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');
 const destination=await currentDestination(db,archive.company_id,archive.project_id,{bindingId:archive.storage_binding_id,parentId:archive.destination_parent_id,fileId:archive.destination_file_id,name:archive.destination_name},archive,exclusiveBinding);
 if(archive.destination_name_key!==archive.destination_name.normalize('NFC').toLowerCase()||destination.binding.connection_id!==archive.storage_connection_id||destination.storageConnection.revision!==archive.storage_connection_revision||digest(storageSnapshot(destination.storageConnection))!==digest(archive.storage_connection_snapshot)||digest(destination.ancestors)!==digest(archive.destination_ancestors))changed('HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED');
 return {project,...source,...destination};
}
async function view(db:PoolClient,row:Row):Promise<HiggsfieldArchive>{
 const fetched=(await db.query('SELECT bytes::float8 AS bytes,sha256 FROM higgsfield_archive_fetches WHERE company_id=$1 AND project_id=$2 AND archive_id=$3 AND locator_identity=$4',[row.company_id,row.project_id,row.id,row.locator_identity])).rows[0];
 const verified=row.status==='verified'&&fetched&&row.version_id?(await db.query('SELECT 1 FROM project_storage_verifications ok JOIN project_storage_versions v ON v.company_id=ok.company_id AND v.project_id=ok.project_id AND v.id=ok.version_id JOIN project_storage_uploads u ON u.company_id=v.company_id AND u.project_id=v.project_id AND u.version_id=v.id WHERE ok.company_id=$1 AND ok.project_id=$2 AND ok.version_id=$3 AND ok.bytes=$4 AND ok.sha256=$5 AND v.bytes=ok.bytes AND v.sha256=ok.sha256 AND u.id=$6 AND u.archive_id=$7 AND u.status=\'ready\'',[row.company_id,row.project_id,row.version_id,fetched.bytes,fetched.sha256,row.upload_id,row.id])).rowCount:0;
 const s=row.source_snapshot;
 return {id:row.id,projectId:row.project_id,requestId:row.request_id,jobId:row.job_id,outputId:row.output_id,outputIdentity:row.locator_identity,kind:s.kind,status:row.status,revision:row.revision,requestHash:row.request_hash,projectRevision:row.project_revision,bindingId:row.storage_binding_id,bindingRevision:row.storage_binding_revision,storageConnectionId:row.storage_connection_id,storageConnectionRevision:row.storage_connection_revision,destination:{parentId:row.destination_parent_id,fileId:row.destination_file_id,name:row.destination_name,ancestors:row.destination_ancestors.map((item:Row)=>({id:item.id,name:item.name}))},maxBytes:Number(row.max_bytes),sourceAttribution:{requestedBy:s.requestedBy,agentId:s.agentId,runId:s.runId,agentSponsorId:s.agentSponsorId,approvedBy:s.approvedBy},proposedBy:row.proposed_by,proposedAgentId:row.proposed_agent_id,createdAt:iso(row.created_at)!,approvedBy:row.approved_by,approvedAt:iso(row.approved_at),expiresAt:iso(row.expires_at),revokedAt:iso(row.revoked_at),approvedProjectRevision:row.approved_project_revision,approvedBindingRevision:row.approved_binding_revision,uploadId:row.upload_id,versionId:row.version_id,diagnosticCode:row.diagnostic_code,fetched:fetched??null,bytesVerified:Boolean(verified)};
}
export async function proposeHiggsfieldArchive(db:PoolClient,actor:HiggsfieldArchiveActor,input:unknown){
 const data=parse(higgsfieldArchiveProposalInput,input);await actorAuthority(db,actor,'propose');return once(db,actor,data.clientId,'propose',data,async()=>{
  const project=await currentProject(db,actor.companyId,data.projectId);if(project.revision!==data.projectRevision)changed('HIGGSFIELD_ARCHIVE_REVISION_CONFLICT');
  const source=await currentSource(db,actor.companyId,project,data.jobId,data.outputId);if(source.output.locator_identity!==data.outputIdentity)changed('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');
  const destination=await currentDestination(db,actor.companyId,data.projectId,{bindingId:data.bindingId,parentId:data.parentId,fileId:data.fileId??null,name:data.name});if(destination.binding.revision!==data.bindingRevision)changed('HIGGSFIELD_ARCHIVE_REVISION_CONFLICT');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-archive-cap:${actor.companyId}:${data.projectId}`]);if(Number((await db.query('SELECT count(*) FROM higgsfield_output_archives WHERE company_id=$1 AND project_id=$2',[actor.companyId,data.projectId])).rows[0].count)>=500)fail(409,'This project reached its 500-archive pilot limit.');
  const requestHash=digest({proposal:data,source:source.source,destination:{storageConnection:storageSnapshot(destination.storageConnection),ancestors:destination.ancestors}});
  const row=(await db.query(`INSERT INTO higgsfield_output_archives(company_id,project_id,request_id,job_id,output_id,locator_identity,source_snapshot,provider_connection_id,provider_connection_revision,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,storage_connection_snapshot,destination_parent_id,destination_file_id,destination_name,destination_name_key,destination_ancestors,max_bytes,project_revision,request_hash,proposed_by,proposed_agent_id,proposed_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,[actor.companyId,data.projectId,source.source.requestId,data.jobId,data.outputId,data.outputIdentity,JSON.stringify(source.source),source.provider.id,source.provider.revision,data.bindingId,data.bindingRevision,destination.storageConnection.id,destination.storageConnection.revision,JSON.stringify(storageSnapshot(destination.storageConnection)),data.parentId,data.fileId??null,data.name,data.name.normalize('NFC').toLowerCase(),JSON.stringify(destination.ancestors),data.maxBytes,data.projectRevision,requestHash,actor.userId,actor.agentId??null,actor.runId??null])).rows[0];
  return {archive:await view(db,row)};
 });
}
export async function getHiggsfieldArchive(db:PoolClient,actor:HiggsfieldArchiveActor,archiveId:string){await actorAuthority(db,actor,'read');return {archive:await view(db,await archiveRow(db,actor.companyId,archiveId))};}
export async function listHiggsfieldArchives(db:PoolClient,actor:HiggsfieldArchiveActor,input:unknown):Promise<HiggsfieldArchivePage>{
 const data=parse(higgsfieldArchiveListInput,input);await actorAuthority(db,actor,'read');if(!(await db.query('SELECT 1 FROM studio_projects WHERE company_id=$1 AND id=$2',[actor.companyId,data.projectId])).rowCount)fail(404,'Project not found.');
 if(data.after&&!(await db.query('SELECT 1 FROM higgsfield_output_archives WHERE company_id=$1 AND project_id=$2 AND id=$3',[actor.companyId,data.projectId,data.after])).rowCount)fail(404,'Archive cursor not found.');
 const rows=(await db.query('SELECT * FROM higgsfield_output_archives WHERE company_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[actor.companyId,data.projectId,data.after??null,data.limit+1])).rows,archives=[];
 for(const row of rows.slice(0,data.limit))archives.push(await view(db,row));return {archives,hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?archives.at(-1)!.id:null};
}
export async function approveHiggsfieldArchive(db:PoolClient,actor:HiggsfieldArchiveActor,archiveId:string,input:unknown){
 const data=parse(higgsfieldArchiveApproveInput,input);await actorAuthority(db,actor,'admin');return once(db,actor,data.clientId,'approve:'+id(archiveId),data,async()=>{
  const archive=await archiveRow(db,actor.companyId,archiveId,true);if(archive.status!=='proposed'||archive.revoked_at)changed('HIGGSFIELD_ARCHIVE_NOT_PROPOSED');if(archive.revision!==data.revision||archive.request_hash!==data.requestHash)changed('HIGGSFIELD_ARCHIVE_REVISION_CONFLICT');
  const processing=await companyHiggsfieldArchiveAvailability(db,actor.companyId,archive.project_id);if(!processing.enabled)fail(503,'Archive processing is not enabled for this project.','HIGGSFIELD_ARCHIVE_UNAVAILABLE');
  const current=await facts(db,archive);if(current.project.revision!==data.projectRevision||current.binding.revision!==data.bindingRevision)changed('HIGGSFIELD_ARCHIVE_REVISION_CONFLICT');
  const row=(await db.query("WITH approval_clock AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE higgsfield_output_archives SET status='queued',revision=revision+1,approved_by=$3,approved_at=tick.at,expires_at=LEAST(tick.at+make_interval(hours=>$4),$7::timestamptz),approved_project_revision=$5,approved_binding_revision=$6,updated_at=tick.at FROM approval_clock tick WHERE company_id=$1 AND id=$2 AND ($7::timestamptz IS NULL OR $7::timestamptz>tick.at) RETURNING higgsfield_output_archives.*",[actor.companyId,archiveId,actor.userId,data.expiresInHours,data.projectRevision,data.bindingRevision,processing.expiresAt])).rows[0];
  if(!row)fail(409,'The archive service deadline ended during approval.','HIGGSFIELD_ARCHIVE_UNAVAILABLE');
  await db.query("INSERT INTO higgsfield_archive_receipts(company_id,project_id,archive_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,'approve','returned',$5)",[actor.companyId,row.project_id,row.id,data.clientId,JSON.stringify({approvedBy:actor.userId,requestHash:row.request_hash,expiresAt:iso(row.expires_at)})]);return {archive:await view(db,row)};
 });
}
export async function revokeHiggsfieldArchive(db:PoolClient,actor:HiggsfieldArchiveActor,archiveId:string,input:unknown){
 const data=parse(higgsfieldArchiveRevokeInput,input);await actorAuthority(db,actor,'admin');return once(db,actor,data.clientId,'revoke:'+id(archiveId),data,async()=>{
  const archive=await archiveRow(db,actor.companyId,archiveId,true);if(archive.revision!==data.revision)changed('HIGGSFIELD_ARCHIVE_REVISION_CONFLICT');if(archive.revoked_at)changed('HIGGSFIELD_ARCHIVE_REVOKED');
  // Revocation does not assert that already stored bytes were deleted or that
  // an in-flight provider mutation was undone. Retain its upload/action state.
  const row=(await db.query("UPDATE higgsfield_output_archives SET status=CASE WHEN status='verified' THEN status ELSE 'cancelled' END,revision=revision+1,revoked_by=$3,revoked_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL,diagnostic_code='HIGGSFIELD_ARCHIVE_REVOKED',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,archiveId,actor.userId])).rows[0];
  await db.query("INSERT INTO higgsfield_archive_receipts(company_id,project_id,archive_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,'revoke','cancelled',$5)",[actor.companyId,row.project_id,row.id,data.clientId,JSON.stringify({revokedBy:actor.userId,note:data.note})]);return {archive:await view(db,row),storedBytesDeleted:false};
 });
}
/** Internal worker authority. No locator or storage credential is decrypted or
 * returned here. Caller supplies its own transaction and publication fencing. */
export async function authorizeHiggsfieldArchive(db:PoolClient,companyId:string,archiveId:string,options:{leaseId?:string;exclusiveBinding?:boolean}={}){
 id(companyId);await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[companyId]);const archive=await archiveRow(db,companyId,archiveId,true);
 // Check the database clock after the row lock is held: host clock skew or a
 // wait for that lock must never extend a lease or a human approval deadline.
 const checkDeadline=async()=>{const validity=(await db.query('SELECT expires_at>clock_timestamp() AS approval_valid,lease_expires_at>clock_timestamp() AS lease_valid FROM higgsfield_output_archives WHERE company_id=$1 AND id=$2',[companyId,archiveId])).rows[0];
  if(!active.includes(archive.status)||archive.revoked_at||!archive.approved_by||validity?.approval_valid!==true)fail(403,'Archive approval is absent, ended or revoked.','HIGGSFIELD_ARCHIVE_AUTHORITY_ENDED');
  if(options.leaseId!==undefined&&(archive.lease_id!==id(options.leaseId)||validity?.lease_valid!==true))fail(409,'This archive worker lease ended.','HIGGSFIELD_ARCHIVE_LEASE_ENDED');
 };await checkDeadline();
 // Allocation takes UPDATE initially, avoiding two shared-lock holders both
 // trying to upgrade the same binding. Ordinary streaming checks use SHARE.
 await currentAdmin(db,companyId,[archive.approved_by]);const current=await facts(db,archive,options.exclusiveBinding===true);
 await checkDeadline();
 return {...archive,output:current.output,binding:current.binding,storageConnection:current.storageConnection,source:current.source};
}
