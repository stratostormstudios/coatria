import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {database,query} from '../src/lib/db';
import {ApiError,dummyPasswordHash,hashToken} from '../src/lib/security';
import {conversationHistory,conversationSync,listConversations,sendConversationMessage,editConversationMessage,deleteConversationMessage,reactToConversationMessage,markConversationRead,type ConversationActor} from '../src/lib/conversations';

const emulator=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname));
const rejects=(run:()=>Promise<unknown>,status:number,code?:string)=>assert.rejects(run,error=>error instanceof ApiError&&error.status===status&&(!code||error.code===code));
test('durable conversations preserve identity, ordering, retries, privacy and legacy messages',{skip:!emulator&&!local,timeout:120000},async t=>{
 process.env.DATABASE_POOL_MAX=emulator?'1':'5';let stop:(()=>Promise<void>)|undefined;
 if(emulator){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const name of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)&&name!=='007_conversations.sql').sort())await db.exec(await readFile(resolve('database',name),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}else process.env.DATABASE_URL=url!;
 const companyId=randomUUID(),otherId=randomUUID(),ownerId=randomUUID(),memberId=randomUUID(),outsiderId=randomUUID(),agentId=randomUUID(),roomId=randomUUID(),foreignRoomId=randomUUID(),legacyId=randomUUID();
 const owner:ConversationActor={companyId,kind:'human',userId:ownerId},member:ConversationActor={companyId,kind:'human',userId:memberId},agent:ConversationActor={companyId,kind:'agent',userId:ownerId,agentId,tokenHash:hashToken(randomUUID())};
 const send=(actor:ConversationActor,body:string,channel='commons',extra:Record<string,unknown>={})=>sendConversationMessage(actor,channel,{clientId:randomUUID(),body,...extra});
 try{
  for(const [id,name]of[[ownerId,'Human Owner'],[memberId,'Human Member'],[outsiderId,'Other Company']]as const)await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,name,id+'@example.invalid',dummyPasswordHash]);
  for(const id of[companyId,otherId])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Conversation fixture',$2,'blank')",[id,'conversation-'+id]);
  for(const[userId,id,role]of[[ownerId,companyId,'owner'],[memberId,companyId,'member'],[outsiderId,otherId,'owner']]as const)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[id,userId,role]);
  await query("INSERT INTO rooms(id,company_id,name,kind,capacity) VALUES($1,$2,'Local room','meeting',8),($3,$4,'Foreign room','meeting',8)",[roomId,companyId,foreignRoomId,otherId]);
  await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by) VALUES($1,$2,'Visible Agent','custom',$3,$4)",[agentId,companyId,agent.tokenHash,ownerId]);
  await query("INSERT INTO messages(id,company_id,user_id,body,created_at) VALUES($1,$2,$3,'Before the conversation upgrade','2024-01-01T00:00:00.123456Z')",[legacyId,companyId,ownerId]);
  if(emulator)await query(await readFile('database/007_conversations.sql','utf8'));
  await t.test('migration backfills existing content and the previous INSERT remains commit-ordered',async()=>{
   const initial=await conversationHistory(owner,'commons');assert.equal(initial.messages[0].id,legacyId);assert.equal(initial.messages[0].body,'Before the conversation upgrade');assert.equal(initial.messages[0].sequence,'1');assert.equal(initial.messages[0].actor.kind,'human');assert.equal(initial.messages[0].clientId,null);
   const legacy=(await query("INSERT INTO messages(company_id,room_id,user_id,body) VALUES($1,$2,$3,'Old deployed writer still works') RETURNING id,sequence::text AS sequence",[companyId,roomId,memberId])).rows[0];
   const events=await conversationSync(owner,roomId,{after:'0'});assert.equal(events.events.length,1);assert.equal(events.events[0].messageId,legacy.id);assert.equal(events.cursor,legacy.sequence);
   assert.equal((await listConversations(owner)).conversations.length,2);
  });
  await t.test('send retries resolve to one message and actor-scoped payload conflicts never duplicate',async()=>{
   const clientId=randomUUID(),payload={clientId,body:'  One durable send  '};const results=await Promise.all(Array.from({length:20},()=>sendConversationMessage(owner,'commons',payload)));
   assert.equal(new Set(results.map(result=>result.message.id)).size,1);assert.equal(results.filter(result=>result.replayed).length,19);assert.equal(results[0].message.body,'One durable send');assert.equal(results[0].message.clientId,clientId);
   await rejects(()=>sendConversationMessage(owner,'commons',{...payload,body:'Different'}),409,'IDEMPOTENCY_CONFLICT');await rejects(()=>sendConversationMessage(owner,roomId,payload),409,'IDEMPOTENCY_CONFLICT');
   const otherAuthor=await sendConversationMessage(member,'commons',payload);assert.notEqual(otherAuthor.message.id,results[0].message.id);
   assert.equal((await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1 AND client_id=$2',[companyId,clientId])).rows[0].count,2);
  });
  await t.test('company/channel/parent boundaries and agent default-deny are enforced in the core',async()=>{
   await rejects(()=>conversationHistory({...owner,companyId:otherId},'commons'),403);await rejects(()=>send(owner,'Foreign',foreignRoomId),404);
   await rejects(()=>conversationHistory(agent,'commons'),403,'AGENT_CONVERSATION_ACCESS');await rejects(()=>send(agent,'No grant'),403);
   await query("UPDATE agents SET conversation_access='read' WHERE id=$1",[agentId]);assert((await conversationHistory(agent,'commons')).messages.length>0);await rejects(()=>send(agent,'Read-only cannot send'),403);await rejects(()=>markConversationRead(agent,'commons',{sequence:'1'}),403);
   await query("UPDATE agents SET conversation_access='write' WHERE id=$1",[agentId]);const bot=await send(agent,'An explicit agent contribution');assert.equal(bot.message.actor.kind,'agent');assert.equal(bot.message.actor.id,agentId);assert.equal(bot.message.actor.name,'Visible Agent');assert.equal(bot.message.userId,null);assert.equal(bot.message.agentId,agentId);
   await rejects(()=>editConversationMessage(owner,'commons',bot.message.id,{body:'Sponsor impersonation',revision:1}),403);
   await rejects(()=>conversationHistory({...agent,tokenHash:hashToken('wrong')},'commons'),401);
   await query("UPDATE agents SET status='paused' WHERE id=$1",[agentId]);await rejects(()=>conversationHistory(agent,'commons'),401);await query("UPDATE agents SET status='active' WHERE id=$1",[agentId]);
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companyId,ownerId]);await rejects(()=>send(agent,'Sponsor demoted'),401);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[companyId,ownerId]);
  });
  await t.test('exclusive sequence pagination survives insertions and one-level threads stay scoped',async()=>{
   for(let i=0;i<8;i++)await send(owner,'History '+i,roomId);
   const newest=await conversationHistory(owner,roomId,{limit:3});assert.equal(newest.messages.length,3);assert.equal(newest.hasMore,true);assert.equal(newest.nextBefore,newest.messages[0].sequence);
   await send(member,'Concurrent new root',roomId);const older=await conversationHistory(owner,roomId,{before:newest.nextBefore!,limit:3});assert.equal(older.messages.length,3);assert(older.messages.every(message=>BigInt(message.sequence)<BigInt(newest.messages[0].sequence)));assert(!older.messages.some(message=>newest.messages.some(item=>item.id===message.id)));
   const parent=newest.messages[0],reply=await send(member,'A thread reply',roomId,{parentId:parent.id});await rejects(()=>send(owner,'Nested reply',roomId,{parentId:reply.message.id}),400);await rejects(()=>send(owner,'Cross channel reply','commons',{parentId:parent.id}),404);
   assert.equal((await conversationHistory(owner,roomId,{parentId:parent.id})).messages[0].id,reply.message.id);assert(!(await conversationHistory(owner,roomId)).messages.some(message=>message.id===reply.message.id));
   const update=await conversationSync(owner,roomId,{after:newest.conversation.lastSequence});const replyEvent=update.events.find(event=>event.messageId===reply.message.id)!;assert.equal(replyEvent.parentMessage?.id,parent.id);assert.equal(replyEvent.parentMessage?.replyCount,1);
  });
  await t.test('edits use optimistic revisions; deletion redacts every sync snapshot and retains thread structure',async()=>{
   const sent=await send(owner,'Original sensitive content'),reply=await send(member,'Reply retained','commons',{parentId:sent.message.id});
   const edited=await editConversationMessage(owner,'commons',sent.message.id,{revision:1,body:'Edited sensitive content'});assert.equal(edited.message.revision,2);assert(edited.message.editedAt);await rejects(()=>editConversationMessage(owner,'commons',sent.message.id,{revision:1,body:'Stale overwrite'}),409,'MESSAGE_CONFLICT');await rejects(()=>deleteConversationMessage(member,'commons',sent.message.id,{revision:2}),403);
   await reactToConversationMessage(member,'commons',sent.message.id,{emoji:'heart',active:true});const deleted=await deleteConversationMessage(owner,'commons',sent.message.id,{revision:2});assert.equal(deleted.message.body,'');assert.equal(deleted.message.revision,3);assert(deleted.message.deletedAt);assert.deepEqual(deleted.message.reactions,[]);assert.equal(deleted.message.replyCount,1);
   const events=await conversationSync(member,'commons',{after:(BigInt(sent.message.sequence)-1n).toString()});for(const event of events.events.filter(event=>event.messageId===sent.message.id)){assert.equal(event.message?.body,'');assert(event.message?.deletedAt);}
   assert.equal((await conversationHistory(owner,'commons',{parentId:sent.message.id})).messages[0].id,reply.message.id);await rejects(()=>send(member,'Late reply','commons',{parentId:sent.message.id}),409,'MESSAGE_DELETED');await rejects(()=>reactToConversationMessage(member,'commons',sent.message.id,{emoji:'heart',active:true}),409,'MESSAGE_DELETED');
   const replay=await sendConversationMessage(owner,'commons',{clientId:sent.message.clientId!,body:'Original sensitive content'});assert.equal(replay.replayed,true);assert.equal(replay.message.body,'');
  });
  await t.test('reaction add/remove is idempotent, allowlisted, actor-specific and incremental',async()=>{
   const sent=await send(owner,'React to this');const first=await reactToConversationMessage(member,'commons',sent.message.id,{emoji:'thumbsup',active:true});const repeat=await reactToConversationMessage(member,'commons',sent.message.id,{emoji:'thumbsup',active:true});assert.deepEqual(repeat,first);assert.deepEqual(first.message.reactions,[{emoji:'thumbsup',count:1,mine:true}]);
   const bot=await reactToConversationMessage(agent,'commons',sent.message.id,{emoji:'thumbsup',active:true});assert.deepEqual(bot.message.reactions,[{emoji:'thumbsup',count:2,mine:true}]);
   const mine=(await conversationHistory(owner,'commons')).messages.find(message=>message.id===sent.message.id)!;assert.deepEqual(mine.reactions,[{emoji:'thumbsup',count:2,mine:false}]);
   await rejects(()=>reactToConversationMessage(member,'commons',sent.message.id,{emoji:'<script>',active:true}),400);const removed=await reactToConversationMessage(member,'commons',sent.message.id,{emoji:'thumbsup',active:false});assert.deepEqual(removed.message.reactions,[{emoji:'thumbsup',count:1,mine:false}]);
   const updates=await conversationSync(member,'commons',{after:sent.message.sequence,limit:2});assert.equal(updates.events.length,2);assert.equal(updates.hasMore,true);assert.equal(updates.cursor,updates.events[1].sequence);assert(updates.events.every(event=>event.type==='reaction.changed'));
  });
  await t.test('read markers are monotonic and only the caller sees their own reading position',async()=>{
   const before=(await conversationHistory(member,'commons')).conversation;assert(before.unreadCount>0);
   const marker=await markConversationRead(member,'commons',{sequence:before.lastSequence});assert.equal(marker.conversation.readSequence,before.lastSequence);assert.equal(marker.conversation.unreadCount,0);
   const repeated=await markConversationRead(member,'commons',{sequence:'1'});assert.equal(repeated.conversation.readSequence,before.lastSequence);assert.equal(repeated.conversation.lastSequence,marker.conversation.lastSequence);
   const own=await conversationSync(member,'commons',{after:before.lastSequence});assert.equal(own.events[0].read?.actor.id,memberId);assert.equal(own.events[0].read?.sequence,before.lastSequence);
   for(const actor of[owner,agent]){const peer=await conversationSync(actor,'commons',{after:before.lastSequence});assert.equal(peer.events[0].type,'read.updated');assert.equal(peer.events[0].read,undefined);assert(!JSON.stringify(peer.events[0]).includes(memberId));}
   await rejects(()=>markConversationRead(member,'commons',{sequence:'9223372036854775807'}),400);
  });
  await t.test('channel unread counts track top-level messages separately from thread activity',async()=>{
   const parent=await send(owner,'Root already read');await markConversationRead(member,'commons',{sequence:parent.message.sequence});
   await send(owner,'Thread activity stays with its parent','commons',{parentId:parent.message.id});
   assert.equal((await conversationHistory(member,'commons')).conversation.unreadCount,0);
   await send(owner,'Unseen main conversation update');assert.equal((await conversationHistory(member,'commons')).conversation.unreadCount,1);
   assert.equal((await listConversations(member)).conversations.find(channel=>channel.channel==='commons')?.unreadCount,1);
  });
  await t.test('incremental sync drains a backlog over 1000 events without dropping durable events',async()=>{
   const channel=(await conversationHistory(owner,roomId)).conversation;
   await query("INSERT INTO conversation_events(company_id,conversation_id,sequence,kind,actor_kind,actor_id,read_sequence) SELECT $1,$2,$3::bigint+i,'read.updated','human',$4,0 FROM generate_series(1,1001) i",[companyId,channel.id,channel.lastSequence,ownerId]);await query('UPDATE conversations SET last_sequence=last_sequence+1001 WHERE id=$1',[channel.id]);
   let cursor=channel.lastSequence,count=0,pages=0;for(;;){const page=await conversationSync(owner,roomId,{after:cursor});assert.equal(page.resetRequired,false);assert(page.events.length<=100);for(const event of page.events){assert.equal(BigInt(event.sequence),BigInt(cursor)+1n);cursor=event.sequence;count++;}assert.equal(page.cursor,cursor);pages++;if(!page.hasMore)break;assert(pages<20);}
   assert.equal(count,1001);assert.equal(pages,11);
   const fresh=await conversationHistory(owner,roomId);assert.equal(fresh.conversation.lastSequence,cursor);assert.equal((await conversationSync(owner,roomId,{after:fresh.conversation.lastSequence})).events.length,0);
   await rejects(()=>conversationSync(owner,roomId,{after:(BigInt(fresh.conversation.lastSequence)+1n).toString()}),409,'CURSOR_INVALID');await rejects(()=>conversationSync(owner,roomId,{after:'1e3'}),400);await rejects(()=>conversationHistory(owner,'commons',{limit:101}),400);
  });
  await t.test('removed members cannot read, edit, react or retry a previously accepted send',async()=>{
   const sent=await send(member,'Before access ended');await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[companyId,memberId]);
   await rejects(()=>conversationHistory(member,'commons'),403);await rejects(()=>sendConversationMessage(member,'commons',{clientId:sent.message.clientId!,body:sent.message.body}),403);await rejects(()=>editConversationMessage(member,'commons',sent.message.id,{body:'After removal',revision:1}),403);await rejects(()=>reactToConversationMessage(member,'commons',sent.message.id,{emoji:'heart',active:true}),403);
  });
 }finally{
  await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[companyId,otherId]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,outsiderId]]);await database().end();delete(globalThis as unknown as{coatriaPool?:unknown}).coatriaPool;if(stop)await stop();
 }
});
