#!/usr/bin/env node
// Curated HTTP harness only. Broker credentials never become model context,
// process arguments, executable modules, or a shared mutable environment.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,chmod,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runtimeOrigin,createRuntimeClient,openWorkerState,workOnce,createAutonomyTicker,RuntimeError,pause} from '../../public/downloads/agent-worker.mjs';
import {createProviderExecutor,providerConfiguration} from '../../public/downloads/provider-adapter.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function integer(value,min,max){return Number.isSafeInteger(value)&&value>=min&&value<=max;}
function utc(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)?Date.parse(value):NaN;}
function directoryPath(value){if(typeof value!=='string'||!isAbsolute(value)||resolve(value)===dirname(resolve(value)))throw Error('Private absolute state directory required.');return resolve(value);}
async function abortable(operation,signal){let abort;try{return await Promise.race([operation,new Promise((_resolve,reject)=>{abort=()=>reject(signal.reason);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}}

/** @param {Record<string,string|undefined>} settings */
export function studioHostConfiguration(settings=process.env,now=Date.now()){
 const companyId=settings.COATRIA_HOST_COMPANY_ID,hostId=settings.COATRIA_HOST_ID;
 const deadlineMs=utc(settings.COATRIA_HOST_EXPIRES_AT),concurrency=Number(settings.COATRIA_HOST_CONCURRENCY||1);
 if(!UUID.test(companyId||'')||!UUID.test(hostId||'')||!Number.isFinite(deadlineMs)||deadlineMs>now+86400000||!integer(concurrency,1,2))throw Error('Pin the company, host, absolute UTC deadline and concurrency (1 or 2).');
 const modelId=settings.COATRIA_HOST_MODEL_ID;
 if(typeof modelId!=='string'||!/^[-A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(modelId)||modelId.includes('..'))throw Error('Pin the approved hosted model.');
 return{directory:directoryPath(settings.COATRIA_HOST_STATE_DIR||'/state/studio/'+companyId.toLowerCase()+'/'+hostId.toLowerCase()),companyId,hostId,deadlineMs,concurrency,modelId};
}

/** No broker retries: an uncertain or rejected renewal stops the local fleet.
 * @param {{token?:string,url?:string,fetch?:typeof globalThis.fetch,timeoutMs?:number}} options */
export function createHostBroker({token=process.env.COATRIA_HOST_TOKEN,url=process.env.COATRIA_URL||'https://coatria.com',fetch:transport=globalThis.fetch,timeoutMs=10000}={}){
 if(typeof token!=='string'||!/^ch_[A-Za-z0-9_-]{8,200}$/.test(token)||!integer(timeoutMs,1,20000))throw Error('Valid private host token and bounded timeout required.');
 const origin=runtimeOrigin(url);
 async function request(path,body,signal){
  const active=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  let reader;
  try{
   const operation=(async()=>{
   const response=await transport(origin+'/api/host/'+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:active});
   reader=response.body?.getReader();if(!reader)throw Error();let size=0;const chunks=[];
   while(true){active.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024){void reader.cancel().catch(()=>{});throw Error();}chunks.push(part.value);}
   active.throwIfAborted();const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(value))throw Error();
   if(!response.ok)throw new RuntimeError(response.status,value.code);
   return value;
   })();
   return await abortable(operation,active);
  }catch(error){if(signal?.aborted)throw signal.reason;throw error instanceof RuntimeError?error:new RuntimeError(0,'HOST_BROKER_UNAVAILABLE');}
  finally{if(active.aborted&&reader)void reader.cancel().catch(()=>{});}
 }
 return{origin,identity:hash(token),identify:signal=>request('identity',undefined,signal),credentials:(body,signal)=>request('credentials',body,signal)};
}

async function boundedCleanup(promises,milliseconds){let timer;return Promise.race([Promise.allSettled(promises).then(()=>true),new Promise(resolveWait=>{timer=setTimeout(()=>resolveWait(false),milliseconds);})]).finally(()=>clearTimeout(timer));}
async function privateDirectory(path){await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Private state directory is unsafe.');if(process.platform!=='win32')await chmod(path,0o700);}

/** Injectable factories are trusted operator/test code, never broker modules.
 * @param {{directory:string,companyId:string,hostId:string,deadlineMs:number,modelId:string,concurrency?:number,broker:any,settings?:Record<string,string|undefined>,signal?:AbortSignal,log?:(entry:Record<string,unknown>)=>void,pollMs?:number,refreshMs?:number,cleanupMs?:number,clientFactory?:(options:any)=>any,executorFactory?:(options:any)=>any}} options */
export async function runStudioHost({directory,companyId,hostId,deadlineMs,modelId,concurrency=1,broker,settings={},signal,log=()=>{},pollMs=3000,refreshMs=20000,cleanupMs=5000,clientFactory=createRuntimeClient,executorFactory=createProviderExecutor}){
 directory=directoryPath(directory);
 if(!UUID.test(companyId)||!UUID.test(hostId)||!Number.isFinite(deadlineMs)||deadlineMs>Date.now()+86400000||!integer(concurrency,1,2)||!integer(pollMs,1,30000)||!integer(refreshMs,1,20000)||!integer(cleanupMs,1,10000))throw Error('Invalid studio host configuration.');
 const control=new AbortController(),agents=new Map(),retired=new Set(),pendingInference=new Set();
 let supervisor,deadlineTimer,leaseTimer,refreshing,reason='completed',exitCode=0,cleanupComplete=true,leaseEpoch,leaseDeadline=0,cursor=0,nextRefresh=0,hostRevision=0;
 const emit=event=>{try{log({at:new Date().toISOString(),event});}catch{/* A diagnostic sink cannot change authority. */}};
 const stop=(why,failure=false)=>{if(!control.signal.aborted){reason=why;if(failure)exitCode=1;control.abort(Error('Studio host stopped.'));emit('host-stopping');}};
 const externalStop=()=>stop('operator_stop'),processStop=()=>stop('signal');
 const armDeadline=()=>{clearTimeout(deadlineTimer);deadlineTimer=setTimeout(()=>stop('deadline'),Math.max(0,deadlineMs-Date.now()));};
 const providerSettings=Object.freeze(Object.fromEntries(['RUNPOD_API_KEY','COATRIA_RUNPOD_ENDPOINT_ID','COATRIA_MAX_STEPS','COATRIA_MAX_OUTPUT_TOKENS','COATRIA_MAX_TOTAL_TOKENS','COATRIA_TIMEOUT_SECONDS'].filter(key=>settings[key]!==undefined).map(key=>[key,settings[key]])));
 function verifyHost(host){
  const expiry=utc(host?.expiresAt);
  if(host?.id!==hostId||host.companyId!==companyId||host.status!=='active'||!integer(host.revision,1,2147483647)||host.revision<hostRevision||!integer(host.maxAgents,1,11)||!Array.isArray(host.providerIds)||host.providerIds.length!==1||host.providerIds[0]!=='runpod'||!Number.isFinite(expiry)||expiry<=Date.now()||expiry>deadlineMs)throw Error('Host scope or expiry changed.');
  hostRevision=host.revision;deadlineMs=Math.min(deadlineMs,expiry);armDeadline();return host;
 }
 function verifyBundle(item){
  if(!UUID.test(item?.agentId||'')||!UUID.test(item?.installationId||'')||!integer(item.credentialVersion,1,2147483647)||!integer(item.installationRevision,1,2147483647)||!/^ca_[A-Za-z0-9_-]{8,200}$/.test(item.agentToken||'')||!Number.isFinite(utc(item.expiresAt))||utc(item.expiresAt)>deadlineMs||utc(item.expiresAt)<=Date.now()||!Array.isArray(item.capabilities)||item.capabilities.length>100||item.capabilities.some(cap=>typeof cap!=='string'||cap.length>100)||new Set(item.capabilities).size!==item.capabilities.length||item.runtime?.pluginId!=='runpod'||item.runtime.runtimeConfig?.providerId!=='runpod'||item.runtime.runtimeConfig?.modelId!==modelId||typeof item.runtime.manifestVersion!=='string'||!object(item.runtime.character))throw Error('Invalid hosted agent bundle.');
  // The same reviewed adapter validates limits and the fixed Runpod endpoint.
  providerConfiguration({installation:item.runtime},providerSettings);
  return hash(canonical(item));
 }
 async function addAgent(bundle,fingerprint){
  const client=clientFactory({url:broker.origin,token:bundle.agentToken});
  if(client.origin!==broker.origin||client.identity!==hash(bundle.agentToken))throw Error('Agent client identity mismatch.');
  const identity=await client.readIdentity(control.signal);
  if(identity?.agent?.id!==bundle.agentId||identity.agent.companyId!==companyId||identity.agent.status!=='active'||canonical([...identity.agent.capabilities].sort())!==canonical([...bundle.capabilities].sort()))throw Error('Hosted agent identity does not match its enrollment.');
  const folder=join(directory,'agents',bundle.agentId);await privateDirectory(folder);
  // A rotated credential has a separate journal. Previous uncertain receipts
  // are retained; broker rotation fences/cancels their old server runs.
  const state=await openWorkerState(join(folder,'credential-'+bundle.credentialVersion+'-'+client.identity.slice(0,16)+'.json'),client);
  const local=new AbortController(),executor=executorFactory({settings:providerSettings});
  const entry={bundle,fingerprint,client,state,control:local,tick:createAutonomyTicker(client),busy:null,nextAt:0,pending:new Set()};
  entry.execute=options=>{
   const installed=options.context?.installation;
   if(control.signal.aborted||local.signal.aborted||Date.now()>=leaseDeadline)throw Error('Host lease ended.');
   if(options.run?.companyId!==companyId||options.run?.agentId!==bundle.agentId||installed?.revision!==bundle.installationRevision||installed.id!==bundle.installationId||canonical({pluginId:installed.pluginId,manifestVersion:installed.manifestVersion,runtimeConfig:installed.runtimeConfig,character:installed.character})!==canonical(bundle.runtime)||!Array.isArray(options.context.capabilities)||options.context.capabilities.some(cap=>!bundle.capabilities.includes(cap))){stop('agent_scope_changed',true);throw Error('Agent runtime differs from its broker approval.');}
   const operation=Promise.resolve().then(()=>{options.signal.throwIfAborted();return executor(options);});pendingInference.add(operation);entry.pending.add(operation);const finished=()=>{pendingInference.delete(operation);entry.pending.delete(operation);};operation.then(finished,finished);return operation;
  };
  if(control.signal.aborted){await state.close();control.signal.throwIfAborted();}
  agents.set(bundle.agentId,entry);emit('agent-state-ready');
 }
 async function retire(entry){
  agents.delete(entry.bundle.agentId);entry.control.abort(Error('Hosted membership or configuration changed.'));retired.add(entry);
  if(entry.busy&&!await boundedCleanup([entry.busy],cleanupMs))throw Error('Agent cleanup is incomplete.');
  // workOnce can finish cancellation before the provider's /cancel completes.
  if(entry.pending.size&&!await boundedCleanup([...entry.pending],cleanupMs))throw Error('Inference cleanup is incomplete.');
  await entry.state.close();retired.delete(entry);emit('agent-retired');
 }
 async function refresh(){
  const response=await broker.credentials({supervisorId:supervisor.data.supervisor.id,...(leaseEpoch===undefined?{}:{leaseEpoch})},control.signal);
  control.signal.throwIfAborted();const host=verifyHost(response.host),lease=response.supervisor;
  const expires=utc(lease?.expiresAt);
  if(lease?.id!==supervisor.data.supervisor.id||!integer(lease.epoch,1,2147483647)||(leaseEpoch!==undefined&&lease.epoch<leaseEpoch)||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+65000||expires>deadlineMs||!Array.isArray(response.credentials)||response.credentials.length>host.maxAgents||!integer(response.pollAfterSeconds,1,30))throw Error('Invalid host lease.');
  const incoming=new Map();for(const bundle of response.credentials){const fingerprint=verifyBundle(bundle);if(incoming.has(bundle.agentId))throw Error('Duplicate agent bundle.');incoming.set(bundle.agentId,{bundle,fingerprint});}
  leaseEpoch=lease.epoch;leaseDeadline=expires;supervisor.data.supervisor.epoch=leaseEpoch;supervisor.data.supervisor.deadlineMs=deadlineMs;await supervisor.save();
  clearTimeout(leaseTimer);leaseTimer=setTimeout(()=>stop('lease_expired',true),Math.max(0,expires-Date.now()-250));
  for(const entry of [...agents.values()])if(incoming.get(entry.bundle.agentId)?.fingerprint!==entry.fingerprint)await retire(entry);
  for(const {bundle,fingerprint} of incoming.values())if(!agents.has(bundle.agentId))await addAgent(bundle,fingerprint);
  nextRefresh=Date.now()+Math.min(refreshMs,response.pollAfterSeconds*1000);emit('lease-renewed');
 }
 async function launch(entry){
  const active=AbortSignal.any([control.signal,entry.control.signal]);
  try{
   await entry.tick(entry.state,active);
   const worked=await workOnce({client:entry.client,state:entry.state,execute:entry.execute,signal:active,log:event=>{if(['result-recorded','failure-recorded','adapter-failed'].includes(event.event))emit(event.event);}});
   entry.nextAt=Date.now()+(worked?0:pollMs);
  }catch(error){
   if(!active.aborted){if(error instanceof RuntimeError&&![401,403].includes(error.status)){entry.nextAt=Date.now()+Math.max(pollMs,Math.min(30000,(error.retryAfter||0)*1000));emit('agent-request-delayed');}else stop('agent_access_ended',true);}
  }finally{
   // A cancelled run can return before provider cancellation finishes. Keep
   // its concurrency slot occupied until cleanup is known to have completed.
   if(entry.pending.size&&!await boundedCleanup([...entry.pending],cleanupMs))stop('inference_cleanup_incomplete',true);
  }
 }
 try{
  if(Date.now()>=deadlineMs)return{reason:'deadline',exitCode:0,cleanupComplete:true};
  await privateDirectory(directory);supervisor=await openWorkerState(join(directory,'supervisor-private.json'),broker);
  if(supervisor.data.supervisor){const saved=supervisor.data.supervisor;if(saved.hostId!==hostId||saved.companyId!==companyId||!UUID.test(saved.id)||!Number.isFinite(saved.deadlineMs)||!integer(saved.epoch??0,0,2147483647))throw Error('Supervisor state scope changed.');deadlineMs=Math.min(deadlineMs,saved.deadlineMs);leaseEpoch=saved.epoch;emit('state-restored');}
  else{supervisor.data.supervisor={id:randomUUID(),hostId,companyId,deadlineMs};await supervisor.save();emit('state-created');}
  if(Date.now()>=deadlineMs){reason='deadline';return{reason,exitCode,cleanupComplete};}
  signal?.addEventListener('abort',externalStop,{once:true});if(signal?.aborted)externalStop();process.once('SIGTERM',processStop);process.once('SIGINT',processStop);armDeadline();
  control.signal.throwIfAborted();const identity=await broker.identify(control.signal);verifyHost(identity.host);await refresh();emit('host-started');
  while(!control.signal.aborted){
   if(Date.now()>=nextRefresh&&!refreshing){refreshing=refresh().catch(()=>stop('broker_unavailable',true)).finally(()=>{refreshing=null;});}
   // Pause new claims while refreshing; running claims retain the independent
   // hard lease timer and their own server run heartbeats.
   if(!refreshing){
    let available=concurrency-[...agents.values()].filter(entry=>entry.busy).length;
    const list=[...agents.values()];for(let scanned=0;available>0&&scanned<list.length;scanned++){
     const index=(cursor+scanned)%list.length,entry=list[index];if(entry.busy||entry.nextAt>Date.now())continue;
     cursor=(index+1)%list.length;available--;entry.busy=launch(entry).finally(()=>{entry.busy=null;});break;
    }
   }
   await pause(Math.min(100,pollMs),control.signal);
  }
 }catch{if(!control.signal.aborted)stop('host_error',true);}
 finally{
  clearTimeout(deadlineTimer);clearTimeout(leaseTimer);signal?.removeEventListener('abort',externalStop);process.removeListener('SIGTERM',processStop);process.removeListener('SIGINT',processStop);
  if(!control.signal.aborted)control.abort(Error('Studio host closing.'));
  const entries=[...agents.values(),...retired];for(const entry of entries)entry.control.abort(Error('Studio host closing.'));
  cleanupComplete=await boundedCleanup([...(refreshing?[refreshing]:[]),...entries.map(entry=>entry.busy).filter(Boolean),...pendingInference],cleanupMs);
  if(!cleanupComplete){exitCode=1;emit('cleanup-incomplete');}
  // Retain locks if any asynchronous writer/inference still owns state. CLI
  // exits the process; a clean restart will reconcile the same private journal.
  if(cleanupComplete){for(const entry of entries)await entry.state.close();if(supervisor)await supervisor.close();}
  if(supervisor){const path=join(directory,'host-status.json'),temporary=path+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify({version:1,hostId,companyId,deadlineAt:new Date(deadlineMs).toISOString(),status:'stopped',reason,exitCode,cleanupComplete,updatedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}}
  emit('host-stopped');
 }
 return{reason,exitCode,cleanupComplete};
}

async function main(){const config=studioHostConfiguration();if(Date.now()>=config.deadlineMs)return{reason:'deadline',exitCode:0,cleanupComplete:true};return runStudioHost({...config,broker:createHostBroker(),settings:process.env,log:entry=>console.log(JSON.stringify(entry))});}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(result=>{process.exitCode=result.exitCode;if(!result.cleanupComplete)process.exit(result.exitCode);}).catch(()=>{console.error('{"event":"host-configuration-error"}');process.exitCode=1;});
