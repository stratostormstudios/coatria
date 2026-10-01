/** Server-owned service authority. No credential opening, provider I/O or public
 * registration. Callers own transactions and repeat authority before commit. */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {fail,id} from './security';
import {verifiedProjectGateway} from './project-gateway-bindings';
import {verifiedImagePreparationServiceEnrollment} from './project-image-preparation-enrollment';
import {imagePreparationEnrollmentCanonical} from './project-image-preparation-enrollment-contract.mjs';
import {IMAGE_PREPARATION_RECIPE_HASH} from './higgsfield-image-preparation';
import {projectImagePreparationProcessorSchema,type ProjectImagePreparationProcessor,type ProjectImagePreparationLease} from './project-image-preparations-protocol';

type Row=Record<string,any>;
export type ImagePreparationServiceIdentity={service:Row;projects:Row[];processor:ProjectImagePreparationProcessor;enrollment:ReturnType<typeof verifiedImagePreparationServiceEnrollment>};
export type ImagePreparationServiceAuthorityOptions={tokenHash?:string;allowExpiredFailure?:boolean};
function ended():never{return fail(403,'This preparation service or exact scope is no longer authorized.','IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED');}
const iso=(v:Date|string)=>new Date(v).toISOString();
const serviceColumns='id,company_id,token_hash,enrolled_by,sponsor_role,location,release_sha256,qualification_sha256,profile_sha256,source_commit,closure_sha256,recipe_sha256,transport,created_at,expires_at,revoked_at,revoked_by,revision,updated_at';
export async function authorizeImagePreparationService(db:PoolClient,serviceId:string,options:ImagePreparationServiceAuthorityOptions={}):Promise<ImagePreparationServiceIdentity>{
 const preview=(await db.query('SELECT company_id,enrolled_by FROM project_image_preparation_services WHERE id=$1',[id(serviceId)])).rows[0];if(!preview)ended();
 if(!(await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[preview.company_id])).rowCount)ended();
 const row=(await db.query(`SELECT ${serviceColumns},to_char(sponsor_joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sponsor_joined_at
  FROM project_image_preparation_services WHERE id=$1 FOR SHARE`,[serviceId])).rows[0];
 if(!row||row.company_id!==preview.company_id||row.enrolled_by!==preview.enrolled_by||options.tokenHash!==undefined&&row.token_hash!==options.tokenHash)ended();
 const cleanup=options.allowExpiredFailure===true;
 if(!(await db.query(`SELECT ${cleanup?"expires_at+interval '10 minutes'":"expires_at"}>clock_timestamp() AS live FROM project_image_preparation_services WHERE id=$1`,[row.id])).rows[0]?.live||!cleanup&&row.revoked_at)ended();
 if(!cleanup&&!(await db.query(`SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role=$3 AND access_revoked_at IS NULL
  AND joined_at=$4::timestamptz FOR SHARE`,[row.company_id,row.enrolled_by,row.sponsor_role,row.sponsor_joined_at])).rowCount)ended();
 const projects=(await db.query('SELECT * FROM project_image_preparation_service_projects WHERE service_id=$1 AND company_id=$2 ORDER BY project_id',[row.id,row.company_id])).rows;
 if(!projects.length||projects.length>32)ended();
 const record=(await db.query('SELECT service_id,company_id,request_id,request_hash,identity FROM project_image_preparation_service_enrollments WHERE service_id=$1 AND company_id=$2',[row.id,row.company_id])).rows[0];
 let enrollment:ReturnType<typeof verifiedImagePreparationServiceEnrollment>;
 try{enrollment=verifiedImagePreparationServiceEnrollment(row,projects,record);}catch{return ended();}
 const parsed=projectImagePreparationProcessorSchema.safeParse({id:row.id,location:row.location,qualificationSha256:row.qualification_sha256,releaseSha256:row.release_sha256,profileSha256:row.profile_sha256,sourceCommit:row.source_commit,closureSha256:row.closure_sha256,transport:row.transport,recipeSha256:row.recipe_sha256,expiresAt:iso(row.expires_at)});
 if(!parsed.success||parsed.data.transport!=='linux_binary_v1'||parsed.data.recipeSha256!==IMAGE_PREPARATION_RECIPE_HASH)ended();
 return {service:row,projects,processor:parsed.data,enrollment};
}
/** Enrollment binds logical routing. Catalog revisions belong to each explicit
 * preparation, including exactly its recorded allocation increment; an old
 * service revision is never substituted for the preparation's own facts. */
