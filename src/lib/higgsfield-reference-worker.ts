/** Prepared-image reference worker foundation. No public route, host activation,
 * OAuth, generic tools or storage write permission. The existing archive worker
 * remains separate; production composition must qualify this service explicitly. */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,realpath,rm,type FileHandle} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {inspectHiggsfieldArchiveMedia,type HiggsfieldArchiveMediaInput,type HiggsfieldMediaDescriptor} from './higgsfield-media-inspection';
import {isQualifiedLinuxMediaSandbox,type QualifiedLinuxMediaSandbox} from './higgsfield-media-sandbox';
import {isQualifiedVercelMediaSandbox,type QualifiedVercelMediaSandbox} from './higgsfield-vercel-media-sandbox';
import {HIGGSFIELD_REFERENCE_POLICY,type HiggsfieldReferenceLease,type HiggsfieldReferenceAllocation} from './higgsfield-references-protocol';
import {type HiggsfieldReferenceUpload,type HiggsfieldReferenceUploadResult} from './higgsfield-reference-transport';
import type {RunpodObjectRead} from './project-storage-runpod';

type Image=Extract<HiggsfieldMediaDescriptor,{kind:'image'}>;
export type HiggsfieldReferenceWorkerCode='REFERENCE_WORKER_UNAVAILABLE'|'REFERENCE_WORKER_POLICY_INVALID'|'REFERENCE_AUTHORITY_CHANGED'|'REFERENCE_SOURCE_CHANGED'|'REFERENCE_IMAGE_REJECTED'|'REFERENCE_WORKER_DEADLINE'|'REFERENCE_WORKER_ABORTED'|'REFERENCE_WORKER_FAILED'|'REFERENCE_PROVIDER_UNCERTAIN';
export class HiggsfieldReferenceWorkerError extends Error{constructor(readonly code:HiggsfieldReferenceWorkerCode){super(code);this.name='HiggsfieldReferenceWorkerError';}}
const fail=(code:HiggsfieldReferenceWorkerCode):never=>{throw new HiggsfieldReferenceWorkerError(code);};
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),validHash=(s:string)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),positive=(n:number,max:number)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const uuid=(s:string)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
export type HiggsfieldReferenceWorkerReadiness={enabled:boolean;hostQualified:boolean;storageVerified:boolean;catalogVerified:boolean;profileSha256:string;expiresAt:string};
/** These are trusted server broker calls, not model tools. Allocate and confirm
 * MUST fence and complete their own durable phase records, before returning.
 * uploadCapability only opens an already-persisted, exact leased allocation. */
export type HiggsfieldReferenceWorkerBroker={
 allocate:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<void>;
 uploadCapability:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<HiggsfieldReferenceAllocation>;
 confirm:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<void>;
};
export type HiggsfieldReferenceWorkerDependencies={
 /** Omission is disabled. Host, storage, catalog and finite runtime scope are
  * checked again during every authority renewal, not just at process startup. */
 readiness?:(signal:AbortSignal)=>Promise<HiggsfieldReferenceWorkerReadiness>;
 claim:(signal:AbortSignal)=>Promise<HiggsfieldReferenceLease|null>;
 authorize:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<unknown>;
 /** Exact version + verified ETag read via existing bounded storage adapter;
  * no range, alternate version, caller URL or original-file fallback. */
 readProxy:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<RunpodObjectRead>;
 inspectMedia:(input:HiggsfieldArchiveMediaInput)=>Promise<HiggsfieldMediaDescriptor>;
 recordInspection:(lease:HiggsfieldReferenceLease,inspection:{descriptor:Image;profileSha256:string},signal:AbortSignal)=>Promise<void>;
 beginPut:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<string>;
 completePut:(lease:HiggsfieldReferenceLease,actionId:string,result:{phase:'put';bytes:number;sha256:string;httpStatus:200},signal:AbortSignal)=>Promise<void>;
 fail:(lease:HiggsfieldReferenceLease,input:{code:HiggsfieldReferenceWorkerCode;uncertain:boolean})=>Promise<void>;
 broker:HiggsfieldReferenceWorkerBroker;
 upload:(input:HiggsfieldReferenceUpload)=>Promise<HiggsfieldReferenceUploadResult>;
};
type Options={scratchRoot:string;inspectionProfileSha256:string;companyId:string;projectIds:readonly string[];operationDeadlineMs?:number;authorityIntervalMs?:number;authorityTimeoutMs?:number;cleanupTimeoutMs?:number};
export type HiggsfieldReferenceWorkerResult={processed:boolean;referenceId?:string;status:'disabled'|'idle'|'awaiting_approval'|'confirmed'|'uncertain'|'blocked'|'failed';code?:HiggsfieldReferenceWorkerCode};

