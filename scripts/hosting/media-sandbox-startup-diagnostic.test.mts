import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySyntheticStartupStderr,diagnoseMediaSandboxStartup,diagnoseArchiveHostSandboxStartup,archiveStartupIdentity} from './media-sandbox-startup-diagnostic.mts';
import {assertMediaSandboxBoundary,mediaSandboxBoundaryObservation} from './media-sandbox-linux-canary.mts';
import {MediaSandboxError} from '../../src/lib/higgsfield-media-sandbox';

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

const boundaryKeys=['hostFileHidden','hostProcHidden','environmentClean','extraHandlesClosed','inputReadonly','rootReadonly','capabilitiesZero','noNewPrivileges','nestedUsernsDenied','localNetworkDenied','externalNetworkDenied','ipv6Denied'];
const networkKeys=['interfacesLoopbackOnly','routableDefaultAbsent','apparmorChildStacked'];
const namespaceKeys=['mnt','pid','net','ipc','uts','user','cgroup'];
function boundaryFixture(){
 const limits={memoryBytes:67108864,cpuQuotaMicros:20000,cpuPeriodMicros:100000,pids:16,openFiles:64,wallTimeMs:10000};
 const hostNamespaces=Object.fromEntries(namespaceKeys.map(name=>[name,name+':[1]'])),network=Object.fromEntries(networkKeys.map(name=>[name,true]));
 const facts={...Object.fromEntries(boundaryKeys.map(name=>[name,true])),namespaces:Object.fromEntries(namespaceKeys.map(name=>[name,name+':[2]']))};
 const controls={'memory.max':'67108864','memory.swap.max':'0','memory.oom.group':'1','pids.max':'16','cpu.max':'20000 100000'};
 const observations=new Map([['/private-group-secret',{group:'/private-group-secret',processes:new Set([4321]),controls}]]);
 return {limits,hostNamespaces,network,facts,observations,result:()=>({stdout:JSON.stringify(network)+'\n'+JSON.stringify(facts)+'\n',error:null,observations})};
}
test('boundary diagnostics preserve every isolation and namespace assertion with fixed sub-check IDs',()=>{
 const good=boundaryFixture(),record:Record<string,unknown>={};assert.deepEqual(assertMediaSandboxBoundary(good.result(),good.hostNamespaces,good.limits,record),{network:good.network,facts:good.facts});assert.equal(record.check,'cgroup_controls');assert.equal(record.qualified,false);assert.equal(record.diagnosticOnly,true);
 for(const key of networkKeys){const f=boundaryFixture(),diagnostic:Record<string,unknown>={};f.network[key]=false;assert.throws(()=>assertMediaSandboxBoundary(f.result(),f.hostNamespaces,f.limits,diagnostic));assert.equal(diagnostic.check,'network_'+key);assert.equal((diagnostic.network as Record<string,unknown>)[key],false);}
 for(const key of boundaryKeys){const f=boundaryFixture(),diagnostic:Record<string,unknown>={};(f.facts as Record<string,unknown>)[key]=false;assert.throws(()=>assertMediaSandboxBoundary(f.result(),f.hostNamespaces,f.limits,diagnostic));assert.equal(diagnostic.check,'fact_'+key);assert.equal((diagnostic.facts as Record<string,unknown>)[key],false);}
 for(const name of namespaceKeys)for(const invalid of [true,false]){const f=boundaryFixture(),diagnostic:Record<string,unknown>={};f.facts.namespaces[name]=invalid?'private-namespace-secret':f.hostNamespaces[name];assert.throws(()=>assertMediaSandboxBoundary(f.result(),f.hostNamespaces,f.limits,diagnostic));assert.equal(diagnostic.check,(invalid?'namespace_format_':'namespace_isolated_')+name);assert(!JSON.stringify(diagnostic).includes('private-namespace-secret'));}
});
test('boundary diagnostic distinguishes execution, output shape and cgroup failures without accepting them',()=>{
 const f=boundaryFixture();
 for(const [patch,check]of [[{error:new MediaSandboxError('PROCESS_FAILED')},'execution'],[{stdout:'private-not-json'},'output_json'],[{stdout:'{}'},'output_lines'],[{observations:new Map()},'cgroup_presence']] as const){const diagnostic:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxBoundary({...f.result(),...patch},f.hostNamespaces,f.limits,diagnostic));assert.equal(diagnostic.check,check);assert.equal(diagnostic.qualified,false);assert(!JSON.stringify(diagnostic).includes('private-not-json'));}
 for(const key of Object.keys(f.observations.values().next().value!.controls)){const bad=boundaryFixture(),diagnostic:Record<string,unknown>={};(bad.observations.values().next().value!.controls as Record<string,string>)[key]='private-control-secret';assert.throws(()=>assertMediaSandboxBoundary(bad.result(),bad.hostNamespaces,bad.limits,diagnostic));assert.equal(diagnostic.check,'cgroup_controls');assert.equal((diagnostic.controls as Record<string,unknown>[])[0][key],false);assert(!JSON.stringify(diagnostic).includes('private-control-secret'));}
 const extra=boundaryFixture(),diagnostic:Record<string,unknown>={};Object.assign(extra.observations.values().next().value!.controls,{'private-control-key':'private-value'});assert.throws(()=>assertMediaSandboxBoundary(extra.result(),extra.hostNamespaces,extra.limits,diagnostic));assert.equal(diagnostic.check,'cgroup_controls');assert.equal((diagnostic.controls as Record<string,unknown>[])[0].keysMatch,false);assert(!JSON.stringify(diagnostic).includes('private-control'));
});
test('boundary projections exclude raw errors, process identifiers, paths and unexpected output fields',()=>{
 const f=boundaryFixture(),privateText='private-canary-secret';
 Object.assign(f.network,{privateText});Object.assign(f.facts,{privateText});
 const diagnostic:Record<string,unknown>={};assertMediaSandboxBoundary(f.result(),f.hostNamespaces,f.limits,diagnostic);
 assert.doesNotMatch(JSON.stringify(diagnostic),/private-|4321|\[1\]|\[2\]/);
 const unknown=mediaSandboxBoundaryObservation(f.observations,f.limits,Error(privateText));assert.equal(unknown.execution,'failed');assert.equal(unknown.executionCode,'CANARY_ASSERTION_FAILED');assert(!JSON.stringify(unknown).includes(privateText));
 const forged=mediaSandboxBoundaryObservation(f.observations,f.limits,new MediaSandboxError(privateText as never));assert.equal(forged.executionCode,'CANARY_ASSERTION_FAILED');assert(!JSON.stringify(forged).includes(privateText));
 const before=mediaSandboxBoundaryObservation(f.observations,f.limits);assert.equal(before.execution,'not_observed');assert.equal(before.executionCode,null);
 const many=new Map(Array.from({length:300},(_,index)=>[String(index),f.observations.values().next().value!])),bounded=mediaSandboxBoundaryObservation(many,f.limits,null);assert.equal(bounded.observedGroups,256);assert.equal(bounded.controls.length,16);assert.equal(bounded.observationsTruncated,true);assert.equal(bounded.execution,'succeeded');assert.equal(bounded.qualified,false);
});
