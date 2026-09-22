import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {database,query,transaction} from '../src/lib/db';
import {ApiError,hashToken} from '../src/lib/security';
import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {bindProjectStorage,createProjectStorageConnection,getProjectStorage,reserveProjectStorageUpload,accessProjectStorageVersion,revokeProjectStorageConnection} from '../src/lib/project-storage';
import {projectStorageTransfer} from '../src/lib/project-storage-transfer';
import {RunpodStorageError,type RunpodProjectStorage,type RunpodProjectStorageConfig,type RunpodMultipartUpload} from '../src/lib/project-storage-runpod';
import type {ProjectStorageActor} from '../src/lib/project-storage-protocol';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const origin='https://coatria.example.invalid',gatewayOrigin='https://storage.example.invalid';
const credentials={accessKeyId:['user','fixture'].join('_'),secretAccessKey:['rps','fixture-storage-key'].join('_')};
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const stream=(bytes:Uint8Array)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close();}});
const consume=(body:ReadableStream<Uint8Array>)=>new Response(body).arrayBuffer().then(value=>Buffer.from(value));
async function bounded<T>(promise:Promise<T>,ms=15000){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture coordination timed out')),ms);})]);}finally{clearTimeout(timer!);}}

test('gateway rejects malformed or empty operator scope before any service work',()=>{
 for(const scope of [{companyId:'bad',projectIds:[randomUUID()]},{companyId:randomUUID(),projectIds:[]},{companyId:randomUUID(),projectIds:['bad']},{companyId:randomUUID(),projectIds:[randomUUID()],unexpected:true}])assert.throws(()=>createProjectStorageGateway({scope}),{code:'STORAGE_SCOPE_INVALID'});
 const projectId=randomUUID();assert.throws(()=>createProjectStorageGateway({scope:{companyId:randomUUID(),projectIds:[projectId,projectId]}}),{code:'STORAGE_SCOPE_INVALID'});
});

test('storage gateway uses real scoped database grants and injected byte provider',{skip:!emulate&&!integration,timeout:180000},async t=>{
 const prior={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING,COATRIA_STORAGE_GATEWAY_ENABLED:process.env.COATRIA_STORAGE_GATEWAY_ENABLED,COATRIA_STORAGE_GATEWAY_URL:process.env.COATRIA_STORAGE_GATEWAY_URL};
 process.env.DATABASE_URL=integration;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'storage-gateway-fixture',keys:{'storage-gateway-fixture':Buffer.alloc(32,58).toString('base64')}});process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';process.env.COATRIA_STORAGE_GATEWAY_URL=gatewayOrigin;
 let stop:(()=>Promise<void>)|undefined;const previousFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Storage gateway tests must never contact a provider.');};
 const userId=randomUUID(),companies:string[]=[],projectIds:string[]=[];let userCreated=false;
 type Hooks={beforeCreate?:()=>Promise<void>;beforePart?:()=>Promise<void>;beforeComplete?:()=>Promise<void>;beforeRead?:()=>Promise<void>;read?:(versionId:string,body:Buffer)=>ReadableStream<Uint8Array>;corrupt?:boolean;failCreate?:boolean;failComplete?:boolean};
 async function fixture(hooks:Hooks={}){
  const companyId=randomUUID(),projectId=randomUUID();companies.push(companyId);projectIds.push(projectId);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Storage gateway fixture',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
  const newProject=async(pid:string)=>query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,production_path,created_by) VALUES($1,$2,'File transport fixture','Internal','No cloud or provider operations.',$3,'allowed','higgsfield',$4)",[pid,companyId,JSON.stringify({width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),userId]);await newProject(projectId);
  const actor={companyId,userId},connection=(await transaction(client=>createProjectStorageConnection(client,actor,{clientId:randomUUID(),name:'Synthetic storage credentials',region:'US-NC-2',volumeId:'fixture-volume',...credentials}))).connection;
  const bind=async(pid:string)=>transaction(client=>bindProjectStorage(client,actor,pid,{clientId:randomUUID(),revision:0,connectionId:connection.id}));await bind(projectId);
  const counts={create:0,part:0,complete:0,abort:0,read:0,close:0},objects=new Map<string,Buffer>(),parts=new Map<string,Map<number,Buffer>>(),configs:RunpodProjectStorageConfig[]=[];
  function providerFactory(config:RunpodProjectStorageConfig):RunpodProjectStorage{
   configs.push(config);assert.equal(config.companyId,companyId);assert.equal(config.timeoutMs,7200000);assert.equal(config.partBytes,64*1024**2);assert.equal(config.maxObjectBytes,100*1024**3);assert.deepEqual(config.credentials,credentials);
   return {verifyBucketAccess:async()=>{throw Error('Operator preflight is not part of this gateway test');},list:async()=>({objects:[],cursor:null}),head:async()=>null,validateMultipart(value){const result=value as RunpodMultipartUpload;assert.equal(result.scope,companyId);return result;},
    async createMultipart(input){counts.create++;await hooks.beforeCreate?.();if(hooks.failCreate)throw new RunpodStorageError('STORAGE_PROVIDER_UNCERTAIN');const descriptor={scope:companyId,versionId:input.versionId,uploadId:randomUUID(),bytes:input.bytes,partBytes:config.partBytes!};parts.set(descriptor.uploadId,new Map());return descriptor;},
    async uploadPart(input){counts.part++;await hooks.beforePart?.();const body=input.body instanceof Uint8Array?Buffer.from(input.body):await consume(input.body as ReadableStream<Uint8Array>);parts.get(input.upload.uploadId)!.set(input.partNumber,body);return {partNumber:input.partNumber,bytes:body.length,etag:'"part-'+sha(body)+'"'};},
    async completeMultipart(input){counts.complete++;await hooks.beforeComplete?.();if(hooks.failComplete)throw new RunpodStorageError('STORAGE_PROVIDER_UNCERTAIN');objects.set(input.upload.versionId,Buffer.concat([...parts.get(input.upload.uploadId)!.entries()].sort((a,b)=>a[0]-b[0]).map(([,body])=>body)));return {versionId:input.upload.versionId,etag:'"verified-object"'};},
    async abortMultipart(input){counts.abort++;parts.delete(input.upload.uploadId);},
    async get(input){counts.read++;await hooks.beforeRead?.();assert.equal(input.ifMatch,'"verified-object"');const body=objects.get(input.versionId)!;assert(body);const content=hooks.corrupt?Buffer.from('x'.repeat(body.length)):body;const selected=input.range?content.subarray(input.range.start,input.range.end+1):content;return {stream:hooks.read?.(input.versionId,selected)??stream(selected),bytes:selected.length,totalBytes:body.length,etag:'"verified-object"',contentType:'video/mp4',contentRange:input.range?`bytes ${input.range.start}-${input.range.end}/${body.length}`:null,range:input.range??null};},close(){counts.close++;}};
  }
  const gateway=createProjectStorageGateway({providerFactory,allowedOrigins:[origin]});
  async function reserve(body=Buffer.from('abcdef'),extras:Record<string,unknown>={},pid=projectId,principal:ProjectStorageActor=actor):Promise<Record<string,any>&{body:Buffer;input:Record<string,unknown>}>{const binding=(await transaction(client=>getProjectStorage(client,principal,pid))).binding!;const input={clientId:randomUUID(),revision:binding.revision,parentId:null,name:'clip-'+randomUUID()+'.mp4',bytes:body.length,sha256:sha(body),contentType:'video/mp4',...extras};return {body,input,...await transaction(client=>reserveProjectStorageUpload(client,principal,pid,input,projectStorageTransfer))};}
  function request(path:string,token:string,method='GET',body?:BodyInit,headers:Record<string,string>={}){return gateway.handle(new Request(gatewayOrigin+path,{method,headers:{Origin:origin,Authorization:'Bearer '+token,...headers},...(body===undefined?{}:{body}),...body instanceof ReadableStream?{duplex:'half'}:{}}));}
  const action=(upload:any,name:string)=>request('/v1/uploads/'+upload.id+'/'+name,upload.token,'POST','{}',{'Content-Type':'application/json'});
  const part=(upload:any,body:Buffer,number=1)=>request('/v1/uploads/'+upload.id+'/parts/'+number,upload.token,'PUT',Uint8Array.from(body).buffer,{'Content-Length':String(body.length)});
  async function json(response:Response,status=200){const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
  async function uploaded(body=Buffer.from('abcdef')){const f=await reserve(body);await json(await action(f.upload,'start'));await json(await part(f.upload,body));await json(await action(f.upload,'complete'),202);return f;}
  async function readGrant(versionId:string,principal:ProjectStorageActor=actor){return (await transaction(client=>accessProjectStorageVersion(client,principal,projectId,versionId,{clientId:randomUUID(),disposition:'attachment'},projectStorageTransfer))).access;}
  async function leasedAgent(){
   const agentId=randomUUID(),runId=randomUUID(),leaseHash=sha(randomUUID()),capabilities=['storage.read','storage.write'];
   await query("INSERT INTO agents(id,company_id,name,harness,created_by,token_hash,status,invocation_access,capabilities) VALUES($1,$2,'Storage fixture agent','custom',$3,$4,'active','admins',$5)",[agentId,companyId,userId,sha(randomUUID()),JSON.stringify(capabilities)]);
   await query('INSERT INTO conversations(company_id) VALUES($1) ON CONFLICT DO NOTHING',[companyId]);const conversation=(await query('SELECT id FROM conversations WHERE company_id=$1 AND room_id IS NULL',[companyId])).rows[0];
   await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,attempts,worker_id,lease_token_hash,lease_expires_at,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Storage fixture request',$8,'running',1,'storage-fixture',$9,clock_timestamp()+interval '1 hour',clock_timestamp())",[runId,companyId,agentId,userId,conversation.id,randomUUID(),sha(randomUUID()),JSON.stringify(capabilities),leaseHash]);
   return {actor:{companyId,userId,agentId,runId},leaseHash};
  }
  const revoke=()=>transaction(client=>revokeProjectStorageConnection(client,actor,connection.id,{clientId:randomUUID(),revision:connection.revision,status:'revoked'}));
  const row=(uploadId:string)=>query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2',[companyId,uploadId]).then(result=>result.rows[0]);
  return {actor,companyId,projectId,connection,gateway,providerFactory,counts,objects,configs,reserve,request,action,part,json,uploaded,readGrant,revoke,row,newProject,bind,hooks,leasedAgent};
 }
 try{
  if(emulate){const{PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();stop=async()=>{await db.close();};for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});stop=async()=>{try{await socket.stop();}finally{await db.close();}};await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;}
  await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Storage gateway fixture',userId+'@example.invalid','fixture']);
  userCreated=true;

  await t.test('reserve/retry preserves one immutable file version and refreshes exact scoped access',async()=>{
   const f=await fixture(),saved=await f.reserve(),retry=await transaction(client=>reserveProjectStorageUpload(client,f.actor,f.projectId,saved.input,projectStorageTransfer));assert.equal(saved.replayed,false);assert.equal(retry.replayed,true);assert.equal(retry.upload.id,saved.upload.id);assert.notEqual(retry.upload.token,saved.upload.token);assert.equal(Number((await query('SELECT count(*) FROM project_storage_versions WHERE company_id=$1',[f.companyId])).rows[0].count),1);
   await assert.rejects(transaction(client=>reserveProjectStorageUpload(client,f.actor,f.projectId,{...saved.input,name:'different.mp4'},projectStorageTransfer)),(error:unknown)=>error instanceof ApiError&&error.status===409);assert.equal(f.counts.create,0);const receipt=(await query('SELECT * FROM project_storage_access_receipts WHERE company_id=$1 AND token_hash=$2',[f.companyId,hashToken(saved.upload.token)])).rows[0];assert.equal(receipt.token_hash,hashToken(saved.upload.token));assert(!JSON.stringify(receipt).includes(saved.upload.token));
  });

  await t.test('upload, immutable part replay, complete, independent byte verification and ranged download',async()=>{
   const f=await fixture(),saved=await f.reserve();await f.json(await f.action(saved.upload,'start'));await f.json(await f.action(saved.upload,'start'));assert.equal(f.counts.create,1);const first=await f.json(await f.part(saved.upload,saved.body));assert.equal(first.sha256,sha(saved.body));assert.equal((await f.json(await f.part(saved.upload,saved.body))).replayed,true);assert.equal((await f.json(await f.part(saved.upload,Buffer.from('xxxxxx')),409)).code,'IDEMPOTENCY_CONFLICT');assert.equal(f.counts.part,1);
   await assert.rejects(f.readGrant(saved.upload.versionId),(error:unknown)=>error instanceof ApiError&&error.status===404);await f.json(await f.action(saved.upload,'complete'),202);await f.json(await f.action(saved.upload,'complete'),202);assert.equal(f.counts.complete,1);assert.equal(await f.gateway.verifyNext(),true);assert.equal(await f.gateway.verifyNext(),false);assert.equal((await f.row(saved.upload.id)).status,'ready');const verification=(await query('SELECT * FROM project_storage_verifications WHERE company_id=$1 AND version_id=$2',[f.companyId,saved.upload.versionId])).rows[0];assert.equal(verification.sha256,sha(saved.body));
   const access=await f.readGrant(saved.upload.versionId),response=await f.gateway.handle(new Request(access.url,{headers:{...access.headers,Origin:origin,Range:'bytes=2-4'}}));assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),'bytes 2-4/6');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(await response.text(),'cde');assert.equal(response.headers.get('X-Content-SHA256'),sha(saved.body));await f.json(await f.action(saved.upload,'cancel'),409);
  });

  await t.test('grant credentials are resource/company/operation/expiry bound and reject hostile browser origins',async()=>{
   const f=await fixture(),g=await fixture(),one=await f.reserve(),two=await g.reserve();await f.json(await f.request('/v1/uploads/'+one.upload.id,two.upload.token),403);await f.json(await f.request('/v1/files/'+one.upload.versionId,one.upload.token),403);assert.equal((await f.gateway.handle(new Request(gatewayOrigin+'/v1/uploads/'+one.upload.id,{headers:{Authorization:'Bearer '+one.upload.token,Origin:'https://evil.example.invalid'}}))).status,403);assert.equal((await f.gateway.handle(new Request(gatewayOrigin+'/v1/uploads/'+one.upload.id+'?token='+one.upload.token,{headers:{Authorization:'Bearer '+one.upload.token}}))).status,400);
   await query("UPDATE project_storage_access_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[hashToken(one.upload.token)]);await f.json(await f.action(one.upload,'start'),403);assert.equal(f.counts.create,0);
  });

  await t.test('scoped gateway rejects every transfer path outside company/project before credential opening or provider use',async()=>{
   const f=await fixture(),ready=await f.uploaded();await f.gateway.verifyNext();const access=await f.readGrant(ready.upload.versionId),pending=await f.reserve(),before=f.configs.length;
   const urls=[['/v1/uploads/'+pending.upload.id,'GET',undefined,{}],...['start','complete','cancel'].map(action=>['/v1/uploads/'+pending.upload.id+'/'+action,'POST','{}',{'Content-Type':'application/json'}]),['/v1/uploads/'+pending.upload.id+'/parts/1','PUT','abcdef',{'Content-Length':'6'}]] as Array<[string,string,string|undefined,Record<string,string>]>;
   const keyring=process.env.COATRIA_HOSTING_KEYRING;delete process.env.COATRIA_HOSTING_KEYRING;
   try{for(const scope of [{companyId:randomUUID(),projectIds:[f.projectId]},{companyId:f.companyId,projectIds:[randomUUID()]}]){
    const gateway=createProjectStorageGateway({scope,providerFactory:f.providerFactory,allowedOrigins:[origin]});
    for(const[path,method,body,headers]of urls){const response=await gateway.handle(new Request(gatewayOrigin+path,{method,headers:{Authorization:'Bearer '+pending.upload.token,...headers},...body===undefined?{}:{body}}));assert.equal(response.status,403);assert.equal((await response.json()).code,'STORAGE_SCOPE_DENIED');}
    const response=await gateway.handle(new Request(access.url,{headers:access.headers}));assert.equal(response.status,403);assert.equal((await response.json()).code,'STORAGE_SCOPE_DENIED');
   }}finally{process.env.COATRIA_HOSTING_KEYRING=keyring;}
   assert.equal(f.configs.length,before);assert.equal((await f.row(pending.upload.id)).status,'allocated');
  });

  await t.test('scoped verifier claims only its immutable company/project queue and leaves foreign pending work untouched',async()=>{
   const foreign=await fixture(),outside=await foreign.uploaded(),own=await fixture(),otherProject=randomUUID();projectIds.push(otherProject);await own.newProject(otherProject);await own.bind(otherProject);
   const other=await own.reserve(Buffer.from('other'),{},otherProject);await own.json(await own.action(other.upload,'start'));await own.json(await own.part(other.upload,other.body));await own.json(await own.action(other.upload,'complete'),202);
   const target=await own.uploaded(),scope={companyId:own.companyId,projectIds:[own.projectId]},gateway=createProjectStorageGateway({scope,providerFactory:own.providerFactory});scope.companyId=foreign.companyId;scope.projectIds.splice(0,1,foreign.projectId);
   const foreignBefore=await foreign.row(outside.upload.id),otherBefore=await own.row(other.upload.id);assert.equal(await gateway.verifyNext(),true);assert.equal(await gateway.verifyNext(),false);assert.equal((await own.row(target.upload.id)).status,'ready');
   for(const [actual,prior]of [[await foreign.row(outside.upload.id),foreignBefore],[await own.row(other.upload.id),otherBefore]]){assert.equal(actual.status,'verifying');assert.equal(actual.action_id,null);assert.equal(+new Date(actual.updated_at),+new Date(prior.updated_at));}assert.equal(foreign.counts.read,0);assert.equal(own.counts.read,1);
   assert.equal(await createProjectStorageGateway({scope:{companyId:foreign.companyId,projectIds:[foreign.projectId]},providerFactory:foreign.providerFactory}).verifyNext(),true);assert.equal(await createProjectStorageGateway({scope:{companyId:own.companyId,projectIds:[otherProject]},providerFactory:own.providerFactory}).verifyNext(),true);
  });

  await t.test('missing parts and malformed byte lengths cannot complete or publish a version',async()=>{
   const f=await fixture(),saved=await f.reserve();await f.json(await f.action(saved.upload,'start'));assert.equal((await f.json(await f.action(saved.upload,'complete'),409)).code,'STORAGE_PARTS_MISSING');await f.json(await f.part(saved.upload,Buffer.from('short')),400);assert.equal(f.counts.part,0);assert.equal(await f.gateway.verifyNext(),false);assert.equal((await f.row(saved.upload.id)).status,'uploading');
  });

  await t.test('full-file SHA mismatch fails verification and never grants download access',async()=>{
   const f=await fixture({corrupt:true}),saved=await f.uploaded();assert.equal(await f.gateway.verifyNext(),true);assert.equal((await f.row(saved.upload.id)).status,'failed');assert.equal(Number((await query('SELECT count(*) FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].count),0);await assert.rejects(f.readGrant(saved.upload.versionId),(error:unknown)=>error instanceof ApiError&&error.status===404);
  });

  await t.test('unknown provider initiation or completion never automatically retries mutations',async()=>{
   const f=await fixture({failCreate:true}),saved=await f.reserve();await f.json(await f.action(saved.upload,'start'),502);assert.equal((await f.row(saved.upload.id)).status,'uncertain');await f.json(await f.action(saved.upload,'start'));assert.equal(f.counts.create,1);assert.equal((await f.json(await f.action(saved.upload,'cancel'),409)).code,'STORAGE_OUTCOME_UNCERTAIN');
   const g=await fixture({failComplete:true}),other=await g.reserve();await g.json(await g.action(other.upload,'start'));await g.json(await g.part(other.upload,other.body));await g.json(await g.action(other.upload,'complete'),502);await g.json(await g.action(other.upload,'complete'),409);assert.equal(g.counts.complete,1);assert.equal((await g.row(other.upload.id)).status,'uncertain');
  });

  await t.test('concurrent start/part/complete observe durable action reservations without duplicate provider work',async()=>{
   for(const operation of ['start','part','complete'] as const){const entered=deferred(),release=deferred(),hooks:Hooks={};hooks[operation==='start'?'beforeCreate':operation==='part'?'beforePart':'beforeComplete']=async()=>{entered.resolve();await release.promise;};const f=await fixture(hooks),saved=await f.reserve();if(operation!=='start')await f.json(await f.action(saved.upload,'start'));if(operation==='complete')await f.json(await f.part(saved.upload,saved.body));const invoke=()=>operation==='part'?f.part(saved.upload,saved.body):f.action(saved.upload,operation);const first=invoke();try{await bounded(entered.promise);await f.json(await invoke(),operation==='start'?200:409);}finally{release.resolve();}await f.json(await bounded(first),operation==='complete'?202:200);assert.equal(f.counts[operation==='start'?'create':operation],1);if(operation==='complete'){assert.equal(await f.gateway.verifyNext(),true);assert.equal((await f.row(saved.upload.id)).status,'ready');}}
  });

  await t.test('revocation while a provider mutation is active prevents its result becoming an authorized receipt',async()=>{
   const entered=deferred(),release=deferred(),f=await fixture({beforePart:async()=>{entered.resolve();await release.promise;}}),saved=await f.reserve();await f.json(await f.action(saved.upload,'start'));const pending=f.part(saved.upload,saved.body);try{await bounded(entered.promise);await f.revoke();}finally{release.resolve();}const response=await bounded(pending);assert([403,409].includes(response.status));await response.json();assert.equal((await f.row(saved.upload.id)).status,'uncertain');assert.equal(Number((await query('SELECT count(*) FROM project_storage_upload_parts WHERE company_id=$1',[f.companyId])).rows[0].count),0);assert.equal(f.counts.part,1);
  });

  await t.test('revocation during provider connection setup rejects its first returned download chunk',async()=>{
   const f=await fixture(),saved=await f.uploaded();await f.gateway.verifyNext();const access=await f.readGrant(saved.upload.versionId),entered=deferred(),release=deferred();
   f.hooks.beforeRead=async()=>{entered.resolve();await release.promise;};
   const pending=f.gateway.handle(new Request(access.url,{headers:access.headers}));
   try{await bounded(entered.promise);await f.revoke();}finally{release.resolve();}
   const response=await bounded(pending);assert.equal(response.status,200);await assert.rejects(response.body!.getReader().read(),(error:unknown)=>error instanceof ApiError&&[403,409].includes(error.status));
  });

  await t.test('revocation interrupts a stalled download rather than exposing the next delayed chunk', {timeout:15000},async()=>{
   const f=await fixture(),saved=await f.uploaded();await f.gateway.verifyNext();const access=await f.readGrant(saved.upload.versionId),entered=deferred(),cancelled=deferred();f.hooks.read=()=>new ReadableStream({pull(){entered.resolve();},cancel(){cancelled.resolve();}},{highWaterMark:0});const response=await f.gateway.handle(new Request(access.url,{headers:{...access.headers,Origin:origin}}));assert.equal(response.status,200);const rejected=assert.rejects(bounded(response.arrayBuffer(),10000));await bounded(entered.promise);await f.revoke();await rejected;await bounded(cancelled.promise,1000);
  });

  await t.test('revocation interrupts stalled verification and cannot publish a byte-verification receipt', {timeout:15000},async()=>{
   const entered=deferred(),cancelled=deferred(),f=await fixture({read:()=>new ReadableStream({pull(){entered.resolve();},cancel(){cancelled.resolve();}},{highWaterMark:0})}),saved=await f.uploaded(),pending=f.gateway.verifyNext();await bounded(entered.promise);await f.revoke();assert.equal(await bounded(pending,10000),true);await bounded(cancelled.promise,1000);assert.equal((await f.row(saved.upload.id)).status,'failed');assert.equal(Number((await query('SELECT count(*) FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].count),0);
  });

  await t.test('company upload cap serializes reservations across different project bindings',{skip:emulate,timeout:30000},async()=>{
   const f=await fixture();for(let i=0;i<7;i++)await f.reserve();const secondProject=randomUUID();projectIds.push(secondProject);await f.newProject(secondProject);await f.bind(secondProject);const results=await Promise.allSettled([f.reserve(Buffer.from('first'),{},f.projectId),f.reserve(Buffer.from('second'),{},secondProject)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert(failure.reason instanceof ApiError);assert.equal(failure.reason.code,'STORAGE_TRANSFER_LIMIT');assert.equal(Number((await query('SELECT count(*) FROM project_storage_uploads WHERE company_id=$1',[f.companyId])).rows[0].count),8);
  });

  await t.test('uncertain provider writes retain company capacity even after session expiry until operator reconciliation',async()=>{
   const f=await fixture({failCreate:true}),uploads:string[]=[];
   for(let index=0;index<8;index++){const saved=await f.reserve();uploads.push(saved.upload.id);await f.json(await f.action(saved.upload,'start'),502);assert.equal((await f.row(saved.upload.id)).status,'uncertain');}
   const atCapacity=(error:unknown)=>error instanceof ApiError&&error.status===429&&error.code==='STORAGE_TRANSFER_LIMIT';
   await assert.rejects(f.reserve(),atCapacity);assert.equal(f.counts.create,8);
   await query("UPDATE project_storage_uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1",[f.companyId]);
   await assert.rejects(f.reserve(),atCapacity);assert.equal(f.counts.create,8);assert.equal(Number((await query('SELECT count(*) FROM project_storage_versions WHERE company_id=$1',[f.companyId])).rows[0].count),8);
   // Explicit privileged fixture reconciliation stands in for an operator who
   // has independently resolved one provider outcome; expiry is not resolution.
   await query("UPDATE project_storage_uploads SET status='cancelled' WHERE company_id=$1 AND id=$2",[f.companyId,uploads[0]]);
   const next=await f.reserve();assert.equal(next.upload.status,'allocated');assert.equal(f.counts.create,8);
  });

  await t.test('a reclaimed agent run invalidates its previous lease-bound upload and download grants',async()=>{
   const f=await fixture(),agent=await f.leasedAgent(),saved=await f.reserve(Buffer.from('abcdef'),{},f.projectId,agent.actor);
   const original=(await query('SELECT agent_lease_hash FROM project_storage_access_receipts WHERE token_hash=$1',[hashToken(saved.upload.token)])).rows[0];assert.equal(original.agent_lease_hash,agent.leaseHash);
   await f.json(await f.action(saved.upload,'start'));await f.json(await f.part(saved.upload,saved.body));await f.json(await f.action(saved.upload,'complete'),202);assert.equal(await f.gateway.verifyNext(),true);const read=await f.readGrant(saved.upload.versionId,agent.actor);
   await query('UPDATE agent_runs SET lease_token_hash=$2,attempts=attempts+1 WHERE id=$1',[agent.actor.runId,sha(randomUUID())]);
   await f.json(await f.request('/v1/uploads/'+saved.upload.id,saved.upload.token),403);await f.json(await f.gateway.handle(new Request(read.url,{headers:read.headers})),403);
   const fresh=await transaction(client=>reserveProjectStorageUpload(client,agent.actor,f.projectId,saved.input,projectStorageTransfer));assert.equal(fresh.replayed,true);assert.equal(fresh.upload.id,saved.upload.id);await f.json(await f.request('/v1/uploads/'+fresh.upload.id,fresh.upload.token));
   const next=await f.readGrant(saved.upload.versionId,agent.actor),response=await f.gateway.handle(new Request(next.url,{headers:next.headers}));assert.equal(response.status,200);assert.equal(await response.text(),saved.body.toString());
   await query('UPDATE agents SET token_hash=$2 WHERE id=$1',[agent.actor.agentId,sha(randomUUID())]);await f.json(await f.gateway.handle(new Request(next.url,{headers:next.headers})),403);
  });

  await t.test('expired crash intents and unfinished multipart handles retain capacity until reconciled',async()=>{
   const f=await fixture(),saved=[];
   for(let index=0;index<8;index++)saved.push(await f.reserve());
   // Durable states left by process exits at different provider boundaries.
   // No fake provider calls are needed: the unconfirmed intent itself must be
   // treated conservatively, including a cancellation whose abort is unknown.
   const states=['initiating','uploading','completing','verifying','cancelled','uncertain','uploading','initiating'];
   for(let index=0;index<states.length;index++)await query("UPDATE project_storage_uploads SET status=$2,action_id=$3,action_expires_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[saved[index].upload.id,states[index],states[index]==='uploading'?null:randomUUID()]);
   await assert.rejects(f.reserve(),(error:unknown)=>error instanceof ApiError&&error.code==='STORAGE_TRANSFER_LIMIT');assert.equal(f.counts.create,0);
   await query("UPDATE project_storage_uploads SET status='cancelled',action_id=NULL,action_expires_at=NULL WHERE id=$1",[saved[0].upload.id]);
   const unused=await f.reserve();assert.equal(unused.upload.status,'allocated');
   await query("UPDATE project_storage_uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[unused.upload.id]);
   const replacement=await f.reserve();assert.equal(replacement.upload.status,'allocated');assert.equal(f.counts.create,0);
  });

  await t.test('lease takeover as verification receives its final bytes cannot commit an old worker verification',async()=>{
   const f=await fixture(),agent=await f.leasedAgent(),saved=await f.reserve(Buffer.from('abcdef'),{},f.projectId,agent.actor);
   await f.json(await f.action(saved.upload,'start'));await f.json(await f.part(saved.upload,saved.body));await f.json(await f.action(saved.upload,'complete'),202);
   // Zero prefetch ensures the first byte read has passed its current-authority
   // check. Transfer ownership only when the verifier requests EOF, leaving the
   // final transactional authority check responsible for rejecting publication.
   f.hooks.read=(_versionId,body)=>{let sent=false;return new ReadableStream<Uint8Array>({async pull(controller){if(!sent){sent=true;controller.enqueue(body);return;}await query('UPDATE agent_runs SET lease_token_hash=$2,attempts=attempts+1 WHERE id=$1',[agent.actor.runId,sha(randomUUID())]);controller.close();}},{highWaterMark:0});};
   assert.equal(await f.gateway.verifyNext(),true);assert.equal((await f.row(saved.upload.id)).status,'failed');assert.equal(Number((await query('SELECT count(*) FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].count),0);
  });

  await t.test('restricted gateway role executes real transfers without authority writes or hosted-agent ciphertext access',{skip:emulate||!integration||!['localhost','127.0.0.1'].includes(new URL(integration).hostname),timeout:30000},async()=>{
   // A denied Pool.query discards its connection. Session SET ROLE alone would
   // then silently fall back to the owner on reconnect. Authenticate every
   // gateway connection as the restricted login, using only fixture credentials.
   const ownerPool=database(),role='coatria_storage_test_'+randomUUID().replaceAll('-','');
   const password=randomBytes(32).toString('hex'),restrictedUrl=new URL(integration!);
   restrictedUrl.username=role;restrictedUrl.password=password;
   let roleCreated=false,restrictedPool:Pool|undefined;
   try{
    const f=await fixture(),agent=await f.leasedAgent(),saved=await f.reserve(Buffer.from('abcdef'),{},f.projectId,agent.actor);
    await query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);roleCreated=true;
    await query((await readFile('database/storage-gateway-permissions.sql','utf8')).replaceAll('coatria_storage_gateway_v1',role));
    restrictedPool=new Pool({connectionString:restrictedUrl.href,max:1,connectionTimeoutMillis:10000,statement_timeout:15000});
    (globalThis as any).coatriaPool=restrictedPool;
    const identity=async()=>{const result=(await query('SELECT current_user,session_user,pg_backend_pid() AS pid')).rows[0];assert.equal(result.current_user,role);assert.equal(result.session_user,role);return result.pid;};
    await identity();
    await query('SELECT company_id,child_run_id FROM studio_generated_followups WHERE false');
    await f.json(await f.action(saved.upload,'start'));await f.json(await f.part(saved.upload,saved.body));await f.json(await f.action(saved.upload,'complete'),202);assert.equal(await f.gateway.verifyNext(),true);assert.equal((await f.row(saved.upload.id)).status,'ready');
    for(const sql of [
     "UPDATE memberships SET role='owner' WHERE false",
     "UPDATE agents SET capabilities='[]'::jsonb WHERE false",
     'UPDATE agent_runs SET lease_token_hash=lease_token_hash WHERE false',
     'UPDATE project_storage_connections SET secret_envelope=secret_envelope WHERE false',
     'UPDATE project_storage_connections SET revision=revision WHERE false',
     'UPDATE project_storage_versions SET object_key=object_key WHERE false',
     'UPDATE project_storage_uploads SET actor_agent_id=actor_agent_id WHERE false',
     'UPDATE project_storage_upload_parts SET sha256=sha256 WHERE false',
     'UPDATE project_storage_verifications SET sha256=sha256 WHERE false',
     'UPDATE project_storage_access_receipts SET agent_lease_hash=agent_lease_hash WHERE false',
     'SELECT ciphertext FROM studio_host_credentials WHERE false',
     'SELECT source_snapshot FROM studio_generated_followups WHERE false',
     'SELECT claim_request_id FROM studio_generated_followups WHERE false',
     'SELECT * FROM studio_generated_followups WHERE false',
     'DELETE FROM project_storage_versions WHERE false',
     `CREATE ROLE ${role}_escalated NOLOGIN`
    ]){await identity();await assert.rejects(query(sql),{code:'42501'},sql);await identity();}
    // Exercise replacement independently of the driver's current error policy.
    const oldPid=await identity(),connection=await restrictedPool.connect();connection.release(true);assert.notEqual(await identity(),oldPid);
    (globalThis as any).coatriaPool=ownerPool;const access=await f.readGrant(saved.upload.versionId,agent.actor);(globalThis as any).coatriaPool=restrictedPool;await identity();
    const response=await f.gateway.handle(new Request(access.url,{headers:access.headers}));assert.equal(response.status,200);assert.equal(await response.text(),saved.body.toString());assert.equal(f.counts.create,1);assert.equal(f.counts.part,1);assert.equal(f.counts.complete,1);
   }finally{
    (globalThis as any).coatriaPool=ownerPool;await restrictedPool?.end();if(roleCreated){await query(`DROP OWNED BY ${role}`);await query(`DROP ROLE ${role}`);}
   }
  });
  assert.equal(outbound,0);
 }finally{
  try{if(companies.length)await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);if(userCreated)await query('DELETE FROM users WHERE id=$1',[userId]);}finally{try{await (globalThis as any).coatriaPool?.end();}finally{delete(globalThis as any).coatriaPool;try{await stop?.();}finally{globalThis.fetch=previousFetch;for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}}
 }
});
