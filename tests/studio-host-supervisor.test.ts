import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {studioHostConfiguration,createHostBroker,runStudioHost} from '../scripts/hosting/run-studio-host.mjs';
import {RuntimeError} from '../public/downloads/agent-worker.mjs';
import {createProviderExecutor} from '../public/downloads/provider-adapter.mjs';
import {buildStudioBootstrap,studioHostStateDirectory} from '../scripts/hosting/build-studio-bootstrap.mjs';
import {fileURLToPath} from 'node:url';

const companyId=randomUUID(),hostId=randomUUID(),modelId='Qwen/Qwen3.8-27B-FP8';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const settings={RUNPOD_API_KEY:'fixture-provider-key',COATRIA_RUNPOD_ENDPOINT_ID:'fixture-endpoint',COATRIA_MAX_OUTPUT_TOKENS:'8192',COATRIA_MAX_TOTAL_TOKENS:'80000'};
const secret='private-fixture-do-not-log';
// I/O scheduling varies in the full parallel suite. Synchronize on actual
// worker events, retain a bounded timeout, and never miss an earlier abort.
const test=(name:string,body:()=>void|Promise<void>)=>nodeTest(name,{timeout:30000},body);
const waitForAbort=(signal:AbortSignal)=>new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
async function readyBeforeStop(ready:Promise<void>,operation:Promise<unknown>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([ready,operation.then(()=>{throw Error('Host stopped before executor entered.');}),new Promise<void>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Executor readiness timed out.')),15000);})]);}finally{clearTimeout(timer);}}
function bundle(expiresAt:string){return{agentId:randomUUID(),installationId:randomUUID(),credentialVersion:1,installationRevision:1,agentToken:'ca_'+randomUUID().replaceAll('-',''),expiresAt,name:'Fixture',capabilities:['workspace.read'],runtime:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId,maxSteps:8,maxOutputTokens:8192,maxTotalTokens:80000,timeoutSeconds:600},character:{roleTitle:'VFX producer',persona:'Careful.',workStyle:'methodical'}}};}
async function fixture(count=1){
 const directory=await mkdtemp(join(tmpdir(),'coatria-studio-host-test-')),deadlineMs=Date.now()+20000,expiresAt=new Date(deadlineMs).toISOString(),bundles=Array.from({length:count},()=>bundle(expiresAt));
 const host={id:hostId,companyId,status:'active',revision:1,maxAgents:11,providerIds:['runpod'],expiresAt};
 const broker={origin:'https://coatria.com',identity:hash('ch_fixture_not_real'),identify:async()=>({host}),credentials:async({supervisorId}:any)=>({host,supervisor:{id:supervisorId,epoch:1,expiresAt:new Date(Math.min(deadlineMs,Date.now()+10000)).toISOString()},credentials:bundles,unavailable:[],pollAfterSeconds:20})};
 const control=new AbortController(),events:any[]=[];
 const options={directory,companyId,hostId,deadlineMs,modelId,broker,settings,signal:control.signal,log:(entry:any)=>events.push(entry),pollMs:5,refreshMs:10000,cleanupMs:1000};
 return{directory,deadlineMs,bundles,host,broker,control,events,options,remove:async()=>{const local=relative(tmpdir(),directory);assert(local&&!local.startsWith('..')&&!isAbsolute(local));await rm(directory,{recursive:true,force:true});}};
}
function clientFactory(bundles:any[],overrides:(item:any)=>any=()=>({})){
 return({url,token}:any)=>{const item=bundles.find(value=>value.agentToken===token);assert(item);return{origin:url,identity:hash(token),readIdentity:async()=>({agent:{id:item.agentId,companyId,status:'active',capabilities:item.capabilities}}),autonomyTick:async()=>({}),claim:async()=>({run:null}),...overrides(item)};};
}
function jobClient(item:any,overrides:any={}){
 const run={id:randomUUID(),companyId,agentId:item.agentId,prompt:'Synthetic supervisor fixture',attempts:1};
 return{claim:async()=>({run,leaseToken:secret,leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),context:async()=>({run,capabilities:item.capabilities,installation:{id:item.installationId,...item.runtime,revision:item.installationRevision}}),complete:async()=>({run:{status:'succeeded'}}),fail:async()=>({run:{status:'failed'}}),...overrides};
}
async function journals(folder:string,agentId:string){const path=join(folder,'agents',agentId);return(await readdir(path)).filter(name=>name.endsWith('.json')).map(name=>join(path,name));}

test('studio host pins an absolute deadline, company, host, model and concurrency',()=>{
 const config={COATRIA_HOST_COMPANY_ID:companyId,COATRIA_HOST_ID:hostId,COATRIA_HOST_MODEL_ID:modelId,COATRIA_HOST_EXPIRES_AT:new Date(Date.now()+60000).toISOString(),COATRIA_HOST_STATE_DIR:tmpdir()};
 assert.equal(studioHostConfiguration(config).concurrency,1);
 for(const change of[{COATRIA_HOST_CONCURRENCY:'3'},{COATRIA_HOST_ID:'invalid'},{COATRIA_HOST_MODEL_ID:'../../model'},{COATRIA_HOST_STATE_DIR:'relative'},{COATRIA_HOST_EXPIRES_AT:new Date(Date.now()+90000000).toISOString()}])assert.throws(()=>studioHostConfiguration({...config,...change}));
});

test('host broker is origin pinned, credential private, bounded and fails closed without retries',async()=>{
 const token='ch_'+secret;let requests=0;
 assert.throws(()=>createHostBroker({token,url:'https://coatria.com/redirect'}));
 const broker=createHostBroker({token,fetch:async(url:any,options:any)=>{requests++;assert.equal(String(url),'https://coatria.com/api/host/credentials');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);return new Response(JSON.stringify({code:'HOST_LEASE_LOST'}),{status:409});}});
 await assert.rejects(()=>broker.credentials({supervisorId:randomUUID()},undefined),(error:any)=>error instanceof RuntimeError&&error.code==='HOST_LEASE_LOST'&&!error.message.includes(secret));assert.equal(requests,1);
 let cancelled=false;const oversized=createHostBroker({token,fetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}))});
 await assert.rejects(()=>oversized.identify(undefined));assert.equal(cancelled,true);
 let stopped=false;const timeout=createHostBroker({token,timeoutMs:20,fetch:async()=>new Response(new ReadableStream({cancel(){stopped=true;}}))});
 const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(()=>timeout.identify(undefined));assert.equal(stopped,true);}finally{clearTimeout(keepAlive);}
});

