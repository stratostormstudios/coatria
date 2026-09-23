import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {studioInferenceSubmitInput,studioInferenceCancelInput} from '../src/lib/studio-inference-protocol';
import {submitStudioInference,readStudioInference,cancelStudioInference,reconcileStudioInferenceJob,studioInferenceReserved,recordStudioInferenceToolReceipt} from '../src/lib/studio-inference';
import {stableRequestId,createRunInferenceClient} from '../public/downloads/agent-worker.mjs';
import {createProviderExecutor} from '../public/downloads/provider-adapter.mjs';

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
 async function fixture(options:{maxJobs?:number;money?:number;tokens?:number;capabilities?:string[]}={}){
  const company=randomUUID(),user=randomUUID(),session=randomUUID();companies.push(company);users.push(user);
  await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Inference owner',user+'@example.invalid','fixture']);await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Inference fixture',$2,'blank')",[company,company]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[company,user]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),user]);
  let agentToken='',hostToken='';
  async function call(path:string,method='GET',payload?:unknown,actor='owner',expected=200,extra:Record<string,string>={}){const headers:Record<string,string>={...extra,...actor==='owner'?{Cookie:'coatria_session='+session,Origin:origin}:actor==='agent'?{Authorization:'Bearer '+agentToken}:actor==='host'?{Authorization:'Bearer '+hostToken}:{}};if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('/'));const result=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(result)}`);return result;}
  const installation=(await call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Avery producer',invocationAccess:'admins',capabilities:options.capabilities??['workspace.read','tasks.write'],runtimeConfig,character:{roleTitle:'Studio producer',persona:'Prepare drafts for independent human review. Never approve your own work.',workStyle:'methodical'}},'owner',201)).installation;
  const registration=await call(`companies/${company}/studio/hosts`,'POST',{clientId:randomUUID(),name:'Broker fixture',maxAgents:1,expiresAt:new Date(Date.now()+1200000).toISOString()},'owner',201);hostToken=registration.hostToken;
  const host=(await call(`companies/${company}/studio/hosts/${registration.host.id}/enroll`,'POST',{clientId:randomUUID(),revision:registration.host.revision,activateAgents:true,installations:[{installationId:installation.id,revision:installation.revision}]},'owner',201)).host;
  const bundle=await call('host/credentials','POST',{supervisorId:randomUUID()},'host');agentToken=bundle.credentials[0].agentToken;
  const preset={id:'broker-fixture',endpointId:'fixture-endpoint',modelId:runtimeConfig.modelId,maxSteps:8,maxOutputTokens:2048,maxTotalTokens:options.tokens??80000,timeoutSeconds:600,inference:{mode:'coatria_broker_v1',maxJobs:options.maxJobs??12,maxHourlyMicrousd:600000,lifetimeAllowanceMicrousd:options.money??2000000}},provision=randomUUID();
  await query("INSERT INTO studio_host_provisions(id,company_id,created_by,client_id,request_hash,plan,plan_hash,preset,phase,host_id,pod_name,expires_at) VALUES($1,$2,$3,$4,$5,'{}',$5,$6,'running',$7,$8,$9)",[provision,company,user,randomUUID(),'a'.repeat(64),JSON.stringify(preset),host.id,'fixture-'+provision,host.expiresAt]);
  const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:installation.agentId,prompt:'Create a producer estimate draft and submit it for human review. Do not approve work.'},'owner',201)).run;
  const lease=await call('agent/runs/claim','POST',{workerId:'broker-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);
  const identity={id:installation.agentId,company_id:company,created_by:user,token_hash:hashToken(agentToken)},input=(step=0)=>({leaseToken:lease.leaseToken,requestId:randomUUID(),step});
  return{company,user,installation,host,provision,run,lease,identity,input,call,agentToken};
 }
 function providerFixture(outputs:any[]=[]){const calls:Array<{method:string;url:string;body:any}>=[];const jobPrefix='fixture-'+randomUUID();let lost=false,status='COMPLETED',index=0;const transport:typeof fetch=async(url,init)=>{assert(String(url).startsWith('https://api.runpod.ai/v2/fixture-endpoint/'));assert.equal((init?.headers as any).Authorization,'Bearer fixture-server-lifecycle-key');assert.equal(init?.redirect,'error');const body=init?.body?JSON.parse(String(init.body)):null;calls.push({method:init?.method??'GET',url:String(url),body});if(String(url).endsWith('/run')){index++;if(lost)throw Error('Simulated lost response');return Response.json({id:jobPrefix+'-'+index,status,output:status==='COMPLETED'?[outputs[index-1]??final('Ready for review')]:undefined});}if(String(url).includes('/cancel/')){status='CANCELLED';return Response.json({id:jobPrefix+'-'+index,status});}return Response.json({id:jobPrefix+'-'+index,status,output:status==='COMPLETED'?[outputs[index-1]??final('Ready for review')]:undefined});};return{transport,calls,setLost:(v:boolean)=>lost=v,setStatus:(v:string)=>status=v,creates:()=>calls.filter(c=>c.url.endsWith('/run')).length};}
 function final(text:string){return{choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:400,completion_tokens:40}};}
 function tool(name:string,args:unknown,callId='call-one'){return{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:400,completion_tokens:40}};}
 try{
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
   const small=await fixture({tokens:100});await assert.rejects(submitStudioInference(small.identity,small.run.id,small.input()),/token allowance/);
   const f=await fixture({maxJobs:1}),p=providerFixture([tool('workspace_get',{})]);const job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});await f.call('agent/tools/workspace_get','POST',{runId:f.run.id,leaseToken:f.lease.leaseToken,requestId:stableRequestId(f.run.id,'provider:0:call-one'),arguments:{}},'agent');await assert.rejects(submitStudioInference(f.identity,f.run.id,f.input(1)),/job limit/);assert.equal(p.creates(),1);
   const row=(await query('SELECT used_tokens,reserved_tokens FROM studio_inference_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.used_tokens,440);assert(row.reserved_tokens>row.used_tokens);
  });
  await t.test('projected workspace receipts preserve full API geometry and reject fabricated argument changes',async()=>{
   const f=await fixture(),p=providerFixture([tool('workspace_get',{})]),job=(await submitStudioInference(f.identity,f.run.id,f.input())).inference;await reconcileStudioInferenceJob(job.id,{fetch:p.transport});const raw={company:{id:f.company},floor:{width:50,depth:50,revision:7,items:Array.from({length:3000},(_,i)=>({id:i,geometry:'x'.repeat(120)}))}},key=stableRequestId(f.run.id,'provider:0:call-one');const result=await transaction(c=>recordStudioInferenceToolReceipt(c,f.identity,f.run.id,key,'workspace_get',{},raw));assert.deepEqual(result,raw);const saved=(await query('SELECT response FROM studio_inference_tool_receipts WHERE company_id=$1',[f.company])).rows[0].response;assert.equal(saved.floor.itemCount,3000);assert.equal(saved.floor.itemsOmitted,true);assert(!saved.floor.items);assert.equal(saved.floor.revision,7);
   const next=await submitStudioInference(f.identity,f.run.id,f.input(1));assert(next.inference.id);await assert.rejects(transaction(c=>recordStudioInferenceToolReceipt(c,f.identity,f.run.id,key,'workspace_get',{invented:true},raw)),/does not match/);
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
