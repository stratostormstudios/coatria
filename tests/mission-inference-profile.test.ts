import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database,query} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {inferMissionRunProfile,missionCreateInput,missionPatchInput} from '../src/lib/agent-missions';
import {missionInferenceProfileSchema} from '../src/lib/mission-inference-profile';

const profile=(projectId=randomUUID())=>({kind:'studio_generated_coordinator' as const,version:1 as const,projectId});
const migrationNames=async()=>(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort();
test('typed mission profiles are explicit and preserve omitted legacy request hashing',()=>{
 const input={clientId:randomUUID(),agentId:randomUUID(),name:'Legacy mission',objective:'Existing work'};
 const legacy={...input,intervalMinutes:60,maxCycles:5,status:'paused'};
 assert.equal(JSON.stringify(missionCreateInput.parse(input)),JSON.stringify(legacy));
 assert.equal(hashToken(JSON.stringify(missionCreateInput.parse(input))),hashToken(JSON.stringify(legacy)));
 assert.equal('inferenceProfile' in missionCreateInput.parse(input),false);
 assert.equal(missionCreateInput.parse({...input,inferenceProfile:null}).inferenceProfile,null);
 assert.deepEqual(missionPatchInput.parse({revision:1,inferenceProfile:null}),{revision:1,inferenceProfile:null});
});

test('unknown or malformed profiles fail closed rather than selecting the legacy catalogue',async()=>{
 const selected=profile();
 assert.deepEqual(missionInferenceProfileSchema.parse(selected),selected);
 for(const value of [{...selected,version:2},{...selected,kind:'prompt_selected'},{...selected,projectId:'not-a-uuid'},{...selected,tools:['*']},{kind:selected.kind,version:1},[],null])assert.equal(missionInferenceProfileSchema.safeParse(value).success,false);
 const run={id:randomUUID(),company_id:randomUUID(),agent_id:randomUUID(),requested_by:randomUUID()};
 const client=(row:unknown)=>({query:async()=>({rows:row?[row]:[]})}) as any;
 assert.equal(await inferMissionRunProfile(client(null),run),null);
 assert.equal(await inferMissionRunProfile(client({inference_profile:null}),run),null);
 const row={inference_profile:selected,mission_agent_id:run.agent_id,run_agent_id:run.agent_id,mission_author_id:run.requested_by,run_requester_id:run.requested_by,cycle_client_id:'same',run_client_id:'same',purpose:'task'};
 assert.deepEqual(await inferMissionRunProfile(client(row),run),selected);
 for(const changed of [{inference_profile:{}},{inference_profile:{...selected,version:2}},{mission_agent_id:randomUUID()},{run_requester_id:randomUUID()},{mission_author_id:null},{cycle_client_id:'different'},{purpose:'mention'}])await assert.rejects(()=>inferMissionRunProfile(client({...row,...changed}),run),(error:any)=>error.code==='MISSION_INFERENCE_PROFILE_INVALID');
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('mission API snapshots a validated coordinator profile without changing legacy or historical cycles',{skip:!emulate&&!url,timeout:120000},async t=>{
 process.env.DATABASE_URL=url;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const name of await migrationNames())await db.exec(await readFile('database/'+name,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID(),agent=randomUUID(),other=randomUUID(),projectId=randomUUID(),legacyProject=randomUUID(),foreignProject=randomUUID(),session=randomUUID(),memberSession=randomUUID();
 const selected=profile(projectId),origin='http://localhost:4180',prefix=`companies/${company}/autonomy/missions`;
 const base=()=>({clientId:randomUUID(),agentId:agent,name:'Generated coordinator',objective:'Coordinate the approved generated project',maxCycles:5});
 let mission:any,firstRun:string,firstClientId:string;
 async function call(path:string,method='GET',body?:unknown,expected=200,asMember=false){const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Cookie:'coatria_session='+(asMember?memberSession:session),Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),path.split('?')[0].split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;}
 async function patch(body:Record<string,unknown>){mission=(await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,...body})).mission;return mission;}
 async function tick(){const response=await handleApi(new Request(origin+'/api/agent/autonomy/tick',{method:'POST',headers:{Authorization:'Bearer ca_'+agent,'Content-Type':'application/json'},body:'{}'}),['agent','autonomy','tick']);const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
 const readRun=async(id:string)=>(await query('SELECT * FROM agent_runs WHERE company_id=$1 AND id=$2',[company,id])).rows[0];
 const resolve=async(run:Record<string,unknown>)=>{const client=await database().connect();try{return await inferMissionRunProfile(client,run);}finally{client.release();}};
 try{
  for(const id of [owner,member])await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic profile test',$2,'not-a-login')",[id,id+'@example.invalid']);
  for(const id of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic profile company',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$2,'owner')",[company,owner,member,foreign]);
  for(const [token,user] of [[session,owner],[memberSession,member]])await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(token),user]);
  for(const id of [agent,other])await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic coordinator','custom',$3,$4,'admins','[\"workspace.read\",\"tasks.write\"]')",[id,company,hashToken('ca_'+id),owner]);
  for(const id of [company,foreign])await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[id,owner]);
  const spec=JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}});
  for(const [id,c,version]of[[projectId,company,2],[legacyProject,company,1],[foreignProject,foreign,2]])await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,ai_policy,created_by,production_path,contract_version,spec) VALUES($1,$2,'Synthetic generated project','Fixture','No real generation','allowed',$3,'higgsfield',$4,$5)",[id,c,owner,version,spec]);
  await query("INSERT INTO studio_role_bindings(company_id,role_key,agent_id) VALUES($1,'producer',$2)",[company,agent]);
  await t.test('creation validates project, schema and staffing, including paused missions',async()=>{
   await call(prefix,'POST',{...base(),inferenceProfile:selected},403,true);
   for(const p of [profile(randomUUID()),profile(foreignProject),profile(legacyProject)])assert.equal((await call(prefix,'POST',{...base(),inferenceProfile:p},409)).code,'MISSION_INFERENCE_PROJECT_REQUIRED');
   assert.equal((await call(prefix,'POST',{...base(),agentId:other,inferenceProfile:selected},409)).code,'MISSION_INFERENCE_COORDINATOR_REQUIRED');
   await call(prefix,'POST',{...base(),inferenceProfile:{...selected,extra:true}},400);
   const request={...base(),inferenceProfile:selected};mission=(await call(prefix,'POST',request,201)).mission;
   assert.equal(mission.status,'paused');assert.deepEqual(mission.inferenceProfile,selected);
   assert.equal((await call(prefix,'POST',request)).mission.id,mission.id);
   assert.equal((await call(prefix,'POST',{...request,inferenceProfile:null},409)).code,'IDEMPOTENCY_CONFLICT');
  });
  await t.test('activation and dispatch recheck staffing, then persist the exact run identity',async()=>{
   await query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,other]);
   assert.equal((await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,status:'active'},409)).code,'MISSION_INFERENCE_COORDINATOR_REQUIRED');
   await query("UPDATE studio_role_bindings SET agent_id=$2,role_key='coordinator' WHERE company_id=$1",[company,agent]);
   await patch({status:'active'});
   await query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,other]);
   const dueAt=mission.nextRunAt,refused=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},409);assert.equal(refused.code,'MISSION_INFERENCE_COORDINATOR_REQUIRED');mission=refused.mission;
   assert.equal(mission.status,'paused');assert.match(mission.pauseReason,/inference profile/);assert.equal(mission.nextRunAt,dueAt);
   assert.equal((await call(prefix+'/'+mission.id)).mission.status,'paused');
   assert.equal(Number((await query('SELECT count(*) FROM agent_mission_cycles WHERE company_id=$1',[company])).rows[0].count),0);
   assert.equal((await query('SELECT cycles_started FROM agent_missions WHERE id=$1',[mission.id])).rows[0].cycles_started,0);
   await query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,agent]);
   await patch({status:'active'});
   firstClientId=randomUUID();const started=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:firstClientId},201);firstRun=started.runId;mission=started.mission;
   assert.deepEqual(await resolve(await readRun(firstRun)),selected);
   assert.deepEqual((await call(prefix+'/'+mission.id+'/runs')).cycles[0].inferenceProfile,selected);
   assert.equal(await resolve({...await readRun(firstRun),company_id:foreign}),null);
   const stored=await readRun(firstRun);await assert.rejects(()=>resolve({...stored,agent_id:other}),(error:any)=>error.code==='MISSION_INFERENCE_PROFILE_INVALID');
  });
  await t.test('profile edits pause and cancel work while old cycles remain bound to their snapshot',async()=>{
   await patch({inferenceProfile:null});assert.equal(mission.status,'paused');assert.equal(mission.inferenceProfile,null);assert.equal((await readRun(firstRun)).status,'cancelled');
   assert.deepEqual(await resolve(await readRun(firstRun)),selected);
   const replay=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:firstClientId});assert.equal(replay.runId,firstRun);assert.equal(replay.replayed,true);
   await query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,other]);
   await patch({status:'active'});const next=await call(prefix+'/'+mission.id+'/run-now','POST',{clientId:randomUUID()},201);mission=next.mission;
   assert.equal(await resolve(await readRun(next.runId)),null);
   const history=(await call(prefix+'/'+mission.id+'/runs')).cycles;assert.equal(history.length,2);assert.equal(history[0].inferenceProfile,null);assert.deepEqual(history[1].inferenceProfile,selected);
   const before=JSON.stringify((await query('SELECT * FROM agent_missions WHERE id=$1',[mission.id])).rows[0]);
   assert.equal((await call(prefix+'/'+mission.id,'PATCH',{revision:mission.revision,inferenceProfile:selected},409)).code,'MISSION_INFERENCE_COORDINATOR_REQUIRED');
   assert.equal(JSON.stringify((await query('SELECT * FROM agent_missions WHERE id=$1',[mission.id])).rows[0]),before);assert.equal((await readRun(next.runId)).status,'queued');
   await patch({status:'paused'});
  });
  await t.test('legacy omission remains null, retry-safe and unrelated to an objective containing coordinator text',async()=>{
   const request={...base(),objective:'Full v6 generated coordinator objective text cannot opt in'};
   const created=(await call(prefix,'POST',request,201)).mission;
   assert.equal(created.inferenceProfile,null);assert.equal((await call(prefix,'POST',request)).replayed,true);
   const parsed={clientId:request.clientId,agentId:request.agentId,name:request.name,objective:request.objective,intervalMinutes:60,maxCycles:5,status:'paused'};
   assert.equal((await query('SELECT request_hash FROM agent_missions WHERE id=$1',[created.id])).rows[0].request_hash,hashToken(JSON.stringify(parsed)));
  });
  await t.test('scheduled stale profiles pause independently while another due mission advances',async()=>{
   await query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,agent]);
   const removedProject=randomUUID();await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,ai_policy,created_by,production_path,contract_version,spec) VALUES($1,$2,'Disposable fixture','Synthetic','No external effects','allowed',$3,'higgsfield',2,$4)",[removedProject,company,owner,spec]);
   const roleStale=(await call(prefix,'POST',{...base(),status:'active',inferenceProfile:selected},201)).mission;
   const projectStale=(await call(prefix,'POST',{...base(),status:'active',inferenceProfile:profile(removedProject)},201)).mission;
   const general=(await call(prefix,'POST',{...base(),status:'active'},201)).mission;
   await query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,other]);
   await query('DELETE FROM studio_projects WHERE company_id=$1 AND id=$2',[company,removedProject]);
   await query("UPDATE agent_missions SET next_run_at=clock_timestamp()-interval '1 day' WHERE company_id=$1 AND id=ANY($2::uuid[])",[company,[roleStale.id,projectStale.id,general.id]]);
   const before=(await query('SELECT id,next_run_at,max_cycles,cycles_started,last_run_id FROM agent_missions WHERE id=ANY($1::uuid[]) ORDER BY id',[[roleStale.id,projectStale.id]])).rows;
   const first=await tick();assert.deepEqual(first.pausedMissionIds.sort(),[roleStale.id,projectStale.id].sort());assert.deepEqual(first.runs.map((r:any)=>r.missionId),[general.id]);
   const after=(await query('SELECT id,next_run_at,max_cycles,cycles_started,last_run_id FROM agent_missions WHERE id=ANY($1::uuid[]) ORDER BY id',[[roleStale.id,projectStale.id]])).rows;assert.deepEqual(after,before);
   for(const id of [roleStale.id,projectStale.id]){const paused=(await call(prefix+'/'+id)).mission;assert.equal(paused.status,'paused');assert.match(paused.pauseReason,/inference profile/);assert.equal(paused.cyclesStarted,0);assert.equal((await call(prefix+'/'+id+'/runs')).cycles.length,0);}
   const reasons=(await query('SELECT pause_reason FROM agent_missions WHERE id=ANY($1::uuid[])',[[roleStale.id,projectStale.id]])).rows.map(row=>row.pause_reason);assert(reasons.some(reason=>reason.includes('coordinator role')));assert(reasons.some(reason=>reason.includes('generated-media project')));
   const repeated=await tick();assert.deepEqual(repeated.pausedMissionIds,[]);assert.deepEqual(repeated.runs,[]);
  });
  await t.test('PostgreSQL restricted runtime cannot reclassify cycle or joined identities',{skip:emulate||!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname)},async()=>{
   const client=await database().connect(),runtime='mission_profile_'+randomUUID().replaceAll('-','');
   const cycleMission=randomUUID(),cycleRun=randomUUID(),cycleClient=randomUUID(),original=await readRun(firstRun);
   try{
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${runtime} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await client.query((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',runtime));
    await client.query(`SET LOCAL ROLE ${runtime}`);
    await client.query('UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1',[company,agent]);
    await client.query("INSERT INTO agent_missions(id,company_id,agent_id,created_by,client_id,request_hash,name,objective,interval_minutes,max_cycles,inference_profile) VALUES($1,$2,$3,$4,$5,$6,'Restricted fixture','Synthetic only',60,5,$7)",[cycleMission,company,agent,owner,randomUUID(),hashToken(cycleMission),JSON.stringify(selected)]);
    await client.query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic only')",[cycleRun,company,agent,owner,original.conversation_id,cycleClient,hashToken(cycleRun)]);
    await client.query("INSERT INTO agent_mission_cycles(company_id,mission_id,ordinal,run_id,client_id,trigger,inference_profile) VALUES($1,$2,1,$3,$4,'manual',$5)",[company,cycleMission,cycleRun,cycleClient,JSON.stringify(selected)]);
    // A runtime with TEMP permission must not redirect the guard's provenance reads.
    await client.query('CREATE TEMP TABLE agent_mission_cycles(company_id uuid,run_id uuid,mission_id uuid,inference_profile jsonb)');
    const denied=async(sql:string,args:unknown[])=>{await client.query('SAVEPOINT denied');try{await assert.rejects(()=>client.query(sql,args),(error:any)=>error.code==='42501');}finally{await client.query('ROLLBACK TO SAVEPOINT denied');}};
    await denied('UPDATE public.agent_runs SET requested_by=$2 WHERE id=$1',[cycleRun,member]);
    await denied('UPDATE public.agent_missions SET agent_id=$2 WHERE id=$1',[cycleMission,other]);
    await denied('UPDATE public.agent_mission_cycles SET inference_profile=NULL WHERE run_id=$1',[cycleRun]);
    await denied('DELETE FROM public.agent_mission_cycles WHERE run_id=$1',[cycleRun]);
    await client.query('DROP TABLE pg_temp.agent_mission_cycles');
    await client.query('DELETE FROM companies WHERE id=$1',[company]);
    assert.equal(Number((await client.query('SELECT count(*) FROM public.agent_mission_cycles WHERE company_id=$1',[company])).rows[0].count),0);
   }finally{await client.query('ROLLBACK');client.release();}
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();}}
});

