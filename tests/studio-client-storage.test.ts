import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {database,transaction} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {errorResponse,hashToken} from '../src/lib/security';
import {setupStudio} from '../src/lib/studio';
import {updateProjectStorageFile} from '../src/lib/project-storage';
import {issueStudioClientStorageAccess,authorizeStudioClientStorageGrant} from '../src/lib/studio-client-storage';
import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {authorityReader} from '../src/lib/project-storage-stream';
import type {RunpodProjectStorage,RunpodProjectStorageConfig} from '../src/lib/project-storage-runpod';
import {makeGeneratedClientPackageFixture,type GeneratedFixtureKind} from './fixtures/generated-client-delivery';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPg=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
type Row=Record<string,any>;
const origin='http://localhost:4180';
const credentials={accessKeyId:['user','client-fixture'].join('_'),secretAccessKey:['rps','client-fixture-key'].join('_')};
const stream=(body:Buffer)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(body);c.close();}});

test('closing an authority reader drains an already running authority query',async()=>{
 let begin!:()=>void,finish!:()=>void;const began=new Promise<void>(resolve=>{begin=resolve;}),queryDone=new Promise<void>(resolve=>{finish=resolve;});
 const reader=authorityReader(new ReadableStream<Uint8Array>().getReader(),async()=>{begin();await queryDone;}),reading=reader.read();await began;
 let closed=false;const closing=reader.close().then(()=>{closed=true;});try{await delay(10);assert.equal(closed,false);}finally{finish();}
 await closing;assert.equal(closed,true);assert.equal((await reading).done,true);
});

