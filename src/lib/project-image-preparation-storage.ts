/** Private preparation storage authority. Caller-owned transactions only; no
 * provider I/O, generic upload grant, archive substitution or public route. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {fail,id} from './security';
import {openProjectStorageCredentials} from './project-storage';
import {authorizeProjectImagePreparation,getProjectImagePreparation,projectImagePreparationDigest as digest,type ProjectImagePreparationOptions} from './project-image-preparations';
import {PROJECT_IMAGE_PREPARATION_LIMITS as limits,type ProjectImagePreparationLease as Lease} from './project-image-preparations-protocol';
import {runpodProjectObjectKey,runpodProjectRoot,type RunpodProjectStorageConfig,type RunpodMultipartUpload,type RunpodUploadedPart} from './project-storage-runpod';
import {createHash} from 'node:crypto';

type Row=Record<string,any>;
const PART_BYTES=64*1024**2;
export type ProjectImagePreparationOutput={fileId:string;versionId:string;uploadId:string;bytes:number;sha256:string;partBytes:number};
export type ProjectImagePreparationStoreOperation='initiate'|'part'|'complete';
const changed=():never=>fail(409,'The exact preparation storage operation is no longer authorized.','IMAGE_PREPARATION_STORAGE_CHANGED');
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const parsed=schema.safeParse(value);if(!parsed.success)fail(400,'Invalid preparation storage result.','IMAGE_PREPARATION_STORAGE_RESULT_INVALID');return parsed.data;};
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const opaque=z.string().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/);
const etag=z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f,]+$/).refine(v=>v!=='*'&&!v.startsWith('W/'));
const descriptor=z.object({scope:sha,versionId:uuid,uploadId:opaque,bytes:z.number().int().positive().max(limits.outputMaxBytes),partBytes:z.literal(PART_BYTES)}).strict();
const resultInput=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('initiate'),descriptor}).strict(),
 z.object({operation:z.literal('part'),part:z.object({partNumber:z.literal(1),etag,bytes:z.number().int().positive().max(limits.outputMaxBytes)}).strict(),sha256:sha}).strict(),
 z.object({operation:z.literal('complete'),versionId:uuid,etag}).strict(),
]);
const publicationInput=z.object({bytes:z.number().int().positive().max(limits.outputMaxBytes),sha256:sha,etag,cleanupConfirmed:z.literal(true)}).strict();
async function receipt(db:PoolClient,r:Row,actionId:string,operation:string,phase:string,detail:Row={}){await db.query('INSERT INTO project_image_preparation_receipts(company_id,project_id,preparation_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',[r.company_id,r.project_id,r.id,actionId,operation,phase,JSON.stringify(detail)]);}
async function allocation(db:PoolClient,r:Row){
 const value=(await db.query(`SELECT a.*,u.status AS upload_status,u.provider_descriptor,u.provider_upload_id,u.provider_etag,u.part_bytes,u.action_id,u.active_part,
 u.action_expires_at,u.expires_at AS upload_expires_at FROM project_image_preparation_allocations a JOIN project_storage_uploads u
 ON (u.company_id,u.project_id,u.id,u.version_id)=(a.company_id,a.project_id,a.upload_id,a.version_id)
 WHERE a.company_id=$1 AND a.project_id=$2 AND a.preparation_id=$3 FOR UPDATE OF u`,[r.company_id,r.project_id,r.id])).rows[0];
 if(!value)return changed();return value;
}
const output=(a:Row):ProjectImagePreparationOutput=>({fileId:a.file_id,versionId:a.version_id,uploadId:a.upload_id,bytes:Number(a.output_bytes),sha256:a.output_sha256,partBytes:a.part_bytes});
async function current(db:PoolClient,lease:Lease,options:ProjectImagePreparationOptions){
 const value=await authorizeProjectImagePreparation(db,lease,options),a=await allocation(db,value.r);
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[a.upload_expires_at])).rows[0].valid)changed();return {...value,a};
}
async function liveAtCommit(db:PoolClient,r:Row,lease:Lease){
 if(!(await db.query(`SELECT 1 FROM project_image_preparations p JOIN project_image_preparation_approvals a ON a.company_id=p.company_id AND a.preparation_id=p.id
 WHERE p.company_id=$1 AND p.id=$2 AND p.lease_id=$3 AND p.lease_expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()
 AND p.revoked_at IS NULL AND p.status IN ('validating','storing','verifying')`,[r.company_id,r.id,lease.leaseId])).rowCount)changed();
}

/** The supervisor alone receives these credentials. A decoder/guest must only
 * receive its bounded private source bytes and immutable processing context. */
