import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import * as preparation from '../src/lib/project-image-preparations';
import {projectImagePreparationAvailability} from '../src/lib/project-image-preparation-availability';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import type {ProjectImagePreparationProcessor} from '../src/lib/project-image-preparations-protocol';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const ROLE='coatria_runtime_v1';
const integration=process.env.COATRIA_TEST_EMULATOR==='1'?undefined:process.env.COATRIA_INTEGRATION_DATABASE_URL;
const native=Boolean(integration);

test('image preparation web runtime performs control operations without worker authority'+(native?' (independent PostgreSQL LOGIN)':' (PGlite SET LOCAL ROLE)'),{timeout:180000},async t=>{
 const oldKey=process.env.COATRIA_HOSTING_KEYRING,oldFetch=globalThis.fetch;
 let owner:Pool,runtime:Pool,stop:()=>Promise<void>,outbound=0;
 const migrations=(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort();
 if(integration){
  const url=new URL(integration);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Only disposable localhost PostgreSQL is permitted');
  const control=new Pool({connectionString:integration,max:1}),lock=await control.connect(),name='coatria_preparation_role_'+randomUUID().replaceAll('-','');
  let databaseCreated=false,roleCreated=false;url.pathname='/'+name;
  await lock.query('SELECT pg_advisory_lock(739284011)');
  owner=new Pool({connectionString:url.href,max:2});
  const password=randomBytes(32).toString('hex'),runtimeUrl=new URL(url);runtimeUrl.username=ROLE;runtimeUrl.password=password;
  runtime=new Pool({connectionString:runtimeUrl.href,max:1,connectionTimeoutMillis:10000});
  stop=async()=>{await runtime.end();await owner.end();try{if(databaseCreated)await dropFixtureDatabase(lock,name);if(roleCreated)await lock.query('DROP ROLE '+ROLE);}finally{await lock.query('SELECT pg_advisory_unlock(739284011)');lock.release();await control.end();}};
  try{
   assert.equal((await lock.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount,0,'A fixture must not alter an existing runtime role');
   await lock.query('CREATE DATABASE '+name);databaseCreated=true;
   await lock.query('CREATE ROLE '+ROLE+" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'");roleCreated=true;
   await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY)');
   for(const name of migrations)await owner.query(await readFile('database/'+name,'utf8'));
   await owner.query(await readFile('database/runtime-permissions.sql','utf8'));
  }catch(error){await stop();throw error;}
 }else{
  const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();
  try{
   await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY)');
   for(const name of migrations)await db.exec(await readFile('database/'+name,'utf8'));
   await db.exec('CREATE ROLE '+ROLE+' NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
   await db.exec(await readFile('database/runtime-permissions.sql','utf8'));
  }catch(error){await db.close();throw error;}
  const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();
  owner=new Pool({connectionString:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres',max:1});runtime=owner;
  stop=async()=>{await owner.end();await socket.stop();await db.close();};
 }
 process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});
 globalThis.fetch=async()=>{outbound++;throw Error('No provider calls in the runtime role fixture');};
 async function tx<T>(run:(db:PoolClient)=>Promise<T>,restricted=true){const db=await (restricted?runtime:owner).connect();try{
  await db.query('BEGIN');if(restricted&&!native)await db.query('SET LOCAL ROLE '+ROLE);
  if(restricted){const identity=(await db.query('SELECT current_user,session_user')).rows[0];assert.equal(identity.current_user,ROLE);if(native)assert.equal(identity.session_user,ROLE);}
  const result=await run(db);await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 const denied=(sql:string,values:unknown[]=[])=>assert.rejects(tx(db=>db.query(sql,values)),{code:'42501'});
 try{
  await t.test('native authentication is a separate restricted LOGIN, never SET ROLE',{skip:!native},async()=>{
   await tx(async db=>{assert.deepEqual((await db.query('SELECT current_user,session_user')).rows[0],{current_user:ROLE,session_user:ROLE});assert.deepEqual((await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false});});
  });
  const company=randomUUID(),user=randomUUID(),project=randomUUID(),work=randomUUID(),task=randomUUID(),file=randomUUID(),version=randomUUID(),sha='a'.repeat(64),actor={companyId:company,userId:user};
  await owner.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Runtime fixture',$2,'not-a-login')",[user,user+'@example.invalid']);
  await owner.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Runtime fixture',$2,'blank')",[company,company]);
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[company,user]);
  await owner.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[company,user]);
  await owner.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Image fixture','Internal','Synthetic metadata only',$3,'allowed','production',$4,$5,'higgsfield',2)",[project,company,JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}}),JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:user}]))),user]);
  await owner.query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Prepare image',$3)",[task,company,user]);
  await owner.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'original',$4,'references','ingest','agent')",[work,company,project,task]);
  await owner.query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)",[company,user]);
  const connection=(await tx(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic storage',region:'US-CA-2',volumeId:'fixture',accessKeyId:'user_fixture',secretAccessKey:'rps_fixture-only'}),false)).connection;
  const binding=(await tx(db=>bindProjectStorage(db,actor,project,{clientId:randomUUID(),revision:0,connectionId:connection.id}),false)).binding;
  await owner.query("INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,'original.png','original.png',$5)",[file,company,project,binding.id,user]);
  await owner.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,100,$5,'image/png',$6,$7)",[version,company,project,file,sha,'coatria/companies/'+company+'/projects/'+project+'/objects/'+version,user]);
  // Synthetic verified metadata only; no file or processor qualification exists.
  await owner.query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,100,$4,'synthetic-etag',$5)",[company,project,version,sha,randomUUID()]);
  const input=()=>({clientId:randomUUID(),projectId:project,projectRevision:1,workItemId:work,sourceVersionId:version,sourceBytes:100,sourceSha256:sha,destinationFolderId:null,destinationName:'prepared-'+randomUUID()+'.png',purpose:'Runtime metadata regression'});
  const processor:ProjectImagePreparationProcessor={id:randomUUID(),location:'Synthetic permission fixture only',transport:'linux_binary_v1',qualificationSha256:'b'.repeat(64),releaseSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),sourceCommit:'e'.repeat(40),closureSha256:'f'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,expiresAt:new Date(Date.now()+1800000).toISOString()};
  const options={runtime:async()=>processor};
  const approveInput=(p:{revision:number;requestHash:string})=>({clientId:randomUUID(),revision:p.revision,requestHash:p.requestHash,processorId:processor.id,qualificationSha256:processor.qualificationSha256,expiresInMinutes:10,maxCostMicrousd:0,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true});
  let queuedId:string;
  await t.test('public propose, replay, list and get work with immutable source rows still unwritable',async()=>{
   const data=input(),first=await tx(db=>preparation.proposeProjectImagePreparation(db,actor,data));queuedId=first.preparation.id;
   assert.equal(first.preparation.status,'proposed');assert.equal((await tx(db=>preparation.proposeProjectImagePreparation(db,actor,data))).replayed,true);
   assert.equal((await tx(db=>preparation.getProjectImagePreparation(db,actor,queuedId))).preparation.id,queuedId);
   assert.equal((await tx(db=>preparation.listProjectImagePreparations(db,actor,{projectId:project}))).preparations[0].id,queuedId);
   for(const table of ['project_storage_versions','project_storage_verifications']){
    await denied('UPDATE '+table+' SET sha256=sha256 WHERE company_id=$1',[company]);await denied('DELETE FROM '+table+' WHERE company_id=$1',[company]);
   }
  });
  await t.test('default processor prevents approval and public revocation remains replayable',async()=>{
   const p=(await tx(db=>preparation.proposeProjectImagePreparation(db,actor,input()))).preparation;
   assert.equal((await tx(db=>projectImagePreparationAvailability(db,actor,project))).enabled,false);
   await assert.rejects(tx(db=>preparation.approveProjectImagePreparation(db,actor,p.id,approveInput(p))),{code:'IMAGE_PREPARATION_UNAVAILABLE'});
   assert.equal((await owner.query('SELECT 1 FROM project_image_preparation_approvals WHERE preparation_id=$1',[p.id])).rowCount,0);
   const revoke={clientId:randomUUID(),revision:p.revision,note:'Cancel synthetic proposal'};
   assert.equal((await tx(db=>preparation.revokeProjectImagePreparation(db,actor,p.id,revoke))).preparation.status,'revoked');
   assert.equal((await tx(db=>preparation.revokeProjectImagePreparation(db,actor,p.id,revoke))).replayed,true);
  });
  await t.test('finite synthetic approval succeeds but worker claim and all execution evidence are denied',async()=>{
   const p=(await tx(db=>preparation.getProjectImagePreparation(db,actor,queuedId!))).preparation;
   const approved=await tx(db=>preparation.approveProjectImagePreparation(db,actor,p.id,approveInput(p),options));assert.equal(approved.preparation.status,'queued');
   const snapshot=async()=>(await owner.query('SELECT * FROM project_image_preparations WHERE id=$1',[p.id])).rows[0],before=await snapshot();
   await assert.rejects(tx(db=>preparation.claimProjectImagePreparation(db,{companyId:company,projectIds:[project]},options)),{code:'42501'});
   for(const column of ['attempt','claimed_at','lease_id','lease_expires_at','action_id','action_operation','transform_result','transform_sha256','cleanup_confirmed_at','diagnostic_code'])await denied('UPDATE project_image_preparations SET '+column+'='+column+' WHERE id=$1',[p.id]);
   for(const status of ['reading','blocked','failed'])await denied('UPDATE project_image_preparations SET status=$2,revision=revision+1 WHERE id=$1',[p.id,status]);
   await denied('INSERT INTO project_image_preparations(attempt) SELECT attempt FROM project_image_preparations WHERE false');
   await denied('DELETE FROM project_image_preparations WHERE id=$1',[p.id]);
   for(const operation of ['claim','read','transform','validate','allocation','store','store_initiate','store_part','store_complete','verify','publish','cleanup'])for(const phase of ['intent','returned'])await denied('INSERT INTO project_image_preparation_receipts(company_id,project_id,preparation_id,action_id,operation,phase) VALUES($1,$2,$3,$4,$5,$6)',[company,project,p.id,randomUUID(),operation,phase]);
   for(const table of ['project_image_preparation_allocations','project_image_preparation_derivations'])await denied('INSERT INTO '+table+' SELECT * FROM '+table+' WHERE false');
   for(const table of ['project_image_preparation_approvals','project_image_preparation_requests','project_image_preparation_receipts','project_image_preparation_allocations','project_image_preparation_derivations']){
    await denied('UPDATE '+table+' SET company_id=company_id WHERE company_id=$1',[company]);await denied('DELETE FROM '+table+' WHERE company_id=$1',[company]);
   }
   assert.deepEqual(await snapshot(),before);assert.equal((await owner.query("SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation<>'approve'",[p.id])).rows[0].n,0);
   assert.equal((await tx(db=>preparation.revokeProjectImagePreparation(db,actor,p.id,{clientId:randomUUID(),revision:approved.preparation.revision,note:'Cancel approved fixture'}))).preparation.status,'revoked');
  });
  await t.test('original marker is append-only and can only accompany a new exact dispatch',async()=>{
   const agent=randomUUID(),run=randomUUID(),conversation=randomUUID();
   await owner.query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by) VALUES($1,$2,'Original planner','custom',$3,$4)",[agent,company,'1'.repeat(64),user]);
   await owner.query('INSERT INTO conversations(id,company_id) VALUES($1,$2)',[conversation,company]);
   await tx(async db=>{
    await db.query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic original plan',1)",[run,company,agent,user,conversation,randomUUID(),'2'.repeat(64)]);
    await db.query("INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id,original_preparation_profile) VALUES($1,$2,$3,$4,'original_image_v1')",[company,project,work,run]);
    await db.query('INSERT INTO studio_image_preparation_dispatches(company_id,project_id,work_item_id,run_id,authority_version,coordination) VALUES($1,$2,$3,$4,1,NULL)',[company,project,work,run]);
   });
   await denied('UPDATE studio_image_preparation_dispatches SET coordination=coordination WHERE run_id=$1',[run]);
   await denied('DELETE FROM studio_image_preparation_dispatches WHERE run_id=$1',[run]);
   assert.equal((await tx(db=>db.query('SELECT run_id FROM studio_image_preparation_dispatches WHERE run_id=$1',[run]))).rows[0].run_id,run);
  });
  assert.equal(outbound,0);
 }finally{
  globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=oldKey;
  await stop();
 }
});
