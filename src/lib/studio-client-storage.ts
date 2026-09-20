/** Server-only external recipient capabilities. These never grant membership,
 * agent storage access, a provider URL, or authority over another file version. */
import type {PoolClient} from 'pg';
import {fail,hashToken,id,secret} from './security';
import {storageGatewayOrigin} from './project-storage-config';
import type {StudioGeneratedClientAccess} from './studio-client-delivery-protocol';

type Row=Record<string,any>;
const unavailable=():never=>fail(403,'This client file access is unavailable. Request access again from the client portal.','CLIENT_STORAGE_UNAVAILABLE');

/** Run only inside a transaction. Shares pin immutable, independently checked
 * artifact facts at issuance; the gateway checks the exact current source and
 * storage lifecycle without reading prompts, manifests, locators or journals. */
async function currentFile(db:PoolClient,shareId:string,recipientUserId:string,versionId:string){
 const located=(await db.query('SELECT company_id,project_id FROM studio_client_deliveries WHERE id=$1 AND recipient_user_id=$2',[shareId,recipientUserId])).rows[0];if(!located)return unavailable();
 const companyId=located.company_id,projectId=located.project_id;
 await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[companyId]);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`invite:${companyId}:${recipientUserId}`]);
 if((await db.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2',[companyId,recipientUserId])).rowCount)return unavailable();
 const sponsor=(await db.query("SELECT m.user_id FROM studio_client_deliveries s JOIN memberships m ON m.company_id=s.company_id AND m.user_id=s.created_by WHERE s.id=$1 AND m.role IN ('owner','admin') FOR SHARE OF m",[shareId])).rows[0];if(!sponsor)return unavailable();
 // Project precedes share, matching client acknowledgement and API issuance.
 const project=(await db.query('SELECT contract_version,production_path,ai_policy,gates FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,projectId])).rows[0];
 if(!project||project.contract_version!==2||project.production_path!=='higgsfield'||project.ai_policy!=='allowed'||project.gates?.production?.decision!=='approved')return unavailable();
 const share=(await db.query('SELECT id,company_id,project_id,recipient_user_id,status,package_hash,expires_at FROM studio_client_deliveries WHERE id=$1 AND recipient_user_id=$2 FOR SHARE',[shareId,recipientUserId])).rows[0];
 if(!share||share.status!=='active'||share.company_id!==companyId||share.project_id!==projectId)return unavailable();
 const source=(await db.query(`SELECT f.artifact_id,f.review_id,f.storage_name AS name,f.storage_sha256 AS sha256,f.storage_bytes::float8 AS bytes,f.storage_content_type AS content_type,
  s.archive_id,s.request_id,s.job_id,s.output_id,s.storage_version_id,s.archive_approved_by
  FROM studio_client_delivery_files f JOIN studio_generated_artifact_sources s ON s.company_id=f.company_id AND s.project_id=f.project_id AND s.artifact_id=f.artifact_id AND s.storage_version_id=f.storage_version_id
  WHERE f.company_id=$1 AND f.project_id=$2 AND f.share_id=$3 AND f.file_id=$4 AND f.storage_version_id=$4
  AND s.file_facts->>'sha256'=f.storage_sha256 AND (s.file_facts->>'bytes')::bigint=f.storage_bytes AND s.file_facts->>'contentType'=f.storage_content_type`,[companyId,projectId,shareId,versionId])).rows[0];if(!source)return unavailable();
 const approved=(await db.query(`SELECT a.id FROM studio_artifacts a JOIN studio_reviews r ON r.company_id=a.company_id AND r.project_id=a.project_id AND r.artifact_id=a.id
  WHERE a.company_id=$1 AND a.project_id=$2 AND a.id=$3 AND r.id=$4 AND r.decision='approved' AND r.technical_qc=true
  AND a.id=(SELECT latest.id FROM studio_artifacts latest WHERE latest.company_id=a.company_id AND latest.project_id=a.project_id AND latest.work_item_id=a.work_item_id ORDER BY latest.version DESC LIMIT 1)
  AND r.id=(SELECT latest.id FROM studio_reviews latest WHERE latest.company_id=a.company_id AND latest.project_id=a.project_id AND latest.artifact_id=a.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)`,[companyId,projectId,source.artifact_id,source.review_id])).rows[0];if(!approved)return unavailable();
 const tasks=(await db.query('SELECT t.status FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=$2 FOR SHARE OF t',[companyId,projectId])).rows;
 if(!tasks.length||tasks.some(t=>t.status!=='done'))return unavailable();
 const archive=(await db.query(`SELECT id,request_id,job_id,output_id,version_id,upload_id,locator_identity,approved_by,provider_connection_id,storage_binding_id,storage_connection_id,storage_connection_snapshot,status,revoked_at
  FROM higgsfield_output_archives WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`,[companyId,projectId,source.archive_id])).rows[0];
 if(!archive||archive.status!=='verified'||archive.revoked_at||archive.request_id!==source.request_id||archive.job_id!==source.job_id||archive.output_id!==source.output_id||archive.version_id!==versionId||archive.approved_by!==source.archive_approved_by)return unavailable();
 const job=(await db.query(`SELECT j.id FROM higgsfield_jobs j JOIN higgsfield_requests r ON r.company_id=j.company_id AND r.project_id=j.project_id AND r.id=j.request_id
  JOIN higgsfield_job_outputs o ON o.company_id=j.company_id AND o.project_id=j.project_id AND o.job_id=j.id
  WHERE j.company_id=$1 AND j.project_id=$2 AND j.id=$3 AND r.id=$4 AND o.id=$5 AND j.status='completed' AND r.status='returned'
  AND j.connection_id=$6 AND r.connection_id=$6 AND o.locator_identity=$7 FOR SHARE OF j,r`,[companyId,projectId,source.job_id,source.request_id,source.output_id,archive.provider_connection_id,archive.locator_identity])).rows[0];if(!job)return unavailable();
 const stored=(await db.query(`SELECT v.id,v.file_id,v.bytes::float8 AS bytes,v.sha256,v.content_type,ok.provider_etag
  FROM project_storage_versions v JOIN project_storage_verifications ok ON ok.company_id=v.company_id AND ok.project_id=v.project_id AND ok.version_id=v.id
  JOIN project_storage_uploads u ON u.company_id=v.company_id AND u.project_id=v.project_id AND u.version_id=v.id
  JOIN higgsfield_archive_fetches af ON af.company_id=v.company_id AND af.project_id=v.project_id AND af.archive_id=u.archive_id
  WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3 AND u.id=$4 AND u.archive_id=$5 AND u.status='ready' AND u.action_id IS NULL
  AND u.actor_key='archive:'||$5::text AND u.actor_user_id=$6 AND u.actor_agent_id IS NULL AND u.run_id IS NULL
  AND af.locator_identity=$7 AND af.bytes=v.bytes AND af.sha256=v.sha256 AND ok.bytes=v.bytes AND ok.sha256=v.sha256 AND ok.provider_etag=u.provider_etag FOR SHARE OF u`,[companyId,projectId,versionId,archive.upload_id,source.archive_id,source.archive_approved_by,archive.locator_identity])).rows[0];
 if(!stored||stored.bytes!==source.bytes||stored.sha256!==source.sha256||stored.content_type!==source.content_type)return unavailable();
 // Folder/file writers take connection -> binding -> file. A joined LockRows
 // query can lock file first despite its FOR SHARE list, producing a cycle
 // with a writer that already owns the binding. Acquire these locks explicitly.
 if(!(await db.query('SELECT id FROM project_storage_connections WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,archive.storage_connection_id])).rowCount)return unavailable();
 if(!(await db.query('SELECT id FROM project_storage_bindings WHERE company_id=$1 AND project_id=$2 AND id=$3 AND connection_id=$4 FOR SHARE',[companyId,projectId,archive.storage_binding_id,archive.storage_connection_id])).rowCount)return unavailable();
 const storage=(await db.query(`SELECT b.id AS binding_id,b.connection_id,c.revision,c.created_by,c.region,c.volume_id,c.status,c.provider,c.secret_envelope IS NOT NULL AS configured
  FROM project_storage_files f JOIN project_storage_bindings b ON b.company_id=f.company_id AND b.project_id=f.project_id AND b.id=f.binding_id
  JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE f.company_id=$1 AND f.project_id=$2 AND f.id=$3 FOR SHARE OF f`,[companyId,projectId,stored.file_id])).rows[0];
 const snapshot=archive.storage_connection_snapshot;
 if(!storage||storage.binding_id!==archive.storage_binding_id||storage.connection_id!==archive.storage_connection_id||storage.status!=='configured'||!storage.configured||storage.provider!=='runpod'||snapshot?.id!==storage.connection_id||snapshot?.region!==storage.region||snapshot?.volumeId!==storage.volume_id)return unavailable();
 if(!(await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[companyId,storage.created_by])).rowCount)return unavailable();
 return {share,companyId,projectId,versionId,connectionId:storage.connection_id as string,connectionRevision:storage.revision as number,name:source.name as string,bytes:stored.bytes as number,sha256:stored.sha256 as string,contentType:stored.content_type as string,etag:stored.provider_etag as string};
}

/** Fresh DB time AFTER all authority locks, never host-clock authority. */
async function deadline(db:PoolClient,shareId:string,expiresAt?:string|Date){
 const row=(await db.query(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
  SELECT greatest(0,floor(extract(epoch FROM (least(s.expires_at,coalesce($2::timestamptz,s.expires_at))-instant.at))*1000))::float8 AS remaining
  FROM studio_client_deliveries s CROSS JOIN instant WHERE s.id=$1 AND s.status='active'`,[shareId,expiresAt??null])).rows[0];
 if(!row||row.remaining<=0)return unavailable();return row.remaining as number;
}

export async function issueStudioClientStorageAccess(db:PoolClient,input:{shareId:string;recipientUserId:string;versionId:string}):Promise<StudioGeneratedClientAccess>{
 const shareId=id(input.shareId),recipientUserId=id(input.recipientUserId),versionId=id(input.versionId),gatewayOrigin=storageGatewayOrigin();if(!gatewayOrigin)fail(503,'The private file transfer service is unavailable.','STORAGE_GATEWAY_UNAVAILABLE');
 const current=await currentFile(db,shareId,recipientUserId,versionId),token=secret('sct_');
 // The invitation advisory lock also serializes this cap, including API receipt
 // replays that intentionally issue a fresh token rather than storing secrets.
 const live=(await db.query('SELECT count(*)::int AS count FROM studio_client_storage_grants WHERE company_id=$1 AND share_id=$2 AND recipient_user_id=$3 AND expires_at>clock_timestamp()',[current.companyId,shareId,recipientUserId])).rows[0].count;
 if(live>=256)fail(429,'Wait for existing client file access windows to expire.','CLIENT_STORAGE_GRANT_LIMIT');
 const grant=(await db.query(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
  INSERT INTO studio_client_storage_grants(company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,token_hash,created_at,expires_at)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,instant.at,least($10::timestamptz,instant.at+interval '60 seconds') FROM instant WHERE $10::timestamptz>instant.at RETURNING expires_at`,[current.companyId,current.projectId,shareId,recipientUserId,versionId,current.connectionId,current.connectionRevision,current.share.package_hash,hashToken(token),current.share.expires_at])).rows[0];if(!grant)return unavailable();
 await deadline(db,shareId,grant.expires_at);
 return {transport:'project_storage',storageVersionId:versionId,gatewayOrigin,url:`${gatewayOrigin}/v1/client-files/${versionId}`,headers:{Authorization:'Bearer '+token},expiresAt:new Date(grant.expires_at).toISOString(),bytes:current.bytes,name:current.name,sha256:current.sha256,contentType:current.contentType,status:'download_access_issued',bytesReceivedByClient:'not_observed'};
}

/** Gateway-only opaque capability lookup. Raw tokens never enter SQL or logs. */
export async function authorizeStudioClientStorageGrant(db:PoolClient,token:string,versionId:string){
 if(!/^sct_[A-Za-z0-9_-]{43}$/.test(token))return unavailable();
 // Cheap expired-token rejection first; the decisive clock sample still runs
 // after every authority lock below, including waits for a concurrent writer.
 const grant=(await db.query('SELECT company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,expires_at FROM studio_client_storage_grants WHERE token_hash=$1 AND expires_at>clock_timestamp()',[hashToken(token)])).rows[0];
 if(!grant||grant.storage_version_id!==versionId)return unavailable();
 const current=await currentFile(db,grant.share_id,grant.recipient_user_id,versionId);
 if(current.companyId!==grant.company_id||current.projectId!==grant.project_id||current.connectionId!==grant.connection_id||current.connectionRevision!==grant.connection_revision||current.share.package_hash!==grant.package_hash)return unavailable();
 const remainingMs=await deadline(db,grant.share_id,grant.expires_at);return {...current,remainingMs};
}
