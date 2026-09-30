import test from 'node:test';
import assert from 'node:assert/strict';
import {RUNPOD_CPU_CREATE_MAX_BYTES,serializeRunpodCpuCreate} from '../src/lib/runpod-cpu-create-request';

for(const scope of ['CPU','SERVICE'] as const){
 test(`${scope} create body accepts exactly 102400 UTF-8 bytes and rejects one byte over`,()=>{
  const payload={args:'bootstrap',env:{privateValue:''}},overhead=Buffer.byteLength(JSON.stringify(payload));
  payload.env.privateValue='x'.repeat(RUNPOD_CPU_CREATE_MAX_BYTES-overhead);
  const body=serializeRunpodCpuCreate(payload,scope);
  assert.equal(Buffer.byteLength(body,'utf8'),102400);assert.deepEqual(JSON.parse(body),payload);
  payload.env.privateValue+='x';
  assert.throws(()=>serializeRunpodCpuCreate(payload,scope),{status:413,code:scope+'_CREATE_REQUEST_TOO_LARGE'});
 });
 test(`${scope} complete body accounts for environment, JSON escapes and UTF-8 rather than character counts`,()=>{
  const bootstrapAndConfig={args:'b'.repeat(99000),env:{configuration:'c'.repeat(4000)}};
  assert(bootstrapAndConfig.args.length<100000);
  assert.throws(()=>serializeRunpodCpuCreate(bootstrapAndConfig,scope),{code:scope+'_CREATE_REQUEST_TOO_LARGE'});
  for(const value of ['é'.repeat(52000),'\\'.repeat(52000),'\u0000'.repeat(18000)]){
   const payload={env:{privateValue:value}};
   assert(value.length<102400);assert(Buffer.byteLength(JSON.stringify(payload),'utf8')>102400);
   assert.throws(()=>serializeRunpodCpuCreate(payload,scope),{code:scope+'_CREATE_REQUEST_TOO_LARGE'});
  }
 });
}

test('serialization is a single immutable snapshot and local errors disclose no private payload or thrown message',()=>{
 const privateMarker='synthetic-private-value',data={env:{value:privateMarker}};let calls=0;
 const body=serializeRunpodCpuCreate({toJSON(){calls++;return data;}},'CPU');
 data.env.value='changed';assert.equal(calls,1);assert.equal(JSON.parse(body).env.value,privateMarker);
 for(const [payload,code] of [[{env:{value:privateMarker.repeat(10000)}},'SERVICE_CREATE_REQUEST_TOO_LARGE'],[{toJSON(){throw Error(privateMarker);}},'SERVICE_CREATE_REQUEST_INVALID']] as const){
  assert.throws(()=>serializeRunpodCpuCreate(payload,'SERVICE'),error=>{
   assert.equal((error as {code:string}).code,code);
   assert(!String(error).includes(privateMarker));assert(!JSON.stringify(error).includes(privateMarker));
   return true;
  });
 }
});
