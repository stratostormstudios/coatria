import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {hashToken,ApiError} from '../src/lib/security';
import {higgsfieldRoute} from '../src/lib/higgsfield';
import {openHiggsfieldSecret,sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {HIGGSFIELD_MCP_ENDPOINT,HIGGSFIELD_OAUTH_REDIRECT_URI} from '../src/lib/higgsfield-mcp';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('rotating Higgsfield refresh has a committed crash fence and exact authority on publication',{
  skip:!emulate&&!integrationUrl,timeout:120000,
},async t=>{
  const old={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch};
  const keyring=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});
  process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=keyring;
  let stop:(()=>Promise<void>)|undefined;
  if(emulate){
    const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();
    for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));
    const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
    process.env.DATABASE_URL='postgresql://postgres:postgres@'+server.getServerConn()+'/postgres';stop=async()=>{await server.stop();await db.close();};
  }
  const companyId=randomUUID(),userId=randomUUID(),session=randomUUID();let connectionId=randomUUID();
  const path=`companies/${companyId}/higgsfield`,origin='https://coatria.com',oldAccess='fixture-old-'+randomUUID(),oldRefresh='fixture-refresh-'+randomUUID(),newAccess='fixture-new-'+randomUUID(),newRefresh='fixture-rotated-'+randomUUID();
  const issuer='https://clerk.higgsfield.ai',metadata={resource:HIGGSFIELD_MCP_ENDPOINT,issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',registration_endpoint:issuer+'/oauth/register',scopes:['openid','email','offline_access']};
  const client={client_id:'fixture-client',redirect_uris:[HIGGSFIELD_OAUTH_REDIRECT_URI],token_endpoint_auth_method:'none'};
  let exchanges=0,toolCalls=0,mode:'ok'|'uncertain'|'pause'|'publication-failure'='ok';
  let arrived:(()=>void)|undefined,release:(()=>void)|undefined,waiting:Promise<void>|undefined;
  const current=async()=>(await query('SELECT * FROM higgsfield_connections WHERE company_id=$1',[companyId])).rows[0];
  async function reset(){
    process.env.COATRIA_HOSTING_KEYRING=keyring;mode='ok';exchanges=0;toolCalls=0;connectionId=randomUUID();
    await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[companyId,userId]);
    const sealed=sealHiggsfieldSecret({metadata,client,token:{access_token:oldAccess,refresh_token:oldRefresh,token_type:'Bearer',expires_in:3600}}, {companyId,id:connectionId,purpose:'oauth-connection'});
    await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,7,'connected',$3,$4,clock_timestamp()-interval '1 minute',$5) ON CONFLICT(company_id) DO UPDATE SET id=EXCLUDED.id,revision=7,status='connected',connected_by=EXCLUDED.connected_by,sealed=EXCLUDED.sealed,expires_at=EXCLUDED.expires_at,tools=EXCLUDED.tools",[companyId,connectionId,userId,JSON.stringify(sealed),JSON.stringify([{name:'balance',description:'Fixture',inputSchema:{type:'object'}}])]);
  }
  async function call(suffix:string,body:unknown){
    const parts=(path+suffix).split('/'),response=await higgsfieldRoute(new Request(origin+'/api/'+parts.join('/'),{method:'POST',headers:{Origin:origin,Cookie:'coatria_session='+session,'Content-Type':'application/json'},body:JSON.stringify(body)}),parts,'POST');
    assert(response);return response.json();
  }
  const read=()=>call('/read',{tool:'balance',arguments:{}});
  const unavailable=(error:unknown)=>error instanceof ApiError&&[403,409].includes(error.status);
  function pause(){mode='pause';const started=new Promise<void>(resolve=>{arrived=resolve;});waiting=new Promise<void>(resolve=>{release=resolve;});return started;}
  globalThis.fetch=async(url,init)=>{
    assert.equal(init?.redirect,'error');
    if(String(url)===metadata.token_endpoint){
      exchanges++;const form=new URLSearchParams(String(init?.body));assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),oldRefresh);
      // This query uses another transaction after the helper committed. With a
      // one-connection emulator it would block if refresh still held the lock.
      const fence=await current();assert.equal(fence.status,'reconnect_required');assert.equal(fence.sealed,null);assert.equal(fence.revision,7);assert.equal(fence.id,connectionId);
      if(mode==='uncertain')throw Error('Synthetic lost rotating-token response');
      if(mode==='pause'){arrived?.();await waiting;}
      if(mode==='publication-failure')process.env.COATRIA_HOSTING_KEYRING='invalid-fixture-keyring';
      return Response.json({access_token:newAccess,refresh_token:newRefresh,token_type:'Bearer',expires_in:3600});
    }
    assert.equal(String(url),HIGGSFIELD_MCP_ENDPOINT);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+newAccess);
    const input=JSON.parse(String(init?.body));
    if(input.method==='notifications/initialized')return new Response(null,{status:202});
    if(input.method==='initialize')return Response.json({jsonrpc:'2.0',id:input.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
    assert.equal(input.method,'tools/call');assert.equal(input.params.name,'balance');toolCalls++;
    return Response.json({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:'Fixture balance'}]}});
  };
  try{
    await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Refresh fixture',userId+'@example.invalid','fixture']);
    await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Refresh fixture',$2,'blank')",[companyId,companyId]);
    await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);
    await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(session),userId]);

    await t.test('normal refresh seals the rotated token and retains the approved connection revision',async()=>{
      await reset();await read();assert.equal(exchanges,1);assert.equal(toolCalls,1);
      const row=await current();assert.equal(row.status,'connected');assert.equal(row.revision,7);assert.equal(row.id,connectionId);
      const saved=openHiggsfieldSecret<any>(row.sealed,{companyId,id:connectionId,purpose:'oauth-connection'});
      assert.equal(saved.token.access_token,newAccess);assert.equal(saved.token.refresh_token,newRefresh);
      await read();assert.equal(exchanges,1);assert.equal(toolCalls,2);
    });
    await t.test('uncertain rotation destroys the reusable old credential before POST and never repeats it',async()=>{
      await reset();mode='uncertain';await assert.rejects(read(),unavailable);
      assert.equal((await current()).sealed,null);assert.equal((await current()).status,'reconnect_required');
      await assert.rejects(read(),unavailable);assert.equal(exchanges,1);assert.equal(toolCalls,0);
    });
    await t.test('credential publication failure cannot roll back the committed refresh fence',async()=>{
      await reset();mode='publication-failure';await assert.rejects(read(),unavailable);process.env.COATRIA_HOSTING_KEYRING=keyring;
      const row=await current();assert.equal(row.sealed,null);assert.equal(row.status,'reconnect_required');
      await assert.rejects(read(),unavailable);assert.equal(exchanges,1);assert.equal(toolCalls,0);
    });
    await t.test('parallel read cannot duplicate refresh; disconnect wins over an in-flight response',async()=>{
      await reset();const started=pause(),pending=read();await started;
      await assert.rejects(read(),unavailable);assert.equal(exchanges,1);
      await call('/disconnect',{revision:7});release?.();await assert.rejects(pending,unavailable);
      const row=await current();assert.equal(row.status,'disconnected');assert.equal(row.sealed,null);assert.equal(row.revision,8);assert.equal(toolCalls,0);
    });
    await t.test('a new independently authorized connection is never overwritten by old refresh completion',async()=>{
      await reset();const started=pause(),pending=read();await started;
      const replacementId=randomUUID(),replacement=sealHiggsfieldSecret({replacement:true},{companyId,id:replacementId,purpose:'oauth-connection'});
      await query("UPDATE higgsfield_connections SET id=$2,revision=8,status='connected',sealed=$3,expires_at=clock_timestamp()+interval '1 hour' WHERE company_id=$1",[companyId,replacementId,JSON.stringify(replacement)]);
      release?.();await assert.rejects(pending,unavailable);const row=await current();assert.equal(row.id,replacementId);assert.equal(row.revision,8);assert.deepEqual(row.sealed,replacement);assert.equal(exchanges,1);assert.equal(toolCalls,0);
    });
    await t.test('administrator revocation during refresh prevents credential publication',async()=>{
      await reset();const started=pause(),pending=read();await started;
      await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companyId,userId]);release?.();await assert.rejects(pending,unavailable);
      const row=await current();assert.equal(row.status,'reconnect_required');assert.equal(row.sealed,null);assert.equal(exchanges,1);assert.equal(toolCalls,0);
    });
  }finally{
    release?.();globalThis.fetch=old.fetch;process.env.COATRIA_HOSTING_KEYRING=keyring;
    if(!emulate){await query('DELETE FROM higgsfield_connections WHERE company_id=$1',[companyId]);await query('DELETE FROM sessions WHERE user_id=$1',[userId]);await query('DELETE FROM memberships WHERE company_id=$1',[companyId]);await query('DELETE FROM companies WHERE id=$1',[companyId]);await query('DELETE FROM users WHERE id=$1',[userId]);}
    await database().end();delete(globalThis as any).coatriaPool;await stop?.();
    for(const[key,value]of Object.entries({DATABASE_URL:old.url,DATABASE_POOL_MAX:old.pool,COATRIA_HOSTING_KEYRING:old.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
