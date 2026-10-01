import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {readFile} from 'node:fs/promises';
import {query,transaction} from '../src/lib/db';
import {openReferenceGenerationDatabase,referenceGenerationFixture} from './fixtures/reference-generation';
import {recordHiggsfieldReferenceInspection,authorizeHiggsfieldReference,claimHiggsfieldReference,renewHiggsfieldReferenceLease} from '../src/lib/higgsfield-references';
import {adoptStudioReferenceGenerationInspection} from '../src/lib/studio-reference-generation-inspection';
import {proposeProjectImagePreparationReference} from '../src/lib/project-image-preparation-reference';

test('derived generation references require exact finite human inspection adoption',{timeout:240000},async t=>{
 const db=await openReferenceGenerationDatabase();
 try{
  await t.test('actual derivative handoff, producer completion and finite adoption leave sharing separate',async()=>{
   const f=await referenceGenerationFixture();assert(f.reference);assert(f.handoff);
   assert.equal(f.reference.status,'proposed');
   assert.equal(await f.claim(),null,'Unadopted ended-producer work must not be claimed');
   await assert.rejects(f.adopt(),{code:'REFERENCE_GENERATION_HANDOFF_ENDED'},'Running producer cannot be adopted');
   await f.finishProducer();const input=f.adoptInput(),adopted=await f.adopt(input);
   assert.equal(adopted.replayed,false);assert.equal(adopted.adoption.maximumAttempts,1);
   const r=(await query('SELECT * FROM higgsfield_references WHERE id=$1',[f.reference.id])).rows[0];
   assert.equal(r.generation_inspection_adoption_id,adopted.adoption.id);assert.equal(r.inspection_authority,null);assert.equal(r.approved_by,null);assert.equal(r.status,'proposed');
   assert.deepEqual((await f.adopt(input)).adoption,adopted.adoption);
   assert.equal((await f.adopt(input)).replayed,true);
   const lease=await f.claim();assert(lease);assert.equal(lease.phase,'inspect');
   const inspected=await transaction(c=>recordHiggsfieldReferenceInspection(c,lease,{profileSha256:'b'.repeat(64),descriptor:{format:'png',codec:'png',contentType:'image/png',width:96,height:64,bytes:f.output.bytes,sha256:f.output.sha256,kind:'image',verification:'full_decode',inspectionVersion:1,color:{space:null,primaries:null,transfer:null,range:null}}},f.inspectionOptions));
   assert.equal(inspected.reference.status,'awaiting_approval');assert.equal(inspected.reference.approvedAt,null);assert.equal(inspected.reference.providerConfirmed,false);
   assert.equal((await query('SELECT inspection_attempts FROM higgsfield_references WHERE id=$1',[f.reference.id])).rows[0].inspection_attempts,1);
  });
  await t.test('adoption requires human administrator, exact hashes and a single idempotent consent',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();const input=f.adoptInput();
   await assert.rejects(f.adopt(input,f.member),{code:'REFERENCE_GENERATION_INSPECTION_ADMIN_REQUIRED'});
   await assert.rejects(transaction(c=>adoptStudioReferenceGenerationInspection(c,{...f.actor,agentId:f.producer.id} as any,f.reference!.id,input)),{code:'REFERENCE_GENERATION_INSPECTION_ADMIN_REQUIRED'});
   for(const patch of [{referenceRevision:999},{requestHash:'0'.repeat(64)},{handoffSha256:'0'.repeat(64)}])await assert.rejects(f.adopt({...input,...patch}),{code:'REFERENCE_GENERATION_INSPECTION_ENDED'});
   for(const patch of [{inspectionConsent:false},{expiresInMinutes:61},{approvedBy:f.owner},{processingConsent:true}])await assert.rejects(f.adopt({...input,...patch}),{code:'VALIDATION_ERROR'});
   assert.equal((await query('SELECT count(*)::int n FROM studio_reference_generation_inspection_adoptions WHERE company_id=$1',[f.company])).rows[0].n,0);
   const saved=await f.adopt(input);await assert.rejects(f.adopt({...input,expiresInMinutes:19}),{code:'IDEMPOTENCY_CONFLICT'});
   await assert.rejects(f.adopt(f.adoptInput()),{code:'REFERENCE_GENERATION_INSPECTION_ENDED'});
   assert.equal((await query('SELECT count(*)::int n FROM studio_reference_generation_inspection_adoptions WHERE company_id=$1',[f.company])).rows[0].n,1);
   assert.equal((await f.adopt(input)).adoption.id,saved.adoption.id);
  });
  await t.test('unadopted generation head does not starve a later ordinary human reference',async()=>{
   const f=await referenceGenerationFixture();assert.equal(await f.claim(),null);
   const human=(await transaction(c=>proposeProjectImagePreparationReference(c,f.actor,f.preparation.id,{...f.proposal,clientId:randomUUID(),workItemId:f.referenceWork,purpose:'Separate current human reference request'}))).reference;
   const lease=await f.claim();assert(lease);assert.equal(lease.referenceId,human.id);
   assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[f.reference!.id])).rows[0].status,'proposed');
  });
  await t.test('successful status alone cannot substitute for committed exact completion evidence',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();
   for(const change of [
    {sql:"DELETE FROM agent_run_receipts WHERE run_id=$1 AND kind='complete'",args:[f.sourceLease.run!.id]},
    {sql:'UPDATE agent_runs SET result_message_id=NULL WHERE id=$1',args:[f.sourceLease.run!.id]},
    {sql:'UPDATE agent_runs SET finished_at=NULL WHERE id=$1',args:[f.sourceLease.run!.id]},
    {sql:"DELETE FROM agent_run_receipts WHERE run_id=$1 AND kind='complete'",args:[f.parent.id]},
   ])await transaction(async c=>{await c.query('SAVEPOINT forged_completion');try{await c.query(change.sql,change.args);await assert.rejects(adoptStudioReferenceGenerationInspection(c,{companyId:f.company,userId:f.admin},f.reference!.id,f.adoptInput()),{code:'REFERENCE_GENERATION_HANDOFF_ENDED'});}finally{await c.query('ROLLBACK TO SAVEPOINT forged_completion');}});
   await f.adopt();
  });
  await t.test('current source, task, policy, both principals and installation identity remain pinned after completion',async inner=>{
   const f=await referenceGenerationFixture();await f.finishProducer();
   const cases=[
    ['task title',"UPDATE tasks SET title='Changed objective' WHERE id=$1",[f.task]],
    ['task description',"UPDATE tasks SET description='Different work' WHERE id=$1",[f.task]],
    ['task revision','UPDATE tasks SET revision=revision+1 WHERE id=$1',[f.task]],
    ['task reservation','UPDATE tasks SET agent_run_id=NULL WHERE id=$1',[f.task]],
    ['project semantics',"UPDATE studio_projects SET brief='Different objective' WHERE id=$1",[f.project]],
    ['project revision','UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.project]],
    ['policy pause',"UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1",[f.project]],
    ['policy opt-out','UPDATE studio_coordination_policies SET reference_generation_continuations=false WHERE project_id=$1',[f.project]],
    ['policy revision','UPDATE studio_coordination_policies SET revision=revision+1 WHERE project_id=$1',[f.project]],
    ['expired policy',"UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.project]],
    ['producer credential',"UPDATE agents SET token_hash=repeat('0',64) WHERE id=$1",[f.producer.id]],
    ['coordinator credential',"UPDATE agents SET token_hash=repeat('0',64) WHERE id=$1",[f.coordinator.id]],
    ['producer installation','UPDATE plugin_installations SET revision=revision+1 WHERE id=$1',[f.producer.installationId]],
    ['coordinator installation','UPDATE plugin_installations SET revision=revision+1 WHERE id=$1',[f.coordinator.installationId]],
    ['source attempt','UPDATE agent_runs SET attempts=2,max_attempts=3 WHERE id=$1',[f.sourceLease.run!.id]],
    ['producer start',"UPDATE agent_runs SET started_at=started_at-interval '1 second' WHERE id=$1",[f.sourceLease.run!.id]],
    ['coordinator start',"UPDATE agent_runs SET started_at=started_at-interval '1 second' WHERE id=$1",[f.parent.id]],
    ['sponsor timestamp revocation','UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner]],
    ['source revocation',"UPDATE project_image_preparations SET status='revoked',revoked_by=$2,revoked_at=clock_timestamp(),revision=revision+1 WHERE id=$1",[f.preparation.id,f.admin]],
   ] as const;
   for(const[name,sql,args]of cases)await inner.test(name,async()=>transaction(async c=>{await c.query('SAVEPOINT drift');try{await c.query(sql,[...args]);await assert.rejects(adoptStudioReferenceGenerationInspection(c,{companyId:f.company,userId:f.admin},f.reference!.id,f.adoptInput()),{code:'REFERENCE_GENERATION_HANDOFF_ENDED'},name);}finally{await c.query('ROLLBACK TO SAVEPOINT drift');}}));
   await f.adopt();
  });
  await t.test('cached adoption rechecks membership epoch and expiry without extending consent',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();const input=f.adoptInput();await f.adopt(input);
   await transaction(async c=>{await c.query('SAVEPOINT epoch');try{await c.query("UPDATE memberships SET joined_at=joined_at+interval '1 second' WHERE company_id=$1 AND user_id=$2",[f.company,f.admin]);await assert.rejects(adoptStudioReferenceGenerationInspection(c,{companyId:f.company,userId:f.admin},f.reference!.id,input),{code:'REFERENCE_GENERATION_INSPECTION_ENDED'});}finally{await c.query('ROLLBACK TO SAVEPOINT epoch');}});
   // Immutable consent cannot be shortened by a test UPDATE. Advance the exact
   // read-only DB clock seam instead; every other SQL statement remains real.
   await transaction(async c=>{const original=c.query.bind(c);let clockChecks=0;(c as any).query=async(sql:any,args?:any[])=>{if(typeof sql==='string'&&sql.startsWith('SELECT $1::timestamptz>clock_timestamp() AND')){clockChecks++;return{rows:[{live:false}],rowCount:1};}return original(sql,args);};try{await assert.rejects(adoptStudioReferenceGenerationInspection(c,{companyId:f.company,userId:f.admin},f.reference!.id,input),{code:'REFERENCE_GENERATION_INSPECTION_ENDED'});assert.equal(clockChecks,1);}finally{c.query=original as any;}});
  });
  await t.test('one inspection attempt is never automatically replaced after its lease expires',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();await f.adopt();const lease=await f.claim();assert(lease);
   await query("UPDATE higgsfield_references SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reference!.id]);
   assert.equal(await f.claim(),null);
   const r=(await query('SELECT * FROM higgsfield_references WHERE id=$1',[f.reference!.id])).rows[0];assert.equal(r.inspection_attempts,1);assert.equal(r.status,'blocked');assert.equal(r.lease_id,null);
   await assert.rejects(transaction(c=>authorizeHiggsfieldReference(c,lease,f.inspectionOptions)),{code:'HIGGSFIELD_REFERENCE_LEASE_ENDED'});
  });
  await t.test('lease renewal never extends adoption and expiry after inspection writes rolls back all evidence',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();const adopted=await f.adopt(f.adoptInput({expiresInMinutes:1}));const lease=await f.claim();assert(lease);
   const renewed=await transaction(c=>renewHiggsfieldReferenceLease(c,lease,f.inspectionOptions));assert(+new Date(renewed.expiresAt)<=+new Date(adopted.adoption.expiresAt));
   const before=(await query('SELECT * FROM higgsfield_references WHERE id=$1',[f.reference!.id])).rows[0];
   await assert.rejects(transaction(async c=>{const original=c.query.bind(c);let reached=false;(c as any).query=async(sql:any,args?:any[])=>{const result=await original(sql,args);if(typeof sql==='string'&&sql.startsWith('INSERT INTO higgsfield_reference_receipts(')){reached=true;await original("UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.project]);}return result;};try{await recordHiggsfieldReferenceInspection(c,renewed,{profileSha256:'b'.repeat(64),descriptor:{kind:'image',format:'png',codec:'png',contentType:'image/png',width:96,height:64,bytes:f.output.bytes,sha256:f.output.sha256,verification:'full_decode',inspectionVersion:1,color:{space:null,primaries:null,transfer:null,range:null}}},f.inspectionOptions);}finally{c.query=original as any;assert(reached,'Failure must occur after inspection and its receipt were written');}}),{code:'REFERENCE_GENERATION_HANDOFF_ENDED'});
   assert.deepEqual((await query('SELECT * FROM higgsfield_references WHERE id=$1',[f.reference!.id])).rows[0],before);
   for(const table of ['higgsfield_reference_inspections','higgsfield_reference_receipts'])assert.equal((await query('SELECT count(*)::int n FROM '+table+' WHERE reference_id=$1',[f.reference!.id])).rows[0].n,0);
  });
  await t.test('authority changing while worker availability resolves cannot commit an inspection claim',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();await f.adopt();let reached=false;
   await assert.rejects(transaction(c=>claimHiggsfieldReference(c,{companyId:f.company,projectIds:[f.project]},{availability:async(db,company,project)=>{reached=true;await db.query("UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1",[project]);return f.inspectionOptions.availability!(db,company,project);}})),{code:'REFERENCE_GENERATION_HANDOFF_ENDED'});
   assert(reached);const r=(await query('SELECT * FROM higgsfield_references WHERE id=$1',[f.reference!.id])).rows[0];assert.equal(r.inspection_attempts,0);assert.equal(r.lease_id,null);
  });
  await t.test('restricted broker can inspect adopted output without general preparation or adoption-write privileges',async()=>{
   const f=await referenceGenerationFixture();await f.finishProducer();await f.adopt();
   const role='coatria_higgsfield_reference_broker_v1';let control:Pool|undefined,lock:PoolClient|undefined,login:Pool|undefined,created=false;
   try{
    if(db.native){control=new Pool({connectionString:process.env.COATRIA_INTEGRATION_DATABASE_URL,max:1});lock=await control.connect();await lock.query('SELECT pg_advisory_lock(739284011)');}
    assert.equal((await query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0,'Dedicated fixture role must not preexist');
    await query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY)');
    const password=randomBytes(32).toString('hex');await query('CREATE ROLE '+role+" LOGIN NOINHERIT PASSWORD '"+password+"'");created=true;
    await query(await readFile('database/reference-broker-permissions.sql','utf8'));
    if(db.native){const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password;login=new Pool({connectionString:url.href,max:1});}
    const broker=async<T>(fn:(c:PoolClient)=>Promise<T>)=>{
     if(!login)return transaction(async c=>{await c.query('SET LOCAL ROLE '+role);return fn(c);});
     const c=await login.connect();try{const identity=(await c.query('SELECT current_user,session_user')).rows[0];assert.deepEqual(identity,{current_user:role,session_user:role});await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    };
    for(const table of ['project_image_preparations','project_image_preparation_derivations','project_image_preparation_allocations','higgsfield_connections'])await assert.rejects(broker(c=>c.query('SELECT * FROM '+table)),{code:'42501'});
    await assert.rejects(broker(c=>c.query('UPDATE studio_reference_generation_inspection_adoptions SET expires_at=expires_at')),{code:'42501'});
    await assert.rejects(broker(c=>c.query('UPDATE studio_profiles SET updated_at=clock_timestamp() WHERE company_id=$1',[f.company])),{code:'42501'},'A row-lock privilege is not authority to mutate the profile timestamp');
    const lease=await broker(c=>claimHiggsfieldReference(c,{companyId:f.company,projectIds:[f.project]},f.inspectionOptions));assert(lease);assert.equal(lease.phase,'inspect');
    await broker(c=>authorizeHiggsfieldReference(c,lease,f.inspectionOptions));
   }finally{if(login)await login.end();if(created){await query('DROP OWNED BY '+role);await query('DROP ROLE '+role);}if(lock){await lock.query('SELECT pg_advisory_unlock(739284011)');lock.release();}if(control)await control.end();}
  });
 }finally{await db.close();}
});
