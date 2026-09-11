import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {handleApi} from '../src/lib/api';
import {database,query} from '../src/lib/db';
import {dummyPasswordHash,hashToken,secret} from '../src/lib/security';
import {getOfficeAsset} from '../src/lib/office-catalog';
import {getOfficeSeats} from '../src/lib/office-seating';
import type {LayoutItem} from '../src/lib/floor-plan';

const emulator=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname));
test('authenticated presence interactions and exclusive expiring seat claims',{skip:!emulator&&!local,timeout:90000},async t=>{
 process.env.DATABASE_POOL_MAX=emulator?'1':'5';process.env.TRUST_PROXY='true';let stop:(()=>Promise<void>)|undefined;
 if(emulator){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const name of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile(resolve('database',name),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}else process.env.DATABASE_URL=url!;
 const origin='http://localhost:4180',companyId=randomUUID(),otherId=randomUUID(),roomId=randomUUID(),foreignRoomId=randomUUID();
 const users=Array.from({length:3},()=>({id:randomUUID(),token:secret()})),[owner,worker,outsider]=users;
 const floor={width:20,depth:16};
 const layout:LayoutItem[]=['office-chair-001','office-chair-009','office-chair-012'].map((id,index)=>{const asset=getOfficeAsset(id)!;return{id:'seat-'+index,type:'asset',assetId:id,label:'Chair '+index,x:30+index*15,y:45,w:asset.width/20*100,h:asset.depth/16*100};});
 const seats=getOfficeSeats(layout,floor);let revision=0;
 const heartbeat={roomId:null,x:0,z:0,status:'available'};
 async function call(person:typeof owner|null,resource='presence',method='POST',data:unknown=heartbeat,headers:Record<string,string>={}){
  const path=`companies/${companyId}/${resource}`;
  const response=await handleApi(new Request(`${origin}/api/${path}`,{method,headers:{Origin:origin,'x-forwarded-for':companyId,...(method==='GET'?{}:{'Content-Type':'application/json'}),...(person?{Cookie:`coatria_session=${person.token}`,'X-Coatria-User':person.id}:{}),...headers},...(method==='GET'?{}:{body:JSON.stringify(data)})}),path.split('/'));
  return{status:response.status,data:await response.json()};
 }
 const own=(response:Awaited<ReturnType<typeof call>>,person=owner)=>response.data.presence.find((row:{userId:string})=>row.userId===person.id);
 const post=(person:typeof owner,extra:Record<string,unknown>={})=>call(person,'presence','POST',{...heartbeat,...extra});
 const clearRates=()=>query('DELETE FROM rate_limits WHERE key=ANY($1::text[])',[users.map(person=>hashToken(`interaction:${companyId}:${person.id}`))]);
 try{
  for(const person of users){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[person.id,'Interaction fixture',person.id+'@example.invalid',dummyPasswordHash]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(person.token),person.id]);}
  for(const id of [companyId,otherId])await query("INSERT INTO companies(id,name,slug,template,layout) VALUES($1,'Interaction fixture',$2,'blank',$3)",[id,'interaction-'+id,JSON.stringify({version:1,items:layout,floor,revision:0})]);
  for(const [person,id,role]of[[owner,companyId,'owner'],[worker,companyId,'member'],[outsider,otherId,'owner']]as const)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[id,person.id,role]);
  await query("INSERT INTO rooms(id,company_id,name,kind,capacity) VALUES($1,$2,'Local room','meeting',8),($3,$4,'Other room','meeting',8)",[roomId,companyId,foreignRoomId,otherId]);
  await t.test('legacy heartbeats and allowlisted modes respect tenant, origin and identity boundaries',async()=>{
   const original=await post(owner);assert.equal(original.status,200);assert.equal(own(original).motionMode,'walk');assert.equal(own(original).interaction,null);assert.equal(own(original).seat,null);
   for(const motionMode of ['walk','run','teleport'])assert.equal(own(await post(owner,{motionMode})).motionMode,motionMode);
   assert.equal((await call(null)).status,401);assert.equal((await post(outsider,{interaction:{type:'reaction',value:'heart'}})).status,404);
   assert.equal((await call(owner,'presence','POST',heartbeat,{Origin:'https://outside.example'})).status,403);
   assert.equal((await call(owner,'presence','POST',heartbeat,{'X-Coatria-User':outsider.id})).status,409);
   assert.equal((await post(owner,{roomId:foreignRoomId})).status,400);assert.equal((await post(owner,{motionMode:'fly'})).status,400);
  });
  await t.test('events have server identity and fixed TTL; identical heartbeats never replay or extend them',async()=>{
   await clearRates();const first=own(await post(owner,{motionMode:'walk',interaction:{type:'emote',value:'wave'}}));
   assert.match(first.interaction.id,/^[a-f0-9-]{36}$/);assert.equal(first.interaction.type,'emote');assert.equal(Date.parse(first.interaction.expiresAt)-Date.parse(first.interaction.createdAt),8000);
   const next=own(await post(owner));assert.deepEqual(next.interaction,first.interaction);assert(Date.parse(next.updatedAt)>Date.parse(first.updatedAt));
   await query("UPDATE presence SET interaction_at=date_trunc('second',clock_timestamp())+interval '0.123456 seconds' WHERE company_id=$1 AND user_id=$2",[companyId,owner.id]);
   const precise=own(await call(worker,'presence','GET')).interaction;assert.match(precise.createdAt,/\.123456/);assert.match(precise.expiresAt,/\.123456/);
   assert.deepEqual(own(await post(owner)).interaction,precise,'A heartbeat must preserve the full PostgreSQL event timestamp, including microseconds.');
   assert.equal((await post(owner,{interaction:{type:'emote',value:'wave',createdAt:'2099-01-01'}})).status,400);
   await query("UPDATE presence SET interaction_at=clock_timestamp()-interval '9 seconds' WHERE company_id=$1 AND user_id=$2",[companyId,owner.id]);
   assert.equal(own(await post(owner)).interaction,null);assert.equal(own(await call(worker,'presence','GET')).interaction,null);
   const dance=own(await post(owner,{interaction:{type:'emote',value:'dance'}}));assert.equal(dance.interaction.value,'dance');assert.notEqual(dance.interaction.id,first.interaction.id);
   assert.equal(own(await post(owner,{x:1,seatId:null})).interaction,null);
   const reaction=own(await post(owner,{interaction:{type:'reaction',value:'heart'}})).interaction;
   assert.deepEqual(own(await post(owner,{x:2,motionMode:'teleport'})).interaction,reaction);
  });
  await t.test('explicit interaction rate limits do not consume or replay regular heartbeats',async()=>{
   await clearRates();for(let index=0;index<8;index++)assert.equal((await post(worker,{interaction:{type:'reaction',value:'applause'}})).status,200);
   assert.equal((await post(worker,{interaction:{type:'reaction',value:'applause'}})).status,429);assert.equal((await post(worker)).status,200);await clearRates();
  });
  await t.test('seat transforms come from the current allowlisted floor and are exclusive',async()=>{
   const seated=await post(owner,{seatId:seats[0].id,x:19,z:19});assert.equal(seated.status,200);assert.deepEqual(own(seated).seat,seats[0]);assert(Math.abs(own(seated).x-seats[0].x)<.000001);
   const busy=await post(worker,{seatId:seats[0].id});assert.equal(busy.status,409);assert.equal(busy.data.code,'SEAT_OCCUPIED');
   assert.equal((await post(worker,{seatId:'../../outside'})).status,404);assert.equal((await post(worker,{seatId:'https://example.test/seat'})).status,404);
   assert.equal((await post(worker,{seat:{x:1,z:1}})).status,400);
   const retained=own(await post(owner,{x:seats[0].x,z:seats[0].z}));assert.equal(retained.seatId,seats[0].id);
   const stood=own(await post(owner,{x:seats[0].x,z:seats[0].z,seatId:null}));assert.equal(stood.seatId,null);assert(Math.abs(stood.x-seats[0].approach.x)<.000001);assert(Math.abs(stood.z-seats[0].approach.z)<.000001);
   assert.equal((await post(worker,{seatId:seats[0].id})).status,200);
   assert.equal(own(await post(worker,{x:3,z:3,motionMode:'run',seatId:null}),worker).seatId,null);
  });
  await t.test('expired claims cannot block a new person or be silently reclaimed by an old heartbeat',async()=>{
   await post(owner,{seatId:seats[0].id});await query("UPDATE presence SET updated_at=clock_timestamp()-interval '46 seconds' WHERE company_id=$1 AND user_id=$2",[companyId,owner.id]);
   assert.equal((await post(worker,{seatId:seats[0].id})).status,200);
   const old=own(await post(owner,{x:seats[0].x,z:seats[0].z}));assert.equal(old.seatId,null);
   assert.equal(own(await call(owner,'presence','GET'),worker).seatId,seats[0].id);
   assert.equal(own(await post(worker,{x:seats[0].x,z:seats[0].z,roomId}),worker).seatId,null);
  });
  await t.test('simultaneous claims produce one occupant and one conflict',async()=>{
   await post(owner,{seatId:null});await post(worker,{seatId:null});
   const results=await Promise.all([post(owner,{seatId:seats[1].id}),post(worker,{seatId:seats[1].id})]);assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
   assert.equal((await call(owner,'presence','GET')).data.presence.filter((person:{seatId:string})=>person.seatId===seats[1].id).length,1);
  });
  await t.test('PostgreSQL serializes competing seat claims on the same advisory lock',{skip:emulator},async()=>{
   await post(owner,{seatId:null});await post(worker,{seatId:null});const blocker=await database().connect();let committed=false;let pending:Array<ReturnType<typeof post>>=[];
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`presence-seat:${companyId}:${seats[2].id}`]);
    pending=[post(owner,{seatId:seats[2].id}),post(worker,{seatId:seats[2].id})];let waiting=0;
    for(let attempt=0;attempt<100&&waiting<2;attempt++){waiting=Number((await query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock(hashtextextended($1,0))'")).rows[0].count);if(waiting<2)await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(waiting,2);await blocker.query('COMMIT');committed=true;assert.deepEqual((await Promise.all(pending)).map(result=>result.status).sort(),[200,409]);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled(pending);}
  });
  await t.test('floor changes release altered seats without reviving inactive presence',async()=>{
   await post(owner,{seatId:null});await post(worker,{seatId:null});await post(owner,{seatId:seats[0].id});
   const originalSeen=(await query('SELECT updated_at FROM presence WHERE company_id=$1 AND user_id=$2',[companyId,owner.id])).rows[0].updated_at;
   const labelEdit=layout.map(item=>({...item,label:item.label+' updated'}));const saved=await call(owner,'layout','PATCH',{layout:labelEdit,floor,revision});assert.equal(saved.status,200);revision++;
   assert.equal(own(await call(owner,'presence','GET')).seatId,seats[0].id);
   const moved=labelEdit.map((item,index)=>index===0?{...item,x:item.x+5}:item);assert.equal((await call(owner,'layout','PATCH',{layout:moved,floor,revision})).status,200);revision++;
   assert.equal(own(await call(owner,'presence','GET')).seatId,null);assert.deepEqual((await query('SELECT updated_at FROM presence WHERE company_id=$1 AND user_id=$2',[companyId,owner.id])).rows[0].updated_at,originalSeen);
   await post(worker,{seatId:seats[2].id});await query("UPDATE presence SET updated_at=clock_timestamp()-interval '46 seconds' WHERE company_id=$1 AND user_id=$2",[companyId,worker.id]);
   assert.equal((await call(owner,'layout','PATCH',{layout:[],floor,revision})).status,200);revision++;
   assert.equal((await call(owner,'presence','GET')).data.presence.some((person:{userId:string})=>person.userId===worker.id),false);
   assert.equal((await query('SELECT seat_id FROM presence WHERE company_id=$1 AND user_id=$2',[companyId,worker.id])).rows[0].seat_id,null);
  });
  await t.test('offboarding removes interaction and seating presence and prevents further writes',async()=>{
   await post(worker,{interaction:{type:'reaction',value:'coffee'}});assert.equal((await call(owner,'members/'+worker.id,'PATCH',{role:'removed'})).status,200);
   assert.equal((await post(worker,{interaction:{type:'reaction',value:'heart'}})).status,404);
   assert.equal((await query('SELECT 1 FROM presence WHERE company_id=$1 AND user_id=$2',[companyId,worker.id])).rowCount,0);
  });
 }finally{
  try{await clearRates();await query('DELETE FROM rate_limits WHERE key=ANY($1::text[])',[users.map(person=>hashToken('write:'+person.id))]);await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[companyId,otherId]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users.map(person=>person.id)]);}finally{await database().end();await stop?.();}
 }
});
