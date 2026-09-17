import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('bounded missions use approved identities, leased runs, cycle budgets and explicit recovery',{skip:!emulate&&!url,timeout:120000},async t=>{
 process.env.DATABASE_URL=url;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const f of(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile('database/'+f,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID(),agent=randomUUID(),otherAgent=randomUUID(),token='ca_'+randomUUID(),otherToken='ca_'+randomUUID(),sessions={owner:randomUUID(),admin:randomUUID(),member:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180',prefix=`companies/${company}/autonomy/missions`;
 const payload={clientId:randomUUID(),agentId:agent,name:'Weekly launch research',objective:'Review existing work and advance the launch research with evidence.',intervalMinutes:15,maxCycles:2};let mission:any;
 async function call(path:string,method='GET',payload?:unknown,actor:'owner'|'admin'|'member'|'outsider'|'agent'|'otherAgent'='owner',expected=200){const headers:Record<string,string>={};if(actor==='agent'||actor==='otherAgent')headers.Authorization='Bearer '+(actor==='agent'?token:otherToken);else{headers.Cookie='coatria_session='+sessions[actor];headers.Origin=origin;}if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('?')[0].split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;}
 const tick=()=>call('agent/autonomy/tick','POST',{},'agent');
 const due=()=>query("UPDATE agent_missions SET next_run_at=clock_timestamp()-interval '1 day' WHERE id=$1",[mission.id]);
 async function update(data:unknown){mission=(await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,...data as any})).mission;return mission;}
 async function completeNext(fail=false){const claimed=await call('agent/runs/claim','POST',{workerId:'mission-worker',claimId:randomUUID()},'agent');assert(claimed.run);return call('agent/runs/'+claimed.run.id+'/'+(fail?'fail':'complete'),'POST',{leaseToken:claimed.leaseToken,clientId:randomUUID(),...(fail?{error:'External effect uncertain; human review required.'}:{result:'Reviewed current tasks and prepared evidence for human approval.'})},'agent');}
 try{
  for(const[userId,name]of[[owner,'Owner'],[admin,'Administrator'],[member,'Member'],[outsider,'Outsider']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','fixture']);
  for(const[c,name]of[[company,'Mission company'],[foreign,'Foreign company']])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')",[c,name,c]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[company,owner,admin,member,foreign,outsider]);
  for(const[k,userId]of Object.entries({owner,admin,member,outsider}))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[k as keyof typeof sessions]),userId]);
  for(const[agentId,agentToken]of[[agent,token],[otherAgent,otherToken]])await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Mission worker','custom',$3,$4,'admins','[\"workspace.read\",\"tasks.write\"]')",[agentId,company,hashToken(agentToken),owner]);
  await t.test('mission creation requires a human admin, defaults paused and is retry-safe',async()=>{
   await call(prefix,'POST',payload,'member',403);await call(prefix,'POST',payload,'outsider',404);await call(prefix,'POST',{...payload,intervalMinutes:1},'owner',400);await call(prefix,'POST',{...payload,maxCycles:101},'owner',400);
   const first=await call(prefix,'POST',payload,'owner',201);mission=first.mission;assert.equal(mission.status,'paused');assert.equal(mission.cyclesStarted,0);
   const retry=await call(prefix,'POST',payload);assert.equal(retry.mission.id,mission.id);assert.equal(retry.replayed,true);await call(prefix,'POST',{...payload,objective:'Different'},'owner',409);
   assert.equal((await tick()).runs.length,0);await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},'owner',409);
   await call(prefix+'/'+mission.id,'PATCH',{revision:1,status:'active'},'member',403);
  });
  await t.test('only the assigned worker can tick; active missions queue one leased cycle without catchup',async()=>{
   await update({status:'active'});await due();assert.equal((await call('agent/autonomy/tick','POST',{},'otherAgent')).runs.length,0);
   const first=await tick();assert.equal(first.runs.length,1);assert.equal(first.runs[0].missionId,mission.id);assert.equal(first.runs[0].status,'queued');assert.equal((await tick()).runs.length,0);
   mission=(await call(prefix+'/'+mission.id)).mission;assert.equal(mission.cyclesStarted,1);assert.equal(mission.lastRunStatus,'queued');assert(new Date(mission.nextRunAt).getTime()>Date.now());
   const run=(await query('SELECT * FROM agent_runs WHERE id=$1',[mission.lastRunId])).rows[0];assert.equal(run.requested_by,owner);assert.deepEqual(run.capabilities,['workspace.read','tasks.write']);assert.match(run.prompt,/independent human review/);assert.match(run.prompt,/Cycle 1 of 2/);
   await due();const pending=await tick();assert.equal(pending.runs.length,0);assert.equal((await query('SELECT cycles_started FROM agent_missions WHERE id=$1',[mission.id])).rows[0].cycles_started,1);
  });
  await t.test('successful cycles consume the fixed budget and stop without new planning loops',async()=>{
   const first=await completeNext();assert.equal(first.run.status,'succeeded');assert.equal((await tick()).runs.length,1);await completeNext();
   const final=await tick();assert.equal(final.runs.length,0);mission=(await call(prefix+'/'+mission.id)).mission;assert.equal(mission.status,'completed');assert.equal(mission.cyclesStarted,2);
   await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},'owner',409);await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,status:'active'},'owner',409);
   const history=await call(prefix+'/'+mission.id+'/runs?limit=1');assert.equal(history.cycles.length,1);assert.equal(history.cycles[0].ordinal,2);assert.equal(history.hasMore,true);assert.equal((await call(prefix+'/'+mission.id+'/runs?after='+history.nextAfter)).cycles[0].ordinal,1);
  });
  await t.test('a model failure stops on its first attempt and pauses until reviewed',async()=>{
   await update({maxCycles:4,status:'active'});await due();await tick();const failure=await completeNext(true);assert.equal(failure.run.status,'failed');assert.equal(failure.run.attempts,1);
   const stopped=await tick();assert.deepEqual(stopped.pausedMissionIds,[mission.id]);mission=(await call(prefix+'/'+mission.id)).mission;assert.equal(mission.status,'paused');assert.match(mission.pauseReason,/Review/);
   const claim=await call('agent/runs/claim','POST',{workerId:'must-not-repeat',claimId:randomUUID()},'agent');assert.equal(claim.run,null);
   await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},'owner',409);
   await update({status:'active'});assert.equal((await tick()).runs.length,0);
  });
  await t.test('manual runs use the same budget, original requester and durable retry key',async()=>{
   const clientId=randomUUID(),first=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId},'admin',201),again=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId},'admin');assert.equal(first.runId,again.runId);assert.equal(again.replayed,true);assert.equal(first.mission.cyclesStarted,4);assert.equal((await query('SELECT requested_by FROM agent_runs WHERE id=$1',[first.runId])).rows[0].requested_by,owner);
   mission=first.mission;await completeNext();await tick();mission=(await call(prefix+'/'+mission.id)).mission;assert.equal(mission.status,'completed');await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,maxCycles:3},'owner',400);
  });
  await t.test('expired mission leases fail closed instead of starting a second attempt',async()=>{
   await update({maxCycles:6,status:'active'});await due();await tick();const held=await call('agent/runs/claim','POST',{workerId:'lost-worker',claimId:randomUUID()},'agent');await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[held.run.id]);
   assert.equal((await call('agent/runs/claim','POST',{workerId:'new-worker',claimId:randomUUID()},'agent')).run,null);assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[held.run.id])).rows[0].status,'failed');
   await tick();mission=(await call(prefix+'/'+mission.id)).mission;assert.equal(mission.status,'paused');await update({status:'active'});
  });
  await t.test('configuration edits cancel work and pause; stale edits cannot override a new cycle',async()=>{
   const work=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},'owner',201),oldRevision=mission.revision;mission=work.mission;
   await call(prefix+'/'+mission.id,'PATCH',{revision:oldRevision,status:'paused'},'owner',409);
   // Replenish the explicit lifetime cycle budget as part of this admin review.
   await update({name:'Reviewed launch research',maxCycles:8});assert.equal(mission.status,'paused');assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[work.runId])).rows[0].status,'cancelled');
   assert.equal((await tick()).runs.length,0);await update({status:'active'});
  });
  await t.test('mission authors cannot retain autonomous authority after demotion',async()=>{
   await due();await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);
   // Keep the worker sponsor authorized while removing only mission authorship.
   await query('UPDATE agents SET created_by=$3 WHERE company_id=$1 AND id=$2',[company,agent,admin]);
   const result=await tick();assert.deepEqual(result.pausedMissionIds,[mission.id]);mission=(await call(prefix+'/'+mission.id,'GET',undefined,'member')).mission;assert.equal(mission.status,'paused');assert.match(mission.pauseReason,/mission author/);
   await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,status:'active'},'admin',409);
   await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);await update({status:'active'});
  });
  await t.test('real PostgreSQL competing ticks never exceed one cycle',{skip:emulate},async()=>{
   await due();const responses=await Promise.all(Array.from({length:4},()=>tick()));assert.equal(responses.flatMap(response=>response.runs).length,1);mission=(await call(prefix+'/'+mission.id)).mission;await update({status:'paused'});
  });
  await t.test('live mission leases and queued claims require the author to remain an administrator',async()=>{
   mission=(await call(prefix+'/'+mission.id)).mission;await update({maxCycles:10,status:'active'});
   const work=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},'owner',201);mission=work.mission;
   const claimId=randomUUID(),claimed=await call('agent/runs/claim','POST',{workerId:'live-demotion',claimId},'agent');assert.equal(claimed.run.id,work.runId);
   await query("UPDATE agents SET invocation_access='members' WHERE id=$1",[agent]);await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);
   await call('agent/runs/'+work.runId+'/heartbeat','POST',{leaseToken:claimed.leaseToken},'agent',403);
   const context=await handleApi(new Request(origin+'/api/agent/runs/'+work.runId+'/context',{headers:{Authorization:'Bearer '+token,'X-Coatria-Run-Lease':claimed.leaseToken}}),['agent','runs',work.runId,'context']);assert.equal(context.status,403);assert.equal((await context.json()).code,'MISSION_AUTHOR_ACCESS');
   await call('agent/tools/workspace_get','POST',{runId:work.runId,leaseToken:claimed.leaseToken,requestId:randomUUID(),arguments:{}},'agent',403);
   await call('agent/runs/'+work.runId+'/complete','POST',{leaseToken:claimed.leaseToken,clientId:randomUUID(),result:'Late completion must be denied.'},'agent',403);
   await call('agent/runs/claim','POST',{workerId:'live-demotion',claimId},'agent',403);
   assert.equal((await call('agent/runs/claim','POST',{workerId:'cancel-demoted',claimId:randomUUID()},'agent')).run,null);assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[work.runId])).rows[0].status,'cancelled');await tick();
   await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);mission=(await call(prefix+'/'+mission.id)).mission;await update({status:'active'});
   const queued=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},'owner',201);mission=queued.mission;
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);assert.equal((await call('agent/runs/claim','POST',{workerId:'queued-demotion',claimId:randomUUID()},'agent')).run,null);assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[queued.runId])).rows[0].status,'cancelled');
   await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);
  });
  await t.test('mission lists and histories remain tenant scoped and limits are enforced',async()=>{
   assert.equal((await call(prefix,'GET',undefined,'member')).missions.length,1);await call(`companies/${foreign}/autonomy/missions/${mission.id}`,'GET',undefined,'outsider',404);await call(prefix+'/'+mission.id+'/runs','GET',undefined,'outsider',404);await call(prefix+'?limit=101','GET',undefined,'owner',400);await call('agent/autonomy/tick','POST',{maxMissions:6},'agent',400);await call('agent/autonomy/tick','POST',{companyId:foreign},'agent',400);
   await query("UPDATE agents SET status='paused' WHERE id=$1",[agent]);await call('agent/autonomy/tick','POST',{},'agent',401);
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,admin,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();}}
});
