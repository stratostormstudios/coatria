/** Finite reference-service control plane. Registration is deliberately absent:
 * only a separately reviewed operator/qualification path may enroll a host. */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {body,fail,hashToken,json,errorResponse} from './security';
import {higgsfieldReferenceDigest,higgsfieldReferencesUnavailable,claimHiggsfieldReference,authorizeHiggsfieldReference,recordHiggsfieldReferenceInspection,beginHiggsfieldReferencePhase,completeHiggsfieldReferencePhase,failHiggsfieldReference,getHiggsfieldReferenceStorageContext,type HiggsfieldReferenceOptions} from './higgsfield-references';
import {createDatabaseHiggsfieldReferenceBroker} from './higgsfield-reference-broker-db';
import {openProjectStorageCredentials} from './project-storage';
import {createRunpodProjectStorage,runpodProjectObjectKey,type RunpodProjectStorageConfig,type RunpodProjectStorage} from './project-storage-runpod';
import {authorityReader} from './project-storage-stream';
import {verifiedReferenceServiceEnrollment} from './higgsfield-reference-enrollment';
import type {HiggsfieldReferenceLease,HiggsfieldReferenceAvailability} from './higgsfield-references-protocol';

export type ReferenceServiceTransaction=<T>(run:(db:PoolClient)=>Promise<T>)=>Promise<T>;
type Row=Record<string,any>;
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),identity={referenceId:uuid,leaseId:uuid,requestHash:sha};
const base=z.object({requestId:uuid}).strict(),bound=base.extend(identity);
const schemas={
 readiness:base,claim:base,authorize:bound,'read-proxy':bound,allocate:bound,'upload-capability':bound,'begin-put':bound,confirm:bound,
 inspection:bound.extend({inspection:z.object({descriptor:z.unknown(),profileSha256:sha}).strict()}),
 'complete-put':bound.extend({actionId:uuid,result:z.object({phase:z.literal('put'),bytes:z.number().int().positive().max(10485760),sha256:sha,httpStatus:z.literal(200)}).strict()}),
 fail:bound.extend({failure:z.object({code:z.enum(['REFERENCE_WORKER_UNAVAILABLE','REFERENCE_WORKER_POLICY_INVALID','REFERENCE_AUTHORITY_CHANGED','REFERENCE_SOURCE_CHANGED','REFERENCE_IMAGE_REJECTED','REFERENCE_WORKER_DEADLINE','REFERENCE_WORKER_ABORTED','REFERENCE_WORKER_FAILED','REFERENCE_PROVIDER_UNCERTAIN']),uncertain:z.boolean()}).strict()})
} as const;
type Operation=keyof typeof schemas;
const mutating=new Set<Operation>(['claim','read-proxy','inspection','allocate','begin-put','complete-put','confirm','fail']);
const ended=():never=>fail(403,'This reference service or its exact scope is no longer authorized.','REFERENCE_SERVICE_AUTHORITY_ENDED');
const unavailable=():never=>fail(503,'The reference service is not configured or qualified.','REFERENCE_SERVICE_UNAVAILABLE');
const iso=(v:Date|string)=>new Date(v).toISOString();
function hosts(value:unknown):string[]{
 const parsed=z.array(z.string().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).min(1).max(8).safeParse(value);
 if(!parsed.success)return unavailable();if(new Set(parsed.data).size!==parsed.data.length)return unavailable();return parsed.data;
}
/** Match company lifecycle lock order before sponsor, enrolment and work locks. */
async function service(db:PoolClient,serviceId:string,tokenHash?:string,cleanup=false){
 const preview=(await db.query('SELECT company_id,enrolled_by FROM higgsfield_reference_services WHERE id=$1',[serviceId])).rows[0];if(!preview)ended();
 if(!(await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[preview.company_id])).rowCount)ended();
 if(!cleanup&&!(await db.query("SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND access_revoked_at IS NULL FOR SHARE",[preview.company_id,preview.enrolled_by])).rowCount)ended();
 const row=(await db.query(`SELECT * FROM higgsfield_reference_services WHERE id=$1 AND ${cleanup?"expires_at+interval '10 minutes'>clock_timestamp()":"revoked_at IS NULL AND expires_at>clock_timestamp()"} FOR SHARE`,[serviceId])).rows[0];
 if(!row||row.company_id!==preview.company_id||row.enrolled_by!==preview.enrolled_by||tokenHash&&row.token_hash!==tokenHash)ended();
 if(!(await db.query(`SELECT ${cleanup?"expires_at+interval '10 minutes'":"expires_at"}>clock_timestamp() AS valid FROM higgsfield_reference_services WHERE id=$1`,[serviceId])).rows[0]?.valid)ended();
 hosts(row.upload_hosts);
 const projects=(await db.query('SELECT * FROM higgsfield_reference_service_projects WHERE service_id=$1 AND company_id=$2 ORDER BY project_id',[row.id,row.company_id])).rows;
 if(!projects.length||projects.length>100)ended();
 const enrollment=(await db.query('SELECT service_id,company_id,request_id,request_hash,identity FROM higgsfield_reference_service_enrollments WHERE service_id=$1 AND company_id=$2',[row.id,row.company_id])).rows[0];
 let identity;try{identity=verifiedReferenceServiceEnrollment(row,projects,enrollment);}catch{return ended();}
 return {...row,projects,enrollmentOrigin:identity.origin,enrollmentProjects:identity.projects} as Row;
}
async function serviceProject(db:PoolClient,s:Row,projectId:string){
 const p=s.projects.find((p:Row)=>p.project_id===projectId);if(!p)ended();
 const approved=s.enrollmentProjects.find((p:Row)=>p.projectId===projectId),project=(await db.query('SELECT revision,status,ai_policy,production_path,contract_version,gates FROM studio_projects WHERE company_id=$1 AND id=$2',[s.company_id,projectId])).rows[0];
 if(!approved||!project||project.revision!==approved.projectRevision||project.status==='delivered'||project.ai_policy!=='allowed'||project.production_path!=='higgsfield'||project.contract_version!==2||['brief','estimate','production'].some(g=>project.gates?.[g]?.decision!=='approved'))ended();
 const provider=(await db.query(`SELECT c.id,c.revision,c.tools,m.role,m.access_revoked_at FROM higgsfield_connections c
 JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.connected_by WHERE c.company_id=$1 AND c.status='connected'`,[s.company_id])).rows[0];
 if(!provider||provider.id!==s.provider_connection_id||provider.revision!==s.provider_connection_revision||provider.access_revoked_at||!['owner','admin'].includes(provider.role)||higgsfieldReferenceDigest(provider.tools)!==s.catalog_sha256)ended();
 const storage=(await db.query(`SELECT b.id,b.revision,b.connection_id,c.revision AS connection_revision,c.status,m.role,m.access_revoked_at
 FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id
 JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.created_by
 WHERE b.company_id=$1 AND b.project_id=$2`,[s.company_id,projectId])).rows[0];
 if(!storage||storage.id!==p.storage_binding_id||storage.revision!==p.storage_binding_revision||storage.connection_id!==p.storage_connection_id||storage.connection_revision!==p.storage_connection_revision||storage.status!=='configured'||storage.access_revoked_at||!['owner','admin'].includes(storage.role))ended();
 return {enabled:true,code:'REFERENCE_SERVICE_QUALIFIED',message:'A finite qualified reference service is enrolled for this exact project.',expiresAt:iso(s.expires_at),qualificationSha256:s.qualification_sha256,catalogSha256:s.catalog_sha256} satisfies HiggsfieldReferenceAvailability;
}
/** Shared human-approval readiness. Exposes no token, lease, paths or credentials.
 * An operator row alone cannot enable a route with no dedicated broker pool. */
