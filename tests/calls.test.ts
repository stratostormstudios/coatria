import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { query, database } from '../src/lib/db';
import { hashToken } from '../src/lib/security';
import { GET, POST } from '../src/app/api/companies/[companyId]/signals/route';

const useEmulator=process.env.COATRIA_TEST_EMULATOR==='1';
const testDatabase=process.env.COATRIA_INTEGRATION_DATABASE_URL||process.env.DATABASE_URL;
const local=Boolean(testDatabase&&['localhost','127.0.0.1'].includes(new URL(testDatabase).hostname));
test('company room calls enforce membership, recipients, capacity and expiry', {skip:!local&&!useEmulator,timeout:90000},async t=>{
  // Explicit test environment only. Never read .env files or reuse the UI emulator.
  let stopEmulator:(()=>Promise<void>)|undefined;
  if(useEmulator) {
    const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');
    const db=await PGlite.create();
    for(const file of (await readdir(resolve('database'))).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile(resolve('database',file),'utf8'));
    const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
    process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;process.env.DATABASE_POOL_MAX='1';
    stopEmulator=async()=>{await server.stop();await db.close();};
  } else {process.env.DATABASE_URL=testDatabase!;process.env.DATABASE_POOL_MAX='5';}
  const company=randomUUID(),otherCompany=randomUUID(),room=randomUUID(),otherRoom=randomUUID();
  const people=Array.from({length:8},()=>({id:randomUUID(),session:randomUUID(),peer:randomUUID()}));
  const url=`http://localhost:4180/api/companies/${company}/signals`;
  const context={params:Promise.resolve({companyId:company})};
  function request(person:number,action:string,extra:Record<string,unknown>={},origin='http://localhost:4180') {
    return new Request(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:`coatria_session=${people[person].session}`},body:JSON.stringify({action,roomId:room,peerId:people[person].peer,...extra})});
  }
  async function post(person:number,action:string,extra:Record<string,unknown>={},origin?:string){return POST(request(person,action,extra,origin),context);}
  async function get(person:number,queryString=''){return GET(new Request(`${url}?roomId=${room}&peerId=${people[person].peer}${queryString}`,{headers:{Cookie:`coatria_session=${people[person].session}`}}),context);}
  try{
    await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Call tests',$3,'blank'),($2,'Other call tests',$4,'blank')",[company,otherCompany,`call-${company}`,`call-${otherCompany}`]);
    await query("INSERT INTO rooms(id,company_id,name,kind,capacity) VALUES($1,$2,'Call room','meeting',6),($3,$2,'Other room','meeting',6)",[room,company,otherRoom]);
    for(let n=0;n<people.length;n++){
      const p=people[n];await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,'test-session-only')",[p.id,`Call QA ${n}`,`${p.id}@example.invalid`]);
      await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(p.session),p.id]);
      await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[n===7?otherCompany:company,p.id,n===0?'owner':'member']);
    }
    await t.test('outsiders and forged origins cannot join',async()=>{
      assert.equal((await post(7,'join')).status,404);
      assert.equal((await post(0,'join',{},'https://attacker.invalid')).status,403);
    });
    await t.test('participants must join before signaling and cannot impersonate a peer',async()=>{
      assert.equal((await post(0,'heartbeat')).status,409);
      assert.equal((await post(0,'join')).status,200);
      assert.equal((await post(1,'join',{peerId:people[0].peer})).status,409);
      assert.equal((await post(1,'join')).status,200);
      assert.equal((await post(1,'heartbeat',{peerId:people[0].peer})).status,409);
    });
    await t.test('signals reach only the addressed participant',async()=>{
      const signal={recipientId:people[1].peer,payload:{type:'description',description:{type:'offer',sdp:'v=0\r\n'}}};
      assert.equal((await post(0,'signal',signal)).status,200);
      const own=await (await get(0)).json();assert.equal(own.signals.length,0);
      const received=await (await get(1)).json();assert.equal(received.signals.length,1);assert.equal(received.signals[0].senderId,people[0].peer);
      const cursor=received.signals[0].id;assert.equal((await (await get(1,`&after=${cursor}`)).json()).signals.length,0);
      assert.equal((await get(1,'&after=bad')).status,400);
    });
    await t.test('concurrent signal requests retain complete ordered cursor delivery',async()=>{
      const before=await (await get(1)).json();const cursor=before.signals.at(-1)?.id||'0';
      const responses=await Promise.all(Array.from({length:6},(_,n)=>post(0,'signal',{recipientId:people[1].peer,payload:{type:'candidate',candidate:{candidate:`candidate:parallel-${n}`}}})));
      for(const response of responses)assert.equal(response.status,200);
      const received=await (await get(1,`&after=${cursor}`)).json();
      assert.equal(received.signals.length,6);
      assert.equal(new Set(received.signals.map((s:{payload:{candidate:{candidate:string}}})=>s.payload.candidate.candidate)).size,6);
      const ids=received.signals.map((s:{id:string})=>BigInt(s.id));
      assert(ids.every((value:bigint,index:number)=>index===0||value>ids[index-1]));
      assert.equal((await (await get(1,`&after=${received.signals.at(-1).id}`)).json()).signals.length,0);
    });
    await t.test('PostgreSQL room lock prevents a later signal committing past an unseen cursor',{skip:useEmulator},async()=>{
      // This is intentionally PostgreSQL-only: PGlite has one physical connection.
      const before=await (await get(1)).json();const cursor=before.signals.at(-1)?.id||'0';
      const blocker=await database().connect();let pending:Promise<Response>|undefined;let committed=false;
      try {
        await blocker.query('BEGIN');
        const lockKey=`call:${company}:${room}`;
        await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
        await blocker.query('INSERT INTO call_signals(company_id,room_id,sender_id,recipient_id,payload) VALUES($1,$2,$3,$4,$5)',[company,room,people[0].peer,people[1].peer,JSON.stringify({type:'candidate',candidate:{candidate:'candidate:held'}})]);
        pending=post(0,'signal',{recipientId:people[1].peer,payload:{type:'candidate',candidate:{candidate:'candidate:waiting'}}});
        let waiting=false;
        for(let attempt=0;attempt<100&&!waiting;attempt++) {
          waiting=(await query(`WITH key AS (SELECT hashtextextended($1,0) AS k) SELECT EXISTS(SELECT 1 FROM pg_locks,key WHERE locktype='advisory' AND NOT granted AND classid::bigint=((k>>32)&4294967295) AND objid::bigint=(k&4294967295)) AS waiting`,[lockKey])).rows[0].waiting;
          if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert(waiting,'The later API signal must wait for the room transaction lock.');
        assert.equal((await (await get(1,`&after=${cursor}`)).json()).signals.length,0);
        await blocker.query('COMMIT');committed=true;
        assert.equal((await pending).status,200);
        const received=await (await get(1,`&after=${cursor}`)).json();assert.equal(received.signals.length,2);
        assert.equal(received.signals[0].payload.candidate.candidate,'candidate:held');assert.equal(received.signals[1].payload.candidate.candidate,'candidate:waiting');
      } finally {if(!committed)await blocker.query('ROLLBACK');blocker.release();await pending;}
    });
    await t.test('cross-room recipients and oversized descriptions are rejected',async()=>{
      assert.equal((await post(2,'join',{roomId:otherRoom})).status,200);
      assert.equal((await post(0,'signal',{recipientId:people[2].peer,payload:{type:'description',description:{type:'offer',sdp:'v=0'}}})).status,404);
      assert.equal((await post(0,'signal',{recipientId:people[1].peer,payload:{type:'description',description:{type:'offer',sdp:'x'.repeat(32001)}}})).status,400);
      assert.equal((await post(2,'leave',{roomId:otherRoom})).status,200);
    });
    await t.test('small-room call capacity is enforced on the server',async()=>{
      for(let n=2;n<6;n++)assert.equal((await post(n,'join')).status,200);
      assert.equal((await post(6,'join')).status,409);
    });
    await t.test('removed and expired participants disappear and lose signaling access',async()=>{
      await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[company,people[1].id]);
      assert.equal((await get(1)).status,404);
      assert.equal((await post(0,'signal',{recipientId:people[1].peer,payload:{type:'candidate',candidate:{candidate:'candidate:1'}}})).status,404);
      const visible=await (await get(0)).json();assert.ok(!visible.peers.some((p:{id:string})=>p.id===people[1].peer));
      // No peer has expired yet: removal itself must free the sixth seat.
      assert.equal((await post(6,'join')).status,200);
      await query("UPDATE call_peers SET updated_at=now()-interval '46 seconds' WHERE id=$1",[people[2].peer]);
      assert.equal((await get(2)).status,409);
      assert.equal((await post(2,'join')).status,200);
    });
    await t.test('leaving removes the call session and its pending signals',async()=>{
      assert.equal((await post(0,'leave')).status,200);
      assert.equal((await get(0)).status,409);
      assert.equal(Number((await query('SELECT count(*) FROM call_signals WHERE sender_id=$1',[people[0].peer])).rows[0].count),0);
    });
  } finally {
    try {
      await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,otherCompany]]);
      await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[people.map(p=>p.id)]);
    } finally {await database().end();await stopEmulator?.();}
  }
});