test('external client gateway serves only approved exact versions through isolated HTTP',{skip:!emulate&&!localPg,timeout:240000},async t=>{
 const prior={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING,COATRIA_STORAGE_GATEWAY_ENABLED:process.env.COATRIA_STORAGE_GATEWAY_ENABLED,COATRIA_STORAGE_GATEWAY_URL:process.env.COATRIA_STORAGE_GATEWAY_URL};
 const dbName='coatria_client_storage_'+randomUUID().replaceAll('-',''),key=Buffer.alloc(32,38),keyId='client-storage-fixture';let control:Pool|undefined,stop:(()=>Promise<void>)|undefined,server:Server|undefined,created=false;
 process.env.DATABASE_POOL_MAX=emulate?'1':'6';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:keyId,keys:{[keyId]:key.toString('base64')}});process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';
 const users={owner:randomUUID(),registrar:randomUUID(),reviewer:randomUUID(),client:randomUUID(),other:randomUUID()},sessions=Object.fromEntries(Object.keys(users).map(k=>[k,randomUUID()]));
 let gateway:ReturnType<typeof createProjectStorageGateway>,db:Pool,gatewayOrigin='';
 type Hooks={beforeRead?:()=>Promise<void>;read?:(body:Buffer)=>ReadableStream<Uint8Array>;metadata?:Row};
 async function call(path:string,method:string,payload:unknown,actor:keyof typeof users,expected=200){const request=new Request(origin+'/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+sessions[actor],'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});let response;try{response=await handleApi(request,path.split('?')[0].split('/'));}catch(e){response=errorResponse(e);}const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;}
 async function fixture(kind:GeneratedFixtureKind='image',hooks:Hooks={}){
  const companyId=randomUUID();await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Isolated external storage fixture',$2,'blank')",[companyId,companyId]);
  for(const userId of[users.owner,users.registrar,users.reviewer])await db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin')",[companyId,userId]);
  await transaction(c=>setupStudio(c,{companyId,userId:users.owner},{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'comp',humanId:users.owner}]}));
  const f=await makeGeneratedClientPackageFixture({db,transaction,call,companyId,users},kind);
  // A real test-only encrypted envelope exercises the trusted vault path. The
  // injected byte provider never contacts Runpod and receives no real secrets.
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(JSON.stringify(['coatria:project-storage:v1',companyId,f.storageId])));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(credentials),'utf8'),cipher.final()]);
  await db.query('UPDATE project_storage_connections SET secret_envelope=$2 WHERE id=$1',[f.storageId,JSON.stringify({keyId,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})]);
  const shared=await call(`companies/${companyId}/studio/projects/${f.projectId}/client-deliveries`,'POST',{clientId:randomUUID(),revision:f.revision,deliveryId:f.delivery.id,recipientUserId:users.client,identityConfirmation:'confirmed_out_of_band',expiresAt:new Date(Date.now()+3600000).toISOString()},'owner',201),shareId=shared.share.id;
  const counts={get:0,close:0,cancel:0};let lastSignal:AbortSignal|undefined;
  const providerFactory=(config:RunpodProjectStorageConfig):RunpodProjectStorage=>{assert.equal(config.companyId,companyId);assert.equal(config.projectId,f.projectId);assert.deepEqual(config.credentials,credentials);assert(config.timeoutMs!>0&&config.timeoutMs!<=60000);const forbidden=async()=>{throw Error('Client download cannot mutate provider storage');};return {verifyBucketAccess:forbidden,list:forbidden,head:forbidden,createMultipart:forbidden,uploadPart:forbidden,completeMultipart:forbidden,abortMultipart:forbidden,validateMultipart(){throw Error('No upload handle');},close(){counts.close++;},async get(input){counts.get++;lastSignal=input.signal;assert.equal(input.versionId,f.versionId);assert.equal(input.ifMatch,'"synthetic-etag"');await hooks.beforeRead?.();const part=input.range?f.body.subarray(input.range.start,input.range.end+1):f.body;return{stream:hooks.read?.(part)??stream(part),bytes:part.length,totalBytes:f.bytes,etag:'"synthetic-etag"',contentType:f.contentType,range:input.range??null,contentRange:input.range?`bytes ${input.range.start}-${input.range.end}/${f.bytes}`:null,...hooks.metadata};}};};
  const own=createProjectStorageGateway({providerFactory,allowedOrigins:[origin]});
  const access=()=>transaction(c=>issueStudioClientStorageAccess(c,{shareId,recipientUserId:users.client,versionId:f.versionId}));
  const request=async(a:Awaited<ReturnType<typeof access>>,range?:string,signal?:AbortSignal)=>{gateway=own;return fetch(a.url,{headers:{...a.headers,Origin:origin,...range?{Range:range}:{}},signal});};
  return{...f,companyId,shareId,counts,hooks,own,providerFactory,access,request,get lastSignal(){return lastSignal;}};
 }
 async function activateRevision(f:Awaited<ReturnType<typeof fixture>>){
  const prefix=`companies/${f.companyId}/studio/projects/${f.projectId}`,portal='client-deliveries/'+f.shareId;
  const change=await call(portal+'/responses','POST',{clientId:randomUUID(),revision:1,decision:'changes_requested',note:'A separately approved correction is required.'},'client',201),share=(await db.query('SELECT package_hash FROM studio_client_deliveries WHERE id=$1',[f.shareId])).rows[0],unit=(await db.query('SELECT shot_id FROM studio_work_items WHERE id=$1',[f.workItemId])).rows[0];
  const draft=await call(prefix+'/generated-revisions','POST',{clientId:randomUUID(),projectRevision:change.project.revision,shareId:f.shareId,receiptId:change.receipt.id,packageSha256:share.package_hash,summary:'One source-bound correction',items:[{unitId:unit.shot_id,action:'regenerate',instructions:'Prepare a fresh correction.'}]},'owner',201);
  const applied=await call(prefix+`/generated-revisions/${draft.plan.id}/apply`,'POST',{clientId:randomUUID(),projectRevision:change.project.revision,planSha256:draft.plan.planSha256},'owner',201);
  await db.query('UPDATE studio_projects SET gates=gates||$2::jsonb WHERE id=$1',[f.projectId,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);
  await db.query("UPDATE tasks SET status='done' WHERE id IN(SELECT w.task_id FROM studio_work_items w JOIN studio_generated_revision_work rw ON rw.work_item_id=w.id WHERE rw.round_id=$1)",[applied.round.id]);
  return {packageSha256:share.package_hash};
 }
 try{
  if(emulate){const{PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),pg=await PGlite.create();for(const file of(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await pg.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:4});await socket.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;stop=async()=>{await socket.stop();await pg.close();};}
  else{control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;process.env.DATABASE_URL=url.href;}
  db=database();if(!emulate)for(const file of(await readdir('database')).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.query(await readFile('database/'+file,'utf8'));
  await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  for(const[name,userId]of Object.entries(users)){await db.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','fixture']);await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name]),userId]);}
  server=createServer(async(req,res)=>{const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});try{const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);const response=await gateway.handle(new Request(gatewayOrigin+req.url,{method:req.method,headers,signal:abort.signal}));res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)await pipeline(Readable.fromWeb(response.body as any),res);else res.end();}catch{res.destroy();}});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));gatewayOrigin=`http://127.0.0.1:${(server.address() as any).port}`;process.env.COATRIA_STORAGE_GATEWAY_URL=gatewayOrigin;

  await t.test('gateway readiness requires the storage baseline and external recipient migration',async()=>{
   gateway=createProjectStorageGateway();let r=await fetch(gatewayOrigin+'/health');assert.equal(r.status,503);await r.body?.cancel();await db.query("INSERT INTO schema_migrations(name) VALUES('027_project_storage.sql')");r=await fetch(gatewayOrigin+'/health');assert.equal(r.status,503);await r.body?.cancel();await db.query("INSERT INTO schema_migrations(name) VALUES('032_studio_generated_client_delivery.sql')");r=await fetch(gatewayOrigin+'/health');assert.equal(r.status,503);await r.body?.cancel();await db.query("INSERT INTO schema_migrations(name) VALUES('033_studio_generated_revisions.sql')");r=await fetch(gatewayOrigin+'/health');assert.equal(r.status,503);await r.body?.cancel();await db.query("INSERT INTO schema_migrations(name) VALUES('034_studio_coordinator_generation.sql')");r=await fetch(gatewayOrigin+'/health');assert.equal(r.status,200);assert.deepEqual(await r.json(),{service:'coatria-storage-gateway',status:'ready',schemaVersion:4});
  });
  await t.test('image/video/audio exact range and full downloads use isolated capabilities after historical archive expiry',async()=>{
   for(const kind of['image','video','audio'] as const){const f=await fixture(kind),a=await f.access();assert.equal(a.transport,'project_storage');assert.equal(a.storageVersionId,f.versionId);assert.equal(a.sha256,f.fileHash);assert.equal(a.contentType,f.contentType);assert.equal(a.bytes,f.bytes);
    const ranged=await f.request(a,'bytes=2-7');assert.equal(ranged.status,206);assert.equal(ranged.headers.get('Content-Range'),`bytes 2-7/${f.bytes}`);assert.equal(ranged.headers.get('Content-Length'),'6');assert.equal(ranged.headers.get('X-Content-SHA256'),f.fileHash);assert.equal(ranged.headers.get('Content-Type'),'application/octet-stream');assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),f.body.subarray(2,8));
    const all=await f.request(await f.access());assert.equal(all.status,200);assert.deepEqual(Buffer.from(await all.arrayBuffer()),f.body);assert.equal(f.counts.get,2);assert.equal(f.counts.close,2);
    const grants=(await db.query('SELECT token_hash,extract(epoch FROM(expires_at-created_at))::float8 AS seconds FROM studio_client_storage_grants WHERE share_id=$1',[f.shareId])).rows;assert.equal(grants.length,2);assert(grants.every(g=>g.seconds<=60));assert(!JSON.stringify(grants).includes(a.headers.Authorization.slice(7)));assert.equal((await db.query('SELECT count(*)::int AS n FROM memberships WHERE company_id=$1 AND user_id=$2',[f.companyId,users.client])).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM project_storage_access_receipts WHERE company_id=$1',[f.companyId])).rows[0].n,0);
   }
  });
  await t.test('an issued client token cannot serve a superseded round even after new gates and tasks are ready',async()=>{
   const f=await fixture(),a=await f.access(),changed=await activateRevision(f);
   const rejected=await f.request(a);assert.equal(rejected.status,403);assert.equal((await rejected.json()).code,'CLIENT_STORAGE_UNAVAILABLE');assert.equal(f.counts.get,0);
   await assert.rejects(f.access(),(error:any)=>error.code==='CLIENT_STORAGE_UNAVAILABLE');
   const history=await call('client-deliveries/'+f.shareId,'GET',undefined,'client');assert.equal(history.share.packageSha256,changed.packageSha256);assert.equal(history.canRespond,false);
  });
  await t.test('tokens cannot cross versions, companies, ordinary file endpoints or browser origins',async()=>{
   const f=await fixture(),g=await fixture(),a=await f.access();gateway=f.own;
   for(const[url,headers,status]of[[a.url.replace(f.versionId,g.versionId),a.headers,403],[a.url.replace('/client-files/','/files/'),a.headers,401],[a.url,{...a.headers,Origin:'https://hostile.invalid'},403],[a.url+'?token=forbidden',a.headers,400]] as const){const response=await fetch(url,{headers});assert.equal(response.status,status);await response.body?.cancel();}assert.equal(f.counts.get,0);
   await assert.rejects(transaction(c=>issueStudioClientStorageAccess(c,{shareId:f.shareId,recipientUserId:users.other,versionId:f.versionId})),(e:any)=>e.code==='CLIENT_STORAGE_UNAVAILABLE');
  });
  await t.test('client capability stays inside an immutable gateway company/project scope before vault opening',async()=>{
   const f=await fixture(),a=await f.access(),keyring=process.env.COATRIA_HOSTING_KEYRING;delete process.env.COATRIA_HOSTING_KEYRING;
   try{for(const scope of [{companyId:randomUUID(),projectIds:[f.projectId]},{companyId:f.companyId,projectIds:[randomUUID()]}]){
    const scoped=createProjectStorageGateway({scope,providerFactory:f.providerFactory}),response=await scoped.handle(new Request(a.url,{headers:a.headers}));assert.equal(response.status,403);assert.equal((await response.json()).code,'STORAGE_SCOPE_DENIED');
   }}finally{process.env.COATRIA_HOSTING_KEYRING=keyring;}assert.equal(f.counts.get,0);assert.equal(f.counts.close,0);
   const scope={companyId:f.companyId,projectIds:[f.projectId]},scoped=createProjectStorageGateway({scope,providerFactory:f.providerFactory});scope.companyId=randomUUID();scope.projectIds[0]=randomUUID();
   const response=await scoped.handle(new Request(a.url,{headers:a.headers}));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.body);assert.equal(f.counts.get,1);assert.equal(f.counts.close,1);
  });
  await t.test('invalid and multiple ranges never open the provider',async()=>{
   const f=await fixture(),a=await f.access();for(const range of['bytes=-1','bytes=0-1,4-5','bytes=8-2',`bytes=0-${f.bytes}`,'bytes=9007199254740993-']){const r=await f.request(a,range);assert.equal(r.status,416);await r.body?.cancel();}assert.equal(f.counts.get,0);
  });
  await t.test('fresh gateway reads reject revoked share, project policy, membership, source and storage authority',async()=>{
   for(const change of['share','membership','sponsor','connection','archive','job','policy'] as const){const f=await fixture(),a=await f.access();
    if(change==='share')await db.query("UPDATE studio_client_deliveries SET status='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=$1",[f.shareId]);
    if(change==='membership')await db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'member')",[f.companyId,users.client]);
    if(change==='sponsor')await db.query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[f.companyId,users.owner]);
    if(change==='connection')await db.query("UPDATE project_storage_connections SET status='revoked',revision=revision+1,secret_envelope=NULL WHERE id=$1",[f.storageId]);
    if(change==='archive')await db.query('UPDATE higgsfield_output_archives SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1',[f.archiveId,users.owner]);
    if(change==='job')await db.query("UPDATE higgsfield_jobs SET status='conflict' WHERE id=$1",[f.jobId]);
    if(change==='policy')await db.query("UPDATE studio_projects SET ai_policy='restricted' WHERE id=$1",[f.projectId]);
    const response=await f.request(a);assert.equal(response.status,403,change);await response.body?.cancel();assert.equal(f.counts.get,0,change);
   }
  });
  await t.test('provider setup revocation cannot expose the first byte',async()=>{
   const f=await fixture(),a=await f.access();f.hooks.beforeRead=async()=>{await db.query("UPDATE studio_client_deliveries SET status='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=$1",[f.shareId]);};const response=await f.request(a);assert.equal(response.status,403);await response.body?.cancel();assert.equal(f.counts.get,1);assert.equal(f.counts.close,1);
  });
  await t.test('periodic revocation and incomplete or mismatched provider output never complete',async()=>{
   const f=await fixture(),a=await f.access();let reads=0;
   f.hooks.read=body=>new ReadableStream({async pull(c){
    if(reads++===0)c.enqueue(body.subarray(0,2));
    else{await db.query("UPDATE studio_client_deliveries SET status='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=$1",[f.shareId]);await delay(5100);try{c.enqueue(body.subarray(2));c.close();}catch{/* Periodic cancellation closed the source. */}}
   }},{highWaterMark:0});
   const response=await f.request(a);await assert.rejects(response.arrayBuffer());assert.equal(f.counts.close,1);
   for(const mismatch of['metadata','short','long'] as const){const b=await fixture();if(mismatch==='metadata')b.hooks.metadata={etag:'"wrong-etag"'};else b.hooks.read=body=>stream(mismatch==='short'?body.subarray(0,body.length-1):Buffer.concat([body,Buffer.from('x')]));const access=await b.access();if(mismatch==='metadata'){const r=await b.request(access);assert.equal(r.status,502);await r.body?.cancel();}else await assert.rejects(async()=>{const r=await b.request(access);await r.arrayBuffer();});assert.equal(b.counts.close,1);}
  });
  await t.test('stalled streams cancel on revocation and caller abort without provider writes',async()=>{
   const f=await fixture();let cancelled=false;f.hooks.read=()=>new ReadableStream({start(c){c.enqueue(Buffer.from('x'));},cancel(){cancelled=true;}});const response=await f.request(await f.access());const reader=response.body!.getReader();assert.equal((await reader.read()).value?.length,1);await db.query("UPDATE studio_client_deliveries SET status='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=$1",[f.shareId]);await assert.rejects(reader.read());assert(cancelled);assert.equal(f.counts.close,1);
   const g=await fixture(),abort=new AbortController();g.hooks.read=()=>new ReadableStream({start(c){c.enqueue(Buffer.from('x'));}});const r=await g.request(await g.access(),undefined,abort.signal),rr=r.body!.getReader();await rr.read();abort.abort();await assert.rejects(rr.read());for(let i=0;i<20&&!g.lastSignal?.aborted;i++)await delay(10);assert(g.lastSignal?.aborted);
  });
  await t.test('host clock skew cannot extend transport deadlines; expired tokens are rejected before provider reads',async()=>{
   const f=await fixture(),oldNow=Date.now;let a;
   // PGlite's clock itself is implemented using JS Date.now; only an actual
   // PostgreSQL process can prove independent host/application clock skew.
   try{if(!emulate)Date.now=()=>0;a=await f.access();}finally{Date.now=oldNow;}
   const stored=(await db.query('SELECT extract(epoch FROM(expires_at-created_at))::float8 AS seconds FROM studio_client_storage_grants WHERE token_hash=$1',[hashToken(a.headers.Authorization.slice(7))])).rows[0];assert(stored.seconds<=60);
   const expired='sct_'+randomBytes(32).toString('base64url');await db.query(`INSERT INTO studio_client_storage_grants(company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,token_hash,created_at,expires_at)
    SELECT company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,$2,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '90 seconds' FROM studio_client_storage_grants WHERE token_hash=$1`,[hashToken(a.headers.Authorization.slice(7)),hashToken(expired)]);
   try{if(!emulate)Date.now=()=>0;await assert.rejects(transaction(c=>authorizeStudioClientStorageGrant(c,expired,f.versionId)),(e:any)=>e.code==='CLIENT_STORAGE_UNAVAILABLE');const r=await f.request({...a,headers:{Authorization:'Bearer '+expired}});assert.equal(r.status,403,await r.text());}finally{Date.now=oldNow;}assert.equal(f.counts.get,0);
  });
  await t.test('absolute short-lived grant cancels a stalled body and bounded live grant issuance cannot grow indefinitely',async()=>{
   const f=await fixture(),a=await f.access(),short='sct_'+randomBytes(32).toString('base64url');
   await db.query(`WITH instant AS MATERIALIZED(SELECT clock_timestamp() AS at) INSERT INTO studio_client_storage_grants(company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,token_hash,created_at,expires_at)
    SELECT company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,$2,instant.at,instant.at+interval '1500 milliseconds' FROM studio_client_storage_grants CROSS JOIN instant WHERE token_hash=$1`,[hashToken(a.headers.Authorization.slice(7)),hashToken(short)]);
   let cancelled=false;f.hooks.read=()=>new ReadableStream({start(c){c.enqueue(Buffer.from('x'));},cancel(){cancelled=true;}});const r=await f.request({...a,headers:{Authorization:'Bearer '+short}}),reader=r.body!.getReader();await reader.read();await assert.rejects(reader.read());assert(cancelled);assert(f.lastSignal?.aborted);assert.equal(f.counts.close,1);
   const g=await fixture(),first=await g.access(),hashes=Array.from({length:255},()=>hashToken(randomUUID()));
   await db.query(`WITH instant AS MATERIALIZED(SELECT clock_timestamp() AS at) INSERT INTO studio_client_storage_grants(company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,token_hash,created_at,expires_at)
    SELECT company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,h.hash,instant.at,instant.at+interval '60 seconds' FROM studio_client_storage_grants CROSS JOIN instant CROSS JOIN unnest($2::text[]) h(hash) WHERE token_hash=$1`,[hashToken(first.headers.Authorization.slice(7)),hashes]);
   await assert.rejects(g.access(),(e:any)=>e.code==='CLIENT_STORAGE_GRANT_LIMIT');assert.equal((await db.query('SELECT count(*)::int AS n FROM studio_client_storage_grants WHERE share_id=$1',[g.shareId])).rows[0].n,256);
  });
  await t.test('a different latest review and reopened work revoke an already issued transport capability',async()=>{
   const f=await fixture(),a=await f.access();await db.query("UPDATE tasks SET status='review' WHERE id=$1",[f.taskId]);await call(`companies/${f.companyId}/studio/projects/${f.projectId}/reviews`,'POST',{clientId:randomUUID(),revision:f.revision,artifactId:f.artifactId,decision:'approved',note:'Synthetic later independent review with different immutable receipt',technicalQc:true},'reviewer',201);await db.query("UPDATE tasks SET status='done' WHERE id=$1",[f.taskId]);const response=await f.request(a);assert.equal(response.status,403);await response.body?.cancel();assert.equal(f.counts.get,0);
   const g=await fixture(),b=await g.access();await db.query("UPDATE tasks SET status='doing' WHERE id=$1",[g.taskId]);const r=await g.request(b);assert.equal(r.status,403);await r.body?.cancel();assert.equal(g.counts.get,0);
  });
  await t.test('PostgreSQL concurrent rename takes binding before file without a client-read deadlock',{skip:emulate,timeout:15000},async()=>{
   const f=await fixture(),a=await f.access(),writer=await db.connect();let read:Promise<Response>|undefined;
   try{
    await writer.query('BEGIN');await writer.query('SELECT id FROM project_storage_connections WHERE id=$1 FOR SHARE',[f.storageId]);await writer.query('SELECT id FROM project_storage_bindings WHERE id=$1 FOR UPDATE',[f.bindingId]);
    read=f.request(a);void read.catch(()=>{});
    let waiting=false;for(let i=0;i<100;i++){const row=(await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%project_storage_bindings%FOR SHARE%' LIMIT 1")).rowCount;if(row){waiting=true;break;}await delay(20);}assert(waiting,'Client read must wait on binding before acquiring the file row.');
    await updateProjectStorageFile(writer,{companyId:f.companyId,userId:users.owner},f.projectId,f.fileId,{clientId:randomUUID(),revision:1,parentId:null,name:'renamed-source.png'});await writer.query('COMMIT');
    const response=await read;assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.body);assert(response.headers.get('Content-Disposition')?.includes(encodeURIComponent(a.name)));assert.equal((await db.query('SELECT name FROM project_storage_files WHERE id=$1',[f.fileId])).rows[0].name,'renamed-source.png');
   }finally{await writer.query('ROLLBACK');writer.release();await read?.then(r=>r.body?.cancel()).catch(()=>{});}
  });
  await t.test('PostgreSQL samples expiry after project-lock waits despite a skewed gateway host clock',{skip:emulate,timeout:15000},async()=>{
   const f=await fixture(),a=await f.access(),short='sct_'+randomBytes(32).toString('base64url'),blocker=await db.connect(),oldNow=Date.now;let read:Promise<Response>|undefined;
   try{
    await db.query(`WITH instant AS MATERIALIZED(SELECT clock_timestamp() AS at) INSERT INTO studio_client_storage_grants(company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,token_hash,created_at,expires_at)
     SELECT company_id,project_id,share_id,recipient_user_id,storage_version_id,connection_id,connection_revision,package_hash,$2,instant.at,instant.at+interval '800 milliseconds' FROM studio_client_storage_grants CROSS JOIN instant WHERE token_hash=$1`,[hashToken(a.headers.Authorization.slice(7)),hashToken(short)]);
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM studio_projects WHERE id=$1 FOR UPDATE',[f.projectId]);Date.now=()=>0;read=f.request({...a,headers:{Authorization:'Bearer '+short}});void read.catch(()=>{});
    let waiting=false;for(let i=0;i<100;i++){if((await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%studio_projects%FOR SHARE%' LIMIT 1")).rowCount){waiting=true;break;}await delay(20);}assert(waiting);await delay(900);await blocker.query('COMMIT');const response=await read;assert.equal(response.status,403);await response.body?.cancel();assert.equal(f.counts.get,0);
   }finally{Date.now=oldNow;await blocker.query('ROLLBACK');blocker.release();await read?.then(r=>r.body?.cancel()).catch(()=>{});}
  });
  await t.test('restricted gateway role downloads but cannot read unrelated private evidence or create client authority',async()=>{
   const f=await fixture(),a=await f.access(),role='client_gateway_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');let restricted:Pool|undefined;
   try{await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);const grants=(await readFile('database/storage-gateway-permissions.sql','utf8')).replaceAll('coatria_storage_gateway_v1',role);await db.query(grants);const url=new URL(process.env.DATABASE_URL!);if(!emulate){url.username=role;url.password=password;}restricted=new Pool({connectionString:url.href,max:1});if(emulate)await restricted.query('SET ROLE '+role);(globalThis as any).coatriaPool=restricted;
    const response=await f.request(a,'bytes=1-4');assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.body.subarray(1,5));
    if(emulate)await restricted.query('RESET ROLE');(globalThis as any).coatriaPool=db;await activateRevision(f);if(emulate)await restricted.query('SET ROLE '+role);(globalThis as any).coatriaPool=restricted;
    const superseded=await f.request(a,'bytes=1-4');assert.equal(superseded.status,403);assert.equal((await superseded.json()).code,'CLIENT_STORAGE_UNAVAILABLE');assert.equal(f.counts.get,1);
    for(const sql of['SELECT snapshot FROM studio_generated_revision_plans WHERE false','SELECT source_snapshot FROM studio_generated_artifact_sources WHERE false','SELECT manifest_text FROM studio_generated_artifact_sources WHERE false','SELECT sealed FROM higgsfield_output_locators WHERE false','SELECT arguments FROM higgsfield_requests WHERE false','SELECT source_snapshot FROM studio_generated_followups WHERE false','SELECT claim_request_id FROM studio_generated_followups WHERE false','INSERT INTO studio_client_storage_grants DEFAULT VALUES',"UPDATE studio_client_deliveries SET status='active' WHERE false"]){const c:PoolClient=await restricted.connect();try{assert.equal((await c.query('SELECT current_user AS u')).rows[0].u,role);await assert.rejects(c.query(sql),{code:'42501'},sql);assert.equal((await c.query('SELECT current_user AS u')).rows[0].u,role);}finally{c.release();}}
   }finally{if(emulate&&restricted)await restricted.query('RESET ROLE');(globalThis as any).coatriaPool=db;await restricted?.end();await db.query(`DROP OWNED BY ${role}`);await db.query(`DROP ROLE ${role}`);}
  });
 }finally{
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}await (globalThis as any).coatriaPool?.end();delete(globalThis as any).coatriaPool;await stop?.();
  if(control){if(created){for(let i=0;i<100;i++){const n=(await control.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0].n;if(!n)break;await delay(100);}await control.query('DROP DATABASE '+dbName);}await control.end();}
  for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
