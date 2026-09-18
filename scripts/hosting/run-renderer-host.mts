#!/usr/bin/env node
// Dedicated, one-job procedural renderer. Provider lifecycle stays on Coatria's server.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,chmod,open,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hostname} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {runExecutionWorkerOnce,BUILTIN_EXECUTION_PROFILE} from '../vfx/worker.mjs';

export const RENDER_ORIGIN='https://coatria.com';
export const RENDER_CLAIM_RESERVE_MS=900_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const failure=()=>Error('RENDERER_HOST_RECONCILIATION_REQUIRED');
export function rendererStateDirectory(companyId:string,connectorId:string){
 if(!UUID.test(companyId)||!UUID.test(connectorId))throw Error('RENDERER_SCOPE_INVALID');
 return '/state/renderers/'+companyId.toLowerCase()+'/'+connectorId.toLowerCase();
}
export function rendererHostConfiguration(settings:Record<string,string|undefined>=process.env,now=Date.now()){
 const companyId=settings.COATRIA_RENDER_COMPANY_ID??'',connectorId=settings.COATRIA_RENDER_CONNECTOR_ID??'',expiresAt=settings.COATRIA_RENDER_EXPIRES_AT??'';
 const deadlineMs=UTC.test(expiresAt)?Date.parse(expiresAt):NaN,token=settings.COATRIA_EXECUTION_TOKEN??'';
 if(!UUID.test(companyId)||!UUID.test(connectorId)||!Number.isFinite(deadlineMs)||deadlineMs>now+86400000||!/^ce_[A-Za-z0-9_-]{20,200}$/.test(token)||settings.COATRIA_BASE_URL!==undefined&&settings.COATRIA_BASE_URL!==RENDER_ORIGIN)throw Error('RENDERER_CONFIGURATION_INVALID');
 return {companyId:companyId.toLowerCase(),connectorId:connectorId.toLowerCase(),deadlineMs,token,directory:rendererStateDirectory(companyId,connectorId),blenderPath:'/opt/coatria/blender-5.2.2/blender'};
}
type Journal={version:1;binding:string;deadlineMs:number;phase:'ready'|'claimed'|'completed'|'failed';claimId?:string;jobId?:string};
type CycleOptions=Parameters<typeof runExecutionWorkerOnce>[0];
type CycleResult=Awaited<ReturnType<typeof runExecutionWorkerOnce>>;
type Options={directory:string;companyId:string;connectorId:string;deadlineMs:number;token:string;blenderPath:string;signal?:AbortSignal;fetch?:typeof fetch;cycle?:(options:CycleOptions)=>Promise<CycleResult>;log?:(entry:Record<string,unknown>)=>void;pollMs?:number;claimReserveMs?:number;cleanupMs?:number};
async function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{let abort:()=>void=()=>{};try{return await Promise.race([promise,new Promise<T>((_resolve,reject)=>{abort=()=>reject(signal.reason);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}}
async function jsonResponse(response:Response,signal:AbortSignal){
 const reader=response.body?.getReader();if(!reader)throw failure();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const next=await bounded(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>1024*1024)throw failure();chunks.push(next.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function privateFile(file:string){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>32768||process.platform!=='win32'&&(info.mode&0o077)!==0)throw failure();return JSON.parse(await readFile(file,'utf8'));}

/** Injected transport/cycles are test/operator code, never agent-selected modules. */
export async function runRendererHost({directory,companyId,connectorId,deadlineMs,token,blenderPath,signal,fetch:transport=fetch,cycle=runExecutionWorkerOnce,log=()=>{},pollMs=5000,claimReserveMs=RENDER_CLAIM_RESERVE_MS,cleanupMs=7000}:Options){
 if(!UUID.test(companyId)||!UUID.test(connectorId)||!/^ce_[A-Za-z0-9_-]{20,200}$/.test(token)||!Number.isFinite(deadlineMs)||deadlineMs>Date.now()+86400000||!isAbsolute(directory)||resolve(directory)===dirname(resolve(directory))||!isAbsolute(blenderPath)||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>30000||!Number.isSafeInteger(claimReserveMs)||claimReserveMs<0||claimReserveMs>900000||!Number.isSafeInteger(cleanupMs)||cleanupMs<1||cleanupMs>10000)throw Error('RENDERER_CONFIGURATION_INVALID');
 const emit=(event:string)=>{try{log({at:new Date().toISOString(),event});}catch{/* Logs never change authority. */}};
 // Expiry never resets on restart, and expired hosts perform no API requests.
 if(Date.now()>=deadlineMs){emit('renderer-expired');return {reason:'deadline',exitCode:0,cleanupComplete:true};}
 directory=resolve(directory);await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw failure();if(process.platform!=='win32')await chmod(directory,0o700);
 const lockPath=join(directory,'renderer-host.lock'),journalPath=join(directory,'renderer-host.json'),workerId='cloud-renderer-v1';
 const lock=await open(lockPath,'wx',0o600).catch(()=>{throw failure();});await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname()}));
 const binding=hash([RENDER_ORIGIN,companyId.toLowerCase(),connectorId.toLowerCase(),token].join('\0'));
 let journal:Journal={version:1,binding,deadlineMs,phase:'ready'},writes=Promise.resolve(),reason='completed',exitCode=0,cleanupComplete=true,active:Promise<CycleResult>|undefined;
 const control=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const stop=(why:string)=>{if(!control.signal.aborted){reason=why;control.abort(Error('RENDERER_STOPPED'));}};
 const externalStop=()=>stop('operator_stop'),processStop=()=>stop('signal');
 const persist=()=>{const bytes=JSON.stringify(journal);writes=writes.then(async()=>{const temporary=journalPath+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,journalPath);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}});return writes;};
 const verifyIdentity=(value:any)=>{const c=value?.connector;if(c?.id!==connectorId||c.companyId!==companyId||c.status!=='active'||!UTC.test(c.expiresAt??'')||!Number.isFinite(Date.parse(c.expiresAt))||Date.parse(c.expiresAt)<deadlineMs||!Number.isSafeInteger(c.revision)||c.revision<1||canonical(c.profiles)!==canonical([BUILTIN_EXECUTION_PROFILE]))throw failure();};
 const scopedFetch:typeof fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url),method=init?.method??'GET';
  if(url.origin!==RENDER_ORIGIN){
   if(url.protocol!=='https:'||url.hostname!=='vercel.com'||url.port||url.username||url.password||url.hash||!['/api/blob','/api/blob/'].includes(url.pathname)||method!=='PUT'||new Headers(init?.headers).has('authorization'))throw failure();
   const storageSignal=AbortSignal.any([control.signal,AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])]);
   return bounded(transport(input,{...init,redirect:'error',signal:storageSignal}),storageSignal);
  }
  if(url.username||url.password||url.search||url.hash||!url.pathname.startsWith('/api/execution/'))throw failure();
  const endpoint=url.pathname.slice('/api/execution/'.length),identity=endpoint==='identity'&&method==='GET',claim=endpoint==='jobs/claim'&&method==='POST';
  if(!identity&&!claim&&(!journal.jobId||!new RegExp('^jobs/'+journal.jobId+'/(heartbeat|complete|fail|media/upload|media/verify)$').test(endpoint)||method!=='POST'))throw failure();
  const activeSignal=AbortSignal.any([control.signal,AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])]);
  let claimId:string|undefined;
  if(claim){
   const body=typeof init?.body==='string'?JSON.parse(init.body):null;
   if(!body||Object.keys(body).sort().join(',')!=='claimId,workerId'||!UUID.test(body.claimId)||body.workerId!==workerId||journal.phase==='completed'||journal.phase==='failed'||journal.claimId&&journal.claimId!==body.claimId&&journal.jobId)throw failure();
   if(!journal.jobId&&deadlineMs-Date.now()<claimReserveMs){stop('insufficient_time');throw failure();}
   claimId=body.claimId;journal={...journal,claimId};await persist();
  }
  const response=await bounded(transport(input,{...init,signal:activeSignal,redirect:'error'}),activeSignal);
  if(!identity&&!claim)return response;
  const body=await jsonResponse(response,activeSignal);
  if(response.ok){
   if(identity)verifyIdentity(body);
   else if(body.job){
    if(!UUID.test(body.job.id)||body.job.companyId!==companyId||body.job.connectorId!==connectorId||canonical(body.job.profile)!==canonical(BUILTIN_EXECUTION_PROFILE)||journal.jobId&&journal.jobId!==body.job.id)throw failure();
    // Persist before handing the claim/lease to Blender. Never claim a second
    // job if the process crashes after the worker clears its completed journal.
    journal={...journal,phase:'claimed',claimId,jobId:body.job.id};await persist();
   }else if(journal.jobId)throw failure();
  }
  return new Response(JSON.stringify(body),{status:response.status,headers:{'Content-Type':'application/json'}});
 };
 try{
  try{journal=await privateFile(journalPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await persist();}
  if(journal.version!==1||journal.binding!==binding||journal.deadlineMs!==deadlineMs||!['ready','claimed','completed','failed'].includes(journal.phase)||journal.claimId!==undefined&&!UUID.test(journal.claimId)||journal.jobId!==undefined&&!UUID.test(journal.jobId)||journal.phase!=='ready'&&!journal.jobId)throw failure();
  if(journal.phase==='completed'||journal.phase==='failed'){emit('renderer-terminal-restored');return{reason:journal.phase,exitCode:journal.phase==='completed'?0:1,cleanupComplete:true};}
  signal?.addEventListener('abort',externalStop,{once:true});if(signal?.aborted)externalStop();process.once('SIGTERM',processStop);process.once('SIGINT',processStop);
  timer=setTimeout(()=>stop('deadline'),Math.max(0,deadlineMs-Date.now()));control.signal.throwIfAborted();
  const identity=await scopedFetch(RENDER_ORIGIN+'/api/execution/identity',{headers:{Authorization:'Bearer '+token},signal:control.signal});if(!identity.ok)throw failure();
  emit('renderer-started');
  while(!control.signal.aborted){
   if(!journal.jobId&&deadlineMs-Date.now()<claimReserveMs){reason='insufficient_time';break;}
   active=Promise.resolve().then(()=>cycle({origin:RENDER_ORIGIN,token,workerId,outputRoot:directory,blenderPath,signal:control.signal,fetch:scopedFetch,publishPrivateMedia:true}));
   const result=await bounded(active,control.signal);active=undefined;
   if(result.status==='idle'){if(journal.jobId)throw failure();await delay(pollMs,undefined,{signal:control.signal});continue;}
   if(!journal.jobId||result.jobId!==journal.jobId)throw failure();
   if(result.status==='publication_pending'){
    const retry=Date.parse(result.nextRetryAt);if(!Number.isFinite(retry)||retry>Date.now()+65000)throw failure();emit('renderer-publication-pending');await delay(Math.max(1,retry-Date.now()),undefined,{signal:control.signal});continue;
   }
   if(result.status==='completed'&&(result.publication?.status!=='verified'||result.publication.verificationSource!=='server_bytes'||result.publication.independentlyReviewed!==false))throw failure();
   journal={...journal,phase:result.status};await persist();reason=result.status;exitCode=result.status==='failed'?1:0;emit('renderer-'+result.status);break;
  }
 }catch{if(!control.signal.aborted){reason='reconciliation_required';exitCode=1;emit('renderer-reconciliation-required');}}
 finally{
  clearTimeout(timer);signal?.removeEventListener('abort',externalStop);process.removeListener('SIGTERM',processStop);process.removeListener('SIGINT',processStop);if(!control.signal.aborted)control.abort(Error('RENDERER_CLOSING'));
  if(active){let waitTimer:ReturnType<typeof setTimeout>|undefined;cleanupComplete=await Promise.race([active.then(()=>true,()=>true),new Promise<boolean>(done=>{waitTimer=setTimeout(()=>done(false),cleanupMs);})]);clearTimeout(waitTimer);}
  await writes.catch(()=>{exitCode=1;});await lock.close();if(cleanupComplete)await unlink(lockPath);else{exitCode=1;emit('renderer-cleanup-unconfirmed');}emit('renderer-stopped');
 }
 return{reason,exitCode,cleanupComplete};
}
async function main(){if(process.argv.length!==2)throw Error('RENDERER_CONFIGURATION_INVALID');const result=await runRendererHost({...rendererHostConfiguration(),log:entry=>console.log(JSON.stringify(entry))});process.exitCode=result.exitCode;if(!result.cleanupComplete)process.exit(result.exitCode);}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error('{"event":"renderer-configuration-error"}');process.exitCode=1;});
