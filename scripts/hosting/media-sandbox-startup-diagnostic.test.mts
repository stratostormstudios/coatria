import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySyntheticStartupStderr,diagnoseMediaSandboxStartup,diagnoseArchiveHostSandboxStartup,archiveStartupIdentity} from './media-sandbox-startup-diagnostic.mts';
import {assertMediaSandboxBoundary,mediaSandboxBoundaryObservation,assertMediaSandboxFileDescriptorCap,assertMediaSandboxOrphanCleanup,mediaSandboxOrphanObservation,assertMediaSandboxLabelParser,mediaSandboxLabelObservation,mediaSandboxLabelFailure,withMediaSandboxInputLifetime} from './media-sandbox-linux-canary.mts';
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

test('file descriptor diagnostics preserve execution, parsing and both exact limit assertions',()=>{
 const good={stdout:JSON.stringify({openFiles:61,limited:true}),error:null},limits={openFiles:64},record:Record<string,unknown>={};
 assert.deepEqual(assertMediaSandboxFileDescriptorCap(good,limits,record),{openFiles:61,limited:true});assert.equal(record.check,'open_files');assert.equal(record.qualified,false);assert.equal(record.diagnosticOnly,true);assert.equal(record.approvedOpenFiles,64);
 for(const [patch,check]of [[{error:new MediaSandboxError('PROCESS_FAILED')},'execution'],[{stdout:'private-not-json'},'output_json'],[{stdout:JSON.stringify({openFiles:61,limited:false})},'limited'],[{stdout:JSON.stringify({openFiles:64,limited:true})},'open_files'],[{stdout:JSON.stringify({openFiles:65,limited:true})},'open_files']] as const){
  const diagnostic:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxFileDescriptorCap({...good,...patch},limits,diagnostic));assert.equal(diagnostic.check,check);assert.equal(diagnostic.qualified,false);assert(!JSON.stringify(diagnostic).includes('private-not-json'));
 }
});

test('file descriptor failure diagnostics exclude raw output, error text and unexpected fields',()=>{
 const secret='private-path-env-credential';
 for(const error of [Error(secret),new MediaSandboxError(secret as never)]){const diagnostic:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxFileDescriptorCap({stdout:secret,error},{openFiles:64},diagnostic));assert.equal(diagnostic.executionCode,'CANARY_ASSERTION_FAILED');assert(!JSON.stringify(diagnostic).includes(secret));}
 for(const facts of [{limited:true,openFiles:secret,privateField:secret},{limited:secret,openFiles:61,privateField:secret},{limited:true,openFiles:2048,privateField:secret},{limited:true,openFiles:1e100,privateField:secret}]){
  const diagnostic:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxFileDescriptorCap({stdout:JSON.stringify(facts),error:null},{openFiles:64},diagnostic));assert.equal(diagnostic.openFiles,typeof facts.openFiles==='number'&&facts.openFiles<=1024?facts.openFiles:null);assert(!JSON.stringify(diagnostic).includes(secret));assert(!JSON.stringify(diagnostic).includes('privateField'));
 }
 const diagnostic:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxFileDescriptorCap({stdout:'x'.repeat(65537),error:null},{openFiles:64},diagnostic));assert.equal(diagnostic.stdoutBytes,65536);assert.equal(diagnostic.stdoutTruncated,true);assert.equal(diagnostic.check,'output_json');
});

test('orphan checkpoints preserve execution, fork, exact controls and observed-descendant assertions',()=>{
 const fixture=()=>{const f=boundaryFixture();f.observations.values().next().value!.processes=new Set([4301,4302,4303,4304,4305]);return {...f,orphan:{stdout:'{"forked":3,"limited":false}',error:null as unknown,observations:f.observations}};};
 const good=fixture(),passed:Record<string,unknown>={};assertMediaSandboxOrphanCleanup(good.orphan,good.limits,passed);assert.equal(passed.check,'descendants_observed');assert.equal(passed.maximumObservedProcesses,5);assert.equal(passed.forked,3);assert.equal(passed.qualified,false);
 for(const [patch,check]of [[{error:new MediaSandboxError('CLEANUP_FAILED')},'execution'],[{stdout:'private-not-json'},'output_json'],[{stdout:'{"forked":2}'},'fork_count'],[{observations:new Map()},'cgroup_controls']] as const){
  const f=fixture(),diagnostic:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxOrphanCleanup({...f.orphan,...patch},f.limits,diagnostic));assert.equal(diagnostic.check,check);assert.equal(diagnostic.qualified,false);assert(!JSON.stringify(diagnostic).includes('private-not-json'));
 }
 for(const key of Object.keys(good.observations.values().next().value!.controls)){const f=fixture(),diagnostic:Record<string,unknown>={};(f.observations.values().next().value!.controls as Record<string,string>)[key]='private-control-secret';assert.throws(()=>assertMediaSandboxOrphanCleanup(f.orphan,f.limits,diagnostic));assert.equal(diagnostic.check,'cgroup_controls');assert(!JSON.stringify(diagnostic).includes('private-control-secret'));}
 const missing=fixture(),record:Record<string,unknown>={};missing.observations.values().next().value!.processes=new Set([4301,4302,4303,4304]);assert.throws(()=>assertMediaSandboxOrphanCleanup(missing.orphan,missing.limits,record));assert.equal(record.check,'descendants_observed');assert.equal(record.maximumObservedProcesses,4);
 const failed:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxOrphanCleanup({...good.orphan,error:new MediaSandboxError('CLEANUP_FAILED')},good.limits,failed));assert.equal(failed.executionCode,'CLEANUP_FAILED');
});

