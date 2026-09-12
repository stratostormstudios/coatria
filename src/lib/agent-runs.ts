import {createHmac,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from './db';
import {fail,hashToken,id,uuid} from './security';
import type {Membership} from './auth';
import {AGENT_CAPABILITIES} from './agent-policy';
import {sendRunConversationMessage} from './conversations';
import type {AgentRun} from './agent-run-protocol';

export type AgentRunIdentity={id:string;company_id:string;created_by:string;token_hash:string};
export const runInput=z.object({clientId:uuid,agentId:uuid,prompt:z.string().trim().min(1).max(6000),parentId:uuid.nullable().optional()}).strict();
export const claimInput=z.object({workerId:z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/),claimId:uuid}).strict();
export const leaseInput=z.object({leaseToken:z.string().min(20).max(200)}).strict();
export const completeInput=leaseInput.extend({clientId:uuid,result:z.string().trim().min(1).max(12000),artifactUrl:z.string().url().max(2048).refine(value=>{const url=new URL(value);return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}).optional()}).strict();
export const failInput=leaseInput.extend({clientId:uuid,error:z.string().trim().min(1).max(2000)}).strict();
const listInput=z.object({agentId:uuid.optional(),parentId:uuid.optional(),limit:z.number().int().min(1).max(50).optional()}).strict();
const runColumns=`r.id,r.company_id AS "companyId",COALESCE(c.room_id::text,'commons') AS channel,r.conversation_id AS "conversationId",r.parent_id AS "parentId",r.prompt,r.requested_by AS "requestedBy",u.name AS "requesterName",r.agent_id AS "agentId",a.name AS "agentName",r.status,r.attempts,r.max_attempts AS "maxAttempts",r.capabilities,r.available_at AS "availableAt",r.lease_expires_at AS "leaseExpiresAt",r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.started_at AS "startedAt",(r.started_at+interval '30 minutes') AS "deadlineAt",r.finished_at AS "finishedAt",r.result,r.error,r.artifact_url AS "artifactUrl",r.result_message_id AS "resultMessageId"`;
function parse<T>(schema:z.ZodType<T>,input:unknown){const value=schema.safeParse(input);if(!value.success)fail(400,value.error.issues.slice(0,3).map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; '),'VALIDATION_ERROR');return value.data;}
function capabilities(value:unknown):string[]{return Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'&&(AGENT_CAPABILITIES as readonly string[]).includes(item)))]:[];}
async function project(client:PoolClient,companyId:string,runId:string):Promise<AgentRun>{const row=(await client.query(`SELECT ${runColumns} FROM agent_runs r JOIN conversations c ON c.company_id=r.company_id AND c.id=r.conversation_id JOIN users u ON u.id=r.requested_by JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id WHERE r.company_id=$1 AND r.id=$2`,[companyId,runId])).rows[0];if(!row)fail(404,'Agent request not found.');return row;}
async function lockCompany(client:PoolClient,companyId:string){if(!(await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[companyId])).rowCount)fail(404,'Workspace not found.');}
async function humanAuthority(client:PoolClient,member:Membership){await lockCompany(client,member.companyId);const role=(await client.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role<>'removed' FOR SHARE",[member.companyId,member.userId])).rows[0]?.role;if(!role)fail(403,'Your company access has ended.');return role;}
async function authority(client:PoolClient,identity:AgentRunIdentity,requesterId?:string,exclusive=false,human=false){
 await lockCompany(client,identity.company_id);
 const users=[...new Set([identity.created_by,...(requesterId?[requesterId]:[])])].sort();
 const members=(await client.query('SELECT user_id,role FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[identity.company_id,users])).rows;
 if(!members.some(member=>member.user_id===identity.created_by&&['owner','admin'].includes(member.role)))fail(human?409:401,'Agent sponsor access ended.',human?'AGENT_UNAVAILABLE':undefined);
 const requesterRole=requesterId?members.find(member=>member.user_id===requesterId&&member.role!=='removed')?.role:undefined;
 if(requesterId&&!requesterRole)fail(403,'The requester no longer belongs to this company.','RUN_REQUESTER_ACCESS');
 const agent=(await client.query(`SELECT * FROM agents WHERE id=$1 AND company_id=$2 AND created_by=$3 AND token_hash=$4 AND status='active' AND expires_at>clock_timestamp() FOR ${exclusive?'UPDATE':'SHARE'}`,[identity.id,identity.company_id,identity.created_by,identity.token_hash])).rows[0];
 if(!agent)fail(human?409:401,'Agent credential is expired, paused, revoked or rotated.',human?'AGENT_UNAVAILABLE':undefined);
 if(agent.invocation_access==='none'||requesterRole&&agent.invocation_access==='admins'&&!['owner','admin'].includes(requesterRole))fail(403,'This agent is not available to this requester.','AGENT_INVOCATION_ACCESS');
 return{agent,requesterRole};
}
async function lockedRun(client:PoolClient,identity:AgentRunIdentity,runId:string){
 id(runId);const preview=(await client.query('SELECT requested_by FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND id=$3',[identity.company_id,identity.id,runId])).rows[0];if(!preview)fail(404,'Agent request not found.');
 const access=await authority(client,identity,preview.requested_by);
 const run=(await client.query("SELECT *,lease_expires_at>clock_timestamp() AND started_at>clock_timestamp()-interval '30 minutes' AS lease_live FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND id=$3 FOR UPDATE",[identity.company_id,identity.id,runId])).rows[0];
 if(!run)fail(404,'Agent request not found.');return{...access,run,capabilities:capabilities(run.capabilities).filter(capability=>capabilities(access.agent.capabilities).includes(capability))};
}
function requireLease(run:Record<string,any>,leaseToken:string){
 if(run.status==='cancelled')fail(409,'This request was cancelled.','RUN_CANCELLED');
 if(run.status!=='running'||!run.lease_live||run.lease_token_hash!==hashToken(leaseToken))fail(409,'This worker no longer owns a live lease.','RUN_LEASE_LOST');
}
/** Caller owns the transaction. Locks company -> sorted memberships -> agent -> run. */
export async function authorizeRunTool(client:PoolClient,identity:AgentRunIdentity,runId:string,leaseToken:string){const access=await lockedRun(client,identity,runId);requireLease(access.run,leaseToken);return access as{run:Record<string,any>;capabilities:string[];requesterRole:string;agent:Record<string,any>};}

export async function createAgentRun(member:Membership,channel:string,input:unknown){
 const data=parse(runInput,input),roomId=channel==='commons'?null:id(channel);
 return transaction(async client=>{
  const candidate=(await client.query('SELECT * FROM agents WHERE company_id=$1 AND id=$2',[member.companyId,data.agentId])).rows[0];if(!candidate)fail(404,'Agent not found.');
  // Queueing is a human action. Recheck sponsor and requester together before agent locks.
  const access=await authority(client,candidate,member.userId,false,true);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`agent-run-request:${member.companyId}:${member.userId}:${data.clientId}`]);
  const digest=hashToken(JSON.stringify({agentId:data.agentId,roomId,parentId:data.parentId||null,prompt:data.prompt}));
  const prior=(await client.query('SELECT id,payload_hash FROM agent_runs WHERE company_id=$1 AND requested_by=$2 AND client_id=$3',[member.companyId,member.userId,data.clientId])).rows[0];
  if(prior){if(prior.payload_hash!==digest)fail(409,'This request key was used for different work.','IDEMPOTENCY_CONFLICT');return{run:await project(client,member.companyId,prior.id),replayed:true};}
  if(roomId&&!(await client.query('SELECT id FROM rooms WHERE company_id=$1 AND id=$2 FOR KEY SHARE',[member.companyId,roomId])).rowCount)fail(404,'Conversation not found.');
  await client.query('INSERT INTO conversations(company_id,room_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[member.companyId,roomId]);
  const conversation=(await client.query('SELECT id FROM conversations WHERE company_id=$1 AND room_id IS NOT DISTINCT FROM $2::uuid FOR SHARE',[member.companyId,roomId])).rows[0];
  if(data.parentId){const parent=(await client.query('SELECT parent_id,deleted_at FROM messages WHERE company_id=$1 AND conversation_id=$2 AND id=$3',[member.companyId,conversation.id,data.parentId])).rows[0];if(!parent)fail(404,'Parent message not found.');if(parent.parent_id)fail(400,'Requests can only be attached to a top-level thread.');if(parent.deleted_at)fail(409,'The parent message has been deleted.','MESSAGE_DELETED');}
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`agent-run-quota:${member.companyId}:${data.agentId}`]);
  if(Number((await client.query("SELECT count(*) FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND status IN ('queued','running')",[member.companyId,data.agentId])).rows[0].count)>=100)fail(429,'This agent already has 100 pending requests.','AGENT_QUEUE_FULL');
  const row=(await client.query('INSERT INTO agent_runs(company_id,agent_id,requested_by,conversation_id,parent_id,client_id,payload_hash,prompt,capabilities) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[member.companyId,data.agentId,member.userId,conversation.id,data.parentId||null,data.clientId,digest,data.prompt,JSON.stringify(capabilities(access.agent.capabilities))])).rows[0];
  return{run:await project(client,member.companyId,row.id),replayed:false};
 });
}
export async function listAgentRuns(member:Membership,channel:string|undefined,input:unknown={}){
 const options=parse(listInput,input),roomId=channel===undefined?undefined:channel==='commons'?null:id(channel);
 return transaction(async client=>{await humanAuthority(client,member);const rows=(await client.query(`SELECT ${runColumns} FROM agent_runs r JOIN conversations c ON c.company_id=r.company_id AND c.id=r.conversation_id JOIN users u ON u.id=r.requested_by JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id WHERE r.company_id=$1 AND ($2::boolean OR c.room_id IS NOT DISTINCT FROM $3::uuid) AND ($4::uuid IS NULL OR r.agent_id=$4) AND ($5::uuid IS NULL OR r.parent_id=$5) ORDER BY r.created_at DESC,r.id DESC LIMIT $6`,[member.companyId,roomId===undefined,roomId??null,options.agentId||null,options.parentId||null,options.limit||20])).rows;return{runs:rows as AgentRun[]};});
}
export async function getAgentRun(member:Membership,runId:string){id(runId);return transaction(async client=>{await humanAuthority(client,member);const run=await project(client,member.companyId,runId);const actions=(await client.query('SELECT request_id AS "requestId",tool,created_at AS "createdAt" FROM agent_tool_receipts WHERE company_id=$1 AND run_id=$2 ORDER BY created_at,request_id LIMIT 200',[member.companyId,runId])).rows;return{run,actions};});}
export async function cancelAgentRun(member:Membership,runId:string){id(runId);return transaction(async client=>{
 const role=await humanAuthority(client,member),preview=(await client.query('SELECT agent_id FROM agent_runs WHERE company_id=$1 AND id=$2',[member.companyId,runId])).rows[0];if(!preview)fail(404,'Agent request not found.');
 await client.query('SELECT id FROM agents WHERE company_id=$1 AND id=$2 FOR SHARE',[member.companyId,preview.agent_id]);
 const run=(await client.query('SELECT * FROM agent_runs WHERE company_id=$1 AND id=$2 FOR UPDATE',[member.companyId,runId])).rows[0];if(run.requested_by!==member.userId&&!['owner','admin'].includes(role))fail(403,'Only the requester or an administrator can cancel this work.');
 if(['succeeded','failed'].includes(run.status))fail(409,'This request has already finished.','RUN_TERMINAL');
 if(run.status!=='cancelled')await client.query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[member.companyId,runId]);return{run:await project(client,member.companyId,runId)};
});}
function leaseProof(identity:AgentRunIdentity,runId:string,attempt:number,claimId:string){return createHmac('sha256',identity.token_hash).update(`${identity.company_id}:${identity.id}:${runId}:${attempt}:${claimId}`).digest('base64url');}
export async function claimAgentRun(identity:AgentRunIdentity,input:unknown){
 const data=parse(claimInput,input);return transaction(async client=>{
  // Agent FOR UPDATE serializes claims to one active run per agent. Tools only use SHARE.
  const access=await authority(client,identity,undefined,true);
  await client.query("DELETE FROM agent_run_claims WHERE agent_id=$1 AND run_id IS NULL AND created_at<clock_timestamp()-interval '15 minutes'",[identity.id]);
  const prior=(await client.query('SELECT * FROM agent_run_claims WHERE agent_id=$1 AND claim_id=$2',[identity.id,data.claimId])).rows[0];
  if(prior){if(prior.worker_id!==data.workerId)fail(409,'This claim key belongs to a different worker.','IDEMPOTENCY_CONFLICT');if(!prior.run_id)return{run:null,replayed:true};
   const proof=leaseProof(identity,prior.run_id,prior.attempt,data.claimId),run=(await client.query("SELECT *,lease_expires_at>clock_timestamp() AND started_at>clock_timestamp()-interval '30 minutes' AS lease_live FROM agent_runs WHERE company_id=$1 AND id=$2 FOR UPDATE",[identity.company_id,prior.run_id])).rows[0];
   requireLease(run,proof);const requester=(await client.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role<>'removed'",[identity.company_id,run.requested_by])).rows[0];if(!requester||access.agent.invocation_access==='admins'&&!['owner','admin'].includes(requester.role))fail(403,'The requester no longer has access.','RUN_REQUESTER_ACCESS');return{run:await project(client,identity.company_id,run.id),leaseToken:proof,leaseExpiresAt:run.lease_expires_at,replayed:true};}
  // Company KEY SHARE prevents member offboarding from committing during this claim.
  await client.query("UPDATE agent_runs r SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error='Requester access ended.' WHERE r.company_id=$1 AND r.agent_id=$2 AND r.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=r.company_id AND m.user_id=r.requested_by AND m.role<>'removed' AND ($3<>'admins' OR m.role IN ('owner','admin')))",[identity.company_id,identity.id,access.agent.invocation_access]);
  await client.query("UPDATE agent_runs SET status='failed',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error='The 30-minute execution deadline was reached.' WHERE company_id=$1 AND agent_id=$2 AND status IN ('queued','running') AND started_at<=clock_timestamp()-interval '30 minutes'",[identity.company_id,identity.id]);
  await client.query("UPDATE agent_runs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,available_at=clock_timestamp()+interval '5 seconds',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=CASE WHEN attempts>=max_attempts THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp(),error='Worker lease expired.' WHERE company_id=$1 AND agent_id=$2 AND status='running' AND lease_expires_at<=clock_timestamp()",[identity.company_id,identity.id]);
  let run:Record<string,any>|undefined;
  if(!(await client.query("SELECT id FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND status='running' AND lease_expires_at>clock_timestamp()",[identity.company_id,identity.id])).rowCount)run=(await client.query("SELECT * FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND status='queued' AND available_at<=clock_timestamp() AND attempts<max_attempts ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",[identity.company_id,identity.id])).rows[0];
  if(!run){await client.query('INSERT INTO agent_run_claims(company_id,agent_id,claim_id,worker_id) VALUES($1,$2,$3,$4)',[identity.company_id,identity.id,data.claimId,data.workerId]);return{run:null,replayed:false};}
  const attempt=run.attempts+1,proof=leaseProof(identity,run.id,attempt,data.claimId);
  await client.query("UPDATE agent_runs SET status='running',attempts=$3,worker_id=$4,lease_token_hash=$5,lease_expires_at=clock_timestamp()+interval '60 seconds',started_at=COALESCE(started_at,clock_timestamp()),updated_at=clock_timestamp(),error='' WHERE company_id=$1 AND id=$2",[identity.company_id,run.id,attempt,data.workerId,hashToken(proof)]);
  await client.query('INSERT INTO agent_run_claims(company_id,agent_id,claim_id,worker_id,run_id,attempt) VALUES($1,$2,$3,$4,$5,$6)',[identity.company_id,identity.id,data.claimId,data.workerId,run.id,attempt]);
  const result=await project(client,identity.company_id,run.id);return{run:result,leaseToken:proof,leaseExpiresAt:result.leaseExpiresAt,replayed:false};
 });
}
export async function heartbeatAgentRun(identity:AgentRunIdentity,runId:string,input:unknown){const data=parse(leaseInput,input);return transaction(async client=>{await authorizeRunTool(client,identity,runId,data.leaseToken);await client.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[identity.company_id,runId]);const run=await project(client,identity.company_id,runId);return{run,leaseExpiresAt:run.leaseExpiresAt};});}
export async function agentRunContext(identity:AgentRunIdentity,runId:string,leaseToken:string){parse(leaseInput,{leaseToken});return transaction(async client=>{const access=await authorizeRunTool(client,identity,runId,leaseToken);await client.query('SELECT id FROM conversations WHERE company_id=$1 AND id=$2 FOR SHARE',[identity.company_id,access.run.conversation_id]);const messages=(await client.query(`SELECT m.id,m.body,m.parent_id AS "parentId",m.sequence::text AS sequence,m.deleted_at AS "deletedAt",m.actor_kind AS "actorKind",COALESCE(m.user_id,m.agent_id) AS "actorId",COALESCE(u.name,a.name,'Former teammate') AS "authorName" FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.company_id=m.company_id AND a.id=m.agent_id WHERE m.company_id=$1 AND m.conversation_id=$2 AND (($3::uuid IS NULL AND m.parent_id IS NULL) OR m.id=$3 OR m.parent_id=$3) ORDER BY (m.id=$3) DESC NULLS LAST,m.sequence DESC LIMIT 30`,[identity.company_id,access.run.conversation_id,access.run.parent_id])).rows.sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1);return{run:await project(client,identity.company_id,runId),messages,capabilities:access.capabilities};});}
export async function finishAgentRun(identity:AgentRunIdentity,runId:string,kind:'complete'|'fail',input:unknown){
 const data=kind==='complete'?parse(completeInput,input):parse(failInput,input);
 return transaction(async client=>{
  const access=await lockedRun(client,identity,runId),digest=hashToken(JSON.stringify({kind,...('result'in data?{result:data.result,artifactUrl:data.artifactUrl||null}:{error:data.error})}));
  const prior=(await client.query('SELECT * FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2 AND client_id=$3',[identity.company_id,runId,data.clientId])).rows[0];
  if(prior){if(prior.payload_hash!==digest||prior.kind!==kind)fail(409,'This completion key was used for another result.','IDEMPOTENCY_CONFLICT');if(prior.lease_token_hash!==hashToken(data.leaseToken))fail(409,'This receipt belongs to another lease.','RUN_LEASE_LOST');return{...prior.response,replayed:true};}
  requireLease(access.run,data.leaseToken);
  if(kind==='complete'&&'result'in data){
   const channel=(await client.query('SELECT room_id FROM conversations WHERE company_id=$1 AND id=$2',[identity.company_id,access.run.conversation_id])).rows[0];
   const result=await sendRunConversationMessage(client,{kind:'agent',companyId:identity.company_id,userId:identity.created_by,agentId:identity.id,tokenHash:identity.token_hash},channel.room_id||'commons',{clientId:randomUUID(),body:data.result.length>3800?data.result.slice(0,3800)+'\n\nOpen the agent request to read the full result.':data.result,parentId:access.run.parent_id});
   await client.query("UPDATE agent_runs SET status='succeeded',result=$3,artifact_url=$4,result_message_id=$5,error='',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[identity.company_id,runId,data.result,data.artifactUrl||null,result.message.id]);
  }else if('error'in data)await client.query("UPDATE agent_runs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,error=$3,available_at=clock_timestamp()+CASE WHEN attempts=1 THEN interval '5 seconds' ELSE interval '30 seconds' END,worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=CASE WHEN attempts>=max_attempts THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[identity.company_id,runId,data.error]);
  const response={run:await project(client,identity.company_id,runId)};await client.query('INSERT INTO agent_run_receipts(company_id,run_id,client_id,kind,payload_hash,lease_token_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[identity.company_id,runId,data.clientId,kind,digest,hashToken(data.leaseToken),JSON.stringify(response)]);return{...response,replayed:false};
 });
}
