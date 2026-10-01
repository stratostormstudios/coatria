import type {PoolClient} from 'pg';
import type {Membership} from './auth';
import {ApiError,fail,hashToken,id} from './security';
import {createAgentRunInTransaction} from './agent-runs';
import {managedAgentAuthoritySql} from './studio-hosting';
import {studioCreativeFollowupInput,type StudioCreativeFollowupReceipt,type StudioCreativeFollowupSnapshot} from './studio-creative-followup-protocol';

type Row=Record<string,any>;
const required=['studio.read','studio.write','tasks.write','creative.read','creative.write'];
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const unavailable=()=>fail(409,'This exact generation handoff is not ready. Finish or reconcile the source run, register its actual output, then refresh the project.','CREATIVE_FOLLOWUP_UNAVAILABLE');
async function supportedProject(client:PoolClient,companyId:string,projectId:string){
 const project=(await client.query('SELECT id,contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rows[0];
 if(!project)fail(404,'Studio project not found.');
 if(project.contract_version===2)fail(409,'Generated-media continuation requires a version-aware verified-source handoff. Submit the registered output through the normal authorized task workflow.','STUDIO_GENERATED_FOLLOWUP_UNAVAILABLE');
}

async function evidence(client:PoolClient,companyId:string,projectId:string,workItemId:string,requestId:string,artifactId:string,followup?:StudioCreativeFollowupReceipt){
 const row=(await client.query(`SELECT q.id AS request_id,q.request_hash,q.status AS request_status,q.result,q.agent_id AS source_agent_id,q.run_id AS source_run_id,q.task_revision AS request_task_revision,q.role_agent_id,q.role_human_id,
  w.task_id,w.execution,w.stage,t.revision AS task_revision,t.status AS task_status,t.agent_run_id AS task_run_id,t.assignee_id,
  b.agent_id AS assigned_agent_id,b.human_id AS assigned_human_id,source.status AS source_status,
  a.id AS artifact_id,a.sha256 AS artifact_sha256,a.produced_agent_id,a.run_id AS artifact_run_id,
  (SELECT latest.id FROM studio_artifacts latest WHERE latest.company_id=w.company_id AND latest.work_item_id=w.id ORDER BY latest.version DESC LIMIT 1) AS latest_artifact_id,
  (SELECT d.run_id FROM studio_dispatches d JOIN agent_runs active ON active.company_id=d.company_id AND active.id=d.run_id WHERE d.company_id=w.company_id AND d.work_item_id=w.id AND active.status IN ('queued','running') AND ($6::uuid IS NULL OR active.id<>$6) LIMIT 1) AS other_active_run,
  EXISTS(SELECT 1 FROM studio_dependencies deps JOIN studio_work_items prior_work ON prior_work.company_id=deps.company_id AND prior_work.id=deps.predecessor_id JOIN tasks prior_task ON prior_task.company_id=prior_work.company_id AND prior_task.id=prior_work.task_id WHERE deps.company_id=w.company_id AND deps.project_id=w.project_id AND deps.work_item_id=w.id AND prior_task.status<>'done') AS dependencies_pending,
  agent.status AS agent_status,agent.capabilities,agent.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('agent')} AS agent_live,
  EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=agent.company_id AND m.user_id=agent.created_by AND m.role IN ('owner','admin')) AS sponsor_live,
  p.production_path,p.status AS project_status,p.revision AS project_revision,p.ai_policy,p.gates
  FROM higgsfield_requests q JOIN studio_work_items w ON w.company_id=q.company_id AND w.project_id=q.project_id AND w.id=q.work_item_id
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN agent_runs source ON source.company_id=q.company_id AND source.id=q.run_id AND source.agent_id=q.agent_id
  JOIN agents agent ON agent.company_id=q.company_id AND agent.id=q.agent_id
  JOIN studio_artifacts a ON a.company_id=w.company_id AND a.project_id=w.project_id AND a.work_item_id=w.id AND a.id=$5
  WHERE q.company_id=$1 AND q.project_id=$2 AND w.id=$3 AND q.id=$4`,[companyId,projectId,workItemId,requestId,artifactId,followup?.runId??null])).rows[0];
 if(!row||row.production_path!=='higgsfield'||row.execution!=='creative'||row.stage!=='generation'||row.request_status!=='returned'||!row.result||row.result.isError===true||!['succeeded','failed','cancelled'].includes(row.source_status)||row.assignee_id||row.other_active_run)unavailable();
 if(row.assigned_agent_id!==row.source_agent_id||row.role_agent_id!==row.source_agent_id||row.role_human_id!==null||row.assigned_human_id!==null||row.latest_artifact_id!==artifactId)unavailable();
 if(row.produced_agent_id&&(row.produced_agent_id!==row.source_agent_id||row.artifact_run_id!==row.source_run_id))unavailable();
 if(row.agent_status!=='active'||!row.agent_live||!row.sponsor_live||required.some(scope=>!row.capabilities.includes(scope)))unavailable();
 if(row.project_status==='delivered'||row.ai_policy!=='allowed'||row.dependencies_pending||['brief','estimate','production'].some(gate=>row.gates[gate]?.decision!=='approved'))unavailable();
 if(followup){
  if(followup.agentId!==row.source_agent_id||followup.sourceRunId!==row.source_run_id||followup.taskId!==row.task_id||followup.requestHash!==row.request_hash||followup.artifactSha256!==row.artifact_sha256||followup.projectRevision!==row.project_revision||followup.taskRevision!==row.request_task_revision)unavailable();
  const beforeClaim=row.task_run_id===row.source_run_id&&row.task_status==='doing'&&row.task_revision===followup.taskRevision;
  const claimed=row.task_run_id===followup.runId&&row.task_status==='doing'&&row.task_revision===followup.taskRevision+1;
  const submitted=row.task_run_id===followup.runId&&row.task_status==='review'&&row.task_revision===followup.taskRevision+2;
  if(!beforeClaim&&!claimed&&!submitted)unavailable();
 }else if(row.task_status!=='doing'||row.task_run_id!==row.source_run_id||row.task_revision!==row.request_task_revision)unavailable();
 return row;
}
async function priorPair(client:PoolClient,companyId:string,projectId:string,workItemId:string,requestId:string,artifactId:string){
 return (await client.query(`SELECT r.id FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id
  JOIN studio_requests s ON s.company_id=r.company_id AND s.actor_key='human:'||r.requested_by::text AND s.client_id=r.client_id
  WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND s.response#>>'{creativeFollowup,requestId}'=$4 AND s.response#>>'{creativeFollowup,artifactId}'=$5 LIMIT 1`,[companyId,projectId,workItemId,requestId,artifactId])).rows[0];
}
/** A preview of eligible identities, never a provider-completion or pixel claim. */
export async function studioCreativeFollowupSnapshot(client:PoolClient,companyId:string,projectId:string):Promise<StudioCreativeFollowupSnapshot>{
 id(companyId);id(projectId);await supportedProject(client,companyId,projectId);
 const rows=(await client.query(`SELECT q.id,q.work_item_id,q.run_id,a.id AS artifact_id FROM higgsfield_requests q JOIN LATERAL (SELECT id FROM studio_artifacts a WHERE a.company_id=q.company_id AND a.work_item_id=q.work_item_id ORDER BY version DESC LIMIT 1) a ON true WHERE q.company_id=$1 AND q.project_id=$2 AND q.status='returned' AND q.run_id IS NOT NULL ORDER BY q.created_at,q.id LIMIT 200`,[companyId,projectId])).rows;
 const candidates=[];
 for(const row of rows)try{await evidence(client,companyId,projectId,row.work_item_id,row.id,row.artifact_id);if(!await priorPair(client,companyId,projectId,row.work_item_id,row.id,row.artifact_id))candidates.push({workItemId:row.work_item_id,requestId:row.id,artifactId:row.artifact_id,sourceRunId:row.run_id});}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;}
 return {candidates,requiresHumanOutputAttestation:true,automaticContinuation:false};
}

/** Explicit administrator action. It queues one scoped run, never another generation. */
export async function dispatchStudioCreativeFollowup(client:PoolClient,member:Membership,projectId:string,input:unknown){
 id(projectId);const data=studioCreativeFollowupInput.parse(input),actorKey='human:'+member.userId,requestHash=hashToken(canonical({operation:'creative-followup',projectId,...data}));
 if(!(await client.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[member.companyId,member.userId])).rowCount)fail(403,'A current administrator must attest this handoff.');
 await supportedProject(client,member.companyId,projectId);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-request:${member.companyId}:${actorKey}:${data.clientId}`]);
 const previous=(await client.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[member.companyId,actorKey,data.clientId])).rows[0];
 if(previous){if(previous.request_hash!==requestHash)fail(409,'This request key belongs to a different handoff.','IDEMPOTENCY_CONFLICT');return {...previous.response,replayed:true};}
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-followup:${member.companyId}:${data.requestId}:${data.artifactId}`]);
 if(await priorPair(client,member.companyId,projectId,data.workItemId,data.requestId,data.artifactId))fail(409,'This exact output handoff already has a recorded run. Inspect that run; it will not be dispatched again.','CREATIVE_FOLLOWUP_EXISTS');
 const preview=await evidence(client,member.companyId,projectId,data.workItemId,data.requestId,data.artifactId);
 const prompt=`This administrator-attested handoff may only submit an existing output for independent human review. Read studio_get for projectId ${projectId} and workItemId ${data.workItemId}, then studio_get with artifactId ${data.artifactId}, and higgsfield_requests_list with requestId ${data.requestId}. The administrator attests that this registered artifact is the output of that exact request; this is not server byte verification or creative QC. Do not generate, import observations, register another artifact, update tasks, or delegate. Claim existing task ${preview.task_id} at revision ${preview.task_revision}, then tasks_submit at revision ${preview.task_revision+1} with a factual summary referencing that artifact and request. Do not claim that media was inspected or approved. Stop after the committed submission.`;
 // Agent/conversation locks precede the project lock, as in ordinary dispatch.
 const queued=await createAgentRunInTransaction(client,member,'commons',{clientId:data.clientId,agentId:preview.source_agent_id,prompt});if(queued.replayed)fail(409,'This request key already belongs to another agent request.','IDEMPOTENCY_CONFLICT');
 const project=(await client.query('SELECT id,revision FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[member.companyId,projectId])).rows[0];
 if(!project||project.revision!==data.revision)fail(409,'The project changed. Review this handoff again.','STUDIO_REVISION_CONFLICT');
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[member.companyId]);
 await client.query('SELECT id FROM tasks WHERE company_id=$1 AND id=$2 FOR SHARE',[member.companyId,preview.task_id]);
 const exact=await evidence(client,member.companyId,projectId,data.workItemId,data.requestId,data.artifactId);if(exact.source_agent_id!==preview.source_agent_id||exact.task_id!==preview.task_id||exact.task_revision!==preview.task_revision)unavailable();
 if(required.some(scope=>!queued.run.capabilities.includes(scope)))unavailable();
 await client.query('UPDATE agent_runs SET capabilities=$3,max_attempts=1 WHERE company_id=$1 AND id=$2',[member.companyId,queued.run.id,JSON.stringify(required)]);
 await client.query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[member.companyId,projectId,data.workItemId,queued.run.id]);
 const updated=(await client.query('UPDATE studio_projects SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING id,revision',[member.companyId,projectId])).rows[0];
 const receipt:StudioCreativeFollowupReceipt={version:1,runId:queued.run.id,projectId,workItemId:data.workItemId,taskId:exact.task_id,requestId:data.requestId,requestHash:exact.request_hash,artifactId:data.artifactId,artifactSha256:exact.artifact_sha256,sourceRunId:exact.source_run_id,agentId:exact.source_agent_id,taskRevision:exact.task_revision,projectRevision:updated.revision,attestedBy:member.userId,attestedAt:new Date().toISOString(),note:data.note,provenance:'human_attested',providerOutputVerified:false,mediaBytesVerified:false,mediaQcApproved:false,maxAttempts:1};
 const result={run:{...queued.run,capabilities:required,maxAttempts:1},project:updated,creativeFollowup:receipt};
 await client.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[member.companyId,actorKey,data.clientId,requestHash,JSON.stringify(result)]);
 await client.query("INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,'studio.creative_followup','An administrator attested one exact existing output/request handoff and queued a single scoped submission run. No generation, byte verification or media approval occurred.')",[member.companyId,member.userId]);
 return {...result,replayed:false};
}

