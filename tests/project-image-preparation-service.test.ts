import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {ApiError,hashToken} from '../src/lib/security';
import {createImagePreparationControlService} from '../src/lib/project-image-preparation-service';
import {assertImagePreparationBrokerDatabase} from '../src/lib/project-image-preparation-database.mjs';
import {enrollImagePreparationService} from '../src/lib/project-image-preparation-enrollment';
import {resolveProjectImagePreparationProcessor} from '../src/lib/project-image-preparation-service-authority';
import {proposeProjectImagePreparation,approveProjectImagePreparation} from '../src/lib/project-image-preparations';
import {runpodProjectRoot} from '../src/lib/project-storage-runpod';
import type {PreparationServiceOperation,PreparationByteCapability} from '../src/lib/project-image-preparation-service-protocol';
import type {ProjectImagePreparationLease} from '../src/lib/project-image-preparations-protocol';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';

type Row=Record<string,any>;
const request=()=>({requestId:randomUUID(),deadlineAt:new Date(Date.now()+25000).toISOString()});
const rejected=(code?:string)=>(error:unknown)=>{assert(error instanceof ApiError,'Intentional fixed API error, not an unhandled SQL failure');if(code)assert.equal(error.code,code);assert.doesNotMatch(error.message,/rps_synthetic|user_synthetic|postgresql:|secret_envelope|coatria\/companies\//);return true;};

test('private image preparation metadata control uses durable requests and independent byte evidence',{timeout:180000},async t=>{
 const env=await openImagePreparationServiceDatabase(),oldFetch=globalThis.fetch,oldKeyring=process.env.COATRIA_HOSTING_KEYRING;let network=0;
 globalThis.fetch=async()=>{network++;throw Error('Offline control fixture prohibits network');};delete process.env.COATRIA_HOSTING_KEYRING;
 let service=createImagePreparationControlService({transaction:env.tx});
 const fixture=()=>env.tx(db=>imagePreparationServiceFixture(db));
 async function leased(existing?:Awaited<ReturnType<typeof fixture>>){const f=existing??await fixture();await env.tx(f.approve);const claimInput=request(),{lease}=await service.execute(f.serviceId,f.token,'claim',claimInput);assert(lease);return {...f,lease,claimInput};}
 const call=<K extends PreparationServiceOperation>(f:{serviceId:string;token:string;lease:ProjectImagePreparationLease},operation:K,extra:Row={})=>service.execute(f.serviceId,f.token,operation,{...request(),preparationId:f.lease.preparationId,leaseId:f.lease.leaseId,...extra});
 async function snapshot(companyId:string){const result:Row={};for(const table of ['project_image_preparations','project_image_preparation_approvals','project_image_preparation_receipts','project_image_preparation_allocations','project_image_preparation_derivations','project_storage_versions','project_storage_verifications','project_storage_uploads','project_storage_upload_parts'])result[table]=(await env.db.query('SELECT row_to_json(r) value FROM '+table+' r WHERE company_id=$1 ORDER BY row_to_json(r)::text',[companyId])).rows;return result;}
 // These rows model the trusted gateway journal, not actual provider I/O or
 // verified native bytes. Native transform and HTTP byte tests are separate.
 async function gatewayResult(cap:PreparationByteCapability,publicResult:Row,providerResult:Row|null=null){
  await env.tx(async db=>{
   await db.query("INSERT INTO project_image_preparation_byte_results(grant_id,status) VALUES($1,'started')",[cap.id]);
   const read=cap.operation.startsWith('read-'),part=cap.operation==='part';
   await db.query("UPDATE project_image_preparation_byte_results SET status='completed',public_result=$2,provider_result=$3,observed_bytes=$4,observed_sha256=$5,observed_etag=$6,finished_at=clock_timestamp() WHERE grant_id=$1",[cap.id,JSON.stringify(publicResult),providerResult===null?null:JSON.stringify(providerResult),read||part?cap.bytes:null,read||part?cap.sha256:null,read?cap.etag:cap.operation==='complete'?publicResult.etag:null]);
  });
 }
 async function readSource(f:Awaited<ReturnType<typeof leased>>){const {capability}=await call(f,'byte-capability',{transfer:{operation:'read-source'}});await gatewayResult(capability,{operation:'read-source',versionId:capability.versionId,bytes:capability.bytes,sha256:capability.sha256,etag:capability.etag});return capability;}
 async function transformed(existing?:Awaited<ReturnType<typeof fixture>>){const f=await leased(existing);await readSource(f);const {actionId}=await call(f,'begin-transform');await call(f,'complete-transform',{actionId,result:{operation:'transform',sourceVersionId:f.versionId,sourceSha256:f.sourceSha256,sourceBytes:f.sourceLength,source:{format:'png',width:16,height:16,orientation:1},recipeSha256:f.lease.recipeSha256,processor:f.lease.processor,output:{bytes:88,sha256:'f'.repeat(64),width:16,height:16,format:'png',pixelFormat:'rgba8',metadataRemoved:true}}});return f;}
 const descriptor=(f:Awaited<ReturnType<typeof leased>>,output:Row)=>({scope:hashToken(JSON.stringify(['US-CA-2','synthetic-volume',runpodProjectRoot(f.companyId,f.projectId)])),versionId:output.versionId,uploadId:'synthetic-multipart-'+output.uploadId,bytes:output.bytes,partBytes:output.partBytes});
 async function stored(existing?:Awaited<ReturnType<typeof fixture>>){const f=await transformed(existing),{output}=await call(f,'reserve-output');for(const operation of ['initiate','part','complete'] as const){const {intent}=await call(f,'begin-store',{operation});const {capability}=await call(f,'byte-capability',{transfer:{operation,actionId:intent.actionId}});const receipt={...intent,...(operation==='part'?{partNumber:1,bytes:output.bytes,sha256:output.sha256}:operation==='complete'?{etag:'synthetic-final-etag'}:{})};const provider=operation==='initiate'?{operation,descriptor:descriptor(f,output)}:operation==='part'?{operation,part:{partNumber:1,etag:'synthetic-private-part-etag',bytes:output.bytes},sha256:output.sha256}:{operation,versionId:output.versionId,etag:'synthetic-final-etag'};await gatewayResult(capability,receipt,provider);await call(f,'complete-store',{receipt});}return {...f,output};}
 try{
  await t.test('strict inputs, exact token and current sponsor reject before durable admission',async()=>{
   const f=await fixture(),before=await snapshot(f.companyId);
   for(const input of [{...request(),sql:'SELECT secrets'},{...request(),deadlineAt:new Date(Date.now()+60000).toISOString()},{...request(),deadlineAt:new Date(Date.now()-1000).toISOString()}])await assert.rejects(service.execute(f.serviceId,f.token,'readiness',input),rejected());
   await assert.rejects(service.execute(f.serviceId,'ips_'+randomBytes(32).toString('base64url'),'readiness',request()),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));
   const outsider=await fixture();await assert.rejects(service.execute(f.serviceId,outsider.token,'readiness',request()),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));
   await env.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.companyId,f.userId]);
   await assert.rejects(service.execute(f.serviceId,f.token,'readiness',request()),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));
   assert.equal(Number((await env.db.query('SELECT count(*) n FROM project_image_preparation_service_calls WHERE service_id=$1',[f.serviceId])).rows[0].n),0);
   assert.deepEqual(await snapshot(f.companyId),before);
  });
  await t.test('actual claim persists one exact lease and replay preserves it; source needs no keyring',async()=>{
   const f=await leased(),ready=await service.execute(f.serviceId,f.token,'readiness',request());assert.equal(ready.readiness.serviceId,f.serviceId);
   assert.deepEqual(await service.execute(f.serviceId,f.token,'claim',f.claimInput),{lease:f.lease});
   await assert.rejects(service.execute(f.serviceId,f.token,'readiness',f.claimInput),rejected('IDEMPOTENCY_CONFLICT'));
   assert.equal(Number((await env.db.query('SELECT count(*) n FROM project_image_preparation_service_leases WHERE service_id=$1',[f.serviceId])).rows[0].n),1);
   const source=await call(f,'source');assert.deepEqual(source.source,{versionId:f.versionId,bytes:100,sha256:'a'.repeat(64),contentType:'image/png',etag:'synthetic-source-etag'});
   assert.doesNotMatch(JSON.stringify([ready,source]),/objectKey|secret_envelope|accessKey|rps_synthetic|user_synthetic/);assert.equal(process.env.COATRIA_HOSTING_KEYRING,undefined);
   const other=await fixture();await assert.rejects(service.execute(other.serviceId,other.token,'source',{...request(),preparationId:f.lease.preparationId,leaseId:f.lease.leaseId}),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));
  });
  await t.test('claim skips a foreign processor approval without blocking or modifying it',async()=>{
   const f=await fixture();await env.tx(f.approve);const foreignBefore=(await env.db.query('SELECT row_to_json(p) value FROM project_image_preparations p WHERE id=$1',[f.proposed!.id])).rows[0].value;
   const serviceId=randomUUID(),token='ips_'+randomBytes(32).toString('base64url');await env.tx(db=>enrollImagePreparationService(db,{...f.enrollment,requestId:randomUUID(),serviceId,tokenHash:hashToken(token)}));
   assert.deepEqual(await service.execute(serviceId,token,'claim',request()),{lease:null});
   const own=await env.tx(async db=>{const p=(await proposeProjectImagePreparation(db,f.actor,{clientId:randomUUID(),projectId:f.projectId,projectRevision:1,workItemId:f.workItemId,sourceVersionId:f.versionId,sourceSha256:f.sourceSha256,sourceBytes:f.sourceLength,destinationFolderId:null,destinationName:'other-prepared.png',purpose:'Second exact processor fixture'})).preparation;await approveProjectImagePreparation(db,f.actor,p.id,{clientId:randomUUID(),revision:p.revision,requestHash:p.requestHash,processorId:serviceId,qualificationSha256:f.enrollment.qualificationSha256,expiresInMinutes:5,maxCostMicrousd:0,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},{runtime:resolveProjectImagePreparationProcessor});return p;});
   const result=await service.execute(serviceId,token,'claim',request());assert.equal(result.lease?.preparationId,own.id);assert.equal(result.lease?.processor.id,serviceId);
   assert.deepEqual((await env.db.query('SELECT row_to_json(p) value FROM project_image_preparations p WHERE id=$1',[f.proposed!.id])).rows[0].value,foreignBefore);
  });
  await t.test('begin-transform requires a completed read journal; byte token persists only its hash and never remints',async()=>{
   const f=await leased(),before=await snapshot(f.companyId);await assert.rejects(call(f,'begin-transform'),rejected('IMAGE_PREPARATION_SERVICE_BYTES_CHANGED'));assert.deepEqual(await snapshot(f.companyId),before);
   const input={...request(),preparationId:f.lease.preparationId,leaseId:f.lease.leaseId,transfer:{operation:'read-source'}};const {capability}=await service.execute(f.serviceId,f.token,'byte-capability',input);
   const capRow=(await env.db.query('SELECT * FROM project_image_preparation_byte_grants WHERE id=$1',[capability.id])).rows[0];assert.equal(capRow.token_hash,hashToken(capability.token));assert.equal(capRow.gateway_origin,f.gateway.origin);
   const saved=(await env.db.query('SELECT * FROM project_image_preparation_service_calls WHERE service_id=$1 AND request_id=$2',[f.serviceId,input.requestId])).rows[0];assert.deepEqual(saved.response,{capabilityId:capability.id});assert(!JSON.stringify([capRow,saved]).includes(capability.token));
   await assert.rejects(service.execute(f.serviceId,f.token,'byte-capability',input),rejected('IMAGE_PREPARATION_SERVICE_RECONCILIATION_REQUIRED'));
   await assert.rejects(call(f,'byte-capability',{transfer:{operation:'read-source'}}),rejected('IMAGE_PREPARATION_SERVICE_RECONCILIATION_REQUIRED'));
   await env.db.query("INSERT INTO project_image_preparation_byte_results(grant_id,status) VALUES($1,'started')",[capability.id]);await assert.rejects(call(f,'begin-transform'),rejected('IMAGE_PREPARATION_SERVICE_BYTES_CHANGED'));
   assert.equal(Number((await env.db.query('SELECT count(*) n FROM project_image_preparation_byte_grants WHERE preparation_id=$1',[f.proposed!.id])).rows[0].n),1);
  });
  await t.test('store echo alone cannot complete an operation; gateway result must match exact public and private evidence',async()=>{
   const f=await transformed(),{output}=await call(f,'reserve-output'),{intent}=await call(f,'begin-store',{operation:'initiate'}),before=await snapshot(f.companyId);
   await assert.rejects(call(f,'complete-store',{receipt:intent}),rejected('IMAGE_PREPARATION_SERVICE_BYTES_CHANGED'));assert.deepEqual(await snapshot(f.companyId),before);
   const {capability}=await call(f,'byte-capability',{transfer:{operation:'initiate',actionId:intent.actionId}});await gatewayResult(capability,intent,{operation:'initiate',descriptor:descriptor(f,output)});
   await assert.rejects(call(f,'complete-store',{receipt:{...intent,output:{...output,sha256:'e'.repeat(64)}}}),rejected('IMAGE_PREPARATION_SERVICE_BYTES_CHANGED'));
   assert.deepEqual(await call(f,'complete-store',{receipt:intent}),{ok:true});
   const upload=(await env.db.query('SELECT provider_upload_id,status FROM project_storage_uploads WHERE id=$1',[output.uploadId])).rows[0];assert.equal(upload.provider_upload_id,'synthetic-multipart-'+output.uploadId);assert.equal(upload.status,'uploading');
  });
  await t.test('publication requires independent completed output read and preserves original bytes and provenance',async()=>{
   const f=await stored(),sourceBefore=(await env.db.query('SELECT row_to_json(v) value FROM project_storage_versions v WHERE id=$1',[f.versionId])).rows[0],result={bytes:f.output.bytes,sha256:f.output.sha256,etag:'synthetic-final-etag',cleanupConfirmed:true};
   await assert.rejects(call(f,'publish',{result}),rejected('IMAGE_PREPARATION_SERVICE_BYTES_CHANGED'));
   const {capability}=await call(f,'byte-capability',{transfer:{operation:'read-output'}});await gatewayResult(capability,{operation:'read-output',versionId:f.output.versionId,bytes:f.output.bytes,sha256:f.output.sha256,etag:result.etag});
   await assert.rejects(call(f,'publish',{result:{...result,etag:'different-etag'}}),rejected('IMAGE_PREPARATION_SERVICE_BYTES_CHANGED'));
   const input={...request(),preparationId:f.lease.preparationId,leaseId:f.lease.leaseId,result};assert.deepEqual(await service.execute(f.serviceId,f.token,'publish',input),{status:'ready'});assert.deepEqual(await service.execute(f.serviceId,f.token,'publish',input),{status:'ready'});
   assert.deepEqual((await env.db.query('SELECT row_to_json(v) value FROM project_storage_versions v WHERE id=$1',[f.versionId])).rows[0],sourceBefore);
   const proof=(await env.db.query('SELECT * FROM project_image_preparation_derivations WHERE company_id=$1 AND preparation_id=$2',[f.companyId,f.proposed!.id])).rows[0];assert.equal(proof.source_version_id,f.versionId);assert.equal(proof.output_version_id,f.output.versionId);assert.equal(proof.output_sha256,f.output.sha256);
  });
  await t.test('terminal replay cannot return success after an awaited check crosses the actual service deadline',async()=>{
   const base=await env.tx(db=>imagePreparationServiceFixture(db,{enroll:false}));
   await env.tx(db=>enrollImagePreparationService(db,{...base.enrollment,expiresAt:new Date(Date.now()+15000).toISOString()}));
   const f=await stored(base),{capability}=await call(f,'byte-capability',{transfer:{operation:'read-output'}});
   await gatewayResult(capability,{operation:'read-output',versionId:f.output.versionId,bytes:f.output.bytes,sha256:f.output.sha256,etag:'synthetic-final-etag'});
   const input={...request(),preparationId:f.lease.preparationId,leaseId:f.lease.leaseId,result:{bytes:f.output.bytes,sha256:f.output.sha256,etag:'synthetic-final-etag',cleanupConfirmed:true}};
   assert.deepEqual(await service.execute(f.serviceId,f.token,'publish',input),{status:'ready'});const before=await snapshot(f.companyId);let intercepted=false;
   const slow=createImagePreparationControlService({transaction:run=>env.tx(db=>run(new Proxy(db,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql.startsWith('SELECT p.status,p.revoked_at,a.approver_snapshot')){assert(Date.now()<Date.parse(f.lease.processor.expiresAt),'The replay entered before the finite service expired');intercepted=true;await delay(Math.max(0,Date.parse(f.lease.processor.expiresAt)-Date.now()+30));}return result;};}})))});
   await assert.rejects(slow.execute(f.serviceId,f.token,'publish',input),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));assert(intercepted);assert.deepEqual(await snapshot(f.companyId),before);
  });
  await t.test('revocation after admission prevents effects and keeps the original uncertain request',async()=>{
   const f=await fixture();await env.tx(f.approve);let commits=0;const guarded=createImagePreparationControlService({transaction:async run=>{const result=await env.tx(run);if(++commits===1)await env.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.companyId,f.userId]);return result;}}),input=request();
   await assert.rejects(guarded.execute(f.serviceId,f.token,'claim',input),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));
   assert.equal((await env.db.query('SELECT status FROM project_image_preparations WHERE id=$1',[f.proposed!.id])).rows[0].status,'queued');assert.equal((await env.db.query('SELECT status FROM project_image_preparation_service_calls WHERE service_id=$1 AND request_id=$2',[f.serviceId,input.requestId])).rows[0].status,'started');
  });
  await t.test('abort inside final commit fence rolls back claim but retains once-only admission',async()=>{
   const f=await fixture();await env.tx(f.approve);const controller=new AbortController();let transactions=0;
   const guarded=createImagePreparationControlService({transaction:run=>env.tx(db=>{const second=++transactions===2;const wrapped=new Proxy(db,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(second&&sql.startsWith('INSERT INTO project_image_preparation_service_leases'))controller.abort();return result;};}});return run(wrapped);})});const input=request();
   await assert.rejects(guarded.execute(f.serviceId,f.token,'claim',input,{signal:controller.signal}),rejected('IMAGE_PREPARATION_SERVICE_ABORTED'));
   assert.equal((await env.db.query('SELECT status FROM project_image_preparations WHERE id=$1',[f.proposed!.id])).rows[0].status,'queued');assert.equal(Number((await env.db.query('SELECT count(*) n FROM project_image_preparation_service_leases WHERE service_id=$1',[f.serviceId])).rows[0].n),0);
   await assert.rejects(service.execute(f.serviceId,f.token,'claim',input),rejected('IMAGE_PREPARATION_SERVICE_RECONCILIATION_REQUIRED'));
  });
  await t.test('lost committed claim response replays exactly once; lost capability response never creates another token',async()=>{
   const f=await fixture();await env.tx(f.approve);let count=0;const lost=createImagePreparationControlService({transaction:async run=>{const value=await env.tx(run);if(++count===2)throw Error('Synthetic lost COMMIT reply with private SQL details');return value;}}),input=request();
   await assert.rejects(lost.execute(f.serviceId,f.token,'claim',input),rejected('IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN'));const {lease}=await service.execute(f.serviceId,f.token,'claim',input);assert(lease);
   let byteCount=0;const lostByte=createImagePreparationControlService({transaction:async run=>{const value=await env.tx(run);if(++byteCount===2)throw Error('Synthetic lost COMMIT reply');return value;}}),byteInput={...request(),preparationId:lease.preparationId,leaseId:lease.leaseId,transfer:{operation:'read-source'}};
   await assert.rejects(lostByte.execute(f.serviceId,f.token,'byte-capability',byteInput),rejected('IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN'));await assert.rejects(service.execute(f.serviceId,f.token,'byte-capability',byteInput),rejected('IMAGE_PREPARATION_SERVICE_RECONCILIATION_REQUIRED'));
   assert.equal(Number((await env.db.query('SELECT count(*) n FROM project_image_preparation_byte_grants WHERE preparation_id=$1',[lease.preparationId])).rows[0].n),1);
  });
  await t.test('failure reports after service revocation release no bytes and retain cleanup uncertainty',async()=>{
   const f=await leased();await env.db.query('UPDATE project_image_preparation_services SET revoked_at=clock_timestamp(),revoked_by=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[f.serviceId,f.userId]);
   await assert.rejects(call(f,'source'),rejected('IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'));const response=await call(f,'fail',{code:'PREPARATION_CLEANUP_FAILED'});assert(['failed','uncertain'].includes(response.status));
   const row=(await env.db.query('SELECT cleanup_confirmed_at,lease_id,status FROM project_image_preparations WHERE id=$1',[f.proposed!.id])).rows[0];assert.equal(row.cleanup_confirmed_at,null);assert.equal(row.lease_id,f.lease.leaseId);
  });
  await t.test('native concurrent authorization waits only before transition without retaining service locks',{skip:env.native?false:'Requires independent native PostgreSQL transactions'},async()=>{
   const f=await fixture();await env.tx(f.approve);const blocker=new Pool({connectionString:env.connectionString,max:1}),db=await blocker.connect();let notify!:()=>void;const probed=new Promise<void>(resolve=>{notify=resolve;});let probes=0;let pending:Promise<unknown>|undefined;
   const guarded=createImagePreparationControlService({transaction:run=>env.tx(client=>run(new Proxy(client,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql.startsWith('SELECT pg_try_advisory_xact_lock')&&!result.rows[0]?.acquired){probes++;notify();}return result;};}})))});
   try{
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['project-image-preparation:'+f.companyId]);
    pending=guarded.execute(f.serviceId,f.token,'claim',request());await Promise.race([probed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Expected exact company-lock probe')),3000))]);
    // A revoker can still acquire the service row while admission waits. This
    // would fail with 55P03 if control held its authorization SHARE lock first.
    await db.query('SELECT id FROM project_image_preparation_services WHERE id=$1 FOR UPDATE NOWAIT',[f.serviceId]);
    assert.equal((await db.query('SELECT status FROM project_image_preparations WHERE id=$1',[f.proposed!.id])).rows[0].status,'queued');
    await db.query('COMMIT');const result=await pending as {lease:ProjectImagePreparationLease};assert.equal(result.lease.preparationId,f.proposed!.id);assert(probes>=1);
    assert.equal(Number((await env.db.query('SELECT count(*) n FROM project_image_preparation_service_leases WHERE service_id=$1',[f.serviceId])).rows[0].n),1);
   }finally{await db.query('ROLLBACK').catch(()=>{});if(pending)await Promise.allSettled([pending]);db.release();await blocker.end();}
  });
  await t.test('restricted broker performs the complete control lifecycle without writing gateway byte evidence',async()=>{
   const role='coatria_image_preparation_broker_v1',oldService=service;let lock:PoolClient|undefined,pool:Pool|undefined,created=false;
   try{
    if(env.native){assert(env.control);lock=await env.control.connect();await lock.query('SELECT pg_advisory_lock(739284033)');}
    assert.equal(Number((await (lock??env.db).query('SELECT count(*) n FROM pg_roles WHERE rolname=$1',[role])).rows[0].n),0,'Never alter an existing role');
    const password=randomBytes(32).toString('hex');await (lock??env.db).query('CREATE ROLE '+role+" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'");created=true;
    await env.db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await env.exec(await readFile('database/image-preparation-broker-permissions.sql','utf8'));
    let transaction:typeof env.tx;
    if(env.native){assert(env.connectionString);const url=new URL(env.connectionString);url.username=role;url.password=password;pool=new Pool({connectionString:url.href,max:2});const brokerPool=pool;
     transaction=async run=>{const db=await brokerPool.connect();try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
    }else transaction=run=>env.tx(async db=>{await db.query('SET LOCAL ROLE '+role);return run(db);});
    await transaction(async db=>{assert.equal((await assertImagePreparationBrokerDatabase(db,{provisioning:!env.native})).status,'passed');if(env.native)assert.deepEqual((await db.query('SELECT session_user,current_user')).rows[0],{session_user:role,current_user:role});const privileges=(await db.query("SELECT has_table_privilege(current_user,'project_image_preparation_byte_results','INSERT') AS insert,has_any_column_privilege(current_user,'project_image_preparation_byte_results','UPDATE') AS update,has_table_privilege(current_user,'project_image_preparation_byte_results','DELETE') AS delete")).rows[0];assert.deepEqual(privileges,{insert:false,update:false,delete:false});});
    service=createImagePreparationControlService({transaction});const f=await stored(),{capability}=await call(f,'byte-capability',{transfer:{operation:'read-output'}});await gatewayResult(capability,{operation:'read-output',versionId:f.output.versionId,bytes:f.output.bytes,sha256:f.output.sha256,etag:'synthetic-final-etag'});
    const result={bytes:f.output.bytes,sha256:f.output.sha256,etag:'synthetic-final-etag',cleanupConfirmed:true};assert.deepEqual(await call(f,'publish',{result}),{status:'ready'});
    assert.equal((await env.db.query('SELECT status FROM project_image_preparations WHERE id=$1',[f.proposed!.id])).rows[0].status,'ready');
   }finally{service=oldService;await pool?.end();if(created){await env.db.query('DROP OWNED BY '+role);await (lock??env.db).query('DROP ROLE '+role);}if(lock){await lock.query('SELECT pg_advisory_unlock(739284033)');lock.release();}}
  });
  assert.equal(network,0,'The metadata service never calls a provider');
 }finally{globalThis.fetch=oldFetch;if(oldKeyring===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=oldKeyring;await env.close();}
});
