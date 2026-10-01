/** A finite planning handoff is evidence about an unchanged objective, never
 * authentication for an ended agent or permission to approve/share media. */
import type {PoolClient} from 'pg';
import {fail} from './security';

type Row=Record<string,any>;
const ended=():never=>fail(409,'The exact submitted preparation plan changed. Review a new proposal.','IMAGE_PREPARATION_HANDOFF_CHANGED');

/** Caller already locks the original principals, project/work/task and run.
 * Return the original phase fields only after proving their allowed transition;
 * the caller still compares the complete remaining immutable work snapshot. */
export async function preparationHandoffWork(db:PoolClient,r:Row,current:Row,members:Row[],projectRevision:number):Promise<{work:Row;projectRevision:number}>{
 const old=r.work_snapshot;
 if(r.continuation_mode!=='submitted_plan_v1'||!r.proposed_agent_id||!r.proposed_run_id||old.stage!=='references'||old.execution!=='agent'||old.status!=='doing'
  ||current.stage!=='references'||current.execution!=='agent'||current.assignee_id!==null||current.role_agent_id!==r.proposed_agent_id)ended();
 if(current.status==='doing')return {work:current,projectRevision};
 if(!['review','done'].includes(current.status)||current.task_revision!==old.task_revision+(current.status==='review'?1:2))ended();
 const task=(await db.query(`SELECT submitted_by,submitted_agent_id,submission_summary,submission_url,approved_by,approved_agent_id,machine_review_id
  FROM tasks WHERE company_id=$1 AND id=$2 FOR SHARE`,[r.company_id,old.task_id])).rows[0];
 if(!task||task.submitted_by||task.submitted_agent_id!==r.proposed_agent_id)ended();
 const submitted=(await db.query(`SELECT response FROM agent_tool_receipts WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND tool='tasks_submit'
  AND response->>'id'=$4::text AND response->>'status'='review' AND response->>'agentRunId'=$3::text AND response->>'revision'=$5::text LIMIT 1`,
 [r.company_id,r.proposed_agent_id,r.proposed_run_id,old.task_id,old.task_revision+1])).rows[0]?.response;
 if(!submitted||submitted.title!==old.title||submitted.description!==old.description||submitted.title!==current.title||submitted.description!==current.description
  ||submitted.submissionSummary!==task.submission_summary||(submitted.submissionUrl??null)!==(task.submission_url??null))ended();
 if(current.status==='review'){
  if(current.agent_run_id!==r.proposed_run_id||task.approved_by||task.approved_agent_id||task.machine_review_id)ended();
 }else{
  if(current.agent_run_id!==null)ended();
  if(task.approved_by){
   const reviewer=members.find(m=>m.user_id===task.approved_by);
   if(!reviewer||!['owner','admin'].includes(reviewer.role)||reviewer.access_revoked_at!==null||task.approved_agent_id||task.machine_review_id
    ||[r.proposed_by,r.proposer_snapshot.agent.sponsorId].includes(task.approved_by))ended();
   if((await db.query(`SELECT 1 FROM task_authors WHERE task_id=$1 AND user_id=$2
    UNION ALL SELECT 1 FROM contributions c JOIN agents a ON a.company_id=c.company_id AND a.id=c.agent_id
    WHERE c.company_id=$3 AND c.task_id=$1 AND a.created_by=$2 LIMIT 1`,[old.task_id,task.approved_by,r.company_id])).rowCount)ended();
  }else{
   if(!task.approved_agent_id||task.approved_agent_id===r.proposed_agent_id||!task.machine_review_id)ended();
   const decision=(await db.query(`SELECT d.project_revision_before,d.project_revision_after
   FROM studio_planning_reviews v JOIN studio_planning_review_decisions d ON d.company_id=v.company_id AND d.review_id=v.id
   WHERE v.company_id=$1 AND v.id=$2 AND v.project_id=$3 AND v.work_item_id=$4 AND v.task_id=$5 AND v.producer_agent_id=$6
    AND v.producer_run_id=$7 AND v.task_revision=$8 AND v.reviewer_agent_id=$9 AND d.decision='approve' AND d.task_revision=$10`,
   [r.company_id,task.machine_review_id,r.project_id,r.work_item_id,old.task_id,r.proposed_agent_id,r.proposed_run_id,old.task_revision+1,task.approved_agent_id,current.task_revision])).rows[0];
   if(!decision||decision.project_revision_before!==r.project_revision||decision.project_revision_after!==r.project_revision+1||decision.project_revision_after!==projectRevision)ended();
   projectRevision=r.project_revision;
  }
 }
 return {work:{...current,status:old.status,task_revision:old.task_revision,agent_run_id:old.agent_run_id},projectRevision};
}
