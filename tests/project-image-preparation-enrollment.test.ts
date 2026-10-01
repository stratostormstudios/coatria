import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';
import {parseImagePreparationEnrollmentRequest,imagePreparationEnrollmentHash} from '../src/lib/project-image-preparation-enrollment-contract.mjs';
import {enrollImagePreparationService,reconcileImagePreparationServiceEnrollment} from '../src/lib/project-image-preparation-enrollment';
import {authorizeImagePreparationService,authorizeImagePreparationServiceLease,resolveProjectImagePreparationProcessor} from '../src/lib/project-image-preparation-service-authority';
import {assertImagePreparationBrokerDatabase,assertImagePreparationRegistrarDatabase} from '../src/lib/project-image-preparation-database.mjs';
import {hashToken} from '../src/lib/security';
import * as preparations from '../src/lib/project-image-preparations';
import {reserveProjectImagePreparationOutput} from '../src/lib/project-image-preparation-storage';

test('finite preparation enrollment and gateway evidence use actual isolated schema and authority',{timeout:180000},async t=>{
 const database=await openImagePreparationServiceDatabase(),db=database.db;
 try{
  const f=await database.tx(client=>imagePreparationServiceFixture(client));
  await t.test('exact registry is inert, source-bound and hashes every qualification field',async()=>{
   const replay=await database.tx(client=>enrollImagePreparationService(client,f.enrollment));assert.equal(replay.replayed,true);
   assert.equal((await reconcileImagePreparationServiceEnrollment(db,f.enrollment)).status,'committed');
   assert.equal((await db.query('SELECT status,attempt FROM project_image_preparations WHERE id=$1',[f.proposed!.id])).rows[0].status,'proposed');
   const processor=await database.tx(client=>resolveProjectImagePreparationProcessor(client,f.companyId,f.projectId));assert(processor);assert.equal(processor.id,f.serviceId);
   assert(!JSON.stringify(processor).includes('token_hash'));assert(!JSON.stringify(processor).includes('synthetic-source-etag'));
   for(const change of [{token:'ips_secret'},{databaseUrl:'SYNTHETIC_MUST_NOT_REFLECT'},{transport:'vercel_binary_v1'},{qualification:{...f.enrollment.qualification,kind:'coatria-reference-worker-qualification'}},{enroller:{...f.enrollment.enroller,joinedAt:new Date().toISOString()}},{sourceCommit:'f'.repeat(40)}])assert.throws(()=>parseImagePreparationEnrollmentRequest({...f.enrollment,...change}),e=>!String(e).includes('SYNTHETIC_MUST_NOT_REFLECT'));
   assert.notEqual(imagePreparationEnrollmentHash({...f.enrollment,closureSha256:'0'.repeat(64)}),imagePreparationEnrollmentHash(f.enrollment));
   await assert.rejects(database.tx(client=>enrollImagePreparationService(client,{...f.enrollment,location:'changed'})),{code:'IMAGE_PREPARATION_ENROLLMENT_CONFLICT'});
  });
  await t.test('same-user reinvitation, wrong token and gateway stop invalidate availability',async()=>{
   await assert.rejects(database.tx(client=>authorizeImagePreparationService(client,f.serviceId,{tokenHash:'0'.repeat(64)})),{code:'IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'});
   await database.tx(async client=>{await client.query("UPDATE memberships SET joined_at=joined_at+interval '1 microsecond' WHERE company_id=$1 AND user_id=$2",[f.companyId,f.userId]);assert.equal(await resolveProjectImagePreparationProcessor(client,f.companyId,f.projectId),null);await client.query('UPDATE memberships SET joined_at=$3 WHERE company_id=$1 AND user_id=$2',[f.companyId,f.userId,f.enrollment.enroller.joinedAt]);});
   await database.tx(async client=>{await client.query('UPDATE trusted_service_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.gateway.provisionId]);assert.equal(await resolveProjectImagePreparationProcessor(client,f.companyId,f.projectId),null);await client.query('UPDATE trusted_service_provisions SET stop_requested_at=NULL WHERE id=$1',[f.gateway.provisionId]);});
  });
  await t.test('registry evidence cannot be changed or service expiry extended',async()=>{
   for(const [sql,args]of [
    ['UPDATE project_image_preparation_services SET expires_at=expires_at+interval \'1 second\' WHERE id=$1',[f.serviceId]],
    ['UPDATE project_image_preparation_service_projects SET storage_binding_revision=storage_binding_revision+1 WHERE service_id=$1',[f.serviceId]],
    ['UPDATE project_image_preparation_service_enrollments SET identity=jsonb_set(identity,\'{location}\',\'"changed"\') WHERE service_id=$1',[f.serviceId]],
   ] as const)await assert.rejects(database.tx(client=>client.query(sql,[...args])),{code:'42501'});
  });
  await database.tx(f.approve);const lease=await database.tx(f.claim);
  await t.test('stored service lease exactly binds current M2 claim and rejects cross-service identity',async()=>{
   const identity=await database.tx(client=>authorizeImagePreparationService(client,f.serviceId,{tokenHash:hashToken(f.token)}));
   assert.deepEqual(await database.tx(client=>authorizeImagePreparationServiceLease(client,identity,{preparationId:lease.preparationId,leaseId:lease.leaseId})),lease);
   await assert.rejects(database.tx(client=>authorizeImagePreparationServiceLease(client,identity,{preparationId:randomUUID(),leaseId:lease.leaseId})),{code:'IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'});
   await assert.rejects(database.tx(client=>client.query("UPDATE project_image_preparation_service_leases SET lease=jsonb_set(lease,'{requestHash}',to_jsonb($2::text)) WHERE lease_id=$1",[lease.leaseId,'0'.repeat(64)])),{code:'42501'});
  });
  let grantId:string;
  await t.test('capability is source-exact and cannot be admitted twice or without started control call',async()=>{
   const call=randomUUID(),deadline=new Date(Math.min(Date.parse(lease.expiresAt),Date.now()+60000)).toISOString();
   await db.query("INSERT INTO project_image_preparation_service_calls(service_id,request_id,operation,request_hash,deadline_at,status) VALUES($1,$2,'byte-capability',$3,$4,'started')",[f.serviceId,call,'b'.repeat(64),deadline]);
   const cap={id:randomUUID(),service_id:f.serviceId,company_id:f.companyId,project_id:f.projectId,preparation_id:lease.preparationId,lease_id:lease.leaseId,request_id:call,request_hash:lease.requestHash,token_hash:'c'.repeat(64),operation:'read-source',action_id:null,version_id:f.versionId,upload_id:null,bytes:100,sha256:'a'.repeat(64),content_type:'image/png',expected_etag:'synthetic-source-etag',storage_binding_id:f.binding.id,storage_binding_revision:f.binding.revision,storage_connection_id:f.connection.id,storage_connection_revision:f.connection.revision,gateway_binding_id:f.gateway.bindingId,gateway_provision_id:f.gateway.provisionId,gateway_configuration_sha256:f.gateway.configurationHash,gateway_origin:f.gateway.origin,expires_at:deadline};
   const insert=(value:Record<string,unknown>)=>database.tx(client=>client.query(`INSERT INTO project_image_preparation_byte_grants(${Object.keys(value).join(',')}) VALUES(${Object.keys(value).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(value)));
   for(const change of [{bytes:99},{sha256:'e'.repeat(64)},{expected_etag:null},{gateway_provision_id:randomUUID()},{request_id:randomUUID()},{action_id:randomUUID()}])await assert.rejects(insert({...cap,...change}));
   await insert(cap);grantId=cap.id;
   await assert.rejects(insert({...cap,id:randomUUID(),token_hash:'f'.repeat(64)}),{code:'23505'});
   await assert.rejects(database.tx(client=>client.query('UPDATE project_image_preparation_byte_grants SET bytes=99 WHERE id=$1',[cap.id])),{code:'42501'});
  });
  await t.test('gateway result must start once and immutable completion cannot be replaced',async()=>{
   await assert.rejects(database.tx(client=>client.query("INSERT INTO project_image_preparation_byte_results(grant_id,status,public_result,finished_at) VALUES($1,'completed','{}',clock_timestamp())",[grantId])),{code:'23514'});
   await db.query("INSERT INTO project_image_preparation_byte_results(grant_id,status) VALUES($1,'started')",[grantId]);
   await assert.rejects(database.tx(client=>client.query("INSERT INTO project_image_preparation_byte_results(grant_id,status) VALUES($1,'started')",[grantId])),{code:'23505'});
   await assert.rejects(database.tx(client=>client.query("UPDATE project_image_preparation_byte_results SET status='completed',public_result='{}',observed_bytes=99,observed_sha256=$2,observed_etag='synthetic-source-etag',finished_at=clock_timestamp() WHERE grant_id=$1",[grantId,'a'.repeat(64)])),{code:'23514'});
   await db.query("UPDATE project_image_preparation_byte_results SET status='completed',public_result='{}',observed_bytes=100,observed_sha256=$2,observed_etag='synthetic-source-etag',finished_at=clock_timestamp() WHERE grant_id=$1",[grantId,'a'.repeat(64)]);
   await assert.rejects(database.tx(client=>client.query('UPDATE project_image_preparation_byte_results SET observed_bytes=99 WHERE grant_id=$1',[grantId])),{code:'42501'});
  });
  await t.test('failure-only grace retains exact historical lease and cannot authorize new work',async()=>{
   await db.query('UPDATE project_image_preparation_services SET revoked_at=clock_timestamp(),revoked_by=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[f.serviceId,f.userId]);
   assert.equal(await database.tx(client=>resolveProjectImagePreparationProcessor(client,f.companyId,f.projectId)),null);
   const identity=await database.tx(client=>authorizeImagePreparationService(client,f.serviceId,{tokenHash:hashToken(f.token),allowExpiredFailure:true}));
   assert.deepEqual(await database.tx(client=>authorizeImagePreparationServiceLease(client,identity,{preparationId:lease.preparationId,leaseId:lease.leaseId},{allowExpiredFailure:true})),lease);
   await assert.rejects(database.tx(client=>authorizeImagePreparationServiceLease(client,identity,{preparationId:lease.preparationId,leaseId:lease.leaseId})),{code:'IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'});
  });
  await t.test('dedicated role templates apply without expanding operator or gateway evidence authority',async()=>{
   // PGlite proves SQL/effective grants; native LOGIN proof is a separate case.
   if(database.native)return;
   await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
   for(const kind of ['broker','registrar']){await db.query('CREATE ROLE coatria_image_preparation_'+kind+'_v1 LOGIN NOINHERIT');await database.exec(await readFile('database/image-preparation-'+kind+'-permissions.sql','utf8'));}
   // The transaction callback must use the same client on PGlite; test effective
   // privileges directly without mistaking SET ROLE for production identity.
   await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_broker_v1');assert.deepEqual((await client.query("SELECT has_table_privilege(current_user,'project_image_preparation_byte_results','INSERT') AS fake_result,has_table_privilege(current_user,'project_image_preparation_approvals','INSERT') AS approve,has_table_privilege(current_user,'project_image_preparation_services','INSERT') AS enroll")).rows[0],{fake_result:false,approve:false,enroll:false});await assert.rejects(assertImagePreparationBrokerDatabase(client),{code:'IMAGE_PREPARATION_DB_IDENTITY'});assert.equal((await assertImagePreparationBrokerDatabase(client,{provisioning:true})).status,'passed');});
   await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_registrar_v1');assert.deepEqual((await client.query("SELECT has_table_privilege(current_user,'project_image_preparation_service_leases','INSERT') AS claim,has_table_privilege(current_user,'project_image_preparation_byte_results','INSERT') AS fake_result,has_column_privilege(current_user,'project_storage_connections','secret_envelope','SELECT') AS secret")).rows[0],{claim:false,fake_result:false,secret:false});await assert.rejects(assertImagePreparationRegistrarDatabase(client),{code:'IMAGE_PREPARATION_DB_IDENTITY'});assert.equal((await assertImagePreparationRegistrarDatabase(client,{provisioning:true})).status,'passed');});
   await db.query('GRANT INSERT ON project_image_preparation_byte_results TO coatria_image_preparation_broker_v1');
   await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_broker_v1');await assert.rejects(assertImagePreparationBrokerDatabase(client,{provisioning:true}),{code:'IMAGE_PREPARATION_DB_PRIVILEGES'});});
   await db.query('REVOKE INSERT ON project_image_preparation_byte_results FROM coatria_image_preparation_broker_v1');
   const g=await database.tx(client=>imagePreparationServiceFixture(client,{enroll:false}));
   await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_registrar_v1');await enrollImagePreparationService(client,g.enrollment);});
   await database.tx(g.approve);
   const claimed=await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_broker_v1');return g.claim(client);});
   await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_broker_v1');const intent=await preparations.beginProjectImagePreparationPhase(client,claimed,'transform',g.runtime);await preparations.completeProjectImagePreparationPhase(client,claimed,intent.actionId,{operation:'transform',sourceVersionId:g.versionId,sourceSha256:'a'.repeat(64),sourceBytes:100,source:{format:'png',width:16,height:16,orientation:1},recipeSha256:claimed.recipeSha256,processor:claimed.processor,output:{bytes:80,sha256:'d'.repeat(64),width:16,height:16,format:'png',pixelFormat:'rgba8',metadataRemoved:true}},g.runtime);});
   await database.tx(async client=>{await client.query('SET LOCAL ROLE coatria_image_preparation_broker_v1');await reserveProjectImagePreparationOutput(client,claimed,g.runtime);assert(await resolveProjectImagePreparationProcessor(client,g.companyId,g.projectId));});
  });
  await t.test('native restricted identities require independent PostgreSQL LOGIN',{skip:!database.native},async()=>{
   assert(database.connectionString);assert(database.control);
   const lock=await database.control.connect(),created:string[]=[];
   await lock.query('SELECT pg_advisory_lock(739284033)');
   try{
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    for(const kind of ['broker','registrar']){
     const role='coatria_image_preparation_'+kind+'_v1',password=randomBytes(32).toString('hex');
     assert.equal((await lock.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0,'Never alter an existing role');
     await lock.query('CREATE ROLE '+role+" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'");created.push(role);
     await database.exec(await readFile('database/image-preparation-'+kind+'-permissions.sql','utf8'));
     const url:URL=new URL(database.connectionString);url.username=role;url.password=password;const pool:Pool=new Pool({connectionString:url.href,max:1});
     try{const client:PoolClient=await pool.connect();try{const validator=kind==='broker'?assertImagePreparationBrokerDatabase:assertImagePreparationRegistrarDatabase;assert.equal((await validator(client)).independentLogin,true);assert.deepEqual((await client.query('SELECT current_user,session_user')).rows[0],{current_user:role,session_user:role});}finally{client.release();}}finally{await pool.end();}
    }
   }finally{try{for(const role of created.reverse()){await db.query('DROP OWNED BY '+role);await lock.query('DROP ROLE '+role);}}finally{await lock.query('SELECT pg_advisory_unlock(739284033)');lock.release();}}
  });
 }finally{await database.close();}
});