test('migration047 preserves legacy bytes and guards profiled identity under restricted runtime grants',{timeout:120000},async()=>{
 const db=await PGlite.create(),company=randomUUID(),owner=randomUUID(),otherUser=randomUUID(),agent=randomUUID(),otherAgent=randomUUID(),projectId=randomUUID(),conversation=randomUUID(),mission=randomUUID(),run=randomUUID(),clientId=randomUUID(),legacyMission=randomUUID(),legacyRun=randomUUID();
 const selected=profile(projectId),role='mission_profile_fixture';
 const insert=async(table:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));};
 const makeRun=(id:string,changes:Record<string,unknown>={})=>insert('agent_runs',{id,company_id:company,agent_id:agent,requested_by:owner,conversation_id:conversation,client_id:id===run?clientId:randomUUID(),payload_hash:hashToken(id),prompt:'Synthetic migration fixture',...changes});
 try{
  for(const name of(await migrationNames()).filter(name=>name<'047_'))await db.exec(await readFile('database/'+name,'utf8'));
  for(const id of [owner,otherUser])await insert('users',{id,name:'Fixture',email:id+'@example.invalid',password_hash:'not-a-login'});
  await insert('companies',{id:company,name:'Fixture',slug:company,template:'blank'});
  for(const id of [agent,otherAgent])await insert('agents',{id,company_id:company,name:'Fixture',harness:'custom',token_hash:hashToken(id),created_by:owner});
  await insert('conversations',{id:conversation,company_id:company});
  await insert('studio_profiles',{company_id:company,template_id:'ai-production',template_version:1,created_by:owner});
  await insert('studio_projects',{id:projectId,company_id:company,name:'Fixture',client_name:'Synthetic',brief:'No external effects',ai_policy:'allowed',created_by:owner,production_path:'higgsfield',contract_version:2,spec:JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}})});
  await insert('studio_role_bindings',{company_id:company,role_key:'coordinator',agent_id:agent});
  const missionRow=(id:string)=>({id,company_id:company,agent_id:agent,created_by:owner,client_id:randomUUID(),request_hash:hashToken(id),name:'Fixture',objective:'Fixture',interval_minutes:60,max_cycles:5});
  await insert('agent_missions',missionRow(legacyMission));await makeRun(legacyRun);
  await insert('agent_mission_cycles',{company_id:company,mission_id:legacyMission,ordinal:1,run_id:legacyRun,client_id:randomUUID(),trigger:'manual'});
  const legacy=(await db.query<{mission:string;cycle:string}>("SELECT to_jsonb(m)::text AS mission,to_jsonb(c)::text AS cycle FROM agent_missions m JOIN agent_mission_cycles c ON c.mission_id=m.id WHERE m.id=$1",[legacyMission])).rows[0];
  await db.exec(await readFile('database/047_mission_inference_profiles.sql','utf8'));
  const unchanged=(await db.query<{mission:string;cycle:string;mp:unknown;cp:unknown}>("SELECT (to_jsonb(m)-'inference_profile')::text AS mission,(to_jsonb(c)-'inference_profile')::text AS cycle,m.inference_profile AS mp,c.inference_profile AS cp FROM agent_missions m JOIN agent_mission_cycles c ON c.mission_id=m.id WHERE m.id=$1",[legacyMission])).rows[0];
  assert.equal(unchanged.mission,legacy.mission);assert.equal(unchanged.cycle,legacy.cycle);assert.equal(unchanged.mp,null);assert.equal(unchanged.cp,null);
  await insert('agent_missions',{...missionRow(mission),inference_profile:JSON.stringify(selected)});await makeRun(run);
  // The production migration runner owns this table, not the numbered SQL files.
  await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  await db.exec(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await db.exec((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',role));
  await db.exec(`SET ROLE ${role}`);
  const rejects=(action:()=>Promise<unknown>,code:string)=>assert.rejects(action,(error:any)=>error.code===code);
  const cycle={company_id:company,mission_id:mission,ordinal:1,run_id:run,client_id:clientId,trigger:'manual',inference_profile:JSON.stringify(selected)};
  await rejects(()=>insert('agent_mission_cycles',{...cycle,inference_profile:null}),'23514');
  await rejects(()=>insert('agent_mission_cycles',{...cycle,client_id:randomUUID()}),'23514');
  for(const identity of [{agent_id:otherAgent},{requested_by:otherUser}]){const id=randomUUID(),client=randomUUID();await makeRun(id,{...identity,client_id:client});await rejects(()=>insert('agent_mission_cycles',{...cycle,run_id:id,client_id:client}),'23514');}
  await rejects(()=>insert('agent_mission_cycles',{...cycle,company_id:randomUUID()}),'P0002');
  await insert('agent_mission_cycles',cycle);
  for(const [field,value]of[['inference_profile',null],['client_id',randomUUID()],['run_id',legacyRun],['mission_id',legacyMission],['ordinal',2]])await rejects(()=>db.query(`UPDATE agent_mission_cycles SET ${field}=$2 WHERE run_id=$1`,[run,value]),'42501');
  await rejects(()=>db.query('DELETE FROM agent_mission_cycles WHERE run_id=$1',[run]),'42501');
  for(const [field,value]of[['agent_id',otherAgent],['requested_by',otherUser],['client_id',randomUUID()],['purpose','mention']])await rejects(()=>db.query(`UPDATE agent_runs SET ${field}=$2 WHERE id=$1`,[run,value]),'42501');
  for(const [field,value]of[['agent_id',otherAgent],['created_by',otherUser]])await rejects(()=>db.query(`UPDATE agent_missions SET ${field}=$2 WHERE id=$1`,[mission,value]),'42501');
  await db.query("UPDATE agent_runs SET status='cancelled',error='Fixture stops safely' WHERE id=$1",[run]);
  await db.query("UPDATE agent_missions SET inference_profile=NULL,revision=revision+1,status='paused' WHERE id=$1",[mission]);
  await rejects(()=>db.query('UPDATE agent_missions SET agent_id=$2 WHERE id=$1',[mission,otherAgent]),'42501');
  await db.query('DELETE FROM companies WHERE id=$1',[company]);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM agent_mission_cycles WHERE company_id=$1',[company])).rows[0].n,0);
 }finally{await db.close();}
});
