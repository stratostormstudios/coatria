/** Trusted, separately deployed Node worker. No default host policy, scratch
 * root, provider provisioning, user session, transfer ticket or HTTP route. */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,realpath,rm,type FileHandle} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,resolve} from 'node:path';
import type {PoolClient} from 'pg';
import {transaction} from './db';
import {authorizeHiggsfieldArchive} from './higgsfield-archives';
import {openHiggsfieldSecret} from './higgsfield-secrets';
import {openProjectStorageCredentials} from './project-storage';
import {STORAGE_MAX_FILE_BYTES,STORAGE_PART_BYTES} from './project-storage-config';
import {createRunpodProjectStorage,runpodProjectObjectKey,type RunpodProjectStorage,type RunpodProjectStorageConfig} from './project-storage-runpod';
import type {HiggsfieldOutputRead} from './higgsfield-output-fetch';
import type {HiggsfieldArchiveMediaInput,HiggsfieldMediaDescriptor} from './higgsfield-media-inspection';

type Row=Record<string,any>;
type Code='HIGGSFIELD_ARCHIVE_POLICY_INVALID'|'HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED'|'HIGGSFIELD_ARCHIVE_SOURCE_CHANGED'|'HIGGSFIELD_ARCHIVE_MEDIA_REJECTED'|'HIGGSFIELD_ARCHIVE_FETCH_FAILED'|'HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN'|'HIGGSFIELD_ARCHIVE_STORED_BYTES_MISMATCH'|'HIGGSFIELD_ARCHIVE_WORKER_FAILED'|'HIGGSFIELD_ARCHIVE_BUDGET_EXHAUSTED'|'HIGGSFIELD_ARCHIVE_DEADLINE'|'HIGGSFIELD_ARCHIVE_ABORTED'|'HIGGSFIELD_ARCHIVE_TRANSFER_LIMIT';
class ArchiveError extends Error{constructor(readonly code:Code){super(code);this.name='HiggsfieldArchiveWorkerError';}}
const fail=(code:Code):never=>{throw new ArchiveError(code);};
const active=['queued','fetching','uploading','verifying'];
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const etag=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
export type ArchiveInspectionContext=Readonly<{companyId:string;projectId:string;archiveId:string;leaseId:string;locatorIdentity:string;requestHash:string;expectedBytes:number;expectedSha256:string;expectedKind:'image'|'video'|'audio'}>;
export type ArchiveWorkerScope=Readonly<{companyId:string;projectIds:readonly string[]}>;
type Options={
 fetchOutput:(input:HiggsfieldOutputRead)=>Promise<{bytes:number;sha256:string}>;
 inspectMedia:(input:HiggsfieldArchiveMediaInput,context:ArchiveInspectionContext)=>Promise<HiggsfieldMediaDescriptor>;
 /** Trusted host configuration, never supplied by an agent or API caller. */
 scope?:ArchiveWorkerScope;
 scratchRoot:string;
 providerFactory?:(config:RunpodProjectStorageConfig)=>RunpodProjectStorage;
 /** Trusted worker/test composition only; never accepted from a route/agent. */
 operationDeadlineMs?:number;authorityIntervalMs?:number;authorityTimeoutMs?:number;partBytes?:number;
};
type Result={processed:boolean;archiveId?:string;status?:string;code?:string};

async function receipt(db:PoolClient,row:Row,actionId:string,operation:string,phase:string,detail:Row={}){
 await db.query('INSERT INTO higgsfield_archive_receipts(company_id,project_id,archive_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,archive_id,action_id,phase) DO NOTHING',[row.company_id,row.project_id,row.id,actionId,operation,phase,JSON.stringify(detail)]);
}

/** At most one authority check at a time; the watchdog continues while DNS,
 * native media tools, provider requests or stream consumers are stalled. */