export async function referenceServiceAvailability(db:PoolClient,companyId:string,projectId:string,dependencies:{brokerReady?:()=>Promise<unknown>}={}):Promise<HiggsfieldReferenceAvailability>{
 if(!process.env.COATRIA_REFERENCE_BROKER_DATABASE_URL)return {...higgsfieldReferencesUnavailable};
 try{await (dependencies.brokerReady??(async()=>{const {referenceBrokerTransaction}=await import('./higgsfield-reference-service-runtime');return referenceBrokerTransaction();}))();}catch{return {...higgsfieldReferencesUnavailable};}
 const candidates=(await db.query(`SELECT s.id FROM higgsfield_reference_services s JOIN higgsfield_reference_service_projects p ON p.service_id=s.id AND p.company_id=s.company_id
 WHERE s.company_id=$1 AND p.project_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() ORDER BY s.created_at DESC,s.id LIMIT 10`,[companyId,projectId])).rows;
 for(const candidate of candidates){try{const s=await service(db,candidate.id);return await serviceProject(db,s,projectId);}catch(error){if(!(error instanceof Error)||!('code' in error)||!['REFERENCE_SERVICE_AUTHORITY_ENDED','REFERENCE_SERVICE_UNAVAILABLE'].includes(String(error.code)))throw error;}}
 return {...higgsfieldReferencesUnavailable};
}

