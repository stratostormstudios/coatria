import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {handleApi} from '../src/lib/api';
import {database,query} from '../src/lib/db';
import {dummyPasswordHash,hashToken,secret} from '../src/lib/security';
import {DEFAULT_FLOOR,type LayoutItem} from '../src/lib/floor-plan';

const emulator=process.env.COATRIA_TEST_EMULATOR==='1',testDatabase=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(testDatabase&&['localhost','127.0.0.1'].includes(new URL(testDatabase).hostname));
test('floor API preserves legacy offices, tenant access and revision-checked saves',{skip:!emulator&&!local,timeout:90000},async t=>{
 process.env.DATABASE_POOL_MAX=emulator?'1':'5';process.env.TRUST_PROXY='true';
 let stop:(()=>Promise<void>)|undefined;
 if(emulator){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of(await readdir(resolve('database'))).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile(resolve('database',file),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}else process.env.DATABASE_URL=testDatabase!;
 const origin='http://localhost:4180',run=randomUUID(),companyId=randomUUID(),otherCompanyId=randomUUID(),companyIds=[companyId,otherCompanyId];
 const users=Array.from({length:4},(_,index)=>({id:randomUUID(),token:secret(),name:['Owner','Admin','Member','Outsider'][index]}));
 const [owner,admin,member,outsider]=users;
 const furniture:LayoutItem[]=[{id:'legacy-desk',type:'desk',x:10,y:20,w:20,h:15,label:'Existing desk'}];
 let currentRevision=0;
 async function call(person:typeof owner|null,path:string,method='GET',data?:unknown,source=origin){
  const headers:Record<string,string>={Origin:source,'x-forwarded-for':run};if(person)headers.Cookie=`coatria_session=${person.token}`;if(data!==undefined)headers['Content-Type']='application/json';
  const response=await handleApi(new Request(`${origin}/api/${path}`,{method,headers,...(data!==undefined?{body:JSON.stringify(data)}:{})}),path.split('/'));
  return {status:response.status,data:await response.json()};
 }
 const write=(person:typeof owner|null,data:unknown,source=origin)=>call(person,`companies/${companyId}/layout`,'PATCH',data,source);
 const snapshot=()=>call(owner,`companies/${companyId}/workspace`);
 const stored=async()=>(await query('SELECT layout FROM companies WHERE id=$1',[companyId])).rows[0].layout;
 try{
  for(const person of users){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[person.id,person.name,`${person.id}@example.invalid`,dummyPasswordHash]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(person.token),person.id]);}
  for(const id of companyIds)await query("INSERT INTO companies(id,name,slug,template,layout) VALUES($1,'Floor fixture',$2,'blank',$3)",[id,'floor-'+id,JSON.stringify(furniture)]);
  for(const [person,role] of [[owner,'owner'],[admin,'admin'],[member,'member']] as const)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[companyId,person.id,role]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[otherCompanyId,outsider.id]);

  await t.test('legacy read and new-company creation expose explicit floor metadata',async()=>{
   const start=await snapshot();assert.equal(start.status,200);assert.deepEqual(start.data.layout,furniture);assert.deepEqual(start.data.floor,DEFAULT_FLOOR);assert.equal(start.data.layoutRevision,0);assert.deepEqual(await stored(),furniture);
   const created=await call(owner,'companies','POST',{name:'A new floor',slug:'new-floor-'+run,template:'blank'});assert.equal(created.status,201);companyIds.push(created.data.company.id);
   const fresh=(await call(owner,`companies/${created.data.company.id}/workspace`)).data;assert.deepEqual(fresh.layout,[]);assert.deepEqual(fresh.floor,DEFAULT_FLOOR);assert.equal(fresh.layoutRevision,0);
   const document=(await query('SELECT layout FROM companies WHERE id=$1',[created.data.company.id])).rows[0].layout;assert.deepEqual(document,{version:1,items:[],floor:DEFAULT_FLOOR,revision:0});
  });
  await t.test('only same-company administrators can write; old editors must reload',async()=>{
   const input={layout:furniture,floor:DEFAULT_FLOOR,revision:0};
   assert.equal((await write(null,input)).status,401);assert.equal((await write(outsider,input)).status,404);assert.equal((await write(member,input)).status,403);assert.equal((await write(owner,input,'https://outside.example')).status,403);
   const old=await write(owner,{layout:furniture});assert.equal(old.status,400);assert.match(old.data.error,/Reload the office editor/);
   assert.equal((await write(owner,{...input,floor:{width:100,depth:16}})).status,400);assert.deepEqual(await stored(),furniture);
  });
  await t.test('a resized and rotated floor persists atomically; stale saves change nothing',async()=>{
   const layout=[{...furniture[0],w:15,h:20,rotation:90}],floor={width:28,depth:22};
   const result=await write(owner,{layout,floor,revision:0});assert.equal(result.status,200);assert.deepEqual(result.data,{layout,floor,layoutRevision:1});currentRevision=1;
   assert.deepEqual(await stored(),{version:1,items:layout,floor,revision:1});
   const visible=(await call(member,`companies/${companyId}/workspace`)).data;assert.deepEqual(visible.layout,layout);assert.deepEqual(visible.floor,floor);assert.equal(visible.layoutRevision,1);
   const stale=await write(admin,{layout:[],floor:DEFAULT_FLOOR,revision:0});assert.equal(stale.status,409);assert.equal(stale.data.code,'LAYOUT_CONFLICT');assert.deepEqual(await stored(),{version:1,items:layout,floor,revision:1});
   assert.equal(Number((await query("SELECT count(*) FROM activity WHERE company_id=$1 AND kind='office.updated'",[companyId])).rows[0].count),1);
  });
  await t.test('two requests carrying the same revision produce exactly one saved floor',async()=>{
   const first={layout:furniture,floor:{width:30,depth:20},revision:currentRevision},second={layout:[],floor:{width:18,depth:12},revision:currentRevision};
   const results=await Promise.all([write(owner,first),write(admin,second)]);assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
   const saved=results.find(result=>result.status===200)!.data;currentRevision++;assert.equal(saved.layoutRevision,currentRevision);const visible=(await snapshot()).data;assert.deepEqual(visible.layout,saved.layout);assert.deepEqual(visible.floor,saved.floor);assert.equal(visible.layoutRevision,currentRevision);
  });
  await t.test('PostgreSQL serializes editors blocked on the same company row',{skip:emulator},async()=>{
   const blocker=await database().connect();let pending:Array<ReturnType<typeof write>>=[];let committed=false;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
    pending=[write(owner,{layout:furniture,floor:{width:32,depth:24},revision:currentRevision}),write(admin,{layout:[],floor:{width:24,depth:32},revision:currentRevision})];
    let waiting=0;for(let attempt=0;attempt<100&&waiting<2;attempt++){waiting=Number((await query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT layout FROM companies WHERE id=$1 FOR UPDATE'")).rows[0].count);if(waiting<2)await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(waiting,2,'Both authenticated editor transactions must wait at the company lock.');
    await blocker.query('COMMIT');committed=true;
    const results=await Promise.all(pending);assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);currentRevision++;assert.equal((await stored()).revision,currentRevision);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled(pending);}
  });
  await t.test('PostgreSQL rechecks administrator access after acquiring the layout lock',{skip:emulator},async()=>{
   const blocker=await database().connect();let pending:ReturnType<typeof write>|undefined;let committed=false;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
    pending=write(admin,{layout:[],floor:DEFAULT_FLOOR,revision:currentRevision});
    let waiting=false;for(let attempt=0;attempt<100&&!waiting;attempt++){waiting=(await query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT layout FROM companies WHERE id=$1 FOR UPDATE') AS waiting")).rows[0].waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));}
    assert(waiting,'The request has passed its initial administrator check and is waiting on the company.');
    await blocker.query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companyId,admin.id]);await blocker.query('COMMIT');committed=true;
    assert.equal((await pending).status,403);assert.equal((await stored()).revision,currentRevision);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await pending;}
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companyIds]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users.map(person=>person.id)]);}finally{await database().end();await stop?.();}}
});
