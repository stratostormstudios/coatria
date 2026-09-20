import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import type {Membership} from '../src/lib/auth';
import {saveStudioCoordination,studioCoordinationSnapshot,dispatchStudioWork,coordinationRunAuthority} from '../src/lib/studio-coordination';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !emulate&&!!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
type Row=Record<string,any>;
type Db={query(sql:string,values?:any[]):Promise<{rows:any[];rowCount?:number}>};
const caps=['studio.read','studio.write','tasks.write'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);

test('coordination approval uses database time after authority waits and before committing effects',{skip:!emulate&&!localPostgres,timeout:120000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_coord_clock_'+suffix,applicationName='coord-clock-'+suffix,originalNow=Date.now;
 let db:Db,app:Pool|undefined,owner:Pool|undefined,control:Pool|undefined,close:(()=>Promise<void>)|undefined,created=false;
 const insert=async(c:Db,table:string,row:Row)=>{const keys=Object.keys(row);return(await c.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row))).rows[0];};
 async function tx<T>(run:(c:PoolClient)=>Promise<T>,after?:(sql:string)=>Promise<void>){const c=app?await app.connect():db as PoolClient,original=c.query.bind(c);try{
  if(after)c.query=(async(sql:string,values?:any[])=>{const result=await original(sql,values);await after(sql);return result;}) as typeof c.query;
  await c.query('BEGIN');const result=await run(c);await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.query=original as typeof c.query;if(app)c.release();}}
 const expires=async(offsetMs=3600000)=>new Date((await db.query("SELECT clock_timestamp()+($1::text||' milliseconds')::interval AS at",[offsetMs])).rows[0].at).toISOString();
 async function past(expiresAt:string,c:Db=db){const remaining=Number((await c.query('SELECT EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp())*1000 AS remaining',[expiresAt])).rows[0].remaining);await delay(Math.max(0,remaining)+35);assert.equal((await c.query('SELECT $1::timestamptz>clock_timestamp() AS live',[expiresAt])).rows[0].live,false);}
 const withSkew=async<T>(offset:number,run:()=>Promise<T>)=>{Date.now=()=>originalNow()+offset;try{return await run();}finally{Date.now=originalNow;}};
 const rejected=(code:string|number)=>(error:any)=>typeof code==='number'?error.status===code:error.code===code;
 try{
  if(emulate){const{PGlite}=await import('@electric-sql/pglite'),pg=await PGlite.create();db={query:async(sql,values)=>{if(!values&&/^(?:--|CREATE|ALTER|GRANT|REVOKE)/.test(sql.trim()))return{rows:await pg.exec(sql)};const result=await pg.query(sql,values);return{rows:result.rows,rowCount:result.affectedRows||result.rows.length};}};close=()=>pg.close();}
  else{control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;owner=new Pool({connectionString:url.href,max:3,connectionTimeoutMillis:10000});app=new Pool({connectionString:url.href,max:3,application_name:applicationName,connectionTimeoutMillis:10000,statement_timeout:15000});db=owner;}
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.query(await readFile('database/'+file,'utf8'));
  async function fixture(){
   const company=randomUUID(),user=await insert(db,'users',{name:'Clock fixture',email:randomUUID()+'@example.invalid',password_hash:'not-a-login'});
   await insert(db,'companies',{id:company,name:'Synthetic coordination clock',slug:company,template:'blank'});await insert(db,'memberships',{company_id:company,user_id:user.id,role:'owner'});
   const agents:Row[]=[];for(const name of['coordinator','producer']){const agent=await insert(db,'agents',{company_id:company,name,harness:'custom',created_by:user.id,token_hash:hash(randomUUID()),capabilities:JSON.stringify(caps),invocation_access:'admins',expires_at:await expires(86400000)});agents.push(agent);await insert(db,'plugin_installations',{company_id:company,agent_id:agent.id,installed_by:user.id,client_id:randomUUID(),request_hash:hash(randomUUID()),plugin_id:'runpod',manifest_version:'1.0.0',runtime_config:'{}',character:'{}'});}
   await insert(db,'studio_profiles',{company_id:company,template_id:'vfx-boutique',template_version:1,created_by:user.id});for(const[index,key]of['coordinator','producer'].entries())await insert(db,'studio_role_bindings',{company_id:company,role_key:key,agent_id:agents[index].id});
   const project=await insert(db,'studio_projects',{company_id:company,name:'Synthetic clock work',client_name:'Internal',brief:'Timing fixture only; no inference or provider calls.',spec:JSON.stringify({width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'Linear Rec.709'}),gates:'{"brief":{"decision":"approved"}}',created_by:user.id,ai_policy:'allowed'});
   const task=await insert(db,'tasks',{company_id:company,title:'Estimate synthetic work',created_by:user.id}),work=await insert(db,'studio_work_items',{company_id:company,project_id:project.id,logical_key:'estimate',task_id:task.id,stage:'estimate',role_key:'producer',execution:'agent'}),conversation=await insert(db,'conversations',{company_id:company});
   const run=await insert(db,'agent_runs',{company_id:company,agent_id:agents[0].id,requested_by:user.id,conversation_id:conversation.id,client_id:randomUUID(),payload_hash:hash(randomUUID()),prompt:'Synthetic timing test',capabilities:JSON.stringify(caps),status:'running',worker_id:'synthetic-clock',lease_token_hash:hash(randomUUID()),lease_expires_at:await expires()});
   const member={companyId:company,userId:user.id,role:'owner',user} as Membership;
   const input={clientId:randomUUID(),revision:0,coordinatorAgentId:agents[0].id,allowedRoleKeys:['producer'],status:'active',maxRuns:3,maxConcurrentRuns:2,expiresAt:await expires()};
   const save=(body=input,after?:(sql:string)=>Promise<void>)=>tx(c=>saveStudioCoordination(c,member,project.id,body),after);
   const dispatch=(after?:(sql:string)=>Promise<void>)=>tx(c=>dispatchStudioWork(c,agents[0],run,{projectId:project.id,workItemId:work.id,projectRevision:1,policyRevision:1}),after);
   const state=async()=>({policy:(await db.query('SELECT revision,runs_started,expires_at,status FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2',[company,project.id])).rows,project:(await db.query('SELECT revision,status FROM studio_projects WHERE id=$1',[project.id])).rows[0],runs:Number((await db.query('SELECT count(*) AS count FROM agent_runs WHERE company_id=$1',[company])).rows[0].count),receipts:Number((await db.query('SELECT count(*) AS count FROM studio_requests WHERE company_id=$1',[company])).rows[0].count),dispatches:Number((await db.query('SELECT count(*) AS count FROM studio_dispatches WHERE company_id=$1',[company])).rows[0].count),activity:Number((await db.query('SELECT count(*) AS count FROM activity WHERE company_id=$1',[company])).rows[0].count)});
   const shorten=async(ms=250)=>{const until=await expires(ms);await db.query('UPDATE studio_coordination_policies SET expires_at=$3 WHERE company_id=$1 AND project_id=$2',[company,project.id,until]);return until;};
   return {company,project,work,run,agents,member,input,save,dispatch,state,shorten};
  }

  await t.test('saved receipt hashes and historical replay stay unchanged; expired exact pause remains available',async()=>{
   const f=await fixture(),saved=await f.save();assert.equal(saved.policy?.effectiveStatus,'active');assert.equal(saved.replayed,false);
   const receipt=(await db.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND client_id=$2',[f.company,f.input.clientId])).rows[0];assert.equal(receipt.request_hash,hash(canonical({projectId:f.project.id,...f.input})));
   const ended=await f.shorten(-1000);assert.deepEqual(await f.save(),{...receipt.response,replayed:true});assert.equal((await tx(c=>studioCoordinationSnapshot(c,f.company,f.project.id))).policy?.effectiveStatus,'expired');
   await db.query("UPDATE agents SET status='paused' WHERE company_id=$1",[f.company]);const pause={...f.input,clientId:randomUUID(),revision:1,status:'paused',expiresAt:ended};assert.equal((await f.save(pause)).policy?.effectiveStatus,'paused');
  });
  await t.test('snapshot resamples time after configuration reads without acquiring policy locks',async()=>{
   const f=await fixture();await f.save();const until=await f.shorten();let delayed=false;const seen:string[]=[];
   const snapshot=await tx(c=>studioCoordinationSnapshot(c,f.company,f.project.id),async sql=>{seen.push(sql);if(!delayed&&sql==='SELECT revision FROM studio_profiles WHERE company_id=$1'){delayed=true;await past(until);}});
   assert(delayed);assert.equal(snapshot.policy?.effectiveStatus,'expired');assert(!seen.some(sql=>/FOR (?:UPDATE|SHARE)/.test(sql)),'Read-only snapshot must not gain authority locks');
  });
  await t.test('save expiry after its final activity write rolls back policy and receipt',async()=>{
   const f=await fixture(),body={...f.input,expiresAt:await expires(500)},before=await f.state();let delayed=false;
   await assert.rejects(()=>f.save(body,async sql=>{if(!delayed&&sql.startsWith('INSERT INTO activity(')){delayed=true;await past(body.expiresAt);}}),rejected(400));assert(delayed);assert.deepEqual(await f.state(),before);
  });
  await t.test('dispatch expiry after child and budget writes rolls back every queue effect',async()=>{
   const f=await fixture();await f.save();const until=await f.shorten(500),before=await f.state();let delayed=false;
   await assert.rejects(()=>f.dispatch(async sql=>{if(!delayed&&sql.startsWith('UPDATE studio_coordination_policies SET runs_started=')){delayed=true;await past(until);}}),rejected('COORDINATION_UNAVAILABLE'));assert(delayed);assert.deepEqual(await f.state(),before);
  });
  await t.test('existing dispatch replay cannot return authority after its final snapshot crosses expiry',async()=>{
   const f=await fixture();await f.save();await f.dispatch();const until=await f.shorten(),before=await f.state();let delayed=false;
   await assert.rejects(()=>f.dispatch(async sql=>{if(!delayed&&sql.includes('FROM studio_execution_jobs j JOIN studio_media_promotions p')){delayed=true;await past(until);}}),rejected('COORDINATION_UNAVAILABLE'));assert(delayed);assert.deepEqual(await f.state(),before);
  });

  // A separate PostgreSQL process is essential: Date.now overrides also move
  // same-process PGlite's clock. These tests never treat that as host-skew proof.
  await t.test('PostgreSQL creation bounds, dispatch and live-child checks ignore either host skew',{skip:!localPostgres},async()=>{
   for(const offset of[-2*86400000,2*86400000]){
    const f=await fixture();await withSkew(offset,async()=>{assert.equal((await f.save()).policy?.effectiveStatus,'active');const result=await f.dispatch();assert.equal(result.replayed,false);assert.equal(await tx(c=>coordinationRunAuthority(c,f.company,{id:result.childRunId,status:'running'})),true);await f.shorten(-1000);assert.equal((await tx(c=>studioCoordinationSnapshot(c,f.company,f.project.id))).policy?.effectiveStatus,'expired');assert.equal(await tx(c=>coordinationRunAuthority(c,f.company,{id:result.childRunId,status:'running'})),false);await assert.rejects(()=>f.dispatch(),rejected('COORDINATION_UNAVAILABLE'));});
    for(const ms of[-1000,25*3600000]){const g=await fixture(),body={...g.input,expiresAt:await expires(ms)};await withSkew(offset,()=>assert.rejects(()=>g.save(body),rejected(400)));}
   }
  });
  async function lockWait(pattern:string){const deadline=performance.now()+10000;while(performance.now()<deadline){if((await owner!.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock' AND query ILIKE $3",[dbName,applicationName,pattern])).rowCount)return;await delay(20);}assert.fail('Expected PostgreSQL lock wait was not observed');}
  async function held<T>(lock:(c:PoolClient)=>Promise<unknown>,pattern:string,until:string,run:()=>Promise<T>){const blocker=await owner!.connect();let pending:Promise<{value:T}|{error:unknown}>|undefined;try{await blocker.query('BEGIN');await lock(blocker);pending=run().then(value=>({value}),error=>({error}));await lockWait(pattern);await past(until,owner!);await blocker.query('ROLLBACK');return await pending;}finally{await blocker.query('ROLLBACK');blocker.release();await pending;}}
  await t.test('PostgreSQL save samples expiry after waiting for its policy row lock',{skip:!localPostgres},async()=>{
   const f=await fixture();await f.save();const body={...f.input,clientId:randomUUID(),revision:1,expiresAt:await expires(2000)},before=await f.state();
   const result=await held(c=>c.query('SELECT project_id FROM studio_coordination_policies WHERE project_id=$1 FOR UPDATE',[f.project.id]),'%FROM studio_coordination_policies%FOR UPDATE%',body.expiresAt,()=>f.save(body));assert('error'in result&&rejected(400)(result.error));assert.deepEqual(await f.state(),before);
  });
  await t.test('PostgreSQL live child cannot use time evaluated before its policy lock wait',{skip:!localPostgres},async()=>{
   const f=await fixture();await f.save();const child=await f.dispatch(),until=await f.shorten(2000);
   const result=await withSkew(-2*86400000,()=>held(c=>c.query('SELECT project_id FROM studio_coordination_policies WHERE project_id=$1 FOR UPDATE',[f.project.id]),'%FROM studio_coordination_policies%FOR SHARE%',until,()=>tx(c=>coordinationRunAuthority(c,f.company,{id:child.childRunId,status:'running'}))));assert.deepEqual(result,{value:false});
  });
  await t.test('PostgreSQL project-lock expiry rolls back child creation before any handoff is committed',{skip:!localPostgres},async()=>{
   const f=await fixture();await f.save();const until=await f.shorten(2000),before=await f.state();
   const result=await held(c=>c.query('SELECT id FROM studio_projects WHERE id=$1 FOR UPDATE',[f.project.id]),'%FROM studio_projects%FOR UPDATE%',until,()=>f.dispatch());assert('error'in result&&rejected('COORDINATION_UNAVAILABLE')(result.error));assert.deepEqual(await f.state(),before);
  });
 }finally{
  Date.now=originalNow;await close?.();await app?.end();await owner?.end();
  try{if(created){const deadline=performance.now()+10000;while((await control!.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[dbName])).rowCount){if(performance.now()>deadline)assert.fail('Disposable coordination database sessions did not drain');await delay(25);}await control!.query('DROP DATABASE '+dbName);}}finally{await control?.end();}
 }
});
