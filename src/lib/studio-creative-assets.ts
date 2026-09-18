import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {requireMembership} from './auth';
import {memberMutation} from './company';
import {body,fail,hashToken,id,json} from './security';
import {managedAgentAuthoritySql} from './studio-hosting';
import {assertStudioTaskAction} from './studio';
import {studioGenerationImportInput,studioStorageReferenceInput,studioCreativeListInput,type StudioCreativeActor,type StudioGeneration,type StudioGenerationReceipt,type StudioStorageReference} from './studio-creative-assets-protocol';

type Row=Record<string,any>;
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)fail(400,result.error.issues.map(issue=>issue.message).slice(0,3).join(' '),'VALIDATION_ERROR');return result.data;};
const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const digest=(value:unknown)=>hashToken(canonical(value));
const iso=(value:string|Date)=>new Date(value).toISOString();
const generationColumns=`id,project_id AS "projectId",work_item_id AS "workItemId",provider,provider_job_id AS "providerJobId",kind,model,prompt,reference_bindings AS "references",created_at AS "createdAt"`;
const receiptColumns=`id,generation_id AS "generationId",source_tool AS "sourceTool",observed_status AS "observedStatus",observed_at AS "observedAt",outputs,note,imported_by AS "importedBy",imported_agent_id AS "importedAgentId",run_id AS "runId",received_at AS "receivedAt"`;
const generationSelection=`SELECT ${generationColumns},(SELECT row_to_json(observation) FROM (SELECT ${receiptColumns} FROM studio_generation_receipts WHERE company_id=g.company_id AND generation_id=g.id ORDER BY received_at DESC,id DESC LIMIT 1) observation) AS latest_receipt FROM studio_generations g`;
const storageSelection=`SELECT s.id,s.project_id AS "projectId",s.work_item_id AS "workItemId",s.drive_id AS "driveId",s.drive_name AS "driveName",s.path,s.bytes::float8 AS bytes,s.modified_at AS "modifiedAt",s.indexed_at AS "indexedAt",s.name,s.purpose,s.created_at AS "createdAt",CASE WHEN d.status='revoked' THEN 'revoked' WHEN f.path IS NULL THEN 'missing' WHEN f.size=s.bytes AND f.modified_at=s.modified_at THEN 'unchanged' ELSE 'changed' END AS "indexState" FROM studio_storage_references s JOIN drives d ON d.company_id=s.company_id AND d.id=s.drive_id LEFT JOIN drive_files f ON f.drive_id=s.drive_id AND f.path=s.path`;
const terminal=new Set(['completed','canceled','failed','nsfw','ip_detected']);
const receiptView=(row:Row):StudioGenerationReceipt=>({...row,observedAt:iso(row.observedAt),receivedAt:iso(row.receivedAt),evidenceSource:'imported_report',providerVerified:false,bytesVerified:false,independentlyReviewed:false}) as StudioGenerationReceipt;
const generationRow=(row:Row):StudioGeneration=>{const {latest_receipt,...fields}=row;return {...fields,createdAt:iso(row.createdAt),latestReceipt:latest_receipt?receiptView(latest_receipt):null} as StudioGeneration;};
const storageRow=(row:Row):StudioStorageReference=>({...row,modifiedAt:iso(row.modifiedAt),indexedAt:iso(row.indexedAt),createdAt:iso(row.createdAt),verificationSource:'metadata_only',bytesVerified:false,fileAccessGranted:false,uploadedToHiggsfield:false}) as StudioStorageReference;
function boundedPage<T extends {id:string}>(rows:T[],limit:number){let bytes=0;const items:T[]=[];for(const row of rows.slice(0,limit)){const size=Buffer.byteLength(JSON.stringify(row));if(items.length&&bytes+size>196608)break;items.push(row);bytes+=size;}return {items,page:{limit,hasMore:rows.length>items.length,nextAfter:rows.length>items.length?items.at(-1)!.id:null}};}
async function projectExists(client:PoolClient,companyId:string,projectId:string){id(companyId);id(projectId);if(!(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rowCount)fail(404,'Studio project not found.');}
/** The caller owns company/member/agent/run authority locks (memberMutation or
 * authorizeRunTool). This fresh check does not infer a lease from an input ID. */
async function writer(client:PoolClient,actor:StudioCreativeActor){
 if(!actor.agentId){if(actor.runId)fail(403,'An agent run requires its authenticated agent.');if(!(await client.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin')",[actor.companyId,actor.userId])).rowCount)fail(403,'A current company administrator is required.');return null;}
 if(!actor.runId)fail(403,'Use an authenticated leased agent run.','AGENT_RUN_REQUIRED');
 const row=(await client.query(`SELECT a.*,r.id AS run_id,r.capabilities AS run_capabilities FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id JOIN memberships sponsor ON sponsor.company_id=a.company_id AND sponsor.user_id=a.created_by JOIN memberships requester ON requester.company_id=r.company_id AND requester.user_id=r.requested_by WHERE a.company_id=$1 AND a.id=$2 AND r.id=$3 AND r.requested_by=$4 AND a.status='active' AND a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} AND sponsor.role IN ('owner','admin') AND requester.role IN ('owner','admin') AND a.invocation_access<>'none' AND r.status='running' AND r.lease_token_hash IS NOT NULL AND r.lease_expires_at>clock_timestamp()`,[actor.companyId,actor.agentId,actor.runId,actor.userId])).rows[0];
 if(!row||!row.capabilities.includes('studio.write')||!row.run_capabilities.includes('studio.write'))fail(403,'The agent needs current studio.write authority and a live leased run.','AGENT_CAPABILITY_REQUIRED');return row;
}
async function once(client:PoolClient,actor:StudioCreativeActor,clientId:string,operation:string,data:unknown,run:()=>Promise<Row>){
 const actorKey=actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId,requestHash=digest({operation,data});
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-creative:${actor.companyId}:${actorKey}:${clientId}`]);
 const previous=(await client.query('SELECT request_hash,response FROM studio_creative_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,actorKey,clientId])).rows[0];
 if(previous){if(previous.request_hash!==requestHash)fail(409,'This creative request ID belongs to different data.','IDEMPOTENCY_CONFLICT');return {...previous.response,replayed:true};}
 const result=await run();await client.query('INSERT INTO studio_creative_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.companyId,actorKey,clientId,requestHash,JSON.stringify(result)]);return {...result,replayed:false};
}
async function writeContext(client:PoolClient,actor:StudioCreativeActor,agent:Row|null,projectId:string,revision:number,workItemId:string|null){
 const project=(await client.query('SELECT * FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,projectId])).rows[0];if(!project)fail(404,'Studio project not found.');
 if(project.revision!==revision)fail(409,'The project changed. Refresh before recording creative evidence.','STUDIO_REVISION_CONFLICT');
 if(project.status==='delivered')fail(409,'Delivered project records are closed. Create follow-up work.','STUDIO_PROJECT_CLOSED');
 if(agent&&!workItemId)fail(403,'An agent must attach creative evidence to its exact assigned task.','STUDIO_ROLE_REQUIRED');
 if(workItemId){
  const work=(await client.query('SELECT w.task_id,t.status,t.agent_run_id FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3',[actor.companyId,projectId,workItemId])).rows[0];if(!work)fail(404,'Work item not found in this project.');
  if(agent){
   if(project.ai_policy!=='allowed')fail(403,'This project does not authorize agent media work.','STUDIO_AI_RESTRICTED');
   await assertStudioTaskAction(client,actor.companyId,work.task_id,'creative_evidence',{}, {capabilities:agent.run_capabilities},agent);
   const task=(await client.query('SELECT status,agent_run_id FROM tasks WHERE company_id=$1 AND id=$2 FOR SHARE',[actor.companyId,work.task_id])).rows[0];
   if(task.status!=='doing'||task.agent_run_id!==actor.runId)fail(403,'Reserve this assigned task for the current run before importing creative evidence.','STUDIO_TASK_RESERVATION_REQUIRED');
  }else if(work.status==='done')fail(409,'Accepted work is immutable. Create follow-up work.','STUDIO_WORK_CLOSED');
 }
 return project;
}
async function bump(client:PoolClient,actor:StudioCreativeActor,projectId:string,kind:string){
 const project=(await client.query('UPDATE studio_projects SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING id,revision',[actor.companyId,projectId])).rows[0];
 await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[actor.companyId,actor.userId,kind,kind==='studio.generation_imported'?'An imported Higgsfield observation was recorded. It is not provider verification, media QC, or delivery.':'An external storage metadata snapshot was recorded. No original bytes were accessed or transferred.']);return project;
}
async function generationView(client:PoolClient,companyId:string,projectId:string,generationId:string):Promise<StudioGeneration>{
 const row=(await client.query(`${generationSelection} WHERE g.company_id=$1 AND g.project_id=$2 AND g.id=$3`,[companyId,projectId,generationId])).rows[0];if(!row)fail(404,'Generation record not found.');return generationRow(row);
}
export async function listStudioGenerations(client:PoolClient,companyId:string,projectId:string,input:unknown={}){
 const page=parse(studioCreativeListInput,input);await projectExists(client,companyId,projectId);if(page.after)await generationView(client,companyId,projectId,page.after);
 const rows=(await client.query(`${generationSelection} WHERE g.company_id=$1 AND g.project_id=$2 AND ($3::uuid IS NULL OR g.id>$3) ORDER BY g.id LIMIT $4`,[companyId,projectId,page.after??null,page.limit+1])).rows.map(generationRow),result=boundedPage(rows,page.limit);
 return {generations:result.items,page:result.page};
}
export async function getStudioGeneration(client:PoolClient,companyId:string,projectId:string,generationId:string,input:unknown={}){
 id(generationId);const page=parse(studioCreativeListInput,input);await projectExists(client,companyId,projectId);const generation=await generationView(client,companyId,projectId,generationId);
 if(page.after&&!(await client.query('SELECT id FROM studio_generation_receipts WHERE company_id=$1 AND generation_id=$2 AND id=$3',[companyId,generationId,page.after])).rowCount)fail(404,'Generation receipt cursor not found.');
 const rows=(await client.query(`SELECT ${receiptColumns} FROM studio_generation_receipts WHERE company_id=$1 AND generation_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,[companyId,generationId,page.after??null,page.limit+1])).rows.map(receiptView),result=boundedPage(rows,page.limit);
 return {generation,receipts:result.items,page:result.page};
}
/** Imports observations from the official MCP workflow. Never submits a job,
 * downloads a URL, attests provider ownership, or advances a production task. */
export async function importStudioGeneration(client:PoolClient,actor:StudioCreativeActor,projectId:string,input:unknown){
 id(projectId);const data=parse(studioGenerationImportInput,input),agent=await writer(client,actor);
 return once(client,actor,data.clientId,'generation:'+projectId,data,async()=>{
  await writeContext(client,actor,agent,projectId,data.revision,data.workItemId);
  if(Date.parse(data.observedAt)>Date.now()+300000)fail(400,'The observation time cannot be in the future.','CREATIVE_OBSERVATION_TIME');
  for(const reference of data.references){
   const table=reference.kind==='generation'?'studio_generations':reference.kind==='storage'?'studio_storage_references':null,referenceId=reference.kind==='generation'?reference.generationId:reference.kind==='storage'?reference.storageReferenceId:null;
   if(table&&!(await client.query(`SELECT id FROM ${table} WHERE company_id=$1 AND project_id=$2 AND id=$3`,[actor.companyId,projectId,referenceId])).rowCount)fail(404,'A reference is not part of this project.','CREATIVE_REFERENCE_NOT_FOUND');
  }
  const identity={projectId,workItemId:data.workItemId,providerJobId:data.providerJobId,kind:data.kind,model:data.model,prompt:data.prompt,references:data.references},identityHash=digest(identity);
  let generation=(await client.query('SELECT id,identity_hash FROM studio_generations WHERE company_id=$1 AND provider_job_id=$2',[actor.companyId,data.providerJobId])).rows[0];
  if(generation&&generation.identity_hash!==identityHash)fail(409,'This provider job is already bound to a different immutable project, task or reference snapshot.','CREATIVE_JOB_IDENTITY_CONFLICT');
  if(!generation){
   if(Number((await client.query('SELECT count(*) FROM studio_generations WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count)>=1000)fail(409,'This project reached its 1,000-generation record limit.');
   generation=(await client.query('INSERT INTO studio_generations(company_id,project_id,work_item_id,provider_job_id,kind,model,prompt,reference_bindings,identity_hash,created_by,created_agent_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',[actor.companyId,projectId,data.workItemId,data.providerJobId,data.kind,data.model,data.prompt,JSON.stringify(data.references),identityHash,actor.userId,actor.agentId??null,actor.runId??null])).rows[0];
  }
  const previous=(await client.query('SELECT observed_status,observed_at,outputs FROM studio_generation_receipts WHERE company_id=$1 AND generation_id=$2 ORDER BY received_at DESC,id DESC LIMIT 1',[actor.companyId,generation.id])).rows[0];
  if(previous&&Date.parse(data.observedAt)<+new Date(previous.observed_at))fail(409,'Import observations in their observed order.','CREATIVE_OBSERVATION_STALE');
  if(previous&&terminal.has(previous.observed_status)&&(data.observedStatus!==previous.observed_status||digest(data.outputs)!==digest(previous.outputs)))fail(409,'A terminal provider observation cannot be replaced by a different result. Import a new provider job for a new generation.','CREATIVE_GENERATION_TERMINAL');
  if(Number((await client.query('SELECT count(*) FROM studio_generation_receipts WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count)>=5000)fail(409,'This project reached its 5,000-observation limit.');
  const row=(await client.query(`INSERT INTO studio_generation_receipts(company_id,project_id,generation_id,source_tool,observed_status,observed_at,outputs,note,imported_by,imported_agent_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${receiptColumns}`,[actor.companyId,projectId,generation.id,data.sourceTool,data.observedStatus,data.observedAt,JSON.stringify(data.outputs),data.note,actor.userId,actor.agentId??null,actor.runId??null])).rows[0];
  return {generation:await generationView(client,actor.companyId,projectId,generation.id),receipt:receiptView(row),project:await bump(client,actor,projectId,'studio.generation_imported')};
 });
}
export async function getStudioStorageReference(client:PoolClient,companyId:string,projectId:string,referenceId:string):Promise<StudioStorageReference>{
 id(referenceId);const row=(await client.query(`${storageSelection} WHERE s.company_id=$1 AND s.project_id=$2 AND s.id=$3`,[companyId,projectId,referenceId])).rows[0];if(!row)fail(404,'Storage reference not found.');return storageRow(row);
}
export async function listStudioStorageReferences(client:PoolClient,companyId:string,projectId:string,input:unknown={}){
 const page=parse(studioCreativeListInput,input);await projectExists(client,companyId,projectId);if(page.after)await getStudioStorageReference(client,companyId,projectId,page.after);
 const rows=(await client.query(`${storageSelection} WHERE s.company_id=$1 AND s.project_id=$2 AND ($3::uuid IS NULL OR s.id>$3) ORDER BY s.id LIMIT $4`,[companyId,projectId,page.after??null,page.limit+1])).rows.map(storageRow),result=boundedPage(rows,page.limit);return {references:result.items,page:result.page};
}
export async function registerStudioStorageReference(client:PoolClient,actor:StudioCreativeActor,projectId:string,input:unknown){
 id(projectId);const data=parse(studioStorageReferenceInput,input),agent=await writer(client,actor);
 return once(client,actor,data.clientId,'storage:'+projectId,data,async()=>{
  await writeContext(client,actor,agent,projectId,data.revision,data.workItemId);
  // Heartbeats replace the index under this same drive lock. Pin a complete
  // metadata observation, never a live FK into the replaceable file index.
  const drive=(await client.query("SELECT id,name,last_seen_at FROM drives WHERE company_id=$1 AND id=$2 AND status<>'revoked' FOR SHARE",[actor.companyId,data.driveId])).rows[0];if(!drive||!drive.last_seen_at)fail(404,'Choose an indexed, non-revoked drive in this company.');
  const file=(await client.query('SELECT path,size::text AS bytes,modified_at FROM drive_files WHERE drive_id=$1 AND path=$2',[data.driveId,data.path])).rows[0];if(!file)fail(404,'This path is not present in the selected drive index.');
  if(String(data.expectedBytes)!==file.bytes||Date.parse(data.expectedModifiedAt)!==+new Date(file.modified_at))fail(409,'The indexed file changed. Refresh its size and modification time before recording it.','STORAGE_INDEX_CONFLICT');
  if(Number((await client.query('SELECT count(*) FROM studio_storage_references WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count)>=1000)fail(409,'This project reached its 1,000-storage-reference limit.');
  const row=(await client.query('INSERT INTO studio_storage_references(company_id,project_id,work_item_id,drive_id,drive_name,path,bytes,modified_at,indexed_at,name,purpose,created_by,created_agent_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id',[actor.companyId,projectId,data.workItemId,data.driveId,drive.name,data.path,file.bytes,file.modified_at,drive.last_seen_at,data.name,data.purpose,actor.userId,actor.agentId??null,actor.runId??null])).rows[0];
  return {reference:await getStudioStorageReference(client,actor.companyId,projectId,row.id),project:await bump(client,actor,projectId,'studio.storage_reference_registered')};
 });
}
export async function studioCreativeAssetsRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='projects'||parts[5]!=='creative-assets'||!['generations','storage-references'].includes(parts[6])||parts.length<7||parts.length>8)return null;
 if(method!=='GET'&&!(method==='POST'&&parts.length===7))return null;
 const companyId=id(parts[1]),projectId=id(parts[4]),member=await requireMembership(request,companyId,method==='POST'),kind=parts[6],actor={companyId,userId:member.userId};
 if(method==='GET'){
  const params=new URL(request.url).searchParams;if(new Set(params.keys()).size!==[...params.keys()].length)fail(400,'Duplicate page parameters.');const page=parse(studioCreativeListInput,Object.fromEntries(params));
  return json(await memberMutation<Row>(member,false,client=>kind==='generations'?(parts.length===8?getStudioGeneration(client,companyId,projectId,id(parts[7]),page):listStudioGenerations(client,companyId,projectId,page)):(parts.length===8?getStudioStorageReference(client,companyId,projectId,id(parts[7])).then(reference=>({reference})):listStudioStorageReferences(client,companyId,projectId,page))));
 }
 const data=kind==='generations'?await body(request,studioGenerationImportInput,48000):await body(request,studioStorageReferenceInput,6000);
 const result=kind==='generations'?await memberMutation(member,true,client=>importStudioGeneration(client,actor,projectId,data)):await memberMutation(member,true,client=>registerStudioStorageReference(client,actor,projectId,data));
 return json(result,result.replayed?200:201);
}