/** The leased tool caller must invoke this before receipt replay and any effects. */
export async function assertCreativeFollowupTool(client:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const saved=(await client.query("SELECT response->'creativeFollowup' AS receipt FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3",[agent.company_id,'human:'+run.requested_by,run.client_id])).rows[0]?.receipt as StudioCreativeFollowupReceipt|undefined;
 if(!saved)return;
 if(saved.version!==1||saved.runId!==run.id||saved.agentId!==agent.id||saved.attestedBy!==run.requested_by)unavailable();
 if(!(await client.query("SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[agent.company_id,saved.attestedBy])).rowCount)fail(403,'The handoff administrator no longer has authority.','CREATIVE_FOLLOWUP_AUTHORITY');
 await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[agent.company_id,saved.projectId]);
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[agent.company_id]);
 await evidence(client,agent.company_id,saved.projectId,saved.workItemId,saved.requestId,saved.artifactId,saved);
 const allowed=(name==='studio_get'&&args.projectId===saved.projectId&&((args.workItemId===saved.workItemId&&!args.artifactId)||(args.artifactId===saved.artifactId&&!args.workItemId)))||
  (name==='higgsfield_requests_list'&&args.projectId===saved.projectId&&args.requestId===saved.requestId&&!args.after)||
  (name==='tasks_claim'&&args.taskId===saved.taskId&&args.revision===saved.taskRevision)||
  (name==='tasks_submit'&&args.taskId===saved.taskId&&args.revision===saved.taskRevision+1);
 if(!allowed)fail(403,'This handoff may only read its exact task, artifact and generation receipt, then claim and submit that task. Generation, registration, edits and delegation are prohibited.','CREATIVE_FOLLOWUP_SCOPE');
}
