import {createHash,randomUUID} from 'node:crypto';
import * as blob from '@vercel/blob';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from './db';
import {requireMembership} from './auth';
import {memberMutation} from './company';
import {assertOrigin,body,fail,hashToken,id,json,publicUrl} from './security';
import {authenticateExecution,authorizeCompletedExecution,type ConnectorIdentity} from './studio-execution';
import {studioProjectDetail} from './studio';
import {STUDIO_MEDIA_MAX_FILE_BYTES,STUDIO_MEDIA_READ_SECONDS,STUDIO_MEDIA_UPLOAD_SECONDS,studioMediaUploadInput,studioMediaVerifyInput,studioMediaPromoteInput,studioMediaListInput} from './studio-media-protocol';

type Row=Record<string,any>;
type BlobSdk=Pick<typeof blob,'issueSignedToken'|'presignUrl'|'get'>;
export type StudioMediaProvider={
 signUpload(pathname:string,bytes:number,contentType:string,expiresAt:number):Promise<string>;
 read(pathname:string,signal:AbortSignal):Promise<{stream:ReadableStream<Uint8Array>;bytes:number|null;etag:string}|null>;
 signRead(pathname:string,expiresAt:number):Promise<string>;
};
const privatePath=/^studio\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{64}\/[0-9a-f-]{36}\.[a-z0-9]{1,12}$/;
function checkedPath(pathname:string){if(!privatePath.test(pathname))throw new Error('Invalid private media pathname.');return pathname;}
/** The only storage transport: exact server-created paths, fixed SDK control plane, private access. */
export function createStudioMediaProvider(sdk:BlobSdk=blob):StudioMediaProvider{
 return {
  async signUpload(pathname,bytes,contentType,expiresAt){
   checkedPath(pathname);if(!Number.isInteger(bytes)||bytes<1||bytes>STUDIO_MEDIA_MAX_FILE_BYTES)throw new Error('Invalid media size.');
   const token=await sdk.issueSignedToken({pathname,operations:['put'],validUntil:expiresAt,maximumSizeInBytes:bytes,allowedContentTypes:[contentType],abortSignal:AbortSignal.timeout(10000)});
   return (await sdk.presignUrl(token,{access:'private',operation:'put',pathname,validUntil:expiresAt,maximumSizeInBytes:bytes,allowedContentTypes:[contentType],allowOverwrite:false,addRandomSuffix:false,cacheControlMaxAge:60})).presignedUrl;
  },
  async read(pathname,signal){
   const result=await sdk.get(checkedPath(pathname),{access:'private',useCache:false,abortSignal:signal,headers:{'Accept-Encoding':'identity'}});if(!result)return null;if(result.statusCode!==200)throw new Error('Media bytes are unavailable.');
   // SDK blob.size comes from HTTP Content-Length (or 0 when missing). Fetch
   // decodes compressed responses, so that transport length may not describe
   // the file bytes delivered by this stream. Count and hash those bytes below.
   const encoding=result.headers.get('content-encoding')?.trim().toLowerCase(),length=result.headers.get('content-length');
   const declared=(!encoding||encoding==='identity')&&length!==null&&/^\d+$/.test(length)?Number(length):null;
   return {stream:result.stream,bytes:declared!==null&&Number.isSafeInteger(declared)?declared:null,etag:result.blob.etag};
  },
  async signRead(pathname,expiresAt){checkedPath(pathname);const token=await sdk.issueSignedToken({pathname,operations:['get'],validUntil:expiresAt,abortSignal:AbortSignal.timeout(10000)});return (await sdk.presignUrl(token,{access:'private',operation:'get',pathname,validUntil:expiresAt,useCache:false})).presignedUrl;},
 };
}
const defaultProvider=createStudioMediaProvider();
export function canonicalStudioMedia(value:unknown):string{return Array.isArray(value)?'['+value.map(canonicalStudioMedia).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonicalStudioMedia(item)).join(',')+'}':JSON.stringify(value);}
const digest=(value:unknown)=>hashToken(canonicalStudioMedia(value));
const fileColumns=`f.id,f.project_id AS "projectId",f.job_id AS "jobId",f.output_path AS path,f.kind,f.frame,f.sha256,f.bytes::float8 AS bytes,f.content_type AS "contentType",f.created_at AS "createdAt",v.verified_at AS "verifiedAt"`;
const publicFile=(row:Row):Row=>({...row,verifiedState:row.verifiedAt?'verified':'awaiting_upload_or_verification',verificationSource:row.verifiedAt?'server_bytes':'connector_reported',independentlyReviewed:false});
async function fileView(client:PoolClient,companyId:string,fileId:string):Promise<Row>{const row=(await client.query(`SELECT ${fileColumns} FROM studio_media_files f LEFT JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id WHERE f.company_id=$1 AND f.id=$2`,[companyId,fileId])).rows[0];if(!row)fail(404,'Private media file not found.');return publicFile(row);}
async function once(client:PoolClient,companyId:string,actorKey:string,clientId:string,operation:string,data:unknown,run:()=>Promise<Row>):Promise<Row>{
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-media:${companyId}:${actorKey}:${clientId}`]);
 const hash=digest({operation,data}),prior=(await client.query('SELECT request_hash,response FROM studio_media_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[companyId,actorKey,clientId])).rows[0];
 if(prior){if(prior.request_hash!==hash)fail(409,'This media request ID was used for different data.','IDEMPOTENCY_CONFLICT');return {...prior.response,replayed:true};}
 const result=await run();await client.query('INSERT INTO studio_media_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[companyId,actorKey,clientId,hash,JSON.stringify(result)]);return {...result,replayed:false};
}
function mediaType(path:string){const ext=path.split('.').at(-1)?.toLowerCase();return ext==='png'?{extension:'png',contentType:'image/png'}:ext==='exr'?{extension:'exr',contentType:'image/x-exr'}:ext==='json'?{extension:'json',contentType:'application/json'}:ext==='blend'?{extension:'blend',contentType:'application/octet-stream'}:{extension:'bin',contentType:'application/octet-stream'};}
async function prepareUpload(identity:ConnectorIdentity,jobId:string,data:z.infer<typeof studioMediaUploadInput>):Promise<Row>{
 return transaction(async client=>{
  const job=await authorizeCompletedExecution(client,identity,jobId);
  const result=await once(client,identity.company_id,'connector:'+identity.id,data.clientId,'upload:'+jobId,data,async()=>{
   const expected=job.manifest.files.find((file:Row)=>file.path===data.path);if(!expected)fail(404,'This file is not in the completed job manifest.');
   if(expected.bytes>STUDIO_MEDIA_MAX_FILE_BYTES)fail(413,'This output exceeds the 20 MiB private-media pilot limit.','MEDIA_FILE_TOO_LARGE');
   const existing=(await client.query('SELECT id FROM studio_media_files WHERE company_id=$1 AND job_id=$2 AND output_path=$3',[identity.company_id,jobId,data.path])).rows[0];
   if(existing)return {fileId:existing.id};
   const fileId=randomUUID(),type=mediaType(expected.path),pathname=`studio/${identity.company_id}/${jobId}/${expected.sha256}/${fileId}.${type.extension}`;
   await client.query('INSERT INTO studio_media_files(id,company_id,project_id,job_id,output_path,kind,frame,sha256,bytes,blob_pathname,content_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[fileId,identity.company_id,job.project_id,jobId,expected.path,expected.kind,expected.frame??null,expected.sha256,expected.bytes,pathname,type.contentType]);return {fileId};
  });
  const stored=(await client.query('SELECT blob_pathname FROM studio_media_files WHERE company_id=$1 AND id=$2',[identity.company_id,result.fileId])).rows[0];return {...result,file:await fileView(client,identity.company_id,result.fileId),pathname:stored.blob_pathname};
 });
}
/** Hash bounded stored bytes, not connector assertions or a model-supplied URL. */
export async function verifyStudioMediaBytes(provider:StudioMediaProvider,pathname:string,expected:{bytes:number;sha256:string},signal:AbortSignal=AbortSignal.timeout(20000)){
 checkedPath(pathname);if(expected.bytes<1||expected.bytes>STUDIO_MEDIA_MAX_FILE_BYTES)fail(413,'Media exceeds the verification limit.');
 const result=await provider.read(pathname,signal);if(!result)fail(409,'Upload this exact file before verifying.','MEDIA_UPLOAD_MISSING');
 const reader=result.stream.getReader();let length=0;const hash=createHash('sha256');
 const onAbort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});
 try{
  signal.throwIfAborted();if(result.bytes!==null&&result.bytes!==expected.bytes||!result.etag||result.etag.length>300)fail(409,'Stored media size does not match the immutable output manifest.','MEDIA_VERIFICATION_FAILED');
  while(true){signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();if(chunk.done)break;length+=chunk.value.byteLength;if(length>expected.bytes||length>STUDIO_MEDIA_MAX_FILE_BYTES)fail(409,'Stored media exceeds its declared size.','MEDIA_VERIFICATION_FAILED');hash.update(chunk.value);}
  if(length!==expected.bytes||hash.digest('hex')!==expected.sha256)fail(409,'Stored media checksum does not match the immutable output manifest.','MEDIA_VERIFICATION_FAILED');
  return {bytes:length,sha256:expected.sha256,etag:result.etag};
 }finally{signal.removeEventListener('abort',onAbort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function verifyFile(identity:ConnectorIdentity,jobId:string,data:z.infer<typeof studioMediaVerifyInput>,provider:StudioMediaProvider){
 const expected=await transaction(async client=>{await authorizeCompletedExecution(client,identity,jobId);const file=(await client.query('SELECT f.*,v.file_id AS verified FROM studio_media_files f LEFT JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id WHERE f.company_id=$1 AND f.job_id=$2 AND f.id=$3',[identity.company_id,jobId,data.fileId])).rows[0];if(!file)fail(404,'Private media file not found in this job.');return file;});
 // Storage work happens outside a database transaction. Recheck authority and immutable identity before recording it.
 const verified=expected.verified?null:await verifyStudioMediaBytes(provider,expected.blob_pathname,{bytes:Number(expected.bytes),sha256:expected.sha256});
 return transaction(async client=>{
  await authorizeCompletedExecution(client,identity,jobId);
  return once(client,identity.company_id,'connector:'+identity.id,data.clientId,'verify:'+jobId,data,async()=>{
   // This insert-only table deliberately has no UPDATE privilege. The current
   // company/connector/job locks fence lifecycle changes; re-read its immutable identity.
   const file=(await client.query('SELECT * FROM studio_media_files WHERE company_id=$1 AND job_id=$2 AND id=$3',[identity.company_id,jobId,data.fileId])).rows[0];if(!file||file.blob_pathname!==expected.blob_pathname||file.sha256!==expected.sha256||Number(file.bytes)!==Number(expected.bytes))fail(409,'The expected output changed.');
   if(verified)await client.query('INSERT INTO studio_media_verifications(company_id,file_id,etag,sha256,bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,file_id) DO NOTHING',[identity.company_id,data.fileId,verified.etag,verified.sha256,verified.bytes]);
   return {file:await fileView(client,identity.company_id,data.fileId)};
  });
 });
}
export async function studioMediaList(client:PoolClient,companyId:string,input:z.infer<typeof studioMediaListInput>){
 if(!(await client.query('SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND id=$2',[companyId,input.jobId])).rowCount)fail(404,'Execution job not found.');
 if(input.after&&!(await client.query('SELECT id FROM studio_media_files WHERE company_id=$1 AND job_id=$2 AND id=$3',[companyId,input.jobId,input.after])).rowCount)fail(404,'Media page cursor not found.');
 const rows=(await client.query(`SELECT ${fileColumns} FROM studio_media_files f LEFT JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id WHERE f.company_id=$1 AND f.job_id=$2 AND ($3::uuid IS NULL OR f.id>$3) ORDER BY f.id LIMIT $4`,[companyId,input.jobId,input.after??null,input.limit+1])).rows,files=rows.slice(0,input.limit).map(publicFile);
 return {files,page:{limit:input.limit,hasMore:rows.length>input.limit,nextAfter:rows.length>input.limit?files.at(-1)!.id:null},maxFileBytes:STUDIO_MEDIA_MAX_FILE_BYTES};
}
async function promote(client:PoolClient,companyId:string,userId:string,jobId:string,data:z.infer<typeof studioMediaPromoteInput>,origin:string){
 return once(client,companyId,'human:'+userId,data.clientId,'promote:'+jobId,data,async()=>{
  const job=(await client.query('SELECT j.*,m.manifest,m.manifest_hash,c.created_by AS connector_sponsor_id,a.created_by AS agent_sponsor_id FROM studio_execution_jobs j JOIN studio_execution_manifests m ON m.company_id=j.company_id AND m.job_id=j.id JOIN studio_execution_connectors c ON c.company_id=j.company_id AND c.id=j.connector_id LEFT JOIN agents a ON a.company_id=j.company_id AND a.id=j.requested_agent_id WHERE j.company_id=$1 AND j.id=$2',[companyId,jobId])).rows[0];if(!job)fail(404,'Completed execution job not found.');
  if(job.status!=='succeeded'||job.output_kind!=='image_sequence')fail(409,'Promotion requires a completed image sequence. Native scenes remain separately accessible files.');
  const project=(await client.query('SELECT * FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,job.project_id])).rows[0];if(project.revision!==data.revision)fail(409,'The studio project changed.','STUDIO_REVISION_CONFLICT');
  if(project.status==='delivered'||project.ai_policy!=='allowed'||project.gates.production?.decision!=='approved'||digest(project.spec)!==digest(job.spec))fail(409,'Current project policy, specification and production approval must match the executed job.','STUDIO_EXECUTION_BLOCKED');
  const detail=await studioProjectDetail(client,companyId,job.project_id),work=detail.workItems.find(item=>item.id===job.work_item_id);if(!work||work.execution!=='dcc'||work.blockedReason||['review','done'].includes(work.status))fail(409,'This production work is no longer eligible for a new version.','STUDIO_WORK_BLOCKED');
  if(job.requested_agent_id&&work.agentId!==job.requested_agent_id)fail(409,'The producing agent no longer holds this studio role.','STUDIO_ROLE_REQUIRED');
  if((await client.query('SELECT job_id FROM studio_media_promotions WHERE company_id=$1 AND job_id=$2',[companyId,jobId])).rowCount)fail(409,'This execution already has an immutable studio version.','MEDIA_ALREADY_PROMOTED');
  if((await client.query("SELECT id FROM studio_execution_jobs WHERE company_id=$1 AND work_item_id=$2 AND status IN ('awaiting_approval','queued','running')",[companyId,work.id])).rowCount)fail(409,'Resolve pending execution for this work before promotion.','STUDIO_EXECUTION_ACTIVE');
  if(Number((await client.query('SELECT count(*) FROM studio_artifacts WHERE company_id=$1 AND project_id=$2',[companyId,project.id])).rows[0].count)>=1000)fail(409,'This project reached its media-version limit.');
  const files=(await client.query('SELECT f.*,v.etag FROM studio_media_files f JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id AND v.sha256=f.sha256 AND v.bytes=f.bytes WHERE f.company_id=$1 AND f.job_id=$2 ORDER BY f.frame,f.id',[companyId,jobId])).rows;
  const expected=job.manifest.files.filter((file:Row)=>file.kind==='image').sort((a:Row,b:Row)=>a.frame-b.frame);
  if(expected.length!==job.frame_end-job.frame_start+1)fail(409,'The execution frame manifest is incomplete.');
  const frames=expected.map((frame:Row,index:number)=>{const file=files.find(item=>item.output_path===frame.path&&item.sha256===frame.sha256&&Number(item.bytes)===frame.bytes&&item.frame===frame.frame);if(!file||frame.frame!==job.frame_start+index)fail(409,'Upload and verify every sequence frame before promotion.','MEDIA_SEQUENCE_INCOMPLETE');return {frame:frame.frame,fileId:file.id,path:frame.path,sha256:frame.sha256,bytes:frame.bytes,accessPath:`/api/companies/${companyId}/studio/media/${file.id}`};});
  const provenance={jobId,connectorId:job.connector_id,connectorSponsorId:job.connector_sponsor_id,producedBy:job.requested_by,producedAgentId:job.requested_agent_id,agentSponsorId:job.agent_sponsor_id??null,runId:job.requested_run_id,promotedBy:userId,executionManifestSha256:job.manifest_hash};
  const manifest={schemaVersion:1,kind:'verified_image_sequence',companyId,projectId:project.id,workItemId:work.id,jobId,spec:job.spec,frameStart:job.frame_start,frameEnd:job.frame_end,verificationSource:'server_bytes',independentlyReviewed:false,provenance,frames};
  const manifestText=canonicalStudioMedia(manifest),sha256=hashToken(manifestText),url=new URL(`/api/companies/${companyId}/studio/execution/jobs/${jobId}/media/manifest`,origin).href;
  const version=Number((await client.query('SELECT COALESCE(max(version),0)+1 AS version FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3',[companyId,project.id,work.id])).rows[0].version);
  const metadata={...job.spec,frameStart:job.frame_start,frameEnd:job.frame_end,notes:'Private sequence manifest; all frame bytes and SHA-256 hashes verified. Independent image/creative QC is still required.',executionProvenance:provenance,storageVerification:'server_bytes',referenceKind:'image_sequence_manifest'};
  const artifact=(await client.query('INSERT INTO studio_artifacts(company_id,project_id,work_item_id,name,version,url,sha256,metadata,produced_by,produced_agent_id,agent_sponsor_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,version',[companyId,project.id,work.id,data.name,version,url,sha256,JSON.stringify(metadata),job.requested_by,job.requested_agent_id,job.agent_sponsor_id??null,job.requested_run_id])).rows[0];
  await client.query('INSERT INTO studio_media_promotions(company_id,project_id,job_id,artifact_id,manifest_text,manifest_sha256,promoted_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,project.id,jobId,artifact.id,manifestText,sha256,userId]);
  await client.query('UPDATE studio_projects SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[companyId,project.id]);
  await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[companyId,userId,'studio.media_promoted','Verified private sequence files were registered as a pending studio version. Independent technical and creative review is required.']);
  return {artifact:{...artifact,name:data.name,url,sha256,workItemId:work.id,...metadata,reviewStatus:'pending'},project:{id:project.id,revision:project.revision+1}};
 });
}
export async function studioMediaRoute(request:Request,parts:string[],method:string,provider:StudioMediaProvider=defaultProvider):Promise<Response|null>{
 if(parts[0]==='execution'&&parts[1]==='jobs'&&parts[3]==='media'&&parts.length===5&&method==='POST'&&['upload','verify'].includes(parts[4])){
  const identity=await authenticateExecution(request),jobId=id(parts[2]);
  if(parts[4]==='verify')return json(await verifyFile(identity,jobId,await body(request,studioMediaVerifyInput),provider));
  const result=await prepareUpload(identity,jobId,await body(request,studioMediaUploadInput));if(result.file.verifiedState==='verified')return json({file:result.file,upload:null,replayed:result.replayed});
  const expiresAt=Date.now()+STUDIO_MEDIA_UPLOAD_SECONDS*1000,url=await provider.signUpload(result.pathname,result.file.bytes,result.file.contentType,expiresAt);
  await transaction(client=>authorizeCompletedExecution(client,identity,jobId));
  // Blob's control-plane PUT uses x-content-type for the stored MIME type;
  // Content-Type alone may be replaced by extension inference (notably EXR).
  // The signed exact allowedContentTypes grant enforces this same value.
  return json({file:result.file,upload:{url,method:'PUT',headers:{'Content-Type':result.file.contentType,'x-content-type':result.file.contentType},expiresAt:new Date(expiresAt).toISOString()},replayed:result.replayed});
 }
 const isFiles=parts[0]==='companies'&&parts[2]==='studio'&&parts[3]==='media';
 const isJobMedia=parts[0]==='companies'&&parts[2]==='studio'&&parts[3]==='execution'&&parts[4]==='jobs'&&parts[6]==='media'&&parts.length===8;
 if(!isFiles&&!isJobMedia)return null;
 if(method!=='GET')assertOrigin(request);const companyId=id(parts[1]),member=await requireMembership(request,companyId,method!=='GET');
 if(isFiles&&parts.length===4&&method==='GET'){const search=new URL(request.url).searchParams;if(new Set(search.keys()).size!==[...search.keys()].length)fail(400,'Duplicate media query.');const input=studioMediaListInput.safeParse(Object.fromEntries(search));if(!input.success)fail(400,'Choose a job and valid media page.');return json(await memberMutation(member,false,client=>studioMediaList(client,companyId,input.data)));}
 if(isFiles&&parts.length===5&&method==='GET'){
  const result=await memberMutation(member,false,async client=>{const file=await fileView(client,companyId,id(parts[4]));if(file.verifiedState!=='verified')fail(409,'This file has not passed storage verification.','MEDIA_UNVERIFIED');const stored=(await client.query('SELECT blob_pathname FROM studio_media_files WHERE company_id=$1 AND id=$2',[companyId,file.id])).rows[0];return {file,pathname:stored.blob_pathname};});
  const expiresAt=Date.now()+STUDIO_MEDIA_READ_SECONDS*1000,url=await provider.signRead(result.pathname,expiresAt);await memberMutation(member,false,async()=>null);return json({file:result.file,access:{url,expiresAt:new Date(expiresAt).toISOString()}});
 }
 if(isJobMedia&&parts[7]==='promote'&&method==='POST'){const data=await body(request,studioMediaPromoteInput);return json(await memberMutation(member,true,client=>promote(client,companyId,member.userId,id(parts[5]),data,publicUrl(request))));}
 if(isJobMedia&&parts[7]==='manifest'&&method==='GET'){
  const row=await memberMutation(member,false,async client=>(await client.query('SELECT manifest_text,manifest_sha256 FROM studio_media_promotions WHERE company_id=$1 AND job_id=$2',[companyId,id(parts[5])])).rows[0]);if(!row)fail(404,'Verified sequence manifest not found.');return new Response(row.manifest_text,{headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':row.manifest_sha256}});
 }
 return null;
}
