import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {database,query,transaction} from '../src/lib/db';
import {ApiError,hashToken,errorResponse} from '../src/lib/security';
import {handleApi} from '../src/lib/api';
import {studioGeneratedRevisionRoute,applyStudioGeneratedRevision,draftStudioGeneratedRevision} from '../src/lib/studio-generated-revisions';
import {generatedRoundScope,assertGeneratedWorkCurrent,assertGeneratedDeliveryCurrent} from '../src/lib/studio-generated-rounds';
import {studioGeneratedRevisionDraftPlanInput} from '../src/lib/studio-generated-revision-protocol';
import {makeGeneratedClientPackageFixture,type GeneratedFixtureKind} from './fixtures/generated-client-delivery';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
test('revision input rejects incomplete and oversized creative instructions without changing technical scope',()=>{
 const unitId=randomUUID(),input={projectRevision:1,shareId:randomUUID(),receiptId:randomUUID(),packageSha256:'a'.repeat(64),summary:'Creative change',items:[{unitId,action:'regenerate',instructions:'Use a warmer palette.'}]};
 assert(studioGeneratedRevisionDraftPlanInput.safeParse(input).success);
 assert(!studioGeneratedRevisionDraftPlanInput.safeParse({...input,spec:{kind:'video'}}).success);
 assert(!studioGeneratedRevisionDraftPlanInput.safeParse({...input,items:[{unitId,action:'carry'}]}).success);
 assert(!studioGeneratedRevisionDraftPlanInput.safeParse({...input,items:[input.items[0],input.items[0]]}).success);
 assert(!studioGeneratedRevisionDraftPlanInput.safeParse({...input,summary:'x'.repeat(4000),items:Array.from({length:8},()=>({unitId:randomUUID(),action:'regenerate',instructions:'x'.repeat(4000)}))}).success);
});

