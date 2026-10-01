import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {Pool} from 'pg';
import {database,query,transaction} from '../src/lib/db';
import {createHiggsfieldRemoteMediaController,type RemoteMediaControllerPolicy} from '../src/lib/higgsfield-remote-media-controller';
import {createHiggsfieldArchiveWorker,type ArchiveInspectionContext} from '../src/lib/higgsfield-archive-worker';
import {proposeHiggsfieldArchive,approveHiggsfieldArchive,revokeHiggsfieldArchive} from '../src/lib/higgsfield-archives';
import {recordHiggsfieldSubmission} from '../src/lib/higgsfield-jobs';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {bindProjectStorage,createProjectStorageConnection} from '../src/lib/project-storage';
import {VERCEL_MEDIA_IMAGE,type VercelMediaIntent,type VercelMediaJournalEvent} from '../src/lib/higgsfield-vercel-media-sandbox';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
const code=(value:string)=>({code:value});

for(const postgres of [false,true])test(`${postgres?'PostgreSQL':'PGlite'} remote media controller durably fences launch authority and recovery`,{skip:postgres&&!localPostgres,timeout:180000},async t=>{
 const before={url:process.env.DATABASE_URL,pool:(globalThis as any).coatriaPool,poolMax:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,enabled:process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED,fetch:globalThis.fetch};
 const dbName='coatria_remote_media_'+randomUUID().replaceAll('-','');let worker:Worker|undefined,control:Pool|undefined,app:Pool|undefined,created=false,network=0;
 const scratch=await mkdtemp(join(tmpdir(),'coatria-remote-media-'));
 try{
  if(postgres){control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;process.env.DATABASE_URL=url.href;app=new Pool({connectionString:url.href,max:5});(globalThis as any).coatriaPool=app;for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await app.query(await readFile('database/'+file,'utf8'));}
  else{
   worker=new Worker(`const {parentPort}=require('node:worker_threads');(async()=>{const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),{readdir,readFile}=require('node:fs/promises'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\\d.*\\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();parentPort.postMessage({url:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres'});parentPort.once('message',async()=>{await socket.stop();await db.close();parentPort.postMessage({stopped:true});parentPort.close();});})().catch(error=>{throw error;});`,{eval:true,execArgv:[]});
   process.env.DATABASE_URL=await new Promise<string>((yes,no)=>{worker!.once('error',no);worker!.once('message',value=>yes(value.url));});process.env.DATABASE_POOL_MAX='1';delete(globalThis as any).coatriaPool;app=database();
  }
  process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,17).toString('base64')}});
  globalThis.fetch=async()=>{network++;throw Error('Remote media controller tests must never contact a provider');};
  const userId=randomUUID();await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic media owner',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  async function fixture(){
   const companyId=randomUUID(),projectId=randomUUID(),providerId=randomUUID(),requestId=randomUUID(),taskId=randomUUID(),workId=randomUUID(),providerJobId=randomUUID(),body=Buffer.from('synthetic-original-media'),actor={companyId,userId};
   await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Remote controller test',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
   const gates=Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved',recordedBy:userId}]));
   await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Synthetic archive','Internal','Synthetic test',$3,'allowed','production',$4,$5,'higgsfield')",[projectId,companyId,JSON.stringify({width:32,height:32,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),JSON.stringify(gates),userId]);
   await query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Generation',$3)",[taskId,companyId,userId]);await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[workId,companyId,projectId,taskId]);await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[companyId,userId]);
   await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[companyId,providerId,userId,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-not-used'}},{companyId,id:providerId,purpose:'oauth-connection'}))]);
   const request=(await query("INSERT INTO higgsfield_requests(id,company_id,project_id,requested_by,client_id,project_revision,connection_id,connection_revision,tool,arguments,note,request_hash,status,approved_by,dispatched_at,work_item_id,task_revision,role_human_id) VALUES($1,$2,$3,$4,$5,1,$6,1,'generate_image',$7,'Synthetic receipt',$8,'returned',$4,clock_timestamp(),$9,1,$4) RETURNING *",[requestId,companyId,projectId,userId,randomUUID(),providerId,JSON.stringify({prompt:'Synthetic original'}),sha(requestId),workId])).rows[0];
   await transaction(db=>recordHiggsfieldSubmission(db,request,{structuredContent:{results:[{id:providerJobId,type:'image',status:'completed',model:'synthetic-model',params:{prompt:'Synthetic original'},results:{rawUrl:'https://reviewed.example/'+randomUUID()+'.png?signature=synthetic-private'}}]}}));
   const output=(await query('SELECT * FROM higgsfield_job_outputs WHERE company_id=$1',[companyId])).rows[0];
   const connection=(await transaction(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic volume',region:'US-NC-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_fixture-only'}))).connection;
   const binding=(await transaction(db=>bindProjectStorage(db,actor,projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
   async function archive(){
    const proposal=(await transaction(db=>proposeHiggsfieldArchive(db,actor,{clientId:randomUUID(),projectId,projectRevision:1,jobId:output.job_id,outputId:output.id,outputIdentity:output.locator_identity,bindingId:binding.id,bindingRevision:binding.revision,name:'original-'+randomUUID(),maxBytes:4096}))).archive;
    await transaction(db=>approveHiggsfieldArchive(db,actor,proposal.id,{clientId:randomUUID(),revision:proposal.revision,requestHash:proposal.requestHash,projectRevision:1,bindingRevision:binding.revision,expiresInHours:1,archiveConsent:true}));
    const leaseId=randomUUID();await query("UPDATE higgsfield_output_archives SET status='fetching',lease_id=$2,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[proposal.id,leaseId]);
    const context:ArchiveInspectionContext={companyId,projectId,archiveId:proposal.id,leaseId,locatorIdentity:output.locator_identity,requestHash:proposal.requestHash,expectedBytes:body.length,expectedSha256:sha(body),expectedKind:'image'};
    return context;
   }
   const context=await archive();
   const policy:RemoteMediaControllerPolicy={pilotId:randomUUID(),companyId,projectIds:[projectId],sourceCommit:'a'.repeat(40),expiresAt:new Date(Date.now()+3600000).toISOString(),maxLaunches:3,binding:{teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:'b'.repeat(64),limits:{maxInputBytes:128*1024**2,maxClosureBytes:128*1024**2,timeoutMs:120000,maxOutputBytes:1024**2,maxStderrBytes:65536}}};
   const intent=(ctx=context):VercelMediaIntent=>{const id=randomUUID();return {id,name:'coatria-media-'+id,teamId:policy.binding.teamId,projectId:policy.binding.projectId,region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:policy.binding.closureSha256,inputSha256:ctx.expectedSha256,inputBytes:ctx.expectedBytes,tool:'ffprobe',ttlMs:120000,vcpus:2,memoryMiB:4096};};
   const revoke=async(ctx=context)=>{const row=(await query('SELECT revision FROM higgsfield_output_archives WHERE id=$1',[ctx.archiveId])).rows[0];await transaction(db=>revokeHiggsfieldArchive(db,actor,ctx.archiveId,{clientId:randomUUID(),revision:row.revision,note:'Synthetic revoke'}));};
   return {context,policy,intent,revoke,archive,body};
  }
  const event=(intent:VercelMediaIntent,type:VercelMediaJournalEvent['type'],extra:Partial<VercelMediaJournalEvent>={}):VercelMediaJournalEvent=>({type,intentId:intent.id,name:intent.name,...extra});
  const finish=async(journal:ReturnType<ReturnType<typeof createHiggsfieldRemoteMediaController>['forArchive']>,intent:VercelMediaIntent)=>{await journal.record(event(intent,'created',{sessionId:'sbx_synthetic'}));await journal.record(event(intent,'cleanup-intent',{sessionId:'sbx_synthetic'}));await journal.record(event(intent,'terminal',{sessionId:'sbx_synthetic',status:'stopped'}));};

  await t.test('one durable reservation, exact event replay, distinct cleanup identity and no refund/recreate',async()=>{
   const f=await fixture(),policy={...f.policy,maxLaunches:1,binding:{...f.policy.binding,limits:{...f.policy.binding.limits,maxClosureBytes:256*1024**2}}},controller=createHiggsfieldRemoteMediaController(policy),journal=controller.forArchive(f.context),intent=f.intent();
   assert.throws(()=>createHiggsfieldRemoteMediaController({...policy,binding:{...policy.binding,limits:{...policy.binding.limits,maxClosureBytes:256*1024**2+1}}}),code('REMOTE_MEDIA_POLICY_INVALID'));
   assert.deepEqual(await controller.assertAdmission(),{reserved:0,remaining:1});await assert.rejects(controller.assertAdmission(3),code('REMOTE_MEDIA_BUDGET_EXHAUSTED'));
   await journal.reserve(intent);await journal.authorize(intent);await assert.rejects(journal.reserve(intent),code('REMOTE_MEDIA_ALREADY_RESERVED'));
   await assert.rejects(controller.assertAdmission(),code('REMOTE_MEDIA_RECOVERY_REQUIRED'));
   await finish(journal,intent);await finish(journal,intent);await journal.authorize(intent);
   const rows=(await query("SELECT action_id,operation,phase FROM higgsfield_archive_receipts WHERE company_id=$1 AND operation LIKE 'remote-media.%'",[f.context.companyId])).rows;assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.action_id)).size,4);assert.equal(rows.filter(r=>r.phase==='intent').length,2);
   assert.deepEqual(await controller.scanRecovery(),[]);await assert.rejects(journal.reserve(f.intent()),code('REMOTE_MEDIA_BUDGET_EXHAUSTED'));await assert.rejects(controller.assertAdmission(),code('REMOTE_MEDIA_BUDGET_EXHAUSTED'));
  });
  await t.test('ambiguous creation blocks restart until ownership-bound cleanup, even after revocation',async()=>{
   const f=await fixture(),controller=createHiggsfieldRemoteMediaController(f.policy),journal=controller.forArchive(f.context),intent=f.intent();await journal.reserve(intent);await journal.record(event(intent,'create-unknown'));await journal.record(event(intent,'cleanup-unknown'));
   const restarted=createHiggsfieldRemoteMediaController(f.policy),recovery=await restarted.scanRecovery();assert.equal(recovery.length,1);assert.deepEqual(recovery[0].context,f.context);assert.deepEqual(recovery[0].intent,intent);assert.equal(recovery[0].events.length,2);assert(!JSON.stringify(recovery).includes('signature='));
   await assert.rejects(restarted.forArchive(f.context).reserve(f.intent()),code('REMOTE_MEDIA_RECOVERY_REQUIRED'));await f.revoke();await assert.rejects(journal.authorize(intent),code('REMOTE_MEDIA_AUTHORITY_ENDED'));
   await journal.record(event(intent,'cleanup-intent',{sessionId:'sbx_recovered'}));await journal.record(event(intent,'terminal',{sessionId:'sbx_recovered',status:'stopped'}));assert.deepEqual(await restarted.scanRecovery(),[]);
   await assert.rejects(journal.reserve(f.intent()),code('REMOTE_MEDIA_AUTHORITY_ENDED'));
  });
  await t.test('full binding, immutable context, tenant/lease and conflicting event replay fail closed',async()=>{
   const f=await fixture(),controller=createHiggsfieldRemoteMediaController(f.policy),journal=controller.forArchive(f.context),intent=f.intent();
   assert.throws(()=>controller.forArchive({...f.context,companyId:randomUUID()}),code('REMOTE_MEDIA_BINDING_CHANGED'));assert.throws(()=>controller.forArchive({...f.context,projectId:randomUUID()}),code('REMOTE_MEDIA_BINDING_CHANGED'));
   for(const patch of [{inputSha256:'f'.repeat(64)},{inputBytes:f.context.expectedBytes+1},{closureSha256:'e'.repeat(64)},{projectId:'prj_other'},{ttlMs:119000}])await assert.rejects(journal.reserve({...intent,...patch}),code('REMOTE_MEDIA_BINDING_CHANGED'));
   await assert.rejects(controller.forArchive({...f.context,requestHash:'e'.repeat(64)}).reserve(intent),code('REMOTE_MEDIA_BINDING_CHANGED'));
   await journal.reserve(intent);await journal.record(event(intent,'created',{sessionId:'sbx_owned'}));await assert.rejects(journal.record(event(intent,'created',{sessionId:'sbx_foreign'})),code('REMOTE_MEDIA_EVENT_CONFLICT'));await assert.rejects(journal.record(event(intent,'terminal',{sessionId:'sbx_foreign',status:'stopped'})),code('REMOTE_MEDIA_EVENT_CONFLICT'));
   await assert.rejects(controller.forArchive({...f.context,leaseId:randomUUID()}).authorize(intent),code('REMOTE_MEDIA_BINDING_CHANGED'));
   await query("UPDATE higgsfield_output_archives SET lease_id=$2 WHERE id=$1",[f.context.archiveId,randomUUID()]);await assert.rejects(journal.authorize(intent),code('REMOTE_MEDIA_AUTHORITY_ENDED'));await journal.record(event(intent,'terminal',{sessionId:'sbx_owned',status:'stopped'}));
  });
  await t.test('configuration drift never resets history and first source hash survives a new pilot',async()=>{
   const f=await fixture(),controller=createHiggsfieldRemoteMediaController(f.policy),journal=controller.forArchive(f.context),intent=f.intent();await journal.reserve(intent);await finish(journal,intent);
   await assert.rejects(createHiggsfieldRemoteMediaController({...f.policy,maxLaunches:4}).scanRecovery(),code('REMOTE_MEDIA_BINDING_CHANGED'));await assert.rejects(createHiggsfieldRemoteMediaController({...f.policy,sourceCommit:'c'.repeat(40)}).scanRecovery(),code('REMOTE_MEDIA_BINDING_CHANGED'));
   const changed={...f.context,expectedSha256:'d'.repeat(64)},renewed=createHiggsfieldRemoteMediaController({...f.policy,pilotId:randomUUID()});await assert.rejects(renewed.forArchive(changed).reserve(f.intent(changed)),code('REMOTE_MEDIA_BINDING_CHANGED'));
  });
  await t.test('renewed policy sees old unknown guests and cannot clear them; cleanup retains old policy and budgets remain per pilot',async()=>{
   const f=await fixture(),oldPolicy={...f.policy,maxLaunches:1},old=createHiggsfieldRemoteMediaController(oldPolicy),journal=old.forArchive(f.context),intent=f.intent();await journal.reserve(intent);await journal.record(event(intent,'create-unknown'));await journal.record(event(intent,'cleanup-unknown'));
   const nextContext=await f.archive(),nextPolicy={...oldPolicy,pilotId:randomUUID(),sourceCommit:'c'.repeat(40),binding:{...oldPolicy.binding,closureSha256:'d'.repeat(64)}},next=createHiggsfieldRemoteMediaController(nextPolicy),nextIntent={...f.intent(nextContext),closureSha256:nextPolicy.binding.closureSha256};
   const recovered=await next.scanRecovery();assert.equal(recovered.length,1);assert.deepEqual(recovered[0].policy,oldPolicy);assert.deepEqual(recovered[0].intent,intent);assert.ok(Object.isFrozen(recovered[0].policy));
   const otherProject=createHiggsfieldRemoteMediaController({...nextPolicy,pilotId:randomUUID(),projectIds:[randomUUID()]});assert.equal((await otherProject.scanRecovery())[0].intent.id,intent.id);
   await assert.rejects(next.assertAdmission(),code('REMOTE_MEDIA_RECOVERY_REQUIRED'));await assert.rejects(next.forArchive(nextContext).reserve(nextIntent),code('REMOTE_MEDIA_RECOVERY_REQUIRED'));
   const sameBindingNewPilot=createHiggsfieldRemoteMediaController({...oldPolicy,pilotId:randomUUID()}).forArchive(f.context);await assert.rejects(sameBindingNewPilot.authorize(intent),code('REMOTE_MEDIA_BINDING_CHANGED'));await assert.rejects(sameBindingNewPilot.record(event(intent,'terminal',{sessionId:'sbx_recovered',status:'stopped'})),code('REMOTE_MEDIA_BINDING_CHANGED'));
   await f.revoke();const cleanup=createHiggsfieldRemoteMediaController(recovered[0].policy).forArchive(recovered[0].context);await cleanup.record(event(intent,'cleanup-intent',{sessionId:'sbx_recovered'}));await cleanup.record(event(intent,'terminal',{sessionId:'sbx_recovered',status:'stopped'}));
   assert.deepEqual(await next.scanRecovery(),[]);assert.deepEqual(await next.assertAdmission(),{reserved:0,remaining:1});await next.forArchive(nextContext).reserve(nextIntent);await finish(next.forArchive(nextContext),nextIntent);
   await assert.rejects(next.assertAdmission(),code('REMOTE_MEDIA_BUDGET_EXHAUSTED'));await assert.rejects(old.assertAdmission(),code('REMOTE_MEDIA_BUDGET_EXHAUSTED'));
  });
  await t.test('cross-pilot receipts are validated against their recorded policy and event hash',async()=>{
   const f=await fixture(),old=createHiggsfieldRemoteMediaController(f.policy),journal=old.forArchive(f.context),intent=f.intent();await journal.reserve(intent);await journal.record(event(intent,'create-unknown'));
   const next=createHiggsfieldRemoteMediaController({...f.policy,pilotId:randomUUID(),sourceCommit:'c'.repeat(40)}),row=(await query("SELECT id,detail FROM higgsfield_archive_receipts WHERE company_id=$1 AND operation='remote-media.reserve'",[f.context.companyId])).rows[0];
   await query('UPDATE higgsfield_archive_receipts SET detail=$2 WHERE id=$1',[row.id,JSON.stringify({...row.detail,policyHash:'e'.repeat(64)})]);await assert.rejects(next.scanRecovery(),code('REMOTE_MEDIA_BINDING_CHANGED'));await assert.rejects(next.assertAdmission(),code('REMOTE_MEDIA_BINDING_CHANGED'));
   await query('UPDATE higgsfield_archive_receipts SET detail=$2 WHERE id=$1',[row.id,JSON.stringify(row.detail)]);
   const eventRow=(await query("SELECT id,detail FROM higgsfield_archive_receipts WHERE company_id=$1 AND operation='remote-media.create-unknown'",[f.context.companyId])).rows[0];await query('UPDATE higgsfield_archive_receipts SET detail=$2 WHERE id=$1',[eventRow.id,JSON.stringify({...eventRow.detail,policyHash:'e'.repeat(64)})]);await assert.rejects(next.scanRecovery(),code('REMOTE_MEDIA_EVENT_CONFLICT'));
  });
  await t.test('database clock enforces expiry and reserves the entire VM TTL; expired cleanup remains possible',async()=>{
   const f=await fixture(),short=createHiggsfieldRemoteMediaController({...f.policy,expiresAt:new Date(Date.now()+30000).toISOString()});await assert.rejects(short.forArchive(f.context).reserve(f.intent()),code('REMOTE_MEDIA_PILOT_EXPIRED'));
   const expired=createHiggsfieldRemoteMediaController({...f.policy,expiresAt:new Date(Date.now()-1000).toISOString()}),originalNow=Date.now;
   try{Date.now=()=>0;await assert.rejects(expired.forArchive(f.context).reserve(f.intent()),code('REMOTE_MEDIA_PILOT_EXPIRED'));}finally{Date.now=originalNow;}
   const controller=createHiggsfieldRemoteMediaController(f.policy),journal=controller.forArchive(f.context),intent=f.intent();await journal.reserve(intent);await query("UPDATE higgsfield_output_archives SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.context.archiveId]);await assert.rejects(journal.authorize(intent),code('REMOTE_MEDIA_AUTHORITY_ENDED'));await finish(journal,intent);assert.deepEqual(await controller.scanRecovery(),[]);
   const g=await fixture(),soon={...g.policy,expiresAt:new Date(Date.now()+4000).toISOString(),binding:{...g.policy.binding,limits:{...g.policy.binding.limits,timeoutMs:1000}}},expires=createHiggsfieldRemoteMediaController(soon),later=expires.forArchive(g.context),launch={...g.intent(),ttlMs:1000};await later.reserve(launch);await new Promise(resolve=>setTimeout(resolve,4200));await assert.rejects(later.authorize(launch),code('REMOTE_MEDIA_PILOT_EXPIRED'));await finish(later,launch);assert.deepEqual(await expires.scanRecovery(),[]);
  });
  await t.test('scoped worker ignores foreign queues and supplies exact per-lease inspection context',async()=>{
   const foreign=await fixture(),own=await fixture();for(const f of [foreign,own])await query("UPDATE higgsfield_output_archives SET status='queued',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[f.context.archiveId]);
   let captured:ArchiveInspectionContext|undefined;
   const base={scratchRoot:scratch,fetchOutput:async(input:Parameters<Parameters<typeof createHiggsfieldArchiveWorker>[0]['fetchOutput']>[0])=>{await input.consume(own.body,input.signal!);return {bytes:own.body.length,sha256:sha(own.body)};},inspectMedia:async(_input:unknown,context:ArchiveInspectionContext)=>{captured=context;throw Error('Stop before storage; context test only');}};
   assert.throws(()=>createHiggsfieldArchiveWorker({...base,scope:{companyId:own.context.companyId,projectIds:[]}}),code('HIGGSFIELD_ARCHIVE_POLICY_INVALID'));
   assert.deepEqual(await createHiggsfieldArchiveWorker({...base,scope:{companyId:own.context.companyId,projectIds:[randomUUID()]}}).runNext(),{processed:false});
   const result=await createHiggsfieldArchiveWorker({...base,scope:{companyId:own.context.companyId,projectIds:[own.context.projectId]}}).runNext();assert.equal(result.archiveId,own.context.archiveId);assert(captured);assert.equal(captured.archiveId,own.context.archiveId);assert.notEqual(captured.leaseId,own.context.leaseId);assert.equal(captured.expectedSha256,sha(own.body));assert.equal(captured.locatorIdentity,own.context.locatorIdentity);assert.equal(captured.requestHash,own.context.requestHash);assert(Object.isFrozen(captured));
   const unchanged=(await query('SELECT status,attempt_count,lease_id FROM higgsfield_output_archives WHERE id=$1',[foreign.context.archiveId])).rows[0];assert.deepEqual(unchanged,{status:'queued',attempt_count:0,lease_id:null});
  });
  await t.test('real concurrent last-slot reservation and authority withdrawal while waiting for admission',{skip:!postgres},async()=>{
   const f=await fixture(),second=await f.archive(),policy={...f.policy,maxLaunches:1},controller=createHiggsfieldRemoteMediaController(policy),blocker=await app!.connect(),key=`remote-media-company:${policy.companyId}`;
   let settled:Promise<PromiseSettledResult<void>[]>;
   try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
    let done=0;const one=controller.forArchive(f.context).reserve(f.intent()).finally(()=>{done++;}),two=controller.forArchive(second).reserve(f.intent(second)).finally(()=>{done++;});settled=Promise.allSettled([one,two]);
    await new Promise(resolve=>setTimeout(resolve,75));assert.equal(done,0);await blocker.query('COMMIT');
   }finally{await blocker.query('ROLLBACK');blocker.release();}
   const results=await settled!;assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await controller.scanRecovery()).length,1);assert.equal((await query("SELECT count(*)::int n FROM higgsfield_archive_receipts WHERE company_id=$1 AND operation='remote-media.reserve'",[f.context.companyId])).rows[0].n,1);
   const g=await fixture(),other=createHiggsfieldRemoteMediaController(g.policy),gate=await app!.connect();await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`remote-media-company:${g.policy.companyId}`]);
   let waiting:Promise<void>;try{waiting=assert.rejects(other.forArchive(g.context).reserve(g.intent()),code('REMOTE_MEDIA_AUTHORITY_ENDED'));await g.revoke();await gate.query('COMMIT');}finally{await gate.query('ROLLBACK');gate.release();}await waiting!;assert.deepEqual(await other.scanRecovery(),[]);
  });
  await t.test('real concurrent reservations under different pilot IDs share one company recovery fence',{skip:!postgres},async()=>{
   const f=await fixture(),otherContext=await f.archive(),first=createHiggsfieldRemoteMediaController(f.policy),second=createHiggsfieldRemoteMediaController({...f.policy,pilotId:randomUUID()}),gate=await app!.connect();let settled:Promise<PromiseSettledResult<void>[]>;
   try{await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`remote-media-company:${f.policy.companyId}`]);let done=0;
    const one=first.forArchive(f.context).reserve(f.intent()).finally(()=>{done++;}),two=second.forArchive(otherContext).reserve(f.intent(otherContext)).finally(()=>{done++;});settled=Promise.allSettled([one,two]);await new Promise(resolve=>setTimeout(resolve,75));assert.equal(done,0);await gate.query('COMMIT');
   }finally{await gate.query('ROLLBACK');gate.release();}
   const result=await settled!;assert.equal(result.filter(item=>item.status==='fulfilled').length,1);const rejected=result.find(item=>item.status==='rejected');assert.equal(rejected?.status==='rejected'&&rejected.reason.code,'REMOTE_MEDIA_RECOVERY_REQUIRED');
   const a=await first.scanRecovery(),b=await second.scanRecovery();assert.equal(a.length,1);assert.deepEqual(a,b);assert.equal((await query("SELECT count(*)::int n FROM higgsfield_archive_receipts WHERE company_id=$1 AND operation='remote-media.reserve'",[f.context.companyId])).rows[0].n,1);
  });
  assert.equal(network,0);
 }finally{
  globalThis.fetch=before.fetch;await app?.end();(globalThis as any).coatriaPool=before.pool;
  if(worker){try{await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('Fixture shutdown timeout')),5000);worker!.once('message',()=>{clearTimeout(timer);yes();});worker!.postMessage('stop');});}finally{await worker.terminate();}}
  if(created)await dropFixtureDatabase(control!,dbName);await control?.end();await rm(scratch,{recursive:true,force:true});
  for(const [key,value]of Object.entries({DATABASE_URL:before.url,DATABASE_POOL_MAX:before.poolMax,COATRIA_HOSTING_KEYRING:before.key,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:before.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