test('two agent slots are independent, bounded and give each approved specialist a turn',async()=>{
 const f=await fixture(4);const seen:string[]=[],configured:any[]=[];let active=0,maximum=0,completed=0,releaseSlots!:()=>void;const twoSlots=new Promise<void>(resolve=>releaseSlots=resolve);
 try{
  const result=await runStudioHost({...f.options,concurrency:2,clientFactory:clientFactory(f.bundles,item=>jobClient(item,{complete:async()=>{completed++;if(completed===4)f.control.abort();return{};}})),executorFactory:({settings:explicit}:any)=>{configured.push(explicit);return async({run,signal}:any)=>{active++;maximum=Math.max(maximum,active);seen.push(run.agentId);if(active===2)releaseSlots();await Promise.race([twoSlots,waitForAbort(signal)]);signal.throwIfAborted();active--;return{result:'Synthetic reviewed output'};};}});
  assert.equal(result.cleanupComplete,true);assert.equal(maximum,2);assert.equal(new Set(seen.slice(0,4)).size,4);assert.equal(configured.length,4);assert(configured.every(value=>Object.isFrozen(value)&&value.RUNPOD_API_KEY===settings.RUNPOD_API_KEY&&!('COATRIA_AGENT_TOKEN'in value)));assert(!JSON.stringify(f.events).includes(secret));
 }finally{await f.remove();}
});

test('explicit inference broker mode runs a hosted specialist without forwarding provider credentials',async()=>{
 const f=await fixture();let inferenceCalls=0,completed=0,directCalls=0;const configured:any[]=[];
 try{
  const clients=clientFactory(f.bundles,item=>{
   const client=jobClient(item,{complete:async()=>{completed++;f.control.abort();return{run:{status:'succeeded'}};}});
   return{...client,listTools:async()=>({tools:[]}),submitInference:async(runId:string,payload:any)=>{
    inferenceCalls++;assert.deepEqual(Object.keys(payload).sort(),['leaseToken','requestId','step']);
    return{inference:{id:randomUUID(),runId,step:payload.step,status:'succeeded',deadlineAt:new Date(Date.now()+60000).toISOString(),output:{usage:{prompt_tokens:100,completion_tokens:30},choices:[{finish_reason:'stop',message:{role:'assistant',content:'Synthetic server-brokered result.'}}]}}};
   }};
  });
  const result=await runStudioHost({...f.options,settings:{...settings,COATRIA_INFERENCE_MODE:'coatria_broker_v1'},clientFactory:clients,executorFactory:({settings:explicit}:any)=>{configured.push(explicit);return createProviderExecutor({settings:explicit,fetch:(async()=>{directCalls++;throw Error('No direct provider transport');}) as typeof fetch});}});
  assert.equal(result.cleanupComplete,true);assert.equal(inferenceCalls,1);assert.equal(completed,1);assert.equal(directCalls,0);assert.equal(configured[0].COATRIA_INFERENCE_MODE,'coatria_broker_v1');assert(Object.isFrozen(configured[0]));assert(!('RUNPOD_API_KEY'in configured[0]));assert(!('COATRIA_RUNPOD_ENDPOINT_ID'in configured[0]));assert(!JSON.stringify(f.events).includes(settings.RUNPOD_API_KEY));
 }finally{await f.remove();}
});

