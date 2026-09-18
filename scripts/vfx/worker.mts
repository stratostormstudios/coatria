import {createHash,randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {executionManifestInput,executionProfileInput,EXECUTION_BUILTIN_PROFILES,type ExecutionManifest} from '../../src/lib/studio-execution-protocol';
import {studioSpecInput} from '../../src/lib/studio-protocol';
import {controlledRenderJobSchema,executeControlledRender,RenderError,sha256File,verifyRenderDirectory,type RenderResult} from './renderer.mjs';

export const BUILTIN_EXECUTION_PROFILE = EXECUTION_BUILTIN_PROFILES.find(profile=>profile.key==='coatria-product-turntable-v1'&&profile.version===1)!;
type WorkerOptions={origin:string;token:string;workerId:string;outputRoot:string;blenderPath:string;signal?:AbortSignal;fetch?:typeof fetch;heartbeatMs?:number};
type Pending={schemaVersion:1;workerId:string;binding:string;claimId:string;phase:'claiming'|'rendering'|'completing'|'failing'|'uncertain';jobId?:string;body?:Record<string,unknown>};
export const executionWorkerBinding=(origin:string,token:string)=>createHash('sha256').update(new URL(origin).origin+'\0'+token).digest('hex');
const claimedJob=z.object({id:z.string().uuid(),companyId:z.string().uuid(),projectId:z.string().uuid(),workItemId:z.string().uuid(),profile:executionProfileInput,spec:studioSpecInput,inputReferences:z.array(z.unknown()).max(32),frameStart:z.number().int().min(0),frameEnd:z.number().int().min(0),outputKind:z.string()}).passthrough();
function validateOptions(options:WorkerOptions) {
  const origin=new URL(options.origin);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!(origin.protocol==='https:'||origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw new RenderError('WORKER_CONFIG','Use a bare HTTPS Coatria origin, or a loopback HTTP test origin.');
  if(!/^ce_[A-Za-z0-9_-]{20,200}$/.test(options.token)||!/^[-A-Za-z0-9_.:]{1,80}$/.test(options.workerId))throw new RenderError('WORKER_CONFIG','Provide an execution connector token and bounded worker identity.');
  if(!path.isAbsolute(options.outputRoot)||!path.isAbsolute(options.blenderPath))throw new RenderError('WORKER_CONFIG','Worker storage and Blender are operator-configured absolute paths.');
  if(options.heartbeatMs!==undefined&&(!Number.isInteger(options.heartbeatMs)||options.heartbeatMs<50||options.heartbeatMs>20000))throw new RenderError('WORKER_CONFIG','Heartbeat interval must be at most 20 seconds.');
  return origin.origin;
}
async function atomicState(file:string,value:Pending) {const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}
export async function executionManifestFromResult(outputRoot:string,result:RenderResult):Promise<ExecutionManifest> {
  z.string().uuid().parse(result.jobId);
  const base=path.resolve(outputRoot,result.jobId),manifestPath=path.resolve(base,result.manifestPath);
  if(!/^attempts\/\d{4}\/manifest\.json$/.test(result.manifestPath)||await sha256File(manifestPath)!==result.manifestSha256)throw new RenderError('OUTPUT_HASH_MISMATCH','The sealed renderer result changed.');
  const manifest=await verifyRenderDirectory(path.dirname(manifestPath)),prefix=result.jobId+'/'+result.manifestPath.slice(0,-'manifest.json'.length);
  const files:ExecutionManifest['files']=manifest.files.map(file=>({path:prefix+file.path,kind:file.kind==='frame'?'image' as const:file.kind==='scene'?'scene' as const:'media' as const,bytes:file.sizeBytes,sha256:file.sha256,...file.frame===undefined?{}:{frame:file.frame}}));
  const report=path.join(path.dirname(manifestPath),'manifest.json');
  files.push({path:prefix+'manifest.json',kind:'report',bytes:(await lstat(report)).size,sha256:await sha256File(report)});
  return executionManifestInput.parse({schemaVersion:1,files,spec:{width:manifest.job.width,height:manifest.job.height,fpsNumerator:manifest.job.fpsNumerator,fpsDenominator:manifest.job.fpsDenominator,format:'exr',colorSpace:manifest.job.colorSpace},engineVersion:`Blender ${manifest.evidence.blenderVersion} (${manifest.evidence.blenderBuildHash})`,verification:{fileHashes:true,fileSizes:true,frameCoverage:true,imageMetadata:true}});
}
/** One durable connector cycle. No human/agent credentials or arbitrary DCC input. */
export async function runExecutionWorkerOnce(options:WorkerOptions):Promise<{status:'idle'}|{status:'completed'|'failed';jobId:string;replayed?:boolean}> {
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
  try {
    try{const stat=await lstat(stateFile);if(stat.isSymbolicLink()||stat.size>1024*1024)throw new RenderError('WORKER_STATE_INVALID','Private connector state is invalid.');state=JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(state&&(state.schemaVersion!==1||state.workerId!==options.workerId||state.binding!==binding))throw new RenderError('WORKER_STATE_INVALID','Private connector state belongs to another worker, origin or connector credential.');
    if(state?.phase==='uncertain'||state?.phase==='rendering')throw new RenderError('WORKER_RECONCILIATION_REQUIRED','An interrupted render needs operator reconciliation before another connector cycle.');
    // Re-send the exact durable completion/failure before claiming new work.
    if(state&&(state.phase==='completing'||state.phase==='failing')){
      if(!state.jobId||!state.body)throw new RenderError('WORKER_STATE_INVALID','Pending receipt state is incomplete.');
      const response=await request(`jobs/${state.jobId}/${state.phase==='completing'?'complete':'fail'}`,state.body,options.signal);
      await unlink(stateFile);return {status:state.phase==='completing'?'completed':'failed',jobId:state.jobId,replayed:response.replayed===true};
    }
    await request('identity',undefined,options.signal);
    state??={schemaVersion:1,workerId:options.workerId,binding,claimId:randomUUID(),phase:'claiming'};
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
      await unlink(stateFile);return {status:'completed',jobId:job.id,replayed:response.replayed===true};
    }catch(error){
      if(state.phase==='completing')throw error;
      if(leaseLost||controller.signal.aborted){state={...state,phase:'uncertain'};await atomicState(stateFile,state);throw new RenderError('WORKER_RECONCILIATION_REQUIRED','The lease or worker stopped; preserved local outputs require reconciliation.');}
      const reason=error instanceof RenderError&&['PROFILE_UNAVAILABLE','OPERATOR_PATH_REQUIRED'].includes(error.code)?'profile_unavailable':error instanceof RenderError&&error.code.startsWith('OUTPUT')?'output_verification_failed':'renderer_failed';
      state={...state,phase:'failing',body:{leaseToken,clientId:randomUUID(),reason}};await atomicState(stateFile,state);
      await request(`jobs/${job.id}/fail`,state.body,options.signal);await unlink(stateFile);return {status:'failed',jobId:job.id};
    }finally{if(heartbeat)clearInterval(heartbeat);await heartbeatPending;options.signal?.removeEventListener('abort',externalAbort);}
  }finally{await lock.close();await unlink(lockFile);}
}

async function main(){
  const once=process.argv.slice(2).length===1&&process.argv[2]==='--once';if(process.argv.length>2&&!once)throw new RenderError('USAGE','Use --once for one bounded cycle, or no arguments for the operator-managed service loop.');
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  const options:WorkerOptions={origin:process.env.COATRIA_BASE_URL??'',token:process.env.COATRIA_EXECUTION_TOKEN??'',workerId:process.env.COATRIA_EXECUTION_WORKER_ID??'vfx-worker',outputRoot:process.env.COATRIA_EXECUTION_OUTPUT_ROOT??'',blenderPath:process.env.COATRIA_BLENDER_PATH??'',signal:controller.signal};
  do {console.log(JSON.stringify(await runExecutionWorkerOnce(options)));if(once)break;await delay(5000,undefined,{signal:controller.signal});}while(!controller.signal.aborted);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({status:'stopped',code:error instanceof RenderError?error.code:'WORKER_FAILED',message:error instanceof RenderError?error.message:'The execution worker stopped. Inspect private operator logs.'}));process.exitCode=1;});
