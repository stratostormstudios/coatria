import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {studioInferenceSubmitInput,studioInferenceCancelInput} from '../src/lib/studio-inference-protocol';
import {submitStudioInference,readStudioInference,cancelStudioInference,reconcileStudioInferenceJob,studioInferenceReserved,recordStudioInferenceToolReceipt,buildStudioInferenceRequest} from '../src/lib/studio-inference';
import {AGENT_TOOLS,studioAgentSnapshot} from '../src/lib/agent-tools';
import {studioSnapshot} from '../src/lib/studio';
import {stableRequestId,createRunInferenceClient} from '../public/downloads/agent-worker.mjs';
import {createProviderExecutor,modelContextResult,modelToolSchema,normalize} from '../public/downloads/provider-adapter.mjs';
import {studioDispatchInferenceToolNames} from '../src/lib/studio-coordination';

test('inference transport accepts only a leased step and rejects model/context/secret overrides',()=>{
 const request={leaseToken:'fixture-lease-proof-that-is-long',requestId:randomUUID(),step:0};assert(studioInferenceSubmitInput.safeParse(request).success);
 for(const patch of [{model:'other'},{messages:[]},{tools:[]},{endpoint:'other'},{apiKey:'fixture'},{step:20},{step:-1},{context:{}},{output:{}}])assert(!studioInferenceSubmitInput.safeParse({...request,...patch}).success);
 assert(studioInferenceCancelInput.safeParse({leaseToken:request.leaseToken,requestId:request.requestId}).success);
});
const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('broker runs real leased API and receipt transactions against isolated provider fixtures',{skip:!emulate&&!integrationUrl,timeout:180000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING,MANAGED_RUNPOD_API_KEY:process.env.MANAGED_RUNPOD_API_KEY},realFetch=globalThis.fetch;
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:Buffer.alloc(32,6).toString('base64')}});process.env.MANAGED_RUNPOD_API_KEY='fixture-server-lifecycle-key';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 const origin='http://localhost:4180',companies:string[]=[],users:string[]=[],runtimeConfig={providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:80000,timeoutSeconds:600};
 async function fixture(options:{maxJobs?:number;money?:number;tokens?:number;maxOutputTokens?:number;capabilities?:string[]}={}){
  const company=randomUUID(),user=randomUUID(),session=randomUUID();companies.push(company);users.push(user);
  await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Inference owner',user+'@example.invalid','fixture']);await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Inference fixture',$2,'blank')",[company,company]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[company,user]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),user]);
  let agentToken='',hostToken='';
  async function call(path:string,method='GET',payload?:unknown,actor='owner',expected=200,extra:Record<string,string>={}){const headers:Record<string,string>={...extra,...actor==='owner'?{Cookie:'coatria_session='+session,Origin:origin}:actor==='agent'?{Authorization:'Bearer '+agentToken}:actor==='host'?{Authorization:'Bearer '+hostToken}:{}};if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/'));const result=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(result)}`);return result;}
  const installation=(await call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Avery producer',invocationAccess:'admins',capabilities:options.capabilities??['workspace.read','tasks.write'],runtimeConfig:{...runtimeConfig,maxTotalTokens:options.tokens??runtimeConfig.maxTotalTokens,maxOutputTokens:options.maxOutputTokens??runtimeConfig.maxOutputTokens},character:{roleTitle:'Studio producer',persona:'Prepare drafts for independent human review. Never approve your own work.',workStyle:'methodical'}},'owner',201)).installation;
  const registration=await call(`companies/${company}/studio/hosts`,'POST',{clientId:randomUUID(),name:'Broker fixture',maxAgents:1,expiresAt:new Date(Date.now()+1200000).toISOString()},'owner',201);hostToken=registration.hostToken;
  const host=(await call(`companies/${company}/studio/hosts/${registration.host.id}/enroll`,'POST',{clientId:randomUUID(),revision:registration.host.revision,activateAgents:true,installations:[{installationId:installation.id,revision:installation.revision}]},'owner',201)).host;
  const bundle=await call('host/credentials','POST',{supervisorId:randomUUID()},'host');agentToken=bundle.credentials[0].agentToken;
  const preset={id:'broker-fixture',endpointId:'fixture-endpoint',modelId:runtimeConfig.modelId,maxSteps:8,maxOutputTokens:options.maxOutputTokens??2048,maxTotalTokens:options.tokens??80000,timeoutSeconds:600,inference:{mode:'coatria_broker_v1',maxJobs:options.maxJobs??12,maxHourlyMicrousd:600000,lifetimeAllowanceMicrousd:options.money??2000000}},provision=randomUUID();
  await query("INSERT INTO studio_host_provisions(id,company_id,created_by,client_id,request_hash,plan,plan_hash,preset,phase,host_id,pod_name,expires_at) VALUES($1,$2,$3,$4,$5,'{}',$5,$6,'running',$7,$8,$9)",[provision,company,user,randomUUID(),'a'.repeat(64),JSON.stringify(preset),host.id,'fixture-'+provision,host.expiresAt]);
  const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:installation.agentId,prompt:'Create a producer estimate draft and submit it for human review. Do not approve work.'},'owner',201)).run;
  const lease=await call('agent/runs/claim','POST',{workerId:'broker-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);
  const identity={id:installation.agentId,company_id:company,created_by:user,token_hash:hashToken(agentToken)},input=(step=0)=>({leaseToken:lease.leaseToken,requestId:randomUUID(),step});
  return{company,user,installation,host,provision,run,lease,identity,input,call,agentToken};
 }
 function providerFixture(outputs:any[]=[]){const calls:Array<{method:string;url:string;body:any}>=[];const jobPrefix='fixture-'+randomUUID();let lost=false,status='COMPLETED',index=0;const transport:typeof fetch=async(url,init)=>{assert(String(url).startsWith('https://api.runpod.ai/v2/fixture-endpoint/'));assert.equal((init?.headers as any).Authorization,'Bearer fixture-server-lifecycle-key');assert.equal(init?.redirect,'error');const body=init?.body?JSON.parse(String(init.body)):null;calls.push({method:init?.method??'GET',url:String(url),body});if(String(url).endsWith('/run')){index++;if(lost)throw Error('Simulated lost response');return Response.json({id:jobPrefix+'-'+index,status,output:status==='COMPLETED'?[outputs[index-1]??final('Ready for review')]:undefined});}if(String(url).includes('/cancel/')){status='CANCELLED';return Response.json({id:jobPrefix+'-'+index,status});}return Response.json({id:jobPrefix+'-'+index,status,output:status==='COMPLETED'?[outputs[index-1]??final('Ready for review')]:undefined});};return{transport,calls,setLost:(v:boolean)=>lost=v,setStatus:(v:string)=>status=v,creates:()=>calls.filter(c=>c.url.endsWith('/run')).length};}
 function final(text:string){return{choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:400,completion_tokens:40}};}
 function tool(name:string,args:unknown,callId='call-one'){return{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:400,completion_tokens:40}};}
 const v2=(f:Awaited<ReturnType<typeof fixture>>,step=0)=>({...f.input(step),protocolVersion:2});
 function batch(...outputs:ReturnType<typeof tool>[]){const output=outputs[0];output.choices[0].message.tool_calls=outputs.flatMap(item=>item.choices[0].message.tool_calls);return output;}
 try{
  for(const point of ['before_submit','create','running_read'] as const)await t.test(`timestamp-only sponsor revocation at ${point} fences paid inference and preserves cancellation evidence`,async()=>{
   const f=await fixture(),p=providerFixture();p.setStatus('IN_QUEUE');const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference,reserved=await transaction(client=>studioInferenceReserved(client,f.company));
   const revoke=()=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.user]);
   if(point==='before_submit')await revoke();if(point==='running_read')await reconcileStudioInferenceJob(job.id,{fetch:p.transport});let revoked=point==='before_submit';
   const transport:typeof fetch=async(url,init)=>{const response=await p.transport(url,init);if(!revoked&&(point==='create'&&String(url).endsWith('/run')||point==='running_read'&&String(url).includes('/status/'))){revoked=true;await revoke();}return response;};
   await reconcileStudioInferenceJob(job.id,{fetch:transport});assert(revoked);await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
   assert.equal(p.creates(),point==='before_submit'?0:1);if(point!=='before_submit')assert(p.calls.some(call=>call.url.includes('/cancel/')));
   const row=(await query('SELECT status,output,model_calls,provider_job_id FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.status,'cancelled');assert.equal(row.output,null);assert.deepEqual(row.model_calls,[]);assert.equal(Boolean(row.provider_job_id),point!=='before_submit');
   await assert.rejects(readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken));await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input()));assert.equal(await transaction(client=>studioInferenceReserved(client,f.company)),reserved);
  });
  await t.test('broker advertises exactly the grant-complete public catalog for an ordinary run',async()=>{
   const capabilities=['studio.read','studio.write','tasks.write'],f=await fixture({capabilities});
   const context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken}),catalog=await f.call('agent/tools','GET',undefined,'agent');
   const request=await transaction(async client=>{const run=(await client.query('SELECT * FROM agent_runs WHERE id=$1',[f.run.id])).rows[0];return buildStudioInferenceRequest(client,{run,capabilities,installation:context.installation});});
   assert.deepEqual(request.tools?.map(tool=>tool.function.name),catalog.tools.map((tool:any)=>tool.name));
   assert(request.tools?.some(tool=>tool.function.name==='studio_plan'));
   for(const name of ['studio_generated_followup_advance','studio_generated_artifact_register'])assert(!request.tools?.some(tool=>tool.function.name===name),'Primary studio.write does not grant additional creative/storage permissions.');
   assert.deepEqual((await query('SELECT capabilities FROM agents WHERE id=$1',[f.identity.id])).rows[0].capabilities,capabilities);
  });
  await t.test('source-dispatched planning completes four real worker steps at realistic usage within the unchanged 100k budget',async()=>{
   const capabilities=['studio.read','studio.write','tasks.write','storage.read','storage.organize','infrastructure.read','creative.read','creative.write'],f=await fixture({capabilities,tokens:100000,maxOutputTokens:8192}),sent:any[]=[],receipts:any[]=[],bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
   await f.call(`agent/runs/${f.run.id}/complete`,'POST',{leaseToken:f.lease.leaseToken,clientId:randomUUID(),result:'Unrelated fixture mission ended.'},'agent');
   await f.call(`companies/${f.company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'producer',agentId:f.identity.id}]},'owner',201);
   const base=`companies/${f.company}/studio/projects`,project=(await f.call(base,'POST',{clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Aster estimate fixture',clientName:'Synthetic client',brief:'Prepare a bounded estimate for one quiet-workspace product reference image. Separate review and explicit media credit approval remain required.',aiPolicy:'allowed',dueDate:null,spec:{kind:'image',format:'png',width:1024,height:1024,color:{mode:'not_required'}},shots:[{kind:'image',code:'ASTER01',description:'Quiet workspace product reference.'}]},'owner',201)).project;
   await f.call(`${base}/${project.id}/gates`,'POST',{clientId:randomUUID(),revision:project.revision,gate:'brief',decision:'approved',note:'Synthetic brief approved for estimate preparation.'},'owner',201);
   const detail=await f.call(`${base}/${project.id}?contractVersion=2`),work=detail.workItems.find((item:any)=>item.stage==='estimate');
   f.run=(await f.call(`${base}/${project.id}/dispatch`,'POST',{clientId:randomUUID(),revision:detail.project.revision,workItemId:work.id},'owner',201)).run;
   f.lease=await f.call('agent/runs/claim','POST',{workerId:'assigned-estimate-fixture',claimId:randomUUID()},'agent');assert.equal(f.lease.run.id,f.run.id);
   const initialContext=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   const preview=async()=>{const request=await transaction(async client=>buildStudioInferenceRequest(client,{run:(await client.query('SELECT * FROM agent_runs WHERE id=$1',[f.run.id])).rows[0],capabilities,installation:initialContext.installation}));request.max_tokens=8192;return request;};
   // Synthetic conversation context exercises reservation pressure through the
   // ordinary message API; the server-generated assignment stays unchanged.
   for(let i=0;i<8;i++){const remaining=20000-bytes(await preview());if(remaining<=0)break;await f.call(`companies/${f.company}/conversations/commons/messages`,'POST',{clientId:randomUUID(),body:'p'.repeat(Math.max(1,Math.min(4000,remaining-250)))},'owner',201);}
   const initialBytes=bytes(await preview());assert(initialBytes>=20000&&initialBytes<20500);
   const fullTools=Object.entries(AGENT_TOOLS).filter(([,definition])=>[definition.capability,...definition.additionalCapabilities??[]].every(cap=>capabilities.includes(cap))).map(([name,definition])=>({type:'function',function:{name,description:definition.description,parameters:modelToolSchema(z.toJSONSchema(definition.schema,{io:'input',unrepresentable:'any'}))}}));
   globalThis.fetch=async(url,init)=>{
    assert(String(url).endsWith('/fixture-endpoint/run'));const request=JSON.parse(String(init?.body)).input.openai_input;sent.push(request);const step=sent.length-1,last=request.messages.at(-1);let output:any;
    assert.deepEqual(request.tools.map((item:any)=>item.function.name).sort(),['studio_get','tasks_claim','tasks_submit']);
    if(step===0)output=tool('studio_get',{contractVersion:2,projectId:project.id,workItemId:work.id},'read-assigned-work');
    else if(step===1){const current=JSON.parse(last.content);assert.equal(current.workItem.id,work.id);assert(current.skills.length>0);output=tool('tasks_claim',{taskId:current.workItem.taskId,revision:current.workItem.revision},'claim-assigned-work');}
    else if(step===2){const claimed=JSON.parse(last.content);assert.equal(claimed.status,'doing');output=tool('tasks_submit',{taskId:claimed.id,revision:claimed.revision,summary:'Estimate draft: one 1024px PNG reference, one generation request after separate credit approval, one independent review. Provider price remains unquoted until the exact request is estimated. Dependencies: accepted brief and reference planning. No generation or delivery performed.'},'submit-estimate');}
    else{assert.equal(JSON.parse(last.content).status,'review');output=final('Assigned estimate submitted for independent review.');}
    output.usage={prompt_tokens:19000,completion_tokens:1000};return Response.json({id:'assigned-worker-'+randomUUID(),status:'COMPLETED',output});
   };
   const context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   const client={submitInference:(runId:string,body:unknown)=>f.call(`agent/runs/${runId}/inference`,'POST',body,'agent',201),readInference:(runId:string,id:string,leaseToken:string)=>f.call(`agent/runs/${runId}/inference/${id}`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':leaseToken}),cancelInference:(runId:string,id:string,body:unknown)=>f.call(`agent/runs/${runId}/inference/${id}/cancel`,'POST',body,'agent')};
   const tools={storageTransportVersion:'1',key:(key:string)=>stableRequestId(f.run.id,key),list:()=>f.call('agent/tools','GET',undefined,'agent'),call:async(name:string,args:unknown,{requestId}:{requestId:string})=>{assert(['studio_get','tasks_claim','tasks_submit'].includes(name));const result=(await f.call('agent/tools/'+name,'POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId,arguments:args},'agent')).result;receipts.push({name,requestId,result});return result;}};
   const execute=createProviderExecutor({settings:{NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'}}),inference=createRunInferenceClient({client,runId:f.run.id,leaseToken:f.lease.leaseToken,pollMs:0}),result=await execute({run:context.run,context,tools,inference});assert.match(result.result,/independent review/);assert.equal(sent.length,4);
   await f.call(`agent/runs/${f.run.id}/complete`,'POST',{leaseToken:f.lease.leaseToken,clientId:randomUUID(),result:result.result},'agent');
   const jobs=(await query('SELECT request_body,reserved_tokens,used_tokens,limits FROM studio_inference_jobs WHERE run_id=$1 ORDER BY step',[f.run.id])).rows;assert.equal(jobs.length,4);
   t.diagnostic(JSON.stringify({assignedPlanningCatalogBytes:bytes(jobs[0].request_body.tools),fullCatalogBytes:bytes(fullTools),reservedTokens:jobs.map(job=>job.reserved_tokens),usedTokens:jobs.map(job=>job.used_tokens)}));
   jobs.forEach((job,index)=>{assert.equal(job.used_tokens,20000);assert.equal(job.limits.maxTotalTokens,100000);assert.equal(job.limits.maxOutputTokens,8192);assert.equal(job.reserved_tokens,bytes(job.request_body)+8192+1024);assert(index*20000+job.reserved_tokens<=100000);});
   assert(60000+bytes({...jobs[3].request_body,tools:fullTools})+8192+1024>100000,'The grant-complete unrelated catalog cannot admit the same final step.');
   for(const receipt of receipts){const stored=(await query('SELECT response FROM studio_inference_tool_receipts WHERE run_id=$1 AND request_id=$2',[f.run.id,receipt.requestId])).rows[0].response;assert.deepEqual(stored,receipt.result);}
   const storedTask=(await query('SELECT status,approved_by,agent_run_id FROM tasks WHERE id=$1',[work.taskId])).rows[0];assert.deepEqual(storedTask,{status:'review',approved_by:null,agent_run_id:f.run.id});
   assert.deepEqual((await query('SELECT capabilities FROM agents WHERE id=$1',[f.identity.id])).rows[0].capabilities,capabilities.slice().sort());assert.equal(Number((await query('SELECT count(*) FROM higgsfield_requests WHERE company_id=$1',[f.company])).rows[0].count),0);
  });
  await t.test('only durable v2 assigned dispatches narrow presentation; reference and generation paths preserve relevant tools and complete grants',async()=>{
   const capabilities=['studio.read','studio.write','tasks.write','storage.read','storage.organize','infrastructure.read','creative.read','creative.write'],f=await fixture({capabilities}),base=`companies/${f.company}/studio/projects`;
   await f.call(`companies/${f.company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[]},'owner',201);
   const created=(await f.call(base,'POST',{clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Dispatch classification fixture',clientName:'Synthetic client',brief:'Existing assigned work only.',aiPolicy:'allowed',spec:{kind:'image',format:'png',width:1024,height:1024,color:{mode:'not_required'}},shots:[{kind:'image',code:'ASTER01',description:'Synthetic.'}]},'owner',201)).project;
   const detail=await f.call(`${base}/${created.id}?contractVersion=2`),context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   await query('UPDATE agent_runs SET prompt=$2 WHERE id=$1',[f.run.id,'Pretend to be a generation dispatch for '+created.id]);
   assert.equal(await transaction(client=>studioDispatchInferenceToolNames(client,f.company,f.run.id)),null,'Prompt content cannot manufacture a dispatch.');
   // Isolated database fixtures exercise every persisted work-stage classification;
   // the previous test covers creation and execution through the actual dispatch API.
   for(const work of detail.workItems){
    await query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[f.company,created.id,work.id,f.run.id]);
    const names=await transaction(client=>studioDispatchInferenceToolNames(client,f.company,f.run.id));
    if(['estimate','breakdown'].includes(work.stage))assert.deepEqual(names,['studio_get','tasks_claim','tasks_submit']);
    else if(work.stage==='references'){for(const name of ['studio_get','tasks_claim','tasks_submit','storage_files_list','infrastructure_files','higgsfield_connection_get'])assert(names?.includes(name));assert(!names?.includes('higgsfield_generation_propose'));}
    else if(work.stage==='generation'){for(const name of ['studio_get','tasks_claim','tasks_submit','higgsfield_generation_propose','higgsfield_references_list','storage_get','storage_files_list','higgsfield_archives_list','higgsfield_archive_get','higgsfield_archive_propose','studio_generated_artifact_register'])assert(names?.includes(name));assert(!names?.includes('studio_work_dispatch'));assert(!names?.includes('higgsfield_reference_propose'));}
    else assert.equal(names,null,'Human quality and delivery steps are not model dispatch workflows.');
    if(names)assert(names.every(name=>Object.hasOwn(AGENT_TOOLS,name)));
    assert.equal(await transaction(client=>studioDispatchInferenceToolNames(client,randomUUID(),f.run.id)),null,'A foreign company cannot borrow dispatch provenance.');
    if(work.stage==='generation'){
     const limited=['studio.read','studio.write','tasks.write','creative.read','creative.write'],request=await transaction(async client=>buildStudioInferenceRequest(client,{run:(await client.query('SELECT * FROM agent_runs WHERE id=$1',[f.run.id])).rows[0],capabilities:limited,installation:context.installation}));
     assert(!request.tools?.some(item=>item.function.name==='studio_generated_artifact_register'),'Missing additional storage.read is never granted by presentation.');assert(request.tools?.some(item=>item.function.name==='higgsfield_generation_propose'));
     const required=['creative.read','studio.read','studio.write','tasks.write','storage.read'];
     for(const omitted of [null,...required]){
      const allowed=capabilities.filter(cap=>cap!==omitted),scoped=await transaction(async client=>buildStudioInferenceRequest(client,{run:(await client.query('SELECT * FROM agent_runs WHERE id=$1',[f.run.id])).rows[0],capabilities:allowed,installation:context.installation}));
      assert.equal(scoped.tools?.some(item=>item.function.name==='higgsfield_references_list'),omitted===null,'Reference discovery requires every backend grant, including '+omitted);
     }
     for(const name of ['higgsfield_reference_propose','higgsfield_references_list','higgsfield_reference_get','higgsfield_reference_candidates_list']){const definition=AGENT_TOOLS[name];assert.deepEqual([definition.capability,...definition.additionalCapabilities??[]].sort(),[...required].sort());}
    }
    await query('DELETE FROM studio_dispatches WHERE company_id=$1 AND run_id=$2',[f.company,f.run.id]);
   }
   const legacy=(await f.call(base,'POST',{clientId:randomUUID(),name:'Legacy dispatch fixture',clientName:'Synthetic client',brief:'Legacy frame project remains unchanged.',spec:{width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'Linear Rec.709'},shots:[{code:'SH010',description:'Synthetic frame shot.',frameStart:1,frameEnd:2,handles:0,disciplines:['compositing']}]},'owner',201)).project,legacyDetail=await f.call(`${base}/${legacy.id}`);
   await query('INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[f.company,legacy.id,legacyDetail.workItems[0].id,f.run.id]);assert.equal(await transaction(client=>studioDispatchInferenceToolNames(client,f.company,f.run.id)),null);
  });
  await t.test('protocol 2 atomically rejects every sibling, pins raw malformed arguments, blocks alternate keys and advances only with exact server receipts',async()=>{
   const f=await fixture(),bad=tool('tasks_create',{},'invalid-json');bad.choices[0].message.tool_calls[0].function.arguments='{invalid private content';
   const p=providerFixture([batch(bad,tool('tasks_create',{title:'Do not execute sibling'},'valid-sibling')),tool('tasks_create',{title:'Corrected draft'},'corrected'),final('Draft ready')]);globalThis.fetch=p.transport;
   const request=v2(f),first=(await f.call(`agent/runs/${f.run.id}/inference`,'POST',request,'agent',201)).inference;
   assert.equal(first.protocolVersion,2);assert.equal(first.status,'succeeded');assert.equal(first.disposition,'validation_feedback');assert.equal(first.validationFeedback.correction,1);assert.deepEqual(first.validationFeedback.calls.map((call:any)=>call.response.code),['ARGUMENT_JSON_INVALID','BATCH_NOT_EXECUTED']);assert(!JSON.stringify(first.validationFeedback).includes('private content'));
   const receipts=(await query('SELECT request_id,arguments_hash,response FROM studio_inference_tool_receipts WHERE inference_id=$1 ORDER BY tool,request_id',[first.id])).rows;assert.equal(receipts.length,2);assert(receipts.some(row=>row.arguments_hash===hashToken('raw:{invalid private content')));
   assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),0);
   for(const [requestId,args]of [[stableRequestId(f.run.id,'provider:0:valid-sibling'),{title:'Do not execute sibling'}],[stableRequestId(f.run.id,'provider:0:invalid-json'),{title:'Changed invalid arguments'}],[randomUUID(),{title:'Alternate key'}]])await f.call('agent/tools/tasks_create','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId,arguments:args},'agent',409);
   const replay=(await f.call(`agent/runs/${f.run.id}/inference`,'POST',request,'agent')).inference;assert.deepEqual(replay,first);assert.equal(p.creates(),1);
   await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(1)),{code:'INFERENCE_PROTOCOL_REQUIRED'});
   const saved=receipts.find(row=>row.response.code==='ARGUMENT_JSON_INVALID')!;await query('UPDATE studio_inference_tool_receipts SET response=$2 WHERE request_id=$1',[saved.request_id,JSON.stringify({...saved.response,code:'BATCH_NOT_EXECUTED'})]);await assert.rejects(submitStudioInference(f.identity,f.run.id,v2(f,1)),{code:'INFERENCE_TOOLS_PENDING'});await query('UPDATE studio_inference_tool_receipts SET response=$2 WHERE request_id=$1',[saved.request_id,JSON.stringify(saved.response)]);
   const next=v2(f,1),admissions=await Promise.all([submitStudioInference(f.identity,f.run.id,next),submitStudioInference(f.identity,f.run.id,{...next,requestId:randomUUID()})]);assert.equal(admissions[0].inference.id,admissions[1].inference.id);await reconcileStudioInferenceJob(admissions[0].inference.id,{fetch:p.transport});
   const history=p.calls[1].body.input.openai_input.messages;assert.deepEqual(history.slice(-2).map((message:any)=>JSON.parse(message.content).executed),[false,false]);assert.equal(history.at(-3).tool_calls[0].function.arguments,'{invalid private content');
   const action={runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:1:corrected'),arguments:{title:'Corrected draft'}};const created=await f.call('agent/tools/tasks_create','POST',action,'agent');assert.equal((await f.call('agent/tools/tasks_create','POST',action,'agent')).result.id,created.result.id);
   const last=(await f.call(`agent/runs/${f.run.id}/inference`,'POST',v2(f,2),'agent',201)).inference;assert.equal(last.disposition,'execute');await f.call('agent/tools/tasks_create','POST',action,'agent',409);assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),1);assert.equal(p.creates(),3);
  });
  await t.test('two durable corrections survive restart and valid intermediate calls; a third invalid batch is terminal without receipts or refund',async()=>{
   const f=await fixture(),p=providerFixture([tool('tasks_create',{},'bad1'),tool('workspace_get',{},'good'),tool('tasks_create',{},'bad2'),tool('tasks_create',{},'bad3')]);
   let previousReserve=0;
   for(let step=0;step<4;step++){
    const request=v2(f,step),job=(await submitStudioInference(f.identity,f.run.id,request)).inference;
    if(step===0){let lost=false;const tx:typeof transaction=async(fn)=>{const result=await transaction(fn);if(!lost&&(result as any)?.inference?.status==='succeeded'){lost=true;throw Error('Simulated commit acknowledgement lost');}return result;};await reconcileStudioInferenceJob(job.id,{fetch:p.transport,transaction:tx});assert(lost);}else await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    const row=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;
    const reserved=await transaction(client=>studioInferenceReserved(client,f.company));assert(reserved>previousReserve);previousReserve=reserved;
    if(step===1){assert.equal(row.disposition,'execute');await f.call('agent/tools/workspace_get','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:1:good'),arguments:{}},'agent');}
    else if(step===3){assert.equal(row.status,'failed');assert.equal(row.errorCode,'INFERENCE_VALIDATION_LIMIT');assert.equal(row.usedTokens,440);assert.equal(row.output,undefined);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);}
    else{assert.equal(row.validationFeedback?.correction,step===0?1:2);assert.deepEqual((await submitStudioInference(f.identity,f.run.id,request)).inference,row);}
    const calls=p.calls.length;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});assert.equal(p.calls.length,calls);
   }
   await assert.rejects(submitStudioInference(f.identity,f.run.id,v2(f,4)),{code:'INFERENCE_SEQUENCE'});assert.equal(p.creates(),4);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),3);assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),0);
  });
  await t.test('a nonexecution key cannot be reused in another run of the same agent; unrelated direct harness calls retain ordinary authority',async()=>{
   const f=await fixture(),p=providerFixture([tool('tasks_create',{},'rejected')]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
   await f.call(`agent/runs/${f.run.id}/fail`,'POST',{leaseToken:f.lease.leaseToken,clientId:randomUUID(),error:'Fixture run ended after rejected batch.',retryable:false},'agent');
   const run=(await f.call(`companies/${f.company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:f.identity.id,prompt:'Separate direct harness draft.'},'owner',201)).run,lease=await f.call('agent/runs/claim','POST',{workerId:'second-direct-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);
   await f.call('agent/tools/tasks_create','POST',{runId:run.id,leaseToken:lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:0:rejected'),arguments:{title:'Borrowed rejected key'}},'agent',409);
   await f.call('agent/tools/tasks_create','POST',{runId:run.id,leaseToken:lease.leaseToken,requestId:randomUUID(),arguments:{title:'Independent direct harness draft'}},'agent');assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),1);
   await assert.rejects(readStudioInference(f.identity,f.run.id,job.id,lease.leaseToken));assert.equal(p.creates(),1);
  });
  await t.test('a legitimately reclaimed run cannot execute an earlier lease model call',async()=>{
   const f=await fixture(),p=providerFixture([tool('tasks_create',{title:'Old lease call'},'old')]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
   await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run.id]);await f.call('agent/runs/claim','POST',{workerId:'replacement-worker',claimId:randomUUID()},'agent');await query("UPDATE agent_runs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run.id]);
   const replacement=await f.call('agent/runs/claim','POST',{workerId:'replacement-worker',claimId:randomUUID()},'agent');assert.equal(replacement.run.id,f.run.id);assert.notEqual(replacement.leaseToken,f.lease.leaseToken);
   await f.call('agent/tools/tasks_create','POST',{runId:f.run.id,leaseToken:replacement.leaseToken,requestId:stableRequestId(f.run.id,'provider:0:old'),arguments:{title:'Old lease call'}},'agent',409);assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),0);assert.equal(p.creates(),1);
  });
  await t.test('correction feedback cannot bypass job, token, money or authority admission and revocation suppresses late receipts',async()=>{
   for(const mode of ['job','token','money','host','lease','cancel']){
    const f=await fixture(mode==='job'?{maxJobs:1}:{}),p=providerFixture([tool('tasks_create',{},'bad')]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    if(mode==='token')await query('UPDATE studio_inference_jobs SET used_tokens=100000 WHERE id=$1',[job.id]);
    if(mode==='money')await query('UPDATE studio_inference_reservations SET amount_microusd=2000000 WHERE inference_id=$1',[job.id]);
    if(mode==='host')await query('UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.provision]);
    if(mode==='lease')await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run.id]);
    if(mode==='cancel')await f.call(`companies/${f.company}/agent-runs/${f.run.id}/cancel`,'POST',{},'owner');
    await assert.rejects(submitStudioInference(f.identity,f.run.id,v2(f,1)));assert.equal(p.creates(),1);
   }
   for(const action of ['cancel','stop','expiry']){
    const f=await fixture(),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;let release!:(v:Response)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),pending=new Promise<Response>(resolve=>release=resolve);
    const work=reconcileStudioInferenceJob(job.id,{fetch:async()=>{started();return pending;}});await ready;
    if(action==='cancel')await cancelStudioInference(f.identity,f.run.id,job.id,{leaseToken:f.lease.leaseToken,requestId:randomUUID()});else if(action==='stop')await query('UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.provision]);else await query("UPDATE studio_inference_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    release(Response.json({id:'late-feedback-'+randomUUID(),status:'COMPLETED',output:tool('tasks_create',{},'bad')}));await work;
    const row=(await query('SELECT status,output,model_calls FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.status,'cancelled');assert.equal(row.output,null);assert.deepEqual(row.model_calls,[]);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);
   }
  });
  await t.test('an expired or superseded poll lease cannot persist late correction receipts; a new poll reconciles the same provider job',async()=>{
   for(const mode of ['expired','superseded']){
    const f=await fixture(),p=providerFixture([tool('tasks_create',{},'bad')]);p.setStatus('IN_QUEUE');
    const job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    const providerId=(await query('SELECT provider_job_id FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0].provider_job_id;
    let release!:(v:Response)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),pending=new Promise<Response>(resolve=>release=resolve);
    const work=reconcileStudioInferenceJob(job.id,{fetch:async(url,init)=>{assert(String(url).endsWith('/status/'+providerId));assert.equal(init?.method,'GET');started();return pending;}});await ready;
    if(mode==='expired')await query("UPDATE studio_inference_jobs SET poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    else await query("UPDATE studio_inference_jobs SET poll_lease_id=$2,poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id,randomUUID()]);
    release(Response.json({id:providerId,status:'COMPLETED',output:tool('tasks_create',{},'bad')}));assert.deepEqual(await work,{skipped:true});
    const unchanged=(await query('SELECT status,output,model_calls FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(unchanged.status,'queued');assert.equal(unchanged.output,null);assert.deepEqual(unchanged.model_calls,[]);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);
    p.setStatus('COMPLETED');await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const observed=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(observed.disposition,'validation_feedback');assert.equal(observed.validationFeedback?.correction,1);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),1);assert.equal(p.creates(),1);
   }
  });
  await t.test('a receipt write failure rolls the entire corrective completion back and retries only the known provider status',async()=>{
   const f=await fixture(),p=providerFixture([batch(tool('tasks_create',{},'invalid'),tool('workspace_get',{},'sibling'))]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;
   let inserts=0,injected=false;
   const guarded:typeof transaction=async fn=>transaction(client=>{
    const wrapped=Object.create(client);wrapped.query=(text:string,values?:unknown[])=>{
     if(text.startsWith('INSERT INTO studio_inference_tool_receipts')&&++inserts===2){injected=true;throw Error('Synthetic receipt persistence failure');}
     return client.query(text,values);
    };
    return fn(wrapped);
   });
   await reconcileStudioInferenceJob(job.id,{fetch:p.transport,transaction:guarded});assert(injected);
   const failedSave=(await query('SELECT status,provider_job_id,output,model_calls FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(failedSave.status,'uncertain');assert(failedSave.provider_job_id);assert.equal(failedSave.output,null);assert.deepEqual(failedSave.model_calls,[]);
   assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),0);
   await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const recovered=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(recovered.disposition,'validation_feedback');assert.equal(recovered.validationFeedback?.correction,1);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),2);assert.equal(p.creates(),1);assert(p.calls.at(-1)?.url.endsWith('/status/'+failedSave.provider_job_id));
  });
  await t.test('authority ending during receipt persistence rolls back every nonexecution receipt at the final save boundary',async()=>{
   for(const mode of ['deadline','poll','run','host']){
    const f=await fixture(),p=providerFixture([batch(tool('tasks_create',{},'invalid'),tool('workspace_get',{},'sibling'))]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;
    let injected=false;
    const guarded:typeof transaction=async fn=>transaction(client=>{
     const wrapped=Object.create(client);wrapped.query=async(text:string,values?:unknown[])=>{
      const result=await client.query(text,values);
      if(!injected&&text.startsWith('INSERT INTO studio_inference_tool_receipts')){
       injected=true;
       if(mode==='deadline')await client.query("UPDATE studio_inference_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
       if(mode==='poll')await client.query("UPDATE studio_inference_jobs SET poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
       if(mode==='run')await client.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run.id]);
       if(mode==='host')await client.query('UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.provision]);
      }
      return result;
     };
     return fn(wrapped);
    });
    await reconcileStudioInferenceJob(job.id,{fetch:p.transport,transaction:guarded});assert(injected);
    const rejected=(await query('SELECT status,provider_job_id,output,model_calls FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(rejected.status,'uncertain');assert(rejected.provider_job_id);assert.equal(rejected.output,null);assert.deepEqual(rejected.model_calls,[]);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);
    // The synthetic authority mutation was inside the rejected transaction and
    // rolls back too. A fresh poll can therefore reconcile the same known job.
    await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const recovered=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(recovered.disposition,'validation_feedback');assert.equal(recovered.validationFeedback?.correction,1);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),2);assert.equal(p.creates(),1);
   }
  });
  await t.test('atomic completion fence rejects run and hosting expiry after the final authority reads',async()=>{
   for(const mode of ['run','agent','host','host-lease','credential','provision']){
    const f=await fixture(),p=providerFixture([tool('tasks_create',{},'invalid')]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;
    let injected=false;
    const guarded:typeof transaction=async fn=>transaction(client=>{
     const wrapped=Object.create(client);wrapped.query=async(text:string,values?:unknown[])=>{
      if(!injected&&text.startsWith('UPDATE studio_inference_jobs j SET status=')&&values?.[1]==='succeeded'){
       injected=true;
       if(mode==='run')await client.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run.id]);
       if(mode==='agent')await client.query("UPDATE agents SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.identity.id]);
       if(mode==='host')await client.query("UPDATE studio_managed_hosts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.host.id]);
       if(mode==='host-lease')await client.query("UPDATE studio_managed_hosts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.host.id]);
       if(mode==='credential')await client.query("UPDATE studio_host_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND agent_id=$2",[f.company,f.identity.id]);
       if(mode==='provision')await client.query("UPDATE studio_host_provisions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.provision]);
      }
      return client.query(text,values);
     };
     return fn(wrapped);
    });
    await reconcileStudioInferenceJob(job.id,{fetch:p.transport,transaction:guarded});assert(injected);
    const rejected=(await query('SELECT status,provider_job_id,output,model_calls FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(rejected.status,'uncertain');assert(rejected.provider_job_id);assert.equal(rejected.output,null);assert.deepEqual(rejected.model_calls,[]);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);
    await reconcileStudioInferenceJob(job.id,{fetch:p.transport});assert.equal((await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference.disposition,'validation_feedback');assert.equal(p.creates(),1);
   }
  });
  await t.test('actual API pins persona, context and tools; accepts only authentic tool receipts and preserves independent task review',async()=>{
   const f=await fixture(),provider=providerFixture([tool('tasks_create',{title:'Producer estimate draft'},'create'),final('Estimate drafted for human review.')]);globalThis.fetch=provider.transport;
   const request=f.input(),first=await f.call(`agent/runs/${f.run.id}/inference`,'POST',request,'agent',201);assert.equal(first.inference.status,'succeeded');assert(!JSON.stringify(first).includes('fixture-server-lifecycle-key'));
   const sent=provider.calls[0].body.input.openai_input;assert.equal(sent.model,runtimeConfig.modelId);assert(sent.messages[0].content.includes('Studio producer'));assert(sent.messages[0].content.includes('untrusted'));assert(!sent.tools.some((v:any)=>v.function.name==='studio_review'));assert.equal(sent.max_tokens,2048);
   const replay=await f.call(`agent/runs/${f.run.id}/inference`,'POST',request,'agent');assert.equal(replay.inference.id,first.inference.id);assert.equal(provider.creates(),1);
   await f.call(`agent/runs/${f.run.id}/inference`,'POST',{...f.input(1),messages:[]},'agent',400);
   await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(1)),/exact model-requested tool/);
   const key=stableRequestId(f.run.id,'provider:0:create');await f.call('agent/tools/tasks_create','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:key,arguments:{title:'Wrong title'}},'agent',409);assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),0);
   const taskResult=await f.call('agent/tools/tasks_create','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:key,arguments:{title:'Producer estimate draft'}},'agent');assert(taskResult.result.id);
   const second=await f.call(`agent/runs/${f.run.id}/inference`,'POST',f.input(1),'agent',201);assert.equal(second.inference.status,'succeeded');assert.equal(provider.calls[1].body.input.openai_input.messages.at(-1).role,'tool');assert.equal(JSON.parse(provider.calls[1].body.input.openai_input.messages.at(-1).content).id,taskResult.result.id);
   await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(2)),/not requested more tools/);
   assert.equal((await query('SELECT status FROM tasks WHERE id=$1',[taskResult.result.id])).rows[0].status,'todo');assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),1);
   assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),1);
   await f.call(`agent/runs/${f.run.id}/inference/${first.inference.id}`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   await f.call(`agent/runs/${f.run.id}/inference/${first.inference.id}`,'GET',undefined,'agent',400);
   await assert.rejects(readStudioInference({...f.identity,company_id:randomUUID()},f.run.id,first.inference.id,f.lease.leaseToken),/not found|unavailable/);
  });
  await t.test('lost submissions remain uncertain and never retry paid POST; deadline expires without refund',async()=>{
   const f=await fixture(),p=providerFixture();p.setLost(true);const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;
   await reconcileStudioInferenceJob(job.id,{fetch:p.transport});await reconcileStudioInferenceJob(job.id,{fetch:p.transport});assert.equal(p.creates(),1);assert.equal((await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference.status,'uncertain');
   const reserved=await transaction(c=>studioInferenceReserved(c,f.company));assert(reserved>0);await query("UPDATE studio_inference_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);await reconcileStudioInferenceJob(job.id,{fetch:p.transport});assert.equal((await query('SELECT status FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0].status,'expired');assert.equal(await transaction(c=>studioInferenceReserved(c,f.company)),reserved);assert.equal(p.creates(),1);
  });
  await t.test('stop and revocation deny cached inference authority and independently cancel known paid jobs',async()=>{
   const f=await fixture(),p=providerFixture();p.setStatus('IN_QUEUE');const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});await query('UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.provision]);await assert.rejects(readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken),/no approved inference/);await reconcileStudioInferenceJob(job.id,{fetch:p.transport});assert.equal((await query('SELECT status FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0].status,'cancelled');assert.equal(p.creates(),1);assert(p.calls.some(c=>c.url.includes('/cancel/')));
   const g=await fixture(),q=providerFixture();q.setStatus('IN_QUEUE');const second=(await submitStudioInference(g.identity,g.run.id,g.input())).inference;await reconcileStudioInferenceJob(second.id,{fetch:q.transport});await query("UPDATE studio_managed_hosts SET status='revoked' WHERE id=$1",[g.host.id]);await reconcileStudioInferenceJob(second.id,{fetch:q.transport});assert.equal((await query('SELECT status FROM studio_inference_jobs WHERE id=$1',[second.id])).rows[0].status,'cancelled');
  });
  await t.test('money, token and job bounds deny submission before provider calls; valid usage settles tokens only',async()=>{
   const insufficient=await fixture({money:1});await assert.rejects(submitStudioInference(insufficient.identity,insufficient.run.id,insufficient.input()),/company inference allowance/);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_jobs WHERE company_id=$1',[insufficient.company])).rows[0].count),0);
   const small=await fixture({tokens:2048});await assert.rejects(submitStudioInference(small.identity,small.run.id,small.input()),/token allowance/);
   const f=await fixture({maxJobs:1}),p=providerFixture([tool('workspace_get',{})]);const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});await f.call('agent/tools/workspace_get','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:0:call-one'),arguments:{}},'agent');await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(1)),/job limit/);assert.equal(p.creates(),1);
   const row=(await query('SELECT used_tokens,reserved_tokens FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.used_tokens,440);assert(row.reserved_tokens>row.used_tokens);
  });
  await t.test('projected workspace receipts preserve full API geometry and reject fabricated argument changes',async()=>{
   const f=await fixture(),p=providerFixture([tool('workspace_get',{})]),job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const raw={company:{id:f.company},floor:{width:50,depth:50,revision:7,items:Array.from({length:3000},(_,i)=>({id:i,geometry:'x'.repeat(120)}))}},key=stableRequestId(f.run.id,'provider:0:call-one');const result=await transaction(c=>recordStudioInferenceToolReceipt(c,f.identity,f.run.id,key,'workspace_get',{},raw));assert.deepEqual(result,raw);const saved=(await query('SELECT response FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].response;assert.equal(saved.floor.itemCount,3000);assert.equal(saved.floor.itemsOmitted,true);assert(!saved.floor.items);assert.equal(saved.floor.revision,7);
   const next=await submitStudioInference(f.identity,f.run.id,f.input(1));assert(next.inference.id);await assert.rejects(transaction(c=>recordStudioInferenceToolReceipt(c,f.identity,f.run.id,key,'workspace_get',{invented:true},raw)),{code:'INFERENCE_TOOL_MISMATCH'});
  });
  await t.test('failed cancellation responses still reconcile the exact terminal job after revocation without exposing output or releasing reservations',async()=>{
   const privateText='synthetic-private-cancel-response-never-copy';
   for(const mode of ['not-found','server-error','empty','non-json','transport-timeout','body-timeout'])for(const status of ['COMPLETED','FAILED','CANCELLED','TIMED_OUT']){
    const f=await fixture(),p=providerFixture();p.setStatus('IN_QUEUE');const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    const before=(await query('SELECT provider_job_id,reserved_tokens,submitted_at FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0],reserved=await transaction(client=>studioInferenceReserved(client,f.company));
    await query("UPDATE studio_managed_hosts SET status='revoked' WHERE id=$1",[f.host.id]);
    const calls:Array<{url:string;method:string}>=[];let bodyCancelled=false,cancelAborted=false;
    const result=await reconcileStudioInferenceJob(job.id,{requestTimeoutMs:30,reconcileTimeoutMs:5000,fetch:async(url,init)=>{
     calls.push({url:String(url),method:init?.method??'GET'});assert.equal(init?.redirect,'error');assert.equal(init?.body,undefined);
     if(String(url).endsWith('/cancel/'+before.provider_job_id)){
      assert.equal(init?.method,'POST');init?.signal?.addEventListener('abort',()=>{cancelAborted=true;},{once:true});
      if(mode==='not-found')return new Response(privateText,{status:404});if(mode==='server-error')return new Response(privateText,{status:503});if(mode==='empty')return new Response(null,{status:204});if(mode==='non-json')return new Response(privateText);
      if(mode==='transport-timeout')return new Promise<Response>(()=>{});
      return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){bodyCancelled=true;}}));
     }
     assert.equal(String(url),'https://api.runpod.ai/v2/fixture-endpoint/status/'+before.provider_job_id);assert.equal(init?.method,'GET');return Response.json({id:before.provider_job_id,status,output:status==='COMPLETED'?[tool('tasks_create',{title:privateText})]:undefined,error:status==='FAILED'?privateText:undefined});
    }});
    assert.deepEqual(calls.map(c=>c.method),['POST','GET']);assert.equal(p.creates(),1);if(mode.endsWith('timeout'))assert(cancelAborted);if(mode==='body-timeout')assert(bodyCancelled);
    const row=(await query('SELECT status,provider_job_id,submitted_at,reserved_tokens,used_tokens,output,model_calls,poll_lease_id,error_code FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];
    assert.equal(row.status,'cancelled');assert.equal(row.provider_job_id,before.provider_job_id);assert.deepEqual(row.submitted_at,before.submitted_at);assert.equal(row.reserved_tokens,before.reserved_tokens);assert.equal(row.used_tokens,null);assert.equal(row.output,null);assert.deepEqual(row.model_calls,[]);assert.equal(row.poll_lease_id,null);assert.equal(await transaction(client=>studioInferenceReserved(client,f.company)),reserved);assert(!JSON.stringify(result).includes(privateText));
    await assert.rejects(readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken));assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),0);
    assert.equal((await reconcileStudioInferenceJob(job.id,{fetch:async()=>{throw Error('Terminal cleanup must not contact a provider');}})).skipped,true);
   }
  });
  await t.test('cancel acknowledgement or failed cancel never substitutes for matching terminal status evidence',async()=>{
   for(const mode of ['mismatch','missing-id','unsupported','queued','running','status-not-found','status-error','status-non-json','status-timeout'])for(const acceptedCancel of [false,true]){
    const f=await fixture(),p=providerFixture();p.setStatus('IN_QUEUE');const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    const providerJob=(await query('SELECT provider_job_id FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0].provider_job_id,reserved=await transaction(client=>studioInferenceReserved(client,f.company));
    await cancelStudioInference(f.identity,f.run.id,job.id,{leaseToken:f.lease.leaseToken,requestId:randomUUID()});let cancels=0,reads=0;
    const result=await reconcileStudioInferenceJob(job.id,{requestTimeoutMs:30,reconcileTimeoutMs:5000,fetch:async(url,init)=>{
     if(String(url).endsWith('/cancel/'+providerJob)){cancels++;assert.equal(init?.method,'POST');return acceptedCancel?Response.json({id:providerJob,status:'CANCELLED'}):new Response('private-cancel-error',{status:404});}
     reads++;assert.equal(String(url),'https://api.runpod.ai/v2/fixture-endpoint/status/'+providerJob);assert.equal(init?.method,'GET');
     if(mode==='status-not-found')return new Response('private-expired-result',{status:404});if(mode==='status-error')return new Response('private-status-error',{status:503});if(mode==='status-non-json')return new Response('private-status-error');if(mode==='status-timeout')return new Promise<Response>(()=>{});
     return Response.json({...(mode==='missing-id'?{}:{id:mode==='mismatch'?'foreign-'+randomUUID():providerJob}),status:mode==='queued'?'IN_QUEUE':mode==='running'?'IN_PROGRESS':mode==='unsupported'?'UNKNOWN':'COMPLETED',output:[final('Private unaccepted completion')]});
    }});
    assert.equal(cancels,1);assert.equal(reads,1);assert.equal(p.creates(),1);const row=(await query('SELECT status,provider_job_id,output,model_calls,used_tokens FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.status,'cancel_requested');assert.equal(row.provider_job_id,providerJob);assert.equal(row.output,null);assert.deepEqual(row.model_calls,[]);assert.equal(row.used_tokens,null);assert.equal(await transaction(client=>studioInferenceReserved(client,f.company)),reserved);assert(!JSON.stringify(result).includes('private-'));assert(!JSON.stringify(result).includes('Private unaccepted'));
   }
  });
  await t.test('cancellation fallback shares the overall deadline and does not start a status read after it expires',async()=>{
   for(const mode of ['cancel-stalls','status-stalls']){
    const f=await fixture(),p=providerFixture();p.setStatus('IN_QUEUE');const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});await cancelStudioInference(f.identity,f.run.id,job.id,{leaseToken:f.lease.leaseToken,requestId:randomUUID()});
    let cancels=0,reads=0;const started=performance.now(),events:Array<{start:number;abort:number|null}>=[];
    await reconcileStudioInferenceJob(job.id,{requestTimeoutMs:1000,reconcileTimeoutMs:300,fetch:async(url,init)=>{
     const event={start:performance.now(),abort:null as number|null};events.push(event);init?.signal?.addEventListener('abort',()=>{event.abort=performance.now();},{once:true});
     if(String(url).includes('/cancel/')){cancels++;if(mode==='status-stalls'){await new Promise(resolve=>setTimeout(resolve,80));return new Response('private-cancel-response',{status:404});}}
     else{reads++;assert(String(url).includes('/status/'));}return new Promise<Response>(()=>{});
    }});
    assert.equal(cancels,1);assert.equal(reads,mode==='cancel-stalls'?0:1);assert.equal(p.creates(),1);assert(events.at(-1)!.abort!==null);assert(events.at(-1)!.abort!-started<1000,'The same overall signal bounds cancellation plus status, excluding the later database persistence.');assert(events.at(-1)!.abort!-events.at(-1)!.start<1000);assert.equal((await query('SELECT status FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0].status,'cancel_requested');
   }
  });
  await t.test('managed inference persists and transmits ticket-free storage receipts while trusted callers keep exact transfer credentials',async()=>{
   for(const name of ['storage_upload_reserve','storage_file_access']){
    const f=await fixture({capabilities:['storage.read','storage.write']}),projectId=randomUUID(),versionId=randomUUID(),token='stg_fixture_only_private_transfer_'+name,url='https://gateway.example.invalid/v1/private/'+versionId;
    const args=name==='storage_upload_reserve'?{projectId,revision:1,parentId:null,name:'Synthetic footage.mov',bytes:64000000,contentType:'video/quicktime'}:{projectId,versionId,disposition:'attachment'};
    const p=providerFixture([tool(name,args),final('A trusted client must perform the transfer; no file content was sent to inference.')]);
    const first=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(first.id,{fetch:p.transport});
    const raw=name==='storage_upload_reserve'?{upload:{id:randomUUID(),versionId,token,baseUrl:url,expiresAt:'2026-09-18T20:00:00.000Z',partBytes:67108864,totalBytes:64000000,status:'allocated'},replayed:false}:{access:{url,headers:{Authorization:'Bearer '+token},expiresAt:'2026-09-18T20:00:00.000Z',bytes:64000000,sha256:'a'.repeat(64),contentType:'video/quicktime',name:'Synthetic footage.mov'}};
    const key=stableRequestId(f.run.id,'provider:0:call-one'),returned=await transaction(client=>recordStudioInferenceToolReceipt(client,f.identity,f.run.id,key,name,args,raw));assert.strictEqual(returned,raw);
    const receipt=(await query('SELECT response FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].response;assert.equal(receipt.transportCredentialsOmitted,true);for(const secret of[token,url,'Authorization'])assert(!JSON.stringify(receipt).includes(secret));
    // Even an older, unprojected receipt cannot bypass the next-request boundary.
    await query('UPDATE studio_inference_tool_receipts SET response=$2 WHERE company_id=$1',[f.company,JSON.stringify(raw)]);
    const next=(await submitStudioInference(f.identity,f.run.id,f.input(1))).inference;await reconcileStudioInferenceJob(next.id,{fetch:p.transport});assert.equal(p.creates(),2);
    const sent=p.calls.filter(call=>call.url.endsWith('/run')).at(-1)!.body,stored=(await query('SELECT request_body FROM studio_inference_jobs WHERE id=$1',[next.id])).rows[0].request_body;
    for(const secret of[token,url,'Authorization']){assert(!JSON.stringify(sent).includes(secret));assert(!JSON.stringify(stored).includes(secret));}
    const context=JSON.parse(sent.input.openai_input.messages.at(-1).content);assert.equal(context.transportCredentialsOmitted,true);if(name==='storage_upload_reserve')assert.equal(context.upload.versionId,versionId);else assert.equal(context.access.sha256,'a'.repeat(64));assert.deepEqual(returned,raw);
   }
  });
  await t.test('known completed invalid output fails once without duplicate submission, polling, tool execution or reservation release',async()=>{
   const privateText='synthetic-provider-private-output-never-return';
   const missingUsage=final(privateText);delete (missingUsage as any).usage;
   const truncated=final(privateText);truncated.choices[0].finish_reason='length';
   const badUsage=final(privateText);(badUsage.usage as any).completion_tokens='untrusted';
   const overBudget=final(privateText);overBudget.usage.completion_tokens=2049;
   const invalidArguments=tool('tasks_create',{title:privateText});invalidArguments.choices[0].message.tool_calls[0].function.arguments='{"title":';
   const outsideSchema=tool('tasks_create',{title:42,privateText});
   const providerError={...final(privateText),error:privateText},unknownTool=tool(privateText,{title:privateText}),badToolId=tool('tasks_create',{title:privateText},privateText+'/invalid');
   const tooManyTools=tool('tasks_create',{title:privateText});tooManyTools.choices[0].message.tool_calls=Array.from({length:9},(_,index)=>({...tooManyTools.choices[0].message.tool_calls[0],id:'call-'+index}));
   const cases:Array<[unknown,string]>=[[missingUsage,'usage'],[truncated,'normalization'],[badUsage,'usage'],[overBudget,'output_limits'],[invalidArguments,'tool_arguments_json'],[outsideSchema,'tool_arguments_schema'],[privateText,'response_shape'],[providerError,'provider_error'],[unknownTool,'tool_name'],[badToolId,'tool_identity'],[tooManyTools,'tool_count']];
   const diagnostics:unknown[][]=[],originalWarn=console.warn;console.warn=(...values:unknown[])=>{diagnostics.push(values);};
   try{for(const queuedFirst of [false,true])for(const [output,reason] of cases){
    const diagnosticsBefore=diagnostics.length;
    const f=await fixture(),p=providerFixture([output]),input=f.input(),job=(await submitStudioInference(f.identity,f.run.id,input)).inference;
    const reserved=await transaction(client=>studioInferenceReserved(client,f.company));assert(reserved>0);
    if(queuedFirst){p.setStatus('IN_QUEUE');await reconcileStudioInferenceJob(job.id,{fetch:p.transport});p.setStatus('COMPLETED');}
    await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    const row=(await query('SELECT * FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.status,'failed');assert.equal(row.error_code,'INFERENCE_OUTPUT_INVALID');assert.match(row.provider_job_id,/^fixture-/);assert(row.submitted_at);assert.equal(row.used_tokens,null);assert(row.reserved_tokens>0);assert.equal(row.output,null);assert.deepEqual(row.model_calls,[]);
    assert.equal(diagnostics.length,diagnosticsBefore+1);assert.equal(diagnostics.at(-1)!.length,1);assert.deepEqual(JSON.parse(String(diagnostics.at(-1)![0])),{event:'studio_inference_output_invalid',inferenceId:job.id,runId:f.run.id,step:0,reason});assert(!JSON.stringify(diagnostics.at(-1)).includes(privateText));
    const read=await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken);assert.equal(read.inference.errorCode,'INFERENCE_OUTPUT_INVALID');assert(!JSON.stringify(read).includes(privateText));assert(!Object.hasOwn(read.inference,'output'));
    const replay=await submitStudioInference(f.identity,f.run.id,input);assert.equal(replay.replayed,true);assert.equal(replay.inference.id,job.id);assert.equal(replay.inference.status,'failed');
    await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(1)),/previous|prior|completed|succeeded/i);
    const calls=p.calls.length;assert.equal((await reconcileStudioInferenceJob(job.id,{fetch:p.transport})).skipped,true);const cancelled=await cancelStudioInference(f.identity,f.run.id,job.id,{leaseToken:f.lease.leaseToken,requestId:randomUUID()});assert.equal(cancelled.replayed,true);assert.equal(cancelled.inference.status,'failed');assert.equal((await reconcileStudioInferenceJob(job.id,{fetch:p.transport})).skipped,true);
    assert.equal(p.calls.length,calls);assert.equal(p.creates(),1);assert.equal(await transaction(client=>studioInferenceReserved(client,f.company)),reserved);assert.equal(diagnostics.length,diagnosticsBefore+1);
   }}finally{console.warn=originalWarn;}
  });
  await t.test('downloadable worker adapter executes three real broker steps and leaves the task in independent human review',async()=>{
   const f=await fixture({tokens:20000}),sent:any[]=[];
   globalThis.fetch=async(url,init)=>{assert(String(url).endsWith('/fixture-endpoint/run'));const request=JSON.parse(String(init?.body));sent.push(request);const last=request.input.openai_input.messages.at(-1);let output:any;
    if(sent.length===1)output=tool('tasks_create',{title:'Actual worker estimate draft'},'create-draft');
    else if(sent.length===2){const created=JSON.parse(last.content);assert(created.id);output=tool('tasks_submit',{taskId:created.id,revision:created.revision,summary:'Draft estimate prepared; independent human review required.'},'submit-draft');}
    else{assert.equal(JSON.parse(last.content).status,'review');output=final('Estimate submitted for independent human review.');}
    return Response.json({id:'worker-'+randomUUID(),status:'COMPLETED',output:[output]});
   };
   const context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   const client={submitInference:(runId:string,body:unknown)=>f.call(`agent/runs/${runId}/inference`,'POST',body,'agent',201),readInference:(runId:string,id:string,leaseToken:string)=>f.call(`agent/runs/${runId}/inference/${id}`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':leaseToken}),cancelInference:(runId:string,id:string,body:unknown)=>f.call(`agent/runs/${runId}/inference/${id}/cancel`,'POST',body,'agent')};
   const tools={key:(key:string)=>stableRequestId(f.run.id,key),list:()=>f.call('agent/tools','GET',undefined,'agent'),call:async(name:string,args:unknown,{requestId}:{requestId:string})=>(await f.call('agent/tools/'+name,'POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId,arguments:args},'agent')).result};
   const execute=createProviderExecutor({settings:{NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'}}),inference=createRunInferenceClient({client,runId:f.run.id,leaseToken:f.lease.leaseToken,pollMs:0});
   const result=await execute({run:context.run,context,tools,inference});assert(result.result.includes('independent human review'));assert.equal(sent.length,3);
   await f.call(`agent/runs/${f.run.id}/complete`,'POST',{leaseToken:f.lease.leaseToken,clientId:randomUUID(),result:result.result},'agent');
   const tasks=(await query('SELECT status,approved_by FROM tasks WHERE company_id=$1',[f.company])).rows;assert.deepEqual(tasks,[{status:'review',approved_by:null}]);
   const accounting=(await query('SELECT sum(used_tokens)::int AS used,sum(reserved_tokens)::int AS reserved FROM studio_inference_jobs WHERE company_id=$1',[f.company])).rows[0];assert.equal(accounting.used,1320);assert(accounting.reserved>20000,'Successful measured usage releases only the token reservation needed for later steps');
   assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),2);
  });
  await t.test('live-size generated project correction fits the unchanged conservative budget without losing context, grants or exact tool receipts',async()=>{
   const capabilities=['studio.read','studio.write','tasks.write'],f=await fixture({tokens:100000,maxOutputTokens:8192,capabilities}),bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
   await f.call(`companies/${f.company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'producer',agentId:f.identity.id},{roleKey:'supervisor',agentId:f.identity.id}]},'owner',201);
   const context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   // Reconstruct the historical director catalog: prepared-reference proposals
   // were creative.write-only then and were absent at the observed byte sizes.
   const fullTools=Object.entries(AGENT_TOOLS).filter(([name,definition])=>name!=='higgsfield_reference_propose'&&capabilities.includes(definition.capability)).map(([name,definition])=>({type:'function',function:{name,description:definition.description,parameters:z.toJSONSchema(definition.schema,{io:'input',unrepresentable:'any'})}}));
   const preview=await transaction(async client=>{const run=(await client.query('SELECT * FROM agent_runs WHERE id=$1',[f.run.id])).rows[0];return buildStudioInferenceRequest(client,{run,capabilities,installation:context.installation});});preview.max_tokens=8192;
   // Match the observed pre-fix request sizes with synthetic task/reasoning
   // text, without copying private live content or assuming a tokenizer ratio.
   const padding=47824-bytes({...preview,tools:fullTools});assert(padding>0&&padding<11000);const exactPrompt=context.run.prompt+'p'.repeat(padding);
   await query('UPDATE agent_runs SET prompt=$2 WHERE id=$1',[f.run.id,exactPrompt]);preview.messages[1].content=JSON.stringify({...JSON.parse(preview.messages[1].content),verifiedRequest:{id:f.run.id,prompt:exactPrompt}});
   const oldFirst={...preview,tools:fullTools};assert.equal(bytes(oldFirst),47824);
   const fullSnapshot=await transaction(async client=>studioAgentSnapshot(await studioSnapshot(client,f.company,undefined,50,2))),snapshotBefore=JSON.stringify(fullSnapshot);
   const read=tool('studio_get',{contractVersion:2},'read-current-studio');(read.choices[0].message as any).reasoning_content='';read.usage={prompt_tokens:17128,completion_tokens:1000};
   const oldNext=()=>({...oldFirst,messages:[...oldFirst.messages,normalize(read,'chat').continuation,{role:'tool',tool_call_id:'read-current-studio',content:JSON.stringify(fullSnapshot)}]});
   const reasoningPadding=62588-bytes(oldNext());assert(reasoningPadding>=0&&reasoningPadding<8192);(read.choices[0].message as any).reasoning_content='r'.repeat(reasoningPadding);assert.equal(bytes(oldNext()),62588);
   const project={contractVersion:2,productionPath:'higgsfield',name:'Synthetic budget correction',clientName:'Synthetic client',brief:'One generated reference image. Independent human review remains required.',dueDate:null,spec:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},shots:[{kind:'image',code:'GEN001',description:'One generated deliverable.'}]};
   const bad=tool('studio_plan',{...project,contractVersion:'2',dueDate:'null',spec:JSON.stringify(project.spec),shots:JSON.stringify(project.shots)},'stringified-project');bad.usage={prompt_tokens:20408,completion_tokens:1000};
   const p=providerFixture([read,bad,tool('studio_plan',project,'corrected-project')]);
   const first=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(first.id,{fetch:p.transport});
   const readKey=stableRequestId(f.run.id,'provider:0:read-current-studio'),readCommand={runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:readKey,arguments:{contractVersion:2}};
   const actual=await f.call('agent/tools/studio_get','POST',readCommand,'agent');assert.deepEqual(actual.result,fullSnapshot);
   const readReceipt=(await query('SELECT response FROM studio_inference_tool_receipts WHERE request_id=$1',[readKey])).rows[0].response;assert.deepEqual(readReceipt,fullSnapshot);assert.equal(JSON.stringify(fullSnapshot),snapshotBefore);
   const second=(await submitStudioInference(f.identity,f.run.id,v2(f,1))).inference;await reconcileStudioInferenceJob(second.id,{fetch:p.transport});
   const rejected=(await readStudioInference(f.identity,f.run.id,second.id,f.lease.leaseToken)).inference;assert.equal(rejected.disposition,'validation_feedback');assert.equal(rejected.validationFeedback?.calls[0].response.code,'ARGUMENT_SCHEMA_INVALID');
   const prior=(await query('SELECT id,request_body,used_tokens,reserved_tokens,limits,output FROM studio_inference_jobs WHERE run_id=$1 ORDER BY step',[f.run.id])).rows,priorBefore=JSON.stringify(prior);assert.deepEqual(prior.map(row=>row.used_tokens),[18128,21408]);assert(prior.every(row=>row.limits.maxTotalTokens===100000&&row.limits.maxOutputTokens===8192));
   assert.equal(Number((await query('SELECT count(*) FROM studio_projects WHERE company_id=$1',[f.company])).rows[0].count),0);
   const third=(await submitStudioInference(f.identity,f.run.id,v2(f,2))).inference,thirdRow=(await query('SELECT request_body,reserved_tokens,limits FROM studio_inference_jobs WHERE id=$1',[third.id])).rows[0],request=thirdRow.request_body;
   assert(39536+thirdRow.reserved_tokens<=100000);assert.equal(thirdRow.reserved_tokens,bytes(request)+8192+1024);
   const readMessage=request.messages.find((message:any)=>message.role==='tool'&&message.tool_call_id==='read-current-studio'),modelSnapshot=JSON.parse(readMessage.content);assert.deepEqual(modelSnapshot,modelContextResult('studio_get',fullSnapshot));assert.deepEqual(modelSnapshot.profile,fullSnapshot.profile);assert.equal(JSON.stringify(modelSnapshot.skills),JSON.stringify(fullSnapshot.skills));assert.equal(modelSnapshot.templatesAreSummaries,true);assert.match(modelSnapshot.templateDetails,/studio_templates/);
   assert.deepEqual(JSON.parse(request.messages[1].content).verifiedRequest,{id:f.run.id,prompt:exactPrompt});assert.deepEqual(request.messages.slice(0,prior[1].request_body.messages.length),prior[1].request_body.messages);
   const feedback=(await query('SELECT response FROM studio_inference_tool_receipts WHERE inference_id=$1',[second.id])).rows[0].response;assert.deepEqual(JSON.parse(request.messages.at(-1).content),feedback);assert.equal(request.messages.at(-1).tool_call_id,'stringified-project');
   const schemaOnly={...request,messages:request.messages.map((message:any)=>message===readMessage?{...message,content:JSON.stringify(fullSnapshot)}:message)};assert(39536+bytes(schemaOnly)+8192+1024>100000,'Schema savings alone cannot admit this correction at the observed prior usage: '+JSON.stringify({schemaOnlyBytes:bytes(schemaOnly),requestBytes:bytes(request),fullCatalogBytes:bytes(fullTools),projectedCatalogBytes:bytes(request.tools)}));
   const unprojected={...schemaOnly,tools:fullTools};assert(bytes(unprojected)>bytes(request)+14000);assert.equal(JSON.stringify((await query('SELECT id,request_body,used_tokens,reserved_tokens,limits,output FROM studio_inference_jobs WHERE run_id=$1 AND step<2 ORDER BY step',[f.run.id])).rows),priorBefore);
   await reconcileStudioInferenceJob(third.id,{fetch:p.transport});const command={runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:2:corrected-project'),arguments:project},created=await f.call('agent/tools/studio_plan','POST',command,'agent');assert.equal((await f.call('agent/tools/studio_plan','POST',command,'agent')).replayed,true);
   assert.equal(created.result.project.contractVersion,2);assert.equal(Number((await query('SELECT count(*) FROM studio_projects WHERE company_id=$1',[f.company])).rows[0].count),1);assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),6);assert.equal(p.creates(),3);
   assert.deepEqual((await query('SELECT capabilities FROM agents WHERE id=$1',[f.identity.id])).rows[0].capabilities,capabilities);assert.deepEqual((await query('SELECT response FROM studio_inference_tool_receipts WHERE request_id=$1',[readKey])).rows[0].response,readReceipt);
  });
  await t.test('actual downloadable worker corrects real staffing refinements and generated-project union arguments before creating authored drafts once',async()=>{
   const f=await fixture({tokens:100000,capabilities:['workspace.read','studio.read','studio.write','tasks.write']}),sent:any[]=[],executions:string[]=[];
   await f.call(`companies/${f.company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[]},'owner',201);
   const staffing={templateId:'ai-production',brief:'A synthetic four-person AI production studio. Prepare plans only.',teamSize:4,disciplines:['compositing'],provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig}},badStaffing={...staffing,specialists:[{name:'Only producer',roleKeys:['producer']}]};
   const project={contractVersion:2,productionPath:'higgsfield',name:'Synthetic image draft',clientName:'Synthetic client',brief:'A single generated reference image for later independent review.',spec:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},shots:[{kind:'image',code:'GEN001',description:'One generated deliverable.'}]};
   globalThis.fetch=async(url,init)=>{
    assert(String(url).endsWith('/fixture-endpoint/run'));const request=JSON.parse(String(init?.body));sent.push(request);const step=sent.length-1;
    let output:any;if(step===0)output=batch(tool('studio_staffing_propose',badStaffing,'bad-staffing'),tool('workspace_get',{},'skipped-read'));
    else if(step===1){assert.equal(executions.length,0);const feedback=request.input.openai_input.messages.slice(-2).map((v:any)=>JSON.parse(v.content));assert.equal(feedback[0].code,'STAFFING_VALIDATION_INVALID');output=batch(tool('studio_staffing_propose',staffing,'skip-staffing'),tool('studio_plan',{...project,spec:{...project.spec,color:{mode:'invented'}}},'bad-project'));}
    else if(step===2){assert.equal(executions.length,0);output=batch(tool('studio_staffing_propose',staffing,'staffing-correct'),tool('studio_plan',project,'project-correct'));}
    else{assert.deepEqual(executions,['studio_staffing_propose','studio_plan']);output=final('Draft staffing and project prepared. Human approval remains required.');}
    return Response.json({id:'validation-worker-'+randomUUID(),status:'COMPLETED',output});
   };
   const context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   const client={submitInference:(runId:string,body:unknown)=>f.call(`agent/runs/${runId}/inference`,'POST',body,'agent',201),readInference:(runId:string,id:string,leaseToken:string)=>f.call(`agent/runs/${runId}/inference/${id}`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':leaseToken}),cancelInference:(runId:string,id:string,body:unknown)=>f.call(`agent/runs/${runId}/inference/${id}/cancel`,'POST',body,'agent')};
   const tools={key:(key:string)=>stableRequestId(f.run.id,key),list:()=>f.call('agent/tools','GET',undefined,'agent'),call:async(name:string,args:unknown,{requestId}:{requestId:string})=>{executions.push(name);return(await f.call('agent/tools/'+name,'POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId,arguments:args},'agent')).result;}};
   const execute=createProviderExecutor({settings:{NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'}}),inference=createRunInferenceClient({client,runId:f.run.id,leaseToken:f.lease.leaseToken,pollMs:0});const result=await execute({run:context.run,context,tools,inference});assert.match(result.result,/Human approval/);assert.equal(sent.length,4);
   const proposal=(await query('SELECT created_agent_id,run_id,status,plan FROM studio_staffing_proposals WHERE company_id=$1',[f.company])).rows;assert.equal(proposal.length,1);assert.equal(proposal[0].created_agent_id,f.identity.id);assert.equal(proposal[0].run_id,f.run.id);assert.equal(proposal[0].status,'pending');assert.equal(proposal[0].plan.actualAgentCount,4);
   const projects=(await query('SELECT contract_version,status,created_agent_id FROM studio_projects WHERE company_id=$1',[f.company])).rows;assert.equal(projects.length,1);assert.equal(projects[0].contract_version,2);assert.equal(projects[0].status,'intake');assert.equal(projects[0].created_agent_id,f.identity.id);assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),2);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),6);assert.equal(Number((await query('SELECT count(*) FROM higgsfield_jobs WHERE company_id=$1',[f.company])).rows[0].count),0);
  });
  await t.test('actual downloadable adapter regroups an insufficient existing staffing binding using exact nonexecution receipts without expanding grants',async()=>{
   const capabilities=['studio.read','studio.write','tasks.write'],f=await fixture({tokens:100000,capabilities}),sent:any[]=[],results:any[]=[];let toolFailure:unknown;
   const base={templateId:'ai-production',brief:'Private brief must not enter rejection feedback.',teamSize:4,disciplines:['compositing'],reviewerHumanId:null,provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig},planningReviewer:{name:'Separate planning reviewer'}};
   const bad={...base,specialists:[{name:'Private director name',roleKeys:['producer','coordinator','delivery'],existingAgentId:f.identity.id},{name:'Reference lead',roleKeys:['supervisor','ingest']},{name:'Generation lead',roleKeys:['comp']}]};
   const corrected={...base,specialists:[{name:'Existing director',roleKeys:['producer','supervisor'],existingAgentId:f.identity.id},{name:'Reference and coordination lead',roleKeys:['coordinator','ingest','delivery']},{name:'Generation lead',roleKeys:['comp']}]};
   const before=(await query('SELECT capabilities FROM agents WHERE company_id=$1 AND id=$2',[f.company,f.identity.id])).rows[0].capabilities;
   globalThis.fetch=async(url,init)=>{
    assert(String(url).endsWith('/fixture-endpoint/run'));const request=JSON.parse(String(init?.body));sent.push(request);const step=sent.length-1;
    if(step===1){const feedback=JSON.parse(request.input.openai_input.messages.at(-1).content);assert.deepEqual(feedback,results[0]);assert.equal(feedback.executed,false);assert.equal(feedback.code,'STAFFING_AGENT_GRANTS_REQUIRED');assert.deepEqual(feedback.roleRequirements.find((role:any)=>role.roleKey==='coordinator').capabilities,[...capabilities,'storage.read','storage.organize']);assert(!JSON.stringify(feedback).includes('Private'));}
    return Response.json({id:'staffing-grants-'+randomUUID(),status:'COMPLETED',output:step===0?tool('studio_staffing_propose',bad,'insufficient-binding'):step===1?tool('studio_staffing_propose',corrected,'regrouped-binding'):final('One staffing proposal is saved for human review. Existing grants are unchanged.')});
   };
   const context=await f.call(`agent/runs/${f.run.id}/context`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':f.lease.leaseToken});
   const client={submitInference:(runId:string,body:unknown)=>f.call(`agent/runs/${runId}/inference`,'POST',body,'agent',201),readInference:(runId:string,id:string,leaseToken:string)=>f.call(`agent/runs/${runId}/inference/${id}`,'GET',undefined,'agent',200,{'X-Coatria-Run-Lease':leaseToken}),cancelInference:(runId:string,id:string,body:unknown)=>f.call(`agent/runs/${runId}/inference/${id}/cancel`,'POST',body,'agent')};
   const tools={key:(key:string)=>stableRequestId(f.run.id,key),list:()=>f.call('agent/tools','GET',undefined,'agent'),call:async(name:string,args:unknown,{requestId}:{requestId:string})=>{try{
    const command={runId:f.run.id,leaseToken:f.lease.leaseToken,requestId,arguments:args},response=await f.call('agent/tools/'+name,'POST',command,'agent');results.push(response.result);
    if(results.length===1){
     assert.equal(response.result.proposalCreated,false);assert.equal(response.result.grantsChanged,false);assert.equal(response.result.correction,1);
     const counts=(await query("SELECT (SELECT count(*) FROM studio_staffing_proposals WHERE company_id=$1)::int proposals,(SELECT count(*) FROM studio_staffing_applications WHERE company_id=$1)::int applications,(SELECT count(*) FROM activity WHERE company_id=$1 AND kind='studio.staffing_proposed')::int staffing_activity,(SELECT count(*) FROM activity WHERE company_id=$1 AND kind='agent.tool_rejected')::int rejected_activity",[f.company])).rows[0];assert.deepEqual(counts,{proposals:0,applications:0,staffing_activity:0,rejected_activity:1});
     const receipt=(await query('SELECT request_id,tool,response FROM studio_inference_tool_receipts WHERE company_id=$1 AND run_id=$2',[f.company,f.run.id])).rows;assert.equal(receipt.length,1);assert.equal(receipt[0].request_id,requestId);assert.equal(receipt[0].tool,name);assert.deepEqual(receipt[0].response,response.result);
     const replay=await f.call('agent/tools/'+name,'POST',command,'agent');assert.equal(replay.replayed,true);assert.deepEqual(replay.result,response.result);
     await f.call('agent/tools/'+name,'POST',{...command,arguments:corrected},'agent',409);
     await f.call('agent/tools/'+name,'POST',{...command,requestId:randomUUID()},'agent',409);
    }
    return response.result;}catch(error){toolFailure=error;throw error;}
   }};
   const execute=createProviderExecutor({settings:{NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'}}),inference=createRunInferenceClient({client,runId:f.run.id,leaseToken:f.lease.leaseToken,pollMs:0});const result=await execute({run:context.run,context,tools,inference}).catch(error=>{throw toolFailure??error;});assert.match(result.result,/human review/);assert.equal(sent.length,3);
   const proposals=(await query('SELECT status,plan FROM studio_staffing_proposals WHERE company_id=$1',[f.company])).rows;assert.equal(proposals.length,1);assert.equal(proposals[0].status,'pending');assert.equal(proposals[0].plan.actualAgentCount,4);assert.deepEqual(proposals[0].plan.specialists.find((person:any)=>person.mode==='bind').roleKeys,['producer','supervisor']);
   assert.deepEqual((await query('SELECT capabilities FROM agents WHERE company_id=$1 AND id=$2',[f.company,f.identity.id])).rows[0].capabilities,before);assert.equal(Number((await query('SELECT count(*) FROM agents WHERE company_id=$1',[f.company])).rows[0].count),1);
   assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),2);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),2);
  });
  await t.test('staffing role-binding corrections are durable, limited to two per run, and never bypass current authority',async()=>{
   const f=await fixture({tokens:100000,capabilities:['studio.read','studio.write','tasks.write']}),args={templateId:'ai-production',brief:'Bounded staffing corrections.',teamSize:1,disciplines:['compositing'],reviewerHumanId:null,provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig},specialists:[{name:'Existing director',roleKeys:['producer','coordinator','supervisor','ingest','comp','delivery'],existingAgentId:f.identity.id}]};
   const p=providerFixture([tool('studio_staffing_propose',args,'bad1'),tool('studio_staffing_propose',args,'bad2'),tool('studio_staffing_propose',args,'bad3')]);
   for(let step=0;step<3;step++){
    const job=(await submitStudioInference(f.identity,f.run.id,v2(f,step))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
    const command={runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,`provider:${step}:bad${step+1}`),arguments:args};
    if(step===0){await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[f.company,f.user]);await f.call('agent/tools/studio_staffing_propose','POST',command,'agent',401);assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),0);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[f.company,f.user]);}
    const response=await f.call('agent/tools/studio_staffing_propose','POST',command,'agent',step<2?200:409);
    if(step<2){assert.equal(response.result.executed,false);assert.equal(response.result.correction,step+1);assert.deepEqual((await f.call('agent/tools/studio_staffing_propose','POST',command,'agent')).result,response.result);}else assert.equal(response.code,'STAFFING_CORRECTION_LIMIT');
   }
   await assert.rejects(submitStudioInference(f.identity,f.run.id,v2(f,3)),{code:'INFERENCE_TOOLS_PENDING'});
   assert.equal(Number((await query('SELECT count(*) FROM studio_staffing_proposals WHERE company_id=$1',[f.company])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM agent_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),2);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].count),2);assert.equal(p.creates(),3);
  });
  await t.test('business authorization failures remain ordinary failed tools and cannot manufacture correction evidence',async()=>{
   const f=await fixture({tokens:100000,capabilities:['studio.read','studio.write','tasks.write']}),args={templateId:'ai-production',brief:'Synthetic staffing draft.',teamSize:4,disciplines:['compositing'],reviewerHumanId:f.user,provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig}},p=providerFixture([tool('studio_staffing_propose',args,'conflicting-reviewer')]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});
   const completed=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(completed.disposition,'execute');
   const denied=await f.call('agent/tools/studio_staffing_propose','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:0:conflicting-reviewer'),arguments:args},'agent',409);assert.equal(denied.code,'STAFFING_REVIEWER_CONFLICT');
   await assert.rejects(submitStudioInference(f.identity,f.run.id,v2(f,1)),{code:'INFERENCE_TOOLS_PENDING'});assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM studio_staffing_proposals WHERE company_id=$1',[f.company])).rows[0].count),0);assert.equal(p.creates(),1);
  });
  await t.test('protocol 2 never converts identity, usage, truncation, unsafe JSONB or unauthorized calls into correction feedback',async()=>{
   const noUsage:any=tool('tasks_create',{},'invalid');delete noUsage.usage;const truncated=tool('tasks_create',{},'invalid');truncated.choices[0].finish_reason='length';
   const duplicate=batch(tool('tasks_create',{},'same'),tool('tasks_create',{},'same'));
   for(const output of [noUsage,truncated,duplicate,tool('tasks_create',{title:'nul\u0000'},'nul'),tool('tasks_create',{title:'surrogate\ud800'},'surrogate'),batch(tool('tasks_create',{},'bad'),tool('studio_plan',{},'unauthorized'))]){
    const f=await fixture(),p=providerFixture([output]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const row=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(row.status,'failed');assert.equal(row.validationFeedback,undefined);assert.equal(row.output,undefined);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);assert.equal(p.creates(),1);
   }
   const f=await fixture(),forged:any=tool('tasks_create',{title:'Real executable call'},'real');forged.disposition='validation_feedback';forged.validationFeedback={version:1,correction:1,calls:[]};const p=providerFixture([forged]),job=(await submitStudioInference(f.identity,f.run.id,v2(f))).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const row=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(row.disposition,'execute');assert.equal(row.validationFeedback,undefined);assert.equal(Number((await query('SELECT count(*) FROM studio_inference_tool_receipts WHERE inference_id=$1',[job.id])).rows[0].count),0);
   const repeated=await fixture(),repeatProvider=providerFixture([tool('tasks_create',{},'same-id'),tool('tasks_create',{title:'Correct arguments but reused ID'},'same-id')]);for(let step=0;step<2;step++){const next=(await submitStudioInference(repeated.identity,repeated.run.id,v2(repeated,step))).inference;await reconcileStudioInferenceJob(next.id,{fetch:repeatProvider.transport});const observed=(await readStudioInference(repeated.identity,repeated.run.id,next.id,repeated.lease.leaseToken)).inference;assert.equal(observed.status,step===0?'succeeded':'failed');if(step===1)assert.equal(observed.errorCode,'INFERENCE_OUTPUT_INVALID');}assert.equal(repeatProvider.creates(),2);
  });
  await t.test('committed cancellation, deadline and host stop defeat a late completed provider reply',async()=>{
   for(const action of ['cancel','stop','expiry']){
    const f=await fixture(),job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;let release!:(value:Response)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),pending=new Promise<Response>(resolve=>release=resolve);
    const reconciliation=reconcileStudioInferenceJob(job.id,{fetch:async()=>{started();return pending;}});await ready;
    if(action==='cancel'){const request={leaseToken:f.lease.leaseToken,requestId:randomUUID()};await cancelStudioInference(f.identity,f.run.id,job.id,request);assert.equal((await cancelStudioInference(f.identity,f.run.id,job.id,request)).replayed,true);}
    else if(action==='stop')await query('UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.provision]);
    else await query("UPDATE studio_inference_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    release(Response.json({id:'late-'+randomUUID(),status:'COMPLETED',output:[tool('tasks_create',{title:'Never apply this late result'})]}));await reconciliation;
    const saved=(await query('SELECT status,output,model_calls,provider_job_id FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(saved.status,'cancelled');assert.equal(saved.output,null);assert.deepEqual(saved.model_calls,[]);assert(saved.provider_job_id);
    await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(1)));assert.equal(Number((await query('SELECT count(*) FROM tasks WHERE company_id=$1',[f.company])).rows[0].count),0);
   }
  });
  await t.test('uncooperative transport and body streams stop at the deadline without another provider submission',async()=>{
   for(const mode of ['transport','body']){
    const f=await fixture(),job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;
    let calls=0,cancelled=false,transportStarted=0,transportAborted=0;
    await reconcileStudioInferenceJob(job.id,{requestTimeoutMs:20,reconcileTimeoutMs:5000,fetch:async(_url,init)=>{
     calls++;transportStarted=performance.now();init?.signal?.addEventListener('abort',()=>{transportAborted=performance.now();},{once:true});
     if(mode==='transport')return new Promise<Response>(()=>{});
     return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));
    }});
    assert.equal(calls,1);assert(transportAborted>=transportStarted);assert(transportAborted-transportStarted<1000,'The request timeout bounds the actual stalled transport independently of database authorization and result persistence.');
    const result=(await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference;assert.equal(result.status,'uncertain');if(mode==='body')assert(cancelled);
    await reconcileStudioInferenceJob(job.id,{fetch:async()=>{calls++;throw Error('A second submit is forbidden');}});assert.equal(calls,1);
   }
  });
  await t.test('strict provider identity and error fields are rejected; transient status reads preserve a known pending job',async()=>{
   for(const bad of [{status:'COMPLETED',output:final('No ID')},{id:12,status:'COMPLETED',output:final('Numeric ID')},{id:'error-'+randomUUID(),status:'COMPLETED',output:{...final('Conflicting error'),error:'synthetic'}}]){const f=await fixture(),job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:async()=>Response.json(bad)});const row=(await query('SELECT status,output FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.status,typeof bad.id==='string'?'failed':'uncertain');assert.equal(row.output,null);}
   const f=await fixture(),p=providerFixture();p.setStatus('IN_QUEUE');const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});await reconcileStudioInferenceJob(job.id,{fetch:async()=>Response.json({error:'Temporary read failure'},{status:503})});assert.equal((await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference.status,'queued');assert.equal(p.creates(),1);let statusTimeoutCalls=0;await reconcileStudioInferenceJob(job.id,{requestTimeoutMs:20,reconcileTimeoutMs:5000,fetch:async()=>{statusTimeoutCalls++;return new Promise<Response>(()=>{});}});assert.equal(statusTimeoutCalls,1);assert.equal((await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference.status,'queued');p.setStatus('COMPLETED');await reconcileStudioInferenceJob(job.id,{fetch:p.transport});assert.equal((await readStudioInference(f.identity,f.run.id,job.id,f.lease.leaseToken)).inference.status,'succeeded');
  });
 }finally{globalThis.fetch=realFetch;for(const company of companies)await query('DELETE FROM companies WHERE id=$1',[company]);for(const user of users)await query('DELETE FROM users WHERE id=$1',[user]);await database().end();delete (globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