function authorityScope(check:()=>Promise<void>,input:{deadline:number;interval:number;checkTimeout:number;signal?:AbortSignal}){
 const controller=new AbortController();let pending:Promise<void>|undefined,finished=false,lastCheck=0;
 const stop=(code:Code)=>{if(!finished&&!controller.signal.aborted)controller.abort(new ArchiveError(code));};
 const current=()=>{if(controller.signal.aborted)throw controller.signal.reason;};
 function bound<T>(value:Promise<T>):Promise<T>{
  return new Promise<T>((yes,no)=>{const abort=()=>{controller.signal.removeEventListener('abort',abort);no(controller.signal.reason);};controller.signal.addEventListener('abort',abort,{once:true});value.then(result=>{controller.signal.removeEventListener('abort',abort);try{current();yes(result);}catch(error){no(error);}},error=>{controller.signal.removeEventListener('abort',abort);no(controller.signal.aborted?controller.signal.reason:error);});if(controller.signal.aborted)abort();});
 }
 async function authorize(force=false){
  current();if(finished)return;
  if(!pending&&(force||Date.now()-lastCheck>=input.interval)){const timer=setTimeout(()=>stop('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED'),input.checkTimeout);pending=bound(Promise.resolve().then(()=>{current();return check();})).then(()=>{lastCheck=Date.now();}).catch(()=>{stop('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');current();}).finally(()=>{clearTimeout(timer);pending=undefined;});}
  await pending;current();
 }
 const external=()=>stop('HIGGSFIELD_ARCHIVE_ABORTED');input.signal?.addEventListener('abort',external,{once:true});if(input.signal?.aborted)external();
 const deadline=setTimeout(()=>stop('HIGGSFIELD_ARCHIVE_DEADLINE'),input.deadline),watchdog=setInterval(()=>void authorize(true).catch(()=>{}),input.interval);
 return {signal:controller.signal,authorize,bound,current,async io<T>(run:()=>Promise<T>){await authorize(true);const result=await bound(Promise.resolve().then(()=>{current();return run();}));await authorize(true);return result;},close(){finished=true;clearTimeout(deadline);clearInterval(watchdog);input.signal?.removeEventListener('abort',external);}};
}

