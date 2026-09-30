import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {handleApi} from '../src/lib/api';
import {AGENT_TOOLS,agentToolInputSchema,executeAgentTool} from '../src/lib/agent-tools';
import {agentRunContext,authorizeStoredAgentRun,claimAgentRun,finishAgentRun} from '../src/lib/agent-runs';
import {installedRuntimeContext} from '../src/lib/plugin-marketplace';
import {buildStudioInferenceRequest} from '../src/lib/studio-inference';
import {referencePreparationToolNames,studioDispatchInferenceToolNames,coordinationRunAuthority} from '../src/lib/studio-coordination';
import {studioDispatchInput} from '../src/lib/studio-protocol';
import {studioWorkDispatchInput,studioCoordinationInput} from '../src/lib/studio-coordination-protocol';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import * as references from '../src/lib/higgsfield-references';
import {createProviderExecutor} from '../public/downloads/provider-adapter.mjs';
import {createRunInferenceClient,stableRequestId} from '../public/downloads/agent-worker.mjs';

type Row=Record<string,any>;
test('prepared dispatch is an explicit human option, not a new default or coordinator authority',()=>{
 const legacy={clientId:randomUUID(),revision:1,workItemId:randomUUID()};
 assert.deepEqual(studioDispatchInput.parse(legacy),legacy);
 assert(studioDispatchInput.safeParse({...legacy,preparationProfile:'prepared_image_v1'}).success);
 assert(!studioDispatchInput.safeParse({...legacy,preparationProfile:'auto'}).success);
 assert(!studioWorkDispatchInput.safeParse({projectId:randomUUID(),workItemId:legacy.workItemId,projectRevision:1,policyRevision:1,preparationProfile:'prepared_image_v1'}).success);
 const policy={clientId:randomUUID(),revision:0,coordinatorAgentId:randomUUID(),allowedRoleKeys:['ingest'],status:'active',maxRuns:1,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+3600000).toISOString()};assert.deepEqual(studioCoordinationInput.parse(policy),policy);assert(studioCoordinationInput.safeParse({...policy,referencePreparationProfile:'prepared_image_v1'}).success);for(const value of['auto',null,false])assert(!studioCoordinationInput.safeParse({...policy,referencePreparationProfile:value}).success);
 const schema=AGENT_TOOLS.higgsfield_connection_get.schema;
 assert(schema.safeParse({modelId:'provider.model-1'}).success);
 for(const modelId of['','https://untrusted.invalid/model','a'.repeat(129)])assert(!schema.safeParse({modelId}).success);
 const operation=(agentRuntimeOpenApi.paths as Row)['/api/companies/{companyId}/studio/projects/{projectId}/dispatch'].post,schemaDoc=operation.requestBody.content['application/json'].schema;
 assert.deepEqual(operation['x-coatria-roles'],['owner','admin']);assert.equal(schemaDoc.properties.preparationProfile.const,'prepared_image_v1');assert(!schemaDoc.required.includes('preparationProfile'));
 const proposal=(agentRuntimeOpenApi.paths as Row)['/api/agent/tools/higgsfield_reference_propose'].post;assert(!proposal['x-coatria-required-capabilities'].includes('creative.write'));assert.match(proposal.description,/markerless legacy proposals additionally require creative.write/);
});

