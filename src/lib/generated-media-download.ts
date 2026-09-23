import {Sha256Js} from '@smithy/core/checksum';
import type {StudioGeneratedArtifact} from './studio-protocol';
import {assertGeneratedDownload} from './generated-media-ui';
import {downloadStorageFile,type StorageDownloadAccess,type StorageSaveTarget} from './project-storage-client';

type Context={gatewayOrigin:string;signal?:AbortSignal;fetch?:typeof fetch;onProgress?:(bytes:number)=>void};
/** Generated-media downloads verify the received bytes before committing a disk
 * writer or returning a Blob. The existing transport still owns endpoint/token,
 * length, backpressure and the 128 MiB fallback bound. No retries or buffering of
 * the complete media: SHA-256 holds only its fixed internal state and one chunk. */
export async function downloadGeneratedMedia(access:StorageDownloadAccess,artifact:StudioGeneratedArtifact,target:StorageSaveTarget|null,context:Context){
 try{context.signal?.throwIfAborted();assertGeneratedDownload(access,artifact,context.gatewayOrigin);}
 catch(error){await target?.abort(error).catch(()=>{});throw error;}
 return downloadVerifiedStorageFile(access,artifact.file,target,context);
}
/** Shared byte verifier for internal and authenticated client storage transports.
 * The caller separately validates its immutable version and scoped endpoint. */
export async function downloadVerifiedStorageFile(access:StorageDownloadAccess,file:{bytes:number;sha256:string;contentType:string},target:StorageSaveTarget|null,context:Context){
 let verified=false,aborted=false;
 const abort=async(error?:unknown)=>{if(target&&!aborted){aborted=true;await target.abort(error).catch(()=>{});}};
 const writer:StorageSaveTarget|null=target?{
  write:async chunk=>{context.signal?.throwIfAborted();await target.write(chunk);context.signal?.throwIfAborted();},
  close:async()=>{context.signal?.throwIfAborted();if(!verified)throw Error('The downloaded file checksum was not verified.');await target.close();},
  abort,
 }:null;
 try{
  context.signal?.throwIfAborted();
  if(!Number.isSafeInteger(file.bytes)||file.bytes<1||!/^[a-f0-9]{64}$/.test(file.sha256)||access.bytes!==file.bytes||access.sha256!==file.sha256||access.contentType!==file.contentType)throw Error('Download access does not match the exact file facts.');
  const transport:typeof fetch=async(input,init)=>{
   context.signal?.throwIfAborted();
   const response=await(context.fetch??fetch)(input,init);
   if(context.signal?.aborted){await response.body?.cancel().catch(()=>{});context.signal.throwIfAborted();}
   if(!response.ok||!response.body)return response;
   const declared=response.headers.get('content-length');
   if(declared!==null&&Number(declared)!==file.bytes){await response.body.cancel().catch(()=>{});throw Error('The stored file length differs from this registered version.');}
   const hash=new Sha256Js();let received=0;
   const stream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){context.signal?.throwIfAborted();received+=chunk.byteLength;if(received>file.bytes)throw Error('The download exceeded this registered file size.');hash.update(chunk);controller.enqueue(chunk);},
    async flush(){
     context.signal?.throwIfAborted();
     if(received!==file.bytes)throw Error('The download ended before the complete file arrived.');
     const actual=Array.from(await hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
     context.signal?.throwIfAborted();
     if(actual!==file.sha256)throw Error('The downloaded file checksum differs from this registered version. No file was saved.');
     verified=true;
    },
   }),{signal:context.signal});
   return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  const result=await downloadStorageFile(access,writer,{...context,fetch:transport});
  context.signal?.throwIfAborted();
  if(!verified)throw Error('The downloaded file checksum was not verified.');
  return result;
 }catch(error){await abort(error);throw error;}
}
