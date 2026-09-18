import {createHash,randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {executionProfileInput,EXECUTION_BUILTIN_PROFILES} from '../../src/lib/studio-execution-protocol';
import {studioSpecInput} from '../../src/lib/studio-protocol';
import {controlledRenderJobSchema,executeControlledRender,RenderError} from './renderer.mjs';
import {executionManifestFromResult} from './manifest.mjs';
import {publishExecutionOutputs} from './publish.mjs';
export {executionManifestFromResult} from './manifest.mjs';

export const BUILTIN_EXECUTION_PROFILE = EXECUTION_BUILTIN_PROFILES.find(profile=>profile.key==='coatria-product-turntable-v1'&&profile.version===1)!;
type WorkerOptions={origin:string;token:string;workerId:string;outputRoot:string;blenderPath:string;signal?:AbortSignal;fetch?:typeof fetch;heartbeatMs?:number;publishPrivateMedia?:boolean};
type Pending={schemaVersion:1;workerId:string;binding:string;claimId:string;phase:'claiming'|'rendering'|'completing'|'failing'|'uncertain'|'publishing';jobId?:string;body?:Record<string,unknown>;publishPrivateMedia?:boolean;publication?:{attempts:number;nextAttemptAt:number;lastError?:string;blocked?:boolean}};
type WorkerResult={status:'idle'}|{status:'completed'|'failed';jobId:string;replayed?:boolean;publication?:{status:'verified';files:number;verificationSource:'server_bytes';independentlyReviewed:false}}|{status:'publication_pending';jobId:string;code:string;nextRetryAt:string};
const PUBLICATION_ATTEMPTS=8;
export const executionWorkerBinding=(origin:string,token:string)=>createHash('sha256').update(new URL(origin).origin+'\0'+token).digest('hex');
const claimedJob=z.object({id:z.string().uuid(),companyId:z.string().uuid(),projectId:z.string().uuid(),workItemId:z.string().uuid(),profile:executionProfileInput,spec:studioSpecInput,inputReferences:z.array(z.unknown()).max(32),frameStart:z.number().int().min(0),frameEnd:z.number().int().min(0),outputKind:z.string()}).passthrough();
function validateOptions(options:WorkerOptions) {
  const origin=new URL(options.origin);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!(origin.protocol==='https:'||origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw new RenderError('WORKER_CONFIG','Use a bare HTTPS Coatria origin, or a loopback HTTP test origin.');
  if(!/^ce_[A-Za-z0-9_-]{20,200}$/.test(options.token)||!/^[-A-Za-z0-9_.:]{1,80}$/.test(options.workerId))throw new RenderError('WORKER_CONFIG','Provide an execution connector token and bounded worker identity.');
  if(!path.isAbsolute(options.outputRoot)||!path.isAbsolute(options.blenderPath))throw new RenderError('WORKER_CONFIG','Worker storage and Blender are operator-configured absolute paths.');
  if(options.heartbeatMs!==undefined&&(!Number.isInteger(options.heartbeatMs)||options.heartbeatMs<50||options.heartbeatMs>20000))throw new RenderError('WORKER_CONFIG','Heartbeat interval must be at most 20 seconds.');
  if(options.publishPrivateMedia!==undefined&&typeof options.publishPrivateMedia!=='boolean')throw new RenderError('WORKER_CONFIG','Private-media publication requires an explicit operator choice.');
  return origin.origin;
}
async function atomicState(file:string,value:Pending) {const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}
/** One durable connector cycle. No human/agent credentials or arbitrary DCC input. */
export async function runExecutionWorkerOnce(options:WorkerOptions):Promise<WorkerResult> {
  const origin=validateOptions(options),binding=executionWorkerBinding(origin,options.token);await mkdir(options.outputRoot,{recursive:true});const root=await realpath(options.outputRoot);
  const stateDirectory=path.join(root,'.connector-state');await mkdir(stateDirectory,{recursive:true});if((await lstat(stateDirectory)).isSymbolicLink())throw new RenderError('WORKER_CONFIG','Connector state must be private regular storage.');
  const workerKey=options.workerId.replace(/:/g,'_'),stateFile=path.join(stateDirectory,workerKey+'.json'),lockFile=path.join(stateDirectory,workerKey+'.lock');
  let lock:Awaited<ReturnType<typeof open>>;
  try{lock=await open(lockFile,'wx',0o600);}catch{throw new RenderError('WORKER_LOCKED','This worker identity has a live or unreconciled host lock.');}
  await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname(),at:new Date().toISOString()}));
  const request=async(endpoint:string,body?:unknown,signal?:AbortSignal)=>{
    const signals=[AbortSignal.timeout(10000),...(signal?[signal]:[])];
    const response=await (options.fetch??fetch)(origin+'/api/execution/'+endpoint,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+options.token,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.any(signals)});
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
    try{if(reader)while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1024*1024){await reader.cancel();throw new RenderError('WORKER_PROTOCOL','Execution response exceeds the protocol bound.');}chunks.push(next.value);}}finally{reader?.releaseLock();}
    const text=Buffer.concat(chunks).toString('utf8');
    if(!response.ok)throw new RenderError('WORKER_API_REJECTED',`Execution API rejected ${endpoint.split('/').at(-1)} (${response.status}).`);
    return JSON.parse(text);
  };
  let state:Pending|undefined;
  const publishPending=async():Promise<WorkerResult>=>{
    if(state?.phase!=='publishing'||!state.jobId||state.publishPrivateMedia!==true)throw new RenderError('WORKER_STATE_INVALID','Publication state is incomplete.');
    if(options.publishPrivateMedia!==true)throw new RenderError('WORKER_PUBLICATION_OPT_IN_REQUIRED','Private publication is pending. Re-enable the operator publication option to reconcile it before claiming new work.');
    const pending=state.publication??{attempts:0,nextAttemptAt:0};
    if(!Number.isSafeInteger(pending.attempts)||pending.attempts<0||!Number.isSafeInteger(pending.nextAttemptAt)||pending.nextAttemptAt<0)throw new RenderError('WORKER_STATE_INVALID','Publication retry state is invalid.');
    if(pending.blocked||pending.attempts>=PUBLICATION_ATTEMPTS)throw new RenderError('WORKER_PUBLICATION_RECONCILIATION_REQUIRED','Private publication requires operator reconciliation; the completed render and pending state were preserved.');
    if(pending.nextAttemptAt>Date.now())return {status:'publication_pending',jobId:state.jobId,code:pending.lastError??'PUBLISH_RETRY_WAIT',nextRetryAt:new Date(pending.nextAttemptAt).toISOString()};
    options.signal?.throwIfAborted();
    // Count the attempt before transport. A crash never resets the retry budget.
    state={...state,publication:{attempts:pending.attempts+1,nextAttemptAt:0}};await atomicState(stateFile,state);
    try{
      const result=await publishExecutionOutputs({origin,token:options.token,outputRoot:root,jobId:state.jobId!,signal:options.signal,fetch:options.fetch});
      const receipts=path.join(stateDirectory,workerKey+'.publications');await mkdir(receipts,{recursive:true,mode:0o700});
      if((await lstat(receipts)).isSymbolicLink()||await realpath(receipts)!==receipts)throw new RenderError('WORKER_STATE_INVALID','Publication receipts must be private regular storage.');
      const receipt={schemaVersion:1,workerId:options.workerId,binding,jobId:state.jobId,result},file=path.join(receipts,state.jobId+'.json');
      try{await writeFile(file,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024||JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(receipt))throw new RenderError('WORKER_STATE_INVALID','An existing immutable publication receipt differs from this result.');
      }
      await unlink(stateFile);
      return {status:'completed',jobId:result.jobId,publication:{status:'verified',files:result.files.length,verificationSource:'server_bytes',independentlyReviewed:false}};
    }catch(error){
      const code=error instanceof RenderError?error.code:'PUBLISH_RECONCILIATION_REQUIRED';
      const retryable=['PUBLISH_API_UNCERTAIN','PUBLISH_UPLOAD_UNCERTAIN','PUBLISH_API_RETRYABLE','PUBLISH_UPLOAD_RETRYABLE'].includes(code);
      const attempts=state.publication!.attempts,nextAttemptAt=Date.now()+Math.min(60000,5000*2**(attempts-1));
      state={...state,publication:{attempts,nextAttemptAt,lastError:code,blocked:!retryable||attempts>=PUBLICATION_ATTEMPTS}};await atomicState(stateFile,state);
      if(state.publication!.blocked)throw new RenderError('WORKER_PUBLICATION_RECONCILIATION_REQUIRED','Private publication requires operator reconciliation; the completed render and pending state were preserved.');
      return {status:'publication_pending',jobId:state.jobId!,code,nextRetryAt:new Date(nextAttemptAt).toISOString()};
    }
  };
  const completed=async(replayed:boolean):Promise<WorkerResult>=>{
    if(!state?.jobId)throw new RenderError('WORKER_STATE_INVALID','Completion state is incomplete.');
    if(state.publishPrivateMedia===true){state={...state,phase:'publishing',body:undefined,publication:{attempts:0,nextAttemptAt:0}};await atomicState(stateFile,state);return publishPending();}
    await unlink(stateFile);return {status:'completed',jobId:state.jobId,replayed};
  };
  try {
    try{const stat=await lstat(stateFile);if(stat.isSymbolicLink()||stat.size>1024*1024)throw new RenderError('WORKER_STATE_INVALID','Private connector state is invalid.');state=JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(state&&(state.schemaVersion!==1||state.workerId!==options.workerId||state.binding!==binding))throw new RenderError('WORKER_STATE_INVALID','Private connector state belongs to another worker, origin or connector credential.');
    if(state&&(!['claiming','rendering','completing','failing','uncertain','publishing'].includes(state.phase)||state.jobId!==undefined&&!z.string().uuid().safeParse(state.jobId).success||state.publishPrivateMedia!==undefined&&typeof state.publishPrivateMedia!=='boolean'))throw new RenderError('WORKER_STATE_INVALID','Private connector state has an invalid operation or job identity.');
    if(state?.phase==='uncertain'||state?.phase==='rendering')throw new RenderError('WORKER_RECONCILIATION_REQUIRED','An interrupted render needs operator reconciliation before another connector cycle.');
    if(state?.phase==='publishing')return await publishPending();
    // Re-send the exact durable completion/failure before claiming new work.
    if(state&&(state.phase==='completing'||state.phase==='failing')){
      if(!state.jobId||!state.body)throw new RenderError('WORKER_STATE_INVALID','Pending receipt state is incomplete.');
      const response=await request(`jobs/${state.jobId}/${state.phase==='completing'?'complete':'fail'}`,state.body,options.signal);
      if(state.phase==='completing')return await completed(response.replayed===true);
      await unlink(stateFile);return {status:'failed',jobId:state.jobId,replayed:response.replayed===true};
    }
    await request('identity',undefined,options.signal);
    state??={schemaVersion:1,workerId:options.workerId,binding,claimId:randomUUID(),phase:'claiming',publishPrivateMedia:options.publishPrivateMedia===true};
    await atomicState(stateFile,state);
    const claimed=await request('jobs/claim',{claimId:state.claimId,workerId:options.workerId},options.signal);
    if(!claimed.job){await unlink(stateFile);return {status:'idle'};}
    const job=claimedJob.parse(claimed.job),leaseToken=z.string().min(20).max(200).parse(claimed.leaseToken);
    state={...state,jobId:job.id,phase:'rendering'};await atomicState(stateFile,state);
    const controller=new AbortController();const externalAbort=()=>controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort',externalAbort,{once:true});if(options.signal?.aborted)externalAbort();
    let heartbeat:ReturnType<typeof setInterval>|undefined,heartbeatBusy=false,leaseLost=false,heartbeatPending=Promise.resolve();
    const renew=async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{await request(`jobs/${job.id}/heartbeat`,{leaseToken},controller.signal);}catch{leaseLost=true;controller.abort(new Error('Execution lease was lost.'));}finally{heartbeatBusy=false;}};
    try {
      if(job.profile.key!==BUILTIN_EXECUTION_PROFILE.key||job.profile.version!==1||job.profile.engine!=='blender'||job.profile.inputKinds.length||job.inputReferences.length||job.outputKind!=='image_sequence'||job.spec.format!=='exr')throw new RenderError('PROFILE_UNAVAILABLE','This worker executes only the reviewed no-input product-turntable profile.');
      const input=controlledRenderJobSchema.parse({schemaVersion:1,jobId:job.id,profile:BUILTIN_EXECUTION_PROFILE.key,frameStart:job.frameStart,frameEnd:job.frameEnd,width:job.spec.width,height:job.spec.height,fpsNumerator:job.spec.fpsNumerator,fpsDenominator:job.spec.fpsDenominator,colorSpace:job.spec.colorSpace,samples:16,timeoutSeconds:Math.min(job.profile.timeoutSeconds,600)});
      await renew();if(leaseLost)throw new RenderError('LEASE_LOST','Execution authority ended before render startup.');
      heartbeat=setInterval(()=>{if(!heartbeatBusy)heartbeatPending=renew();},options.heartbeatMs??20000);
      const result=await executeControlledRender(input,{outputRoot:root,blenderPath:options.blenderPath,signal:controller.signal});
      if(leaseLost||controller.signal.aborted)throw new RenderError('LEASE_LOST','Execution authority ended before output registration.');
      const manifest=await executionManifestFromResult(root,result);
      if(manifest.files.reduce((total,file)=>total+file.bytes,0)>job.profile.maxOutputBytes)throw new RenderError('OUTPUT_LIMIT','Verified outputs exceed the approved connector profile.');
      if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;
      await heartbeatPending;if(leaseLost||controller.signal.aborted)throw new RenderError('LEASE_LOST','Execution authority ended before receipt commit.');
      state={...state,phase:'completing',body:{leaseToken,clientId:randomUUID(),manifest}};await atomicState(stateFile,state);
      const response=await request(`jobs/${job.id}/complete`,state.body,controller.signal);
      return await completed(response.replayed===true);
    }catch(error){
      if(state.phase==='completing'||state.phase==='publishing')throw error;
      if(leaseLost||controller.signal.aborted){state={...state,phase:'uncertain'};await atomicState(stateFile,state);throw new RenderError('WORKER_RECONCILIATION_REQUIRED','The lease or worker stopped; preserved local outputs require reconciliation.');}
      const reason=error instanceof RenderError&&['PROFILE_UNAVAILABLE','OPERATOR_PATH_REQUIRED'].includes(error.code)?'profile_unavailable':error instanceof RenderError&&error.code.startsWith('OUTPUT')?'output_verification_failed':'renderer_failed';
      state={...state,phase:'failing',body:{leaseToken,clientId:randomUUID(),reason}};await atomicState(stateFile,state);
      await request(`jobs/${job.id}/fail`,state.body,options.signal);await unlink(stateFile);return {status:'failed',jobId:job.id};
    }finally{if(heartbeat)clearInterval(heartbeat);await heartbeatPending;options.signal?.removeEventListener('abort',externalAbort);}
  }finally{await lock.close();await unlink(lockFile);}
}

