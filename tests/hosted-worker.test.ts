import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,lstat,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {hostConfiguration,runHostedWorker} from '../scripts/hosting/run-company-worker.mjs';
import {RuntimeError} from '../public/downloads/agent-worker.mjs';

const companyId='10000000-0000-4000-8000-000000000751',agentId='10000000-0000-4000-8000-000000000752';
const fixtureSecret='fixture-private-lease-not-real';
async function directory(){return mkdtemp(join(tmpdir(),'coatria-hosted-test-'));}
async function remove(path:string){const local=relative(tmpdir(),path);assert(local&&!local.startsWith('..')&&!isAbsolute(local));await rm(path,{recursive:true,force:true});}
function client(overrides:any={}){return{origin:'https://coatria.com',identity:'fixture-identity',autonomyTick:async()=>({runs:[]}),claim:async()=>({run:null}),heartbeat:async()=>({}),complete:async()=>({}),fail:async()=>({}),...overrides};}
const run=()=>({id:randomUUID(),companyId,agentId,prompt:'Synthetic hosting fixture',attempts:1});
const context=(item:any)=>({run:item,capabilities:[],installation:{pluginId:'runpod',runtimeConfig:{providerId:'runpod'}}});

test('host requires fixed identity, private absolute path and a bounded absolute deadline',()=>{
 const now=Date.now(),settings={COATRIA_HOST_COMPANY_ID:companyId,COATRIA_HOST_AGENT_ID:agentId,COATRIA_HOST_STATE_DIR:tmpdir(),COATRIA_HOST_EXPIRES_AT:new Date(now+60000).toISOString()};
 assert.equal(hostConfiguration(settings,now).deadlineMs,Date.parse(settings.COATRIA_HOST_EXPIRES_AT));
 for(const change of[{COATRIA_HOST_COMPANY_ID:'other'},{COATRIA_HOST_AGENT_ID:''},{COATRIA_HOST_STATE_DIR:'relative'},{COATRIA_HOST_EXPIRES_AT:''},{COATRIA_HOST_EXPIRES_AT:new Date(now+86400001).toISOString()}])assert.throws(()=>hostConfiguration({...settings,...change},now));
});

test('expired deadline never contacts an API and cannot reset its budget on restart',async()=>{
 const folder=await directory();let actions=0,hooks=0;const options={directory:folder,companyId,agentId,deadlineMs:Date.now()-1,client:client({autonomyTick:async()=>{actions++;},claim:async()=>{actions++;}}),execute:async()=>{actions++;return{};},onShutdown:async()=>{hooks++;}};
 try{for(let n=0;n<2;n++)assert.equal((await runHostedWorker(options)).reason,'deadline');assert.equal(actions,0);assert.equal(hooks,2);await assert.rejects(()=>lstat(join(folder,'worker-private.json')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');}finally{await remove(folder);}
});

test('idle host stops at deadline, releases its lock and logs no secrets',async(t)=>{
 const folder=await directory(),events:any[]=[];let claims=0,shutdown=0,firstClaim!:()=>void;
 const claimed=new Promise<void>(resolve=>firstClaim=resolve);
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 try{
  const operation=runHostedWorker({directory:folder,companyId,agentId,deadlineMs:Date.now()+1000,client:client({claim:async()=>{claims++;firstClaim();return{run:null};}}),execute:async()=>{throw new Error(fixtureSecret);},log:event=>events.push(event),onShutdown:async()=>{shutdown++;},pollMs:10});
  // File I/O can be delayed by concurrent suites. Advance the actual deadline
  // timer only once this host has reached its first idle queue check.
  await claimed;t.mock.timers.tick(1001);const result=await operation;
  assert.equal(result.reason,'deadline');assert.equal(result.exitCode,0);assert(claims>0);assert.equal(shutdown,1);await assert.rejects(()=>lstat(join(folder,'worker-private.json.lock')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');assert.equal(JSON.parse(await readFile(join(folder,'host-status.json'),'utf8')).status,'stopped');assert(!JSON.stringify(events).includes(fixtureSecret));
 }finally{t.mock.timers.reset();await remove(folder);}
});

test('operator stop awaits adapter cancellation and preserves uncertain execution state',async()=>{
 const folder=await directory(),control=new AbortController(),item=run();let started!:()=>void,cleaned=false,completed=0;const ready=new Promise<void>(resolve=>started=resolve);
 try{const operation=runHostedWorker({directory:folder,companyId,agentId,deadlineMs:Date.now()+5000,signal:control.signal,client:client({claim:async()=>({run:item,leaseToken:fixtureSecret,leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),context:async()=>context(item),complete:async()=>{completed++;}}),execute:async({signal}:any)=>{started();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));await new Promise(resolve=>setTimeout(resolve,30));cleaned=true;throw new Error(fixtureSecret);}});await ready;control.abort();const result=await operation;assert.equal(result.reason,'operator_stop');assert.equal(result.cleanupComplete,true);assert.equal(cleaned,true);assert.equal(completed,0);const state=JSON.parse(await readFile(join(folder,'worker-private.json'),'utf8'));assert.equal(state.job.started,true);assert(!JSON.stringify(JSON.parse(await readFile(join(folder,'host-status.json'),'utf8'))).includes(fixtureSecret));}finally{await remove(folder);}
});

test('wrong company or provider never reaches the inference adapter',async()=>{
 for(const mismatch of['company','agent','provider']){const folder=await directory(),control=new AbortController(),item=run();let inferences=0,failures=0;const leased=context({...item,...(mismatch==='company'?{companyId:randomUUID()}:mismatch==='agent'?{agentId:randomUUID()}:{})});if(mismatch==='provider')leased.installation.pluginId='openai';
  try{await runHostedWorker({directory:folder,companyId,agentId,deadlineMs:Date.now()+5000,signal:control.signal,client:client({claim:async()=>({run:item,leaseToken:fixtureSecret,leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),context:async()=>leased,fail:async()=>{failures++;control.abort();return{run:{status:'failed'}};}}),execute:async()=>{inferences++;return{result:'must not happen'};}});assert.equal(inferences,0);assert.equal(failures,1);}finally{await remove(folder);}
 }
});

test('authentication failure exits without an infinite retry loop or raw diagnostics',async()=>{
 const folder=await directory(),events:any[]=[];let tries=0;
 try{const result=await runHostedWorker({directory:folder,companyId,agentId,deadlineMs:Date.now()+5000,client:client({autonomyTick:async()=>{tries++;throw new RuntimeError(401,'AGENT_REVOKED');}}),execute:async()=>({}),log:event=>events.push(event)});assert.equal(result.reason,'access_ended');assert.equal(result.exitCode,1);assert.equal(tries,1);assert(events.every(item=>Object.keys(item).every(key=>['at','event'].includes(key))));}finally{await remove(folder);}
});

test('SIGTERM follows the cooperative path and removes its process handlers',async()=>{
 const folder=await directory();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),before=process.listenerCount('SIGTERM');
 try{const pending=runHostedWorker({directory:folder,companyId,agentId,deadlineMs:Date.now()+5000,client:client({claim:async()=>{started();return{run:null};}}),execute:async()=>({})});await ready;process.emit('SIGTERM');const result=await pending;assert.equal(result.reason,'signal');assert.equal(result.exitCode,0);assert.equal(process.listenerCount('SIGTERM'),before);}finally{await remove(folder);}
});
