import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {handleApi} from '../src/lib/api';
import {executeAgentTool} from '../src/lib/agent-tools';
import {agentRunContext,claimAgentRun,finishAgentRun} from '../src/lib/agent-runs';
import {originalImagePreparationToolNames,studioDispatchInferenceToolNames,coordinationRunAuthority,originalImagePreparationRunAuthority} from '../src/lib/studio-coordination';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import * as preparation from '../src/lib/project-image-preparations';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';

type Row=Record<string,any>;
for(const coordinated of [false,true])test(`reviewed ingest staffing executes the ${coordinated?'policy-coordinated':'direct'} original-image proposal harness without creative.write or provider calls`,{skip:process.env.COATRIA_TEST_EMULATOR!=='1'&&!process.env.COATRIA_INTEGRATION_DATABASE_URL,timeout:180000},async t=>{
 const prior={pool:(globalThis as any).coatriaPool,url:process.env.DATABASE_URL,max:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch};
 const emulate=process.env.COATRIA_TEST_EMULATOR==='1';let stop=async()=>{},fixtureCompany:string|undefined,fixtureOwner:string|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),pg=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await pg.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();process.env.DATABASE_URL='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres';stop=async()=>{await socket.stop();await pg.close();};}else{const url=new URL(process.env.COATRIA_INTEGRATION_DATABASE_URL!);assert(['127.0.0.1','localhost','::1'].includes(url.hostname),'Concurrency fixture requires local PostgreSQL');process.env.DATABASE_URL=url.href;}
 delete(globalThis as any).coatriaPool;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});
 let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Offline prepared-reference fixture prohibits network');};
 const insert=async(table:string,row:Row)=>{const keys=Object.keys(row);return(await query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row))).rows[0];};
 try{
  const company=randomUUID(),owner=(await insert('users',{name:'Prepared reference owner',email:randomUUID()+'@example.invalid',password_hash:'not-a-login'})).id,session=randomUUID(),origin='http://localhost:4180';
  fixtureCompany=company;fixtureOwner=owner;
  await insert('companies',{id:company,name:'Offline prepared references',slug:company,template:'blank'});await insert('memberships',{company_id:company,user_id:owner,role:'owner'});
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),owner]);
  const api=async(path:string,method='GET',body?:unknown,status=200)=>{const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+session,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('?')[0].split('/'));const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
  const staffing=`companies/${company}/studio/staffing/proposals`,proposal=(await api(staffing,'POST',{clientId:randomUUID(),templateId:'ai-production',brief:'Supervised reference selection and generated studio work with separate human review.',teamSize:3,disciplines:['compositing'],reviewerHumanId:null,provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8'}}},201)).proposal;
  const planned=proposal.plan.specialists.find((person:Row)=>person.roleKeys.includes('ingest'));assert(planned);assert(!planned.capabilities.includes('creative.write'));
  const applied=(await api(staffing+'/'+proposal.id+'/apply','POST',{clientId:randomUUID(),revision:proposal.revision,planHash:proposal.planHash,profileRevision:proposal.profileRevision},201)).application,specialist=applied.specialists.find((person:Row)=>person.roleKeys.includes('ingest'));
  await api(`companies/${company}/plugin-installations/${specialist.installationId}`,'PATCH',{revision:1,status:'active'});
  const identity=(await query('SELECT * FROM agents WHERE id=$1',[specialist.agentId])).rows[0],originalGrants=[...identity.capabilities].sort();assert(!originalGrants.includes('creative.write'));
  const projects=`companies/${company}/studio/projects`;
  async function project(){
   const p=(await api(projects,'POST',{clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Prepared image selection',clientName:'Internal',brief:'Select a verified synthetic prepared image without claiming inspection or consent.',aiPolicy:'allowed',spec:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},shots:[{kind:'image',code:'REF01',description:'One original synthetic prepared image.'}]},201)).project;
   // Predecessor acceptance is synthetic fixture evidence. No media was decoded.
   await query("UPDATE studio_projects SET gates=$2,status='production' WHERE id=$1",[p.id,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);
   await query("UPDATE tasks SET status='done' WHERE id IN(SELECT task_id FROM studio_work_items WHERE project_id=$1 AND stage IN('estimate','breakdown'))",[p.id]);
   const work=(await query("SELECT * FROM studio_work_items WHERE project_id=$1 AND stage='references'",[p.id])).rows[0];
   return {p,work,dispatch:(body:Row,status=201)=>api(projects+'/'+p.id+'/dispatch','POST',body,status)};
  }
  const legacy=await project(),oldBody={clientId:randomUUID(),revision:legacy.p.revision,workItemId:legacy.work.id},old=await legacy.dispatch(oldBody);
  assert.equal((await legacy.dispatch(oldBody,200)).run.id,old.run.id);
  assert.equal((await query('SELECT count(*)::int n FROM studio_image_preparation_dispatches WHERE run_id=$1',[old.run.id])).rows[0].n,0);
  const legacyTools=await transaction(c=>studioDispatchInferenceToolNames(c,company,old.run.id));assert(legacyTools?.includes('storage_files_list'));assert(!legacyTools?.includes('higgsfield_reference_propose'));
  await api(`companies/${company}/agent-runs/${old.run.id}/cancel`,'POST',{});
  const f=await project(),base={clientId:randomUUID(),revision:f.p.revision,workItemId:f.work.id,preparationProfile:'original_image_v1'};
  const beforeRuns=(await query('SELECT count(*)::int n FROM agent_runs WHERE company_id=$1',[company])).rows[0].n;
  const generation=(await query("SELECT id FROM studio_work_items WHERE project_id=$1 AND stage='generation'",[f.p.id])).rows[0];
  assert.equal((await f.dispatch({...base,clientId:randomUUID(),workItemId:generation.id},409)).code,'STUDIO_REFERENCE_PREPARATION_SCOPE');
  await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);await f.dispatch(base,403);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);
  assert.equal((await query('SELECT count(*)::int n FROM studio_image_preparation_dispatches WHERE company_id=$1',[company])).rows[0].n,0);
  await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants.filter(cap=>cap!=='storage.read'))]);
  const missing=await f.dispatch(base,409);assert.equal(missing.code,'STUDIO_AGENT_CAPABILITIES');assert.equal((await query('SELECT count(*)::int n FROM agent_runs WHERE company_id=$1',[company])).rows[0].n,beforeRuns);
  // Restore the reviewed original grants; dispatch itself must never change them.
  await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants)]);
  let dispatched:Row,parentLease:Row|undefined,coordinatorIdentity:Row|undefined,policyBody:Row|undefined;
  if(coordinated){
   const coordinator=applied.specialists.find((person:Row)=>person.roleKeys.includes('coordinator')||person.roleKeys.includes('producer'));assert(coordinator);assert.notEqual(coordinator.agentId,identity.id);
   await api(`companies/${company}/plugin-installations/${coordinator.installationId}`,'PATCH',{revision:1,status:'active'});coordinatorIdentity=(await query('SELECT * FROM agents WHERE id=$1',[coordinator.agentId])).rows[0];
   policyBody={clientId:randomUUID(),revision:0,coordinatorAgentId:coordinator.agentId,allowedRoleKeys:['ingest'],status:'active',maxRuns:1,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+1200000).toISOString(),referencePreparationProfile:'original_image_v1'};
   await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants.filter(cap=>cap!=='storage.read'))]);assert.equal((await api(projects+'/'+f.p.id+'/coordination','PUT',policyBody,409)).code,'COORDINATION_REFERENCE_CAPABILITIES');assert.equal((await query('SELECT count(*)::int n FROM studio_coordination_policies WHERE project_id=$1',[f.p.id])).rows[0].n,0);await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants)]);
   const policy=(await api(projects+'/'+f.p.id+'/coordination','PUT',policyBody)).policy;assert.equal(policy.referencePreparationProfile,'original_image_v1');
   const parent=(await api(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:coordinator.agentId,prompt:'Coordinate the exact reference specialist under the reviewed policy.'},201)).run;
   parentLease=await claimAgentRun(coordinatorIdentity as any,{workerId:'coordinator-reference-fixture',claimId:randomUUID()});assert.equal(parentLease.run.id,parent.id);
   const ordinary=await project(),ordinaryBody={...policyBody,clientId:randomUUID(),referencePreparationProfile:undefined};delete ordinaryBody.referencePreparationProfile;const ordinaryPolicy=(await api(projects+'/'+ordinary.p.id+'/coordination','PUT',ordinaryBody)).policy;assert(!Object.hasOwn(ordinaryPolicy,'referencePreparationProfile'));assert.equal((await api(projects+'/'+ordinary.p.id+'/coordination','PUT',ordinaryBody)).replayed,true);
   const ordinaryDispatch=(await executeAgentTool(coordinatorIdentity as any,'studio_work_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken,requestId:randomUUID(),arguments:{projectId:ordinary.p.id,projectRevision:ordinary.p.revision,workItemId:ordinary.work.id,policyRevision:ordinaryPolicy.revision}})).result as Row;assert.equal((await query('SELECT count(*)::int n FROM studio_image_preparation_dispatches WHERE run_id=$1',[ordinaryDispatch.childRunId])).rows[0].n,0);const ordinaryTools=await transaction(c=>studioDispatchInferenceToolNames(c,company,ordinaryDispatch.childRunId));assert(ordinaryTools!.includes('storage_files_list'));assert(!ordinaryTools!.includes('higgsfield_reference_propose'));await api(`companies/${company}/agent-runs/${ordinaryDispatch.childRunId}/cancel`,'POST',{});
   const args={projectId:f.p.id,projectRevision:f.p.revision,workItemId:f.work.id,policyRevision:policy.revision},dispatch=()=>executeAgentTool(coordinatorIdentity as any,'studio_work_dispatch',{runId:parent.id,leaseToken:parentLease!.leaseToken,requestId:randomUUID(),arguments:args});
   const delegated=(await dispatch()).result as Row;assert.equal(((await dispatch()).result as Row).childRunId,delegated.childRunId);assert.equal(delegated.policy.effectiveStatus,'exhausted');assert.equal(delegated.policy.runsStarted,1);
   const row=(await query('SELECT * FROM agent_runs WHERE id=$1',[delegated.childRunId])).rows[0];dispatched={run:{id:row.id,maxAttempts:row.max_attempts}};
   const marker=(await query('SELECT coordination FROM studio_image_preparation_dispatches WHERE run_id=$1',[row.id])).rows[0].coordination;assert.equal(marker.parentRunId,parent.id);assert.equal(marker.policyRevision,1);assert.equal(marker.approvedBy,owner);
   await transaction(async c=>{await c.query('SAVEPOINT failed_parent');try{await c.query("UPDATE agent_runs SET status='failed',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE id=$1",[parent.id]);assert.equal(await coordinationRunAuthority(c,company,row),false,'Failed parent denies a queued prepared child before inference');}finally{await c.query('ROLLBACK TO SAVEPOINT failed_parent');}});
   await finishAgentRun(coordinatorIdentity as any,parent.id,'complete',{clientId:randomUUID(),leaseToken:parentLease.leaseToken,result:'Queued exact prepared-reference specialist. No inspection, sharing or generation claimed.'});
  }else{dispatched=await f.dispatch(base);assert.equal((await f.dispatch(base,200)).run.id,dispatched.run.id);}
  assert.equal(dispatched.run.maxAttempts,1);
  assert.equal((await query('SELECT count(*)::int n FROM studio_image_preparation_dispatches WHERE run_id=$1',[dispatched.run.id])).rows[0].n,1);
  assert.equal((await query('SELECT original_preparation_profile FROM studio_dispatches WHERE run_id=$1',[dispatched.run.id])).rows[0].original_preparation_profile,'original_image_v1');
  await assert.rejects(transaction(c=>c.query('UPDATE studio_dispatches SET original_preparation_profile=NULL WHERE run_id=$1',[dispatched.run.id])),{code:'42501'});
  await transaction(async c=>{await c.query('SAVEPOINT absent_marker');try{
   await c.query('DELETE FROM studio_image_preparation_dispatches WHERE run_id=$1',[dispatched.run.id]);
   await assert.rejects(originalImagePreparationRunAuthority(c,company,dispatched.run.id),{code:'STUDIO_IMAGE_PREPARATION_AUTHORITY_ENDED'});
  }finally{await c.query('ROLLBACK TO SAVEPOINT absent_marker');}});
  await transaction(async c=>{await c.query('SAVEPOINT role_change');try{
   await c.query("UPDATE studio_role_bindings SET agent_id=NULL,human_id=$2 WHERE company_id=$1 AND role_key='ingest'",[company,owner]);
   const queued=(await c.query('SELECT * FROM agent_runs WHERE id=$1',[dispatched.run.id])).rows[0];
   assert.equal(await coordinationRunAuthority(c,company,queued),false,'Direct and coordinated original roles are checked before claim/inference');
  }finally{await c.query('ROLLBACK TO SAVEPOINT role_change');}});
  const actor={companyId:company,userId:owner},connection=(await transaction(c=>createProjectStorageConnection(c,actor,{clientId:randomUUID(),name:'Synthetic prepared images',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_syntheticaccess',secretAccessKey:'rps_syntheticsecret'}))).connection,binding=(await transaction(c=>bindProjectStorage(c,actor,f.p.id,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  const file=randomUUID(),version=randomUUID(),bytes=100,sha256=hashToken(version),providerId=randomUUID();
  await insert('project_storage_files',{id:file,company_id:company,project_id:f.p.id,binding_id:binding.id,name:'prepared.png',name_key:'prepared.png',created_by:owner});
  await insert('project_storage_versions',{id:version,company_id:company,project_id:f.p.id,file_id:file,version:1,bytes,sha256,content_type:'image/png',object_key:`coatria/companies/${company}/projects/${f.p.id}/objects/${version}`,created_by:owner});
  await insert('project_storage_verifications',{company_id:company,project_id:f.p.id,version_id:version,bytes,sha256,provider_etag:'synthetic',gateway_receipt_id:randomUUID()});
  await query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[company,providerId,owner,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId:company,id:providerId,purpose:'oauth-connection'}))]);
  const lease=await claimAgentRun(identity as any,{workerId:'offline-reference-fixture',claimId:randomUUID()});assert(lease.run);assert.equal(lease.run.id,dispatched.run.id);
  const context=await agentRunContext(identity as any,lease.run.id,lease.leaseToken!),tool=(name:string,args:Row,requestId:string=randomUUID())=>executeAgentTool(identity as any,name,{runId:lease.run!.id,leaseToken:lease.leaseToken!,requestId,arguments:args});
  async function expiryAtBoundary(matches:(sql:string)=>boolean,action:()=>Promise<unknown>){
   // Deterministic transaction seam: admission has passed before this query,
   // then the real DB policy becomes expired before the final commit guard.
   // This proves rollback at that boundary, not a native lock-wait race.
   const pool=database(),originals=new Map<any,any>();let expired=false;
   const acquire=(client:any)=>{const original=client.query;originals.set(client,original);client.query=async function(...args:any[]){
    const result=await original.apply(client,args),sql=typeof args[0]==='string'?args[0]:'';
    if(!expired&&matches(sql)){expired=true;await original.call(client,"UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.p.id]);}
    return result;
   };};
   const released=(_error:any,client:any)=>{const original=originals.get(client);if(original){client.query=original;originals.delete(client);}};
   pool.on('acquire',acquire);pool.on('release',released);
   try{await assert.rejects(action,{code:'HIGGSFIELD_REFERENCE_COORDINATION_AUTHORITY_ENDED'});assert(expired,'The controlled post-admission boundary must be reached');}
   finally{pool.off('acquire',acquire);pool.off('release',released);for(const[client,original]of originals)client.query=original;}
  }
  async function durableState(){return {
   task:(await query('SELECT * FROM tasks WHERE id=$1',[f.work.task_id])).rows[0],
   run:(await query('SELECT * FROM agent_runs WHERE id=$1',[lease.run!.id])).rows[0],
   policy:(await query('SELECT * FROM studio_coordination_policies WHERE project_id=$1',[f.p.id])).rows[0],
   tools:(await query('SELECT * FROM agent_tool_receipts WHERE company_id=$1 AND run_id=$2 ORDER BY request_id',[company,lease.run!.id])).rows,
   messages:(await query('SELECT * FROM messages WHERE company_id=$1 ORDER BY id',[company])).rows,
   conversationRequests:(await query('SELECT * FROM conversation_requests WHERE company_id=$1 ORDER BY client_id',[company])).rows,
   runReceipts:(await query('SELECT * FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2 ORDER BY client_id',[company,lease.run!.id])).rows,
   activity:(await query('SELECT * FROM activity WHERE company_id=$1 ORDER BY id',[company])).rows,
  };}
  assert.deepEqual(context.capabilities.slice().sort(),['storage.read','studio.read','studio.write','tasks.write'].sort());
  assert.deepEqual(await transaction(c=>studioDispatchInferenceToolNames(c,company,lease.run!.id)),originalImagePreparationToolNames);
  assert.deepEqual(originalImagePreparationToolNames.slice().sort(),['studio_get','tasks_claim','tasks_submit','storage_get','storage_files_list','project_image_preparations_list','project_image_preparation_get','project_image_preparation_propose'].sort());
  assert.equal((await query('SELECT count(*)::int n FROM studio_reference_preparation_dispatches WHERE run_id=$1',[lease.run.id])).rows[0].n,0,'Original profile never gains the prepared inspection marker');
  const scopeDenied={code:'STUDIO_IMAGE_PREPARATION_SCOPE'};
  await assert.rejects(()=>tool('storage_files_list',{projectId:legacy.p.id}),scopeDenied);
  await assert.rejects(()=>tool('tasks_claim',{taskId:randomUUID(),revision:1}),scopeDenied);
  await assert.rejects(()=>tool('studio_get',{contractVersion:2,projectId:f.p.id}),scopeDenied);
  await assert.rejects(()=>tool('higgsfield_reference_candidates_list',{projectId:f.p.id}),scopeDenied);
  const contextRead=(await tool('studio_get',{contractVersion:2,projectId:f.p.id,workItemId:f.work.id})).result as Row;
  const claimArgs={taskId:f.work.task_id,revision:contextRead.workItem.revision},claimRequestId=randomUUID();
  if(coordinated)await t.test('policy expiry after a new task effect and receipt rolls back the entire tool',async()=>{
   const before=await durableState();
   await expiryAtBoundary(sql=>sql.startsWith('INSERT INTO agent_tool_receipts('),()=>tool('tasks_claim',claimArgs,claimRequestId));
   assert.deepEqual(await durableState(),before,'Task reservation, tool receipt and activity cannot commit past the policy boundary');
  });
  const claimed=(await tool('tasks_claim',claimArgs,claimRequestId)).result as Row;
  if(coordinated)await t.test('cached task receipt cannot return after policy expiry following initial admission',async()=>{
   const before=await durableState();
   await expiryAtBoundary(sql=>sql.startsWith('SELECT request_hash,response FROM agent_tool_receipts'),()=>tool('tasks_claim',claimArgs,claimRequestId));
   assert.deepEqual(await durableState(),before,'A replay neither bypasses finite authority nor changes the committed original receipt');
  });
  if(coordinated)await t.test('context refresh repeats original authority after loading its conversation',async()=>{
   const before=await durableState();
   await expiryAtBoundary(sql=>sql.startsWith('SELECT id FROM conversations')&&sql.endsWith(' FOR SHARE'),()=>agentRunContext(identity as any,lease.run!.id,lease.leaseToken!));
   assert.deepEqual(await durableState(),before);
  });
  await tool('storage_get',{projectId:f.p.id});await tool('storage_files_list',{projectId:f.p.id});
  assert.equal(((await tool('project_image_preparations_list',{projectId:f.p.id})).result as Row).preparations.length,0);
  const args={projectId:f.p.id,projectRevision:contextRead.project.revision,workItemId:f.work.id,sourceVersionId:version,sourceSha256:sha256,sourceBytes:bytes,destinationFolderId:null,destinationName:'separate-derivative.png',purpose:'Synthetic original-image proposal; original preserved, no bytes processed',continuation:'submitted_plan_v1'};
  await assert.rejects(()=>tool('project_image_preparation_propose',{...args,continuation:undefined}),scopeDenied);
  await assert.rejects(()=>tool('project_image_preparation_propose',{...args,workItemId:legacy.work.id}),scopeDenied);
  const requestId=randomUUID(),saved=((await tool('project_image_preparation_propose',args,requestId)).result as Row).preparation;
  assert.equal(saved.continuationMode,'submitted_plan_v1');assert.equal(saved.status,'proposed');assert.equal(saved.approval,null);
  assert.equal(((await tool('project_image_preparation_propose',args,requestId)).result as Row).preparation.id,saved.id);
  assert.equal(((await tool('project_image_preparation_get',{preparationId:saved.id})).result as Row).preparation.id,saved.id);
  const snapshot=(await query('SELECT proposer_snapshot FROM project_image_preparations WHERE id=$1',[saved.id])).rows[0].proposer_snapshot.agent.runIdentity.originalPreparation;
  assert.equal(snapshot.runId,lease.run.id);assert.equal(snapshot.workItemId,f.work.id);
  assert.equal(snapshot.coordination?.parentRunId??null,parentLease?.run.id??null);
  await tool('tasks_submit',{taskId:f.work.task_id,revision:claimed.revision,summary:`Saved preparation ${saved.id}. Original preserved. Human finite processing, derivative writing and adoption consent are missing. No inspection, generation or sharing occurred.`});
  const completion={clientId:randomUUID(),leaseToken:lease.leaseToken!,result:`Saved original preparation ${saved.id}; pending explicit finite human consent. No media work performed.`};
  if(coordinated)await t.test('fresh completion rolls back its result message when policy expires before the shared final guard',async()=>{
   const before=await durableState();
   await expiryAtBoundary(sql=>sql.startsWith('INSERT INTO conversation_requests('),()=>finishAgentRun(identity as any,lease.run!.id,'complete',completion));
   assert.deepEqual(await durableState(),before,'No result message, completion receipt or succeeded run may commit after original authority expires');
  });
  await finishAgentRun(identity as any,lease.run.id,'complete',completion);
  if(coordinated)await t.test('a historical exact completion receipt remains readable without reviving live tool authority',async()=>{
   const policy=(await query('SELECT expires_at FROM studio_coordination_policies WHERE project_id=$1',[f.p.id])).rows[0];
   try{
    await query("UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.p.id]);
    const before=await durableState();
    const replay=await finishAgentRun(identity as any,lease.run!.id,'complete',completion);assert.equal(replay.replayed,true);assert.equal(replay.run.status,'succeeded');
    await assert.rejects(()=>tool('project_image_preparation_propose',args,requestId));
    assert.deepEqual(await durableState(),before);
   }finally{await query('UPDATE studio_coordination_policies SET expires_at=$2 WHERE project_id=$1',[f.p.id,policy.expires_at]);}
  });
  await assert.rejects(()=>tool('project_image_preparation_propose',args,requestId),'An ended run cannot act through cached receipts');
  const processor={id:randomUUID(),location:'Synthetic metadata test runtime',transport:'linux_binary_v1' as const,qualificationSha256:'a'.repeat(64),releaseSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),closureSha256:'e'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,expiresAt:new Date(Date.now()+3600000).toISOString()},runtime={runtime:async()=>processor};
  const approve=()=>transaction(c=>preparation.approveProjectImagePreparation(c,actor,saved.id,{clientId:randomUUID(),revision:saved.revision,requestHash:saved.requestHash,processorId:processor.id,qualificationSha256:processor.qualificationSha256,expiresInMinutes:10,maxCostMicrousd:1000,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},runtime));
  if(coordinated){
   const mutations:[string,string,unknown[]][]=[
    ['expired policy',"UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.p.id]],
    ['paused policy',"UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1",[f.p.id]],
    ['policy revision','UPDATE studio_coordination_policies SET revision=revision+1 WHERE project_id=$1',[f.p.id]],
    ['changed parent credential','UPDATE agents SET token_hash=$2 WHERE id=$1',[coordinatorIdentity!.id,hashToken(randomUUID())]],
    ['failed parent',"UPDATE agent_runs SET status='failed' WHERE id=$1",[parentLease!.run.id]],
   ];
   for(const[label,sql,values]of mutations)await t.test('completed child cannot adopt after '+label,()=>transaction(async c=>{
    await c.query('SAVEPOINT authority_case');try{await c.query(sql,values);await assert.rejects(preparation.approveProjectImagePreparation(c,actor,saved.id,{clientId:randomUUID(),revision:saved.revision,requestHash:saved.requestHash,processorId:processor.id,qualificationSha256:processor.qualificationSha256,expiresInMinutes:10,maxCostMicrousd:1000,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},runtime));}finally{await c.query('ROLLBACK TO SAVEPOINT authority_case');}
   }));
  }
  await approve();
  if(coordinated)for(const [label,sql]of [['expiry',"UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1"],['pause',"UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1"],['revision','UPDATE studio_coordination_policies SET revision=revision+1 WHERE project_id=$1']])await t.test('already adopted proposal cannot start processing after '+label,()=>transaction(async c=>{
   await c.query('SAVEPOINT denied_claim');try{await c.query(sql,[f.p.id]);assert.equal(await preparation.claimProjectImagePreparation(c,{companyId:company,projectIds:[f.p.id]},runtime),null);assert.equal((await c.query('SELECT attempt FROM project_image_preparations WHERE id=$1',[saved.id])).rows[0].attempt,0);}finally{await c.query('ROLLBACK TO SAVEPOINT denied_claim');}
  }));
  const processingLease=await transaction(c=>preparation.claimProjectImagePreparation(c,{companyId:company,projectIds:[f.p.id]},runtime));assert(processingLease);
  await transaction(c=>preparation.authorizeProjectImagePreparation(c,processingLease,runtime));
  if(coordinated)await transaction(async c=>{await c.query('SAVEPOINT after_claim');try{
   await c.query("UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1",[f.p.id]);
   await assert.rejects(preparation.authorizeProjectImagePreparation(c,processingLease,runtime));
  }finally{await c.query('ROLLBACK TO SAVEPOINT after_claim');}});
  await assert.rejects(transaction(c=>c.query("UPDATE studio_image_preparation_dispatches SET created_at=created_at+interval '1 second' WHERE run_id=$1",[lease.run!.id])),{code:'42501'});
  await assert.rejects(transaction(c=>c.query('INSERT INTO studio_image_preparation_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[company,legacy.p.id,legacy.work.id,old.run.id])),{code:'23514'});
  assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1',[company])).rows[0].n,0);
  assert.equal((await query('SELECT count(*)::int n FROM higgsfield_references WHERE company_id=$1',[company])).rows[0].n,0);
  assert.deepEqual((await query('SELECT capabilities FROM agents WHERE id=$1',[identity.id])).rows[0].capabilities.sort(),originalGrants);
  assert.equal(outbound,0);t.diagnostic('Real application/DB metadata workflow only; no media bytes, processor qualification or provider calls.');
 }finally{
  if(fixtureCompany)await query('DELETE FROM companies WHERE id=$1',[fixtureCompany]);if(fixtureOwner)await query('DELETE FROM users WHERE id=$1',[fixtureOwner]);await database().end();await stop();(globalThis as any).coatriaPool=prior.pool;globalThis.fetch=prior.fetch;
  for(const[key,value]of Object.entries({DATABASE_URL:prior.url,DATABASE_POOL_MAX:prior.max,COATRIA_HOSTING_KEYRING:prior.key}))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
