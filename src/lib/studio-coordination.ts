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
const columns=`coordinator_generation AS "coordinatorGeneration",generated_continuations AS "generatedContinuations",project_id AS "projectId",coordinator_agent_id AS "coordinatorAgentId",allowed_role_keys AS "allowedRoleKeys",status,revision,max_runs AS "maxRuns",runs_started AS "runsStarted",max_concurrent_runs AS "maxConcurrentRuns",approved_by AS "approvedBy",expires_at AS "expiresAt",updated_at AS "updatedAt",profile_revision AS "profileRevision",authority_snapshot AS "authoritySnapshot"`;
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
 if(p){const {authoritySnapshot:_,coordinatorGeneration,...fields}=p;policy={...fields,...coordinatorGeneration?{coordinatorGeneration:true}:{},...await status(client,companyId,p),remainingRuns:Math.max(0,p.maxRuns-p.runsStarted),expiresAt:new Date(p.expiresAt).toISOString(),updatedAt:new Date(p.updatedAt).toISOString()} as StudioCoordinationPolicy;}
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
 const exactPause=oldPreview&&(!data.coordinatorGeneration||Boolean(oldPreview.coordinatorGeneration))&&(!data.generatedContinuations||Boolean(oldPreview.generatedContinuations))&&data.status==='paused'&&data.coordinatorAgentId===oldPreview.coordinatorAgentId&&canon(data.allowedRoleKeys.slice().sort())===canon(oldPreview.allowedRoleKeys)&&data.maxRuns===oldPreview.maxRuns&&data.maxConcurrentRuns===oldPreview.maxConcurrentRuns&&expires===+new Date(oldPreview.expiresAt);
 // A kill switch never requires reactivating a revoked agent or expired host.
 const configurationSnapshot=exactPause?oldPreview!.authoritySnapshot:await configuration(client,member.companyId,data.coordinatorAgentId,data.allowedRoleKeys,true);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-coordination:${member.companyId}:${projectId}`]);
 const old=await policyRow(client,member.companyId,projectId,'update');if((old?.revision??0)!==data.revision)fail(409,'The coordination policy changed. Refresh before saving.','COORDINATION_REVISION_CONFLICT');
 const project=(await client.query('SELECT status,contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[member.companyId,projectId])).rows[0];if(!project)fail(404,'Studio project not found.');if((data.generatedContinuations||data.coordinatorGeneration)&&project.contract_version!==2)fail(409,'Generated continuations require a generated-media project.','STUDIO_CONTRACT_UNSUPPORTED');if(project.status==='delivered'&&!exactPause)fail(409,'Delivered projects cannot start coordination.');
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[member.companyId]);
 if(!exactPause&&canon(configurationSnapshot)!==canon(await configuration(client,member.companyId,data.coordinatorAgentId,data.allowedRoleKeys)))fail(409,'The company structure changed. Review it again.','COORDINATION_ROLE_CHANGED');
 if(!exactPause){const currentRound=(await client.query('SELECT id,plan_sha256 FROM studio_generated_revision_rounds WHERE company_id=$1 AND project_id=$2 ORDER BY number DESC LIMIT 1',[member.companyId,projectId])).rows[0];if(currentRound)Object.assign(configurationSnapshot,{generatedRound:{roundId:currentRound.id,planSha256:currentRound.plan_sha256}});await requireApprovalWindow(client,data.expiresAt);}
 if(data.maxRuns<(old?.runsStarted??0))fail(409,'The lifetime run limit cannot be below the runs already started.','COORDINATION_BUDGET_USED');
 await client.query(`INSERT INTO studio_coordination_policies(company_id,project_id,coordinator_agent_id,approved_by,status,allowed_role_keys,profile_revision,authority_snapshot,max_runs,max_concurrent_runs,expires_at,generated_continuations,coordinator_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(company_id,project_id) DO UPDATE SET coordinator_agent_id=EXCLUDED.coordinator_agent_id,approved_by=EXCLUDED.approved_by,status=EXCLUDED.status,allowed_role_keys=EXCLUDED.allowed_role_keys,profile_revision=EXCLUDED.profile_revision,authority_snapshot=EXCLUDED.authority_snapshot,max_runs=EXCLUDED.max_runs,max_concurrent_runs=EXCLUDED.max_concurrent_runs,expires_at=EXCLUDED.expires_at,generated_continuations=EXCLUDED.generated_continuations,coordinator_generation=EXCLUDED.coordinator_generation,revision=studio_coordination_policies.revision+1,updated_at=clock_timestamp()`,[member.companyId,projectId,data.coordinatorAgentId,member.userId,data.status,JSON.stringify(data.allowedRoleKeys.slice().sort()),configurationSnapshot.profileRevision,JSON.stringify(configurationSnapshot),data.maxRuns,data.maxConcurrentRuns,data.expiresAt,Boolean(data.generatedContinuations),Boolean(data.coordinatorGeneration)]);
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
 const queued=await dispatchWork(client,member,data.projectId,{clientId:uuidFor(`coatria-coordination:${companyId}:${data.projectId}:${data.workItemId}${data.executionJobId?':render:'+data.executionJobId:''}`),revision:data.projectRevision,workItemId:data.workItemId});
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
 await client.query('UPDATE studio_coordination_policies SET runs_started=runs_started+1 WHERE company_id=$1 AND project_id=$2',[companyId,data.projectId]);
 const snapshot=await studioCoordinationSnapshot(client,companyId,data.projectId);await requireApprovalLive(client,policy.expiresAt);
 return {workItemId:data.workItemId,parentRunId:run.id,childRunId:queued.run.id,replayed:false,policy:snapshot.policy};
}
/** The aggregate company character does not confer coordinator powers on its
 * separate generation child. Called before even replaying a cached tool receipt. */
export async function assertCoordinatorGenerationTool(client:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const receipt=(await client.query('SELECT d.project_id,d.work_item_id,w.task_id FROM studio_coordination_dispatches d JOIN studio_work_items w ON w.company_id=d.company_id AND w.project_id=d.project_id AND w.id=d.work_item_id WHERE d.company_id=$1 AND d.child_run_id=$2 AND d.coordinator_agent_id=d.specialist_agent_id',[agent.company_id,run.id])).rows[0];
 if(!receipt)return;
 const sameProject=args.projectId===receipt.project_id;
 const allowed=(name==='studio_get'&&sameProject&&args.contractVersion===2&&args.workItemId===receipt.work_item_id&&!args.artifactId)
  ||name==='higgsfield_connection_get'
  ||(['higgsfield_requests_list','higgsfield_jobs_list','storage_get','storage_files_list'].includes(name)&&sameProject)
  ||(name==='tasks_claim'&&args.taskId===receipt.task_id)
  ||(name==='higgsfield_generation_propose'&&sameProject&&args.workItemId===receipt.work_item_id);
 if(!allowed)fail(403,'This separate generation request may only read its assigned production context, claim its task and propose generation for human approval. It cannot act as coordinator or transfer, register, submit or approve media.','COORDINATOR_GENERATION_SCOPE');
}
/** Agent/run -> policy. Never hold a project lock across conversation completion. */
export async function coordinationRunAuthority(client:PoolClient,companyId:string,run:Row):Promise<boolean>{
 // Terminal receipts remain replayable after their historical approval expires.
 if(!['queued','running'].includes(run.status))return true;
 const delegation=(await client.query('SELECT project_id,policy_revision,NULL::uuid AS execution_job_id,work_item_id,NULL::uuid AS artifact_id,NULL::text AS execution_manifest_sha256,NULL::text AS artifact_sha256,parent_run_id,coordinator_agent_id=specialist_agent_id AS coordinator_generation FROM studio_coordination_dispatches WHERE company_id=$1 AND child_run_id=$2 UNION ALL SELECT project_id,policy_revision,execution_job_id,work_item_id,artifact_id,execution_manifest_sha256,artifact_sha256,parent_run_id,false AS coordinator_generation FROM studio_coordination_followups WHERE company_id=$1 AND child_run_id=$2',[companyId,run.id])).rows[0];if(!delegation)return true;
 const policy=await policyRow(client,companyId,delegation.project_id,'share');if(!policy||policy.revision!==delegation.policy_revision)return false;
 const active=await status(client,companyId,policy);if(!['active','exhausted'].includes(active.effectiveStatus))return false;
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
