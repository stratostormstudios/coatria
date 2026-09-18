import type {PoolClient} from 'pg';
import {fail} from './security';
import {assertStudioTaskAction,type StudioActor} from './studio';
import {managedAgentAuthoritySql} from './studio-hosting';

type Row=Record<string,any>;
export type HiggsfieldWorkSnapshot={workItemId:string;taskRevision:number;roleAgentId:string|null;roleHumanId:string|null};

/** Company/member and, for an agent, actual lease authority are established by
 * the caller. No caller-supplied status, role, task revision or identity is used. */
export async function higgsfieldProposalWork(client:PoolClient,actor:StudioActor,project:Row,workItemId?:string):Promise<HiggsfieldWorkSnapshot|null>{
 if(!workItemId){
  if(project.production_path==='higgsfield'||actor.agentId)fail(400,'Choose the exact generation task for this request.','HIGGSFIELD_WORK_REQUIRED');
  return null;
 }
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[actor.companyId]);
 const work=(await client.query(`SELECT w.id,w.task_id,w.execution,w.stage,t.status,t.revision,t.agent_run_id,b.agent_id,b.human_id FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3 FOR SHARE OF t`,[actor.companyId,project.id,workItemId])).rows[0];
 if(!work)fail(404,'Generation task not found in this project.');
 if(work.execution!=='creative'||work.stage!=='generation')fail(409,'Select a Higgsfield generation task, not planning, review or legacy DCC work.','HIGGSFIELD_WORK_REQUIRED');
 if(!['todo','doing'].includes(work.status))fail(409,'This generation task is already submitted or accepted.','HIGGSFIELD_WORK_CLOSED');
 let agent:Row|undefined,run:Row|undefined;
 if(actor.agentId){
  if(!actor.runId)fail(403,'A generation proposal requires the authenticated agent run.');
  const row=(await client.query(`SELECT a.*,r.id AS run_id,r.capabilities AS run_capabilities FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id JOIN memberships sponsor ON sponsor.company_id=a.company_id AND sponsor.user_id=a.created_by JOIN memberships requester ON requester.company_id=r.company_id AND requester.user_id=r.requested_by WHERE a.company_id=$1 AND a.id=$2 AND r.id=$3 AND r.requested_by=$4 AND a.status='active' AND a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} AND sponsor.role IN ('owner','admin') AND requester.role IN ('owner','admin') AND a.invocation_access<>'none' AND r.status='running' AND r.lease_token_hash IS NOT NULL AND r.lease_expires_at>clock_timestamp()`,[actor.companyId,actor.agentId,actor.runId,actor.userId])).rows[0];
  if(!row||['studio.read','studio.write','tasks.write','creative.read','creative.write'].some(cap=>!row.capabilities.includes(cap)||!row.run_capabilities.includes(cap)))fail(403,'The current run needs the reviewed studio and creative grants.','AGENT_CAPABILITY_REQUIRED');
  if(work.agent_id!==actor.agentId||work.status!=='doing'||work.agent_run_id!==actor.runId)fail(403,'Reserve this assigned generation task for the current run first.','STUDIO_TASK_RESERVATION_REQUIRED');
  agent=row;run={id:actor.runId,capabilities:row.run_capabilities};
 }
 await assertStudioTaskAction(client,actor.companyId,work.task_id,'higgsfield_propose',{},run,agent);
 return {workItemId:work.id,taskRevision:work.revision,roleAgentId:work.agent_id??null,roleHumanId:work.human_id??null};
}

/** A human administrator adopts the exact proposal. Its task and assignment
 * must still match; the originating inference run need not remain running. */
export async function assertHiggsfieldWorkForDispatch(client:PoolClient,companyId:string,project:Row,request:Row){
 if(!request.work_item_id){
  if(project.production_path==='higgsfield')fail(409,'This production requires a new task-bound generation request.','HIGGSFIELD_WORK_REQUIRED');
  return;
 }
 const current=await higgsfieldProposalWork(client,{companyId,userId:request.requested_by},project,request.work_item_id);
 if(!current||current.taskRevision!==request.task_revision||current.roleAgentId!==request.role_agent_id||current.roleHumanId!==request.role_human_id)fail(409,'The generation task or its assignment changed. Review a new request.','HIGGSFIELD_WORK_CHANGED');
}
