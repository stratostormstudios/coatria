import {currentTaskPatchForFixture} from './task-fixture-revision';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {getStudioTemplate,planStudioCompany,studioProjectInput,studioProjectPatchInput,STUDIO_SKILLS,type StudioProjectDetail,type StudioWorkItem} from '../src/lib/studio-protocol';

const spec={width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'};
const input=(extra:Record<string,unknown>={})=>({clientId:randomUUID(),name:'Creative pipeline fixture',clientName:'Internal fixture',brief:'Prepare approved references and one independently reviewed synthetic creative version. No provider generation is executed by this test.',productionPath:'higgsfield',aiPolicy:'allowed',spec,shots:[{code:'SH010',description:'Synthetic shot',frameStart:1,frameEnd:120,handles:0,disciplines:['compositing']}],...extra});
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
test('Higgsfield projects and AI studio templates are explicit while omitted project paths remain VFX',()=>{
 assert.equal(studioProjectInput.parse(input()).productionPath,'higgsfield');
 const {productionPath:_,...legacy}=input();assert.equal(studioProjectInput.parse(legacy).productionPath,'vfx');
 assert(!studioProjectInput.safeParse(input({productionPath:'automatic'})).success);
 assert(!studioProjectPatchInput.safeParse({clientId:randomUUID(),revision:1,productionPath:'higgsfield'}).success);
 assert.equal(planStudioCompany({templateId:'ai-production'}).template.id,'ai-production');
 const template=getStudioTemplate('ai-production')!;assert.equal(template.version,1);assert.deepEqual(template.roles.map(role=>role.key),['producer','coordinator','supervisor','ingest','comp','qc','delivery']);
 for(const role of template.roles)assert(role.skills.every(key=>STUDIO_SKILLS.some(skill=>skill.key===key)));
 assert(template.roles.find(role=>role.key==='comp')!.skills.includes('higgsfield-production'));
 assert.equal(getStudioTemplate('unsupported'),undefined);assert.equal(getStudioTemplate('vfx-boutique')!.roles.length,11);
});

test('migration025 preserves existing VFX project/task/grant data and makes the chosen production path immutable',{timeout:120000},async()=>{
 const db=await PGlite.create();try{
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)&&Number(file.slice(0,3))<=24).sort())await db.exec(await readFile('database/'+file,'utf8'));
  const user=randomUUID(),company=randomUUID(),project=randomUUID(),agent=randomUUID(),task=randomUUID(),work=randomUUID();
  await db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Fixture','pipeline-migration@example.invalid','fixture')",[user]);
  await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Fixture','pipeline-migration','blank')",[company]);
  await db.query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,capabilities) VALUES($1,$2,'Fixture','custom',$3,$4,'[\"studio.read\"]')",[agent,company,'5'.repeat(64),user]);
  await db.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'vfx-boutique',1,$2)",[company,user]);
  await db.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Existing','Fixture','Existing VFX','{}','unknown',$3)",[project,company,user]);
  await db.query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Existing VFX task',$3)",[task,company,user]);
  await db.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'SH010:compositing',$4,'compositing','comp','dcc')",[work,company,project,task]);
  const beforeProject=(await db.query('SELECT * FROM studio_projects')).rows[0],beforeWork=(await db.query('SELECT * FROM studio_work_items')).rows,beforeTask=(await db.query('SELECT * FROM tasks')).rows,beforeAgent=(await db.query('SELECT * FROM agents')).rows;
  await db.exec(await readFile('database/025_studio_higgsfield_pipeline.sql','utf8'));
  const after=(await db.query<Record<string,unknown>>('SELECT * FROM studio_projects')).rows[0];assert.equal(after.production_path,'vfx');const{production_path:_,...rest}=after;assert.deepEqual(rest,beforeProject);
  assert.deepEqual((await db.query('SELECT * FROM studio_work_items')).rows,beforeWork);assert.deepEqual((await db.query('SELECT * FROM tasks')).rows,beforeTask);assert.deepEqual((await db.query('SELECT * FROM agents')).rows,beforeAgent);
  await assert.rejects(db.query("UPDATE studio_projects SET production_path='higgsfield' WHERE id=$1",[project]),(error:any)=>error.code==='23514');
  await db.query("UPDATE studio_projects SET production_path='vfx',brief='Reviewed scope update' WHERE id=$1",[project]);
  await assert.rejects(db.query("INSERT INTO studio_projects(company_id,name,client_name,brief,spec,ai_policy,created_by,production_path) VALUES($1,'Invalid','Fixture','Invalid','{}','unknown',$2,'shell')",[company,user]),(error:any)=>error.code==='23514');
 }finally{await db.close();}
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const safeIntegration=integration&&['localhost','127.0.0.1','[::1]'].includes(new URL(integration).hostname);
test('actual creative project APIs enforce the graph, finite dispatch, real artifact requirement and independent delivery review',{skip:!emulate&&!safeIntegration,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};process.env.DATABASE_URL=integration;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),outsider=randomUUID(),sessions={owner:randomUUID(),reviewer:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180',base=`companies/${company}/studio`;
 const agents:Record<string,{id:string;token:string;installationId:string}>={};let projectId='',parent:any,child:any,artifactId='';
 const oldFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Creative pipeline fixture must not contact a provider or storage server.');};
 async function call(path:string,method='GET',payload?:unknown,actor='owner',expected=200){payload=await currentTaskPatchForFixture(path,method,payload);const headers:Record<string,string>={Origin:origin};if(agents[actor])headers.Authorization='Bearer '+agents[actor].token;else if(actor in sessions)headers.Cookie='coatria_session='+sessions[actor as keyof typeof sessions];if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/'));const value=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(value)}`);return value;}
 const detail=async():Promise<StudioProjectDetail>=>call(`${base}/projects/${projectId}`);
 const work=async(stage:string)=>(await detail()).workItems.find(item=>item.stage===stage)!;
 const taskPath=(item:StudioWorkItem)=>`companies/${company}/tasks/${item.taskId}`;
 async function gate(key:string,extra:Record<string,unknown>={},expected=201){return call(`${base}/projects/${projectId}/gates`,'POST',{clientId:randomUUID(),revision:(await detail()).project.revision,gate:key,decision:'approved',note:'Fixture human attestation, no real client involved.',...extra},'owner',expected);}
 async function acceptHuman(item:StudioWorkItem){const qc=item.stage==='qc';await call(taskPath(item),'PATCH',{status:'review'},qc?'reviewer':'owner');await call(taskPath(item),'PATCH',{status:'done',reviewNote:'Independent fixture acceptance.'},qc?'owner':'reviewer');}
 async function tool(agent:string,lease:any,name:string,args:unknown,expected=200,requestId=randomUUID()){return call('agent/tools/'+name,'POST',{runId:lease.run.id,leaseToken:lease.leaseToken,requestId,arguments:args},agent,expected);}
 const artifact=async()=>({projectId,revision:(await detail()).project.revision,workItemId:(await work('generation')).id,name:'Synthetic actual-media reference',url:'https://media.example.invalid/creative.mp4',sha256:'ab'.repeat(32),frameStart:1,frameEnd:120,...spec,notes:'Synthetic metadata fixture only; no actual provider output or byte verification.'});
 try{
  for(const[user,name]of[[owner,'Owner'],[reviewer,'Independent reviewer'],[outsider,'Foreign owner']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,name,user+'@example.invalid','fixture']);
  for(const id of[company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Creative fixture',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($4,$5,'owner')",[company,owner,reviewer,foreign,outsider]);
  for(const[name,user]of Object.entries({owner,reviewer,outsider}))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),user]);
  for(const name of['coordinator','comp']){const installed=await call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name,invocationAccess:'admins',capabilities:['studio.read','studio.write','tasks.write'],runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}},'owner',201);agents[name]={id:installed.installation.agentId,token:installed.token,installationId:installed.installation.id};}
  await t.test('selected template creates seven actual role slots without workers or implicit creative grants',async()=>{
   const payload={clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'coordinator',agentId:agents.coordinator.id},{roleKey:'comp',agentId:agents.comp.id},{roleKey:'qc',humanId:reviewer}]};
   await call(base+'/setup','POST',{...payload,assignments:[{roleKey:'prep',agentId:agents.comp.id}]},'owner',400);
   const configured=await call(base+'/setup','POST',payload,'owner',201);assert.equal(configured.profile.templateId,'ai-production');assert.equal(configured.profile.roles.length,7);assert.equal(configured.profile.roles.find((role:any)=>role.key==='comp').title,'AI generation specialist');
   assert.equal((await call(base+'/setup','POST',payload)).replayed,true);assert.equal(Number((await query('SELECT count(*) FROM agents WHERE company_id=$1',[company])).rows[0].count),2);
   assert(!(await query('SELECT capabilities FROM agents WHERE id=$1',[agents.comp.id])).rows[0].capabilities.includes('creative.write'));
  });
  await t.test('immutable path builds the exact non-DCC graph and retains legacy defaults, tenant isolation and replay',async()=>{
   const payload=input(),created=await call(base+'/projects','POST',payload,'owner',201);projectId=created.project.id;assert.equal(created.project.productionPath,'higgsfield');
   const d=await detail();assert.equal(d.workItems.length,6);assert(!d.workItems.some(item=>item.execution==='dcc'));
   let predecessor:string|null=null;for(const[stage,execution,roleKey]of[['estimate','agent','producer'],['breakdown','agent','coordinator'],['references','agent','ingest'],['generation','creative','comp'],['qc','human','qc'],['delivery','human','delivery']]){const item=d.workItems.find(item=>item.stage===stage)!;assert(item);assert.equal(item.execution,execution);assert.equal(item.roleKey,roleKey);assert.deepEqual(item.dependencies,predecessor?[predecessor]:[]);predecessor=item.id;}
   assert.equal((await call(base+'/projects','POST',payload)).project.id,projectId);assert.equal((await detail()).workItems.length,6);
   await call(base+'/projects','POST',{...payload,productionPath:'vfx'},'owner',409);await call(`${base}/projects/${projectId}`,'PATCH',{clientId:randomUUID(),revision:1,productionPath:'vfx'},'owner',400);
   await call(`${base}/projects/${projectId}`,'GET',undefined,'outsider',404);
   await call(base+'/setup','POST',{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:1,assignments:[]},'owner',409);
   const {productionPath:_,...legacy}=input({name:'Backward-compatible VFX'});const vfx=await call(base+'/projects','POST',legacy,'owner',201);assert.equal(vfx.project.productionPath,'vfx');const vd=await call(`${base}/projects/${vfx.project.id}`);assert(vd.workItems.some((item:any)=>item.execution==='dcc'));assert(!vd.workItems.some((item:any)=>item.stage==='generation'));
   const historicalInput={...legacy,clientId:randomUUID()},parsed=studioProjectInput.parse(historicalInput),{productionPath:omitted,...historicalData}=parsed,{productionPath:oldAbsent,...historicalProject}=vfx.project;
   const historicalHash=createHash('sha256').update(canonical({operation:'project',data:historicalData})).digest('hex');
   await query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[company,'human:'+owner,historicalInput.clientId,historicalHash,JSON.stringify({project:historicalProject})]);
   const beforeRetry=Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[company])).rows[0].count),historicalReplay=await call(base+'/projects','POST',historicalInput);assert.equal(historicalReplay.replayed,true);assert.equal(historicalReplay.project.id,vfx.project.id);assert.equal(historicalReplay.project.productionPath,'vfx');assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[company])).rows[0].count),beforeRetry);
   await call(base+'/projects','POST',{...historicalInput,productionPath:'higgsfield'},'owner',409);
   const foreignBase=`companies/${foreign}/studio`;await call(foreignBase+'/setup','POST',{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:0},'outsider',201);
   const underLegacy=await call(foreignBase+'/projects','POST',input({name:'Creative path under an existing VFX company'}),'outsider',201),legacyDetail=await call(`${foreignBase}/projects/${underLegacy.project.id}`,'GET',undefined,'outsider');
   assert.equal((await call(foreignBase,'GET',undefined,'outsider')).profile.templateId,'vfx-boutique');assert(legacyDetail.roles.find((role:any)=>role.key==='comp').skills.includes('higgsfield-production'));assert(!legacyDetail.skills.some((skill:any)=>skill.key==='compositing'));assert(!legacyDetail.skills.some((skill:any)=>skill.key==='lighting-render'));
   const descriptions=(await query("SELECT t.description FROM studio_work_items w JOIN tasks t ON t.id=w.task_id WHERE w.project_id=$1 AND w.stage IN ('generation','references')",[underLegacy.project.id])).rows;
   assert(descriptions.some(row=>row.description.includes('higgsfield-production')));assert(descriptions.some(row=>row.description.includes('creative-references')));assert(!descriptions.some(row=>row.description.includes('Skills: compositing')||row.description.includes('Skills: media-ingest')));
  });
  await t.test('generation waits for business gates, accepted references, allowed AI policy and explicit grants',async()=>{
   const dispatch=async(expected=409)=>call(`${base}/projects/${projectId}/dispatch`,'POST',{clientId:randomUUID(),revision:(await detail()).project.revision,workItemId:(await work('generation')).id},'owner',expected);
   await dispatch();await gate('brief');await gate('estimate');await gate('production');
   await call(taskPath(await work('generation')),'PATCH',{status:'review'},'owner',409);
   for(const stage of['estimate','breakdown','references'])await acceptHuman(await work(stage));
   const denied=await dispatch();assert.equal(denied.code,'STUDIO_AGENT_CAPABILITIES');assert.equal(Number((await query('SELECT count(*) FROM studio_dispatches WHERE company_id=$1',[company])).rows[0].count),0);
   await call(`companies/${company}/plugin-installations/${agents.comp.installationId}`,'PATCH',{revision:1,capabilities:['studio.read','studio.write','tasks.write','creative.read','creative.write']});
   await call(`${base}/projects/${projectId}`,'PATCH',{clientId:randomUUID(),revision:(await detail()).project.revision,aiPolicy:'restricted'});await gate('brief');await gate('estimate');await gate('production');assert.equal((await work('generation')).readiness,'blocked');await dispatch();
   await call(`${base}/projects/${projectId}`,'PATCH',{clientId:randomUUID(),revision:(await detail()).project.revision,aiPolicy:'allowed'});await gate('brief');await gate('estimate');await gate('production');
  });
  await t.test('coordinator queues exactly one creative specialist under its existing finite policy',async()=>{
   const parentRun=await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:agents.coordinator.id,prompt:'Coordinate one synthetic creative production task.'},'owner',201);parent=await call('agent/runs/claim','POST',{workerId:'creative-coordinator',claimId:randomUUID()},'coordinator');assert.equal(parent.run.id,parentRun.run.id);
   const policyPath=`${base}/projects/${projectId}/coordination`;await call(policyPath,'PUT',{clientId:randomUUID(),revision:0,coordinatorAgentId:agents.coordinator.id,allowedRoleKeys:['comp'],status:'active',maxRuns:1,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+3600000).toISOString()});
   const d=await detail(),generation=d.workItems.find(item=>item.stage==='generation')!,args={projectId,workItemId:generation.id,projectRevision:d.project.revision,policyRevision:1};
   const queued=(await tool('coordinator',parent,'studio_work_dispatch',args)).result;assert.equal(queued.policy.runsStarted,1);assert.equal(queued.policy.effectiveStatus,'exhausted');assert.equal((await tool('coordinator',parent,'studio_work_dispatch',args)).result.childRunId,queued.childRunId);
   const run=(await query('SELECT prompt,max_attempts,capabilities FROM agent_runs WHERE id=$1',[queued.childRunId])).rows[0];assert.equal(run.max_attempts,1);assert(run.capabilities.includes('creative.write'));assert(!run.capabilities.includes('studio.execute'));assert.match(run.prompt,/higgsfield_connection_get/);assert.match(run.prompt,/higgsfield_generation_propose/);assert.match(run.prompt,/workItemId/);assert(!run.prompt.includes('studio_execution_submit'));
   child=await call('agent/runs/claim','POST',{workerId:'creative-specialist',claimId:randomUUID()},'comp');assert.equal(child.run.id,queued.childRunId);
   await tool('comp',child,'tasks_claim',{taskId:generation.taskId,revision:generation.revision});
   await tool('comp',child,'tasks_claim',{taskId:(await work('qc')).taskId,revision:(await work('qc')).revision},403);
  });
  await t.test('completed imported generation metadata is not media and cannot submit or approve the creative task',async()=>{
   const generation=await work('generation');const imported=(await tool('comp',child,'studio_generation_import',{projectId,revision:(await detail()).project.revision,workItemId:generation.id,providerJobId:randomUUID(),kind:'video',model:'synthetic-official-model',sourceTool:'jobs_wait',observedStatus:'completed',observedAt:new Date().toISOString(),outputs:[{kind:'video',mediaId:randomUUID()}]})).result;
   assert.equal(imported.receipt.providerVerified,false);assert.equal((await detail()).artifacts.length,0);assert.equal((await work('generation')).status,'doing');
   const denied=await tool('comp',child,'tasks_submit',{taskId:generation.taskId,revision:(await work('generation')).revision,summary:'Imported report alone cannot complete production.'},409);assert.equal(denied.code,'STUDIO_ARTIFACT_REQUIRED');
   await tool('comp',child,'studio_artifact_register',{...await artifact(),workItemId:(await work('references')).id},400);
  });
  await t.test('exact artifact registration and independent media/task reviews precede human QC and delivery',async()=>{
   const args=await artifact(),requestId=randomUUID();const registered=(await tool('comp',child,'studio_artifact_register',args,200,requestId)).result;artifactId=registered.artifact.id;assert.equal((await tool('comp',child,'studio_artifact_register',args,200,requestId)).result.artifact.id,artifactId);
   const review=async(actor:string,expected:number,extra:Record<string,unknown>={})=>call(`${base}/projects/${projectId}/reviews`,'POST',{clientId:randomUUID(),revision:(await detail()).project.revision,artifactId,decision:'approved',technicalQc:true,note:'Synthetic metadata-only test attestation; no actual video has been inspected.',...extra},actor,expected);
   await review('owner',403);await review('reviewer',400,{technicalQc:false});
   await tool('comp',child,'tasks_submit',{taskId:(await work('generation')).taskId,revision:(await work('generation')).revision,summary:'Versioned synthetic media reference is ready for independent review.'});
   await call(`agent/runs/${child.run.id}/complete`,'POST',{leaseToken:child.leaseToken,clientId:randomUUID(),result:'Reference submitted for independent human media review.'},'comp');
   await call(taskPath(await work('generation')),'PATCH',{status:'done'},'owner',409);assert.equal((await call(taskPath(await work('generation')),'PATCH',{status:'done'},'reviewer',409)).code,'STUDIO_ARTIFACT_REVIEW_REQUIRED');
   await review('reviewer',201);await call(taskPath(await work('generation')),'PATCH',{status:'done'},'owner',403);await call(taskPath(await work('generation')),'PATCH',{status:'done'},'reviewer');
   const packageInput=async()=>({clientId:randomUUID(),revision:(await detail()).project.revision,name:'Synthetic approved package',artifactIds:[artifactId],note:'Manifest only; no transfer or genuine client receipt.'});
   await call(`${base}/projects/${projectId}/deliveries`,'POST',await packageInput(),'owner',409);
   await acceptHuman(await work('qc'));const prepared=await call(`${base}/projects/${projectId}/deliveries`,'POST',await packageInput(),'owner',201);assert.equal(prepared.delivery.manifest.transportStatus,'not_transferred');assert.equal(prepared.delivery.manifest.artifacts[0].id,artifactId);
   await gate('client_acceptance',{deliveryId:prepared.delivery.id},409);await acceptHuman(await work('delivery'));await gate('client_acceptance',{deliveryId:prepared.delivery.id});assert.equal((await detail()).project.status,'delivered');assert.equal((await detail()).deliveries[0].status,'acknowledged');
   assert.equal(outbound,0);assert.equal(Number((await query('SELECT count(*) FROM studio_execution_jobs WHERE company_id=$1',[company])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM higgsfield_requests WHERE company_id=$1',[company])).rows[0].count),0);
  });
 }finally{
  globalThis.fetch=oldFetch;try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,reviewer,outsider]]);}finally{await database().end();await stop?.();for(const[name,value]of Object.entries(before))if(value===undefined)delete process.env[name];else process.env[name]=value;}
 }
});