export async function readProjectImagePreparationSource(db:PoolClient,lease:Lease,options:ProjectImagePreparationOptions={}){
 const {r}=await authorizeProjectImagePreparation(db,lease,options);if(r.status!=='reading')changed();
 const credentials=await openProjectStorageCredentials(db,r.company_id,r.storage_connection_id);
 if(credentials.connection.revision!==r.storage_connection_revision)changed();
 const config:RunpodProjectStorageConfig={companyId:r.company_id,projectId:r.project_id,region:credentials.connection.region,volumeId:credentials.connection.volumeId,
 credentials:{accessKeyId:credentials.accessKeyId,secretAccessKey:credentials.secretAccessKey},partBytes:PART_BYTES,maxObjectBytes:limits.sourceMaxBytes,timeoutMs:30_000};
 // Credential reads and preceding lock waits may consume the remaining lease.
 await authorizeProjectImagePreparation(db,lease,options);
 return {versionId:r.source_snapshot.versionId,bytes:r.source_snapshot.bytes,sha256:r.source_snapshot.sha256,etag:r.source_snapshot.providerEtag,contentType:r.source_snapshot.contentType,config};
}
export async function reserveProjectImagePreparationOutput(db:PoolClient,lease:Lease,options:ProjectImagePreparationOptions={}):Promise<ProjectImagePreparationOutput>{
 const {r,approval}=await authorizeProjectImagePreparation(db,lease,options);
 if(r.status==='storing')return output(await allocation(db,r));
 if(r.status!=='validating'||!r.transform_result||r.cleanup_confirmed_at)changed();
 // All folder/file mutations take this binding lock. Project NO KEY UPDATE
 // preserves its facts while permitting child foreign-key KEY SHARE locks.
 const b=(await db.query('SELECT revision FROM project_storage_bindings WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[r.company_id,r.project_id,r.storage_binding_id])).rows[0];
 if(!b||b.revision!==r.storage_binding_revision)changed();
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['storage-upload-cap:'+r.company_id]);
 if(Number((await db.query("SELECT count(*) n FROM project_storage_uploads WHERE company_id=$1 AND (status IN ('uncertain','initiating','uploading','completing','verifying') OR status='cancelled' AND action_id IS NOT NULL OR status='allocated' AND expires_at>clock_timestamp())",[r.company_id])).rows[0].n)>=8)fail(409,'The company has outstanding storage operations to finish or reconcile.','IMAGE_PREPARATION_TRANSFER_LIMIT');
 const fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID(),allocationId=randomUUID(),storeActionId=randomUUID(),image=r.transform_result.output;
 await receipt(db,r,allocationId,'allocation','intent',{fileId,versionId,uploadId});
 await receipt(db,r,storeActionId,'store','intent',{versionId,uploadId,bytes:image.bytes,sha256:image.sha256});
 await db.query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[fileId,r.company_id,r.project_id,r.storage_binding_id,r.destination_folder_id,r.destination_name,r.destination_name.normalize('NFC').toLowerCase(),approval.approved_by]);
 await db.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'image/png',$7,$8)",[versionId,r.company_id,r.project_id,fileId,image.bytes,image.sha256,runpodProjectObjectKey(r.company_id,r.project_id,versionId),approval.approved_by]);
 await db.query('INSERT INTO project_storage_uploads(id,company_id,project_id,version_id,actor_key,actor_user_id,client_id,request_hash,part_bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[uploadId,r.company_id,r.project_id,versionId,'preparation:'+r.id,approval.approved_by,r.id,r.request_hash,PART_BYTES,r.lease_expires_at]);
 await db.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE company_id=$1 AND id=$2',[r.company_id,r.storage_binding_id]);
 await db.query(`INSERT INTO project_image_preparation_allocations(company_id,project_id,preparation_id,file_id,version_id,upload_id,binding_revision_before,binding_revision_after,output_sha256,output_bytes,store_action_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[r.company_id,r.project_id,r.id,fileId,versionId,uploadId,b.revision,b.revision+1,image.sha256,image.bytes,storeActionId]);
 await receipt(db,r,allocationId,'allocation','returned',{fileId,versionId,uploadId,bindingRevision:b.revision+1});
 await liveAtCommit(db,r,lease);
 await db.query("UPDATE project_image_preparations SET status='storing',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,r.id]);
 return {fileId,versionId,uploadId,bytes:image.bytes,sha256:image.sha256,partBytes:PART_BYTES};
}
export async function beginProjectImagePreparationStore(db:PoolClient,lease:Lease,operation:ProjectImagePreparationStoreOperation,options:ProjectImagePreparationOptions={}):Promise<{actionId:string;output:ProjectImagePreparationOutput;descriptor:RunpodMultipartUpload|null;parts:RunpodUploadedPart[]}>{
 if(!['initiate','part','complete'].includes(operation))fail(400,'Invalid preparation storage phase.');
 const {r,a}=await current(db,lease,options);
 if(r.status!=='storing'||a.action_id||a.upload_status!==(operation==='initiate'?'allocated':'uploading'))changed();
 const parts=(await db.query('SELECT part_number AS "partNumber",bytes::float8 AS bytes,provider_etag AS etag,sha256 FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2 ORDER BY part_number',[r.company_id,a.upload_id])).rows;
 if(operation==='part'&&parts.length||operation==='complete'&&(parts.length!==1||parts[0].partNumber!==1||parts[0].bytes!==Number(a.output_bytes)||parts[0].sha256!==a.output_sha256))changed();
 const prior=(await db.query("SELECT 1 FROM project_image_preparation_receipts WHERE company_id=$1 AND preparation_id=$2 AND operation=$3 AND phase='intent'",[r.company_id,r.id,'store_'+operation])).rowCount;if(prior)changed();
 const actionId=randomUUID();await receipt(db,r,actionId,'store_'+operation,'intent',{uploadId:a.upload_id,versionId:a.version_id,...operation==='part'?{partNumber:1}: {}});
 await liveAtCommit(db,r,lease);
 await db.query('UPDATE project_storage_uploads SET status=$3,action_id=$4,action_expires_at=$5,active_part=$6,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[r.company_id,a.upload_id,operation==='initiate'?'initiating':operation==='complete'?'completing':'uploading',actionId,r.lease_expires_at,operation==='part'?1:null]);
 return {actionId,output:output(a),descriptor:a.provider_descriptor??null,parts:parts.map(p=>({partNumber:p.partNumber,bytes:p.bytes,etag:p.etag}))};
}
export async function completeProjectImagePreparationStore(db:PoolClient,lease:Lease,actionId:string,input:unknown,options:ProjectImagePreparationOptions={}){
 const value=parse(resultInput,input),{r,a}=await current(db,lease,options);
 if(r.status!=='storing'||a.action_id!==id(actionId)||a.upload_status!==(value.operation==='initiate'?'initiating':value.operation==='complete'?'completing':'uploading')||!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[a.action_expires_at])).rows[0].valid)changed();
 if(!(await db.query("SELECT 1 FROM project_image_preparation_receipts WHERE company_id=$1 AND preparation_id=$2 AND action_id=$3 AND operation=$4 AND phase='intent'",[r.company_id,r.id,actionId,'store_'+value.operation])).rowCount)changed();
 if(value.operation==='initiate'){
  const c=(await db.query('SELECT region,volume_id FROM project_storage_connections WHERE company_id=$1 AND id=$2',[r.company_id,r.storage_connection_id])).rows[0];
  const expectedScope=createHash('sha256').update(JSON.stringify([c.region,c.volume_id,runpodProjectRoot(r.company_id,r.project_id)])).digest('hex');
  if(value.descriptor.versionId!==a.version_id||value.descriptor.bytes!==Number(a.output_bytes)||value.descriptor.scope!==expectedScope)changed();
  await receipt(db,r,actionId,'store_initiate','returned',{uploadId:a.upload_id});
  await liveAtCommit(db,r,lease);
  await db.query("UPDATE project_storage_uploads SET status='uploading',provider_upload_id=$3,provider_descriptor=$4,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,a.upload_id,value.descriptor.uploadId,JSON.stringify(value.descriptor)]);
 }else if(value.operation==='part'){
  if(a.active_part!==1||value.part.bytes!==Number(a.output_bytes)||value.sha256!==a.output_sha256)changed();
  await receipt(db,r,actionId,'store_part','returned',{uploadId:a.upload_id,bytes:value.part.bytes,sha256:value.sha256});
  await liveAtCommit(db,r,lease);
  await db.query('INSERT INTO project_storage_upload_parts(company_id,upload_id,part_number,bytes,sha256,provider_etag) VALUES($1,$2,1,$3,$4,$5)',[r.company_id,a.upload_id,value.part.bytes,value.sha256,value.part.etag]);
  await db.query('UPDATE project_storage_uploads SET active_part=NULL,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[r.company_id,a.upload_id]);
 }else{
  if(value.versionId!==a.version_id)changed();
  await receipt(db,r,actionId,'store_complete','returned',{uploadId:a.upload_id});
  await receipt(db,r,a.store_action_id,'store','returned',{uploadId:a.upload_id,versionId:a.version_id});
  await liveAtCommit(db,r,lease);
  await db.query("UPDATE project_storage_uploads SET status='verifying',provider_etag=$3,action_id=NULL,action_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,a.upload_id,value.etag]);
  await db.query("UPDATE project_image_preparations SET status='verifying',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,r.id]);
 }
}
/** Trusted supervisor only, after complete stored-byte readback and confirmed
 * processor/scratch cleanup. This assertion is never accepted by an API route. */
export async function publishProjectImagePreparation(db:PoolClient,lease:Lease,input:unknown,options:ProjectImagePreparationOptions={}){
 const value=parse(publicationInput,input),{r,a,approval}=await current(db,lease,options);
 if(r.status!=='verifying'||a.upload_status!=='verifying'||a.action_id||value.bytes!==Number(a.output_bytes)||value.sha256!==a.output_sha256||value.etag!==a.provider_etag||r.cleanup_confirmed_at)changed();
 const parts=(await db.query('SELECT bytes,sha256 FROM project_storage_upload_parts WHERE company_id=$1 AND upload_id=$2',[r.company_id,a.upload_id])).rows;
 if(parts.length!==1||Number(parts[0].bytes)!==value.bytes||parts[0].sha256!==value.sha256)changed();
 const verifyId=randomUUID(),cleanupId=randomUUID();
 await receipt(db,r,verifyId,'verify','returned',{versionId:a.version_id,bytes:value.bytes,sha256:value.sha256});
 await receipt(db,r,cleanupId,'cleanup','returned',{processorId:lease.processor.id,leaseId:lease.leaseId,sourceRemoved:true,processorStopped:true,ioDrained:true});
 await db.query('INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[r.company_id,r.project_id,a.version_id,value.bytes,value.sha256,value.etag,verifyId]);
 await db.query("UPDATE project_storage_uploads SET status='ready',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,a.upload_id]);
 const evidence={version:1,companyId:r.company_id,projectId:r.project_id,preparationId:r.id,workItemId:r.work_item_id,source:r.source_snapshot,output:{fileId:a.file_id,versionId:a.version_id,uploadId:a.upload_id,bytes:value.bytes,sha256:value.sha256,width:r.transform_result.output.width,height:r.transform_result.output.height},recipeSha256:r.recipe_sha256,processor:approval.processor_snapshot,transformSha256:r.transform_sha256,approvalHash:approval.approval_hash,verifyId,cleanupId};
 await db.query(`INSERT INTO project_image_preparation_derivations(company_id,project_id,preparation_id,source_version_id,output_file_id,output_version_id,upload_id,recipe_sha256,source_sha256,source_bytes,output_sha256,output_bytes,output_width,output_height,processor_snapshot,transform_evidence,receipt_sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[r.company_id,r.project_id,r.id,r.source_version_id,a.file_id,a.version_id,a.upload_id,r.recipe_sha256,r.source_snapshot.sha256,r.source_snapshot.bytes,value.sha256,value.bytes,r.transform_result.output.width,r.transform_result.output.height,JSON.stringify(approval.processor_snapshot),JSON.stringify(r.transform_result),digest(evidence)]);
 await receipt(db,r,randomUUID(),'publish','returned',{versionId:a.version_id,derivationSha256:digest(evidence)});
 await liveAtCommit(db,r,lease);
 await db.query("UPDATE project_image_preparations SET status='ready',cleanup_confirmed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[r.company_id,r.id]);
 return getProjectImagePreparation(db,{companyId:r.company_id,userId:approval.approved_by},r.id);
}
