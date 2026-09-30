import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {HIGGSFIELD_REFERENCE_REGISTRAR_ROLE as ROLE,REFERENCE_REGISTRAR_CONTRACT as CONTRACT,REFERENCE_REGISTRAR_LOCK_BODY,REFERENCE_REGISTRAR_LOCK_TABLES,REFERENCE_REGISTRAR_ENROLLMENT_BODY,assertHiggsfieldReferenceRegistrarDatabase} from '../src/lib/higgsfield-reference-registrar-database.mjs';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=(()=>{try{return !!integration&&['127.0.0.1','localhost'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();

test('registrar provisioner validates stdin credentials and verified direct TLS without exposing input',async()=>{
 const {parseReferenceRegistrarProvisionInput}=await import('../scripts/provision-reference-registrar-role.mjs');
 const url=new URL('postgresql://127.0.0.1:5432/fixture');url.username='owner';url.password='synthetic-memory-only';
 const input={connectionString:url.href,password:'f'.repeat(40)},parsed=parseReferenceRegistrarProvisionInput(input);
 assert.equal(parsed.clientConfig.application_name,'coatria-reference-registrar-role-provisioner');assert.equal(parsed.clientConfig.ssl,false);
 const direct=new URL(url);direct.hostname='fixture.eu-central-1.aws.neon.tech';
 const remote=parseReferenceRegistrarProvisionInput({...input,connectionString:direct.href});
 assert.deepEqual(remote.clientConfig.ssl,{rejectUnauthorized:true});assert.equal(remote.clientConfig.enableChannelBinding,true);
 for(const change of[{password:'short'},{extra:'forbidden'},{connectionString:direct.href+'?sslmode=disable'},{connectionString:direct.href+'?options=unsafe'},{connectionString:direct.href.replace('fixture.','fixture-pooler.')},{connectionString:direct.href.replace('neon.tech','example.invalid')}]){
  assert.throws(()=>parseReferenceRegistrarProvisionInput({...input,...change}),error=>{assert(!String(error).includes(url.password));assert(!String(error).includes(input.password));return true;});
 }
});

test('registrar grants are metadata-only and preserve reviewed inert-lock and immutable-enrollment bodies',async()=>{
 const sql=(await readFile('database/reference-registrar-permissions.sql','utf8')).replaceAll('\r\n','\n');
 const expected:string[]=[];
 for(const[table,spec]of Object.entries(CONTRACT))for(const[priv,cols]of Object.entries(spec))expected.push('GRANT '+priv+(Array.isArray(cols)?'('+cols.join(',')+')':'')+' ON '+table+' TO '+ROLE+';');
 assert.deepEqual(sql.split('\n').filter(line=>line.startsWith('GRANT ')&&!line.includes(' ON SCHEMA ')),expected);
 assert(!CONTRACT.higgsfield_connections.SELECT.includes('sealed'));assert(!CONTRACT.project_storage_connections.SELECT.includes('secret_envelope'));
 assert(!CONTRACT.project_storage_connections.SELECT.includes('volume_id'));assert(!Object.values(CONTRACT).some(spec=>'DELETE'in spec));
 assert(sql.includes('$guard$\n'+REFERENCE_REGISTRAR_LOCK_BODY+'\n$guard$;'));
 for(const table of REFERENCE_REGISTRAR_LOCK_TABLES)assert(sql.includes('ALTER TABLE public.'+table+' ENABLE ALWAYS TRIGGER coatria_reference_registrar_lock_guard;'));
 const migration=(await readFile('database/044_higgsfield_reference_enrollments.sql','utf8')).replaceAll('\r\n','\n');
 assert(migration.includes('AS $$\n'+REFERENCE_REGISTRAR_ENROLLMENT_BODY+' $$;'));
 for(const [field,column]of [['serviceId','service_id'],['companyId','company_id'],['requestId','request_id']])assert(migration.includes("CHECK((identity->>'"+field+"') IS NOT DISTINCT FROM "+column+'::text)'));
 assert(migration.includes('pg_column_size(identity)<=65536'));assert(migration.includes('ON DELETE CASCADE'));assert(!migration.includes('BEFORE DELETE'));
});

test('registrar preflight rejects unexpected database errors without raw database details',async()=>{
 const raw='synthetic sensitive database transport detail';
 await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase({query:async()=>{throw Error(raw);}}),error=>{
  assert.equal((error as {code?:string}).code,'REFERENCE_REGISTRAR_DB_CHECK_FAILED');assert(!String(error).includes(raw));return true;
 });
});

// Only a disposable loopback PostgreSQL database qualifies: no PGlite or
// SET ROLE substitute for actual registrar/application/worker LOGIN coverage.
test('PostgreSQL registrar LOGIN has exact enrollment grants and no other authority',{skip:!local,timeout:180000},async t=>{
 const {provisionReferenceRegistrarRole}=await import('../scripts/provision-reference-registrar-role.mjs');
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_registrar_'+suffix;
 const control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000});
 const ownerUrl=new URL(integration!);ownerUrl.pathname='/'+dbName;
 let owner:Pool|undefined,registrar:Pool|undefined,controlClient:PoolClient|undefined,created=false,roleAbsent=false;
 const auxiliary:{role:string,pool:Pool}[]=[],password=randomBytes(32).toString('hex');
 const identity=async(db:Pool|PoolClient,role=ROLE)=>{assert.deepEqual((await db.query('SELECT current_user,session_user')).rows[0],{current_user:role,session_user:role});};
 const denied=async(db:Pool,sql:string,values:unknown[]=[])=>{await assert.rejects(db.query(sql,values),{code:'42501'});};
 try{
  controlClient=await control.connect();await controlClient.query('SELECT pg_advisory_lock(739284011)');
  assert.equal((await controlClient.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount,0,'Fixture registrar role must not preexist');roleAbsent=true;
  await controlClient.query('CREATE DATABASE '+dbName);created=true;
  owner=new Pool({connectionString:ownerUrl.href,max:2,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of(await readdir('database')).filter(n=>/^\d.*\.sql$/.test(n)).sort()){await owner.query(await readFile('database/'+name,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
  for(const[kind,file,original]of [
   ['runtime','runtime-permissions.sql','coatria_runtime_v1'],['broker','reference-broker-permissions.sql','coatria_higgsfield_reference_broker_v1'],
   ['archive','higgsfield-archive-worker-permissions.sql','coatria_higgsfield_archive_worker_v1'],['gateway','storage-gateway-permissions.sql','coatria_storage_gateway_v1']]){
   const role='coatria_rr_'+kind+'_'+suffix,secret=randomBytes(32).toString('hex');
   await controlClient.query('CREATE ROLE '+role+" LOGIN PASSWORD '"+secret+"' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
   const login=new URL(ownerUrl);login.username=role;login.password=secret;
   const pool=new Pool({connectionString:login.href,max:1,connectionTimeoutMillis:10000});auxiliary.push({role,pool});
   await owner.query((await readFile('database/'+file,'utf8')).replaceAll(original,role));await identity(pool,role);
  }
  const snapshot=async()=>(await owner!.query(`SELECT c.relname,a.attname,r.name,p.priv,has_column_privilege(r.name,c.oid,a.attnum,p.priv) AS allowed
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   CROSS JOIN unnest($1::text[]) r(name) CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(priv)
   WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname,a.attname,r.name,p.priv`,[auxiliary.map(v=>v.role)])).rows;
  const before=await snapshot(),provisioned=await provisionReferenceRegistrarRole({connectionString:ownerUrl.href,password});
  assert.equal(provisioned?.verification.independentLogin,true);assert.deepEqual(await snapshot(),before);
  const login=new URL(ownerUrl);login.username=ROLE;login.password=password;
  registrar=new Pool({connectionString:login.href,max:1,connectionTimeoutMillis:10000});await identity(registrar);
  const grants=await readFile('database/reference-registrar-permissions.sql','utf8');
  await t.test('independent LOGIN preflight rejects impersonation, effective grant drift and altered ALWAYS guards',async()=>{
   assert.equal((await assertHiggsfieldReferenceRegistrarDatabase(registrar!)).status,'passed');
   await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase(owner!),{code:'REFERENCE_REGISTRAR_DB_IDENTITY'});
   const impersonation=await owner!.connect();try{await impersonation.query('SET ROLE '+ROLE);await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase(impersonation),{code:'REFERENCE_REGISTRAR_DB_IDENTITY'});}finally{await impersonation.query('RESET ROLE');impersonation.release();}
   for(const sql of['GRANT SELECT(sealed) ON higgsfield_connections TO '+ROLE,'GRANT UPDATE(token_hash) ON higgsfield_reference_services TO '+ROLE,'GRANT SELECT ON schema_migrations TO '+ROLE+' WITH GRANT OPTION']){
    await owner!.query(sql);try{await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase(registrar!),{code:'REFERENCE_REGISTRAR_DB_PRIVILEGES'});}finally{await owner!.query(grants);}
   }
   await owner!.query('ALTER TABLE studio_projects DISABLE TRIGGER coatria_reference_registrar_lock_guard');
   try{await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase(registrar!),{code:'REFERENCE_REGISTRAR_DB_GUARD'});}finally{await owner!.query(grants);}
   for(const name of['coatria_reference_registrar_readonly_lock_guard','guard_higgsfield_reference_enrollment']){
    const original=(await owner!.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',['public.'+name+'()'])).rows[0].definition;
    try{await owner!.query('CREATE OR REPLACE FUNCTION public.'+name+"() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'");await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase(registrar!),{code:'REFERENCE_REGISTRAR_DB_GUARD'});}finally{await owner!.query(original);}
   }
   await controlClient!.query('GRANT '+auxiliary[0].role+' TO '+ROLE);
   try{await assert.rejects(()=>assertHiggsfieldReferenceRegistrarDatabase(registrar!),{code:'REFERENCE_REGISTRAR_DB_ROLE'});}finally{await controlClient!.query('REVOKE '+auxiliary[0].role+' FROM '+ROLE);}
   assert.equal((await assertHiggsfieldReferenceRegistrarDatabase(registrar!)).status,'passed');
   await assert.rejects(()=>provisionReferenceRegistrarRole({connectionString:ownerUrl.href,password:randomBytes(32).toString('hex')}),{code:'ROLE_EXISTS'});await identity(registrar!);
  });
  const companyId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),providerId=randomUUID(),connectionId=randomUUID(),bindingId=randomUUID(),serviceId=randomUUID(),requestId=randomUUID(),sha='b'.repeat(64);
  await owner.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Registrar fixture',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  await owner.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Registrar fixture',$2,'blank')",[companyId,companyId]);
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);
  await owner.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Registrar fixture','Internal','Synthetic permission test','{}','allowed','production','{}',$3,'higgsfield')",[projectId,companyId,userId]);
  await owner.query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,tools,expires_at) VALUES($1,$2,'connected',$3,'{}','[]',clock_timestamp()+interval '1 hour')",[companyId,providerId,userId]);
  await owner.query("INSERT INTO project_storage_connections(id,company_id,name,region,volume_id,secret_envelope,created_by) VALUES($1,$2,'Registrar fixture','US-NC-2','fixture-only','{}',$3)",[connectionId,companyId,userId]);
  await owner.query('INSERT INTO project_storage_bindings(id,company_id,project_id,connection_id,created_by) VALUES($1,$2,$3,$4,$5)',[bindingId,companyId,projectId,connectionId,userId]);
  await t.test('locks metadata but cannot mutate timestamps, secrets, memberships, projects or provider authority',async()=>{
   const client=await registrar!.connect();try{
    await client.query('BEGIN');await identity(client);
    for(const [table,key,id]of [['companies','id',companyId],['memberships','company_id',companyId],['studio_projects','id',projectId],['higgsfield_connections','id',providerId],['project_storage_connections','id',connectionId],['project_storage_bindings','id',bindingId]])await client.query('SELECT '+key+' FROM '+table+' WHERE '+key+'=$1 FOR UPDATE',[id]);
    await client.query('COMMIT');
   }finally{await client.query('ROLLBACK');client.release();}
   for(const [table,key,id,time]of [['companies','id',companyId,'created_at'],['memberships','company_id',companyId,'joined_at'],['studio_projects','id',projectId,'updated_at'],['higgsfield_connections','id',providerId,'updated_at'],['project_storage_connections','id',connectionId,'created_at'],['project_storage_bindings','id',bindingId,'created_at']])await denied(registrar!,'UPDATE '+table+" SET "+time+'='+time+"+interval '1 second' WHERE "+key+'=$1',[id]);
   for(const sql of['SELECT sealed FROM higgsfield_connections','SELECT secret_envelope FROM project_storage_connections','SELECT * FROM sessions','SELECT password_hash FROM users','SELECT token_hash FROM agents','UPDATE memberships SET role=role','UPDATE studio_projects SET gates=gates','UPDATE project_storage_connections SET revision=revision','UPDATE higgsfield_connections SET revision=revision','CREATE TABLE public.registrar_escape(id int)','CREATE ROLE registrar_escape','ALTER TABLE higgsfield_reference_service_enrollments DISABLE TRIGGER ALL','SET ROLE '+auxiliary[0].role])await denied(registrar!,sql);
  });
  // Permission fixture only: host qualification validity is tested by the
  // separate real enrollment transaction fixture, not invented by these rows.
  const identityValue={version:1,requestId,serviceId,companyId,fixtureOnly:true};
  await t.test('registrar atomically stores enrollment scope; immutable identity and exact foreign keys are enforced',async()=>{
   const client=await registrar!.connect();try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO higgsfield_reference_services(id,company_id,token_hash,enrolled_by,release_sha256,qualification_sha256,profile_sha256,provider_connection_id,provider_connection_revision,catalog_sha256,upload_hosts,expires_at)
     VALUES($1,$2,$3,$4,$3,$3,$3,$5,1,$3,'["fixture.invalid"]',clock_timestamp()+interval '30 minutes')`,[serviceId,companyId,sha,userId,providerId]);
    await client.query('INSERT INTO higgsfield_reference_service_projects(service_id,company_id,project_id,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision) VALUES($1,$2,$3,$4,1,$5,1)',[serviceId,companyId,projectId,bindingId,connectionId]);
    await client.query('INSERT INTO higgsfield_reference_service_enrollments(service_id,company_id,request_id,request_hash,identity) VALUES($1,$2,$3,$4,$5)',[serviceId,companyId,requestId,sha,JSON.stringify(identityValue)]);
    await client.query('COMMIT');
   }finally{await client.query('ROLLBACK');client.release();}
   assert.deepEqual((await registrar!.query('SELECT identity FROM higgsfield_reference_service_enrollments WHERE service_id=$1',[serviceId])).rows[0].identity,identityValue);
   for(const sql of['UPDATE higgsfield_reference_service_enrollments SET request_hash=request_hash','DELETE FROM higgsfield_reference_service_enrollments','UPDATE higgsfield_reference_services SET token_hash=token_hash','UPDATE higgsfield_reference_service_projects SET storage_binding_revision=storage_binding_revision','INSERT INTO higgsfield_reference_service_leases(service_id) VALUES($1)','INSERT INTO higgsfield_references(company_id) VALUES($1)'])await denied(registrar!,sql,sql.includes('$1')?[serviceId]:[]);
   await assert.rejects(owner!.query("UPDATE higgsfield_reference_service_enrollments SET identity=identity||'{\"changed\":true}' WHERE service_id=$1",[serviceId]),{code:'42501'});
   const insert='INSERT INTO higgsfield_reference_service_enrollments(service_id,company_id,request_id,request_hash,identity) VALUES($1,$2,$3,$4,$5)';
   for(const bad of [{},{...identityValue,serviceId:randomUUID()},{...identityValue,companyId:randomUUID()},{...identityValue,requestId:randomUUID()},[]])await assert.rejects(registrar!.query(insert,[serviceId,companyId,requestId,sha,JSON.stringify(bad)]),{code:'23514'});
   const oversized={...identityValue,padding:randomBytes(40000).toString('hex')};await assert.rejects(registrar!.query(insert,[serviceId,companyId,requestId,sha,JSON.stringify(oversized)]),{code:'23514'});
  });
  await t.test('independent application, broker, archive and gateway logins cannot enroll or modify enrollment identity',async()=>{
   for(const {role,pool}of auxiliary){
    await identity(pool,role);
    for(const sql of['INSERT INTO higgsfield_reference_services(id) VALUES($1)','INSERT INTO higgsfield_reference_service_projects(service_id) VALUES($1)','INSERT INTO higgsfield_reference_service_enrollments(service_id) VALUES($1)','UPDATE higgsfield_reference_service_enrollments SET identity=identity WHERE service_id=$1','DELETE FROM higgsfield_reference_service_enrollments WHERE service_id=$1'])await denied(pool,sql,[serviceId]);
    await denied(pool,'SET ROLE '+ROLE);
   }
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('enrollment immutability does not block owner-controlled company cascades',async()=>{
   await owner!.query('DELETE FROM companies WHERE id=$1',[companyId]);
   assert.equal((await owner!.query('SELECT 1 FROM higgsfield_reference_service_enrollments WHERE service_id=$1',[serviceId])).rowCount,0);
  });
 }finally{
  await registrar?.end();for(const {pool}of auxiliary)await pool.end();await owner?.end();
  if(created)await dropFixtureDatabase(controlClient!,dbName);
  if(roleAbsent&&(await controlClient!.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount)await controlClient!.query('DROP ROLE '+ROLE);
  for(const {role}of auxiliary)await controlClient!.query('DROP ROLE '+role);
  if(controlClient){await controlClient.query('SELECT pg_advisory_unlock(739284011)');controlClient.release();}await control.end();
 }
});
