import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {studioCreativeFollowupInput} from '../src/lib/studio-creative-followup-protocol';

test('creative continuation requires an exact human-attested output pair, never arbitrary execution',()=>{
 const input={clientId:randomUUID(),revision:1,workItemId:randomUUID(),requestId:randomUUID(),artifactId:randomUUID(),outputAttestation:true,note:'I inspected the source request and identified this existing output.'};
 assert(studioCreativeFollowupInput.safeParse(input).success);
 for(const extra of [{outputAttestation:false},{note:''},{providerOutputVerified:true},{startGeneration:true},{capabilities:['*']}])assert(!studioCreativeFollowupInput.safeParse({...input,...extra}).success);
});

test('the documented creative continuation contract is human-only and distinguishes attestation from verification',async()=>{
 const {studioCreativeFollowupPaths,studioCreativeFollowupSchemas}=await import('../src/lib/studio-creative-followup-openapi');
 const path=studioCreativeFollowupPaths['/api/companies/{companyId}/studio/projects/{projectId}/creative-followup'];
 assert.deepEqual(path.post.security,[{sessionCookie:[]}]);assert.deepEqual(path.post['x-coatria-roles'],['owner','admin']);const inputSchema:any=path.post.requestBody.content['application/json'].schema;assert.equal(inputSchema.properties.outputAttestation.const,true);
 const schema:any=studioCreativeFollowupSchemas.StudioCreativeFollowupReceipt;for(const key of ['providerOutputVerified','mediaBytesVerified','mediaQcApproved'])assert.equal(schema.properties[key].const,false);assert.equal(schema.properties.provenance.const,'human_attested');assert.equal(schema.properties.maxAttempts.const,1);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('explicit creative continuation reuses a committed request/output and can only submit the exact task',{skip:!emulate&&!integration,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const prior={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};process.env.DATABASE_URL=integration;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),member=randomUUID(),outsider=randomUUID(),users={owner,reviewer,member,outsider},sessions={owner:randomUUID(),reviewer:randomUUID(),member:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180';
 const base=`companies/${company}/studio`,scopes=['studio.read','studio.write','tasks.write','creative.read','creative.write'];let agentId='',token='';
 const oldFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('No model, provider or storage calls are allowed in this synthetic fixture.');};
 async function call(path:string,method='GET',payload?:unknown,actor:keyof typeof sessions|'agent'='owner',expected:number|number[]=200){const headers:Record<string,string>={Origin:origin};if(actor==='agent')headers.Authorization='Bearer '+token;else headers.Cookie='coatria_session='+sessions[actor];if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/'));const value=await response.json();assert((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);return value;}
 const detail=(pid:string)=>call(`${base}/projects/${pid}`);
 const tool=(lease:any,name:string,args:unknown,expected=200,requestId=randomUUID())=>call('agent/tools/'+name,'POST',{runId:lease.run.id,leaseToken:lease.leaseToken,requestId,arguments:args},'agent',expected);
 const spec={width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'};
 async function fixture(end:'succeeded'|'failed'|'cancelled'='succeeded'){
  const p=(await call(base+'/projects','POST',{clientId:randomUUID(),name:'Asynchronous output fixture',clientName:'Internal',brief:'A synthetic approved concept with a manually attested existing output.',productionPath:'higgsfield',aiPolicy:'allowed',spec,shots:[{code:'SH010',description:'Synthetic fixture',frameStart:1,frameEnd:24,handles:0,disciplines:['compositing']}]},'owner',201)).project;
  await query('UPDATE studio_projects SET gates=$2 WHERE company_id=$3 AND id=$1',[p.id,JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved'}]))),company]);
  await query("UPDATE tasks SET status='done' WHERE id IN (SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage IN ('estimate','breakdown','references'))",[company,p.id]);
  const d=await detail(p.id),work=d.workItems.find((w:any)=>w.stage==='generation');
  const queued=await call(`${base}/projects/${p.id}/dispatch`,'POST',{clientId:randomUUID(),revision:d.project.revision,workItemId:work.id},'owner',201);
  const lease=await call('agent/runs/claim','POST',{workerId:'creative-followup-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,queued.run.id);
  const claimed=(await tool(lease,'tasks_claim',{taskId:work.taskId,revision:work.revision})).result;
  const request=(await tool(lease,'higgsfield_generation_propose',{projectId:p.id,projectRevision:(await detail(p.id)).project.revision,workItemId:work.id,tool:'generate_video',arguments:{prompt:'Synthetic already approved request'},note:'Fixture no actual provider call'})).result.request;
  if(end==='cancelled')await call(`companies/${company}/agent-runs/${lease.run.id}/cancel`,'POST',{});
  else if(end==='failed'){await call(`agent/runs/${lease.run.id}/fail`,'POST',{clientId:randomUUID(),leaseToken:lease.leaseToken,error:'Synthetic interruption after durable proposal.'},'agent');await query("UPDATE agent_runs SET status='failed',finished_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[company,lease.run.id]);}
  else await call(`agent/runs/${lease.run.id}/complete`,'POST',{clientId:randomUUID(),leaseToken:lease.leaseToken,result:'Exact generation request prepared; waiting for human approval and the external provider.'},'agent');
  // Synthetic provider boundary: no paid generation is performed. The actual
  // company integration suite separately exercises the official MCP transport.
  await query("UPDATE higgsfield_requests SET status='returned',approved_by=$3,result=$4 WHERE company_id=$1 AND id=$2",[company,request.id,owner,JSON.stringify({content:[{type:'text',text:'Synthetic queued response; not media verification.'}],structuredContent:{job_ids:[randomUUID()]}})]);
  const registered=await call(`${base}/projects/${p.id}/artifacts`,'POST',{clientId:randomUUID(),revision:(await detail(p.id)).project.revision,workItemId:work.id,name:'Manually identified synthetic output',url:'https://media.example.invalid/fixture.mp4',sha256:'ab'.repeat(32),frameStart:1,frameEnd:24,...spec,notes:'Synthetic metadata only, no actual file inspected.'},'owner',201);
  const path=`${base}/projects/${p.id}/creative-followup`,input={clientId:randomUUID(),revision:(await detail(p.id)).project.revision,workItemId:work.id,requestId:request.id,artifactId:registered.artifact.id,outputAttestation:true,note:'Synthetic human attestation linking the existing output to this exact request.'};
  return {p,work,source:lease,request,artifactId:registered.artifact.id,path,input,taskRevision:claimed.revision};
 }
 try{
  for(const[actor,user]of Object.entries(users))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,'Creative handoff '+actor,user+'@example.invalid','fixture']);
  for(const id of[company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Creative handoff fixture',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[company,owner,reviewer,member,foreign,outsider]);
  for(const[actor,user]of Object.entries(users))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[actor as keyof typeof sessions]),user]);
  const installed=await call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Creative handoff worker',capabilities:[...scopes,'workspace.read'],invocationAccess:'admins',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}},'owner',201);agentId=installed.installation.agentId;token=installed.token;
  await call(base+'/setup','POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'comp',agentId},{roleKey:'qc',humanId:reviewer}]},'owner',201);
  await query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,'connected',$3,'{}',clock_timestamp()+interval '1 hour',$4)",[company,randomUUID(),owner,JSON.stringify([{name:'generate_video',description:'Fixture generation',inputSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt'],additionalProperties:false}}])]);

  await t.test('an ended source can be handed off once with no generation, grant expansion or automatic coordinator run',async()=>{
   const f=await fixture(),snapshot=await call(f.path);assert.deepEqual(snapshot.candidates,[{workItemId:f.work.id,requestId:f.request.id,artifactId:f.artifactId,sourceRunId:f.source.run.id}]);assert.equal(snapshot.automaticContinuation,false);
   await call(f.path,'GET',undefined,'member',403);await call(f.path,'GET',undefined,'outsider',404);await call(f.path,'POST',f.input,'agent',401);await call(f.path,'POST',{...f.input,outputAttestation:false},'owner',400);await call(f.path,'POST',{...f.input,artifactId:randomUUID()},'owner',409);
   const queued=await call(f.path,'POST',f.input,'owner',201);assert.equal(queued.run.maxAttempts,1);assert.deepEqual(queued.run.capabilities,scopes);assert.equal(queued.creativeFollowup.sourceRunId,f.source.run.id);assert.equal(queued.creativeFollowup.provenance,'human_attested');assert.equal(queued.creativeFollowup.providerOutputVerified,false);assert.equal(queued.creativeFollowup.mediaBytesVerified,false);
   const replay=await call(f.path,'POST',f.input);assert.equal(replay.replayed,true);assert.equal(replay.run.id,queued.run.id);assert.equal((await call(f.path,'POST',{...f.input,note:'Changed decision'},'owner',409)).code,'IDEMPOTENCY_CONFLICT');
   assert.equal((await call(f.path,'POST',{...f.input,clientId:randomUUID()},'reviewer',409)).code,'CREATIVE_FOLLOWUP_EXISTS');assert.deepEqual((await call(f.path)).candidates,[]);
   const lease=await call('agent/runs/claim','POST',{workerId:'creative-followup-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,queued.run.id);
   await tool(lease,'studio_get',{projectId:f.p.id,workItemId:f.work.id});await tool(lease,'studio_get',{projectId:f.p.id,artifactId:f.artifactId});await tool(lease,'higgsfield_requests_list',{projectId:f.p.id,requestId:f.request.id});
   assert.equal((await tool(lease,'higgsfield_generation_propose',{projectId:f.p.id,projectRevision:queued.project.revision,workItemId:f.work.id,tool:'generate_video',arguments:{prompt:'Must not be submitted'},note:'Forbidden generation'},403)).code,'CREATIVE_FOLLOWUP_SCOPE');
   await tool(lease,'tasks_create',{title:'Forbidden duplicate',description:'Forbidden'},403);await tool(lease,'studio_get',{projectId:f.p.id},403);await tool(lease,'tasks_claim',{taskId:randomUUID(),revision:f.taskRevision},403);
   const claimId=randomUUID(),claimed=await tool(lease,'tasks_claim',{taskId:f.work.taskId,revision:f.taskRevision},200,claimId);assert.equal(claimed.result.revision,f.taskRevision+1);assert.equal((await tool(lease,'tasks_claim',{taskId:f.work.taskId,revision:f.taskRevision},200,claimId)).replayed,true);
   await tool(lease,'tasks_claim',{taskId:f.work.taskId,revision:f.taskRevision+1},403);
   const submitId=randomUUID(),submitted=await tool(lease,'tasks_submit',{taskId:f.work.taskId,revision:f.taskRevision+1,summary:`Existing artifact ${f.artifactId}, exact request ${f.request.id}; human-attested output ready for independent review.`},200,submitId);assert.equal(submitted.result.status,'review');assert.equal((await tool(lease,'tasks_submit',{taskId:f.work.taskId,revision:f.taskRevision+1,summary:`Existing artifact ${f.artifactId}, exact request ${f.request.id}; human-attested output ready for independent review.`},200,submitId)).replayed,true);
   await call(`agent/runs/${lease.run.id}/complete`,'POST',{clientId:randomUUID(),leaseToken:lease.leaseToken,result:'Existing output submitted for review; not media QC or client acceptance.'},'agent');
   const after=await detail(f.p.id);assert.equal(after.artifacts.length,1);assert.equal(after.workItems.find((w:any)=>w.id===f.work.id).status,'review');assert.equal(after.reviews.length,0);assert.equal(after.deliveries.length,0);
   assert.equal(Number((await query('SELECT count(*) FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2',[company,f.p.id])).rows[0].count),1);assert.equal(outbound,0);
  });

  await t.test('uncertain/error provider receipts, stale task/role and absent grants never become eligible',async()=>{
   const f=await fixture();
   await query("UPDATE higgsfield_requests SET status='uncertain' WHERE id=$1",[f.request.id]);assert.deepEqual((await call(f.path)).candidates,[]);await call(f.path,'POST',f.input,'owner',409);
   await query("UPDATE higgsfield_requests SET status='returned',result='{\"isError\":true}' WHERE id=$1",[f.request.id]);await call(f.path,'POST',f.input,'owner',409);
   await query("UPDATE higgsfield_requests SET result='{\"content\":[]}' WHERE id=$1",[f.request.id]);
   await query("UPDATE agents SET capabilities=capabilities-'creative.write' WHERE id=$1",[agentId]);await call(f.path,'POST',f.input,'owner',409);await query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agentId,JSON.stringify(scopes)]);
   await query("UPDATE studio_role_bindings SET agent_id=NULL WHERE company_id=$1 AND role_key='comp'",[company]);await call(f.path,'POST',f.input,'owner',409);await query("UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1 AND role_key='comp'",[company,agentId]);
   await query('UPDATE tasks SET revision=revision+1 WHERE id=$1',[f.work.taskId]);await call(f.path,'POST',f.input,'owner',409);assert.equal(Number((await query('SELECT count(*) FROM studio_dispatches WHERE company_id=$1 AND project_id=$2',[company,f.p.id])).rows[0].count),1);
  });

  await t.test('an explicit failed-source reconciliation is one attempt and new artifact drift fences all further tools',async()=>{
   const f=await fixture('failed'),queued=await call(f.path,'POST',f.input,'owner',201),lease=await call('agent/runs/claim','POST',{workerId:'creative-followup-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,queued.run.id);
   await call(`${base}/projects/${f.p.id}/artifacts`,'POST',{clientId:randomUUID(),revision:(await detail(f.p.id)).project.revision,workItemId:f.work.id,name:'Newer output supersedes attested version',url:'https://media.example.invalid/revised.mp4',sha256:'cd'.repeat(32),frameStart:1,frameEnd:24,...spec,notes:'Synthetic replacement.'},'owner',201);
   assert.equal((await tool(lease,'tasks_claim',{taskId:f.work.taskId,revision:f.taskRevision},409)).code,'CREATIVE_FOLLOWUP_UNAVAILABLE');
   await call(`agent/runs/${lease.run.id}/fail`,'POST',{clientId:randomUUID(),leaseToken:lease.leaseToken,error:'The human-attested artifact changed.'},'agent');
   assert.equal((await query('SELECT status,max_attempts FROM agent_runs WHERE id=$1',[lease.run.id])).rows[0].status,'failed');assert.equal((await call('agent/runs/claim','POST',{workerId:'creative-followup-fixture',claimId:randomUUID()},'agent')).run,null);
  });

  await t.test('different simultaneous handoff keys cannot enqueue two runs for one exact output',{skip:emulate},async()=>{
   const f=await fixture('cancelled');const attempts=await Promise.all([call(f.path,'POST',f.input,'owner',[201,409]),call(f.path,'POST',{...f.input,clientId:randomUUID()},'reviewer',[201,409])]);assert.equal(attempts.filter(result=>result.run).length,1);assert.equal(attempts.filter(result=>result.code==='CREATIVE_FOLLOWUP_EXISTS').length,1);
   const run=attempts.find(result=>result.run)!.run;await call(`companies/${company}/agent-runs/${run.id}/cancel`,'POST',{});
  });
 }finally{globalThis.fetch=oldFetch;try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,reviewer,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
});
