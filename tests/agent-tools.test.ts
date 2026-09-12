import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {AGENT_CAPABILITIES} from '../src/lib/agent-policy';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('leased tools enforce authority, durable effects, review boundaries and isolated resource projections',{skip:!emulate&&!url,timeout:120000},async t=>{
 process.env.DATABASE_URL=url;process.env.DATABASE_POOL_MAX='1';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const f of(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile('database/'+f,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID(),reviewer=randomUUID(),outsider=randomUUID(),agent=randomUUID(),token='ca_'+randomUUID(),sessions={owner:randomUUID(),member:randomUUID(),reviewer:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180';let runId='',leaseToken='';
 async function call(path:string,method='GET',payload?:unknown,actor:'owner'|'member'|'reviewer'|'outsider'|'agent'='agent',expected=200){const headers:Record<string,string>={};if(actor==='agent')headers.Authorization='Bearer '+token;else{headers.Cookie='coatria_session='+sessions[actor];headers.Origin=origin;}if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('?')[0].split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;}
 const tool=(name:string,args:unknown,expected=200,requestId=randomUUID())=>call('agent/tools/'+name,'POST',{runId,leaseToken,requestId,arguments:args},'agent',expected);
 try{
  for(const [userId,name]of[[owner,'Owner'],[member,'Requester'],[reviewer,'Independent reviewer'],[outsider,'Outsider']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','fixture']);
  for(const[id,c]of[[company,'Tools company'],[foreign,'Foreign company']])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')",[id,c,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'admin'),($5,$6,'owner')",[company,owner,member,reviewer,foreign,outsider]);
  for(const[k,id]of Object.entries({owner,member,reviewer,outsider}))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[k as keyof typeof sessions]),id]);
  await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Worker','custom',$3,$4,'members',$5)",[agent,company,hashToken(token),owner,JSON.stringify(AGENT_CAPABILITIES)]);
  const created=await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:agent,prompt:'Prepare a reviewed workspace update'},'member',201);runId=created.run.id;
  const claim=await call('agent/runs/claim','POST',{workerId:'tools-fixture',claimId:randomUUID()});assert.equal(claim.run.id,runId);leaseToken=claim.leaseToken;
  await t.test('discovery is scoped and private resources cannot be reached through arguments',async()=>{
   const catalog=await call('agent/tools');assert.equal(catalog.tools.length,18);assert(catalog.tools.every((x:any)=>x.inputSchema.type==='object'));
   const people=(await tool('people_list',{})).result;assert.equal(people.items.length,3);assert(!JSON.stringify(people).includes('@example.invalid'));
   await tool('workspace_get',{companyId:foreign},400);await tool('vault_export',{},404);await tool('people_list',{limit:101},400);
   assert.equal((await tool('workspace_get',{})).result.company.id,company);
  });
  let task:any;
  await t.test('a member cannot borrow the sponsor’s authority to claim another person’s task',async()=>{
   const otherTask=(await call(`companies/${company}/tasks`,'POST',{title:'Owner task'},'owner',201)).task;
   await tool('tasks_claim',{taskId:otherTask.id,revision:1},403);
   const mine=(await call(`companies/${company}/tasks`,'POST',{title:'Requester task'},'member',201)).task;
   const claimed=(await tool('tasks_claim',{taskId:mine.id,revision:1})).result;assert.equal(claimed.agentRunId,runId);
   await call(`companies/${company}/tasks/${mine.id}`,'PATCH',{title:'Human takes over'},'member');
   await tool('tasks_update',{taskId:mine.id,revision:claimed.revision+1,status:'doing'},403);
  });
  await t.test('same tool operation retries once and a different payload conflicts',async()=>{
   const key=randomUUID(),args={title:'Worker deliverable',description:'Review before acceptance'};const first=await tool('tasks_create',args,200,key),again=await tool('tasks_create',args,200,key);assert.equal(again.replayed,true);assert.equal(first.result.id,again.result.id);task=first.result;await tool('tasks_create',{...args,title:'Changed'},409,key);
   assert.equal((await query('SELECT count(*)::int AS count FROM tasks WHERE company_id=$1 AND title=$2',[company,args.title])).rows[0].count,1);
  });
  await t.test('task revisions and independent approval apply to agent authorship',async()=>{
   task=(await tool('tasks_update',{taskId:task.id,revision:task.revision,status:'doing'})).result;await tool('tasks_update',{taskId:task.id,revision:1,title:'Stale'},409);
   task=(await tool('tasks_submit',{taskId:task.id,revision:task.revision,summary:'Ready for review',tokensUsed:123})).result;assert.equal(task.status,'review');await tool('tasks_update',{taskId:task.id,revision:task.revision,title:'Overwrite'},409);
   await call(`companies/${company}/tasks/${task.id}`,'PATCH',{status:'done'},'owner',403);await call(`companies/${company}/tasks/${task.id}`,'PATCH',{status:'done'},'member',403);await call(`companies/${company}/tasks/${task.id}`,'PATCH',{status:'done'},'reviewer');
  });
  await t.test('infrastructure returns metadata only and refuses foreign or revoked drives',async()=>{
   const d=randomUUID(),f=randomUUID();for(const[drive,c,user]of[[d,company,owner],[f,foreign,outsider]])await query("INSERT INTO drives(id,company_id,name,token_hash,created_by) VALUES($1,$2,'Private footage',$4,$3)",[drive,c,user,hashToken(drive)]);
   await query("INSERT INTO drive_files(drive_id,path,size,modified_at) VALUES($1,'footage/take-01.mov',9223372036854775,now())",[d]);
   const files=(await tool('infrastructure_files',{driveId:d})).result;assert.equal(files.items[0].sizeBytes,'9223372036854775');assert(!JSON.stringify(files).includes('token'));
   await tool('infrastructure_files',{driveId:f},404);await query("UPDATE drives SET status='revoked' WHERE id=$1",[d]);await tool('infrastructure_files',{driveId:d},404);
  });
  await t.test('presence controls only the agent, validates floor bounds and room ownership',async()=>{
   const pos=(await tool('office_presence',{roomId:null,x:0,z:0,status:'focus'})).result;assert.equal(pos.agentId,agent);assert.equal((await query('SELECT count(*)::int AS count FROM presence WHERE company_id=$1',[company])).rows[0].count,0);
   await tool('office_presence',{roomId:null,x:20,z:20,status:'focus'},400);await tool('office_presence',{roomId:randomUUID(),x:0,z:0,status:'focus'},404);
  });
  await t.test('proposals do not mutate until an administrator reviews the exact change',async()=>{
   const result=(await tool('rooms_propose',{name:'Review room',kind:'meeting',capacity:12})).result;assert.equal((await query('SELECT count(*)::int AS count FROM rooms WHERE company_id=$1',[company])).rows[0].count,0);
   const endpoint=`companies/${company}/agent-proposals/${result.id}/approve`;await call(endpoint,'POST',{},'member',403);await call(endpoint,'POST',{},'outsider',404);
   const applied=await call(endpoint,'POST',{},'reviewer');assert.equal(applied.proposal.status,'applied');const replay=await call(endpoint,'POST',{},'reviewer');assert.equal(replay.replayed,true);assert.equal((await query('SELECT count(*)::int AS count FROM rooms WHERE company_id=$1',[company])).rows[0].count,1);
   const opening=(await tool('hiring_propose',{title:'Editor',description:'Edit footage',type:'human',compensation:'paid',budget:'Agreed separately'})).result;await call(`companies/${company}/agent-proposals/${opening.id}/approve`,'POST',{},'reviewer');assert.equal((await query('SELECT status FROM openings WHERE company_id=$1',[company])).rows[0].status,'draft');
  });
  await t.test('layout approvals reject stale revision and reduced grants',async()=>{
   const floor=(await tool('layout_get',{})).result,payload={layout:[],floor:floor.floor,revision:floor.revision};const proposal=(await tool('layout_propose',payload)).result;
   await call(`companies/${company}/layout`,'PATCH',payload,'reviewer');await call(`companies/${company}/agent-proposals/${proposal.id}/approve`,'POST',{},'reviewer',409);
   const room=(await tool('rooms_propose',{name:'Unapproved',kind:'focus',capacity:2})).result;await query("UPDATE agents SET capabilities='[\"workspace.read\"]'::jsonb WHERE id=$1",[agent]);await tool('tasks_create',{title:'No grant'},403);await call(`companies/${company}/agent-proposals/${room.id}/approve`,'POST',{},'reviewer',409);
  });
  await t.test('cancellation fences reads and writes and legacy endpoints cannot bypass it',async()=>{
   await call(`companies/${company}/agent-runs/${runId}/cancel`,'POST',{},'member');await tool('workspace_get',{},409);
   await tool('tasks_create',{title:'After cancellation'},409);
   await call('agent/work','GET',undefined,'agent',410);await call('agent/report','POST',{taskId:task.id,summary:'Legacy bypass'},'agent',410);
  });
 }catch(error){console.error('Agent tools fixture failed',error);throw error;}finally{
  try{await query('DELETE FROM agent_proposals WHERE company_id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member,reviewer,outsider]]);}finally{await database().end();await stop?.();}
 }
});
