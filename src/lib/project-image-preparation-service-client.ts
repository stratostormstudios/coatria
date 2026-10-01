/** Credential-free processor transport. Only finite preparation/byte tokens
 * leave this client, to their exact reviewed origins. No redirects or retries. */
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ProjectImagePreparationLease,ProjectImagePreparationProcessor} from './project-image-preparations-protocol';
import {projectImagePreparationProcessorSchema} from './project-image-preparations-protocol';
import type {ProjectImagePreparationPorts,ProjectImagePreparationOperationContext,ProjectImagePreparationStoreIntent,ProjectImagePreparationOutput,ProjectImagePreparationByteRead} from './project-image-preparation-worker-core';
import {PREPARATION_SERVICE_MAX_JSON_BYTES,PREPARATION_SERVICE_FAILURE_CODES,preparationServiceOrigin,preparationServiceToken,preparationServiceUuid,preparationServiceDate,preparationServiceRequests,preparationServiceResponses,preparationStoreReceiptSchema,preparationBytePath,type PreparationServiceOperation,type PreparationByteOperation,type PreparationByteCapability} from './project-image-preparation-service-protocol';

type Code='PREPARATION_SERVICE_CONFIGURATION_INVALID'|'PREPARATION_SERVICE_RESPONSE_INVALID'|'PREPARATION_SERVICE_UNAVAILABLE'|'PREPARATION_SERVICE_ABORTED'|'PREPARATION_SERVICE_CLEANUP_FAILED';
export class ImagePreparationServiceClientError extends Error {constructor(readonly code:Code){super(code);this.name='ImagePreparationServiceClientError';}}
function fail(code:Code):never{throw new ImagePreparationServiceClientError(code);}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const valid=<T>(schema:z.ZodType<T>,value:unknown,code:Code='PREPARATION_SERVICE_RESPONSE_INVALID'):T=>{const result=schema.safeParse(value);if(!result.success)fail(code);return result.data;};
export type ImagePreparationServiceClientOptions={origin:string;serviceId:string;companyId:string;projectIds:readonly string[];gateways:readonly {projectId:string;origin:string}[];token:string;expiresAt:string;processor:ProjectImagePreparationProcessor;requestTimeoutMs?:number};
export type ImagePreparationServiceClient=ProjectImagePreparationPorts&{readiness(signal?:AbortSignal):Promise<z.infer<typeof preparationServiceResponses.readiness>['readiness']>;close():void;drain():Promise<void>};