test('failed broker renewal aborts inference and keeps the uncertain journal without duplicate execution',async()=>{
 const f=await fixture();let renewals=0,executions=0;const original=f.broker.credentials;
 f.broker.credentials=async(body:any)=>{if(++renewals>1&&executions>0)throw new RuntimeError(401,'HOST_UNAVAILABLE');return original(body);};
 try{
  const result=await runStudioHost({...f.options,refreshMs:10,clientFactory:clientFactory(f.bundles,item=>jobClient(item)),executorFactory:()=>async({signal}:any)=>{executions++;await waitForAbort(signal);throw Error(secret);}});
  assert.equal(result.reason,'broker_unavailable');assert.equal(result.cleanupComplete,true);assert.equal(executions,1);
  const [path]=await journals(f.directory,f.bundles[0].agentId),state=JSON.parse(await readFile(path,'utf8'));assert.equal(state.job.started,true);assert.equal(state.job.outcome,null);
  assert(f.events.every(entry=>Object.keys(entry).every(key=>['at','event'].includes(key))));assert(!JSON.stringify(f.events).includes(secret));
 }finally{await f.remove();}
});

test('revoking a hosted specialist cancels its active work while retaining the host lease',async()=>{
 const f=await fixture();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),original=f.broker.credentials;let remove=false,aborted=false;
 f.broker.credentials=async(body:any)=>{const result=await original(body);if(remove)return{...result,credentials:[]};return result;};
 try{
  const operation=runStudioHost({...f.options,refreshMs:10,clientFactory:clientFactory(f.bundles,item=>jobClient(item)),executorFactory:()=>async({signal}:any)=>{started();await waitForAbort(signal);aborted=true;throw Error(secret);},log:entry=>{f.events.push(entry);if(entry.event==='agent-retired')f.control.abort();}});
  await readyBeforeStop(ready,operation);remove=true;const result=await operation;assert.equal(aborted,true);assert.equal(result.reason,'operator_stop');assert.equal(result.cleanupComplete,true);assert(f.events.some(entry=>entry.event==='agent-retired'));
 }finally{await f.remove();}
});

test('foreign company, agent, installation, character or expanded capability never reaches inference',async()=>{
 for(const mismatch of['company','agent','installation','character','capability']){
  const f=await fixture();let executions=0;
  try{
   const result=await runStudioHost({...f.options,clientFactory:clientFactory(f.bundles,item=>{const normal=jobClient(item);return{...normal,context:async()=>{const result=await normal.context();if(mismatch==='company')result.run.companyId=randomUUID();if(mismatch==='agent')result.run.agentId=randomUUID();if(mismatch==='installation')result.installation.id=randomUUID();if(mismatch==='character')result.installation.character={...result.installation.character,roleTitle:'Other'};if(mismatch==='capability')result.capabilities=[...result.capabilities,'tasks.write'];return result;}};}),executorFactory:()=>async()=>{executions++;return{result:'Invalid'};}});
   assert.equal(result.reason,'agent_scope_changed');assert.equal(executions,0);
  }finally{await f.remove();}
 }
});

test('a mismatched credential identity is rejected before any scheduler or claim mutation',async()=>{
 const f=await fixture();let writes=0;
 try{const result=await runStudioHost({...f.options,clientFactory:clientFactory(f.bundles,item=>({readIdentity:async()=>({agent:{id:item.agentId,companyId:randomUUID(),status:'active',capabilities:item.capabilities}}),autonomyTick:async()=>{writes++;},claim:async()=>{writes++;}}))});assert.equal(result.reason,'host_error');assert.equal(writes,0);}finally{await f.remove();}
});

test('supervisor restart restores identity and cannot extend its original absolute cutoff',async()=>{
 const f=await fixture(0);let identity:string|undefined,contacts=0;const original=f.broker.credentials;
 f.broker.credentials=async(body:any)=>{if(identity)assert.equal(body.supervisorId,identity);identity=body.supervisorId;contacts++;const response=await original(body);f.control.abort();return response;};
 try{
  await runStudioHost({...f.options,clientFactory:clientFactory([])});
  const path=join(f.directory,'supervisor-private.json');const first=JSON.parse(await readFile(path,'utf8'));assert.equal(first.supervisor.deadlineMs,f.deadlineMs);
  const control=new AbortController();f.broker.credentials=async(body:any)=>{assert.equal(body.supervisorId,identity);contacts++;const response=await original(body);control.abort();return response;};
  await runStudioHost({...f.options,deadlineMs:f.deadlineMs+1000,signal:control.signal,clientFactory:clientFactory([])});
  assert.equal(contacts,2);assert.equal(JSON.parse(await readFile(path,'utf8')).supervisor.deadlineMs,f.deadlineMs);
 }finally{await f.remove();}
});

