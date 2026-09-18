import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {body,fail,id,json} from './security';
import {STUDIO_TEMPLATES,STUDIO_SKILLS,STUDIO_DISCIPLINES,studioSetupInput,studioProjectInput,studioProjectPatchInput,studioDispatchInput,studioArtifactInput,studioGateInput,studioReviewInput,studioDeliveryInput,type StudioProject,type StudioRole,type StudioWorkItem,type StudioProjectDetail,type StudioSnapshot} from './studio-protocol';
import {createAgentRunInTransaction} from './agent-runs';

export type StudioActor={companyId:string;userId:string;agentId?:string;runId?:string;agentSponsorId?:string};
const projectColumns=`id,name,client_name AS "clientName",brief,due_date::text AS "dueDate",spec,ai_policy AS "aiPolicy",revision,status,gates,created_at AS "createdAt",updated_at AS "updatedAt"`;
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)fail(400,result.error.issues.map(i=>i.message).join(' '));return result.data;};
function canonical(v:unknown):string{return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,w])=>JSON.stringify(k)+':'+canonical(w)).join(',')+'}':JSON.stringify(v);}
async function requestOnce<T>(client:PoolClient,actor:StudioActor,clientId:string,operation:string,data:unknown,run:()=>Promise<T>):Promise<T&{replayed:boolean}>{
 const actorKey=actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId,hash=createHash('sha256').update(canonical({operation,data})).digest('hex');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-request:${actor.companyId}:${actorKey}:${clientId}`]);
 const old=(await client.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,actorKey,clientId])).rows[0];
 if(old){if(old.request_hash!==hash)fail(409,'This request ID belongs to a different studio operation.','IDEMPOTENCY_CONFLICT');return {...old.response,replayed:true};}
 const result=await run();await client.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.companyId,actorKey,clientId,hash,JSON.stringify(result)]);return {...result,replayed:false};
}
async function activity(client:PoolClient,actor:StudioActor,kind:string,description:string){await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[actor.companyId,actor.userId,kind,description]);}
async function lockedProject(client:PoolClient,companyId:string,projectId:string,revision?:number){
 const p=(await client.query(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,projectId])).rows[0] as StudioProject|undefined;
 if(!p)fail(404,'Studio project not found.');if(revision!==undefined&&p.revision!==revision)fail(409,'The project changed. Refresh before continuing.','STUDIO_REVISION_CONFLICT');return p;
}
async function bump(client:PoolClient,companyId:string,projectId:string){return (await client.query(`UPDATE studio_projects SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING ${projectColumns}`,[companyId,projectId])).rows[0] as StudioProject;}
async function studioRoles(client:PoolClient,companyId:string):Promise<StudioRole[]>{
 const rows=(await client.query(`SELECT b.role_key,b.agent_id,b.human_id,a.name AS agent_name,u.name AS human_name,CASE WHEN a.id IS NULL THEN NULL WHEN a.status<>'active' THEN a.status WHEN a.expires_at<=clock_timestamp() THEN 'expired' WHEN a.last_seen_at>clock_timestamp()-interval '2 minutes' THEN 'recent_contact' ELSE 'not_connected' END AS connection_state FROM studio_role_bindings b LEFT JOIN agents a ON a.company_id=b.company_id AND a.id=b.agent_id LEFT JOIN users u ON u.id=b.human_id WHERE b.company_id=$1`,[companyId])).rows;
 return STUDIO_TEMPLATES[0].roles.map(role=>{const row=rows.find(r=>r.role_key===role.key);return {...role,skills:[...role.skills],agentId:row?.agent_id??null,humanId:row?.human_id??null,agentName:row?.agent_name,humanName:row?.human_name,connectionState:row?.connection_state};});
}
export async function studioSnapshot(client:PoolClient,companyId:string,after?:string,limit=50):Promise<StudioSnapshot>{
 if(after&&!(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,after])).rowCount)fail(404,'Studio cursor not found.');
 const p=(await client.query('SELECT template_id AS "templateId",revision FROM studio_profiles WHERE company_id=$1',[companyId])).rows[0];
 const projects=(await client.query(`SELECT ${projectColumns},(SELECT count(*)::int FROM studio_shots s WHERE s.company_id=$1 AND s.project_id=p.id) AS "shotCount",(SELECT count(*)::int FROM studio_work_items w WHERE w.company_id=$1 AND w.project_id=p.id) AS "workCount",(SELECT count(*)::int FROM studio_work_items w JOIN tasks t ON t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=p.id AND t.status='done') AS "acceptedCount" FROM studio_projects p WHERE company_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[companyId,after??null,limit+1])).rows as StudioProject[];
 return {templates:STUDIO_TEMPLATES,skills:STUDIO_SKILLS,profile:p?{templateId:p.templateId,revision:p.revision,roles:await studioRoles(client,companyId)}:null,projects:projects.slice(0,limit),hasMore:projects.length>limit,nextAfter:projects.length>limit?projects[limit-1].id:null};
}
export async function setupStudio(client:PoolClient,actor:StudioActor,input:unknown){
 if(actor.agentId)fail(403,'An administrator must apply the company structure.');const data=parse(studioSetupInput,input);
 return requestOnce(client,actor,data.clientId,'setup',data,async()=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-profile:${actor.companyId}`]);
  const current=(await client.query('SELECT revision FROM studio_profiles WHERE company_id=$1 FOR UPDATE',[actor.companyId])).rows[0];if((current?.revision??0)!==data.revision)fail(409,'The studio structure changed. Refresh before applying.','STUDIO_REVISION_CONFLICT');
  // Role changes serialize with every studio authority check. No project/run
  // locks follow here; active work must be cancelled and reconciled separately.
  const previous=(await client.query('SELECT role_key,agent_id,human_id FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR UPDATE',[actor.companyId])).rows;
  for(const old of previous){
   const next=data.assignments.find(a=>a.roleKey===old.role_key);
   if(old.agent_id===(next?.agentId??null)&&old.human_id===(next?.humanId??null))continue;
   if((await client.query("SELECT w.id FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.role_key=$2 AND (EXISTS(SELECT 1 FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id WHERE d.company_id=w.company_id AND d.work_item_id=w.id AND r.status IN ('queued','running')) OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.company_id=t.company_id AND r.id=t.agent_run_id AND r.status IN ('queued','running'))) LIMIT 1",[actor.companyId,old.role_key])).rowCount)fail(409,'Cancel active requests and reconcile their tasks before changing this role assignment.','STUDIO_ROLE_BUSY');
  }
  for(const binding of data.assignments){
   if(!STUDIO_TEMPLATES[0].roles.some(r=>r.key===binding.roleKey))fail(400,'Unknown studio role.');
   if(binding.agentId&&!(await client.query("SELECT id FROM agents WHERE company_id=$1 AND id=$2 AND status<>'revoked'",[actor.companyId,binding.agentId])).rowCount)fail(400,'Choose an agent in this company.');
   if(binding.humanId&&!(await client.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 AND role<>'removed'",[actor.companyId,binding.humanId])).rowCount)fail(400,'Choose a current company member.');
  }
  await client.query('INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(company_id) DO UPDATE SET template_id=EXCLUDED.template_id,template_version=EXCLUDED.template_version,revision=studio_profiles.revision+1,updated_at=clock_timestamp()',[actor.companyId,data.templateId,data.templateVersion,actor.userId]);
  // Explicit complete assignment snapshot; omitted roles are unassigned, not invented workers.
  for(const role of STUDIO_TEMPLATES[0].roles){const b=data.assignments.find(a=>a.roleKey===role.key);await client.query('INSERT INTO studio_role_bindings(company_id,role_key,agent_id,human_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,role_key) DO UPDATE SET agent_id=EXCLUDED.agent_id,human_id=EXCLUDED.human_id',[actor.companyId,role.key,b?.agentId??null,b?.humanId??null]);}
  await activity(client,actor,'studio.configured','The VFX studio structure and role assignments were configured.');return {profile:(await studioSnapshot(client,actor.companyId)).profile};
 });
}
export async function createStudioProject(client:PoolClient,actor:StudioActor,input:unknown){
 const data=parse(studioProjectInput,input);
 return requestOnce(client,actor,data.clientId,'project',data,async()=>{
  if(!(await client.query('SELECT company_id FROM studio_profiles WHERE company_id=$1 FOR UPDATE',[actor.companyId])).rowCount)fail(409,'Apply a studio structure before planning a project.','STUDIO_SETUP_REQUIRED');
  if(Number((await client.query('SELECT count(*) FROM studio_projects WHERE company_id=$1',[actor.companyId])).rows[0].count)>=200)fail(409,'This workspace has reached its 200-project pilot limit.');
  const p=(await client.query(`INSERT INTO studio_projects(company_id,name,client_name,brief,due_date,spec,ai_policy,created_by,created_agent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${projectColumns}`,[actor.companyId,data.name,data.clientName,data.brief,data.dueDate,JSON.stringify(data.spec),data.aiPolicy,actor.userId,actor.agentId??null])).rows[0] as StudioProject;
  const add=async(key:string,title:string,stage:string,roleKey:string,execution:string,shotId:string|null,deps:string[])=>{
   const skillKeys=STUDIO_TEMPLATES[0].roles.find(r=>r.key===roleKey)?.skills??[];
   const description=`Studio project ${p.name}. Role: ${roleKey}. Stage: ${stage}. Skills: ${skillKeys.join(', ')}. Read studio_get for current brief, dependencies and skill instructions. ${execution==='dcc'?'Requires an artist or approved DCC connector and an actual versioned media artifact. A written report is not rendered media.':execution==='human'?'Requires a human production/review handoff.':'Prepare a reviewable production contribution.'} Never bypass project gates or accept your own work.`;
   const task=(await client.query('INSERT INTO tasks(company_id,title,description,created_by,created_agent_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[actor.companyId,title,description,actor.userId,actor.agentId??null])).rows[0];
   if(actor.agentId)await client.query('INSERT INTO task_authors(task_id,user_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',[task.id,[...new Set([actor.userId,actor.agentSponsorId??actor.userId])]]);
   const w=(await client.query('INSERT INTO studio_work_items(company_id,project_id,shot_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[actor.companyId,p.id,shotId,key,task.id,stage,roleKey,execution])).rows[0];
   for(const dep of deps)await client.query('INSERT INTO studio_dependencies(company_id,project_id,work_item_id,predecessor_id) VALUES($1,$2,$3,$4)',[actor.companyId,p.id,w.id,dep]);return w.id as string;
  };
  const estimate=await add('estimate',`${p.name} · Scope & estimate`,'estimate','producer','agent',null,[]);
  const breakdown=await add('breakdown',`${p.name} · Shot breakdown & schedule`,'breakdown','coordinator','agent',null,[estimate]);const finals:string[]=[];
  const roleFor:Record<string,string>={prep:'prep',matchmove:'prep',layout:'cg',animation:'cg',fx:'fx',lighting:'lighting',compositing:'comp'};
  for(const shot of data.shots){
   const s=(await client.query('INSERT INTO studio_shots(company_id,project_id,code,description,frame_start,frame_end,handles,disciplines) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[actor.companyId,p.id,shot.code,shot.description,shot.frameStart,shot.frameEnd,shot.handles,JSON.stringify(shot.disciplines)])).rows[0];
   let previous=await add(`${shot.code}:ingest`,`${shot.code} · Media ingest`,'ingest','ingest','human',s.id,[breakdown]);
   for(const discipline of STUDIO_DISCIPLINES.filter(d=>shot.disciplines.includes(d)))previous=await add(`${shot.code}:${discipline}`,`${shot.code} · ${discipline}`,discipline,roleFor[discipline],'dcc',s.id,[previous]);
   finals.push(await add(`${shot.code}:qc`,`${shot.code} · Independent shot QC`,'qc','qc','human',s.id,[previous]));
  }
  await add('delivery',`${p.name} · Package & delivery handoff`,'delivery','delivery','human',null,finals);
  await activity(client,actor,'studio.project_planned',`A studio project was planned with ${data.shots.length} shots and explicit production dependencies.`);return {project:p};
 });
}
async function workItems(client:PoolClient,companyId:string,project:StudioProject):Promise<StudioWorkItem[]>{
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[companyId]);
 const rows=(await client.query(`SELECT w.id,w.task_id AS "taskId",w.shot_id AS "shotId",w.stage,w.role_key AS "roleKey",w.execution,t.title,t.status,t.revision,t.submission_summary AS "submissionSummary",t.approved_by AS "approvedBy",t.approved_agent_id AS "approvedAgentId",t.machine_review_id AS "machineReviewId",latest.run_id AS "runId",latest.run_status AS "runStatus",b.agent_id AS "agentId",b.human_id AS "humanId",COALESCE((SELECT jsonb_agg(d.predecessor_id ORDER BY d.predecessor_id) FROM studio_dependencies d WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id),'[]') AS dependencies FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key LEFT JOIN LATERAL (SELECT d.run_id,r.status AS run_status FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id ORDER BY d.created_at DESC,d.run_id DESC LIMIT 1) latest ON true WHERE w.company_id=$1 AND w.project_id=$2 ORDER BY w.id`,[companyId,project.id])).rows;
 const statuses=new Map(rows.map(w=>[w.id,w.status]));
 return rows.map(w=>{
  let blockedReason:string|null=null;if(project.gates.brief?.decision!=='approved')blockedReason='Client brief approval is required.';
  else if(!['estimate','breakdown'].includes(w.stage)&&project.gates.production?.decision!=='approved')blockedReason='Production authorization is required.';
  else if(w.dependencies.some((dep:string)=>statuses.get(dep)!=='done'))blockedReason='An upstream task still needs independent acceptance.';
  else if(project.aiPolicy==='restricted'&&w.execution==='dcc'&&w.agentId)blockedReason='AI use is restricted. Assign an authorized human for media work.';
  return {...w,readiness:w.status==='done'?'accepted':w.status==='review'?'review':blockedReason?'blocked':w.runStatus==='queued'?'queued':w.status==='doing'||w.runStatus==='running'?'running':'ready',blockedReason} as StudioWorkItem;
 });
}
export async function studioProjectDetail(client:PoolClient,companyId:string,projectId:string):Promise<StudioProjectDetail>{
 const project=(await client.query(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2`,[companyId,projectId])).rows[0] as StudioProject|undefined;if(!project)fail(404,'Studio project not found.');
 const shots=(await client.query('SELECT id,code,description,frame_start AS "frameStart",frame_end AS "frameEnd",handles,disciplines FROM studio_shots WHERE company_id=$1 AND project_id=$2 ORDER BY code',[companyId,projectId])).rows;
 const artifacts=(await client.query(`SELECT a.id,a.work_item_id AS "workItemId",a.name,a.version,a.url,a.sha256,a.metadata,a.produced_by AS "producedBy",a.produced_agent_id AS "producedAgentId",a.created_at AS "createdAt",COALESCE((SELECT r.decision FROM studio_reviews r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.artifact_id=a.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'pending') AS "reviewStatus" FROM studio_artifacts a WHERE a.company_id=$1 AND a.project_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 1000`,[companyId,projectId])).rows.map(a=>{const {metadata,...rest}=a;return {...rest,...metadata};});
 const reviews=(await client.query('SELECT id,artifact_id AS "artifactId",decision,note,technical_qc AS "technicalQc",reviewed_by AS "reviewedBy",created_at AS "createdAt" FROM studio_reviews WHERE company_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1000',[companyId,projectId])).rows;
 const deliveries=(await client.query('SELECT id,name,status,manifest,note,created_at AS "createdAt" FROM studio_deliveries WHERE company_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[companyId,projectId])).rows;
 return {project,shots,workItems:await workItems(client,companyId,project),artifacts,reviews,deliveries,roles:await studioRoles(client,companyId),skills:STUDIO_SKILLS} as StudioProjectDetail;
}
export async function registerStudioArtifact(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioArtifactInput,input);return requestOnce(client,actor,data.clientId,'artifact:'+projectId,data,async()=>{
  const project=await lockedProject(client,actor.companyId,projectId,data.revision);if(project.status==='delivered')fail(409,'Delivered projects are immutable. Create follow-up work.');
  const work=(await workItems(client,actor.companyId,project)).find(w=>w.id===data.workItemId);if(!work)fail(404,'Work item not found.');if(work.execution!=='dcc')fail(400,'Register media against a VFX or CG production work item.');
  if(work.status==='done')fail(409,'Accepted work is immutable. Create follow-up work for a new version.');if(work.blockedReason)fail(409,work.blockedReason,'STUDIO_WORK_BLOCKED');
  if(actor.agentId){if(project.aiPolicy!=='allowed')fail(403,'This project does not authorize agent processing of media.','STUDIO_AI_RESTRICTED');if(work.agentId!==actor.agentId)fail(403,'Only the assigned specialist may register this media artifact.');const t=(await client.query('SELECT agent_run_id FROM tasks WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,work.taskId])).rows[0];if(t.agent_run_id!==actor.runId)fail(403,'Reserve the production task for this run first.');}
  if(Number((await client.query('SELECT count(*) FROM studio_artifacts WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count)>=1000)fail(409,'This project reached its 1,000-version pilot limit.');
  const version=Number((await client.query('SELECT COALESCE(max(version),0)+1 AS version FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3',[actor.companyId,projectId,work.id])).rows[0].version);
  const {clientId:_,revision:__,workItemId:___,name,url,sha256,...metadata}=data;
  const artifact=(await client.query('INSERT INTO studio_artifacts(company_id,project_id,work_item_id,name,version,url,sha256,metadata,produced_by,produced_agent_id,agent_sponsor_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,version',[actor.companyId,projectId,work.id,name,version,url,sha256,JSON.stringify(metadata),actor.userId,actor.agentId??null,actor.agentSponsorId??null,actor.runId??null])).rows[0];
  await activity(client,actor,'studio.artifact_registered','An immutable media reference was registered; content and checksum still require independent verification.');return {artifact:{...artifact,name,url,sha256,workItemId:work.id,...metadata,reviewStatus:'pending'},project:await bump(client,actor.companyId,projectId)};
 });
}

export async function assertStudioTaskAction(client:PoolClient,companyId:string,taskId:string,name:string,args:Record<string,any>,run?:Record<string,any>,agent?:Record<string,any>){
 const link=(await client.query('SELECT project_id,id FROM studio_work_items WHERE company_id=$1 AND task_id=$2',[companyId,taskId])).rows[0];if(!link)return;
 const project=await lockedProject(client,companyId,link.project_id),items=await workItems(client,companyId,project),work=items.find(w=>w.id===link.id)!;
 if(project.status==='delivered')fail(409,'Delivered project work is immutable.');
 if(agent){
  if(!agent.capabilities?.includes('studio.write')||!run?.capabilities?.includes('studio.write'))fail(403,'This studio work requires an explicitly approved studio.write grant.','AGENT_CAPABILITY_REQUIRED');
  if(work.agentId!==agent.id)fail(403,'The studio role must be assigned to this agent before it can perform this work.','STUDIO_ROLE_REQUIRED');
  if(work.execution==='human')fail(403,'This stage requires a human production or quality handoff.','STUDIO_HUMAN_REQUIRED');
  if(work.execution==='dcc'&&project.aiPolicy!=='allowed')fail(403,'This project does not authorize agent processing of media.','STUDIO_AI_RESTRICTED');
 }
 if(!agent&&name==='human_update'&&(await client.query("SELECT r.id FROM agent_runs r WHERE r.company_id=$1 AND r.status IN ('queued','running') AND (r.id IN (SELECT d.run_id FROM studio_dispatches d WHERE d.company_id=$1 AND d.work_item_id=$2) OR r.id=(SELECT t.agent_run_id FROM tasks t WHERE t.company_id=$1 AND t.id=$3)) LIMIT 1",[companyId,work.id,taskId])).rowCount)fail(409,'Cancel or finish the active agent request before editing its studio task.','STUDIO_RUN_ACTIVE');
 if(work.blockedReason)fail(409,work.blockedReason,'STUDIO_WORK_BLOCKED');
 if(work.execution==='dcc'&&(name==='tasks_submit'||args.status==='review'||args.status==='done')){
  const artifact=(await client.query(`SELECT a.id,COALESCE((SELECT r.decision FROM studio_reviews r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.artifact_id=a.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'pending') AS decision FROM studio_artifacts a WHERE a.company_id=$1 AND a.project_id=$2 AND a.work_item_id=$3 ORDER BY a.version DESC LIMIT 1`,[companyId,project.id,work.id])).rows[0];
  if(!artifact)fail(409,'Register an actual versioned media reference before submitting this production task. A text result is insufficient.','STUDIO_ARTIFACT_REQUIRED');
  if(args.status==='done'&&artifact.decision!=='approved')fail(409,'The latest media version needs independent technical review before task acceptance.','STUDIO_ARTIFACT_REVIEW_REQUIRED');
 }
}
async function recordGate(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioGateInput,input);return requestOnce(client,actor,data.clientId,'gate:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.status==='delivered')fail(409,'Client acceptance is already recorded; create follow-up work for changes.');
  if(data.decision==='approved'){
   if(data.gate!=='brief'&&p.gates.brief?.decision!=='approved')fail(409,'Approve the client brief first.','STUDIO_GATE_REQUIRED');
   if(data.gate==='production'&&(p.gates.estimate?.decision!=='approved'||p.aiPolicy==='unknown'))fail(409,'Approve scope and estimate, and resolve the client AI-use policy before production.','STUDIO_GATE_REQUIRED');
   if(data.gate==='client_acceptance'){
    if(p.gates.production?.decision!=='approved'||!(await client.query("SELECT id FROM studio_deliveries WHERE company_id=$1 AND project_id=$2 AND id=$3 AND status='prepared'",[actor.companyId,projectId,data.deliveryId])).rowCount)fail(409,'Select an approved delivery package from this project before recording client acceptance.','STUDIO_DELIVERY_REQUIRED');
    if((await workItems(client,actor.companyId,p)).some(w=>w.status!=='done'))fail(409,'Complete the independent delivery-handoff task review before recording acceptance.','STUDIO_WORK_INCOMPLETE');
   }
  }
  const gates={...p.gates};gates[data.gate]={decision:data.decision,note:data.note,recordedBy:actor.userId,at:new Date().toISOString(),...data.deliveryId?{deliveryId:data.deliveryId}:{}};
  if(data.decision==='changes_requested')for(const key of data.gate==='brief'?['estimate','production','client_acceptance']:data.gate==='estimate'?['production','client_acceptance']:['client_acceptance'])if(key!==data.gate)delete gates[key];
  const status=gates.client_acceptance?.decision==='approved'?'delivered':gates.production?.decision==='approved'?'production':gates.brief?.decision==='approved'?'planning':'intake';
  await client.query('INSERT INTO studio_gate_events(company_id,project_id,gate,decision,note,recorded_by,delivery_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor.companyId,projectId,data.gate,data.decision,data.note,actor.userId,data.deliveryId??null]);
  await client.query('UPDATE studio_projects SET gates=$3,status=$4 WHERE company_id=$1 AND id=$2',[actor.companyId,projectId,JSON.stringify(gates),status]);
  if(data.gate==='client_acceptance'&&data.decision==='approved')await client.query("UPDATE studio_deliveries SET status='acknowledged' WHERE company_id=$1 AND project_id=$2 AND id=$3 AND status='prepared'",[actor.companyId,projectId,data.deliveryId]);
  await activity(client,actor,'studio.gate_recorded',`An administrator recorded the ${data.gate} production gate. This is an administrator attestation, not an automated client action.`);return {project:await bump(client,actor.companyId,projectId)};
 });
}
async function recordReview(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioReviewInput,input);return requestOnce(client,actor,data.clientId,'review:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.status==='delivered')fail(409,'Delivered review history is closed.');
  const a=(await client.query('SELECT * FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND id=$3',[actor.companyId,projectId,data.artifactId])).rows[0];if(!a)fail(404,'Artifact not found.');
  if([a.produced_by,a.agent_sponsor_id,a.metadata?.executionProvenance?.connectorSponsorId].includes(actor.userId))fail(403,'An independent administrator who did not produce or sponsor this version must review it.','STUDIO_INDEPENDENT_REVIEW');
  if((await client.query('SELECT id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND version>$4',[actor.companyId,projectId,a.work_item_id,a.version])).rowCount)fail(409,'Review the latest version of this work item.');
  const work=(await workItems(client,actor.companyId,p)).find(w=>w.id===a.work_item_id)!;if(work.status==='done')fail(409,'Accepted work and its reviewed version are immutable.');
  if(data.decision==='approved'){
   if(!data.technicalQc)fail(400,'Approval requires explicit technical QC of the actual referenced media.','STUDIO_QC_REQUIRED');
   const s=(await client.query('SELECT frame_start,frame_end,handles FROM studio_shots WHERE company_id=$1 AND project_id=$2 AND id=$3',[actor.companyId,projectId,work.shotId])).rows[0];
   const m=a.metadata;if(m.frameStart>Math.max(0,s.frame_start-s.handles)||m.frameEnd<s.frame_end+s.handles)fail(409,'This version does not cover the shot and required handles.','STUDIO_SPEC_MISMATCH');
   if(m.width!==p.spec.width||m.height!==p.spec.height||m.fpsNumerator*p.spec.fpsDenominator!==p.spec.fpsNumerator*m.fpsDenominator||m.colorSpace!==p.spec.colorSpace)fail(409,'Version metadata does not match the approved project specification.','STUDIO_SPEC_MISMATCH');
  }
  if(Number((await client.query('SELECT count(*) FROM studio_reviews WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count)>=1000)fail(409,'This project reached its 1,000-review pilot limit.');
  const review=(await client.query('INSERT INTO studio_reviews(company_id,project_id,artifact_id,decision,note,technical_qc,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,artifact_id AS "artifactId",decision,note,technical_qc AS "technicalQc",reviewed_by AS "reviewedBy",created_at AS "createdAt"',[actor.companyId,projectId,a.id,data.decision,data.note,data.technicalQc,actor.userId])).rows[0];
  await activity(client,actor,'studio.version_reviewed','An independent administrator recorded a media-version review.');return {review,project:await bump(client,actor.companyId,projectId)};
 });
}
async function prepareDelivery(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioDeliveryInput,input);return requestOnce(client,actor,data.clientId,'delivery:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.status==='delivered')fail(409,'This project already has recorded client acceptance.');if(p.gates.production?.decision!=='approved')fail(409,'Production authorization is required.','STUDIO_GATE_REQUIRED');
  const detail=await studioProjectDetail(client,actor.companyId,projectId);if(detail.workItems.some(w=>w.stage!=='delivery'&&w.status!=='done'))fail(409,'All production work needs independent task acceptance before packaging.','STUDIO_WORK_INCOMPLETE');
  const selected=data.artifactIds.map(artifactId=>detail.artifacts.find(a=>a.id===artifactId));if(selected.some(a=>!a))fail(404,'A selected artifact is not in this project.');
  for(const artifact of selected){if(artifact!.reviewStatus!=='approved'||detail.artifacts.some(a=>a.workItemId===artifact!.workItemId&&a.version>artifact!.version))fail(409,'Delivery can include only the latest approved versions.','STUDIO_VERSION_UNAPPROVED');if(artifact!.format!==p.spec.format)fail(409,'A delivery version does not match the required delivery format.','STUDIO_SPEC_MISMATCH');}
  const finalWorkIds=detail.workItems.filter(w=>w.stage==='qc').flatMap(w=>w.dependencies);
  if(finalWorkIds.some(w=>!selected.some(a=>a!.workItemId===w)))fail(409,'Include the latest approved final production version for every shot.','STUDIO_DELIVERY_INCOMPLETE');
  if(Number((await client.query('SELECT count(*) FROM studio_deliveries WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count)>=100)fail(409,'This project reached its delivery-package limit.');
  const manifest={schemaVersion:1,project:{id:p.id,name:p.name,clientName:p.clientName,spec:p.spec,revision:p.revision},generatedAt:new Date().toISOString(),preparedBy:actor.userId,transportStatus:'not_transferred',artifacts:selected,reviewReceipts:detail.reviews.filter(r=>selected.some(a=>a!.id===r.artifactId)),note:data.note};
  const delivery=(await client.query('INSERT INTO studio_deliveries(company_id,project_id,name,manifest,note,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,status,manifest,note,created_at AS "createdAt"',[actor.companyId,projectId,data.name,JSON.stringify(manifest),data.note,actor.userId])).rows[0];
  await client.query("UPDATE studio_projects SET status='delivery' WHERE company_id=$1 AND id=$2",[actor.companyId,projectId]);await activity(client,actor,'studio.delivery_prepared','An approved-version delivery manifest was prepared. Media transfer is a separate operation.');return {delivery,project:await bump(client,actor.companyId,projectId)};
 });
}
async function updateProject(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioProjectPatchInput,input);return requestOnce(client,actor,data.clientId,'update:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.status==='delivered')fail(409,'Create follow-up work for a delivered project.');
  if(data.brief!==undefined&&data.brief!==p.brief&&(await client.query("SELECT w.id FROM studio_work_items w JOIN tasks t ON t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=$2 AND t.status<>'todo' LIMIT 1",[actor.companyId,projectId])).rowCount)fail(409,'Work has begun against this brief. Create a follow-up project for a changed scope.','STUDIO_SCOPE_LOCKED');
  const invalidate=(data.brief!==undefined&&data.brief!==p.brief)||(data.aiPolicy!==undefined&&data.aiPolicy!==p.aiPolicy);
  await client.query("UPDATE studio_projects SET brief=$3,ai_policy=$4,due_date=$5,gates=CASE WHEN $6 THEN '{}'::jsonb ELSE gates END,status=CASE WHEN $6 THEN 'intake' ELSE status END WHERE company_id=$1 AND id=$2",[actor.companyId,projectId,data.brief??p.brief,data.aiPolicy??p.aiPolicy,data.dueDate===undefined?p.dueDate:data.dueDate,invalidate]);
  await activity(client,actor,'studio.project_updated',invalidate?'The client brief or AI-use policy changed; business approvals require review again.':'The project delivery date was updated.');return {project:await bump(client,actor.companyId,projectId)};
 });
}
export async function dispatchWork(client:PoolClient,member:Membership,projectId:string,input:unknown){
 const data=parse(studioDispatchInput,input),actor={companyId:member.companyId,userId:member.userId};
 return requestOnce(client,actor,data.clientId,'dispatch:'+projectId,data,async()=>{
  const preview=(await client.query('SELECT w.task_id,w.role_key,w.execution,b.agent_id FROM studio_work_items w JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3',[member.companyId,projectId,data.workItemId])).rows[0];if(!preview)fail(404,'Studio work item not found.');if(!preview.agent_id)fail(409,'Assign and connect an agent to this role first.','STUDIO_AGENT_REQUIRED');
  const role=STUDIO_TEMPLATES[0].roles.find(r=>r.key===preview.role_key)!;
  const prompt=`Act as ${role.title} in this company. Read studio_get with projectId ${projectId} and workItemId ${data.workItemId} for current task ${preview.task_id}, role assignments, dependencies and the curated skills ${role.skills.join(', ')} before acting. Continue that existing task; do not create a duplicate. If all current permissions and gates allow, reserve it with tasks_claim using its current revision, ${preview.execution==='dcc'?'Read studio_execution_get for approved connector profiles and existing jobs. If actual verified outputs already exist, report their exact job IDs and hashes; register only a real accessible media reference matching those files before submitting for review. Otherwise propose one bounded job with studio_execution_submit, then stop while human approval and the connector handle execution. A proposed or queued job is not a rendered result.':'Prepare the requested production-planning contribution and submit with tasks_submit for independent human review.'} Do not approve work, execute shell commands, transfer files, contact clients, promise prices or deploy compute. Stop and report any missing input or authority. Return a short status report with the task ID and actual committed state.`;
  // Lock agent/run before project, matching the leased-tool lock order. Any
  // gate or competing-dispatch failure rolls back this ordinary run creation.
  const queued=await createAgentRunInTransaction(client,member,'commons',{clientId:data.clientId,agentId:preview.agent_id,prompt});
  const p=await lockedProject(client,member.companyId,projectId,data.revision),work=(await workItems(client,member.companyId,p)).find(w=>w.id===data.workItemId)!;
  if(work.agentId!==preview.agent_id)fail(409,'The role assignment changed. Refresh before dispatch.');
  if(work.execution==='human')fail(409,'This step requires a human production or quality handoff.','STUDIO_EXTERNAL_EXECUTION_REQUIRED');
  if(work.execution==='dcc'&&!queued.run.capabilities.includes('studio.execute'))fail(409,'The specialist needs an explicitly reviewed studio.execute grant to propose connector work.','STUDIO_AGENT_CAPABILITIES');
  const completedDcc=work.execution==='dcc'&&work.status==='doing'&&!work.blockedReason&&(!work.runStatus||['succeeded','failed','cancelled'].includes(work.runStatus))&&(await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND work_item_id=$2 AND status IN ('succeeded','failed','failed_uncertain','cancelled') LIMIT 1",[member.companyId,work.id])).rowCount;
  if(work.readiness!=='ready'&&!completedDcc)fail(409,work.blockedReason??'This work is already running or awaiting review.','STUDIO_WORK_BLOCKED');
  if(work.execution==='dcc'&&(await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND work_item_id=$2 AND status IN ('awaiting_approval','queued','running') LIMIT 1",[member.companyId,work.id])).rowCount)fail(409,'Review or finish the pending connector job before requesting another specialist pass.','EXECUTION_ALREADY_PENDING');
  if(['studio.read','studio.write','tasks.write'].some(cap=>!queued.run.capabilities.includes(cap)))fail(409,'The assigned bridge needs explicitly approved studio.read, studio.write and tasks.write capabilities.','STUDIO_AGENT_CAPABILITIES');
  if((await client.query("SELECT d.run_id FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND r.status IN ('queued','running')",[member.companyId,projectId,work.id])).rowCount)fail(409,'This work already has a queued or running agent request.','STUDIO_ALREADY_DISPATCHED');
  await client.query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[member.companyId,projectId,work.id,queued.run.id]);
  await activity(client,actor,'studio.work_dispatched','Production work was queued for its assigned specialist. Connector execution requires a separately approved job.');return {run:queued.run,project:await bump(client,member.companyId,projectId)};
 });
}
export async function studioRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio')return null;
 const member=await requireMembership(request,id(parts[1]),method!=='GET'),actor:StudioActor={companyId:member.companyId,userId:member.userId};
 if(parts.length===3&&method==='GET'){
  const params=new URL(request.url).searchParams,keys=[...params.keys()];if(new Set(keys).size!==keys.length||keys.some(k=>!['after','limit'].includes(k)))fail(400,'Unsupported or duplicate studio query parameter.');
  const pagination=parse(z.object({after:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}),Object.fromEntries(params));
  return json(await memberMutation(member,false,client=>studioSnapshot(client,actor.companyId,pagination.after,pagination.limit)));
 }
 if(parts[3]==='setup'&&parts.length===4&&method==='POST'){const data=await body(request,studioSetupInput,24000);const result=await memberMutation(member,true,client=>setupStudio(client,actor,data));return json(result,result.replayed?200:201);}
 if(parts[3]!=='projects')return null;
 if(parts.length===4&&method==='POST'){const data=await body(request,studioProjectInput,256*1024);const result=await memberMutation(member,true,client=>createStudioProject(client,actor,data));return json(result,result.replayed?200:201);}
 const projectId=id(parts[4]);
 if(parts.length===5&&method==='GET')return json(await memberMutation(member,false,client=>studioProjectDetail(client,actor.companyId,projectId)));
 if(parts.length===5&&method==='PATCH'){const data=await body(request,studioProjectPatchInput,16000);const result=await memberMutation(member,true,client=>updateProject(client,actor,projectId,data));return json(result);}
 if(parts.length===6&&method==='POST'){
  if(parts[5]==='dispatch'){const data=await body(request,studioDispatchInput);const result=await memberMutation(member,true,client=>dispatchWork(client,member,projectId,data));return json(result,result.replayed?200:201);}
  const entry={gates:{schema:studioGateInput,run:recordGate},artifacts:{schema:studioArtifactInput,run:registerStudioArtifact},reviews:{schema:studioReviewInput,run:recordReview},deliveries:{schema:studioDeliveryInput,run:prepareDelivery}}[parts[5]];
  if(!entry)return null;const data=await body(request,entry.schema as z.ZodType,24000);const result=await memberMutation(member,true,client=>entry.run(client,actor,projectId,data));return json(result,result.replayed?200:201);
 }
 return null;
}
