#!/usr/bin/env node
// Operator-owned execution. No model SDK, generated command, or shell is launched here.
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,open,unlink,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalCodes=new Set(['RUN_LEASE_LOST','RUN_CANCELLED']);
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
export function stableRequestId(runId,key){
 if(!UUID.test(runId)||typeof key!=='string'||!key||key.length>200)throw new Error('A run UUID and a nonempty logical operation key are required.');
 const bytes=Buffer.from(fingerprint(runId+'\0'+key).slice(0,32),'hex');bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function runtimeOrigin(value){
 let url;try{url=new URL(value);}catch{throw new Error('Use a valid Coatria HTTPS origin.');}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(local&&url.protocol==='http:')))throw new Error('Use a plain HTTPS Coatria origin; HTTP is allowed only on loopback.');
 return url.origin;
}
export class RuntimeError extends Error{
 constructor(status,code,retryAfter=0){super('Coatria request failed'+(status?' ('+status+')':'')+'.');this.status=status;this.code=typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'REQUEST_FAILED';this.retryAfter=retryAfter;}
}
export function pause(ms,signal){return new Promise((resolvePause,reject)=>{if(signal?.aborted)return reject(signal.reason);const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolvePause();},ms);signal?.addEventListener('abort',abort,{once:true});});}
async function boundedJson(response){
 const reader=response.body?.getReader();if(!reader)throw new RuntimeError(502,'INVALID_RESPONSE');let size=0;const chunks=[];
 while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1024*1024){await reader.cancel();throw new RuntimeError(502,'RESPONSE_TOO_LARGE');}chunks.push(chunk.value);}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RuntimeError(502,'INVALID_RESPONSE');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError(502,'INVALID_RESPONSE');return value;
}
/** @param {{token?:string,url?:string,fetch?:typeof globalThis.fetch,timeoutMs?:number,retryBaseMs?:number}} options */
export function createRuntimeClient({token=process.env.COATRIA_AGENT_TOKEN,url=process.env.COATRIA_URL||'https://coatria.com',fetch:transport=globalThis.fetch,timeoutMs=20000,retryBaseMs=300}={}){
 if(typeof token!=='string'||!/^ca_[A-Za-z0-9_-]{8,200}$/.test(token))throw new Error('Set a valid COATRIA_AGENT_TOKEN in the worker environment.');
 const origin=runtimeOrigin(url);
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new Error('Invalid request timeout.');
 async function request(path,{method='GET',body=undefined,signal=undefined,headers={}}={}){
  const target=new URL(path,origin);if(target.origin!==origin||!target.pathname.startsWith('/api/agent/')||target.username||target.password||target.hash)throw new Error('Only Coatria agent API paths are allowed.');
  const encoded=body===undefined?undefined:JSON.stringify(body),maxBytes=target.pathname.startsWith('/api/agent/tools/')?256*1024:65000;if(encoded&&Buffer.byteLength(encoded)>maxBytes)throw new RuntimeError(413,'REQUEST_TOO_LARGE');
  for(let attempt=0;;attempt++){
   signal?.throwIfAborted();let error;
   try{
    const deadline=AbortSignal.timeout(timeoutMs),response=await transport(target,{method,redirect:'error',headers:{...headers,Authorization:'Bearer '+token,...(encoded===undefined?{}:{'Content-Type':'application/json'})},body:encoded,signal:signal?AbortSignal.any([signal,deadline]):deadline});
    const data=await boundedJson(response);
    if(response.ok)return data;
    const retry=Number(response.headers.get('retry-after'));throw new RuntimeError(response.status,data.code,Number.isFinite(retry)&&retry>0?retry:0);
   }catch(caught){if(signal?.aborted)throw signal.reason;error=caught instanceof RuntimeError?caught:new RuntimeError(0,'NETWORK_ERROR');}
   if(attempt>=2||!(error.status===0||error.status===429||error.status>=500))throw error;
   const delay=error.retryAfter?error.retryAfter*1000:retryBaseMs*2**attempt;
   if(delay>10000)throw error;await pause(delay,signal);
  }
 }
 const runPath=runId=>{if(!UUID.test(runId))throw new Error('A run UUID is required.');return '/api/agent/runs/'+runId;};
 const post=(path,body,signal)=>request(path,{method:'POST',body,signal});
 return {origin,identity:fingerprint(token),
  claim:(workerId,claimId,signal)=>post('/api/agent/runs/claim',{workerId,claimId},signal),
  heartbeat:(runId,leaseToken,signal)=>post(runPath(runId)+'/heartbeat',{leaseToken},signal),
  context:(runId,leaseToken,signal)=>request(runPath(runId)+'/context',{headers:{'X-Coatria-Run-Lease':leaseToken},signal}),
  complete:(runId,payload,signal)=>post(runPath(runId)+'/complete',payload,signal),
  fail:(runId,payload,signal)=>post(runPath(runId)+'/fail',payload,signal),
  listTools:signal=>request('/api/agent/tools',{signal}),
  callTool:(name,{runId,leaseToken,requestId,arguments:args},signal)=>{
   if(typeof name!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(name)||!UUID.test(runId)||!UUID.test(requestId)||!args||typeof args!=='object'||Array.isArray(args))throw new Error('A named tool, run UUID, request UUID and arguments object are required.');
   return post('/api/agent/tools/'+encodeURIComponent(name),{runId,leaseToken,requestId,arguments:args},signal);
  }};
}