test('independent lease timer stops a working specialist even while renewal is pending',async()=>{
 const f=await fixture();let calls=0,aborted=false,entered=false,shortLease=false;const original=f.broker.credentials;
 f.broker.credentials=async(body:any,signal?:AbortSignal)=>{
  calls++;if(!shortLease){const response=await original(body);if(entered){shortLease=true;response.supervisor.expiresAt=new Date(Date.now()+700).toISOString();}return response;}
  await waitForAbort(signal!);throw signal!.reason;
 };
 try{
  const result=await runStudioHost({...f.options,refreshMs:20,clientFactory:clientFactory(f.bundles,item=>jobClient(item)),executorFactory:()=>async({signal}:any)=>{entered=true;await waitForAbort(signal);aborted=true;throw Error(secret);}});
  assert.equal(result.reason,'lease_expired');assert.equal(aborted,true);assert.equal(result.cleanupComplete,true);assert(calls>=3);
 }finally{await f.remove();}
});

test('a resumed uncertain run is reconciled as failed without a second provider request',async()=>{
 const f=await fixture();let started!:()=>void,failed=0,providerRequests=0;const ready=new Promise<void>(resolve=>started=resolve);
 const clients=clientFactory(f.bundles,item=>jobClient(item));
 try{
  const first=runStudioHost({...f.options,clientFactory:clients,executorFactory:()=>async({signal}:any)=>{started();await waitForAbort(signal);throw Error(secret);}});
  await readyBeforeStop(ready,first);f.control.abort();assert.equal((await first).cleanupComplete,true);
  const control=new AbortController();
  await runStudioHost({...f.options,signal:control.signal,clientFactory:clientFactory(f.bundles,item=>jobClient(item,{fail:async()=>{failed++;control.abort();return{};}})),executorFactory:({settings:explicit}:any)=>createProviderExecutor({settings:explicit,fetch:async()=>{providerRequests++;throw Error('Should never contact inference during uncertain recovery.');}})});
  assert.equal(failed,1);assert.equal(providerRequests,0);const [path]=await journals(f.directory,f.bundles[0].agentId);assert.equal(JSON.parse(await readFile(path,'utf8')).job,null);
 }finally{await f.remove();}
});

test('bootstrap pins source hashes and image, drops privileges and excludes agent credentials from environment',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 await assert.rejects(()=>buildStudioBootstrap({commit:'main',root}));
 const built=await buildStudioBootstrap({commit:'a'.repeat(40),root});assert.match(built.image,/^node@sha256:[a-f0-9]{64}$/);assert.equal(built.manifest.length,3);assert(built.manifest.every((entry:any)=>/^[a-f0-9]{64}$/.test(entry.sha256)));
 const encoded=built.args.match(/base64,([A-Za-z0-9+/=]+)/)?.[1];assert(encoded);const source=Buffer.from(encoded,'base64').toString('utf8');
 assert(source.includes("uid:1000,gid:1000"));assert(source.includes("'/state/studio'"));assert(source.includes("'COATRIA_HOST_TOKEN'"));assert(!source.includes('COATRIA_AGENT_TOKEN'));assert(!source.includes(settings.RUNPOD_API_KEY));assert(source.includes("redirect:'error'"));
});

test('renewed host identities have separate stable journal namespaces and preserve prior host paths',()=>{
 const first=studioHostStateDirectory(companyId,hostId),second=studioHostStateDirectory(companyId,randomUUID()),foreign=studioHostStateDirectory(randomUUID(),hostId);
 assert.equal(first,`/state/studio/${companyId}/${hostId}`);assert.notEqual(first,second);assert.notEqual(first,foreign);assert.equal(studioHostStateDirectory(companyId.toUpperCase(),hostId.toUpperCase()),first);
 for(const bad of ['../other','',hostId+'/other'])assert.throws(()=>studioHostStateDirectory(companyId,bad));
 const config=studioHostConfiguration({COATRIA_HOST_COMPANY_ID:companyId,COATRIA_HOST_ID:hostId,COATRIA_HOST_MODEL_ID:modelId,COATRIA_HOST_EXPIRES_AT:new Date(Date.now()+60000).toISOString()});assert.equal(config.directory,resolve(first));
});