test('orphan diagnostics retain bounded counts and no output, paths, PIDs or unknown error text',()=>{
 const f=boundaryFixture(),secret='private-credential-path';
 for(const error of [Error(secret),new MediaSandboxError(secret as never)]){const record:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxOrphanCleanup({stdout:secret,error,observations:f.observations},f.limits,record));assert.equal(record.executionCode,'CANARY_ASSERTION_FAILED');assert.doesNotMatch(JSON.stringify(record),/private-|4321/);}
 const map=new Map([['private-group',{group:'private-group',processes:new Set(Array.from({length:300},(_,i)=>4000+i)),controls:f.observations.values().next().value!.controls}]]),bounded=mediaSandboxOrphanObservation(map,f.limits,null);assert.equal(bounded.maximumObservedProcesses,256);assert.equal(bounded.execution,'succeeded');assert.doesNotMatch(JSON.stringify(bounded),/private-|4000/);
 const record:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxOrphanCleanup({stdout:JSON.stringify({forked:secret,secret}),error:null,observations:f.observations},f.limits,record));assert.equal(record.forked,null);assert(!JSON.stringify(record).includes(secret));
});

test('label parser diagnostic preserves successful execution and exact trimmed output requirements',()=>{
 for(const stdout of ['label parser ok\n',' \r\nlabel parser ok\r\n']){const record:Record<string,unknown>={};assertMediaSandboxLabelParser({stdout,error:null},record);assert.equal(record.check,'output_match');assert.equal(record.execution,'succeeded');assert.equal(record.exactExpectedOutput,true);assert.equal(record.stdoutBytes,Buffer.byteLength(stdout));assert.equal(record.qualified,false);assert.equal(record.diagnosticOnly,true);}
 const failed:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxLabelParser({stdout:'label parser ok',error:new MediaSandboxError('PROCESS_FAILED')},failed));assert.equal(failed.check,'execution');assert.equal(failed.executionCode,'PROCESS_FAILED');assert.equal(failed.exactExpectedOutput,true);
 for(const stdout of ['', 'label parser ok\nprivate-output-canary', 'private-output-canary']){const record:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxLabelParser({stdout,error:null},record));assert.equal(record.check,'output_match');assert.equal(record.exactExpectedOutput,false);assert.equal(record.execution,'succeeded');assert(!JSON.stringify(record).includes('private-output-canary'));}
});

test('label diagnostics distinguish fixed observation phases and retain only bounded output metadata',()=>{
 for(const check of ['input_open','process_start','cgroup_observation','process_drain'])assert.deepEqual(mediaSandboxLabelObservation(check),{diagnosticOnly:true,qualified:false,check,execution:'not_observed',executionCode:null});
 assert.equal(mediaSandboxLabelObservation('private-stage-path').check,null);
 assert.equal(mediaSandboxLabelObservation('process_drain',null).execution,'succeeded');assert.equal(mediaSandboxLabelObservation('process_drain',new MediaSandboxError('CLEANUP_FAILED')).executionCode,'CLEANUP_FAILED');
 const record:Record<string,unknown>={};assert.throws(()=>assertMediaSandboxLabelParser({stdout:'x'.repeat(65537)+'private-secret',error:null},record));assert.equal(record.stdoutBytes,65536);assert.equal(record.stdoutTruncated,true);assert.equal(record.exactExpectedOutput,false);assert(!JSON.stringify(record).includes('private-secret'));
});

