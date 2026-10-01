import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {openHiggsfieldSecret,sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {recordHiggsfieldModelContracts} from '../src/lib/higgsfield-model-contract-db';
import {normalizeHiggsfieldModelContract} from '../src/lib/higgsfield-model-contract';
import type {HiggsfieldTool} from '../src/lib/higgsfield-mcp';
import {observedImageModel,observedImageTool} from './fixtures/higgsfield-model-contract';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const origin='https://coatria.com',endpoint='https://mcp.higgsfield.ai/mcp',issuer='https://clerk.higgsfield.ai';
const modelId=observedImageModel.id;
const exactTool:HiggsfieldTool={name:'models_get',description:'Synthetic exact metadata read',inputSchema:{type:'object',properties:{model_id:{type:'string'}},required:['model_id'],additionalProperties:false}};
const listTool:HiggsfieldTool={name:'models_list',description:'Synthetic bounded model page',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function within<T>(work:Promise<T>,message:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),5000);})]);}finally{clearTimeout(timer);}}

test('leased agent model refresh is an authorized bounded read with durable credential fencing',{skip:!emulate&&!integrationUrl,timeout:180000},async t=>{
 const old={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch};
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';
 process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'model-refresh-fixture',keys:{'model-refresh-fixture':randomBytes(32).toString('base64')}});
 let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL='postgresql://postgres:postgres@'+server.getServerConn()+'/postgres';stop=async()=>{await server.stop();await db.close();};}
 const companies:string[]=[],users:string[]=[];
 globalThis.fetch=async()=>{throw Error('No live network is allowed in the model refresh fixture');};
 async function fixture(tools:HiggsfieldTool[]=[observedImageTool,exactTool,listTool]){
  const company=randomUUID(),sponsor=randomUUID(),requester=randomUUID(),connectionSponsor=randomUUID(),agent=randomUUID(),connectionId=randomUUID(),session=randomUUID(),agentToken='ca_'+randomUUID();
  const access='synthetic-access-'+randomUUID(),refresh='synthetic-refresh-'+randomUUID(),rotatedAccess='synthetic-rotated-'+randomUUID(),rotatedRefresh='synthetic-next-refresh-'+randomUUID(),privateProse='PRIVATE_PROVIDER_PROSE_'+randomUUID();
  companies.push(company);users.push(sponsor,requester,connectionSponsor);
  for(const[user,name]of[[sponsor,'Agent sponsor'],[requester,'Administrator requester'],[connectionSponsor,'Connection sponsor']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,name,user+'@example.invalid','not-a-login']);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Model refresh fixture',$2,'blank')",[company,company]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'admin')",[company,sponsor,requester,connectionSponsor]);
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),requester]);
  await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Metadata worker','custom',$3,$4,'members','[\"creative.read\"]')",[agent,company,hashToken(agentToken),sponsor]);
  const credentials={metadata:{resource:endpoint,issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',registration_endpoint:issuer+'/oauth/register',scopes:['openid','email','offline_access']},client:{client_id:'synthetic-client',redirect_uris:[origin+'/api/higgsfield/callback'],token_endpoint_auth_method:'none'},token:{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600}};
  const sealed=sealHiggsfieldSecret(credentials,{companyId:company,id:connectionId,purpose:'oauth-connection'});
  await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour',$5)",[company,connectionId,connectionSponsor,JSON.stringify(sealed),JSON.stringify(tools)]);
  async function api(path:string,payload:unknown,human=false){const response=await handleApi(new Request(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...human?{Cookie:'coatria_session='+session,Origin:origin}:{Authorization:'Bearer '+agentToken}},body:JSON.stringify(payload)}),path.split('/'));return{status:response.status,value:await response.json()};}
  const created=await api(`companies/${company}/conversations/commons/runs`,{clientId:randomUUID(),agentId:agent,prompt:'Read current company model constraints without generating media.'},true);assert.equal(created.status,201,JSON.stringify(created.value));
  const runId=created.value.run.id,claim=await api('agent/runs/claim',{workerId:'model-metadata-fixture',claimId:randomUUID()});assert.equal(claim.status,200,JSON.stringify(claim.value));assert.equal(claim.value.run.id,runId);const leaseToken=claim.value.leaseToken;
  const reads:Array<{name:string;args:Record<string,unknown>}>=[];let network=0,refreshes=0;
  let onRead:(name:string,args:Record<string,unknown>)=>Promise<unknown>=async()=>({content:[{type:'text',text:privateProse}],structuredContent:{...observedImageModel,description:privateProse,provider_name:privateProse}});
  let onRefresh:()=>Promise<Response>=async()=>Response.json({access_token:rotatedAccess,refresh_token:rotatedRefresh,token_type:'Bearer',expires_in:3600});
  globalThis.fetch=async(input,init)=>{
   network++;const url=String(input);assert.equal(init?.redirect,'error');
   if(url===issuer+'/oauth/token'){
    refreshes++;const body=new URLSearchParams(String(init?.body));assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),refresh);
    const fenced=(await query('SELECT status,sealed FROM higgsfield_connections WHERE company_id=$1',[company])).rows[0];assert.equal(fenced.status,'reconnect_required');assert.equal(fenced.sealed,null,'The rotating credential fence must commit before HTTP');
    return onRefresh();
   }
   assert.equal(url,endpoint,'Only the fixed official MCP endpoint is reachable');
   const authorization=new Headers(init?.headers).get('Authorization');assert([access,rotatedAccess].some(token=>authorization==='Bearer '+token));
   const command=JSON.parse(String(init?.body));
   if(command.method==='notifications/initialized')return new Response(null,{status:202});
   if(command.method==='initialize')return Response.json({jsonrpc:'2.0',id:command.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
   assert.equal(command.method,'tools/call');const{name,arguments:args}=command.params;
   assert(['models_get','models_list','models_explore'].includes(name),'Metadata refresh cannot call generation, balance, upload or cost tools');
   reads.push({name,args});return Response.json({jsonrpc:'2.0',id:command.id,result:await onRead(name,args)});
  };
  const tool=(args:Record<string,unknown>,options:{requestId?:string;leaseToken?:string}={})=>api('agent/tools/higgsfield_connection_get',{runId,leaseToken:options.leaseToken??leaseToken,requestId:options.requestId??randomUUID(),arguments:args});
  const cache=()=>query('SELECT * FROM higgsfield_model_contracts WHERE company_id=$1 ORDER BY model_id',[company]).then(r=>r.rows);
  const seed=()=>transaction(db=>recordHiggsfieldModelContracts(db,company,{id:connectionId,revision:1,tools},'models_get',{model_id:modelId},{structuredContent:observedImageModel}));
  // Both ends must use one instant: separate volatile clock reads can exceed
  // the schema's exact 15-minute ceiling by a few microseconds on PostgreSQL.
  const expire=()=>query("UPDATE higgsfield_model_contracts SET observed_at=statement_timestamp()-interval '20 minutes',expires_at=statement_timestamp()-interval '5 minutes' WHERE company_id=$1",[company]);
  const safe=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of [access,refresh,rotatedAccess,rotatedRefresh,agentToken,leaseToken,privateProse])assert(!text.includes(secret),'Credentials and provider prose must not enter model context or cache');};
  return{company,sponsor,requester,connectionSponsor,agent,connectionId,runId,leaseToken,tool,api,cache,seed,expire,safe,reads,tools,privateProse,rotatedAccess,rotatedRefresh,setRead:(read:typeof onRead)=>{onRead=read;},setRefresh:(handler:typeof onRefresh)=>{onRefresh=handler;},counts:()=>({network,refreshes})};
 }
 try{
  await t.test('omitted flag stays network-free; fresh exact and list refreshes are no-ops',async()=>{
   const f=await fixture();await f.seed();
   await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1",[f.company]);
   for(const args of [{},{modelId},{modelId,refreshModels:true},{refreshModels:true}]){const r=await f.tool(args);assert.equal(r.status,200,JSON.stringify(r.value));f.safe(r.value);}
   assert.deepEqual(f.counts(),{network:0,refreshes:0});await f.expire();
   const stale=await f.tool({modelId});assert.equal(stale.status,409);assert.equal(stale.value.code,'HIGGSFIELD_MODEL_CONTRACT_CHANGED');
   const list=await f.tool({});assert.equal(list.status,200);assert.equal(list.value.result.modelCatalog.refreshRequired,true);assert.deepEqual(f.counts(),{network:0,refreshes:0});
  });
  await t.test('stale exact read refreshes through advertised arguments and exposes only normalized evidence',async()=>{
   const f=await fixture();await f.seed();await f.expire();const requestId=randomUUID();
   const r=await f.tool({modelId,refreshModels:true},{requestId});assert.equal(r.status,200,JSON.stringify(r.value));assert.deepEqual(f.reads,[{name:'models_get',args:{model_id:modelId}}]);
   assert.deepEqual(r.value.result.modelContract.descriptor,normalizeHiggsfieldModelContract(observedImageModel));f.safe(r.value);const rows=await f.cache();assert.equal(rows.length,1);f.safe(rows);
   const replay=await f.tool({modelId,refreshModels:true},{requestId});assert.equal(replay.status,200);assert.equal(f.reads.length,1);
   assert.equal((await query('SELECT count(*)::int n FROM higgsfield_requests WHERE company_id=$1',[f.company])).rows[0].n,0);
  });
  await t.test('one bounded list page never follows a cursor or returns provider descriptions',async()=>{
   const f=await fixture();f.setRead(async(name,args)=>{assert.equal(name,'models_list');assert.deepEqual(args,{});return{content:[{type:'text',text:f.privateProse}],structuredContent:{items:Array.from({length:51},(_,i)=>({...observedImageModel,id:'fixture_'+String(i).padStart(3,'0'),description:f.privateProse})),has_more:true,next_page_token:'do-not-follow-private-cursor'}};});
   const r=await f.tool({refreshModels:true});assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(f.reads.length,1);assert.equal(r.value.result.modelCatalog.models.length,50);assert.equal(r.value.result.modelCatalog.hasMore,true);f.safe(r.value);assert(!JSON.stringify(r.value).includes('do-not-follow-private-cursor'));assert.equal((await f.cache()).length,51);
  });
  await t.test('models_explore get/list are supported only through their complete advertised schemas',async()=>{
   // Only assertion fields from the observed 2026-09-30 company schema.
   // Provider descriptions, account metadata and observations stay out of source.
   const explore:HiggsfieldTool={name:'models_explore',description:'Observed schema with annotations omitted',inputSchema:{type:'object',$schema:'https://json-schema.org/draft/2020-12/schema',required:['action'],properties:{type:{enum:['image','video','audio','3d'],type:'string'},after:{type:'string'},input:{enum:['text','image'],type:'string'},limit:{type:'integer',maximum:100,minimum:1},query:{type:'string',maxLength:1024},unlim:{type:'boolean'},action:{enum:['list','search','get','recommend'],type:'string'},model_id:{type:'string'}}}};
   const f=await fixture([observedImageTool,explore]);f.setRead(async(_name,args)=>({content:[],structuredContent:args.action==='get'?observedImageModel:{items:[observedImageModel]}}));
   let r=await f.tool({refreshModels:true});assert.equal(r.status,200,JSON.stringify(r.value));assert.deepEqual(f.reads[0],{name:'models_explore',args:{action:'list'}});await f.expire();r=await f.tool({modelId,refreshModels:true});assert.equal(r.status,200,JSON.stringify(r.value));assert.deepEqual(f.reads[1],{name:'models_explore',args:{action:'get',model_id:modelId}});
   const g=await fixture([observedImageTool,{...exactTool,inputSchema:{...exactTool.inputSchema,required:['model_id','unprovided']}}]);const denied=await g.tool({modelId,refreshModels:true});assert.equal(denied.status,409);assert.equal(denied.value.code,'HIGGSFIELD_MODEL_REFRESH_UNSUPPORTED');assert.equal(g.counts().network,0);
  });
  await t.test('revoked identity, requester/sponsors, missing grants and wrong lease never reach OAuth or MCP',async()=>{
   const cases:Array<{name:string;change:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<unknown>;status:number;lease?:string}>=[
    {name:'agent',change:f=>query("UPDATE agents SET status='revoked' WHERE id=$1",[f.agent]),status:401},
    {name:'requester',change:f=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.requester]),status:403},
    {name:'non-admin requester',change:f=>query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.company,f.requester]),status:403},
    {name:'agent sponsor',change:f=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.sponsor]),status:401},
    {name:'connection sponsor',change:f=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.connectionSponsor]),status:403},
    {name:'agent grant',change:f=>query("UPDATE agents SET capabilities='[]' WHERE id=$1",[f.agent]),status:403},
    {name:'run grant',change:f=>query("UPDATE agent_runs SET capabilities='[]' WHERE id=$1",[f.runId]),status:403},
    {name:'expired lease',change:f=>query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.runId]),status:409},
    {name:'lease',change:async()=>{},status:409,lease:'incorrect-synthetic-lease-proof'},
   ];
   for(const c of cases){const f=await fixture();await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1",[f.company]);await c.change(f);const r=await f.tool({modelId,refreshModels:true},{leaseToken:c.lease});assert.equal(r.status,c.status,c.name+': '+JSON.stringify(r.value));assert.equal(f.counts().network,0,c.name);assert.equal((await f.cache()).length,0);}
  });
  await t.test('authority revocation during an unlocked provider read rejects both cache and tool receipt',async()=>{
   const changes=[
    {name:'cancel',mutate:(f:Awaited<ReturnType<typeof fixture>>)=>query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE id=$1",[f.runId])},
    {name:'agent revoke',mutate:(f:Awaited<ReturnType<typeof fixture>>)=>query("UPDATE agents SET status='revoked' WHERE id=$1",[f.agent])},
    {name:'requester revoke',mutate:(f:Awaited<ReturnType<typeof fixture>>)=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.requester])},
    {name:'connection sponsor revoke',mutate:(f:Awaited<ReturnType<typeof fixture>>)=>query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.connectionSponsor])},
   ];
   for(const c of changes){const f=await fixture(),entered=deferred(),release=deferred(),requestId=randomUUID();f.setRead(async()=>{entered.resolve();await release.promise;return{content:[],structuredContent:observedImageModel};});const pending=f.tool({modelId,refreshModels:true},{requestId});try{await within(entered.promise,'Provider read did not start');await within(c.mutate(f),'Provider read held a database transaction across network I/O');}finally{release.resolve();}const r=await pending;assert([401,403,409].includes(r.status),c.name+': '+JSON.stringify(r.value));assert.equal((await f.cache()).length,0,c.name);assert.equal((await query('SELECT count(*)::int n FROM agent_tool_receipts WHERE company_id=$1 AND request_id=$2',[f.company,requestId])).rows[0].n,0);}
  });
  await t.test('a refresh absent from the recorded inference batch is denied before credential or metadata I/O',async()=>{
   const f=await fixture(),host=randomUUID(),provision=randomUUID(),hash='a'.repeat(64);
   // Minimal persisted inference evidence under the existing FK contracts. No
   // host is enrolled, no worker starts and no inference provider is invoked.
   await query("INSERT INTO studio_managed_hosts(id,company_id,created_by,client_id,request_hash,token_hash,name,max_agents,provider_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,'Synthetic inference guard',1,'[\"runpod\"]',clock_timestamp()+interval '1 hour')",[host,f.company,f.sponsor,randomUUID(),hash,hashToken(host)]);
   await query("INSERT INTO studio_host_provisions(id,company_id,created_by,client_id,request_hash,plan,plan_hash,preset,host_id,pod_name) VALUES($1,$2,$3,$4,$5,'{}',$5,'{}',$6,$7)",[provision,f.company,f.sponsor,randomUUID(),hash,host,'synthetic-'+provision]);
   await query("INSERT INTO studio_inference_jobs(company_id,agent_id,run_id,host_id,provision_id,request_id,step,request_hash,agent_sponsor_id,agent_token_hash,lease_token_hash,installation_id,installation_revision,preset_hash,endpoint_id,model_id,limits,request_body,reserved_tokens,status,model_calls,deadline_at) SELECT r.company_id,r.agent_id,r.id,$2,$3,$4,0,$5,a.created_by,a.token_hash,r.lease_token_hash,$6,1,$5,'synthetic-endpoint','synthetic-model','{}','{}',1,'succeeded','[]',clock_timestamp()+interval '1 hour' FROM agent_runs r JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id WHERE r.id=$1",[f.runId,host,provision,randomUUID(),hash,randomUUID()]);
   await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1",[f.company]);
   const r=await f.tool({modelId,refreshModels:true});assert.equal(r.status,409,JSON.stringify(r.value));assert.equal(r.value.code,'INFERENCE_TOOL_MISMATCH');assert.deepEqual(f.counts(),{network:0,refreshes:0});assert.equal((await f.cache()).length,0);
  });
  await t.test('connection revision and catalog drift during metadata I/O cannot mint a current contract',async()=>{
   for(const drift of ['revision','catalog'] as const){const f=await fixture(),entered=deferred(),release=deferred();f.setRead(async()=>{entered.resolve();await release.promise;return{content:[],structuredContent:observedImageModel};});const pending=f.tool({modelId,refreshModels:true});try{await within(entered.promise,'Provider read did not start');await within(drift==='revision'?query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[f.company]):query('UPDATE higgsfield_connections SET tools=$2 WHERE company_id=$1',[f.company,JSON.stringify([...f.tools,{name:'new_tool',description:'drift',inputSchema:{type:'object'}}])]),'Connection update was blocked by provider I/O');}finally{release.resolve();}const r=await pending;assert.equal(r.status,409,JSON.stringify(r.value));assert.equal((await f.cache()).length,0);}
  });
  await t.test('an incompatible new descriptor durably retires old support despite exact getter rejection',async()=>{
   const f=await fixture();await f.seed();await f.expire();f.setRead(async()=>({content:[],structuredContent:{...observedImageModel,unreviewed_constraint:true}}));
   const r=await f.tool({modelId,refreshModels:true});assert.equal(r.status,409,JSON.stringify(r.value));const rows=await f.cache();assert.equal(rows.length,1);assert.equal(rows[0].descriptor,null);assert.equal(rows[0].descriptor_sha256,null);assert(new Date(rows[0].expires_at).getTime()>Date.now());const before=f.counts().network;assert.equal((await f.tool({modelId})).status,409);assert.equal(f.counts().network,before);
  });
  await t.test('a reconnect or catalog edit before credential acquisition cannot rotate a successor credential',async()=>{
   for(const drift of ['id','revision','catalog'] as const){
    const f=await fixture();await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1",[f.company]);
    const pool=database(),original=pool.query;let changed=false,expectedSealed:unknown;
    // The rate-limit write is the first independent DB phase after metadata
    // preparation. Mutate its real persisted connection before returning it,
    // deterministically exercising the pre-credential race without live I/O.
    (pool as any).query=async(sql:string,values:unknown[])=>{
     const result=await (original as any).call(pool,sql,values);
     if(!changed&&sql.startsWith('INSERT INTO rate_limits')&&values[0]===hashToken('higgsfield-models:'+f.company)){
      changed=true;const current=(await (original as any).call(pool,'SELECT sealed FROM higgsfield_connections WHERE company_id=$1',[f.company])).rows[0];expectedSealed=current.sealed;
      if(drift==='id'){
       const replacement=randomUUID(),saved=openHiggsfieldSecret(current.sealed,{companyId:f.company,id:f.connectionId,purpose:'oauth-connection'});expectedSealed=sealHiggsfieldSecret(saved,{companyId:f.company,id:replacement,purpose:'oauth-connection'});
       await (original as any).call(pool,'UPDATE higgsfield_connections SET id=$2,sealed=$3,revision=revision+1 WHERE company_id=$1',[f.company,replacement,JSON.stringify(expectedSealed)]);
      }else if(drift==='revision')await (original as any).call(pool,'UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[f.company]);
      else await (original as any).call(pool,'UPDATE higgsfield_connections SET tools=$2 WHERE company_id=$1',[f.company,JSON.stringify([...f.tools,{name:'changed_catalog',description:'synthetic',inputSchema:{type:'object'}}])]);
     }
     return result;
    };
    let r:Awaited<ReturnType<typeof f.tool>>;try{r=await f.tool({modelId,refreshModels:true});}finally{pool.query=original;}
    assert(changed);assert.equal(r.status,409,drift+': '+JSON.stringify(r.value));assert.equal(r.value.code,'HIGGSFIELD_MODEL_CONTRACT_CHANGED');assert.deepEqual(f.counts(),{network:0,refreshes:0});
    const current=(await query('SELECT status,sealed FROM higgsfield_connections WHERE company_id=$1',[f.company])).rows[0];assert.equal(current.status,'connected');assert.deepEqual(current.sealed,expectedSealed);assert.equal((await f.cache()).length,0);
   }
  });
  await t.test('expired OAuth rotates once behind a committed fence and never exposes credential material',async()=>{
   const f=await fixture();await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1",[f.company]);const r=await f.tool({modelId,refreshModels:true});assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(f.counts().refreshes,1);assert.equal(f.reads.length,1);f.safe(r.value);f.safe(await f.cache());
   const row=(await query('SELECT * FROM higgsfield_connections WHERE company_id=$1',[f.company])).rows[0];assert.equal(row.status,'connected');assert.equal(row.revision,1);const secret=openHiggsfieldSecret<{token:{access_token:string;refresh_token:string}}>(row.sealed,{companyId:f.company,id:f.connectionId,purpose:'oauth-connection'});assert.equal(secret.token.access_token,f.rotatedAccess);assert.equal(secret.token.refresh_token,f.rotatedRefresh);
   assert.equal((await f.tool({modelId,refreshModels:true})).status,200);assert.equal(f.counts().refreshes,1);
  });
  await t.test('lost rotating-token response remains reconnect-required without repeated refresh or model read',async()=>{
   const f=await fixture();await query("UPDATE higgsfield_connections SET expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1",[f.company]);f.setRefresh(async()=>{throw Error(f.privateProse);});
   const r=await f.tool({modelId,refreshModels:true});assert.equal(r.status,409,JSON.stringify(r.value));f.safe(r.value);assert.equal(f.counts().refreshes,1);assert.equal(f.reads.length,0);const row=(await query('SELECT status,sealed FROM higgsfield_connections WHERE company_id=$1',[f.company])).rows[0];assert.equal(row.status,'reconnect_required');assert.equal(row.sealed,null);
   const before=f.counts().network;assert.equal((await f.tool({modelId,refreshModels:true})).status,409);assert.equal(f.counts().network,before);assert.equal((await f.cache()).length,0);
  });
 }finally{
  globalThis.fetch=old.fetch;
  try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries({DATABASE_URL:old.url,DATABASE_POOL_MAX:old.pool,COATRIA_HOSTING_KEYRING:old.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 }
});
