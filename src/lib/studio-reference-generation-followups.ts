/** Fresh, finite generation proposals from an exact inspected and shared
 * derivative. Ended producer leases never become executable again. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,fail,id,json} from './security';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {createAgentRunInTransaction} from './agent-runs';
import {executeAgentTaskAction} from './agent-task-actions';
import {lockedStudioProject} from './studio';
import {assertGeneratedWorkCurrent} from './studio-generated-rounds';
import {proposeHiggsfieldRequest} from './higgsfield';
import {higgsfieldReferenceDigest} from './higgsfield-references';
import {HIGGSFIELD_REFERENCE_GENERATION_CAPABILITIES} from './higgsfield-references-protocol';
import {assertReferenceGenerationHandoff,lockReferenceGenerationHandoff,referenceGenerationAuthorityBusy} from './studio-reference-generation-authority';
import {assertReferenceGenerationInspectionAdoption} from './studio-reference-generation-inspection';
import {referenceGenerationStepHash} from './studio-reference-generation-transition';
import {studioCoordinationPolicyRow,studioCoordinationConfiguration,studioCoordinationStatus,requireStudioCoordinationApprovalLive} from './studio-coordination';
import {studioReferenceGenerationFollowupGetInput,studioReferenceGenerationFollowupDispatchInput,studioReferenceGenerationFollowupAdvanceInput,type StudioReferenceGenerationFollowupContext} from './studio-reference-generation-followup-protocol';

type Row=Record<string,any>;
const required=HIGGSFIELD_REFERENCE_GENERATION_CAPABILITIES;
function changed():never{return fail(409,'This continuation no longer matches its exact reference, task, specialist or approval.','REFERENCE_GENERATION_FOLLOWUP_CHANGED');}
function unavailable():never{return fail(409,'A completed specialist, confirmed reference and current finite coordination approval are required.','REFERENCE_GENERATION_FOLLOWUP_UNAVAILABLE');}
const ownRow=async(db:PoolClient,companyId:string,runId:string)=>(await db.query('SELECT * FROM studio_reference_generation_followups WHERE company_id=$1 AND child_run_id=$2',[companyId,runId])).rows[0] as Row|undefined;
async function policyAuthority(db:PoolClient,companyId:string,receipt:Row){
 const p=await studioCoordinationPolicyRow(db,companyId,receipt.project_id,'share');
 if(!p||!p.referenceGenerationContinuations||p.revision!==receipt.policy_revision||p.coordinatorAgentId!==receipt.coordinator_agent_id||p.approvedBy!==receipt.approved_by
  ||receipt.coordinator_agent_id===receipt.specialist_agent_id&&!p.coordinatorGeneration)changed();
 if(!['active','exhausted'].includes((await studioCoordinationStatus(db,companyId,p)).effectiveStatus))unavailable();return p;
}
async function parentAuthority(db:PoolClient,f:Row){
 const p=(await db.query(`SELECT *,lease_token_hash IS NOT NULL AND lease_expires_at>clock_timestamp() AND started_at>clock_timestamp()-interval '30 minutes' AS live
  FROM agent_runs WHERE company_id=$1 AND id=$2`,[f.company_id,f.parent_run_id])).rows[0];
 if(!p||p.agent_id!==f.coordinator_agent_id||p.requested_by!==f.approved_by||!['running','succeeded'].includes(p.status))unavailable();
 if(p.status==='running'){if(!p.live||f.coordinator_agent_id===f.specialist_agent_id)unavailable();}
 else if(!p.finished_at||!p.result_message_id||!(await db.query("SELECT 1 FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2 AND kind='complete' AND response#>>'{run,id}'=$2::text AND response#>>'{run,status}'='succeeded' AND response#>>'{run,resultMessageId}'=$3::text",[f.company_id,p.id,p.result_message_id])).rowCount)unavailable();
 return p.status==='running'?new Date(Math.min(+new Date(p.lease_expires_at),+new Date(p.started_at)+1800000)).toISOString():null;
}
async function deadline(db:PoolClient,companyId:string,run:Row,expiresAt:string|Date){
 await requireStudioCoordinationApprovalLive(db,expiresAt);
 if(run.status==='running'&&!(await db.query("SELECT 1 FROM agent_runs WHERE company_id=$1 AND id=$2 AND status='running' AND lease_expires_at>clock_timestamp() AND started_at>clock_timestamp()-interval '30 minutes'",[companyId,run.id])).rowCount)fail(409,'This worker lease expired while checking the continuation.','RUN_LEASE_LOST');
}
/** Lifecycle checks take no project write lock across conversation completion.
 * The proposal itself additionally uses the standard locked reference resolver. */
