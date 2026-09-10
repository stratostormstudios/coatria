import test from 'node:test';
import assert from 'node:assert/strict';
import {api,setClientIdentity} from '../src/lib/client';

test('unreadable successful responses reject instead of replacing valid application state',async()=>{
 const original=globalThis.fetch;
 try{
  for(const body of ['{broken','','null','[]']){
   globalThis.fetch=async()=>new Response(body,{status:200});
   await assert.rejects(api('/api/companies/fixture/workspace'),{code:'INVALID_RESPONSE',status:502});
  }
  globalThis.fetch=async()=>Response.json({presence:[]});
  assert.deepEqual(await api('/api/companies/fixture/presence'),{presence:[]});
 }finally{globalThis.fetch=original;}
});

test('aborting response body consumption keeps AbortError visible to polling teardown',async()=>{
 const original=globalThis.fetch,abort=new DOMException('The request was aborted.','AbortError');
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.error(abort);}}));
  await assert.rejects(api('/api/companies/fixture/workspace'),error=>error===abort);
 }finally{globalThis.fetch=original;}
});

test('unreadable unauthorized responses still reconcile the current account',async()=>{
 const original=globalThis.fetch,originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
 const events=new EventTarget();let changes=0;events.addEventListener('coatria:session-changed',()=>changes++);
 try{
  Object.defineProperty(globalThis,'window',{configurable:true,value:events});
  globalThis.fetch=async()=>new Response('upstream failure',{status:401});
  await assert.rejects(api('/api/companies/fixture/workspace'),{status:401});assert.equal(changes,1);
 }finally{globalThis.fetch=original;if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');}
});

test('an account change during an unreadable response cannot commit to the new account',async()=>{
 const original=globalThis.fetch;
 try{
  setClientIdentity('first-account');
  globalThis.fetch=async()=>{setClientIdentity('second-account');return new Response('{broken');};
  await assert.rejects(api('/api/companies/fixture/workspace'),{code:'SESSION_CHANGED',status:409});
 }finally{setClientIdentity(null);globalThis.fetch=original;}
});