/** Full-decode only: output bytes are NOT re-encoded or metadata-stripped. No
 * native decoder fallback is offered in this production inspector factory. */
export function createHiggsfieldReferenceInspector(sandbox:QualifiedLinuxMediaSandbox|QualifiedVercelMediaSandbox){
 if(!isQualifiedLinuxMediaSandbox(sandbox)&&!isQualifiedVercelMediaSandbox(sandbox))fail('REFERENCE_WORKER_UNAVAILABLE');
 return (input:HiggsfieldArchiveMediaInput)=>inspectHiggsfieldArchiveMedia(input,{sandbox,sandboxTimeoutMs:30000,limits:{timeoutMs:30000,maxBytes:HIGGSFIELD_REFERENCE_POLICY.maxBytes,maxDimension:HIGGSFIELD_REFERENCE_POLICY.maxDimension,maxPixels:HIGGSFIELD_REFERENCE_POLICY.maxPixels,maxVideoFrames:1,maxDecodedPixels:HIGGSFIELD_REFERENCE_POLICY.maxPixels,maxProbeBytes:1024**2,maxAllocationBytes:64*1024**2}});
}
function authorityScope(check:(signal:AbortSignal)=>Promise<void>,input:{deadline:number;interval:number;checkTimeout:number;signal?:AbortSignal}){
 const controller=new AbortController(),inFlight=new Set<Promise<unknown>>();let pending:Promise<void>|undefined,finished=false,lastCheck=0;
 function track<T>(value:Promise<T>){inFlight.add(value);void value.then(()=>inFlight.delete(value),()=>inFlight.delete(value));return value;}
 const stop=(code:HiggsfieldReferenceWorkerCode)=>{if(!finished&&!controller.signal.aborted)controller.abort(new HiggsfieldReferenceWorkerError(code));};
 const current=()=>{if(controller.signal.aborted)throw controller.signal.reason;};
 function bound<T>(value:Promise<T>){track(value);return new Promise<T>((yes,no)=>{const abort=()=>{controller.signal.removeEventListener('abort',abort);no(controller.signal.reason);};controller.signal.addEventListener('abort',abort,{once:true});value.then(result=>{controller.signal.removeEventListener('abort',abort);try{current();yes(result);}catch(error){no(error);}},error=>{controller.signal.removeEventListener('abort',abort);no(controller.signal.aborted?controller.signal.reason:error);});if(controller.signal.aborted)abort();});}
 async function authorize(force=false){current();if(finished)return;if(!pending&&(force||Date.now()-lastCheck>=input.interval)){const timeout=setTimeout(()=>stop('REFERENCE_AUTHORITY_CHANGED'),input.checkTimeout);pending=bound(Promise.resolve().then(()=>{current();return check(controller.signal);})).then(()=>{lastCheck=Date.now();}).catch(()=>{stop('REFERENCE_AUTHORITY_CHANGED');current();}).finally(()=>{clearTimeout(timeout);pending=undefined;});}await pending;current();}
 const external=()=>stop('REFERENCE_WORKER_ABORTED');input.signal?.addEventListener('abort',external,{once:true});if(input.signal?.aborted)external();
 const deadline=setTimeout(()=>stop('REFERENCE_WORKER_DEADLINE'),input.deadline),watchdog=setInterval(()=>void authorize(true).catch(()=>{}),input.interval);
 return {signal:controller.signal,bound,track,current,authorize,async io<T>(run:()=>Promise<T>){await authorize(true);const result=await bound(Promise.resolve().then(()=>{current();return run();}));await authorize(true);return result;},async drain(){while(inFlight.size)await Promise.allSettled([...inFlight]);},close(){stop('REFERENCE_WORKER_ABORTED');finished=true;clearTimeout(deadline);clearInterval(watchdog);input.signal?.removeEventListener('abort',external);}};
}
function descriptor(value:HiggsfieldMediaDescriptor,lease:HiggsfieldReferenceLease):Image{
 if(!value||value.kind!=='image'||value.verification!=='full_decode'||value.inspectionVersion!==1||value.bytes!==lease.proxy.bytes||value.sha256!==lease.proxy.sha256||value.contentType!==lease.proxy.contentType||!positive(value.width,HIGGSFIELD_REFERENCE_POLICY.maxDimension)||!positive(value.height,HIGGSFIELD_REFERENCE_POLICY.maxDimension)||value.width*value.height>HIGGSFIELD_REFERENCE_POLICY.maxPixels||({png:'image/png',jpeg:'image/jpeg',webp:'image/webp'} as Record<string,string>)[value.format]!==value.contentType||typeof value.codec!=='string'||value.codec.length>80||!value.color||['space','primaries','transfer','range'].some(k=>{const v=(value.color as any)[k];return v!==null&&(typeof v!=='string'||v.length>80);}))return fail('REFERENCE_IMAGE_REJECTED');
 return {kind:'image',format:value.format,contentType:value.contentType,bytes:value.bytes,sha256:value.sha256,verification:'full_decode',inspectionVersion:1,width:value.width,height:value.height,codec:value.codec,color:{space:value.color.space,primaries:value.color.primaries,transfer:value.color.transfer,range:value.color.range}};
}
function sameDescriptor(a:Image,b:Image){return ['kind','format','contentType','bytes','sha256','verification','inspectionVersion','width','height','codec'].every(key=>(a as any)[key]===(b as any)[key])&&['space','primaries','transfer','range'].every(key=>(a.color as any)?.[key]===(b.color as any)?.[key]);}