export async function authorizeImagePreparationServiceProject(db:PoolClient,identity:ImagePreparationServiceIdentity,projectId:string,options:{preparationId?:string}={}):Promise<Row>{
 const s=identity.service,p=identity.projects.find(p=>p.project_id===projectId);if(!p)ended();
 const project=(await db.query('SELECT revision,status,ai_policy,production_path,contract_version,gates FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE',[s.company_id,id(projectId)])).rows[0];
 if(!project||project.status==='delivered'||project.ai_policy!=='allowed'||project.production_path!=='higgsfield'||project.contract_version!==2||['brief','estimate','production'].some(g=>project.gates?.[g]?.decision!=='approved'))ended();
 const storage=(await db.query(`SELECT b.id,b.revision,b.connection_id,c.revision AS connection_revision,c.status,m.role,m.access_revoked_at
  FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id
  JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.created_by
  WHERE b.company_id=$1 AND b.project_id=$2 FOR SHARE OF b,c,m`,[s.company_id,projectId])).rows[0];
 if(!storage||storage.id!==p.storage_binding_id||storage.connection_id!==p.storage_connection_id||storage.connection_revision!==p.storage_connection_revision||storage.status!=='configured'||storage.access_revoked_at||!['owner','admin'].includes(storage.role))ended();
 if(options.preparationId){
  const r=(await db.query(`SELECT p.storage_binding_id,p.storage_binding_revision,p.storage_connection_id,p.storage_connection_revision,
   a.binding_revision_before,a.binding_revision_after FROM project_image_preparations p LEFT JOIN project_image_preparation_allocations a ON a.company_id=p.company_id AND a.project_id=p.project_id AND a.preparation_id=p.id
   WHERE p.company_id=$1 AND p.project_id=$2 AND p.id=$3`,[s.company_id,projectId,id(options.preparationId)])).rows[0];
  if(!r||r.storage_binding_id!==p.storage_binding_id||r.storage_connection_id!==p.storage_connection_id||r.storage_connection_revision!==p.storage_connection_revision||!(storage.revision===r.storage_binding_revision||r.binding_revision_before===r.storage_binding_revision&&r.binding_revision_after===r.storage_binding_revision+1&&storage.revision===r.binding_revision_after))ended();
 }
 const gateway=await verifiedProjectGateway(db,s.company_id,projectId);
 if(!gateway||gateway.bindingId!==p.gateway_binding_id||gateway.provisionId!==p.gateway_provision_id||gateway.configurationHash!==p.gateway_configuration_sha256||gateway.origin!==p.gateway_origin||gateway.expiresAt!==iso(p.gateway_expires_at))ended();
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp() AS live',[s.expires_at,p.gateway_expires_at])).rows[0]?.live)ended();
 return {...p,gateway};
}
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const leaseSchema=z.object({companyId:uuid,projectId:uuid,preparationId:uuid,leaseId:uuid,requestHash:sha,expiresAt:z.string().datetime({offset:true}),claimedAt:z.string().datetime({offset:true}),recipeSha256:sha,
 source:z.object({versionId:uuid,fileId:uuid,name:z.string().min(1),version:z.number().int().positive(),bytes:z.number().int().positive().max(33554432),sha256:sha,contentType:z.enum(['image/png','image/jpeg','image/webp'])}).strict(),processor:projectImagePreparationProcessorSchema}).strict();
export async function authorizeImagePreparationServiceLease(db:PoolClient,identity:ImagePreparationServiceIdentity,input:{preparationId:string;leaseId:string},options:{allowExpiredFailure?:boolean}={}):Promise<ProjectImagePreparationLease>{
 // Never accept an arbitrary client lease or a stale cached identity.
 const current=await authorizeImagePreparationService(db,identity.service.id,{allowExpiredFailure:options.allowExpiredFailure});
 if(current.service.company_id!==identity.service.company_id||imagePreparationEnrollmentCanonical(current.processor)!==imagePreparationEnrollmentCanonical(identity.processor))ended();
 const row=(await db.query('SELECT * FROM project_image_preparation_service_leases WHERE service_id=$1 AND company_id=$2 AND preparation_id=$3 AND lease_id=$4',[current.service.id,current.service.company_id,id(input.preparationId),id(input.leaseId)])).rows[0];
 const parsed=leaseSchema.safeParse(row?.lease);if(!parsed.success)ended();const lease=parsed.data;
 if(row.project_id!==lease.projectId||lease.companyId!==current.service.company_id||lease.preparationId!==input.preparationId||lease.leaseId!==input.leaseId||row.request_hash!==lease.requestHash||lease.recipeSha256!==current.processor.recipeSha256||imagePreparationEnrollmentCanonical(lease.processor)!==imagePreparationEnrollmentCanonical(current.processor))ended();
 const preparation=(await db.query('SELECT lease_id,request_hash,lease_expires_at,revoked_at FROM project_image_preparations WHERE company_id=$1 AND project_id=$2 AND id=$3',[lease.companyId,lease.projectId,lease.preparationId])).rows[0];
 if(!preparation||preparation.lease_id!==lease.leaseId||preparation.request_hash!==lease.requestHash||iso(preparation.lease_expires_at)!==lease.expiresAt)ended();
 if(!options.allowExpiredFailure){if(preparation.revoked_at||!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[lease.expiresAt])).rows[0]?.live)ended();await authorizeImagePreparationServiceProject(db,current,lease.projectId,{preparationId:lease.preparationId});}
 return lease;
}
/** Database-only resolver for the existing M2 callback. A production caller
 * separately preflights its dedicated broker before exposing availability. */
export async function resolveProjectImagePreparationProcessor(db:PoolClient,companyId:string,projectId:string,processorId?:string):Promise<ProjectImagePreparationProcessor|null>{
 const candidates=(await db.query(`SELECT s.id FROM project_image_preparation_services s JOIN project_image_preparation_service_projects p ON p.service_id=s.id AND p.company_id=s.company_id
  WHERE s.company_id=$1 AND p.project_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND ($3::uuid IS NULL OR s.id=$3)
  ORDER BY s.created_at DESC,s.id LIMIT 10`,[id(companyId),id(projectId),processorId===undefined?null:id(processorId)])).rows;
 for(const candidate of candidates){try{const identity=await authorizeImagePreparationService(db,candidate.id);await authorizeImagePreparationServiceProject(db,identity,projectId);return identity.processor;}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED')throw error;}}
 return null;
}
