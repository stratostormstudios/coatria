import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {enrollReferenceService,reconcileReferenceService} from '../scripts/hosting/reference-enrollment-transaction.mjs';
import {referenceEnrollmentHash,referenceEnrollmentLockKey} from '../scripts/hosting/reference-enrollment-contract.mjs';
import {HIGGSFIELD_REFERENCE_REGISTRAR_ROLE as ROLE} from '../src/lib/higgsfield-reference-registrar-database.mjs';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const tools=[
 {name:'media_upload',description:'Synthetic upload schema',inputSchema:{type:'object',properties:{filename:{type:'string'},content_type:{type:'string'},method:{type:'string',enum:['upload_url']}},additionalProperties:false}},
 {name:'media_confirm',description:'Synthetic confirmation schema',inputSchema:{type:'object',properties:{media_id:{type:'string'},type:{type:'string',enum:['image','video','audio','file']}},required:['type'],additionalProperties:false}}
];

test('actual PostgreSQL registrar transaction preserves atomic enrollment and current authority across lock waits',{skip:!local,timeout:240000},async t=>{
 const {provisionReferenceRegistrarRole}=await import('../scripts/provision-reference-registrar-role.mjs');
 const name='coatria_ref_enroll_'+randomUUID().replaceAll('-',''),control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000});
 const ownerUrl=new URL(integration!);ownerUrl.pathname='/'+name;
 let controlClient:PoolClient|undefined,owner:Pool|undefined,registrar:Pool|undefined,created=false,roleAbsent=false;
 const priorFetch=globalThis.fetch;let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;throw Error('No provider calls permitted in enrollment fixture');};
 const identity=async(client:PoolClient)=>{const row=(await client.query('SELECT current_user,session_user')).rows[0];assert.equal(row.current_user,ROLE);assert.equal(row.session_user,ROLE);};
 const run=async(fn:typeof enrollReferenceService,input:any)=>{const client=await registrar!.connect();try{await identity(client);return await fn(client,input);}finally{client.release();}};
 const empty=async(serviceId:string)=>{for(const table of ['higgsfield_reference_services','higgsfield_reference_service_projects','higgsfield_reference_service_enrollments'])assert.equal((await owner!.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table==='higgsfield_reference_services'?'id':'service_id'}=$1`,[serviceId])).rows[0].n,0);};
 async function seed(){
  const companyId=randomUUID(),enrolledBy=randomUUID(),providerSponsor=randomUUID(),storageSponsor=randomUUID(),connectionId=randomUUID(),storageConnectionId=randomUUID();
  for(const userId of [enrolledBy,providerSponsor,storageSponsor])await owner!.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Enrollment fixture',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  await owner!.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Enrollment fixture',$2,'blank')",[companyId,companyId]);
  for(const userId of [enrolledBy,providerSponsor,storageSponsor])await owner!.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[companyId,userId,userId===enrolledBy?'owner':'admin']);
  await owner!.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,enrolledBy]);
  await owner!.query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,tools,expires_at) VALUES($1,$2,'connected',$3,'{}',$4,clock_timestamp()+interval '1 hour')",[companyId,connectionId,providerSponsor,JSON.stringify(tools)]);
  await owner!.query("INSERT INTO project_storage_connections(id,company_id,name,region,volume_id,secret_envelope,created_by) VALUES($1,$2,'Synthetic storage','US-CA-2','synthetic-fixture-volume','{}',$3)",[storageConnectionId,companyId,storageSponsor]);
  const projects=[];for(let n=0;n<2;n++){
   const projectId=randomUUID(),storageBindingId=randomUUID(),gates=Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:enrolledBy}]));
   await owner!.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Enrollment project','Synthetic','Immutable prepared image','{\"kind\":\"image\",\"width\":16,\"height\":16,\"format\":\"png\",\"color\":{\"mode\":\"not_required\"}}','allowed','production',$3,$4,'higgsfield',2)",[projectId,companyId,JSON.stringify(gates),enrolledBy]);
   await owner!.query('INSERT INTO project_storage_bindings(id,company_id,project_id,connection_id,created_by) VALUES($1,$2,$3,$4,$5)',[storageBindingId,companyId,projectId,storageConnectionId,storageSponsor]);
   projects.push({projectId,projectRevision:1,storageBindingId,storageBindingRevision:1,storageConnectionId,storageConnectionRevision:1});
  }
  const request={version:1,requestId:randomUUID(),serviceId:randomUUID(),companyId,enrolledBy,tokenHash:randomBytes(32).toString('hex'),origin:'https://coatria.com',releaseSha256:'b'.repeat(64),qualificationSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),expiresAt:new Date(Date.now()+600000).toISOString(),uploadHosts:['upload.example.invalid'],provider:{connectionId,connectionRevision:1,catalogSha256:digest(tools)},projects:projects.sort((a,b)=>a.projectId.localeCompare(b.projectId)),qualification:{sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),bundleSha256:'c'.repeat(64),hostConfigurationSha256:'d'.repeat(64),configurationSha256:'e'.repeat(64),qualifierSha256:'f'.repeat(64),conformanceProfileSha256:'a'.repeat(64),bootId:randomUUID(),uid:1234,gid:1234,qualifierInvocationId:'a'.repeat(32),evidenceSha256:'b'.repeat(64),reportSha256:'c'.repeat(64),acceptedAt:new Date(Date.now()-1000).toISOString()}};
  return {request,providerSponsor,storageSponsor};
 }
 // Fresh autocommit observation avoids pg_stat_activity transaction snapshots.
 async function waitBlocked(pid:number,blocker:number){const end=performance.now()+15000;while(performance.now()<end){const row=(await owner!.query("SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];if(row?.wait_event_type==='Lock'&&row.blockers.includes(blocker))return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Registrar did not wait for the exact independent authority transaction');}
 async function race(request:any,lock:(db:PoolClient)=>Promise<unknown>,change:(db:PoolClient)=>Promise<unknown>,code='REFERENCE_ENROLLMENT_AUTHORITY',afterBlocked?:()=>Promise<void>){
  const writer=await owner!.connect(),client=await registrar!.connect();let pending:Promise<{value?:any;error?:any}>|undefined;
  try{await identity(client);await writer.query('BEGIN');await writer.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[request.companyId]);await lock(writer);
   const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   pending=enrollReferenceService(client,request).then(value=>({value}),error=>({error}));await waitBlocked(pid,writerPid);await afterBlocked?.();await change(writer);await writer.query('COMMIT');const result=await pending;assert.equal(result.error?.code,code);await empty(request.serviceId);
  }finally{await writer.query('ROLLBACK').catch(()=>{});if(pending)await pending;writer.release();client.release();}
 }
 try{
  controlClient=await control.connect();await controlClient.query('SELECT pg_advisory_lock(739284011)');assert.equal((await controlClient.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount,0);roleAbsent=true;
  await controlClient.query('CREATE DATABASE '+name);created=true;owner=new Pool({connectionString:ownerUrl.href,max:4,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');for(const migration of(await readdir('database')).filter(n=>/^\d.*\.sql$/.test(n)).sort()){await owner.query(await readFile('database/'+migration,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[migration]);}
  const password=randomBytes(32).toString('hex');await provisionReferenceRegistrarRole({connectionString:ownerUrl.href,password});const url=new URL(ownerUrl);url.username=ROLE;url.password=password;registrar=new Pool({connectionString:url.href,max:3,connectionTimeoutMillis:10000});
  await t.test('two real independent LOGINs atomically converge on one exact immutable enrollment',async()=>{
   const {request}=await seed(),results=await Promise.all([run(enrollReferenceService,request),run(enrollReferenceService,structuredClone(request))]);
   for(const result of results){assert.equal(result.status,'committed');assert.equal(result.serviceId,request.serviceId);assert.equal(result.requestHash,referenceEnrollmentHash(request));assert.equal(result.active,true);}
   assert.equal((await owner!.query('SELECT count(*)::int AS n FROM higgsfield_reference_services WHERE id=$1',[request.serviceId])).rows[0].n,1);
   assert.equal((await owner!.query('SELECT count(*)::int AS n FROM higgsfield_reference_service_projects WHERE service_id=$1',[request.serviceId])).rows[0].n,2);
   const row=(await owner!.query('SELECT request_hash,identity FROM higgsfield_reference_service_enrollments WHERE service_id=$1',[request.serviceId])).rows[0];assert.equal(row.request_hash,referenceEnrollmentHash(request));assert.deepEqual(row.identity,request);
   const before=(await owner!.query('SELECT to_jsonb(s) AS row FROM higgsfield_reference_services s WHERE id=$1',[request.serviceId])).rows[0].row;
   await run(enrollReferenceService,request);assert.deepEqual((await owner!.query('SELECT to_jsonb(s) AS row FROM higgsfield_reference_services s WHERE id=$1',[request.serviceId])).rows[0].row,before);
   await assert.rejects(()=>run(enrollReferenceService,{...request,tokenHash:'f'.repeat(64)}),{code:'REFERENCE_ENROLLMENT_CONFLICT'});
   await assert.rejects(()=>run(enrollReferenceService,{...request,serviceId:randomUUID()}),{code:'REFERENCE_ENROLLMENT_CONFLICT'});
  });
  await t.test('lost COMMIT acknowledgement reconciles the original identity without repeating inserts',async()=>{
   const {request}=await seed(),client=await registrar!.connect();let commits=0;
   try{await identity(client);const transport={query:async(sql:string,values?:any[])=>{const result=await client.query(sql,values);if(sql.trim().toUpperCase()==='COMMIT'){commits++;throw Error('Synthetic lost acknowledgement');}return result;}};await assert.rejects(()=>enrollReferenceService(transport,request),{code:'REFERENCE_ENROLLMENT_COMMIT_UNKNOWN'});}finally{client.release();}
   assert.equal(commits,1);const result=await run(reconcileReferenceService,request);assert.equal(result.status,'committed');assert.equal(result.active,true);assert.equal((await owner!.query('SELECT count(*)::int AS n FROM higgsfield_reference_service_enrollments WHERE service_id=$1',[request.serviceId])).rows[0].n,1);
  });
  await t.test('reconcile waits for the exact original enrollment lock before deciding absence',async()=>{
   const {request}=await seed(),writer=await registrar!.connect(),reader=await registrar!.connect();
   let commitReady!:()=>void,releaseCommit!:()=>void;
   const ready=new Promise<void>(resolve=>{commitReady=resolve;}),permit=new Promise<void>(resolve=>{releaseCommit=resolve;});
   let enrollment:Promise<{value?:any;error?:any}>|undefined,reconciliation:Promise<{value?:any;error?:any}>|undefined,observedKey:string|undefined;
   try{
    await identity(writer);await identity(reader);
    const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,readerPid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const held={query:async(sql:string,values?:any[])=>{if(sql.includes('pg_advisory_xact_lock'))observedKey=values?.[0];if(sql.trim().toUpperCase()==='COMMIT'){commitReady();await permit;}return writer.query(sql,values);}};
    enrollment=enrollReferenceService(held,request).then(value=>({value}),error=>({error}));
    await Promise.race([ready,enrollment.then(result=>{assert.ifError(result.error);assert.fail('Enrollment completed before the held COMMIT');})]);
    assert.equal(observedKey,referenceEnrollmentLockKey(request));
    reconciliation=reconcileReferenceService(reader,request).then(value=>({value}),error=>({error}));
    await waitBlocked(readerPid,writerPid);releaseCommit();
    for(const result of await Promise.all([enrollment,reconciliation])){assert.ifError(result.error);assert.equal(result.value?.status,'committed');assert.equal(result.value?.active,true);}
   }finally{releaseCommit();await Promise.all([enrollment,reconciliation]);writer.release();reader.release();}
  });
  await t.test('company lifecycle removal wins before registrar sponsorship locks',async()=>{
   const {request,providerSponsor}=await seed();await race(request,db=>db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[request.companyId]),db=>db.query("UPDATE memberships SET role='removed',access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2",[request.companyId,providerSponsor]));
  });
  await t.test('provider revision change while enrollment waits invalidates the reviewed catalog',async()=>{
   const {request}=await seed();await race(request,db=>db.query('SELECT id FROM higgsfield_connections WHERE company_id=$1 FOR UPDATE',[request.companyId]),db=>db.query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[request.companyId]));
  });
  await t.test('storage connection revocation while enrollment waits rolls back every enrollment row',async()=>{
   const {request}=await seed(),id=request.projects[0].storageConnectionId;await race(request,db=>db.query('SELECT id FROM project_storage_connections WHERE id=$1 FOR UPDATE',[id]),db=>db.query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL,revision=revision+1 WHERE id=$1",[id]));
  });
  await t.test('storage binding revision change while enrollment waits rejects the exact project set',async()=>{
   const {request}=await seed(),id=request.projects[0].storageBindingId;await race(request,db=>db.query('SELECT id FROM project_storage_bindings WHERE id=$1 FOR UPDATE',[id]),db=>db.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[id]));
  });
  await t.test('deadline crossing during a real row-lock wait cannot commit a formerly fresh request',async()=>{
   const {request}=await seed();request.expiresAt=new Date(Date.now()+3000).toISOString();await race(request,db=>db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[request.companyId]),async()=>{},'REFERENCE_ENROLLMENT_EXPIRED',()=>new Promise(resolve=>setTimeout(resolve,Math.max(1,Date.parse(request.expiresAt)-Date.now()+30))));
  });
  await t.test('reconciliation reports absent or committed-inactive after expiry without extending identity',async()=>{
   const {request}=await seed(),absent={...request,expiresAt:new Date(Date.now()-1).toISOString()};assert.equal((await run(reconcileReferenceService,absent)).status,'absent');await empty(absent.serviceId);
   request.expiresAt=new Date(Date.now()+3000).toISOString();await run(enrollReferenceService,request);await new Promise(resolve=>setTimeout(resolve,Math.max(1,Date.parse(request.expiresAt)-Date.now()+30)));
   const result=await run(reconcileReferenceService,request);assert.equal(result.status,'committed');assert.equal(result.active,false);assert.equal(result.requestHash,referenceEnrollmentHash(request));
  });
  await t.test('exact replay reports changed sponsorship inactive without rewriting the saved authority',async()=>{
   const {request,storageSponsor}=await seed();await run(enrollReferenceService,request);
   const before=(await owner!.query('SELECT to_jsonb(e) AS row FROM higgsfield_reference_service_enrollments e WHERE service_id=$1',[request.serviceId])).rows[0].row;
   await owner!.query("UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2",[request.companyId,storageSponsor]);
   for(const operation of [enrollReferenceService,reconcileReferenceService]){const result=await run(operation,request);assert.equal(result.status,'committed');assert.equal(result.active,false);assert.equal(result.reason,'authority_changed');}
   assert.deepEqual((await owner!.query('SELECT to_jsonb(e) AS row FROM higgsfield_reference_service_enrollments e WHERE service_id=$1',[request.serviceId])).rows[0].row,before);
  });
  assert.equal(providerCalls,0);
 }finally{
  globalThis.fetch=priorFetch;await registrar?.end();await owner?.end();if(created)await dropFixtureDatabase(controlClient!,name);
  if(roleAbsent&&(await controlClient!.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount)await controlClient!.query('DROP ROLE '+ROLE);
  if(controlClient){await controlClient.query('SELECT pg_advisory_unlock(739284011)');controlClient.release();}await control.end();
 }
});
