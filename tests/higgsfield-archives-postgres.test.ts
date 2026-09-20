import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool,type PoolClient} from 'pg';
import {transaction} from '../src/lib/db';
import {recordHiggsfieldSubmission} from '../src/lib/higgsfield-jobs';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {createProjectStorageConnection,bindProjectStorage,createProjectStorageFolder} from '../src/lib/project-storage';
import {proposeHiggsfieldArchive,approveHiggsfieldArchive,getHiggsfieldArchive,revokeHiggsfieldArchive,authorizeHiggsfieldArchive} from '../src/lib/higgsfield-archives';
import {createHiggsfieldArchiveWorker} from '../src/lib/higgsfield-archive-worker';
import {assertHiggsfieldArchiveDatabase,HIGGSFIELD_ARCHIVE_WORKER_ROLE} from '../src/lib/higgsfield-archive-preflight';
import type {RunpodProjectStorage,RunpodMultipartUpload} from '../src/lib/project-storage-runpod';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');

// CI only: unique database and authenticated LOGINs exercise the exact grant
// scripts. Source, decoder and storage providers are synthetic injected code;
// no provider, existing database rows, account tokens or paid API is contacted.
test('PostgreSQL separates archive approval authority from the dedicated transfer worker',{skip:!localPostgres,timeout:180000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_archives_'+suffix;
 const roles={runtime:'coatria_archive_api_'+suffix,worker:HIGGSFIELD_ARCHIVE_WORKER_ROLE};
 const prior={pool:(globalThis as any).coatriaPool,url:process.env.DATABASE_URL,key:process.env.COATRIA_HOSTING_KEYRING,enabled:process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED,fetch:globalThis.fetch};
 const control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000}),ownerUrl=new URL(integration!);ownerUrl.pathname='/'+dbName;
 let owner:Pool|undefined,runtime:Pool|undefined,workerPool:Pool|undefined,created=false,scratchRoot:string|undefined;
 const createdRoles:string[]=[],companyId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),providerId=randomUUID(),providerJobId=randomUUID(),requestId=randomUUID(),taskId=randomUUID(),workId=randomUUID();
 const actor={companyId,userId},locator='https://media.reviewed.example/private.png?signature='+randomUUID(),oauth='synthetic-oauth-'+randomUUID(),storageSecret='rps_synthetic-only';
 const body=Buffer.alloc(5*1024**2+29,37),counts={fetch:0,inspect:0,create:0,part:0,complete:0,get:0,network:0};
 const parts=new Map<string,Map<number,Buffer>>(),objects=new Map<string,Buffer>();
 globalThis.fetch=async()=>{counts.network++;throw Error('Real network is forbidden in this database permissions suite');};
 const use=(pool:Pool)=>{(globalThis as any).coatriaPool=pool;};
 const identity=async(pool:Pool|PoolClient,role:string)=>{const row=(await pool.query('SELECT current_user,session_user,pg_backend_pid() AS pid')).rows[0];assert.equal(row.current_user,role);assert.equal(row.session_user,role);return row.pid as number;};
 const denied=async(pool:Pool,role:string,sql:string)=>{
  // Pool.query removes clients on query errors. Keep this standalone denial on
  // one checked-out connection so cleanup never races a discarded backend.
  const client=await pool.connect();
  try{const pid=await identity(client,role);await assert.rejects(client.query(sql),{code:'42501'},sql);assert.equal(await identity(client,role),pid,'A denied statement must retain this authenticated client');}
  finally{client.release();}
 };
 const clean=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of[locator,oauth,storageSecret,'sealed','lease_id'])assert(!text.includes(secret),secret+' leaked into public archive output');};
 try{
  await control.query(`CREATE DATABASE ${dbName}`);created=true;owner=new Pool({connectionString:ownerUrl.href,max:2,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){await owner.query(await readFile('database/'+file,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
  for(const [kind,role]of Object.entries(roles)){
   const password=randomBytes(32).toString('hex');await control.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);createdRoles.push(role);
   const script=await readFile('database/'+(kind==='runtime'?'runtime-permissions.sql':'higgsfield-archive-worker-permissions.sql'),'utf8');await owner.query(script.replaceAll(kind==='runtime'?'coatria_runtime_v1':'coatria_higgsfield_archive_worker_v1',role));
   const url=new URL(ownerUrl);url.username=role;url.password=password;const pool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:10000});if(kind==='runtime')runtime=pool;else workerPool=pool;await identity(pool,role);
  }
  await t.test('startup accepts only the dedicated LOGIN with exact current effective archive privileges',async()=>{
   assert.equal((await assertHiggsfieldArchiveDatabase(workerPool!)).status,'passed');
   await assert.rejects(()=>assertHiggsfieldArchiveDatabase(owner!),{code:'ARCHIVE_DB_IDENTITY'});
   await assert.rejects(()=>assertHiggsfieldArchiveDatabase(runtime!),{code:'ARCHIVE_DB_IDENTITY'});
   const impersonated=await owner!.connect();try{await impersonated.query('SET ROLE '+roles.worker);await assert.rejects(()=>assertHiggsfieldArchiveDatabase(impersonated),{code:'ARCHIVE_DB_IDENTITY'});}finally{await impersonated.query('RESET ROLE');impersonated.release();}
   await control.query(`GRANT ${roles.runtime} TO ${roles.worker}`);try{await assert.rejects(()=>assertHiggsfieldArchiveDatabase(workerPool!),{code:'ARCHIVE_DB_ROLE'});}finally{await control.query(`REVOKE ${roles.runtime} FROM ${roles.worker}`);}
   const grants=await readFile('database/higgsfield-archive-worker-permissions.sql','utf8');
   for(const sql of[`REVOKE UPDATE(status) ON project_storage_uploads FROM ${roles.worker}`,`GRANT SELECT(sealed) ON higgsfield_connections TO ${roles.worker}`,`GRANT UPDATE(role) ON memberships TO ${roles.worker}`,`GRANT SELECT ON schema_migrations TO ${roles.worker} WITH GRANT OPTION`]){
    await owner!.query(sql);try{await assert.rejects(()=>assertHiggsfieldArchiveDatabase(workerPool!),{code:'ARCHIVE_DB_PRIVILEGES'});}finally{await owner!.query(grants);}
   }
   await owner!.query('GRANT SELECT ON sessions TO PUBLIC');try{await assert.rejects(()=>assertHiggsfieldArchiveDatabase(workerPool!),{code:'ARCHIVE_DB_PRIVILEGES'});}finally{await owner!.query('REVOKE SELECT ON sessions FROM PUBLIC');}
   await owner!.query("CREATE FUNCTION public.archive_preflight_fixture() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");try{await assert.rejects(()=>assertHiggsfieldArchiveDatabase(workerPool!),{code:'ARCHIVE_DB_PRIVILEGES'});await owner!.query('REVOKE ALL ON FUNCTION public.archive_preflight_fixture() FROM PUBLIC');assert.equal((await assertHiggsfieldArchiveDatabase(workerPool!)).status,'passed');}finally{await owner!.query('DROP FUNCTION public.archive_preflight_fixture()');}
   await owner!.query("DELETE FROM schema_migrations WHERE name='029_higgsfield_archives.sql'");try{await assert.rejects(()=>assertHiggsfieldArchiveDatabase(workerPool!),{code:'ARCHIVE_DB_MIGRATIONS'});}finally{await owner!.query("INSERT INTO schema_migrations(name) VALUES('029_higgsfield_archives.sql')");}
   assert.equal((await assertHiggsfieldArchiveDatabase(workerPool!)).status,'passed');assert.equal((await owner!.query('SELECT count(*)::int n FROM higgsfield_output_archives')).rows[0].n,0);
  });
  process.env.DATABASE_URL=ownerUrl.href;process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});
  await owner.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic archive owner',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  await owner.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Isolated archive PostgreSQL fixture',$2,'blank')",[companyId,companyId]);await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);
  await owner.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
  const gates=Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved',recordedBy:userId}]));
  await owner.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Archive fixture','Internal','Synthetic original generation',$3,'allowed','production',$4,$5,'higgsfield')",[projectId,companyId,JSON.stringify({width:32,height:32,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),JSON.stringify(gates),userId]);
  await owner.query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Fixture generation',$3)",[taskId,companyId,userId]);await owner.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[workId,companyId,projectId,taskId]);await owner.query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[companyId,userId]);
  await owner.query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[companyId,providerId,userId,JSON.stringify(sealHiggsfieldSecret({token:{access_token:oauth}},{companyId,id:providerId,purpose:'oauth-connection'}))]);
  const request=(await owner.query("INSERT INTO higgsfield_requests(id,company_id,project_id,requested_by,client_id,project_revision,connection_id,connection_revision,tool,arguments,note,request_hash,status,approved_by,dispatched_at,work_item_id,task_revision,role_human_id) VALUES($1,$2,$3,$4,$5,1,$6,1,'generate_image',$7,'Synthetic adopted receipt',$8,'returned',$4,clock_timestamp(),$9,1,$4) RETURNING *",[requestId,companyId,projectId,userId,randomUUID(),providerId,JSON.stringify({prompt:'Synthetic original'}),sha(requestId),workId])).rows[0];
  use(runtime!);await transaction(db=>recordHiggsfieldSubmission(db,request,{structuredContent:{results:[{id:providerJobId,type:'image',status:'completed',model:'synthetic-model',params:{prompt:'Synthetic original'},results:{rawUrl:locator}}]}}));
  const output=(await owner.query('SELECT * FROM higgsfield_job_outputs WHERE company_id=$1',[companyId])).rows[0];assert(output);
  const connection=(await transaction(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic volume',region:'US-NC-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:storageSecret}))).connection;
  let binding=(await transaction(db=>bindProjectStorage(db,actor,projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  const folder=await transaction(db=>createProjectStorageFolder(db,actor,projectId,{clientId:randomUUID(),revision:binding.revision,parentId:null,name:'Approved outputs'}));binding=folder.binding;
  const proposed=(await transaction(db=>proposeHiggsfieldArchive(db,actor,{clientId:randomUUID(),projectId,projectRevision:1,jobId:output.job_id,outputId:output.id,outputIdentity:output.locator_identity,bindingId:binding.id,bindingRevision:binding.revision,parentId:folder.folder.id,name:'approved.png',maxBytes:body.length+1024}))).archive;
  const approved=await transaction(db=>approveHiggsfieldArchive(db,actor,proposed.id,{clientId:randomUUID(),revision:proposed.revision,requestHash:proposed.requestHash,projectRevision:1,bindingRevision:binding.revision,expiresInHours:1,archiveConsent:true}));assert.equal(approved.archive.status,'queued');clean(approved);

  await t.test('web role can approve but cannot rewrite source, destination, approval identity evidence or worker receipts',async()=>{
   for(const column of['source_snapshot','output_id','job_id','request_id','locator_identity','provider_connection_id','storage_binding_id','storage_connection_id','destination_name','destination_file_id','max_bytes','request_hash','proposed_by','upload_id','version_id','attempt_count'])await denied(runtime!,roles.runtime,`UPDATE higgsfield_output_archives SET ${column}=${column}`);
   await denied(runtime!,roles.runtime,'INSERT INTO higgsfield_archive_fetches SELECT * FROM higgsfield_archive_fetches');
   for(const table of['higgsfield_output_archives','higgsfield_archive_fetches','higgsfield_archive_receipts','higgsfield_archive_requests'])await denied(runtime!,roles.runtime,`DELETE FROM ${table}`);
   for(const table of['higgsfield_archive_fetches','higgsfield_archive_receipts','higgsfield_archive_requests'])await denied(runtime!,roles.runtime,`UPDATE ${table} SET company_id=company_id`);
  });

  await t.test('database deadlines remain authoritative when the application clock is behind or ahead',async()=>{
   use(workerPool!);const now=Date.now,lease=randomUUID();
   try{
    Date.now=()=>0;await owner!.query("UPDATE higgsfield_output_archives SET lease_id=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[proposed.id,lease]);
    await assert.rejects(()=>transaction(db=>authorizeHiggsfieldArchive(db,companyId,proposed.id,{leaseId:lease})),{code:'HIGGSFIELD_ARCHIVE_LEASE_ENDED'});
    await owner!.query("UPDATE higgsfield_output_archives SET approved_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[proposed.id]);
    await assert.rejects(()=>transaction(db=>authorizeHiggsfieldArchive(db,companyId,proposed.id)),{code:'HIGGSFIELD_ARCHIVE_AUTHORITY_ENDED'});
    await owner!.query('UPDATE higgsfield_output_archives SET approved_at=$2,expires_at=$3,lease_id=NULL,lease_expires_at=NULL WHERE id=$1',[proposed.id,approved.archive.approvedAt,approved.archive.expiresAt]);
    Date.now=()=>8640000000000000;await transaction(db=>authorizeHiggsfieldArchive(db,companyId,proposed.id));
   }finally{Date.now=now;await owner!.query('UPDATE higgsfield_output_archives SET approved_at=$2,expires_at=$3,lease_id=NULL,lease_expires_at=NULL WHERE id=$1',[proposed.id,approved.archive.approvedAt,approved.archive.expiresAt]);}
  });

  await t.test('dedicated authenticated worker claims, decrypts only approved output, writes parts and verifies stored bytes',async()=>{
   use(workerPool!);scratchRoot=await mkdtemp(join(tmpdir(),'coatria-pg-archive-'));
   const checkIntent=async(operation:string)=>{await identity(workerPool!,roles.worker);const upload=(await workerPool!.query('SELECT * FROM project_storage_uploads WHERE archive_id=$1',[proposed.id])).rows[0];assert.equal(upload.actor_key,'archive:'+proposed.id);assert.equal(upload.actor_agent_id,null);assert.equal(upload.run_id,null);assert.equal(upload.verification_grant_id,null);assert(upload.action_id);assert.equal((await workerPool!.query("SELECT count(*)::int n FROM higgsfield_archive_receipts WHERE archive_id=$1 AND action_id=$2 AND operation=$3 AND phase='intent'",[proposed.id,upload.action_id,operation])).rows[0].n,1);};
   const archiveWorker=createHiggsfieldArchiveWorker({scratchRoot,partBytes:5*1024**2,authorityIntervalMs:500,operationDeadlineMs:30000,
    fetchOutput:async input=>{counts.fetch++;assert.equal(input.locator,locator);await input.assertAuthority(input.signal!);await input.consume(body,input.signal!);return {bytes:body.length,sha256:sha(body)};},
    inspectMedia:async input=>{counts.inspect++;const bytes=await readFile(input.path);assert.equal(bytes.length,input.expectedBytes);assert.equal(sha(bytes),input.expectedSha256);return {kind:'image',format:'png',contentType:'image/png',bytes:bytes.length,sha256:sha(bytes),verification:'full_decode',inspectionVersion:1,width:32,height:32,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};},
    providerFactory:config=>{assert.equal(config.credentials.secretAccessKey,storageSecret);assert.equal(config.companyId,companyId);assert.equal(config.projectId,projectId);const provider:RunpodProjectStorage={
     list:async()=>({objects:[],cursor:null}),head:async()=>null,validateMultipart:value=>value as RunpodMultipartUpload,
     createMultipart:async input=>{counts.create++;await checkIntent('initiate');const descriptor={scope:companyId,versionId:input.versionId,uploadId:randomUUID(),bytes:input.bytes,partBytes:config.partBytes!};parts.set(descriptor.uploadId,new Map());return descriptor;},
     uploadPart:async input=>{counts.part++;await checkIntent('part');const bytes=input.body instanceof Uint8Array?Buffer.from(input.body):Buffer.from(await new Response(input.body as ReadableStream<Uint8Array>).arrayBuffer());parts.get(input.upload.uploadId)!.set(input.partNumber,bytes);return {partNumber:input.partNumber,bytes:bytes.length,etag:'"part-'+sha(bytes)+'"'};},
     completeMultipart:async input=>{counts.complete++;await checkIntent('complete');objects.set(input.upload.versionId,Buffer.concat(input.parts.map(part=>parts.get(input.upload.uploadId)!.get(part.partNumber)!)));return {versionId:input.upload.versionId,etag:'"stored-object"'};},
     abortMultipart:async()=>{throw Error('No provider deletion authorized');},
     get:async input=>{counts.get++;assert.equal(input.ifMatch,'"stored-object"');const bytes=objects.get(input.versionId)!;assert(bytes);return {stream:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}}),bytes:bytes.length,totalBytes:bytes.length,etag:'"stored-object"',contentType:'image/png',contentRange:null,range:null};},close(){}
    };return provider;}
   });
   assert.deepEqual(await archiveWorker.runNext(),{processed:true,archiveId:proposed.id,status:'verified'});assert.deepEqual(await archiveWorker.runNext(),{processed:false});
   assert.deepEqual(counts,{fetch:1,inspect:1,create:1,part:2,complete:1,get:1,network:0});assert.deepEqual(await readdir(scratchRoot),[]);
   const saved=(await workerPool!.query('SELECT * FROM higgsfield_output_archives WHERE id=$1',[proposed.id])).rows[0];assert.deepEqual(objects.get(saved.version_id),body);
   const verification=(await workerPool!.query('SELECT * FROM project_storage_verifications WHERE version_id=$1',[saved.version_id])).rows[0];assert.equal(verification.sha256,sha(body));assert.equal(Number(verification.bytes),body.length);
   assert.equal((await owner!.query('SELECT count(*)::int n FROM project_storage_access_receipts WHERE company_id=$1',[companyId])).rows[0].n,0);
   use(runtime!);const view=await transaction(db=>getHiggsfieldArchive(db,actor,proposed.id));assert.equal(view.archive.bytesVerified,true);assert.deepEqual(view.archive.fetched,{bytes:body.length,sha256:sha(body)});clean(view);
  });

  await t.test('worker cannot approve, impersonate a runtime, change role authority or rewrite immutable provenance',async()=>{
   use(workerPool!);
   for(const column of['company_id','project_id','output_id','source_snapshot','provider_connection_id','storage_connection_snapshot','storage_connection_id','storage_binding_id','destination_parent_id','destination_file_id','destination_name','destination_ancestors','max_bytes','request_hash','revision','approved_by','approved_at','expires_at','approved_project_revision','approved_binding_revision','revoked_by','revoked_at'])await denied(workerPool!,roles.worker,`UPDATE higgsfield_output_archives SET ${column}=${column}`);
   await denied(workerPool!,roles.worker,'INSERT INTO higgsfield_output_archives SELECT * FROM higgsfield_output_archives');
   for(const table of['higgsfield_archive_fetches','higgsfield_archive_receipts','higgsfield_output_locators','higgsfield_job_outputs','higgsfield_job_receipts','project_storage_versions','project_storage_upload_parts','project_storage_verifications']){await denied(workerPool!,roles.worker,`UPDATE ${table} SET company_id=company_id`);await denied(workerPool!,roles.worker,`DELETE FROM ${table}`);}
   for(const [table,column]of[['memberships','role'],['studio_role_bindings','human_id'],['studio_role_bindings','agent_id'],['studio_role_bindings','role_key'],['studio_projects','gates'],['higgsfield_connections','status'],['higgsfield_connections','connected_by'],['higgsfield_jobs','provider_job_id'],['higgsfield_requests','approved_by'],['project_storage_connections','secret_envelope'],['project_storage_connections','volume_id'],['project_storage_bindings','connection_id'],['project_storage_folders','parent_id'],['project_storage_files','name'],['project_storage_uploads','actor_key'],['project_storage_uploads','archive_id'],['project_storage_uploads','verification_grant_id']])await denied(workerPool!,roles.worker,`UPDATE ${table} SET ${column}=${column}`);
   for(const sql of['SELECT sealed FROM higgsfield_connections','SELECT * FROM higgsfield_provider_responses','SELECT * FROM higgsfield_oauth_attempts','SELECT arguments FROM higgsfield_requests','SELECT token_hash FROM agents','SELECT * FROM agent_runs','SELECT * FROM sessions','SELECT password_hash FROM users','SELECT * FROM studio_host_credentials','SELECT * FROM higgsfield_archive_requests',`SET ROLE ${roles.runtime}`])await denied(workerPool!,roles.worker,sql);
   const client=await workerPool!.connect(),oldPid=await identity(client,roles.worker);client.release(true);assert.notEqual(await identity(workerPool!,roles.worker),oldPid,'Reconnection must remain the worker LOGIN');
  });

  await t.test('worker grant reapplication removes obsolete column grants and retained verified bytes can be revoked by the web role',async()=>{
   await owner!.query(`GRANT SELECT(sealed),UPDATE(connected_by) ON higgsfield_connections TO ${roles.worker}`);
   await owner!.query((await readFile('database/higgsfield-archive-worker-permissions.sql','utf8')).replaceAll('coatria_higgsfield_archive_worker_v1',roles.worker));
   await denied(workerPool!,roles.worker,'SELECT sealed FROM higgsfield_connections');await denied(workerPool!,roles.worker,'UPDATE higgsfield_connections SET connected_by=connected_by');
   use(runtime!);const view=await transaction(db=>getHiggsfieldArchive(db,actor,proposed.id));const revoked=await transaction(db=>revokeHiggsfieldArchive(db,actor,proposed.id,{clientId:randomUUID(),revision:view.archive.revision,note:'Retain verified bytes; end authority'}));assert.equal(revoked.archive.status,'verified');assert.equal(revoked.archive.bytesVerified,true);assert(revoked.archive.revokedAt);assert.equal(revoked.storedBytesDeleted,false);clean(revoked);
  });
 }finally{
  globalThis.fetch=prior.fetch;if(prior.pool)(globalThis as any).coatriaPool=prior.pool;else delete(globalThis as any).coatriaPool;
  for(const [key,value]of Object.entries({DATABASE_URL:prior.url,COATRIA_HOSTING_KEYRING:prior.key,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:prior.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  try{
   await workerPool?.end();await runtime?.end();await owner?.end();
   if(created){
    // Pool.end waits for its tracked clients; the explicit reconnection test
    // also removes a client. Wait for PostgreSQL to observe every disconnect.
    const deadline=performance.now()+10000;
    while(true){const remaining=(await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0].count;if(remaining===0)break;assert(performance.now()<deadline,'Disposable archive database connections did not drain');await new Promise(resolve=>setTimeout(resolve,25));}
    await control.query(`DROP DATABASE ${dbName}`);
   }
   for(const role of createdRoles)await control.query(`DROP ROLE ${role}`);
  }finally{await control.end();if(scratchRoot)await rm(scratchRoot,{recursive:true,force:true});}
 }
});
