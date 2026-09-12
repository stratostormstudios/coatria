import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {database,query,transaction} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {authorizeRunTool} from '../src/lib/agent-runs';
import {dummyPasswordHash,hashToken,secret} from '../src/lib/security';
const emulator=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(url&&['127.0.0.1','localhost'].includes(new URL(url).hostname));
test('invoked agent runs enforce leases, retries, cancellation and explicit authority',{skip:!emulator&&!local,timeout:120000},async t=>{
 process.env.DATABASE_POOL_MAX=emulator?'1':'5';process.env.TRUST_PROXY='true';let stop:(()=>Promise<void>)|undefined;
 if(emulator){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const name of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile(resolve('database',name),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}else process.env.DATABASE_URL=url!;
 const companyId=randomUUID(),otherId=randomUUID(),origin='http://localhost:4180',people=Array.from({length:3},()=>({id:randomUUID(),token:secret()})),[owner,member,outsider]=people;
 const base=`companies/${companyId}`,cancelPending=()=>query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE company_id=$1 AND status IN ('queued','running')",[companyId]);let token='',agentId='';
 async function call(person:typeof owner|null,path:string,method='GET',data?:unknown,expected=200,bearerToken=token,headers:Record<string,string>={}){const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json','x-forwarded-for':companyId,...(person?{Cookie:`coatria_session=${person.token}`,'X-Coatria-User':person.id}:bearerToken?{Authorization:`Bearer ${bearerToken}`}:{ }),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})}),path.split('?')[0].split('/'));const body=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${body.error||response.status}`);return body;}
 const create=(prompt='Review this request',extra:Record<string,unknown>={},person=member)=>call(person,base+'/conversations/commons/runs','POST',{clientId:randomUUID(),agentId,prompt,...extra},201);
 const claim=(extra:Record<string,unknown>={})=>call(null,'agent/runs/claim','POST',{workerId:'fixture-worker',claimId:randomUUID(),...extra});
 try{
  for(const person of people){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[person.id,person===owner?'Run owner':person===member?'Run requester':'Other company',person.id+'@example.invalid',dummyPasswordHash]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(person.token),person.id]);}
  for(const id of[companyId,otherId])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Run fixture',$2,'blank')",[id,'runs-'+id]);
  for(const[person,id,role]of[[owner,companyId,'owner'],[member,companyId,'member'],[outsider,otherId,'owner']]as const)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[id,person.id,role]);
  const created=await call(owner,base+'/agents','POST',{name:'Leased worker',harness:'custom'},201);token=created.token;agentId=created.agent.id;
  await t.test('new credentials default to no invocation/tool grants and legacy implicit task access is closed',async()=>{
   assert.equal(created.agent.invocationAccess,'none');assert.deepEqual(created.agent.capabilities,[]);assert(Date.parse(created.agent.expiresAt)>Date.now());
   await call(member,base+'/conversations/commons/runs','POST',{clientId:randomUUID(),agentId,prompt:'Not allowed'},403);await call(null,'agent/runs/claim','POST',{workerId:'fixture',claimId:randomUUID()},403);
   for(const[path,method,data]of[['agent/work','GET',undefined],['agent/report','POST',{taskId:randomUUID(),summary:'No bypass'}]]as const)assert.equal((await call(null,path,method,data,410)).code,'AGENT_RUN_REQUIRED');
   await call(member,base+'/agents/'+agentId,'PATCH',{invocationAccess:'members',capabilities:['workspace.read']},403);
   await call(owner,base+'/agents/'+agentId,'PATCH',{invocationAccess:'members',capabilities:['workspace.read']});
  });
  await t.test('human requests are tenant-bound, idempotent and contain no lease material',async()=>{
   const clientId=randomUUID(),body={clientId,agentId,prompt:'A durable request'};const first=await call(member,base+'/conversations/commons/runs','POST',body,201),again=await call(member,base+'/conversations/commons/runs','POST',body);assert.equal(first.run.id,again.run.id);assert.equal(again.replayed,true);assert.equal(first.run.requestedBy,member.id);assert(!JSON.stringify(first).includes('leaseToken'));
   assert.equal((await call(member,base+'/conversations/commons/runs','POST',{...body,prompt:'Different'},409)).code,'IDEMPOTENCY_CONFLICT');
   await call(outsider,base+'/agent-runs/'+first.run.id,'GET',undefined,404);await call(member,base+'/conversations/commons/runs','POST',{clientId:randomUUID(),agentId,prompt:'Forged'},403,token,{Origin:'https://outside.example'});
   const listed=await call(member,base+'/agent-runs?agentId='+agentId);assert(listed.runs?.some((run:{id:string})=>run.id===first.run.id));await cancelPending();
  });
  await t.test('competing workers get one lease and retries recover the same proof without extending expiry',async()=>{
   const queued=await create(),claimId=randomUUID();const responses=await Promise.all([claim({claimId,workerId:'one'}),claim({workerId:'two'})]);assert.equal(responses.filter(response=>response.run).length,1);const held=responses.find(response=>response.run)!;assert.equal(held.run.id,queued.run.id);assert.equal(held.run.attempts,1);
   if(responses[0].run){const replay=await claim({claimId,workerId:'one'});assert.equal(replay.leaseToken,held.leaseToken);assert.equal(replay.leaseExpiresAt,held.leaseExpiresAt);await call(null,'agent/runs/claim','POST',{claimId,workerId:'someone-else'},409);}
   const stored=(await query('SELECT lease_token_hash FROM agent_runs WHERE id=$1',[queued.run.id])).rows[0];assert.equal(stored.lease_token_hash,hashToken(held.leaseToken));assert.notEqual(stored.lease_token_hash,held.leaseToken);
   const context=await call(null,`agent/runs/${queued.run.id}/context`,'GET',undefined,200,token,{'X-Coatria-Run-Lease':held.leaseToken});assert.equal(context.run.prompt,'Review this request');assert.deepEqual(context.capabilities,['workspace.read']);assert(!JSON.stringify(context).includes('password_hash'));
   await call(null,`agent/runs/${queued.run.id}/heartbeat`,'POST',{leaseToken:'not-the-actual-lease-proof'},409);await cancelPending();
  });
  await t.test('cancellation fences late heartbeats, tool calls and completion',async()=>{
   const queued=await create(),held=await claim();await call(outsider,base+'/agent-runs/'+queued.run.id+'/cancel','POST',{},404);await call(member,base+'/agent-runs/'+queued.run.id+'/cancel','POST',{});await call(member,base+'/agent-runs/'+queued.run.id+'/cancel','POST',{});
   assert.equal((await call(null,`agent/runs/${queued.run.id}/heartbeat`,'POST',{leaseToken:held.leaseToken},409)).code,'RUN_CANCELLED');await call(null,`agent/runs/${queued.run.id}/complete`,'POST',{leaseToken:held.leaseToken,clientId:randomUUID(),result:'Too late'},409);
   const identity=(await query('SELECT * FROM agents WHERE id=$1',[agentId])).rows[0];await assert.rejects(()=>transaction(client=>authorizeRunTool(client,identity as any,queued.run.id,held.leaseToken)),{code:'RUN_CANCELLED'});
   assert.equal((await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1 AND body=$2',[companyId,'Too late'])).rows[0].count,0);
  });
  await t.test('expired leases are requeued with a new fence, and failure retries stop after three attempts',async()=>{
   const queued=await create(),old=await claim();await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[queued.run.id]);await claim();await query("UPDATE agent_runs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[queued.run.id]);const next=await claim();assert.equal(next.run.attempts,2);assert.notEqual(next.leaseToken,old.leaseToken);
   await call(null,`agent/runs/${queued.run.id}/heartbeat`,'POST',{leaseToken:old.leaseToken},409);
   const failureId=randomUUID(),failed=await call(null,`agent/runs/${queued.run.id}/fail`,'POST',{leaseToken:next.leaseToken,clientId:failureId,error:'Transient worker failure'});assert.equal(failed.run.status,'queued');const replay=await call(null,`agent/runs/${queued.run.id}/fail`,'POST',{leaseToken:next.leaseToken,clientId:failureId,error:'Transient worker failure'});assert.equal(replay.replayed,true);
   await query("UPDATE agent_runs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[queued.run.id]);const final=await claim();assert.equal(final.run.attempts,3);const terminal=await call(null,`agent/runs/${queued.run.id}/fail`,'POST',{leaseToken:final.leaseToken,clientId:randomUUID(),error:'Final attempt failed'});assert.equal(terminal.run.status,'failed');assert.equal((await claim()).run,null);
  });
  await t.test('completion is atomic with an agent-attributed reply and retry never posts twice',async()=>{
   const parent=(await call(member,base+'/conversations/commons/messages','POST',{clientId:randomUUID(),body:'Please review this thread'},201)).message;
   const queued=await create('Thread work',{parentId:parent.id}),held=await claim(),body={leaseToken:held.leaseToken,clientId:randomUUID(),result:'A completed independent agent result',artifactUrl:'https://example.test/result'};
   const done=await call(null,`agent/runs/${queued.run.id}/complete`,'POST',body),again=await call(null,`agent/runs/${queued.run.id}/complete`,'POST',body);assert.equal(done.run.status,'succeeded');assert.equal(again.replayed,true);assert.equal(done.run.resultMessageId,again.run.resultMessageId);
   const message=(await query('SELECT actor_kind,agent_id,user_id,parent_id,body FROM messages WHERE id=$1',[done.run.resultMessageId])).rows[0];assert.deepEqual(message,{actor_kind:'agent',agent_id:agentId,user_id:null,parent_id:parent.id,body:body.result});assert.equal((await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1 AND body=$2',[companyId,body.result])).rows[0].count,1);
   await call(null,`agent/runs/${queued.run.id}/complete`,'POST',{...body,result:'Different retry'},409);await call(member,base+'/agent-runs/'+queued.run.id+'/cancel','POST',{},409);
   assert.equal((await query('SELECT conversation_access FROM agents WHERE id=$1',[agentId])).rows[0].conversation_access,'none');
  });
  await t.test('current grants intersect the original run snapshot and requester demotion revokes access',async()=>{
   const queued=await create(),held=await claim();await call(owner,base+'/agents/'+agentId,'PATCH',{capabilities:['workspace.read','office.write']});let context=await call(null,`agent/runs/${queued.run.id}/context`,'GET',undefined,200,token,{'X-Coatria-Run-Lease':held.leaseToken});assert.deepEqual(context.capabilities,['workspace.read']);
   await call(owner,base+'/agents/'+agentId,'PATCH',{capabilities:[]});context=await call(null,`agent/runs/${queued.run.id}/context`,'GET',undefined,200,token,{'X-Coatria-Run-Lease':held.leaseToken});assert.deepEqual(context.capabilities,[]);
   await call(owner,base+'/agents/'+agentId,'PATCH',{invocationAccess:'admins'});await call(null,`agent/runs/${queued.run.id}/heartbeat`,'POST',{leaseToken:held.leaseToken},403);assert.equal((await call(member,base+'/agent-runs/'+queued.run.id)).run.status,'cancelled');await call(owner,base+'/agents/'+agentId,'PATCH',{invocationAccess:'members',capabilities:['workspace.read']});
  });
  await t.test('heartbeat cannot extend the hard execution deadline',async()=>{
   const queued=await create(),held=await claim();await query("UPDATE agent_runs SET started_at=clock_timestamp()-interval '31 minutes' WHERE id=$1",[queued.run.id]);await call(null,`agent/runs/${queued.run.id}/heartbeat`,'POST',{leaseToken:held.leaseToken},409);await claim();assert.equal((await call(member,base+'/agent-runs/'+queued.run.id)).run.status,'failed');
  });
  await t.test('token rotation, expiry and requester offboarding invalidate leased access',async()=>{
   const queued=await create(),held=await claim(),oldToken=token;const rotated=await call(owner,base+'/agents/'+agentId+'/rotate','POST',{expiresInDays:7});token=rotated.token;assert.notEqual(oldToken,token);assert.equal((await call(member,base+'/agent-runs/'+queued.run.id)).run.status,'cancelled');await call(null,'agent/runs/claim','POST',{workerId:'fixture',claimId:randomUUID()},401,oldToken);
   const next=await create(),nextHeld=await claim();await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[companyId,member.id]);await call(null,`agent/runs/${next.run.id}/heartbeat`,'POST',{leaseToken:nextHeld.leaseToken},403);await claim();assert.equal((await call(owner,base+'/agent-runs/'+next.run.id)).run.status,'cancelled');
   await query("UPDATE agents SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[agentId]);await call(null,'agent/runs/claim','POST',{workerId:'fixture',claimId:randomUUID()},401);assert(held.leaseToken);
  });
 }finally{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[companyId,otherId]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[people.map(person=>person.id)]);await database().end();delete(globalThis as any).coatriaPool;if(stop)await stop();}
});
