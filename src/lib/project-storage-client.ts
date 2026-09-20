/** Browser transfer client. Provider credentials never enter this module. */
export type StorageUploadTicket={id:string;versionId:string;baseUrl:string;token:string;expiresAt:string;partBytes:number;totalBytes:number};
export type StorageUploadStatus={upload:{id:string;versionId:string;status:string;totalBytes:number;partBytes:number;uploadedBytes:number;parts:{partNumber:number;bytes:number;sha256:string}[];expiresAt:string};verified?:{sha256:string;bytes:number}};
export type StorageDownloadAccess={url:string;headers:{Authorization:string};expiresAt:string;bytes:number;name:string;sha256:string;contentType?:string};
export type StorageSaveTarget={write(chunk:Uint8Array):Promise<void>;close():Promise<void>;abort(reason?:unknown):Promise<void>};
export const STORAGE_BROWSER_BLOB_LIMIT=128*1024**2;
type Context={gatewayOrigin:string;signal?:AbortSignal;fetch?:typeof fetch};
type UploadContext=Context&{renew?:(current:StorageUploadTicket)=>Promise<StorageUploadTicket>;onRenew?:(renewed:StorageUploadTicket)=>void};
const message='The transfer response was not confirmed. Check its status before trying again.';
function endpoint(value:string,origin:string){const url=new URL(value),expected=new URL(origin);if(url.origin!==expected.origin||url.username||url.password||url.hash||url.search||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost'].includes(url.hostname))throw Error('The transfer service address is invalid. Refresh project files.');return url.href;}
function ticket(value:StorageUploadTicket,context:Context,requireCurrent=true){endpoint(value.baseUrl,context.gatewayOrigin);if(!value.token||!Number.isSafeInteger(value.partBytes)||value.partBytes<1||value.partBytes>64*1024**2||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<1||!Number.isFinite(Date.parse(value.expiresAt)))throw Error('The upload session is invalid. Refresh project files.');if(requireCurrent&&Date.parse(value.expiresAt)<=Date.now())throw Error('This transfer access expired. Keep your file and request renewed access before continuing.');}
function uploadSession(original:StorageUploadTicket,context:UploadContext){
 let current=original;
 return async(suffix:string,method:string,body?:Blob)=>{
  context.signal?.throwIfAborted();ticket(current,context,false);
  if(context.renew&&Date.parse(current.expiresAt)<=Date.now()+60000){
   const renewed=await context.renew(current);context.signal?.throwIfAborted();ticket(renewed,context);
   if(['id','versionId','baseUrl','partBytes','totalBytes'].some(key=>renewed[key as keyof StorageUploadTicket]!==original[key as keyof StorageUploadTicket]))throw Error('Renewed access belongs to different file details. Keep the original upload and refresh its status.');
   current=renewed;context.onRenew?.(renewed);
  }
  ticket(current,context);
  // Exactly one request: renewal never retries an uncertain provider operation.
  const response=await(context.fetch??fetch)(endpoint(current.baseUrl+suffix,context.gatewayOrigin),{method,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:context.signal,headers:{Authorization:'Bearer '+current.token,...body?{'Content-Type':'application/octet-stream'}:method!=='GET'?{'Content-Type':'application/json'}:{}},...method==='GET'?{}:{body:body??'{}'}});
  const text=await response.text();if(text.length>512*1024)throw Error(message);let result:Record<string,any>;try{result=JSON.parse(text);}catch{throw Error(message);}if(!response.ok)throw Object.assign(new Error(typeof result.error==='string'?result.error:message),{status:response.status,code:result.code});return result;
 };
}
function state(value:Record<string,any>,expected:StorageUploadTicket):StorageUploadStatus{const upload=value.upload;if(!upload||upload.id!==expected.id||upload.versionId!==expected.versionId||upload.totalBytes!==expected.totalBytes||upload.partBytes!==expected.partBytes||!Array.isArray(upload.parts)||!Number.isSafeInteger(upload.uploadedBytes)||upload.uploadedBytes<0||upload.uploadedBytes>expected.totalBytes)throw Error(message);const seen=new Set<number>();for(const part of upload.parts){const expectedBytes=Math.min(expected.partBytes,expected.totalBytes-(part.partNumber-1)*expected.partBytes);if(!Number.isInteger(part.partNumber)||part.partNumber<1||seen.has(part.partNumber)||part.bytes!==expectedBytes||expectedBytes<=0||typeof part.sha256!=='string'||!/^[a-f0-9]{64}$/.test(part.sha256))throw Error(message);seen.add(part.partNumber);}if(upload.parts.reduce((sum:number,part:{bytes:number})=>sum+part.bytes,0)!==upload.uploadedBytes||['ready','verifying'].includes(upload.status)&&upload.uploadedBytes!==expected.totalBytes)throw Error(message);if(upload.status==='ready'&&(!value.verified||value.verified.bytes!==expected.totalBytes||!/^[a-f0-9]{64}$/.test(value.verified.sha256)))throw Error('The upload is not yet backed by a verified file receipt.');return value as StorageUploadStatus;}
export async function readStorageUpload(value:StorageUploadTicket,context:UploadContext){return state(await uploadSession(value,context)('','GET'),value);}
export async function cancelStorageUpload(value:StorageUploadTicket,context:UploadContext){return uploadSession(value,context)('/cancel','POST');}

/** Sequential Blob slices keep large originals out of browser-wide ArrayBuffers.
 * Resume verifies every committed slice before any remaining write. No network retries. */
export async function uploadStorageFile(file:Blob,value:StorageUploadTicket,context:UploadContext&{onProgress?:(bytes:number,phase:string)=>void}){
 ticket(value,context,false);if(file.size!==value.totalBytes)throw Error('Choose the same file that this upload session reserved.');
 const call=uploadSession(value,context);
 let current=state(await call('','GET'),value);
 if(current.upload.status==='allocated'){await call('/start','POST');current=state(await call('','GET'),value);}
 if(['ready','verifying'].includes(current.upload.status))return current;
 if(current.upload.status!=='uploading')throw Error('This upload is '+current.upload.status+'. Check its stored status before continuing.');
 const received=new Map(current.upload.parts.map(part=>[part.partNumber,part])),total=Math.ceil(file.size/value.partBytes);let sent=current.upload.uploadedBytes;context.onProgress?.(sent,'uploading');
 // Validate all prior receipts before filling any gaps: checking only as the
 // sending loop reaches a part could write mixed bytes before a later mismatch.
 for(const receipt of received.values()){
  context.signal?.throwIfAborted();
  const offset=(receipt.partNumber-1)*value.partBytes,part=file.slice(offset,Math.min(file.size,offset+value.partBytes));
  const digest=await crypto.subtle.digest('SHA-256',await part.arrayBuffer());
  context.signal?.throwIfAborted();
  const sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(sha256!==receipt.sha256)throw Error('This file differs from the bytes already uploaded. Choose the original file or start a new file version.');
 }
 for(let partNumber=1;partNumber<=total;partNumber++){
  context.signal?.throwIfAborted();if(received.has(partNumber))continue;
  const offset=(partNumber-1)*value.partBytes,part=file.slice(offset,Math.min(file.size,offset+value.partBytes));
  const receipt=await call('/parts/'+partNumber,'PUT',part);
  if(receipt.partNumber!==partNumber||receipt.bytes!==part.size||typeof receipt.sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.sha256))throw Error(message);
  sent+=part.size;context.onProgress?.(sent,'uploading');
 }
 context.onProgress?.(file.size,'verifying');await call('/complete','POST');return state(await call('','GET'),value);
}

export function canStreamStorageDownload(){return typeof window!=='undefined'&&typeof(window as unknown as {showSaveFilePicker?:unknown}).showSaveFilePicker==='function';}
/** Call directly inside the click handler, before an asynchronous access request. */
export async function chooseStorageDownloadTarget(name:string):Promise<StorageSaveTarget|null>{
 if(!canStreamStorageDownload())return null;
 const picker=(window as unknown as {showSaveFilePicker:(options:{suggestedName:string})=>Promise<{createWritable:()=>Promise<StorageSaveTarget>}>}).showSaveFilePicker;
 return(await picker.call(window,{suggestedName:name})).createWritable();
}
export async function downloadStorageFile(access:StorageDownloadAccess,target:StorageSaveTarget|null,context:Context&{onProgress?:(bytes:number)=>void}){
 endpoint(access.url,context.gatewayOrigin);if(!/^Bearer [A-Za-z0-9_-]+$/.test(access.headers.Authorization)||!Number.isSafeInteger(access.bytes)||access.bytes<1||(!Number.isFinite(Date.parse(access.expiresAt))||Date.parse(access.expiresAt)<=Date.now()))throw Error('Download access is invalid or expired. Request a fresh download.');
 if(!target&&access.bytes>STORAGE_BROWSER_BLOB_LIMIT)throw Error('This browser cannot save this large file as a stream. Use a browser with a file save picker, or the authenticated storage API.');
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,received=0;const chunks:Uint8Array<ArrayBuffer>[]=[];
 try{
  const response=await(context.fetch??fetch)(endpoint(access.url,context.gatewayOrigin),{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:context.signal,headers:{Authorization:access.headers.Authorization}});
  if(!response.ok||!response.body)throw Error('The download could not be opened. Request a fresh download.');
  const declared=response.headers.get('content-length');if(declared!==null&&Number(declared)!==access.bytes)throw Error('The stored file length differs from this version.');
  reader=response.body.getReader();
  while(true){context.signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;received+=chunk.value.byteLength;if(received>access.bytes||!target&&received>STORAGE_BROWSER_BLOB_LIMIT)throw Error('The download exceeded its expected file size.');if(target)await target.write(chunk.value);else chunks.push(new Uint8Array(chunk.value));context.onProgress?.(received);}
  if(received!==access.bytes)throw Error('The download ended before the complete file arrived.');
  if(target){await target.close();return {bytes:received,blob:null};}
  return {bytes:received,blob:new Blob(chunks,{type:access.contentType??'application/octet-stream'})};
 }catch(error){await reader?.cancel().catch(()=>{});await target?.abort(error).catch(()=>{});throw error;}finally{reader?.releaseLock();}
}
