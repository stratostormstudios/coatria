import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {handleApi} from '../src/lib/api';
import {conversationHistory,conversationSync,listConversations,sendConversationMessage,type ConversationActor} from '../src/lib/conversations';

// Real PostgreSQL only: PGlite's single physical connection cannot demonstrate
// transaction visibility, row-lock scheduling or revocation races. Never load
// .env files or borrow the local UI database for this test suite.
const connection=process.env.COATRIA_INTEGRATION_DATABASE_URL;
let local=false;try{local=Boolean(connection&&['localhost','127.0.0.1'].includes(new URL(connection).hostname));}catch{}
type Outcome<T>={value:T;error?:never}|{value?:never;error:unknown};
function track<T>(promise:Promise<T>){let settled=false;const result=promise.then(value=>({value} as Outcome<T>),error=>({error} as Outcome<T>)).then(value=>{settled=true;return value;});return{result,get settled(){return settled;}};}
async function success<T>(pending:ReturnType<typeof track<T>>){const result=await pending.result;if('error' in result)throw result.error;return result.value;}
async function waitForBlocker(pid:number,count=1){
 for(let attempt=0;attempt<150;attempt++){
  const row=(await query('SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0];
  if(row.waiting>=count)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.fail(`Expected ${count} request(s) to wait on the controlled PostgreSQL transaction.`);
}

test('conversation protocol serializes commits and rechecks authority across real PostgreSQL transactions',{skip:!local||process.env.COATRIA_TEST_EMULATOR==='1',timeout:120000},async t=>{
 process.env.DATABASE_URL=connection!;process.env.DATABASE_POOL_MAX='8';
 const companyId=randomUUID(),users:string[]=[];
 const origin='http://localhost:4180';
 async function person(role='member'){
  const userId=randomUUID(),session=randomUUID();users.push(userId);
  await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Conversation concurrency reviewer',$2,'local-test-session-only')",[userId,`${userId}@example.invalid`]);
  await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[companyId,userId,role]);
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),userId]);
  return{userId,cookie:`coatria_session=${session}`,actor:{companyId,kind:'human' as const,userId}};
 }
 async function channel(actor:ConversationActor){const roomId=randomUUID();await query("INSERT INTO rooms(id,company_id,name,kind,capacity) VALUES($1,$2,$3,'meeting',8)",[roomId,companyId,`Concurrency ${roomId}`]);const history=await conversationHistory(actor,roomId);return{selector:roomId,id:history.conversation.id};}
 async function beginWriter(actor:ConversationActor,conversationId:string){
  const client=await database().connect();await client.query('BEGIN');await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[companyId]);await client.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[companyId,actor.userId]);await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE',[conversationId]);return client;
 }
 async function appendHeld(client:PoolClient,room:{id:string;selector:string},actor:ConversationActor,body:string){
  const sequence=(await client.query('UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence::text AS sequence',[room.id])).rows[0].sequence as string;
  const messageId=randomUUID();
  await client.query("INSERT INTO messages(id,company_id,room_id,conversation_id,user_id,body,sequence,last_event_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",[messageId,companyId,room.selector,room.id,actor.userId,body,sequence]);
  await client.query("INSERT INTO conversation_events(company_id,conversation_id,sequence,kind,message_id,actor_kind,actor_id) VALUES($1,$2,$3,'message.created',$4,'human',$5)",[companyId,room.id,sequence,messageId,actor.userId]);
  return{messageId,sequence};
 }
 const backendPid=async(client:PoolClient)=>(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
 try{
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Conversation concurrency tests',$2,'blank')",[companyId,`conversation-concurrency-${companyId}`]);
  const owner=await person('owner');

  await t.test('a later sender cannot commit past an earlier invisible event',async()=>{
   const room=await channel(owner.actor),blocker=await beginWriter(owner.actor,room.id);let committed=false;
   const first=await appendHeld(blocker,room,owner.actor,'Held first message');
   const later=track(sendConversationMessage(owner.actor,room.selector,{clientId:randomUUID(),body:'Later message'}));
   try{
    await waitForBlocker(await backendPid(blocker));assert.equal(later.settled,false);
    assert.equal((await query('SELECT count(*)::int AS count FROM conversation_events WHERE conversation_id=$1',[room.id])).rows[0].count,0,'No uncommitted event is externally visible.');
    await blocker.query('COMMIT');committed=true;const second=await success(later);
    const replay=await conversationSync(owner.actor,room.selector,{after:'0'});
    assert.deepEqual(replay.events.map(event=>event.message?.body),['Held first message','Later message']);assert.equal(first.sequence,'1');assert.equal(second.message.sequence,'2');assert.equal(replay.cursor,'2');assert.equal(replay.hasMore,false);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await later.result;}
  });

  await t.test('rollback never leaves a cursor gap or a phantom committed message',async()=>{
   const room=await channel(owner.actor),blocker=await beginWriter(owner.actor,room.id);let released=false;
   await appendHeld(blocker,room,owner.actor,'Rolled back message');const later=track(sendConversationMessage(owner.actor,room.selector,{clientId:randomUUID(),body:'Committed after rollback'}));
   try{
    await waitForBlocker(await backendPid(blocker));await blocker.query('ROLLBACK');released=true;const result=await success(later);assert.equal(result.message.sequence,'1');
    const replay=await conversationSync(owner.actor,room.selector,{after:'0'});assert.equal(replay.events.length,1);assert.equal(replay.events[0].message?.body,'Committed after rollback');assert.equal(replay.cursor,'1');
   }finally{if(!released)await blocker.query('ROLLBACK');blocker.release();await later.result;}
  });

  await t.test('a busy conversation does not serialize a different conversation in the company',async()=>{
   const first=await channel(owner.actor),other=await channel(owner.actor),blocker=await beginWriter(owner.actor,first.id);let timer:ReturnType<typeof setTimeout>|undefined;
   const independent=track(sendConversationMessage(owner.actor,other.selector,{clientId:randomUUID(),body:'Independent room message'}));
   try{
    const completed=await Promise.race([independent.result,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('A different conversation was blocked by the first conversation.')),3000);})]);
    if('error' in completed)throw completed.error;assert.equal(completed.value.message.sequence,'1');
   }finally{clearTimeout(timer);await blocker.query('ROLLBACK');blocker.release();await independent.result;}
  });

  await t.test('bootstrap history waits for an active writer and returns its matching cursor',async()=>{
   const room=await channel(owner.actor),blocker=await beginWriter(owner.actor,room.id);let committed=false;
   const first=await appendHeld(blocker,room,owner.actor,'Message included by bootstrap');const reading=track(conversationHistory(owner.actor,room.selector));
   try{
    await waitForBlocker(await backendPid(blocker));assert.equal(reading.settled,false);await blocker.query('COMMIT');committed=true;
    const snapshot=await success(reading);assert.equal(snapshot.conversation.lastSequence,first.sequence);assert.deepEqual(snapshot.messages.map(message=>message.id),[first.messageId]);
    const after=await sendConversationMessage(owner.actor,room.selector,{clientId:randomUUID(),body:'After bootstrap'});const replay=await conversationSync(owner.actor,room.selector,{after:snapshot.conversation.lastSequence});assert.deepEqual(replay.events.map(event=>event.messageId),[after.message.id]);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await reading.result;}
  });

  await t.test('an uncommitted offboarding blocks and then rejects both stale reads and writes',async()=>{
   const member=await person(),room=await channel(owner.actor),blocker=await database().connect();let committed=false;
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);await blocker.query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[companyId,member.userId]);
   const writing=track(sendConversationMessage(member.actor,room.selector,{clientId:randomUUID(),body:'Must not commit after removal'})),reading=track(conversationHistory(member.actor,room.selector));
   try{
    await waitForBlocker(await backendPid(blocker),2);assert.equal(writing.settled,false);assert.equal(reading.settled,false);await blocker.query('COMMIT');committed=true;
    for(const pending of [writing,reading]){const result=await pending.result;assert.equal((result.error as {status:number})?.status,403);}
    assert.equal((await conversationHistory(owner.actor,room.selector)).messages.length,0);assert.equal((await query('SELECT count(*)::int AS count FROM conversation_requests WHERE company_id=$1 AND actor_id=$2',[companyId,member.userId])).rows[0].count,0);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await Promise.all([writing.result,reading.result]);}
  });

  await t.test('a writer already holding authority finishes before the actual offboarding API commits',async()=>{
   const member=await person(),room=await channel(owner.actor),blocker=await beginWriter(member.actor,room.id);let committed=false;
   await appendHeld(blocker,room,member.actor,'Authorized before offboarding');
   const parts=['companies',companyId,'members',member.userId],offboarding=track(handleApi(new Request(`${origin}/api/${parts.join('/')}`,{method:'PATCH',headers:{Origin:origin,Cookie:owner.cookie,'Content-Type':'application/json'},body:JSON.stringify({role:'removed'})}),parts));
   try{
    await waitForBlocker(await backendPid(blocker));assert.equal(offboarding.settled,false);await blocker.query('COMMIT');committed=true;assert.equal((await success(offboarding)).status,200);
    assert.equal((await conversationHistory(owner.actor,room.selector)).messages.length,1);await assert.rejects(()=>sendConversationMessage(member.actor,room.selector,{clientId:randomUUID(),body:'Too late'}),{status:403});
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await offboarding.result;}
  });

  for(const change of ['revoked','read'] as const)await t.test(`an agent ${change==='read'?'write-grant downgrade':'revocation'} is rechecked after waiting on its credential row`,async()=>{
   const sponsor=await person('admin'),room=await channel(owner.actor),agentId=randomUUID(),tokenHash=hashToken(randomUUID());
   await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,conversation_access) VALUES($1,$2,'Concurrency agent','custom',$3,$4,'write')",[agentId,companyId,tokenHash,sponsor.userId]);
   const actor:ConversationActor={companyId,kind:'agent',agentId,userId:sponsor.userId,tokenHash};const blocker=await database().connect();let committed=false;
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE',[agentId]);await blocker.query(change==='revoked'?"UPDATE agents SET status='revoked' WHERE id=$1":"UPDATE agents SET conversation_access='read' WHERE id=$1",[agentId]);
   const writing=track(sendConversationMessage(actor,room.selector,{clientId:randomUUID(),body:'Must honor current agent authority'}));
   try{
    await waitForBlocker(await backendPid(blocker));assert.equal(writing.settled,false);await blocker.query('COMMIT');committed=true;const result=await writing.result;assert.equal((result.error as {status:number})?.status,change==='revoked'?401:403);
    assert.equal((await conversationHistory(owner.actor,room.selector)).messages.length,0);if(change==='read')assert.equal((await listConversations(actor)).conversations.some(conversation=>conversation.id===room.id),true);
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await writing.result;}
  });
 }finally{
  try{await query('DELETE FROM companies WHERE id=$1',[companyId]);if(users.length)await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);}finally{await database().end();}
 }
});
