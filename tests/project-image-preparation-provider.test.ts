/** Actual signed SDK/default provider ownership, with synthetic fetch responses.
 * No request is allowed to reach an external provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createImagePreparationByteProvider} from '../src/lib/project-image-preparation-provider';

const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const config=()=>({companyId:randomUUID(),projectId:randomUUID(),region:'US-CA-2' as const,volumeId:'synthetic-volume',credentials:{accessKeyId:'user_synthetic',secretAccessKey:'rps_synthetic'},timeoutMs:30000,maxObjectBytes:33554432,partBytes:64*1024**2});

test('provider owns late raw fetch and asynchronous body cancellation after SDK abort',{timeout:10000},async()=>{
 const previous=globalThis.fetch,entered=deferred(),late=deferred<Response>(),cancelling=deferred(),release=deferred();let drainDone=false,calls=0;
 globalThis.fetch=async(value,init)=>{calls++;assert.equal(new URL(String(value)).origin,'https://s3api-us-ca-2.runpod.io');assert.match(new Headers(init?.headers).get('authorization')!,/^AWS4-HMAC-SHA256 /);entered.resolve();return late.promise;};
 const provider=createImagePreparationByteProvider(config()),controller=new AbortController();
 try{
  const operation=provider.createMultipart({versionId:randomUUID(),bytes:16,contentType:'image/png',signal:controller.signal});await entered.promise;controller.abort();provider.close();await assert.rejects(operation);
  const drain=provider.drain().then(()=>{drainDone=true;});await delay(10);assert.equal(drainDone,false);
  late.resolve(new Response(new ReadableStream({cancel(){cancelling.resolve();return release.promise;}}),{headers:{'content-type':'application/xml'}}));
  await cancelling.promise;await delay(10);assert.equal(drainDone,false);release.resolve();await drain;assert.equal(drainDone,true);
  await assert.rejects(provider.createMultipart({versionId:randomUUID(),bytes:16,contentType:'image/png'}));assert.equal(calls,1);
 }finally{release.resolve();provider.close();globalThis.fetch=previous;}
});

test('failed late body cancellation cannot certify cleanup',{timeout:10000},async()=>{
 const previous=globalThis.fetch,entered=deferred(),late=deferred<Response>();
 globalThis.fetch=async()=>{entered.resolve();return late.promise;};
 const provider=createImagePreparationByteProvider(config()),controller=new AbortController();
 try{
  const operation=provider.createMultipart({versionId:randomUUID(),bytes:16,contentType:'image/png',signal:controller.signal});await entered.promise;controller.abort();provider.close();await assert.rejects(operation);
  const drain=provider.drain();late.resolve(new Response(new ReadableStream({cancel(){throw Error('Synthetic retained body');}}),{headers:{'content-type':'application/xml'}}));
  await assert.rejects(drain,/PREPARATION_PROVIDER_CLEANUP_FAILED/);
 }finally{provider.close();globalThis.fetch=previous;}
});

test('SDK response bodies enforce wall time even when empty chunks starve timers',{timeout:10000},async()=>{
 const previous=globalThis.fetch,originalNow=Date.now;let reads=0,cancelled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){reads++;if(reads>2)throw Error('Clock check did not stop empty input');Date.now=()=>originalNow()+60000;controller.enqueue(new Uint8Array(0));},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-type':'application/xml'}});
 const provider=createImagePreparationByteProvider(config());
 try{await assert.rejects(provider.createMultipart({versionId:randomUUID(),bytes:16,contentType:'image/png'}));provider.close();await provider.drain();assert.equal(reads,1);assert.equal(cancelled,true);}
 finally{Date.now=originalNow;provider.close();globalThis.fetch=previous;}
});
