/** Internal inspection authority derived only from an explicit human dispatch.
 * This never authenticates an agent or issues a general file access capability. */
import type {PoolClient} from 'pg';
import {fail,hashToken} from './security';
import {managedAgentAuthoritySql,managedAgentAuthorityPrincipals} from './studio-hosting';
import {referenceCoordinationAuthority} from './studio-coordination';
import {HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES,HIGGSFIELD_REFERENCE_INSPECTION_LIMITS,type HiggsfieldReferenceActor,type HiggsfieldReferenceInspectionAuthority} from './higgsfield-references-protocol';
type Row=Record<string,any>;
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
export const referenceInspectionAuthorityHash=(v:unknown)=>hashToken(canonical(v));
const ended=():never=>fail(409,'The exact human-dispatched reference inspection authority ended. Prepare a new authorized request.','HIGGSFIELD_REFERENCE_INSPECTION_AUTHORITY_ENDED');
const iso=(v:Date|string)=>new Date(v).toISOString();

export async function referencePreparationDispatch(db:PoolClient,actor:HiggsfieldReferenceActor,projectId:string,workItemId:string){
 if(!actor.agentId||!actor.runId)return false;
 const marker=(await db.query('SELECT coordination FROM studio_reference_preparation_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND run_id=$4 AND authority_version=1',[actor.companyId,projectId,workItemId,actor.runId])).rows[0];
 if(marker?.coordination){await lockReferenceInspectionAuthority(db,{company_id:actor.companyId,project_id:projectId,proposed_agent_id:actor.agentId,proposed_run_id:actor.runId,proposed_by:actor.userId,inspection_authority:{coordination:marker.coordination}});await referenceCoordinationAuthority(db,actor.companyId,projectId,workItemId,actor.runId,marker.coordination);}
 return Boolean(marker);
}
/** Match agent-tool lock order before taking project/reference locks. Revocation
 * must still be able to lock an invalid proposal, so this acquires locks only. */
