import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import * as refs from '../src/lib/higgsfield-references';
import {higgsfieldReferenceRoute} from '../src/lib/higgsfield-reference-api';
import {higgsfieldRoute,proposeHiggsfieldRequest,higgsfieldAgentConnection} from '../src/lib/higgsfield';
import {observedImageModel,observedImageModelPage,observedImageTool} from './fixtures/higgsfield-model-contract';
import {studioRoute} from '../src/lib/studio';
import {workRoute} from '../src/lib/work';
import {claimAgentRun,finishAgentRun} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';
import {HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES} from '../src/lib/higgsfield-references-protocol';
import {higgsfieldReferenceApproveInput,type HiggsfieldReferenceActor,type HiggsfieldReferenceLease} from '../src/lib/higgsfield-references-protocol';

test('prepared reference authority, finite consent, durable phases and generation provenance',{timeout:120000},async t=>{
 const previous={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch,savedPool:(globalThis as any).coatriaPool};
 const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();
 for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));
 const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
 delete(globalThis as any).coatriaPool;process.env.DATABASE_URL='postgresql://postgres:postgres@'+server.getServerConn()+'/postgres';process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});
 let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Reference control tests prohibit network');};
 async function fixture(stage='generation',tools:unknown[]=[],contractVersion=1,roleKey='comp',execution='creative'){
  const company=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),project=randomUUID(),shot=randomUUID(),task=randomUUID(),work=randomUUID(),providerId=randomUUID(),sessions={owner:randomUUID(),admin:randomUUID(),member:randomUUID()};
  for(const user of[owner,admin,member])await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Reference fixture',$2,'not-a-login')",[user,user+'@example.invalid']);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Reference fixture',$2,'blank')",[company,company]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member')",[company,owner,admin,member]);
  for(const[name,user]of Object.entries({owner,admin,member}))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),user]);
  await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[company,owner]);
  const gates=Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:admin}]));
  await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Prepared reference','Internal','Synthetic approved reference',$5,'allowed','production',$3,$4,'higgsfield',$6)",[project,company,JSON.stringify(gates),owner,JSON.stringify(contractVersion===2?{kind:'image',format:'png',width:100,height:100,color:{mode:'not_required'}}:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'sRGB'}),contractVersion]);
  await query("INSERT INTO studio_shots(id,company_id,project_id,code,description,frame_start,frame_end,handles,disciplines,media_kind) VALUES($1,$2,$3,'REFERENCE01','Exact approved deliverable',$4,$4,$4,'[]',$5)",[shot,company,project,contractVersion===2?null:0,contractVersion===2?'image':'legacy_frames']);
  await query("INSERT INTO tasks(id,company_id,title,description,created_by,assignee_id) VALUES($1,$2,'Exact prepared reference','Preserve the approved content and role',$3,$3)",[task,company,owner]);
  await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution,shot_id) VALUES($1,$2,$3,'reference-fixture',$4,$5,$6,$8,$7)",[work,company,project,task,stage,roleKey,shot,execution]);
  await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,$2,$3)",[company,roleKey,owner]);
  await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour',$5)",[company,providerId,owner,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId:company,id:providerId,purpose:'oauth-connection'})),JSON.stringify(tools)]);
  const actor={companyId:company,userId:owner},adminActor={companyId:company,userId:admin},memberActor={companyId:company,userId:member};
  const connection=(await transaction(c=>createProjectStorageConnection(c,actor,{clientId:randomUUID(),name:'Private prepared images',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_syntheticaccess',secretAccessKey:'rps_syntheticsecret'}))).connection;
  const binding=(await transaction(c=>bindProjectStorage(c,actor,project,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  async function stored({bytes=100,contentType='image/png',verified=true,name='proxy-'+randomUUID()+'.png'}={}){
   const file=randomUUID(),version=randomUUID(),sha=hashToken(version);
   await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)',[file,company,project,binding.id,name,owner]);
   await query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)',[version,company,project,file,bytes,sha,contentType,`coatria/companies/${company}/projects/${project}/objects/${version}`,owner]);
   if(verified)await query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'private-etag',$6)",[company,project,version,bytes,sha,randomUUID()]);
   return {file,version,bytes,sha,contentType};
  }
  const proxy=await stored(),source=await stored({bytes:50*1024*1024,contentType:'application/octet-stream',name:'heavy-original.exr'});
  const options:refs.HiggsfieldReferenceOptions={availability:async()=>({enabled:true,code:'SYNTHETIC_QUALIFIED',message:'Offline injected fixture only',expiresAt:new Date(Date.now()+3600000).toISOString(),qualificationSha256:'a'.repeat(64),catalogSha256:refs.higgsfieldReferenceDigest(tools)})};
  const input=(patch:Record<string,unknown>={})=>({clientId:randomUUID(),projectId:project,projectRevision:1,workItemId:work,proxyVersionId:proxy.version,proxyBytes:proxy.bytes,proxySha256:proxy.sha,sourceVersionId:source.version,role:'image',purpose:'Exact bounded prepared reference',...patch});
  const propose=(data=input(),who:HiggsfieldReferenceActor=actor)=>transaction(c=>refs.proposeHiggsfieldReference(c,who,data));
  const claim=()=>transaction(c=>refs.claimHiggsfieldReference(c,{companyId:company,projectIds:[project]},options));
  const descriptor={kind:'image',format:'png',contentType:'image/png',bytes:proxy.bytes,sha256:proxy.sha,verification:'full_decode',inspectionVersion:1,width:100,height:100,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};
  const inspect=async()=>{const proposal=await propose(),lease=(await claim())!;assert(lease);return (await transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor,profileSha256:'b'.repeat(64)},options))).reference;};
  const approval=(r:any,patch:Record<string,unknown>={})=>({clientId:randomUUID(),revision:r.revision,requestHash:r.requestHash,inspectionHash:r.inspection?.inspectionHash??'0'.repeat(64),expiresInMinutes:30,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true,...patch});
  const approve=(r:any,data=approval(r),who:HiggsfieldReferenceActor=adminActor)=>transaction(c=>refs.approveHiggsfieldReference(c,who,r.id,data,options));
  const transfer=async()=>{const r=await inspect();await approve(r);return (await claim())!;};
  const begin=(lease:HiggsfieldReferenceLease,phase:'allocate'|'put'|'confirm')=>transaction(c=>refs.beginHiggsfieldReferencePhase(c,lease,phase,options));
  const complete=(lease:HiggsfieldReferenceLease,actionId:string,result:any)=>transaction(c=>refs.completeHiggsfieldReferencePhase(c,lease,actionId,result,options));
  async function confirm(){const lease=await transfer(),mediaId=randomUUID(),allocation={mediaId,uploadUrl:'https://private.example/upload?opaque=synthetic',expiresAt:new Date(Date.now()+600000).toISOString()};let a=await begin(lease,'allocate');await complete(lease,a.actionId,{phase:'allocate',allocation});a=await begin(lease,'put');await complete(lease,a.actionId,{phase:'put',httpStatus:200,bytes:proxy.bytes,sha256:proxy.sha});a=await begin(lease,'confirm');const r=await complete(lease,a.actionId,{phase:'confirm',mediaId,confirmed:true});return {lease,mediaId,reference:r.reference,allocation};}
  async function agent(){const agentId=randomUUID(),runId=randomUUID(),conversation=randomUUID(),caps=['creative.read','creative.write','studio.read','studio.write','tasks.write','storage.read'];await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Reference agent','custom',$3,$4,'admins',$5)",[agentId,company,hashToken(randomUUID()),owner,JSON.stringify(caps)]);await query('INSERT INTO conversations(id,company_id) VALUES($1,$2)',[conversation,company]);await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic reference task',$8,'running','fixture',$9,clock_timestamp()+interval '1 hour')",[runId,company,agentId,owner,conversation,randomUUID(),'1'.repeat(64),JSON.stringify(caps),'2'.repeat(64)]);await query("INSERT INTO studio_role_bindings(company_id,role_key,agent_id) VALUES($1,'comp',$2) ON CONFLICT(company_id,role_key) DO UPDATE SET agent_id=EXCLUDED.agent_id,human_id=NULL",[company,agentId]);await query("UPDATE tasks SET status='doing',agent_run_id=$2 WHERE id=$1",[task,runId]);return {...actor,agentId,runId};}
  return {company,owner,admin,member,project,shot,task,work,providerId,actor,adminActor,memberActor,sessions,connection,binding,proxy,source,options,input,propose,claim,descriptor,inspect,approval,approve,transfer,begin,complete,confirm,agent,stored};
 }
 async function prepared(){
  const f=await fixture('references',[],2,'ingest','agent'),agentId=randomUUID(),tokenHash=hashToken(randomUUID());
  await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Prepared image specialist','custom',$3,$4,'admins',$5)",[agentId,f.company,tokenHash,f.owner,JSON.stringify(HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES)]);
  await query("UPDATE studio_role_bindings SET agent_id=$2,human_id=NULL WHERE company_id=$1 AND role_key='ingest'",[f.company,agentId]);await query("UPDATE tasks SET assignee_id=NULL WHERE id=$1",[f.task]);
  const parts=['companies',f.company,'studio','projects',f.project,'dispatch'],dispatch=await studioRoute(new Request('https://coatria.com/api/'+parts.join('/'),{method:'POST',headers:{Origin:'https://coatria.com',Cookie:'coatria_session='+f.sessions.owner,'Content-Type':'application/json'},body:JSON.stringify({clientId:randomUUID(),revision:1,workItemId:f.work,preparationProfile:'prepared_image_v1'})}),parts,'POST');
  const dispatched=await dispatch!.json(),identity={id:agentId,company_id:f.company,created_by:f.owner,token_hash:tokenHash},claimed=await claimAgentRun(identity,{workerId:'reference-fixture',claimId:randomUUID()});assert.equal(claimed.run!.id,dispatched.run.id);assert.equal(claimed.run!.maxAttempts,1);
  const runId=claimed.run!.id,leaseToken=claimed.leaseToken!,actor={...f.actor,agentId,runId};
  const tool=async(name:string,args:unknown,requestId=randomUUID())=>(await executeAgentTool(identity,name,{runId,leaseToken,requestId,arguments:args})).result;
  const claimedTask:any=await tool('tasks_claim',{taskId:f.task,revision:1});assert.equal(claimedTask.revision,2);
  const propose=async()=>{const {clientId:_,...args}=f.input({projectRevision:dispatched.project.revision});return await tool('higgsfield_reference_propose',args) as any;};
  const submit=()=>tool('tasks_submit',{taskId:f.task,revision:2,summary:'Prepared reference proposal recorded. Image inspection and external sharing remain pending; no bytes were disclosed.'});
  const finish=()=>finishAgentRun(identity,runId,'complete',{clientId:randomUUID(),leaseToken,result:'Exact prepared reference proposed; inspection and independent review remain pending.'});
  const accept=async()=>{const parts=['companies',f.company,'tasks',f.task];return workRoute(new Request('https://coatria.com/api/'+parts.join('/'),{method:'PATCH',headers:{Origin:'https://coatria.com',Cookie:'coatria_session='+f.sessions.admin,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:3,status:'done',reviewNote:'Accept the factual plan only; no image QC or sharing approval.'})}),parts,'PATCH');};
  return {...f,identity,actor,agentId,runId,leaseToken,tool,propose,submit,finish,accept};
 }
 try{
  await t.test('exact verified proxy and separate heavy source, scoped history, replay and no private projection',async()=>{
   const f=await fixture(),input=f.input(),r=await f.propose(input);assert.equal(r.reference.status,'proposed');assert.equal(r.reference.proxy.bytes,100);assert.equal(r.reference.source.bytes,50*1024*1024);assert.equal(r.reference.originalUploaded,false);assert.equal(r.reference.metadataRemoved,false);assert.equal((await f.propose(input)).replayed,true);await assert.rejects(f.propose({...input,purpose:'different'}),{code:'IDEMPOTENCY_CONFLICT'});
   for(const key of['objectKey','providerEtag','sealed','leaseId','mediaId','uploadUrl','synthetic-only'])assert(!JSON.stringify(r).includes(key));
   const other=await fixture();await assert.rejects(f.propose(f.input({proxyVersionId:other.proxy.version})));await assert.rejects(transaction(c=>refs.getHiggsfieldReference(c,other.actor,r.reference.id)));
   const unverified=await f.stored({verified:false});await assert.rejects(f.propose(f.input({proxyVersionId:unverified.version,proxySha256:unverified.sha})));
   await assert.rejects(f.propose(f.input({proxySha256:'0'.repeat(64)})),{code:'HIGGSFIELD_REFERENCE_SOURCE_CHANGED'});await assert.rejects(f.propose(f.input({sourceVersionId:f.proxy.version})),{code:'VALIDATION_ERROR'});
   for(const spec of[{contentType:'video/mp4'},{bytes:11*1024*1024}]){const wrong=await f.stored(spec);await assert.rejects(f.propose(f.input({proxyVersionId:wrong.version,proxyBytes:Math.min(wrong.bytes,10485760),proxySha256:wrong.sha})));}
   const candidates=await transaction(c=>refs.listHiggsfieldReferenceCandidates(c,f.actor,{projectId:f.project,limit:1}));assert.equal(candidates.versions.length,1);assert(candidates.nextAfter);await assert.rejects(transaction(c=>refs.listHiggsfieldReferenceCandidates(c,f.actor,{projectId:f.project,after:other.proxy.version})));
   await query("UPDATE studio_projects SET status='delivered',gates='{}' WHERE id=$1",[f.project]);assert.equal((await transaction(c=>refs.listHiggsfieldReferences(c,f.actor,{projectId:f.project}))).references.length,1);assert.equal((await transaction(c=>refs.getHiggsfieldReference(c,f.actor,r.reference.id))).reference.id,r.reference.id);
  });
  await t.test('qualified inspection precedes finite exact human approval and default activation is disabled',async()=>{
   const f=await fixture(),p=(await f.propose()).reference;await assert.rejects(f.approve(p),{code:'HIGGSFIELD_REFERENCE_REVIEW_CHANGED'});await assert.rejects(transaction(c=>refs.claimHiggsfieldReference(c,{companyId:f.company,projectIds:[f.project]})),{code:'HIGGSFIELD_REFERENCE_UNAVAILABLE'});
   const lease=(await f.claim())!;await assert.rejects(transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor:{...f.descriptor,width:4097},profileSha256:'b'.repeat(64)},f.options)),{code:'VALIDATION_ERROR'});await assert.rejects(transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor:{...f.descriptor,width:4096,height:4096},profileSha256:'b'.repeat(64)},f.options)),{code:'HIGGSFIELD_REFERENCE_INSPECTION_CHANGED'});
   const r=(await transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor:f.descriptor,profileSha256:'b'.repeat(64)},f.options))).reference;assert.equal(r.status,'awaiting_approval');await assert.rejects(f.approve(r,undefined,f.memberActor));await assert.rejects(f.approve(r,f.approval(r,{inspectionHash:'0'.repeat(64)})),{code:'HIGGSFIELD_REFERENCE_INSPECTION_CHANGED'});
   for(const patch of[{expiresInMinutes:0},{expiresInMinutes:61},{rightsConsent:false},{allBytesConsent:false},{preparedProxyConsent:false},{referenceSharingConsent:false}])assert.equal(higgsfieldReferenceApproveInput.safeParse(f.approval(r,patch)).success,false);
   await assert.rejects(transaction(c=>refs.approveHiggsfieldReference(c,f.adminActor,r.id,f.approval(r))),{code:'HIGGSFIELD_REFERENCE_UNAVAILABLE'});const input=f.approval(r),approved=await f.approve(r,input);assert.equal(approved.reference.status,'queued');assert.equal(+new Date(approved.reference.expiresAt)-+new Date(approved.reference.approvedAt),1800000);assert.equal((await f.approve(r,input)).replayed,true);
  });
  await t.test('agent proposal and metadata require current six grants, reservation and run; agent cannot approve',async()=>{
   const f=await fixture(),a=await f.agent();await assert.rejects(f.propose(f.input(),{...a,runId:undefined}));const r=await f.propose(f.input(),a);assert.equal(r.reference.proposedAgentId,a.agentId);assert.equal((await transaction(c=>refs.listHiggsfieldReferences(c,a,{projectId:f.project}))).references.length,1);await assert.rejects(f.approve(r.reference,undefined,a));
   await query("UPDATE agents SET capabilities='[\"storage.read\"]' WHERE id=$1",[a.agentId]);await assert.rejects(transaction(c=>refs.getHiggsfieldReference(c,a,r.reference.id)),{code:'AGENT_CAPABILITY_REQUIRED'});
  });
  await t.test('generation agent reads another role predecessor metadata without acquiring its write authority',async()=>{
   const f=await fixture('references');await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)",[f.company,f.owner]);await query("UPDATE studio_work_items SET role_key='ingest' WHERE id=$1",[f.work]);const reference=(await f.propose()).reference,a=await f.agent(),task=randomUUID(),work=randomUUID();
   await query("UPDATE tasks SET status='done',revision=revision+1 WHERE id=$1",[f.task]);await query("INSERT INTO tasks(id,company_id,title,created_by,status,agent_run_id) VALUES($1,$2,'Generate using predecessor reference',$3,'doing',$4)",[task,f.company,f.owner,a.runId]);await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation-agent',$4,'generation','comp','creative')",[work,f.company,f.project,task]);await query('INSERT INTO studio_dependencies(company_id,project_id,work_item_id,predecessor_id) VALUES($1,$2,$3,$4)',[f.company,f.project,work,f.work]);
   assert.equal((await transaction(c=>refs.getHiggsfieldReference(c,a,reference.id))).reference.id,reference.id);assert.equal((await transaction(c=>refs.listHiggsfieldReferences(c,a,{projectId:f.project}))).references[0].id,reference.id);assert.equal((await transaction(c=>refs.listHiggsfieldReferenceCandidates(c,a,{projectId:f.project}))).versions.length,2);await assert.rejects(f.propose(f.input(),a),{code:'HIGGSFIELD_REFERENCE_WORK_CHANGED'});
  });
  await t.test('inspection retains proposal run authority; finite human adoption can outlive that run',async()=>{
   const f=await fixture(),a=await f.agent(),p=(await f.propose(f.input(),a)).reference;
   await query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1",[a.runId]);assert.equal(await f.claim(),null);assert.equal((await transaction(c=>refs.getHiggsfieldReference(c,f.actor,p.id))).reference.status,'blocked');
   const g=await fixture(),actor=await g.agent();await g.propose(g.input(),actor);const lease=(await g.claim())!,inspected=(await transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor:g.descriptor,profileSha256:'b'.repeat(64)},g.options))).reference;await g.approve(inspected);
   await query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1",[actor.runId]);assert.equal((await g.claim())!.phase,'transfer');
  });
  await t.test('explicit five-grant preparation survives actual submit, successful completion and independent acceptance',async()=>{
   for(const accepted of[false,true]){
    const f=await prepared(),r=(await f.propose()).reference;await f.submit();await f.finish();if(accepted)assert.equal((await f.accept())!.status,200);
    const stored=(await query('SELECT * FROM higgsfield_references WHERE id=$1',[r.id])).rows[0];assert.equal(stored.inspection_authority.mode,'prepared_image_v1');assert.equal(stored.inspection_authority.runId,f.runId);assert.equal(stored.inspection_attempts,0);
    const lease=(await f.claim())!;assert(lease);assert.equal(lease.phase,'inspect');const inspected=(await transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor:f.descriptor,profileSha256:'b'.repeat(64)},f.options))).reference;
    assert.equal(inspected.status,'awaiting_approval');assert.equal((await query('SELECT inspection_attempts FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].inspection_attempts,1);
    await f.approve(inspected);assert.equal((await f.claim())!.phase,'transfer');assert.equal((await query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE reference_id=$1 AND phase='intent'",[r.id])).rows[0].n,0);
    assert(!JSON.stringify(inspected).includes(f.identity.token_hash));assert(!JSON.stringify(inspected).includes('inspection_authority'));
   }
  });
  await t.test('failure, cancellation, queued retry and unreceipted success cannot adopt inspection',async()=>{
   for(const outcome of['failed','cancelled','queued','succeeded_without_receipt','retried']){
    const f=await prepared(),r=(await f.propose()).reference;await f.submit();
    if(outcome==='failed')await finishAgentRun(f.identity,f.runId,'fail',{clientId:randomUUID(),leaseToken:f.leaseToken,error:'Synthetic terminal failure',retryable:false});
    else if(outcome==='retried'){await f.finish();await query('UPDATE agent_runs SET attempts=2 WHERE id=$1',[f.runId]);}
    else await query("UPDATE agent_runs SET status=$2,worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE id=$1",[f.runId,outcome==='succeeded_without_receipt'?'succeeded':outcome]);
    assert.equal(await f.claim(),null,outcome);assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].status,'blocked',outcome);
   }
  });
  await t.test('new authority pins current owners, grants, credential, task scope and submitted content',async()=>{
   const mutations:Array<[string,(f:Awaited<ReturnType<typeof prepared>>)=>Promise<unknown>]>=[
    ['membership revoked',f=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner])],
    ['sponsor demoted',f=>query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.company,f.owner])],
    ['grant removed',f=>query("UPDATE agents SET capabilities=capabilities-'storage.read' WHERE id=$1",[f.agentId])],
    ['invocation disabled',f=>query("UPDATE agents SET invocation_access='none' WHERE id=$1",[f.agentId])],
    ['agent paused',f=>query("UPDATE agents SET status='paused' WHERE id=$1",[f.agentId])],
    ['credential rotated',f=>query('UPDATE agents SET token_hash=$2 WHERE id=$1',[f.agentId,hashToken(randomUUID())])],
    ['role reassigned',f=>query("UPDATE studio_role_bindings SET agent_id=NULL,human_id=$2 WHERE company_id=$1 AND role_key='ingest'",[f.company,f.admin])],
    ['title changed',f=>query("UPDATE tasks SET title='Different objective' WHERE id=$1",[f.task])],
    ['summary changed',f=>query("UPDATE tasks SET submission_summary='Substituted evidence' WHERE id=$1",[f.task])],
    ['reservation replaced',f=>query('UPDATE tasks SET agent_run_id=NULL WHERE id=$1',[f.task])],
    ['submission receipt absent',f=>query("DELETE FROM agent_tool_receipts WHERE run_id=$1 AND tool='tasks_submit'",[f.runId])],
    ['forged acceptance',f=>query("UPDATE tasks SET status='done',revision=revision+1,agent_run_id=NULL WHERE id=$1",[f.task])],
    ['bytes changed',f=>query('UPDATE project_storage_verifications SET sha256=$2 WHERE version_id=$1',[f.proxy.version,'e'.repeat(64)])]
   ];
   for(const[label,mutate]of mutations){const f=await prepared(),r=(await f.propose()).reference;await f.submit();await f.finish();await mutate(f);assert.equal(await f.claim(),null,label);assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].status,'blocked',label);}
  });
  await t.test('preparation lifetime, claim attempts and proposal count remain bounded without provider intent',async()=>{
   const f=await prepared(),r=(await f.propose()).reference,initial=(await query('SELECT created_at,inspect_expires_at,inspection_authority FROM higgsfield_references WHERE id=$1',[r.id])).rows[0];assert(+initial.inspect_expires_at-+initial.created_at<=3600000);await f.submit();await f.finish();
   for(let attempt=1;attempt<=3;attempt++){const lease=(await f.claim())!;assert(lease);assert(+new Date(lease.expiresAt)<=+initial.inspect_expires_at);assert.equal((await query('SELECT inspection_attempts FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].inspection_attempts,attempt);await query("UPDATE higgsfield_references SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[r.id]);}
   assert.equal(await f.claim(),null);assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].status,'blocked');
   const g=await prepared();for(let n=0;n<8;n++)await g.propose();await assert.rejects(g.propose(),{code:'HIGGSFIELD_REFERENCE_PREPARATION_LIMIT'});
   const h=await prepared(),expired=(await h.propose()).reference;await h.submit();await h.finish();await query("UPDATE higgsfield_references SET inspect_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal(await h.claim(),null);
  });
  await t.test('marker cannot retrofit an old dispatch and old proposals retain six-grant authority',async()=>{
   const f=await prepared();await assert.rejects(transaction(c=>c.query('INSERT INTO studio_reference_preparation_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[f.company,f.project,f.work,f.runId])),{code:'23514'});
   await query('DELETE FROM studio_reference_preparation_dispatches WHERE run_id=$1',[f.runId]);await assert.rejects(f.propose(),{code:'AGENT_CAPABILITY_REQUIRED'});
   await query("UPDATE agent_runs SET status='queued',attempts=0,started_at=NULL,worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1",[f.runId]);await assert.rejects(transaction(c=>c.query('INSERT INTO studio_reference_preparation_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[f.company,f.project,f.work,f.runId])),{code:'23514'});
  });
  await t.test('prepared authority pins plugin revision and cannot cross tenant or task scope',async()=>{
   const f=await prepared(),installation=randomUUID();await query("INSERT INTO plugin_installations(id,company_id,agent_id,installed_by,client_id,request_hash,plugin_id,manifest_version,runtime_config,character) VALUES($1,$2,$3,$4,$5,$6,'synthetic-inspection','1','{}','{}')",[installation,f.company,f.agentId,f.owner,randomUUID(),'1'.repeat(64)]);
   const r=(await f.propose()).reference,g=await fixture();const {clientId:_,...foreign}=g.input();await assert.rejects(f.tool('higgsfield_reference_propose',foreign));assert.equal((await query('SELECT count(*)::int n FROM higgsfield_references WHERE company_id=$1',[g.company])).rows[0].n,0);
   await f.submit();await f.finish();const lease=(await f.claim())!;assert(lease);
   await assert.rejects(transaction(c=>refs.authorizeHiggsfieldReference(c,{...lease,companyId:g.company},f.options)));
   await assert.rejects(transaction(c=>refs.authorizeHiggsfieldReference(c,{...lease,projectId:g.project},f.options)),{code:'HIGGSFIELD_REFERENCE_LEASE_ENDED'});
   await query('UPDATE plugin_installations SET revision=revision+1 WHERE id=$1',[installation]);await assert.rejects(transaction(c=>refs.authorizeHiggsfieldReference(c,lease,f.options)),{code:'HIGGSFIELD_REFERENCE_INSPECTION_AUTHORITY_ENDED'});
   assert.equal((await query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE reference_id=$1 AND phase='intent'",[r.id])).rows[0].n,0);
  });
  await t.test('expiry after readiness waits and revocation stop the durable worker before evidence commit',async()=>{
   const f=await prepared(),r=(await f.propose()).reference;await f.submit();await f.finish();const lease=(await f.claim())!;
   const late:refs.HiggsfieldReferenceOptions={availability:async(db,companyId,projectId)=>{await db.query("UPDATE higgsfield_references SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[r.id]);return f.options.availability!(db,companyId,projectId);}};
   await assert.rejects(transaction(c=>refs.recordHiggsfieldReferenceInspection(c,lease,{descriptor:f.descriptor,profileSha256:'b'.repeat(64)},late)),{code:'HIGGSFIELD_REFERENCE_LEASE_ENDED'});
   assert.equal((await query('SELECT count(*)::int n FROM higgsfield_reference_inspections WHERE reference_id=$1',[r.id])).rows[0].n,0);
   await transaction(c=>refs.revokeHiggsfieldReference(c,f.adminActor,r.id,{clientId:randomUUID(),revision:r.revision}));await assert.rejects(transaction(c=>refs.authorizeHiggsfieldReference(c,lease,f.options)),{code:'HIGGSFIELD_REFERENCE_LEASE_ENDED'});
  });
  await t.test('revoked membership timestamp, sponsor changes and every pinned epoch fence transfer',async()=>{
   const mutations=[(f:any)=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.admin]),(f:any)=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner]),(f:any)=>query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[f.company]),(f:any)=>query('UPDATE project_storage_connections SET revision=revision+1 WHERE id=$1',[f.connection.id]),(f:any)=>query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id]),(f:any)=>query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.project]),(f:any)=>query("UPDATE tasks SET description='Changed content' WHERE id=$1",[f.task]),(f:any)=>query("UPDATE studio_role_bindings SET human_id=$2 WHERE company_id=$1 AND role_key='comp'",[f.company,f.admin]),(f:any)=>query("UPDATE project_storage_verifications SET sha256=$2 WHERE version_id=$1",[f.proxy.version,'f'.repeat(64)])];
   for(const mutate of mutations){const f=await fixture(),lease=await f.transfer();await mutate(f);await assert.rejects(transaction(c=>refs.authorizeHiggsfieldReference(c,lease,f.options)));await assert.rejects(f.begin(lease,'allocate'));assert.equal((await query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE reference_id=$1 AND phase='intent'",[lease.referenceId])).rows[0].n,0);}
  });
  await t.test('allocation, PUT and confirmation each commit one intent and preserve sealed transport',async()=>{
   const f=await fixture(),lease=await f.transfer();await assert.rejects(f.begin(lease,'put'),{code:'HIGGSFIELD_REFERENCE_PHASE_CONFLICT'});const a=await f.begin(lease,'allocate');await assert.rejects(f.begin(lease,'allocate'),{code:'HIGGSFIELD_REFERENCE_PHASE_CONFLICT'});await assert.rejects(f.complete(lease,randomUUID(),{phase:'allocate',allocation:{}}));const mediaId=randomUUID(),allocation={mediaId,uploadUrl:'https://private.example/upload?opaque=synthetic',expiresAt:new Date(Date.now()+600000).toISOString()};await f.complete(lease,a.actionId,{phase:'allocate',allocation});assert.deepEqual(await transaction(c=>refs.getHiggsfieldReferenceTransport(c,lease,f.options)),allocation);assert(!(JSON.stringify((await query('SELECT sealed FROM higgsfield_reference_transports WHERE reference_id=$1',[lease.referenceId])).rows[0])).includes(allocation.uploadUrl));
   const put=await f.begin(lease,'put');await assert.rejects(f.complete(lease,put.actionId,{phase:'put',httpStatus:200,bytes:101,sha256:f.proxy.sha}),{code:'HIGGSFIELD_REFERENCE_BYTES_CHANGED'});await f.complete(lease,put.actionId,{phase:'put',httpStatus:200,bytes:100,sha256:f.proxy.sha});const confirm=await f.begin(lease,'confirm');await assert.rejects(f.complete(lease,confirm.actionId,{phase:'confirm',mediaId:randomUUID(),confirmed:true}),{code:'HIGGSFIELD_REFERENCE_CONFIRMATION_CHANGED'});const result=await f.complete(lease,confirm.actionId,{phase:'confirm',mediaId,confirmed:true});assert.equal(result.reference.providerConfirmed,true);assert.equal(result.reference.status,'confirmed');await assert.rejects(f.begin(lease,'confirm'));assert.equal((await query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE reference_id=$1 AND phase='intent'",[lease.referenceId])).rows[0].n,3);
  });
  await t.test('tampered private lease metadata cannot reach an allocation intent',async()=>{
   const f=await fixture(),lease=await f.transfer();
   for(const altered of[{...lease,role:'end_image' as const},{...lease,proxy:{...lease.proxy,bytes:lease.proxy.bytes+1}},{...lease,proxy:{...lease.proxy,versionId:randomUUID()}},{...lease,inspection:{...lease.inspection!,profileSha256:'c'.repeat(64)}}]){
    await assert.rejects(transaction(c=>refs.getHiggsfieldReferenceProviderContext(c,altered,f.options)),{code:'HIGGSFIELD_REFERENCE_LEASE_ENDED'});await assert.rejects(f.begin(altered,'allocate'),{code:'HIGGSFIELD_REFERENCE_LEASE_ENDED'});
   }
   assert.equal((await query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE reference_id=$1 AND phase='intent'",[lease.referenceId])).rows[0].n,0);assert.equal((await transaction(c=>refs.getHiggsfieldReferenceProviderContext(c,lease,f.options))).approvedBy,f.admin);
  });
  await t.test('any external intent makes lease loss terminal uncertain with no repeat',async()=>{
   const f=await fixture(),lease=await f.transfer();await f.begin(lease,'allocate');await query("UPDATE higgsfield_references SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[lease.referenceId]);assert.equal(await f.claim(),null);assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[lease.referenceId])).rows[0].status,'uncertain');assert.equal(await f.claim(),null);await assert.rejects(f.begin(lease,'allocate'));
   const g=await fixture(),active=await g.transfer();await g.begin(active,'allocate');const failure=await transaction(c=>refs.failHiggsfieldReference(c,active,'HIGGSFIELD_REFERENCE_WORKER_FAILED'));assert.equal(failure.status,'uncertain');assert.equal(await g.claim(),null);
  });
  await t.test('human revoke immediately fences every worker path without claiming provider deletion',async()=>{
   const f=await fixture(),lease=await f.transfer(),current=(await transaction(c=>refs.getHiggsfieldReference(c,f.actor,lease.referenceId))).reference;const r=await transaction(c=>refs.revokeHiggsfieldReference(c,f.adminActor,lease.referenceId,{clientId:randomUUID(),revision:current.revision}));assert.equal(r.providerBytesDeleted,false);assert.equal(r.disclosureUndone,false);await assert.rejects(transaction(c=>refs.authorizeHiggsfieldReference(c,lease,f.options)));assert.equal((await transaction(c=>refs.failHiggsfieldReference(c,lease,'HIGGSFIELD_REFERENCE_WORKER_FAILED'))).recorded,false);
  });
  await t.test('expired and changed oldest proposals are terminalized instead of starving valid work',async()=>{
   const f=await fixture(),old=(await f.propose()).reference;
   await query("UPDATE higgsfield_references SET inspect_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);const next=(await f.propose()).reference;assert.equal(await f.claim(),null);assert.equal((await transaction(c=>refs.getHiggsfieldReference(c,f.actor,old.id))).reference.status,'blocked');assert.equal((await f.claim())!.referenceId,next.id);
   const g=await fixture(),stale=(await g.propose()).reference;await query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[g.project]);const fresh=(await g.propose(g.input({projectRevision:2}))).reference;assert.equal(await g.claim(),null);assert.equal((await transaction(c=>refs.getHiggsfieldReference(c,g.actor,stale.id))).reference.status,'blocked');assert.equal((await g.claim())!.referenceId,fresh.id);
  });
  await t.test('confirmed references resolve exact IDs without worker readiness and revalidate immutable snapshots',async()=>{
   const f=await fixture(),r=await f.confirm(),resolution=await transaction(c=>refs.resolveHiggsfieldReferences(c,f.actor,{projectId:f.project,workItemId:f.work,referenceIds:[r.reference.id]}));assert.deepEqual(resolution.medias,[{role:'image',value:r.mediaId}]);assert.equal(resolution.snapshot.references[0].sha256,f.proxy.sha);assert.equal((await transaction(c=>refs.revalidateHiggsfieldReferences(c,f.actor,resolution.snapshot))).snapshotHash,resolution.snapshotHash);await assert.rejects(transaction(c=>refs.resolveHiggsfieldReferences(c,f.actor,{projectId:f.project,workItemId:f.work,referenceIds:[r.reference.id,r.reference.id]})),{code:'VALIDATION_ERROR'});
   const modified=structuredClone(resolution.snapshot);modified.references[0].role='end_image';await assert.rejects(transaction(c=>refs.revalidateHiggsfieldReferences(c,f.actor,modified)),{code:'HIGGSFIELD_REFERENCE_BINDING_CHANGED'});
   await query("UPDATE higgsfield_references SET approved_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[r.reference.id]);await assert.rejects(transaction(c=>refs.revalidateHiggsfieldReferences(c,f.actor,resolution.snapshot)),{code:'HIGGSFIELD_REFERENCE_AUTHORITY_ENDED'});
  });
  await t.test('accepted direct reference predecessor remains usable; edited content, role or missing edge does not',async()=>{
   const f=await fixture('references'),r=await f.confirm(),generation=randomUUID(),generationTask=randomUUID();await query("UPDATE tasks SET status='done',revision=revision+1 WHERE id=$1",[f.task]);await query("INSERT INTO tasks(id,company_id,title,created_by,assignee_id) VALUES($1,$2,'Generate from accepted reference',$3,$3)",[generationTask,f.company,f.owner]);await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[generation,f.company,f.project,generationTask]);await query('INSERT INTO studio_dependencies(company_id,project_id,work_item_id,predecessor_id) VALUES($1,$2,$3,$4)',[f.company,f.project,generation,f.work]);await query('UPDATE studio_work_items SET shot_id=$2 WHERE id=$1',[generation,f.shot]);const resolve=()=>transaction(c=>refs.resolveHiggsfieldReferences(c,f.actor,{projectId:f.project,workItemId:generation,referenceIds:[r.reference.id]}));assert.equal((await resolve()).medias[0].value,r.mediaId);
   await query("UPDATE tasks SET description='Changed reference instructions' WHERE id=$1",[f.task]);await assert.rejects(resolve(),{code:'HIGGSFIELD_REFERENCE_WORK_CHANGED'});await query("UPDATE tasks SET description='Preserve the approved content and role' WHERE id=$1",[f.task]);await query("UPDATE studio_role_bindings SET human_id=$2 WHERE company_id=$1 AND role_key='comp'",[f.company,f.admin]);await assert.rejects(resolve(),{code:'HIGGSFIELD_REFERENCE_WORK_CHANGED'});await query("UPDATE studio_role_bindings SET human_id=$2 WHERE company_id=$1 AND role_key='comp'",[f.company,f.owner]);await query('DELETE FROM studio_dependencies WHERE work_item_id=$1',[generation]);await assert.rejects(resolve(),{code:'HIGGSFIELD_REFERENCE_WORK_CHANGED'});
  });
  await t.test('generation proposal, estimate and dispatch bind confirmed references; revoke blocks before OAuth/RPC',async()=>{
   const media={type:'object',required:['role','value'],additionalProperties:false,properties:{role:{type:'string',enum:['image']},value:{type:'string',format:'uuid'}}};
   const params={type:'object',required:['model','prompt','medias'],additionalProperties:false,properties:{model:{type:'string',const:'fixture'},prompt:{type:'string'},get_cost:{type:'boolean'},medias:{type:'array',minItems:1,maxItems:8,items:media}}};
   const tools=[{name:'generate_image',description:'Synthetic exact model',inputSchema:{type:'object',required:['params'],additionalProperties:false,properties:{params}}}];
   const f=await fixture('generation',tools),r=await f.confirm(),input={clientId:randomUUID(),projectId:f.project,projectRevision:1,workItemId:f.work,referenceIds:[r.reference.id],tool:'generate_image',arguments:{params:{model:'fixture',prompt:'An approved synthetic concept'}},note:'Exact managed reference'},p=(await transaction(c=>proposeHiggsfieldRequest(c,f.actor,input))).request;
   assert.deepEqual(p.arguments.params.medias,[{role:'image',value:r.mediaId}]);assert.equal(p.referenceSnapshot.references[0].proxyVersionId,f.proxy.version);assert.equal((await transaction(c=>proposeHiggsfieldRequest(c,f.actor,input))).replayed,true);
   const deniedFetch=globalThis.fetch;let rpc=0,paid=0,estimates=0;
   globalThis.fetch=async(url,init)=>{rpc++;assert.equal(String(url),'https://mcp.higgsfield.ai/mcp');const command=JSON.parse(String(init?.body));if(command.method==='notifications/initialized')return new Response(null,{status:202});if(command.method==='initialize')return Response.json({jsonrpc:'2.0',id:command.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});assert.equal(command.method,'tools/call');assert.deepEqual(command.params.arguments.params.medias,[{role:'image',value:r.mediaId}]);const cost=command.params.arguments.params.get_cost===true;if(cost)estimates++;else paid++;return Response.json({jsonrpc:'2.0',id:command.id,result:{content:[],structuredContent:cost?{cost:2}:{job_ids:[randomUUID()],status:'queued'}}});};
   const call=async(request:any,phase:'estimate'|'execute')=>{const parts=['companies',f.company,'higgsfield','requests',request.id,phase],response=await higgsfieldRoute(new Request('https://coatria.com/api/'+parts.join('/'),{method:'POST',headers:{Origin:'https://coatria.com',Cookie:'coatria_session='+f.sessions.admin,'Content-Type':'application/json'},body:JSON.stringify({requestHash:request.requestHash,...phase==='execute'?{creditConsent:true}:{}})}),parts,'POST');return response!.json();};
   try{
    assert.equal((await call(p,'estimate')).estimateOnly,true);assert.equal(estimates,1);assert.equal(paid,0);assert.equal((await call(p,'execute')).status,'returned');assert.equal(paid,1);await call(p,'execute');assert.equal(paid,1);
    const pending=(await transaction(c=>proposeHiggsfieldRequest(c,f.actor,{...input,clientId:randomUUID()}))).request;
    await transaction(c=>refs.revokeHiggsfieldReference(c,f.adminActor,r.reference.id,{clientId:randomUUID(),revision:r.reference.revision}));await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 hour' WHERE company_id=$1",[f.company]);const before=rpc;
    await assert.rejects(call(pending,'estimate'),{code:'HIGGSFIELD_REFERENCE_NOT_CONFIRMED'});await assert.rejects(call(pending,'execute'),{code:'HIGGSFIELD_REFERENCE_NOT_CONFIRMED'});assert.equal(rpc,before);assert.equal(paid,1);assert.equal((await query('SELECT status FROM higgsfield_requests WHERE id=$1',[pending.id])).rows[0].status,'proposed');
   }finally{globalThis.fetch=deniedFetch;}
  });
  await t.test('company model reads bind proposal hashes and fence drift before cost or paid RPC',async()=>{
   const tools=[observedImageTool,{name:'models_list',description:'Model listing',inputSchema:{type:'object'}},{name:'models_explore',description:'Model catalog actions',inputSchema:{type:'object',required:['action'],properties:{action:{enum:['list','get','search','recommend']},model_id:{type:'string'}}}}];
   const f=await fixture('generation',tools),reference=await f.confirm(),data={clientId:randomUUID(),projectId:f.project,projectRevision:1,workItemId:f.work,referenceIds:[reference.reference.id],tool:'generate_image',arguments:{params:{model:'gpt_image_2',prompt:'Approved synthetic concept',quality:'high',resolution:'1k',aspect_ratio:'1:1'}},note:'Bound model contract'};
   const propose=()=>transaction(c=>proposeHiggsfieldRequest(c,f.actor,data));await assert.rejects(propose(),{code:'HIGGSFIELD_MODEL_CONTRACT_CHANGED'});
   let rpc=0,reads=0,estimates=0,paid=0,descriptor:unknown=structuredClone(observedImageModel);const deniedFetch=globalThis.fetch;
   globalThis.fetch=async(url,init)=>{
    rpc++;assert.equal(String(url),'https://mcp.higgsfield.ai/mcp');const command=JSON.parse(String(init?.body));
    if(command.method==='notifications/initialized')return new Response(null,{status:202});
    if(command.method==='initialize')return Response.json({jsonrpc:'2.0',id:command.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
    assert.equal(command.method,'tools/call');let structuredContent;
    if(['models_list','models_explore'].includes(command.params.name)){reads++;structuredContent=command.params.arguments.action==='get'?descriptor:{...observedImageModelPage,items:[descriptor]};}
    else {assert.equal(command.params.name,'generate_image');assert.deepEqual(command.params.arguments.params.medias,[{role:'image',value:reference.mediaId}]);assert.equal(command.params.arguments.params.quality,'high');assert.equal(command.params.arguments.params.resolution,'1k');const cost=command.params.arguments.params.get_cost===true;if(cost)estimates++;else paid++;structuredContent=cost?{cost:2}:{job_ids:[randomUUID()],status:'queued'};}
    return Response.json({jsonrpc:'2.0',id:command.id,result:{content:[],structuredContent}});
   };
   const call=async(suffix:string,payload:unknown)=>{const parts=['companies',f.company,'higgsfield',...suffix.split('/')],response=await higgsfieldRoute(new Request('https://coatria.com/api/'+parts.join('/'),{method:'POST',headers:{Origin:'https://coatria.com',Cookie:'coatria_session='+f.sessions.admin,'Content-Type':'application/json'},body:JSON.stringify(payload)}),parts,'POST');return response!.json();};
   const refresh=()=>call('read',{tool:'models_explore',arguments:{action:'list'}});
   try{
    await call('read',{tool:'models_list',arguments:{}});assert.equal(reads,1);
    assert.equal((await transaction(c=>higgsfieldAgentConnection(c,f.company))).modelCatalog!.models[0].modelId,'gpt_image_2');
    await query('DELETE FROM higgsfield_model_contracts WHERE company_id=$1',[f.company]);
    await call('read',{tool:'models_explore',arguments:{action:'search',query:'image'}});
    assert.deepEqual((await transaction(c=>higgsfieldAgentConnection(c,f.company))).modelCatalog!.models,[]);
    await refresh();assert.equal(reads,3);assert.equal(paid,0);
    await assert.rejects(call('read',{tool:'models_explore',arguments:{action:'get',model_id:'other_model'}}),{code:'HIGGSFIELD_MODEL_CONTRACT_CHANGED'});
    await call('read',{tool:'models_explore',arguments:{action:'get',model_id:'gpt_image_2'}});
    const catalog=await transaction(c=>higgsfieldAgentConnection(c,f.company));assert(catalog.modelCatalog);assert.equal(catalog.modelCatalog.models[0].modelId,'gpt_image_2');
    const exact=await transaction(c=>higgsfieldAgentConnection(c,f.company,'generate_image','gpt_image_2'));assert(exact.modelContract);assert.equal(exact.modelContract.descriptor.modelId,'gpt_image_2');
    const request=(await propose()).request;assert.equal(request.modelSnapshot.connectionId,f.providerId);assert.equal(request.modelSnapshot.descriptor.modelId,'gpt_image_2');assert.equal((await propose()).replayed,true);
    await call(`requests/${request.id}/estimate`,{requestHash:request.requestHash});assert.equal(estimates,1);assert.equal(paid,0);
    descriptor={...observedImageModel,medias:[{...observedImageModel.medias[0],max:1}]};await refresh();const before=rpc;
    await assert.rejects(call(`requests/${request.id}/estimate`,{requestHash:request.requestHash}),{code:'HIGGSFIELD_MODEL_CONTRACT_CHANGED'});
    await assert.rejects(call(`requests/${request.id}/execute`,{requestHash:request.requestHash,creditConsent:true}),{code:'HIGGSFIELD_MODEL_CONTRACT_CHANGED'});assert.equal(rpc,before);
    descriptor=structuredClone(observedImageModel);await refresh();await call(`requests/${request.id}/execute`,{requestHash:request.requestHash,creditConsent:true});assert.equal(paid,1);
    await call(`requests/${request.id}/execute`,{requestHash:request.requestHash,creditConsent:true});assert.equal(paid,1);
    await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner]);const beforeRevoked=rpc;
    await assert.rejects(refresh(),{code:'HIGGSFIELD_SPONSOR_UNAVAILABLE'});assert.equal(rpc,beforeRevoked);
   }finally{globalThis.fetch=deniedFetch;}
  });
  await t.test('actual v2 dispatch revision bump preserves only unchanged confirmed accepted predecessor semantics',async()=>{
   const f=await fixture('references',[],2,'ingest'),agent=await f.agent(),confirmed=await f.confirm(),task=randomUUID(),work=randomUUID();
   await query("UPDATE tasks SET status='done',revision=revision+1 WHERE id=$1",[f.task]);
   await query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Generate from accepted image reference',$3)",[task,f.company,f.owner]);
   await query("INSERT INTO studio_work_items(id,company_id,project_id,shot_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,$4,'generation',$5,'generation','comp','creative')",[work,f.company,f.project,f.shot,task]);
   await query('INSERT INTO studio_dependencies(company_id,project_id,work_item_id,predecessor_id) VALUES($1,$2,$3,$4)',[f.company,f.project,work,f.work]);
   const parts=['companies',f.company,'studio','projects',f.project,'dispatch'];const response=await studioRoute(new Request('https://coatria.com/api/'+parts.join('/'),{method:'POST',headers:{Origin:'https://coatria.com',Cookie:'coatria_session='+f.sessions.owner,'Content-Type':'application/json'},body:JSON.stringify({clientId:randomUUID(),revision:1,workItemId:work})}),parts,'POST');const result=await response!.json();assert.equal(result.project.revision,2);assert.equal(result.run.agentId,agent.agentId);
   const resolve=()=>transaction(c=>refs.resolveHiggsfieldReferences(c,f.actor,{projectId:f.project,workItemId:work,referenceIds:[confirmed.reference.id]}));assert.equal((await resolve()).medias[0].value,confirmed.mediaId);
   const original=(await query('SELECT * FROM studio_projects WHERE id=$1',[f.project])).rows[0];
   for(const[column,value]of[['brief','Changed semantic brief'],['gates',{}],['status','review'],['client_name','Another client']] as const){await query(`UPDATE studio_projects SET ${column}=$2 WHERE id=$1`,[f.project,typeof value==='object'?JSON.stringify(value):value]);await assert.rejects(resolve(),{code:'HIGGSFIELD_REFERENCE_PROJECT_CHANGED'});await query(`UPDATE studio_projects SET ${column}=$2 WHERE id=$1`,[f.project,typeof original[column]==='object'?JSON.stringify(original[column]):original[column]]);}
   await assert.rejects(transaction(c=>c.query("UPDATE studio_projects SET spec=jsonb_set(spec,'{width}','101') WHERE id=$1",[f.project])),{code:'23514'});assert.equal((await resolve()).medias[0].value,confirmed.mediaId);
  });
  await t.test('session routes enforce origin/admin, report disabled readiness and expose no worker operations',async()=>{
   const f=await fixture(),prefix=['companies',f.company,'higgsfield','references'];
   const call=(parts:string[],method:string,payload?:unknown,who:keyof typeof f.sessions='owner',origin='https://coatria.com')=>higgsfieldReferenceRoute(new Request('https://coatria.com/api/'+parts.join('/')+(method==='GET'?'?projectId='+f.project:''),{method,headers:{Origin:origin,Cookie:'coatria_session='+f.sessions[who],'Content-Type':'application/json'},...payload===undefined?{}:{body:JSON.stringify(payload)}}),parts,method);
   await assert.rejects(call(prefix,'POST',f.input(),'owner','https://untrusted.example'),{code:'INVALID_ORIGIN'});const response=(await call(prefix,'POST',f.input()))!;assert.equal(response.status,201);const r=await response.json();assert.equal(r.processing.enabled,false);await assert.rejects(call([...prefix,r.reference.id,'approve'],'POST',f.approval(r.reference),'member'));assert.equal(await call([...prefix,r.reference.id,'allocate'],'POST',{}),null);const list=await (await call(prefix,'GET'))!.json();assert.equal(list.references.length,1);assert.equal(list.processing.enabled,false);for(const key of['sealed','leaseId','objectKey','providerEtag','uploadUrl'])assert(!JSON.stringify(list).includes(key));
  });
  assert.equal(outbound,0);
 }finally{globalThis.fetch=previous.fetch;await database().end();if(previous.savedPool)(globalThis as any).coatriaPool=previous.savedPool;else delete(globalThis as any).coatriaPool;await server.stop();await db.close();for(const[key,value]of Object.entries({DATABASE_URL:previous.url,DATABASE_POOL_MAX:previous.pool,COATRIA_HOSTING_KEYRING:previous.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
