// Node-only storage transport. Never import this module from a client component.
// Authorization and durable transfer receipts belong to the service/gateway, not this adapter.
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand} from '@aws-sdk/client-s3';
import {RUNPOD_STORAGE_REGIONS,runpodStorageEndpoint} from './project-storage-protocol';

export {RUNPOD_STORAGE_REGIONS,runpodStorageEndpoint};
export type RunpodStorageRegion=typeof RUNPOD_STORAGE_REGIONS[number];
export type RunpodStorageErrorCode='STORAGE_CONFIG_INVALID'|'STORAGE_INPUT_INVALID'|'STORAGE_ABORTED'|'STORAGE_TIMEOUT'|'STORAGE_PROVIDER_UNAVAILABLE'|'STORAGE_PROVIDER_UNCERTAIN'|'STORAGE_PROVIDER_PROTOCOL'|'STORAGE_RANGE_UNSUPPORTED'|'STORAGE_RESPONSE_TOO_LARGE'|'STORAGE_OBJECT_CHANGED';
const messages:Record<RunpodStorageErrorCode,string>={STORAGE_CONFIG_INVALID:'Storage configuration is invalid.',STORAGE_INPUT_INVALID:'Storage operation is invalid.',STORAGE_ABORTED:'Storage operation was cancelled.',STORAGE_TIMEOUT:'Storage operation timed out.',STORAGE_PROVIDER_UNAVAILABLE:'Storage provider could not confirm the read.',STORAGE_PROVIDER_UNCERTAIN:'Storage provider could not confirm the write; reconcile before retrying.',STORAGE_PROVIDER_PROTOCOL:'Storage provider returned an invalid response.',STORAGE_RANGE_UNSUPPORTED:'Storage provider did not confirm the requested byte range.',STORAGE_RESPONSE_TOO_LARGE:'Storage response exceeded its allowed size.',STORAGE_OBJECT_CHANGED:'The stored object no longer matches its verified version.'};
export class RunpodStorageError extends Error {constructor(readonly code:RunpodStorageErrorCode){super(messages[code]);this.name='RunpodStorageError';}}
function fail(code:RunpodStorageErrorCode):never{throw new RunpodStorageError(code);}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('STORAGE_PROVIDER_PROTOCOL');return value as Record<string,unknown>;}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function id(value:unknown){if(typeof value!=='string'||!uuid.test(value))fail('STORAGE_INPUT_INVALID');return value;}
function integer(value:unknown,min:number,max:number,code:RunpodStorageErrorCode='STORAGE_INPUT_INVALID'){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)fail(code);return value;}
function text(value:unknown,max=2048,code:RunpodStorageErrorCode='STORAGE_PROVIDER_PROTOCOL'){if(typeof value!=='string'||!value.length||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail(code);return value;}
function etag(value:unknown){return text(value,256);}
function mediaType(value:unknown){if(typeof value!=='string'||value.length>160||!/^[-\w.+]+\/[-\w.+]+$/.test(value))fail('STORAGE_INPUT_INVALID');return value;}
function status(value:Record<string,unknown>){return record(value.$metadata).httpStatusCode;}
export function runpodProjectRoot(companyId:string,projectId:string){return `coatria/companies/${id(companyId)}/projects/${id(projectId)}/`;}
export function runpodProjectObjectKey(companyId:string,projectId:string,versionId:string){return runpodProjectRoot(companyId,projectId)+'objects/'+id(versionId);}

export interface RunpodProjectStorageConfig {
 companyId:string;projectId:string;volumeId:string;region:RunpodStorageRegion;
 credentials:{accessKeyId:string;secretAccessKey:string};
 timeoutMs?:number;partBytes?:number;maxObjectBytes?:number;
}
export interface RunpodStorageTransport {fetch:typeof fetch}
export interface RunpodStorageOptions {signal?:AbortSignal}
/** Server-side descriptor; not a bearer capability. Persist it in the authorized transfer job. */
export interface RunpodMultipartUpload {scope:string;versionId:string;uploadId:string;bytes:number;partBytes:number}
export interface RunpodUploadedPart {partNumber:number;etag:string;bytes:number}
export interface RunpodObjectMetadata {versionId:string;bytes:number;etag:string;modifiedAt:string|null;contentType:string|null}
export interface RunpodObjectPage {objects:RunpodObjectMetadata[];cursor:string|null}
export interface RunpodObjectRead {stream:ReadableStream<Uint8Array>;bytes:number;totalBytes:number;etag:string;contentType:string|null;contentRange:string|null;range:{start:number;end:number}|null}
export interface RunpodProjectStorage {
 list(input?:{cursor?:string;limit?:number}&RunpodStorageOptions):Promise<RunpodObjectPage>;
 head(versionId:string,options?:RunpodStorageOptions):Promise<RunpodObjectMetadata|null>;
 createMultipart(input:{versionId:string;bytes:number;contentType:string}&RunpodStorageOptions):Promise<RunpodMultipartUpload>;
 validateMultipart(upload:unknown):RunpodMultipartUpload;
 uploadPart(input:{upload:RunpodMultipartUpload;partNumber:number;body:Uint8Array|ReadableStream<Uint8Array>|Readable}&RunpodStorageOptions):Promise<RunpodUploadedPart>;
 completeMultipart(input:{upload:RunpodMultipartUpload;parts:RunpodUploadedPart[]}&RunpodStorageOptions):Promise<{versionId:string;etag:string}>;
 abortMultipart(input:{upload:RunpodMultipartUpload}&RunpodStorageOptions):Promise<void>;
 get(input:{versionId:string;range?:{start:number;end:number};maxBytes:number;ifMatch?:string}&RunpodStorageOptions):Promise<RunpodObjectRead>;
 close():void;
}

function abortError(signal:AbortSignal):RunpodStorageError{return signal.reason instanceof RunpodStorageError?signal.reason:new RunpodStorageError('STORAGE_ABORTED');}
async function untilAborted<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
 if(signal.aborted)throw abortError(signal);
 let listener:()=>void=()=>{};
 const cancelled=new Promise<never>((_,reject)=>{listener=()=>reject(abortError(signal));signal.addEventListener('abort',listener,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw abortError(signal);return operation();}),cancelled]);}finally{signal.removeEventListener('abort',listener);}
}
function scope(timeoutMs:number,signal?:AbortSignal){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new RunpodStorageError('STORAGE_TIMEOUT')),timeoutMs);
 const stop=()=>controller.abort(new RunpodStorageError('STORAGE_ABORTED'));if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
 return {signal:controller.signal,dispose(){clearTimeout(timer);signal?.removeEventListener('abort',stop);},abort(){controller.abort(new RunpodStorageError('STORAGE_ABORTED'));}};
}
function cancel(stream:ReadableStream<Uint8Array>|null|undefined){if(stream)void stream.cancel().catch(()=>{});}
function boundedStream(source:ReadableStream<Uint8Array>,signal:AbortSignal,maxBytes:number,exactBytes?:number,onFinish:()=>void=()=>{}):ReadableStream<Uint8Array>{
 const reader=source.getReader();let bytes=0,finished=false,controller:ReadableStreamDefaultController<Uint8Array>;
 const finish=()=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);onFinish();};
 const stop=()=>{void reader.cancel().catch(()=>{});};
 const abort=()=>{if(finished)return;stop();controller.error(abortError(signal));finish();};
 return new ReadableStream<Uint8Array>({
  start(c){controller=c;if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});},
  async pull(c){try{const part=await untilAborted(signal,()=>reader.read());if(finished)return;if(part.done){if(exactBytes!==undefined&&bytes!==exactBytes)fail('STORAGE_PROVIDER_PROTOCOL');c.close();finish();return;}bytes+=part.value.byteLength;if(bytes>maxBytes)fail('STORAGE_RESPONSE_TOO_LARGE');if(exactBytes!==undefined&&bytes>exactBytes)fail('STORAGE_PROVIDER_PROTOCOL');c.enqueue(part.value);}catch(error){if(finished)return;stop();c.error(error instanceof RunpodStorageError?error:new RunpodStorageError('STORAGE_PROVIDER_UNAVAILABLE'));finish();}},
  cancel(){stop();finish();}
 },{highWaterMark:0});
}

