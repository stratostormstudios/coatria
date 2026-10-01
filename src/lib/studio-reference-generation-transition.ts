import type {PoolClient} from 'pg';
import {referenceGenerationHandoffHash} from './studio-reference-generation-authority';
type Row=Record<string,any>;
export const referenceGenerationStepHash=(receipt:Row,step:'claim'|'proposal')=>referenceGenerationHandoffHash({operation:'reference-generation-followup-step',runId:receipt.child_run_id,projectId:receipt.project_id,workItemId:receipt.work_item_id,step});

/** One exact task-reservation transition. No project revision, content, role,
 * approval or arbitrary task update is normalized by this historical proof. */
export async function referenceGenerationClaimTransition(db:PoolClient,r:Row,h:Row,work:Row):Promise<boolean>{
 if(work.status!=='doing'||work.task_revision!==h.task_revision+1||work.assignee_id!==null)return false;
 const f=(await db.query(`SELECT f.*,c.agent_id,c.requested_by,c.max_attempts,c.attempts FROM studio_reference_generation_followups f
  JOIN agent_runs c ON c.company_id=f.company_id AND c.id=f.child_run_id
  WHERE f.company_id=$1 AND f.project_id=$2 AND f.handoff_id=$3 AND f.reference_id=$4`,[r.company_id,r.project_id,h.id,r.id])).rows[0];
 if(!f||f.task_id!==h.task_id||f.work_item_id!==h.work_item_id||f.source_child_run_id!==h.source_child_run_id||f.child_run_id!==work.agent_run_id||f.specialist_agent_id!==h.specialist_agent_id
  ||f.agent_id!==h.specialist_agent_id||f.requested_by!==h.requested_by||f.approved_by!==h.requested_by||f.policy_revision!==h.policy_revision||f.initial_task_revision!==h.task_revision||f.max_attempts!==1||f.attempts!==1)return false;
 const steps=(await db.query('SELECT step,request_id FROM studio_reference_generation_followup_steps WHERE company_id=$1 AND child_run_id=$2',[r.company_id,f.child_run_id])).rows;
 if(steps.length!==2||!steps.some(s=>s.step==='claim'&&s.request_id===f.claim_request_id)||!steps.some(s=>s.step==='proposal'&&s.request_id===f.proposal_request_id))return false;
 const proof=(await db.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[r.company_id,'agent:'+f.specialist_agent_id,f.claim_request_id])).rows[0];
 const task=proof?.response?.task;
 return Boolean(proof&&proof.request_hash===referenceGenerationStepHash(f,'claim')&&task?.id===h.task_id&&task.agentRunId===f.child_run_id&&task.revision===h.task_revision+1
  &&task.status==='doing'&&task.assigneeId===null&&task.title===work.title&&task.description===work.description);
}
