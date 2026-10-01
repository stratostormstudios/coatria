/** Private metadata control. No provider I/O, credential opening, default DB
 * connection or activation. The injected transaction owns every commit. */
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {ApiError,fail,hashToken,secret} from './security';
import {imagePreparationEnrollmentCanonical as canonical} from './project-image-preparation-enrollment-contract.mjs';
import {authorizeImagePreparationService,authorizeImagePreparationServiceProject,authorizeImagePreparationServiceLease,resolveProjectImagePreparationProcessor,type ImagePreparationServiceIdentity} from './project-image-preparation-service-authority';
import {authorizeProjectImagePreparation,claimProjectImagePreparation,beginProjectImagePreparationPhase,completeProjectImagePreparationPhase,failProjectImagePreparation,type ProjectImagePreparationOptions} from './project-image-preparations';
import {reserveProjectImagePreparationOutput,beginProjectImagePreparationStore,completeProjectImagePreparationStore,publishProjectImagePreparation} from './project-image-preparation-storage';
import type {ProjectImagePreparationLease} from './project-image-preparations-protocol';
import {PREPARATION_SERVICE_MAX_JSON_BYTES,preparationServiceUuid,preparationServiceToken,preparationServiceRequests,preparationServiceResponses,preparationByteCapabilitySchema,preparationServiceSourceSchema,type PreparationServiceOperation} from './project-image-preparation-service-protocol';

type Row=Record<string,any>;
type Transaction=<T>(run:(db:PoolClient)=>Promise<T>)=>Promise<T>;
type ResponseFor<K extends PreparationServiceOperation>=z.infer<(typeof preparationServiceResponses)[K]>;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const iso=(value:Date|string)=>new Date(value).toISOString();
const invalid=():never=>fail(400,'Invalid preparation service request.','IMAGE_PREPARATION_SERVICE_INPUT_INVALID');
const uncertain=():never=>fail(409,'This request has a retained outcome. Reconcile it without repeating work.','IMAGE_PREPARATION_SERVICE_RECONCILIATION_REQUIRED');
const changed=():never=>fail(409,'The exact completed byte evidence is unavailable or changed.','IMAGE_PREPARATION_SERVICE_BYTES_CHANGED');

