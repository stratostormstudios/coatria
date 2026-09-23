import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {handleApi} from '../src/lib/api';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {taskPatch} from '../src/lib/model';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';

test('human task writes require an explicit revision in validation and published API',()=>{
 for(const status of ['doing','review','done']){
  for(const expectedRevision of [undefined,null,'1',0,-1,1.5,Number.MAX_SAFE_INTEGER])assert.equal(taskPatch.safeParse({status,expectedRevision}).success,false);
  assert.equal(taskPatch.safeParse({status,expectedRevision:1}).success,true);
 }
 assert.equal(taskPatch.safeParse({expectedRevision:1}).success,false);
 const endpoint=(agentRuntimeOpenApi.paths as Record<string,any>)['/api/companies/{companyId}/tasks/{taskId}'];
 assert.deepEqual(endpoint.patch.security,[{sessionCookie:[]}]);assert.deepEqual(endpoint.get.security,[{sessionCookie:[]}]);
 assert(endpoint.patch.requestBody.content['application/json'].schema.required.includes('expectedRevision'));
 for(const operation of [endpoint.get,endpoint.patch])assert(operation.responses['200'].content['application/json'].schema.properties.task.required.includes('revision'));
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('human task API fences stale review decisions and competing mutations atomically',{skip:!emulate&&!url,timeout:120000},async t=>{
 process.env.DATABASE_URL=url;process.env.DATABASE_POOL_MAX=emulate?'1':'5';
 let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const f of(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile('database/'+f,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),users={worker:randomUUID(),reviewer:randomUUID(),otherReviewer:randomUUID(),outsider:randomUUID()},sessions={worker:randomUUID(),reviewer:randomUUID(),otherReviewer:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180';
 type Actor=keyof typeof users;
 async function request(actor:Actor,path:string,method='GET',payload?:unknown){const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Cookie:'coatria_session='+sessions[actor],Origin:origin,'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('/'));return {status:response.status,data:await response.json()};}
 const path=(taskId:string,companyId=company)=>`companies/${companyId}/tasks/${taskId}`;
 async function patch(actor:Actor,taskId:string,payload:unknown,expected=200){const result=await request(actor,path(taskId),'PATCH',payload);assert.equal(result.status,expected,JSON.stringify(result.data));return result.data;}
 async function create(){const response=await request('worker',`companies/${company}/tasks`,'POST',{title:'Exact revision fixture',assigneeId:users.worker});assert.equal(response.status,201);assert.equal(response.data.task.revision,1);return response.data.task;}
 async function submitted(){const task=await create();return (await patch('worker',task.id,{expectedRevision:task.revision,status:'review',submissionUrl:'https://example.invalid/original'})).task;}
 async function state(taskId:string){return {task:(await query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows,authors:(await query('SELECT * FROM task_authors WHERE task_id=$1 ORDER BY user_id',[taskId])).rows,activity:(await query('SELECT * FROM activity WHERE company_id=$1 ORDER BY id',[company])).rows};}
 try{
  for(const [name,id] of Object.entries(users)){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,name,id+'@example.invalid','fixture']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[name as Actor]),id]);}
  for(const id of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Revision fixture',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'admin'),($5,$6,'owner')",[company,users.worker,users.reviewer,users.otherReviewer,foreign,users.outsider]);
  await t.test('GET and workspace expose revisions without crossing tenant boundaries',async()=>{
   const task=await create(),read=await request('reviewer',path(task.id));assert.equal(read.status,200);assert.deepEqual(read.data.task,task);
   const workspace=await request('reviewer',`companies/${company}/workspace`);assert.equal(workspace.data.tasks.find((item:any)=>item.id===task.id).revision,1);
   assert.equal((await request('outsider',path(task.id))).status,404);assert.equal((await request('outsider',path(task.id,foreign))).status,404);
   assert.equal((await request('outsider',path(task.id,foreign),'PATCH',{expectedRevision:1,status:'doing'})).status,404);
  });
  await t.test('missing preconditions cannot accept, submit or edit and cannot leave side effects',async()=>{
   const task=await submitted(),before=await state(task.id);
   for(const payload of [{status:'done'},{status:'doing'},{reviewNote:'Unversioned review'},{expectedRevision:0,status:'done'},{expectedRevision:task.revision}])await patch('reviewer',task.id,payload,400);
   assert.deepEqual(await state(task.id),before);
  });
  await t.test('a stale decision cannot accept a returned, edited and resubmitted outcome',async()=>{
   const old=await submitted();let current=(await patch('worker',old.id,{expectedRevision:old.revision,status:'doing'})).task;
   current=(await patch('worker',old.id,{expectedRevision:current.revision,submissionUrl:'https://example.invalid/replacement'})).task;
   current=(await patch('worker',old.id,{expectedRevision:current.revision,status:'review'})).task;
   const before=await state(old.id);
   for(const status of ['done','doing'])assert.equal((await patch('reviewer',old.id,{expectedRevision:old.revision,status,reviewNote:'Decision for original bytes'},409)).code,'TASK_REVISION_CONFLICT');
   assert.deepEqual(await state(old.id),before);
   const accepted=(await patch('reviewer',old.id,{expectedRevision:current.revision,status:'done',reviewNote:'Reviewed the replacement contribution'})).task;
   assert.equal(accepted.approvedBy,users.reviewer);assert.equal(accepted.submissionUrl,current.submissionUrl);assert.equal(accepted.revision,current.revision+1);
   await patch('reviewer',old.id,{expectedRevision:accepted.revision,title:'Rewrite accepted work'},409);
  });
  await t.test('independence and submitted-work immutability still apply with the correct revision',async()=>{
   const task=await submitted(),before=await state(task.id);
   await patch('worker',task.id,{expectedRevision:task.revision,status:'done'},403);
   await patch('reviewer',task.id,{expectedRevision:task.revision,status:'done',submissionUrl:'https://example.invalid/changed'},400);
   await patch('reviewer',task.id,{expectedRevision:task.revision,title:'Change during review'},409);
   assert.deepEqual(await state(task.id),before);
  });
  await t.test('competing accept/reopen requests from the same snapshot commit at most one decision',async()=>{
   for(let i=0;i<4;i++){
    const task=await submitted(),before=await state(task.id);
    const accept=()=>request('reviewer',path(task.id),'PATCH',{expectedRevision:task.revision,status:'done',reviewNote:'Exact contribution reviewed'});
    const reopen=()=>request('worker',path(task.id),'PATCH',{expectedRevision:task.revision,status:'doing'});
    const results=await Promise.all(i%2?[reopen(),accept()]:[accept(),reopen()]);
    assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);assert.equal(results.find(result=>result.status===409)!.data.code,'TASK_REVISION_CONFLICT');
    const after=await state(task.id),winner=results.find(result=>result.status===200)!.data.task;
    assert.equal(after.task[0].revision,task.revision+1);assert.equal(after.task[0].status,winner.status);assert.equal(after.activity.length,before.activity.length+1);assert.deepEqual(after.authors,before.authors);
    assert.equal(after.task[0].approved_by,winner.status==='done'?users.reviewer:null);
   }
  });
  await t.test('two independent acceptances cannot overwrite the winning reviewer or add a second receipt',async()=>{
   const task=await submitted(),before=await state(task.id);
   const results=await Promise.all((['reviewer','otherReviewer'] as const).map(actor=>request(actor,path(task.id),'PATCH',{expectedRevision:task.revision,status:'done',reviewNote:actor+' reviewed this revision'})));
   assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);const winner=results.find(result=>result.status===200)!.data.task,after=await state(task.id);
   assert.equal(after.task[0].approved_by,winner.approvedBy);assert.equal(after.task[0].review_note,winner.reviewNote);assert.equal(after.task[0].revision,task.revision+1);assert.equal(after.activity.length,before.activity.length+1);
  });
  await t.test('PostgreSQL compares the revision after waiting for a concurrent editor row lock',{skip:emulate},async()=>{
   const task=await submitted(),holder=await database().connect();let pending:ReturnType<typeof request>|undefined;
   try{
    await holder.query('BEGIN');const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[task.id]);
    pending=request('reviewer',path(task.id),'PATCH',{expectedRevision:task.revision,status:'done',reviewNote:'Decision made before concurrent edit'});
    let waiting=false;const deadline=Date.now()+5000;
    while(Date.now()<deadline){waiting=(await query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert(waiting,'The acceptance must actually wait for the held task lock.');
    await holder.query("UPDATE tasks SET revision=revision+1,submission_url='https://example.invalid/concurrent',updated_at=now() WHERE id=$1",[task.id]);
    await holder.query('COMMIT');const result=await pending;assert.equal(result.status,409);assert.equal(result.data.code,'TASK_REVISION_CONFLICT');
    const stored=(await query('SELECT status,approved_by,revision,submission_url FROM tasks WHERE id=$1',[task.id])).rows[0];
    assert.equal(stored.status,'review');assert.equal(stored.approved_by,null);assert.equal(stored.revision,task.revision+1);assert.equal(stored.submission_url,'https://example.invalid/concurrent');
   }finally{await holder.query('ROLLBACK');holder.release();await pending;}
  });
 }finally{
  try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[Object.values(users)]);}finally{await database().end();await stop?.();}
 }
});
