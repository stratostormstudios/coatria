/** Real relational authorization/state with synthetic provider bytes. This is
 * not live Runpod, native decoder, or host qualification evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {readFile} from 'node:fs/promises';
import {assertProjectStorageGatewayDatabase,PROJECT_STORAGE_GATEWAY_ROLE as role} from '../src/lib/project-storage-preflight';
import {assertImagePreparationGatewayDatabase,IMAGE_PREPARATION_GATEWAY_LOCK_TABLES} from '../src/lib/project-image-preparation-gateway-database.mjs';
import {executeAgentTaskAction} from '../src/lib/agent-task-actions';
import {canonicalStudioReview,decideStudioPlanningReview,readStudioPlanningReview,saveStudioReviewPolicy} from '../src/lib/studio-review-policy';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';
import {createImagePreparationByteGateway} from '../src/lib/project-image-preparation-byte-gateway';
import type {ImagePreparationByteProvider} from '../src/lib/project-image-preparation-provider';
import {hashToken} from '../src/lib/security';
import * as preparations from '../src/lib/project-image-preparations';
import * as storage from '../src/lib/project-image-preparation-storage';
import {runpodProjectRoot,type RunpodMultipartUpload} from '../src/lib/project-storage-runpod';
import type {PreparationByteOperation} from '../src/lib/project-image-preparation-service-protocol';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};

test('explicit preparation gateway ACL uses real authorization and byte SQL only',{timeout:180000},async t=>{
 const database=await openImagePreparationServiceDatabase(),originalKeyring=process.env.COATRIA_HOSTING_KEYRING;
 let login:Pool|undefined,lock:PoolClient|undefined,createdRole=false;
 const password=randomBytes(32).toString('hex');
 const gatewayTx=async<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>=>{
  if(!login)return database.tx(async db=>{await db.query('SET LOCAL ROLE '+role);return run(db);});
  const db=await login.connect();try{await db.query('BEGIN');const value=await run(db);await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 };
 async function preflight(image=true){
  const check=image?assertImagePreparationGatewayDatabase:assertProjectStorageGatewayDatabase;
  if(login)return check(login);
  await database.exec('SET SESSION AUTHORIZATION '+role);try{return await check(database.db);}finally{await database.exec('SET SESSION AUTHORIZATION postgres');}
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function submittedPlan(f:Awaited<ReturnType<typeof imagePreparationServiceFixture>>,mode:'human'|'machine'){
  const agentId=randomUUID(),runId=randomUUID(),conversationId=randomUUID(),reviewerId=randomUUID(),caps=['storage.read','studio.read','studio.write','tasks.write'];
  const proposed=await database.tx(async db=>{
   await db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Independent synthetic reviewer',$2,'not-a-login')",[reviewerId,reviewerId+'@example.invalid']);
   await db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin')",[f.companyId,reviewerId]);
   await db.query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic original planner','custom',$3,$4,'admins',$5)",[agentId,f.companyId,hashToken(agentId),f.userId,JSON.stringify(caps)]);
   await db.query('INSERT INTO conversations(id,company_id) VALUES($1,$2)',[conversationId,f.companyId]);
   await db.query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic original plan',$8,'queued',1)",[runId,f.companyId,agentId,f.userId,conversationId,randomUUID(),'1'.repeat(64),JSON.stringify(caps)]);
   await db.query("UPDATE studio_role_bindings SET agent_id=$2,human_id=NULL WHERE company_id=$1 AND role_key='ingest'",[f.companyId,agentId]);
   await db.query("INSERT INTO studio_dispatches(company_id,project_id,work_item_id,run_id,original_preparation_profile) VALUES($1,$2,$3,$4,'original_image_v1')",[f.companyId,f.projectId,f.workItemId,runId]);
   await db.query('INSERT INTO studio_image_preparation_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[f.companyId,f.projectId,f.workItemId,runId]);
   await db.query("UPDATE agent_runs SET status='running',worker_id='synthetic',lease_token_hash=$2,lease_expires_at=clock_timestamp()+interval '1 hour',started_at=clock_timestamp(),attempts=1 WHERE id=$1",[runId,'2'.repeat(64)]);
   await db.query("UPDATE tasks SET status='doing',agent_run_id=$2,assignee_id=NULL WHERE id=$1",[f.taskId,runId]);
   return (await preparations.proposeProjectImagePreparation(db,{...f.actor,agentId,runId},{clientId:randomUUID(),projectId:f.projectId,projectRevision:1,workItemId:f.workItemId,sourceVersionId:f.versionId,sourceSha256:f.sourceSha256,sourceBytes:f.sourceLength,destinationFolderId:null,destinationName:'prepared.png',purpose:'Synthetic independently accepted original plan',continuation:'submitted_plan_v1'})).preparation;
  });
  await database.tx(async db=>{
   const agent=(await db.query('SELECT * FROM agents WHERE id=$1',[agentId])).rows[0],run=(await db.query('SELECT * FROM agent_runs WHERE id=$1',[runId])).rows[0];
   const revision=(await db.query('SELECT revision FROM tasks WHERE id=$1',[f.taskId])).rows[0].revision,args={taskId:f.taskId,revision,summary:'Exact original proposed; processing, derivative storage and sharing require separate consent.',tokensUsed:0};
   const response=await executeAgentTaskAction(db,agent,run,'owner','tasks_submit',args);
   await db.query("INSERT INTO agent_tool_receipts(company_id,agent_id,run_id,request_id,tool,request_hash,response) VALUES($1,$2,$3,$4,'tasks_submit',$5,$6)",[f.companyId,agentId,runId,randomUUID(),hashToken(JSON.stringify(args)),JSON.stringify(response)]);
   const messageId=randomUUID();await db.query("INSERT INTO messages(id,company_id,conversation_id,sequence,last_event_sequence,actor_kind,agent_id,body) VALUES($1,$2,$3,1,1,'agent',$4,'Synthetic submitted planning completion')",[messageId,f.companyId,conversationId,agentId]);
   await db.query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),result_message_id=$2 WHERE id=$1",[runId,messageId]);
   await db.query("INSERT INTO agent_run_receipts(company_id,run_id,client_id,kind,payload_hash,lease_token_hash,response) VALUES($1,$2,$3,'complete',$4,$5,$6)",[f.companyId,runId,randomUUID(),'3'.repeat(64),'2'.repeat(64),JSON.stringify({run:{id:runId,status:'succeeded',resultMessageId:messageId}})]);
  });
  if(mode==='human')await database.db.query("UPDATE tasks SET status='done',agent_run_id=NULL,approved_by=$2,revision=revision+1 WHERE id=$1",[f.taskId,reviewerId]);
  else{
   const coordinator=randomUUID(),reviewer=randomUUID(),reviewerRun=randomUUID(),reviewId=randomUUID();
   for(const [id,sponsor,capabilities] of [[coordinator,f.userId,['studio.read','studio.write']],[reviewer,reviewerId,['studio.read','studio.review']]] as const){
    await database.db.query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic review agent','custom',$3,$4,'admins',$5)",[id,f.companyId,hashToken(id),sponsor,JSON.stringify(capabilities)]);
    await database.db.query("INSERT INTO plugin_installations(company_id,agent_id,installed_by,client_id,request_hash,plugin_id,manifest_version,runtime_config,character) VALUES($1,$2,$3,$4,$5,'synthetic','1','{}','{}')",[f.companyId,id,sponsor,randomUUID(),'5'.repeat(64)]);
   }
   await database.db.query("INSERT INTO studio_role_bindings(company_id,role_key,agent_id) VALUES($1,'producer',$2)",[f.companyId,coordinator]);
   await database.tx(db=>saveStudioReviewPolicy(db,{companyId:f.companyId,userId:reviewerId,role:'admin',user:{name:'Synthetic policy administrator'}} as any,f.projectId,{clientId:randomUUID(),revision:0,coordinatorAgentId:coordinator,reviewerAgentId:reviewer,allowedStages:['references'],allowSharedSponsor:false,maxReviews:10,status:'active',expiresAt:new Date(Date.now()+3_600_000).toISOString()}));
   await database.db.query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at,started_at,attempts,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic review','[\"studio.review\"]','running','synthetic',$8,clock_timestamp()+interval '1 hour',clock_timestamp(),1,1)",[reviewerRun,f.companyId,reviewer,reviewerId,conversationId,randomUUID(),'6'.repeat(64),'7'.repeat(64)]);
   const project=(await database.db.query('SELECT * FROM studio_projects WHERE id=$1',[f.projectId])).rows[0],task=(await database.db.query('SELECT * FROM tasks WHERE id=$1',[f.taskId])).rows[0];
   const brief={id:project.id,name:project.name,brief:project.brief,spec:project.spec,aiPolicy:project.ai_policy,approvedBrief:project.gates.brief},submission={schemaVersion:1,reviewKind:'machine_planning',independentHumanReview:false,contentInspected:false,project:brief,work:{id:f.workItemId,stage:'references',execution:'agent'},task:{id:f.taskId,revision:task.revision,title:task.title,description:task.description,summary:task.submission_summary,url:task.submission_url,producerAgentId:agentId,producerRunId:runId},inputReferences:[]},sha=hashToken(canonicalStudioReview(submission));
   await database.db.query('INSERT INTO studio_planning_reviews(id,company_id,project_id,work_item_id,task_id,task_revision,policy_revision,parent_run_id,reviewer_run_id,reviewer_agent_id,producer_agent_id,producer_run_id,submission,submission_sha256,brief_sha256) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$7,$11,$12,$13)',[reviewId,f.companyId,f.projectId,f.workItemId,f.taskId,task.revision,runId,reviewerRun,reviewer,agentId,JSON.stringify(submission),sha,hashToken(canonicalStudioReview(brief))]);
   const a=(await database.db.query('SELECT * FROM agents WHERE id=$1',[reviewer])).rows[0],r=(await database.db.query('SELECT * FROM agent_runs WHERE id=$1',[reviewerRun])).rows[0];
   await database.tx(db=>readStudioPlanningReview(db,a,r,{reviewId}));await database.tx(db=>decideStudioPlanningReview(db,a,r,{reviewId,policyRevision:1,submissionSha256:sha,decision:'approve',note:'Synthetic machine planning acceptance only. No media inspection.'}));
  }
  return proposed;
 }
 async function fixture(sourceBytes?:Buffer,mode?:'human'|'machine'){
  const source=sourceBytes??Buffer.from('Synthetic original transport bytes. Decoder is not part of this fixture.');
  const f=await database.tx(db=>imagePreparationServiceFixture(db,{sourceBytes:source,propose:!mode}));
  process.env.COATRIA_HOSTING_KEYRING=f.storageKeyring;
  const proposed=mode?await submittedPlan(f,mode):f.proposed!;
  await database.tx(db=>preparations.approveProjectImagePreparation(db,f.actor,proposed.id,{clientId:randomUUID(),revision:proposed.revision,requestHash:proposed.requestHash,processorId:f.serviceId,qualificationSha256:f.enrollment.qualificationSha256,expiresInMinutes:5,maxCostMicrousd:0,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},f.runtime));const lease=await database.tx(db=>f.claim(db));
  const output=Buffer.from('Synthetic derivative transport bytes. No pixel claim.');
  const calls:string[]=[],scope=hash(JSON.stringify(['US-CA-2','synthetic-volume',runpodProjectRoot(f.companyId,f.projectId)]));
  let stored:Buffer|undefined,hook:((operation:string)=>Promise<void>)|undefined,drainHook:(()=>Promise<void>)|undefined,tinyChunks=false;
  const factory=():ImagePreparationByteProvider=>({
   async verifyBucketAccess(){throw Error('No synthetic bucket access');},async list(){throw Error('No synthetic listing');},async head(){throw Error('No synthetic HEAD');},async abortMultipart(){throw Error('No synthetic delete');},
   async get(input){const operation=input.versionId===f.versionId?'read-source':'read-output';calls.push(operation);await hook?.(operation);const bytes=operation==='read-source'?source:stored!;assert.ok(bytes);let offset=0;const stream=tinyChunks?new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.subarray(offset,++offset));}},{highWaterMark:0}):new Response(new Uint8Array(bytes)).body!;return {stream,bytes:bytes.length,totalBytes:bytes.length,contentType:'image/png',etag:operation==='read-source'?'synthetic-source-etag':'stored-etag',range:null,contentRange:null};},
   async createMultipart(input){calls.push('initiate');await hook?.('initiate');return {scope,versionId:input.versionId,uploadId:'synthetic-private-multipart',bytes:input.bytes,partBytes:64*1024**2};},
   validateMultipart(value){const v=value as RunpodMultipartUpload;assert.equal(v.scope,scope);return structuredClone(v);},
   async uploadPart(input){calls.push('part');await hook?.('part');assert(input.body instanceof Uint8Array);stored=Buffer.from(input.body);return {partNumber:1,bytes:stored.length,etag:'private-part-etag'};},
   async completeMultipart(input){calls.push('complete');await hook?.('complete');assert.equal(input.parts.length,1);return {versionId:input.upload.versionId,etag:'stored-etag'};},
   close(){},async drain(){await drainHook?.();},
  });
  const identity={version:1 as const,companyId:f.companyId,projectIds:[f.projectId],provisionId:f.gateway.provisionId,configurationHash:f.gateway.configurationHash,sourceCommit:'b'.repeat(40),expiresAt:f.gateway.expiresAt};
  const gateway=createImagePreparationByteGateway({transaction:gatewayTx,identity,providerFactory:factory});
  async function prepareOutput(){
   const action=await database.tx(db=>preparations.beginProjectImagePreparationPhase(db,lease,'transform',f.runtime));
   await database.tx(db=>preparations.completeProjectImagePreparationPhase(db,lease,action.actionId,{operation:'transform',sourceVersionId:f.versionId,sourceSha256:hash(source),sourceBytes:source.length,source:{format:'png',width:16,height:16,orientation:1},recipeSha256:lease.recipeSha256,processor:lease.processor,output:{sha256:hash(output),bytes:output.length,width:16,height:16,format:'png',pixelFormat:'rgba8',metadataRemoved:true}},f.runtime));
   return database.tx(db=>storage.reserveProjectImagePreparationOutput(db,lease,f.runtime));
  }
  async function capability(operation:PreparationByteOperation,actionId:string|null=null){
   const grantId=randomUUID(),requestId=randomUUID(),token='ipt_'+randomBytes(32).toString('base64url');
   await database.tx(async db=>{
    const p=(await db.query('SELECT * FROM project_image_preparations WHERE id=$1',[lease.preparationId])).rows[0];
    const allocation=(await db.query('SELECT a.*,u.provider_etag FROM project_image_preparation_allocations a JOIN project_storage_uploads u ON u.company_id=a.company_id AND u.id=a.upload_id WHERE a.preparation_id=$1',[lease.preparationId])).rows[0];
    const sourceRead=operation==='read-source',expires=new Date(Date.now()+25000).toISOString();
    await db.query("INSERT INTO project_image_preparation_service_calls(service_id,request_id,operation,request_hash,deadline_at,status) VALUES($1,$2,'byte-capability',$3,$4,'started')",[f.serviceId,requestId,'f'.repeat(64),expires]);
    await db.query(`INSERT INTO project_image_preparation_byte_grants(id,service_id,company_id,project_id,preparation_id,lease_id,request_id,request_hash,token_hash,operation,action_id,version_id,upload_id,bytes,sha256,content_type,expected_etag,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,gateway_binding_id,gateway_provision_id,gateway_configuration_sha256,gateway_origin,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'image/png',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [grantId,f.serviceId,f.companyId,f.projectId,lease.preparationId,lease.leaseId,requestId,lease.requestHash,hashToken(token),operation,actionId,sourceRead?f.versionId:allocation.version_id,sourceRead?null:allocation.upload_id,sourceRead?source.length:output.length,sourceRead?hash(source):hash(output),sourceRead?'synthetic-source-etag':operation==='read-output'?allocation.provider_etag:null,p.storage_binding_id,sourceRead?p.storage_binding_revision:allocation.binding_revision_after,p.storage_connection_id,p.storage_connection_revision,f.gateway.bindingId,f.gateway.provisionId,f.gateway.configurationHash,f.gateway.origin,expires]);
   });
   return {id:grantId,token,operation};
  }
  function request(cap:Awaited<ReturnType<typeof capability>>,body?:Buffer,signal?:AbortSignal){
   return new Request(f.gateway.origin+'/v1/image-preparations/capabilities/'+cap.id+'/'+cap.operation,{method:cap.operation.startsWith('read-')?'GET':cap.operation==='part'?'PUT':'POST',headers:{authorization:'Bearer '+cap.token,...body?{'content-type':'image/png','content-length':String(body.length)}:{}},...body?{body:new Uint8Array(body)}:{},signal});
  }
  async function result(id:string){return (await database.db.query('SELECT * FROM project_image_preparation_byte_results WHERE grant_id=$1',[id])).rows[0];}
  return {...f,source,output,lease,calls,identity,factory,gateway,capability,request,result,prepareOutput,setHook(value:typeof hook){hook=value;},setDrain(value:typeof drainHook){drainHook=value;},tinyChunks(){tinyChunks=true;},corruptSource(){source[0]^=1;}};
 }
 async function stage(f:Fixture,operation:'initiate'|'part'|'complete'){
  const intent=await database.tx(db=>storage.beginProjectImagePreparationStore(db,f.lease,operation,f.runtime));
  const cap=await f.capability(operation,intent.actionId),response=await f.gateway.handle(f.request(cap,operation==='part'?f.output:undefined));
  return {intent,cap,response};
 }
 try{
  if(database.native){lock=await database.control!.connect();await lock.query('SELECT pg_advisory_lock(739284034)');assert.equal((await lock.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0,'Never alter an existing role');}
  await database.db.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);createdRole=true;
  await database.exec(await readFile('database/storage-gateway-permissions.sql','utf8'));
  if(database.native){const url=new URL(database.connectionString!);url.username=role;url.password=password;login=new Pool({connectionString:url.href,max:2});}
  await t.test('ordinary mode stays exact and extension requires explicit matching grants',async()=>{
   assert.equal((await preflight(false)).contractVersion,2);
   await assert.rejects(preflight(),{code:'STORAGE_DB_PRIVILEGES'});
   await database.exec(await readFile('database/image-preparation-gateway-permissions.sql','utf8'));
   const result=await preflight();assert.equal(result.status,'passed');assert.equal(result.checkedMigrations,50);assert('checkedGuards' in result);assert.equal(result.checkedGuards,31);
   await assert.rejects(preflight(false),{code:'STORAGE_DB_PRIVILEGES'});
   await assert.rejects(assertImagePreparationGatewayDatabase(database.db),{code:'STORAGE_DB_IDENTITY'});
   if(!database.native)await gatewayTx(db=>assert.rejects(assertImagePreparationGatewayDatabase(db),{code:'STORAGE_DB_IDENTITY'}));
  });
  await t.test('source, each multipart operation and exact readback pass through restricted gateway SQL',async()=>{
   const f=await fixture();try{
    const cap=await f.capability('read-source'),source=await f.gateway.handle(f.request(cap));assert.equal(source.status,200,await source.clone().text());assert.deepEqual(Buffer.from(await source.arrayBuffer()),f.source);
    await f.prepareOutput();
    for(const operation of ['initiate','part','complete'] as const){const {intent,cap,response}=await stage(f,operation);assert.equal(response.status,200,await response.clone().text());const saved=await f.result(cap.id);assert.equal(saved.status,'completed');await database.tx(db=>storage.completeProjectImagePreparationStore(db,f.lease,intent.actionId,saved.provider_result,f.runtime));}
    const outputCap=await f.capability('read-output'),output=await f.gateway.handle(f.request(outputCap));assert.equal(output.status,200,await output.clone().text());assert.deepEqual(Buffer.from(await output.arrayBuffer()),f.output);
    assert.deepEqual(f.calls,['read-source','initiate','part','complete','read-output']);
    // Only the owner-side control path can publish after separately confirmed cleanup.
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM project_image_preparation_derivations WHERE preparation_id=$1',[f.lease.preparationId])).rows[0].n,0);
   }finally{f.gateway.close();await f.gateway.drain();}
  });
  await t.test('gateway cannot enroll, approve, mint capabilities, allocate or transition preparation',async()=>{
   const f=await fixture();try{
    for(const table of ['project_image_preparation_services','project_image_preparation_service_projects','project_image_preparation_service_enrollments','project_image_preparation_service_leases','project_image_preparation_service_calls','project_image_preparation_byte_grants','project_image_preparation_approvals','project_image_preparation_allocations','project_image_preparation_derivations','project_image_preparation_receipts','project_storage_versions','project_storage_files'])await assert.rejects(gatewayTx(db=>db.query('INSERT INTO '+table+' DEFAULT VALUES')),{code:'42501'});
    await assert.rejects(gatewayTx(db=>db.query("UPDATE project_image_preparations SET status='failed' WHERE id=$1",[f.lease.preparationId])),{code:'42501'});
    await assert.rejects(gatewayTx(db=>db.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id])),{code:'42501'});
    await assert.rejects(gatewayTx(db=>db.query('SELECT identity FROM project_image_preparation_service_enrollments WHERE service_id=$1 FOR UPDATE',[f.serviceId])),{code:'42501'});
    await assert.rejects(gatewayTx(db=>db.query('SELECT provider_result FROM project_image_preparation_byte_results')),{code:'42501'});
    assert.equal((await database.db.query('SELECT status FROM project_image_preparations WHERE id=$1',[f.lease.preparationId])).rows[0].status,'reading');
   }finally{f.gateway.close();await f.gateway.drain();}
  });
  await t.test('ended original-image plans retain human or machine acceptance under restricted authority reads',async()=>{
   for(const mode of ['human','machine'] as const){const f=await fixture(undefined,mode);try{const cap=await f.capability('read-source'),response=await f.gateway.handle(f.request(cap));assert.equal(response.status,200,mode+': '+await response.clone().text());assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.source);assert.equal((await f.result(cap.id)).status,'completed');}finally{f.gateway.close();await f.gateway.drain();}}
  });
  await t.test('row locks work but every newly granted lock column rejects real changes',async()=>{
   const f=await fixture(),folder=randomUUID();try{
    await database.db.query("INSERT INTO project_storage_folders(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,'synthetic','synthetic',$5)",[folder,f.companyId,f.projectId,f.binding.id,f.userId]);
    const cases=[['project_image_preparations','updated_at',f.lease.preparationId,'id'],['project_image_preparation_services','updated_at',f.serviceId,'id'],['project_storage_folders','created_at',folder,'id'],['studio_work_items','id',f.workItemId,'id'],['studio_role_bindings','created_at',f.companyId,'company_id'],['studio_profiles','updated_at',f.companyId,'company_id'],['project_storage_versions','created_at',f.versionId,'id']];
    assert.equal(cases.length,IMAGE_PREPARATION_GATEWAY_LOCK_TABLES.length);
    for(const [table,column,id,key] of cases){await gatewayTx(db=>db.query(`SELECT ${key} FROM ${table} WHERE ${key}=$1 FOR UPDATE`,[id]));await assert.rejects(gatewayTx(db=>db.query(`UPDATE ${table} SET ${column}=${column==='id'?'gen_random_uuid()':"clock_timestamp()+interval '1 second'"} WHERE ${key}=$1`,[id])),{code:'42501'});}
   }finally{f.gateway.close();await f.gateway.drain();}
  });
  await t.test('added privileges, absent guards and modified immutable guard bodies fail closed',async()=>{
   for(const [grant,revoke] of [
    ['GRANT INSERT ON project_image_preparation_byte_grants','REVOKE INSERT ON project_image_preparation_byte_grants'],
    ['GRANT UPDATE(status) ON project_image_preparations','REVOKE UPDATE(status) ON project_image_preparations'],
    ['GRANT SELECT(provider_result) ON project_image_preparation_byte_results','REVOKE SELECT(provider_result) ON project_image_preparation_byte_results'],
   ]){await database.db.query(grant+' TO '+role);try{await assert.rejects(preflight(),{code:'STORAGE_DB_PRIVILEGES'});}finally{await database.db.query(revoke+' FROM '+role);}}
   await database.db.query('ALTER TABLE project_storage_versions DISABLE TRIGGER coatria_image_preparation_gateway_lock_guard');try{await assert.rejects(preflight(),{code:'IMAGE_PREPARATION_GATEWAY_DB_GUARD'});}finally{await database.db.query('ALTER TABLE project_storage_versions ENABLE ALWAYS TRIGGER coatria_image_preparation_gateway_lock_guard');}
   const definition=(await database.db.query("SELECT pg_get_functiondef('public.guard_image_preparation_service_result()'::regprocedure) AS definition")).rows[0].definition;
   await database.db.query("CREATE OR REPLACE FUNCTION public.guard_image_preparation_service_result() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$");try{await assert.rejects(preflight(),{code:'IMAGE_PREPARATION_GATEWAY_DB_GUARD'});}finally{await database.db.query(definition);}
   assert.equal((await preflight()).status,'passed');
  });
  await t.test('native independent LOGIN executes the restricted handler path',{skip:!database.native},async()=>{
   assert(login);assert.deepEqual((await login.query('SELECT current_user,session_user')).rows[0],{current_user:role,session_user:role});const result=await preflight();assert('independentLogin' in result);assert.equal(result.independentLogin,true);
  });
 }finally{
  if(originalKeyring===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=originalKeyring;
  await login?.end();try{if(createdRole){await database.db.query('DROP OWNED BY '+role);await database.db.query('DROP ROLE '+role);}}finally{if(lock){await lock.query('SELECT pg_advisory_unlock(739284034)');lock.release();}await database.close();}
 }
});