export async function lockReferenceInspectionAuthority(db:PoolClient,r:Row){
 if(!r.inspection_authority)return;
 const coordination=r.inspection_authority.coordination,agentIds=[...new Set([r.proposed_agent_id,...coordination?[coordination.coordinatorAgentId]:[]])].sort();
 const agents=(await db.query('SELECT id,created_by FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[r.company_id,agentIds])).rows;
 const sponsorIds=[r.proposed_by,...coordination?[coordination.approvedBy]:[]];for(const agent of agents)sponsorIds.push(agent.created_by,...await managedAgentAuthorityPrincipals(db,r.company_id,agent.id));
 const principals=[...new Set(sponsorIds)].sort();
 await db.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[r.company_id,principals]);
 await db.query('SELECT id FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[r.company_id,agentIds]);
 await db.query('SELECT id FROM plugin_installations WHERE company_id=$1 AND agent_id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[r.company_id,agentIds]);
 await db.query('SELECT id FROM agent_runs WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[r.company_id,[r.proposed_run_id,...coordination?[coordination.parentRunId]:[]].sort()]);
 if(coordination)await db.query('SELECT project_id FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2 FOR SHARE',[r.company_id,r.project_id]);
}
async function source(db:PoolClient,companyId:string,agentId:string,runId:string,requestedBy:string,projectId:string,workItemId:string){
 if(!await referencePreparationDispatch(db,{companyId,agentId,runId,userId:requestedBy},projectId,workItemId))ended();
 const marker=(await db.query('SELECT coordination FROM studio_reference_preparation_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND run_id=$4',[companyId,projectId,workItemId,runId])).rows[0];
 // Only the explicit immutable policy marker permits ordinary delegation.
 // Follow-ups, missions and review runs never inherit inspection authority.
 if((await db.query(`SELECT 1 FROM (
  SELECT child_run_id AS run_id FROM studio_coordination_dispatches WHERE company_id=$1 AND $3::boolean=false
  UNION ALL SELECT child_run_id FROM studio_coordination_followups WHERE company_id=$1
  UNION ALL SELECT child_run_id FROM studio_generated_followups WHERE company_id=$1
  UNION ALL SELECT reviewer_run_id FROM studio_planning_reviews WHERE company_id=$1
  UNION ALL SELECT run_id FROM agent_mission_cycles WHERE company_id=$1
 ) nested WHERE run_id=$2 LIMIT 1`,[companyId,runId,Boolean(marker.coordination)])).rowCount)ended();
 const coordination=marker.coordination?await referenceCoordinationAuthority(db,companyId,projectId,workItemId,runId,marker.coordination):undefined;
 const a=(await db.query(`SELECT a.created_by,a.token_hash,a.invocation_access,a.capabilities,a.expires_at,
 a.status='active' AND a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} AS live,
 r.capabilities AS run_capabilities,r.status,r.attempts,r.max_attempts,r.started_at,r.finished_at,r.result_message_id,
 r.lease_token_hash IS NOT NULL AND r.lease_expires_at>clock_timestamp() AND r.started_at>clock_timestamp()-interval '30 minutes' AS lease_live
 FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id
 WHERE a.company_id=$1 AND a.id=$2 AND r.id=$3 AND r.requested_by=$4 AND r.purpose='task' FOR SHARE OF a,r`,[companyId,agentId,runId,requestedBy])).rows[0];
 if(!a||a.live!==true||a.invocation_access==='none'||a.attempts!==1||a.max_attempts!==1||!a.started_at||HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES.some(cap=>!a.capabilities.includes(cap)||!a.run_capabilities.includes(cap)))ended();
 const principals=[...new Set([requestedBy,a.created_by,...await managedAgentAuthorityPrincipals(db,companyId,agentId)])].sort();
 if((await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE",[companyId,principals])).rowCount!==principals.length)ended();
 if(a.status==='running'){if(a.lease_live!==true)ended();}
 else if(a.status==='succeeded'){
  if(!a.finished_at||!a.result_message_id||!(await db.query("SELECT 1 FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2 AND kind='complete' AND response#>>'{run,id}'=$2::text AND response#>>'{run,status}'='succeeded' LIMIT 1",[companyId,runId])).rowCount)ended();
 }else ended();
 const installation=(await db.query('SELECT id,revision FROM plugin_installations WHERE company_id=$1 AND agent_id=$2 FOR SHARE',[companyId,agentId])).rows[0]??null;
 return {...a,installation,coordination};
}
export async function createReferenceInspectionAuthority(db:PoolClient,actor:HiggsfieldReferenceActor,projectId:string,workItemId:string):Promise<HiggsfieldReferenceInspectionAuthority|null>{
 if(!await referencePreparationDispatch(db,actor,projectId,workItemId))return null;
 const a=await source(db,actor.companyId,actor.agentId!,actor.runId!,actor.userId,projectId,workItemId);
 if(a.status!=='running')ended();
 const clock=(await db.query("SELECT LEAST(clock_timestamp()+make_interval(mins=>$1),$2::timestamptz,$3::timestamptz) AS expires_at",[HIGGSFIELD_REFERENCE_INSPECTION_LIMITS.maxMinutes,a.expires_at,a.coordination?.expiresAt??a.expires_at])).rows[0];
 return {version:1,mode:'prepared_image_v1',companyId:actor.companyId,projectId,workItemId,runId:actor.runId!,agentId:actor.agentId!,requestedBy:actor.userId,agentSponsorId:a.created_by,credentialSha256:a.token_hash,installation:a.installation,startedAt:iso(a.started_at),attempt:1,expiresAt:iso(clock.expires_at),...a.coordination?{coordination:a.coordination}:{}};
}
export async function assertReferenceInspectionAuthority(db:PoolClient,r:Row){
 const s=r.inspection_authority as HiggsfieldReferenceInspectionAuthority;
 if(!s||s.version!==1||s.mode!=='prepared_image_v1'||referenceInspectionAuthorityHash(s)!==r.inspection_authority_sha256||s.companyId!==r.company_id||s.projectId!==r.project_id||s.workItemId!==r.work_item_id||s.agentId!==r.proposed_agent_id||s.runId!==r.proposed_run_id||s.requestedBy!==r.proposed_by||s.attempt!==1||s.expiresAt!==iso(r.inspect_expires_at))ended();
 const a=await source(db,r.company_id,r.proposed_agent_id,r.proposed_run_id,r.proposed_by,r.project_id,r.work_item_id);
 if(a.created_by!==s.agentSponsorId||a.token_hash!==s.credentialSha256||iso(a.started_at)!==s.startedAt||canonical(a.installation)!==canonical(s.installation)||canonical(a.coordination??null)!==canonical(s.coordination??null))ended();
}
/** A submitted/accepted planning task is still the same inspection objective.
 * Only the original committed submission proves the reservation after normal
 * acceptance clears tasks.agent_run_id. Arbitrary revision changes do not. */
export async function assertReferenceInspectionTask(db:PoolClient,r:Row,current:Row){
 const old=r.work_snapshot;
 if(current.assignee_id||current.title===undefined||current.description===undefined)ended();
 if(current.status==='doing'){
  if(current.agent_run_id!==r.proposed_run_id||current.task_revision!==old.taskRevision)ended();return;
 }
 if(!['review','done'].includes(current.status)||current.submitted_by||current.submitted_agent_id!==r.proposed_agent_id||current.task_revision!==old.taskRevision+(current.status==='review'?1:2))ended();
 const submitted=(await db.query(`SELECT response FROM agent_tool_receipts WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND tool='tasks_submit'
  AND response->>'id'=$4::text AND response->>'status'='review' AND response->>'agentRunId'=$3::text AND response->>'revision'=$5::text LIMIT 1`,[r.company_id,r.proposed_agent_id,r.proposed_run_id,old.taskId,old.taskRevision+1])).rows[0]?.response;
 if(!submitted||submitted.title!==current.title||submitted.description!==current.description||submitted.submissionSummary!==current.submission_summary||(submitted.submissionUrl??null)!==(current.submission_url??null))ended();
 if(current.status==='review'){if(current.agent_run_id!==r.proposed_run_id||current.approved_by||current.approved_agent_id||current.machine_review_id)ended();return;}
 if(current.agent_run_id!==null)ended();
 if(current.approved_by){
  if([r.proposed_by,r.inspection_authority.agentSponsorId].includes(current.approved_by)||!(await db.query("SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND access_revoked_at IS NULL FOR SHARE",[r.company_id,current.approved_by])).rowCount)ended();
 }else if(!current.approved_agent_id||!current.machine_review_id||!(await db.query(`SELECT 1 FROM studio_planning_reviews v JOIN studio_planning_review_decisions d ON d.company_id=v.company_id AND d.review_id=v.id WHERE v.company_id=$1 AND v.id=$2 AND v.project_id=$3 AND v.work_item_id=$4 AND v.task_id=$5 AND v.producer_agent_id=$6 AND v.producer_run_id=$7 AND v.task_revision=$8 AND v.reviewer_agent_id=$9 AND d.decision='approve'`,[r.company_id,current.machine_review_id,r.project_id,r.work_item_id,old.taskId,r.proposed_agent_id,r.proposed_run_id,old.taskRevision+1,current.approved_agent_id])).rowCount)ended();
}
