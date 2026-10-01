import type {PoolClient} from 'pg';
import {parseImagePreparationEnrollmentRequest,imagePreparationEnrollmentHash,imagePreparationEnrollmentCanonical,imagePreparationEnrollmentServiceIdentity,imagePreparationEnrollmentProjectIdentity,imagePreparationEnrollmentLockKey,imagePreparationEnrollmentFailure} from './project-image-preparation-enrollment-contract.mjs';
import {verifiedImagePreparationGateway} from './project-image-preparation-gateway-binding';
import {IMAGE_PREPARATION_RECIPE_HASH} from './higgsfield-image-preparation';

/** Registrar evidence authenticates an immutable DB record, not a remote host.
 * Actual Linux binary qualification is separately required by host enrollment. */
export function verifiedImagePreparationServiceEnrollment(service:Record<string,any>,projects:Record<string,any>[],enrollment:Record<string,any>|undefined){
 if(!enrollment)throw Error('IMAGE_PREPARATION_SERVICE_ENROLLMENT_REQUIRED');
 const identity=parseImagePreparationEnrollmentRequest(enrollment.identity,{allowExpired:true});
 const normalized=projects.map(p=>({...p,gateway_expires_at:new Date(p.gateway_expires_at).toISOString()}));
 if(enrollment.service_id!==service.id||enrollment.company_id!==service.company_id||enrollment.request_id!==identity.requestId||enrollment.request_hash!==imagePreparationEnrollmentHash(identity)
  ||Object.entries(imagePreparationEnrollmentServiceIdentity(identity)).some(([key,value])=>service[key]!==value)
  ||new Date(service.expires_at).toISOString()!==identity.expiresAt
  ||imagePreparationEnrollmentCanonical(normalized)!==imagePreparationEnrollmentCanonical(imagePreparationEnrollmentProjectIdentity(identity)))throw Error('IMAGE_PREPARATION_SERVICE_ENROLLMENT_REQUIRED');
 return identity;
}

async function existing(db:PoolClient,request:ReturnType<typeof parseImagePreparationEnrollmentRequest>){
 const row=(await db.query(`SELECT *,to_char(sponsor_joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sponsor_joined_at FROM project_image_preparation_services WHERE id=$1`,[request.serviceId])).rows[0];
 const enrollment=(await db.query('SELECT service_id,company_id,request_id,request_hash,identity FROM project_image_preparation_service_enrollments WHERE service_id=$1 OR (company_id=$2 AND request_id=$3)',[request.serviceId,request.companyId,request.requestId])).rows;
 if(!row&&!enrollment.length)return null;
 if(!row||enrollment.length!==1)imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_CONFLICT');
 const projects=(await db.query('SELECT * FROM project_image_preparation_service_projects WHERE service_id=$1 ORDER BY project_id',[request.serviceId])).rows;
 let verified;try{verified=verifiedImagePreparationServiceEnrollment(row,projects,enrollment[0]);}catch{imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_CONFLICT');}
 if(imagePreparationEnrollmentHash(verified)!==imagePreparationEnrollmentHash(request))imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_CONFLICT');
 return {serviceId:request.serviceId,requestHash:imagePreparationEnrollmentHash(request),status:'committed' as const,replayed:true};
}
/** Read-only historical reconciliation. Never retries enrollment or extends time. */
export async function reconcileImagePreparationServiceEnrollment(db:PoolClient,input:unknown){
 const request=parseImagePreparationEnrollmentRequest(input,{allowExpired:true});
 return await existing(db,request)??{serviceId:request.serviceId,requestHash:imagePreparationEnrollmentHash(request),status:'absent' as const,replayed:false};
}
/** Dedicated registrar only, caller-owned transaction. The host installer must
 * already have verified the real qualification receipt. This function records
 * that exact inert identity; it cannot activate, approve, claim or transform. */
export async function enrollImagePreparationService(db:PoolClient,input:unknown){
 const r=parseImagePreparationEnrollmentRequest(input);if(r.recipeSha256!==IMAGE_PREPARATION_RECIPE_HASH)imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_RECIPE_CHANGED');
 if(!(await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[r.companyId])).rowCount)imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_AUTHORITY_ENDED');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[imagePreparationEnrollmentLockKey(r)]);
 const prior=await existing(db,r);if(prior)return prior;
 if(!(await db.query(`SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role=$3 AND joined_at=$4::timestamptz AND access_revoked_at IS NULL FOR SHARE`,[r.companyId,r.enrolledBy,r.enroller.role,r.enroller.joinedAt])).rowCount)imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_AUTHORITY_ENDED');
 for(const p of [...r.projects].sort((a,b)=>a.projectId.localeCompare(b.projectId))){
  const project=(await db.query('SELECT revision,status,production_path,ai_policy,contract_version,gates FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE',[r.companyId,p.projectId])).rows[0];
  if(!project||project.revision!==p.projectRevision||project.status==='delivered'||project.production_path!=='higgsfield'||project.ai_policy!=='allowed'||project.contract_version!==2||['brief','estimate','production'].some(g=>project.gates?.[g]?.decision!=='approved'))imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_AUTHORITY_ENDED');
  const storage=(await db.query(`SELECT b.id,b.revision,b.connection_id,c.revision AS connection_revision,c.status,m.role,m.access_revoked_at FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.created_by WHERE b.company_id=$1 AND b.project_id=$2 FOR SHARE OF b,c,m`,[r.companyId,p.projectId])).rows[0];
  if(!storage||storage.id!==p.storageBindingId||storage.revision!==p.storageBindingRevision||storage.connection_id!==p.storageConnectionId||storage.connection_revision!==p.storageConnectionRevision||storage.status!=='configured'||storage.access_revoked_at||!['owner','admin'].includes(storage.role))imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_AUTHORITY_ENDED');
  const gateway=await verifiedImagePreparationGateway(db,r.companyId,p.projectId);
  if(!gateway||gateway.bindingId!==p.gateway.bindingId||gateway.provisionId!==p.gateway.provisionId||gateway.configurationHash!==p.gateway.configurationSha256||gateway.origin!==p.gateway.origin||gateway.expiresAt!==p.gateway.expiresAt)imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_GATEWAY_CHANGED');
 }
 const insert=async(table:string,value:Record<string,unknown>)=>{const columns=Object.keys(value);await db.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(value));};
 await insert('project_image_preparation_services',{...imagePreparationEnrollmentServiceIdentity(r),expires_at:r.expiresAt});
 for(const project of imagePreparationEnrollmentProjectIdentity(r))await insert('project_image_preparation_service_projects',project);
 await insert('project_image_preparation_service_enrollments',{service_id:r.serviceId,company_id:r.companyId,request_id:r.requestId,request_hash:imagePreparationEnrollmentHash(r),identity:JSON.stringify(r)});
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[r.expiresAt])).rows[0]?.live)imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_EXPIRED');
 return {serviceId:r.serviceId,requestHash:imagePreparationEnrollmentHash(r),status:'committed' as const,replayed:false};
}