export function createHiggsfieldArchiveWorker(options:Options){
 if(!options||typeof options.fetchOutput!=='function'||typeof options.inspectMedia!=='function'||typeof options.scratchRoot!=='string'||!isAbsolute(options.scratchRoot)||options.scratchRoot.includes('\0')||/^[\\/]{2}/.test(options.scratchRoot)||process.platform==='win32'&&options.scratchRoot.slice(2).includes(':'))fail('HIGGSFIELD_ARCHIVE_POLICY_INVALID');
 const {fetchOutput,inspectMedia}=options,factory=options.providerFactory??createRunpodProjectStorage,scratchRoot=resolve(options.scratchRoot),deadline=options.operationDeadlineMs??2*60*60*1000,interval=options.authorityIntervalMs??1000,checkTimeout=options.authorityTimeoutMs??5000,partBytes=options.partBytes??STORAGE_PART_BYTES;
 if(!Number.isSafeInteger(deadline)||deadline<1||deadline>7200000||!Number.isSafeInteger(interval)||interval<1||interval>5000||!Number.isSafeInteger(checkTimeout)||checkTimeout<1||checkTimeout>5000)fail('HIGGSFIELD_ARCHIVE_POLICY_INVALID');
 if(!Number.isSafeInteger(partBytes)||partBytes<5*1024**2||partBytes>STORAGE_PART_BYTES)fail('HIGGSFIELD_ARCHIVE_POLICY_INVALID');
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 if(options.scope&&(!uuid.test(options.scope.companyId)||!Array.isArray(options.scope.projectIds)||!options.scope.projectIds.length||options.scope.projectIds.length>100||options.scope.projectIds.some(value=>!uuid.test(value))||new Set(options.scope.projectIds).size!==options.scope.projectIds.length))fail('HIGGSFIELD_ARCHIVE_POLICY_INVALID');
 const workerScope=options.scope?Object.freeze({companyId:options.scope.companyId,projectIds:Object.freeze([...options.scope.projectIds])}):undefined;
 const assertScope=(value:Row)=>{if(workerScope&&(value.company_id!==workerScope.companyId||!workerScope.projectIds.includes(value.project_id)))fail('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');};

 async function claim():Promise<{row:Row;lease:string}|Result>{
  return transaction(async db=>{
   const row=(await db.query("SELECT * FROM higgsfield_output_archives WHERE status IN ('queued','fetching','uploading','verifying') AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())"+(workerScope?' AND company_id=$1 AND project_id=ANY($2::uuid[])':'')+' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1',workerScope?[workerScope.companyId,workerScope.projectIds]:[])).rows[0];if(!row)return {processed:false};assertScope(row);
   const prior=row.upload_id?(await db.query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2 AND archive_id=$3 FOR UPDATE',[row.company_id,row.upload_id,row.id])).rows[0]:null;
   if(prior&&(prior.action_id||['initiating','completing','uncertain'].includes(prior.status))){
    await db.query("UPDATE project_storage_uploads SET status='uncertain',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,prior.id]);
    await db.query("UPDATE higgsfield_output_archives SET status='uncertain',diagnostic_code='HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN',lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,row.id]);
    await receipt(db,row,prior.action_id??randomUUID(),'claim','uncertain',{code:'HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN'});return {processed:true,archiveId:row.id,status:'uncertain',code:'HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN'};
   }
   let code:Code|undefined;if(row.attempt_count>=5)code='HIGGSFIELD_ARCHIVE_BUDGET_EXHAUSTED';else try{await authorizeHiggsfieldArchive(db,row.company_id,row.id);}catch{code='HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED';}
   if(code){await db.query("UPDATE higgsfield_output_archives SET status='blocked',diagnostic_code=$3,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,row.id,code]);await receipt(db,row,randomUUID(),'claim','blocked',{code});return {processed:true,archiveId:row.id,status:'blocked',code};}
   const lease=randomUUID();await db.query("UPDATE higgsfield_output_archives SET status=CASE WHEN status='queued' THEN 'fetching' ELSE status END,attempt_count=attempt_count+1,lease_id=$3,lease_expires_at=LEAST(expires_at,clock_timestamp()+interval '120 seconds'),diagnostic_code=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,row.id,lease]);return {row,lease};
  });
 }

 async function runNext(input:{signal?:AbortSignal}={}):Promise<Result>{
  const claimed=await claim();if('processed'in claimed)return claimed;
  const {row,lease}=claimed;let adapter:RunpodProjectStorage|undefined,scratch:string|undefined,root:string|undefined,file:FileHandle|undefined,storedStream:ReadableStream<Uint8Array>|undefined,phase='fetching',intent:{id:string;operation:string}|undefined;
  const fenced=async(db:PoolClient)=>{const current=await authorizeHiggsfieldArchive(db,row.company_id,row.id,{leaseId:lease});assertScope(current);return current;};
  const scope=authorityScope(()=>transaction(async db=>{await fenced(db);const renewed=await db.query("UPDATE higgsfield_output_archives SET lease_expires_at=LEAST(expires_at,clock_timestamp()+interval '120 seconds') WHERE company_id=$1 AND id=$2 AND lease_id=$3 AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL AND status IN ('queued','fetching','uploading','verifying')",[row.company_id,row.id,lease]);if(!renewed.rowCount)fail('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');}),{deadline,interval,checkTimeout,signal:input.signal});
  const atomic=<T>(run:(db:PoolClient,current:Row)=>Promise<T>,exclusiveBinding=false)=>scope.bound(transaction(async db=>{scope.current();const current=await authorizeHiggsfieldArchive(db,row.company_id,row.id,{leaseId:lease,exclusiveBinding});assertScope(current);const result=await run(db,current);scope.current();return result;}));
  async function uploadState(){return atomic(async(db,current)=>{const upload=(await db.query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND project_id=$2 AND id=$3 AND archive_id=$4 FOR UPDATE',[row.company_id,row.project_id,current.upload_id,row.id])).rows[0];if(!upload)fail('HIGGSFIELD_ARCHIVE_WORKER_FAILED');return upload;});}
  async function begin(operation:string,status:string,partNumber?:number){
   const actionId=randomUUID();const saved=await atomic(async(db,current)=>{const upload=(await db.query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2 AND archive_id=$3 FOR UPDATE',[row.company_id,current.upload_id,row.id])).rows[0];if(!upload||upload.action_id||upload.status!==(operation==='initiate'?'allocated':'uploading'))fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');await db.query('UPDATE project_storage_uploads SET status=$3,active_part=$4,action_id=$5,action_expires_at=LEAST(expires_at,clock_timestamp()+interval \'120 seconds\'),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[row.company_id,upload.id,status,partNumber??null,actionId]);await receipt(db,current,actionId,operation,'intent',{uploadId:upload.id,versionId:upload.version_id,...partNumber?{partNumber}:{}});return upload;});intent={id:actionId,operation};return saved;
  }
  async function returned<T>(run:(db:PoolClient,current:Row,upload:Row,actionId:string)=>Promise<T>){
   const action=intent!;const result=await atomic(async(db,current)=>{const upload=(await db.query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2 AND archive_id=$3 AND action_id=$4 FOR UPDATE',[row.company_id,current.upload_id,row.id,action.id])).rows[0];if(!upload)fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');return run(db,current,upload,action.id);});intent=undefined;return result;
  }
  try{
   await scope.authorize();let current=await atomic(async(_db,value)=>value),source=(await atomic(db=>db.query('SELECT * FROM higgsfield_archive_fetches WHERE company_id=$1 AND archive_id=$2',[row.company_id,row.id]))).rows[0];
   let upload=current.upload_id?await uploadState():null;
   if(!upload||upload.status!=='verifying'){
    // A lease-specific opaque directory never adopts or follows a previous
    // worker's scratch file. Recovery repeats only the authorized source read.
    root=await scope.io(async()=>{const info=await lstat(scratchRoot);if(!info.isDirectory()||info.isSymbolicLink())fail('HIGGSFIELD_ARCHIVE_POLICY_INVALID');return realpath(scratchRoot);});
    scratch=join(root,randomUUID());await scope.io(async()=>{await mkdir(scratch!,{mode:0o700});if(scope.signal.aborted){await rm(scratch!,{recursive:true,force:true,maxRetries:5,retryDelay:100});scope.current();}});const path=join(scratch,'source');await scope.io(async()=>{const opened=await open(path,'wx+',0o600);if(scope.signal.aborted){await opened.close();scope.current();}file=opened;});
    const locator=await atomic(async(db,value)=>{const saved=(await db.query('SELECT l.sealed,j.provider_job_id FROM higgsfield_output_locators l JOIN higgsfield_job_outputs o ON o.company_id=l.company_id AND o.id=l.output_id JOIN higgsfield_jobs j ON j.company_id=o.company_id AND j.id=o.job_id WHERE l.company_id=$1 AND l.output_id=$2',[row.company_id,value.output_id])).rows[0];if(!saved)fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');const opened=openHiggsfieldSecret<{locator:string}>(saved.sealed,{companyId:row.company_id,id:value.output_id,purpose:'provider-output'});if(typeof opened.locator!=='string')fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');const url=new URL(opened.locator);if(sha(JSON.stringify([saved.provider_job_id,value.output.kind,value.output.ordinal,url.origin,url.pathname]))!==value.locator_identity)fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');return opened.locator;});
    const hash=createHash('sha256');let bytes=0;
    const fetched=await scope.io(()=>fetchOutput({locator,maxBytes:Number(current.max_bytes),deadlineMs:deadline,signal:scope.signal,assertAuthority:async()=>scope.authorize(true),consume:async chunk=>{scope.current();if(!(chunk instanceof Uint8Array)||bytes+chunk.byteLength>Number(current.max_bytes))fail('HIGGSFIELD_ARCHIVE_FETCH_FAILED');let offset=0;while(offset<chunk.byteLength){await scope.authorize();const written=await scope.bound(file!.write(chunk,offset,chunk.byteLength-offset,bytes+offset));if(written.bytesWritten<1)fail('HIGGSFIELD_ARCHIVE_FETCH_FAILED');offset+=written.bytesWritten;}hash.update(chunk);bytes+=chunk.byteLength;}}));
    const digest=hash.digest('hex');if(!bytes||fetched.bytes!==bytes||fetched.sha256!==digest)fail('HIGGSFIELD_ARCHIVE_FETCH_FAILED');await scope.io(()=>file!.sync());
    if(source&&(Number(source.bytes)!==bytes||source.sha256!==digest||source.locator_identity!==current.locator_identity))fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');
    const inspectionContext:ArchiveInspectionContext=Object.freeze({companyId:row.company_id,projectId:row.project_id,archiveId:row.id,leaseId:lease,locatorIdentity:current.locator_identity,requestHash:current.request_hash,expectedBytes:bytes,expectedSha256:digest,expectedKind:current.output.kind});
    phase='inspecting';const media=await scope.io(()=>inspectMedia({path,expectedKind:current.output.kind,expectedBytes:bytes,expectedSha256:digest,signal:scope.signal},inspectionContext));
    if(!media||media.kind!==current.output.kind||media.bytes!==bytes||media.sha256!==digest||media.verification!=='full_decode'||typeof media.contentType!=='string'||!new RegExp('^'+current.output.kind+'/[-a-zA-Z0-9.+]+$').test(media.contentType))fail('HIGGSFIELD_ARCHIVE_MEDIA_REJECTED');
    const extension=extname(current.destination_name).toLowerCase(),extensions:Record<string,string>={'.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.webp':'webp','.mp4':'mp4','.mov':'mov','.wav':'wav','.mp3':'mp3'};
    if(extension&&extensions[extension]!==media.format)fail('HIGGSFIELD_ARCHIVE_MEDIA_REJECTED');
    source=await atomic(async(db,value)=>{const prior=(await db.query('SELECT * FROM higgsfield_archive_fetches WHERE company_id=$1 AND archive_id=$2',[row.company_id,row.id])).rows[0];if(prior){if(Number(prior.bytes)!==bytes||prior.sha256!==digest||prior.locator_identity!==value.locator_identity||prior.media.kind!==media.kind||prior.media.contentType!==media.contentType)fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');return prior;}return(await db.query('INSERT INTO higgsfield_archive_fetches(company_id,project_id,archive_id,locator_identity,bytes,sha256,media) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[row.company_id,row.project_id,row.id,value.locator_identity,bytes,digest,JSON.stringify(media)])).rows[0];});
    phase='allocating';upload=await atomic(async(db,value)=>{
     if(value.upload_id)return(await db.query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2 AND archive_id=$3',[row.company_id,value.upload_id,row.id])).rows[0];
     await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`storage-upload-cap:${row.company_id}`]);
     if(Number((await db.query("SELECT count(*) FROM project_storage_uploads WHERE company_id=$1 AND (status IN ('uncertain','initiating','uploading','completing','verifying') OR status='cancelled' AND action_id IS NOT NULL OR status='allocated' AND expires_at>clock_timestamp())",[row.company_id])).rows[0].count)>=8)fail('HIGGSFIELD_ARCHIVE_TRANSFER_LIMIT');
     let savedFile:Row|undefined;if(value.destination_file_id)savedFile=(await db.query('SELECT * FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[row.company_id,row.project_id,value.destination_file_id])).rows[0];else{
      const occupied=(await db.query('SELECT id FROM project_storage_folders WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4 UNION ALL SELECT id FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4',[row.company_id,row.project_id,value.destination_parent_id,value.destination_name_key])).rowCount;if(occupied)fail('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');
      savedFile=(await db.query('INSERT INTO project_storage_files(company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[row.company_id,row.project_id,value.storage_binding_id,value.destination_parent_id,value.destination_name,value.destination_name_key,value.approved_by])).rows[0];
     }
     if(!savedFile||savedFile.parent_id!==value.destination_parent_id||savedFile.name!==value.destination_name)fail('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');
     const versionId=randomUUID(),uploadId=randomUUID(),version=Number((await db.query('SELECT COALESCE(max(version),0)+1 AS version FROM project_storage_versions WHERE company_id=$1 AND file_id=$2',[row.company_id,savedFile!.id])).rows[0].version);
     await db.query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[versionId,row.company_id,row.project_id,savedFile!.id,version,source.bytes,source.sha256,source.media.contentType,runpodProjectObjectKey(row.company_id,row.project_id,versionId),value.approved_by]);
     const reserved=(await db.query("INSERT INTO project_storage_uploads(id,company_id,project_id,version_id,actor_key,actor_user_id,client_id,request_hash,part_bytes,expires_at,archive_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7) RETURNING *",[uploadId,row.company_id,row.project_id,versionId,'archive:'+row.id,value.approved_by,row.id,value.request_hash,partBytes,value.expires_at])).rows[0];
     await db.query("UPDATE higgsfield_output_archives SET upload_id=$3,version_id=$4,status='uploading',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,row.id,uploadId,versionId]);await db.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE company_id=$1 AND id=$2',[row.company_id,value.storage_binding_id]);return reserved;
    },true);
   }
   if(!source||!validHash(source.sha256)||Number(source.bytes)<1||!upload)fail('HIGGSFIELD_ARCHIVE_WORKER_FAILED');
   const config=await atomic(async(db,value)=>{const credentials=await openProjectStorageCredentials(db,row.company_id,value.storage_connection_id);if(credentials.connection.revision!==value.storage_connection_revision)fail('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');return {companyId:row.company_id,projectId:row.project_id,region:credentials.connection.region,volumeId:credentials.connection.volumeId,credentials:{accessKeyId:credentials.accessKeyId,secretAccessKey:credentials.secretAccessKey},partBytes:upload.part_bytes,maxObjectBytes:STORAGE_MAX_FILE_BYTES,timeoutMs:deadline};});
   adapter=factory(config);phase='uploading';
   if(upload.status==='allocated'){
    await begin('initiate','initiating');const descriptor=await scope.io(()=>adapter!.createMultipart({versionId:upload.version_id,bytes:Number(source.bytes),contentType:source.media.contentType,signal:scope.signal}));
    const checked=adapter.validateMultipart(descriptor);if(checked.versionId!==upload.version_id||checked.bytes!==Number(source.bytes)||checked.partBytes!==upload.part_bytes)fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');
    await returned(async(db,value,u,actionId)=>{await db.query("UPDATE project_storage_uploads SET status='uploading',provider_upload_id=$3,provider_descriptor=$4,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,u.id,checked.uploadId,JSON.stringify(checked)]);await receipt(db,value,actionId,'initiate','returned',{uploadId:u.id});});upload=await uploadState();
   }
   if(upload.status==='uploading'){
    if(!file)fail('HIGGSFIELD_ARCHIVE_WORKER_FAILED');const descriptor=adapter.validateMultipart(upload.provider_descriptor),whole=createHash('sha256');let total=0;
    const savedParts=(await atomic(db=>db.query('SELECT * FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 ORDER BY part_number',[row.company_id,upload.id]))).rows;
    const count=Math.ceil(Number(source.bytes)/upload.part_bytes);
    if(savedParts.some(p=>p.part_number<1||p.part_number>count))fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');
    for(let number=1;number<=count;number++){
     const expected=Math.min(upload.part_bytes,Number(source.bytes)-(number-1)*upload.part_bytes),prior=savedParts.find(p=>p.part_number===number),partHash=createHash('sha256');let read=0,ended=false;
     const body=new ReadableStream<Uint8Array>({async pull(controller){try{await scope.authorize();if(read===expected){ended=true;controller.close();return;}const buffer=Buffer.alloc(Math.min(64*1024,expected-read)),chunk=await scope.bound(file!.read(buffer,0,buffer.length,(number-1)*upload.part_bytes+read));if(chunk.bytesRead<1)fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');const value=buffer.subarray(0,chunk.bytesRead);read+=value.length;total+=value.length;partHash.update(value);whole.update(value);controller.enqueue(value);}catch(error){controller.error(error);}}},{highWaterMark:0});
     try{
      if(prior){const reader=body.getReader();try{while(!(await scope.bound(reader.read())).done){}}finally{reader.releaseLock();}if(prior.sha256!==partHash.digest('hex')||Number(prior.bytes)!==read)fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');continue;}
      await begin('part','uploading',number);const result=await scope.io(()=>adapter!.uploadPart({upload:descriptor,partNumber:number,body,signal:scope.signal}));if(!ended||read!==expected||result.bytes!==read||result.partNumber!==number||!etag(result.etag))fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');const digest=partHash.digest('hex');
      await returned(async(db,value,u,actionId)=>{await db.query('INSERT INTO project_storage_upload_parts(company_id,upload_id,part_number,bytes,sha256,provider_etag) VALUES($1,$2,$3,$4,$5,$6)',[row.company_id,u.id,number,read,digest,result.etag]);await db.query('UPDATE project_storage_uploads SET active_part=NULL,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[row.company_id,u.id]);await receipt(db,value,actionId,'part','returned',{partNumber:number,bytes:read,sha256:digest});});
     }finally{void body.cancel().catch(()=>{});}
    }
    if(total!==Number(source.bytes)||whole.digest('hex')!==source.sha256)fail('HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');
    const parts=(await atomic(db=>db.query('SELECT part_number AS "partNumber",bytes::float8 AS bytes,provider_etag AS etag FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 ORDER BY part_number',[row.company_id,upload.id]))).rows;
    if(parts.length!==count||parts.some((p,i)=>p.partNumber!==i+1)||parts.reduce((n,p)=>n+Number(p.bytes),0)!==Number(source.bytes))fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');
    await begin('complete','completing');const completed=await scope.io(()=>adapter!.completeMultipart({upload:descriptor,parts:parts as any,signal:scope.signal}));if(completed.versionId!==upload.version_id||!etag(completed.etag))fail('HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');
    await returned(async(db,value,u,actionId)=>{await db.query("UPDATE project_storage_uploads SET status='verifying',provider_etag=$3,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,u.id,completed.etag]);await db.query("UPDATE higgsfield_output_archives SET status='verifying',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,row.id]);await receipt(db,value,actionId,'complete','returned',{uploadId:u.id});});upload=await uploadState();
   }
   phase='verifying';if(upload.status!=='verifying'||!etag(upload.provider_etag))fail('HIGGSFIELD_ARCHIVE_WORKER_FAILED');
   const object=await scope.io(async()=>{const value=await adapter!.get({versionId:upload.version_id,maxBytes:Number(source.bytes),ifMatch:upload.provider_etag,signal:scope.signal});if(scope.signal.aborted){void value.stream.cancel().catch(()=>{});scope.current();}storedStream=value.stream;return value;});
   const reader=object.stream.getReader(),hash=createHash('sha256');let bytes=0;
   try{if(object.bytes!==Number(source.bytes)||object.totalBytes!==Number(source.bytes)||object.etag!==upload.provider_etag||object.range||object.contentRange)fail('HIGGSFIELD_ARCHIVE_STORED_BYTES_MISMATCH');while(true){await scope.authorize();const chunk=await scope.bound(reader.read());await scope.authorize();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array)||bytes+chunk.value.byteLength>Number(source.bytes))fail('HIGGSFIELD_ARCHIVE_STORED_BYTES_MISMATCH');bytes+=chunk.value.byteLength;hash.update(chunk.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
   const digest=hash.digest('hex');if(bytes!==Number(source.bytes)||digest!==source.sha256)fail('HIGGSFIELD_ARCHIVE_STORED_BYTES_MISMATCH');
   await atomic(async(db,value)=>{const u=(await db.query("SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2 AND archive_id=$3 AND status='verifying' AND action_id IS NULL FOR UPDATE",[row.company_id,value.upload_id,row.id])).rows[0];if(!u||u.provider_etag!==object.etag)fail('HIGGSFIELD_ARCHIVE_STORED_BYTES_MISMATCH');await db.query('INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.company_id,row.project_id,u.version_id,bytes,digest,object.etag,randomUUID()]);await db.query("UPDATE project_storage_uploads SET status='ready',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,u.id]);await receipt(db,value,randomUUID(),'verify','returned',{versionId:u.version_id,bytes,sha256:digest});const published=await db.query("UPDATE higgsfield_output_archives SET status='verified',diagnostic_code=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND lease_id=$3 AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL AND status='verifying'",[row.company_id,row.id,lease]);if(!published.rowCount)fail('HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');});
   return {processed:true,archiveId:row.id,status:'verified'};
  }catch(error){
   let code:Code=intent?'HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN':error instanceof ArchiveError?error.code:phase==='inspecting'?'HIGGSFIELD_ARCHIVE_MEDIA_REJECTED':phase==='fetching'?'HIGGSFIELD_ARCHIVE_FETCH_FAILED':'HIGGSFIELD_ARCHIVE_WORKER_FAILED';
   const retry=!intent&&['fetching','verifying'].includes(phase)&&['HIGGSFIELD_ARCHIVE_FETCH_FAILED','HIGGSFIELD_ARCHIVE_WORKER_FAILED','HIGGSFIELD_ARCHIVE_DEADLINE','HIGGSFIELD_ARCHIVE_ABORTED'].includes(code);
   const status=intent?'uncertain':code==='HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED'||code==='HIGGSFIELD_ARCHIVE_SOURCE_CHANGED'?'blocked':retry?phase:'failed';
   const savedStatus=await transaction(async db=>{const current=(await db.query('SELECT * FROM higgsfield_output_archives WHERE company_id=$1 AND id=$2 FOR UPDATE',[row.company_id,row.id])).rows[0];if(!current||current.lease_id!==lease||!active.includes(current.status))return current?.status??'blocked';if(intent&&current.upload_id)await db.query("UPDATE project_storage_uploads SET status='uncertain',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND action_id=$3",[row.company_id,current.upload_id,intent.id]);await receipt(db,current,intent?.id??randomUUID(),intent?.operation??phase,intent?'uncertain':status==='blocked'?'blocked':'failed',{code});await db.query('UPDATE higgsfield_output_archives SET status=$3,diagnostic_code=$4,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[row.company_id,row.id,status,code]);return status;});
   return {processed:true,archiveId:row.id,status:savedStatus,...savedStatus==='verified'?{}:{code}};
  }finally{
   scope.close();adapter?.close();void storedStream?.cancel().catch(()=>{});await file?.close().catch(()=>{});
   if(scratch&&root&&dirname(scratch)===root&&/^[a-f0-9-]{36}$/.test(scratch.slice(root.length+1)))await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
  }
 }
 return {runNext};
}
