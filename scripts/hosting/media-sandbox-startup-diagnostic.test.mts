import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySyntheticStartupStderr,diagnoseMediaSandboxStartup} from './media-sandbox-startup-diagnostic.mts';

test('synthetic startup diagnostics classify setup errors without returning their text',()=>{
 const result=classifySyntheticStartupStderr(Buffer.from('bwrap: setting up uid map /private/credential-canary failed: Operation not permitted'));
 assert.deepEqual(result,{classes:['USER_ID_MAPPING'],errno:['EPERM'],truncated:false});
 assert.doesNotMatch(JSON.stringify(result),/private|credential|bwrap|failed/);
});
test('unknown and credential-like stderr remains explicitly unclassified',()=>{
 for(const value of ['https://private.invalid/signed-token?credential=secret','private-value-with-no-known-host-error']){
  const result=classifySyntheticStartupStderr(Buffer.from(value));assert.deepEqual(result,{classes:['UNCLASSIFIED'],errno:[],truncated:false});assert.ok(!JSON.stringify(result).includes(value));
 }
});
test('classification is bounded and never consumes diagnostic text beyond its byte ceiling',()=>{
 const result=classifySyntheticStartupStderr(Buffer.from('x'.repeat(8192)+'Permission denied user map'));
 assert.deepEqual(result,{classes:['UNCLASSIFIED'],errno:[],truncated:true});
 assert.deepEqual(classifySyntheticStartupStderr(Buffer.alloc(0)),{classes:[],errno:[],truncated:false});
});
test('invalid identity prevents any diagnostic launch and cannot produce qualification',async()=>{
 const report=await diagnoseMediaSandboxStartup({uid:-1,gid:-1,cgroupRoot:'/private/credential-canary',supervisorGroup:'/private/credential-canary',profiles:{conformance:{profilePath:'/private/credential-canary',expectedProfileSha256:'secret'}}});
 assert.equal(report.qualified,false);assert.equal(report.diagnosticOnly,true);assert.equal(report.failureCode,'DIAGNOSTIC_STARTUP_FAILED');assert.deepEqual(report.phases,[]);assert.doesNotMatch(JSON.stringify(report),/credential-canary|secret/);
});
