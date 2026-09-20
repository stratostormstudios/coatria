import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {ApiError,fail,id,json} from './security';
import {createAgentRunInTransaction} from './agent-runs';
import {executeAgentTaskAction} from './agent-task-actions';
import {managedAgentAuthoritySql} from './studio-hosting';
import {lockedStudioProject,bumpStudioProject} from './studio';
import {loadVerifiedGeneratedSource,loadStoredGeneratedArtifact,studioGeneratedSourceInput} from './studio-generated-artifacts';
import {studioGeneratedObservedMediaInput,studioGeneratedFileFactsInput} from './studio-generated-protocol';
import {studioCoordinationPolicyRow,studioCoordinationConfiguration,studioCoordinationStatus,requireStudioCoordinationApprovalLive} from './studio-coordination';
import {studioGeneratedFollowupGetInput,studioGeneratedFollowupDispatchInput,studioGeneratedFollowupAdvanceInput,type StudioGeneratedFollowupStep} from './studio-generated-followup-protocol';

type Row=Record<string,any>;
const required=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const generatedFollowupEvidenceInput=z.object({schemaVersion:z.literal(1),projectId:uuid,workItemId:uuid,taskId:uuid,roleKey:z.string().min(1).max(80),sourceChildRunId:uuid,specialistAgentId:uuid,archiveId:uuid,archiveApprovedBy:uuid,requestId:uuid,jobId:uuid,outputId:uuid,storageVersionId:uuid,specSha256:hash,gatesSha256:hash,source:studioGeneratedSourceInput,media:studioGeneratedObservedMediaInput,file:studioGeneratedFileFactsInput}).strict();
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function changed():never{return fail(409,'This continuation no longer matches its exact source, task or approval. Reconcile the original work.','GENERATED_FOLLOWUP_CHANGED');}
function unavailable():never{return fail(409,'A verified archive from the original stopped specialist and current production authority are required.','GENERATED_FOLLOWUP_UNAVAILABLE');}
const ownRow=async(db:PoolClient,companyId:string,runId:string)=>(await db.query('SELECT * FROM studio_generated_followups WHERE company_id=$1 AND child_run_id=$2',[companyId,runId])).rows[0] as Row|undefined;
const stepId=(receipt:Row,step:StudioGeneratedFollowupStep)=>receipt[`${step==='register'?'registration':step==='submit'?'submission':'claim'}_request_id`] as string;
const stepHash=(receipt:Row,step:StudioGeneratedFollowupStep)=>digest({operation:'generated-followup-step',runId:receipt.child_run_id,projectId:receipt.project_id,workItemId:receipt.work_item_id,step});
async function stepReceipts(db:PoolClient,receipt:Row){return (await db.query('SELECT client_id,request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=ANY($3::uuid[])',[receipt.company_id,'agent:'+receipt.specialist_agent_id,[receipt.claim_request_id,receipt.registration_request_id,receipt.submission_request_id]])).rows;}
function receiptFor(rows:Row[],receipt:Row,step:StudioGeneratedFollowupStep){const prior=rows.find(row=>row.client_id===stepId(receipt,step));if(prior&&step!=='register'&&prior.request_hash!==stepHash(receipt,step))changed();return prior;}
async function policyAuthority(db:PoolClient,companyId:string,receipt:Row){
 const p=await studioCoordinationPolicyRow(db,companyId,receipt.project_id,'share');
 if(!p||!p.generatedContinuations||p.revision!==receipt.policy_revision||p.coordinatorAgentId!==receipt.coordinator_agent_id||p.approvedBy!==receipt.approved_by)changed();
 const active=await studioCoordinationStatus(db,companyId,p);if(!['active','exhausted'].includes(active.effectiveStatus))unavailable();return p;
}
async function taskEvidence(db:PoolClient,companyId:string,projectId:string,workItemId:string,followupRunId?:string){
 return (await db.query(`SELECT w.task_id,w.role_key,w.stage,w.execution,b.agent_id,b.human_id,t.status AS task_status,t.revision AS task_revision,t.agent_run_id,t.assignee_id,
 p.contract_version,p.status AS project_status,p.ai_policy,p.gates,p.revision AS project_revision,
 d.child_run_id AS source_child_run_id,d.specialist_agent_id,source.status AS source_status,
 a.status AS agent_status,a.capabilities,a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} AS agent_live,
 EXISTS(SELECT 1 FROM studio_dependencies dep JOIN studio_work_items prior ON prior.company_id=dep.company_id AND prior.id=dep.predecessor_id JOIN tasks pt ON pt.company_id=prior.company_id AND pt.id=prior.task_id WHERE dep.company_id=w.company_id AND dep.work_item_id=w.id AND pt.status<>'done') AS dependencies_pending,
 EXISTS(SELECT 1 FROM studio_dispatches pending JOIN agent_runs r ON r.company_id=pending.company_id AND r.id=pending.run_id WHERE pending.company_id=w.company_id AND pending.work_item_id=w.id AND r.status IN ('queued','running') AND ($4::uuid IS NULL OR r.id<>$4)) AS other_active
 FROM studio_work_items w JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
 JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
 JOIN studio_coordination_dispatches d ON d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id
 JOIN agent_runs source ON source.company_id=d.company_id AND source.id=d.child_run_id JOIN agents a ON a.company_id=d.company_id AND a.id=d.specialist_agent_id
 WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3`,[companyId,projectId,workItemId,followupRunId??null])).rows[0] as Row|undefined;
}
/** Current evidence uses the verified source reader; it never fetches provider
 * bytes. Lifecycle callers take no project write lock across conversation work. */