type WireRequest={protocol:string;hostname:string;port?:number;method:string;path:string;query?:Record<string,string|string[]|null>;headers:Record<string,string>;body?:unknown};
/** The SDK signs requests; this handler bounds HTTP and never follows provider redirects. */
function sdkTransport(endpoint:string,bucket:string,objectPrefix:string,maxObjectBytes:number,transport:RunpodStorageTransport){
 const hostname=new URL(endpoint).hostname;
 return {
  metadata:{handlerProtocol:'http/1.1'},
  async handle(request:WireRequest,options?:{abortSignal?:AbortSignal}){
   const signal=options?.abortSignal;if(!signal)fail('STORAGE_CONFIG_INVALID');
   if(request.protocol!=='https:'||request.hostname!==hostname||request.port!==undefined&&request.port!==443)fail('STORAGE_CONFIG_INVALID');
   const listingPath='/'+bucket+'/',objectPath='/'+bucket+'/'+objectPrefix;
   if(request.path!==listingPath&&(!request.path.startsWith(objectPath)||!uuid.test(request.path.slice(objectPath.length)))||!['GET','HEAD','PUT','POST','DELETE'].includes(request.method))fail('STORAGE_CONFIG_INVALID');
   const query=new URLSearchParams();for(const[k,v]of Object.entries(request.query??{})){for(const value of Array.isArray(v)?v:[v])query.append(k,value??'');}
   const queryString=query.toString().replaceAll('+','%20');const url=endpoint.replace(/\/$/,'')+request.path+(queryString?'?'+queryString:'');
   const headers=new Headers(request.headers);headers.set('Accept-Encoding','identity');
   if(request.body!==undefined&&typeof request.body!=='string'&&!(request.body instanceof Uint8Array)&&!(request.body instanceof Readable))fail('STORAGE_CONFIG_INVALID');
   const response=await untilAborted(signal,()=>{const pending=transport.fetch(url,{method:request.method,headers,body:request.body as BodyInit|undefined,...request.body instanceof Readable?{duplex:'half'}:{},redirect:'error',cache:'no-store',signal});void pending.then(late=>{if(signal.aborted)cancel(late.body);},()=>{});return pending;});
   if(signal.aborted){cancel(response.body);throw abortError(signal);}
   if(response.headers.get('content-encoding')&&!['identity',''].includes(response.headers.get('content-encoding')!)){cancel(response.body);fail('STORAGE_PROVIDER_PROTOCOL');}
   const objectGet=request.method==='GET'&&request.path.startsWith('/'+bucket+'/'+objectPrefix)&&!queryString;
   const maxBytes=objectGet&&response.ok?maxObjectBytes:1024*1024;
   // HEAD's Content-Length describes the object, not an HTTP response body.
   const length=request.method==='HEAD'?null:response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){cancel(response.body);fail('STORAGE_RESPONSE_TOO_LARGE');}
   const body=response.body?Readable.fromWeb(boundedStream(response.body,signal,maxBytes) as Parameters<typeof Readable.fromWeb>[0]):Readable.from([]);
   // An abort may destroy an unread Node stream before the SDK attaches its consumer.
   body.on('error',()=>{});
   return {response:{statusCode:response.status,headers:Object.fromEntries(response.headers),body}};
  },
  updateHttpClientConfig(){},httpHandlerConfigs(){return {};},destroy(){}
 };
}

