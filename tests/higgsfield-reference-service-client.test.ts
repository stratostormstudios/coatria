import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHiggsfieldReferenceServiceClient,ReferenceServiceClientError,type ReferenceServiceClientOptions} from '../src/lib/higgsfield-reference-service-client';
import {createHiggsfieldReferenceWorker} from '../src/lib/higgsfield-reference-worker';
import type {HiggsfieldReferenceLease} from '../src/lib/higgsfield-references-protocol';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),body=Buffer.from('small exact synthetic bytes'),profile='a'.repeat(64),qualification='b'.repeat(64);
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}}),signal=()=>new AbortController().signal;
function fixture(){
 const options:ReferenceServiceClientOptions={origin:'https://coatria.example',serviceId:randomUUID(),companyId:randomUUID(),projectIds:[randomUUID()],token:'rfs_'+'T'.repeat(43),profileSha256:profile,qualificationSha256:qualification,expiresAt:new Date(Date.now()+60000).toISOString(),requestTimeoutMs:1000};
 const descriptor={kind:'image' as const,format:'png' as const,contentType:'image/png',bytes:body.length,sha256:sha(body),verification:'full_decode' as const,inspectionVersion:1 as const,width:2,height:2,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};
 const lease:HiggsfieldReferenceLease={companyId:options.companyId,projectId:options.projectIds[0],referenceId:randomUUID(),leaseId:randomUUID(),requestHash:'c'.repeat(64),phase:'inspect',expiresAt:options.expiresAt,proxy:{versionId:randomUUID(),fileId:randomUUID(),name:'prepared.png',version:2,bytes:body.length,sha256:sha(body),contentType:'image/png'},role:'image',inspection:null};
 const readiness={enabled:true,hostQualified:true,storageVerified:true,catalogVerified:true,profileSha256:profile,qualificationSha256:qualification,expiresAt:options.expiresAt};
 const headers={'content-type':'image/png','content-length':String(body.length),etag:'"exact-etag"','x-coatria-reference-sha256':sha(body)};
 const calls:Array<{operation:string;input:Record<string,unknown>;init:RequestInit}>=[];
 let handler:(op:string,input:Record<string,unknown>)=>Response|Promise<Response>=(op)=>op==='readiness'?json({readiness}):op==='claim'?json({lease}):op==='authorize'?json({authorized:true}):op==='read-proxy'?new Response(body,{headers}):json({ok:true});
 const client=()=>createHiggsfieldReferenceServiceClient(options,{fetch:async(url,init)=>{const operation=String(url).split('/').at(-1)!;assert.equal(String(url),`${options.origin}/api/internal/reference-services/${options.serviceId}/${operation}`);const input=JSON.parse(String(init!.body));calls.push({operation,input,init:init!});return handler(operation,input);}});
 return {options,lease,readiness,descriptor,headers,calls,client,setHandler:(value:typeof handler)=>{handler=value;}};
}
test('service RPC confines identity and secrets to fixed HTTPS POST without redirects or retries',async()=>{
 const f=fixture(),client=f.client();await client.readiness!(signal());await client.claim(signal());await client.authorize(f.lease,signal());await client.recordInspection(f.lease,{descriptor:f.descriptor,profileSha256:profile},signal());await client.broker.allocate(f.lease,signal());await client.completePut(f.lease,randomUUID(),{phase:'put',bytes:body.length,sha256:sha(body),httpStatus:200},signal());await client.broker.confirm(f.lease,signal());await client.fail(f.lease,{code:'REFERENCE_WORKER_FAILED',uncertain:false});
 const ids=new Set();for(const c of f.calls){assert.match(String(c.input.requestId),/^[a-f0-9-]{36}$/);ids.add(c.input.requestId);assert.equal(c.init.redirect,'error');assert.equal(c.init.credentials,'omit');assert.equal(c.init.cache,'no-store');assert.equal(c.init.method,'POST');assert.equal(new Headers(c.init.headers).get('authorization'),'Bearer '+f.options.token);assert(!JSON.stringify(c.input).includes(f.options.token));assert(!('companyId'in c.input));assert(!('versionId'in c.input));assert(!('lease'in c.input));if(!['readiness','claim'].includes(c.operation)){assert.equal(c.input.referenceId,f.lease.referenceId);assert.equal(c.input.leaseId,f.lease.leaseId);assert.equal(c.input.requestHash,f.lease.requestHash);}}assert.equal(ids.size,f.calls.length);
});
test('untrusted origin, short token, duplicate scope, expired config and credential-bearing settings fail before fetch',()=>{
 for(const changes of [{origin:'http://coatria.example'},{origin:'https://coatria.example/'},{origin:'https://127.0.0.1'},{origin:'https://user:pass@coatria.example'},{origin:'https://coatria.example/path'},{origin:'https://coatria.example:8443'},{token:'rfs_short'},{expiresAt:new Date(Date.now()-1).toISOString()}]){const f=fixture();Object.assign(f.options,changes);assert.throws(()=>f.client());assert.equal(f.calls.length,0);}
 const f=fixture();f.options.projectIds=[f.options.projectIds[0],f.options.projectIds[0]];assert.throws(()=>f.client());
});
test('readiness must match exact startup profile and qualification; scope and stale leases fail closed',async()=>{
 for(const changed of [{profileSha256:'d'.repeat(64)},{qualificationSha256:'e'.repeat(64)},{expiresAt:new Date(Date.now()+120000).toISOString()}]){const f=fixture();Object.assign(f.readiness,changed);await assert.rejects(f.client().readiness!(signal()),ReferenceServiceClientError);}
 for(const changed of [{companyId:randomUUID()},{projectId:randomUUID()},{expiresAt:new Date(Date.now()-1).toISOString()}]){const f=fixture();Object.assign(f.lease,changed);await assert.rejects(f.client().claim(signal()),ReferenceServiceClientError);assert.equal(f.calls.length,1);}
});
test('invalid, oversized, redirected and error responses are bounded and raw secrets never escape',async()=>{
 const responses=[new Response('private upstream secret',{status:500}),new Response('private',{status:302,headers:{location:'https://other.example'}}),new Response('{}',{headers:{'content-type':'text/plain'}}),json({readiness:{},unexpected:'secret'}),new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'65537'}}),new Response('{}',{headers:{'content-type':'application/json','content-encoding':'gzip'}})];
 for(const response of responses){const f=fixture();f.setHandler(()=>response);await assert.rejects(f.client().readiness!(signal()),e=>e instanceof ReferenceServiceClientError&&!String(e).includes('private'));assert.equal(f.calls.length,1);}
});
test('hung fetch and aborted request return promptly, without retry or raw failure details',async()=>{
 const f=fixture();f.options.requestTimeoutMs=25;f.setHandler(()=>new Promise(()=>{}));const start=Date.now();await assert.rejects(f.client().claim(signal()),ReferenceServiceClientError);assert(Date.now()-start<1000);assert.equal(f.calls.length,1);
 const g=fixture();g.setHandler(()=>{throw new Error('sensitive upstream body');});await assert.rejects(g.client().broker.allocate({...g.lease,phase:'transfer'},signal()),e=>e instanceof ReferenceServiceClientError&&!String(e).includes('sensitive'));assert.equal(g.calls.length,1);
 const h=fixture(),stop=new AbortController();stop.abort();await assert.rejects(h.client().claim(stop.signal),ReferenceServiceClientError);assert.equal(h.calls.length,0);
});
test('exact binary proxy read is bounded; wrong hash/type/range and excess/truncated bodies are rejected',async()=>{
 const f=fixture(),read=await f.client().readProxy(f.lease,signal());assert.equal(await new Response(read.stream).text(),body.toString());assert.equal(read.range,null);assert.equal(read.totalBytes,body.length);
 const changes:Record<string,string>[]=[{'content-type':'application/octet-stream'},{'content-length':String(body.length+1)},{'x-coatria-reference-sha256':'f'.repeat(64)},{'content-range':'bytes 0-1/2'},{etag:'*'}];for(const change of changes){const g=fixture();g.setHandler(()=>new Response(body,{headers:{...g.headers,...change}}));await assert.rejects(g.client().readProxy(g.lease,signal()),ReferenceServiceClientError);}
 for(const bytes of [body.subarray(1),Buffer.concat([body,Buffer.from('extra')])]){const g=fixture();g.setHandler(()=>new Response(bytes,{headers:g.headers}));const read=await g.client().readProxy(g.lease,signal());await assert.rejects(new Response(read.stream).arrayBuffer(),ReferenceServiceClientError);}
});
test('aborting a stalled binary body cancels source and cannot leave the consumer hanging',async()=>{
 const f=fixture();let cancelled=0;f.options.requestTimeoutMs=25;f.setHandler(()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:f.headers}));const read=await f.client().readProxy(f.lease,signal());await assert.rejects(new Response(read.stream).arrayBuffer(),ReferenceServiceClientError);assert.equal(cancelled,1);assert.equal(f.calls.length,1);
});
test('actual worker uses client inspection handoff and cleans scratch without allocation',async t=>{
 const f=fixture(),scratch=await mkdtemp(join(tmpdir(),'coatria-reference-rpc-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const worker=createHiggsfieldReferenceWorker({companyId:f.options.companyId,projectIds:f.options.projectIds,scratchRoot:scratch,inspectionProfileSha256:profile},{...f.client(),inspectMedia:async()=>f.descriptor,upload:async()=>{assert.fail('inspection cannot upload');}});
 assert.equal((await worker.runNext()).status,'awaiting_approval');assert.equal(f.calls.filter(c=>c.operation==='inspection').length,1);assert.equal(f.calls.filter(c=>c.operation==='allocate'||c.operation==='begin-put'||c.operation==='confirm').length,0);assert.deepEqual(await readdir(scratch),[]);
});
test('actual worker transfer preserves bytes; lost mutating RPC replies become uncertainty and stop admission',async t=>{
 for(const lost of ['none','allocate','complete-put','confirm'] as const){
  const f=fixture(),scratch=await mkdtemp(join(tmpdir(),'coatria-reference-rpc-transfer-'));t.after(()=>rm(scratch,{recursive:true,force:true}));f.lease.phase='transfer';f.lease.inspection={descriptor:f.descriptor,profileSha256:profile,inspectionHash:'e'.repeat(64),inspectedAt:new Date().toISOString()};const actionId=randomUUID(),allocation={mediaId:randomUUID(),uploadUrl:'https://uploads.example/capability?signature=private',expiresAt:f.options.expiresAt};let uploads=0;
  f.setHandler(op=>{if(op===lost)throw Error('private lost provider outcome');switch(op){case'readiness':return json({readiness:f.readiness});case'claim':return json({lease:f.lease});case'authorize':return json({authorized:true});case'read-proxy':return new Response(body,{headers:f.headers});case'upload-capability':return json({allocation});case'begin-put':return json({actionId});default:return json({ok:true});}});
  const worker=createHiggsfieldReferenceWorker({companyId:f.options.companyId,projectIds:f.options.projectIds,scratchRoot:scratch,inspectionProfileSha256:profile},{...f.client(),inspectMedia:async()=>f.descriptor,upload:async input=>{uploads++;assert.deepEqual(input.body,body);assert.equal(input.sha256,sha(body));assert(!JSON.stringify(input).includes(f.options.token));return {bytes:body.length,sha256:sha(body),status:200};}});
  const result=await worker.runNext();assert.equal(result.status,lost==='none'?'confirmed':'uncertain');assert.equal(f.calls.filter(c=>c.operation==='claim').length,1);for(const op of ['allocate','begin-put','complete-put','confirm'])assert(f.calls.filter(c=>c.operation===op).length<=1);assert.equal(uploads,lost==='allocate'?0:1);assert.deepEqual(await readdir(scratch),[]);if(lost!=='none'){const failure=f.calls.find(c=>c.operation==='fail')!;assert.deepEqual(failure.input.failure,{code:'REFERENCE_PROVIDER_UNCERTAIN',uncertain:true});}
 }
});
test('JSON body timeout and late transport resolution are bounded and cancelled',async()=>{
 const f=fixture();f.options.requestTimeoutMs=25;let cancelled=0;f.setHandler(()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));await assert.rejects(f.client().claim(signal()),ReferenceServiceClientError);assert.equal(cancelled,1);
 const g=fixture();g.options.requestTimeoutMs=20;let resolve!:(r:Response)=>void,cancelledLate=0;g.setHandler(()=>new Promise(r=>{resolve=r;}));await assert.rejects(g.client().claim(signal()),ReferenceServiceClientError);resolve(new Response(new ReadableStream({cancel(){cancelledLate++;}})));await new Promise(r=>setTimeout(r,1));assert.equal(cancelledLate,1);assert.equal(g.calls.length,1);
});
test('expired authority permits only a bounded failure receipt, never another claim or phase',async()=>{
 const f=fixture();f.options.expiresAt=new Date(Date.now()+25).toISOString();f.lease.expiresAt=f.options.expiresAt;const client=f.client();await new Promise(r=>setTimeout(r,35));
 await client.fail(f.lease,{code:'REFERENCE_AUTHORITY_CHANGED',uncertain:false});assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'fail');
 await assert.rejects(client.claim(signal()),ReferenceServiceClientError);await assert.rejects(client.broker.allocate(f.lease,signal()),ReferenceServiceClientError);assert.equal(f.calls.length,1);
});

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,10));
test('binary cancellation awaits the raw body and its rejection poisons only safe client state',async()=>{
 for(const rejected of [false,true]){
  const f=fixture(),finish=deferred<void>();let started=0,cancelSettled=false,drainSettled=false;
  f.setHandler(()=>new Response(new ReadableStream({cancel(){started++;return finish.promise;}}),{headers:f.headers}));
  const client=f.client(),source=await client.readProxy(f.lease,signal());
  const cancelled=source.stream.cancel().then(()=>{cancelSettled=true;return null;},error=>{cancelSettled=true;return error;});
  const drained=client.drain().then(()=>{drainSettled=true;return null;},error=>{drainSettled=true;return error;});
  await turn();assert.equal(started,1);assert.equal(cancelSettled,false);assert.equal(drainSettled,false);
  if(rejected)finish.reject(Error('private raw cancellation detail'));else finish.resolve();
  for(const result of [await cancelled,await drained])if(rejected){assert(result instanceof ReferenceServiceClientError);assert(!String(result).includes('private'));}else assert.equal(result,null);
  if(rejected){await assert.rejects(client.readiness!(signal()),ReferenceServiceClientError);assert.equal(f.calls.length,1,'Failed cleanup cannot be followed by another transport request');}
 }
});
test('JSON deadline stays bounded while the exact raw body cancellation remains owned by drain',async()=>{
 const f=fixture(),finish=deferred<void>();f.options.requestTimeoutMs=20;let cancelled=0,settled=false;
 f.setHandler(()=>new Response(new ReadableStream({cancel(){cancelled++;return finish.promise;}}),{headers:{'content-type':'application/json'}}));
 const client=f.client(),start=Date.now();await assert.rejects(client.claim(signal()),ReferenceServiceClientError);assert(Date.now()-start<1000);assert.equal(cancelled,1);
 const drained=client.drain().then(()=>{settled=true;});await turn();assert.equal(settled,false);finish.resolve();await drained;assert.equal(f.calls.length,1);
});
test('client raw cancellation rejection drains local worker scratch and cannot admit another claim',async t=>{
 const f=fixture(),entered=deferred<void>(),stop=new AbortController(),scratch=await mkdtemp(join(tmpdir(),'coatria-reference-cancel-rejected-'));t.after(()=>rm(scratch,{recursive:true,force:true}));let cancels=0;
 f.setHandler(op=>op==='readiness'?json({readiness:f.readiness}):op==='claim'?json({lease:f.lease}):op==='authorize'?json({authorized:true}):op==='read-proxy'?(entered.resolve(),new Response(new ReadableStream({cancel(){cancels++;throw Error('private raw cancellation detail');}}),{headers:f.headers})):json({ok:true}));
 const client=f.client(),worker=createHiggsfieldReferenceWorker({companyId:f.options.companyId,projectIds:f.options.projectIds,scratchRoot:scratch,inspectionProfileSha256:profile,cleanupTimeoutMs:100},{...client,inspectMedia:async()=>{assert.fail('Stalled source cannot be inspected');},upload:async()=>{assert.fail('Inspection cannot upload');}});
 const attempt=worker.runNext({signal:stop.signal});await entered.promise;await turn();stop.abort();const result=await attempt;
 assert.equal(result.status,'failed');assert(!JSON.stringify(result).includes('private'));assert.equal(cancels,1);assert.deepEqual(await readdir(scratch),[]);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.calls.filter(c=>c.operation==='claim').length,1);assert.equal(f.calls.filter(c=>['allocate','begin-put','confirm'].includes(c.operation)).length,0);await assert.rejects(client.drain(),ReferenceServiceClientError);
});
test('late raw fetch and cancellation stay owned after worker cleanup timeout, without retries',async t=>{
 for(const rejected of [false,true]){
  const f=fixture(),response=deferred<Response>(),cancelStarted=deferred<void>(),finishCancel=deferred<void>(),scratch=await mkdtemp(join(tmpdir(),'coatria-reference-late-transport-'));t.after(()=>rm(scratch,{recursive:true,force:true}));f.options.requestTimeoutMs=20;let cancels=0;
  f.setHandler(op=>op==='readiness'?json({readiness:f.readiness}):op==='claim'?json({lease:f.lease}):op==='authorize'?json({authorized:true}):op==='read-proxy'?response.promise:json({ok:true}));
  const client=f.client(),worker=createHiggsfieldReferenceWorker({companyId:f.options.companyId,projectIds:f.options.projectIds,scratchRoot:scratch,inspectionProfileSha256:profile,cleanupTimeoutMs:25},{...client,inspectMedia:async()=>{assert.fail('Late source cannot be inspected');},upload:async()=>{assert.fail('Inspection cannot upload');}});
  const start=Date.now(),result=await worker.runNext();assert(Date.now()-start<1000);assert.equal(result.status,'failed');assert.equal((await worker.runNext()).status,'disabled');assert.equal((await readdir(scratch)).length,1);
  response.resolve(new Response(new ReadableStream({cancel(){cancels++;cancelStarted.resolve();return finishCancel.promise;}}),{headers:f.headers}));await cancelStarted.promise;
  let settled=false;const drained=client.drain().then(()=>{settled=true;return null;},error=>{settled=true;return error;});await turn();assert.equal(settled,false);assert.equal((await readdir(scratch)).length,1);
  if(rejected)finishCancel.reject(Error('private late cancellation detail'));else finishCancel.resolve();const failure=await drained;if(rejected){assert(failure instanceof ReferenceServiceClientError);assert(!String(failure).includes('private'));}else assert.equal(failure,null);
  for(let i=0;i<50&&(await readdir(scratch)).length;i++)await turn();assert.deepEqual(await readdir(scratch),[]);assert.equal(cancels,1);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.calls.filter(c=>c.operation==='claim').length,1);assert.equal(f.calls.filter(c=>['allocate','begin-put','confirm'].includes(c.operation)).length,0);
 }
});