async function referenceAuthority(db:PoolClient,r:Row){
 await assertReferenceGenerationInspectionAdoption(db,r,false,{nonBlockingRunLocks:true});
 const c=(await db.query('SELECT * FROM higgsfield_reference_confirmations WHERE company_id=$1 AND reference_id=$2 AND request_hash=$3 AND approval_hash=$4',[r.company_id,r.id,r.request_hash,r.approval_hash])).rows[0];
 const inspection=(await db.query('SELECT inspection_hash FROM higgsfield_reference_inspections WHERE company_id=$1 AND reference_id=$2 AND request_hash=$3',[r.company_id,r.id,r.request_hash])).rows[0];
 const provider=(await db.query('SELECT id,revision,status,connected_by,tools FROM higgsfield_connections WHERE company_id=$1',[r.company_id])).rows[0];
 const binding=(await db.query('SELECT b.*,c.revision AS connection_revision,c.status AS connection_status,c.created_by AS sponsor,c.secret_envelope IS NOT NULL AS credentials FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE b.company_id=$1 AND b.project_id=$2',[r.company_id,r.project_id])).rows[0];
 if(!c||!inspection||Number(c.bytes)!==r.proxy_snapshot.bytes||c.sha256!==r.proxy_snapshot.sha256||!r.approved_by
  ||!provider||provider.status!=='connected'||provider.id!==r.provider_connection_id||provider.revision!==r.provider_connection_revision||provider.connected_by!==r.provider_sponsor_id||higgsfieldReferenceDigest(provider.tools)!==r.catalog_sha256
  ||!binding||binding.id!==r.storage_binding_id||binding.revision!==r.storage_binding_revision||binding.connection_id!==r.storage_connection_id||binding.connection_revision!==r.storage_connection_revision||binding.sponsor!==r.storage_sponsor_id||binding.connection_status!=='configured'||!binding.credentials)changed();
 const sponsors=[...new Set([r.approved_by,r.storage_sponsor_id,r.provider_sponsor_id])].sort();
 if((await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE",[r.company_id,sponsors])).rowCount!==sponsors.length)changed();
 for(const version of [r.source_snapshot,r.proxy_snapshot]){
  if(!(await db.query(`SELECT 1 FROM project_storage_versions v JOIN project_storage_files f ON f.company_id=v.company_id AND f.project_id=v.project_id AND f.id=v.file_id
   JOIN project_storage_verifications verified ON verified.company_id=v.company_id AND verified.project_id=v.project_id AND verified.version_id=v.id
   WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3 AND f.binding_id=$4 AND v.bytes=$5 AND verified.bytes=$5 AND verified.sha256=$6 AND (v.sha256 IS NULL OR v.sha256=$6) AND v.content_type=$7`,[r.company_id,r.project_id,version.versionId,r.storage_binding_id,version.bytes,version.sha256,version.contentType])).rowCount)changed();
 }
 if(!(await db.query('SELECT expires_at>clock_timestamp() AS live FROM higgsfield_references WHERE company_id=$1 AND id=$2',[r.company_id,r.id])).rows[0]?.live)unavailable();return {mediaId:c.media_id};
}
async function evidence(db:PoolClient,companyId:string,projectId:string,referenceId:string,f?:Row){
 const r=(await db.query('SELECT * FROM higgsfield_references WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,referenceId])).rows[0];
 if(!r?.generation_handoff_id||r.status!=='confirmed'||!r.generation_inspection_adoption_id)unavailable();
 const exact=await assertReferenceGenerationHandoff(db,r,{requireSucceededProducer:true,adoptedSource:true,nonBlockingRunLocks:true});if(!exact)unavailable();const h=exact.handoff;
 await assertGeneratedWorkCurrent(db,companyId,projectId,h.work_item_id);
 if((await db.query("SELECT 1 FROM studio_dependencies d JOIN studio_work_items w ON w.company_id=d.company_id AND w.id=d.predecessor_id JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND t.status<>'done' LIMIT 1",[companyId,projectId,h.work_item_id])).rowCount)unavailable();
 const media=await referenceAuthority(db,r);
 if((await db.query("SELECT 1 FROM studio_dispatches d JOIN agent_runs run ON run.company_id=d.company_id AND run.id=d.run_id WHERE d.company_id=$1 AND d.work_item_id=$2 AND run.status IN ('queued','running') AND ($3::uuid IS NULL OR run.id<>$3) LIMIT 1",[companyId,h.work_item_id,f?.child_run_id??null])).rowCount)unavailable();
 let state:'claim'|'proposal'|'proposed'='claim',request:Row|undefined,claimed:Row|undefined;
 if(f){
  if(f.handoff_id!==h.id||f.work_item_id!==h.work_item_id||f.task_id!==h.task_id||f.source_child_run_id!==h.source_child_run_id||f.specialist_agent_id!==h.specialist_agent_id||f.coordinator_agent_id!==h.coordinator_agent_id
   ||f.initial_task_revision!==h.task_revision||f.reference_id!==r.id||f.reference_revision!==r.revision||f.reference_approval_hash!==r.approval_hash||f.media_id!==media.mediaId)changed();
  const steps=(await db.query('SELECT step,request_id FROM studio_reference_generation_followup_steps WHERE company_id=$1 AND child_run_id=$2',[companyId,f.child_run_id])).rows;
  if(steps.length!==2||!steps.some(s=>s.step==='claim'&&s.request_id===f.claim_request_id)||!steps.some(s=>s.step==='proposal'&&s.request_id===f.proposal_request_id))changed();
  claimed=(await db.query('SELECT * FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[companyId,'agent:'+f.specialist_agent_id,f.claim_request_id])).rows[0];
  if(claimed&&claimed.request_hash!==referenceGenerationStepHash(f,'claim'))changed();
  const requests=(await db.query('SELECT * FROM higgsfield_requests WHERE company_id=$1 AND run_id=$2',[companyId,f.child_run_id])).rows;if(requests.length>1)changed();request=requests[0];
  if(request&&(!claimed||request.client_id!==f.proposal_request_id||request.requested_by!==f.approved_by||request.agent_id!==f.specialist_agent_id||request.project_id!==projectId||request.work_item_id!==h.work_item_id
   ||request.project_revision!==h.project_revision||request.task_revision!==h.task_revision+1||request.reference_ids?.length!==1||request.reference_ids[0]!==r.id||request.reference_snapshot?.references?.[0]?.approvalHash!==f.reference_approval_hash
   ||request.reference_snapshot?.references?.[0]?.mediaId!==f.media_id))changed();
  if(claimed)state=request?'proposed':'proposal';
 }
 return {reference:r,handoff:h,expiresAt:new Date(Math.min(+new Date(exact.expiresAt),+new Date(r.expires_at))).toISOString(),state,claimed,request,media};
}
export async function referenceGenerationFollowupRunAuthority(db:PoolClient,companyId:string,run:Row):Promise<boolean>{
 const f=await ownRow(db,companyId,run.id);if(!f||!['queued','running'].includes(run.status))return true;
 try{if(run.agent_id!==f.specialist_agent_id||run.requested_by!==f.approved_by||run.max_attempts!==1||required.some(c=>!run.capabilities.includes(c)))return false;
  const current=await evidence(db,companyId,f.project_id,f.reference_id,f),policy=await policyAuthority(db,companyId,f),parentExpiry=await parentAuthority(db,f);await deadline(db,companyId,run,new Date(Math.min(+new Date(current.expiresAt),+new Date(policy.expiresAt),parentExpiry?+new Date(parentExpiry):Infinity)).toISOString());return true;
 }catch(error){if(!(error instanceof ApiError)||error.status>=500||error.code==='REFERENCE_GENERATION_AUTHORITY_BUSY')throw error;return false;}
}
/** Only the final commit boundary may retain source locks across completion.
 * Initial lifecycle reads stay free of project locks, since conversation
 * acquisition precedes this boundary. NOWAIT prevents a parent-run/policy
 * cycle from being misclassified as lost authority or cancelling live work. */
export async function referenceGenerationFollowupCommitAuthority(db:PoolClient,companyId:string,run:Row):Promise<void>{
 const f=await ownRow(db,companyId,run.id);if(!f||!['queued','running'].includes(run.status))return;
 try{
  const h=await lockReferenceGenerationHandoff(db,companyId,f.reference_id,[],{nonBlocking:true});if(!h)changed();
  await db.query('SELECT id FROM agent_runs WHERE company_id=$1 AND id=$2 FOR SHARE NOWAIT',[companyId,f.parent_run_id]);
  await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE NOWAIT',[companyId,f.project_id]);
  const r=(await db.query('SELECT * FROM higgsfield_references WHERE company_id=$1 AND id=$2 FOR SHARE NOWAIT',[companyId,f.reference_id])).rows[0];if(!r)changed();
  await db.query('SELECT id FROM project_image_preparations WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE NOWAIT',[companyId,f.project_id,h.preparation_id]);
  await db.query(`SELECT id FROM tasks WHERE company_id=$1 AND (id=$2 OR id IN(SELECT w.task_id FROM studio_dependencies d JOIN studio_work_items w ON w.company_id=d.company_id AND w.id=d.predecessor_id WHERE d.company_id=$1 AND d.project_id=$3 AND d.work_item_id=$4)) ORDER BY id FOR SHARE NOWAIT`,[companyId,h.task_id,f.project_id,h.work_item_id]);
  await db.query('SELECT id FROM higgsfield_connections WHERE company_id=$1 AND id=$2 FOR SHARE NOWAIT',[companyId,r.provider_connection_id]);
  await db.query('SELECT id FROM project_storage_connections WHERE company_id=$1 AND id=$2 FOR SHARE NOWAIT',[companyId,r.storage_connection_id]);
  await db.query('SELECT id FROM project_storage_bindings WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE NOWAIT',[companyId,f.project_id,r.storage_binding_id]);
  await db.query('SELECT id FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE NOWAIT',[companyId,f.project_id,[r.source_snapshot.fileId,r.proxy_snapshot.fileId].sort()]);
  if(!await referenceGenerationFollowupRunAuthority(db,companyId,run))fail(409,'This reference-generation continuation no longer has its exact source authority.','REFERENCE_GENERATION_FOLLOWUP_AUTHORITY_ENDED');
 }catch(error){referenceGenerationAuthorityBusy(error);}
}
export async function referenceGenerationFollowupRunContext(db:PoolClient,companyId:string,runId:string):Promise<StudioReferenceGenerationFollowupContext|null>{
 const f=await ownRow(db,companyId,runId);if(!f)return null;const current=await evidence(db,companyId,f.project_id,f.reference_id,f);
 return {projectId:f.project_id,workItemId:f.work_item_id,taskId:f.task_id,referenceId:f.reference_id,handoffSha256:current.handoff.handoff_sha256,requestId:current.request?.id??null,nextStep:current.state,
  advanceTool:'studio_reference_generation_followup_advance',serverOwnsOperationIds:true,contentInspected:false,canGenerate:false,canTransfer:false,canApprove:false};
}
const rules:Record<string,(args:Row,f:Row,current:Row)=>unknown>={
 studio_reference_generation_followup_advance:(a,f)=>a.projectId===f.project_id&&a.workItemId===f.work_item_id,
 studio_get:(a,f)=>a.contractVersion===2&&a.projectId===f.project_id&&a.workItemId===f.work_item_id&&!a.artifactId&&!a.after,
 higgsfield_connection_get:()=>true,
 higgsfield_reference_get:(a,f)=>a.referenceId===f.reference_id,
 higgsfield_requests_list:(a,f,c)=>!!c.request&&a.projectId===f.project_id&&a.requestId===c.request.id&&!a.after,
 studio_reference_generation_followups_get:(a,f)=>a.projectId===f.project_id&&a.referenceId===f.reference_id&&!a.after&&!a.historyAfter,
};
export const referenceGenerationFollowupToolNames:readonly string[]=Object.freeze(Object.keys(rules));
export async function assertReferenceGenerationFollowupTool(db:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const f=await ownRow(db,agent.company_id,run.id);if(!f)return;
 const p=await policyAuthority(db,agent.company_id,f);await lockReferenceGenerationHandoff(db,agent.company_id,f.reference_id,[],{nonBlocking:true});await lockedStudioProject(db,agent.company_id,f.project_id);
 const current=await evidence(db,agent.company_id,f.project_id,f.reference_id,f);
 if(agent.id!==f.specialist_agent_id||!Object.hasOwn(rules,name)||!rules[name](args,f,current))fail(403,'This continuation may only read its pinned work and advance one exact claim and generation proposal.','REFERENCE_GENERATION_FOLLOWUP_SCOPE');
 await deadline(db,agent.company_id,run,new Date(Math.min(+new Date(p.expiresAt),+new Date(current.expiresAt))));
}
const receipt=(f:Row)=>({projectId:f.project_id,workItemId:f.work_item_id,taskId:f.task_id,referenceId:f.reference_id,sourceChildRunId:f.source_child_run_id,parentRunId:f.parent_run_id,childRunId:f.child_run_id,specialistAgentId:f.specialist_agent_id,policyRevision:f.policy_revision,createdAt:new Date(f.created_at).toISOString(),status:f.status});
export async function studioReferenceGenerationFollowupSnapshot(db:PoolClient,companyId:string,input:unknown){
 const data=studioReferenceGenerationFollowupGetInput.parse(input);
 const project=(await db.query('SELECT contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,data.projectId])).rows[0];if(!project)fail(404,'Project not found.');if(project.contract_version!==2)unavailable();
 const rows=(await db.query('SELECT reference_id,work_item_id FROM studio_reference_generation_handoffs WHERE company_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR reference_id=$3) AND ($4::uuid IS NULL OR reference_id>$4) ORDER BY reference_id LIMIT $5',[companyId,data.projectId,data.referenceId??null,data.after??null,data.limit+1])).rows;
 const candidates=[];
 for(const h of rows.slice(0,data.limit)){
  const prior=(await db.query('SELECT f.*,r.status FROM studio_reference_generation_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.reference_id=$2',[companyId,h.reference_id])).rows[0];let blocker:string|null=null;
  try{const current=await evidence(db,companyId,data.projectId,h.reference_id,prior),p=await studioCoordinationPolicyRow(db,companyId,data.projectId);
   if(!p?.referenceGenerationContinuations||!p.allowedRoleKeys.includes(current.handoff.source_snapshot.work.roleKey))blocker='Review and enable this specialist continuation in the coordination policy.';
   else if(!prior&&p.runsStarted>=p.maxRuns)blocker='The approved lifetime run limit is exhausted.';
  }catch(error){if(!(error instanceof ApiError)||error.status>=500||error.code==='REFERENCE_GENERATION_AUTHORITY_BUSY')throw error;blocker=error.message;}
  candidates.push({referenceId:h.reference_id,workItemId:h.work_item_id,eligible:!prior&&!blocker,blocker,continuation:prior?receipt(prior):null});
 }
 const history=(await db.query('SELECT f.*,r.status FROM studio_reference_generation_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.project_id=$2 AND ($3::uuid IS NULL OR f.reference_id=$3) AND ($4::uuid IS NULL OR f.child_run_id>$4) ORDER BY f.child_run_id LIMIT $5',[companyId,data.projectId,data.referenceId??null,data.historyAfter??null,data.limit+1])).rows;
 return {candidates,history:history.slice(0,data.limit).map(receipt),hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?rows[data.limit-1].reference_id:null,historyHasMore:history.length>data.limit,historyNextAfter:history.length>data.limit?history[data.limit-1].child_run_id:null,requiresExplicitPolicy:true,automaticProviderActions:false,contentInspected:false};
}
export async function dispatchStudioReferenceGenerationFollowup(db:PoolClient,agent:Row,run:Row,input:unknown){
 const data=studioReferenceGenerationFollowupDispatchInput.parse(input),companyId=agent.company_id;
 if((await db.query('SELECT run_id FROM studio_dispatches WHERE company_id=$1 AND run_id=$2 UNION ALL SELECT reviewer_run_id FROM studio_planning_reviews WHERE company_id=$1 AND reviewer_run_id=$2',[companyId,run.id])).rowCount)fail(403,'A delegated specialist cannot delegate another run.','COORDINATION_NESTED_DISPATCH');
 const preview=await studioCoordinationPolicyRow(db,companyId,data.projectId);if(!preview||preview.coordinatorAgentId!==agent.id)fail(403,'Only the approved coordinator can continue this generation.','COORDINATION_AGENT_REQUIRED');
 await db.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[companyId,preview.approvedBy]);await studioCoordinationConfiguration(db,companyId,preview.coordinatorAgentId,preview.allowedRoleKeys,true);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-coordination:${companyId}:${data.projectId}`]);
 const policy=await studioCoordinationPolicyRow(db,companyId,data.projectId,'update');
 if(!policy||!policy.referenceGenerationContinuations||policy.revision!==data.policyRevision||policy.coordinatorAgentId!==agent.id)fail(409,'Review the current reference-generation continuation policy.','COORDINATION_REVISION_CONFLICT');
 if(run.requested_by!==policy.approvedBy)fail(403,'The coordinator request must be sponsored by this policy approver.','COORDINATION_REQUESTER_REQUIRED');
 if(!['active','exhausted'].includes((await studioCoordinationStatus(db,companyId,policy)).effectiveStatus))unavailable();
 const prior=(await db.query('SELECT f.*,r.status FROM studio_reference_generation_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.reference_id=$2',[companyId,data.referenceId])).rows[0];
 if(prior){if(prior.work_item_id!==data.workItemId||prior.project_id!==data.projectId)changed();await policyAuthority(db,companyId,prior);const current=await evidence(db,companyId,data.projectId,data.referenceId,prior);await deadline(db,companyId,run,new Date(Math.min(+new Date(policy.expiresAt),+new Date(current.expiresAt))));return {continuation:receipt(prior),replayed:true};}
 if(policy.runsStarted>=policy.maxRuns)fail(409,'The approved lifetime specialist limit is exhausted.','COORDINATION_RUN_BUDGET');
 const count=Number((await db.query("SELECT count(*) FROM (SELECT company_id,project_id,child_run_id FROM studio_coordination_dispatches UNION ALL SELECT company_id,project_id,child_run_id FROM studio_coordination_followups UNION ALL SELECT company_id,project_id,child_run_id FROM studio_generated_followups UNION ALL SELECT company_id,project_id,child_run_id FROM studio_reference_generation_followups) d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.child_run_id WHERE d.company_id=$1 AND d.project_id=$2 AND r.status IN ('queued','running')",[companyId,data.projectId])).rows[0].count);
 if(count>=policy.maxConcurrentRuns)fail(409,'The approved specialist concurrency limit is reached.','COORDINATION_CONCURRENCY');
 const h=(await db.query('SELECT * FROM studio_reference_generation_handoffs WHERE company_id=$1 AND project_id=$2 AND reference_id=$3 AND work_item_id=$4',[companyId,data.projectId,data.referenceId,data.workItemId])).rows[0];
 if(!h||!policy.allowedRoleKeys.includes(h.source_snapshot.work.roleKey)||h.coordinator_agent_id!==agent.id||h.specialist_agent_id===agent.id&&!policy.coordinatorGeneration)unavailable();
 const user=(await db.query('SELECT id,name,email FROM users WHERE id=$1',[policy.approvedBy])).rows[0],member={companyId,userId:policy.approvedBy,role:'admin',user} as Membership;
 const prompt=`Continue the original ${h.source_snapshot.work.roleKey} generation task ${h.task_id} in project ${data.projectId}, work ${data.workItemId}. Use referenceGenerationFollowup context and studio_get for this assigned task. Its inspected, shared reference is pinned by Coatria. Use studio_reference_generation_followup_advance to claim, then propose exact tool/arguments/note for this original objective. The server supplies the sole reference, current revisions and stable operation IDs. Omit media IDs and URLs from arguments. After the proposal commits, complete with its real ID and stop for separate human credit approval. Do not generate, transfer, approve, delegate, submit the media task, create another reference, or claim you inspected pixels. On uncertainty retry the identical step; on ended authority fail without replacement.`;
 const queued=await createAgentRunInTransaction(db,member,'commons',{clientId:randomUUID(),agentId:h.specialist_agent_id,prompt});
 if(required.some(cap=>!queued.run.capabilities.includes(cap)))fail(409,'The specialist lacks required generation grants.','STUDIO_AGENT_CAPABILITIES');
 await lockReferenceGenerationHandoff(db,companyId,data.referenceId,[],{nonBlocking:true});await lockedStudioProject(db,companyId,data.projectId,data.projectRevision);
 const current=await evidence(db,companyId,data.projectId,data.referenceId);
 if(current.handoff.id!==h.id)changed();
 await db.query('UPDATE agent_runs SET max_attempts=1,capabilities=$3 WHERE company_id=$1 AND id=$2',[companyId,queued.run.id,JSON.stringify(required)]);
 await db.query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[companyId,data.projectId,data.workItemId,queued.run.id]);
 const f={company_id:companyId,project_id:data.projectId,handoff_id:h.id,work_item_id:data.workItemId,task_id:h.task_id,source_child_run_id:h.source_child_run_id,parent_run_id:run.id,child_run_id:queued.run.id,coordinator_agent_id:agent.id,specialist_agent_id:h.specialist_agent_id,policy_revision:policy.revision,approved_by:policy.approvedBy,initial_task_revision:h.task_revision,reference_id:data.referenceId,reference_revision:current.reference.revision,reference_approval_hash:current.reference.approval_hash,media_id:current.media.mediaId,claim_request_id:randomUUID(),proposal_request_id:randomUUID()};
 const keys=Object.keys(f);await db.query(`INSERT INTO studio_reference_generation_followups(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(f));
 await db.query('UPDATE studio_coordination_policies SET runs_started=runs_started+1 WHERE company_id=$1 AND project_id=$2',[companyId,data.projectId]);
 // Dispatch and claim have their own durable revisions/receipts. They do not
 // change project content or infer consent to a newer project revision.
 await db.query("INSERT INTO activity(company_id,kind,description) VALUES($1,'studio.reference_generation_followup_dispatched','A coordinator queued one exact reference-bound proposal continuation; generation credit approval remains separate.')",[companyId]);
 const final=await evidence(db,companyId,data.projectId,data.referenceId,f);await deadline(db,companyId,run,new Date(Math.min(+new Date(policy.expiresAt),+new Date(final.expiresAt))));
 const saved=(await db.query('SELECT f.*,r.status FROM studio_reference_generation_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.child_run_id=$2',[companyId,queued.run.id])).rows[0];return {continuation:receipt(saved),replayed:false};
}
export async function advanceStudioReferenceGenerationFollowup(db:PoolClient,agent:Row,run:Row,requesterRole:string,input:unknown){
 const data=studioReferenceGenerationFollowupAdvanceInput.parse(input),companyId=agent.company_id,f=await ownRow(db,companyId,run.id);
 if(!f||f.specialist_agent_id!==agent.id||f.project_id!==data.projectId||f.work_item_id!==data.workItemId||f.approved_by!==run.requested_by||!['owner','admin'].includes(requesterRole))fail(403,'This run does not own the pinned generation continuation.','REFERENCE_GENERATION_FOLLOWUP_SCOPE');
 const policy=await policyAuthority(db,companyId,f);await lockReferenceGenerationHandoff(db,companyId,f.reference_id,[],{nonBlocking:true});const p=await lockedStudioProject(db,companyId,data.projectId);
 const current=await evidence(db,companyId,data.projectId,f.reference_id,f);await deadline(db,companyId,run,new Date(Math.min(+new Date(policy.expiresAt),+new Date(current.expiresAt))));
 if(data.step==='claim'&&current.claimed)return {step:'claim',...current.claimed.response,replayed:true};
 if(current.state!==data.step&&!(data.step==='proposal'&&current.state==='proposed'))fail(409,`Continue the ${current.state} step from the run context.`,'REFERENCE_GENERATION_FOLLOWUP_STEP');
 let result:Row;
 if(data.step==='claim'){
  const task=await executeAgentTaskAction(db,agent,run,requesterRole,'tasks_claim',{taskId:f.task_id,revision:f.initial_task_revision});result={task};
  await db.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[companyId,'agent:'+agent.id,f.claim_request_id,referenceGenerationStepHash(f,'claim'),JSON.stringify(result)]);
 }else result=await proposeHiggsfieldRequest(db,{companyId,userId:run.requested_by,agentId:agent.id,runId:run.id,agentSponsorId:agent.created_by},{...data.proposal,clientId:f.proposal_request_id,projectId:f.project_id,workItemId:f.work_item_id,projectRevision:p.revision,referenceIds:[f.reference_id]});
 const final=await evidence(db,companyId,data.projectId,f.reference_id,f);await deadline(db,companyId,run,new Date(Math.min(+new Date(policy.expiresAt),+new Date(final.expiresAt))));return {step:data.step,...result,replayed:Boolean(result.replayed)};
}
export async function studioReferenceGenerationFollowupRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='projects'||parts.length!==6||parts[5]!=='reference-generation-followups'||method!=='GET')return null;
 const member=await requireMembership(request,id(parts[1])),q=new URL(request.url).searchParams;
 const data=studioReferenceGenerationFollowupGetInput.parse({projectId:id(parts[4]),referenceId:q.get('referenceId')??undefined,after:q.get('after')??undefined,historyAfter:q.get('historyAfter')??undefined,limit:q.has('limit')?Number(q.get('limit')):undefined});
 return json(await memberMutation(member,false,db=>studioReferenceGenerationFollowupSnapshot(db,member.companyId,data)));
}