export function createImagePreparationServiceClient(options:ImagePreparationServiceClientOptions,transport:{fetch?:typeof fetch}={}):ImagePreparationServiceClient {
 const configuration:Code='PREPARATION_SERVICE_CONFIGURATION_INVALID',origin=valid(preparationServiceOrigin,options.origin,configuration),serviceId=valid(preparationServiceUuid,options.serviceId,configuration),companyId=valid(preparationServiceUuid,options.companyId,configuration),token=valid(preparationServiceToken,options.token,configuration),processor=structuredClone(valid(projectImagePreparationProcessorSchema,options.processor,configuration));
 const expires=Date.parse(valid(preparationServiceDate,options.expiresAt,configuration)),projects=new Set(options.projectIds),gateways=new Map<string,string>(),timeout=options.requestTimeoutMs??25000;
 if(processor.id!==serviceId||processor.transport!=='linux_binary_v1'||!projects.size||projects.size>32||projects.size!==options.projectIds.length||options.projectIds.some(id=>!preparationServiceUuid.safeParse(id).success)||!Array.isArray(options.gateways)||options.gateways.length!==projects.size||expires<=Date.now()||expires-Date.now()>3600000||Date.parse(processor.expiresAt)!==expires||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)fail(configuration);
 for(const gateway of options.gateways){if(!projects.has(gateway.projectId)||gateways.has(gateway.projectId))fail(configuration);gateways.set(gateway.projectId,valid(preparationServiceOrigin,gateway.origin,configuration));}
 const send=transport.fetch??fetch,pending=new Set<Promise<unknown>>(),scopes=new Set<{controller:AbortController;bytes:boolean}>(),attempted=new Set<string>();
 let closed=false,bytesClosed=false,cleanupFailed=false,claimed=false;
 function track<T>(promise:Promise<T>):Promise<T>{pending.add(promise);void promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;}
 function scope(signal:AbortSignal|undefined,deadline:number,bytes=false){
  if(closed||cleanupFailed||bytes&&bytesClosed||deadline<=Date.now())fail('PREPARATION_SERVICE_ABORTED');
  const controller=new AbortController(),entry={controller,bytes},abort=()=>controller.abort();scopes.add(entry);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
  const current=()=>{if(Date.now()>=deadline)controller.abort();if(controller.signal.aborted)fail('PREPARATION_SERVICE_ABORTED');};
  return {signal:controller.signal,current,close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);scopes.delete(entry);},bound<T>(promise:Promise<T>):Promise<T>{return new Promise((resolve,reject)=>{
   const stop=()=>{controller.signal.removeEventListener('abort',stop);reject(new ImagePreparationServiceClientError('PREPARATION_SERVICE_ABORTED'));};
   controller.signal.addEventListener('abort',stop,{once:true});
   promise.then(value=>{controller.signal.removeEventListener('abort',stop);try{current();resolve(value);}catch(error){reject(error);}},()=>{controller.signal.removeEventListener('abort',stop);reject(new ImagePreparationServiceClientError('PREPARATION_SERVICE_UNAVAILABLE'));});
   if(controller.signal.aborted)stop();
  });}};
 }
 function own(response:Response){
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancelled:Promise<void>|undefined;
  return {response,reader(){if(!response.body)fail('PREPARATION_SERVICE_RESPONSE_INVALID');return reader??=response.body.getReader();},cancel(){return cancelled??=track(Promise.resolve().then(async()=>{try{if(reader)await reader.cancel();else await response.body?.cancel();}finally{reader?.releaseLock();}}).catch(()=>{cleanupFailed=true;throw new ImagePreparationServiceClientError('PREPARATION_SERVICE_CLEANUP_FAILED');}));}};
 }
 async function start(url:string,init:RequestInit,call:ReturnType<typeof scope>){
  let owned:ReturnType<typeof own>|undefined,abandoned=false;
  try{
   call.current();const request=track(Promise.resolve().then(()=>{call.current();return send(url,{...init,signal:call.signal,redirect:'error',credentials:'omit',cache:'no-store'});}).then(response=>{owned=own(response);if(abandoned||call.signal.aborted)void owned.cancel().catch(()=>{});return owned;}));
   owned=await call.bound(request);call.current();const response=owned.response;
   if(response.status!==200||response.redirected||response.url&&response.url!==url||response.headers.has('content-range')||response.headers.has('content-encoding')&&response.headers.get('content-encoding')!=='identity')fail('PREPARATION_SERVICE_RESPONSE_INVALID');
   return owned;
  }catch(error){abandoned=true;call.close();void owned?.cancel().catch(()=>{});throw error instanceof ImagePreparationServiceClientError?error:new ImagePreparationServiceClientError('PREPARATION_SERVICE_UNAVAILABLE');}
 }
 async function readJson(owned:ReturnType<typeof own>,call:ReturnType<typeof scope>){
  const {response}=owned;if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')fail('PREPARATION_SERVICE_RESPONSE_INVALID');
  const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9]\d*)$/.test(length)||Number(length)>PREPARATION_SERVICE_MAX_JSON_BYTES))fail('PREPARATION_SERVICE_RESPONSE_INVALID');
  const reader=owned.reader(),chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const next=await call.bound(track(reader.read()));if(next.done)break;if(!(next.value instanceof Uint8Array)||(bytes+=next.value.byteLength)>PREPARATION_SERVICE_MAX_JSON_BYTES)fail('PREPARATION_SERVICE_RESPONSE_INVALID');chunks.push(next.value);}
  if(length!==null&&bytes!==Number(length))fail('PREPARATION_SERVICE_RESPONSE_INVALID');
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{return fail('PREPARATION_SERVICE_RESPONSE_INVALID');}
 }
 async function rpc<K extends PreparationServiceOperation>(operation:K,fields:Record<string,unknown>,signal?:AbortSignal){
  const deadline=Math.min(Date.now()+(operation==='fail'?5000:timeout),expires+(operation==='fail'?600000:0));
  const args=valid(preparationServiceRequests[operation],{requestId:randomUUID(),deadlineAt:new Date(deadline).toISOString(),...fields},configuration),body=JSON.stringify(args);
  if(Buffer.byteLength(body)>PREPARATION_SERVICE_MAX_JSON_BYTES)fail(configuration);
  const call=scope(signal,deadline),owned=await start(`${origin}/api/internal/image-preparation-services/${serviceId}/${operation}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json','accept-encoding':'identity'},body},call);
  try{const parsed=preparationServiceResponses[operation].safeParse(await readJson(owned,call));if(!parsed.success)fail('PREPARATION_SERVICE_RESPONSE_INVALID');await call.bound(owned.cancel());return parsed.data as z.infer<(typeof preparationServiceResponses)[K]>;}
  finally{call.close();void owned.cancel().catch(()=>{});}
 }
 function identity(lease:ProjectImagePreparationLease,cleanup=false){
  if(lease.companyId!==companyId||!projects.has(lease.projectId)||!preparationServiceUuid.safeParse(lease.preparationId).success||!preparationServiceUuid.safeParse(lease.leaseId).success||!same(lease.processor,processor)||lease.recipeSha256!==processor.recipeSha256||!preparationServiceDate.safeParse(lease.expiresAt).success||Date.parse(lease.expiresAt)>expires||!cleanup&&Date.parse(lease.expiresAt)<=Date.now())fail(configuration);
  return {preparationId:lease.preparationId,leaseId:lease.leaseId};
 }
 const current=(context:ProjectImagePreparationOperationContext)=>{context.assertCurrent();if(context.signal.aborted)fail('PREPARATION_SERVICE_ABORTED');};
 async function capability(lease:ProjectImagePreparationLease,operation:PreparationByteOperation,context:ProjectImagePreparationOperationContext,intent?:ProjectImagePreparationStoreIntent){
  current(context);if(bytesClosed)fail('PREPARATION_SERVICE_ABORTED');
  const key=lease.leaseId+':'+operation;if(attempted.has(key))fail('PREPARATION_SERVICE_CONFIGURATION_INVALID');attempted.add(key);
  const transfer=operation==='read-source'||operation==='read-output'?{operation}:{operation,actionId:intent?.actionId};
  const result=(await rpc('byte-capability',{...identity(lease),transfer},context.signal)).capability;
  current(context);
  if(result.origin!==gateways.get(lease.projectId)||result.operation!==operation||result.preparationId!==lease.preparationId||result.leaseId!==lease.leaseId||result.requestHash!==lease.requestHash||Date.parse(result.expiresAt)>Math.min(expires,Date.parse(lease.expiresAt))||Date.parse(result.expiresAt)<=Date.now()||result.actionId!==(intent?.actionId??null))fail('PREPARATION_SERVICE_RESPONSE_INVALID');
  return result;
 }
 function matches(cap:PreparationByteCapability,expected:{versionId:string;bytes:number;sha256:string;contentType?:string;etag?:string}){
  if(cap.versionId!==expected.versionId||cap.bytes!==expected.bytes||cap.sha256!==expected.sha256||expected.contentType&&cap.contentType!==expected.contentType||expected.etag&&cap.etag!==expected.etag)fail('PREPARATION_SERVICE_RESPONSE_INVALID');
 }
 async function read(cap:PreparationByteCapability,context:ProjectImagePreparationOperationContext):Promise<ProjectImagePreparationByteRead>{
  current(context);const call=scope(context.signal,Math.min(Date.now()+30000,Date.parse(cap.expiresAt)),true),url=cap.origin+preparationBytePath(cap),owned=await start(url,{method:'GET',headers:{authorization:'Bearer '+cap.token,accept:cap.contentType,'accept-encoding':'identity'}},call);
  try{
   const response=owned.response;
   if(!response.body||response.headers.get('content-length')!==String(cap.bytes)||response.headers.get('content-type')!==cap.contentType||response.headers.get('etag')!==cap.etag||response.headers.get('x-coatria-preparation-sha256')!==cap.sha256)fail('PREPARATION_SERVICE_RESPONSE_INVALID');
   const reader=owned.reader();let ended=false,seen=0,output:ReadableStreamDefaultController<Uint8Array>|undefined;
   const close=()=>{call.signal.removeEventListener('abort',abort);call.close();return owned.cancel();};
   const abort=()=>{if(!ended){ended=true;output?.error(new ImagePreparationServiceClientError('PREPARATION_SERVICE_ABORTED'));}void close().catch(()=>{});};
   const stream=new ReadableStream<Uint8Array>({start(controller){output=controller;},async pull(controller){try{
    call.current();const part=await call.bound(track(reader.read()));if(ended)return;
    if(part.done){if(seen!==cap.bytes)fail('PREPARATION_SERVICE_RESPONSE_INVALID');await close();if(!ended){ended=true;controller.close();}return;}
    if(!(part.value instanceof Uint8Array)||(seen+=part.value.byteLength)>cap.bytes)fail('PREPARATION_SERVICE_RESPONSE_INVALID');controller.enqueue(part.value);
   }catch{if(!ended){ended=true;controller.error(new ImagePreparationServiceClientError('PREPARATION_SERVICE_RESPONSE_INVALID'));}void close().catch(()=>{});}},cancel(){ended=true;return close();}},{highWaterMark:0});
   call.signal.addEventListener('abort',abort,{once:true});if(call.signal.aborted)abort();
   return {stream,bytes:cap.bytes,totalBytes:cap.bytes,etag:cap.etag!,contentType:cap.contentType,range:null,contentRange:null};
  }catch(error){call.close();void owned.cancel().catch(()=>{});throw error;}
 }
 async function write(lease:ProjectImagePreparationLease,intent:ProjectImagePreparationStoreIntent,context:ProjectImagePreparationOperationContext,bytes?:Buffer){
  if(intent.operation==='part'&&(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>10*1024**2||bytes.length!==intent.output.bytes)||intent.operation!=='part'&&bytes!==undefined)fail(configuration);
  // Retain the exact validated bytes across the capability RPC. The caller may
  // reuse or mutate its buffer while this asynchronous operation is in flight.
  const snapshot=bytes===undefined?undefined:new Uint8Array(bytes);
  if(snapshot&&createHash('sha256').update(snapshot).digest('hex')!==intent.output.sha256)fail(configuration);
  const cap=await capability(lease,intent.operation,context,intent);matches(cap,{...intent.output,contentType:'image/png'});current(context);
  const call=scope(context.signal,Math.min(Date.now()+30000,Date.parse(cap.expiresAt)),true),owned=await start(cap.origin+preparationBytePath(cap),{method:intent.operation==='part'?'PUT':'POST',headers:{authorization:'Bearer '+cap.token,accept:'application/json','accept-encoding':'identity',...snapshot?{'content-type':'image/png','content-length':String(snapshot.length)}:{}},...snapshot?{body:snapshot}:{}},call);
  try{const receipt=valid(preparationStoreReceiptSchema,await readJson(owned,call));if(receipt.operation!==intent.operation||receipt.actionId!==intent.actionId||!same(receipt.output,intent.output)||receipt.operation==='part'&&(receipt.bytes!==intent.output.bytes||receipt.sha256!==intent.output.sha256))fail('PREPARATION_SERVICE_RESPONSE_INVALID');await call.bound(owned.cancel());return receipt;}
  finally{call.close();void owned.cancel().catch(()=>{});}
 }
 const drain=async()=>{while(pending.size)await Promise.allSettled([...pending]);if(cleanupFailed)fail('PREPARATION_SERVICE_CLEANUP_FAILED');};
 return {
  async readiness(signal){const value=(await rpc('readiness',{},signal)).readiness;if(value.serviceId!==serviceId||value.companyId!==companyId||!same([...value.projectIds].sort(),[...projects].sort())||!same(value.processor,processor)||Date.parse(value.expiresAt)!==expires)fail('PREPARATION_SERVICE_RESPONSE_INVALID');return value;},
  close(){closed=true;bytesClosed=true;for(const entry of scopes)entry.controller.abort();},drain,
  control:{
   async claim(scope,context){current(context);if(claimed||scope.companyId!==companyId||!same([...scope.projectIds].sort(),[...projects].sort()))fail(configuration);claimed=true;const lease=(await rpc('claim',{},context.signal)).lease;if(lease)identity(lease);return lease;},
   async authorize(lease,context){current(context);await rpc('authorize',identity(lease),context.signal);},
   async source(lease,context){current(context);return (await rpc('source',identity(lease),context.signal)).source;},
   async beginTransform(lease,context){current(context);return rpc('begin-transform',identity(lease),context.signal);},
   async completeTransform(lease,actionId,result,context){current(context);await rpc('complete-transform',{...identity(lease),actionId,result},context.signal);},
   async reserveOutput(lease,context){current(context);return (await rpc('reserve-output',identity(lease),context.signal)).output;},
   async beginStore(lease,operation,context){current(context);return (await rpc('begin-store',{...identity(lease),operation},context.signal)).intent;},
   async completeStore(lease,receipt,context){current(context);await rpc('complete-store',{...identity(lease),receipt},context.signal);},
   async publish(lease,result,context){current(context);return rpc('publish',{...identity(lease),result},context.signal);},
   async fail(lease,code){const safe=PREPARATION_SERVICE_FAILURE_CODES.includes(code as typeof PREPARATION_SERVICE_FAILURE_CODES[number])?code:'IMAGE_PREPARATION_WORKER_FAILED';return rpc('fail',{...identity(lease,true),code:safe});}
  },
  bytes:{
   async readSource(lease,source,context){const cap=await capability(lease,'read-source',context);matches(cap,source);return read(cap,context);},
   async initiate(lease,intent,context){if(intent.operation!=='initiate')fail(configuration);const result=await write(lease,intent,context);if(result.operation!=='initiate')fail('PREPARATION_SERVICE_RESPONSE_INVALID');return result;},
   async uploadPart(lease,intent,bytes,context){if(intent.operation!=='part')fail(configuration);const result=await write(lease,intent,context,bytes);if(result.operation!=='part')fail('PREPARATION_SERVICE_RESPONSE_INVALID');return result;},
   async complete(lease,intent,context){if(intent.operation!=='complete')fail(configuration);const result=await write(lease,intent,context);if(result.operation!=='complete')fail('PREPARATION_SERVICE_RESPONSE_INVALID');return result;},
   async readOutput(lease,output:ProjectImagePreparationOutput,etag,context){const cap=await capability(lease,'read-output',context);matches(cap,{...output,contentType:'image/png',etag});return read(cap,context);},
   close(){bytesClosed=true;for(const entry of scopes)if(entry.bytes)entry.controller.abort();},drain
  }
 };
}
