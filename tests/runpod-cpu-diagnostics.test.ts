import test from 'node:test';
import assert from 'node:assert/strict';
import {observeRunpodCpuCreate,type CpuCreateDiagnostic} from '../src/lib/runpod-cpu-diagnostics';
const provision='928be2c7-adb9-4365-934e-c26b3c919a93',requestId='c69b8333-eaea-4b8e-ac70-0e3113dc8b3f';

test('useful HTTP failures remain the original unread response and issue exactly one request',async()=>{
 for(const [status,category] of [[400,'bad_request'],[401,'unauthorized'],[402,'payment_required'],[403,'forbidden'],[404,'not_found'],[409,'conflict'],[413,'payload_too_large'],[422,'validation_rejected'],[429,'rate_limited'],[500,'provider_server_error'],[503,'provider_server_error']] as const){
  let calls=0;const events:CpuCreateDiagnostic[]=[],response=new Response('secret original provider body',{status,headers:{'x-request-id':requestId}});
  assert.equal(await observeRunpodCpuCreate(provision,async()=>{calls++;return response;},event=>events.push(event)),response);
  assert.equal(calls,1);assert.equal(response.bodyUsed,false);assert.deepEqual(events,[{version:1,event:'runpod.cpu_create_observation',provisionId:provision,httpStatus:status,category,requestId}]);
 }
});
test('successful HTTP response records no claim of resource allocation and is not consumed',async()=>{
 const events:CpuCreateDiagnostic[]=[],response=new Response('invalid JSON',{status:201});await observeRunpodCpuCreate(provision,async()=>response,event=>events.push(event));assert.equal(response.bodyUsed,false);assert.equal(events[0].category,'response_received');assert.equal(events[0].httpStatus,201);assert.equal(events[0].requestId,null);
});
test('raw provider bodies, error codes, messages and non-allowlisted headers never enter telemetry',async()=>{
 // Assemble synthetic credential-shaped values only in memory; no credential
 // literals or scanner exceptions belong in the repository.
 const database=new URL('postgresql://private.invalid/db');database.username='private';database.password='password';
 const secrets=['rpa_'+'synthetic_PRIVATE_KEY',database.href,'Bearer PRIVATE','https://private.invalid/?token=PRIVATE','PRIVATE'.repeat(1000)];
 for(const secret of secrets){const events:CpuCreateDiagnostic[]=[],response=new Response(JSON.stringify({code:secret,detail:secret,errors:[secret]}),{status:400,headers:{'x-request-id':secret,'x-error-code':secret,'set-cookie':secret,authorization:secret}});await observeRunpodCpuCreate(provision,async()=>response,event=>events.push(event));assert.equal(events[0].requestId,null);assert(!JSON.stringify(events).includes(secret));assert(JSON.stringify(events[0]).length<512);assert.equal(response.bodyUsed,false);}
});
test('only canonical UUID or 32-hex x-request-id is retained',async()=>{
 for(const value of [requestId,requestId.toUpperCase(),'a'.repeat(32)]){const events:CpuCreateDiagnostic[]=[],response=new Response(null,{status:403,headers:{'x-request-id':value}});await observeRunpodCpuCreate(provision,async()=>response,event=>events.push(event));assert.equal(events[0].requestId,value.toLowerCase());}
 for(const value of ['abc','a'.repeat(31),'a'.repeat(33),requestId+', '+requestId,'req_'+requestId,'12345678-1234-0000-0000-123456789012']){const events:CpuCreateDiagnostic[]=[];await observeRunpodCpuCreate(provision,async()=>new Response(null,{status:403,headers:{'x-request-id':value}}),event=>events.push(event));assert.equal(events[0].requestId,null);}
});
test('timeouts and network errors keep the exact original rejection without retrying or logging messages',async()=>{
 for(const name of ['Error','TypeError','AbortError','TimeoutError']){let calls=0;const error=Object.assign(new Error('private provider token'),{name}),events:CpuCreateDiagnostic[]=[];await assert.rejects(observeRunpodCpuCreate(provision,async()=>{calls++;throw error;},event=>events.push(event)),value=>value===error);assert.equal(calls,1);assert.equal(events[0].category,['AbortError','TimeoutError'].includes(name)?'timeout_or_abort':'network_error');assert.equal(events[0].httpStatus,null);assert(!JSON.stringify(events).includes('private'));}
});
test('telemetry failure or invalid local identity cannot change request semantics',async()=>{
 const response=new Response(null,{status:500});assert.equal(await observeRunpodCpuCreate(provision,async()=>response,()=>{throw Error('logging unavailable');}),response);const error=Error('original');await assert.rejects(observeRunpodCpuCreate(provision,async()=>{throw error;},()=>{throw Error('logging unavailable');}),value=>value===error);let emitted=false;assert.equal(await observeRunpodCpuCreate('not-a-provision',async()=>response,()=>{emitted=true;}),response);assert.equal(emitted,false);
});
