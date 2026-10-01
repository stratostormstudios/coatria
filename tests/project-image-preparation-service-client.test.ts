/** Synthetic transport only: these tests prove credential routing, strict
 * metadata/byte boundaries and ownership; no provider or host is qualified. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createImagePreparationServiceClient,ImagePreparationServiceClientError,type ImagePreparationServiceClientOptions} from '../src/lib/project-image-preparation-service-client';
import {preparationServiceRequests,preparationByteCapabilitySchema,type PreparationByteCapability} from '../src/lib/project-image-preparation-service-protocol';
import type {ProjectImagePreparationLease} from '../src/lib/project-image-preparations-protocol';
import type {ProjectImagePreparationOperationContext,ProjectImagePreparationStoreIntent} from '../src/lib/project-image-preparation-worker-core';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
function fixture(){
 const serviceId=randomUUID(),companyId=randomUUID(),projectId=randomUUID(),expiresAt=new Date(Date.now()+300000).toISOString(),bytes=Buffer.from('synthetic binary transport only\0\xff','latin1');
 const options:ImagePreparationServiceClientOptions={origin:'https://app.example.com',serviceId,companyId,projectIds:[projectId],gateways:[{projectId,origin:'https://gateway.example.com'}],token:'ips_'+'s'.repeat(43),expiresAt,processor:{id:serviceId,location:'Synthetic Linux fixture',qualificationSha256:'a'.repeat(64),releaseSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),closureSha256:'e'.repeat(64),transport:'linux_binary_v1',recipeSha256:'f'.repeat(64),expiresAt}};
 const lease:ProjectImagePreparationLease={companyId,projectId,preparationId:randomUUID(),leaseId:randomUUID(),requestHash:'1'.repeat(64),expiresAt:new Date(Date.now()+110000).toISOString(),claimedAt:new Date().toISOString(),recipeSha256:options.processor.recipeSha256,source:{versionId:randomUUID(),fileId:randomUUID(),name:'Synthetic original.png',version:1,bytes:bytes.length,sha256:hash(bytes),contentType:'image/png'},processor:options.processor};
 const source={versionId:lease.source.versionId,bytes:bytes.length,sha256:hash(bytes),contentType:'image/png',etag:'"source"'},output={fileId:randomUUID(),versionId:randomUUID(),uploadId:randomUUID(),bytes:bytes.length,sha256:hash(bytes),partBytes:64*1024**2};
 const stop=new AbortController(),context:ProjectImagePreparationOperationContext={signal:stop.signal,assertCurrent:()=>stop.signal.throwIfAborted()},calls:{url:string;init:RequestInit;body:Record<string,any>|null}[]=[];
 let mutate:(cap:PreparationByteCapability)=>PreparationByteCapability=cap=>cap;
 const caps=new Map<string,PreparationByteCapability>();
 const request=async(value:string|URL|Request,init:RequestInit={})=>{
  const url=String(value),body=typeof init.body==='string'?JSON.parse(init.body):null;calls.push({url,init,body});
  assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');
  const headers=new Headers(init.headers);assert.equal(headers.has('cookie'),false);assert.equal(headers.has('origin'),false);
  if(url.startsWith(options.origin+'/')){
   assert.equal(headers.get('authorization'),'Bearer '+options.token);const operation=url.split('/').at(-1)!;
   assert.ok(preparationServiceRequests[operation as keyof typeof preparationServiceRequests].safeParse(body).success);
   if(operation==='claim')return Response.json({lease});
   if(operation==='readiness')return Response.json({readiness:{serviceId,companyId,projectIds:[projectId],processor:options.processor,expiresAt}});
   if(operation==='source')return Response.json({source});
   if(operation==='authorize')return Response.json({authorized:true});
   if(operation==='publish')return Response.json({status:'ready'});
   if(operation==='fail')return Response.json({status:'failed'});
   if(operation==='byte-capability'){
    const operation=body.transfer.operation,id=randomUUID(),read=operation==='read-source'||operation==='read-output';
    const cap=mutate({id,token:'ipt_'+'t'.repeat(43),origin:options.gateways[0].origin,operation,preparationId:lease.preparationId,leaseId:lease.leaseId,requestHash:lease.requestHash,versionId:operation==='read-source'?source.versionId:output.versionId,bytes:bytes.length,sha256:hash(bytes),contentType:'image/png',etag:read?operation==='read-source'?source.etag:'"stored"':null,actionId:read?null:body.transfer.actionId,expiresAt:new Date(Date.now()+20000).toISOString()});caps.set(id,cap);return Response.json({capability:cap});
   }
   throw Error('Unexpected synthetic control operation');
  }
  assert.ok(url.startsWith(options.gateways[0].origin+'/v1/image-preparations/capabilities/'));assert.equal(headers.get('authorization'),'Bearer '+'ipt_'+'t'.repeat(43));
  const cap=caps.get(url.split('/').at(-2)!)!;assert.ok(cap);
  if(cap.operation==='read-source'||cap.operation==='read-output')return new Response(bytes,{headers:{'content-type':cap.contentType,'content-length':String(bytes.length),etag:cap.etag!,'x-coatria-preparation-sha256':cap.sha256}});
  return Response.json({operation:cap.operation,actionId:cap.actionId,output,...cap.operation==='part'?{partNumber:1,bytes:bytes.length,sha256:hash(bytes)}:cap.operation==='complete'?{etag:'"stored"'}:{}});
 };
 return {options,lease,source,output,bytes,stop,context,calls,request:request as typeof fetch,mutateCap(fn:typeof mutate){mutate=fn;},intent(operation:ProjectImagePreparationStoreIntent['operation']):ProjectImagePreparationStoreIntent{return {actionId:randomUUID(),operation,output};}};
}

test('finite metadata and raw bytes use distinct pinned credentials and no implicit retry',async()=>{
 const f=fixture(),client=createImagePreparationServiceClient(f.options,{fetch:f.request});
 assert.equal((await client.readiness()).serviceId,f.options.serviceId);
 assert.deepEqual(await client.control.claim({companyId:f.options.companyId,projectIds:f.options.projectIds},f.context),f.lease);
 const source=await client.control.source(f.lease,f.context),read=await client.bytes.readSource(f.lease,source,f.context);
 assert.deepEqual(Buffer.from(await new Response(read.stream).arrayBuffer()),f.bytes);
 const initiate=f.intent('initiate');await client.bytes.initiate(f.lease,initiate,f.context);
 const part=f.intent('part');await client.bytes.uploadPart(f.lease,part,f.bytes,f.context);
 const complete=f.intent('complete');await client.bytes.complete(f.lease,complete,f.context);
 const output=await client.bytes.readOutput(f.lease,f.output,'"stored"',f.context);await new Response(output.stream).arrayBuffer();
 client.bytes.close();await client.bytes.drain();
 assert.equal((await client.control.publish(f.lease,{bytes:f.bytes.length,sha256:hash(f.bytes),etag:'"stored"',cleanupConfirmed:true},f.context)).status,'ready');
 const upload=f.calls.find(call=>call.init.method==='PUT')!;assert.ok(upload.init.body instanceof Uint8Array);assert.deepEqual(Buffer.from(upload.init.body),f.bytes);
 for(const call of f.calls.filter(call=>call.body))assert.doesNotMatch(JSON.stringify(call.body),/objectKey|provider_descriptor|accessKey|secretAccess|base64|synthetic binary/);
 assert.equal(new Set(f.calls.filter(call=>call.body).map(call=>call.body!.requestId)).size,f.calls.filter(call=>call.body).length);
 client.close();await client.drain();
});

test('unknown fields, alternate origins and unsupported processor transport are rejected',()=>{
 const f=fixture();for(const origin of ['http://app.example.com','https://127.0.0.1','https://app.example.com/path','https://app.example.com:8443'])assert.throws(()=>createImagePreparationServiceClient({...f.options,origin}),ImagePreparationServiceClientError);
 assert.throws(()=>createImagePreparationServiceClient({...f.options,processor:{...f.options.processor,transport:'vercel_binary_v1'}}),ImagePreparationServiceClientError);
 assert.equal(preparationServiceRequests.claim.safeParse({requestId:randomUUID(),deadlineAt:f.options.expiresAt,companyId:randomUUID()}).success,false);
 assert.equal(preparationByteCapabilitySchema.safeParse({url:'https://unreviewed.example.com',token:'ipt_'+'x'.repeat(43)}).success,false);
});

test('foreign, changed and expired byte capabilities stop before any gateway request',async t=>{
 for(const change of ['origin','lease','version','hash','expiry','action'] as const)await t.test(change,async()=>{
  const f=fixture();f.mutateCap(cap=>({...cap,...change==='origin'?{origin:'https://unreviewed.example.com'}:change==='lease'?{leaseId:randomUUID()}:change==='version'?{versionId:randomUUID()}:change==='hash'?{sha256:'0'.repeat(64)}:change==='expiry'?{expiresAt:new Date(Date.now()+3600000).toISOString()}:{actionId:randomUUID()}}));
  const client=createImagePreparationServiceClient(f.options,{fetch:f.request});await assert.rejects(client.bytes.readSource(f.lease,f.source,f.context),ImagePreparationServiceClientError);await client.drain();assert.equal(f.calls.length,1);client.close();
 });
});

test('operation mismatch and changed output bytes cannot consume a write capability',async()=>{
 const f=fixture(),client=createImagePreparationServiceClient(f.options,{fetch:f.request});
 await assert.rejects(client.bytes.initiate(f.lease,f.intent('complete'),f.context),ImagePreparationServiceClientError);
 await assert.rejects(client.bytes.uploadPart(f.lease,f.intent('part'),Buffer.alloc(f.bytes.length),f.context),ImagePreparationServiceClientError);assert.equal(f.calls.length,0);client.close();await client.drain();
});

test('a lost provider-side response is not retried with a replacement capability',async()=>{
 const f=fixture(),send:typeof fetch=async(value,init)=>{if(String(value).startsWith(f.options.gateways[0].origin))throw Error('synthetic lost response');return f.request(value,init);};
 const client=createImagePreparationServiceClient(f.options,{fetch:send}),intent=f.intent('initiate');
 await assert.rejects(client.bytes.initiate(f.lease,intent,f.context),ImagePreparationServiceClientError);
 await assert.rejects(client.bytes.initiate(f.lease,intent,f.context),ImagePreparationServiceClientError);assert.equal(f.calls.length,1);client.close();await client.drain();
});

test('synchronous close or cancellation prevents queued metadata transport from starting',async t=>{
 for(const stop of ['close','abort'] as const)await t.test(stop,async()=>{
  const f=fixture(),client=createImagePreparationServiceClient(f.options,{fetch:f.request});
  const pending=client.control.authorize(f.lease,f.context);
  if(stop==='close')client.close();else f.stop.abort();
  await assert.rejects(pending,ImagePreparationServiceClientError);await client.drain();
  assert.equal(f.calls.length,0);client.close();
 });
});

test('upload retains the checked bytes when the caller mutates its buffer during capability issuance',async()=>{
 const f=fixture(),entered=deferred(),release=deferred(),callerBytes=Buffer.from(f.bytes),intent=f.intent('part');
 const client=createImagePreparationServiceClient(f.options,{fetch:async(value,init)=>{
  const response=await f.request(value,init);
  if(String(value).endsWith('/byte-capability')){entered.resolve();await release.promise;}
  return response;
 }});
 const pending=client.bytes.uploadPart(f.lease,intent,callerBytes,f.context);
 await entered.promise;callerBytes.fill(0);release.resolve();await pending;
 const upload=f.calls.find(call=>call.init.method==='PUT')!;assert.ok(upload.init.body instanceof Uint8Array);
 assert.deepEqual(Buffer.from(upload.init.body),f.bytes);assert.equal(hash(Buffer.from(upload.init.body)),intent.output.sha256);
 assert.notDeepEqual(Buffer.from(upload.init.body),callerBytes);client.close();await client.drain();
});

test('late raw response and asynchronous body cancellation remain owned until drain completes',async()=>{
 const f=fixture(),entered=deferred(),late=deferred<Response>(),cancelling=deferred(),release=deferred();let cancelled=false,drained=false;
 const client=createImagePreparationServiceClient(f.options,{fetch:async(value,init)=>{if(String(value).startsWith(f.options.gateways[0].origin)){entered.resolve();return late.promise;}return f.request(value,init);}});
 const pending=client.bytes.readSource(f.lease,f.source,f.context);await entered.promise;f.stop.abort();await assert.rejects(pending,ImagePreparationServiceClientError);
 client.bytes.close();const drain=client.drain().then(()=>{drained=true;});await delay(10);assert.equal(drained,false);
 late.resolve(new Response(new ReadableStream({cancel(){cancelled=true;cancelling.resolve();return release.promise;}})));await cancelling.promise;await delay(10);assert.equal(cancelled,true);assert.equal(drained,false);
 release.resolve();await drain;assert.equal(drained,true);client.close();
});

test('unconfirmed cancellation poisons future traffic and fails drain',async()=>{
 const f=fixture(),client=createImagePreparationServiceClient(f.options,{fetch:async()=>new Response(new ReadableStream({cancel(){throw Error('synthetic retained response');}}),{status:502})});
 await assert.rejects(client.readiness(),ImagePreparationServiceClientError);await assert.rejects(client.drain(),error=>error instanceof ImagePreparationServiceClientError&&error.code==='PREPARATION_SERVICE_CLEANUP_FAILED');await assert.rejects(client.readiness(),ImagePreparationServiceClientError);client.close();
});

test('empty metadata chunks cannot starve the local request deadline',async()=>{
 const f=fixture(),originalNow=Date.now;let reads=0,cancelled=false;
 const client=createImagePreparationServiceClient(f.options,{fetch:async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){reads++;if(reads>2)throw Error('Clock check did not stop empty input');Date.now=()=>originalNow()+60000;controller.enqueue(new Uint8Array(0));},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-type':'application/json'}})});
 try{await assert.rejects(client.readiness(),ImagePreparationServiceClientError);await client.drain();assert.equal(reads,1);assert.equal(cancelled,true);}
 finally{Date.now=originalNow;client.close();await client.drain();}
});
