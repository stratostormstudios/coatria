import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {body,fail,id,json} from './security';
import {STUDIO_TEMPLATES,STUDIO_SKILLS,STUDIO_DISCIPLINES,getStudioTemplate,studioSetupInput,studioProjectInput,studioVersionedProjectInput,studioProjectPatchInput,studioDispatchInput,studioArtifactInput,studioGateInput,studioReviewInput,studioDeliveryInput,type StudioProject,type StudioRole,type StudioWorkItem,type StudioProjectDetail,type StudioSnapshot,type StudioGeneratedProject,type StudioGeneratedShot,type StudioGeneratedProjectDetail,type StudioReadableProject,type StudioReadableProjectDetail,type StudioReadableSnapshot} from './studio-protocol';
import {studioGeneratedProjectInput,studioGeneratedSpecInput,studioGeneratedWorkUnitInput,studioGeneratedArtifactRegisterInput} from './studio-generated-protocol';
import {recordGeneratedStudioReview,prepareGeneratedStudioDelivery,assertGeneratedStudioTaskArtifact} from './studio-generated-review';
import {createAgentRunInTransaction} from './agent-runs';
import {studioCreativeFollowupSnapshot,dispatchStudioCreativeFollowup} from './studio-creative-followup';
import {studioCreativeFollowupInput} from './studio-creative-followup-protocol';
import {generatedRoundScope,assertGeneratedWorkCurrent,assertGeneratedDeliveryCurrent} from './studio-generated-rounds';

