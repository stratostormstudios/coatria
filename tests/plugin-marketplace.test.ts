import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {PLUGIN_CATALOG,PLUGIN_CATALOG_VERSION} from '../src/lib/plugin-catalog';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('curated catalog is public without database configuration',async()=>{
 const saved=process.env.DATABASE_URL;delete process.env.DATABASE_URL;
 try{const response=await handleApi(new Request('http://localhost:4180/api/plugins/catalog'),['plugins','catalog']);assert.equal(response.status,200);const result=await response.json();assert.equal(result.version,PLUGIN_CATALOG_VERSION);assert.deepEqual(result.plugins,PLUGIN_CATALOG);assert(result.plugins.length>=4);}finally{if(saved)process.env.DATABASE_URL=saved;else delete process.env.DATABASE_URL;}
});

test('plugin installations enforce grants, tenant boundaries, secret handling and live-worker lifecycle',{skip:!emulate&&!url,timeout:120000},async t=>{
 process.env.DATABASE_URL=url;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const f of(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile('database/'+f,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),sessions={owner:randomUUID(),member:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180';
 const plugin=PLUGIN_CATALOG.find(plugin=>plugin.runtime==='responses')??PLUGIN_CATALOG[0],provider=plugin.providers[0],prefix=`companies/${company}/plugin-installations`;
 let installation:any,token='',runId='',leaseToken='';
 const payload={clientId:randomUUID(),pluginId:plugin.id,manifestVersion:plugin.version,name:'Studio researcher',runtimeConfig:{providerId:provider.id,modelId:provider.models[0].id}};
 async function call(path:string,method='GET',payload?:unknown,actor:'owner'|'member'|'outsider'|'agent'|'anonymous'='owner',expected=200,agentToken=token){
  const headers:Record<string,string>={};if(actor==='agent')headers.Authorization='Bearer '+agentToken;else if(actor!=='anonymous'){headers.Cookie='coatria_session='+sessions[actor];headers.Origin=origin;}if(payload!==undefined)headers['Content-Type']='application/json';
  const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('?')[0].split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;
 }
 const patch=(data:unknown,expected=200)=>call(prefix+'/'+installation.id,'PATCH',{revision:installation.revision,...data as any},'owner',expected);
 async function requestRun(){const result=await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:installation.agentId,prompt:'Inspect only the configured company context'},'member',201);runId=result.run.id;const held=await call('agent/runs/claim','POST',{workerId:'marketplace-fixture',claimId:randomUUID()},'agent');assert.equal(held.run.id,runId);leaseToken=held.leaseToken;return held;}
 try{
  for(const[userId,name]of[[owner,'Owner'],[member,'Member'],[outsider,'Outsider']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','fixture']);
  for(const[c,name]of[[company,'Marketplace company'],[foreign,'Foreign company']])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')",[c,name,c]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[company,owner,member,foreign,outsider]);
  for(const[k,userId]of Object.entries({owner,member,outsider}))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[k as keyof typeof sessions]),userId]);
  await t.test('administrators install exact manifests; members and foreign tenants cannot install',async()=>{
   await call(prefix,'POST',payload,'member',403);await call(prefix,'POST',payload,'outsider',404);await call(prefix,'GET',undefined,'anonymous',401);
   await call(prefix,'POST',{...payload,manifestVersion:'unreviewed-version'},'owner',400);
   await call(prefix,'POST',{...payload,runtimeConfig:{...payload.runtimeConfig,providerId:'untrusted'}},'owner',400);
   await call(prefix,'POST',{...payload,runtimeConfig:{...payload.runtimeConfig,apiKey:'not-an-accepted-field'}},'owner',400);
   await call(prefix,'POST',{...payload,apiKey:'not-an-accepted-field'},'owner',400);
   await call(prefix,'POST',{...payload,capabilities:['vault.read']},'owner',400);
   const created=await call(prefix,'POST',payload,'owner',201);installation=created.installation;token=created.token;
   assert(token.startsWith('ca_'));assert.equal(installation.status,'active');assert.equal(installation.connectionState,'installed');assert.equal(installation.invocationAccess,'none');assert.deepEqual(installation.capabilities,[]);assert.equal(installation.revision,1);assert.equal(installation.character.workStyle,'collaborative');
   const agent=(await query('SELECT * FROM agents WHERE company_id=$1 AND id=$2',[company,installation.agentId])).rows[0];assert.equal(agent.conversation_access,'none');assert.equal(agent.token_hash,hashToken(token));
   const saved=(await query('SELECT row_to_json(p) AS data FROM plugin_installations p WHERE id=$1',[installation.id])).rows[0].data;assert(!JSON.stringify(saved).includes(token));assert(!JSON.stringify(saved).includes('apiKey'));
  });
  await t.test('uncertain installation retries create one agent and never return its token again',async()=>{
   const replay=await call(prefix,'POST',payload);assert.equal(replay.installation.id,installation.id);assert.equal(replay.replayed,true);assert.equal(replay.token,null);
   await call(prefix,'POST',{...payload,name:'Different request'},'owner',409);
   assert.equal((await query('SELECT count(*)::int AS count FROM plugin_installations WHERE company_id=$1',[company])).rows[0].count,1);
   assert.equal((await query('SELECT count(*)::int AS count FROM agents WHERE company_id=$1',[company])).rows[0].count,1);
  });
  await t.test('installation reads are company scoped and projections never expose credentials',async()=>{
   const listed=await call(prefix,'GET',undefined,'member');assert.equal(listed.installations.length,1);assert.equal(listed.nextAfter,null);assert.equal(listed.hasMore,false);assert(!JSON.stringify(listed).includes(token));assert(!JSON.stringify(listed).includes('token_hash'));
   await call(prefix+'/'+installation.id,'GET',undefined,'outsider',404);
   await call(`companies/${foreign}/plugin-installations/${installation.id}`,'GET',undefined,'outsider',404);
   await call(prefix+'?limit=101','GET',undefined,'owner',400);await call(prefix+'?after='+randomUUID(),'GET',undefined,'owner',404);
   await call(prefix+'/'+installation.id,'PATCH',{revision:1,status:'paused'},'member',403);
   await call(prefix+'/'+installation.id+'/rotate','POST',{revision:1},'member',403);
  });
  await t.test('default-deny invocation cannot be bypassed through raw agent administration',async()=>{
   await call('agent/runs/claim','POST',{workerId:'ungranted',claimId:randomUUID()},'agent',403);
   await call(`companies/${company}/agents/${installation.agentId}`,'PATCH',{invocationAccess:'members',capabilities:['workspace.read']},'owner',409);
   await call(`companies/${company}/agents/${installation.agentId}/rotate`,'POST',{},'owner',409);
   installation=(await patch({invocationAccess:'members',capabilities:['workspace.read'],character:{roleTitle:'Research lead',persona:'Explain uncertainty and cite company evidence.',workStyle:'methodical'}})).installation;
   assert.equal(installation.revision,2);
   await call(prefix+'/'+installation.id,'PATCH',{revision:1,name:'Stale'},'owner',409);
  });
  await t.test('leased workers receive the exact public configuration and company character',async()=>{
   await requestRun();
   const response=await handleApi(new Request(origin+'/api/agent/runs/'+runId+'/context',{headers:{Authorization:'Bearer '+token,'X-Coatria-Run-Lease':leaseToken}}),['agent','runs',runId,'context']);assert.equal(response.status,200);const context=await response.json();assert.equal(context.installation.pluginId,plugin.id);assert.equal(context.installation.revision,2);assert.equal(context.installation.character.roleTitle,'Research lead');assert.equal(context.installation.runtimeConfig.modelId,payload.runtimeConfig.modelId);assert(!JSON.stringify(context).includes(token));
   await call('agent/runs/'+runId+'/context','GET',undefined,'agent',400);
   const current=(await call(prefix+'/'+installation.id)).installation;assert.equal(current.connectionState,'worker_contact');assert.equal(current.status,'active');assert(!JSON.stringify(current).includes('connected'));
  });
  await t.test('a reviewed config edit cancels old leases and uses optimistic revisions',async()=>{
   const before=installation.revision;installation=(await patch({runtimeConfig:{...installation.runtimeConfig,maxSteps:3}})).installation;assert.equal(installation.revision,before+1);
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'cancelled');
   await call('agent/tools/workspace_get','POST',{runId,leaseToken,requestId:randomUUID(),arguments:{}},'agent',409);
   await call(prefix+'/'+installation.id,'PATCH',{revision:before,status:'paused'},'owner',409);
   await patch({runtimeConfig:{...installation.runtimeConfig,maxOutputTokens:8192,maxTotalTokens:2000}},400);
  });
  await t.test('connection checks are queued work, never optimistic provider success',async()=>{
   await query("INSERT INTO messages(company_id,user_id,body) VALUES($1,$2,'Private company context excluded from connection tests')",[company,owner]);
   const clientId=randomUUID(),first=await call(prefix+'/'+installation.id+'/connection-test','POST',{clientId},'owner',201),again=await call(prefix+'/'+installation.id+'/connection-test','POST',{clientId});assert.equal(first.run.status,'queued');assert.equal(again.run.id,first.run.id);assert.equal(again.replayed,true);
   assert.equal(first.run.purpose,'connection_test');assert.deepEqual(first.run.capabilities,[]);
   const claimed=await call('agent/runs/claim','POST',{workerId:'connection-check',claimId:randomUUID()},'agent');assert.equal(claimed.run.id,first.run.id);
   const contextResponse=await handleApi(new Request(origin+'/api/agent/runs/'+first.run.id+'/context',{headers:{Authorization:'Bearer '+token,'X-Coatria-Run-Lease':claimed.leaseToken}}),['agent','runs',first.run.id,'context']);assert.equal(contextResponse.status,200);const context=await contextResponse.json();assert.deepEqual(context.messages,[]);assert.deepEqual(context.capabilities,[]);
   await call('agent/tools/workspace_get','POST',{runId:first.run.id,leaseToken:claimed.leaseToken,requestId:randomUUID(),arguments:{}},'agent',403);
   await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:installation.agentId,prompt:'Attempt to set internal purpose',purpose:'connection_test'},'owner',400);
   await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId,agentId:installation.agentId,prompt:first.run.prompt},'owner',409);
   await call(prefix+'/'+installation.id+'/connection-test','POST',{clientId:randomUUID()},'member',403);
   installation=(await patch({status:'paused'})).installation;assert.equal(installation.connectionState,'paused');assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[first.run.id])).rows[0].status,'cancelled');
   await call('agent/runs/claim','POST',{workerId:'paused',claimId:randomUUID()},'agent',401);
   installation=(await patch({status:'active'})).installation;
  });
  await t.test('rotation invalidates old credentials and cannot be replayed with a stale revision',async()=>{
   const previous=token,revision=installation.revision,result=await call(prefix+'/'+installation.id+'/rotate','POST',{revision});installation=result.installation;token=result.token;assert.notEqual(token,previous);assert.equal(installation.connectionState,'installed');assert.equal(installation.revision,revision+1);
   await call('agent/tools','GET',undefined,'agent',401,previous);
   await call(prefix+'/'+installation.id+'/rotate','POST',{revision},'owner',409);
   await call('agent/tools','GET',undefined,'agent');
  });
  await t.test('real PostgreSQL serializes conflicting administrator revisions',{skip:emulate},async()=>{
   const revision=installation.revision;
   const responses=await Promise.all(['A','B','C','D'].map(name=>handleApi(new Request(origin+'/api/'+prefix+'/'+installation.id,{method:'PATCH',headers:{Cookie:'coatria_session='+sessions.owner,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({revision,name:'Concurrent '+name})}),prefix.split('/').concat(installation.id))));
   assert.equal(responses.filter(response=>response.status===200).length,1);assert.equal(responses.filter(response=>response.status===409).length,3);installation=(await call(prefix+'/'+installation.id)).installation;assert.equal(installation.revision,revision+1);
  });
  await t.test('revocation is terminal and cancels queued work without deleting history',async()=>{
   const work=await call(prefix+'/'+installation.id+'/connection-test','POST',{clientId:randomUUID()},'owner',201);
   await query("UPDATE plugin_installations SET manifest_version='retired-manifest-version' WHERE id=$1",[installation.id]);
   await patch({capabilities:[]},400);
   installation=(await patch({status:'paused'})).installation;assert.equal(installation.status,'paused');assert.equal(installation.manifestVersion,'retired-manifest-version');
   installation=(await patch({status:'revoked'})).installation;assert.equal(installation.status,'revoked');assert.equal(installation.connectionState,'revoked');assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[work.run.id])).rows[0].status,'cancelled');
   await patch({status:'active'},409);await call(prefix+'/'+installation.id+'/rotate','POST',{revision:installation.revision},'owner',409);
   await call(`companies/${company}/agents/${installation.agentId}`,'PATCH',{status:'active'},'owner',409);await call('agent/tools','GET',undefined,'agent',401);
   assert.equal((await call(prefix)).installations.length,1);
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();}}
});