/**
 * Server-only and preparatory: no presigning, provisioning, gateway, SHA verification or authorization.
 * Only opaque version UUIDs can select stored objects; display paths never select S3 keys.
 * Range is experimental until a live Runpod conformance check; ignored ranges fail closed.
 */
export function createRunpodProjectStorage(config:RunpodProjectStorageConfig,transport:RunpodStorageTransport={fetch}):RunpodProjectStorage {
 if(typeof window!=='undefined')fail('STORAGE_CONFIG_INVALID');
 let root:string,endpoint:string;
 try{root=runpodProjectRoot(config.companyId,config.projectId);endpoint=runpodStorageEndpoint(config.region);}catch{fail('STORAGE_CONFIG_INVALID');}
 if(!RUNPOD_STORAGE_REGIONS.includes(config.region)||!/^[-a-z0-9]{4,64}$/.test(config.volumeId)||!/^user_[A-Za-z0-9_-]{4,160}$/.test(config.credentials?.accessKeyId??'')||!/^rps_[A-Za-z0-9_-]{8,256}$/.test(config.credentials?.secretAccessKey??''))fail('STORAGE_CONFIG_INVALID');
 const timeoutMs=integer(config.timeoutMs??30000,1,7_200_000,'STORAGE_CONFIG_INVALID'),partBytes=integer(config.partBytes??8*1024*1024,1,64*1024*1024,'STORAGE_CONFIG_INVALID'),maxObjectBytes=integer(config.maxObjectBytes??64*1024**3,1,4_000_000_000_000,'STORAGE_CONFIG_INVALID');
 const prefix=root+'objects/',binding=createHash('sha256').update(JSON.stringify([config.region,config.volumeId,root])).digest('hex');
 const client=new S3Client({endpoint,region:config.region,credentials:{...config.credentials},forcePathStyle:true,maxAttempts:1,followRegionRedirects:false,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',requestHandler:sdkTransport(endpoint,config.volumeId,prefix,maxObjectBytes,transport),logger:{debug(){},info(){},warn(){},error(){},trace(){}}});
 const active=new Set<ReturnType<typeof scope>>();let closed=false;
 const key=(versionId:string)=>prefix+id(versionId);
 function begin(signal?:AbortSignal){if(closed)fail('STORAGE_ABORTED');const current=scope(timeoutMs,signal);active.add(current);return {current,finish(){current.dispose();active.delete(current);}};}
 function error(value:unknown,mutation:boolean){if(mutation)return new RunpodStorageError('STORAGE_PROVIDER_UNCERTAIN');if(value instanceof RunpodStorageError)return value;return new RunpodStorageError('STORAGE_PROVIDER_UNAVAILABLE');}
 async function send(command:ListObjectsV2Command|CreateMultipartUploadCommand|CompleteMultipartUploadCommand|AbortMultipartUploadCommand,mutation:boolean,signal?:AbortSignal){const context=begin(signal);const options={abortSignal:context.current.signal};try{return await untilAborted(context.current.signal,()=>{if(command instanceof ListObjectsV2Command)return client.send(command,options);if(command instanceof CreateMultipartUploadCommand)return client.send(command,options);if(command instanceof CompleteMultipartUploadCommand)return client.send(command,options);return client.send(command,options);});}catch(e){throw error(e,mutation);}finally{context.finish();}}
 function upload(value:unknown):RunpodMultipartUpload{if(!value||typeof value!=='object'||Array.isArray(value))fail('STORAGE_INPUT_INVALID');const candidate=value as Record<string,unknown>;if(candidate.scope!==binding||candidate.partBytes!==partBytes)fail('STORAGE_INPUT_INVALID');const versionId=id(candidate.versionId),uploadId=text(candidate.uploadId,2048,'STORAGE_INPUT_INVALID'),bytes=integer(candidate.bytes,1,maxObjectBytes);if(Math.ceil(bytes/partBytes)>10000)fail('STORAGE_INPUT_INVALID');return {scope:binding,versionId,uploadId,bytes,partBytes};}
 function metadata(value:unknown,versionId:string):RunpodObjectMetadata{const o=record(value);const modified=o.LastModified instanceof Date&&!Number.isNaN(o.LastModified.valueOf())?o.LastModified.toISOString():null;const contentType=typeof o.ContentType==='string'?o.ContentType.slice(0,160):null;return {versionId,bytes:integer(o.ContentLength??o.Size,0,maxObjectBytes,'STORAGE_PROVIDER_PROTOCOL'),etag:etag(o.ETag),modifiedAt:modified,contentType};}
 return {
  validateMultipart:upload,
  async list(input={}){
   const limit=integer(input.limit??50,1,100);let continuation:string|undefined;
   if(input.cursor!==undefined){try{const raw=JSON.parse(Buffer.from(text(input.cursor,8192,'STORAGE_INPUT_INVALID'),'base64url').toString('utf8'));if(raw.scope!==binding)fail('STORAGE_INPUT_INVALID');continuation=text(raw.token,2048,'STORAGE_INPUT_INVALID');}catch{fail('STORAGE_INPUT_INVALID');}}
   const result=record(await send(new ListObjectsV2Command({Bucket:config.volumeId,Prefix:prefix,Delimiter:'/',MaxKeys:limit,ContinuationToken:continuation}),false,input.signal));
   if(status(result)!==200||!Array.isArray(result.Contents??[])||((result.Contents as unknown[]|undefined)?.length??0)>limit)fail('STORAGE_PROVIDER_PROTOCOL');
   const objects=(result.Contents as unknown[]??[]).map(value=>{const o=record(value),full=text(o.Key,1024);if(!full.startsWith(prefix)||!uuid.test(full.slice(prefix.length)))fail('STORAGE_PROVIDER_PROTOCOL');return metadata(o,full.slice(prefix.length));});
   if(Array.isArray(result.CommonPrefixes)&&result.CommonPrefixes.length)fail('STORAGE_PROVIDER_PROTOCOL');
   if(result.IsTruncated!==undefined&&typeof result.IsTruncated!=='boolean')fail('STORAGE_PROVIDER_PROTOCOL');
   let cursor:string|null=null;if(result.IsTruncated){const token=text(result.NextContinuationToken);if(token===continuation)fail('STORAGE_PROVIDER_PROTOCOL');cursor=Buffer.from(JSON.stringify({scope:binding,token})).toString('base64url');}
   return {objects,cursor};
  },
  async head(versionId,options={}){
   const path=key(versionId),context=begin(options.signal);try{const result=record(await untilAborted(context.current.signal,()=>client.send(new HeadObjectCommand({Bucket:config.volumeId,Key:path}),{abortSignal:context.current.signal})));if(status(result)!==200)fail('STORAGE_PROVIDER_PROTOCOL');return metadata(result,versionId);}catch(e){if(e&&typeof e==='object'&&'$metadata'in e&&(e as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;throw error(e,false);}finally{context.finish();}
  },
  async createMultipart(input){
   const bytes=integer(input.bytes,1,maxObjectBytes);if(Math.ceil(bytes/partBytes)>10000)fail('STORAGE_INPUT_INVALID');const path=key(input.versionId),contentType=mediaType(input.contentType);
   const result=record(await send(new CreateMultipartUploadCommand({Bucket:config.volumeId,Key:path,ContentType:contentType}),true,input.signal));
   if(status(result)!==200||result.Bucket!==config.volumeId||result.Key!==path)fail('STORAGE_PROVIDER_UNCERTAIN');let uploadId:string;try{uploadId=text(result.UploadId);}catch{fail('STORAGE_PROVIDER_UNCERTAIN');}
   return {scope:binding,versionId:input.versionId,uploadId,bytes,partBytes};
  },
  async uploadPart(input){
   const handle=upload(input.upload),partNumber=integer(input.partNumber,1,Math.ceil(handle.bytes/partBytes)),bytes=Math.min(partBytes,handle.bytes-(partNumber-1)*partBytes);
   if(!(input.body instanceof Uint8Array)&&!(input.body instanceof ReadableStream)&&!(input.body instanceof Readable)||input.body instanceof Uint8Array&&input.body.byteLength!==bytes)fail('STORAGE_INPUT_INVALID');
   const context=begin(input.signal);let stream:Readable|undefined;
   try{
    const source=input.body instanceof Readable?Readable.toWeb(input.body) as ReadableStream<Uint8Array>:input.body;
    const body=source instanceof Uint8Array?source:(stream=Readable.fromWeb(boundedStream(source,context.current.signal,bytes,bytes) as Parameters<typeof Readable.fromWeb>[0]));stream?.on('error',()=>{});
    const result=record(await untilAborted(context.current.signal,()=>client.send(new UploadPartCommand({Bucket:config.volumeId,Key:key(handle.versionId),UploadId:handle.uploadId,PartNumber:partNumber,ContentLength:bytes,Body:body}),{abortSignal:context.current.signal})));
    if(status(result)!==200||stream&&!stream.readableEnded)fail('STORAGE_PROVIDER_UNCERTAIN');return {partNumber,etag:etag(result.ETag),bytes};
   }catch(e){context.current.abort();throw error(e,true);}finally{stream?.destroy();context.finish();}
  },
  async completeMultipart(input){
   const handle=upload(input.upload),count=Math.ceil(handle.bytes/partBytes);if(!Array.isArray(input.parts)||input.parts.length!==count)fail('STORAGE_INPUT_INVALID');
   const parts=input.parts.map((p,index)=>{if(p.partNumber!==index+1||p.bytes!==Math.min(partBytes,handle.bytes-index*partBytes))fail('STORAGE_INPUT_INVALID');return {PartNumber:p.partNumber,ETag:text(p.etag,256,'STORAGE_INPUT_INVALID')};});
   const result=record(await send(new CompleteMultipartUploadCommand({Bucket:config.volumeId,Key:key(handle.versionId),UploadId:handle.uploadId,MultipartUpload:{Parts:parts}}),true,input.signal));
   if(status(result)!==200||result.Bucket!==config.volumeId||result.Key!==key(handle.versionId))fail('STORAGE_PROVIDER_UNCERTAIN');try{return {versionId:handle.versionId,etag:etag(result.ETag)};}catch{fail('STORAGE_PROVIDER_UNCERTAIN');}
  },
  async abortMultipart(input){const handle=upload(input.upload);const result=record(await send(new AbortMultipartUploadCommand({Bucket:config.volumeId,Key:key(handle.versionId),UploadId:handle.uploadId}),true,input.signal));if(status(result)!==204)fail('STORAGE_PROVIDER_UNCERTAIN');},
  async get(input){
   const path=key(input.versionId),maxBytes=integer(input.maxBytes,1,maxObjectBytes);let requested:{start:number;end:number}|null=null;
   const ifMatch=input.ifMatch===undefined?undefined:text(input.ifMatch,256,'STORAGE_INPUT_INVALID');if(ifMatch==='*'||ifMatch?.startsWith('W/')||ifMatch?.includes(','))fail('STORAGE_INPUT_INVALID');
   if(input.range){const start=integer(input.range.start,0,maxObjectBytes-1),end=integer(input.range.end,start,maxObjectBytes-1);if(end-start+1>maxBytes)fail('STORAGE_INPUT_INVALID');requested={start,end};}
   const context=begin(input.signal);let body:ReadableStream<Uint8Array>|undefined;
   try{
    const result=await untilAborted(context.current.signal,()=>client.send(new GetObjectCommand({Bucket:config.volumeId,Key:path,...requested?{Range:`bytes=${requested.start}-${requested.end}`}:{},...ifMatch?{IfMatch:ifMatch}:{}}),{abortSignal:context.current.signal}));
    if(!result.Body)fail('STORAGE_PROVIDER_PROTOCOL');body=result.Body.transformToWebStream();
    const bytes=integer(result.ContentLength,0,maxObjectBytes,'STORAGE_PROVIDER_PROTOCOL');if(bytes>maxBytes)fail('STORAGE_RESPONSE_TOO_LARGE');let totalBytes=bytes;
    if(requested){const parsed=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.ContentRange??'');if(result.$metadata.httpStatusCode!==206||!parsed||Number(parsed[1])!==requested.start||Number(parsed[2])!==requested.end||bytes!==requested.end-requested.start+1)fail('STORAGE_RANGE_UNSUPPORTED');totalBytes=integer(Number(parsed[3]),requested.end+1,maxObjectBytes,'STORAGE_PROVIDER_PROTOCOL');}
    else if(result.$metadata.httpStatusCode!==200||result.ContentRange)fail('STORAGE_PROVIDER_PROTOCOL');
    const observedEtag=etag(result.ETag);if(ifMatch!==undefined&&observedEtag!==ifMatch)fail('STORAGE_OBJECT_CHANGED');
    const out={stream:boundedStream(body,context.current.signal,maxBytes,bytes,context.finish),bytes,totalBytes,etag:observedEtag,contentType:result.ContentType??null,contentRange:result.ContentRange??null,range:requested};return out;
   }catch(e){cancel(body);context.current.abort();context.finish();if(e&&typeof e==='object'&&'$metadata'in e&&(e as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===412)fail('STORAGE_OBJECT_CHANGED');throw error(e,false);}
  },
  close(){closed=true;for(const current of active){current.abort();current.dispose();}active.clear();client.destroy();}
 };
}
