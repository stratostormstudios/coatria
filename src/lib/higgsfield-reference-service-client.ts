/** Private reference-runner RPC adapter. No database/provider credentials,
 * arbitrary tool calls, redirects or automatic retries belong in this client. */
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';
import {HIGGSFIELD_REFERENCE_POLICY,type HiggsfieldReferenceLease} from './higgsfield-references-protocol';
import type {HiggsfieldReferenceWorkerDependencies} from './higgsfield-reference-worker';

export class ReferenceServiceClientError extends Error {
 constructor(readonly code:'REFERENCE_SERVICE_CONFIGURATION_INVALID'|'REFERENCE_SERVICE_UNAVAILABLE'|'REFERENCE_SERVICE_RESPONSE_INVALID'|'REFERENCE_SERVICE_ABORTED'){super(code);this.name='ReferenceServiceClientError';}
}
function fail(code:ReferenceServiceClientError['code']):never{throw new ReferenceServiceClientError(code);}
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid(),date=z.iso.datetime(),integer=z.number().int().positive();
const color=z.object({space:z.string().max(80).nullable(),primaries:z.string().max(80).nullable(),transfer:z.string().max(80).nullable(),range:z.string().max(80).nullable()}).strict();
const descriptor=z.object({kind:z.literal('image'),format:z.enum(['png','jpeg','webp']),contentType:z.enum(['image/png','image/jpeg','image/webp']),bytes:integer.max(HIGGSFIELD_REFERENCE_POLICY.maxBytes),sha256:hash,verification:z.literal('full_decode'),inspectionVersion:z.literal(1),width:integer.max(4096),height:integer.max(4096),codec:z.string().max(80),color}).strict();
const version=z.object({versionId:uuid,fileId:uuid,name:z.string().max(1024),version:integer,bytes:integer.max(HIGGSFIELD_REFERENCE_POLICY.maxBytes),sha256:hash,contentType:z.enum(['image/png','image/jpeg','image/webp'])}).strict();
const leaseSchema=z.object({companyId:uuid,projectId:uuid,referenceId:uuid,leaseId:uuid,requestHash:hash,phase:z.enum(['inspect','transfer']),expiresAt:date,proxy:version,role:z.enum(['image','start_image','end_image']),inspection:z.object({descriptor,profileSha256:hash,inspectionHash:hash,inspectedAt:date}).strict().nullable()}).strict();
const readinessSchema=z.object({enabled:z.boolean(),hostQualified:z.boolean(),storageVerified:z.boolean(),catalogVerified:z.boolean(),profileSha256:hash,qualificationSha256:hash,expiresAt:date}).strict();
const allocationSchema=z.object({mediaId:uuid,uploadUrl:z.string().url().max(8192),expiresAt:date}).strict();
const okay=z.object({ok:z.literal(true)}).strict();
export type ReferenceServiceClientOptions={origin:string;serviceId:string;companyId:string;projectIds:readonly string[];token:string;expiresAt:string;profileSha256:string;qualificationSha256:string;requestTimeoutMs?:number};
type Transport={fetch?:typeof fetch};
export type ReferenceServiceClient=Pick<HiggsfieldReferenceWorkerDependencies,'readiness'|'claim'|'authorize'|'readProxy'|'recordInspection'|'beginPut'|'completePut'|'fail'|'broker'>&{drain:()=>Promise<void>};

