#!/usr/bin/env node
// One company, one reviewed HTTP provider bridge. No shell, remote adapter,
// package installation, business policy, or provider lifecycle API is accepted.
import {mkdir,lstat,chmod,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRuntimeClient,openWorkerState,workOnce,createAutonomyTicker,RuntimeError,pause} from '../../public/downloads/agent-worker.mjs';
import {createProviderExecutor} from '../../public/downloads/provider-adapter.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** @param {Record<string,string|undefined>} settings */
export function hostConfiguration(settings=process.env,now=Date.now()){
 const directory=settings.COATRIA_HOST_STATE_DIR||'/state';
 if(!isAbsolute(directory)||resolve(directory)===dirname(resolve(directory)))throw new Error('A private absolute state directory is required.');
 const companyId=settings.COATRIA_HOST_COMPANY_ID,agentId=settings.COATRIA_HOST_AGENT_ID;
 if(!uuid.test(companyId||'')||!uuid.test(agentId||''))throw new Error('Pin this host to a company and agent UUID.');
 const deadlineAt=settings.COATRIA_HOST_EXPIRES_AT,deadlineMs=Date.parse(deadlineAt||'');
 if(typeof deadlineAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(deadlineAt)||!Number.isFinite(deadlineMs)||deadlineMs>now+86400000)throw new Error('Set an absolute UTC host deadline no more than 24 hours away.');
 return{directory:resolve(directory),companyId,agentId,deadlineMs};
}
function boundedCleanup(promise,milliseconds){let timer;return Promise.race([Promise.resolve(promise).then(()=>true,()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]).finally(()=>clearTimeout(timer));}

/** Reusable lifecycle hook is operator code, never a command/URL from a model.
 * @param {{directory:string,companyId:string,agentId:string,deadlineMs:number,client:any,execute:(options:any)=>Promise<any>,signal?:AbortSignal,log?:(event:Record<string,unknown>)=>void,onShutdown?:(event:Record<string,unknown>,signal:AbortSignal)=>Promise<void>,pollMs?:number,cleanupMs?:number}} options
 */
export async function runHostedWorker({directory,companyId,agentId,deadlineMs,client,execute,signal,log=()=>{},onShutdown=async()=>{},pollMs=3000,cleanupMs=5000}){
 if(!uuid.test(companyId)||!uuid.test(agentId)||!Number.isFinite(deadlineMs)||!Number.isFinite(pollMs)||pollMs<1||!Number.isFinite(cleanupMs)||cleanupMs<1||cleanupMs>10000)throw new Error('Invalid hosted worker configuration.');
 directory=resolve(directory);await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink())throw new Error('State must be a private real directory.');
 if(process.platform!=='win32')await chmod(directory,0o700);
 const control=new AbortController(),pending=new Set(),startedAt=new Date().toISOString(),statusPath=join(directory,'host-status.json');
 let state,deadlineTimer,writing=Promise.resolve(),reason='completed',exitCode=0,cleanupComplete=true,lastContactAt=null,ownsState=false;
 const emit=event=>{const entry={at:new Date().toISOString(),event};try{log(entry);}catch{/* Diagnostic sinks cannot alter a run. */}};
 const report=status=>{const value={version:1,pid:process.pid,companyId,agentId,startedAt,updatedAt:new Date().toISOString(),deadlineAt:new Date(deadlineMs).toISOString(),status,reason,lastContactAt,exitCode,cleanupComplete};const bytes=JSON.stringify(value);writing=writing.then(async()=>{const temporary=statusPath+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,statusPath);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}});return writing;};
 const stop=why=>{if(!control.signal.aborted){reason=why;control.abort(new Error('Hosted worker stopped.'));emit('host-stopping');}};
 const externalStop=()=>stop('operator_stop'),signalStop=()=>stop('signal');
 try{
  // Absolute deadline is unchanged across container restarts. Expired hosts
  // never authenticate or dispatch work and exit successfully without retry.
  if(Date.now()>=deadlineMs){reason='deadline';await report('stopped');return{reason,exitCode,cleanupComplete};}
  signal?.addEventListener('abort',externalStop,{once:true});if(signal?.aborted)externalStop();
  deadlineTimer=setTimeout(()=>stop('deadline'),Math.max(0,deadlineMs-Date.now()));
  process.once('SIGTERM',signalStop);process.once('SIGINT',signalStop);
  control.signal.throwIfAborted();state=await openWorkerState(join(directory,'worker-private.json'),client);ownsState=true;await report('starting');emit('host-started');
  const tick=createAutonomyTicker(client);
  const tracked=options=>{
   if(options.run?.companyId!==companyId||options.run?.agentId!==agentId||options.context?.installation?.pluginId!=='runpod'||options.context?.installation?.runtimeConfig?.providerId!=='runpod')throw new Error('Host scope differs from the leased installation.');
   const operation=Promise.resolve().then(()=>execute(options));pending.add(operation);operation.then(()=>pending.delete(operation),()=>pending.delete(operation));return operation;
  };
  while(!control.signal.aborted){
   try{
    await tick(state,control.signal);await report('polling');
    const worked=await workOnce({client,state,execute:tracked,signal:control.signal,log:entry=>{if(['result-recorded','failure-recorded','adapter-failed','heartbeat-delayed'].includes(entry.event))emit(entry.event);}});
    lastContactAt=new Date().toISOString();await report('idle');if(!worked)await pause(pollMs,control.signal);
   }catch(error){
    if(control.signal.aborted)break;
    if(!(error instanceof RuntimeError)||[401,403].includes(error.status)){reason=error instanceof RuntimeError?'access_ended':'host_error';exitCode=1;emit('host-failed');break;}
    emit('request-delayed');await report('retry_wait');await pause(Math.max(3000,Math.min(300000,(error.retryAfter||0)*1000)),control.signal);
   }
  }
 }catch{if(!control.signal.aborted){reason='host_error';exitCode=1;emit('host-failed');}}
 finally{
  clearTimeout(deadlineTimer);signal?.removeEventListener('abort',externalStop);process.removeListener('SIGTERM',signalStop);process.removeListener('SIGINT',signalStop);
  if(!control.signal.aborted)control.abort(new Error('Hosted worker closing.'));
  if(pending.size)cleanupComplete=await boundedCleanup(Promise.allSettled([...pending]),cleanupMs);
  if(!cleanupComplete){exitCode=1;emit('adapter-cleanup-incomplete');}
  // Keep credentials/run outcome for reconciliation. Do not erase state or
  // force another reasoning attempt after an uncertain interruption.
  if(state)await state.close();
  if(ownsState)await report('stopped');
  const summary={reason,exitCode,cleanupComplete};
  const shutdownSignal=AbortSignal.timeout(2000);if(!await boundedCleanup(Promise.resolve().then(()=>onShutdown(summary,shutdownSignal)),2000))emit('shutdown-hook-failed');
  emit('host-stopped');
 }
 return{reason,exitCode,cleanupComplete};
}
async function main(){
 const config=hostConfiguration();
 // Delay credential parsing/client construction until a valid, live deadline.
 const client=Date.now()<config.deadlineMs?createRuntimeClient():null;
 return runHostedWorker({...config,client,execute:createProviderExecutor(),log:entry=>console.log(JSON.stringify(entry))});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(result=>{process.exitCode=result.exitCode;if(!result.cleanupComplete)process.exit(result.exitCode);}).catch(()=>{console.error('{"event":"host-configuration-error"}');process.exitCode=1;});