/** Private state stores lease credentials. Use one state file per worker. */
export async function openWorkerState(path,client){
 path=resolve(path);await mkdir(dirname(path),{recursive:true,mode:0o700});const lockPath=path+'.lock',lockId=randomUUID();
 async function acquire(){try{const handle=await open(lockPath,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,id:lockId}));await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;let lock;try{const info=await lstat(lockPath);if(!info.isFile()||info.isSymbolicLink())throw new Error();lock=JSON.parse(await readFile(lockPath,'utf8'));if(!Number.isInteger(lock.pid)||lock.pid<1)throw new Error();}catch{throw new Error('Worker state is locked; inspect the private lock file before restarting.');}try{process.kill(lock.pid,0);}catch(probe){if(probe.code==='ESRCH'){await unlink(lockPath);return acquire();}}throw new Error('Another worker owns this state file.');}}
 await acquire();
 const close=async()=>{try{const lock=JSON.parse(await readFile(lockPath,'utf8'));if(lock.id===lockId)await unlink(lockPath);}catch(error){if(error.code!=='ENOENT')throw error;}};
 try{
  let data;try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>512000)throw new Error('Invalid worker state file.');data=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Worker state is unreadable; keep it for recovery rather than overwriting it.');}
  data||={version:1,origin:client.origin,identity:client.identity,workerId:'worker-'+randomUUID(),claimId:null,job:null};
  if(data.version!==1||data.origin!==client.origin||data.identity!==client.identity||typeof data.workerId!=='string'||data.workerId.length>80)throw new Error('Worker state belongs to a different origin, credential or format.');
  let writing=Promise.resolve();
  const save=()=>{const bytes=JSON.stringify(data);if(Buffer.byteLength(bytes)>512000)throw new Error('Worker state exceeds its size limit.');writing=writing.then(async()=>{const temporary=path+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}});return writing;};
  await save();return {data,save,close};
 }catch(error){await close();throw error;}
}

function ended(error){return error instanceof RuntimeError&&(terminalCodes.has(error.code)||[401,403].includes(error.status));}
/** Execute one durable claim. Adapter work is cooperative and may be retried by the server.
 * @param {{client:any,state:any,execute:(options:any)=>any,signal?:AbortSignal,heartbeatMs?:number,log?:(entry:Record<string,unknown>)=>void}} options
 */