/** A single leased attempt. Durable claim must never reclaim a reference after
 * ANY external intent, including allocation/PUT that already returned. This
 * worker intentionally provides no retry/resume loop or activation entry point. */
export function createHiggsfieldReferenceWorker(options:Options,dependencies:HiggsfieldReferenceWorkerDependencies){
 if(!options||typeof options.scratchRoot!=='string'||!isAbsolute(options.scratchRoot)||options.scratchRoot.includes('\0')||/^[\\/]{2}/.test(options.scratchRoot)||process.platform==='win32'&&options.scratchRoot.slice(2).includes(':')||!validHash(options.inspectionProfileSha256)||!uuid(options.companyId)||!Array.isArray(options.projectIds)||!options.projectIds.length||options.projectIds.length>100||options.projectIds.some(id=>!uuid(id))||new Set(options.projectIds).size!==options.projectIds.length)fail('REFERENCE_WORKER_POLICY_INVALID');
 const rootPath=resolve(options.scratchRoot),profileSha256=options.inspectionProfileSha256,companyId=options.companyId,projects=new Set(options.projectIds),deadline=options.operationDeadlineMs??120000,interval=options.authorityIntervalMs??1000,checkTimeout=options.authorityTimeoutMs??5000,cleanupTimeout=options.cleanupTimeoutMs??10000;
 if(!positive(deadline,120000)||!positive(interval,5000)||!positive(checkTimeout,5000)||!positive(cleanupTimeout,10000))fail('REFERENCE_WORKER_POLICY_INVALID');
 const {claim,authorize,readProxy,inspectMedia,recordInspection,beginPut,completePut,upload,broker}=dependencies;
 let poisoned=false,busy=false;
 return {async runNext(input:{signal?:AbortSignal}={}):Promise<HiggsfieldReferenceWorkerResult>{
  if(poisoned||busy||!dependencies.readiness)return {processed:false,status:'disabled',code:'REFERENCE_WORKER_UNAVAILABLE'};
  busy=true;
  let lease:HiggsfieldReferenceLease|null=null,scratch:string|undefined,root:string|undefined,file:FileHandle|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,body:Buffer|undefined,externalIntent=false;
  const scope=authorityScope(async signal=>{
   const ready=await dependencies.readiness!(signal);
   if(!ready||ready.enabled!==true||ready.hostQualified!==true||ready.storageVerified!==true||ready.catalogVerified!==true||ready.profileSha256!==profileSha256||!Number.isFinite(Date.parse(ready.expiresAt))||Date.parse(ready.expiresAt)<=Date.now())fail('REFERENCE_WORKER_UNAVAILABLE');
   if(lease&&(Date.parse(lease.expiresAt)<=Date.now()||await authorize(lease,signal)===false))fail('REFERENCE_AUTHORITY_CHANGED');
  },{deadline,interval,checkTimeout,signal:input.signal});
  const outcome=await (async():Promise<HiggsfieldReferenceWorkerResult>=>{try{
   await scope.authorize(true);const claimed=await scope.io(()=>claim(scope.signal));if(!claimed)return {processed:false,status:'idle'};
   if(!uuid(claimed.referenceId)||!uuid(claimed.leaseId)||claimed.companyId!==companyId||!projects.has(claimed.projectId)||!validHash(claimed.requestHash)||!['inspect','transfer'].includes(claimed.phase)||!['image','start_image','end_image'].includes(claimed.role)||!Number.isFinite(Date.parse(claimed.expiresAt))||Date.parse(claimed.expiresAt)<=Date.now()||!uuid(claimed.proxy?.versionId)||!positive(claimed.proxy.bytes,HIGGSFIELD_REFERENCE_POLICY.maxBytes)||!validHash(claimed.proxy.sha256)||!['image/png','image/jpeg','image/webp'].includes(claimed.proxy.contentType))fail('REFERENCE_WORKER_POLICY_INVALID');
   // Snapshot the trusted lease; never let mutable caller data switch versions.
   const p=claimed.proxy,i=claimed.inspection;
   lease={companyId:claimed.companyId,projectId:claimed.projectId,referenceId:claimed.referenceId,leaseId:claimed.leaseId,requestHash:claimed.requestHash,phase:claimed.phase,expiresAt:claimed.expiresAt,role:claimed.role,proxy:{versionId:p.versionId,fileId:p.fileId,name:p.name,version:p.version,bytes:p.bytes,sha256:p.sha256,contentType:p.contentType},inspection:i?{descriptor:descriptor(i.descriptor,claimed),profileSha256:i.profileSha256,inspectionHash:i.inspectionHash,inspectedAt:i.inspectedAt}:null};
   Object.freeze(lease.proxy);if(lease.inspection){Object.freeze(lease.inspection.descriptor.color);Object.freeze(lease.inspection.descriptor);Object.freeze(lease.inspection);}Object.freeze(lease);
   const currentLease=lease;await scope.authorize(true);
   root=await scope.io(async()=>{const info=await lstat(rootPath);if(!info.isDirectory()||info.isSymbolicLink())fail('REFERENCE_WORKER_POLICY_INVALID');const canonical=await realpath(rootPath);if((process.platform==='win32'?canonical.toLowerCase():canonical)!==(process.platform==='win32'?rootPath.toLowerCase():rootPath))fail('REFERENCE_WORKER_POLICY_INVALID');return canonical;});
   scratch=join(root,randomUUID());await scope.io(async()=>{await mkdir(scratch!,{mode:0o700});scope.current();});
   const path=join(scratch,'prepared-image');await scope.io(async()=>{file=await open(path,'wx+',0o600);scope.current();});
   const source=await scope.io(async()=>{const value=await readProxy(currentLease,scope.signal);reader=value.stream.getReader();scope.current();return value;});
   if(source.bytes!==lease.proxy.bytes||source.totalBytes!==lease.proxy.bytes||source.range!==null||source.contentRange!==null)fail('REFERENCE_SOURCE_CHANGED');
   const digest=createHash('sha256');let bytes=0;
   while(true){const part=await scope.io(()=>reader!.read());if(part.done)break;if(!(part.value instanceof Uint8Array)||part.value.byteLength>HIGGSFIELD_REFERENCE_POLICY.maxBytes||bytes+part.value.byteLength>lease.proxy.bytes)fail('REFERENCE_SOURCE_CHANGED');
    for(let offset=0;offset<part.value.byteLength;offset+=65536){const chunk=Buffer.from(part.value.subarray(offset,offset+65536));let written=0;while(written<chunk.length){const saved=await scope.io(()=>file!.write(chunk,written,chunk.length-written,bytes+written));if(saved.bytesWritten<1)fail('REFERENCE_SOURCE_CHANGED');written+=saved.bytesWritten;}digest.update(chunk);bytes+=chunk.length;}
   }
   if(bytes!==lease.proxy.bytes||digest.digest('hex')!==lease.proxy.sha256)fail('REFERENCE_SOURCE_CHANGED');await scope.io(()=>file!.sync());
   const media=descriptor(await scope.io(()=>inspectMedia({path,expectedKind:'image',expectedBytes:bytes,expectedSha256:currentLease.proxy.sha256,signal:scope.signal})),lease);
   if(lease.phase==='inspect'){
    await scope.authorize(true);await scope.bound(recordInspection(lease,{descriptor:media,profileSha256},scope.signal));return {processed:true,referenceId:lease.referenceId,status:'awaiting_approval'};
   }
   if(!lease.inspection||lease.inspection.profileSha256!==profileSha256||!sameDescriptor(media,lease.inspection.descriptor))fail('REFERENCE_IMAGE_REJECTED');
   // Read the same private file handle after decode, never the original or an
   // inspector-produced path. Bound and rehash a snapshot before allocating.
   const before=await scope.io(()=>file!.stat());if(!before.isFile()||before.nlink!==1||before.size!==bytes)fail('REFERENCE_SOURCE_CHANGED');
   body=Buffer.alloc(bytes);let position=0;while(position<bytes){const read=await scope.io(()=>file!.read(body!,position,Math.min(65536,bytes-position),position));if(!read.bytesRead)fail('REFERENCE_SOURCE_CHANGED');position+=read.bytesRead;}
   const after=await scope.io(()=>file!.stat());if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash(body)!==lease.proxy.sha256)fail('REFERENCE_SOURCE_CHANGED');
   // Conservative local marker precedes a broker call: a lost response may have
   // crossed the broker's durable intent. fail() must retain that uncertainty.
   await scope.authorize(true);externalIntent=true;await scope.io(()=>broker.allocate(currentLease,scope.signal));
   const allocation=await scope.io(()=>broker.uploadCapability(currentLease,scope.signal));
   if(!uuid(allocation.mediaId)||typeof allocation.uploadUrl!=='string'||!Number.isFinite(Date.parse(allocation.expiresAt))||Date.parse(allocation.expiresAt)<=Date.now())fail('REFERENCE_PROVIDER_UNCERTAIN');
   const actionId=await scope.io(()=>beginPut(currentLease,scope.signal));if(!uuid(actionId))fail('REFERENCE_PROVIDER_UNCERTAIN');
   const uploaded=await scope.io(()=>{if(Date.parse(allocation.expiresAt)<=Date.now())fail('REFERENCE_PROVIDER_UNCERTAIN');return upload({locator:allocation.uploadUrl,body:body!,bytes,sha256:currentLease.proxy.sha256,contentType:media.contentType as HiggsfieldReferenceUpload['contentType'],deadlineMs:Math.max(1,Math.min(deadline,Date.parse(allocation.expiresAt)-Date.now())),signal:scope.signal,assertAuthority:async()=>{await scope.authorize(true);if(Date.parse(allocation.expiresAt)<=Date.now())fail('REFERENCE_AUTHORITY_CHANGED');}});});
   if(uploaded.bytes!==bytes||uploaded.sha256!==lease.proxy.sha256||uploaded.status!==200)fail('REFERENCE_PROVIDER_UNCERTAIN');
   await scope.io(()=>completePut(currentLease,actionId,{phase:'put',bytes,sha256:currentLease.proxy.sha256,httpStatus:200},scope.signal));
   await scope.authorize(true);await scope.bound(broker.confirm(currentLease,scope.signal));return {processed:true,referenceId:lease.referenceId,status:'confirmed'};
  }catch(error){
   const code:HiggsfieldReferenceWorkerCode=externalIntent?'REFERENCE_PROVIDER_UNCERTAIN':error instanceof HiggsfieldReferenceWorkerError?error.code:'REFERENCE_WORKER_FAILED';
   if(!lease)return {processed:false,status:'disabled',code};
   // One local failure receipt attempt, never a provider retry. Backend also
   // treats any recorded external intent as uncertain on lease expiry.
   let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([scope.track(Promise.resolve().then(()=>dependencies.fail(lease!,{code,uncertain:externalIntent}))),new Promise<void>(resolve=>{timeout=setTimeout(resolve,checkTimeout);})]);}catch{}finally{clearTimeout(timeout);}
   return {processed:true,referenceId:lease.referenceId,status:externalIntent?'uncertain':code==='REFERENCE_AUTHORITY_CHANGED'?'blocked':'failed',code};
  }})();
  // Cancelling an await is not proof its decoder, file I/O or stream has stopped.
  // Drain before closing/unlinking scratch or reporting completion. A stubborn
  // dependency gets one finite cleanup window; this instance can never reclaim.
  scope.close();
  const cleanup=(async()=>{
   let clean=true,cancelledReader:ReadableStreamDefaultReader<Uint8Array>|undefined;
   const cancelReader=async()=>{if(reader&&reader!==cancelledReader){cancelledReader=reader;try{await reader.cancel();}catch{clean=false;}}};
   await Promise.all([scope.drain(),cancelReader()]);
   // A read response may arrive after cancellation; its tracked callback first
   // takes ownership so this final pass cannot lose the late stream.
   await cancelReader();
   body?.fill(0);
   if(reader)try{reader.releaseLock();}catch{clean=false;}
   let closed=true;try{await file?.close();}catch{clean=false;closed=false;}
   if(scratch&&closed)try{if(!root||dirname(scratch)!==root)throw new Error('Invalid scratch scope');await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{clean=false;}
   return clean;
  })();
  let timer:ReturnType<typeof setTimeout>|undefined,clean=false;
  try{clean=await Promise.race([cleanup,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),cleanupTimeout);})]);}catch{/* No raw local errors leave this worker. */}finally{clearTimeout(timer);busy=false;}
  if(!clean){
   poisoned=true;
   // A committed remote inspection/confirmation is not rewritten by a second
   // failure RPC. Stop admission and retain any prior provider uncertainty.
   return {...outcome,status:externalIntent?'uncertain':outcome.processed?'failed':'disabled',code:externalIntent?'REFERENCE_PROVIDER_UNCERTAIN':outcome.code??'REFERENCE_WORKER_FAILED'};
  }
  return outcome;
 }};
}