for(const coordinated of [false,true])test(`reviewed ingest staffing executes the ${coordinated?'policy-coordinated':'direct'} prepared-reference harness without creative.write or provider calls`,{skip:process.env.COATRIA_TEST_EMULATOR!=='1'&&!process.env.COATRIA_INTEGRATION_DATABASE_URL,timeout:180000},async t=>{
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
  assert.equal((await query('SELECT count(*)::int n FROM studio_reference_preparation_dispatches WHERE run_id=$1',[old.run.id])).rows[0].n,0);
  const legacyTools=await transaction(c=>studioDispatchInferenceToolNames(c,company,old.run.id));assert(legacyTools?.includes('storage_files_list'));assert(!legacyTools?.includes('higgsfield_reference_propose'));
  await api(`companies/${company}/agent-runs/${old.run.id}/cancel`,'POST',{});
  const f=await project(),base={clientId:randomUUID(),revision:f.p.revision,workItemId:f.work.id,preparationProfile:'prepared_image_v1'};
  const beforeRuns=(await query('SELECT count(*)::int n FROM agent_runs WHERE company_id=$1',[company])).rows[0].n;
  const generation=(await query("SELECT id FROM studio_work_items WHERE project_id=$1 AND stage='generation'",[f.p.id])).rows[0];
  assert.equal((await f.dispatch({...base,clientId:randomUUID(),workItemId:generation.id},409)).code,'STUDIO_REFERENCE_PREPARATION_SCOPE');
  await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);await f.dispatch(base,403);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);
  assert.equal((await query('SELECT count(*)::int n FROM studio_reference_preparation_dispatches WHERE company_id=$1',[company])).rows[0].n,0);
  await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants.filter(cap=>cap!=='storage.read'))]);
  const missing=await f.dispatch(base,409);assert.equal(missing.code,'STUDIO_AGENT_CAPABILITIES');assert.equal((await query('SELECT count(*)::int n FROM agent_runs WHERE company_id=$1',[company])).rows[0].n,beforeRuns);
  // Restore the reviewed original grants; dispatch itself must never change them.
  await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants)]);
  let dispatched:Row,parentLease:Row|undefined,coordinatorIdentity:Row|undefined,policyBody:Row|undefined;
  if(coordinated){
   const coordinator=applied.specialists.find((person:Row)=>person.roleKeys.includes('coordinator')||person.roleKeys.includes('producer'));assert(coordinator);assert.notEqual(coordinator.agentId,identity.id);
   await api(`companies/${company}/plugin-installations/${coordinator.installationId}`,'PATCH',{revision:1,status:'active'});coordinatorIdentity=(await query('SELECT * FROM agents WHERE id=$1',[coordinator.agentId])).rows[0];
   policyBody={clientId:randomUUID(),revision:0,coordinatorAgentId:coordinator.agentId,allowedRoleKeys:['ingest'],status:'active',maxRuns:1,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+1200000).toISOString(),referencePreparationProfile:'prepared_image_v1'};
   await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants.filter(cap=>cap!=='storage.read'))]);assert.equal((await api(projects+'/'+f.p.id+'/coordination','PUT',policyBody,409)).code,'COORDINATION_REFERENCE_CAPABILITIES');assert.equal((await query('SELECT count(*)::int n FROM studio_coordination_policies WHERE project_id=$1',[f.p.id])).rows[0].n,0);await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[identity.id,JSON.stringify(originalGrants)]);
   const policy=(await api(projects+'/'+f.p.id+'/coordination','PUT',policyBody)).policy;assert.equal(policy.referencePreparationProfile,'prepared_image_v1');
   const parent=(await api(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:coordinator.agentId,prompt:'Coordinate the exact reference specialist under the reviewed policy.'},201)).run;
   parentLease=await claimAgentRun(coordinatorIdentity as any,{workerId:'coordinator-reference-fixture',claimId:randomUUID()});assert.equal(parentLease.run.id,parent.id);
   const ordinary=await project(),ordinaryBody={...policyBody,clientId:randomUUID(),referencePreparationProfile:undefined};delete ordinaryBody.referencePreparationProfile;const ordinaryPolicy=(await api(projects+'/'+ordinary.p.id+'/coordination','PUT',ordinaryBody)).policy;assert(!Object.hasOwn(ordinaryPolicy,'referencePreparationProfile'));assert.equal((await api(projects+'/'+ordinary.p.id+'/coordination','PUT',ordinaryBody)).replayed,true);
   const ordinaryDispatch=(await executeAgentTool(coordinatorIdentity as any,'studio_work_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken,requestId:randomUUID(),arguments:{projectId:ordinary.p.id,projectRevision:ordinary.p.revision,workItemId:ordinary.work.id,policyRevision:ordinaryPolicy.revision}})).result as Row;assert.equal((await query('SELECT count(*)::int n FROM studio_reference_preparation_dispatches WHERE run_id=$1',[ordinaryDispatch.childRunId])).rows[0].n,0);const ordinaryTools=await transaction(c=>studioDispatchInferenceToolNames(c,company,ordinaryDispatch.childRunId));assert(ordinaryTools!.includes('storage_files_list'));assert(!ordinaryTools!.includes('higgsfield_reference_propose'));await api(`companies/${company}/agent-runs/${ordinaryDispatch.childRunId}/cancel`,'POST',{});
   const args={projectId:f.p.id,projectRevision:f.p.revision,workItemId:f.work.id,policyRevision:policy.revision},dispatch=()=>executeAgentTool(coordinatorIdentity as any,'studio_work_dispatch',{runId:parent.id,leaseToken:parentLease!.leaseToken,requestId:randomUUID(),arguments:args});
   const delegated=(await dispatch()).result as Row;assert.equal(((await dispatch()).result as Row).childRunId,delegated.childRunId);assert.equal(delegated.policy.effectiveStatus,'exhausted');assert.equal(delegated.policy.runsStarted,1);
   const row=(await query('SELECT * FROM agent_runs WHERE id=$1',[delegated.childRunId])).rows[0];dispatched={run:{id:row.id,maxAttempts:row.max_attempts}};
   const marker=(await query('SELECT coordination FROM studio_reference_preparation_dispatches WHERE run_id=$1',[row.id])).rows[0].coordination;assert.equal(marker.parentRunId,parent.id);assert.equal(marker.policyRevision,1);assert.equal(marker.approvedBy,owner);
   await transaction(async c=>{await c.query('SAVEPOINT failed_parent');try{await c.query("UPDATE agent_runs SET status='failed',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE id=$1",[parent.id]);assert.equal(await coordinationRunAuthority(c,company,row),false,'Failed parent denies a queued prepared child before inference');}finally{await c.query('ROLLBACK TO SAVEPOINT failed_parent');}});
   await finishAgentRun(coordinatorIdentity as any,parent.id,'complete',{clientId:randomUUID(),leaseToken:parentLease.leaseToken,result:'Queued exact prepared-reference specialist. No inspection, sharing or generation claimed.'});
  }else{dispatched=await f.dispatch(base);assert.equal((await f.dispatch(base,200)).run.id,dispatched.run.id);}
  assert.equal(dispatched.run.maxAttempts,1);
  assert.equal((await query('SELECT count(*)::int n FROM studio_reference_preparation_dispatches WHERE run_id=$1',[dispatched.run.id])).rows[0].n,1);
  const actor={companyId:company,userId:owner},connection=(await transaction(c=>createProjectStorageConnection(c,actor,{clientId:randomUUID(),name:'Synthetic prepared images',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_syntheticaccess',secretAccessKey:'rps_syntheticsecret'}))).connection,binding=(await transaction(c=>bindProjectStorage(c,actor,f.p.id,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  const file=randomUUID(),version=randomUUID(),bytes=100,sha256=hashToken(version),providerId=randomUUID();
  await insert('project_storage_files',{id:file,company_id:company,project_id:f.p.id,binding_id:binding.id,name:'prepared.png',name_key:'prepared.png',created_by:owner});
  await insert('project_storage_versions',{id:version,company_id:company,project_id:f.p.id,file_id:file,version:1,bytes,sha256,content_type:'image/png',object_key:`coatria/companies/${company}/projects/${f.p.id}/objects/${version}`,created_by:owner});
  await insert('project_storage_verifications',{company_id:company,project_id:f.p.id,version_id:version,bytes,sha256,provider_etag:'synthetic',gateway_receipt_id:randomUUID()});
  await query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[company,providerId,owner,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId:company,id:providerId,purpose:'oauth-connection'}))]);
  const lease=await claimAgentRun(identity as any,{workerId:'offline-reference-fixture',claimId:randomUUID()});assert(lease.run);assert.equal(lease.run.id,dispatched.run.id);
  const context=await agentRunContext(identity as any,lease.run.id,lease.leaseToken!),tool=(name:string,args:Row,requestId:string=randomUUID())=>executeAgentTool(identity as any,name,{runId:lease.run!.id,leaseToken:lease.leaseToken!,requestId,arguments:args});
  const scopeDenied={code:'STUDIO_REFERENCE_PREPARATION_SCOPE'};
  await assert.rejects(()=>tool('higgsfield_reference_candidates_list',{projectId:legacy.p.id}),scopeDenied);
  await assert.rejects(()=>tool('tasks_claim',{taskId:randomUUID(),revision:1}),scopeDenied);
  await assert.rejects(()=>tool('studio_get',{contractVersion:2,projectId:f.p.id}),scopeDenied);
  await assert.rejects(()=>tool('storage_files_list',{projectId:f.p.id}),scopeDenied);
  await assert.rejects(()=>tool('higgsfield_generation_propose',{projectId:f.p.id,projectRevision:1,workItemId:f.work.id,tool:'generate_image',arguments:{prompt:'Forbidden generation'},note:'Forbidden'}),scopeDenied);
  const fullCatalog=Object.entries(AGENT_TOOLS).filter(([,definition])=>[definition.capability,...definition.additionalCapabilities??[]].every(cap=>context.capabilities.includes(cap))).map(([name,definition])=>({name,description:definition.description,capability:definition.capability,mutating:definition.mutating,inputSchema:agentToolInputSchema(definition)}));
  let step=0,taskRevision=0,projectRevision=0,candidate:Row|undefined,saved:Row|undefined;const executed:string[]=[],catalogBytes:number[]=[];
  const sequence=['studio_get','tasks_claim','higgsfield_reference_candidates_list','higgsfield_references_list','higgsfield_reference_propose','tasks_submit'];
  const inference=createRunInferenceClient({runId:lease.run.id,leaseToken:lease.leaseToken,pollMs:0,client:{submitInference:async()=>{
   const request=await transaction(async c=>{const access=await authorizeStoredAgentRun(c,identity as any,lease.run!.id,hashToken(lease.leaseToken!)),installation=await installedRuntimeContext(c,company,identity.id);return buildStudioInferenceRequest(c,{...access,installation});});
   assert.deepEqual(request.tools!.map(item=>item.function.name).sort(),[...referencePreparationToolNames].sort());catalogBytes.push(Buffer.byteLength(JSON.stringify(request.tools)));assert(catalogBytes.at(-1)!<5500);
   const index=step++,name=sequence[index],args=index===0?{contractVersion:2,projectId:f.p.id,workItemId:f.work.id}:index===1?{taskId:f.work.task_id,revision:taskRevision}:index===2||index===3?{projectId:f.p.id}:index===4?{projectId:f.p.id,projectRevision,workItemId:f.work.id,proxyVersionId:candidate!.versionId,proxyBytes:candidate!.bytes,proxySha256:candidate!.sha256,role:'image',purpose:'Synthetic original prepared reference; rights still require review.'}:{taskId:f.work.task_id,revision:taskRevision,summary:`Reference proposal ${saved!.id}; inspection, rights review and sharing approval remain pending. Bytes unchanged; no generation or upload occurred.`};
   const output={choices:[{finish_reason:index===sequence.length?'stop':'tool_calls',message:index===sequence.length?{role:'assistant',content:'Prepared reference plan submitted. Inspection and human sharing approval remain pending.'}:{role:'assistant',content:null,tool_calls:[{id:'prepared-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:1800,completion_tokens:100}};
   return {inference:{id:randomUUID(),status:'succeeded',deadlineAt:new Date(Date.now()+60000).toISOString(),protocolVersion:2,runId:lease.run!.id,step:index,disposition:'execute',output,usage:{promptTokens:1800,completionTokens:100,totalTokens:1900}}};
  }}});
  const execute=createProviderExecutor({settings:{NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'},fetch:async()=>{throw Error('No direct inference allowed');}});
  const result=await execute({run:context.run,context,tools:{storageTransportVersion:'1',key:(key:string)=>stableRequestId(lease.run!.id,key),list:async()=>({tools:fullCatalog}),call:async(name:string,args:Row,{requestId}:{requestId:string})=>{const value=(await tool(name,args,requestId)).result as Row;executed.push(name);if(name==='studio_get'){taskRevision=value.workItem.revision;projectRevision=value.project.revision;}if(name==='tasks_claim')taskRevision=value.revision;if(name==='higgsfield_reference_candidates_list'){assert.equal(value.nextAfter,null);candidate=value.versions.find((item:Row)=>item.versionId===version);}if(name==='higgsfield_reference_propose'){saved=value.reference;assert.equal(saved!.inspectionAuthorityMode,'prepared_image_v1');assert.equal(((await tool(name,args,requestId)).result as Row).reference.id,saved!.id);}return value;}},inference});
  assert.deepEqual(executed,sequence);assert.equal(step,7);assert(saved);await finishAgentRun(identity as any,lease.run.id,'complete',{clientId:randomUUID(),leaseToken:lease.leaseToken!,result:result.result});
  assert.equal((await query('SELECT status FROM tasks WHERE id=$1',[f.work.task_id])).rows[0].status,'review');assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[lease.run.id])).rows[0].status,'succeeded');
  const runtime:references.HiggsfieldReferenceOptions={availability:async()=>({enabled:true,code:'SYNTHETIC_ONLY',message:'Injected offline qualification, not production proof',expiresAt:new Date(Date.now()+3600000).toISOString(),qualificationSha256:'a'.repeat(64),catalogSha256:references.higgsfieldReferenceDigest([])})};
  if(coordinated){
   const stored=(await query('SELECT * FROM higgsfield_references WHERE id=$1',[saved.id])).rows[0];assert.equal(stored.inspection_authority.coordination.parentRunId,parentLease!.run.id);assert(new Date(stored.inspect_expires_at).getTime()<=Date.parse(policyBody!.expiresAt));
   const mutations:[string,string,unknown[]][]=[
    ['paused policy',"UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1",[f.p.id]],
    ['revised policy','UPDATE studio_coordination_policies SET revision=revision+1 WHERE project_id=$1',[f.p.id]],
    ['expired policy',"UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.p.id]],
    ['failed parent',"UPDATE agent_runs SET status='failed' WHERE id=$1",[parentLease!.run.id]],
    ['cancelled parent',"UPDATE agent_runs SET status='cancelled' WHERE id=$1",[parentLease!.run.id]],
    ['unreceipted parent',"DELETE FROM agent_run_receipts WHERE run_id=$1 AND kind='complete'",[parentLease!.run.id]],
    ['rotated coordinator','UPDATE agents SET token_hash=$2 WHERE id=$1',[coordinatorIdentity!.id,hashToken(randomUUID())]],
    ['coordinator installation revision','UPDATE plugin_installations SET revision=revision+1 WHERE agent_id=$1',[coordinatorIdentity!.id]],
    ['revoked sponsor','UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[company,owner]],
   ];
   for(const[label,sql,args]of mutations)await t.test('completed child cannot retain inspection after '+label,()=>transaction(async c=>{await c.query('SAVEPOINT denied_authority');try{await c.query(sql,args);assert.equal(await references.claimHiggsfieldReference(c,{companyId:company,projectIds:[f.p.id]},runtime),null);}finally{await c.query('ROLLBACK TO SAVEPOINT denied_authority');}}));
   await t.test('slow runtime readiness cannot outlive a still-running parent lease',()=>transaction(async c=>{
    await c.query('SAVEPOINT parent_lease_clock');let readyCalls=0;
    try{await c.query("UPDATE agent_runs SET status='running',worker_id='bounded-ready-fixture',lease_token_hash=$2,lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[parentLease!.run.id,hashToken(randomUUID())]);
     const slow={availability:async()=>{readyCalls++;await new Promise(resolve=>setTimeout(resolve,1100));return runtime.availability!(c,company,f.p.id);}};
     await assert.rejects(()=>references.claimHiggsfieldReference(c,{companyId:company,projectIds:[f.p.id]},slow),{code:'HIGGSFIELD_REFERENCE_COORDINATION_AUTHORITY_ENDED'});assert.equal(readyCalls,1);assert.equal((await c.query('SELECT lease_id FROM higgsfield_references WHERE id=$1',[saved!.id])).rows[0].lease_id,null);
    }finally{await c.query('ROLLBACK TO SAVEPOINT parent_lease_clock');}
   }));
   await t.test('real PostgreSQL policy pause wins before a waiting post-run inspection',{skip:emulate},async()=>{
    const blocker=await database().connect();let inspectionAttempt:Promise<unknown>|undefined;
    try{await blocker.query('BEGIN');await blocker.query("UPDATE studio_coordination_policies SET status='paused' WHERE project_id=$1",[f.p.id]);inspectionAttempt=transaction(c=>references.claimHiggsfieldReference(c,{companyId:company,projectIds:[f.p.id]},runtime));
     let waiting=false;for(let i=0;i<100;i++){const state=await blocker.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%studio_coordination_policies%' LIMIT 1");if(state.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}assert(waiting,'Inspection actually waits on exact policy row');await blocker.query('COMMIT');assert.equal(await inspectionAttempt,null);assert.equal((await query('SELECT count(*)::int n FROM higgsfield_reference_inspections WHERE reference_id=$1',[saved!.id])).rows[0].n,0);
    }finally{await blocker.query('ROLLBACK');blocker.release();await inspectionAttempt;}
    // This fixture alone restores its synthetic policy/proposal for the positive case.
    await query("UPDATE studio_coordination_policies SET status='active' WHERE project_id=$1",[f.p.id]);await query("UPDATE higgsfield_references SET status='proposed',diagnostic_code=NULL WHERE id=$1",[saved!.id]);
   });
  }
  const inspection=await transaction(c=>references.claimHiggsfieldReference(c,{companyId:company,projectIds:[f.p.id]},runtime));assert(inspection,'A committed successful factual plan preserves finite inspection authority');assert.equal(inspection.phase,'inspect');
  const inspected=(await transaction(c=>references.recordHiggsfieldReferenceInspection(c,inspection,{descriptor:{kind:'image',format:'png',contentType:'image/png',bytes,sha256,verification:'full_decode',inspectionVersion:1,width:16,height:16,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}},profileSha256:'b'.repeat(64)},runtime))).reference;
  assert.equal(inspected.status,'awaiting_approval');assert.equal(inspected.approvedBy,null);assert.equal(inspected.providerConfirmed,false);assert.equal(inspected.metadataRemoved,false);
  assert.equal((await query('SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE phase=\'intent\' AND reference_id=$1',[saved.id])).rows[0].n,0);assert.equal((await query('SELECT count(*)::int n FROM higgsfield_requests WHERE company_id=$1',[company])).rows[0].n,0);
  assert.deepEqual((await query('SELECT capabilities FROM agents WHERE id=$1',[identity.id])).rows[0].capabilities.sort(),originalGrants);assert.equal(outbound,0);t.diagnostic(JSON.stringify({preparedReferenceCatalogBytes:catalogBytes,providerCalls:outbound,qualification:'synthetic only'}));
 }finally{
  if(fixtureCompany)await query('DELETE FROM companies WHERE id=$1',[fixtureCompany]);if(fixtureOwner)await query('DELETE FROM users WHERE id=$1',[fixtureOwner]);await database().end();await stop();(globalThis as any).coatriaPool=prior.pool;globalThis.fetch=prior.fetch;
  for(const[key,value]of Object.entries({DATABASE_URL:prior.url,DATABASE_POOL_MAX:prior.max,COATRIA_HOSTING_KEYRING:prior.key}))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