export async function workOnce({client,state,execute,signal,heartbeatMs=15000,log=()=>{}}){
 const clear=async()=>{state.data.job=null;state.data.claimId=null;await state.save();};
 if(!state.data.claimId){state.data.claimId=randomUUID();await state.save();}
 if(!state.data.job){
  let claimed;try{claimed=await client.claim(state.data.workerId,state.data.claimId,signal);}catch(error){if(ended(error))await clear();throw error;}
  if(!claimed.run){await clear();return false;}
  if(!UUID.test(claimed.run.id)||typeof claimed.leaseToken!=='string'||!Number.isFinite(Date.parse(claimed.leaseExpiresAt)))throw new RuntimeError(502,'INVALID_CLAIM');
  state.data.job={run:claimed.run,leaseToken:claimed.leaseToken,leaseExpiresAt:claimed.leaseExpiresAt,started:false,outcome:null};await state.save();
 }
 const job=state.data.job;
 // A prior completion may already be committed. Reconcile it with its original
 // key even after local lease expiry; the server decides replay vs lease loss.
 if(job.outcome){try{await client[job.outcome.kind](job.run.id,job.outcome.payload,signal);await clear();return true;}catch(error){if(ended(error))await clear();throw error;}}
 const control=new AbortController(),stopHeartbeat=new AbortController();let expires=Date.parse(job.leaseExpiresAt),expiryTimer,heartbeatAfter=0;
 const externalAbort=()=>control.abort(signal.reason);if(signal?.aborted)externalAbort();else signal?.addEventListener('abort',externalAbort,{once:true});
 const arm=()=>{clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>control.abort(new RuntimeError(409,'RUN_LEASE_LOST')),Math.max(0,expires-Date.now()-1000));};arm();
 const heartbeat=(async()=>{while(!stopHeartbeat.signal.aborted&&!control.signal.aborted){try{const heartbeatSignal=AbortSignal.any([stopHeartbeat.signal,control.signal]);await pause(Math.max(heartbeatAfter-Date.now(),Math.min(heartbeatMs,Math.max(50,(expires-Date.now())/3))),heartbeatSignal);if(stopHeartbeat.signal.aborted||control.signal.aborted)return;const update=await client.heartbeat(job.run.id,job.leaseToken,heartbeatSignal);if(['cancelled','failed','succeeded'].includes(update.run?.status)){control.abort(new RuntimeError(409,update.run.status==='cancelled'?'RUN_CANCELLED':'RUN_LEASE_LOST'));return;}const next=Date.parse(update.leaseExpiresAt);if(!Number.isFinite(next))throw new RuntimeError(502,'INVALID_HEARTBEAT');expires=next;job.leaseExpiresAt=update.leaseExpiresAt;await state.save();arm();}catch(error){if(stopHeartbeat.signal.aborted||control.signal.aborted)return;if(ended(error)){control.abort(error);return;}if(error.retryAfter)heartbeatAfter=Date.now()+error.retryAfter*1000;log({event:'heartbeat-delayed',runId:job.run.id,code:error.code||'REQUEST_FAILED'});}}})();
 try{
  if(!job.outcome){
   const recovering=job.started;job.started=true;await state.save();const context=await client.context(job.run.id,job.leaseToken,control.signal);
   const tools={key:key=>stableRequestId(job.run.id,key),list:()=>client.listTools(control.signal),call:async(name,args,{requestId}={})=>{control.signal.throwIfAborted();if(!UUID.test(requestId||''))throw new Error('Pass a stable requestId, for example tools.key("logical-step").');const response=await client.callTool(name,{runId:job.run.id,leaseToken:job.leaseToken,requestId,arguments:args},control.signal);return response.result;}};
   // Trusted adapter configuration is separate from model-visible run context.
   const mcpEnvironment={COATRIA_URL:client.origin,COATRIA_RUN_ID:job.run.id,COATRIA_RUN_LEASE:job.leaseToken};
   const execution=Promise.resolve().then(()=>{control.signal.throwIfAborted();return execute({run:context.run||job.run,context,tools,signal:control.signal,recovering,mcpEnvironment});});
   let abortHandler;const aborted=new Promise((_,reject)=>{abortHandler=()=>reject(control.signal.reason);if(control.signal.aborted)abortHandler();else control.signal.addEventListener('abort',abortHandler,{once:true});});
   try{
    const result=await Promise.race([execution,aborted]);control.signal.throwIfAborted();
    if(!result||typeof result.result!=='string'||!result.result.trim()||result.result.length>12000)throw new Error('Adapter must return {result: nonempty text up to 12000 characters, artifactUrl?}.');
    if(result.artifactUrl!==undefined){const artifact=new URL(result.artifactUrl);if(!['https:','http:'].includes(artifact.protocol)||artifact.username||artifact.password)throw new Error('Adapter artifact URL is invalid.');}
    job.outcome={kind:'complete',payload:{leaseToken:job.leaseToken,clientId:randomUUID(),result:result.result,...(result.artifactUrl?{artifactUrl:result.artifactUrl}:{})}};
   }catch(error){if(control.signal.aborted||ended(error))throw error;job.outcome={kind:'fail',payload:{leaseToken:job.leaseToken,clientId:randomUUID(),error:'The external adapter failed. Inspect its private local diagnostics; external effects may require reconciliation.'}};log({event:'adapter-failed',runId:job.run.id});}
   finally{control.signal.removeEventListener('abort',abortHandler);}
   await state.save();
  }
  stopHeartbeat.abort();await heartbeat;
  const result=await client[job.outcome.kind](job.run.id,job.outcome.payload,control.signal);
  log({event:job.outcome.kind==='complete'?'result-recorded':'failure-recorded',runId:job.run.id,status:result.run?.status||'unknown'});await clear();return true;
 }catch(error){if(ended(error)||control.signal.aborted&&ended(control.signal.reason)){await clear();}throw error;}
 finally{stopHeartbeat.abort();clearTimeout(expiryTimer);signal?.removeEventListener('abort',externalAbort);await heartbeat;}
}

