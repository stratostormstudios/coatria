/** Trusted Node service, deployed separately from Vercel. Never import in a browser. */
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {transaction} from './db';
import {ApiError,fail,hashToken,id,json} from './security';
import {authorizeProjectStorageActor,openProjectStorageCredentials} from './project-storage';
import type {ProjectStorageActor} from './project-storage-protocol';
import {authorizeStorageGrantAgent} from './project-storage-authority';
import {authorityReader} from './project-storage-stream';
import {STORAGE_MAX_FILE_BYTES} from './project-storage-config';
import {createRunpodProjectStorage,RunpodStorageError,type RunpodProjectStorage,type RunpodProjectStorageConfig} from './project-storage-runpod';

type Row=Record<string,any>;
type Context={grant:Row;actor:ProjectStorageActor;version:Row;connection:Awaited<ReturnType<typeof openProjectStorageCredentials>>};
type ProviderFactory=(config:RunpodProjectStorageConfig)=>RunpodProjectStorage;
function token(request:Request){const value=request.headers.get('authorization');if(!value||!/^Bearer stg_[A-Za-z0-9_-]{43}$/.test(value))fail(401,'A current storage transfer token is required.','STORAGE_TOKEN_REQUIRED');return value.slice(7);}
async function authorize(client:PoolClient,value:string,operation:'read'|'upload',resourceId:string):Promise<Context>{
 const grant=(await client.query('SELECT * FROM project_storage_access_receipts WHERE token_hash=$1 AND expires_at>clock_timestamp()',[hashToken(value)])).rows[0];
 if(!grant||grant.operation!==operation||(operation==='upload'?grant.upload_id:grant.version_id)!==resourceId)fail(403,'This transfer token is expired or belongs to another file.','STORAGE_ACCESS_DENIED');
 await authorizeStorageGrantAgent(client,grant);
 const actor={companyId:grant.company_id,userId:grant.user_id,...grant.agent_id?{agentId:grant.agent_id,runId:grant.run_id}:{}};
 await authorizeProjectStorageActor(client,actor,operation==='read'?'storage.read':'storage.write');
 const connection=await openProjectStorageCredentials(client,grant.company_id,grant.connection_id);
 if(connection.connection.revision!==grant.connection_revision)fail(403,'The storage connection changed. Request fresh file access.','STORAGE_ACCESS_DENIED');
 const version=(await client.query('SELECT v.*,f.name,b.connection_id FROM project_storage_versions v JOIN project_storage_files f ON f.company_id=v.company_id AND f.id=v.file_id JOIN project_storage_bindings b ON b.company_id=f.company_id AND b.id=f.binding_id WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3',[grant.company_id,grant.project_id,grant.version_id])).rows[0];
 if(!version||version.connection_id!==grant.connection_id)fail(403,'The file storage binding changed.');
 return {grant,actor,version,connection};
}
function provider(context:Context,factory:ProviderFactory){return factory({companyId:context.actor.companyId,projectId:context.version.project_id,region:context.connection.connection.region,volumeId:context.connection.connection.volumeId,credentials:{accessKeyId:context.connection.accessKeyId,secretAccessKey:context.connection.secretAccessKey},partBytes:context.version.part_bytes??64*1024**2,maxObjectBytes:STORAGE_MAX_FILE_BYTES,timeoutMs:2*60*60*1000});}
async function uploadRow(client:PoolClient,context:Context,uploadId:string,lock=false){
 const row=(await client.query(`SELECT * FROM project_storage_uploads WHERE company_id=$1 AND project_id=$2 AND id=$3 AND version_id=$4${lock?' FOR UPDATE':''}`,[context.actor.companyId,context.version.project_id,uploadId,context.version.id])).rows[0];
 if(!row||row.actor_user_id!==context.actor.userId||row.actor_agent_id!==(context.actor.agentId??null)||row.run_id!==(context.actor.runId??null))fail(403,'This upload belongs to another request.');
 if(+new Date(row.expires_at)<=Date.now())fail(409,'This upload session expired.','STORAGE_UPLOAD_EXPIRED');return row;
}
async function status(client:PoolClient,context:Context,uploadId:string){
 const row=await uploadRow(client,context,uploadId),parts=(await client.query('SELECT part_number AS "partNumber",bytes::float8 AS bytes,sha256 FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 ORDER BY part_number',[context.actor.companyId,uploadId])).rows;
 const verified=(await client.query('SELECT sha256,bytes::float8 AS bytes FROM project_storage_verifications WHERE company_id=$1 AND version_id=$2',[context.actor.companyId,context.version.id])).rows[0];
 const staleAction=row.action_id&&+new Date(row.action_expires_at)<Date.now();
 return {upload:{id:row.id,versionId:row.version_id,status:staleAction&&row.status!=='verifying'?'uncertain':row.status,totalBytes:Number(context.version.bytes),partBytes:row.part_bytes,uploadedBytes:parts.reduce((n,p)=>n+Number(p.bytes),0),parts,expiresAt:new Date(row.expires_at).toISOString()},...(verified?{verified}:{})};
}
async function emptyBody(request:Request){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')fail(415,'Send application/json.');
 const reader=request.body?.getReader();let text='';if(reader)try{while(true){const part=await reader.read();if(part.done)break;if(text.length+part.value.byteLength>32)fail(413,'Unexpected transfer arguments.');text+=Buffer.from(part.value).toString('utf8');}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(text.trim()!=='{}')fail(400,'Send an empty JSON object.');
}
async function markUncertain(companyId:string,uploadId:string,actionId:string){await transaction(client=>client.query("UPDATE project_storage_uploads SET status='uncertain',active_part=NULL,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND action_id=$3",[companyId,uploadId,actionId]));}
function checkedStream(source:ReadableStream<Uint8Array>,expected:number){
 const reader=source.getReader(),hash=createHash('sha256');let bytes=0,complete=false;
 const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const part=await reader.read();if(part.done){if(bytes!==expected)fail(400,'The uploaded part length does not match.');complete=true;controller.close();reader.releaseLock();return;}bytes+=part.value.byteLength;if(bytes>expected)fail(413,'The uploaded part exceeds its exact length.');hash.update(part.value);controller.enqueue(part.value);}catch(error){controller.error(error);await reader.cancel().catch(()=>{});}},async cancel(){await reader.cancel().catch(()=>{});}}, {highWaterMark:0});
 return {stream,result(){if(!complete)fail(502,'The provider did not consume the complete part.');return {bytes,sha256:hash.digest('hex')};}};
}
export function createProjectStorageGateway(options:{providerFactory?:ProviderFactory;allowedOrigins?:string[]}={}){
 const factory=options.providerFactory??createRunpodProjectStorage;
 const origins=new Set(options.allowedOrigins??[process.env.APP_URL||'https://coatria.com']);
 async function inspect(value:string,uploadId:string){return transaction(async client=>{const context=await authorize(client,value,'upload',uploadId);return status(client,context,uploadId);});}
 async function start(request:Request,value:string,uploadId:string){
  await emptyBody(request);
  const actionId=randomUUID(),prepared=await transaction(async client=>{
   const context=await authorize(client,value,'upload',uploadId),row=await uploadRow(client,context,uploadId,true);
   if(row.status!=='allocated')return {replayed:true,context,row};
   await client.query("UPDATE project_storage_uploads SET status='initiating',action_id=$3,action_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[context.actor.companyId,uploadId,actionId]);return {replayed:false,context,row};
  });
  if(prepared.replayed)return json(await inspect(value,uploadId));
  const adapter=provider(prepared.context,factory);
  try{
   const descriptor=await adapter.createMultipart({versionId:prepared.context.version.id,bytes:Number(prepared.context.version.bytes),contentType:prepared.context.version.content_type,signal:AbortSignal.timeout(120000)});
   await transaction(async client=>{const current=await authorize(client,value,'upload',uploadId);await uploadRow(client,current,uploadId,true);const saved=await client.query("UPDATE project_storage_uploads SET status='uploading',provider_upload_id=$4,provider_descriptor=$5,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND action_id=$3 AND status='initiating'",[current.actor.companyId,uploadId,actionId,descriptor.uploadId,JSON.stringify(descriptor)]);if(!saved.rowCount)fail(409,'This upload action changed.');});
   return json(await inspect(value,uploadId));
  }catch(error){await markUncertain(prepared.context.actor.companyId,uploadId,actionId);throw error;}finally{adapter.close();}
 }
 async function part(request:Request,value:string,uploadId:string,number:number){
  if(!Number.isInteger(number)||number<1||number>10000||!request.body)fail(400,'Choose a valid upload part.');
  const actionId=randomUUID(),prepared=await transaction(async client=>{
   const context=await authorize(client,value,'upload',uploadId),row=await uploadRow(client,context,uploadId,true),bytes=Math.min(row.part_bytes,Number(context.version.bytes)-(number-1)*row.part_bytes);
   if(bytes<=0)fail(400,'This part is outside the file.');
   const previous=(await client.query('SELECT bytes::float8 AS bytes,sha256 FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 AND part_number=$3',[context.actor.companyId,uploadId,number])).rows[0];
   if(previous)return {previous,context,row,bytes};
   if(row.status!=='uploading'||row.action_id)fail(409,'An upload action is active or uncertain. Check its status before continuing.','STORAGE_ACTION_BUSY');
   if(Number(request.headers.get('content-length'))!==bytes)fail(400,'Send exactly this part’s declared Content-Length.');
   await client.query("UPDATE project_storage_uploads SET active_part=$4,action_id=$3,action_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[context.actor.companyId,uploadId,actionId,number]);return {previous:null,context,row,bytes};
  });
  if(prepared.previous){const replay=checkedStream(request.body,prepared.bytes),reader=replay.stream.getReader();try{while(!(await reader.read()).done){}const digest=replay.result();if(digest.sha256!==prepared.previous.sha256)fail(409,'This completed part contains different bytes. Start a new file version.','IDEMPOTENCY_CONFLICT');return json({partNumber:number,...prepared.previous,replayed:true});}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
  const adapter=provider(prepared.context,factory),checked=checkedStream(request.body,prepared.bytes);
  try{
   const receipt=await adapter.uploadPart({upload:adapter.validateMultipart(prepared.row.provider_descriptor),partNumber:number,body:checked.stream,signal:AbortSignal.any([request.signal,AbortSignal.timeout(240000)])}),digest=checked.result();
   if(receipt.bytes!==digest.bytes)fail(502,'The provider returned a different part size.');
   await transaction(async client=>{const current=await authorize(client,value,'upload',uploadId),row=await uploadRow(client,current,uploadId,true);if(row.action_id!==actionId||row.status!=='uploading')fail(409,'The upload action changed.');await client.query('INSERT INTO project_storage_upload_parts(company_id,upload_id,part_number,bytes,sha256,provider_etag) VALUES($1,$2,$3,$4,$5,$6)',[current.actor.companyId,uploadId,number,digest.bytes,digest.sha256,receipt.etag]);await client.query('UPDATE project_storage_uploads SET active_part=NULL,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[current.actor.companyId,uploadId]);});
   return json({partNumber:number,...digest,replayed:false});
  }catch(error){await markUncertain(prepared.context.actor.companyId,uploadId,actionId);throw error;}finally{await checked.stream.cancel().catch(()=>{});adapter.close();}
 }
 async function complete(request:Request,value:string,uploadId:string){
  await emptyBody(request);const actionId=randomUUID();
  const prepared=await transaction(async client=>{
   const context=await authorize(client,value,'upload',uploadId),row=await uploadRow(client,context,uploadId,true);
   if(['verifying','ready'].includes(row.status))return {context,row,replayed:true,parts:[]};
   if(row.status!=='uploading'||row.action_id)fail(409,'An upload action is active or uncertain.','STORAGE_ACTION_BUSY');
   const parts=(await client.query('SELECT part_number AS "partNumber",bytes::float8 AS bytes,provider_etag AS etag FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 ORDER BY part_number',[context.actor.companyId,uploadId])).rows;
   if(parts.length!==Math.ceil(Number(context.version.bytes)/row.part_bytes)||parts.some((p,i)=>p.partNumber!==i+1)||parts.reduce((n,p)=>n+Number(p.bytes),0)!==Number(context.version.bytes))fail(409,'Upload every part before completing the file.','STORAGE_PARTS_MISSING');
   await client.query("UPDATE project_storage_uploads SET status='completing',action_id=$3,action_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[context.actor.companyId,uploadId,actionId]);return {context,row,parts,replayed:false};
  });
  if(prepared.replayed)return json(await inspect(value,uploadId),prepared.row.status==='ready'?200:202);
  const adapter=provider(prepared.context,factory);
  try{
   const result=await adapter.completeMultipart({upload:adapter.validateMultipart(prepared.row.provider_descriptor),parts:prepared.parts as any,signal:AbortSignal.timeout(120000)});
   await transaction(async client=>{const current=await authorize(client,value,'upload',uploadId),row=await uploadRow(client,current,uploadId,true);if(row.action_id!==actionId||row.status!=='completing')fail(409,'This upload action changed.');await client.query("UPDATE project_storage_uploads SET status='verifying',provider_etag=$3,verification_grant_id=$4,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[current.actor.companyId,uploadId,result.etag,current.grant.id]);});
   return json(await inspect(value,uploadId),202);
  }catch(error){await markUncertain(prepared.context.actor.companyId,uploadId,actionId);throw error;}finally{adapter.close();}
 }
 async function cancel(request:Request,value:string,uploadId:string){
  await emptyBody(request);const actionId=randomUUID();
  const prepared=await transaction(async client=>{const context=await authorize(client,value,'upload',uploadId),row=await uploadRow(client,context,uploadId,true);if(['initiating','uncertain'].includes(row.status)&&!row.provider_descriptor)fail(409,'Storage did not confirm the initial upload handle. Reconcile the uncertain provider outcome before cancellation.','STORAGE_OUTCOME_UNCERTAIN');if(row.status==='ready')fail(409,'The file is already verified. Cancelling does not delete it.');if(row.action_id&&+new Date(row.action_expires_at)>Date.now())fail(409,'Wait for the active transfer action before cancelling.');if(row.status==='cancelled')return {context,row,replayed:true};await client.query("UPDATE project_storage_uploads SET status='cancelled',action_id=$3,action_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[context.actor.companyId,uploadId,actionId]);return {context,row,replayed:false};});
  if(!prepared.replayed&&prepared.row.provider_descriptor&&!['verifying','failed'].includes(prepared.row.status)){
   const adapter=provider(prepared.context,factory);try{await adapter.abortMultipart({upload:adapter.validateMultipart(prepared.row.provider_descriptor),signal:AbortSignal.timeout(120000)});}catch{await markUncertain(prepared.context.actor.companyId,uploadId,actionId);fail(502,'Cancellation could not be confirmed by storage. No automatic deletion was attempted.','STORAGE_OUTCOME_UNCERTAIN');}finally{adapter.close();}
  }
  await transaction(client=>client.query('UPDATE project_storage_uploads SET active_part=NULL,action_id=NULL,action_expires_at=NULL WHERE company_id=$1 AND id=$2 AND action_id=$3',[prepared.context.actor.companyId,uploadId,actionId]));return json(await inspect(value,uploadId));
 }
 async function download(request:Request,value:string,versionId:string){
  const saved=await transaction(async client=>{const context=await authorize(client,value,'read',versionId),verified=(await client.query('SELECT * FROM project_storage_verifications WHERE company_id=$1 AND version_id=$2',[context.actor.companyId,versionId])).rows[0];if(!verified||Number(verified.bytes)!==Number(context.version.bytes))fail(409,'File verification is missing.');return {context,verified};});
  const bytes=Number(saved.verified.bytes),range=request.headers.get('range');let interval:{start:number;end:number}|undefined;
  if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)fail(416,'Use one bounded byte range.');interval={start:Number(match[1]),end:match[2]?Number(match[2]):bytes-1};if(!Number.isSafeInteger(interval.start)||!Number.isSafeInteger(interval.end)||interval.start>interval.end||interval.end>=bytes)fail(416,'The byte range is outside this file.');}
  const adapter=provider(saved.context,factory);let object;try{object=await adapter.get({versionId,maxBytes:bytes,...interval?{range:interval}:{},ifMatch:saved.verified.provider_etag,signal:request.signal});}catch(error){adapter.close();throw error;}
  const reader=authorityReader(object.stream.getReader(),()=>transaction(client=>authorize(client,value,'read',versionId)));
  const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const chunk=await reader.read();if(chunk.done){controller.close();adapter.close();await reader.close();}else controller.enqueue(chunk.value);}catch(error){controller.error(error);await reader.close();adapter.close();}},async cancel(){await reader.close();adapter.close();}}, {highWaterMark:0});
  return new Response(stream,{status:interval?206:200,headers:{'Content-Type':'application/octet-stream','Content-Length':String(object.bytes),'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(saved.context.version.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer','X-Content-SHA256':saved.verified.sha256,...interval?{'Content-Range':`bytes ${interval.start}-${interval.end}/${bytes}`}:{}}});
 }
 /** Restart-safe verification queue: only read/hash is retried, never paid or mutating provider work. */
 async function verifyNext(){
  const actionId=randomUUID(),saved=await transaction(async client=>{
   const upload=(await client.query("SELECT * FROM project_storage_uploads WHERE archive_id IS NULL AND status='verifying' AND expires_at>clock_timestamp() AND (action_id IS NULL OR action_expires_at<clock_timestamp()) ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!upload)return null;
   await client.query("UPDATE project_storage_uploads SET action_id=$3,action_expires_at=clock_timestamp()+interval '2 hours',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[upload.company_id,upload.id,actionId]);return upload;
  });if(!saved)return false;
  let adapter:RunpodProjectStorage|undefined;
  try{
   const context=await transaction(async client=>{
    const grant=(await client.query('SELECT * FROM project_storage_access_receipts WHERE company_id=$1 AND id=$2 AND upload_id=$3 AND version_id=$4',[saved.company_id,saved.verification_grant_id,saved.id,saved.version_id])).rows[0];if(!grant)fail(403,'The stored verification authority is missing.');await authorizeStorageGrantAgent(client,grant);
    const actor={companyId:saved.company_id,userId:saved.actor_user_id,...saved.actor_agent_id?{agentId:saved.actor_agent_id,runId:saved.run_id}:{}};
    await authorizeProjectStorageActor(client,actor,'storage.write');const row=(await client.query('SELECT v.*,b.connection_id FROM project_storage_versions v JOIN project_storage_files f ON f.company_id=v.company_id AND f.id=v.file_id JOIN project_storage_bindings b ON b.company_id=f.company_id AND b.id=f.binding_id WHERE v.company_id=$1 AND v.id=$2',[saved.company_id,saved.version_id])).rows[0];if(!row)fail(404,'Upload version missing.');return {actor,version:row,connection:await openProjectStorageCredentials(client,saved.company_id,row.connection_id),grant} as Context;
   });
   adapter=provider(context,factory);const object=await adapter.get({versionId:saved.version_id,maxBytes:Number(context.version.bytes),ifMatch:saved.provider_etag,signal:AbortSignal.timeout(2*60*60*1000)}),hash=createHash('sha256');let bytes=0;const reader=authorityReader(object.stream.getReader(),()=>transaction(async client=>{await authorizeStorageGrantAgent(client,context.grant);await authorizeProjectStorageActor(client,context.actor,'storage.write');const connection=await openProjectStorageCredentials(client,context.actor.companyId,context.connection.connection.id);const active=(await client.query("SELECT 1 FROM project_storage_uploads WHERE company_id=$1 AND id=$2 AND status='verifying' AND action_id=$3",[saved.company_id,saved.id,actionId])).rowCount;if(!active||connection.connection.revision!==context.connection.connection.revision)fail(403,'Verification authority ended.');}));
   try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>Number(context.version.bytes))fail(409,'Stored file exceeds the reserved size.');hash.update(chunk.value);}}finally{await reader.close();}
   const sha256=hash.digest('hex');if(bytes!==Number(context.version.bytes)||context.version.sha256&&context.version.sha256!==sha256)fail(409,'Stored bytes do not match the reserved file.','STORAGE_VERIFICATION_FAILED');
   await transaction(async client=>{
    await authorizeStorageGrantAgent(client,context.grant);await authorizeProjectStorageActor(client,context.actor,'storage.write');const connection=await openProjectStorageCredentials(client,context.actor.companyId,context.connection.connection.id);if(connection.connection.revision!==context.connection.connection.revision)fail(409,'Storage connection changed during verification.');
    const row=(await client.query('SELECT status,action_id FROM project_storage_uploads WHERE company_id=$1 AND id=$2 FOR UPDATE',[saved.company_id,saved.id])).rows[0];if(row?.status!=='verifying'||row.action_id!==actionId)fail(409,'Verification was cancelled or superseded.');
    await client.query('INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[saved.company_id,saved.project_id,saved.version_id,bytes,sha256,object.etag,randomUUID()]);
    await client.query("UPDATE project_storage_uploads SET status='ready',action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[saved.company_id,saved.id]);
   });
  }catch{
   await transaction(client=>client.query("UPDATE project_storage_uploads SET status='failed',action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND action_id=$3 AND status='verifying'",[saved.company_id,saved.id,actionId]));
  }finally{adapter?.close();}return true;
 }
 async function handle(request:Request):Promise<Response>{
  const origin=request.headers.get('origin');let response:Response;
  try{
   if(origin&&!origins.has(origin))fail(403,'This browser origin is not allowed.');
   const url=new URL(request.url);if(url.search)fail(400,'Transfer credentials belong in Authorization headers.');
   if(request.method==='OPTIONS'){if(!origin)fail(403,'A browser origin is required.');return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, Range','Access-Control-Max-Age':'300','Vary':'Origin'}});}
   if(url.pathname==='/health'&&request.method==='GET'){const ready=await transaction(async client=>(await client.query("SELECT 1 FROM schema_migrations WHERE name='027_project_storage.sql'")).rowCount);return json({service:'coatria-storage-gateway',status:ready?'ready':'schema_required',schemaVersion:1},ready?200:503);}
   const parts=url.pathname.split('/').filter(Boolean);if(parts[0]!=='v1'||!['uploads','files'].includes(parts[1])||parts.length<3)fail(404,'Transfer endpoint not found.');
   const resourceId=id(parts[2]),value=token(request);
   if(parts[1]==='files'&&parts.length===3&&request.method==='GET')response=await download(request,value,resourceId);
   else if(parts[1]==='uploads'&&parts.length===3&&request.method==='GET')response=json(await inspect(value,resourceId));
   else if(parts[1]==='uploads'&&parts.length===4&&request.method==='POST'&&parts[3]==='start')response=await start(request,value,resourceId);
   else if(parts[1]==='uploads'&&parts.length===4&&request.method==='POST'&&parts[3]==='complete')response=await complete(request,value,resourceId);
   else if(parts[1]==='uploads'&&parts.length===4&&request.method==='POST'&&parts[3]==='cancel')response=await cancel(request,value,resourceId);
   else if(parts[1]==='uploads'&&parts.length===5&&request.method==='PUT'&&parts[3]==='parts'&&/^[1-9]\d{0,4}$/.test(parts[4]))response=await part(request,value,resourceId,Number(parts[4]));
   else fail(404,'Transfer endpoint not found.');
  }catch(error){response=error instanceof ApiError?json({error:error.message,code:error.code},error.status):error instanceof RunpodStorageError?json({error:error.message,code:error.code},502):json({error:'The transfer outcome could not be confirmed. Check upload status before retrying.',code:'STORAGE_OUTCOME_UNCERTAIN'},502);}
  if(origin&&origins.has(origin)){response.headers.set('Access-Control-Allow-Origin',origin);response.headers.set('Vary','Origin');response.headers.set('Access-Control-Expose-Headers','Content-Length, Content-Range, X-Content-SHA256');}return response;
 }
 return {handle,verifyNext};
}
