import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {requireMembership,type Membership} from './auth';
import {memberMutation,recordActivity} from './company';
import {transaction} from './db';
import {authenticateAgent} from './integrations';
import {createAgentRunInTransaction,type AgentRunIdentity} from './agent-runs';
import {body,fail,hashToken,id,json,rateLimit,uuid} from './security';

const createInput=z.object({clientId:uuid,agentId:uuid,name:z.string().trim().min(1).max(100),objective:z.string().trim().min(1).max(3000),intervalMinutes:z.number().int().min(15).max(1440).default(60),maxCycles:z.number().int().min(1).max(100).default(5),status:z.enum(['active','paused']).default('paused')}).strict();
const patchInput=z.object({revision:z.number().int().min(1).max(2147483646),name:z.string().trim().min(1).max(100).optional(),objective:z.string().trim().min(1).max(3000).optional(),intervalMinutes:z.number().int().min(15).max(1440).optional(),maxCycles:z.number().int().min(1).max(100).optional(),status:z.enum(['active','paused']).optional()}).strict().refine(value=>Object.keys(value).length>1,'Provide a mission change.');
export {createInput as missionCreateInput,patchInput as missionPatchInput};
const columns=`m.id,m.company_id AS "companyId",m.agent_id AS "agentId",a.name AS "agentName",m.created_by AS "createdBy",m.name,m.objective,m.interval_minutes AS "intervalMinutes",m.max_cycles AS "maxCycles",m.cycles_started AS "cyclesStarted",m.status,m.revision,m.next_run_at AS "nextRunAt",m.last_run_id AS "lastRunId",r.status AS "lastRunStatus",m.pause_reason AS "pauseReason",m.created_at AS "createdAt",m.updated_at AS "updatedAt"`;
async function project(client:PoolClient,companyId:string,missionId:string){const row=(await client.query(`SELECT ${columns} FROM agent_missions m JOIN agents a ON a.company_id=m.company_id AND a.id=m.agent_id LEFT JOIN agent_runs r ON r.company_id=m.company_id AND r.id=m.last_run_id WHERE m.company_id=$1 AND m.id=$2`,[companyId,missionId])).rows[0];if(!row)fail(404,'Mission not found.');return row;}
async function lockAgent(client:PoolClient,companyId:string,agentId:string,authorIds:string[]){
 const preview=(await client.query('SELECT created_by FROM agents WHERE company_id=$1 AND id=$2',[companyId,agentId])).rows[0];if(!preview)fail(404,'Agent not found.');
 const users=[...new Set([preview.created_by,...authorIds])].sort(),members=(await client.query('SELECT user_id,role FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[companyId,users])).rows;
 const agent=(await client.query('SELECT *,expires_at>clock_timestamp() AS credential_live FROM agents WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,agentId])).rows[0];if(!agent)fail(404,'Agent not found.');return{agent,members};
}
function authorityReason(agent:Record<string,any>,members:Record<string,any>[],authorId:string){
 if(agent.status!=='active'||!agent.credential_live)return 'The agent is paused, revoked, or its credential has expired.';
 if(!members.some(member=>member.user_id===agent.created_by&&['owner','admin'].includes(member.role)))return 'The agent sponsor no longer has administrator access.';
 if(!members.some(member=>member.user_id===authorId&&['owner','admin'].includes(member.role)))return 'The mission author no longer has administrator access.';
 if(agent.invocation_access==='none')return 'The agent has no invocation permission.';
 return '';
}
async function cancelMissionRuns(client:PoolClient,companyId:string,missionId:string){
 await client.query("UPDATE agent_runs r SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error='Mission paused or changed by an administrator.' FROM agent_mission_cycles c WHERE c.company_id=$1 AND c.mission_id=$2 AND r.company_id=c.company_id AND r.id=c.run_id AND r.status IN ('queued','running')",[companyId,missionId]);
}
async function pause(client:PoolClient,companyId:string,missionId:string,reason:string){await client.query("UPDATE agent_missions SET status='paused',pause_reason=$3,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND (status<>'paused' OR pause_reason<>$3)",[companyId,missionId,reason]);}
function scheduledId(missionId:string,ordinal:number){const bytes=createHash('sha256').update(`coatria-mission:${missionId}:${ordinal}`).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex');return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
function prompt(mission:Record<string,any>){return `Company mission: ${mission.name}\nCycle ${mission.cycles_started+1} of ${mission.max_cycles}.\nObjective: ${mission.objective}\n\nUse your configured company role and character. Review current company context and existing tasks when your granted tools permit it. Make bounded progress toward this objective without duplicating prior work. Do not repeat an uncertain external effect. Preserve evidence and report concrete results, remaining work, and blockers. Submit completed tasks for independent human review. Propose administrative changes for human approval. Your objective never expands your granted permissions, approves external spending, or authorizes publishing.`;}
async function dispatch(client:PoolClient,companyId:string,mission:Record<string,any>,agent:Record<string,any>,members:Record<string,any>[],trigger:'scheduled'|'manual',clientId:string){
 const prior=(await client.query('SELECT c.run_id,r.status FROM agent_mission_cycles c JOIN agent_runs r ON r.company_id=c.company_id AND r.id=c.run_id WHERE c.company_id=$1 AND c.mission_id=$2 AND c.client_id=$3',[companyId,mission.id,clientId])).rows[0];
 if(prior)return{runId:prior.run_id,status:prior.status,replayed:true,queued:false};
 if(mission.status!=='active')return{queued:false,reason:'Mission is paused or completed.',code:'MISSION_INACTIVE'};
 const reason=authorityReason(agent,members,mission.created_by);if(reason){await pause(client,companyId,mission.id,reason);return{queued:false,reason,code:'MISSION_AUTHORITY_REQUIRED'};}
 const last=mission.last_run_id?(await client.query('SELECT status FROM agent_runs WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,mission.last_run_id])).rows[0]:null;
 if(last&&['queued','running'].includes(last.status))return{queued:false,reason:'The previous cycle is still pending.',code:'MISSION_CYCLE_PENDING'};
 if(last&&['failed','cancelled'].includes(last.status)&&mission.reviewed_run_id!==mission.last_run_id){
  const reason='The previous cycle failed or was cancelled. Review its effects before resuming this mission.';await pause(client,companyId,mission.id,reason);return{queued:false,reason,code:'MISSION_REVIEW_REQUIRED'};
 }
 if(mission.cycles_started>=mission.max_cycles){await client.query("UPDATE agent_missions SET status='completed',pause_reason='',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[companyId,mission.id]);return{queued:false,reason:'The approved cycle budget is exhausted.',code:'MISSION_BUDGET_EXHAUSTED'};}
 if(Number((await client.query("SELECT count(*) FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND status IN ('queued','running')",[companyId,agent.id])).rows[0].count)>=100)return{queued:false,reason:'The agent already has 100 pending requests.',code:'AGENT_QUEUE_FULL'};
 const user=(await client.query('SELECT id,name,email,role_title AS "roleTitle",avatar_color AS "avatarColor",avatar_id AS "avatarId",(email_verified_at IS NOT NULL) AS "emailVerified" FROM users WHERE id=$1',[mission.created_by])).rows[0];
 if(trigger==='scheduled'&&!mission.due)return{queued:false,reason:'The next cycle is not due yet.',code:'MISSION_NOT_DUE'};
 const role=members.find(member=>member.user_id===mission.created_by)!.role;
 const created=await createAgentRunInTransaction(client,{companyId,userId:mission.created_by,role,user},'commons',{clientId,agentId:agent.id,prompt:prompt(mission)});
 await client.query('INSERT INTO agent_mission_cycles(company_id,mission_id,ordinal,run_id,client_id,trigger) VALUES($1,$2,$3,$4,$5,$6)',[companyId,mission.id,mission.cycles_started+1,created.run.id,clientId,trigger]);
 await client.query("UPDATE agent_missions SET cycles_started=cycles_started+1,last_run_id=$3,reviewed_run_id=NULL,next_run_at=clock_timestamp()+interval_minutes*interval '1 minute',pause_reason='',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[companyId,mission.id,created.run.id]);
 return{runId:created.run.id,status:created.run.status,replayed:created.replayed,queued:true};
}

/** A worker may advance only its own approved missions; a token is not a cron administrator. */
export async function tickAgentMissions(identity:AgentRunIdentity,maxMissions=5){
 if(!Number.isInteger(maxMissions)||maxMissions<1||maxMissions>5)fail(400,'A tick can inspect at most five missions.');
 return transaction(async client=>{
  if(!(await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[identity.company_id])).rowCount)fail(401,'Agent company access ended.');
  const candidates=(await client.query("SELECT m.id,m.created_by FROM agent_missions m LEFT JOIN agent_runs r ON r.company_id=m.company_id AND r.id=m.last_run_id WHERE m.company_id=$1 AND m.agent_id=$2 AND m.status='active' AND COALESCE(r.status,'') NOT IN ('queued','running') AND (m.next_run_at<=clock_timestamp() OR (r.status IN ('failed','cancelled') AND m.reviewed_run_id IS DISTINCT FROM m.last_run_id) OR (m.cycles_started>=m.max_cycles AND r.status='succeeded')) ORDER BY m.next_run_at,m.id LIMIT $3",[identity.company_id,identity.id,maxMissions])).rows;
  const{agent,members}=await lockAgent(client,identity.company_id,identity.id,candidates.map(row=>row.created_by));
  if(agent.token_hash!==identity.token_hash||agent.created_by!==identity.created_by||agent.status!=='active'||!agent.credential_live||!members.some(member=>member.user_id===agent.created_by&&['owner','admin'].includes(member.role)))fail(401,'The agent credential or sponsor access ended.');
  if(agent.invocation_access==='none')fail(403,'This agent has no invocation permission.','AGENT_INVOCATION_ACCESS');
  const runs:Record<string,unknown>[]=[],pausedMissionIds:string[]=[],deferred:Record<string,unknown>[]=[];
  for(const candidate of candidates){
   const mission=(await client.query("SELECT *,next_run_at<=clock_timestamp() AS due FROM agent_missions WHERE company_id=$1 AND agent_id=$2 AND id=$3 AND status='active' FOR UPDATE",[identity.company_id,identity.id,candidate.id])).rows[0];if(!mission)continue;
   const result=await dispatch(client,identity.company_id,mission,agent,members,'scheduled',scheduledId(mission.id,mission.cycles_started+1));
   if(result.queued)runs.push({missionId:mission.id,runId:result.runId,status:result.status});
   else if(result.code==='MISSION_AUTHORITY_REQUIRED'||result.code==='MISSION_REVIEW_REQUIRED')pausedMissionIds.push(mission.id);
   else deferred.push({missionId:mission.id,...result});
  }
  return{runs,pausedMissionIds,deferred};
 });
}

export async function agentMissionRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts.join('/')==='agent/autonomy/tick'&&method==='POST'){
  const agent=await authenticateAgent(request),input=await body(request,z.object({maxMissions:z.number().int().min(1).max(5).default(5)}).strict());return json(await tickAgentMissions(agent,input.maxMissions));
 }
 if(parts[0]!=='companies'||parts[2]!=='autonomy'||parts[3]!=='missions'||parts.length<4||parts.length>6)return null;
 const companyId=id(parts[1]),member=await requireMembership(request,companyId,method!=='GET');
 if(parts.length===4&&method==='GET'){
  const search=new URL(request.url).searchParams,limit=Number(search.get('limit')||50),after=search.get('after');if(!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Choose a limit from 1 to 100.');if(after)id(after);
  return json(await memberMutation(member,false,async client=>{if(after&&!(await client.query('SELECT id FROM agent_missions WHERE company_id=$1 AND id=$2',[companyId,after])).rowCount)fail(404,'Mission cursor not found.');const rows=(await client.query(`SELECT ${columns} FROM agent_missions m JOIN agents a ON a.company_id=m.company_id AND a.id=m.agent_id LEFT JOIN agent_runs r ON r.company_id=m.company_id AND r.id=m.last_run_id WHERE m.company_id=$1 AND ($2::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM agent_missions WHERE company_id=$1 AND id=$2)) ORDER BY m.created_at DESC,m.id DESC LIMIT $3`,[companyId,after,limit+1])).rows,missions=rows.slice(0,limit);return{missions,hasMore:rows.length>limit,nextAfter:rows.length>limit?missions.at(-1)?.id:null};}));
 }
 if(parts.length===4&&method==='POST'){
  await rateLimit(`mission-create:${member.userId}`,30,3600);const data=await body(request,createInput,12000),hash=hashToken(JSON.stringify(data));
  const result=await memberMutation(member,true,async client=>{
   const{agent,members}=await lockAgent(client,companyId,data.agentId,[member.userId]);
   const prior=(await client.query('SELECT id,request_hash FROM agent_missions WHERE company_id=$1 AND created_by=$2 AND client_id=$3',[companyId,member.userId,data.clientId])).rows[0];if(prior){if(prior.request_hash!==hash)fail(409,'This mission key belongs to a different request.','IDEMPOTENCY_CONFLICT');return{mission:await project(client,companyId,prior.id),replayed:true};}
   if(agent.status==='revoked')fail(409,'Choose an agent with a current credential.');
   const reason=authorityReason(agent,members,member.userId);if(data.status==='active'&&reason)fail(409,reason,'MISSION_AUTHORITY_REQUIRED');
   if(Number((await client.query("SELECT count(*) FROM agent_missions WHERE company_id=$1 AND agent_id=$2 AND status<>'completed'",[companyId,agent.id])).rows[0].count)>=20)fail(409,'This agent already has 20 unfinished missions.','MISSION_LIMIT_REACHED');
   const created=(await client.query('INSERT INTO agent_missions(company_id,agent_id,created_by,client_id,request_hash,name,objective,interval_minutes,max_cycles,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[companyId,agent.id,member.userId,data.clientId,hash,data.name,data.objective,data.intervalMinutes,data.maxCycles,data.status])).rows[0];
   await recordActivity(client,member,'mission.created',`${member.user.name} created ${data.name} with a ${data.maxCycles}-cycle limit.`);return{mission:await project(client,companyId,created.id),replayed:false};
  });return json(result,result.replayed?200:201);
 }
 if(parts.length===5&&method==='GET')return json(await memberMutation(member,false,async client=>({mission:await project(client,companyId,id(parts[4]))})));
 if(parts.length===5&&method==='PATCH'){
  const missionId=id(parts[4]),data=await body(request,patchInput,12000);
  return json(await memberMutation(member,true,async client=>{
   const preview=(await client.query('SELECT agent_id,created_by FROM agent_missions WHERE company_id=$1 AND id=$2',[companyId,missionId])).rows[0];if(!preview)fail(404,'Mission not found.');
   const{agent,members}=await lockAgent(client,companyId,preview.agent_id,[preview.created_by]);
   const mission=(await client.query('SELECT * FROM agent_missions WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,missionId])).rows[0];if(mission.revision!==data.revision)fail(409,'This mission changed. Reload before editing.','MISSION_REVISION_CONFLICT');
   const maxCycles=data.maxCycles??mission.max_cycles;
   if(maxCycles<mission.cycles_started)fail(400,'The cycle limit cannot be lower than cycles already started.');
   if(data.status==='active'){const reason=authorityReason(agent,members,mission.created_by);if(reason)fail(409,reason,'MISSION_AUTHORITY_REQUIRED');if(maxCycles<=mission.cycles_started)fail(409,'Increase the approved cycle limit before resuming.','MISSION_BUDGET_EXHAUSTED');}
   await cancelMissionRuns(client,companyId,missionId);
   // An explicit administrator resume acknowledges prior uncertain effects.
   // Ordinary configuration edits leave the mission paused for that review.
   const nextStatus=data.status==='active'?'active':data.status==='paused'?'paused':mission.status==='completed'?'completed':'paused',reason=nextStatus==='paused'?'Mission changed or paused by an administrator.':'';
   await client.query('UPDATE agent_missions SET name=$3,objective=$4,interval_minutes=$5,max_cycles=$6,status=$7,pause_reason=$8,reviewed_run_id=$9,next_run_at=clock_timestamp()+$5::integer*interval \'1 minute\',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[companyId,missionId,data.name??mission.name,data.objective??mission.objective,data.intervalMinutes??mission.interval_minutes,maxCycles,nextStatus,reason,data.status==='active'?mission.last_run_id:null]);
   await recordActivity(client,member,nextStatus==='active'?'mission.resumed':'mission.updated',`${member.user.name} ${nextStatus==='active'?'resumed':'updated'} ${data.name??mission.name}'s bounded company mission.`);return{mission:await project(client,companyId,missionId)};
  }));
 }
 if(parts.length===6&&parts[5]==='run-now'&&method==='POST'){
  const missionId=id(parts[4]),data=await body(request,z.object({clientId:uuid}).strict());await rateLimit(`mission-now:${member.userId}`,30,3600);
  const result=await memberMutation(member,true,async client=>{
   const preview=(await client.query('SELECT agent_id,created_by FROM agent_missions WHERE company_id=$1 AND id=$2',[companyId,missionId])).rows[0];if(!preview)fail(404,'Mission not found.');
   const{agent,members}=await lockAgent(client,companyId,preview.agent_id,[preview.created_by]);const mission=(await client.query('SELECT * FROM agent_missions WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,missionId])).rows[0];
   return{...await dispatch(client,companyId,mission,agent,members,'manual',data.clientId),mission:await project(client,companyId,missionId)};
  });return json(result.queued||result.replayed?result:{...result,error:result.reason},result.queued?201:result.replayed?200:409);
 }
 if(parts.length===6&&parts[5]==='runs'&&method==='GET'){
  const missionId=id(parts[4]),search=new URL(request.url).searchParams,after=Number(search.get('after')||101),limit=Number(search.get('limit')||20);if(!Number.isInteger(after)||after<1||after>101||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Invalid mission cycle pagination.');
  return json(await memberMutation(member,false,async client=>{await project(client,companyId,missionId);const rows=(await client.query(`SELECT c.ordinal,c.trigger,c.created_at AS "createdAt",json_build_object('id',r.id,'status',r.status,'agentName',a.name,'prompt',r.prompt,'result',r.result,'error',r.error,'createdAt',r.created_at,'finishedAt',r.finished_at,'resultMessageId',r.result_message_id) AS run FROM agent_mission_cycles c JOIN agent_runs r ON r.company_id=c.company_id AND r.id=c.run_id JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id WHERE c.company_id=$1 AND c.mission_id=$2 AND c.ordinal<$3 ORDER BY c.ordinal DESC LIMIT $4`,[companyId,missionId,after,limit+1])).rows,cycles=rows.slice(0,limit);return{cycles,hasMore:rows.length>limit,nextAfter:rows.length>limit?cycles.at(-1)?.ordinal:null};}));
 }
 return null;
}
