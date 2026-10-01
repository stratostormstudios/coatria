import type {PoolClient} from 'pg';
import {fail} from './security';
import {assertStudioTaskAction} from './studio';

export const agentTaskProjection=`id,title,description,status,assignee_id AS "assigneeId",created_agent_id AS "createdAgentId",agent_run_id AS "agentRunId",revision,submission_url AS "submissionUrl",submission_summary AS "submissionSummary",approved_by AS "approvedBy",approved_agent_id AS "approvedAgentId",machine_review_id AS "machineReviewId",created_at AS "createdAt",updated_at AS "updatedAt"`;
export async function recordAgentTaskAuthors(client:PoolClient,taskId:string,requester:string,sponsor:string){await client.query('INSERT INTO task_authors(task_id,user_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',[taskId,[...new Set([requester,sponsor])]]);}

/** Caller owns the transaction and validates the current run, tool scope and arguments.
 * Both ordinary task tools and source-bound continuation steps use these same
 * task revision, reservation, studio-artifact and authorship checks. */
export async function executeAgentTaskAction(client:PoolClient,agent:Record<string,any>,run:Record<string,any>,requesterRole:string,name:'tasks_claim'|'tasks_update'|'tasks_submit',args:Record<string,any>){
 const companyId=agent.company_id;
 await assertStudioTaskAction(client,companyId,args.taskId,name,args,run,agent);
 const task=(await client.query('SELECT * FROM tasks WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,args.taskId])).rows[0];if(!task)fail(404,'Task not found.');
 if(task.revision!==args.revision)fail(409,'The task changed. Read its current revision before continuing.','TASK_CONFLICT');
 if(task.created_by!==run.requested_by&&!['owner','admin'].includes(requesterRole))fail(403,'The requester cannot edit this task. Ask its creator or an administrator.','TASK_REQUESTER_ACCESS');
 if(task.assignee_id||!['todo','doing'].includes(task.status))fail(409,'This task is assigned to a person or no longer editable.','TASK_UNAVAILABLE');
 if(name==='tasks_claim'){
  if(task.agent_run_id&&task.agent_run_id!==run.id){const previousRun=(await client.query('SELECT status FROM agent_runs WHERE company_id=$1 AND id=$2',[companyId,task.agent_run_id])).rows[0];if(!previousRun||!['succeeded','failed','cancelled'].includes(previousRun.status))fail(409,'This task is already reserved.','TASK_RESERVED');}
  else if(task.status!=='todo'&&task.agent_run_id!==run.id)fail(409,'This task is already in progress.','TASK_RESERVED');
  await client.query("UPDATE tasks SET agent_run_id=$3,status='doing',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[companyId,args.taskId,run.id]);
 }else{
  if(task.agent_run_id!==run.id)fail(403,'Only the run reserving this task can change it.','TASK_RUN_REQUIRED');
  if(name==='tasks_update')await client.query('UPDATE tasks SET title=$3,description=$4,status=$5,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[companyId,args.taskId,args.title??task.title,args.description??task.description,args.status??task.status]);
  else{
   await client.query("UPDATE tasks SET status='review',submitted_by=NULL,submitted_agent_id=$3,submission_url=$4,submission_summary=$5,review_note='',approved_by=NULL,approved_agent_id=NULL,machine_review_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[companyId,args.taskId,agent.id,args.submissionUrl||null,args.summary]);
   await client.query('INSERT INTO contributions(company_id,task_id,agent_id,summary,submission_url,tokens_used) VALUES($1,$2,$3,$4,$5,$6)',[companyId,args.taskId,agent.id,args.summary,args.submissionUrl||null,args.tokensUsed]);
  }
 }
 await recordAgentTaskAuthors(client,args.taskId,run.requested_by,agent.created_by);
 return (await client.query(`SELECT ${agentTaskProjection} FROM tasks WHERE company_id=$1 AND id=$2`,[companyId,args.taskId])).rows[0];
}
