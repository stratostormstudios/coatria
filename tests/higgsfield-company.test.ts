import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret,openHiggsfieldSecret} from '../src/lib/higgsfield-secrets';

test('Higgsfield vault binds ciphertext to company, record, purpose and key',()=>{
 const previous=process.env.COATRIA_HOSTING_KEYRING;process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});
 try{const context={companyId:randomUUID(),id:randomUUID(),purpose:'oauth-pending' as const},secret={verifier:randomBytes(32).toString('base64url')},sealed=sealHiggsfieldSecret(secret,context);assert.deepEqual(openHiggsfieldSecret(sealed,context),secret);assert(!JSON.stringify(sealed).includes(secret.verifier));for(const changed of [{...context,companyId:randomUUID()},{...context,id:randomUUID()},{...context,purpose:'oauth-connection' as const}])assert.throws(()=>openHiggsfieldSecret(sealed,changed));assert.throws(()=>openHiggsfieldSecret({...sealed,tag:randomBytes(16).toString('base64')},context));}
 finally{if(previous===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=previous;}
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('company OAuth, exact spending intent, revocation and uncertain generation use actual API and database',{skip:!emulate&&!integrationUrl,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const old={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch};
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});
 let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL='postgresql://postgres:postgres@'+server.getServerConn()+'/postgres';stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID(),other=randomUUID(),project=randomUUID();const sessions={owner:randomUUID(),member:randomUUID(),other:randomUUID()};
 const prefix=`companies/${company}/higgsfield`,origin='https://coatria.com',access='fixture_'+randomUUID(),refresh='fixture_'+randomUUID();
 let paid=0,exchanges=0,refreshes=0,mode:'ok'|'uncertain'|'tool_error'='ok';
 const issuer='https://clerk.higgsfield.ai',endpoint='https://mcp.higgsfield.ai/mcp',callback=origin+'/api/higgsfield/callback';
 const toolSchema={type:'object',properties:{prompt:{type:'string'}},required:['prompt'],additionalProperties:false};
 const tools=['generate_image','generate_video','generate_audio','balance','models_list','jobs_wait','list_workspaces','workspace_select'].map(name=>({name,description:'Fixture '+name,inputSchema:toolSchema}));
 globalThis.fetch=async(input,init)=>{
  const url=String(input);assert.equal(init?.redirect,'error');
  if(url==='https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp')return Response.json({resource:endpoint,authorization_servers:[issuer],scopes_supported:['openid','email','offline_access']});
  if(url===issuer+'/.well-known/oauth-authorization-server')return Response.json({issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',registration_endpoint:issuer+'/oauth/register',code_challenge_methods_supported:['S256'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none']});
  if(url===issuer+'/oauth/register')return Response.json({client_id:'fixture-client',redirect_uris:[callback],token_endpoint_auth_method:'none'});
  if(url===issuer+'/oauth/token'){const values=new URLSearchParams(String(init?.body));if(values.get('grant_type')==='refresh_token')refreshes++;else{exchanges++;assert.equal(values.get('redirect_uri'),callback);assert.equal(values.get('code_verifier')?.length,43);}return Response.json({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600});}
  assert.equal(url,endpoint,'No unapproved network destination');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+access);
  const command=JSON.parse(String(init?.body));if(command.method==='notifications/initialized')return new Response(null,{status:202});
  let result:unknown;
  if(command.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}}};
  else if(command.method==='tools/list')result={tools};
  else if(command.method==='tools/call'){if(command.params.name.startsWith('generate_')){paid++;if(mode==='uncertain')throw Error('Synthetic connection loss after submit');result={content:[{type:'text',text:'Fixture provider accepted job'}],...(mode==='tool_error'?{isError:true}:{structuredContent:{job_ids:[randomUUID()],status:'queued'}})};}else result={content:[{type:'text',text:'Fixture read response'}]};}
  else throw Error('Unexpected RPC');return Response.json({jsonrpc:'2.0',id:command.id,result});
 };
 async function call(path:string,method='GET',payload?:unknown,actor:keyof typeof sessions|'none'='owner',expected=200){const headers:Record<string,string>={Origin:origin};if(actor!=='none')headers.Cookie='coatria_session='+sessions[actor];if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/'));const value=response.status===303?{}:await response.json();assert.equal(response.status,expected,`${method} ${path} returned ${JSON.stringify(value)}`);assert(!JSON.stringify(value).includes(access));assert(!JSON.stringify(value).includes(refresh));return {response,value};}
 let proposal:any;
 try{
  for(const[id,name]of [[owner,'owner'],[member,'member'],[other,'other']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[id,name,id+'@example.invalid','fixture']);
  for(const id of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Fixture', $2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[company,owner,member,foreign,other]);
  for(const[who,user]of [['owner',owner],['member',member],['other',other]] as const)await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[who]),user]);
  await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'vfx-boutique',1,$2)",[company,owner]);
  await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Higgsfield fixture','Internal','Original test',$3,'allowed',$4)",[project,company,JSON.stringify({width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),owner]);
  await t.test('connect requires own-company admin; OAuth is session-bound, one-use and does not generate',async()=>{
   await call(prefix,'GET',undefined,'none',401);await call(prefix+'/connect','POST',{},'member',403);await call(prefix+'/connect','POST',{},'other',404);
   const begun=(await call(prefix+'/connect','POST',{})).value,auth=new URL(begun.authorizationUrl),state=auth.searchParams.get('state')!;
   assert.equal(auth.origin,issuer);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('redirect_uri'),callback);
   await call('higgsfield/callback?state='+state+'&code=fixture','GET',undefined,'member',403);
   await call('higgsfield/callback?state='+state+'&code=fixture&iss='+encodeURIComponent(issuer),'GET',undefined,'owner',303);
   await call('higgsfield/callback?state='+state+'&code=fixture','GET',undefined,'owner',409);
   const connected=(await call(prefix)).value;assert.equal(connected.status,'connected');assert(!connected.tools.some((x:any)=>x.name==='workspace_select'));assert.equal(exchanges,1);assert.equal(paid,0);
  });
  await t.test('proposal replay is exact and has no provider effect; project gates guard spending',async()=>{
   const input={clientId:randomUUID(),projectId:project,projectRevision:1,tool:'generate_image',arguments:{prompt:'An original cream jar'},note:'Original concept test'};
   proposal=(await call(prefix+'/requests','POST',input,'owner',201)).value.request;
   assert.equal((await call(prefix+'/requests','POST',input,'owner',201)).value.replayed,true);
   await call(prefix+'/requests','POST',{...input,arguments:{prompt:'Changed'}},'owner',409);assert.equal(paid,0);
   await call(`${prefix}/requests/${proposal.id}/execute`,'POST',{requestHash:proposal.requestHash,creditConsent:true},'owner',409);
   await call(`${prefix}/requests/${proposal.id}/execute`,'POST',{requestHash:proposal.requestHash,creditConsent:false},'owner',400);
   await call(`${prefix}/requests/${proposal.id}/execute`,'POST',{requestHash:proposal.requestHash,creditConsent:true},'member',403);
   await query('UPDATE studio_projects SET gates=$2 WHERE id=$1',[project,JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(k=>[k,{decision:'approved'}])))]);
  });
  await t.test('one durable approved intent sends once and preserves provider response without claiming completed media',async()=>{
   const result=(await call(`${prefix}/requests/${proposal.id}/execute`,'POST',{requestHash:proposal.requestHash,creditConsent:true})).value;
   assert.equal(paid,1);assert.equal(result.status,'returned');assert.equal(result.mediaCompleted,false);
   assert.equal((await call(`${prefix}/requests/${proposal.id}/execute`,'POST',{requestHash:proposal.requestHash,creditConsent:true})).value.replayed,true);assert.equal(paid,1);
   const list=(await call(prefix+'/requests?projectId='+project)).value;assert.equal(list.requests[0].hasReceipt,true);assert(!('result'in list.requests[0]));const exact=(await call(prefix+'/requests?projectId='+project+'&requestId='+proposal.id)).value;assert.equal(exact.request.result.structuredContent.status,'queued');
  });
  await t.test('uncertain provider response cannot be replayed; read operations cannot invoke generation or select workspace',async()=>{
   mode='uncertain';const r=(await call(prefix+'/requests','POST',{clientId:randomUUID(),projectId:project,projectRevision:1,tool:'generate_image',arguments:{prompt:'Another original concept'},note:'Uncertain test'},'owner',201)).value.request;
   const first=(await call(`${prefix}/requests/${r.id}/execute`,'POST',{requestHash:r.requestHash,creditConsent:true})).value;assert.equal(first.status,'uncertain');assert.equal(paid,2);
   await call(`${prefix}/requests/${r.id}/execute`,'POST',{requestHash:r.requestHash,creditConsent:true});assert.equal(paid,2);
   await call(prefix+'/read','POST',{tool:'generate_image',arguments:{}},'owner',400);await call(prefix+'/read','POST',{tool:'workspace_select',arguments:{}},'owner',400);
   await query("UPDATE higgsfield_connections SET expires_at=now()-interval '1 minute' WHERE company_id=$1",[company]);await call(prefix+'/read','POST',{tool:'balance',arguments:{}});assert.equal(refreshes,1);
  });
  await t.test('official tool errors are receipts rather than completed media; agent reads are bounded',async()=>{
   mode='tool_error';const r=(await call(prefix+'/requests','POST',{clientId:randomUUID(),projectId:project,projectRevision:1,tool:'generate_video',arguments:{prompt:'Video concept'},note:'Tool error test'},'owner',201)).value.request;
   const result=(await call(`${prefix}/requests/${r.id}/execute`,'POST',{requestHash:r.requestHash,creditConsent:true})).value;assert.equal(result.status,'returned');assert.equal(result.result.isError,true);assert.equal(result.mediaCompleted,false);
   const {higgsfieldAgentRequests,higgsfieldAgentConnection}=await import('../src/lib/higgsfield');const {transaction}=await import('../src/lib/db');
   await query('UPDATE higgsfield_requests SET result=$2 WHERE id=$1',[r.id,JSON.stringify({content:[{type:'text',text:'x'.repeat(200000)}]})]);
   const compact=await transaction(db=>higgsfieldAgentRequests(db,company,{projectId:project,requestId:r.id}));assert.equal(compact.request.resultTruncated,true);assert(Buffer.byteLength(JSON.stringify(compact))<12000);
   const catalog=await transaction(db=>higgsfieldAgentConnection(db,company));assert(catalog.tools.every((item:any)=>!('inputSchema' in item)));
   const schema=await transaction(db=>higgsfieldAgentConnection(db,company,'generate_image'));assert.equal(schema.tools.length,1);assert(schema.tools[0].inputSchema);
  });
  await t.test('disconnect destroys stored credential and invalidates proposals; exact revision required',async()=>{
   await call(prefix+'/disconnect','POST',{revision:4},'owner',409);await call(prefix+'/disconnect','POST',{revision:1});
   assert.equal((await query('SELECT sealed FROM higgsfield_connections WHERE company_id=$1',[company])).rows[0].sealed,null);
   await call(prefix+'/read','POST',{tool:'balance',arguments:{}},'owner',409);assert.equal((await call(prefix)).value.status,'disconnected');
  });
  await t.test('new integration records preserve company cascade deletion',async()=>{
   assert(Number((await query('SELECT count(*) AS n FROM higgsfield_requests WHERE company_id=$1',[company])).rows[0].n)>0);
   await query('DELETE FROM companies WHERE id=$1',[company]);
   for(const table of ['higgsfield_requests','higgsfield_connections','higgsfield_oauth_attempts'])assert.equal(Number((await query(`SELECT count(*) AS n FROM ${table} WHERE company_id=$1`,[company])).rows[0].n),0);
  });
 }finally{globalThis.fetch=old.fetch;await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries({DATABASE_URL:old.url,DATABASE_POOL_MAX:old.pool,COATRIA_HOSTING_KEYRING:old.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
