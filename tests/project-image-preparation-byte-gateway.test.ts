/** Real relational authorization/state with synthetic provider bytes. This is
 * not live Runpod, native decoder, or host qualification evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';
import {createImagePreparationByteGateway} from '../src/lib/project-image-preparation-byte-gateway';
import type {ImagePreparationByteProvider} from '../src/lib/project-image-preparation-provider';
import {hashToken} from '../src/lib/security';
import * as preparations from '../src/lib/project-image-preparations';
import * as storage from '../src/lib/project-image-preparation-storage';
import {runpodProjectRoot,type RunpodMultipartUpload} from '../src/lib/project-storage-runpod';
import type {PreparationByteOperation} from '../src/lib/project-image-preparation-service-protocol';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};

test('finite byte gateway uses authoritative capabilities and immutable provider evidence',{timeout:120000},async t=>{
 const database=await openImagePreparationServiceDatabase(),originalKeyring=process.env.COATRIA_HOSTING_KEYRING;
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function fixture(sourceBytes?:Buffer){
  const source=sourceBytes??Buffer.from('Synthetic original transport bytes. Decoder is not part of this fixture.');
  const f=await database.tx(db=>imagePreparationServiceFixture(db,{sourceBytes:source}));
  process.env.COATRIA_HOSTING_KEYRING=f.storageKeyring;
  await database.tx(db=>f.approve(db));const lease=await database.tx(db=>f.claim(db));
  const output=Buffer.from('Synthetic derivative transport bytes. No pixel claim.');
  const calls:string[]=[],scope=hash(JSON.stringify(['US-CA-2','synthetic-volume',runpodProjectRoot(f.companyId,f.projectId)]));
  let stored:Buffer|undefined,hook:((operation:string)=>Promise<void>)|undefined,drainHook:(()=>Promise<void>)|undefined,tinyChunks=false,streamFactory:((bytes:Buffer)=>ReadableStream<Uint8Array>)|undefined;
  const factory=():ImagePreparationByteProvider=>({
   async verifyBucketAccess(){throw Error('No synthetic bucket access');},async list(){throw Error('No synthetic listing');},async head(){throw Error('No synthetic HEAD');},async abortMultipart(){throw Error('No synthetic delete');},
   async get(input){const operation=input.versionId===f.versionId?'read-source':'read-output';calls.push(operation);await hook?.(operation);const bytes=operation==='read-source'?source:stored!;assert.ok(bytes);let offset=0;const stream=streamFactory?streamFactory(bytes):tinyChunks?new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.subarray(offset,++offset));}},{highWaterMark:0}):new Response(new Uint8Array(bytes)).body!;return {stream,bytes:bytes.length,totalBytes:bytes.length,contentType:'image/png',etag:operation==='read-source'?'synthetic-source-etag':'stored-etag',range:null,contentRange:null};},
   async createMultipart(input){calls.push('initiate');await hook?.('initiate');return {scope,versionId:input.versionId,uploadId:'synthetic-private-multipart',bytes:input.bytes,partBytes:64*1024**2};},
   validateMultipart(value){const v=value as RunpodMultipartUpload;assert.equal(v.scope,scope);return structuredClone(v);},
   async uploadPart(input){calls.push('part');await hook?.('part');assert(input.body instanceof Uint8Array);stored=Buffer.from(input.body);return {partNumber:1,bytes:stored.length,etag:'private-part-etag'};},
   async completeMultipart(input){calls.push('complete');await hook?.('complete');assert.equal(input.parts.length,1);return {versionId:input.upload.versionId,etag:'stored-etag'};},
   close(){},async drain(){await drainHook?.();},
  });
  const identity={version:1 as const,companyId:f.companyId,projectIds:[f.projectId],provisionId:f.gateway.provisionId,configurationHash:f.gateway.configurationHash,sourceCommit:'b'.repeat(40),expiresAt:f.gateway.expiresAt};
  const gateway=createImagePreparationByteGateway({transaction:database.tx,identity,providerFactory:factory});
  async function prepareOutput(){
   const action=await database.tx(db=>preparations.beginProjectImagePreparationPhase(db,lease,'transform',f.runtime));
   await database.tx(db=>preparations.completeProjectImagePreparationPhase(db,lease,action.actionId,{operation:'transform',sourceVersionId:f.versionId,sourceSha256:hash(source),sourceBytes:source.length,source:{format:'png',width:16,height:16,orientation:1},recipeSha256:lease.recipeSha256,processor:lease.processor,output:{sha256:hash(output),bytes:output.length,width:16,height:16,format:'png',pixelFormat:'rgba8',metadataRemoved:true}},f.runtime));
   return database.tx(db=>storage.reserveProjectImagePreparationOutput(db,lease,f.runtime));
  }
  async function capability(operation:PreparationByteOperation,actionId:string|null=null){
   const grantId=randomUUID(),requestId=randomUUID(),token='ipt_'+randomBytes(32).toString('base64url');
   await database.tx(async db=>{
    const p=(await db.query('SELECT * FROM project_image_preparations WHERE id=$1',[lease.preparationId])).rows[0];
    const allocation=(await db.query('SELECT a.*,u.provider_etag FROM project_image_preparation_allocations a JOIN project_storage_uploads u ON u.company_id=a.company_id AND u.id=a.upload_id WHERE a.preparation_id=$1',[lease.preparationId])).rows[0];
    const sourceRead=operation==='read-source',expires=new Date(Date.now()+25000).toISOString();
    await db.query("INSERT INTO project_image_preparation_service_calls(service_id,request_id,operation,request_hash,deadline_at,status) VALUES($1,$2,'byte-capability',$3,$4,'started')",[f.serviceId,requestId,'f'.repeat(64),expires]);
    await db.query(`INSERT INTO project_image_preparation_byte_grants(id,service_id,company_id,project_id,preparation_id,lease_id,request_id,request_hash,token_hash,operation,action_id,version_id,upload_id,bytes,sha256,content_type,expected_etag,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision,gateway_binding_id,gateway_provision_id,gateway_configuration_sha256,gateway_origin,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'image/png',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [grantId,f.serviceId,f.companyId,f.projectId,lease.preparationId,lease.leaseId,requestId,lease.requestHash,hashToken(token),operation,actionId,sourceRead?f.versionId:allocation.version_id,sourceRead?null:allocation.upload_id,sourceRead?source.length:output.length,sourceRead?hash(source):hash(output),sourceRead?'synthetic-source-etag':operation==='read-output'?allocation.provider_etag:null,p.storage_binding_id,sourceRead?p.storage_binding_revision:allocation.binding_revision_after,p.storage_connection_id,p.storage_connection_revision,f.gateway.bindingId,f.gateway.provisionId,f.gateway.configurationHash,f.gateway.origin,expires]);
   });
   return {id:grantId,token,operation};
  }
  function request(cap:Awaited<ReturnType<typeof capability>>,body?:Buffer,signal?:AbortSignal){
   return new Request(f.gateway.origin+'/v1/image-preparations/capabilities/'+cap.id+'/'+cap.operation,{method:cap.operation.startsWith('read-')?'GET':cap.operation==='part'?'PUT':'POST',headers:{authorization:'Bearer '+cap.token,...body?{'content-type':'image/png','content-length':String(body.length)}:{}},...body?{body:new Uint8Array(body)}:{},signal});
  }
  async function result(id:string){return (await database.db.query('SELECT * FROM project_image_preparation_byte_results WHERE grant_id=$1',[id])).rows[0];}
  return {...f,source,output,lease,calls,identity,factory,gateway,capability,request,result,prepareOutput,setHook(value:typeof hook){hook=value;},setDrain(value:typeof drainHook){drainHook=value;},setStream(value:typeof streamFactory){streamFactory=value;},tinyChunks(){tinyChunks=true;},corruptSource(){source[0]^=1;}};
 }
 async function stage(f:Fixture,operation:'initiate'|'part'|'complete'){
  const intent=await database.tx(db=>storage.beginProjectImagePreparationStore(db,f.lease,operation,f.runtime));
  const cap=await f.capability(operation,intent.actionId),response=await f.gateway.handle(f.request(cap,operation==='part'?f.output:undefined));
  return {intent,cap,response};
 }
 try{
  await t.test('source, all writes and readback are independently verified before publication',async()=>{
   const f=await fixture(),original=Buffer.from(f.source),sourceCap=await f.capability('read-source'),read=await f.gateway.handle(f.request(sourceCap));
   assert.equal(read.status,200,await read.clone().text());assert.deepEqual(Buffer.from(await read.arrayBuffer()),original);
   await f.prepareOutput();
   for(const operation of ['initiate','part','complete'] as const){
    const {intent,cap,response}=await stage(f,operation);assert.equal(response.status,200,await response.clone().text());
    const visible=await response.json();assert.doesNotMatch(JSON.stringify(visible),/private-multipart|private-part-etag|scope|credentials|rps_/);
    const saved=await f.result(cap.id);assert.equal(saved.status,'completed');assert.deepEqual(saved.public_result,visible);
    await database.tx(db=>storage.completeProjectImagePreparationStore(db,f.lease,intent.actionId,saved.provider_result,f.runtime));
   }
   const storedCap=await f.capability('read-output'),stored=await f.gateway.handle(f.request(storedCap));assert.equal(stored.status,200,await stored.clone().text());
   assert.deepEqual(Buffer.from(await stored.arrayBuffer()),f.output);const proof=await f.result(storedCap.id);assert.equal(proof.observed_sha256,hash(f.output));
   await database.tx(db=>storage.publishProjectImagePreparation(db,f.lease,{bytes:f.output.length,sha256:hash(f.output),etag:'stored-etag',cleanupConfirmed:true},f.runtime));
   assert.deepEqual(f.calls,['read-source','initiate','part','complete','read-output']);assert.deepEqual(f.source,original);
   assert.equal((await database.db.query('SELECT count(*)::int AS n FROM project_image_preparation_derivations WHERE preparation_id=$1',[f.lease.preparationId])).rows[0].n,1);
   f.gateway.close();await f.gateway.drain();
  });
  await t.test('another gateway identity and wrong token cannot reach the provider',async()=>{
   const f=await fixture(),cap=await f.capability('read-source'),foreign=createImagePreparationByteGateway({transaction:database.tx,identity:{...f.identity,provisionId:randomUUID()},providerFactory:f.factory});
   assert.equal((await foreign.handle(f.request(cap))).status,403);assert.equal((await f.gateway.handle(f.request({...cap,token:'ipt_'+randomBytes(32).toString('base64url')}))).status,403);
   assert.equal(f.calls.length,0);assert.equal(await f.result(cap.id),undefined);foreign.close();f.gateway.close();await foreign.drain();await f.gateway.drain();
  });
  await t.test('one-byte source and upload chunks keep exact bounded byte results',async()=>{
   const f=await fixture(Buffer.alloc(128*1024,97));f.tinyChunks();const cap=await f.capability('read-source');
   const read=await f.gateway.handle(f.request(cap));assert.equal(read.status,200,await read.clone().text());assert.deepEqual(Buffer.from(await read.arrayBuffer()),f.source);
   await f.prepareOutput();const initial=await stage(f,'initiate');assert.equal(initial.response.status,200);
   const initialResult=await f.result(initial.cap.id);
   await database.tx(db=>storage.completeProjectImagePreparationStore(db,f.lease,initial.intent.actionId,initialResult.provider_result,f.runtime));
   const intent=await database.tx(db=>storage.beginProjectImagePreparationStore(db,f.lease,'part',f.runtime)),part=await f.capability('part',intent.actionId);let offset=0;
   const request=new Request(f.request(part).url,{method:'PUT',headers:{authorization:'Bearer '+part.token,'content-type':'image/png','content-length':String(f.output.length)},body:new ReadableStream({pull(controller){if(offset===f.output.length)controller.close();else controller.enqueue(f.output.subarray(offset,++offset));}},{highWaterMark:0}),duplex:'half'} as RequestInit);
   assert.equal((await f.gateway.handle(request)).status,200);assert.equal((await f.result(part.id)).observed_sha256,hash(f.output));f.gateway.close();await f.gateway.drain();
  });
  await t.test('independent company mutex contention waits without revoking or repeating provider work',{skip:!database.native},async()=>{
   const f=await fixture(),cap=await f.capability('read-source'),pool=new Pool({connectionString:database.connectionString,max:1}),blocker=await pool.connect();let pending:Promise<Response>|undefined;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['project-image-preparation:'+f.companyId]);
    pending=f.gateway.handle(f.request(cap));await delay(50);assert.equal(f.calls.length,0);
    // The waiting gateway has taken no service/sponsor row locks.
    await blocker.query('SELECT id FROM project_image_preparation_services WHERE id=$1 FOR UPDATE NOWAIT',[f.serviceId]);
    await blocker.query('COMMIT');assert.equal((await pending).status,200);assert.deepEqual(f.calls,['read-source']);
   }finally{await blocker.query('ROLLBACK');blocker.release();await pool.end();await pending;f.gateway.close();await f.gateway.drain();}
  });
  await t.test('changed stored bytes remain uncertain and cannot be reread with the consumed grant',async()=>{
   const f=await fixture(),cap=await f.capability('read-source');f.corruptSource();
   assert.equal((await f.gateway.handle(f.request(cap))).status,409);assert.equal((await f.result(cap.id)).status,'started');
   assert.equal((await f.gateway.handle(f.request(cap))).status,409);assert.deepEqual(f.calls,['read-source']);f.gateway.close();await f.gateway.drain();
  });
  await t.test('lost provider initiation is retained and never automatically repeated',async()=>{
   const f=await fixture();await f.prepareOutput();f.setHook(async operation=>{if(operation==='initiate')throw Error('Synthetic lost private-provider-response');});
   const {cap,response}=await stage(f,'initiate');assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/private-provider/);
   assert.equal((await f.result(cap.id)).status,'started');assert.equal((await f.gateway.handle(f.request(cap))).status,409);assert.deepEqual(f.calls,['initiate']);f.gateway.close();await f.gateway.drain();
  });
  await t.test('revocation during provider I/O prevents a returned receipt',async()=>{
   const f=await fixture();await f.prepareOutput();f.setHook(async operation=>{if(operation==='initiate')await database.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.companyId,f.userId]);});
   const {cap,response}=await stage(f,'initiate');assert.notEqual(response.status,200);assert.equal((await f.result(cap.id)).status,'started');assert.deepEqual(f.calls,['initiate']);f.gateway.close();await f.gateway.drain();
  });
  await t.test('late provider cleanup stays owned and blocks completion until confirmed',async()=>{
   const f=await fixture(),cap=await f.capability('read-source'),entered=deferred(),release=deferred();let settled=false;
   f.setDrain(async()=>{entered.resolve();await release.promise;});
   const pending=f.gateway.handle(f.request(cap)).then(r=>{settled=true;return r;});await entered.promise;await delay(10);
   assert.equal(settled,false);assert.equal((await f.result(cap.id)).status,'started');release.resolve();assert.equal((await pending).status,200);f.gateway.close();await f.gateway.drain();
  });
  await t.test('failed cleanup poisons admission and never publishes byte evidence',async()=>{
   const f=await fixture(),cap=await f.capability('read-source');f.setDrain(async()=>{throw Error('Synthetic held cleanup');});
   assert.equal((await f.gateway.handle(f.request(cap))).status,503);assert.equal((await f.result(cap.id)).status,'started');
   assert.equal((await f.gateway.handle(f.request(cap))).status,503);assert.deepEqual(f.calls,['read-source']);f.gateway.close();await assert.rejects(f.gateway.drain());
  });
  await t.test('synchronous empty chunks cannot starve the grant deadline timer',async()=>{
   const f=await fixture(),cap=await f.capability('read-source'),originalNow=Date.now;let reads=0,cancelled=false,drained=false;
   f.setStream(()=>new ReadableStream<Uint8Array>({pull(controller){reads++;if(reads>2)throw Error('Clock check did not stop empty input');Date.now=()=>originalNow()+60000;controller.enqueue(new Uint8Array(0));},cancel(){cancelled=true;}},{highWaterMark:0}));
   f.setDrain(async()=>{drained=true;});
   try{assert.equal((await f.gateway.handle(f.request(cap))).status,409);assert.equal(reads,1);assert.equal(cancelled,true);assert.equal(drained,true);}
   finally{Date.now=originalNow;f.gateway.close();await f.gateway.drain();}
   assert.equal((await f.result(cap.id)).status,'started');assert.deepEqual(f.calls,['read-source']);
  });
 }finally{if(originalKeyring===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=originalKeyring;await database.close();}
});
