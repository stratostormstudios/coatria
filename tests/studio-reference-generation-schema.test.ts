import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {Pool, type PoolClient} from 'pg';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

type Row=Record<string,any>;
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex');
const BROKER='coatria_higgsfield_reference_broker_v1';

test('reference generation relational lineage and finite adoption are immutable', {timeout:180_000}, async t=>{
 const native=process.env.COATRIA_TEST_EMULATOR!=='1'?process.env.COATRIA_INTEGRATION_DATABASE_URL:undefined;
 t.diagnostic(native?'Native PostgreSQL disposable relational fixture':'PGlite relational fixture; no native PostgreSQL execution claimed');
 const migrations=(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort();
 let pool:Pool,stop:()=>Promise<void>;
 if(native){
  const url=new URL(native);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
  const control=new Pool({connectionString:native,max:1}),lock=await control.connect(),name='coatria_ref_generation_'+randomUUID().replaceAll('-','');
  await lock.query('SELECT pg_advisory_lock(739284011)');
  const created=!(await lock.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[BROKER])).rowCount;
  if(created)await lock.query('CREATE ROLE '+BROKER+' NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  await lock.query('CREATE DATABASE '+name);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:4,statement_timeout:10_000});
  stop=async()=>{await pool.end();try{await dropFixtureDatabase(lock as any,name);if(created)await lock.query('DROP ROLE '+BROKER);}finally{await lock.query('SELECT pg_advisory_unlock(739284011)');lock.release();await control.end();}};
  try{await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of migrations)await pool.query(await readFile('database/'+file,'utf8'));}catch(error){await stop();throw error;}
 }else{
  const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();
  await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of migrations)await db.exec(await readFile('database/'+file,'utf8'));
  await db.exec('CREATE ROLE '+BROKER+' NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();pool=new Pool({connectionString:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres',max:1});
  stop=async()=>{await pool.end();await socket.stop();await db.close();};
 }
 async function tx<T>(f:(db:PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');const result=await f(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 const insert=async(db:{query:PoolClient['query']},table:string,row:Row)=>{const keys=Object.keys(row),values=Object.values(row).map(v=>v&&typeof v==='object'&&!(v instanceof Date)?JSON.stringify(v):v);return(await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values)).rows[0];};
 const clock=async(db:{query:PoolClient['query']},minutes=0)=>new Date((await db.query("SELECT clock_timestamp()+make_interval(mins=>$1) AS at",[minutes])).rows[0].at).toISOString();
 async function fixture(){
  const company=randomUUID(),user=randomUUID(),project=randomUUID(),task=randomUUID(),work=randomUUID(),conversation=randomUUID();
  await insert(pool,'users',{id:user,name:'Relational fixture',email:user+'@example.invalid',password_hash:'not-a-login'});
  await insert(pool,'companies',{id:company,name:'Offline lineage',slug:company,template:'blank'});
  await insert(pool,'memberships',{company_id:company,user_id:user,role:'owner'});
  await insert(pool,'studio_profiles',{company_id:company,template_id:'ai-production',template_version:1,created_by:user});
  const p=await insert(pool,'studio_projects',{id:project,company_id:company,name:'Synthetic lineage',client_name:'Internal',brief:'SQL metadata only; no byte or provider proof',spec:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},ai_policy:'allowed',status:'production',gates:Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved'}])),created_by:user,production_path:'higgsfield',contract_version:2});
  await insert(pool,'tasks',{id:task,company_id:company,title:'One exact generation',description:'Original semantic task',created_by:user});
  await insert(pool,'studio_work_items',{id:work,company_id:company,project_id:project,logical_key:'gen',task_id:task,stage:'generation',role_key:'comp',execution:'creative'});
  await insert(pool,'conversations',{id:conversation,company_id:company});
  const caps=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];
  async function agent(grants:string[]){const a=await insert(pool,'agents',{company_id:company,name:'Synthetic agent',harness:'custom',created_by:user,token_hash:hash(randomUUID()),capabilities:grants,invocation_access:'admins'});const installation=await insert(pool,'plugin_installations',{company_id:company,agent_id:a.id,installed_by:user,client_id:randomUUID(),request_hash:hash(randomUUID()),plugin_id:'runpod',manifest_version:'1.0.0',runtime_config:{providerId:'runpod',modelId:'synthetic'},character:{}});return {a,installation};}
  const coordinator=await agent(['tasks.write','studio.write','studio.read','workspace.read']),specialist=await agent([...caps,'workspace.read']);
  await insert(pool,'studio_role_bindings',{company_id:company,role_key:'comp',agent_id:specialist.a.id});
  async function run(agentId:string,db:Pool|PoolClient=pool,status='running'){return insert(db,'agent_runs',{company_id:company,agent_id:agentId,requested_by:user,conversation_id:conversation,client_id:randomUUID(),payload_hash:hash(randomUUID()),prompt:'Synthetic lineage only',capabilities:agentId===coordinator.a.id?['tasks.write','studio.write','studio.read']:caps,status,max_attempts:1,...status==='running'?{attempts:1,started_at:await clock(db),worker_id:'fixture',lease_token_hash:hash(randomUUID()),lease_expires_at:await clock(db,20)}:{}});}
  const parent=await run(coordinator.a.id),source=await run(specialist.a.id);
  await pool.query("UPDATE tasks SET status='doing',agent_run_id=$2 WHERE id=$1",[task,source.id]);
  const policy=await insert(pool,'studio_coordination_policies',{company_id:company,project_id:project,coordinator_agent_id:coordinator.a.id,approved_by:user,status:'active',allowed_role_keys:['comp'],profile_revision:1,authority_snapshot:{synthetic:true},max_runs:3,runs_started:1,max_concurrent_runs:1,expires_at:await clock(pool,45),reference_generation_continuations:true});
  await insert(pool,'studio_coordination_dispatches',{company_id:company,project_id:project,work_item_id:work,parent_run_id:parent.id,child_run_id:source.id,coordinator_agent_id:coordinator.a.id,specialist_agent_id:specialist.a.id,policy_revision:1});
  await insert(pool,'studio_dispatches',{company_id:company,project_id:project,work_item_id:work,run_id:source.id});
  const connection=await insert(pool,'project_storage_connections',{company_id:company,name:'Metadata only',region:'US-CA-2',volume_id:'fixture',secret_envelope:{synthetic:true},created_by:user});
  const binding=await insert(pool,'project_storage_bindings',{company_id:company,project_id:project,connection_id:connection.id,created_by:user});
  async function version(label:string){const f=await insert(pool,'project_storage_files',{company_id:company,project_id:project,binding_id:binding.id,name:label+'.png',name_key:label+'.png',created_by:user}),id=randomUUID();const v=await insert(pool,'project_storage_versions',{id,company_id:company,project_id:project,file_id:f.id,version:1,bytes:100,sha256:hash(id),content_type:'image/png',object_key:`coatria/companies/${company}/projects/${project}/objects/${id}`,created_by:user});await insert(pool,'project_storage_verifications',{company_id:company,project_id:project,version_id:id,bytes:100,sha256:v.sha256,provider_etag:'synthetic-etag',gateway_receipt_id:randomUUID()});return v;}
  const original=await version('original'),output=await version('output'),prepId=randomUUID(),recipe=hash('recipe'),derivationHash=hash('derivation');
  // Historical derivative metadata is synthetic. Earlier migrations' processor
  // guards are disabled only for this seed; every 049 guard stays enabled. This
  // suite proves relational constraints, never actual transformation or storage.
  await tx(async db=>{
   const tables=['project_image_preparations','project_image_preparation_derivations'];
   const triggers=(await db.query("SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname=ANY($1::text[]) AND NOT t.tgisinternal",[tables])).rows;
   for(const table of tables)await db.query('ALTER TABLE '+table+' DISABLE TRIGGER USER');
   await insert(db,'project_image_preparations',{id:prepId,company_id:company,project_id:project,work_item_id:work,project_revision:1,project_snapshot:{},work_snapshot:{},source_version_id:original.id,source_snapshot:{},destination_name:'prepared.png',destination_snapshot:{},storage_binding_id:binding.id,storage_binding_revision:1,storage_connection_id:connection.id,storage_connection_revision:1,storage_sponsor_id:user,recipe_sha256:recipe,request_hash:hash('prep'),purpose:'Synthetic historical output',proposed_by:user,proposer_snapshot:{},status:'ready',attempt:1,claimed_at:await clock(db,-1),cleanup_confirmed_at:await clock(db)});
   // Approval insertion is also a historical seed; preserve its original flags.
   await db.query('ALTER TABLE project_image_preparation_approvals DISABLE TRIGGER USER');
   await insert(db,'project_image_preparation_approvals',{company_id:company,project_id:project,preparation_id:prepId,approved_by:user,approver_snapshot:{},expires_at:await clock(db,20),approval_hash:hash('approval'),processor_snapshot:{},max_cost_microusd:0,processing_consent:true,derivative_write_consent:true,adoption_consent:true});
   await db.query('SET CONSTRAINTS ALL IMMEDIATE');
   await db.query('ALTER TABLE project_image_preparation_approvals ENABLE TRIGGER USER');
   await db.query('ALTER TABLE project_image_preparation_approvals ENABLE ALWAYS TRIGGER project_image_preparation_approval_immutable');
   const upload=await insert(db,'project_storage_uploads',{company_id:company,project_id:project,version_id:output.id,actor_key:'fixture',actor_user_id:user,client_id:randomUUID(),request_hash:hash('upload'),part_bytes:67108864,expires_at:await clock(db,20),status:'ready'});
   await insert(db,'project_image_preparation_derivations',{company_id:company,project_id:project,preparation_id:prepId,source_version_id:original.id,output_file_id:output.file_id,output_version_id:output.id,upload_id:upload.id,recipe_sha256:recipe,source_sha256:original.sha256,source_bytes:100,output_sha256:output.sha256,output_bytes:100,output_width:16,output_height:16,processor_snapshot:{},transform_evidence:{},receipt_sha256:derivationHash});
   for(const item of triggers)await db.query('ALTER TABLE '+item.relname+' '+(item.tgenabled==='A'?'ENABLE ALWAYS':item.tgenabled==='D'?'DISABLE':'ENABLE')+' TRIGGER '+item.tgname);
  });
  const handoffId=randomUUID(),referenceId=randomUUID(),refHash=hash(referenceId),workSnapshot={workItemId:work,taskId:task,taskRevision:1,stage:'generation',shotId:null,roleKey:'comp',roleAgentId:specialist.a.id,roleHumanId:null,taskContentHash:hash({title:'One exact generation',description:'Original semantic task'}),status:'doing'};
  const projectSnapshot=JSON.parse(JSON.stringify(p));delete projectSnapshot.revision;delete projectSnapshot.updated_at;
  const identity=(identity:Row,r:Row)=>({runId:r.id,agentId:identity.a.id,requestedBy:user,sponsorId:user,tokenHash:identity.a.token_hash,capabilities:[...identity.a.capabilities].sort(),runCapabilities:[...r.capabilities].sort(),attempts:1,startedAt:new Date(r.started_at).toISOString(),installation:{id:identity.installation.id,revision:1}});
  const snapshot={schemaVersion:1,project:projectSnapshot,work:{...workSnapshot,title:'One exact generation',description:'Original semantic task'},producer:identity(specialist,source),coordinator:identity(coordinator,parent),policy:{revision:1,coordinatorAgentId:coordinator.a.id,approvedBy:user,authoritySnapshot:policy.authority_snapshot,expiresAt:new Date(policy.expires_at).toISOString()}};
  const handoff:Row={id:handoffId,company_id:company,project_id:project,work_item_id:work,task_id:task,initial_parent_run_id:parent.id,source_child_run_id:source.id,coordinator_agent_id:coordinator.a.id,specialist_agent_id:specialist.a.id,requested_by:user,policy_revision:1,project_revision:1,task_revision:1,reference_id:referenceId,reference_request_hash:refHash,preparation_id:prepId,preparation_revision:1,source_version_id:original.id,source_sha256:original.sha256,source_bytes:100,output_version_id:output.id,output_sha256:output.sha256,output_bytes:100,recipe_sha256:recipe,derivation_sha256:derivationHash,source_snapshot:snapshot,handoff_sha256:hash(snapshot)};
  const reference:Row={id:referenceId,company_id:company,project_id:project,work_item_id:work,project_revision:1,project_snapshot:projectSnapshot,project_sha256:hash(projectSnapshot),work_snapshot:workSnapshot,proxy_version_id:output.id,source_version_id:original.id,proxy_snapshot:{versionId:output.id,sha256:output.sha256,bytes:100},source_snapshot:{versionId:original.id,sha256:original.sha256,bytes:100},storage_binding_id:binding.id,storage_binding_revision:1,storage_connection_id:connection.id,storage_connection_revision:1,storage_sponsor_id:user,provider_connection_id:randomUUID(),provider_connection_revision:1,provider_sponsor_id:user,catalog_sha256:hash('catalog'),role:'image',purpose:'Synthetic exact reference',request_hash:refHash,proposed_by:user,proposed_agent_id:specialist.a.id,proposed_run_id:source.id,generation_handoff_id:handoffId};
  const save=async(patch:Row={},before?:(db:PoolClient)=>Promise<any>)=>tx(async db=>{await insert(db,'higgsfield_references',reference);if(before)await before(db);return insert(db,'studio_reference_generation_handoffs',{...handoff,...patch});});
  const succeed=async()=>tx(async db=>{const message=await insert(db,'messages',{company_id:company,conversation_id:conversation,user_id:user,sequence:1,last_event_sequence:1,body:'Synthetic factual completion'});await db.query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),result_message_id=$2 WHERE id=$1",[source.id,message.id]);await insert(db,'agent_run_receipts',{company_id:company,run_id:source.id,client_id:randomUUID(),kind:'complete',payload_hash:hash('completion'),lease_token_hash:hash('lease'),response:{run:{id:source.id,status:'succeeded'}}});});
  const adoption=async(db:PoolClient,patch:Row={})=>{const m=(await db.query("SELECT role,joined_at::text AS joined_at FROM memberships WHERE company_id=$1 AND user_id=$2",[company,user])).rows[0];const saved=await insert(db,'studio_reference_generation_inspection_adoptions',{id:randomUUID(),company_id:company,project_id:project,work_item_id:work,reference_id:referenceId,handoff_id:handoffId,reference_revision:1,request_hash:refHash,handoff_sha256:handoff.handoff_sha256,approved_by:user,approver_snapshot:{userId:user,role:m.role,joinedAt:m.joined_at},expires_at:await clock(db,10),approval_hash:hash('inspection-consent'),inspection_consent:true,...patch});await db.query('UPDATE higgsfield_references SET generation_inspection_adoption_id=$2 WHERE id=$1',[referenceId,saved.id]);return saved;};
  async function confirmed(){await save();await succeed();await tx(db=>adoption(db));await pool.query("UPDATE higgsfield_references SET status='confirmed',revision=2,approved_by=$2,approved_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes',approval_hash=$3,qualification_sha256=$4 WHERE id=$1",[referenceId,user,hash('share'),hash('qualification')]);const media=randomUUID();await insert(pool,'higgsfield_reference_confirmations',{company_id:company,project_id:project,reference_id:referenceId,media_id:media,request_hash:refHash,approval_hash:hash('share'),bytes:100,sha256:output.sha256});return media;}
  const followup=async(db:PoolClient,media:string,patch:Row={})=>{const nextParent=await run(coordinator.a.id,db),child=await run(specialist.a.id,db,'queued');await insert(db,'studio_dispatches',{company_id:company,project_id:project,work_item_id:work,run_id:child.id});return insert(db,'studio_reference_generation_followups',{company_id:company,project_id:project,handoff_id:handoffId,work_item_id:work,task_id:task,source_child_run_id:source.id,parent_run_id:nextParent.id,child_run_id:child.id,coordinator_agent_id:coordinator.a.id,specialist_agent_id:specialist.a.id,policy_revision:1,approved_by:user,initial_task_revision:1,reference_id:referenceId,reference_revision:2,reference_approval_hash:hash('share'),media_id:media,claim_request_id:randomUUID(),proposal_request_id:randomUUID(),...patch});};
  return {company,user,project,task,work,parent,source,specialist,handoff,reference,prepId,save,succeed,adoption,confirmed,followup};
 }
 try{
  await pool.query(await readFile('database/reference-broker-permissions.sql','utf8'));
  await t.test('new policy is default-off, and source/parent/snapshot/derivative mismatches reject atomically',async()=>{
   const f=await fixture();for(const patch of [{output_sha256:hash('wrong')},{source_version_id:f.reference.proxy_version_id},{task_revision:2},{initial_parent_run_id:f.source.id},{preparation_revision:2},{source_snapshot:{},handoff_sha256:hash({})}])await assert.rejects(f.save(patch),{code:'23514'});
   for(const sql of ["UPDATE studio_coordination_policies SET reference_generation_continuations=DEFAULT","UPDATE studio_coordination_policies SET status='paused'","UPDATE studio_coordination_policies SET revision=2","UPDATE tasks SET description='Changed semantic task'","UPDATE agent_runs SET attempts=2 WHERE status='running'"])
    await assert.rejects(f.save({},db=>db.query(sql+(sql.includes(' WHERE ')?' AND':' WHERE')+' company_id=$1',[f.company])),{code:'23514'});
   const missing=structuredClone(f.handoff.source_snapshot);delete missing.producer.runCapabilities;await assert.rejects(f.save({source_snapshot:missing,handoff_sha256:hash(missing)}),{code:'23514'});
   assert.notDeepEqual(f.handoff.source_snapshot.producer.capabilities,f.handoff.source_snapshot.producer.runCapabilities,'Real agent grants can exceed this run grant');
   assert(!f.handoff.source_snapshot.coordinator.runCapabilities.includes('creative.write'),'Coordinator is not assumed to carry generation grants');
   assert.equal((await pool.query('SELECT count(*)::int n FROM higgsfield_references WHERE company_id=$1',[f.company])).rows[0].n,0);
   await f.save();await assert.rejects(tx(db=>db.query('UPDATE studio_reference_generation_handoffs SET task_revision=2 WHERE id=$1',[f.handoff.id])),{code:'42501'});
   await assert.rejects(tx(db=>db.query('UPDATE higgsfield_references SET generation_handoff_id=NULL WHERE id=$1',[f.reference.id])),{code:'42501'});
  });
  await t.test('adoption requires actual completed initial run, exact membership epoch and immutable finite consent',async()=>{
   const f=await fixture();await f.save();await assert.rejects(tx(db=>f.adoption(db)),{code:'23514'});await f.succeed();
   for(const patch of [{max_attempts:3},{inspection_consent:false},{request_hash:hash('different')},{approver_snapshot:{}},{expires_at:'2099-01-01T00:00:00Z'}])await assert.rejects(tx(db=>f.adoption(db,patch)),{code:'23514'});
   await assert.rejects(tx(async db=>{await db.query('DELETE FROM agent_run_receipts WHERE run_id=$1',[f.source.id]);return f.adoption(db);}),{code:'23514'});
   await assert.rejects(tx(async db=>{await db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1',[f.company]);return f.adoption(db);}),{code:'23514'});
   await assert.rejects(tx(async db=>{await db.query("UPDATE agent_runs SET status='failed',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1",[f.parent.id]);return f.adoption(db);}),{code:'23514'});
   const row=await tx(db=>f.adoption(db));await assert.rejects(tx(db=>f.adoption(db)),{code:'23505'});
   await assert.rejects(tx(db=>db.query("UPDATE studio_reference_generation_inspection_adoptions SET expires_at=expires_at+interval '1 minute' WHERE id=$1",[row.id])),{code:'42501'});
   await assert.rejects(tx(db=>db.query('UPDATE higgsfield_references SET generation_inspection_adoption_id=NULL WHERE id=$1',[f.reference.id])),{code:'42501'});
  });
  await t.test('restricted broker reads only adopted derivative facts and receives exactly one bounded inspection claim',async()=>{
   const f=await fixture();await f.save();await f.succeed();await tx(db=>f.adoption(db));
   const claim=()=>tx(async db=>{await db.query('SET LOCAL ROLE '+BROKER);return db.query("UPDATE higgsfield_references SET status='inspecting',inspection_attempts=inspection_attempts+1,lease_id=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 RETURNING inspection_attempts",[f.reference.id,randomUUID()]);});
   for(const table of ['project_image_preparations','project_image_preparation_derivations'])await assert.rejects(tx(async db=>{await db.query('SET LOCAL ROLE '+BROKER);return db.query('SELECT * FROM '+table+' LIMIT 1');}),{code:'42501'});
   await tx(async db=>{await db.query('SET LOCAL ROLE '+BROKER);const row=(await db.query('SELECT * FROM studio_reference_generation_adoption_facts WHERE reference_id=$1',[f.reference.id])).rows[0];assert.equal(row.preparation_status,'ready');assert.equal(row.output_sha256,f.handoff.output_sha256);assert.ok(!('source_snapshot' in row));});
   assert.equal((await claim()).rows[0].inspection_attempts,1);
   await pool.query("UPDATE higgsfield_references SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reference.id]);await assert.rejects(claim(),{code:'42501'});
   // Only the historical attempt predicate is exercised here; this synthetic
   // row does not claim an actual prepared-image inspection or live lease.
   const legacy=await insert(pool,'higgsfield_references',{...f.reference,id:randomUUID(),generation_handoff_id:null,inspection_authority:{version:1,mode:'prepared_image_v1'},inspection_authority_sha256:hash('legacy')});
   const legacyClaim=()=>tx(async db=>{await db.query('SET LOCAL ROLE '+BROKER);return db.query("UPDATE higgsfield_references SET status='inspecting',inspection_attempts=inspection_attempts+1,lease_id=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 RETURNING inspection_attempts",[legacy.id,randomUUID()]);});
   for(let attempt=1;attempt<=3;attempt++){assert.equal((await legacyClaim()).rows[0].inspection_attempts,attempt);await pool.query("UPDATE higgsfield_references SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[legacy.id]);}
   await assert.rejects(legacyClaim(),{code:'42501'});
  });
  await t.test('membership removal/reinvite cannot resurrect a saved adoption',async()=>{
   const f=await fixture();await f.save();await f.succeed();await tx(db=>f.adoption(db));
   await pool.query("UPDATE memberships SET joined_at=joined_at+interval '1 microsecond' WHERE company_id=$1",[f.company]);
   await assert.rejects(tx(async db=>{await db.query('SET LOCAL ROLE '+BROKER);return db.query("UPDATE higgsfield_references SET status='inspecting',inspection_attempts=1,lease_id=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[f.reference.id,randomUUID()]);}),{code:'42501'});
  });
  await t.test('one new child uses exact confirmation, available lifetime budget and two globally distinct step IDs',async()=>{
   const f=await fixture(),media=await f.confirmed();
   for(const patch of [{source_child_run_id:f.parent.id},{media_id:randomUUID()},{reference_approval_hash:hash('other')},{initial_task_revision:2}])await assert.rejects(tx(db=>f.followup(db,media,patch)),{code:'23514'});
   await assert.rejects(tx(async db=>{await db.query('UPDATE studio_coordination_policies SET runs_started=max_runs WHERE company_id=$1',[f.company]);return f.followup(db,media);}),{code:'23514'});
   await assert.rejects(tx(async db=>{await db.query("UPDATE project_image_preparations SET status='revoked',revision=revision+1,revoked_by=$2,revoked_at=clock_timestamp() WHERE id=$1",[f.prepId,f.user]);return f.followup(db,media);}),{code:'23514'});
   const result=await tx(db=>f.followup(db,media)),steps=(await pool.query('SELECT * FROM studio_reference_generation_followup_steps WHERE child_run_id=$1 ORDER BY step',[result.child_run_id])).rows;
   assert.deepEqual(steps.map(x=>x.step),['claim','proposal']);assert.equal(steps[0].request_id,result.claim_request_id);assert.equal(steps[1].request_id,result.proposal_request_id);
   await assert.rejects(tx(db=>f.followup(db,media)),{code:'23505'});
   await assert.rejects(tx(db=>db.query('UPDATE studio_reference_generation_followups SET proposal_request_id=$2 WHERE child_run_id=$1',[result.child_run_id,randomUUID()])),{code:'42501'});
   await assert.rejects(tx(db=>db.query('UPDATE studio_reference_generation_followup_steps SET request_id=$2 WHERE child_run_id=$1',[result.child_run_id,randomUUID()])),{code:'42501'});
  });
  await t.test('new evidence keeps company cascade deletion possible',async()=>{
   const f=await fixture(),media=await f.confirmed();await tx(db=>f.followup(db,media));await pool.query('DELETE FROM companies WHERE id=$1',[f.company]);
   for(const table of ['studio_reference_generation_handoffs','studio_reference_generation_inspection_adoptions','studio_reference_generation_followups','studio_reference_generation_followup_steps'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table+' WHERE company_id=$1',[f.company])).rows[0].n,0);
  });
 }finally{await stop();}
});