export type StudioActor={companyId:string;userId:string;agentId?:string;runId?:string;agentSponsorId?:string};
const projectColumns=`id,contract_version AS "contractVersion",name,client_name AS "clientName",brief,production_path AS "productionPath",due_date::text AS "dueDate",spec,ai_policy AS "aiPolicy",revision,status,gates,created_at AS "createdAt",updated_at AS "updatedAt"`;
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)fail(400,result.error.issues.map(i=>i.message).join(' '));return result.data;};
function canonical(v:unknown):string{return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,w])=>JSON.stringify(k)+':'+canonical(w)).join(',')+'}':JSON.stringify(v);}
type StoredStudioProject=Omit<StudioProject,'spec'|'contractVersion'>&{contractVersion:number;spec:unknown};
function projectDto(row:StoredStudioProject):StudioReadableProject{
 const {contractVersion,...legacy}=row;
 if(contractVersion===1)return {...legacy,spec:parse(studioProjectInput.shape.spec,row.spec)};
 if(contractVersion!==2||row.productionPath!=='higgsfield')fail(409,'This project contract is unsupported.','STUDIO_CONTRACT_UNSUPPORTED');
 const spec=studioGeneratedSpecInput.safeParse(row.spec);if(!spec.success)fail(409,'The generated project specification is invalid.','STUDIO_GENERATED_EVIDENCE_INVALID');
 return {...legacy,contractVersion:2,productionPath:'higgsfield',spec:spec.data};
}
function supportsContract(project:StudioReadableProject,contractVersion:1|2){if(project.contractVersion===2&&contractVersion!==2)fail(409,'Read this generated-media project with contractVersion=2.','STUDIO_CONTRACT_UNSUPPORTED');}
async function requestOnce<T>(client:PoolClient,actor:StudioActor,clientId:string,operation:string,data:unknown,run:()=>Promise<T>):Promise<T&{replayed:boolean}>{
 const actorKey=actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId,hash=createHash('sha256').update(canonical({operation,data})).digest('hex');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-request:${actor.companyId}:${actorKey}:${clientId}`]);
 const old=(await client.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,actorKey,clientId])).rows[0];
 if(old){if(old.request_hash!==hash)fail(409,'This request ID belongs to a different studio operation.','IDEMPOTENCY_CONFLICT');return {...old.response,replayed:true};}
 const result=await run();await client.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.companyId,actorKey,clientId,hash,JSON.stringify(result)]);return {...result,replayed:false};
}
async function activity(client:PoolClient,actor:StudioActor,kind:string,description:string){await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[actor.companyId,actor.userId,kind,description]);}
async function lockedProject(client:PoolClient,companyId:string,projectId:string,revision?:number){
 const row=(await client.query<StoredStudioProject>(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,projectId])).rows[0];
 if(!row)fail(404,'Studio project not found.');const p=projectDto(row);if(revision!==undefined&&p.revision!==revision)fail(409,'The project changed. Refresh before continuing.','STUDIO_REVISION_CONFLICT');return p;
}
async function bump(client:PoolClient,companyId:string,projectId:string){return projectDto((await client.query<StoredStudioProject>(`UPDATE studio_projects SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING ${projectColumns}`,[companyId,projectId])).rows[0]);}
async function studioRoles(client:PoolClient,companyId:string,productionPath?:StudioProject['productionPath']):Promise<StudioRole[]>{
 const profile=(await client.query('SELECT template_id FROM studio_profiles WHERE company_id=$1',[companyId])).rows[0],companyTemplate=profile?getStudioTemplate(profile.template_id):undefined;
 if(!companyTemplate)fail(409,'Apply a supported studio template before accessing its role structure.','STUDIO_SETUP_REQUIRED');
 const template=productionPath==='higgsfield'?getStudioTemplate('ai-production')!:companyTemplate;
 const rows=(await client.query(`SELECT b.role_key,b.agent_id,b.human_id,a.name AS agent_name,u.name AS human_name,CASE WHEN a.id IS NULL THEN NULL WHEN a.status<>'active' THEN a.status WHEN a.expires_at<=clock_timestamp() THEN 'expired' WHEN a.last_seen_at>clock_timestamp()-interval '2 minutes' THEN 'recent_contact' ELSE 'not_connected' END AS connection_state FROM studio_role_bindings b LEFT JOIN agents a ON a.company_id=b.company_id AND a.id=b.agent_id LEFT JOIN users u ON u.id=b.human_id WHERE b.company_id=$1`,[companyId])).rows;
 return template.roles.map(role=>{const row=rows.find(r=>r.role_key===role.key);return {...role,skills:[...role.skills],agentId:row?.agent_id??null,humanId:row?.human_id??null,agentName:row?.agent_name,humanName:row?.human_name,connectionState:row?.connection_state};});
}
export function studioSnapshot(client:PoolClient,companyId:string,after?:string,limit?:number,contractVersion?:1):Promise<StudioSnapshot>;
export function studioSnapshot(client:PoolClient,companyId:string,after:string|undefined,limit:number,contractVersion:2):Promise<StudioReadableSnapshot>;
export function studioSnapshot(client:PoolClient,companyId:string,after:string|undefined,limit:number,contractVersion:1|2):Promise<StudioReadableSnapshot>;
export async function studioSnapshot(client:PoolClient,companyId:string,after?:string,limit=50,contractVersion:1|2=1):Promise<StudioReadableSnapshot>{
 if(after&&!(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 AND contract_version<=$3',[companyId,after,contractVersion])).rowCount)fail(404,'Studio cursor not found.');
 const p=(await client.query('SELECT template_id AS "templateId",revision FROM studio_profiles WHERE company_id=$1',[companyId])).rows[0];
 const revisionWorkScope=contractVersion===2?" AND (p.contract_version=1 OR NOT EXISTS(SELECT 1 FROM studio_generated_revision_rounds rr WHERE rr.company_id=w.company_id AND rr.project_id=w.project_id) OR EXISTS(SELECT 1 FROM studio_generated_revision_work rw WHERE rw.company_id=w.company_id AND rw.project_id=w.project_id AND rw.work_item_id=w.id AND rw.round_id=(SELECT rr.id FROM studio_generated_revision_rounds rr WHERE rr.company_id=w.company_id AND rr.project_id=w.project_id ORDER BY rr.number DESC LIMIT 1)))":'';
 const projects=(await client.query<StoredStudioProject>(`SELECT ${projectColumns},(SELECT count(*)::int FROM studio_shots s WHERE s.company_id=$1 AND s.project_id=p.id) AS "shotCount",(SELECT count(*)::int FROM studio_work_items w WHERE w.company_id=$1 AND w.project_id=p.id${revisionWorkScope}) AS "workCount",(SELECT count(*)::int FROM studio_work_items w JOIN tasks t ON t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=p.id AND t.status='done'${revisionWorkScope}) AS "acceptedCount" FROM studio_projects p WHERE company_id=$1 AND contract_version<=$4 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[companyId,after??null,limit+1,contractVersion])).rows.map(projectDto);
 return {templates:STUDIO_TEMPLATES,skills:STUDIO_SKILLS,profile:p?{templateId:p.templateId,revision:p.revision,roles:await studioRoles(client,companyId)}:null,projects:projects.slice(0,limit),hasMore:projects.length>limit,nextAfter:projects.length>limit?projects[limit-1].id:null};
}
export async function setupStudio(client:PoolClient,actor:StudioActor,input:unknown){
 if(actor.agentId)fail(403,'An administrator must apply the company structure.');const data=parse(studioSetupInput,input),template=getStudioTemplate(data.templateId)!;
 return requestOnce(client,actor,data.clientId,'setup',data,async()=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-profile:${actor.companyId}`]);
  const current=(await client.query('SELECT revision,template_id FROM studio_profiles WHERE company_id=$1 FOR UPDATE',[actor.companyId])).rows[0];if((current?.revision??0)!==data.revision)fail(409,'The studio structure changed. Refresh before applying.','STUDIO_REVISION_CONFLICT');
  if(current&&current.template_id!==data.templateId&&(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 LIMIT 1',[actor.companyId])).rowCount)fail(409,'Existing projects retain their company role structure. Create a separate studio to change its template.','STUDIO_TEMPLATE_IN_USE');
  // Role changes serialize with every studio authority check. Only pending task
  // ownership changes below; active/submitted work must be reconciled first.
  const previous=(await client.query('SELECT role_key,agent_id,human_id FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR UPDATE',[actor.companyId])).rows;
  for(const old of previous){
   const next=data.assignments.find(a=>a.roleKey===old.role_key);
   if(old.agent_id===(next?.agentId??null)&&old.human_id===(next?.humanId??null))continue;
   if((await client.query("SELECT w.id FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.role_key=$2 AND (EXISTS(SELECT 1 FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id WHERE d.company_id=w.company_id AND d.work_item_id=w.id AND r.status IN ('queued','running')) OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.company_id=t.company_id AND r.id=t.agent_run_id AND r.status IN ('queued','running'))) LIMIT 1",[actor.companyId,old.role_key])).rowCount)fail(409,'Cancel active requests and reconcile their tasks before changing this role assignment.','STUDIO_ROLE_BUSY');
   if((await client.query("SELECT w.id FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.role_key=$2 AND t.status IN ('doing','review') LIMIT 1",[actor.companyId,old.role_key])).rowCount)fail(409,'Accept submitted work or reset it to todo before changing this role assignment. Existing contributor attribution must be preserved.','STUDIO_ROLE_BUSY');
  }
  for(const binding of data.assignments){
   if(!template.roles.some(r=>r.key===binding.roleKey))fail(400,'Unknown studio role.');
   if(binding.roleKey==='qc'&&binding.agentId)fail(400,'Quality review must be assigned to a current human owner or administrator, or left unassigned.','STUDIO_QC_HUMAN_REQUIRED');
   if(binding.agentId&&!(await client.query("SELECT id FROM agents WHERE company_id=$1 AND id=$2 AND status<>'revoked'",[actor.companyId,binding.agentId])).rowCount)fail(400,'Choose an agent in this company.');
   if(binding.humanId){const member=(await client.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role<>'removed'",[actor.companyId,binding.humanId])).rows[0];if(!member)fail(400,'Choose a current company member.');if(binding.roleKey==='qc'&&!['owner','admin'].includes(member.role))fail(400,'Quality review requires a current human owner or administrator.','STUDIO_QC_HUMAN_REQUIRED');}
  }
  await client.query('INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(company_id) DO UPDATE SET template_id=EXCLUDED.template_id,template_version=EXCLUDED.template_version,revision=studio_profiles.revision+1,updated_at=clock_timestamp()',[actor.companyId,data.templateId,data.templateVersion,actor.userId]);
  // Explicit complete assignment snapshot; omitted roles are unassigned, not invented workers.
  for(const old of previous.filter(row=>!template.roles.some(role=>role.key===row.role_key)))await client.query('UPDATE studio_role_bindings SET agent_id=NULL,human_id=NULL WHERE company_id=$1 AND role_key=$2',[actor.companyId,old.role_key]);
  for(const role of template.roles){const b=data.assignments.find(a=>a.roleKey===role.key);await client.query('INSERT INTO studio_role_bindings(company_id,role_key,agent_id,human_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,role_key) DO UPDATE SET agent_id=EXCLUDED.agent_id,human_id=EXCLUDED.human_id',[actor.companyId,role.key,b?.agentId??null,b?.humanId??null]);}
  // An explicit structure save also repairs historical unassigned todo tasks.
  // Never rewrite submitted/accepted ownership or grant a human an agent lease.
  await client.query("UPDATE tasks t SET assignee_id=b.human_id,revision=t.revision+1,updated_at=clock_timestamp() FROM studio_work_items w JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE t.company_id=$1 AND w.company_id=t.company_id AND w.task_id=t.id AND t.status='todo' AND t.assignee_id IS DISTINCT FROM b.human_id",[actor.companyId]);
  await activity(client,actor,'studio.configured',`The ${template.name} structure and role assignments were configured.`);return {profile:(await studioSnapshot(client,actor.companyId)).profile};
 });
}
export async function createStudioProject(client:PoolClient,actor:StudioActor,input:unknown){
 const version=typeof input==='object'&&input!==null&&'contractVersion' in input?input.contractVersion:undefined;
 if(version!==undefined&&version!==2)fail(400,'Use an explicit contractVersion of 2 for generated media; omit it for legacy projects.','STUDIO_CONTRACT_UNSUPPORTED');
 const data=version===2?parse(studioGeneratedProjectInput,input):parse(studioProjectInput,input);
 const generated='contractVersion' in data;
 const {productionPath,...legacyRequest}=data;
 const result=await requestOnce(client,actor,data.clientId,'project',productionPath==='vfx'?legacyRequest:data,async()=>{
  const profile=(await client.query('SELECT template_id FROM studio_profiles WHERE company_id=$1 FOR UPDATE',[actor.companyId])).rows[0],template=profile?getStudioTemplate(profile.template_id):undefined;
  if(!template)fail(409,'Apply a studio structure before planning a project.','STUDIO_SETUP_REQUIRED');
  const bindings=(await client.query('SELECT b.role_key,b.human_id,b.agent_id,m.role AS member_role FROM studio_role_bindings b LEFT JOIN memberships m ON m.company_id=b.company_id AND m.user_id=b.human_id WHERE b.company_id=$1 ORDER BY b.role_key FOR SHARE OF b',[actor.companyId])).rows;
  for(const binding of bindings){if(binding.human_id&&(!binding.member_role||binding.member_role==='removed'))fail(409,'A studio role is assigned to a person whose company access ended. Update the role assignment before creating project work.','STUDIO_ROLE_UNAVAILABLE');if(binding.role_key==='qc'&&(binding.agent_id||binding.human_id&&!['owner','admin'].includes(binding.member_role)))fail(409,'Update the quality-review role to an eligible human owner or administrator before creating project work.','STUDIO_QC_HUMAN_REQUIRED');}
  if(Number((await client.query('SELECT count(*) FROM studio_projects WHERE company_id=$1',[actor.companyId])).rows[0].count)>=200)fail(409,'This workspace has reached its 200-project pilot limit.');
  const p=projectDto((await client.query<StoredStudioProject>(`INSERT INTO studio_projects(company_id,name,client_name,brief,due_date,spec,ai_policy,created_by,created_agent_id,production_path,contract_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${projectColumns}`,[actor.companyId,data.name,data.clientName,data.brief,data.dueDate,JSON.stringify(data.spec),data.aiPolicy,actor.userId,actor.agentId??null,data.productionPath,generated?2:1])).rows[0]);
  const add=async(key:string,title:string,stage:string,roleKey:string,execution:string,shotId:string|null,deps:string[])=>{
   if(!template.roles.some(r=>r.key===roleKey))fail(409,'This company template does not include a required project role. Choose a compatible project path.','STUDIO_TEMPLATE_ROLE_REQUIRED');
   const role=(p.productionPath==='higgsfield'?getStudioTemplate('ai-production')!:template).roles.find(r=>r.key===roleKey)!;
   const skillKeys=[...new Set([...role.skills,...(stage==='references'?['creative-references']:execution==='creative'?['higgsfield-production']:[])])];
   const description=`Studio project ${p.name}. Production path: ${p.productionPath}. Role: ${roleKey}. Stage: ${stage}. Skills: ${skillKeys.join(', ')}. Read studio_get${generated?' with contractVersion:2':''} for current brief, dependencies and skill instructions. ${execution==='dcc'?'Requires an artist or approved DCC connector and an actual versioned media artifact. A written report is not rendered media.':execution==='creative'?'Use the official company Higgsfield connection to prepare an exact task-bound generation request for administrator credit approval. Requires actual versioned media before submission; a generation observation or text report is insufficient. No DCC or shell execution.':execution==='human'?'Requires a human production/review handoff.':stage==='references'?'Prepare approved reference identities, rights, intended use and explicit missing-input notes. Indexed paths do not provide bytes or upload references.':'Prepare a reviewable production contribution.'} Never bypass project gates or accept your own work.`;
   const task=(await client.query('INSERT INTO tasks(company_id,title,description,created_by,created_agent_id,assignee_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[actor.companyId,title,description,actor.userId,actor.agentId??null,bindings.find(binding=>binding.role_key===roleKey)?.human_id??null])).rows[0];
   if(actor.agentId)await client.query('INSERT INTO task_authors(task_id,user_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',[task.id,[...new Set([actor.userId,actor.agentSponsorId??actor.userId])]]);
   const w=(await client.query('INSERT INTO studio_work_items(company_id,project_id,shot_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[actor.companyId,p.id,shotId,key,task.id,stage,roleKey,execution])).rows[0];
   for(const dep of deps)await client.query('INSERT INTO studio_dependencies(company_id,project_id,work_item_id,predecessor_id) VALUES($1,$2,$3,$4)',[actor.companyId,p.id,w.id,dep]);return w.id as string;
  };
  const estimate=await add('estimate',`${p.name} · Scope & estimate`,'estimate','producer','agent',null,[]);
  const breakdown=await add('breakdown',`${p.name} · Shot breakdown & schedule`,'breakdown','coordinator','agent',null,[estimate]);const finals:string[]=[];
  const roleFor:Record<string,string>={prep:'prep',matchmove:'prep',layout:'cg',animation:'cg',fx:'fx',lighting:'lighting',compositing:'comp'};
  for(const shot of data.shots){
   const s='kind' in shot?(await client.query('INSERT INTO studio_shots(company_id,project_id,code,description,media_kind,duration_min_ms,duration_max_ms,frame_start,frame_end,handles,disciplines) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,\'[]\') RETURNING id',[actor.companyId,p.id,shot.code,shot.description,shot.kind,shot.kind==='image'?null:shot.durationMs.min,shot.kind==='image'?null:shot.durationMs.max])).rows[0]:(await client.query('INSERT INTO studio_shots(company_id,project_id,code,description,frame_start,frame_end,handles,disciplines) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[actor.companyId,p.id,shot.code,shot.description,shot.frameStart,shot.frameEnd,shot.handles,JSON.stringify(shot.disciplines)])).rows[0];
   let previous:string;
   if(p.productionPath==='higgsfield'){
    previous=await add(`${shot.code}:references`,`${shot.code} · References & provenance`,'references','ingest','agent',s.id,[breakdown]);
    previous=await add(`${shot.code}:generation`,`${shot.code} · Higgsfield generation`,'generation','comp','creative',s.id,[previous]);
   }else{
    if('kind' in shot)fail(409,'Generated media cannot enter DCC production.','STUDIO_CONTRACT_UNSUPPORTED');
    previous=await add(`${shot.code}:ingest`,`${shot.code} · Media ingest`,'ingest','ingest','human',s.id,[breakdown]);
    for(const discipline of STUDIO_DISCIPLINES.filter(d=>shot.disciplines.includes(d)))previous=await add(`${shot.code}:${discipline}`,`${shot.code} · ${discipline}`,discipline,roleFor[discipline],'dcc',s.id,[previous]);
   }
   finals.push(await add(`${shot.code}:qc`,`${shot.code} · Independent shot QC`,'qc','qc','human',s.id,[previous]));
  }
  await add('delivery',`${p.name} · Package & delivery handoff`,'delivery','delivery','human',null,finals);
  await activity(client,actor,'studio.project_planned',`A studio project was planned with ${data.shots.length} shots and explicit production dependencies.`);return {project:p};
 });
 // Historical idempotency receipts predate this field; keep their committed
 // project identity while projecting the same backward-compatible VFX path.
 return {...result,project:{...result.project,productionPath:result.project.productionPath??'vfx'}};
}
async function workItems(client:PoolClient,companyId:string,project:StudioReadableProject):Promise<StudioWorkItem[]>{
 await client.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[companyId]);
 const rows=(await client.query(`SELECT w.id,w.task_id AS "taskId",w.shot_id AS "shotId",w.stage,w.role_key AS "roleKey",w.execution,t.title,t.description,t.status,t.revision,t.submission_summary AS "submissionSummary",t.approved_by AS "approvedBy",t.approved_agent_id AS "approvedAgentId",t.machine_review_id AS "machineReviewId",latest.run_id AS "runId",latest.run_status AS "runStatus",b.agent_id AS "agentId",b.human_id AS "humanId",COALESCE((SELECT jsonb_agg(d.predecessor_id ORDER BY d.predecessor_id) FROM studio_dependencies d WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id),'[]') AS dependencies FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key LEFT JOIN LATERAL (SELECT d.run_id,r.status AS run_status FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id ORDER BY d.created_at DESC,d.run_id DESC LIMIT 1) latest ON true WHERE w.company_id=$1 AND w.project_id=$2 ORDER BY w.id`,[companyId,project.id])).rows;
 const statuses=new Map(rows.map(w=>[w.id,w.status]));
 return rows.map(w=>{
  let blockedReason:string|null=null;if(project.gates.brief?.decision!=='approved')blockedReason='Client brief approval is required.';
  else if(!['estimate','breakdown'].includes(w.stage)&&project.gates.production?.decision!=='approved')blockedReason='Production authorization is required.';
  else if(w.dependencies.some((dep:string)=>statuses.get(dep)!=='done'))blockedReason='An upstream task still needs independent acceptance.';
  else if(w.execution==='creative'&&project.aiPolicy!=='allowed')blockedReason='Higgsfield generation requires the client AI-use policy to allow AI media production.';
  else if(project.aiPolicy==='restricted'&&w.execution==='dcc'&&w.agentId)blockedReason='AI use is restricted. Assign an authorized human for media work.';
  const {description,...fields}=w;
  return {...fields,...project.contractVersion===2?{description}:{},readiness:w.status==='done'?'accepted':w.status==='review'?'review':blockedReason?'blocked':w.runStatus==='queued'?'queued':w.status==='doing'||w.runStatus==='running'?'running':'ready',blockedReason} as StudioWorkItem;
 });
}
export async function studioGeneratedShots(client:PoolClient,companyId:string,projectId:string):Promise<StudioGeneratedShot[]>{
 const rows=(await client.query<{id:string;code:string;description:string;media_kind:string;duration_min_ms:number|null;duration_max_ms:number|null}>('SELECT id,code,description,media_kind,duration_min_ms,duration_max_ms FROM studio_shots WHERE company_id=$1 AND project_id=$2 ORDER BY code',[companyId,projectId])).rows;
 return rows.map(row=>{const parsed=studioGeneratedWorkUnitInput.safeParse({kind:row.media_kind,code:row.code,description:row.description,...row.media_kind==='image'?{}:{durationMs:{min:row.duration_min_ms,max:row.duration_max_ms}}});if(!parsed.success)fail(409,'A generated deliverable has invalid requirements.','STUDIO_GENERATED_EVIDENCE_INVALID');return {id:row.id,...parsed.data};});
}
export function studioProjectDetail(client:PoolClient,companyId:string,projectId:string,contractVersion?:1):Promise<StudioProjectDetail>;
export function studioProjectDetail(client:PoolClient,companyId:string,projectId:string,contractVersion:2):Promise<StudioReadableProjectDetail>;
export function studioProjectDetail(client:PoolClient,companyId:string,projectId:string,contractVersion:1|2):Promise<StudioReadableProjectDetail>;
export async function studioProjectDetail(client:PoolClient,companyId:string,projectId:string,contractVersion:1|2=1):Promise<StudioReadableProjectDetail>{
 const row=(await client.query<StoredStudioProject>(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2`,[companyId,projectId])).rows[0];if(!row)fail(404,'Studio project not found.');
 const project=projectDto(row);supportsContract(project,contractVersion);
 if(project.contractVersion===2){
  const shots=await studioGeneratedShots(client,companyId,projectId);
  if(shots.some(shot=>shot.kind!==project.spec.kind))fail(409,'Generated deliverables disagree with their project specification.','STUDIO_GENERATED_EVIDENCE_INVALID');
  const {loadStoredGeneratedArtifacts}=await import('./studio-generated-artifacts');
  const ids=(await client.query<{id:string}>('SELECT id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1000',[companyId,projectId])).rows;
  const artifacts=(await loadStoredGeneratedArtifacts(client,companyId,projectId,ids.map(artifact=>artifact.id))).map(stored=>stored.artifact);
  const reviews=(await client.query('SELECT 2 AS "contractVersion",r.id,r.artifact_id AS "artifactId",r.decision,r.note,r.technical_qc AS "technicalQc",r.reviewed_by AS "reviewedBy",r.created_at AS "createdAt",e.spec_sha256 AS "specSha256",e.manifest_sha256 AS "manifestSha256",e.attestation_version AS "attestationVersion",e.technical_match AS "technicalMatch" FROM studio_reviews r JOIN studio_generated_review_evidence e ON e.company_id=r.company_id AND e.project_id=r.project_id AND e.review_id=r.id WHERE r.company_id=$1 AND r.project_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1000',[companyId,projectId])).rows;
  const deliveries=(await client.query('SELECT d.id,d.name,d.status,d.manifest,d.note,d.created_at AS "createdAt",r.id AS "roundId",COALESCE(r.number,0) AS "roundNumber" FROM studio_deliveries d LEFT JOIN studio_generated_delivery_rounds m ON m.company_id=d.company_id AND m.project_id=d.project_id AND m.delivery_id=d.id LEFT JOIN studio_generated_revision_rounds r ON r.company_id=m.company_id AND r.project_id=m.project_id AND r.id=m.round_id WHERE d.company_id=$1 AND d.project_id=$2 ORDER BY d.created_at DESC,d.id DESC LIMIT 100',[companyId,projectId])).rows;
  const roles=await studioRoles(client,companyId,project.productionPath),skillKeys=new Set(roles.flatMap(role=>role.skills));
  const generatedRound=await generatedRoundScope(client,companyId,projectId),allWork=await workItems(client,companyId,project),activeIds=new Set(generatedRound.workItemIds);
  return {project,shots,workItems:allWork.filter(work=>activeIds.has(work.id)),historyWorkItems:allWork.filter(work=>!activeIds.has(work.id)),generatedRound,artifacts,reviews,deliveries,roles,skills:STUDIO_SKILLS.filter(skill=>skillKeys.has(skill.key))};
 }
 const shots=(await client.query('SELECT id,code,description,frame_start AS "frameStart",frame_end AS "frameEnd",handles,disciplines FROM studio_shots WHERE company_id=$1 AND project_id=$2 ORDER BY code',[companyId,projectId])).rows;
 const artifacts=(await client.query(`SELECT a.id,a.work_item_id AS "workItemId",a.name,a.version,a.url,a.sha256,a.metadata,a.produced_by AS "producedBy",a.produced_agent_id AS "producedAgentId",a.created_at AS "createdAt",COALESCE((SELECT r.decision FROM studio_reviews r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.artifact_id=a.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'pending') AS "reviewStatus" FROM studio_artifacts a WHERE a.company_id=$1 AND a.project_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 1000`,[companyId,projectId])).rows.map(a=>{const {metadata,...rest}=a;return {...rest,...metadata};});
 const reviews=(await client.query('SELECT id,artifact_id AS "artifactId",decision,note,technical_qc AS "technicalQc",reviewed_by AS "reviewedBy",created_at AS "createdAt" FROM studio_reviews WHERE company_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1000',[companyId,projectId])).rows;
 const deliveries=(await client.query('SELECT id,name,status,manifest,note,created_at AS "createdAt" FROM studio_deliveries WHERE company_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[companyId,projectId])).rows;
 const roles=await studioRoles(client,companyId,project.productionPath),skillKeys=new Set(roles.flatMap(role=>role.skills));
 return {project,shots,workItems:await workItems(client,companyId,project),artifacts,reviews,deliveries,roles,skills:STUDIO_SKILLS.filter(skill=>skillKeys.has(skill.key))} as StudioProjectDetail;
}
export async function registerStudioArtifact(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioArtifactInput,input);return requestOnce(client,actor,data.clientId,'artifact:'+projectId,data,async()=>{
  const project=await lockedProject(client,actor.companyId,projectId,data.revision);if(project.contractVersion===2)fail(409,'Register generated media using its verified archive on the generated-artifacts endpoint.','STUDIO_CONTRACT_UNSUPPORTED');if(project.status==='delivered')fail(409,'Delivered projects are immutable. Create follow-up work.');
  const work=(await workItems(client,actor.companyId,project)).find(w=>w.id===data.workItemId);if(!work)fail(404,'Work item not found.');if(!['dcc','creative'].includes(work.execution))fail(400,'Register media against a VFX, CG or creative generation work item.');
  if(work.status==='done')fail(409,'Accepted work is immutable. Create follow-up work for a new version.');if(work.blockedReason)fail(409,work.blockedReason,'STUDIO_WORK_BLOCKED');
  if(actor.agentId){if(project.aiPolicy!=='allowed')fail(403,'This project does not authorize agent processing of media.','STUDIO_AI_RESTRICTED');if(work.agentId!==actor.agentId)fail(403,'Only the assigned specialist may register this media artifact.');const t=(await client.query('SELECT agent_run_id FROM tasks WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,work.taskId])).rows[0];if(t.agent_run_id!==actor.runId)fail(403,'Reserve the production task for this run first.');
   if(work.execution==='creative'){
    const authority=(await client.query('SELECT a.capabilities AS agent_capabilities,r.capabilities AS run_capabilities FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id AND r.id=$3 WHERE a.company_id=$1 AND a.id=$2',[actor.companyId,actor.agentId,actor.runId])).rows[0];
    if(!authority||['creative.read','creative.write'].some(cap=>!authority.agent_capabilities.includes(cap)||!authority.run_capabilities.includes(cap)))fail(403,'Creative media work requires explicitly approved creative.read and creative.write grants.','AGENT_CAPABILITY_REQUIRED');
   }
  }
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
 if(project.contractVersion===2)await assertGeneratedWorkCurrent(client,companyId,project.id,work.id);
 if(project.status==='delivered')fail(409,'Delivered project work is immutable.');
 if(agent){
  if(!agent.capabilities?.includes('studio.write')||!run?.capabilities?.includes('studio.write'))fail(403,'This studio work requires an explicitly approved studio.write grant.','AGENT_CAPABILITY_REQUIRED');
  if(work.agentId!==agent.id)fail(403,'The studio role must be assigned to this agent before it can perform this work.','STUDIO_ROLE_REQUIRED');
  if(work.execution==='human')fail(403,'This stage requires a human production or quality handoff.','STUDIO_HUMAN_REQUIRED');
  if(['dcc','creative'].includes(work.execution)&&project.aiPolicy!=='allowed')fail(403,'This project does not authorize agent processing of media.','STUDIO_AI_RESTRICTED');
  if(work.execution==='creative'&&['creative.read','creative.write'].some(cap=>!agent.capabilities?.includes(cap)||!run?.capabilities?.includes(cap)))fail(403,'Creative media work requires explicitly approved creative.read and creative.write grants.','AGENT_CAPABILITY_REQUIRED');
 }
 if(!agent&&name==='human_update'&&(await client.query("SELECT r.id FROM agent_runs r WHERE r.company_id=$1 AND r.status IN ('queued','running') AND (r.id IN (SELECT d.run_id FROM studio_dispatches d WHERE d.company_id=$1 AND d.work_item_id=$2) OR r.id=(SELECT t.agent_run_id FROM tasks t WHERE t.company_id=$1 AND t.id=$3)) LIMIT 1",[companyId,work.id,taskId])).rowCount)fail(409,'Cancel or finish the active agent request before editing its studio task.','STUDIO_RUN_ACTIVE');
 if(work.blockedReason)fail(409,work.blockedReason,'STUDIO_WORK_BLOCKED');
 if(['dcc','creative'].includes(work.execution)&&(name==='tasks_submit'||args.status==='review'||args.status==='done')){
  if(project.contractVersion===2){await assertGeneratedStudioTaskArtifact(client,companyId,project.id,work.id,args.status==='done');return;}
  const artifact=(await client.query(`SELECT a.id,COALESCE((SELECT r.decision FROM studio_reviews r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.artifact_id=a.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'pending') AS decision FROM studio_artifacts a WHERE a.company_id=$1 AND a.project_id=$2 AND a.work_item_id=$3 ORDER BY a.version DESC LIMIT 1`,[companyId,project.id,work.id])).rows[0];
  if(!artifact)fail(409,'Register an actual versioned media reference before submitting this production task. A text result is insufficient.','STUDIO_ARTIFACT_REQUIRED');
  if(args.status==='done'&&artifact.decision!=='approved')fail(409,'The latest media version needs independent technical review before task acceptance.','STUDIO_ARTIFACT_REVIEW_REQUIRED');
 }
}
async function recordGate(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioGateInput,input);return requestOnce(client,actor,data.clientId,'gate:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.contractVersion===2&&data.gate==='client_acceptance')fail(409,'Only the designated authenticated external client can respond to a generated delivery invitation.','STUDIO_GENERATED_CLIENT_IDENTITY_REQUIRED');if(p.status==='delivered')fail(409,'Client acceptance is already recorded; create follow-up work for changes.');
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
 const data=parse(studioReviewInput,input);const result=await requestOnce(client,actor,data.clientId,'review:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.status==='delivered')fail(409,'Delivered review history is closed.');
  if(p.contractVersion===2){const result=await recordGeneratedStudioReview(client,actor,p,data);await activity(client,actor,'studio.version_reviewed','An independent administrator reviewed the exact verified generated-media version.');return {...result,project:await bump(client,actor.companyId,projectId)};}
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
 const current=await lockedProject(client,actor.companyId,projectId);if(current.contractVersion===2){const artifact=(await client.query('SELECT work_item_id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND id=$3',[actor.companyId,projectId,data.artifactId])).rows[0];if(!artifact)fail(404,'Artifact not found.');await assertGeneratedWorkCurrent(client,actor.companyId,projectId,artifact.work_item_id);}
 return result;
}
async function prepareDelivery(client:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const data=parse(studioDeliveryInput,input);const result=await requestOnce(client,actor,data.clientId,'delivery:'+projectId,data,async()=>{
  const p=await lockedProject(client,actor.companyId,projectId,data.revision);if(p.status==='delivered')fail(409,'This project already has recorded client acceptance.');if(p.gates.production?.decision!=='approved')fail(409,'Production authorization is required.','STUDIO_GATE_REQUIRED');
  if(p.contractVersion===2){const result=await prepareGeneratedStudioDelivery(client,actor,p,data);await activity(client,actor,'studio.delivery_prepared','An internal generated-media package manifest was prepared; files have not been transferred to the client.');return {...result,project:await bump(client,actor.companyId,projectId)};}
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
 const current=await lockedProject(client,actor.companyId,projectId);if(current.contractVersion===2)await assertGeneratedDeliveryCurrent(client,actor.companyId,projectId,result.delivery.id);
 return result;
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
 const result=await requestOnce(client,actor,data.clientId,'dispatch:'+projectId,data,async()=>{
  const preview=(await client.query('SELECT w.task_id,w.role_key,w.stage,w.execution,b.agent_id,p.template_id,project.production_path,project.contract_version FROM studio_work_items w JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key JOIN studio_profiles p ON p.company_id=w.company_id JOIN studio_projects project ON project.company_id=w.company_id AND project.id=w.project_id WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3',[member.companyId,projectId,data.workItemId])).rows[0];if(!preview)fail(404,'Studio work item not found.');if(!preview.agent_id)fail(409,'Assign and connect an agent to this role first.','STUDIO_AGENT_REQUIRED');
  const template=getStudioTemplate(preview.template_id);if(!template?.roles.some(role=>role.key===preview.role_key))fail(409,'The project role is not present in the current studio template.','STUDIO_TEMPLATE_ROLE_REQUIRED');
  const role=(preview.production_path==='higgsfield'?getStudioTemplate('ai-production')!:template).roles.find(r=>r.key===preview.role_key)!;
  const skills=[...new Set([...role.skills,...(preview.execution==='creative'?['higgsfield-production']:preview.stage==='references'?['creative-references']:[])])];
  const instruction=preview.execution==='dcc'?'Read studio_execution_get for approved connector profiles and existing jobs. If actual verified outputs already exist, report their exact job IDs and hashes; register only a real accessible media reference matching those files before submitting for review. Otherwise propose one bounded job with studio_execution_submit, then stop while human approval and the connector handle execution. A proposed or queued job is not a rendered result.':preview.execution==='creative'?`Read higgsfield_connection_get, higgsfield_requests_list and higgsfield_jobs_list for this project and the exact work item before proposing generation. Use only the discovered official Higgsfield tools through higgsfield_generation_propose, binding projectId ${projectId} and workItemId ${data.workItemId}. Review approved references and exact input schema; do not invent uploads or provider media IDs. Prepare one exact request for human credit approval, then stop while consent, approval and provider execution complete. Reuse existing requests and actual output versions; never automatically retry uncertain spending. Importing a job observation does not complete this task. Register an actual versioned media artifact with correct specification and provenance before tasks_submit for independent review. Never request a DCC job, shell command or workstation/server compute.`:preview.stage==='references'?'Prepare the exact shot reference plan, source provenance, rights and sharing-consent gaps; a storage listing is not access or a provider upload. Submit that reviewable planning contribution with tasks_submit for independent acceptance.':'Prepare the requested production-planning contribution and submit with tasks_submit for independent human review.';
  const prompt=`Act as ${role.title} in this company. Read studio_get${preview.contract_version===2?' with contractVersion:2 and':' with'} projectId ${projectId} and workItemId ${data.workItemId} for current task ${preview.task_id}, role assignments, dependencies and the curated skills ${skills.join(', ')} before acting. Continue that existing task; do not create a duplicate. If all current permissions and gates allow, reserve it with tasks_claim using its current revision. ${instruction} ${preview.contract_version===2?'For this contractVersion:2 project, use studio_generated_artifact_register with the exact verified archive ID; never register legacy frame references or invent frame ranges. ':''}Do not approve work, execute shell commands, transfer files, contact clients, promise prices or deploy compute. Stop and report any missing input or authority. Return a short status report with the task ID and actual committed state.`;
  // Lock agent/run before project, matching the leased-tool lock order. Any
  // gate or competing-dispatch failure rolls back this ordinary run creation.
  const queued=await createAgentRunInTransaction(client,member,'commons',{clientId:data.clientId,agentId:preview.agent_id,prompt});
  const p=await lockedProject(client,member.companyId,projectId,data.revision),work=(await workItems(client,member.companyId,p)).find(w=>w.id===data.workItemId)!;
  if(p.contractVersion===2)await assertGeneratedWorkCurrent(client,member.companyId,projectId,data.workItemId);
  if(work.agentId!==preview.agent_id)fail(409,'The role assignment changed. Refresh before dispatch.');
  if(work.execution==='human')fail(409,'This step requires a human production or quality handoff.','STUDIO_EXTERNAL_EXECUTION_REQUIRED');
  if(work.execution==='dcc'&&!queued.run.capabilities.includes('studio.execute'))fail(409,'The specialist needs an explicitly reviewed studio.execute grant to propose connector work.','STUDIO_AGENT_CAPABILITIES');
  if(work.execution==='creative'&&['creative.read','creative.write'].some(cap=>!queued.run.capabilities.includes(cap)))fail(409,'The generation specialist needs explicitly reviewed creative.read and creative.write grants.','STUDIO_AGENT_CAPABILITIES');
  const completedDcc=work.execution==='dcc'&&work.status==='doing'&&!work.blockedReason&&(!work.runStatus||['succeeded','failed','cancelled'].includes(work.runStatus))&&(await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND work_item_id=$2 AND status IN ('succeeded','failed','failed_uncertain','cancelled') LIMIT 1",[member.companyId,work.id])).rowCount;
  if(work.readiness!=='ready'&&!completedDcc)fail(409,work.blockedReason??'This work is already running or awaiting review.','STUDIO_WORK_BLOCKED');
  if(work.execution==='dcc'&&(await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND work_item_id=$2 AND status IN ('awaiting_approval','queued','running') LIMIT 1",[member.companyId,work.id])).rowCount)fail(409,'Review or finish the pending connector job before requesting another specialist pass.','EXECUTION_ALREADY_PENDING');
  if(['studio.read','studio.write','tasks.write'].some(cap=>!queued.run.capabilities.includes(cap)))fail(409,'The assigned bridge needs explicitly approved studio.read, studio.write and tasks.write capabilities.','STUDIO_AGENT_CAPABILITIES');
  if((await client.query("SELECT d.run_id FROM studio_dispatches d JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.run_id WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND r.status IN ('queued','running')",[member.companyId,projectId,work.id])).rowCount)fail(409,'This work already has a queued or running agent request.','STUDIO_ALREADY_DISPATCHED');
  await client.query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[member.companyId,projectId,work.id,queued.run.id]);
  await activity(client,actor,'studio.work_dispatched','Production work was queued for its assigned specialist. Connector execution requires a separately approved job.');return {run:queued.run,project:await bump(client,member.companyId,projectId)};
 });
 const current=await lockedProject(client,member.companyId,projectId);if(current.contractVersion===2)await assertGeneratedWorkCurrent(client,member.companyId,projectId,data.workItemId);
 return result;
}
export async function studioRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio')return null;
 const member=await requireMembership(request,id(parts[1]),method!=='GET'),actor:StudioActor={companyId:member.companyId,userId:member.userId};
 if(parts[3]==='projects'&&parts.length===6&&parts[5]==='creative-followup'){
  const projectId=id(parts[4]);if(!['owner','admin'].includes(member.role))fail(403,'A company administrator must review a generation handoff.');
  const supported=async(client:PoolClient)=>{const project=(await client.query('SELECT contract_version FROM studio_projects WHERE company_id=$1 AND id=$2',[member.companyId,projectId])).rows[0];if(!project)fail(404,'Studio project not found.');if(project.contract_version!==1)fail(409,'Generated-media follow-up needs a source-bound handoff contract.','STUDIO_CONTRACT_UNSUPPORTED');};
  if(method==='GET')return json(await memberMutation(member,true,async client=>{await supported(client);return studioCreativeFollowupSnapshot(client,member.companyId,projectId);}));
  if(method==='POST'){const data=await body(request,studioCreativeFollowupInput,5000),result=await memberMutation(member,true,async client=>{await supported(client);return dispatchStudioCreativeFollowup(client,member,projectId,data);});return json(result,result.replayed?200:201);}
 }
 if(parts.length===3&&method==='GET'){
  const params=new URL(request.url).searchParams,keys=[...params.keys()];if(new Set(keys).size!==keys.length||keys.some(k=>!['after','limit','contractVersion'].includes(k)))fail(400,'Unsupported or duplicate studio query parameter.');
  const pagination=parse(z.object({after:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50),contractVersion:z.literal('2').optional()}),Object.fromEntries(params));
  return json(await memberMutation(member,false,client=>studioSnapshot(client,actor.companyId,pagination.after,pagination.limit,pagination.contractVersion?2:1)));
 }
 if(parts[3]==='setup'&&parts.length===4&&method==='POST'){const data=await body(request,studioSetupInput,24000);const result=await memberMutation(member,true,client=>setupStudio(client,actor,data));return json(result,result.replayed?200:201);}
 if(parts[3]!=='projects')return null;
 if(parts.length===4&&method==='POST'){const data=await body(request,studioVersionedProjectInput,256*1024);const result=await memberMutation(member,true,client=>createStudioProject(client,actor,data));return json(result,result.replayed?200:201);}
 const projectId=id(parts[4]);
 if(parts.length===5&&method==='GET'){
  const params=new URL(request.url).searchParams,keys=[...params.keys()];if(new Set(keys).size!==keys.length||keys.some(key=>key!=='contractVersion'))fail(400,'Unsupported or duplicate project query parameter.');
  const options=parse(z.object({contractVersion:z.literal('2').optional()}),Object.fromEntries(params));
  return json(await memberMutation(member,false,client=>studioProjectDetail(client,actor.companyId,projectId,options.contractVersion?2:1)));
 }
 if(parts[5]==='generated-artifacts'){
  if(parts.length===6&&method==='POST'){
   const data=await body(request,studioGeneratedArtifactRegisterInput,12000),{registerStudioGeneratedArtifact}=await import('./studio-generated-artifacts');
   const result=await memberMutation(member,true,client=>registerStudioGeneratedArtifact(client,actor,projectId,data));return json(result,result.replayed?200:201);
  }
  if(parts.length===8&&parts[7]==='manifest'&&method==='GET'){
   const artifactId=id(parts[6]),{loadStoredGeneratedArtifact}=await import('./studio-generated-artifacts');
   const stored=await memberMutation(member,false,client=>loadStoredGeneratedArtifact(client,actor.companyId,projectId,artifactId));
   return new Response(stored.manifestText,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','ETag':`"${stored.manifestSha256}"`,'X-Content-SHA256':stored.manifestSha256,'X-Content-Type-Options':'nosniff'}});
  }
 }
 if(parts.length===5&&method==='PATCH'){const data=await body(request,studioProjectPatchInput,16000);const result=await memberMutation(member,true,client=>updateProject(client,actor,projectId,data));return json(result);}
 if(parts.length===6&&method==='POST'){
  if(parts[5]==='dispatch'){const data=await body(request,studioDispatchInput);const result=await memberMutation(member,true,client=>dispatchWork(client,member,projectId,data));return json(result,result.replayed?200:201);}
  const entry={gates:{schema:studioGateInput,run:recordGate},artifacts:{schema:studioArtifactInput,run:registerStudioArtifact},reviews:{schema:studioReviewInput,run:recordReview},deliveries:{schema:studioDeliveryInput,run:prepareDelivery}}[parts[5]];
  if(!entry)return null;const data=await body(request,entry.schema as z.ZodType,24000);const result=await memberMutation(member,true,client=>entry.run(client,actor,projectId,data));return json(result,result.replayed?200:201);
 }
 return null;
}
// Shared transaction seams for generated-media services. Callers keep the same
// tenant/actor authority, request lock, project lock and revision boundaries.
export {requestOnce as studioRequestOnce,lockedProject as lockedStudioProject,bump as bumpStudioProject,activity as studioActivity,workItems as studioWorkItems,studioRoles};