test('label failure classification excludes raw messages, paths, PIDs, output and unknown error codes',()=>{
 const secret='/private/credential-canary pid=4321 stdout=secret';
 const filesystem=Object.assign(Error(secret),{code:'ENODEV',path:secret,syscall:secret});assert.deepEqual(mediaSandboxLabelFailure(filesystem),{errorCategory:'filesystem',errorCode:'ENODEV'});
 for(const errorCode of ['ENOENT','EIO','EACCES','EPERM','ESRCH','EMFILE','ENFILE','ENOMEM','EBUSY','ENOTDIR','EISDIR','EROFS','EINVAL'])assert.deepEqual(mediaSandboxLabelFailure(Object.assign(Error(secret),{code:errorCode})),{errorCategory:'filesystem',errorCode});
 assert.deepEqual(mediaSandboxLabelFailure(Object.assign(Error(secret),{code:'ERR_ASSERTION'})),{errorCategory:'assertion',errorCode:'ERR_ASSERTION'});
 assert.deepEqual(mediaSandboxLabelFailure(new MediaSandboxError('PROCESS_FAILED')),{errorCategory:'sandbox',errorCode:'PROCESS_FAILED'});
 const inaccessible=Object.defineProperty({},'code',{get(){throw Error(secret);}}),trappedDescriptor=new Proxy({},{getOwnPropertyDescriptor(){throw Error(secret);}}),trappedPrototype=new Proxy({},{getPrototypeOf(){throw Error(secret);}});
 for(const error of [Error(secret),Object.assign(Error(secret),{code:secret}),new MediaSandboxError(secret as never),secret,null,undefined,inaccessible,trappedDescriptor,trappedPrototype]){const failure=mediaSandboxLabelFailure(error);assert.deepEqual(failure,{errorCategory:'unknown',errorCode:'UNKNOWN'});assert.doesNotMatch(JSON.stringify(failure),/private|credential|4321|stdout|secret/);}
 const record:Record<string,unknown>={};let original:unknown;try{assertMediaSandboxLabelParser({stdout:secret,error:null},record);}catch(error){original=error;Object.assign(record,mediaSandboxLabelFailure(error));}assert(original instanceof assert.AssertionError);assert.equal(record.check,'output_match');assert.equal(record.errorCategory,'assertion');assert.doesNotMatch(JSON.stringify(record),/private|credential|4321|stdout=|secret/);
});

function deferred<Value>(){let resolve!:(value:Value)=>void;return {promise:new Promise<Value>(done=>{resolve=done;}),resolve:(value:Value)=>resolve(value)};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('observer failure retains its input until sandbox settlement and preserves the original exception',async()=>{
 for(const sandboxError of [null,new MediaSandboxError('PROCESS_FAILED'),new MediaSandboxError('CLEANUP_FAILED')]){
  const pending=deferred<{stdout:string;error:MediaSandboxError|null}>(),events:string[]=[],observerError=Object.assign(Error('Synthetic observer failure'),{code:'ENODEV'});let returned=false,closes=0;
  const outcome=pending.promise.then(value=>{events.push('sandbox_settled');return value;});
  const result=withMediaSandboxInputLifetime(()=>{events.push('started');return outcome;},async()=>{events.push('observer_failed');throw observerError;},async()=>{closes++;events.push('input_closed');});
  const checked=assert.rejects(result,error=>{returned=true;assert.strictEqual(error,observerError);return true;});await turn();assert.equal(closes,0);assert.equal(returned,false);assert.deepEqual(events,['started','observer_failed']);
  pending.resolve({stdout:'',error:sandboxError});await checked;assert.equal(closes,1);assert.deepEqual(events,['started','observer_failed','sandbox_settled','input_closed']);
 }
});
test('normal observed success and captured sandbox failure retain their exact outcomes and close once',async()=>{
 for(const error of [null,new MediaSandboxError('TIMEOUT')]){
  const pending=deferred<{stdout:string;error:MediaSandboxError|null}>(),expected={stdout:error?'':'label parser ok\n',error};let closes=0;
  const result=withMediaSandboxInputLifetime(()=>pending.promise,async outcome=>await outcome,async()=>{closes++;});await turn();assert.equal(closes,0);pending.resolve(expected);assert.strictEqual(await result,expected);assert.equal(closes,1);
 }
});
test('lifetime helper closes input after synchronous start failure and preserves existing close errors',async()=>{
 const startError=Error('Synthetic startup failure');let closes=0;
 await assert.rejects(withMediaSandboxInputLifetime(()=>{throw startError;},async()=>assert.fail('Observer must not run'),async()=>{closes++;}),error=>error===startError);assert.equal(closes,1);
 const closeError=Error('Synthetic close failure');await assert.rejects(withMediaSandboxInputLifetime(async()=>({stdout:'ok',error:null}),async outcome=>await outcome,async()=>{throw closeError;}),error=>error===closeError);
});
