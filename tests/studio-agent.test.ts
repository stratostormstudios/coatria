import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {AGENT_TOOLS,studioAgentProject,studioAgentSnapshot} from '../src/lib/agent-tools';
import {AGENT_CAPABILITIES} from '../src/lib/agent-policy';
import {PLUGIN_CATALOG} from '../src/lib/plugin-catalog';
import {pluginInstallInput} from '../src/lib/plugin-marketplace';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {handleApi} from '../src/lib/api';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {studioSetupInput,studioProjectInput,studioProjectPatchInput,studioDispatchInput,studioGateInput,studioArtifactInput,studioReviewInput,studioDeliveryInput} from '../src/lib/studio-protocol';

const plan={name:'Synthetic studio project',clientName:'Fixture client',brief:'Prepare a governed two-frame compositing plan.',spec:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'ACEScg'},shots:[{code:'SH010',description:'Synthetic plate with a reviewed composite.',frameStart:1001,frameEnd:1002,disciplines:['compositing']}]} as const;
const artifact={projectId:randomUUID(),revision:1,workItemId:randomUUID(),name:'Fixture composite',url:'https://example.invalid/fixture.exr',sha256:'a'.repeat(64),frameStart:1001,frameEnd:1002,width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,colorSpace:'ACEScg',format:'exr'};

test('studio tools advertise separate read/write scopes without expanding installation defaults',()=>{
 for(const name of ['studio_templates','studio_get','studio_company_plan']){assert.equal(AGENT_TOOLS[name].capability,'studio.read');assert.equal(AGENT_TOOLS[name].mutating,false);}
 for(const name of ['studio_plan','studio_artifact_register']){assert.equal(AGENT_TOOLS[name].capability,'studio.write');assert.equal(AGENT_TOOLS[name].mutating,true);}
 for(const forbidden of ['studio_approve','studio_deliver','studio_render','studio_agent_install','studio_skill_export'])assert.equal(AGENT_TOOLS[forbidden],undefined);
 for(const plugin of PLUGIN_CATALOG){assert(plugin.capabilities.includes('studio.read'));assert(plugin.capabilities.includes('studio.write'));}
 const installed=pluginInstallInput.parse({clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Fixture worker',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8'}});
 assert.deepEqual(installed.capabilities,[]);assert.equal(installed.invocationAccess,'none');
});

test('studio schemas forbid caller identity, embedded approval and executable commands',()=>{
 for(const[name,args]of [['studio_templates',{}],['studio_get',{}],['studio_company_plan',{templateId:'vfx-boutique',teamSize:12}],['studio_plan',plan],['studio_artifact_register',artifact]]as const){
  assert(AGENT_TOOLS[name].schema.safeParse(args).success,name);
  for(const extra of [{companyId:randomUUID()},{agentId:randomUUID()},{clientId:randomUUID()},{status:'approved'},{approved:true},{command:'render fixture'},{apiKey:'fixture-no-real-key'}])assert.equal(AGENT_TOOLS[name].schema.safeParse({...args,...extra}).success,false,name);
 }
 assert.equal(AGENT_TOOLS.studio_artifact_register.schema.safeParse({...artifact,frameEnd:1000}).success,false);
 assert.equal(AGENT_TOOLS.studio_artifact_register.schema.safeParse({...artifact,url:'https://user:password@example.invalid/file.exr'}).success,false);
 assert.equal(AGENT_TOOLS.studio_plan.schema.safeParse({...plan,shots:[plan.shots[0],{...plan.shots[0],code:'sh010'}]}).success,false);
});

test('studio OpenAPI retains leases and explicitly disclaims agent approval authority',()=>{
 const spec:any=agentRuntimeOpenApi;
 for(const name of ['studio_templates','studio_get','studio_company_plan','studio_plan','studio_artifact_register']){
  const operation=spec.paths['/api/agent/tools/'+name].post;assert.deepEqual(operation.security,[{agentBearer:[]}]);
  const schema=operation.requestBody.content['application/json'].schema;assert(schema.required.includes('runId'));assert(schema.required.includes('leaseToken'));assert(schema.required.includes('requestId'));assert.equal(schema.additionalProperties,false);
  if(AGENT_TOOLS[name].capability==='studio.write'){assert.deepEqual(operation['x-coatria-requester-roles'],['owner','admin']);assert.equal(operation['x-coatria-approval-authority'],false);assert.match(operation.description,/never approve/);}
 }
});