export function createHiggsfieldReferenceService(input:{transaction:ReferenceServiceTransaction;providerFactory?:(config:RunpodProjectStorageConfig)=>RunpodProjectStorage;brokerFactory?:typeof createDatabaseHiggsfieldReferenceBroker}){
 const tx=input.transaction,factory=input.providerFactory??createRunpodProjectStorage;
 return async function handle(request:Request,serviceId:string,operation:string):Promise<Response>{
  try{
   if(request.method!=='POST'||!uuid.safeParse(serviceId).success||!Object.hasOwn(schemas,operation))fail(404,'Reference service operation not found.');
   const header=request.headers.get('authorization');if(!header||!/^Bearer rfs_[A-Za-z0-9_-]{43}$/.test(header))fail(401,'A reference service credential is required.','REFERENCE_SERVICE_TOKEN_REQUIRED');
   if(request.headers.has('cookie')||request.headers.has('origin')||new URL(request.url).search)fail(403,'Use the private service protocol.','REFERENCE_SERVICE_PROTOCOL');
   const tokenHash=hashToken(header.slice(7)),op=operation as Operation,args=await body(request,schemas[op],24000) as Row;
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(45000)]),callHash=higgsfieldReferenceDigest({operation:op,arguments:args});
   const current=async(db:PoolClient)=>{const s=await service(db,serviceId,tokenHash,op==='fail');if(s.enrollmentOrigin!==new URL(request.url).origin)ended();if(op==='claim')for(const p of s.projects)await serviceProject(db,s,p.project_id);return s;};
   const options:HiggsfieldReferenceOptions={availability:async(db,companyId,projectId)=>{const s=await current(db);if(s.company_id!==companyId)ended();return serviceProject(db,s,projectId);}};
   async function lease(db:PoolClient,s:Row,authorize=true):Promise<HiggsfieldReferenceLease>{
    const row=(await db.query('SELECT * FROM higgsfield_reference_service_leases WHERE service_id=$1 AND company_id=$2 AND reference_id=$3 AND lease_id=$4 AND request_hash=$5',[serviceId,s.company_id,args.referenceId,args.leaseId,args.requestHash])).rows[0];
    if(!row||!s.projects.some((p:Row)=>p.project_id===row.project_id))ended();
    const l=row.lease as HiggsfieldReferenceLease;
    if(l.companyId!==row.company_id||l.projectId!==row.project_id||l.referenceId!==row.reference_id||l.leaseId!==row.lease_id||l.requestHash!==row.request_hash)ended();
    if(authorize)await authorizeHiggsfieldReference(db,l,options);return l;
   }
   async function activeLease(){return tx(async db=>{const s=await current(db);return lease(db,s);});}
   const saved=await tx(async db=>{
    const s=await current(db);signal.throwIfAborted();
    if(!mutating.has(op))return {s,replay:undefined};
    // Serialize one service's finite claim and call receipts, including separate
    // HTTP requests, without holding SQL locks across provider network I/O.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reference-service:'+serviceId]);
    const old=(await db.query('SELECT * FROM higgsfield_reference_service_calls WHERE service_id=$1 AND request_id=$2',[serviceId,args.requestId])).rows[0];
    if(old){if(old.request_hash!==callHash||old.operation!==op)fail(409,'This service request identifier was already used for different inputs.','IDEMPOTENCY_CONFLICT');if(old.status!=='completed')fail(409,'This service call has an unresolved outcome. It will not be repeated.','REFERENCE_SERVICE_CALL_UNCERTAIN');return {s,replay:old.response};}
    if(op==='claim'){
     if((await db.query(`SELECT 1 FROM higgsfield_reference_service_leases l JOIN higgsfield_references r ON r.company_id=l.company_id AND r.id=l.reference_id AND r.lease_id=l.lease_id
       WHERE l.service_id=$1 AND r.lease_expires_at>clock_timestamp() LIMIT 1`,[serviceId])).rowCount)fail(409,'This service already has a live reference lease.','REFERENCE_SERVICE_BUSY');
    }else await lease(db,s,op!=='fail');
    if(Number((await db.query('SELECT count(*) AS n FROM higgsfield_reference_service_calls WHERE service_id=$1',[serviceId])).rows[0].n)>=1000)fail(429,'This finite service reached its operation allowance.','REFERENCE_SERVICE_CALL_LIMIT');
    await db.query("INSERT INTO higgsfield_reference_service_calls(service_id,request_id,operation,request_hash,status) VALUES($1,$2,$3,$4,'started')",[serviceId,args.requestId,op,callHash]);
    if(op==='read-proxy'){
     if((await db.query('SELECT 1 FROM higgsfield_reference_service_reads WHERE lease_id=$1',[args.leaseId])).rowCount)fail(409,'This lease already started its bounded image read. It will not be repeated.','REFERENCE_SERVICE_READ_USED');
     await db.query('INSERT INTO higgsfield_reference_service_reads(service_id,lease_id,request_id) VALUES($1,$2,$3)',[serviceId,args.leaseId,args.requestId]);
    }
    return {s,replay:undefined};
   });
   if(saved.replay!==undefined)return json(saved.replay);
   const finish=async(db:PoolClient,response:Row)=>{if(mutating.has(op))await db.query("UPDATE higgsfield_reference_service_calls SET status='completed',response=$3,finished_at=clock_timestamp() WHERE service_id=$1 AND request_id=$2 AND status='started'",[serviceId,args.requestId,JSON.stringify(response)]);return response;};
   if(op==='readiness'){
    const result=await tx(async db=>{const s=await current(db);for(const p of s.projects)await serviceProject(db,s,p.project_id);return {enabled:true,hostQualified:true,storageVerified:true,catalogVerified:true,profileSha256:s.profile_sha256,qualificationSha256:s.qualification_sha256,expiresAt:iso(s.expires_at)};});
    return json({readiness:result});
   }
   if(op==='claim')return json(await tx(async db=>{
    const s=await current(db);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reference-service:'+serviceId]);
    if((await db.query(`SELECT 1 FROM higgsfield_reference_service_leases l JOIN higgsfield_references r ON r.company_id=l.company_id AND r.id=l.reference_id AND r.lease_id=l.lease_id WHERE l.service_id=$1 AND r.lease_expires_at>clock_timestamp() LIMIT 1`,[serviceId])).rowCount)fail(409,'This service already has a live reference lease.','REFERENCE_SERVICE_BUSY');
    const l=await claimHiggsfieldReference(db,{companyId:s.company_id,projectIds:s.projects.map((p:Row)=>p.project_id)},options);
    if(l)await db.query('INSERT INTO higgsfield_reference_service_leases(service_id,company_id,project_id,reference_id,lease_id,request_hash,lease) VALUES($1,$2,$3,$4,$5,$6,$7)',[serviceId,s.company_id,l.projectId,l.referenceId,l.leaseId,l.requestHash,JSON.stringify(l)]);
    return finish(db,{lease:l});
   }));
   if(op==='authorize'){await activeLease();return json({authorized:true});}
   if(op==='inspection'||op==='begin-put'||op==='complete-put'||op==='fail')return json(await tx(async db=>{
    const s=await current(db),l=await lease(db,s,op!=='fail');signal.throwIfAborted();let result:Row={ok:true};
    if(op==='inspection'){if(args.inspection.profileSha256!==s.profile_sha256)ended();await recordHiggsfieldReferenceInspection(db,l,args.inspection,options);}
    else if(op==='begin-put'){const started=await beginHiggsfieldReferencePhase(db,l,'put',options);result={actionId:started.actionId};}
    else if(op==='complete-put')await completeHiggsfieldReferencePhase(db,l,args.actionId,args.result,options);
    else await failHiggsfieldReference(db,l,args.failure.uncertain?'HIGGSFIELD_REFERENCE_OUTCOME_UNKNOWN':args.failure.code==='REFERENCE_AUTHORITY_CHANGED'?'HIGGSFIELD_REFERENCE_AUTHORITY_CHANGED':'HIGGSFIELD_REFERENCE_WORKER_FAILED');
    return finish(db,result);
   }));
   if(op==='allocate'||op==='confirm'||op==='upload-capability'){
    const l=await activeLease(),broker=(input.brokerFactory??createDatabaseHiggsfieldReferenceBroker)(options,{transaction:tx});
    if(op==='upload-capability'){
     const allocation=await broker.uploadCapability(l,signal),url=new URL(allocation.uploadUrl),s=await tx(current);
     if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||!hosts(s.upload_hosts).includes(url.hostname))ended();return json({allocation});
    }
    await broker[op](l,signal);return json(await tx(async db=>{await current(db);return finish(db,{ok:true});}));
   }
   if(op==='read-proxy'){
    if(request.headers.has('range'))fail(400,'Reference reads never accept ranges.');
    const prepared=await tx(async db=>{const s=await current(db),l=await lease(db,s),c=await getHiggsfieldReferenceStorageContext(db,l,options),credentials=await openProjectStorageCredentials(db,s.company_id,c.connectionId);if(credentials.connection.revision!==c.connectionRevision||c.objectKey!==runpodProjectObjectKey(s.company_id,l.projectId,l.proxy.versionId))ended();return {l,c,credentials};});
    signal.throwIfAborted();
    const {l,c,credentials}=prepared,adapter=factory({companyId:l.companyId,projectId:l.projectId,volumeId:credentials.connection.volumeId,region:credentials.connection.region,credentials:{accessKeyId:credentials.accessKeyId,secretAccessKey:credentials.secretAccessKey},maxObjectBytes:10485760,timeoutMs:45000});
    let object;try{object=await adapter.get({versionId:l.proxy.versionId,maxBytes:l.proxy.bytes,ifMatch:c.providerEtag,signal});}catch(error){adapter.close();throw error;}
    if(object.bytes!==l.proxy.bytes||object.totalBytes!==l.proxy.bytes||object.etag!==c.providerEtag||object.range!==null||object.contentRange!==null){void object.stream.cancel().catch(()=>{});adapter.close();ended();}
    let bytes=0,closed=false;const rawReader=object.stream.getReader();
    const reader=authorityReader(rawReader,async()=>{try{signal.throwIfAborted();await activeLease();}catch(error){close();throw error;}});
    const close=()=>{if(!closed){closed=true;signal.removeEventListener('abort',close);void reader.close();adapter.close();}};
    signal.addEventListener('abort',close,{once:true});if(signal.aborted)close();
    const stream=new ReadableStream<Uint8Array>({async pull(controller){try{signal.throwIfAborted();const part=await reader.read();if(part.done){if(bytes!==l.proxy.bytes)ended();controller.close();close();return;}bytes+=part.value.byteLength;if(bytes>l.proxy.bytes)ended();controller.enqueue(part.value);}catch{close();controller.error(new Error('REFERENCE_SOURCE_ENDED'));}},async cancel(){close();}},{highWaterMark:0});
    return new Response(stream,{headers:{'Content-Type':l.proxy.contentType,'Content-Length':String(l.proxy.bytes),'ETag':object.etag,'X-Coatria-Reference-Sha256':l.proxy.sha256,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
   }
   fail(404,'Reference service operation not found.');
  }catch(error){return errorResponse(error);}
 };
}