test('generated revisions preserve accepted evidence and require a new source-bound approved work graph',{skip:!emulate&&!localPostgres,timeout:180000},async t=>{
 const environment={...process.env},dbName='coatria_revision_'+randomUUID().replaceAll('-','');let stop:(()=>Promise<void>)|undefined,control:Pool|undefined,created=false;
 process.env.DATABASE_POOL_MAX=emulate?'1':'4';process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';process.env.COATRIA_STORAGE_GATEWAY_URL='https://gateway.example.invalid';
 const files=(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort();
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of files)await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=['postgresql',':','//postgres',':','postgres@',server.getServerConn(),'/postgres'].join('');stop=async()=>{await server.stop();await db.close();};}
 else{control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;process.env.DATABASE_URL=url.href;for(const file of files)await query(await readFile('database/'+file,'utf8'));}
 const company=randomUUID(),users={owner:randomUUID(),registrar:randomUUID(),reviewer:randomUUID(),client:randomUUID(),member:randomUUID()},sessions=Object.fromEntries(Object.keys(users).map(name=>[name,randomUUID()])),origin='http://localhost:4180';
 const agentTokens:Record<string,string>={};
 async function call(path:string,method='GET',payload:unknown=undefined,actor='owner',expected=200):Promise<any>{
  const request=new Request(origin+'/api/'+path,{method,headers:{Origin:origin,...agentTokens[actor]?{Authorization:'Bearer '+agentTokens[actor]}:{Cookie:'coatria_session='+sessions[actor]},...payload===undefined?{}:{'Content-Type':'application/json'}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),parts=path.split('?')[0].split('/');let response:Response;try{response=await studioGeneratedRevisionRoute(request,parts,method)??await handleApi(request,parts);}catch(error){if(!(error instanceof ApiError))throw error;response=errorResponse(error);}const text=await response.text();assert.equal(response.status,expected,`${method} ${path}: ${text}`);return JSON.parse(text);
 }
 const prefix=(projectId:string)=>`companies/${company}/studio/projects/${projectId}`,path=(projectId:string)=>prefix(projectId)+'/generated-revisions';
 const prepare=async(kind:GeneratedFixtureKind='image',fixtureCall=call)=>{
  const p=await makeGeneratedClientPackageFixture({db:database(),transaction,call:fixtureCall,companyId:company,users},kind),share=(await call(prefix(p.projectId)+'/client-deliveries','POST',{clientId:randomUUID(),revision:p.revision,deliveryId:p.delivery.id,recipientUserId:users.client,identityConfirmation:'confirmed_out_of_band',expiresAt:new Date(Date.now()+3600000).toISOString()},'owner',201)).share;
  const response=await call('client-deliveries/'+share.id+'/responses','POST',{clientId:randomUUID(),revision:share.revision,decision:'changes_requested',note:'Please revise the creative direction; keep the agreed delivery format.'},'client',201);
  const snapshot=await call(path(p.projectId));return {p,share,response,snapshot};
 };
 const draftBody=(snapshot:any)=>({clientId:randomUUID(),projectRevision:snapshot.projectRevision,shareId:snapshot.source.source.shareId,receiptId:snapshot.source.source.receiptId,packageSha256:snapshot.source.source.packageSha256,summary:'Revise the requested creative direction within the existing technical contract.',items:snapshot.source.items.map((item:any)=>({unitId:item.unitId,action:'regenerate',instructions:'Use a warmer palette while retaining the approved technical specification.'}))});
 try{
  for(const [name,userId] of Object.entries(users)){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','synthetic-not-login']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name]),userId]);}
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic revision studio',$2,'blank')",[company,company]);
  for(const [actor,role] of [['owner','owner'],['registrar','admin'],['reviewer','admin'],['member','member']] as const)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,users[actor],role]);
  await call(`companies/${company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'comp',humanId:users.owner},{roleKey:'qc',humanId:users.reviewer}]},'owner',201);

  await t.test('all media kinds draft exact feedback and apply only fresh work with blank production approvals',async()=>{
   for(const kind of ['image','video','audio'] as const){
    const {p,share,response,snapshot}=await prepare(kind),source=snapshot.source.source;
    assert.equal(source.receiptId,response.receipt.id);assert.equal(source.packageSha256,share.packageSha256);
    const before=(await query('SELECT id,status,revision FROM tasks WHERE company_id=$1 AND id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2) ORDER BY id',[company,p.projectId])).rows,oldScope=await transaction(db=>generatedRoundScope(db,company,p.projectId,{deliveryId:p.delivery.id}));
    const input=draftBody(snapshot),draft=await call(path(p.projectId),'POST',input,'owner',201),again=await call(path(p.projectId),'POST',input);assert.equal(again.replayed,true);assert.equal(again.plan.id,draft.plan.id);assert.equal(draft.plan.items[0].base.storageVersionId,p.versionId);
    const listing=await call(path(p.projectId));assert.equal(listing.plan,null);assert.equal(listing.plans[0].changedCount,1);assert(!('items' in listing.plans[0]));
    const exact=await call(path(p.projectId)+'?planId='+draft.plan.id);assert.equal(exact.plan.planSha256,draft.plan.planSha256);assert.equal(exact.source,null);
    const apply={clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256},applied=await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',apply,'owner',201),replay=await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',apply);
    assert.equal(replay.replayed,true);assert.equal(replay.round.id,applied.round.id);assert.equal(applied.round.number,1);assert.equal(applied.project.status,'intake');assert.equal(applied.project.gates.production,undefined);assert.equal(applied.project.gates.client_acceptance.clientReceiptId,response.receipt.id);
    const current=await transaction(db=>generatedRoundScope(db,company,p.projectId));assert.equal(current.workItemIds.length,6);assert.equal(current.finals.length,1);assert.notEqual(current.finals[0].generationWorkItemId,p.workItemId);assert.equal(current.finals[0].carry,null);
    assert.deepEqual((await query('SELECT id,status,revision FROM tasks WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[company,before.map(row=>row.id)])).rows,before);
    assert.deepEqual(await transaction(db=>generatedRoundScope(db,company,p.projectId,{deliveryId:p.delivery.id})),oldScope);
    await assert.rejects(transaction(db=>assertGeneratedWorkCurrent(db,company,p.projectId,p.workItemId)),/earlier accepted/);
    await assert.rejects(transaction(db=>assertGeneratedDeliveryCurrent(db,company,p.projectId,p.delivery.id)),/earlier production/);
    const after=await call('client-deliveries/'+share.id,undefined,undefined,'client');assert.equal(after.package.files[0].storageVersionId,p.versionId);assert.equal(after.share.response,'changes_requested');assert.equal(after.canRespond,false);
    assert.equal((await query('SELECT count(*)::int count FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2',[company,p.projectId])).rows[0].count,1);
    assert.equal((await query('SELECT count(*)::int count FROM studio_generated_revision_rounds WHERE project_id=$1',[p.projectId])).rows[0].count,1);
   }
  });
  await t.test('wrong scope, actor, immutable hash and changed project cannot activate revision work',async()=>{
   const {p,snapshot}=await prepare(),input=draftBody(snapshot),draft=await call(path(p.projectId),'POST',input,'owner',201);
   await call(path(p.projectId),'POST',input,'member',403);
   await call(path(p.projectId),'POST',{...input,clientId:randomUUID(),items:[{unitId:randomUUID(),action:'regenerate',instructions:'Unrelated'}]},'owner',400);
   await call(path(p.projectId),'POST',{...input,clientId:randomUUID(),receiptId:randomUUID()},'owner',409);
   const apply={clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256};
   await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',apply,'member',403);
   await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',{...apply,planSha256:'0'.repeat(64)},'owner',409);
   await assert.rejects(transaction(db=>applyStudioGeneratedRevision(db,{companyId:company,userId:users.owner,agentId:randomUUID(),runId:randomUUID()},p.projectId,draft.plan.id,apply)),/human administrator/);
   await query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[p.projectId]);
   await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',{...apply,projectRevision:snapshot.projectRevision+1},'owner',409);
   assert.equal((await query('SELECT count(*)::int count FROM studio_generated_revision_rounds WHERE project_id=$1',[p.projectId])).rows[0].count,0);
  });
  await t.test('expired or revoked client grants remain historical planning evidence, never fresh client authority',async()=>{
   const {p,share,snapshot}=await prepare();await query("UPDATE studio_client_deliveries SET status='revoked',revoked_at=clock_timestamp(),revision=revision+1 WHERE id=$1",[share.id]);
   const historical=await call(path(p.projectId));assert.deepEqual(historical.source,snapshot.source);
   const draft=await call(path(p.projectId),'POST',draftBody(historical),'owner',201);assert.equal(draft.plan.source.shareId,share.id);
   await call('client-deliveries/'+share.id,undefined,undefined,'client',410);
  });
  await t.test('database round, plan and work pins are append-only and reject forged source action',async()=>{
   const {p,snapshot}=await prepare(),draft=await call(path(p.projectId),'POST',draftBody(snapshot),'owner',201),apply={clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256};
   const applied=await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',apply,'owner',201);
   await assert.rejects(transaction(db=>db.query("UPDATE studio_generated_revision_plans SET snapshot='{}' WHERE id=$1",[draft.plan.id])),/append-only/);
   await assert.rejects(transaction(db=>db.query('DELETE FROM studio_generated_revision_rounds WHERE id=$1',[applied.round.id])),/append-only/);
   await assert.rejects(transaction(db=>db.query('DELETE FROM studio_generated_revision_work WHERE round_id=$1',[applied.round.id])),/append-only/);
   await assert.rejects(transaction(db=>db.query('INSERT INTO studio_generated_revision_work(company_id,project_id,round_id,work_item_id) VALUES($1,$2,$3,$4)',[company,p.projectId,applied.round.id,p.workItemId])),/sealed revision graph/);
   await assert.rejects(transaction(db=>db.query('INSERT INTO studio_generated_delivery_rounds(company_id,project_id,round_id,delivery_id) VALUES($1,$2,$3,$4)',[company,p.projectId,applied.round.id,p.delivery.id])),/cannot be relabeled/);
   const row=(await query('SELECT * FROM studio_generated_revision_plans WHERE id=$1',[draft.plan.id])).rows[0],bad={...row.snapshot,items:row.snapshot.items.map((item:any)=>({...item,action:null}))};
   await assert.rejects(transaction(async db=>{await db.query("INSERT INTO studio_generated_revision_plans(id,company_id,project_id,source_share_id,source_receipt_id,source_delivery_id,package_sha256,snapshot,plan_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,encode(sha256(convert_to(studio_generated_canonical($8::jsonb),'UTF8')),'hex'),$9)",[randomUUID(),company,p.projectId,row.source_share_id,row.source_receipt_id,row.source_delivery_id,row.package_sha256,JSON.stringify(bad),users.owner]);}),/exact client response|exact delivered evidence/);
  });
  await t.test('competing applications commit one immutable round and do not duplicate its graph',async()=>{
   const {p,snapshot}=await prepare(),draft=await call(path(p.projectId),'POST',draftBody(snapshot),'owner',201),actor={companyId:company,userId:users.owner};
   const results=await Promise.allSettled([0,1].map(()=>transaction(db=>applyStudioGeneratedRevision(db,actor,p.projectId,draft.plan.id,{clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256}))));
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
   assert.equal((await query('SELECT count(*)::int count FROM studio_generated_revision_rounds WHERE project_id=$1',[p.projectId])).rows[0].count,1);
   assert.equal((await query('SELECT count(*)::int count FROM studio_generated_revision_work WHERE project_id=$1',[p.projectId])).rows[0].count,6);
  });
  await t.test('leased agents draft only and derived task authors retain their requester and sponsor',async()=>{
   const {p,snapshot}=await prepare(),agentId=randomUUID(),runId=randomUUID();await query('INSERT INTO conversations(company_id) VALUES($1) ON CONFLICT DO NOTHING',[company]);const conversation=(await query('SELECT id FROM conversations WHERE company_id=$1 AND room_id IS NULL',[company])).rows[0];
   await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic revision drafter','custom',$3,$4,'admins','[\"studio.read\",\"studio.write\"]')",[agentId,company,hashToken(agentId),users.registrar]);
   await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Draft only; do not apply.','[\"studio.read\",\"studio.write\"]','running','synthetic-worker',$8,clock_timestamp()+interval '5 minutes')",[runId,company,agentId,users.owner,conversation.id,randomUUID(),hashToken(runId),hashToken('synthetic-lease')]);
   const actor={companyId:company,userId:users.owner,agentId,runId},draft=await transaction(db=>draftStudioGeneratedRevision(db,actor,p.projectId,draftBody(snapshot)));
   assert.equal(draft.plan.createdAgentId,agentId);
   await query("INSERT INTO studio_coordination_policies(company_id,project_id,coordinator_agent_id,approved_by,status,allowed_role_keys,profile_revision,authority_snapshot,max_runs,runs_started,max_concurrent_runs,expires_at,generated_continuations) VALUES($1,$2,$3,$4,'active','[\"comp\"]',1,'{}',8,3,1,clock_timestamp()+interval '1 hour',true)",[company,p.projectId,agentId,users.owner]);
   await assert.rejects(transaction(db=>applyStudioGeneratedRevision(db,actor,p.projectId,draft.plan.id,{clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256})),/human administrator/);
   const applied=await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',{clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256},'reviewer',201);
   const policy=(await query('SELECT status,revision,max_runs,runs_started,generated_continuations FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2',[company,p.projectId])).rows[0];assert.deepEqual(policy,{status:'paused',revision:2,max_runs:8,runs_started:3,generated_continuations:true});
   const taskRows=(await query('SELECT t.id,t.created_by,t.created_agent_id FROM tasks t JOIN studio_work_items w ON w.company_id=t.company_id AND w.task_id=t.id JOIN studio_generated_revision_work rw ON rw.company_id=w.company_id AND rw.project_id=w.project_id AND rw.work_item_id=w.id WHERE rw.round_id=$1',[applied.round.id])).rows;
   assert.equal(taskRows.length,6);assert(taskRows.every(row=>row.created_by===users.reviewer&&row.created_agent_id===agentId));
   const authors=(await query('SELECT task_id,user_id FROM task_authors WHERE task_id=ANY($1::uuid[])',[taskRows.map(row=>row.id)])).rows;
   for(const task of taskRows){assert(authors.some(row=>row.task_id===task.id&&row.user_id===users.owner));assert(authors.some(row=>row.task_id===task.id&&row.user_id===users.registrar));}
  });
  await t.test('current and identical transport dispatch replays reject superseded generated work without new effects',async()=>{
   const agents:Record<string,string>={};
   for(const name of ['coordinator','producer']){const made=await call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Revision '+name,invocationAccess:'admins',capabilities:['studio.read','studio.write','tasks.write'],runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}},'owner',201);agents[name]=made.installation.agentId;agentTokens[name]=made.token;}
   const profile=(await query('SELECT revision FROM studio_profiles WHERE company_id=$1',[company])).rows[0];
   await call(`companies/${company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:profile.revision,assignments:[{roleKey:'coordinator',agentId:agents.coordinator},{roleKey:'producer',agentId:agents.producer},{roleKey:'comp',humanId:users.owner},{roleKey:'qc',humanId:users.reviewer}]},'owner',201);
   const requested=await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:agents.coordinator,prompt:'Test bounded production revision dispatch receipts.'},'owner',201),parent=await call('agent/runs/claim','POST',{workerId:'revision-coordinator',claimId:randomUUID()},'coordinator');assert.equal(parent.run.id,requested.run.id);
   const approve=async(projectId:string)=>{const policy=(await call(prefix(projectId)+'/coordination')).policy;return call(prefix(projectId)+'/coordination','PUT',{clientId:randomUUID(),revision:policy?.revision??0,coordinatorAgentId:agents.coordinator,allowedRoleKeys:['producer'],status:'active',maxRuns:4,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+3600000).toISOString()});};
   let originalRequest:any,oldWorkId='',oldChildId='';
   const fixtureCall:typeof call=async(route,method='GET',payload,actor='owner',expected=200)=>{
    const result=await call(route,method,payload,actor,expected);
    if(route===`companies/${company}/studio/projects`&&method==='POST'){
     const projectId=result.project.id;
     await call(prefix(projectId)+'/gates','POST',{clientId:randomUUID(),revision:result.project.revision,gate:'brief',decision:'approved',note:'Synthetic reviewed dispatch fixture brief.'},'owner',201);
     const detail=await call(prefix(projectId)+'?contractVersion=2'),policy=await approve(projectId);oldWorkId=detail.workItems.find((work:any)=>work.stage==='estimate').id;
     originalRequest={runId:parent.run.id,leaseToken:parent.leaseToken,requestId:randomUUID(),arguments:{projectId,workItemId:oldWorkId,policyRevision:policy.policy.revision,projectRevision:detail.project.revision}};
     const dispatched=await call('agent/tools/studio_work_dispatch','POST',originalRequest,'coordinator');oldChildId=dispatched.result.childRunId;
     const replay=await call('agent/tools/studio_work_dispatch','POST',originalRequest,'coordinator');assert.equal(replay.replayed,true);assert.equal(replay.result.childRunId,oldChildId);
     await call(`companies/${company}/agent-runs/${oldChildId}/cancel`,'POST',{});
     return {...result,project:(await call(prefix(projectId)+'?contractVersion=2')).project};
    }
    return result;
   };
   const {p,snapshot}=await prepare('image',fixtureCall),draft=await call(path(p.projectId),'POST',draftBody(snapshot),'owner',201),applied=await call(path(p.projectId)+'/'+draft.plan.id+'/apply','POST',{clientId:randomUUID(),projectRevision:snapshot.projectRevision,planSha256:draft.plan.planSha256},'owner',201),policy=await approve(p.projectId);
   const before=(await query('SELECT child_run_id FROM studio_coordination_dispatches WHERE company_id=$1 AND project_id=$2',[company,p.projectId])).rows;assert.deepEqual(before,[{child_run_id:oldChildId}]);
   const fresh=await call('agent/tools/studio_work_dispatch','POST',{...originalRequest,requestId:randomUUID(),arguments:{...originalRequest.arguments,policyRevision:policy.policy.revision,projectRevision:applied.project.revision}},'coordinator',409);assert.equal(fresh.code,'STUDIO_REVISION_WORK_SUPERSEDED');
   const identical=await call('agent/tools/studio_work_dispatch','POST',originalRequest,'coordinator',409);assert.equal(identical.code,'COORDINATION_REVISION_CONFLICT');
   assert.deepEqual((await query('SELECT child_run_id FROM studio_coordination_dispatches WHERE company_id=$1 AND project_id=$2',[company,p.projectId])).rows,before);
   assert.equal((await call(prefix(p.projectId)+'/coordination')).policy.runsStarted,1);
   assert.equal((await query('SELECT count(*)::int count FROM agent_tool_receipts WHERE company_id=$1 AND run_id=$2',[company,parent.run.id])).rows[0].count,1);
   const oldRead=await call('agent/tools/studio_get','POST',{runId:parent.run.id,leaseToken:parent.leaseToken,requestId:randomUUID(),arguments:{projectId:p.projectId,workItemId:oldWorkId,contractVersion:2}},'coordinator');assert.equal(oldRead.result.historicalWork,true);
   const legacy=await call(`companies/${company}/studio/projects`,'POST',{clientId:randomUUID(),name:'Legacy wire compatibility',clientName:'Synthetic client',brief:'Preserve the existing frame-based work projection.',aiPolicy:'allowed',spec:{width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'Linear Rec.709'},shots:[{code:'SH010',description:'Legacy frame-based shot',frameStart:1,frameEnd:2,handles:0,disciplines:['compositing']}]},'owner',201),legacyDetail=await call(prefix(legacy.project.id));
   assert(legacyDetail.workItems.every((work:any)=>!('description' in work)));
   const legacyRead=await call('agent/tools/studio_get','POST',{runId:parent.run.id,leaseToken:parent.leaseToken,requestId:randomUUID(),arguments:{projectId:legacy.project.id,workItemId:legacyDetail.workItems[0].id}},'coordinator');assert(!('historicalWork' in legacyRead.result));assert(!('description' in legacyRead.result.workItem));
  });
 }finally{
  await database().end();if(stop)await stop();if(control){if(created)await control.query('DROP DATABASE '+dbName+' WITH (FORCE)');await control.end();}
  for(const name of Object.keys(process.env))if(!(name in environment))delete process.env[name];Object.assign(process.env,environment);
 }
});