export function createImagePreparationControlService({transaction}:{transaction:Transaction}){
 if(typeof transaction!=='function')throw Error('IMAGE_PREPARATION_SERVICE_CONFIGURATION_INVALID');
 return {async execute<K extends PreparationServiceOperation>(serviceId:string,token:string,operation:K,input:unknown,{signal}:{signal?:AbortSignal}={}):Promise<ResponseFor<K>>{
  if(!preparationServiceUuid.safeParse(serviceId).success||!preparationServiceToken.safeParse(token).success||!Object.hasOwn(preparationServiceRequests,operation))invalid();
  let serialized:string;try{serialized=JSON.stringify(input);}catch{return invalid();}
  if(typeof serialized!=='string'||Buffer.byteLength(serialized)>PREPARATION_SERVICE_MAX_JSON_BYTES)invalid();
  const parsed=preparationServiceRequests[operation].safeParse(input);if(!parsed.success)invalid();const args=parsed.data as Row,deadline=Date.parse(args.deadlineAt);
  const current=()=>{if(signal?.aborted)fail(409,'This service request was cancelled.','IMAGE_PREPARATION_SERVICE_ABORTED');if(Date.now()>=deadline)fail(409,'This service request deadline ended.','IMAGE_PREPARATION_SERVICE_DEADLINE');};
  current();if(deadline-Date.now()>30000)invalid();
  const requestHash=hashToken(canonical({operation,input:args})),tokenHash=hashToken(token),cleanup=operation==='fail';
  const fence=async(db:PoolClient)=>{current();if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[args.deadlineAt])).rows[0]?.live)fail(409,'This service request deadline ended.','IMAGE_PREPARATION_SERVICE_DEADLINE');current();};
  const identity=async(db:PoolClient)=>{
   await fence(db);
   // Only an unlocked identity preview precedes the company mutex. Waiting
   // while retaining service/sponsor locks can deadlock a concurrent revoker.
   // Retrying this read-only probe cannot replay a transition or an intent.
   const preview=(await db.query('SELECT company_id,token_hash FROM project_image_preparation_services WHERE id=$1',[serviceId])).rows[0];
   if(!preview||preview.token_hash!==tokenHash)fail(403,'This preparation service or exact scope is no longer authorized.','IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED');
   const waitUntil=Math.min(deadline,Date.now()+2000);
   while(!(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['project-image-preparation:'+preview.company_id])).rows[0]?.acquired){
    current();if(Date.now()>=waitUntil)fail(409,'Another preparation operation is committing.','IMAGE_PREPARATION_BUSY');await delay(Math.min(25,waitUntil-Date.now()));
   }
   await fence(db);const identity=await authorizeImagePreparationService(db,serviceId,{tokenHash,allowExpiredFailure:cleanup});
   if(identity.service.company_id!==preview.company_id)changed();
   await fence(db);return identity;
  };
  const runtime=(identity:ImagePreparationServiceIdentity):ProjectImagePreparationOptions=>({runtime:async(db,companyId,projectId,processorId)=>{
   if(companyId!==identity.service.company_id||!identity.projects.some(p=>p.project_id===projectId)||processorId!==undefined&&processorId!==serviceId)return null;
   return resolveProjectImagePreparationProcessor(db,companyId,projectId,serviceId);
  }});
  const leaseFor=(db:PoolClient,identity:ImagePreparationServiceIdentity)=>authorizeImagePreparationServiceLease(db,identity,{preparationId:args.preparationId,leaseId:args.leaseId},{allowExpiredFailure:cleanup});
  const scope=async(db:PoolClient,identity:ImagePreparationServiceIdentity)=>{for(const p of identity.projects)await authorizeImagePreparationServiceProject(db,identity,p.project_id);};
  const active=async(db:PoolClient,identity:ImagePreparationServiceIdentity,lease:ProjectImagePreparationLease)=>authorizeProjectImagePreparation(db,lease,runtime(identity));
  async function finalAuthority(db:PoolClient,auth:ImagePreparationServiceIdentity,lease?:ProjectImagePreparationLease){
   const fresh=await authorizeImagePreparationService(db,serviceId,{tokenHash,allowExpiredFailure:cleanup});
   if(lease){await authorizeImagePreparationServiceLease(db,fresh,lease,{allowExpiredFailure:cleanup});if(!cleanup&&operation!=='publish')await active(db,fresh,lease);}
   else if(!cleanup)await scope(db,fresh);
   current();
   // Row locks preserve identities, not clocks. One final nonlocking statement
   // fences all deadlines after any preceding authority query had to wait.
   const live=(await db.query(`SELECT $2::timestamptz>clock_timestamp()
    AND s.expires_at+CASE WHEN $3::boolean THEN interval '10 minutes' ELSE interval '0 seconds' END>clock_timestamp()
    AND ($3 OR (s.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM project_image_preparation_service_projects p
     WHERE p.service_id=s.id AND ($4::uuid IS NULL OR p.project_id=$4) AND p.gateway_expires_at<=clock_timestamp())
     AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM project_image_preparations p JOIN project_image_preparation_approvals a
      ON a.company_id=p.company_id AND a.preparation_id=p.id WHERE p.company_id=s.company_id AND p.id=$5 AND p.lease_id=$6
       AND p.revoked_at IS NULL AND p.lease_expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()
       AND (a.processor_snapshot->>'expiresAt')::timestamptz>clock_timestamp())))) AS live
    FROM project_image_preparation_services s WHERE s.id=$1`,[serviceId,args.deadlineAt,cleanup,lease?.projectId??null,lease?.preparationId??null,lease?.leaseId??null])).rows[0]?.live;
   if(!live)fail(403,'This preparation service or exact scope is no longer authorized.','IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED');current();
  }
  async function replay(db:PoolClient,identity:ImagePreparationServiceIdentity,old:Row):Promise<Row>{
   if(old.operation!==operation||old.request_hash!==requestHash)fail(409,'This request ID belongs to different inputs.','IDEMPOTENCY_CONFLICT');
   if(old.status!=='completed'||operation==='byte-capability')uncertain();
   let currentLease:ProjectImagePreparationLease|undefined;
   if(operation==='readiness'||operation==='claim'){
    await scope(db,identity);
    if(operation==='claim'&&old.response?.lease){currentLease=await authorizeImagePreparationServiceLease(db,identity,old.response.lease);await active(db,identity,currentLease);}
   }else{
    const lease=await leaseFor(db,identity);currentLease=lease;
    if(operation!=='fail'&&operation!=='publish')await active(db,identity,lease);
    if(operation==='publish'){
     const row=(await db.query(`SELECT p.status,p.revoked_at,a.approver_snapshot,a.approved_by,m.role,m.access_revoked_at,
      m.joined_at::text AS joined_at
      FROM project_image_preparations p JOIN project_image_preparation_approvals a ON a.company_id=p.company_id AND a.preparation_id=p.id
      JOIN memberships m ON m.company_id=a.company_id AND m.user_id=a.approved_by
      WHERE p.company_id=$1 AND p.id=$2 FOR SHARE OF p,m`,[lease.companyId,lease.preparationId])).rows[0];
     if(!row||row.status!=='ready'||row.revoked_at||row.access_revoked_at||!same(row.approver_snapshot,{userId:row.approved_by,role:row.role,joinedAt:row.joined_at}))changed();
    }
   }
   const response=preparationServiceResponses[operation].safeParse(old.response);if(!response.success)return uncertain();await finalAuthority(db,identity,currentLease);return response.data;
  }
  async function byteResult(db:PoolClient,lease:ProjectImagePreparationLease,byteOperation:string,actionId?:string){
   // Completed gateway evidence is immutable. Control has SELECT only, never
   // UPDATE/DELETE authority on byte results; the company lock fences cascades.
   const row=(await db.query(`SELECT g.*,r.status AS result_status,r.public_result,r.provider_result,r.observed_bytes,r.observed_sha256,r.observed_etag
    FROM project_image_preparation_byte_grants g JOIN project_image_preparation_byte_results r ON r.grant_id=g.id
    WHERE g.service_id=$1 AND g.company_id=$2 AND g.project_id=$3 AND g.preparation_id=$4 AND g.lease_id=$5 AND g.operation=$6
     AND g.request_hash=$7 AND g.action_id IS NOT DISTINCT FROM $8::uuid`,[serviceId,lease.companyId,lease.projectId,lease.preparationId,lease.leaseId,byteOperation,lease.requestHash,actionId??null])).rows[0];
   if(!row||row.result_status!=='completed')changed();return row;
  }
  try{
   const admission=await transaction(async db=>{
    const auth=await identity(db),old=(await db.query('SELECT * FROM project_image_preparation_service_calls WHERE service_id=$1 AND request_id=$2 FOR UPDATE',[serviceId,args.requestId])).rows[0];
    if(old)return {replayed:true,response:await replay(db,auth,old)};
    if(operation==='readiness'||operation==='claim')await scope(db,auth);else {const lease=await leaseFor(db,auth);if(!cleanup)await active(db,auth,lease);}
    if(!cleanup&&Number((await db.query('SELECT count(*) AS n FROM project_image_preparation_service_calls WHERE service_id=$1',[serviceId])).rows[0].n)>=1000)fail(429,'This finite service reached its request allowance.','IMAGE_PREPARATION_SERVICE_CALL_LIMIT');
    await db.query("INSERT INTO project_image_preparation_service_calls(service_id,request_id,operation,request_hash,deadline_at,status) VALUES($1,$2,$3,$4,$5,'started')",[serviceId,args.requestId,operation,requestHash,args.deadlineAt]);
    await fence(db);return {replayed:false,response:undefined};
   });
   if(admission.replayed)return admission.response as ResponseFor<K>;
   return await transaction(async db=>{
    const auth=await identity(db),call=(await db.query('SELECT * FROM project_image_preparation_service_calls WHERE service_id=$1 AND request_id=$2 FOR UPDATE',[serviceId,args.requestId])).rows[0];
    if(!call||call.status!=='started'||call.operation!==operation||call.request_hash!==requestHash)uncertain();
    let response:Row,stored:Row|undefined,lease:ProjectImagePreparationLease|undefined;
    const options=runtime(auth);
    if(operation==='readiness'){
     await scope(db,auth);response={readiness:{serviceId,companyId:auth.service.company_id,projectIds:auth.projects.map(p=>p.project_id),processor:auth.processor,expiresAt:iso(auth.service.expires_at)}};
    }else if(operation==='claim'){
     await scope(db,auth);
     lease=await claimProjectImagePreparation(db,{companyId:auth.service.company_id,projectIds:auth.projects.map(p=>p.project_id)}, {...options,processorId:serviceId})??undefined;
     if(lease){if(lease.processor.id!==serviceId)changed();await db.query('INSERT INTO project_image_preparation_service_leases(service_id,company_id,project_id,preparation_id,lease_id,request_hash,lease) VALUES($1,$2,$3,$4,$5,$6,$7)',[serviceId,lease.companyId,lease.projectId,lease.preparationId,lease.leaseId,lease.requestHash,JSON.stringify(lease)]);}
     response={lease:lease??null};
    }else{
     lease=await leaseFor(db,auth);
     if(operation==='fail'){const result=await failProjectImagePreparation(db,lease,args.code);response={status:result.preparation.status};}
     else {
      const {r,approval}=await active(db,auth,lease);
      if(operation==='authorize')response={authorized:true};
      else if(operation==='source'){
       if(r.status!=='reading')changed();response={source:preparationServiceSourceSchema.parse({versionId:r.source_snapshot.versionId,bytes:r.source_snapshot.bytes,sha256:r.source_snapshot.sha256,contentType:r.source_snapshot.contentType,etag:r.source_snapshot.providerEtag})};
      }else if(operation==='begin-transform'){
       const read=await byteResult(db,lease,'read-source');if(read.provider_result!==null||!same(read.public_result,{operation:'read-source',versionId:lease.source.versionId,bytes:lease.source.bytes,sha256:lease.source.sha256,etag:r.source_snapshot.providerEtag})||read.version_id!==lease.source.versionId||Number(read.observed_bytes)!==lease.source.bytes||read.observed_sha256!==lease.source.sha256||read.observed_etag!==r.source_snapshot.providerEtag)changed();
       response=await beginProjectImagePreparationPhase(db,lease,'transform',options);
      }else if(operation==='complete-transform'){await completeProjectImagePreparationPhase(db,lease,args.actionId,args.result,options);response={ok:true};}
      else if(operation==='reserve-output')response={output:await reserveProjectImagePreparationOutput(db,lease,options)};
      else if(operation==='begin-store'){
       const intent=await beginProjectImagePreparationStore(db,lease,args.operation,options);response={intent:{operation:args.operation,actionId:intent.actionId,output:intent.output}};
      }else if(operation==='complete-store'){
       const result=await byteResult(db,lease,args.receipt.operation,args.receipt.actionId);
       if(!same(result.public_result,args.receipt)||!result.provider_result||result.provider_result.operation!==args.receipt.operation||result.version_id!==args.receipt.output.versionId||result.upload_id!==args.receipt.output.uploadId||Number(result.bytes)!==args.receipt.output.bytes||result.sha256!==args.receipt.output.sha256)changed();
       if(args.receipt.operation==='part'&&(Number(result.observed_bytes)!==args.receipt.bytes||result.observed_sha256!==args.receipt.sha256)||args.receipt.operation==='complete'&&result.observed_etag!==args.receipt.etag)changed();
       await completeProjectImagePreparationStore(db,lease,args.receipt.actionId,result.provider_result,options);response={ok:true};
      }else if(operation==='publish'){
       const read=await byteResult(db,lease,'read-output');
       if(read.provider_result!==null||!same(read.public_result,{operation:'read-output',versionId:read.version_id,bytes:args.result.bytes,sha256:args.result.sha256,etag:args.result.etag})||Number(read.observed_bytes)!==args.result.bytes||read.observed_sha256!==args.result.sha256||read.observed_etag!==args.result.etag||Number(read.bytes)!==args.result.bytes||read.sha256!==args.result.sha256||read.expected_etag!==args.result.etag)changed();
       const result=await publishProjectImagePreparation(db,lease,args.result,options);if(result.preparation.status!=='ready')changed();response={status:'ready'};
      }else if(operation==='byte-capability'){
       const op=args.transfer.operation,project=await authorizeImagePreparationServiceProject(db,auth,lease.projectId,{preparationId:lease.preparationId});
       if((await db.query('SELECT 1 FROM project_image_preparation_byte_grants WHERE preparation_id=$1 AND lease_id=$2 AND operation=$3',[lease.preparationId,lease.leaseId,op])).rowCount)uncertain();
       let target:Row;
       if(op==='read-source'){
        if(r.status!=='reading')changed();target={versionId:r.source_snapshot.versionId,bytes:r.source_snapshot.bytes,sha256:r.source_snapshot.sha256,contentType:r.source_snapshot.contentType,etag:r.source_snapshot.providerEtag,uploadId:null,bindingRevision:r.storage_binding_revision};
       }else{
        const allocation=(await db.query(`SELECT a.*,u.status AS upload_status,u.provider_etag,u.action_id,u.action_expires_at FROM project_image_preparation_allocations a
         JOIN project_storage_uploads u ON u.company_id=a.company_id AND u.id=a.upload_id WHERE a.company_id=$1 AND a.project_id=$2 AND a.preparation_id=$3 FOR SHARE OF u`,[lease.companyId,lease.projectId,lease.preparationId])).rows[0];
        if(!allocation)changed();
        if(op==='read-output'){if(r.status!=='verifying'||allocation.upload_status!=='verifying'||allocation.action_id||!allocation.provider_etag)changed();}
        else if(r.status!=='storing'||allocation.action_id!==args.transfer.actionId||allocation.upload_status!==(op==='initiate'?'initiating':op==='complete'?'completing':'uploading')||!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[allocation.action_expires_at])).rows[0]?.live)changed();
        target={versionId:allocation.version_id,bytes:Number(allocation.output_bytes),sha256:allocation.output_sha256,contentType:'image/png',etag:op==='read-output'?allocation.provider_etag:null,uploadId:allocation.upload_id,bindingRevision:allocation.binding_revision_after};
       }
       const id=randomUUID(),byteToken=secret('ipt_'),expiresAt=new Date(Math.min(deadline,Date.parse(lease.expiresAt),+new Date(approval.expires_at),+new Date(auth.service.expires_at),+new Date(project.gateway_expires_at),Date.parse(lease.processor.expiresAt))).toISOString();
       const capability=preparationByteCapabilitySchema.parse({id,token:byteToken,origin:project.gateway_origin,operation:op,preparationId:lease.preparationId,leaseId:lease.leaseId,requestHash:lease.requestHash,versionId:target.versionId,bytes:target.bytes,sha256:target.sha256,contentType:target.contentType,etag:target.etag,actionId:args.transfer.actionId??null,expiresAt});
       await db.query(`INSERT INTO project_image_preparation_byte_grants(id,service_id,company_id,project_id,preparation_id,lease_id,request_id,request_hash,token_hash,operation,action_id,version_id,upload_id,bytes,sha256,content_type,expected_etag,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,gateway_binding_id,gateway_provision_id,gateway_configuration_sha256,gateway_origin,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,[id,serviceId,lease.companyId,lease.projectId,lease.preparationId,lease.leaseId,args.requestId,lease.requestHash,hashToken(byteToken),op,args.transfer.actionId??null,target.versionId,target.uploadId,target.bytes,target.sha256,target.contentType,target.etag,r.storage_binding_id,target.bindingRevision,r.storage_connection_id,r.storage_connection_revision,project.gateway_binding_id,project.gateway_provision_id,project.gateway_configuration_sha256,project.gateway_origin,expiresAt]);
       response={capability};stored={capabilityId:id}; // Never persist bearer plaintext for replay.
      }else return invalid();
     }
    }
    const checked=preparationServiceResponses[operation].safeParse(response);if(!checked.success)changed();
    await finalAuthority(db,auth,lease);
    await db.query("UPDATE project_image_preparation_service_calls SET status='completed',response=$3,finished_at=clock_timestamp() WHERE service_id=$1 AND request_id=$2 AND status='started'",[serviceId,args.requestId,JSON.stringify(stored??checked.data)]);
    await finalAuthority(db,auth,lease);return checked.data as ResponseFor<K>;
   });
  }catch(error){if(error instanceof ApiError)throw error;fail(503,'This request outcome could not be confirmed. Do not repeat work; reconcile the retained request ID.','IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');}
 }};
}