test('human studio administration uses the shared strict schemas and never accepts agent credentials for approval or worker dispatch',()=>{
 const spec:any=agentRuntimeOpenApi,base='/api/companies/{companyId}/studio',project=base+'/projects/{projectId}';
 for(const[path,method,schema]of [[base+'/setup','post',studioSetupInput],[base+'/projects','post',studioProjectInput],[project,'patch',studioProjectPatchInput],[project+'/dispatch','post',studioDispatchInput],[project+'/gates','post',studioGateInput],[project+'/artifacts','post',studioArtifactInput],[project+'/reviews','post',studioReviewInput],[project+'/deliveries','post',studioDeliveryInput]]as const){
  const operation=spec.paths[path][method],body=operation.requestBody.content['application/json'].schema;
  assert.deepEqual(body,z.toJSONSchema(schema,{io:'input',unrepresentable:'any'}) as any);assert.equal(body.additionalProperties,false);assert(body.required.includes('clientId'));
  assert.deepEqual(operation.security,[{sessionCookie:[]}]);assert.deepEqual(operation['x-coatria-roles'],['owner','admin']);assert(operation.parameters.some((parameter:any)=>parameter.name==='Origin'&&parameter.in==='header'&&parameter.required));
  for(const key of ['apiKey','token','command','script','companyId','approvedBy'])assert.equal(key in body.properties,false);
 }
 for(const path of[base,project])assert.deepEqual(spec.paths[path].get.security,[{sessionCookie:[]}]);
 const work=spec.components.schemas.StudioWorkItem;assert(work.properties.readiness.enum.includes('queued'));assert.deepEqual(work.properties.runId.anyOf,[{type:'string',format:'uuid'},{type:'null'}]);
 assert.match(spec.paths[project+'/deliveries'].post.description,/does not transfer files/);assert.match(spec.paths[base+'/setup'].post.summary,/without creating workers/);
 const gate=spec.components.schemas.StudioProject.properties.gates.additionalProperties;assert.equal(gate.properties.deliveryId.format,'uuid');assert(!gate.required.includes('deliveryId'));
});

test('project context pages preserve all work and explicit artifact details without oversized model responses',()=>{
 const shotIds=Array.from({length:100},()=>randomUUID());
 const detail:any={project:{id:randomUUID(),name:'Bounded project',revision:1,brief:'b'.repeat(12000),gates:{},spec:plan.spec},roles:[],skills:[],
  shots:shotIds.map((id,index)=>({id,code:'SH'+index,description:'d'.repeat(2000),frameStart:1001,frameEnd:1002})),
  workItems:Array.from({length:200},(_,index)=>({id:randomUUID(),taskId:randomUUID(),title:'Work '+index,shotId:shotIds[Math.floor(index/2)],dependencies:[],status:'todo',readiness:'ready',submissionSummary:'s'.repeat(12000)})),
  artifacts:Array.from({length:75},(_,index)=>({...artifact,id:randomUUID(),name:'Version '+index,version:75-index,createdAt:new Date().toISOString(),reviewStatus:'pending',notes:'artifact details '+index+' '+'.'.repeat(4000)})),
  reviews:[],deliveries:Array.from({length:75},()=>({id:randomUUID(),name:'Manifest',status:'prepared',manifest:{payload:'not-in-summary'},note:'not-in-summary'}))};
 const original=JSON.stringify(detail),seen:string[]=[];let after:string|undefined;
 for(let index=0;index<201;index++){
  const page:any=studioAgentProject(detail,{limit:100,after});assert(Buffer.byteLength(JSON.stringify(page))<=96*1024);assert(page.workItems.length>0&&page.workItems.length<=100);assert.equal(page.page.returned,page.workItems.length);
  const workShotIds=new Set(page.workItems.map((item:any)=>item.shotId));assert(page.shots.every((shot:any)=>workShotIds.has(shot.id)));assert(page.workItems.every((item:any)=>item.submissionSummary.length===12000));
  assert(page.artifacts.length<=50);assert.equal(page.projection.artifactsTruncated,true);assert(page.artifacts.every((item:any)=>!('url'in item)&&!('notes'in item)));assert(page.deliveries.every((item:any)=>!('manifest'in item)&&!('note'in item)));
  seen.push(...page.workItems.map((item:any)=>item.id));if(!page.hasMore){assert.equal(page.nextAfter,null);break;}assert.equal(page.nextAfter,page.workItems.at(-1).id);after=page.nextAfter;
 }
 assert.deepEqual(seen,detail.workItems.map((item:any)=>item.id).sort((a:string,b:string)=>a.localeCompare(b)));assert.equal(new Set(seen).size,200);assert.equal(JSON.stringify(detail),original);
 const exact:any=studioAgentProject(detail,{artifactId:detail.artifacts[55].id});assert.deepEqual(exact.artifact,detail.artifacts[55]);assert.equal(exact.contentInspectedByThisResponse,false);
 assert.throws(()=>studioAgentProject(detail,{after:randomUUID()}),{status:404});assert.throws(()=>studioAgentProject(detail,{artifactId:randomUUID()}),{status:404});
 assert.equal(AGENT_TOOLS.studio_get.schema.safeParse({artifactId:randomUUID()}).success,false);assert.equal(AGENT_TOOLS.studio_get.schema.safeParse({projectId:randomUUID(),artifactId:randomUUID(),after:randomUUID()}).success,false);
});