async function main(){
 const {values}=parseArgs({options:{adapter:{type:'string'},state:{type:'string'},url:{type:'string'},once:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
 if(values.help){console.log('Usage: node agent-worker.mjs --adapter ./approved-adapter.mjs [--state PRIVATE_PATH] [--url https://coatria.com] [--once]\nSet COATRIA_AGENT_TOKEN privately. Adapter exports execute({run,context,tools,signal,recovering}) and returns {result,artifactUrl?}. No provider is installed or selected automatically.');return;}
 if(!values.adapter)throw new Error('Pass --adapter with an operator-approved local JavaScript module.');
 const client=createRuntimeClient({url:values.url});
 const path=values.state||join(homedir(),'.coatria','workers',fingerprint(client.origin+client.identity).slice(0,24)+'.json'),state=await openWorkerState(path,client),controller=new AbortController();
 const stop=()=>controller.abort(new Error('Worker stopped.'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const log=entry=>console.error(JSON.stringify(entry));
 try{const adapter=await import(pathToFileURL(resolve(values.adapter)).href);if(typeof adapter.execute!=='function')throw new Error('The adapter must export an execute function.');do{try{const worked=await workOnce({client,state,execute:adapter.execute,signal:controller.signal,log});if(values.once)return;if(!worked)await pause(3000,controller.signal);}catch(error){if(controller.signal.aborted)return;log({event:'worker-paused',code:error instanceof RuntimeError?error.code:'WORKER_ERROR',status:error instanceof RuntimeError?error.status:0});if(!(error instanceof RuntimeError)||[401,403].includes(error.status)||values.once)throw error;await pause(Math.max(3000,Math.min(300000,(error.retryAfter||0)*1000)),controller.signal);}}while(!controller.signal.aborted);}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await state.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Worker stopped. Check configuration and private state; credentials and server response bodies are not printed.');process.exitCode=1;});
