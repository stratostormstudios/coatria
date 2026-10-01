/** Private binary boundary for enrolled processors. Only this trusted gateway
 * opens storage credentials and records provider evidence. It never advances
 * the preparation state machine or retries an uncertain external operation. */
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import {ApiError,fail,hashToken,json} from './security';
import {gatewayIdentitySchema,type GatewayIdentity} from './project-gateway-identity';
import {authorizeImagePreparationService,authorizeImagePreparationServiceLease,authorizeImagePreparationServiceProject,resolveProjectImagePreparationProcessor} from './project-image-preparation-service-authority';
import {authorizeProjectImagePreparation} from './project-image-preparations';
import {openProjectStorageCredentials} from './project-storage';
import {preparationByteOperationSchema,preparationByteToken,preparationServiceUuid,preparationStoreReceiptSchema,type PreparationByteOperation} from './project-image-preparation-service-protocol';
import {createImagePreparationByteProvider,type ImagePreparationByteProvider} from './project-image-preparation-provider';
import type {RunpodProjectStorageConfig,RunpodMultipartUpload} from './project-storage-runpod';

type Row=Record<string,any>;
type Transaction=<T>(run:(db:PoolClient)=>Promise<T>)=>Promise<T>;
type Options={transaction:Transaction;identity:GatewayIdentity;providerFactory?:(config:RunpodProjectStorageConfig)=>ImagePreparationByteProvider;maxTransfers?:number};
const runtime={runtime:resolveProjectImagePreparationProcessor},PART_BYTES=64*1024**2;
function denied():never{return fail(403,'This exact image transfer is no longer authorized.','IMAGE_PREPARATION_BYTE_AUTHORITY_ENDED');}
function uncertain():never{return fail(409,'This image transfer has an uncertain outcome. It cannot be repeated.','IMAGE_PREPARATION_BYTE_UNCERTAIN');}
function invalid():never{return fail(400,'The image transfer does not match its exact capability.','IMAGE_PREPARATION_BYTE_INVALID');}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const etag=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f,]/.test(value)&&value!=='*'&&!value.startsWith('W/');

