import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {handleApi} from '../src/lib/api';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';

const url=process.env.COATRIA_INTEGRATION_DATABASE_URL,emulate=process.env.COATRIA_TEST_EMULATOR==='1';
test('conversation HTTP contract: scoped external agents, idempotency, permissions, origin, validation and Retry-After',{skip:!url&&!emulate,timeout:60000},async()=>{
 process.env.DATABASE_URL=url;process.env.DATABASE_POOL_MAX='1';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of (await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile(resolve('database',file),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),other=randomUUID(),owner=randomUUID(),outsider=randomUUID(),member=randomUUID(),session=randomUUID(),outsiderSession=randomUUID(),memberSession=randomUUID(),token='ca_'+randomUUID(),origin='http://localhost:4180';let agentId='';
 async function call(path:string,method='GET',payload?:unknown,auth:'human'|'agent'|'outsider'|'member'|'none'='human',expected=200,withOrigin=true){
  const headers:Record<string,string>={};if(auth==='agent')headers.Authorization=`Bearer ${token}`;else if(auth!=='none'){headers.Cookie=`coatria_session=${auth==='human'?session:auth==='member'?memberSession:outsiderSession}`;if(withOrigin)headers.Origin=origin;}
  if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('?')[0].split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return{response,data};
 }
 const base=`companies/${company}/conversations`,agents='agent/conversations';
 try{
  for(const [id,label]of[[owner,'Owner'],[outsider,'Outside'],[member,'Member']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,label,id+'@example.invalid','fixture only']);
  for(const [user,secret]of[[owner,session],[outsider,outsiderSession],[member,memberSession]])await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(secret),user]);
  for(const id of[company,other])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Conversation fixture',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[company,owner,member,other,outsider]);
  agentId=(await query("INSERT INTO agents(company_id,name,harness,token_hash,created_by) VALUES($1,'Harness','custom',$2,$3) RETURNING id",[company,hashToken(token),owner])).rows[0].id;
  await call(base,'GET',undefined,'none',401);await call(base,'GET',undefined,'outsider',404);
  await call(agents,'GET',undefined,'agent',403); // Existing credentials acquire no new powers.
  await call(`companies/${company}/agents/${agentId}`,'PATCH',{conversationAccess:'read'},'member',403);
  await call(`companies/${company}/agents/${agentId}`,'PATCH',{conversationAccess:'read'});
  assert.equal((await call(agents,'GET',undefined,'agent')).data.conversations[0].channel,'commons');
  assert((await query('SELECT last_seen_at FROM agents WHERE id=$1',[agentId])).rows[0].last_seen_at,'Conversation-only harnesses record their actual API contact.');
  const outgoing={clientId:randomUUID(),body:'External harness update'};
  await call(agents+'/commons/messages','POST',outgoing,'agent',403);
  await call(`companies/${company}/agents/${agentId}`,'PATCH',{conversationAccess:'write'});
  const created=await call(agents+'/commons/messages','POST',outgoing,'agent',201);
  assert.match(created.response.headers.get('x-request-id')||'',/^[0-9a-f-]{36}$/);
  assert.equal(created.data.message.actor.kind,'agent');assert.equal(created.data.message.agentId,agentId);assert.equal(created.data.message.userId,null);
  const replay=await call(agents+'/commons/messages','POST',outgoing,'agent');assert.equal(replay.data.replayed,true);assert.equal(replay.data.message.id,created.data.message.id);
  await call(agents+'/commons/messages','POST',{...outgoing,body:'Different'},'agent',409);
  await call(agents+'/commons/messages','POST',{...outgoing,clientId:randomUUID(),userId:owner},'agent',400);
  await call(base+'/commons/messages','POST',{clientId:randomUUID(),body:'Cross-site'},'human',403,false);
  await call(base+'/commons/messages?limit=1&limit=2','GET',undefined,'human',400);
  await call(base+'/commons/messages?limit=NaN','GET',undefined,'human',400);
  await call(base+'/commons/events?after=9223372036854775808','GET',undefined,'human',400);
  await call(base+'/commons/events?after=01','GET',undefined,'human',400);
  const history=(await call(base+'/commons/messages')).data;assert.equal(history.messages[0].actor.kind,'agent');assert.equal(typeof history.conversation.lastSequence,'string');
  await call(base+`/commons/messages/${created.data.message.id}`,'PATCH',{body:'Impersonation',revision:1},'human',403);
  await call(agents+`/commons/messages/${created.data.message.id}`,'PATCH',{body:'Revised',revision:1},'agent');
  await call(agents+`/commons/messages/${created.data.message.id}`,'PATCH',{body:'Stale',revision:1},'agent',409);
  const changes=(await call(base+'/commons/events?after=0')).data;assert.equal(changes.events.length,2);assert.equal(changes.events[0].message.body,'Revised');
  await call(`companies/${company}/agents/${agentId}`,'PATCH',{conversationAccess:'none'});await call(agents+'/commons/messages','GET',undefined,'agent',403);
  await call(`companies/${company}/agents/${agentId}`,'PATCH',{conversationAccess:'write',status:'paused'});await call(agents,'GET',undefined,'agent',401);
  await call(`companies/${company}/agents/${agentId}`,'PATCH',{status:'active'});
  await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);await call(agents,'GET',undefined,'agent',401);
  await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);
  await query("UPDATE rate_limits SET count=180,expires_at=now()+interval '45 seconds' WHERE key=$1",[hashToken(`conversation-read:${company}:${owner}`)]);
  const limited=await call(base,'GET',undefined,'human',429);assert.equal(limited.data.code,'RATE_LIMITED');assert(Number(limited.response.headers.get('retry-after'))>=1);assert(Number(limited.response.headers.get('retry-after'))<=45);
 }finally{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,other]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,outsider,member]]);await database().end();await stop?.();}
});

test('downloadable harness adapter keeps retry keys, forbids credential redirects and validates origins',async()=>{
 const {CoatriaConversationClient}=await import('../public/downloads/conversation-client.mjs');
 for(const value of ['http://outside.test','https://user:secret@example.test','https://coatria.com/path','https://coatria.com/?key=x'])assert.throws(()=>new CoatriaConversationClient({token:'ca_test',url:value}));
 const sent:Array<{url:string;options:RequestInit}>=[];const client=new CoatriaConversationClient({token:'ca_test',fetch:async(url:URL|RequestInfo,options:RequestInit={})=>{sent.push({url:String(url),options});if(sent.length===1)return new Response('{}',{status:503,headers:{'Retry-After':'0'}});return Response.json({message:{id:'confirmed'},replayed:true});}});
 const outgoing={clientId:randomUUID(),body:'One logical message'};await client.send('commons',outgoing);
 assert.equal(sent.length,2);assert.equal(sent[0].options.body,sent[1].options.body);assert.equal(sent[0].options.redirect,'error');assert.equal(sent[0].url,'https://coatria.com/api/agent/conversations/commons/messages');
 assert.throws(()=>client.send('commons',{body:'No durable retry key'}));
});