export function executionWorkerMode(args:string[],publishEnvironment:string|undefined){
  if(args.some(arg=>!['--once','--publish-private-media'].includes(arg))||new Set(args).size!==args.length||publishEnvironment!==undefined&&!['true','false'].includes(publishEnvironment))throw new RenderError('USAGE','Use --once and/or --publish-private-media. COATRIA_EXECUTION_AUTO_PUBLISH must be true or false when set.');
  return {once:args.includes('--once'),publishPrivateMedia:args.includes('--publish-private-media')||publishEnvironment==='true'};
}
async function main(){
  const {once,publishPrivateMedia}=executionWorkerMode(process.argv.slice(2),process.env.COATRIA_EXECUTION_AUTO_PUBLISH);
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  const options:WorkerOptions={origin:process.env.COATRIA_BASE_URL??'',token:process.env.COATRIA_EXECUTION_TOKEN??'',workerId:process.env.COATRIA_EXECUTION_WORKER_ID??'vfx-worker',outputRoot:process.env.COATRIA_EXECUTION_OUTPUT_ROOT??'',blenderPath:process.env.COATRIA_BLENDER_PATH??'',signal:controller.signal,publishPrivateMedia};
  do {const result=await runExecutionWorkerOnce(options);console.log(JSON.stringify(result));if(once){if(result.status==='publication_pending')process.exitCode=2;break;}await delay(5000,undefined,{signal:controller.signal});}while(!controller.signal.aborted);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({status:'stopped',code:error instanceof RenderError?error.code:'WORKER_FAILED',message:error instanceof RenderError?error.message:'The execution worker stopped. Inspect private operator logs.'}));process.exitCode=1;});