test('exact studio work lookup bypasses large-project pages while preserving current dependency state and tenant-local selectors',()=>{
 const workItems=Array.from({length:900},(_,index)=>({id:randomUUID(),taskId:randomUUID(),title:'Work '+index,stage:'compositing',shotId:null,dependencies:[] as string[],status:index%2?'review':'done',readiness:index%2?'review':'accepted',blockedReason:null,revision:index+1,submissionSummary:'Sensitive full contribution '+index})).sort((a,b)=>a.id.localeCompare(b.id));
 const target=workItems.at(-1)!;target.dependencies=workItems.slice(0,100).map(item=>item.id);
 const detail:any={project:{id:randomUUID(),name:'Large project',brief:plan.brief,gates:{},spec:plan.spec,revision:1},roles:[],skills:[],shots:[],workItems,artifacts:[],reviews:[],deliveries:[]},before=JSON.stringify(detail);
 const first:any=studioAgentProject(detail,{limit:50});assert(!first.workItems.some((item:any)=>item.id===target.id));
 const exact:any=studioAgentProject(detail,{workItemId:target.id});assert.deepEqual(exact.workItem,target);assert.equal(exact.dependencies.length,100);assert(exact.dependencies.some((item:any)=>item.readiness==='review'));assert(exact.dependencies.some((item:any)=>item.readiness==='accepted'));assert(exact.dependencies.every((item:any)=>!('submissionSummary'in item)));assert.equal(exact.projection.exactWorkItem,true);assert.equal(exact.projection.dependenciesAreSummaries,true);assert(Buffer.byteLength(JSON.stringify(exact))<=96*1024);assert.equal(JSON.stringify(detail),before);
 assert.throws(()=>studioAgentProject(detail,{workItemId:randomUUID()}),{status:404});assert.throws(()=>studioAgentProject(detail,{workItemId:target.id,after:workItems[0].id}),{status:400});
 for(const args of[{workItemId:target.id},{projectId:detail.project.id,workItemId:target.id,artifactId:randomUUID()},{projectId:detail.project.id,workItemId:target.id,after:randomUUID()}])assert.equal(AGENT_TOOLS.studio_get.schema.safeParse(args).success,false);
 assert(AGENT_TOOLS.studio_get.schema.safeParse({projectId:detail.project.id,workItemId:target.id}).success);
});

