/** Real public API/auth and exact runtime-role grants. Qualification, storage
 * and enrollment records are synthetic fixtures, never host or byte proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {publicImagePreparationProcessor} from '../src/lib/project-image-preparation-public-runtime';
import {imagePreparationBrokerTransaction} from '../src/lib/project-image-preparation-service-runtime';
import {assertImagePreparationBrokerDatabase,IMAGE_PREPARATION_BROKER_ROLE} from '../src/lib/project-image-preparation-database.mjs';
import {imagePreparationServiceFixture} from './fixtures/image-preparation-service';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const ROLE='coatria_runtime_v1',origin='https://coatria.com';
type Fixture=Awaited<ReturnType<typeof imagePreparationServiceFixture>>;
test('public preparation readiness and consent use current same-transaction enrollment under the web role',{timeout:180000},async t=>{
 const globals=globalThis as unknown as {coatriaPool?:Pool;coatriaImagePreparationBroker?:{connectionString:string;pool:Pool;ready:Promise<void>}};
 assert.equal(globals.coatriaPool,undefined);assert.equal(globals.coatriaImagePreparationBroker,undefined);
 const keys=['DATABASE_URL','DATABASE_POOL_MAX','COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL','COATRIA_HOSTING_KEYRING'] as const,saved=Object.fromEntries(keys.map(key=>[key,process.env[key]])),oldFetch=globalThis.fetch;
 const integration=process.env.COATRIA_TEST_EMULATOR==='1'?undefined:process.env.COATRIA_INTEGRATION_DATABASE_URL,native=Boolean(integration),files=(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort();
 let owner:Pool,runtime:Pool,brokerUrl:string,stop:()=>Promise<void>,outbound=0;
 if(integration){
  const url=new URL(integration);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
  const control=new Pool({connectionString:integration,max:1}),lock=await control.connect(),name='coatria_public_preparation_'+randomUUID().replaceAll('-','');await lock.query('SELECT pg_advisory_lock(739284011)');await lock.query('SELECT pg_advisory_lock(739284033)');let created=false;const roles:string[]=[];
  url.pathname='/'+name;owner=new Pool({connectionString:url.href,max:2});const password=randomBytes(32).toString('hex'),runtimeUrl=new URL(url);runtimeUrl.username=ROLE;runtimeUrl.password=password;runtime=new Pool({connectionString:runtimeUrl.href,max:2});const broker=new URL(url);broker.username=IMAGE_PREPARATION_BROKER_ROLE;broker.password=password;brokerUrl=broker.href;
  stop=async()=>{if(globals.coatriaImagePreparationBroker)await globals.coatriaImagePreparationBroker.pool.end();await runtime.end();await owner.end();try{if(created)await dropFixtureDatabase(lock,name);for(const role of roles.reverse())await lock.query('DROP ROLE '+role);}finally{await lock.query('SELECT pg_advisory_unlock(739284033)');await lock.query('SELECT pg_advisory_unlock(739284011)');lock.release();await control.end();}};
  try{for(const role of [ROLE,IMAGE_PREPARATION_BROKER_ROLE])assert.equal((await lock.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0,'Do not alter an existing role');await lock.query('CREATE DATABASE '+name);created=true;for(const role of [ROLE,IMAGE_PREPARATION_BROKER_ROLE]){await lock.query('CREATE ROLE '+role+" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'");roles.push(role);}await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of files){await owner.query(await readFile('database/'+file,'utf8'));await owner.query('INSERT INTO schema_migrations VALUES($1)',[file]);}await owner.query(await readFile('database/runtime-permissions.sql','utf8'));await owner.query(await readFile('database/image-preparation-broker-permissions.sql','utf8'));process.env.DATABASE_URL=runtimeUrl.href;}
  catch(error){await stop();throw error;}
 }else{
  const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),raw=await PGlite.create();
  try{await raw.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of files){await raw.exec(await readFile('database/'+file,'utf8'));await raw.query('INSERT INTO schema_migrations VALUES($1)',[file]);}for(const role of [ROLE,IMAGE_PREPARATION_BROKER_ROLE])await raw.exec('CREATE ROLE '+role+' LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');await raw.exec(await readFile('database/runtime-permissions.sql','utf8'));await raw.exec(await readFile('database/image-preparation-broker-permissions.sql','utf8'));}catch(error){await raw.close();throw error;}
  const socket=new PGLiteSocketServer({db:raw,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const connectionString='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres';owner=new Pool({connectionString,max:1});runtime=owner;brokerUrl='postgresql://'+IMAGE_PREPARATION_BROKER_ROLE+':synthetic@localhost/unused';process.env.DATABASE_URL=connectionString;
  stop=async()=>{await owner.end();await socket.stop();await raw.close();};
 }
 globals.coatriaPool=runtime;process.env.DATABASE_POOL_MAX=native?'2':'1';delete process.env.COATRIA_HOSTING_KEYRING;
 globalThis.fetch=async()=>{outbound++;throw Error('No provider operations in public readiness fixture');};
 const admin=async<T>(run:(db:PoolClient)=>Promise<T>)=>{const db=await owner.connect();try{if(!native)await db.query('SET SESSION AUTHORIZATION postgres');return await run(db);}finally{if(!native)await db.query('SET SESSION AUTHORIZATION '+ROLE);db.release();}};
 const tx=async<T>(run:(db:PoolClient)=>Promise<T>)=>{const db=await runtime.connect();try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
 const fixture=()=>admin(async db=>{const f=await imagePreparationServiceFixture(db),session=randomUUID();await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),f.userId]);return {...f,session};});
 async function api(f:Fixture&{session:string},tail='',payload?:unknown){const method=payload===undefined?'GET':'POST',path='companies/'+f.companyId+'/image-preparations'+tail,headers=new Headers({Cookie:'coatria_session='+f.session});if(method==='POST'){headers.set('Origin',origin);headers.set('Content-Type','application/json');}const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/')),value=await response.json();assert.doesNotMatch(JSON.stringify(value),/ips_|ipt_|token_hash|secret_envelope|leaseId|gateway_origin|rps_synthetic|user_synthetic/);return {status:response.status,value};}
 const approve=(f:Fixture&{session:string})=>api(f,'/'+f.proposed!.id+'/approve',{clientId:randomUUID(),revision:f.proposed!.revision,requestHash:f.proposed!.requestHash,processorId:f.serviceId,qualificationSha256:f.enrollment.qualificationSha256,expiresInMinutes:5,maxCostMicrousd:0,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true});
 const denied=(sql:string,values:unknown[]=[])=>assert.rejects(tx(db=>db.query(sql,values)),{code:'42501'});
 try{
  await t.test('no broker or failed effective preflight stays unavailable before enrollment reads',async()=>{
   const f=await fixture();delete process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL;let checks=0;
   const noRead={query(){assert.fail('Unconfigured availability must not read enrollment');}} as unknown as PoolClient;
   assert.equal(await publicImagePreparationProcessor(noRead,f.companyId,f.projectId,undefined,{brokerReady:async()=>{checks++;}}),null);assert.equal(checks,0);
   assert.equal((await api(f,'?projectId='+f.projectId)).value.processing.enabled,false);assert.equal((await approve(f)).status,503);
   process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL=brokerUrl;
   assert.equal(await publicImagePreparationProcessor(noRead,f.companyId,f.projectId,undefined,{brokerReady:async()=>{checks++;throw Error('Effective grants rejected');}}),null);assert.equal(checks,1);
  });
  // PGlite proves effective SQL authority with SET SESSION AUTHORIZATION. The
  // native branch uses the actual broker pool and independent LOGIN preflight.
  if(native)await imagePreparationBrokerTransaction();else{
   await admin(async db=>{await db.query('SET SESSION AUTHORIZATION '+IMAGE_PREPARATION_BROKER_ROLE);try{await assertImagePreparationBrokerDatabase(db);}finally{await db.query('SET SESSION AUTHORIZATION postgres');}});
   globals.coatriaImagePreparationBroker={connectionString:brokerUrl,pool:owner,ready:Promise.resolve()};
  }
  await t.test('native app and broker use independent restricted LOGIN sessions',{skip:!native},async()=>{
   assert.deepEqual((await runtime.query('SELECT current_user,session_user')).rows[0],{current_user:ROLE,session_user:ROLE});const broker=await imagePreparationBrokerTransaction();await broker(async db=>assert.deepEqual((await db.query('SELECT current_user,session_user')).rows[0],{current_user:IMAGE_PREPARATION_BROKER_ROLE,session_user:IMAGE_PREPARATION_BROKER_ROLE}));
  });
  await t.test('default authenticated API returns safe availability and real human approval/revocation under runtime role',async()=>{
   const f=await fixture();assert.equal((await runtime.query('SELECT current_user')).rows[0].current_user,ROLE);
   const listing=await api(f,'?projectId='+f.projectId);assert.equal(listing.status,200,JSON.stringify(listing.value));assert.equal(listing.value.processing.enabled,true);assert.equal(listing.value.processing.processor.id,f.serviceId);
   const detail=await api(f,'/'+f.proposed!.id);assert.equal(detail.value.processing.enabled,true);
   const approved=await approve(f);assert.equal(approved.status,200,JSON.stringify(approved.value));assert.equal(approved.value.preparation.status,'queued');assert.equal(approved.value.preparation.approval.processor.id,f.serviceId);
   const stopped=await api(f,'/'+f.proposed!.id+'/revoke',{clientId:randomUUID(),revision:approved.value.preparation.revision,note:'Synthetic cleanup'});assert.equal(stopped.status,200);assert.equal(stopped.value.preparation.status,'revoked');
   assert.equal(Number((await admin(db=>db.query('SELECT count(*) n FROM project_image_preparation_service_calls WHERE service_id=$1',[f.serviceId]))).rows[0].n),0);
  });
  await t.test('resolver uses the supplied authorized transaction and never borrows broker execution authority',async()=>{
   const f=await fixture();let preflightCalls=0;await tx(async db=>{const processor=await publicImagePreparationProcessor(db,f.companyId,f.projectId,f.serviceId,{brokerReady:async()=>{preflightCalls++;assert.equal((await db.query('SELECT current_user')).rows[0].current_user,ROLE);return (async()=>{assert.fail('Broker execution must not resolve public authority');});}});assert.equal(processor?.id,f.serviceId);});assert.equal(preflightCalls,1);
   assert.equal(await tx(db=>publicImagePreparationProcessor(db,randomUUID(),f.projectId)),null);assert.equal(await tx(db=>publicImagePreparationProcessor(db,f.companyId,f.projectId,randomUUID())),null);
  });
  await t.test('actual current agent list/get can discover availability without approval or execution tools',async()=>{
   const f=await fixture(),agentId=randomUUID(),token='ca_'+randomUUID()+randomUUID(),caps=['storage.read','studio.read','studio.write','tasks.write'];
   await admin(async db=>{await db.query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Preparation reader','custom',$3,$4,'admins',$5)",[agentId,f.companyId,hashToken(token),f.userId,JSON.stringify(caps)]);await db.query("UPDATE studio_role_bindings SET agent_id=$2,human_id=NULL WHERE company_id=$1 AND role_key='ingest'",[f.companyId,agentId]);});
   async function request(path:string,payload:unknown,agent=false){const headers=new Headers({'Content-Type':'application/json',Origin:origin});headers.set(agent?'Authorization':'Cookie',agent?'Bearer '+token:'coatria_session='+f.session);const response=await handleApi(new Request(origin+'/api/'+path,{method:'POST',headers,body:JSON.stringify(payload)}),path.split('/'));return {status:response.status,value:await response.json()};}
   const created=await request('companies/'+f.companyId+'/conversations/commons/runs',{clientId:randomUUID(),agentId,prompt:'Read the exact preparation and current processor availability; do not approve or execute.'});assert.equal(created.status,201,JSON.stringify(created.value));const runId=created.value.run.id;
   const claim=await request('agent/runs/claim',{claimId:randomUUID(),workerId:'offline-public-preparation'},true);assert.equal(claim.status,200,JSON.stringify(claim.value));assert.equal(claim.value.run.id,runId);
   const tool=(name:string,args:unknown)=>request('agent/tools/'+name,{runId,leaseToken:claim.value.leaseToken,requestId:randomUUID(),arguments:args},true);
   for(const [name,args]of [['project_image_preparations_list',{projectId:f.projectId}],['project_image_preparation_get',{preparationId:f.proposed!.id}]] as const){const value=await tool(name,args);assert.equal(value.status,200,JSON.stringify(value.value));assert.equal(value.value.result.processing.enabled,true);assert.equal(value.value.result.processing.processor.id,f.serviceId);assert.doesNotMatch(JSON.stringify(value.value),/ips_|ipt_|token_hash|secret_envelope|gateway_origin/);}
   assert.equal((await tool('project_image_preparation_approve',{preparationId:f.proposed!.id})).status,404);
   await admin(db=>db.query('UPDATE project_image_preparation_services SET revoked_at=clock_timestamp(),revoked_by=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[f.serviceId,f.userId]));const current=await tool('project_image_preparation_get',{preparationId:f.proposed!.id});assert.equal(current.status,200);assert.equal(current.value.result.processing.enabled,false);
  });
  await t.test('service revocation, current sponsor, storage and gateway changes close public readiness',async()=>{
   for(const kind of ['service','sponsor','connection','gateway','generic'] as const){const f=await fixture();await admin(async db=>{if(kind==='service')await db.query('UPDATE project_image_preparation_services SET revoked_at=clock_timestamp(),revoked_by=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[f.serviceId,f.userId]);else if(kind==='sponsor')await db.query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.companyId,f.userId]);else if(kind==='connection')await db.query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL,revision=revision+1 WHERE id=$1",[f.connection.id]);else if(kind==='gateway')await db.query('UPDATE project_gateway_bindings SET revoked_at=clock_timestamp() WHERE id=$1',[f.gateway.bindingId]);else{
     // A changed provider configuration cannot retain enrollment authority.
     // Root's separate gateway-binding suite covers a fully matching generic gateway.
     await db.query('ALTER TABLE trusted_service_provisions DISABLE TRIGGER USER');try{await db.query("UPDATE trusted_service_provisions SET preset=jsonb_set(preset,'{configuration}',(preset->'configuration')-'imagePreparation') WHERE id=$1",[f.gateway.provisionId]);}finally{await db.query('ALTER TABLE trusted_service_provisions ENABLE TRIGGER USER');}
    }});const value=await api(f,'?projectId='+f.projectId);assert.equal(value.status,200,JSON.stringify(value.value));assert.equal(value.value.processing.enabled,false,kind);}
  });
  await t.test('app SELECT/lock grants cannot create or change tokens, enrollment, capabilities, bytes or worker phases',async()=>{
   const f=await fixture(),before=(await admin(db=>db.query('SELECT row_to_json(s) row FROM project_image_preparation_services s WHERE id=$1',[f.serviceId]))).rows[0].row;
   await tx(db=>db.query('SELECT id FROM project_image_preparation_services WHERE id=$1 FOR SHARE',[f.serviceId]));
   await denied("UPDATE project_image_preparation_services SET created_at=created_at-interval '1 second' WHERE id=$1",[f.serviceId]);
   for(const field of ['token_hash','expires_at','revoked_at','revoked_by','revision','updated_at'])await denied('UPDATE project_image_preparation_services SET '+field+'='+field+' WHERE id=$1',[f.serviceId]);
   for(const table of ['project_image_preparation_services','project_image_preparation_service_projects','project_image_preparation_service_enrollments','project_image_preparation_service_leases','project_image_preparation_service_calls','project_image_preparation_byte_grants','project_image_preparation_byte_results','project_image_preparation_allocations','project_image_preparation_derivations']){await denied('INSERT INTO '+table+' SELECT * FROM '+table+' WHERE false');await denied('DELETE FROM '+table+' WHERE false');}
   for(const table of ['project_image_preparation_service_leases','project_image_preparation_service_calls','project_image_preparation_byte_grants','project_image_preparation_byte_results'])await denied('SELECT * FROM '+table+' LIMIT 1');
   for(const field of ['attempt','lease_id','action_id','transform_result','cleanup_confirmed_at'])await denied('UPDATE project_image_preparations SET '+field+'='+field+' WHERE id=$1',[f.proposed!.id]);
   assert.deepEqual((await admin(db=>db.query('SELECT row_to_json(s) row FROM project_image_preparation_services s WHERE id=$1',[f.serviceId]))).rows[0].row,before);
  });
  assert.equal(outbound,0);
 }finally{globalThis.fetch=oldFetch;await stop();delete globals.coatriaPool;delete globals.coatriaImagePreparationBroker;for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});
