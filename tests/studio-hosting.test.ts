import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken,secret} from '../src/lib/security';
import {sealHostedAgentToken,openHostedAgentToken,managedAgentAuthoritySql,managedAgentAuthorityPrincipals} from '../src/lib/studio-hosting';
import {studioHostRegisterInput,studioHostEnrollInput,studioHostCredentialsInput} from '../src/lib/studio-hosting-protocol';

const fixtureRing=JSON.stringify({activeKeyId:'fixture-v1',keys:{'fixture-v1':Buffer.alloc(32,7).toString('base64')}});
const provider={providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:5,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180};
test('host enrollment requires exact explicit activation, bounded capacity and a pinned provider set',()=>{
 const registration={clientId:randomUUID(),name:'Fixture host',maxAgents:2,expiresAt:new Date(Date.now()+3600000).toISOString()};assert(studioHostRegisterInput.safeParse(registration).success);
 for(const patch of [{maxAgents:12},{maxAgents:0},{providerIds:['unknown']},{providerIds:['runpod','runpod']},{providerKey:'fixture'},{command:'run something'},{companyId:randomUUID()}])assert.equal(studioHostRegisterInput.safeParse({...registration,...patch}).success,false);
 const installation={installationId:randomUUID(),revision:1},enroll={clientId:randomUUID(),revision:1,activateAgents:true,installations:[installation]};assert(studioHostEnrollInput.safeParse(enroll).success);
 for(const patch of [{activateAgents:false},{activateAgents:undefined},{installations:[installation,installation]},{capabilities:['*']},{token:'fixture'},{startInference:true}])assert.equal(studioHostEnrollInput.safeParse({...enroll,...patch}).success,false);
 assert.equal(studioHostCredentialsInput.safeParse({supervisorId:randomUUID(),agentIds:[randomUUID()]}).success,false);assert.throws(()=>managedAgentAuthoritySql('a;drop'));
});
test('credential encryption authenticates company, host, agent, installation, epoch and immutable version',()=>{
 const before=process.env.COATRIA_HOSTING_KEYRING;process.env.COATRIA_HOSTING_KEYRING=fixtureRing;
 try{const token=secret('ca_'),aad={companyId:randomUUID(),hostId:randomUUID(),agentId:randomUUID(),version:1,installationId:randomUUID(),installationRevision:2,hostEpoch:1,configurationHash:'a'.repeat(64)},sealed=sealHostedAgentToken(token,aad);assert.equal(openHostedAgentToken(sealed,aad),token);assert(!JSON.stringify(sealed).includes(token));
  for(const change of [{companyId:randomUUID()},{hostId:randomUUID()},{agentId:randomUUID()},{version:2},{installationRevision:3},{hostEpoch:2},{configurationHash:'b'.repeat(64)}])assert.throws(()=>openHostedAgentToken(sealed,{...aad,...change}),/integrity/i);
  assert.throws(()=>openHostedAgentToken({...sealed,ciphertext:(sealed.ciphertext[0]==='A'?'B':'A')+sealed.ciphertext.slice(1)},aad),/integrity/i);
  delete process.env.COATRIA_HOSTING_KEYRING;assert.throws(()=>openHostedAgentToken(sealed,aad),/not configured/);assert.throws(()=>sealHostedAgentToken(token,aad),/not configured/);
  process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture-v2',keys:{'fixture-v2':Buffer.alloc(32,8).toString('base64')}});assert.throws(()=>openHostedAgentToken(sealed,aad),/unavailable/);
 }finally{if(before===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=before;}
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('managed hosting has tenant isolation, encrypted enrollment, live authority and fenced supervisor leases',{skip:!emulate&&!integrationUrl,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api'),previous={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING};
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=fixtureRing;let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),operator=randomUUID(),member=randomUUID(),outsider=randomUUID(),users={owner,operator,member,outsider},sessions={owner:randomUUID(),operator:randomUUID(),member:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180',prefix=`companies/${company}/studio/hosts`;
 type Actor=keyof typeof sessions|'host'|'host2'|'agent'|'anonymous';let hostToken='',host2Token='',agentToken='',h1:any,h2:any,i1:any,i2:any,oldAgentToken='',manualAgentToken='',supervisor=randomUUID(),epoch=0;
 async function call(path:string,method='GET',payload?:unknown,actor:Actor='owner',expected:number|number[]=200){const headers:Record<string,string>={};if(actor==='host')headers.Authorization='Bearer '+hostToken;else if(actor==='host2')headers.Authorization='Bearer '+host2Token;else if(actor==='agent')headers.Authorization='Bearer '+agentToken;else if(actor!=='anonymous'){headers.Cookie='coatria_session='+sessions[actor];headers.Origin=origin;}if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})}),path.split('?')[0].split('/'));const result=await response.json();assert((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: ${response.status}, code ${result.code??''}, error ${result.error??''}`);return result;}
 const install=async(name:string)=>call(`companies/${company}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name,invocationAccess:'admins',capabilities:['studio.read','studio.write','tasks.write','rooms.propose'],runtimeConfig:provider},'owner',201);
 const currentInstall=(id:string)=>call(`companies/${company}/plugin-installations/${id}`).then(r=>r.installation);
 const pull=(actor:Actor='host',id=supervisor,e:number|undefined=epoch)=>call('host/credentials','POST',{supervisorId:id,...(e===undefined?{}:{leaseEpoch:e})},actor);
 const keyCount=async()=>Number((await query('SELECT count(*) FROM studio_host_credentials WHERE company_id=$1',[company])).rows[0].count);
 try{
  for(const[name,userId]of Object.entries(users))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Hosting fixture '+name,userId+'@example.invalid','fixture']);
  for(const[companyId,name]of [[company,'Hosting fixture'],[foreign,'Foreign hosting fixture']])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')",[companyId,name,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[company,owner,operator,member,foreign,outsider]);for(const[name,userId]of Object.entries(users))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),userId]);
  await t.test('registration is admin-only, company-scoped, short-lived and returns its host secret once',async()=>{
   const request={clientId:randomUUID(),name:'Fixture primary host',maxAgents:2,expiresAt:new Date(Date.now()+3600000).toISOString()};await call(prefix,'POST',request,'member',403);await call(prefix,'POST',request,'outsider',404);await call(prefix,'POST',{...request,expiresAt:new Date(Date.now()+25*3600000).toISOString()},'operator',400);
   const created=await call(prefix,'POST',request,'operator',201);h1=created.host;hostToken=created.hostToken;assert.match(hostToken,/^ch_/);assert.equal(h1.maxAgents,2);const replay=await call(prefix,'POST',request,'operator');assert.equal(replay.hostToken,null);assert.equal(replay.host.id,h1.id);assert.equal(replay.replayed,true);
   assert(!JSON.stringify(await call(prefix)).includes(hostToken));await call(`${prefix}/${h1.id}`,'GET',undefined,'outsider',404);await call(`companies/${foreign}/studio/hosts/${h1.id}`,'GET',undefined,'outsider',404);
   const second=await call(prefix,'POST',{...request,clientId:randomUUID(),name:'Fixture alternate host',maxAgents:1},'owner',201);h2=second.host;host2Token=second.hostToken;
   assert.equal((await call('host/identity','GET',undefined,'host')).host.companyId,company);await call('host/identity','GET',undefined,'anonymous',401);
  });
  await t.test('bad enrollment rolls back; exact reviewed activation rotates agents, encrypts tokens and cancels previous work',async()=>{
   const first=await install('Fixture first specialist'),second=await install('Fixture second specialist');i1=first.installation;i2=second.installation;oldAgentToken=first.token;
   const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:i1.agentId,prompt:'Synthetic queued request before enrollment.'},'owner',201)).run;
   const before=(await query('SELECT token_hash FROM agents WHERE id=$1',[i1.agentId])).rows[0].token_hash;
   const request={clientId:randomUUID(),revision:h1.revision,activateAgents:true,installations:[{installationId:i1.id,revision:1},{installationId:i2.id,revision:99}]};await call(`${prefix}/${h1.id}/enroll`,'POST',request,'owner',409);assert.equal(await keyCount(),0);assert.equal((await query('SELECT token_hash FROM agents WHERE id=$1',[i1.agentId])).rows[0].token_hash,before);assert.equal((await call(`companies/${company}/agent-runs/${run.id}`)).run.status,'queued');
   request.installations[1].revision=1;const enrolled=await call(`${prefix}/${h1.id}/enroll`,'POST',request,'owner',201);h1=enrolled.host;assert.equal(enrolled.bindings.length,2);assert.equal(enrolled.startsWorkers,false);assert.equal(enrolled.startsInference,false);assert.equal(await keyCount(),2);assert(!JSON.stringify(enrolled).includes('agentToken'));assert(!JSON.stringify(enrolled).includes('ciphertext'));
   assert.equal((await call(`companies/${company}/agent-runs/${run.id}`)).run.status,'cancelled');const replay=await call(`${prefix}/${h1.id}/enroll`,'POST',request);assert.equal(replay.replayed,true);assert.equal(await keyCount(),2);assert.deepEqual(replay.bindings,enrolled.bindings);
   agentToken=oldAgentToken;await call('agent/identity','GET',undefined,'agent',401);
   const rows=(await query('SELECT token_hash,ciphertext FROM studio_host_credentials WHERE company_id=$1',[company])).rows;assert(rows.every(r=>r.token_hash.length===64&&r.ciphertext&&!r.ciphertext.startsWith('ca_')));
   const receipt=(await query('SELECT response::text FROM studio_host_requests WHERE company_id=$1',[company])).rows.map(r=>r.response).join('');assert.doesNotMatch(receipt,/"agentToken"|"hostToken"|ciphertext|token_hash|ca_[A-Za-z0-9_-]{30}/);
  });
  await t.test('credential delivery is pinned to one live supervisor; same-epoch renewal preserves tokens',async()=>{
   const bundle=await pull('host',supervisor,undefined);epoch=bundle.supervisor.epoch;assert.equal(epoch,1);assert.equal(bundle.credentials.length,2);assert.equal(bundle.pollAfterSeconds,20);assert(+new Date(bundle.supervisor.expiresAt)<=Date.now()+61000);assert.equal(bundle.credentials[0].expiresAt,h1.expiresAt);
   agentToken=bundle.credentials.find((c:any)=>c.agentId===i2.agentId).agentToken;assert.equal((await call('agent/identity','GET',undefined,'agent')).agent.id,i2.agentId);
   const renewed=await pull();assert.deepEqual(renewed.credentials,bundle.credentials);await call('host/credentials','POST',{supervisorId:randomUUID()},'host',409);await call('host/credentials','POST',{supervisorId:supervisor,leaseEpoch:0},'host',409);
   await call('host/credentials','POST',{supervisorId:supervisor,agentIds:[i1.agentId]},'host',400);const other=await pull('host2',randomUUID(),undefined);assert.equal(other.credentials.length,0);assert.equal(other.host.id,h2.id);
   await call('host/credentials','POST',{supervisorId:supervisor},'agent',401);
  });
  await t.test('PostgreSQL host control fences rehosting while agent authority holds its principal locks',{skip:emulate,timeout:15000},async()=>{
   const writer=await database().connect(),reader=await database().connect();
   try{
    await writer.query('BEGIN');await writer.query("SET LOCAL statement_timeout='5s'");
    await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-host-control:${company}`]);
    await reader.query('BEGIN');await reader.query("SET LOCAL statement_timeout='5s'");
    const principalsPending=managedAgentAuthorityPrincipals(reader,company,i2.agentId);
    // Simulate an enrollment actor change under the real control lock. The
    // authority reader must observe the new principal after this commits.
    await writer.query('UPDATE studio_host_credentials SET enrolled_by=$3 WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId,operator]);await writer.query('COMMIT');
    const principals=await principalsPending;assert(principals.includes(operator));
    await reader.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[company,principals]);
    await writer.query('BEGIN');
    assert.equal((await writer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`studio-host-control:${company}`])).rows[0].acquired,false,'Rehosting cannot replace the principals during an authorized transaction');
    await assert.rejects(writer.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',[company,operator]),(error:any)=>error.code==='55P03');
   }finally{await writer.query('ROLLBACK');await reader.query('ROLLBACK');writer.release();reader.release();await query('UPDATE studio_host_credentials SET enrolled_by=$3 WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId,owner]);}
  });
  await t.test('ciphertext or AAD tampering and unavailable keys fail closed without renewing the lease',async()=>{
   const row=(await query('SELECT * FROM studio_host_credentials WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId])).rows[0],lease=(await query('SELECT lease_expires_at FROM studio_managed_hosts WHERE id=$1',[h1.id])).rows[0].lease_expires_at;
   await query('UPDATE studio_host_credentials SET version=version+1 WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId]);const changed=await call('host/credentials','POST',{supervisorId:supervisor,leaseEpoch:epoch},'host',503);assert.equal(changed.code,'HOST_CREDENTIAL_INTEGRITY');assert.equal(+new Date((await query('SELECT lease_expires_at FROM studio_managed_hosts WHERE id=$1',[h1.id])).rows[0].lease_expires_at),+new Date(lease));await query('UPDATE studio_host_credentials SET version=$3 WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId,row.version]);
   await query('UPDATE studio_host_credentials SET ciphertext=$3 WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId,(row.ciphertext[0]==='A'?'B':'A')+row.ciphertext.slice(1)]);await call('host/credentials','POST',{supervisorId:supervisor,leaseEpoch:epoch},'host',503);await query('UPDATE studio_host_credentials SET ciphertext=$3 WHERE company_id=$1 AND agent_id=$2',[company,i2.agentId,row.ciphertext]);
   delete process.env.COATRIA_HOSTING_KEYRING;const current=await currentInstall(i2.id),hash=(await query('SELECT token_hash FROM agents WHERE id=$1',[i2.agentId])).rows[0].token_hash;await call(`${prefix}/${h1.id}/enroll`,'POST',{clientId:randomUUID(),revision:h1.revision,activateAgents:true,installations:[{installationId:i2.id,revision:current.revision}]},'owner',503);await call('host/credentials','POST',{supervisorId:supervisor,leaseEpoch:epoch},'host',503);assert.equal((await query('SELECT token_hash FROM agents WHERE id=$1',[i2.agentId])).rows[0].token_hash,hash);assert.equal((await call(prefix)).encryptionConfigured,false);process.env.COATRIA_HOSTING_KEYRING=fixtureRing;assert.equal((await pull()).credentials.length,2);
  });
  await t.test('cached agent authority and completed staffing proposals recheck the independent host sponsor',async()=>{
   const {authenticateAgent}=await import('../src/lib/integrations'),{authorizeRunTool}=await import('../src/lib/agent-runs');
   const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:i2.agentId,prompt:'Propose a synthetic staffing plan for human review.'},'owner',201)).run;
   const lease=await call('agent/runs/claim','POST',{workerId:'host-staffing-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);
   const identity=await authenticateAgent(new Request(origin+'/api/agent/identity',{headers:{Authorization:'Bearer '+agentToken}}));
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,operator]);
   await assert.rejects(transaction(client=>authorizeRunTool(client,identity,run.id,lease.leaseToken)),/expired, paused, revoked or rotated/);
   await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,operator]);
   const tool=await call('agent/tools/studio_staffing_propose','POST',{runId:run.id,leaseToken:lease.leaseToken,requestId:randomUUID(),arguments:{brief:'Synthetic compositing studio staffing draft.',teamSize:1,disciplines:['compositing'],reviewerHumanId:null,provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:provider}}},'agent');
   const roomProposal=(await call('agent/tools/rooms_propose','POST',{runId:run.id,leaseToken:lease.leaseToken,requestId:randomUUID(),arguments:{name:'Hosted proposal fixture',kind:'meeting',capacity:4}},'agent')).result;
   const proposal=tool.result.proposal;await call(`agent/runs/${run.id}/complete`,'POST',{leaseToken:lease.leaseToken,clientId:randomUUID(),result:'Synthetic staffing proposal is ready for human review.'},'agent');
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,operator]);
   const result=await call(`companies/${company}/studio/staffing/proposals/${proposal.id}/apply`,'POST',{clientId:randomUUID(),revision:proposal.revision,planHash:proposal.planHash,profileRevision:proposal.profileRevision},'owner',409);assert.equal(result.code,'STAFFING_SOURCE_UNAVAILABLE');
   assert.equal((await call(`companies/${company}/agent-proposals/${roomProposal.id}/approve`,'POST',{},'owner',409)).code,'PROPOSAL_AUTHORITY_ENDED');assert.equal(Number((await query('SELECT count(*) FROM rooms WHERE company_id=$1',[company])).rows[0].count),0);
   assert.equal(Number((await query('SELECT count(*) FROM agents WHERE company_id=$1',[company])).rows[0].count),2);
   await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,operator]);
  });
  await t.test('manual plugin rotation and pause override hosting, while re-enrollment requires a fresh exact revision',async()=>{
   let current=await currentInstall(i1.id);const rotated=await call(`companies/${company}/plugin-installations/${i1.id}/rotate`,'POST',{revision:current.revision,expiresInDays:30});manualAgentToken=rotated.token;const stale=(await pull()).unavailable.find((c:any)=>c.agentId===i1.agentId);assert.equal(stale.reason,'credential_rotated');agentToken=manualAgentToken;assert.equal((await call('agent/identity','GET',undefined,'agent')).agent.id,i1.agentId);
   current=await currentInstall(i2.id);await call(`companies/${company}/plugin-installations/${i2.id}`,'PATCH',{revision:current.revision,status:'paused'});assert((await pull()).unavailable.some((c:any)=>c.agentId===i2.agentId));current=await currentInstall(i2.id);await call(`companies/${company}/plugin-installations/${i2.id}`,'PATCH',{revision:current.revision,status:'active'});assert.equal((await pull()).credentials.length,0);
   current=await currentInstall(i2.id);const enrolled=await call(`${prefix}/${h1.id}/enroll`,'POST',{clientId:randomUUID(),revision:h1.revision,activateAgents:true,installations:[{installationId:i2.id,revision:current.revision}]},'owner',201);h1=enrolled.host;const bundle=await pull();assert.equal(bundle.credentials.length,1);agentToken=bundle.credentials[0].agentToken;await call('agent/identity','GET',undefined,'agent');
  });
  await t.test('lease expiry denies cached tokens and takeover fences the old supervisor and active agent run',async()=>{
   const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:i2.agentId,prompt:'Synthetic active run before supervisor takeover.'},'owner',201)).run;
   const lease=await call('agent/runs/claim','POST',{workerId:'host-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);const oldToken=agentToken;
   await query("UPDATE studio_managed_hosts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h1.id]);await call('agent/identity','GET',undefined,'agent',401);
   supervisor=randomUUID();const takeover=await pull('host',supervisor,undefined);assert.equal(takeover.supervisor.epoch,epoch+1);epoch=takeover.supervisor.epoch;assert.notEqual(takeover.credentials[0].agentToken,oldToken);assert.equal((await call(`companies/${company}/agent-runs/${run.id}`)).run.status,'cancelled');await call('agent/identity','GET',undefined,'agent',401);agentToken=takeover.credentials[0].agentToken;await call('agent/identity','GET',undefined,'agent');
  });
  await t.test('host sponsor removal and absolute expiry deny issued tokens independently of the agent sponsor',async()=>{
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,operator]);await call('host/identity','GET',undefined,'host',401);await call('agent/identity','GET',undefined,'agent',401);await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,operator]);
   await query("UPDATE studio_managed_hosts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h1.id]);await call('agent/identity','GET',undefined,'agent',401);await call('host/credentials','POST',{supervisorId:supervisor,leaseEpoch:epoch},'host',401);await query('UPDATE studio_managed_hosts SET expires_at=$2 WHERE id=$1',[h1.id,h1.expiresAt]);
   const current=await currentInstall(i2.id);h2=(await call(`${prefix}/${h2.id}/enroll`,'POST',{clientId:randomUUID(),revision:h2.revision,activateAgents:true,installations:[{installationId:i2.id,revision:current.revision}]},'operator',201)).host;
   // Release the alternate host's earlier empty lease for an explicit fixture takeover.
   await query("UPDATE studio_managed_hosts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h2.id]);const second=await pull('host2',randomUUID(),undefined);agentToken=second.credentials[0].agentToken;await call('agent/identity','GET',undefined,'agent');await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,operator]);await call('agent/identity','GET',undefined,'agent',401);await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,operator]);
  });
  await t.test('revocation works without the encryption key, invalidates issued tokens and preserves a manually rotated identity',async()=>{
   const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:i2.agentId,prompt:'Synthetic queued run before host revocation.'},'owner',201)).run;
   delete process.env.COATRIA_HOSTING_KEYRING;const input={clientId:randomUUID(),revision:h2.revision},revoked=await call(`${prefix}/${h2.id}/revoke`,'POST',input,'owner',201);assert.equal(revoked.host.status,'revoked');assert.equal(revoked.invalidatedAgentCount,1);assert.equal((await call(`companies/${company}/agent-runs/${run.id}`)).run.status,'cancelled');await call('host/identity','GET',undefined,'host2',401);await call('agent/identity','GET',undefined,'agent',401);assert.equal((await call(`${prefix}/${h2.id}/revoke`,'POST',input)).replayed,true);
   const primary=await call(`${prefix}/${h1.id}/revoke`,'POST',{clientId:randomUUID(),revision:h1.revision},'owner',201);assert.equal(primary.invalidatedAgentCount,0);agentToken=manualAgentToken;assert.equal((await call('agent/identity','GET',undefined,'agent')).agent.id,i1.agentId);
   process.env.COATRIA_HOSTING_KEYRING=fixtureRing;const texts=(await query('SELECT response::text FROM studio_host_requests WHERE company_id=$1',[company])).rows.map(r=>r.response).join('');for(const token of [hostToken,host2Token,agentToken,manualAgentToken])assert(!texts.includes(token));assert.doesNotMatch(JSON.stringify(await call(prefix)),/ciphertext|token_hash|agentToken/);
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,operator,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
});