test('studio overview returns explicit project summaries and preserves full records',()=>{
 const deliveryId=randomUUID(),snapshot:any={templates:[],skills:[],profile:null,projects:[{id:randomUUID(),name:'Summary',brief:'full private project brief',gates:{brief:{decision:'approved',note:'full review note',recordedBy:randomUUID(),at:new Date().toISOString()},client_acceptance:{decision:'approved',note:'Acceptance evidence',recordedBy:randomUUID(),at:new Date().toISOString(),deliveryId}}}],hasMore:true,nextAfter:null};
 const original=JSON.stringify(snapshot),view=studioAgentSnapshot(snapshot);assert.equal(view.projectsAreSummaries,true);assert.equal(view.hasMore,true);assert.equal(view.nextAfter,snapshot.projects[0].id);assert(!('brief'in view.projects[0]));assert(!('note'in view.projects[0].gates.brief));assert.equal(view.projects[0].briefAvailableInProjectDetail,true);assert.equal(JSON.stringify(snapshot),original);
 assert.equal(view.projects[0].gates.client_acceptance.deliveryId,deliveryId);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',connection=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('studio agent APIs retain grant snapshots, requester authority, receipts and tenant boundaries',{skip:!emulate&&!connection,timeout:120000},async t=>{
 process.env.DATABASE_URL=connection;process.env.DATABASE_POOL_MAX='1';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const companyId=randomUUID(),foreignId=randomUUID(),foreignProjectId=randomUUID(),agentId=randomUUID(),token='ca_'+randomUUID(),users={owner:randomUUID(),admin:randomUUID(),member:randomUUID(),outsider:randomUUID()},sessions={owner:randomUUID(),admin:randomUUID(),member:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180';let runId='',leaseToken='';
 type Actor=keyof typeof users|'agent';
 async function call(path:string,method='GET',payload?:unknown,actor:Actor='agent',expected=200){const headers:Record<string,string>=actor==='agent'?{Authorization:'Bearer '+token}:{Cookie:'coatria_session='+sessions[actor],Origin:origin};if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;}
 const tool=(name:string,args:unknown,expected=200,requestId=randomUUID())=>call('agent/tools/'+name,'POST',{runId,leaseToken,requestId,arguments:args},'agent',expected);
 async function start(actor:'admin'|'member'='admin'){
  if(runId)await call(`companies/${companyId}/agent-runs/${runId}/cancel`,'POST',{},'owner');
  const created=await call(`companies/${companyId}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId,prompt:'Inspect and draft synthetic studio records only.'},actor,201);runId=created.run.id;
  const lease=await call('agent/runs/claim','POST',{workerId:'studio-agent-fixture',claimId:randomUUID()});assert.equal(lease.run.id,runId);leaseToken=lease.leaseToken;
 }
 try{
  for(const[name,userId]of Object.entries(users))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','fixture']);
  for(const[id,name]of [[companyId,'Studio fixture'],[foreignId,'Foreign fixture']])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')",[id,name,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[companyId,users.owner,users.admin,users.member,foreignId,users.outsider]);
  await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'vfx-boutique',1,$2)",[companyId,users.owner]);
  await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'vfx-boutique',1,$2)",[foreignId,users.outsider]);
  await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Foreign project','Other client','Not shared',$3,'unknown',$4)",[foreignProjectId,foreignId,JSON.stringify(plan.spec),users.outsider]);
  for(const[name,userId]of Object.entries(users))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),userId]);
  await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Studio worker','custom',$3,$4,'members',$5)",[agentId,companyId,hashToken(token),users.owner,JSON.stringify(['workspace.read','tasks.write'])]);
  await query("INSERT INTO skills(user_id,title,content) VALUES($1,'Private technique','UNSHARED_PRIVATE_STUDIO_SKILL')",[users.admin]);
  await t.test('existing tokens and existing runs do not acquire new studio grants',async()=>{
   const before=await call('agent/tools');assert(!before.tools.some((entry:any)=>entry.name.startsWith('studio_')));await start();await tool('studio_templates',{},403);
   await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agentId,JSON.stringify(AGENT_CAPABILITIES)]);
   await tool('studio_templates',{},403);assert((await call('agent/tools')).tools.some((entry:any)=>entry.name==='studio_templates'));
  });
  await t.test('an ordinary member cannot borrow the administrator sponsor to plan or register artifacts',async()=>{
   await start('member');await tool('studio_plan',plan,403);await tool('studio_artifact_register',artifact,403);
   assert.equal((await query('SELECT count(*)::int AS count FROM agent_tool_receipts WHERE run_id=$1',[runId])).rows[0].count,0);
  });
  await t.test('read-only structure blueprints create no workers or missions and reveal no private skills',async()=>{
   const before=(await query('SELECT count(*)::int AS count FROM agents WHERE company_id=$1',[companyId])).rows[0].count;
   const template=await tool('studio_templates',{}),blueprint=await tool('studio_company_plan',{templateId:'vfx-boutique',teamSize:12}),snapshot=await tool('studio_get',{});
   assert.equal(blueprint.result.createsWorkers,false);assert.equal(blueprint.result.requiresAdministratorApplication,true);assert(!JSON.stringify([template,blueprint,snapshot]).includes('UNSHARED_PRIVATE_STUDIO_SKILL'));
   assert.equal((await query('SELECT count(*)::int AS count FROM agents WHERE company_id=$1',[companyId])).rows[0].count,before);assert.equal((await query('SELECT count(*)::int AS count FROM agent_missions WHERE company_id=$1',[companyId])).rows[0].count,0);
   await tool('studio_get',{projectId:randomUUID()},404);await tool('studio_get',{projectId:foreignProjectId},404);await tool('studio_get',{companyId:foreignId},400);
  });
  await t.test('historical tool receipts replay with legacy defaults and reject a changed production template',async()=>{
   await start();
   const canonical=(value:any):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
   const staffing={brief:'Plan a synthetic production company.',teamSize:2,disciplines:['compositing'],provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8'}}};
   const before=(await query('SELECT (SELECT count(*) FROM studio_projects WHERE company_id=$1)::int AS projects,(SELECT count(*) FROM studio_staffing_proposals WHERE company_id=$1)::int AS proposals',[companyId])).rows[0];
   for(const[name,input,field,legacy,changed]of [['studio_plan',plan,'productionPath','vfx','higgsfield'],['studio_staffing_propose',staffing,'templateId','vfx-boutique','ai-production']]as const){
    const requestId=randomUUID(),args=AGENT_TOOLS[name].schema.parse(input) as Record<string,unknown>;delete args[field];
    const hash=createHash('sha256').update(canonical({tool:name,runId,arguments:args})).digest('hex'),response={historicalReceipt:randomUUID()};
    await query('INSERT INTO agent_tool_receipts(company_id,agent_id,run_id,request_id,tool,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,agentId,runId,requestId,name,hash,JSON.stringify(response)]);
    for(const submitted of [input,{...input,[field]:legacy}]){const replay=await tool(name,submitted,200,requestId);assert.equal(replay.replayed,true);assert.deepEqual(replay.result,response);}
    await tool(name,{...input,[field]:changed},409,requestId);
    const stored=(await query('SELECT request_hash,response FROM agent_tool_receipts WHERE company_id=$1 AND agent_id=$2 AND request_id=$3',[companyId,agentId,requestId])).rows[0];assert.equal(stored.request_hash,hash);assert.deepEqual(stored.response,response);
   }
   assert.deepEqual((await query('SELECT (SELECT count(*) FROM studio_projects WHERE company_id=$1)::int AS projects,(SELECT count(*) FROM studio_staffing_proposals WHERE company_id=$1)::int AS proposals',[companyId])).rows[0],before);
  });
  await t.test('draft creation is receipted and a demoted requester cannot replay an authorized write',async()=>{
   await start();const requestId=randomUUID(),created=await tool('studio_plan',plan,200,requestId),replay=await tool('studio_plan',plan,200,requestId);assert.equal(replay.replayed,true);assert.deepEqual(replay.result,created.result);
   const projectId=created.result.project.id,workItemId=(await query('SELECT id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 LIMIT 1',[companyId,projectId])).rows[0].id;
   assert.equal((await tool('studio_get',{projectId,workItemId})).result.workItem.id,workItemId);await tool('studio_get',{projectId,workItemId:randomUUID()},404);await tool('studio_get',{projectId:foreignProjectId,workItemId},404);
   await tool('studio_plan',{...plan,name:'Changed draft'},409,requestId);
   assert.equal((await query("SELECT count(*)::int AS count FROM agent_tool_receipts WHERE run_id=$1 AND tool='studio_plan'",[runId])).rows[0].count,1);
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companyId,users.admin]);
   await tool('studio_plan',plan,403,requestId);await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[companyId,users.admin]);
   await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agentId,JSON.stringify(['studio.read'])]);await tool('studio_plan',plan,403,requestId);
   await call(`companies/${companyId}/agent-runs/${runId}/cancel`,'POST',{},'owner');await tool('studio_get',{},409);
  });
 }finally{
  try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[companyId,foreignId]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[Object.values(users)]);}finally{await database().end();await stop?.();}
 }
});