export function createImagePreparationByteGateway(options:Options){
 const identity=gatewayIdentitySchema.parse(options.identity),transaction=options.transaction,factory=options.providerFactory??createImagePreparationByteProvider,maxTransfers=options.maxTransfers??2;
 if(!Number.isSafeInteger(maxTransfers)||maxTransfers<1||maxTransfers>8||new Set(identity.projectIds).size!==identity.projectIds.length)invalid();
 const active=new Set<AbortController>(),pending=new Set<Promise<unknown>>();let closed=false,poisoned=false;
 function track<T>(promise:Promise<T>):Promise<T>{pending.add(promise);void promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;}
 async function authorize(db:PoolClient,grantId:string,tokenHash:string,operation:PreparationByteOperation,signal:AbortSignal){
  const grant=(await db.query('SELECT * FROM project_image_preparation_byte_grants WHERE id=$1',[grantId])).rows[0];
  if(!grant||grant.token_hash!==tokenHash||grant.operation!==operation||grant.company_id!==identity.companyId||!identity.projectIds.includes(grant.project_id)||grant.gateway_provision_id!==identity.provisionId||grant.gateway_configuration_sha256!==identity.configurationHash||Date.parse(identity.expiresAt)<=Date.now())denied();
  // Wait for the shared M2 mutex before taking service/sponsor/project locks.
  // Only this side-effect-free probe repeats; external operations never do.
  const waitUntil=Math.min(Date.now()+2000,+new Date(grant.expires_at),Date.parse(identity.expiresAt));
  for(;;){
   if(signal.aborted||Date.now()>=waitUntil)fail(409,'Image preparation authority is busy or expired.','IMAGE_PREPARATION_BUSY');
   const acquired=(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['project-image-preparation:'+grant.company_id])).rows[0]?.acquired;
   if(acquired)break;await delay(Math.min(10,Math.max(1,waitUntil-Date.now())),undefined,{signal});
  }
  const service=await authorizeImagePreparationService(db,grant.service_id),lease=await authorizeImagePreparationServiceLease(db,service,{preparationId:grant.preparation_id,leaseId:grant.lease_id});
  const project=await authorizeImagePreparationServiceProject(db,service,grant.project_id,{preparationId:grant.preparation_id});
  const {r}=await authorizeProjectImagePreparation(db,lease,runtime);
  if(grant.request_hash!==lease.requestHash||grant.storage_binding_id!==r.storage_binding_id||grant.storage_connection_id!==r.storage_connection_id||grant.storage_connection_revision!==r.storage_connection_revision||grant.gateway_binding_id!==project.gateway.bindingId||grant.gateway_origin!==project.gateway.origin||grant.gateway_provision_id!==project.gateway.provisionId||grant.gateway_configuration_sha256!==project.gateway.configurationHash)denied();
  const live=(await db.query(`SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp() AS live`,[grant.expires_at,identity.expiresAt])).rows[0]?.live;if(!live)denied();
  let allocation:Row|undefined,parts:Row[]=[];
  if(operation==='read-source'){
   const source=r.source_snapshot;
   if(r.status!=='reading'||grant.action_id!==null||grant.upload_id!==null||grant.storage_binding_revision!==r.storage_binding_revision||grant.version_id!==source.versionId||Number(grant.bytes)!==source.bytes||grant.sha256!==source.sha256||grant.content_type!==source.contentType||grant.expected_etag!==source.providerEtag)denied();
  }else{
   allocation=(await db.query(`SELECT a.*,u.status AS upload_status,u.part_bytes,u.provider_descriptor,u.provider_etag,u.action_id,u.action_expires_at,u.active_part,u.expires_at AS upload_expires_at
    FROM project_image_preparation_allocations a JOIN project_storage_uploads u ON (u.company_id,u.project_id,u.id,u.version_id)=(a.company_id,a.project_id,a.upload_id,a.version_id)
    WHERE a.company_id=$1 AND a.project_id=$2 AND a.preparation_id=$3`,[grant.company_id,grant.project_id,grant.preparation_id])).rows[0];
   if(!allocation||grant.version_id!==allocation.version_id||grant.upload_id!==allocation.upload_id||grant.storage_binding_revision!==allocation.binding_revision_after||Number(grant.bytes)!==Number(allocation.output_bytes)||grant.sha256!==allocation.output_sha256||grant.content_type!=='image/png'||allocation.part_bytes!==PART_BYTES||+new Date(allocation.upload_expires_at)<=Date.now())denied();
   if(operation==='read-output'){
    if(r.status!=='verifying'||allocation.upload_status!=='verifying'||allocation.action_id||grant.action_id!==null||grant.expected_etag!==allocation.provider_etag)denied();
   }else{
    const expected=operation==='initiate'?'initiating':operation==='part'?'uploading':'completing';
    if(r.status!=='storing'||allocation.upload_status!==expected||grant.action_id!==allocation.action_id||grant.expected_etag!==null||+new Date(allocation.action_expires_at)<=Date.now())denied();
    if(!(await db.query("SELECT 1 FROM project_image_preparation_receipts WHERE company_id=$1 AND preparation_id=$2 AND action_id=$3 AND operation=$4 AND phase='intent'",[grant.company_id,grant.preparation_id,grant.action_id,'store_'+operation])).rowCount)denied();
    parts=(await db.query('SELECT part_number AS "partNumber",bytes::float8 AS bytes,sha256,provider_etag AS etag FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 ORDER BY part_number',[grant.company_id,grant.upload_id])).rows;
    if(operation==='initiate'?(allocation.provider_descriptor!==null||parts.length>0):!allocation.provider_descriptor||parts.length!==(operation==='complete'?1:0))denied();
    if(operation==='part'&&allocation.active_part!==1)denied();
    if(operation==='complete'&&(parts[0].partNumber!==1||parts[0].bytes!==Number(grant.bytes)||parts[0].sha256!==grant.sha256||!etag(parts[0].etag)))denied();
   }
  }
  if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[grant.expires_at])).rows[0]?.live)denied();
  return {grant,lease,allocation,parts};
 }
 async function run(request:Request){
  if(closed||poisoned||active.size>=maxTransfers)fail(503,'Image transfer capacity is unavailable.','IMAGE_PREPARATION_BYTE_UNAVAILABLE');
  const url=new URL(request.url),path=/^\/v1\/image-preparations\/capabilities\/([a-f0-9-]{36})\/([a-z-]+)$/.exec(url.pathname);
  if(!path||url.search||url.hash||request.headers.has('cookie')||request.headers.has('origin')||request.headers.has('range')||request.headers.has('content-encoding')||request.headers.has('content-range'))invalid();
  const parsedId=preparationServiceUuid.safeParse(path[1]),parsedOperation=preparationByteOperationSchema.safeParse(path[2]),parsedToken=preparationByteToken.safeParse(request.headers.get('authorization')?.replace(/^Bearer /,''));
  if(!parsedId.success||!parsedOperation.success||!parsedToken.success||!request.headers.get('authorization')?.startsWith('Bearer '))denied();
  const grantId=parsedId.data,operation=parsedOperation.data,tokenHash=hashToken(parsedToken.data),reading=operation==='read-source'||operation==='read-output';
  if(request.method!==(reading?'GET':operation==='part'?'PUT':'POST')||operation!=='part'&&(request.headers.has('content-type')||request.headers.get('content-length')!==null&&request.headers.get('content-length')!=='0'))invalid();
  const controller=new AbortController();active.add(controller);let operationDeadline=Math.min(Date.now()+30000,Date.parse(identity.expiresAt)),timer:ReturnType<typeof setTimeout>|undefined,authorityTimer:ReturnType<typeof setInterval>|undefined,authorityFlight:Promise<unknown>|undefined,authorityQueue:Promise<unknown>=Promise.resolve(),adapter:ImagePreparationByteProvider|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancelReader:Promise<void>|undefined,cleaned:Promise<void>|undefined;
  const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  const current=()=>{if(Date.now()>=operationDeadline)controller.abort();if(controller.signal.aborted||closed||poisoned)fail(409,'The image transfer was cancelled.','IMAGE_PREPARATION_BYTE_ABORTED');};
  const cancel=()=>cancelReader??=Promise.resolve().then(async()=>{if(reader){await reader.cancel();reader.releaseLock();}});
  const stop=()=>cleaned??=(async()=>{
   clearInterval(authorityTimer);
   let failed=false;try{await cancel();}catch{failed=true;}
   try{adapter?.close();await adapter?.drain();}catch{failed=true;}
   try{await authorityFlight;}catch{/* Authority loss already aborts the operation. */}
   if(failed){poisoned=true;for(const activeController of active)activeController.abort();fail(503,'Image transfer cleanup could not be confirmed.','IMAGE_PREPARATION_BYTE_CLEANUP_FAILED');}
  })();
  function reauthorize(){const next=authorityQueue.then(()=>{current();return transaction(async db=>{current();const value=await authorize(db,grantId,tokenHash,operation,controller.signal);current();return value;});});authorityQueue=next.catch(()=>{});return next;}
  async function consume(stream:ReadableStream<Uint8Array>,expected:number){
   reader=stream.getReader();cancelReader=undefined;const bytes=Buffer.alloc(expected);let size=0;
   const abortRead=()=>void cancel().catch(()=>{poisoned=true;});controller.signal.addEventListener('abort',abortRead,{once:true});
   try{for(;;){current();const chunk=await reader.read();current();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array)||size+chunk.value.byteLength>expected)invalid();bytes.set(chunk.value,size);size+=chunk.value.byteLength;}
    if(size!==expected)invalid();await cancel();reader=undefined;return bytes;
   }finally{controller.signal.removeEventListener('abort',abortRead);}
  }
  try{
   current();
   const prepared=await transaction(async db=>{
    current();const value=await authorize(db,grantId,tokenHash,operation,controller.signal),g=value.grant;
    if(operation==='part'&&(!request.body||request.headers.get('content-type')!=='image/png'||request.headers.get('content-length')!==String(g.bytes)))invalid();
    if((await db.query('SELECT 1 FROM project_image_preparation_byte_results WHERE grant_id=$1',[grantId])).rowCount)uncertain();
    const credentials=await openProjectStorageCredentials(db,g.company_id,g.storage_connection_id);
    if(credentials.connection.revision!==g.storage_connection_revision)denied();
    const config:RunpodProjectStorageConfig={companyId:g.company_id,projectId:g.project_id,region:credentials.connection.region,volumeId:credentials.connection.volumeId,credentials:{accessKeyId:credentials.accessKeyId,secretAccessKey:credentials.secretAccessKey},partBytes:PART_BYTES,maxObjectBytes:33554432,timeoutMs:30000};
    await db.query("INSERT INTO project_image_preparation_byte_results(grant_id,status) VALUES($1,'started') ON CONFLICT DO NOTHING",[grantId]).then(result=>{if(!result.rowCount)uncertain();});
    await authorize(db,grantId,tokenHash,operation,controller.signal);current();return {...value,config};
   });
   const g=prepared.grant;operationDeadline=Math.min(+new Date(g.expires_at),operationDeadline);timer=setTimeout(abort,Math.max(1,operationDeadline-Date.now()));
   authorityTimer=setInterval(()=>{if(authorityFlight)return;authorityFlight=reauthorize().catch(()=>{abort();}).finally(()=>{authorityFlight=undefined;});},500);
   if(operation!=='part'&&request.body)await consume(request.body,0);
   current();adapter=factory({...prepared.config,timeoutMs:Math.max(1,operationDeadline-Date.now())});if(!adapter||typeof adapter.drain!=='function')fail(503,'Image transfer provider cleanup is unavailable.','IMAGE_PREPARATION_BYTE_UNAVAILABLE');
   let raw:Buffer|undefined,publicResult:Row,providerResult:Row|null=null,observedBytes:number|null=null,observedSha:string|null=null,observedEtag:string|null=null;
   const output=prepared.allocation?{fileId:prepared.allocation.file_id,versionId:g.version_id,uploadId:g.upload_id,bytes:Number(g.bytes),sha256:g.sha256,partBytes:PART_BYTES}:undefined;
   const multipart=(value:unknown):RunpodMultipartUpload=>{const upload=adapter!.validateMultipart(value);if(upload.versionId!==g.version_id||upload.bytes!==Number(g.bytes)||upload.partBytes!==PART_BYTES)denied();return upload;};
   if(reading){
    await reauthorize();current();const object=await adapter.get({versionId:g.version_id,ifMatch:g.expected_etag,maxBytes:Number(g.bytes),signal:controller.signal});
    if(object.bytes!==Number(g.bytes)||object.totalBytes!==Number(g.bytes)||object.etag!==g.expected_etag||object.contentType!==g.content_type||object.range!==null||object.contentRange!==null){reader=object.stream.getReader();invalid();}
    raw=await consume(object.stream,Number(g.bytes));if(digest(raw)!==g.sha256)fail(409,'Stored image bytes changed.','IMAGE_PREPARATION_BYTES_CHANGED');
    observedBytes=raw.length;observedSha=g.sha256;observedEtag=object.etag;
    publicResult={operation,versionId:g.version_id,bytes:raw.length,sha256:g.sha256,etag:object.etag};
   }else if(operation==='initiate'){
    await reauthorize();current();const descriptor=multipart(await adapter.createMultipart({versionId:g.version_id,bytes:Number(g.bytes),contentType:'image/png',signal:controller.signal}));
    publicResult={operation,actionId:g.action_id,output};providerResult={operation,descriptor};
   }else if(operation==='part'){
    const bytes=await consume(request.body!,Number(g.bytes));if(digest(bytes)!==g.sha256)invalid();
    await reauthorize();current();const part=await adapter.uploadPart({upload:multipart(prepared.allocation!.provider_descriptor),partNumber:1,body:bytes,signal:controller.signal});
    if(part.partNumber!==1||part.bytes!==bytes.length||!etag(part.etag))uncertain();
    observedBytes=bytes.length;observedSha=g.sha256;
    publicResult={operation,actionId:g.action_id,output,partNumber:1,bytes:bytes.length,sha256:g.sha256};providerResult={operation,part,sha256:g.sha256};
   }else{
    await reauthorize();current();const result=await adapter.completeMultipart({upload:multipart(prepared.allocation!.provider_descriptor),parts:prepared.parts.map(p=>({partNumber:p.partNumber,bytes:p.bytes,etag:p.etag})),signal:controller.signal});
    if(result.versionId!==g.version_id||!etag(result.etag))uncertain();observedEtag=result.etag;
    publicResult={operation,actionId:g.action_id,output,etag:result.etag};providerResult={operation,versionId:result.versionId,etag:result.etag};
   }
   if(!reading)publicResult=preparationStoreReceiptSchema.parse(publicResult);
   current();await stop();current();
   await transaction(async db=>{current();await authorize(db,grantId,tokenHash,operation,controller.signal);
    const saved=await db.query("UPDATE project_image_preparation_byte_results SET status='completed',public_result=$2,provider_result=$3,observed_bytes=$4,observed_sha256=$5,observed_etag=$6,finished_at=clock_timestamp() WHERE grant_id=$1 AND status='started'",[grantId,JSON.stringify(publicResult),providerResult===null?null:JSON.stringify(providerResult),observedBytes,observedSha,observedEtag]);
    if(!saved.rowCount)uncertain();current();
   });
   return reading?new Response(new Uint8Array(raw!),{headers:{'content-type':g.content_type,'content-length':String(g.bytes),etag:g.expected_etag,'x-coatria-preparation-sha256':g.sha256,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer'}}):json(publicResult);
  }finally{try{await stop();}finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);active.delete(controller);}}
 }
 return {
  handle(request:Request):Promise<Response>{return track(run(request).catch(error=>json({error:'The exact image transfer could not be completed.',code:error instanceof ApiError?error.code??'IMAGE_PREPARATION_BYTE_FAILED':'IMAGE_PREPARATION_BYTE_FAILED'},error instanceof ApiError?error.status:502)));},
  close(){closed=true;for(const controller of active)controller.abort();},
  async drain(){while(pending.size)await Promise.allSettled([...pending]);if(poisoned)fail(503,'Image transfer cleanup could not be confirmed.','IMAGE_PREPARATION_BYTE_CLEANUP_FAILED');},
 };
}
