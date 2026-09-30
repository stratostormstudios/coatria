import {HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES,type HiggsfieldReferenceCoordinationAuthority} from './higgsfield-references-protocol';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {ApiError,body,fail,id,json} from './security';
import {managedAgentAuthoritySql,managedAgentAuthorityPrincipals} from './studio-hosting';
import {dispatchWork} from './studio';
import {assertGeneratedWorkCurrent} from './studio-generated-rounds';
import {availableRenderFollowups,renderFollowupEvidence} from './studio-render-followups';
import {studioCoordinationInput,studioWorkDispatchInput,type StudioCoordinationSnapshot,type StudioCoordinationPolicy} from './studio-coordination-protocol';

type Row=Record<string,any>;
const columns=`reference_preparation_profile AS "referencePreparationProfile",coordinator_generation AS "coordinatorGeneration",generated_continuations AS "generatedContinuations",project_id AS "projectId",coordinator_agent_id AS "coordinatorAgentId",allowed_role_keys AS "allowedRoleKeys",status,revision,max_runs AS "maxRuns",runs_started AS "runsStarted",max_concurrent_runs AS "maxConcurrentRuns",approved_by AS "approvedBy",expires_at AS "expiresAt",updated_at AS "updatedAt",profile_revision AS "profileRevision",authority_snapshot AS "authoritySnapshot"`;
const canon=(value:unknown):string=>Array.isArray(value)?'['+value.map(canon).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canon(item)).join(',')+'}':JSON.stringify(value);
const uuidFor=(text:string)=>{const b=createHash('sha256').update(text).digest().subarray(0,16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
async function policyRow(client:PoolClient,companyId:string,projectId:string,lock:false|'update'|'share'=false){return (await client.query(`SELECT ${columns} FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2${lock?' FOR '+lock.toUpperCase():''}`,[companyId,projectId])).rows[0] as Row|undefined;}
// A separate statement samples time after the caller's lock waits. Putting a
// clock expression in SELECT ... FOR UPDATE can evaluate it before acquiring
// the row lock. No host clock or additional authority-row locks are used here.
async function approvalClock(client:PoolClient,expiresAt:string|Date){return (await client.query<{live:boolean;within_window:boolean}>(`WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT $1::timestamptz>at AS live,$1::timestamptz<=at+interval '24 hours' AS within_window FROM moment`,[expiresAt])).rows[0];}
async function requireApprovalWindow(client:PoolClient,expiresAt:string){const time=await approvalClock(client,expiresAt);if(!time.live||!time.within_window)fail(400,'Approval must expire within the next 24 hours.');}
async function requireApprovalLive(client:PoolClient,expiresAt:string|Date){if(!(await approvalClock(client,expiresAt)).live)fail(409,'Administrator approval expired.','COORDINATION_UNAVAILABLE');}
async function configuration(client:PoolClient,companyId:string,coordinatorAgentId:string,roleKeys:string[],lock=false){
 const roles=(await client.query('SELECT role_key AS "roleKey",agent_id AS "agentId" FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key',[companyId])).rows;
 if(!roles.some(r=>['producer','coordinator'].includes(r.roleKey)&&r.agentId===coordinatorAgentId))fail(409,'Assign the coordinator to the producer or coordinator role.','COORDINATION_ROLE_CHANGED');
 const selected=roleKeys.slice().sort().map(roleKey=>roles.find(r=>r.roleKey===roleKey));if(selected.some(r=>!r?.agentId))fail(409,'Every allowed specialist role must have an assigned agent.','COORDINATION_ROLE_CHANGED');
 const ids=[...new Set([coordinatorAgentId,...selected.map(r=>r!.agentId)])].sort();
 if(lock){
  const previews=(await client.query('SELECT id,created_by FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[companyId,ids])).rows;
  const principals:string[]=[];for(const agent of previews)principals.push(agent.created_by,...await managedAgentAuthorityPrincipals(client,companyId,agent.id));
  await client.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[companyId,[...new Set(principals)].sort()]);
 }
 const agents=(await client.query(`SELECT a.id AS "agentId",a.created_by AS "sponsorId",a.status,a.capabilities,a.invocation_access AS "invocationAccess",p.id AS "installationId",p.revision AS "installationRevision",a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=a.company_id AND m.user_id=a.created_by AND m.role IN ('owner','admin')) AS live FROM agents a JOIN plugin_installations p ON p.company_id=a.company_id AND p.agent_id=a.id WHERE a.company_id=$1 AND a.id=ANY($2::uuid[]) ORDER BY a.id${lock?' FOR SHARE OF a,p':''}`,[companyId,ids])).rows;
 if(agents.length!==ids.length||agents.some(a=>a.status!=='active'||!a.live||a.invocationAccess==='none'||['studio.read','studio.write','tasks.write'].some(cap=>!a.capabilities.includes(cap))))fail(409,'An approved plugin agent, credential, sponsor or studio grant is unavailable.','COORDINATION_AGENT_UNAVAILABLE');
 const profile=(await client.query('SELECT revision FROM studio_profiles WHERE company_id=$1',[companyId])).rows[0];if(!profile)fail(409,'Studio setup is required.');
 return {profileRevision:profile.revision,bindings:selected.map(r=>({roleKey:r!.roleKey,agentId:r!.agentId})),agents:agents.map(a=>({agentId:a.agentId,sponsorId:a.sponsorId,installationId:a.installationId,installationRevision:a.installationRevision}))};
}
async function referenceSpecialists(client:PoolClient,companyId:string,projectId:string,coordinatorId:string,roleKeys:string[]){
 const specialists=(await client.query(`SELECT DISTINCT b.agent_id,a.capabilities FROM studio_work_items w
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN agents a ON a.company_id=b.company_id AND a.id=b.agent_id
  WHERE w.company_id=$1 AND w.project_id=$2 AND w.stage='references' AND w.execution='agent' AND w.role_key=ANY($3::text[])`,[companyId,projectId,roleKeys])).rows;
 if(!specialists.length||specialists.some(a=>a.agent_id===coordinatorId||HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES.some(cap=>!a.capabilities.includes(cap))))fail(409,'Select a separate reference specialist with existing studio, task, creative-read and storage-read grants.','COORDINATION_REFERENCE_CAPABILITIES');
}
/** Current prepared-reference delegation authority, including after successful
 * child completion. Deliberately does not use terminal receipt replay rules. */
export async function referenceCoordinationAuthority(client:PoolClient,companyId:string,projectId:string,workItemId:string,childRunId:string,pinned?:HiggsfieldReferenceCoordinationAuthority):Promise<HiggsfieldReferenceCoordinationAuthority>{
 const ended=():never=>fail(409,'The exact coordination approval for prepared-reference inspection ended.','HIGGSFIELD_REFERENCE_COORDINATION_AUTHORITY_ENDED');
 const p=await policyRow(client,companyId,projectId,'share');
 if(!p||p.referencePreparationProfile!=='prepared_image_v1')return ended();
 await client.query('SELECT revision FROM studio_profiles WHERE company_id=$1 FOR SHARE',[companyId]);
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[companyId]);
 const d=(await client.query(`SELECT d.*,a.created_by,a.token_hash,a.status AS agent_status,a.expires_at AS agent_expires_at,
  ${managedAgentAuthoritySql('a')} AS managed_live,a.invocation_access,
  i.id AS installation_id,i.revision AS installation_revision,
  parent.requested_by,parent.status AS parent_status,parent.attempts AS parent_attempts,parent.started_at AS parent_started_at,
  parent.finished_at,parent.result_message_id,parent.lease_token_hash,parent.lease_expires_at,
  child.requested_by AS child_requester,w.role_key,w.stage,w.execution,project.contract_version
  FROM studio_coordination_dispatches d JOIN agents a ON a.company_id=d.company_id AND a.id=d.coordinator_agent_id
  JOIN plugin_installations i ON i.company_id=a.company_id AND i.agent_id=a.id
  JOIN agent_runs parent ON parent.company_id=d.company_id AND parent.id=d.parent_run_id
  JOIN agent_runs child ON child.company_id=d.company_id AND child.id=d.child_run_id
  JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id
  JOIN studio_projects project ON project.company_id=d.company_id AND project.id=d.project_id
  WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND d.child_run_id=$4 FOR SHARE OF a,i,parent,child`,[companyId,projectId,workItemId,childRunId])).rows[0];
 if(!d||d.coordinator_agent_id===d.specialist_agent_id||d.policy_revision!==p.revision||d.coordinator_agent_id!==p.coordinatorAgentId||d.requested_by!==p.approvedBy||d.child_requester!==p.approvedBy||d.stage!=='references'||d.execution!=='agent'||d.contract_version!==2||!p.allowedRoleKeys.includes(d.role_key)||d.agent_status!=='active'||d.managed_live!==true||d.invocation_access==='none'||!d.parent_started_at)ended();
 const principals=[...new Set([p.approvedBy,d.created_by,...await managedAgentAuthorityPrincipals(client,companyId,d.coordinator_agent_id)])].sort();
 if((await client.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE",[companyId,principals])).rowCount!==principals.length)ended();
 const state=await status(client,companyId,p);if(!['active','exhausted'].includes(state.effectiveStatus))ended();
 const authority:HiggsfieldReferenceCoordinationAuthority={version:1,parentRunId:d.parent_run_id,parentAttempt:d.parent_attempts,parentStartedAt:new Date(d.parent_started_at).toISOString(),coordinatorAgentId:d.coordinator_agent_id,coordinatorSponsorId:d.created_by,coordinatorCredentialSha256:d.token_hash,coordinatorInstallation:{id:d.installation_id,revision:d.installation_revision},policyRevision:p.revision,approvedBy:p.approvedBy,expiresAt:new Date(p.expiresAt).toISOString(),authoritySha256:createHash('sha256').update(canon(p.authoritySnapshot)).digest('hex')};
 if(pinned&&canon(authority)!==canon(pinned))ended();
 if(d.parent_status==='succeeded'){
  if(!d.finished_at||!d.result_message_id||!(await client.query("SELECT 1 FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2 AND kind='complete' AND response#>>'{run,id}'=$2::text AND response#>>'{run,status}'='succeeded' LIMIT 1",[companyId,d.parent_run_id])).rowCount)ended();
 }else if(d.parent_status!=='running'||!d.lease_token_hash)ended();
 const clock=(await client.query(`WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
  SELECT $1::timestamptz>at AS policy_live,$2::timestamptz>at AS agent_live,
  $3::text='succeeded' OR ($4::timestamptz>at AND $5::timestamptz>at-interval '30 minutes') AS parent_live FROM moment`,[p.expiresAt,d.agent_expires_at,d.parent_status,d.lease_expires_at,d.parent_started_at])).rows[0];
 if(!clock.policy_live||!clock.agent_live||!clock.parent_live)ended();return authority;
}
async function status(client:PoolClient,companyId:string,p:Row):Promise<{effectiveStatus:StudioCoordinationPolicy['effectiveStatus'];blocker:string|null}>{
 if(p.status!=='active')return {effectiveStatus:'paused',blocker:'Coordination is paused.'};
 if(!(await approvalClock(client,p.expiresAt)).live)return {effectiveStatus:'expired',blocker:'Administrator approval expired.'};
 if(!(await client.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin')",[companyId,p.approvedBy])).rowCount)return {effectiveStatus:'approval_required',blocker:'The approving administrator no longer has authority.'};
 try{const now=await configuration(client,companyId,p.coordinatorAgentId,p.allowedRoleKeys);const {generatedRound:approvedRound,...approvedConfiguration}=p.authoritySnapshot;const currentRound=(await client.query('SELECT id,plan_sha256 FROM studio_generated_revision_rounds WHERE company_id=$1 AND project_id=$2 ORDER BY number DESC LIMIT 1',[companyId,p.projectId])).rows[0];if(canon(currentRound?{roundId:currentRound.id,planSha256:currentRound.plan_sha256}:null)!==canon(approvedRound??null))return {effectiveStatus:'approval_required',blocker:'The production round changed. Review and save a new coordination approval.'};if(canon(now)!==canon(approvedConfiguration))return {effectiveStatus:'approval_required',blocker:'Role assignments or plugin settings changed. Review and save a new approval.'};}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;return {effectiveStatus:'approval_required',blocker:'An approved role, plugin agent, credential, or sponsor is unavailable.'};}
 if(!(await approvalClock(client,p.expiresAt)).live)return {effectiveStatus:'expired',blocker:'Administrator approval expired.'};
 if(p.runsStarted>=p.maxRuns)return {effectiveStatus:'exhausted',blocker:'The approved lifetime specialist run limit is exhausted.'};
 return {effectiveStatus:'active',blocker:null};
}
export async function studioCoordinationSnapshot(client:PoolClient,companyId:string,projectId:string):Promise<StudioCoordinationSnapshot>{
 if(!(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rowCount)fail(404,'Studio project not found.');
 const p=await policyRow(client,companyId,projectId);let policy:StudioCoordinationPolicy|null=null;
 if(p){const {authoritySnapshot:_,coordinatorGeneration,referencePreparationProfile,...fields}=p;policy={...fields,...referencePreparationProfile?{referencePreparationProfile}:{},...coordinatorGeneration?{coordinatorGeneration:true}:{},...await status(client,companyId,p),remainingRuns:Math.max(0,p.maxRuns-p.runsStarted),expiresAt:new Date(p.expiresAt).toISOString(),updatedAt:new Date(p.updatedAt).toISOString()} as StudioCoordinationPolicy;}
 const dispatches=(await client.query('SELECT d.archive_id AS "archiveId",d.execution_job_id AS "executionJobId",d.source_child_run_id AS "sourceChildRunId",d.artifact_id AS "artifactId",d.work_item_id AS "workItemId",d.parent_run_id AS "parentRunId",d.child_run_id AS "childRunId",d.coordinator_agent_id AS "coordinatorAgentId",d.specialist_agent_id AS "specialistAgentId",d.policy_revision AS "policyRevision",d.created_at AS "createdAt",r.status FROM (SELECT company_id,project_id,work_item_id,parent_run_id,child_run_id,coordinator_agent_id,specialist_agent_id,policy_revision,created_at,NULL::uuid AS execution_job_id,NULL::uuid AS source_child_run_id,NULL::uuid AS artifact_id,NULL::uuid AS archive_id FROM studio_coordination_dispatches UNION ALL SELECT company_id,project_id,work_item_id,parent_run_id,child_run_id,coordinator_agent_id,specialist_agent_id,policy_revision,created_at,execution_job_id,source_child_run_id,artifact_id,NULL::uuid FROM studio_coordination_followups UNION ALL SELECT company_id,project_id,work_item_id,parent_run_id,child_run_id,coordinator_agent_id,specialist_agent_id,policy_revision,created_at,NULL::uuid,source_child_run_id,artifact_id,archive_id FROM studio_generated_followups) d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.child_run_id WHERE d.company_id=$1 AND d.project_id=$2 ORDER BY d.created_at DESC,d.child_run_id DESC LIMIT 100',[companyId,projectId])).rows;
 return {policy,renderFollowups:await availableRenderFollowups(client,companyId,projectId),dispatches:dispatches.map(d=>({...d,createdAt:new Date(d.createdAt).toISOString()})) as any,budgetUnit:'specialist_runs',budgetScope:'coordinator_dispatched_runs_only',startsWorkers:false,startsInference:false};
}
export async function saveStudioCoordination(client:PoolClient,member:Membership,projectId:string,input:unknown){
 const data=studioCoordinationInput.parse(input),expires=Date.parse(data.expiresAt);
 const requestHash=createHash('sha256').update(canon({projectId,...data})).digest('hex');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-request:${member.companyId}:human:${member.userId}:${data.clientId}`]);
 const prior=(await client.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[member.companyId,'human:'+member.userId,data.clientId])).rows[0];
 if(prior){if(prior.request_hash!==requestHash)fail(409,'This request ID belongs to another operation.','IDEMPOTENCY_CONFLICT');return {...prior.response,replayed:true};}
 const oldPreview=await policyRow(client,member.companyId,projectId);
 const exactPause=oldPreview&&(!data.referencePreparationProfile||data.referencePreparationProfile===oldPreview.referencePreparationProfile)&&(!data.coordinatorGeneration||Boolean(oldPreview.coordinatorGeneration))&&(!data.generatedContinuations||Boolean(oldPreview.generatedContinuations))&&data.status==='paused'&&data.coordinatorAgentId===oldPreview.coordinatorAgentId&&canon(data.allowedRoleKeys.slice().sort())===canon(oldPreview.allowedRoleKeys)&&data.maxRuns===oldPreview.maxRuns&&data.maxConcurrentRuns===oldPreview.maxConcurrentRuns&&expires===+new Date(oldPreview.expiresAt);
 // A kill switch never requires reactivating a revoked agent or expired host.
 const configurationSnapshot=exactPause?oldPreview!.authoritySnapshot:await configuration(client,member.companyId,data.coordinatorAgentId,data.allowedRoleKeys,true);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-coordination:${member.companyId}:${projectId}`]);
 const old=await policyRow(client,member.companyId,projectId,'update');if((old?.revision??0)!==data.revision)fail(409,'The coordination policy changed. Refresh before saving.','COORDINATION_REVISION_CONFLICT');
 const project=(await client.query('SELECT status,contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[member.companyId,projectId])).rows[0];if(!project)fail(404,'Studio project not found.');if((data.generatedContinuations||data.coordinatorGeneration||data.referencePreparationProfile)&&project.contract_version!==2)fail(409,'Generated continuations require a generated-media project.','STUDIO_CONTRACT_UNSUPPORTED');if(project.status==='delivered'&&!exactPause)fail(409,'Delivered projects cannot start coordination.');
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[member.companyId]);
 if(!exactPause&&canon(configurationSnapshot)!==canon(await configuration(client,member.companyId,data.coordinatorAgentId,data.allowedRoleKeys)))fail(409,'The company structure changed. Review it again.','COORDINATION_ROLE_CHANGED');
 if(!exactPause){const currentRound=(await client.query('SELECT id,plan_sha256 FROM studio_generated_revision_rounds WHERE company_id=$1 AND project_id=$2 ORDER BY number DESC LIMIT 1',[member.companyId,projectId])).rows[0];if(currentRound)Object.assign(configurationSnapshot,{generatedRound:{roundId:currentRound.id,planSha256:currentRound.plan_sha256}});await requireApprovalWindow(client,data.expiresAt);}
 if(data.referencePreparationProfile&&!exactPause)await referenceSpecialists(client,member.companyId,projectId,data.coordinatorAgentId,data.allowedRoleKeys);
 if(data.maxRuns<(old?.runsStarted??0))fail(409,'The lifetime run limit cannot be below the runs already started.','COORDINATION_BUDGET_USED');
 await client.query(`INSERT INTO studio_coordination_policies(company_id,project_id,coordinator_agent_id,approved_by,status,allowed_role_keys,profile_revision,authority_snapshot,max_runs,max_concurrent_runs,expires_at,generated_continuations,coordinator_generation,reference_preparation_profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(company_id,project_id) DO UPDATE SET coordinator_agent_id=EXCLUDED.coordinator_agent_id,approved_by=EXCLUDED.approved_by,status=EXCLUDED.status,allowed_role_keys=EXCLUDED.allowed_role_keys,profile_revision=EXCLUDED.profile_revision,authority_snapshot=EXCLUDED.authority_snapshot,max_runs=EXCLUDED.max_runs,max_concurrent_runs=EXCLUDED.max_concurrent_runs,expires_at=EXCLUDED.expires_at,generated_continuations=EXCLUDED.generated_continuations,coordinator_generation=EXCLUDED.coordinator_generation,reference_preparation_profile=EXCLUDED.reference_preparation_profile,revision=studio_coordination_policies.revision+1,updated_at=clock_timestamp()`,[member.companyId,projectId,data.coordinatorAgentId,member.userId,data.status,JSON.stringify(data.allowedRoleKeys.slice().sort()),configurationSnapshot.profileRevision,JSON.stringify(configurationSnapshot),data.maxRuns,data.maxConcurrentRuns,data.expiresAt,Boolean(data.generatedContinuations),Boolean(data.coordinatorGeneration),data.referencePreparationProfile??null]);
 const result=await studioCoordinationSnapshot(client,member.companyId,projectId);await client.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[member.companyId,'human:'+member.userId,data.clientId,requestHash,JSON.stringify(result)]);
 await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[member.companyId,member.userId,'studio.coordination_approved','An administrator reviewed a finite specialist run limit and exact project coordination policy. This is not a monetary budget.']);
 if(!exactPause)await requireApprovalWindow(client,data.expiresAt);
 return {...result,replayed:false};
}
/** Called only inside the existing authenticated, leased tool transaction. */
export async function dispatchStudioWork(client:PoolClient,agent:Row,run:Row,input:unknown){
 const data=studioWorkDispatchInput.parse(input),companyId=agent.company_id;
 if((await client.query('SELECT child_run_id FROM studio_coordination_dispatches WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT child_run_id FROM studio_coordination_followups WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT child_run_id FROM studio_generated_followups WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT reviewer_run_id FROM studio_planning_reviews WHERE company_id=$1 AND reviewer_run_id=$2',[companyId,run.id])).rowCount)fail(403,'A delegated specialist cannot delegate further work. Use the separately approved coordinator mission.','COORDINATION_NESTED_DISPATCH');
 const preview=await policyRow(client,companyId,data.projectId);if(!preview)fail(404,'Project coordination policy not found.');
 if(preview.coordinatorAgentId!==agent.id)fail(403,'Only the approved coordinator can delegate project work.','COORDINATION_AGENT_REQUIRED');
 await client.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[companyId,preview.approvedBy]);
 await configuration(client,companyId,preview.coordinatorAgentId,preview.allowedRoleKeys,true);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-coordination:${companyId}:${data.projectId}`]);
 const policy=(await policyRow(client,companyId,data.projectId,'update'))!;
 if(policy.revision!==data.policyRevision||policy.coordinatorAgentId!==agent.id)fail(409,'The coordination approval changed. Read it again.','COORDINATION_REVISION_CONFLICT');
 const active=await status(client,companyId,policy);
 if(!['active','exhausted'].includes(active.effectiveStatus))fail(409,active.blocker!,'COORDINATION_UNAVAILABLE');
 const work=(await client.query('SELECT w.role_key,w.stage,w.execution,b.agent_id,p.contract_version FROM studio_work_items w JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3',[companyId,data.projectId,data.workItemId])).rows[0];
 if(!work)fail(404,'Studio work item not found.');
 const prepared=policy.referencePreparationProfile==='prepared_image_v1'&&work.contract_version===2&&work.stage==='references'&&work.execution==='agent'&&!data.executionJobId;
 if(prepared&&run.requested_by!==policy.approvedBy)fail(403,'Prepared references require the current policy approver to sponsor the coordinator request.','COORDINATION_REFERENCE_SPONSOR');
 const ownGeneration=work.agent_id===agent.id;
 if(ownGeneration&&(!policy.coordinatorGeneration||work.contract_version!==2||work.stage!=='generation'||work.execution!=='creative'||data.executionJobId||run.requested_by!==policy.approvedBy))fail(403,'A separate coordinator generation request requires an explicitly reviewed generated-work policy.','COORDINATION_ROLE_REQUIRED');
 if(!policy.allowedRoleKeys.includes(work.role_key)||work.execution==='human')fail(403,'This work is outside the approved specialist handoff.','COORDINATION_ROLE_REQUIRED');
 const existing=(await client.query(`SELECT child_run_id AS "childRunId",parent_run_id AS "parentRunId",work_item_id AS "workItemId" FROM ${data.executionJobId?'studio_coordination_followups':'studio_coordination_dispatches'} WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3${data.executionJobId?' AND execution_job_id=$4':''}`,[companyId,data.projectId,data.workItemId,...data.executionJobId?[data.executionJobId]:[]])).rows[0];
 if(existing){
  // Dispatch receipts remain historical, but cannot authorize obsolete generated
  // work. The coordination lock precedes the project lock, as in round activation.
  const project=(await client.query('SELECT contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,data.projectId])).rows[0];
  if(project?.contract_version===2){await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,data.projectId]);await assertGeneratedWorkCurrent(client,companyId,data.projectId,data.workItemId);}
  const snapshot=await studioCoordinationSnapshot(client,companyId,data.projectId);await requireApprovalLive(client,policy.expiresAt);return {...existing,replayed:true,policy:snapshot.policy};
 }
 if(policy.runsStarted>=policy.maxRuns)fail(409,'The approved lifetime specialist run limit is exhausted.','COORDINATION_RUN_BUDGET');
 if(Number((await client.query("SELECT count(*) FROM (SELECT company_id,project_id,child_run_id FROM studio_coordination_dispatches UNION ALL SELECT company_id,project_id,child_run_id FROM studio_coordination_followups UNION ALL SELECT company_id,project_id,child_run_id FROM studio_generated_followups) d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.child_run_id WHERE d.company_id=$1 AND d.project_id=$2 AND r.status IN ('queued','running')",[companyId,data.projectId])).rows[0].count)>=policy.maxConcurrentRuns)fail(409,'The approved specialist concurrency limit is reached.','COORDINATION_CONCURRENCY');

 const user=(await client.query('SELECT id,name,email,role_title AS "roleTitle",avatar_color AS "avatarColor",avatar_id AS "avatarId",(email_verified_at IS NOT NULL) AS "emailVerified" FROM users WHERE id=$1',[policy.approvedBy])).rows[0];
 const member={companyId,userId:policy.approvedBy,role:'admin',user} as Membership;
 const evidence=data.executionJobId?await renderFollowupEvidence(client,companyId,data.projectId,data.workItemId,data.executionJobId):null;
 const queued=await dispatchWork(client,member,data.projectId,{clientId:uuidFor(`coatria-coordination:${companyId}:${data.projectId}:${data.workItemId}${data.executionJobId?':render:'+data.executionJobId:''}`),revision:data.projectRevision,workItemId:data.workItemId,...prepared?{preparationProfile:'prepared_image_v1'}:{}},prepared?{deferPreparedMarker:true}:{});
 if((await status(client,companyId,policy)).effectiveStatus!=='active')fail(409,'Coordination authority changed before this handoff committed.','COORDINATION_UNAVAILABLE');
 // One attempt: lease expiry and provider failure are terminal, never implicit repeats.
 await client.query('UPDATE agent_runs SET max_attempts=1 WHERE company_id=$1 AND id=$2',[companyId,queued.run.id]);
 if(ownGeneration){
  const required=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];
  if(required.some(cap=>!queued.run.capabilities.includes(cap)))fail(409,'The generation specialist needs explicitly reviewed generated-media grants.','STUDIO_AGENT_CAPABILITIES');
  await client.query('UPDATE agent_runs SET capabilities=$3,prompt=prompt||$4 WHERE company_id=$1 AND id=$2',[companyId,queued.run.id,JSON.stringify(required),' This separate coordinator generation request may only read its assigned work/reference metadata, claim its existing task, and propose exact generation for human approval. Do not act as coordinator, delegate, organize files, register or submit output in this initial request. Stop after the proposal; a separately approved verified-output continuation handles registration and submission.']);
 }
 if(evidence){
  // The ordinary dispatch already holds this project lock. Re-read after it to
  // exclude a concurrent human version change between preview and run creation.
  const exact=await renderFollowupEvidence(client,companyId,data.projectId,data.workItemId,data.executionJobId!,queued.run.id);
  if(canon(exact)!==canon(evidence))fail(409,'The rendered artifact changed during dispatch.','COORDINATION_RENDER_CHANGED');
  const prompt=`Continue only the recorded render handoff for project ${data.projectId}, work item ${data.workItemId}, task ${evidence.taskId}. This is not a new production or render request. Read studio_get with projectId and workItemId, then studio_get with projectId and artifactId ${evidence.artifactId}, and studio_execution_get with jobId ${evidence.executionJobId}. The exact human-promoted artifact SHA-256 is ${evidence.artifactSha256}; execution manifest SHA-256 is ${evidence.executionManifestSha256}. Inspect the returned metadata and verified storage provenance; these tools do not inspect image pixels, so do not claim creative or technical QC. Reuse this existing artifact: do not register a duplicate, propose another render, create another task, or approve anything. If current gates and authority remain valid, claim only task ${evidence.taskId} at its current revision, then tasks_submit with a factual summary identifying the existing artifact and job for independent human media review. Report the actual submitted state and stop.`;
  await client.query('UPDATE agent_runs SET prompt=$3,capabilities=$4 WHERE company_id=$1 AND id=$2',[companyId,queued.run.id,prompt,JSON.stringify(['studio.read','studio.write','tasks.write'])]);
  await client.query('INSERT INTO studio_coordination_followups(company_id,project_id,work_item_id,execution_job_id,parent_run_id,source_child_run_id,child_run_id,coordinator_agent_id,specialist_agent_id,policy_revision,execution_manifest_sha256,artifact_id,artifact_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[companyId,data.projectId,data.workItemId,evidence.executionJobId,run.id,evidence.sourceChildRunId,queued.run.id,agent.id,work.agent_id,policy.revision,evidence.executionManifestSha256,evidence.artifactId,evidence.artifactSha256]);
 }else await client.query('INSERT INTO studio_coordination_dispatches(company_id,project_id,work_item_id,parent_run_id,child_run_id,coordinator_agent_id,specialist_agent_id,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[companyId,data.projectId,data.workItemId,run.id,queued.run.id,agent.id,work.agent_id,policy.revision]);
 if(prepared){const coordination=await referenceCoordinationAuthority(client,companyId,data.projectId,data.workItemId,queued.run.id);await client.query('INSERT INTO studio_reference_preparation_dispatches(company_id,project_id,work_item_id,run_id,authority_version,coordination) VALUES($1,$2,$3,$4,1,$5)',[companyId,data.projectId,data.workItemId,queued.run.id,JSON.stringify(coordination)]);}
 await client.query('UPDATE studio_coordination_policies SET runs_started=runs_started+1 WHERE company_id=$1 AND project_id=$2',[companyId,data.projectId]);
 const snapshot=await studioCoordinationSnapshot(client,companyId,data.projectId);await requireApprovalLive(client,policy.expiresAt);
 return {workItemId:data.workItemId,parentRunId:run.id,childRunId:queued.run.id,replayed:false,policy:snapshot.policy};
}
/** Exact accepted planning context only. Bound the traversal independently of
 * caller input; shared task locks keep approval stable until the read commits.
 * The existing lifecycle policy lock serializes revision-round activation. */
async function acceptedPlanningAncestor(client:PoolClient,companyId:string,projectId:string,workItemId:string,requestedId:string){
 const {roundId}=await assertGeneratedWorkCurrent(client,companyId,projectId,workItemId);
 const seen=new Set([workItemId]),edges=new Map<string,string[]>();let frontier=[workItemId];
 for(let depth=0;frontier.length;depth++){
  const rows=(await client.query<{work_item_id:string;id:string;stage:string;execution:string;status:string;round_id:string|null}>(`SELECT d.work_item_id,w.id,w.stage,w.execution,t.status,rw.round_id
   FROM studio_dependencies d JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.predecessor_id
   JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
   LEFT JOIN studio_generated_revision_work rw ON rw.company_id=w.company_id AND rw.project_id=w.project_id AND rw.work_item_id=w.id
   WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=ANY($3::uuid[])
   ORDER BY w.id,d.work_item_id LIMIT 101 FOR SHARE OF t`,[companyId,projectId,frontier])).rows;
  if(rows.length>100||depth>=8&&rows.length)return false;
  const next:string[]=[];
  for(const row of rows){
   if(row.status!=='done'||row.execution!=='agent'||!['estimate','breakdown','references'].includes(row.stage)||(row.round_id??null)!==roundId)return false;
   edges.set(row.work_item_id,[...(edges.get(row.work_item_id)??[]),row.id]);
   if(!seen.has(row.id)){seen.add(row.id);next.push(row.id);if(seen.size>100)return false;}
  }
  frontier=next;
 }
 const visiting=new Set<string>(),visited=new Set<string>();
 const acyclic=(node:string):boolean=>{if(visiting.has(node))return false;if(visited.has(node))return true;visiting.add(node);for(const dependency of edges.get(node)??[])if(!acyclic(dependency))return false;visiting.delete(node);visited.add(node);return true;};
 return acyclic(workItemId)&&seen.has(requestedId);
}
/** The aggregate company character does not confer coordinator powers on its
 * separate generation child. Called before even replaying a cached tool receipt. */
export async function coordinatorGenerationRunScope(client:PoolClient,companyId:string,runId:string){
 return (await client.query('SELECT d.project_id,d.work_item_id,w.task_id FROM studio_coordination_dispatches d JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id WHERE d.company_id=$1 AND d.child_run_id=$2 AND d.coordinator_agent_id=d.specialist_agent_id',[companyId,runId])).rows[0] as Row|undefined;
}
// Keep model-visible names tied to the exact predicates enforced below.
const coordinatorGenerationToolRules:Record<string,(args:Row,receipt:Row,client:PoolClient,companyId:string)=>unknown>={
 studio_get:async(args,receipt,client,companyId)=>args.projectId===receipt.project_id&&args.contractVersion===2&&args.workItemId&&!args.artifactId&&!args.after&&(args.workItemId===receipt.work_item_id||await acceptedPlanningAncestor(client,companyId,receipt.project_id,receipt.work_item_id,args.workItemId)),
 higgsfield_connection_get:()=>true,
 higgsfield_requests_list:(args,receipt)=>args.projectId===receipt.project_id,
 higgsfield_jobs_list:(args,receipt)=>args.projectId===receipt.project_id,
 higgsfield_references_list:(args,receipt)=>args.projectId===receipt.project_id,
 tasks_claim:(args,receipt)=>args.taskId===receipt.task_id,
 higgsfield_generation_propose:(args,receipt)=>args.projectId===receipt.project_id&&args.workItemId===receipt.work_item_id,
};
export const coordinatorGenerationToolNames:readonly string[]=Object.freeze(Object.keys(coordinatorGenerationToolRules));
const planningDispatchToolNames:readonly string[]=Object.freeze(['studio_get','tasks_claim','tasks_submit']);
const referenceDispatchToolNames:readonly string[]=Object.freeze([...planningDispatchToolNames,'storage_get','storage_files_list','studio_storage_references_list','infrastructure_list','infrastructure_files','higgsfield_connection_get','higgsfield_requests_list','higgsfield_jobs_list']);
/** Only the immutable administrator-selected marker opts a run into preparation.
 * Its predicates are also enforced before cached tool receipts are replayed. */
export async function studioReferencePreparationRunScope(client:PoolClient,companyId:string,runId:string){
 return (await client.query(`SELECT d.project_id,d.work_item_id,w.task_id FROM studio_reference_preparation_dispatches d
  JOIN studio_dispatches dispatched ON dispatched.company_id=d.company_id AND dispatched.project_id=d.project_id AND dispatched.work_item_id=d.work_item_id AND dispatched.run_id=d.run_id
  JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id
  WHERE d.company_id=$1 AND d.run_id=$2 AND d.authority_version=1`,[companyId,runId])).rows[0] as Row|undefined;
}
const referencePreparationToolRules:Record<string,(args:Row,receipt:Row,client:PoolClient,companyId:string)=>unknown>={
 studio_get:coordinatorGenerationToolRules.studio_get,
 tasks_claim:(args,receipt)=>args.taskId===receipt.task_id,
 tasks_submit:(args,receipt)=>args.taskId===receipt.task_id,
 higgsfield_reference_candidates_list:(args,receipt)=>args.projectId===receipt.project_id,
 higgsfield_reference_propose:(args,receipt)=>args.projectId===receipt.project_id&&args.workItemId===receipt.work_item_id,
 higgsfield_references_list:(args,receipt)=>args.projectId===receipt.project_id,
 higgsfield_connection_get:()=>true,
};
export const referencePreparationToolNames:readonly string[]=Object.freeze(Object.keys(referencePreparationToolRules));
export async function assertStudioReferencePreparationTool(client:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const receipt=await studioReferencePreparationRunScope(client,agent.company_id,run.id);if(!receipt)return;
 if(!Object.hasOwn(referencePreparationToolRules,name)||!await referencePreparationToolRules[name](args,receipt,client,agent.company_id))fail(403,'This prepared-image request may only read its assigned context, reserve and submit its reference task, and propose exact prepared references. It cannot generate, transfer, approve or delegate work.','STUDIO_REFERENCE_PREPARATION_SCOPE');
}
// Ordinary specialists also archive outputs and still need destination storage
// browsing. The separate coordinator-generation child only proposes generation.
const generationDispatchToolNames:readonly string[]=Object.freeze([...coordinatorGenerationToolNames,'storage_get','storage_files_list','higgsfield_archives_list','higgsfield_archive_get','higgsfield_archive_propose','studio_generated_artifact_register','tasks_submit']);
/** Model presentation for an existing assigned task, never an authority grant.
 * Exact server-created dispatch provenance, not prompt text or character role,
 * distinguishes these finite tasks from ordinary company/coordinator missions.
 * Callers must prefer the stricter generated-continuation and own-generation
 * scopes. Legacy creative/render continuations are outside this v2 path. */
export async function studioDispatchInferenceToolNames(client:PoolClient,companyId:string,runId:string):Promise<readonly string[]|null>{
 if(await studioReferencePreparationRunScope(client,companyId,runId))return referencePreparationToolNames;
 const work=(await client.query(`SELECT w.stage,w.execution FROM studio_dispatches d
  JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
  WHERE d.company_id=$1 AND d.run_id=$2 AND p.contract_version=2 AND p.production_path='higgsfield'`,[companyId,runId])).rows[0];
 if(work?.execution==='agent'){
  if(['estimate','breakdown'].includes(work.stage))return planningDispatchToolNames;
  if(work.stage==='references')return referenceDispatchToolNames;
 }
 return work?.stage==='generation'&&work.execution==='creative'?generationDispatchToolNames:null;
}
export async function assertCoordinatorGenerationTool(client:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const receipt=await coordinatorGenerationRunScope(client,agent.company_id,run.id);
 if(!receipt)return;
 const allowed=Object.hasOwn(coordinatorGenerationToolRules,name)&&await coordinatorGenerationToolRules[name](args,receipt,client,agent.company_id);
 if(!allowed)fail(403,'This separate generation request may only read its assigned production context, claim its task and propose generation for human approval. It cannot act as coordinator or transfer, register, submit or approve media.','COORDINATOR_GENERATION_SCOPE');
}
/** Agent/run -> policy. Never hold a project lock across conversation completion. */
export async function coordinationRunAuthority(client:PoolClient,companyId:string,run:Row):Promise<boolean>{
 // Terminal receipts remain replayable after their historical approval expires.
 if(!['queued','running'].includes(run.status))return true;
 const delegation=(await client.query('SELECT project_id,policy_revision,NULL::uuid AS execution_job_id,work_item_id,NULL::uuid AS artifact_id,NULL::text AS execution_manifest_sha256,NULL::text AS artifact_sha256,parent_run_id,coordinator_agent_id=specialist_agent_id AS coordinator_generation FROM studio_coordination_dispatches WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT project_id,policy_revision,execution_job_id,work_item_id,artifact_id,execution_manifest_sha256,artifact_sha256,parent_run_id,false AS coordinator_generation FROM studio_coordination_followups WHERE company_id=$1 AND child_run_id=$2',[companyId,run.id])).rows[0];if(!delegation)return true;
 const policy=await policyRow(client,companyId,delegation.project_id,'share');if(!policy||policy.revision!==delegation.policy_revision)return false;
 const active=await status(client,companyId,policy);if(!['active','exhausted'].includes(active.effectiveStatus))return false;
 const preparation=(await client.query('SELECT coordination FROM studio_reference_preparation_dispatches WHERE company_id=$1 AND run_id=$2',[companyId,run.id])).rows[0];
 if(preparation?.coordination)try{await referenceCoordinationAuthority(client,companyId,delegation.project_id,delegation.work_item_id,run.id,preparation.coordination);}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;return false;}
 if(delegation.coordinator_generation){
  const own=(await client.query("SELECT w.stage,w.execution,p.contract_version,parent.status AS parent_status FROM studio_work_items w JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id JOIN agent_runs parent ON parent.company_id=w.company_id AND parent.id=$4 WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3",[companyId,delegation.project_id,delegation.work_item_id,delegation.parent_run_id])).rows[0];
  if(!policy.coordinatorGeneration||!own||own.contract_version!==2||own.stage!=='generation'||own.execution!=='creative'||own.parent_status!=='succeeded')return false;
 }
 if(delegation.execution_job_id)try{const evidence=await renderFollowupEvidence(client,companyId,delegation.project_id,delegation.work_item_id,delegation.execution_job_id,run.id);if(evidence.artifactId!==delegation.artifact_id||evidence.artifactSha256!==delegation.artifact_sha256||evidence.executionManifestSha256!==delegation.execution_manifest_sha256)return false;}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;return false;}return (await approvalClock(client,policy.expiresAt)).live;
}
export async function studioCoordinationRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='projects'||parts.length!==6||parts[5]!=='coordination'||!['GET','PUT'].includes(method))return null;
 const member=await requireMembership(request,id(parts[1]),method==='PUT'),projectId=id(parts[4]);
 if(method==='GET')return json(await memberMutation(member,false,client=>studioCoordinationSnapshot(client,member.companyId,projectId)));
 const data=await body(request,studioCoordinationInput);return json(await memberMutation(member,true,client=>saveStudioCoordination(client,member,projectId,data)));
}
// Shared authority seams retain the caller's transaction and existing lock order.
export {policyRow as studioCoordinationPolicyRow,configuration as studioCoordinationConfiguration,status as studioCoordinationStatus,requireApprovalLive as requireStudioCoordinationApprovalLive,requireApprovalWindow as requireStudioCoordinationApprovalWindow};
