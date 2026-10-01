import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {enrollImagePreparationService,reconcileImagePreparationService} from '../scripts/hosting/image-preparation-enrollment-transaction.mjs';
import {imagePreparationEnrollmentHash,imagePreparationEnrollmentLockKey} from '../src/lib/project-image-preparation-enrollment-contract.mjs';
import {IMAGE_PREPARATION_REGISTRAR_ROLE as ROLE} from '../src/lib/project-image-preparation-database.mjs';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';
const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const native=(()=>{try{return !!integration&&['localhost','127.0.0.1','[::1]'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
type DB={query:(sql:string,values?:any[])=>Promise<{rows:any[];rowCount?:number|null}>};
type Fixture=Awaited<ReturnType<typeof imagePreparationServiceFixture>>;

async function fixtureDatabase(){
 const database=await openImagePreparationServiceDatabase();let control:PoolClient|undefined,registrar:Pool|undefined,createdRole=false;
 try{
  if(database.native){control=await database.control!.connect();await control.query('SELECT pg_advisory_lock(739284033)');assert.equal((await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount,0);}
  await database.db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const password=randomBytes(32).toString('hex');await database.db.query(`CREATE ROLE ${ROLE} LOGIN NOINHERIT PASSWORD '${password}'`);createdRole=true;
  await database.exec(await readFile('database/image-preparation-registrar-permissions.sql','utf8'));
  if(database.native){const url=new URL(database.connectionString!);url.username=ROLE;url.password=password;registrar=new Pool({connectionString:url.href,max:3,connectionTimeoutMillis:5000});}
  const run=async<T>(operation:(db:DB)=>Promise<T>):Promise<T>=>{
   if(registrar){const client=await registrar.connect();let failed=false;try{assert.deepEqual((await client.query('SELECT current_user,session_user')).rows[0],{current_user:ROLE,session_user:ROLE});return await operation(client);}catch(error){failed=true;throw error;}finally{client.release(failed);}}
   // Genuine PGlite role/ACL execution, not native LOGIN or concurrency proof.
   // No preflight substitution: it reads the actual restricted SQL identities.
   await database.db.query(`SET SESSION AUTHORIZATION ${ROLE}`);
   // PGlite does not restore its initial identity on RESET SESSION AUTHORIZATION.
   try{return await operation(database.db);}finally{await database.db.query('SET SESSION AUTHORIZATION postgres');}
  };
  const seed=async()=>{const f=await database.tx(db=>imagePreparationServiceFixture(db,{enroll:false,propose:false,distinctGatewayPrincipals:true}));const sponsor=randomUUID();await database.db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic storage sponsor',$2,'fixture')",[sponsor,sponsor+'@example.invalid']);await database.db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin')",[f.companyId,sponsor]);await database.db.query('UPDATE project_storage_connections SET created_by=$2 WHERE id=$1',[f.connection.id,sponsor]);return {...f,storageSponsor:sponsor};};
  const close=async()=>{await registrar?.end();if(createdRole){await database.db.query(`DROP OWNED BY ${ROLE}`);await database.db.query(`DROP ROLE ${ROLE}`);}if(control){await control.query('SELECT pg_advisory_unlock(739284033)');control.release();control=undefined;}await database.close();};
  return {database,registrar,run,seed,close};
 }catch(error){await registrar?.end();if(createdRole){await database.db.query(`DROP OWNED BY ${ROLE}`).catch(()=>{});await database.db.query(`DROP ROLE ${ROLE}`).catch(()=>{});}if(control){await control.query('SELECT pg_advisory_unlock(739284033)').catch(()=>{});control.release();}await database.close();throw error;}
}

test('image registrar owns exact restricted enrollment/reconciliation transactions',{timeout:180000},async t=>{
 const fdb=await fixtureDatabase(),{database,run,seed}=fdb;const priorFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Synthetic fixture forbids external I/O');};
 const enroll=(f:Fixture)=>run(db=>enrollImagePreparationService(db,f.enrollment)),reconcile=(f:Fixture)=>run(db=>reconcileImagePreparationService(db,f.enrollment));
 const counts=async(id:string)=>{const rows=[];for(const table of ['project_image_preparation_services','project_image_preparation_service_projects','project_image_preparation_service_enrollments'])rows.push((await database.db.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${table==='project_image_preparation_services'?'id':'service_id'}=$1`,[id])).rows[0].count);return rows;};
 try{
  await t.test('malformed or different recipe input is rejected before SQL and owner credentials cannot enroll',async()=>{
   const f=await seed();let queried=0;const forbidden={query:async()=>{queried++;throw Error('PRIVATE_INPUT_MUST_NOT_BE_REFLECTED');}};
   await assert.rejects(enrollImagePreparationService(forbidden,{...f.enrollment,tokenHash:'raw'}),error=>!String(error).includes('PRIVATE_INPUT'));await assert.rejects(reconcileImagePreparationService(forbidden,{...f.enrollment,token:'PRIVATE_INPUT'}));
   await assert.rejects(enrollImagePreparationService(forbidden,{...f.enrollment,recipeSha256:'f'.repeat(64)}),{code:'IMAGE_PREPARATION_ENROLLMENT_RECIPE_CHANGED'});assert.equal(queried,0);
   await assert.rejects(enrollImagePreparationService(database.db,f.enrollment),{code:'IMAGE_PREPARATION_ENROLLMENT_FAILED'});assert.deepEqual(await counts(f.serviceId),[0,0,0]);
  });
  await t.test('both paths lock the same company and advisory identity before collision lookup; absent is read-only',async()=>{
   const f=await seed(),statements:{sql:string;values?:any[]}[]=[];
   const result=await run(db=>reconcileImagePreparationService({query:(sql,values)=>{statements.push({sql,values});return db.query(sql,values);}},f.enrollment));
   assert.equal(result.status,'absent');assert.equal(result.active,false);assert.deepEqual(await counts(f.serviceId),[0,0,0]);assert(!statements.some(s=>/^INSERT /.test(s.sql)));
   const company=statements.findIndex(s=>s.sql==='SELECT id FROM companies WHERE id=$1 FOR KEY SHARE'),lock=statements.findIndex(s=>s.sql.includes('pg_advisory_xact_lock')),lookup=statements.findIndex(s=>s.sql.includes('WHERE id=$1 OR token_hash=$2'));
   assert(company>=0&&company<lock&&lock<lookup);assert.equal(statements[lock].values?.[0],imagePreparationEnrollmentLockKey(f.enrollment));
   assert(statements.some(s=>s.sql==="SET LOCAL lock_timeout='5s'"));assert(statements.some(s=>s.sql==="SET LOCAL statement_timeout='10s'"));
   const saved=await enroll(f);assert.equal(saved.status,'committed');assert.equal(saved.active,true);assert.equal(saved.requestHash,imagePreparationEnrollmentHash(f.enrollment));assert.deepEqual(await counts(f.serviceId),[1,1,1]);
   assert.deepEqual(await reconcile(f),saved);assert.deepEqual(await enroll(f),saved);assert.deepEqual(await counts(f.serviceId),[1,1,1]);
  });
  await t.test('historical lookup rejects all service/token/request/project identity collisions',async()=>{
   const f=await seed();await enroll(f);
   for(const change of [{tokenHash:'f'.repeat(64)},{serviceId:randomUUID()},{requestId:randomUUID()},{companyId:randomUUID()},{location:'Changed immutable location'},{projects:[{...f.enrollment.projects[0],projectRevision:2}]},{projects:[{...f.enrollment.projects[0],gateway:{...f.enrollment.projects[0].gateway,configurationSha256:'0'.repeat(64)}}]}]){
    await assert.rejects(run(db=>reconcileImagePreparationService(db,{...f.enrollment,...change})),{code:'IMAGE_PREPARATION_ENROLLMENT_CONFLICT'});
   }
   const other=await seed();await assert.rejects(run(db=>reconcileImagePreparationService(db,{...other.enrollment,tokenHash:f.enrollment.tokenHash})),{code:'IMAGE_PREPARATION_ENROLLMENT_CONFLICT'});assert.deepEqual(await counts(other.serviceId),[0,0,0]);
   const changedRequest={...f.enrollment,serviceId:randomUUID(),tokenHash:'e'.repeat(64)};await assert.rejects(run(db=>reconcileImagePreparationService(db,changedRequest)),{code:'IMAGE_PREPARATION_ENROLLMENT_CONFLICT'});
   // Privileged fixture deletion simulates partial retained history; the
   // registrar itself cannot delete any of these immutable evidence rows.
   for(const missing of ['project_image_preparation_service_projects','project_image_preparation_service_enrollments']){const partial=await seed();await enroll(partial);await database.db.query(`DELETE FROM ${missing} WHERE service_id=$1`,[partial.serviceId]);await assert.rejects(reconcile(partial),{code:'IMAGE_PREPARATION_ENROLLMENT_CONFLICT'});}
  });
  await t.test('lost COMMIT acknowledgement stays unknown and fresh reconciliation never inserts',async()=>{
   const f=await seed();let commits=0,originalPid:number|undefined,reconciledPid:number|undefined;
   await assert.rejects(run(async db=>{if(database.native)originalPid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return enrollImagePreparationService({query:async(sql,values)=>{const result=await db.query(sql,values);if(sql==='COMMIT'){commits++;throw Error('SYNTHETIC_SECRET_COMMIT_ACK');}return result;}},f.enrollment);}),error=>{assert(!String(error).includes('SYNTHETIC_SECRET'));return (error as any).code==='IMAGE_PREPARATION_ENROLLMENT_COMMIT_UNKNOWN';});
   assert.equal(commits,1);assert.deepEqual(await counts(f.serviceId),[1,1,1]);const result=await run(async db=>{if(database.native)reconciledPid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return reconcileImagePreparationService(db,f.enrollment);});if(database.native)assert.notEqual(reconciledPid,originalPid);assert.equal(result.status,'committed');assert.equal(result.active,true);assert.deepEqual(await counts(f.serviceId),[1,1,1]);
   const pending=await seed();await assert.rejects(run(db=>enrollImagePreparationService({query:async(sql,values)=>{if(sql==='COMMIT')throw Error('SYNTHETIC_UNKNOWN_BEFORE_SERVER');return db.query(sql,values);}},pending.enrollment)),{code:'IMAGE_PREPARATION_ENROLLMENT_COMMIT_UNKNOWN'});assert.deepEqual(await counts(pending.serviceId),[0,0,0]);assert.equal((await reconcile(pending)).status,'absent');
  });
  await t.test('historical commitment remains distinct from sponsor epoch, role and revocation authority',async()=>{
   for(const change of ['enroller-revoked','enroller-role','enroller-epoch','storage-sponsor','gateway-verifier','gateway-sponsor'] as const){const f=await seed();await enroll(f);
    if(change==='enroller-role')await database.db.query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[f.companyId,f.userId]);
    else if(change==='enroller-epoch')await database.db.query("UPDATE memberships SET joined_at=joined_at+interval '1 microsecond' WHERE company_id=$1 AND user_id=$2",[f.companyId,f.userId]);
    else await database.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.companyId,change==='enroller-revoked'?f.userId:change==='storage-sponsor'?f.storageSponsor:change==='gateway-verifier'?f.gateway.verifierId:f.gateway.provisionSponsorId]);
    const result=await reconcile(f);assert.equal(result.status,'committed',change);assert.equal(result.active,false,change);assert.equal(result.reason,'authority_changed',change);assert.deepEqual(await counts(f.serviceId),[1,1,1]);
   }
  });
  await t.test('current project, storage and gateway drift cannot reactivate immutable history',async()=>{
   for(const change of ['project','connection','binding','gateway-stop','gateway-revoke','service-revoke'] as const){const f=await seed();await enroll(f);
    if(change==='project')await database.db.query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.projectId]);
    if(change==='connection')await database.db.query('UPDATE project_storage_connections SET revision=revision+1 WHERE id=$1',[f.connection.id]);
    if(change==='binding')await database.db.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id]);
    if(change==='gateway-stop')await database.db.query('UPDATE trusted_service_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[f.gateway.provisionId]);
    if(change==='gateway-revoke')await database.db.query('UPDATE project_gateway_bindings SET revoked_at=clock_timestamp() WHERE id=$1',[f.gateway.bindingId]);
    if(change==='service-revoke')await database.db.query('UPDATE project_image_preparation_services SET revoked_at=clock_timestamp(),revoked_by=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[f.serviceId,f.userId]);
    const result=await reconcile(f);assert.equal(result.status,'committed');assert.equal(result.active,false,change);assert.equal(result.reason,change==='service-revoke'?'revoked':'authority_changed');
   }
  });
  await t.test('fresh DB clock after the final authority wait prevents stale active results',async()=>{
   const f=await seed();f.enrollment.expiresAt=new Date(Date.now()+2500).toISOString();await enroll(f);let paused=false;
   const result=await run(db=>reconcileImagePreparationService({query:async(sql,values)=>{if(sql.startsWith('SELECT revoked_at,expires_at>clock_timestamp()')){paused=true;await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(f.enrollment.expiresAt)-Date.now()+25)));}return db.query(sql,values);}},f.enrollment));
   assert(paused);assert.equal(result.status,'committed');assert.equal(result.active,false);assert.equal(result.reason,'expired');assert.deepEqual(await counts(f.serviceId),[1,1,1]);
  });
  await t.test('registrar still cannot read provider credentials, change services or claim work',async()=>{
   const f=await seed();await enroll(f);
   for(const statement of ['SELECT secret_envelope FROM project_storage_connections','UPDATE project_image_preparation_services SET revoked_at=clock_timestamp()','SELECT id FROM project_image_preparation_services FOR SHARE','DELETE FROM project_image_preparation_service_projects','UPDATE project_image_preparation_service_enrollments SET identity=identity','INSERT INTO project_image_preparation_service_leases DEFAULT VALUES','INSERT INTO project_image_preparation_byte_grants DEFAULT VALUES','UPDATE project_image_preparation_byte_results SET status=status','UPDATE studio_projects SET revision=revision+1','SELECT * FROM project_image_preparation_service_leases','SELECT * FROM project_image_preparation_byte_grants'])await assert.rejects(run(db=>db.query(statement)),{code:'42501'});
  });
  assert.equal(calls,0);
 }finally{globalThis.fetch=priorFetch;await fdb.close();}
});

test('native independent registrar LOGIN waits for original enrollment COMMIT or ROLLBACK before reconciliation',{skip:!native,timeout:180000},async()=>{
 const fdb=await fixtureDatabase();
 async function blocked(pid:number,by:number){const until=performance.now()+4000;while(performance.now()<until){const r=(await fdb.database.db.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0];if(r.blockers.includes(by))return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Expected exact enrollment advisory-lock wait');}
 try{
  for(const outcome of ['COMMIT','ROLLBACK'] as const){const f=await fdb.seed(),writer=await fdb.registrar!.connect(),reader=await fdb.registrar!.connect();let ready!:()=>void,release!:()=>void;const atCommit=new Promise<void>(r=>{ready=r;}),permit=new Promise<void>(r=>{release=r;});let writing:Promise<any>|undefined,reading:Promise<any>|undefined;
   try{
    const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,readerPid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    writing=enrollImagePreparationService({query:async(sql,values)=>{if(sql==='COMMIT'){ready();await permit;if(outcome==='ROLLBACK'){await writer.query('ROLLBACK');throw Error('Synthetic ambiguous commit transport');}}return writer.query(sql,values);}},f.enrollment).then(value=>({value}),error=>({error}));
    await Promise.race([atCommit,writing.then(result=>{assert.ifError(result.error);assert.fail('Enrollment completed before held COMMIT');})]);
    reading=reconcileImagePreparationService(reader,f.enrollment).then(value=>({value}),error=>({error}));await blocked(readerPid,writerPid);release();const [write,read]=await Promise.all([writing,reading]);assert.ifError(read.error);assert.equal(read.value.status,outcome==='COMMIT'?'committed':'absent');assert.equal(read.value.active,outcome==='COMMIT');if(outcome==='ROLLBACK')assert.equal(write.error?.code,'IMAGE_PREPARATION_ENROLLMENT_COMMIT_UNKNOWN');else assert.ifError(write.error);
   }finally{release?.();await writing;await reading;writer.release();reader.release();}
  }
 }finally{await fdb.close();}
});

test('native reconciliation rereads sponsor revocation and exact membership epoch after a real row lock wait',{skip:!native,timeout:180000},async()=>{
 const fdb=await fixtureDatabase();
 try{
  for(const change of ['revocation','epoch'] as const){
   const f=await fdb.seed();await fdb.run(db=>enrollImagePreparationService(db,f.enrollment));
   const writer=await (fdb.database.db as unknown as Pool).connect(),reader=await fdb.registrar!.connect();let reading:Promise<any>|undefined;
   try{
    const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,readerPid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await writer.query('BEGIN');await writer.query("UPDATE memberships SET "+(change==='revocation'?'access_revoked_at=clock_timestamp()':"joined_at=joined_at+interval '1 microsecond'")+" WHERE company_id=$1 AND user_id=$2",[f.companyId,f.userId]);
    reading=reconcileImagePreparationService(reader,f.enrollment).then(value=>({value}),error=>({error}));
    const until=performance.now()+4000;let blocked=false;
    while(performance.now()<until){if((await fdb.database.db.query('SELECT pg_blocking_pids($1) AS blockers',[readerPid])).rows[0].blockers.includes(writerPid)){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert(blocked,'Expected the registrar to wait on the exact sponsor writer');await writer.query('COMMIT');
    const result=await reading;assert.ifError(result.error);assert.equal(result.value.status,'committed');assert.equal(result.value.active,false);assert.equal(result.value.reason,'authority_changed');
    assert.equal((await fdb.database.db.query('SELECT count(*)::int AS count FROM project_image_preparation_service_enrollments WHERE service_id=$1',[f.serviceId])).rows[0].count,1);
   }finally{await writer.query('ROLLBACK').catch(()=>{});await reading;writer.release();reader.release(true);}
  }
 }finally{await fdb.close();}
});

test('native final gateway revocation retains committed enrollment history but returns inactive',{skip:!native,timeout:180000},async()=>{
 const fdb=await fixtureDatabase();
 try{
  const f=await fdb.seed();let inserted=false,revoked=false;
  const result=await fdb.run(db=>enrollImagePreparationService({query:async(sql,values)=>{
   if(inserted&&!revoked&&sql.startsWith('SELECT b.id,b.project_id,b.provision_id')){revoked=true;await fdb.database.db.query('UPDATE project_gateway_bindings SET revoked_at=clock_timestamp() WHERE id=$1',[f.gateway.bindingId]);}
   const value=await db.query(sql,values);if(sql.startsWith('INSERT INTO project_image_preparation_service_enrollments'))inserted=true;return value;
  }},f.enrollment));
  assert(inserted&&revoked);assert.equal(result.status,'committed');assert.equal(result.active,false);assert.equal(result.reason,'authority_changed');
  assert.equal((await fdb.database.db.query('SELECT count(*)::int AS count FROM project_image_preparation_service_enrollments WHERE service_id=$1',[f.serviceId])).rows[0].count,1);
  const observed=await fdb.run(db=>reconcileImagePreparationService(db,f.enrollment));assert.deepEqual(observed,result);
 }finally{await fdb.close();}
});
