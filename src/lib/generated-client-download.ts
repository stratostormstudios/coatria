import {downloadVerifiedStorageFile} from './generated-media-download';
import type {StorageSaveTarget} from './project-storage-client';
import type {StudioGeneratedClientDeliveryFile,StudioGeneratedClientAccess} from './studio-client-delivery-protocol';

export type GeneratedClientFile=StudioGeneratedClientDeliveryFile;
export type GeneratedClientAccess=StudioGeneratedClientAccess;
export const GENERATED_CLIENT_PART_BYTES=4*1024**2;
const ACCESS_EXPIRY_MARGIN_MS=15_000,ACCESS_MAX_AGE_MS=30_000;
type Context={signal?:AbortSignal;fetch?:typeof fetch;renew:()=>Promise<GeneratedClientAccess>;onProgress?:(bytes:number)=>void};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function assertGeneratedClientAccess(access:GeneratedClientAccess,file:GeneratedClientFile,gatewayOrigin=access.gatewayOrigin){
 const invalid=()=>{throw Error('Download access does not match this exact client package file. Refresh the portal.');};
 if(!access||!file||file.transport!=='project_storage'||!uuid.test(file.storageVersionId)||file.fileId!==file.storageVersionId||!uuid.test(file.artifactId)||!['image','video','audio'].includes(file.mediaKind)||file.frame!==null||!Number.isSafeInteger(file.bytes)||file.bytes<1||!/^[a-f0-9]{64}$/.test(file.sha256)||!file.path||/[\\/\x00-\x1f\x7f]/.test(file.path)||!file.contentType.startsWith(file.mediaKind+'/'))invalid();
 let url:URL,origin:URL;try{url=new URL(access.url);origin=new URL(gatewayOrigin);}catch{invalid();return;}
 if(!['https:','http:'].includes(origin.protocol)||origin.protocol==='http:'&&!['localhost','127.0.0.1'].includes(origin.hostname)||origin.href!==origin.origin+'/'||access.gatewayOrigin!==origin.origin||url.origin!==origin.origin||url.pathname!==`/v1/client-files/${file.storageVersionId}`||url.search||url.hash||url.username||url.password||access.transport!=='project_storage'||access.storageVersionId!==file.storageVersionId||access.bytes!==file.bytes||access.sha256!==file.sha256||access.contentType!==file.contentType||access.name!==file.path||!/^Bearer sct_[A-Za-z0-9_-]{43}$/.test(access.headers?.Authorization)||!Number.isFinite(Date.parse(access.expiresAt))||Date.parse(access.expiresAt)<=Date.now()||access.status!=='download_access_issued'||access.bytesReceivedByClient!=='not_observed')invalid();
}

/** Reuse only the live access window; the gateway rechecks authority on every
 * range. No network retry or bearer persistence. Full SHA-256 precedes commit. */
export async function downloadGeneratedClientFile(initial:GeneratedClientAccess,file:GeneratedClientFile,target:StorageSaveTarget|null,context:Context){
 const controller=new AbortController(),stop=()=>controller.abort(context.signal?.reason);context.signal?.addEventListener('abort',stop,{once:true});if(context.signal?.aborted)stop();
 let reader:ReadableStreamDefaultReader<Uint8Array>|null=null,cancelled=false,offset=0,partEnd=-1,partReceived=0,access=initial,accessStartedAt=performance.now();
 const closeReader=async(reason?:unknown)=>{const current=reader;reader=null;if(current){try{await current.cancel(reason);}catch{}try{current.releaseLock();}catch{}}};
 const transport:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({
  async pull(stream){
   try{
    while(true){
    controller.signal.throwIfAborted();
    if(!reader){
     if(offset===file.bytes){stream.close();return;}
     if(Date.parse(access.expiresAt)-Date.now()<=ACCESS_EXPIRY_MARGIN_MS||performance.now()-accessStartedAt>=ACCESS_MAX_AGE_MS){
      // Measure from the request start so a delayed access response cannot extend
      // the reuse window. A failed renewal stops this save without retrying.
      accessStartedAt=performance.now();access=await context.renew();controller.signal.throwIfAborted();
     }
     assertGeneratedClientAccess(access,file,initial.gatewayOrigin);
     partEnd=Math.min(offset+GENERATED_CLIENT_PART_BYTES,file.bytes)-1;partReceived=0;
     const response=await(context.fetch??fetch)(access.url,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{Authorization:access.headers.Authorization,Range:`bytes=${offset}-${partEnd}`}});
     if(cancelled||controller.signal.aborted){await response.body?.cancel().catch(()=>{});controller.signal.throwIfAborted();throw Error('Download cancelled.');}
     if(response.status!==206||!response.body||response.headers.get('Content-Range')!==`bytes ${offset}-${partEnd}/${file.bytes}`||response.headers.get('Content-Length')!==String(partEnd-offset+1)||response.headers.get('X-Content-SHA256')!==file.sha256){await response.body?.cancel().catch(()=>{});throw Error('The file range was not confirmed. Request a fresh download; no automatic retry was made.');}
     reader=response.body.getReader();
    }
    const chunk=await reader.read();controller.signal.throwIfAborted();
    if(chunk.done){reader.releaseLock();reader=null;if(partReceived!==partEnd-offset+1)throw Error('The file range ended before all expected bytes arrived.');offset=partEnd+1;continue;}
    partReceived+=chunk.value.byteLength;if(partReceived>partEnd-offset+1)throw Error('The file range exceeded its expected size.');stream.enqueue(chunk.value);return;
    }
   }catch(error){await closeReader(error);if(!cancelled)stream.error(error);}
  },
  async cancel(reason){cancelled=true;controller.abort(reason);await closeReader(reason);},
 },{highWaterMark:0}),{headers:{'Content-Length':String(file.bytes),'Content-Type':file.contentType}});
 try{
  controller.signal.throwIfAborted();assertGeneratedClientAccess(initial,file);
  return await downloadVerifiedStorageFile(initial,file,target,{gatewayOrigin:initial.gatewayOrigin,signal:controller.signal,fetch:transport,onProgress:context.onProgress});
 }catch(error){await target?.abort(error).catch(()=>{});throw error;}
 finally{cancelled=true;controller.abort();await closeReader();context.signal?.removeEventListener('abort',stop);}
}
