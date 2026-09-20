import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySyntheticStartupStderr,diagnoseMediaSandboxStartup,diagnoseArchiveHostSandboxStartup,archiveStartupIdentity} from './media-sandbox-startup-diagnostic.mts';

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
test('installed archive diagnostics pin the qualifier, exact release and fixed profile paths',()=>{
 const release='/var/lib/coatria-archive-releases/'+'a'.repeat(64),self='0::/system.slice/coatria-archive-qualify.service/supervisor\n',invocation='b'.repeat(32),root='/sys/fs/cgroup/system.slice/coatria-archive-qualify.service',profile={runtimeRoot:release+'/runtime/media/conformance',launcher:{path:release+'/runtime/media-sandbox-launch'}},config={uid:123,gid:123,cgroupRoot:root+'/decoders',supervisorGroup:root+'/supervisor',profiles:{conformance:{profilePath:'/etc/coatria-archive/conformance.json',expectedProfileSha256:'c'.repeat(64)}}};
 assert.equal(archiveStartupIdentity(config,'conformance',profile,self,invocation,release+'/runtime/node'),true);
 for(const bad of [{...config,cgroupRoot:'/sys/fs/cgroup'},{...config,supervisorGroup:root},{...config,profiles:{conformance:{...config.profiles.conformance,profilePath:'/tmp/conformance.json'}}}])assert.equal(archiveStartupIdentity(bad,'conformance',profile,self,invocation,release+'/runtime/node'),false);
 for(const badSelf of [self.replace('-qualify.','-worker.'),self.replace('-qualify.','-preflight.'),'0::/\n'])assert.equal(archiveStartupIdentity(config,'conformance',profile,badSelf,invocation,release+'/runtime/node'),false);
 assert.equal(archiveStartupIdentity(config,'conformance',profile,self,'',release+'/runtime/node'),false);assert.equal(archiveStartupIdentity(config,'conformance',profile,self,invocation,release.replace('a'.repeat(64),'d'.repeat(64))+'/runtime/node'),false);assert.equal(archiveStartupIdentity(config,'conformance',{...profile,launcher:{path:'/tmp/launcher'}},self,invocation,release+'/runtime/node'),false);
});
test('installed diagnostic cannot launch for an unqualified identity or report success',async()=>{
 const report=await diagnoseArchiveHostSandboxStartup({uid:-1,gid:-1,cgroupRoot:'/private/canary',supervisorGroup:'/private/canary',profiles:{conformance:{profilePath:'/private/canary',expectedProfileSha256:'private'}}});assert.equal(report.qualified,false);assert.equal(report.failureCode,'DIAGNOSTIC_STARTUP_FAILED');assert.deepEqual(report.phases,[]);assert.doesNotMatch(JSON.stringify(report),/private|canary/);
});
