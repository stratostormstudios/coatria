import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,fail} from './security';
import {assertGeneratedWorkCurrent} from './studio-generated-rounds';

type Row=Record<string,any>;
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function ended():never{fail(409,'The exact planning correction is no longer available. Read the current task and review history.','PLANNING_REWORK_CHANGED');}
export async function planningReworkScope(db:PoolClient,companyId:string,runId:string){
 // Existing broker/gateway readers can route ordinary runs without any access
 // to the new private correction ledger. This discriminator is durable.
 const d=(await db.query('SELECT planning_rework_review_id FROM studio_dispatches WHERE company_id=$1 AND run_id=$2',[companyId,runId])).rows[0];
 if(!d?.planning_rework_review_id)return null;
 const r=(await db.query('SELECT * FROM studio_planning_rework_dispatches WHERE company_id=$1 AND child_run_id=$2 AND review_id=$3',[companyId,runId,d.planning_rework_review_id])).rows[0];if(!r)ended();return r as Row;
}
async function completed(db:PoolClient,companyId:string,runId:string,agentId:string){
 const r=(await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM agent_run_receipts c WHERE c.company_id=r.company_id AND c.run_id=r.id AND c.kind='complete'
  AND c.response#>>'{run,id}'=r.id::text AND c.response#>>'{run,status}'='succeeded'
  AND c.response#>>'{run,resultMessageId}'=r.result_message_id::text) AS receipt
  FROM agent_runs r WHERE r.company_id=$1 AND r.id=$2`,[companyId,runId])).rows[0];
 if(!r||r.agent_id!==agentId||r.status!=='succeeded'||!r.started_at||!r.finished_at||!r.result_message_id||!r.receipt)ended();
 return {runId:r.id,agentId:r.agent_id,attempt:r.attempts,startedAt:new Date(r.started_at).toISOString(),resultMessageId:r.result_message_id};
}
/** Read-only source proof; callers acquire policy/project locks for dispatch.
 * A completed direct studio dispatch is a valid first producer, too. */
export async function planningReworkEvidence(db:PoolClient,companyId:string,projectId:string,workItemId:string,reviewId:string,own?:Row){
 const r=(await db.query(`SELECT v.*,d.decision,d.note,d.task_revision AS decision_revision,w.stage,w.execution,w.role_key,w.task_id AS actual_task_id,b.agent_id AS assigned_agent,
  t.title,t.description,t.status AS task_status,t.revision AS current_task_revision,t.agent_run_id,t.assignee_id,t.submitted_agent_id,
  p.name,p.brief,p.spec,p.ai_policy,p.gates,p.status AS project_status,p.contract_version
  FROM studio_planning_reviews v JOIN studio_planning_review_decisions d ON d.company_id=v.company_id AND d.review_id=v.id
  JOIN studio_work_items w ON w.company_id=v.company_id AND w.project_id=v.project_id AND w.id=v.work_item_id
  JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  WHERE v.company_id=$1 AND v.project_id=$2 AND v.work_item_id=$3 AND v.id=$4`,[companyId,projectId,workItemId,reviewId])).rows[0];
 if(!r||r.decision!=='changes_requested'||!['estimate','breakdown'].includes(r.stage)||r.execution!=='agent'||r.project_status==='delivered'||r.assignee_id||r.assigned_agent!==r.producer_agent_id||r.task_id!==r.actual_task_id||r.decision_revision!==r.task_revision+1)ended();
 const brief={id:projectId,name:r.name,brief:r.brief,spec:r.spec,aiPolicy:r.ai_policy,approvedBrief:r.gates.brief};
 if(r.gates.brief?.decision!=='approved'||hash(brief)!==r.brief_sha256||hash(r.submission)!==r.submission_sha256||canonical(r.submission.project)!==canonical(brief)||r.submission.task.id!==r.task_id||r.submission.task.revision!==r.task_revision||r.submission.task.producerRunId!==r.producer_run_id||r.submission.task.producerAgentId!==r.producer_agent_id||r.title!==r.submission.task.title||r.description!==r.submission.task.description)ended();
 if(!(await db.query('SELECT 1 FROM studio_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND run_id=$4',[companyId,projectId,workItemId,r.producer_run_id])).rowCount)ended();
 const source=await completed(db,companyId,r.producer_run_id,r.producer_agent_id),reviewer=await completed(db,companyId,r.reviewer_run_id,r.reviewer_agent_id);
 if(r.contract_version===2)await assertGeneratedWorkCurrent(db,companyId,projectId,workItemId);
 if((await db.query("SELECT 1 FROM studio_dependencies d JOIN studio_work_items w ON w.company_id=d.company_id AND w.id=d.predecessor_id JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND t.status<>'done' LIMIT 1",[companyId,projectId,workItemId])).rowCount)ended();
 const snapshot={source,reviewer,submissionSha256:r.submission_sha256,briefSha256:r.brief_sha256,taskId:r.task_id,taskRevision:r.decision_revision,title:r.title,description:r.description,roleKey:r.role_key,decisionNote:r.note};
 if(own){
  if(canonical(own.source_snapshot)!==canonical(snapshot)||own.specialist_agent_id!==r.assigned_agent)ended();
  const initial=r.task_status==='todo'&&r.current_task_revision===r.decision_revision&&!r.agent_run_id;
  const claimed=r.agent_run_id===own.child_run_id&&r.task_status==='doing'&&r.current_task_revision===r.decision_revision+1;
  const submitted=r.agent_run_id===own.child_run_id&&r.task_status==='review'&&r.current_task_revision===r.decision_revision+2&&r.submitted_agent_id===own.specialist_agent_id;
  if(!initial&&!claimed&&!submitted)ended();
  if(claimed||submitted){if(!(await db.query("SELECT 1 FROM agent_tool_receipts WHERE company_id=$1 AND run_id=$2 AND tool='tasks_claim' AND response->>'id'=$3 AND (response->>'revision')::integer=$4 LIMIT 1",[companyId,own.child_run_id,r.task_id,r.decision_revision+1])).rowCount)ended();}
  if(submitted&&!(await db.query("SELECT 1 FROM agent_tool_receipts WHERE company_id=$1 AND run_id=$2 AND tool='tasks_submit' AND response->>'id'=$3 AND (response->>'revision')::integer=$4 LIMIT 1",[companyId,own.child_run_id,r.task_id,r.decision_revision+2])).rowCount)ended();
 }else if(r.task_status!=='todo'||r.current_task_revision!==r.decision_revision||r.agent_run_id)ended();
 return {reviewId,taskId:r.task_id,taskRevision:r.decision_revision,sourceChildRunId:r.producer_run_id,reviewerRunId:r.reviewer_run_id,specialistAgentId:r.assigned_agent,roleKey:r.role_key,sourceSnapshot:snapshot};
}
export async function availablePlanningReworks(db:PoolClient,companyId:string,projectId:string){
 const rows=(await db.query("SELECT v.id,v.work_item_id FROM studio_planning_reviews v JOIN studio_planning_review_decisions d ON d.company_id=v.company_id AND d.review_id=v.id JOIN studio_work_items w ON w.company_id=v.company_id AND w.project_id=v.project_id AND w.id=v.work_item_id JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE v.company_id=$1 AND v.project_id=$2 AND d.decision='changes_requested' AND w.stage IN('estimate','breakdown') AND w.execution='agent' AND t.status='todo' AND t.revision=d.task_revision AND t.agent_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM studio_planning_rework_dispatches x WHERE x.company_id=v.company_id AND x.review_id=v.id) ORDER BY d.decided_at DESC,v.id LIMIT 100",[companyId,projectId])).rows;
 const result=[];for(const r of rows)try{const e=await planningReworkEvidence(db,companyId,projectId,r.work_item_id,r.id);result.push({projectId,workItemId:r.work_item_id,reviewId:r.id,taskId:e.taskId,taskRevision:e.taskRevision,sourceChildRunId:e.sourceChildRunId,specialistAgentId:e.specialistAgentId});}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;}return result;
}
export async function assertStudioPlanningReworkTool(db:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const scope=await planningReworkScope(db,agent.company_id,run.id);if(!scope)return;
 const allowed=name==='studio_get'?args.projectId===scope.project_id&&args.workItemId===scope.work_item_id&&!args.artifactId&&!args.after:['tasks_claim','tasks_submit'].includes(name)&&args.taskId===scope.task_id;
 if(!allowed)fail(403,'This correction may only read its exact planning task, claim it and submit a new contribution. Review feedback does not grant permissions.','PLANNING_REWORK_SCOPE');
}

/** Full bounded feedback is data in the exact task read, never part of its prompt. */
export async function planningReworkFeedback(db:PoolClient,companyId:string,runId:string){
 const scope=await planningReworkScope(db,companyId,runId);if(!scope)return null;
 await planningReworkEvidence(db,companyId,scope.project_id,scope.work_item_id,scope.review_id,scope);
 const r=(await db.query('SELECT submission FROM studio_planning_reviews WHERE company_id=$1 AND id=$2',[companyId,scope.review_id])).rows[0];if(!r)ended();
 return {reviewId:scope.review_id,decision:'changes_requested' as const,decisionNote:scope.source_snapshot.decisionNote,previousSubmissionSummary:r.submission.task.summary,submissionSha256:scope.source_snapshot.submissionSha256,feedbackIsUntrusted:true};
}