async function evidence(db:PoolClient,companyId:string,projectId:string,workItemId:string,archiveId:string,receipt?:Row){
 const work=await taskEvidence(db,companyId,projectId,workItemId,receipt?.child_run_id);
 if(!work||work.contract_version!==2||work.stage!=='generation'||work.execution!=='creative'||work.project_status==='delivered'||work.ai_policy!=='allowed'||work.dependencies_pending||work.other_active||work.assignee_id||work.human_id||work.agent_id!==work.specialist_agent_id||!['succeeded','failed','cancelled'].includes(work.source_status)||work.agent_status!=='active'||!work.agent_live||required.some(cap=>!work.capabilities.includes(cap))||['brief','estimate','production'].some(gate=>work.gates[gate]?.decision!=='approved'))unavailable();
 const source=await loadVerifiedGeneratedSource(db,companyId,projectId,workItemId,archiveId,{requireAvailable:true});
 if(source.sourceSnapshot.agentId!==work.specialist_agent_id||source.sourceSnapshot.runId!==work.source_child_run_id||source.sourceSnapshot.roleAgentId!==work.specialist_agent_id||source.sourceSnapshot.roleHumanId!==null)changed();
 const principals=[...new Set([source.sourceSnapshot.requestedBy,source.sourceSnapshot.agentSponsorId!,source.sourceSnapshot.providerSponsorId])].sort();
 const sponsors=(await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') ORDER BY user_id FOR SHARE",[companyId,principals])).rows;if(sponsors.length!==principals.length)unavailable();
 const exact=generatedFollowupEvidenceInput.parse({schemaVersion:1,projectId,workItemId,taskId:work.task_id,roleKey:work.role_key,sourceChildRunId:work.source_child_run_id,specialistAgentId:work.specialist_agent_id,archiveId,archiveApprovedBy:source.archiveApprovedBy,requestId:source.requestId,jobId:source.jobId,outputId:source.outputId,storageVersionId:source.storageVersionId,specSha256:source.specSha256,gatesSha256:digest(work.gates),source:source.sourceSnapshot,media:source.observedMedia,file:source.fileFacts});
 const registered=(await db.query('SELECT s.artifact_id FROM studio_generated_artifact_sources s WHERE s.company_id=$1 AND s.project_id=$2 AND (s.archive_id=$3 OR s.output_id=$4 OR s.storage_version_id=$5)',[companyId,projectId,archiveId,source.outputId,source.storageVersionId])).rows;
 if(registered.length>1)changed();
 const artifact=registered[0]?await loadStoredGeneratedArtifact(db,companyId,projectId,registered[0].artifact_id,{requireAvailable:true}):null;
 if(artifact){if(artifact.workItemId!==workItemId||artifact.archiveId!==archiveId||artifact.sourceSnapshot.runId!==work.source_child_run_id)changed();const latest=(await db.query('SELECT id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 ORDER BY version DESC LIMIT 1',[companyId,projectId,workItemId])).rows[0];if(latest?.id!==artifact.artifact.id)changed();}
 let state:'claim'|'register'|'submit'|'submitted'='claim';let steps:Row[]=[];
 if(receipt){
  const parsed=generatedFollowupEvidenceInput.safeParse(receipt.source_snapshot);if(!parsed.success||digest(parsed.data)!==receipt.source_sha256||digest(exact)!==receipt.source_sha256||receipt.specialist_agent_id!==work.specialist_agent_id||receipt.source_child_run_id!==work.source_child_run_id||receipt.task_id!==work.task_id)changed();
  steps=await stepReceipts(db,receipt);const claimed=receiptFor(steps,receipt,'claim'),submitted=receiptFor(steps,receipt,'submit'),registeredStep=receiptFor(steps,receipt,'register');
  if(receipt.artifact_id){if(!artifact||artifact.artifact.id!==receipt.artifact_id||artifact.manifestSha256!==receipt.artifact_sha256||registeredStep)changed();}
  else if(artifact){
   if(!registeredStep||artifact.registeredRunId!==receipt.child_run_id||artifact.registeredAgentId!==receipt.specialist_agent_id||artifact.registeredBy!==receipt.approved_by||registeredStep.response?.artifact?.id!==artifact.artifact.id)changed();
   const data={clientId:receipt.registration_request_id,revision:registeredStep.response.project.revision-1,workItemId,archiveId,name:receipt.registration_name,notes:receipt.registration_notes};
   if(registeredStep.request_hash!==digest({operation:'generated-artifact:'+projectId,data}))changed();
  }else if(registeredStep)changed();
  if(!claimed){if(submitted||registeredStep||work.task_status!=='doing'||work.agent_run_id!==work.source_child_run_id||work.task_revision!==receipt.initial_task_revision)changed();}
  else if(!submitted){if(work.task_status!=='doing'||work.agent_run_id!==receipt.child_run_id||work.task_revision!==receipt.initial_task_revision+1)changed();state=artifact?'submit':'register';}
  else{if(!artifact||work.agent_run_id!==receipt.child_run_id||!((work.task_status==='review'&&work.task_revision===receipt.initial_task_revision+2)||(work.task_status==='done'&&work.task_revision===receipt.initial_task_revision+3)))changed();state='submitted';}
 }else if(work.task_status!=='doing'||work.agent_run_id!==work.source_child_run_id)unavailable();
 return {work,exact,artifact,state,steps};
}
async function deadline(db:PoolClient,companyId:string,run:Row,expiresAt:string|Date){
 await requireStudioCoordinationApprovalLive(db,expiresAt);
 if(run.status==='running'&&!(await db.query("SELECT id FROM agent_runs WHERE company_id=$1 AND id=$2 AND status='running' AND lease_expires_at>clock_timestamp() AND started_at>clock_timestamp()-interval '30 minutes'",[companyId,run.id])).rowCount)fail(409,'This worker lease expired while checking the continuation.','RUN_LEASE_LOST');
}
export async function generatedFollowupRunAuthority(db:PoolClient,companyId:string,run:Row):Promise<boolean>{
 const receipt=await ownRow(db,companyId,run.id);if(!receipt)return true;
 // A completion receipt remains historical. New tools still require a live lease.
 if(!['queued','running'].includes(run.status))return true;
 try{const p=await policyAuthority(db,companyId,receipt);await evidence(db,companyId,receipt.project_id,receipt.work_item_id,receipt.archive_id,receipt);await deadline(db,companyId,run,p.expiresAt);return true;}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;return false;}
}
export async function generatedFollowupRunContext(db:PoolClient,companyId:string,runId:string){
 const receipt=await ownRow(db,companyId,runId);if(!receipt)return null;
 const current=await evidence(db,companyId,receipt.project_id,receipt.work_item_id,receipt.archive_id,receipt);
 return {projectId:receipt.project_id,workItemId:receipt.work_item_id,taskId:receipt.task_id,archiveId:receipt.archive_id,requestId:receipt.request_id,storageVersionId:receipt.storage_version_id,fileSha256:receipt.file_sha256,specSha256:receipt.spec_sha256,artifactId:current.artifact?.artifact.id??null,nextStep:current.state,advanceTool:'studio_generated_followup_advance',serverOwnsOperationIds:true,contentInspected:false,canGenerate:false,canTransfer:false,canApprove:false};
}
export async function assertGeneratedFollowupTool(db:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const receipt=await ownRow(db,agent.company_id,run.id);if(!receipt)return;
 const p=await policyAuthority(db,agent.company_id,receipt);await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[agent.company_id,receipt.project_id]);
 const current=await evidence(db,agent.company_id,receipt.project_id,receipt.work_item_id,receipt.archive_id,receipt);
 const allowed=(name==='studio_generated_followup_advance'&&args.projectId===receipt.project_id&&args.workItemId===receipt.work_item_id)
  ||(name==='studio_get'&&args.contractVersion===2&&args.projectId===receipt.project_id&&((args.workItemId===receipt.work_item_id&&!args.artifactId)||(current.artifact&&args.artifactId===current.artifact.artifact.id&&!args.workItemId)))
  ||(name==='higgsfield_requests_list'&&args.projectId===receipt.project_id&&args.requestId===receipt.request_id)
  ||(name==='higgsfield_archive_get'&&args.archiveId===receipt.archive_id)
  ||(name==='studio_generated_followups_get'&&args.projectId===receipt.project_id&&args.archiveId===receipt.archive_id&&!args.after&&!args.historyAfter);
 if(!allowed)fail(403,'This continuation may only read its pinned evidence or advance its server-owned claim, registration and submission steps.','GENERATED_FOLLOWUP_SCOPE');
 await deadline(db,agent.company_id,run,p.expiresAt);
}
function publicReceipt(receipt:Row){return {projectId:receipt.project_id,workItemId:receipt.work_item_id,taskId:receipt.task_id,sourceChildRunId:receipt.source_child_run_id,parentRunId:receipt.parent_run_id,childRunId:receipt.child_run_id,specialistAgentId:receipt.specialist_agent_id,archiveId:receipt.archive_id,requestId:receipt.request_id,storageVersionId:receipt.storage_version_id,specSha256:receipt.spec_sha256,fileSha256:receipt.file_sha256,artifactId:receipt.artifact_id,policyRevision:receipt.policy_revision,createdAt:new Date(receipt.created_at).toISOString(),status:receipt.status};}
export async function studioGeneratedFollowupSnapshot(db:PoolClient,companyId:string,input:unknown){
 const data=studioGeneratedFollowupGetInput.parse(input),project=(await db.query('SELECT contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,data.projectId])).rows[0];if(!project)fail(404,'Studio project not found.');if(project.contract_version!==2)fail(409,'This workflow requires a generated-media project.','STUDIO_CONTRACT_UNSUPPORTED');
 const rows=(await db.query(`SELECT a.id,a.work_item_id FROM (SELECT a.id,q.work_item_id FROM higgsfield_output_archives a JOIN higgsfield_requests q ON q.company_id=a.company_id AND q.project_id=a.project_id AND q.id=a.request_id WHERE a.company_id=$1 AND a.project_id=$2 AND a.status='verified' AND ($3::uuid IS NULL OR a.id=$3) AND ($4::uuid IS NULL OR a.id>$4) ORDER BY a.id LIMIT $5) a`,[companyId,data.projectId,data.archiveId??null,data.after??null,data.limit+1])).rows;
 const policy=await studioCoordinationPolicyRow(db,companyId,data.projectId),policyState=policy?await studioCoordinationStatus(db,companyId,policy):null;const candidates=[];
 for(const row of rows.slice(0,data.limit)){
  const prior=(await db.query('SELECT f.*,r.status FROM studio_generated_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.project_id=$2 AND f.archive_id=$3',[companyId,data.projectId,row.id])).rows[0];
  let blocker:string|null=null;try{const e=await evidence(db,companyId,data.projectId,row.work_item_id,row.id,prior);if(!policy?.generatedContinuations)blocker='An administrator must explicitly enable generated continuations.';else if(!policyState||!['active','exhausted'].includes(policyState.effectiveStatus)||!prior&&policy.runsStarted>=policy.maxRuns)blocker=policyState?.blocker??'Coordination is unavailable.';else if(!policy.allowedRoleKeys.includes(e.work.role_key))blocker='This specialist role is outside the approved policy.';candidates.push({archiveId:row.id,workItemId:row.work_item_id,taskId:e.work.task_id,sourceChildRunId:e.work.source_child_run_id,artifactId:e.artifact?.artifact.id??null,eligible:!prior&&!blocker,blocker,continuation:prior?publicReceipt(prior):null});}
  catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;candidates.push({archiveId:row.id,workItemId:row.work_item_id,eligible:false,blocker:error.message,continuation:prior?publicReceipt(prior):null});}
 }
 const history=(await db.query(`SELECT f.*,r.status FROM studio_generated_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.project_id=$2 AND ($3::uuid IS NULL OR f.archive_id=$3) AND ($4::uuid IS NULL OR f.child_run_id>$4) ORDER BY f.child_run_id LIMIT $5`,[companyId,data.projectId,data.archiveId??null,data.historyAfter??null,data.limit+1])).rows;
 return {candidates,history:history.slice(0,data.limit).map(publicReceipt),historyHasMore:history.length>data.limit,historyNextAfter:history.length>data.limit?history[data.limit-1].child_run_id:null,hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?rows[data.limit-1].id:null,requiresExplicitPolicy:true,automaticProviderActions:false,contentInspected:false};
}
export async function dispatchStudioGeneratedFollowup(db:PoolClient,agent:Row,run:Row,input:unknown){
 const data=studioGeneratedFollowupDispatchInput.parse(input),companyId=agent.company_id;
 if((await db.query('SELECT child_run_id FROM studio_coordination_dispatches WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT child_run_id FROM studio_coordination_followups WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT child_run_id FROM studio_generated_followups WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT reviewer_run_id FROM studio_planning_reviews WHERE company_id=$1 AND reviewer_run_id=$2',[companyId,run.id])).rowCount)fail(403,'A delegated specialist cannot start another run.','COORDINATION_NESTED_DISPATCH');
 const preview=await studioCoordinationPolicyRow(db,companyId,data.projectId);if(!preview||preview.coordinatorAgentId!==agent.id)fail(403,'Only the approved coordinator may resume this generation.','COORDINATION_AGENT_REQUIRED');
 await db.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[companyId,preview.approvedBy]);await studioCoordinationConfiguration(db,companyId,preview.coordinatorAgentId,preview.allowedRoleKeys,true);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-coordination:${companyId}:${data.projectId}`]);const policy=await studioCoordinationPolicyRow(db,companyId,data.projectId,'update');
 if(!policy||!policy.generatedContinuations||policy.revision!==data.policyRevision||policy.coordinatorAgentId!==agent.id)fail(409,'Review the explicit generated-continuation policy before dispatch.','COORDINATION_REVISION_CONFLICT');
 if(run.requested_by!==policy.approvedBy)fail(403,'The coordinator mission must be requested by the administrator who approved this policy.','COORDINATION_REQUESTER_REQUIRED');
 const active=await studioCoordinationStatus(db,companyId,policy);if(!['active','exhausted'].includes(active.effectiveStatus))unavailable();
 const existing=(await db.query('SELECT f.*,r.status FROM studio_generated_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.project_id=$2 AND f.work_item_id=$3',[companyId,data.projectId,data.workItemId])).rows[0];
 if(existing){if(existing.archive_id!==data.archiveId||existing.policy_revision!==policy.revision)changed();await policyAuthority(db,companyId,existing);await evidence(db,companyId,data.projectId,data.workItemId,data.archiveId,existing);await deadline(db,companyId,run,policy.expiresAt);return {continuation:publicReceipt(existing),replayed:true};}
 if(policy.runsStarted>=policy.maxRuns)fail(409,'The approved lifetime specialist run limit is exhausted.','COORDINATION_RUN_BUDGET');
 const count=Number((await db.query("SELECT count(*) FROM (SELECT company_id,project_id,child_run_id FROM studio_coordination_dispatches UNION ALL SELECT company_id,project_id,child_run_id FROM studio_coordination_followups UNION ALL SELECT company_id,project_id,child_run_id FROM studio_generated_followups) d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.child_run_id WHERE d.company_id=$1 AND d.project_id=$2 AND r.status IN ('queued','running')",[companyId,data.projectId])).rows[0].count);if(count>=policy.maxConcurrentRuns)fail(409,'The approved specialist concurrency limit is reached.','COORDINATION_CONCURRENCY');
 const work=await taskEvidence(db,companyId,data.projectId,data.workItemId);if(!work||!policy.allowedRoleKeys.includes(work.role_key)||work.specialist_agent_id===agent.id)unavailable();
 const user=(await db.query('SELECT id,name,email FROM users WHERE id=$1',[policy.approvedBy])).rows[0],member={companyId,userId:policy.approvedBy,role:'admin',user} as Membership;
 const prompt=`Continue as the assigned ${work.role_key} specialist for project ${data.projectId}, work ${data.workItemId}, task ${work.task_id}. This run resumes only a verified archived output; it is not a new generation. Read your generatedFollowup run context and studio_get with contractVersion:2, projectId and this workItemId. Read the exact source metadata if needed. Use studio_generated_followup_advance with this projectId/workItemId and nextStep in order: claim, register if required, submit. Coatria supplies canonical operation IDs, current guarded revisions and fixed source metadata; your harness transport IDs may differ. Reuse a pinned existing artifact when registration is skipped. Never generate, transfer files, request download tickets, create or edit tasks, delegate, approve, or claim you inspected pixels. After actual task submission, report the committed artifact/task IDs and stop for independent human review. If authority or source checks fail, stop for reconciliation; do not request another run.`;
 const queued=await createAgentRunInTransaction(db,member,'commons',{clientId:randomUUID(),agentId:work.specialist_agent_id,prompt});
 if(required.some(cap=>!queued.run.capabilities.includes(cap)))fail(409,'The specialist needs explicitly approved generated-media and storage-read capabilities.','STUDIO_AGENT_CAPABILITIES');
 await lockedStudioProject(db,companyId,data.projectId,data.projectRevision);
 const current=await evidence(db,companyId,data.projectId,data.workItemId,data.archiveId);
 if(current.work.specialist_agent_id!==work.specialist_agent_id||!policy.allowedRoleKeys.includes(current.work.role_key))changed();
 await db.query('UPDATE agent_runs SET max_attempts=1,capabilities=$3 WHERE company_id=$1 AND id=$2',[companyId,queued.run.id,JSON.stringify(required)]);
 const receipt={company_id:companyId,project_id:data.projectId,work_item_id:data.workItemId,task_id:current.work.task_id,source_child_run_id:current.work.source_child_run_id,parent_run_id:run.id,child_run_id:queued.run.id,coordinator_agent_id:agent.id,specialist_agent_id:work.specialist_agent_id,policy_revision:policy.revision,approved_by:policy.approvedBy,archive_id:data.archiveId,request_id:current.exact.requestId,job_id:current.exact.jobId,output_id:current.exact.outputId,storage_version_id:current.exact.storageVersionId,spec_sha256:current.exact.specSha256,file_sha256:current.exact.file.sha256,file_bytes:current.exact.file.bytes,source_snapshot:current.exact,source_sha256:digest(current.exact),initial_task_revision:current.work.task_revision,artifact_id:current.artifact?.artifact.id??null,artifact_sha256:current.artifact?.manifestSha256??null,claim_request_id:randomUUID(),registration_request_id:randomUUID(),submission_request_id:randomUUID(),registration_name:`Verified ${current.exact.source.kind} · ${current.exact.outputId}`.slice(0,160),registration_notes:'Registered from the exact archived output by its bounded specialist continuation. Independent media review is still required.'};
 const keys=Object.keys(receipt);await db.query(`INSERT INTO studio_generated_followups(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(receipt).map(value=>value&&typeof value==='object'?JSON.stringify(value):value));
 await db.query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[companyId,data.projectId,data.workItemId,queued.run.id]);
 await db.query('UPDATE studio_coordination_policies SET runs_started=runs_started+1 WHERE company_id=$1 AND project_id=$2',[companyId,data.projectId]);await bumpStudioProject(db,companyId,data.projectId);
 await db.query("INSERT INTO activity(company_id,kind,description) VALUES($1,'studio.generated_followup_dispatched',$2)",[companyId,'A coordinator queued one source-bound specialist continuation. It cannot generate, transfer, approve or delegate.']);
 await deadline(db,companyId,run,policy.expiresAt);const saved=(await db.query('SELECT f.*,r.status FROM studio_generated_followups f JOIN agent_runs r ON r.company_id=f.company_id AND r.id=f.child_run_id WHERE f.company_id=$1 AND f.child_run_id=$2',[companyId,queued.run.id])).rows[0];return {continuation:publicReceipt(saved),replayed:false};
}
export async function advanceStudioGeneratedFollowup(db:PoolClient,agent:Row,run:Row,requesterRole:string,input:unknown){
 const data=studioGeneratedFollowupAdvanceInput.parse(input),companyId=agent.company_id,receipt=await ownRow(db,companyId,run.id);
 if(!receipt||receipt.specialist_agent_id!==agent.id||receipt.project_id!==data.projectId||receipt.work_item_id!==data.workItemId||receipt.approved_by!==run.requested_by||!['owner','admin'].includes(requesterRole))fail(403,'This run does not own the pinned generated continuation.','GENERATED_FOLLOWUP_SCOPE');
 const policy=await policyAuthority(db,companyId,receipt);const project=await lockedStudioProject(db,companyId,data.projectId);
 const current=await evidence(db,companyId,data.projectId,data.workItemId,receipt.archive_id,receipt),prior=receiptFor(current.steps,receipt,data.step);
 if(prior){await deadline(db,companyId,run,policy.expiresAt);return {step:data.step,...prior.response,replayed:true};}
 if(data.step==='register'&&receipt.artifact_id){await deadline(db,companyId,run,policy.expiresAt);return {step:'register',artifact:current.artifact!.artifact,reused:true,replayed:true};}
 if(current.state!==data.step)fail(409,`The next committed step is ${current.state}. Read the run context and continue that step.`, 'GENERATED_FOLLOWUP_STEP');
 await deadline(db,companyId,run,policy.expiresAt);let result:Row;
 if(data.step==='register'){
  const {registerStudioGeneratedArtifact}=await import('./studio-generated-artifacts');result=await registerStudioGeneratedArtifact(db,{companyId,userId:run.requested_by,agentId:agent.id,runId:run.id,agentSponsorId:agent.created_by},data.projectId,{clientId:receipt.registration_request_id,revision:project.revision,workItemId:data.workItemId,archiveId:receipt.archive_id,name:receipt.registration_name,notes:receipt.registration_notes});
 }else{
  const taskArgs=data.step==='claim'?{taskId:receipt.task_id,revision:receipt.initial_task_revision}:{taskId:receipt.task_id,revision:receipt.initial_task_revision+1,summary:`Registered verified generated artifact ${current.artifact!.artifact.id}; file SHA-256 ${receipt.file_sha256}; storage version ${receipt.storage_version_id}. Submitted for independent human inspection; this run did not perform creative or technical QC.`,tokensUsed:0};
  const task=await executeAgentTaskAction(db,agent,run,requesterRole,data.step==='claim'?'tasks_claim':'tasks_submit',taskArgs);result={task};
  await db.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[companyId,'agent:'+agent.id,stepId(receipt,data.step),stepHash(receipt,data.step),JSON.stringify(result)]);
 }
 await evidence(db,companyId,data.projectId,data.workItemId,receipt.archive_id,receipt);await deadline(db,companyId,run,policy.expiresAt);return {step:data.step,...result,replayed:false};
}
export async function studioGeneratedFollowupRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='projects'||parts.length!==6||parts[5]!=='generated-followups'||method!=='GET')return null;
 const member=await requireMembership(request,id(parts[1])),query=new URL(request.url).searchParams;
 const input=studioGeneratedFollowupGetInput.parse({projectId:id(parts[4]),archiveId:query.get('archiveId')??undefined,after:query.get('after')??undefined,historyAfter:query.get('historyAfter')??undefined,limit:query.has('limit')?Number(query.get('limit')):undefined});
 return json(await memberMutation(member,false,db=>studioGeneratedFollowupSnapshot(db,member.companyId,input)));
}
