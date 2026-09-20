// Server-only control plane. File bytes never enter a Vercel route handler.
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {fail,hashToken,secret} from './security';
import type {ProjectStorageActor,ProjectStorageBinding} from './project-storage-protocol';
import type {ProjectStorageTransferIntegration} from './project-storage';
import {STORAGE_GRANT_SECONDS,STORAGE_HUMAN_GRANT_SECONDS,STORAGE_MAX_FILE_BYTES,STORAGE_PART_BYTES,storageGatewayOrigin,storageTransferAvailability} from './project-storage-config';

type Row=Record<string,any>;
const actorKey=(actor:ProjectStorageActor)=>actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId;
async function grant(client:PoolClient,actor:ProjectStorageActor,projectId:string,binding:Pick<ProjectStorageBinding,'connectionId'|'connection'>,versionId:string,uploadId:string|null){
 const gateway=storageGatewayOrigin();if(!gateway)fail(503,'The storage transfer service is not connected.','STORAGE_GATEWAY_UNAVAILABLE');
 const lease=actor.agentId?(await client.query("SELECT r.lease_token_hash,a.token_hash FROM agent_runs r JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id WHERE r.company_id=$1 AND r.agent_id=$2 AND r.id=$3 AND r.requested_by=$4 AND r.status='running' AND r.lease_expires_at>clock_timestamp()",[actor.companyId,actor.agentId,actor.runId,actor.userId])).rows[0]:null;
 if(actor.agentId&&!lease?.lease_token_hash)fail(403,'The current agent lease is required.');
 const token=secret('stg_'),grantId=randomUUID(),expiresAt=new Date(Date.now()+(actor.agentId?STORAGE_GRANT_SECONDS:STORAGE_HUMAN_GRANT_SECONDS)*1000).toISOString();
 await client.query(`INSERT INTO project_storage_access_receipts(company_id,project_id,version_id,actor_key,user_id,agent_id,run_id,connection_id,connection_revision,upload_id,token_hash,operation,gateway_grant_id,expires_at,agent_lease_hash,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[actor.companyId,projectId,versionId,actorKey(actor),actor.userId,actor.agentId??null,actor.runId??null,binding.connectionId,binding.connection.revision,uploadId,hashToken(token),uploadId?'upload':'read',grantId,expiresAt,lease?.lease_token_hash??null,lease?.token_hash??null]);
 return {token,expiresAt,url:gateway+`/v1/${uploadId?'uploads/'+uploadId:'files/'+versionId}`,grantId};
}
export const projectStorageTransfer:ProjectStorageTransferIntegration={
 availability:storageTransferAvailability,
 async reserveUpload(client,actor,projectId,binding,input){
  if(!storageGatewayOrigin())fail(503,'The storage transfer service is not connected.','STORAGE_GATEWAY_UNAVAILABLE');
  if(input.bytes>STORAGE_MAX_FILE_BYTES)fail(413,'This storage pilot accepts files up to 100 GiB.');
  const key=actorKey(actor),requestHash=hashToken(JSON.stringify(input));
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`storage-upload:${actor.companyId}:${key}:${input.clientId}`]);
  let upload:Row|undefined=(await client.query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,key,input.clientId])).rows[0];
  const replayed=Boolean(upload);
  if(upload){
   if(upload.request_hash!==requestHash||upload.project_id!==projectId||upload.run_id!==(actor.runId??null))fail(409,'This upload request ID belongs to different file details.','IDEMPOTENCY_CONFLICT');
   if(new Date(upload.expires_at).getTime()<=Date.now())fail(409,'This upload session expired. Start a new version.','STORAGE_UPLOAD_EXPIRED');
  }else{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`storage-upload-cap:${actor.companyId}`]);
   // Expiry is not proof that a provider write/abort completed. In-flight
   // intents and confirmed unfinished multipart uploads keep their slots until
   // explicit reconciliation; only an unused allocation can expire harmlessly.
   if(Number((await client.query("SELECT count(*) FROM project_storage_uploads WHERE company_id=$1 AND (status IN ('uncertain','initiating','uploading','completing','verifying') OR status='cancelled' AND action_id IS NOT NULL OR status='allocated' AND expires_at>clock_timestamp())",[actor.companyId])).rows[0].count)>=8)fail(429,'Finish or cancel an active company upload before starting another.','STORAGE_TRANSFER_LIMIT');
   let file:Row|undefined;
   if(input.fileId){
    file=(await client.query('SELECT * FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[actor.companyId,projectId,input.fileId])).rows[0];
    if(!file||file.name!==input.name||file.parent_id!==input.parentId)fail(409,'The selected file moved or changed. Refresh before adding its next version.');
   }else{
    const occupied=(await client.query('SELECT id FROM project_storage_folders WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4 UNION ALL SELECT id FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND name_key=$4',[actor.companyId,projectId,input.parentId,input.name.normalize('NFC').toLowerCase()])).rowCount;
    if(occupied)fail(409,'An item with this name exists. Select the file to upload a new version.','STORAGE_NAME_CONFLICT');
    file=(await client.query('INSERT INTO project_storage_files(company_id,project_id,binding_id,parent_id,name,name_key,created_by,created_agent_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[actor.companyId,projectId,binding.id,input.parentId,input.name,input.name.normalize('NFC').toLowerCase(),actor.userId,actor.agentId??null,actor.runId??null])).rows[0];
   }
   const versionId=randomUUID(),version=Number((await client.query('SELECT COALESCE(max(version),0)+1 AS version FROM project_storage_versions WHERE company_id=$1 AND file_id=$2',[actor.companyId,file!.id])).rows[0].version);
   await client.query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by,created_agent_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[versionId,actor.companyId,projectId,file!.id,version,input.bytes,input.sha256??null,input.contentType,`coatria/companies/${actor.companyId}/projects/${projectId}/objects/${versionId}`,actor.userId,actor.agentId??null,actor.runId??null]);
   upload=(await client.query("INSERT INTO project_storage_uploads(company_id,project_id,version_id,actor_key,actor_user_id,actor_agent_id,run_id,client_id,request_hash,part_bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '24 hours') RETURNING *",[actor.companyId,projectId,versionId,key,actor.userId,actor.agentId??null,actor.runId??null,input.clientId,requestHash,STORAGE_PART_BYTES])).rows[0];
   await client.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId]);
  }
  const ticket=await grant(client,actor,projectId,binding,upload!.version_id,upload!.id);
  return {upload:{id:upload!.id,versionId:upload!.version_id,baseUrl:ticket.url,token:ticket.token,expiresAt:ticket.expiresAt,sessionExpiresAt:new Date(upload!.expires_at).toISOString(),partBytes:upload!.part_bytes,totalBytes:input.bytes,status:upload!.status},replayed};
 },
 async accessVersion(client,actor,projectId,version){
  const row=(await client.query('SELECT b.connection_id,c.revision FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE b.company_id=$1 AND b.project_id=$2',[actor.companyId,projectId])).rows[0];
  if(!row)fail(404,'Project storage is unavailable.');
  const ticket=await grant(client,actor,projectId,{connectionId:row.connection_id,connection:{revision:row.revision} as ProjectStorageBinding['connection']},version.id,null);
  const file=(await client.query('SELECT name FROM project_storage_files WHERE company_id=$1 AND id=$2',[actor.companyId,version.file_id])).rows[0];
  return {access:{url:ticket.url,headers:{Authorization:'Bearer '+ticket.token},expiresAt:ticket.expiresAt,bytes:Number(version.bytes),name:file.name,sha256:version.verified_sha256,contentType:version.content_type}};
 }
};
