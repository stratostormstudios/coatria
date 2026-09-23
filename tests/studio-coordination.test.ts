import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {studioCoordinationInput,studioWorkDispatchInput} from '../src/lib/studio-coordination-protocol';
import {AGENT_TOOLS} from '../src/lib/agent-tools';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';

const expires=()=>new Date(Date.now()+3600000).toISOString();
test('coordination schemas expose explicit finite approvals, never privilege or provider overrides',()=>{
 const input={clientId:randomUUID(),revision:0,coordinatorAgentId:randomUUID(),allowedRoleKeys:['producer'],status:'paused',maxRuns:2,maxConcurrentRuns:1,expiresAt:expires()};
 assert(studioCoordinationInput.safeParse(input).success);
 assert(!Object.hasOwn(studioCoordinationInput.parse(input),'coordinatorGeneration'),'Legacy inputs keep their exact hash fields and acquire no new opt-in');
 for(const patch of [{maxRuns:0},{maxRuns:101},{maxConcurrentRuns:4},{allowedRoleKeys:['producer','producer']},{allowedRoleKeys:['invented']},{status:'autonomous'},{grant:['*']},{runsStarted:0},{approvedBy:randomUUID()}])assert(!studioCoordinationInput.safeParse({...input,...patch}).success);
 assert(!studioWorkDispatchInput.safeParse({projectId:randomUUID(),workItemId:randomUUID(),policyRevision:1,projectRevision:1,agentId:randomUUID()}).success);
 assert.equal(AGENT_TOOLS.studio_work_dispatch.capability,'studio.write');assert.equal(AGENT_TOOLS.studio_coordination_get.capability,'studio.read');
 const spec:any=agentRuntimeOpenApi,route=spec.paths['/api/companies/{companyId}/studio/projects/{projectId}/coordination'];assert(route.get&&route.put);assert.deepEqual(route.put.security,[{sessionCookie:[]}]);assert.equal(route.put.requestBody.content['application/json'].schema.additionalProperties,false);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('coordinator handoffs enforce real leases, exact human approval, lifetime budgets and uncertainty fences',{skip:!emulate&&!integrationUrl,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api'),prior={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const f of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+f,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();const url=new URL('postgresql://'+server.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),member=randomUUID(),outsider=randomUUID(),sessions={owner:randomUUID(),reviewer:randomUUID(),member:randomUUID(),outsider:randomUUID()},ids={owner,reviewer,member,outsider},origin='http://localhost:4180';
 const agents:Record<string,{id:string;token:string;installationId:string}>={};let parent:any;
 async function call(path:string,method='GET',payload?:unknown,actor='owner',expected:number|number[]=200){const headers:Record<string,string>={Origin:origin};if(agents[actor])headers.Authorization='Bearer '+agents[actor].token;else if(actor in sessions)headers.Cookie='coatria_session='+sessions[actor as keyof typeof sessions];if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload!==undefined?{body:JSON.stringify(payload)}:{}}),path.split('?')[0].split('/'));const result=await response.json();assert((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: ${response.status} ${result.code??''} ${result.error??''}`);return {...result,__httpStatus:response.status};}
 const base=`companies/${company}/studio`,policyPath=(pid:string)=>`${base}/projects/${pid}/coordination`;
 async function project(approved=true){const created=await call(base+'/projects','POST',{clientId:randomUUID(),name:'Synthetic coordination project',clientName:'Fixture',brief:'Coordinate existing bounded work for a synthetic internal project.',aiPolicy:'allowed',spec:{width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'Linear Rec.709'},shots:[{code:'SH010',description:'Synthetic shot',frameStart:1,frameEnd:2,handles:0,disciplines:['compositing']},{code:'SH020',description:'Synthetic shot two',frameStart:1,frameEnd:2,handles:0,disciplines:['compositing']}]},'owner',201);const pid=created.project.id;if(approved)await call(`${base}/projects/${pid}/gates`,'POST',{clientId:randomUUID(),revision:1,gate:'brief',decision:'approved',note:'Synthetic approved brief.'},'owner',201);return (await call(`${base}/projects/${pid}`));}
 async function approve(pid:string,patch:Record<string,unknown>={}){const old=(await call(policyPath(pid))).policy;return call(policyPath(pid),'PUT',{clientId:randomUUID(),revision:old?.revision??0,coordinatorAgentId:agents.coordinator.id,allowedRoleKeys:['producer','comp'],status:'active',maxRuns:3,maxConcurrentRuns:2,expiresAt:expires(),...patch});}
 async function tool(name:string,args:unknown,expected=200,extra:Record<string,unknown>={}){return call('agent/tools/'+name,'POST',{runId:parent.run.id,leaseToken:parent.leaseToken,requestId:randomUUID(),arguments:args,...extra},'coordinator',expected);}
 async function dispatch(detail:any,work:any,expected=200,extra:Record<string,unknown>={}){const p=(await call(policyPath(detail.project.id))).policy;return tool('studio_work_dispatch',{projectId:detail.project.id,workItemId:work.id,policyRevision:p.revision,projectRevision:detail.project.revision,...extra},expected);}
 async function readyComps(detail:any){await query("UPDATE studio_projects SET gates='{"+'"brief":{"decision":"approved"},"estimate":{"decision":"approved"},"production":{"decision":"approved"}}'+"'::jsonb,status='production' WHERE company_id=$1 AND id=$2",[company,detail.project.id]);await query("UPDATE tasks SET status='done' WHERE company_id=$1 AND id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage IN('estimate','breakdown','ingest'))",[company,detail.project.id]);return call(`${base}/projects/${detail.project.id}`);}
 try{
  for(const [name,userId]of Object.entries(ids))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Coordination '+name,userId+'@example.invalid','fixture']);
  for(const c of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Coordination fixture',$2,'blank')",[c,c]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[company,owner,reviewer,member,foreign,outsider]);
  for(const [name,userId]of Object.entries(ids))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),userId]);
  for(const name of ['coordinator','producer','comp']){const result=await call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name,invocationAccess:'admins',capabilities:['studio.read','studio.write','studio.execute','tasks.write'],runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}},'owner',201);agents[name]={id:result.installation.agentId,token:result.token,installationId:result.installation.id};}
  await call(base+'/setup','POST',{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:0,assignments:[{roleKey:'coordinator',agentId:agents.coordinator.id},{roleKey:'producer',agentId:agents.producer.id},{roleKey:'comp',agentId:agents.comp.id},{roleKey:'qc',humanId:reviewer}]},'owner',201);
  const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:agents.coordinator.id,prompt:'Coordinate bounded synthetic existing work.'},'owner',201)).run;parent=await call('agent/runs/claim','POST',{workerId:'coordination-fixture',claimId:randomUUID()},'coordinator');assert.equal(parent.run.id,run.id);
  await t.test('human approval is tenant scoped, finite, revision fenced and cannot be submitted by an agent',async()=>{
   const d=await project();assert.equal((await call(policyPath(d.project.id))).policy,null);await call(policyPath(d.project.id),'GET',undefined,'outsider',404);
   const body={clientId:randomUUID(),revision:0,coordinatorAgentId:agents.coordinator.id,allowedRoleKeys:['producer'],status:'active',maxRuns:1,maxConcurrentRuns:1,expiresAt:expires()};
   await call(policyPath(d.project.id),'PUT',body,'coordinator',401);await call(policyPath(d.project.id),'PUT',body,'member',403);await call(policyPath(d.project.id),'PUT',{...body,expiresAt:new Date(Date.now()+90000000).toISOString()},'owner',400);
   const saved=await call(policyPath(d.project.id),'PUT',body);assert.equal(saved.policy.effectiveStatus,'active');assert.equal(saved.startsWorkers,false);assert.equal(saved.budgetUnit,'specialist_runs');assert.equal((await call(policyPath(d.project.id),'PUT',body)).replayed,true);
   assert(!Object.hasOwn(saved.policy,'coordinatorGeneration'));assert.equal((await query('SELECT coordinator_generation FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2',[company,d.project.id])).rows[0].coordinator_generation,false);
   await call(policyPath(d.project.id),'PUT',{...body,clientId:randomUUID(),revision:saved.policy.revision,coordinatorGeneration:true},'owner',409);
   await call(policyPath(d.project.id),'PUT',{...body,clientId:randomUUID()},'owner',409);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,0);
  });
  await t.test('gates, exact revisions and live parent lease reject before creating a child',async()=>{
   const d=await project(false),w=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id);
   assert.equal((await dispatch(d,w,409)).code,'STUDIO_WORK_BLOCKED');await dispatch(d,w,409,{policyRevision:99});await dispatch(d,w,409,{projectRevision:99});
   await tool('studio_work_dispatch',{projectId:d.project.id,workItemId:w.id,policyRevision:1,projectRevision:1},409,{leaseToken:'x'.repeat(43)});
   await dispatch(d,{id:randomUUID()},404);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,0);
  });
  await t.test('one ready specialist creates durable causation and one charged run; replays never repeat the work',async()=>{
   const d=await project(),w=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id,{maxRuns:1});
   const result=(await dispatch(d,w)).result;assert.equal(result.policy.runsStarted,1);assert.equal(result.policy.effectiveStatus,'exhausted');assert.equal(result.parentRunId,parent.run.id);
   const replay=(await dispatch(d,w)).result;assert.equal(replay.childRunId,result.childRunId);assert.equal(replay.replayed,true);
   const row=(await query('SELECT max_attempts,capabilities FROM agent_runs WHERE company_id=$1 AND id=$2',[company,result.childRunId])).rows[0];assert.equal(row.max_attempts,1);assert(row.capabilities.includes('studio.execute'));
   const claim=await call('agent/runs/claim','POST',{workerId:'producer-fixture',claimId:randomUUID()},'producer');assert.equal(claim.run.id,result.childRunId,'The final budget reservation must still be allowed to execute.');
   const nested=await call('agent/tools/studio_work_dispatch','POST',{runId:claim.run.id,leaseToken:claim.leaseToken,requestId:randomUUID(),arguments:{projectId:d.project.id,workItemId:w.id,policyRevision:1,projectRevision:d.project.revision}},'producer',403);assert.equal(nested.code,'COORDINATION_NESTED_DISPATCH');
   await call(`agent/runs/${claim.run.id}/fail`,'POST',{clientId:randomUUID(),leaseToken:claim.leaseToken,error:'Synthetic uncertain provider result.'},'producer');
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[claim.run.id])).rows[0].status,'failed');assert.equal((await call('agent/runs/claim','POST',{workerId:'producer-fixture',claimId:randomUUID()},'producer')).run,null);
   assert.equal((await dispatch(d,w)).result.childRunId,result.childRunId);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,1);
  });
  await t.test('concurrency and lifetime limits cannot be reset through reapproval, and lease expiry is terminal',async()=>{
   let d=await readyComps(await project());const works=d.workItems.filter((w:any)=>w.stage==='compositing');await approve(d.project.id,{maxRuns:1,maxConcurrentRuns:1});
   const first=(await dispatch(d,works[0])).result;d=await call(`${base}/projects/${d.project.id}`);assert.equal((await dispatch(d,works[1],409)).code,'COORDINATION_RUN_BUDGET');
   await approve(d.project.id,{maxRuns:2,maxConcurrentRuns:1});assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,1);
   assert.equal((await dispatch(d,works[1],409)).code,'COORDINATION_CONCURRENCY');
   // The old approval changed: queued child is cancelled before first inference.
   assert.equal((await call('agent/runs/claim','POST',{workerId:'comp-fixture',claimId:randomUUID()},'comp')).run,null);assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[first.childRunId])).rows[0].status,'cancelled');
   const second=(await dispatch(d,works[1])).result,claim=await call('agent/runs/claim','POST',{workerId:'comp-fixture',claimId:randomUUID()},'comp');assert.equal(claim.run.id,second.childRunId);
   await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.run.id]);assert.equal((await call('agent/runs/claim','POST',{workerId:'comp-fixture',claimId:randomUUID()},'comp')).run,null);
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[claim.run.id])).rows[0].status,'failed');assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,2);await approve(d.project.id,{maxRuns:1}).then(()=>assert.fail('Cannot refund consumed runs'),error=>assert.match(String(error),/lifetime|COORDINATION_BUDGET_USED/));
  });
  await t.test('expiry fences an already running child heartbeat and claim replay without refund',async()=>{
   const d=await project(),w=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id);const result=(await dispatch(d,w)).result,claimId=randomUUID();const claim=await call('agent/runs/claim','POST',{workerId:'producer-fixture',claimId},'producer');assert.equal(claim.run.id,result.childRunId);
   await query("UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND project_id=$2",[company,d.project.id]);
   assert.equal((await call(`agent/runs/${claim.run.id}/heartbeat`,'POST',{leaseToken:claim.leaseToken},'producer',409)).code,'COORDINATION_AUTHORITY_ENDED');await call('agent/runs/claim','POST',{workerId:'producer-fixture',claimId},'producer',409);
   await dispatch(d,w,409);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,1);await call(`companies/${company}/agent-runs/${claim.run.id}/cancel`,'POST',{});
  });
  await t.test('plugin revision, coordinator mismatch and approving sponsor demotion fail closed',async()=>{
   const d=await project(),w=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id);
   await query('UPDATE plugin_installations SET revision=revision+1 WHERE company_id=$1 AND agent_id=$2',[company,agents.producer.id]);assert.equal((await call(policyPath(d.project.id))).policy.effectiveStatus,'approval_required');await dispatch(d,w,409);
   await approve(d.project.id);await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);await dispatch(d,w,401);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,0);
   const own=d.workItems.find((w:any)=>w.stage==='breakdown');await approve(d.project.id,{allowedRoleKeys:['producer','coordinator']});await dispatch(d,own,403);
  });
  await t.test('exact pause works after expiry and unavailable agents; widening expired approval never does',async()=>{
   const d=await project();await approve(d.project.id);await query("UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND project_id=$2",[company,d.project.id]);await query("UPDATE agents SET status='paused' WHERE company_id=$1 AND id=$2",[company,agents.producer.id]);
   const old=(await call(policyPath(d.project.id))).policy,body={clientId:randomUUID(),revision:old.revision,coordinatorAgentId:old.coordinatorAgentId,allowedRoleKeys:old.allowedRoleKeys,status:'paused',maxRuns:old.maxRuns,maxConcurrentRuns:old.maxConcurrentRuns,expiresAt:old.expiresAt};
   await call(policyPath(d.project.id),'PUT',{...body,maxRuns:old.maxRuns+1},'owner',409);
   const paused=await call(policyPath(d.project.id),'PUT',body);assert.equal(paused.policy.status,'paused');assert.equal(paused.policy.runsStarted,0);
   await query("UPDATE agents SET status='active' WHERE company_id=$1 AND id=$2",[company,agents.producer.id]);
  });
  await t.test('a committed completion remains exactly replayable after historical approval expires',async()=>{
   const d=await project(),w=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id);const result=(await dispatch(d,w)).result,claim=await call('agent/runs/claim','POST',{workerId:'producer-fixture',claimId:randomUUID()},'producer');assert.equal(claim.run.id,result.childRunId);
   const receipt={clientId:randomUUID(),leaseToken:claim.leaseToken,result:'Synthetic specialist report, awaiting independent task review.'};const complete=await call(`agent/runs/${claim.run.id}/complete`,'POST',receipt,'producer');assert.equal(complete.run.status,'succeeded');
   await query("UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND project_id=$2",[company,d.project.id]);
   const replay=await call(`agent/runs/${claim.run.id}/complete`,'POST',receipt,'producer');assert.equal(replay.replayed,true);assert.equal(replay.run.id,complete.run.id);
   await call(`agent/runs/${claim.run.id}/complete`,'POST',{...receipt,result:'Different effect'},'producer',409);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,1);
  });
  await t.test('parallel real PostgreSQL dispatches share one reservation and one child',{skip:emulate},async()=>{
   const d=await project(),w=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id,{maxRuns:1});const results=await Promise.all([dispatch(d,w),dispatch(d,w)]);assert.equal(results[0].result.childRunId,results[1].result.childRunId);assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,1);
  });
  async function interleave(projectId:string,releaseAt:'conversation-acquired'|'policy-update-attempt',first:()=>Promise<any>,second:()=>Promise<any>){
   const pool=database(),originals=new Map<any,any>();let reached!:()=>void,release!:()=>void;const authorityLocked=new Promise<void>(resolve=>{reached=resolve;}),otherReady=new Promise<void>(resolve=>{release=resolve;});let intercepted=false;
   const acquire=(client:any)=>{const original=client.query;originals.set(client,original);client.query=async function(...args:any[]){const sql=typeof args[0]==='string'?args[0]:'',params=args[1]??[];
    if(releaseAt==='policy-update-attempt'&&intercepted&&sql.includes('FROM studio_coordination_policies')&&sql.endsWith(' FOR UPDATE')&&params.includes(projectId))release();
    const result=await original.apply(client,args);
    if(!intercepted&&sql.includes('FROM studio_coordination_policies')&&sql.endsWith(' FOR SHARE')&&params.includes(projectId)){intercepted=true;reached();await otherReady;}
    else if(releaseAt==='conversation-acquired'&&intercepted&&sql.includes('FROM conversations')&&sql.endsWith(' FOR SHARE'))release();
    return result;
   };};
   const released=(_error:any,client:any)=>{const original=originals.get(client);if(original){client.query=original;originals.delete(client);}};
   pool.on('acquire',acquire);pool.on('release',released);let timeout:ReturnType<typeof setTimeout>|undefined;const timer=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{release();reject(Error('The controlled PostgreSQL lock race timed out.'));},20000);});
   let a:Promise<any>|undefined,b:Promise<any>|undefined;
   try{a=first();await Promise.race([authorityLocked,a.then(()=>{throw Error('Missing coordination authority lock.');}),timer]);b=second();return await Promise.race([Promise.all([a,b]),timer]);}
   finally{release();await Promise.allSettled([a,b].filter(Boolean));clearTimeout(timeout);pool.off('acquire',acquire);pool.off('release',released);for(const [client,original]of originals)client.query=original;}
  }
  await t.test('real PostgreSQL completion does not deadlock manual dispatch through conversation/project locks',{skip:emulate},async()=>{
   let d=await readyComps(await project());const works=d.workItems.filter((w:any)=>w.stage==='compositing');await approve(d.project.id);const delegated=(await dispatch(d,works[0])).result;d=await call(`${base}/projects/${d.project.id}`);
   const claim=await call('agent/runs/claim','POST',{workerId:'comp-fixture',claimId:randomUUID()},'comp');assert.equal(claim.run.id,delegated.childRunId);
   const [completed,manual]=await interleave(d.project.id,'conversation-acquired',()=>call(`agent/runs/${claim.run.id}/complete`,'POST',{clientId:randomUUID(),leaseToken:claim.leaseToken,result:'Synthetic independent completion receipt.'},'comp'),()=>call(`${base}/projects/${d.project.id}/dispatch`,'POST',{clientId:randomUUID(),revision:d.project.revision,workItemId:works[1].id},'owner',201));
   assert.equal(completed.run.status,'succeeded');assert.equal(manual.run.status,'queued');await call(`companies/${company}/agent-runs/${manual.run.id}/cancel`,'POST',{});
  });
  await t.test('real PostgreSQL child task mutation serializes with policy pause without a project/policy inversion',{skip:emulate},async()=>{
   const d=await project(),work=d.workItems.find((w:any)=>w.stage==='estimate');await approve(d.project.id);const delegated=(await dispatch(d,work)).result;
   // Cancel unrelated queued producer work from the earlier dedupe race.
   await query("UPDATE agent_runs SET status='cancelled',finished_at=clock_timestamp() WHERE company_id=$1 AND agent_id=$2 AND status='queued' AND id<>$3",[company,agents.producer.id,delegated.childRunId]);
   const claim=await call('agent/runs/claim','POST',{workerId:'producer-fixture',claimId:randomUUID()},'producer');assert.equal(claim.run.id,delegated.childRunId);
   const old=(await call(policyPath(d.project.id))).policy,pause={clientId:randomUUID(),revision:old.revision,coordinatorAgentId:old.coordinatorAgentId,allowedRoleKeys:old.allowedRoleKeys,status:'paused',maxRuns:old.maxRuns,maxConcurrentRuns:old.maxConcurrentRuns,expiresAt:old.expiresAt};
   const [claimed,paused]=await interleave(d.project.id,'policy-update-attempt',()=>call('agent/tools/tasks_claim','POST',{runId:claim.run.id,leaseToken:claim.leaseToken,requestId:randomUUID(),arguments:{taskId:work.taskId,revision:work.revision}},'producer'),()=>call(policyPath(d.project.id),'PUT',pause));
   assert.equal(claimed.result.status,'doing');assert.equal(paused.policy.status,'paused');assert.equal((await call(`agent/runs/${claim.run.id}/heartbeat`,'POST',{leaseToken:claim.leaseToken},'producer',409)).code,'COORDINATION_AUTHORITY_ENDED');
  });
  await t.test('real PostgreSQL distinct parent transactions cannot overspend one shared specialist run',{skip:emulate},async()=>{
   const d=await readyComps(await project()),works=d.workItems.filter((w:any)=>w.stage==='compositing');await approve(d.project.id,{maxRuns:1,maxConcurrentRuns:3});
   const second=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:agents.coordinator.id,prompt:'Synthetic second parent for isolated policy concurrency validation.'},'owner',201)).run,leaseToken=randomUUID()+randomUUID();
   // The worker normally serializes one active run per agent. Seed two valid
   // parent leases to prove that the policy budget does not rely on that fact.
   await query("UPDATE agent_runs SET status='running',attempts=1,worker_id='second-coordinator-fixture',lease_token_hash=$2,lease_expires_at=clock_timestamp()+interval '1 minute',started_at=clock_timestamp() WHERE id=$1",[second.id,hashToken(leaseToken)]);
   const results=await Promise.all([parent,{run:second,leaseToken}].map((lease,index)=>call('agent/tools/studio_work_dispatch','POST',{runId:lease.run.id,leaseToken:lease.leaseToken,requestId:randomUUID(),arguments:{projectId:d.project.id,workItemId:works[index].id,policyRevision:1,projectRevision:d.project.revision}},'coordinator',[200,409])));
   assert.equal(results.filter(result=>result.__httpStatus===200).length,1);assert.equal(results.find(result=>result.__httpStatus===409)?.code,'COORDINATION_RUN_BUDGET');assert.equal((await call(policyPath(d.project.id))).policy.runsStarted,1);
   assert.equal(Number((await query('SELECT count(*) FROM studio_coordination_dispatches WHERE company_id=$1 AND project_id=$2',[company,d.project.id])).rows[0].count),1);
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,reviewer,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
});
