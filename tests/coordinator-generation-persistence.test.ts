import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('migration034 preserves prior approvals and defers exact same-identity generation constraints',async()=>{
 const db=await PGlite.create(),company=randomUUID(),owner=randomUUID(),agent=randomUUID(),project=randomUUID(),conversation=randomUUID();
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const insert=async(table:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row));};
 try{
  for(const name of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)&&name<'034_').sort())await db.exec(await readFile('database/'+name,'utf8'));
  await insert('users',{id:owner,name:'Synthetic migration owner',email:owner+'@example.invalid',password_hash:'not-a-login'});
  await insert('companies',{id:company,name:'Synthetic migration studio',slug:company,template:'blank'});
  await insert('agents',{id:agent,company_id:company,name:'One reviewed identity',harness:'custom',token_hash:hash(agent),created_by:owner});
  await insert('conversations',{id:conversation,company_id:company});
  await insert('studio_profiles',{company_id:company,template_id:'ai-production',template_version:1,created_by:owner});
  await insert('studio_projects',{id:project,company_id:company,name:'Generated fixture',client_name:'Internal',brief:'Synthetic approved plan',ai_policy:'allowed',created_by:owner,production_path:'higgsfield',contract_version:2,spec:JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}})});
  await insert('studio_role_bindings',{company_id:company,role_key:'comp',agent_id:agent});
  await insert('studio_coordination_policies',{company_id:company,project_id:project,coordinator_agent_id:agent,approved_by:owner,status:'active',allowed_role_keys:'["comp"]',profile_revision:1,authority_snapshot:'{"reviewed":"unchanged"}',max_runs:10,runs_started:2,max_concurrent_runs:1,expires_at:'2099-01-01T00:00:00Z',generated_continuations:true});
  const requestId=randomUUID();await insert('studio_requests',{company_id:company,actor_key:'human:'+owner,client_id:requestId,request_hash:hash('original reviewed request'),response:'{"policy":{"generatedContinuations":true}}'});
  const before=(await db.query<{value:string}>('SELECT to_jsonb(p)::text AS value FROM studio_coordination_policies p WHERE company_id=$1',[company])).rows[0].value;
  const receipt=(await db.query<{value:string}>('SELECT to_jsonb(r)::text AS value FROM studio_requests r WHERE company_id=$1',[company])).rows[0].value;
  await db.exec(await readFile('database/034_studio_coordinator_generation.sql','utf8'));
  const after=(await db.query<{coordinator_generation:boolean;value:string}>("SELECT coordinator_generation,(to_jsonb(p)-'coordinator_generation')::text AS value FROM studio_coordination_policies p WHERE company_id=$1",[company])).rows[0];
  assert.equal(after.coordinator_generation,false);assert.equal(after.value,before);
  assert.equal((await db.query<{value:string}>('SELECT to_jsonb(r)::text AS value FROM studio_requests r WHERE company_id=$1',[company])).rows[0].value,receipt);
  const run=async(status:'running'|'queued',attempts=1)=>{const id=randomUUID();await insert('agent_runs',{id,company_id:company,agent_id:agent,requested_by:owner,conversation_id:conversation,client_id:randomUUID(),payload_hash:hash(id),prompt:'Synthetic migration proof',status,max_attempts:attempts,...status==='running'?{worker_id:'fixture',lease_token_hash:hash('fixture'),lease_expires_at:'2099-01-01T00:00:00Z'}:{}});return id;};
  const dispatch=async(options:{planning?:boolean;attempts?:number;reuseParent?:boolean}={})=>{
   const task=randomUUID(),work=randomUUID(),parent=await run('running'),child=options.reuseParent?parent:await run('queued',options.attempts??1);
   await insert('tasks',{id:task,company_id:company,title:'Synthetic isolated work',created_by:owner});
   await insert('studio_work_items',{id:work,company_id:company,project_id:project,task_id:task,logical_key:work,stage:options.planning?'estimate':'generation',role_key:'comp',execution:options.planning?'agent':'creative'});
   await db.exec('BEGIN');
   try{await insert('studio_coordination_dispatches',{company_id:company,project_id:project,work_item_id:work,parent_run_id:parent,child_run_id:child,coordinator_agent_id:agent,specialist_agent_id:agent,policy_revision:1});await db.exec('COMMIT');}
   catch(error){await db.exec('ROLLBACK');throw error;}
  };
  const rejects=(action:()=>Promise<unknown>)=>assert.rejects(action,(error:unknown)=>typeof error==='object'&&error!==null&&'code'in error&&error.code==='23514');
  await rejects(()=>dispatch());
  await db.query('UPDATE studio_coordination_policies SET coordinator_generation=true WHERE company_id=$1',[company]);
  await dispatch();
  await rejects(()=>dispatch({planning:true}));await rejects(()=>dispatch({attempts:3}));await rejects(()=>dispatch({reuseParent:true}));
  assert.equal((await db.query<{count:number}>('SELECT count(*)::int AS count FROM studio_coordination_dispatches WHERE company_id=$1',[company])).rows[0].count,1);
 }finally{await db.close();}
});
