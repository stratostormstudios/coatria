import {createHmac} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {query,transaction} from './db';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {assertOrigin,bearer,body,fail,hashToken,id,json,rateLimit,secret} from './security';
import {studioProjectDetail,type StudioActor} from './studio';
import {managedAgentAuthoritySql,managedAgentAuthorityPrincipals} from './studio-hosting';
import {executionConnectorInput,executionConnectorPatchInput,executionInputRegisterInput,executionSubmitInput,executionJobActionInput,executionClaimInput,executionLeaseInput,executionCompleteInput,executionFailureInput,executionManifestInput,type ExecutionManifest} from './studio-execution-protocol';

type Row=Record<string,any>;
export type ConnectorIdentity={id:string;company_id:string;created_by:string;token_hash:string};
const connectorColumns=`id,company_id AS "companyId",name,profiles,status,revision,created_by AS "createdBy",expires_at AS "expiresAt",last_seen_at AS "lastSeenAt",created_at AS "createdAt"`;
const inputColumns=`id,project_id AS "projectId",name,kind,storage_key AS "storageKey",sha256,bytes::float8 AS bytes,registered_by AS "registeredBy",created_at AS "createdAt"`;
const jobColumns=`id,company_id AS "companyId",project_id AS "projectId",work_item_id AS "workItemId",connector_id AS "connectorId",requested_by AS "requestedBy",requested_agent_id AS "requestedAgentId",requested_run_id AS "requestedRunId",approved_by AS "approvedBy",profile,spec,input_snapshot AS "inputReferences",frame_start AS "frameStart",frame_end AS "frameEnd",output_kind AS "outputKind",status,revision,worker_id AS "workerId",started_at AS "startedAt",deadline_at AS "deadlineAt",lease_expires_at AS "leaseExpiresAt",finished_at AS "finishedAt",failure_reason AS "failureReason",created_at AS "createdAt",updated_at AS "updatedAt"`;
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);if(!parsed.success)fail(400,parsed.error.issues.slice(0,3).map(issue=>issue.message).join(' '),'VALIDATION_ERROR');return parsed.data;}
function canonical(value:unknown):string{return Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);}
const digest=(value:unknown)=>hashToken(canonical(value));
async function once(client:PoolClient,companyId:string,actorKey:string,clientId:string,operation:string,data:unknown,run:()=>Promise<Row>){
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`execution-request:${companyId}:${actorKey}:${clientId}`]);
 const hash=digest({operation,data}),previous=(await client.query('SELECT request_hash,response FROM studio_execution_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[companyId,actorKey,clientId])).rows[0];
 if(previous){if(previous.request_hash!==hash)fail(409,'This execution request ID was used for different data.','IDEMPOTENCY_CONFLICT');return {...previous.response,replayed:true};}
 const result=await run();await client.query('INSERT INTO studio_execution_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[companyId,actorKey,clientId,hash,JSON.stringify(result)]);return {...result,replayed:false};
}
async function event(client:PoolClient,companyId:string,actorId:string,kind:string){await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[companyId,actorId,'studio.execution_'+kind,'Studio execution '+kind+'. Renderer results remain subject to independent review.']);}
async function connectorView(client:PoolClient,companyId:string,connectorId:string){const connector=(await client.query(`SELECT ${connectorColumns} FROM studio_execution_connectors WHERE company_id=$1 AND id=$2`,[companyId,connectorId])).rows[0];if(!connector)fail(404,'Execution connector not found.');return connector;}
function observedJob(job:Row):Row{const leaseExpired=job.status==='running'&&(Date.parse(job.leaseExpiresAt)<=Date.now()||Date.parse(job.deadlineAt)<=Date.now());return {...job,leaseExpired,effectiveStatus:leaseExpired?'failed_uncertain':job.status};}
export async function studioExecutionJob(client:PoolClient,companyId:string,jobId:string):Promise<Row>{
 const job=(await client.query(`SELECT ${jobColumns} FROM studio_execution_jobs WHERE company_id=$1 AND id=$2`,[companyId,jobId])).rows[0];if(!job)fail(404,'Execution job not found.');
 const output=(await client.query('SELECT manifest,manifest_hash AS "manifestHash",verification_source AS "verificationSource",created_at AS "createdAt" FROM studio_execution_manifests WHERE company_id=$1 AND job_id=$2',[companyId,jobId])).rows[0];
 return {...observedJob(job),output:output??null,independentlyReviewed:false};
}
export async function studioExecutionInput(client:PoolClient,companyId:string,inputId:string){const input=(await client.query(`SELECT ${inputColumns} FROM studio_execution_inputs WHERE company_id=$1 AND id=$2`,[companyId,inputId])).rows[0];if(!input)fail(404,'Execution input reference not found.');return input;}
export async function studioExecutionSnapshot(client:PoolClient,companyId:string,projectId?:string,options:{kind?:'jobs'|'inputs'|'connectors';after?:string;limit?:number}={}){
 const kind=options.kind??'jobs',limit=options.limit??25,after=options.after;if(!['jobs','inputs','connectors'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Choose an execution resource and a page limit from 1 to 100.');if(after)id(after);
 if(projectId&&!(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rowCount)fail(404,'Studio project not found.');
 const table={jobs:'studio_execution_jobs',inputs:'studio_execution_inputs',connectors:'studio_execution_connectors'}[kind],columns={jobs:jobColumns,inputs:inputColumns,connectors:connectorColumns}[kind],projectFilter=kind==='connectors'?'AND $2::uuid IS NULL':'AND ($2::uuid IS NULL OR project_id=$2)';
 if(after&&!(await client.query(`SELECT id FROM ${table} WHERE company_id=$1 ${projectFilter} AND id=$3`,[companyId,kind==='connectors'?null:projectId??null,after])).rowCount)fail(404,'Execution page cursor not found.');
 const rows=(await client.query(`SELECT ${columns} FROM ${table} WHERE company_id=$1 ${projectFilter} AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,[companyId,kind==='connectors'?null:projectId??null,after??null,limit+1])).rows;
 const items=rows.slice(0,limit).map(row=>{if(kind!=='jobs')return row;const{inputReferences,...job}=observedJob(row);return {...job,inputReferenceCount:inputReferences.length,exactDetailsAvailable:true};});
 return {connectors:kind==='connectors'?items:[],inputs:kind==='inputs'?items:[],jobs:kind==='jobs'?items:[],page:{kind,after:after??null,limit,hasMore:rows.length>limit,nextAfter:rows.length>limit?items.at(-1)?.id??null:null},verificationSource:'connector_reported',independentlyReviewed:false};
}
async function projectLock(client:PoolClient,companyId:string,projectId:string,revision?:number){
 const row=(await client.query('SELECT * FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,projectId])).rows[0];if(!row)fail(404,'Studio project not found.');if(revision!==undefined&&row.revision!==revision)fail(409,'The studio project changed. Refresh before proposing execution.','STUDIO_REVISION_CONFLICT');if(row.status==='delivered')fail(409,'Delivered projects are immutable.');return row;
}
async function readyWork(client:PoolClient,companyId:string,projectId:string,workItemId:string,expected?:Row){
 const detail=await studioProjectDetail(client,companyId,projectId),work=detail.workItems.find(item=>item.id===workItemId);if(!work)fail(404,'Studio work item not found.');
 if(work.execution!=='dcc'||!work.shotId)fail(409,'Only a DCC production work item can execute.','STUDIO_EXECUTION_REQUIRED');
 if(detail.project.aiPolicy!=='allowed'||detail.project.gates.production?.decision!=='approved'||work.blockedReason||['review','done'].includes(work.status))fail(409,'Approved AI use, production gates and accepted dependencies are required.','STUDIO_EXECUTION_BLOCKED');
 if(expected&&digest(detail.project.spec)!==digest(expected.spec))fail(409,'The approved execution specification changed.','EXECUTION_SPEC_CHANGED');
 if(expected?.requested_agent_id&&work.agentId!==expected.requested_agent_id)fail(403,'The producing agent no longer holds this studio role.','STUDIO_ROLE_REQUIRED');
 const shot=detail.shots.find(item=>item.id===work.shotId)!;
 return {detail,work,shot};
}
async function actorAuthority(client:PoolClient,actor:StudioActor){
 await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[actor.companyId]);
 const sponsor=actor.agentId?(await client.query('SELECT created_by FROM agents WHERE company_id=$1 AND id=$2',[actor.companyId,actor.agentId])).rows[0]?.created_by:null;
 const hostPrincipals=actor.agentId?await managedAgentAuthorityPrincipals(client,actor.companyId,actor.agentId):[];
 const userIds=[...new Set([actor.userId,sponsor,...hostPrincipals].filter(Boolean))].sort();
 const members=(await client.query('SELECT user_id,role FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[actor.companyId,userIds])).rows;
 if(userIds.some(userId=>!members.some(member=>member.user_id===userId&&['owner','admin'].includes(member.role))))fail(403,'Execution requires a current administrator requester and agent sponsors.','EXECUTION_AUTHORITY_ENDED');
 if(actor.agentId){
  const agent=(await client.query(`SELECT a.* FROM agents a WHERE a.company_id=$1 AND a.id=$2 AND a.status='active' AND a.invocation_access<>'none' AND a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} FOR SHARE OF a`,[actor.companyId,actor.agentId])).rows[0];
  if(!agent?.capabilities.includes('studio.execute'))fail(403,'An explicitly approved studio.execute grant is required.','AGENT_CAPABILITY_REQUIRED');
  const run=(await client.query("SELECT * FROM agent_runs WHERE company_id=$1 AND id=$2 AND agent_id=$3 AND requested_by=$4 AND status='running' AND lease_expires_at>clock_timestamp() AND started_at>clock_timestamp()-interval '30 minutes' FOR UPDATE",[actor.companyId,actor.runId,actor.agentId,actor.userId])).rows[0];
  if(!run?.capabilities.includes('studio.execute'))fail(403,'The live run does not authorize execution.','AGENT_CAPABILITY_REQUIRED');
 }
}
export async function submitStudioExecution(client:PoolClient,actor:StudioActor,input:unknown){
 const data=parse(executionSubmitInput,input);await actorAuthority(client,actor);
 return once(client,actor.companyId,actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId,data.clientId,'submit',data,async()=>{
  const connector=(await client.query("SELECT * FROM studio_execution_connectors WHERE company_id=$1 AND id=$2 AND status='active' AND expires_at>clock_timestamp() FOR SHARE",[actor.companyId,data.connectorId])).rows[0];if(!connector)fail(404,'Active execution connector not found.');
  const profile=connector.profiles.find((item:Row)=>item.key===data.profileKey&&item.version===data.profileVersion);if(!profile)fail(400,'Choose an approved execution profile and exact version.','EXECUTION_PROFILE_REQUIRED');
  await projectLock(client,actor.companyId,data.projectId,data.revision);const {detail,work,shot}=await readyWork(client,actor.companyId,data.projectId,data.workItemId);
  const task=(await client.query('SELECT * FROM tasks WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,work.taskId])).rows[0];
  if(actor.agentId&&(work.agentId!==actor.agentId||task.agent_run_id!==actor.runId))fail(403,'The assigned agent must reserve this task in its current run.','STUDIO_ROLE_REQUIRED');
  const frames=data.frameEnd-data.frameStart+1,spec=detail.project.spec;if(frames>profile.maxFrames||data.frameStart<Math.max(0,shot.frameStart-shot.handles)||data.frameEnd>shot.frameEnd+shot.handles||spec.width<profile.minWidth||spec.height<profile.minHeight||spec.width>profile.maxWidth||spec.height>profile.maxHeight||spec.width*spec.height*frames>profile.maxTotalPixels||spec.fpsNumerator/spec.fpsDenominator<1||spec.fpsNumerator/spec.fpsDenominator>profile.maxFps||!profile.colorSpaces.includes(spec.colorSpace)||!profile.outputKinds.includes(data.outputKind)||data.outputKind==='image_sequence'&&spec.format!=='exr')fail(400,'Execution exceeds the approved shot or profile bounds.','EXECUTION_PROFILE_BOUNDS');
  const inputs=(await client.query(`SELECT ${inputColumns} FROM studio_execution_inputs WHERE company_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`,[actor.companyId,data.projectId,data.inputIds])).rows;
  if(inputs.length!==data.inputIds.length)fail(404,'An input reference is not in this project.');if((profile.inputKinds.length===0)!==(inputs.length===0)||inputs.some(item=>!profile.inputKinds.includes(item.kind))||inputs.reduce((total,item)=>total+Number(item.bytes),0)>profile.maxInputBytes)fail(400,'Input references exceed the approved profile.','EXECUTION_PROFILE_BOUNDS');
  if((await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND work_item_id=$2 AND status IN ('awaiting_approval','queued','running')",[actor.companyId,work.id])).rowCount)fail(409,'This work already has a pending execution job.','EXECUTION_ALREADY_PENDING');
  if(Number((await client.query('SELECT count(*) FROM studio_execution_jobs WHERE company_id=$1 AND project_id=$2',[actor.companyId,data.projectId])).rows[0].count)>=1000)fail(409,'This project has reached its execution job limit.');
  const job=(await client.query('INSERT INTO studio_execution_jobs(company_id,project_id,work_item_id,connector_id,requested_by,requested_agent_id,requested_run_id,profile,spec,input_snapshot,frame_start,frame_end,output_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',[actor.companyId,data.projectId,work.id,data.connectorId,actor.userId,actor.agentId??null,actor.runId??null,JSON.stringify(profile),JSON.stringify(detail.project.spec),JSON.stringify(inputs),data.frameStart,data.frameEnd,data.outputKind])).rows[0];
  for(const reference of inputs)await client.query('INSERT INTO studio_execution_job_inputs(company_id,project_id,job_id,input_id) VALUES($1,$2,$3,$4)',[actor.companyId,data.projectId,job.id,reference.id]);
  await event(client,actor.companyId,actor.userId,'proposed');return {job:await studioExecutionJob(client,actor.companyId,job.id)};
 });
}
export async function authenticateExecution(request:Request):Promise<ConnectorIdentity>{
 const token=bearer(request);if(!token.startsWith('ce_'))fail(401,'An execution connector credential is required.');
 const connector=(await query("SELECT c.* FROM studio_execution_connectors c JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.created_by WHERE c.token_hash=$1 AND c.status='active' AND c.expires_at>clock_timestamp() AND m.role IN ('owner','admin')",[hashToken(token)])).rows[0];if(!connector)fail(401,'Execution connector access ended.');
 await rateLimit('execution:'+connector.id,120,60);await query("UPDATE studio_execution_connectors SET last_seen_at=clock_timestamp() WHERE id=$1 AND token_hash=$2 AND (last_seen_at IS NULL OR last_seen_at<clock_timestamp()-interval '60 seconds')",[connector.id,connector.token_hash]);return connector as ConnectorIdentity;
}
async function lockConnector(client:PoolClient,identity:ConnectorIdentity,job?:Row){
 await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[identity.company_id]);
 const sourceAgent=job?.requested_agent_id?(await client.query('SELECT created_by FROM agents WHERE company_id=$1 AND id=$2',[identity.company_id,job.requested_agent_id])).rows[0]:null;
 const hostPrincipals=job?.requested_agent_id?await managedAgentAuthorityPrincipals(client,identity.company_id,job.requested_agent_id):[];
 const userIds=[...new Set([identity.created_by,...hostPrincipals,...job?[job.requested_by,...job.approved_by?[job.approved_by]:[],...sourceAgent?[sourceAgent.created_by]:[]]:[]])].sort();
 const members=(await client.query('SELECT user_id,role FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[identity.company_id,userIds])).rows;
 if(!members.some(item=>item.user_id===identity.created_by&&['owner','admin'].includes(item.role)))fail(401,'Execution connector sponsor access ended.');
 if(userIds.some(userId=>!members.some(item=>item.user_id===userId&&['owner','admin'].includes(item.role))))fail(403,'The execution requester or approver no longer has administrator authority.','EXECUTION_AUTHORITY_ENDED');
 if(job?.requested_agent_id){const agent=(await client.query(`SELECT a.* FROM agents a WHERE a.company_id=$1 AND a.id=$2 AND a.status='active' AND a.expires_at>clock_timestamp() AND a.invocation_access<>'none' AND ${managedAgentAuthoritySql('a')} FOR SHARE OF a`,[identity.company_id,job.requested_agent_id])).rows[0];if(!agent?.capabilities.includes('studio.execute'))fail(403,'The producing agent no longer has execution authority.','EXECUTION_AUTHORITY_ENDED');}
 const connector=(await client.query("SELECT * FROM studio_execution_connectors WHERE company_id=$1 AND id=$2 AND token_hash=$3 AND status='active' AND expires_at>clock_timestamp() FOR UPDATE",[identity.company_id,identity.id,identity.token_hash])).rows[0];if(!connector)fail(401,'Execution connector access ended.');return connector;
}
/** Rechecks current connector and producing authority before access to a completed job's exact outputs. */
export async function authorizeCompletedExecution(client:PoolClient,identity:ConnectorIdentity,jobId:string):Promise<Row>{
 const preview=(await client.query('SELECT * FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND id=$3',[identity.company_id,identity.id,jobId])).rows[0];if(!preview)fail(404,'Execution job not found.');
 await lockConnector(client,identity,preview);
 const job=(await client.query('SELECT * FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND id=$3 FOR SHARE',[identity.company_id,identity.id,jobId])).rows[0];if(job.status!=='succeeded')fail(409,'Only completed execution outputs can be uploaded.','EXECUTION_OUTPUT_UNAVAILABLE');
 const output=(await client.query('SELECT manifest,manifest_hash FROM studio_execution_manifests WHERE company_id=$1 AND job_id=$2',[identity.company_id,jobId])).rows[0];if(!output)fail(409,'Execution output evidence is unavailable.');return {...job,...output};
}
const proof=(identity:ConnectorIdentity,jobId:string,claimId:string)=>createHmac('sha256',identity.token_hash).update(`execution:${identity.company_id}:${identity.id}:${jobId}:${claimId}`).digest('base64url');
async function lockedJob(client:PoolClient,identity:ConnectorIdentity,jobId:string){
 const row=(await client.query('SELECT *,lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp() AS lease_live FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND id=$3 FOR UPDATE',[identity.company_id,identity.id,jobId])).rows[0];if(!row)fail(404,'Execution job not found.');return row;
}
function liveLease(job:Row,leaseToken:string){if(job.status==='cancelled')fail(409,'Execution was cancelled.','EXECUTION_CANCELLED');if(job.status!=='running'||!job.lease_live||job.lease_token_hash!==hashToken(leaseToken))fail(409,'This worker no longer owns a live execution lease.','EXECUTION_LEASE_LOST');}
async function claimExecution(identity:ConnectorIdentity,input:unknown){
 const data=parse(executionClaimInput,input);return transaction(async client=>{
  const priorJob=(await client.query('SELECT j.* FROM studio_execution_claims c JOIN studio_execution_jobs j ON j.company_id=c.company_id AND j.connector_id=c.connector_id AND j.id=c.job_id WHERE c.company_id=$1 AND c.connector_id=$2 AND c.claim_id=$3',[identity.company_id,identity.id,data.claimId])).rows[0];
  const candidate=(await client.query("SELECT * FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND status='queued' ORDER BY created_at,id LIMIT 1",[identity.company_id,identity.id])).rows[0];
  await lockConnector(client,identity,priorJob??candidate);
  const previous=(await client.query('SELECT * FROM studio_execution_claims WHERE company_id=$1 AND connector_id=$2 AND claim_id=$3',[identity.company_id,identity.id,data.claimId])).rows[0];
  if(previous){if(previous.worker_id!==data.workerId)fail(409,'This claim ID belongs to a different worker.','IDEMPOTENCY_CONFLICT');if(!previous.job_id)return {job:null,replayed:true};const job=await lockedJob(client,identity,previous.job_id),leaseToken=proof(identity,job.id,data.claimId);liveLease(job,leaseToken);return {job:await studioExecutionJob(client,identity.company_id,job.id),leaseToken,leaseExpiresAt:job.lease_expires_at,replayed:true};}
  await client.query("DELETE FROM studio_execution_claims WHERE company_id=$1 AND connector_id=$2 AND job_id IS NULL AND created_at<clock_timestamp()-interval '15 minutes'",[identity.company_id,identity.id]);
  // Expired work is uncertain. It is never returned to the executable queue.
  await client.query("UPDATE studio_execution_jobs SET status='failed_uncertain',failure_reason='lease_expired',finished_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND connector_id=$2 AND status='running' AND (lease_expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())",[identity.company_id,identity.id]);
  let job:Row|undefined;
  if(candidate&&!(await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND status='running'",[identity.company_id,identity.id])).rowCount){
   await projectLock(client,identity.company_id,candidate.project_id);const current=await lockedJob(client,identity,candidate.id);
   if(current.status==='queued'){await readyWork(client,identity.company_id,current.project_id,current.work_item_id,current);const leaseToken=proof(identity,current.id,data.claimId);job=(await client.query("UPDATE studio_execution_jobs SET status='running',worker_id=$3,claim_id=$4,lease_token_hash=$5,started_at=clock_timestamp(),deadline_at=clock_timestamp()+$6*interval '1 second',lease_expires_at=clock_timestamp()+LEAST(60,$6)*interval '1 second',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *",[identity.company_id,current.id,data.workerId,data.claimId,hashToken(leaseToken),current.profile.timeoutSeconds])).rows[0];}
  }
  await client.query('INSERT INTO studio_execution_claims(company_id,connector_id,claim_id,worker_id,job_id) VALUES($1,$2,$3,$4,$5)',[identity.company_id,identity.id,data.claimId,data.workerId,job?.id??null]);
  return job?{job:await studioExecutionJob(client,identity.company_id,job.id),leaseToken:proof(identity,job.id,data.claimId),leaseExpiresAt:job.lease_expires_at,replayed:false}:{job:null,replayed:false};
 });
}
export function validateExecutionManifest(job:Row,manifest:ExecutionManifest){
 const data=parse(executionManifestInput,manifest),files=data.files;
 if(files.reduce((total,file)=>total+file.bytes,0)>job.profile.maxOutputBytes)fail(400,'Output exceeds its approved byte limit.','EXECUTION_OUTPUT_INVALID');
 const kind=job.output_kind??job.outputKind,start=job.frame_start??job.frameStart,end=job.frame_end??job.frameEnd;
 if(kind==='image_sequence'){
  const images=files.filter(file=>file.kind==='image');if(!data.spec||digest(data.spec)!==digest(job.spec)||images.some(file=>!file.path.toLowerCase().endsWith('.exr'))||!data.verification.frameCoverage||!data.verification.imageMetadata)fail(400,'Image output requires verified metadata matching the job specification.','EXECUTION_OUTPUT_INVALID');
  const frames=new Set(images.map(file=>file.frame));if(images.length!==end-start+1||frames.size!==images.length||images.some(file=>file.frame===undefined||file.frame<start||file.frame>end))fail(400,'The exact expected image frame range is incomplete or duplicated.','EXECUTION_OUTPUT_INVALID');
 }else if(!files.some(file=>file.kind===kind))fail(400,'The expected native output is missing.','EXECUTION_OUTPUT_INVALID');
 return data;
}
async function workerJobAction(identity:ConnectorIdentity,jobId:string,action:string,input:unknown){
 const data=parse(action==='heartbeat'?executionLeaseInput:action==='complete'?executionCompleteInput:executionFailureInput,input) as Row;
 return transaction(async client=>{
  const preview=(await client.query('SELECT * FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND id=$3',[identity.company_id,identity.id,jobId])).rows[0];if(!preview)fail(404,'Execution job not found.');await lockConnector(client,identity,preview);
  const act=async()=>{
   await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[identity.company_id,preview.project_id]);const job=await lockedJob(client,identity,jobId);liveLease(job,data.leaseToken);if(action!=='fail')await readyWork(client,identity.company_id,job.project_id,job.work_item_id,job);
   if(action==='heartbeat'){await client.query("UPDATE studio_execution_jobs SET lease_expires_at=LEAST(deadline_at,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[identity.company_id,jobId]);return {job:await studioExecutionJob(client,identity.company_id,jobId),leaseExpiresAt:(await client.query('SELECT lease_expires_at FROM studio_execution_jobs WHERE id=$1',[jobId])).rows[0].lease_expires_at};}
   if(action==='complete'){const manifest=validateExecutionManifest(job,data.manifest);await client.query('INSERT INTO studio_execution_manifests(job_id,company_id,connector_id,manifest,manifest_hash) VALUES($1,$2,$3,$4,$5)',[jobId,identity.company_id,identity.id,JSON.stringify(manifest),digest(manifest)]);await client.query("UPDATE studio_execution_jobs SET status='succeeded',revision=revision+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[identity.company_id,jobId]);}
   else await client.query("UPDATE studio_execution_jobs SET status=$3,failure_reason=$4,revision=revision+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[identity.company_id,jobId,data.reason==='worker_interrupted'?'failed_uncertain':'failed',data.reason]);
   await event(client,identity.company_id,identity.created_by,action==='complete'?'completed':'failed');return {job:await studioExecutionJob(client,identity.company_id,jobId)};
  };
  if(action==='heartbeat')return act();return once(client,identity.company_id,'connector:'+identity.id,data.clientId,action+':'+jobId,data,act);
 });
}
export async function studioExecutionRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]==='execution'){
  const identity=await authenticateExecution(request);
  if(parts.length===2&&parts[1]==='identity'&&method==='GET')return json({connector:await transaction(client=>connectorView(client,identity.company_id,identity.id))});
  if(parts.length===3&&parts[1]==='jobs'&&parts[2]==='claim'&&method==='POST')return json(await claimExecution(identity,await body(request,executionClaimInput)));
  if(parts.length===4&&parts[1]==='jobs'&&['heartbeat','complete','fail'].includes(parts[3])&&method==='POST'){const schema=parts[3]==='heartbeat'?executionLeaseInput:parts[3]==='complete'?executionCompleteInput:executionFailureInput;return json(await workerJobAction(identity,id(parts[2]),parts[3],await body(request,schema as z.ZodType,512*1024)));}return null;
 }
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='execution')return null;
 if(method!=='GET')assertOrigin(request);const companyId=id(parts[1]),member=await requireMembership(request,companyId,method!=='GET'),actor:StudioActor={companyId,userId:member.userId};
 if(parts.length===4&&method==='GET'){const search=new URL(request.url).searchParams,keys=[...search.keys()];if(keys.some(key=>!['projectId','kind','after','limit'].includes(key))||new Set(keys).size!==keys.length)fail(400,'Unsupported execution query.');const page=parse(z.object({projectId:z.string().uuid().optional(),kind:z.enum(['jobs','inputs','connectors']).default('jobs'),after:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict(),Object.fromEntries(search));return json(await memberMutation(member,false,client=>studioExecutionSnapshot(client,companyId,page.projectId,page)));}
 if(parts[4]==='inputs'&&parts.length===6&&method==='GET')return json({input:await memberMutation(member,false,client=>studioExecutionInput(client,companyId,id(parts[5])))});
 if(parts[4]==='jobs'&&parts.length===6&&method==='GET')return json({job:await memberMutation(member,false,client=>studioExecutionJob(client,companyId,id(parts[5])))});
 if(parts[4]==='jobs'&&parts.length===5&&method==='POST'){const data=await body(request,executionSubmitInput);const result=await memberMutation(member,true,client=>submitStudioExecution(client,actor,data));return json(result,result.replayed?200:201);}
 if(parts[4]==='connectors'&&parts.length===5&&method==='POST'){
  const data=await body(request,executionConnectorInput);let token:string|null=null;
  const result=await memberMutation(member,true,client=>once(client,companyId,'human:'+member.userId,data.clientId,'connector',data,async()=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`execution-connectors:${companyId}`]);if(Number((await client.query("SELECT count(*) FROM studio_execution_connectors WHERE company_id=$1 AND status<>'revoked'",[companyId])).rows[0].count)>=20)fail(409,'This company reached its 20-connector limit.');
   token=secret('ce_');const connector=(await client.query('INSERT INTO studio_execution_connectors(company_id,name,profiles,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval \'1 day\') RETURNING id',[companyId,data.name,JSON.stringify(data.profiles),hashToken(token),member.userId,data.expiresInDays])).rows[0];await event(client,companyId,member.userId,'connector_registered');return {connector:await connectorView(client,companyId,connector.id)};
  }));return json({...result,token},result.replayed?200:201);
 }
 if(parts[4]==='connectors'&&parts.length===6&&method==='PATCH'){
  const connectorId=id(parts[5]),data=await body(request,executionConnectorPatchInput);return json(await memberMutation(member,true,client=>once(client,companyId,'human:'+member.userId,data.clientId,'connector-state:'+connectorId,data,async()=>{
   const connector=(await client.query('SELECT * FROM studio_execution_connectors WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,connectorId])).rows[0];if(!connector)fail(404,'Execution connector not found.');if(connector.status==='revoked')fail(409,'Revoked connectors cannot be reactivated.');if(connector.revision!==data.revision)fail(409,'The connector changed.','EXECUTION_REVISION_CONFLICT');
   await client.query('UPDATE studio_execution_connectors SET status=$3,revision=revision+1 WHERE company_id=$1 AND id=$2',[companyId,connectorId,data.status]);if(data.status!=='active')await client.query("UPDATE studio_execution_jobs SET status='cancelled',failure_reason='connector_access_ended',revision=revision+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND connector_id=$2 AND status IN ('awaiting_approval','queued','running')",[companyId,connectorId]);return {connector:await connectorView(client,companyId,connectorId)};
  })));
 }
 if(parts[4]==='inputs'&&parts.length===5&&method==='POST'){
  const data=await body(request,executionInputRegisterInput);const result=await memberMutation(member,true,client=>once(client,companyId,'human:'+member.userId,data.clientId,'input',data,async()=>{
   await projectLock(client,companyId,data.projectId);if(Number((await client.query('SELECT count(*) FROM studio_execution_inputs WHERE company_id=$1 AND project_id=$2',[companyId,data.projectId])).rows[0].count)>=1000)fail(409,'This project reached its input-reference limit.');
   const reference=(await client.query(`INSERT INTO studio_execution_inputs(company_id,project_id,name,kind,storage_key,sha256,bytes,registered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${inputColumns}`,[companyId,data.projectId,data.name,data.kind,data.storageKey,data.sha256,data.bytes,member.userId])).rows[0];return {input:reference};
  }));return json(result,result.replayed?200:201);
 }
 if(parts[4]==='jobs'&&parts.length===7&&['approve','cancel'].includes(parts[6])&&method==='POST'){
  const jobId=id(parts[5]),data=await body(request,executionJobActionInput),action=parts[6];return json(await memberMutation(member,true,client=>once(client,companyId,'human:'+member.userId,data.clientId,action+':'+jobId,data,async()=>{
   const preview=(await client.query('SELECT * FROM studio_execution_jobs WHERE company_id=$1 AND id=$2',[companyId,jobId])).rows[0];if(!preview)fail(404,'Execution job not found.');
   const connector=(await client.query('SELECT * FROM studio_execution_connectors WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,preview.connector_id])).rows[0];
   if(action==='approve')await projectLock(client,companyId,preview.project_id);else await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,preview.project_id]);const job=(await client.query('SELECT * FROM studio_execution_jobs WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,jobId])).rows[0];if(job.revision!==data.revision)fail(409,'The execution job changed.','EXECUTION_REVISION_CONFLICT');
   if(action==='approve'){if(job.status!=='awaiting_approval')fail(409,'Only a proposed job can be approved.');if(connector.status!=='active'||Date.parse(connector.expires_at)<=Date.now())fail(409,'The execution connector is unavailable.');await readyWork(client,companyId,job.project_id,job.work_item_id,job);await client.query("UPDATE studio_execution_jobs SET status='queued',approved_by=$3,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[companyId,jobId,member.userId]);}
   else{if(!['awaiting_approval','queued','running'].includes(job.status))fail(409,'The execution job has already ended.');await client.query("UPDATE studio_execution_jobs SET status='cancelled',failure_reason='administrator_cancelled',revision=revision+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[companyId,jobId]);}
   await event(client,companyId,member.userId,action==='approve'?'approved':'cancelled');return {job:await studioExecutionJob(client,companyId,jobId)};
  })));
 }
 return null;
}