export function referenceServiceOrigin(value:string){
 let url:URL;try{url=new URL(value);}catch{return fail('REFERENCE_SERVICE_CONFIGURATION_INVALID');}
 if(url.origin!==value||url.protocol!=='https:'||url.username||url.password||url.port||isIP(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.localhost')||!url.hostname.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)))fail('REFERENCE_SERVICE_CONFIGURATION_INVALID');
 return url.origin;
}
function valid<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);if(!parsed.success)fail('REFERENCE_SERVICE_RESPONSE_INVALID');return parsed.data;}
function requestScope(signal:AbortSignal|undefined,timeoutMs:number){
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,timeoutMs);
 const current=()=>{if(controller.signal.aborted)fail('REFERENCE_SERVICE_ABORTED');};
 return {signal:controller.signal,current,close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);},bound<T>(promise:Promise<T>):Promise<T>{return new Promise((resolve,reject)=>{const stopped=()=>{controller.signal.removeEventListener('abort',stopped);reject(new ReferenceServiceClientError('REFERENCE_SERVICE_ABORTED'));};controller.signal.addEventListener('abort',stopped,{once:true});promise.then(v=>{controller.signal.removeEventListener('abort',stopped);try{current();resolve(v);}catch(e){reject(e);}},()=>{controller.signal.removeEventListener('abort',stopped);reject(new ReferenceServiceClientError('REFERENCE_SERVICE_UNAVAILABLE'));});if(controller.signal.aborted)stopped();});}};
}
async function boundedJson(response:Response,scope:ReturnType<typeof requestScope>,readerFor:()=>ReadableStreamDefaultReader<Uint8Array>){
 if(!response.body||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')fail('REFERENCE_SERVICE_RESPONSE_INVALID');
 const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9]\d*)$/.test(length)||Number(length)>65536))fail('REFERENCE_SERVICE_RESPONSE_INVALID');
 const reader=readerFor(),chunks:Uint8Array[]=[];let bytes=0;
 for(;;){const next=await scope.bound(reader.read());if(next.done)break;if(!(next.value instanceof Uint8Array)||(bytes+=next.value.byteLength)>65536)fail('REFERENCE_SERVICE_RESPONSE_INVALID');chunks.push(next.value);}if(length!==null&&bytes!==Number(length))fail('REFERENCE_SERVICE_RESPONSE_INVALID');try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{return fail('REFERENCE_SERVICE_RESPONSE_INVALID');}
}
export function createHiggsfieldReferenceServiceClient(options:ReferenceServiceClientOptions,transport:Transport={}):ReferenceServiceClient {
 const origin=referenceServiceOrigin(options.origin),serviceId=valid(uuid,options.serviceId),companyId=valid(uuid,options.companyId),projects=new Set(options.projectIds),expiry=Date.parse(options.expiresAt),timeout=options.requestTimeoutMs??25000;
 if(!/^rfs_[A-Za-z0-9_-]{43}$/.test(options.token)||!hash.safeParse(options.profileSha256).success||!hash.safeParse(options.qualificationSha256).success||!date.safeParse(options.expiresAt).success||!Number.isFinite(expiry)||expiry<=Date.now()||expiry-Date.now()>86400000||!projects.size||projects.size>100||projects.size!==options.projectIds.length||options.projectIds.some(id=>!uuid.safeParse(id).success)||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)fail('REFERENCE_SERVICE_CONFIGURATION_INVALID');
 const token=options.token,profileSha256=options.profileSha256,qualificationSha256=options.qualificationSha256,send=transport.fetch??fetch;
 const pending=new Set<Promise<unknown>>();let cleanupFailed=false;
 function track<T>(value:Promise<T>){pending.add(value);void value.then(()=>pending.delete(value),()=>pending.delete(value));return value;}
 // RPC deadlines bound the caller's wait, not ownership of the raw transport.
 // Worker shutdown separately drains these exact promises before new admission.
 function own(response:Response){
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancellation:Promise<void>|undefined;
  return {response,reader:()=>{if(!response.body)fail('REFERENCE_SERVICE_RESPONSE_INVALID');return reader??=response.body.getReader();},cancel:()=>cancellation??=track(Promise.resolve().then(async()=>{
   try{if(reader)await reader.cancel();else await response.body?.cancel();}
   finally{reader?.releaseLock();}
  }).catch(()=>{cleanupFailed=true;throw new ReferenceServiceClientError('REFERENCE_SERVICE_UNAVAILABLE');}))};
 }
 function identity(lease:HiggsfieldReferenceLease,cleanup=false){if(lease.companyId!==companyId||!projects.has(lease.projectId)||!uuid.safeParse(lease.referenceId).success||!uuid.safeParse(lease.leaseId).success||!hash.safeParse(lease.requestHash).success||!date.safeParse(lease.expiresAt).success||!cleanup&&Date.parse(lease.expiresAt)<=Date.now()||Date.parse(lease.expiresAt)>expiry)fail('REFERENCE_SERVICE_CONFIGURATION_INVALID');return {referenceId:lease.referenceId,leaseId:lease.leaseId,requestHash:lease.requestHash};}
 async function start(operation:string,body:Record<string,unknown>,signal?:AbortSignal){
  // Failure receipts alone use the server's finite cleanup grace. This cannot
  // read bytes, renew a lease, allocate media or resume a provider phase.
  if(cleanupFailed)fail('REFERENCE_SERVICE_UNAVAILABLE');
  const deadline=expiry+(operation==='fail'?600000:0);if(deadline<=Date.now())fail('REFERENCE_SERVICE_ABORTED');const scope=requestScope(signal,Math.min(timeout,operation==='fail'?5000:30000,deadline-Date.now()));let owned:ReturnType<typeof own>|undefined,abandoned=false;
  try{scope.current();const request=track(Promise.resolve(send(`${origin}/api/internal/reference-services/${serviceId}/${operation}`,{method:'POST',redirect:'error',cache:'no-store',credentials:'omit',headers:{authorization:'Bearer '+token,'content-type':'application/json','accept':operation==='read-proxy'?'image/png, image/jpeg, image/webp':'application/json'},body:JSON.stringify({requestId:randomUUID(),...body}),signal:scope.signal})).then(value=>{const result=own(value);owned=result;if(scope.signal.aborted||abandoned)void result.cancel().catch(()=>{});return result;}));
   owned=await scope.bound(request);scope.current();const response=owned.response;
   if(response.status!==200||response.redirected||response.headers.has('content-range')||response.headers.has('content-encoding')&&response.headers.get('content-encoding')!=='identity')fail('REFERENCE_SERVICE_RESPONSE_INVALID');return {...owned,scope};
  }catch(error){abandoned=true;scope.close();void owned?.cancel().catch(()=>{});throw error instanceof ReferenceServiceClientError?error:new ReferenceServiceClientError('REFERENCE_SERVICE_UNAVAILABLE');}
 }
 async function json<T>(operation:string,body:Record<string,unknown>,schema:z.ZodType<T>,signal?:AbortSignal){const owned=await start(operation,body,signal),{response,scope}=owned;try{const result=valid(schema,await boundedJson(response,scope,owned.reader));await scope.bound(owned.cancel());return result;}finally{scope.close();void owned.cancel().catch(()=>{});}}
 const bound=async(operation:string,lease:HiggsfieldReferenceLease,extra:Record<string,unknown>,signal?:AbortSignal)=>{await json(operation,{...identity(lease,operation==='fail'),...extra},okay,signal);};
 return {
  drain:async()=>{while(pending.size)await Promise.allSettled([...pending]);if(cleanupFailed)fail('REFERENCE_SERVICE_UNAVAILABLE');},
  readiness:async signal=>{const {readiness}=await json('readiness',{},z.object({readiness:readinessSchema}).strict(),signal);if(readiness.profileSha256!==profileSha256||readiness.qualificationSha256!==qualificationSha256||Date.parse(readiness.expiresAt)>expiry||Date.parse(readiness.expiresAt)<=Date.now())fail('REFERENCE_SERVICE_RESPONSE_INVALID');return readiness;},
  claim:async signal=>{const {lease}=await json('claim',{},z.object({lease:leaseSchema.nullable()}).strict(),signal);if(lease)identity(lease);return lease;},
  authorize:async(lease,signal)=>(await json('authorize',identity(lease),z.object({authorized:z.literal(true)}).strict(),signal)).authorized,
  readProxy:async(lease,signal)=>{
   const owned=await start('read-proxy',identity(lease),signal),{response,scope}=owned;
   try{
    const bytes=response.headers.get('content-length'),type=response.headers.get('content-type'),etag=response.headers.get('etag'),sha=response.headers.get('x-coatria-reference-sha256');
    if(!response.body||bytes!==String(lease.proxy.bytes)||type!==lease.proxy.contentType||sha!==lease.proxy.sha256||!etag||etag.length>256||/[\r\n,]/.test(etag)||etag==='*'||etag.startsWith('W/'))fail('REFERENCE_SERVICE_RESPONSE_INVALID');
    const reader=owned.reader();let count=0,ended=false,outputEnded=false,output:ReadableStreamDefaultController<Uint8Array>|undefined;
    const close=()=>{if(!ended){ended=true;scope.signal.removeEventListener('abort',aborted);scope.close();}return owned.cancel();};
    const aborted=()=>{void close().catch(()=>{});if(!outputEnded){outputEnded=true;output?.error(new ReferenceServiceClientError('REFERENCE_SERVICE_ABORTED'));}};
    const stream=new ReadableStream<Uint8Array>({start(controller){output=controller;},async pull(controller){try{scope.current();const part=await scope.bound(reader.read());if(ended)return;if(part.done){if(count!==lease.proxy.bytes)fail('REFERENCE_SERVICE_RESPONSE_INVALID');await close();if(!outputEnded){outputEnded=true;controller.close();}return;}if(!(part.value instanceof Uint8Array)||(count+=part.value.byteLength)>lease.proxy.bytes)fail('REFERENCE_SERVICE_RESPONSE_INVALID');controller.enqueue(part.value);}catch{void close().catch(()=>{});if(!outputEnded){outputEnded=true;controller.error(new ReferenceServiceClientError('REFERENCE_SERVICE_RESPONSE_INVALID'));}}},cancel(){outputEnded=true;return close();}},{highWaterMark:0});
    scope.signal.addEventListener('abort',aborted,{once:true});if(scope.signal.aborted)aborted();
    return {stream,bytes:lease.proxy.bytes,totalBytes:lease.proxy.bytes,etag,contentType:type,range:null,contentRange:null};
   }catch(error){scope.close();void owned.cancel().catch(()=>{});throw error instanceof ReferenceServiceClientError?error:new ReferenceServiceClientError('REFERENCE_SERVICE_RESPONSE_INVALID');}
  },
  recordInspection:(lease,inspection,signal)=>bound('inspection',lease,{inspection},signal),
  beginPut:async(lease,signal)=>(await json('begin-put',identity(lease),z.object({actionId:uuid}).strict(),signal)).actionId,
  completePut:(lease,actionId,result,signal)=>bound('complete-put',lease,{actionId,result},signal),
  fail:(lease,failure)=>bound('fail',lease,{failure}),
  broker:{allocate:(lease,signal)=>bound('allocate',lease,{},signal),confirm:(lease,signal)=>bound('confirm',lease,{},signal),uploadCapability:async(lease,signal)=>(await json('upload-capability',identity(lease),z.object({allocation:allocationSchema}).strict(),signal)).allocation},
 };
}
