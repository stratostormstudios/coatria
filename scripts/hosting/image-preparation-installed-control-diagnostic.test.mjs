import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {collectImagePreparationInstalledControlDiagnostic,createImagePreparationInstalledControlDiagnostic} from './image-preparation-installed-control-diagnostic.mjs';
import {IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES} from './image-preparation-host-control-systemd.mjs';
import {imagePreparationHostHash,imagePreparationHostUnit,imagePreparationHostUnitName} from './image-preparation-host-package.mjs';

function fixture(){
 const serviceId=randomUUID(),projectId=randomUUID(),bundleSha256='a'.repeat(64),release='/var/lib/coatria-image-preparation-releases/'+bundleSha256,bootId=randomUUID(),invocationId='b'.repeat(32);
 const host={version:1,scope:{serviceId,companyId:randomUUID(),projectIds:[projectId],origin:'https://coatria.com',location:'Disposable CI',expiresAt:'2020-01-01T00:00:00.000Z',gateways:[{projectId,origin:'https://imagepreparationci1-4190.proxy.runpod.net'}]},commit:'c'.repeat(40),release,bundleSha256,uid:1234,gid:1235,node:{path:release+'/runtime/node',sha256:'d'.repeat(64)},worker:{path:release+'/worker/runtime.mjs',sha256:'e'.repeat(64)},units:Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:imagePreparationHostUnitName(serviceId,mode),sha256:imagePreparationHostHash(imagePreparationHostUnit(mode,release,bundleSha256,serviceId))}]))};
 const facts={configurationSha256:'f'.repeat(64),qualificationSha256:'1'.repeat(64)};
 const initial=mode=>({LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0',ExecMainPID:'4321',ControlPID:'0',Result:'success',ExecMainCode:'1',ExecMainStatus:'0',ExecMainStartTimestampMonotonic:'1000',ExecMainExitTimestampMonotonic:'2000',InvocationID:invocationId,FragmentPath:'/etc/systemd/system/'+host.units[mode].name,DropInPaths:'',NeedDaemonReload:'no',Transient:'no',UnitFileState:'static',User:'coatria-image-preparation',Group:'coatria-image-preparation',ControlGroup:'',Type:mode==='preflight'?'oneshot':'simple',RemainAfterExit:'no',KillMode:'control-group',Restart:'no',Job:''});
 const states={preflight:initial('preflight'),worker:initial('worker')},journals={preflight:'',worker:''},calls=[],reads=[];
 const stateRaw=mode=>IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES.split(',').map(key=>key+'='+states[mode][key]).join('\n');
 const event=(mode,name='image-preparation-worker-preflight-passed',patch={})=>({_SYSTEMD_UNIT:host.units[mode].name,_SYSTEMD_INVOCATION_ID:invocationId,_BOOT_ID:bootId.replaceAll('-',''),_PID:'4321',_UID:String(host.uid),_GID:String(host.gid),_EXE:host.node.path,_TRANSPORT:'stdout',__MONOTONIC_TIMESTAMP:'1500',MESSAGE:JSON.stringify(name==='image-preparation-worker-stopped'?{event:name,code:'IMAGE_PREPARATION_RUNNER_UNAVAILABLE'}:{event:name,serviceId,sourceCommit:host.commit,...facts,...name==='image-preparation-worker-drained'?{clientsDrained:true,scratchEmpty:true,temporaryEmpty:true,nativeDescendantsEmpty:true,remoteOutcomeResolved:false}:{workClaimed:false,providerCalled:false}}),...patch});
 const deps={runtime:()=>({platform:'linux',arch:'x64',uid:0,ci:'true',candidate:host.commit}),readBootId:async()=>bootId,
  readTrustedFile:async(path,max)=>{reads.push({path,max});if(path.endsWith('/host.json'))return Buffer.from(JSON.stringify(host));const mode=path.endsWith('-preflight.service')?'preflight':'worker';assert.equal(path,'/etc/systemd/system/'+host.units[mode].name);return Buffer.from(imagePreparationHostUnit(mode,release,bundleSha256,serviceId));},
  exec:(program,args,options)=>{calls.push({program,args,options});const mode=args.some(arg=>arg.includes(host.units.preflight.name))?'preflight':'worker';return {status:0,stdout:program==='/usr/bin/systemctl'?stateRaw(mode):journals[mode],stderr:''};}
 };
 return {host,facts,bootId,invocationId,states,stateRaw,journals,calls,reads,deps,event,collect:()=>createImagePreparationInstalledControlDiagnostic(deps)(host,facts)};
}
const serialized=value=>JSON.stringify(value);
function redacted(value,secrets){const output=serialized(value);for(const secret of secrets)assert.equal(output.includes(secret),false,secret);assert(output.length<12000);}

test('constructor is inert; invalid runtime/source/scope/facts cause no reads or commands',async()=>{
 const f=fixture();createImagePreparationInstalledControlDiagnostic(f.deps);assert.deepEqual(f.calls,[]);assert.deepEqual(f.reads,[]);
 for(const patch of [{platform:'win32'},{arch:'arm64'},{uid:1},{ci:'false'},{candidate:'9'.repeat(40)}]){const result=await createImagePreparationInstalledControlDiagnostic({...f.deps,runtime:()=>({...f.deps.runtime(),...patch})})(f.host,f.facts);assert.equal(result.admission,'rejected');}
 for(const change of [h=>{h.scope.origin='https://private.example';},h=>{h.scope.gateways[0].origin='https://private.example';},h=>{h.scope.projectIds.push(randomUUID());},h=>{h.units.worker.name='private.service';},h=>{h.node.path='/private/node';},h=>{h.release+='/../private';}]){const host=structuredClone(f.host);change(host);const result=await createImagePreparationInstalledControlDiagnostic(f.deps)(host,f.facts);assert.equal(result.admission,'rejected');}
 assert.equal((await createImagePreparationInstalledControlDiagnostic(f.deps)(f.host,{...f.facts,configurationSha256:'private'})).admission,'rejected');
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.reads,[]);
 if(process.platform!=='linux'||process.getuid?.()!==0||process.env.CI!=='true')assert.equal((await collectImagePreparationInstalledControlDiagnostic(f.host,f.facts)).admission,'rejected');
});

test('collects exact static unit state and trusted event matches without emitting identity',async()=>{
 const f=fixture();f.journals.preflight=serialized(f.event('preflight'));
 Object.assign(f.states.worker,{ActiveState:'active',SubState:'running',MainPID:'4321',ExecMainExitTimestampMonotonic:'0',ControlGroup:'/system.slice/'+f.host.units.worker.name});f.journals.worker=serialized(f.event('worker','image-preparation-worker-ready'));
 const result=await f.collect();assert.equal(result.admission,'accepted');assert.equal(result.diagnosticOnly,true);assert.equal(result.bootStable,true);
 assert.equal(result.units.preflight.state.contractMatches,true);assert.equal(result.units.preflight.state.exitStatus,0);assert.equal(result.units.preflight.journal.events.preflightPassed.count,1);assert.equal(result.units.preflight.journal.events.preflightPassed.allRequiredFieldsMatch,true);
 assert.equal(result.units.worker.state.phase,'active');assert.equal(result.units.worker.journal.events.ready.allRequiredFieldsMatch,true);assert.equal(result.units.worker.stateStable,true);
 assert.equal(f.calls.length,6);for(const call of f.calls){assert(['/usr/bin/systemctl','/usr/bin/journalctl'].includes(call.program));if(call.program==='/usr/bin/systemctl')assert.equal(call.args[0],'show');else{assert(call.args.includes('--lines=1024'));assert(call.args.includes('--output=json'));assert(call.args.some(arg=>arg.startsWith('--grep=^')));}assert.equal(call.options.shell,false);assert.equal(call.options.timeout,3000);assert.equal(call.options.maxBuffer,call.program==='/usr/bin/systemctl'?16384:1024*1024);assert.deepEqual(call.options.stdio,['ignore','pipe','pipe']);assert.deepEqual(Object.keys(call.options.env).sort(),['LANG','LC_ALL','PATH']);}
 redacted(result,[f.host.scope.serviceId,f.host.scope.companyId,f.host.scope.projectIds[0],f.host.commit,f.host.release,f.host.node.path,f.invocationId,f.bootId,f.facts.configurationSha256,f.facts.qualificationSha256,'4321','1234','1235']);
});

test('forged journal fields and payload extras are projected only as fixed mismatches',async()=>{
 const f=fixture(),secret='PRIVATE_CREDENTIAL_AND_PATH';f.journals.preflight=serialized(f.event('preflight',undefined,{_PID:secret,_UID:secret,_GID:secret,_EXE:secret,_TRANSPORT:secret,_SYSTEMD_UNIT:secret,_BOOT_ID:secret,_SYSTEMD_INVOCATION_ID:secret,__MONOTONIC_TIMESTAMP:secret,MESSAGE:serialized({...JSON.parse(f.event('preflight').MESSAGE),private:secret}),ENV:secret,_CMDLINE:secret}));
 const result=await f.collect(),event=result.units.preflight.journal.events.preflightPassed;assert.equal(event.count,1);assert.equal(event.allRequiredFieldsMatch,false);for(const key of ['unit','boot','pid','uid','gid','executable','transport','invocation','invocationFormat','monotonicStart','payload'])assert(event.mismatchedFields.includes(key));redacted(result,[secret]);
});

test('missing and unavailable trusted fields remain distinct, including cleared oneshot InvocationID',async()=>{
 const f=fixture();f.states.preflight.InvocationID='';const row=f.event('preflight');delete row._UID;delete row._BOOT_ID;delete row.__MONOTONIC_TIMESTAMP;f.journals.preflight=serialized(row);
 const result=await f.collect(),event=result.units.preflight.journal.events.preflightPassed;assert.equal(result.units.preflight.state.contractMatches,true);assert.equal(result.units.preflight.state.invocationPresent,false);assert.deepEqual(event.unavailableFields,['invocation']);assert.deepEqual(event.missingFields,['boot','uid','monotonicStart']);assert.equal(event.allRequiredFieldsMatch,false);
});

test('preserves fixed exit/phase diagnostics when production state parser rejects metadata',async()=>{
 const f=fixture();Object.assign(f.states.preflight,{ActiveState:'failed',SubState:'failed',Result:'exit-code',ExecMainStatus:'1',DropInPaths:'/private/override',User:'private-user'});f.journals.preflight=serialized(f.event('preflight','image-preparation-worker-stopped'));
 const result=await f.collect();assert.equal(result.units.preflight.state.contractMatches,false);assert.equal(result.units.preflight.state.phase,'failed');assert.equal(result.units.preflight.state.result,'exit-code');assert.equal(result.units.preflight.state.exitStatus,1);assert.equal(result.units.preflight.journal.events.stopped.count,1);assert.equal(result.units.preflight.journal.events.stopped.allRequiredFieldsMatch,true);redacted(result,['/private/override','private-user']);
});

test('unknown state values and arbitrary stopped codes never escape the fixed projection',async()=>{
 const f=fixture(),secret='private-error-with-secret';Object.assign(f.states.preflight,{ActiveState:secret,SubState:secret,Result:secret,ExecMainCode:secret,ExecMainStatus:'99999',Job:secret});f.journals.preflight=serialized(f.event('preflight','image-preparation-worker-stopped',{MESSAGE:serialized({event:'image-preparation-worker-stopped',code:secret})}));
 const result=await f.collect(),state=result.units.preflight.state;assert.equal(state.phase,'unknown');assert.equal(state.result,'unknown');assert.equal(state.exitStatus,null);assert.equal(state.jobPresent,true);assert(result.units.preflight.journal.events.stopped.mismatchedFields.includes('payload'));redacted(result,[secret]);
});

test('wrong trusted host or unit bytes prevent commands for that identity',async()=>{
 const f=fixture();const collect=createImagePreparationInstalledControlDiagnostic({...f.deps,readTrustedFile:async()=>Buffer.from('{}')});const result=await collect(f.host,f.facts);assert.equal(result.failure,'trusted-host-unavailable');assert.deepEqual(f.calls,[]);
 const g=fixture();const original=g.deps.readTrustedFile;g.deps.readTrustedFile=async(path,max)=>path.endsWith('/host.json')?original(path,max):Buffer.from('private replacement');const units=await g.collect();assert.equal(units.units.preflight.failure,'trusted-unit-unavailable');assert.equal(units.units.worker.failure,'trusted-unit-unavailable');assert.deepEqual(g.calls,[]);redacted(units,['private replacement']);
});

test('command throws, failed exits and overflows are fixed unknowns without raw failure output',async()=>{
 for(const response of [()=>{throw Error('private exception');},()=>({status:1,stdout:'private stdout',stderr:'private stderr'}),()=>({status:0,stdout:'x'.repeat(1024*1024+1),stderr:''}),()=>({status:null,stdout:'private stdout',stderr:'',error:{code:'private errno'},signal:'private signal'})]){const f=fixture();f.deps.exec=response;const result=await f.collect();assert.equal(result.units.preflight.state.status,'unknown');assert.equal(result.units.preflight.journal.failure,'journal-command-unknown');assert.equal(result.units.preflight.stateStable,null);redacted(result,['private','xxx']);}
 const f=fixture(),original=f.deps.exec;f.deps.exec=(program,args,options)=>program==='/usr/bin/journalctl'?{status:1,stdout:'',stderr:''}:original(program,args,options);const result=await f.collect();assert.equal(result.units.preflight.journal.status,'collected');assert.equal(result.units.preflight.journal.rows,0);assert.equal(result.units.preflight.journal.events.preflightPassed.allRequiredFieldsMatch,null);
});

test('journal line and byte bounds are enforced; invalid and ignored rows cannot assert a match',async()=>{
 const f=fixture();f.journals.preflight='{}\n'.repeat(1025);let result=await f.collect();assert.equal(result.units.preflight.journal.failure,'journal-bound');
 f.journals.preflight=['not-json','[]',serialized({MESSAGE:'not-json'}),serialized({MESSAGE:serialized({event:'private',secret:'private'})}),serialized(f.event('preflight')),serialized(f.event('preflight'))].join('\n');result=await f.collect();assert.equal(result.units.preflight.journal.malformedRows,2);assert.equal(result.units.preflight.journal.ignoredRows,2);assert.equal(result.units.preflight.journal.events.preflightPassed.count,2);redacted(result,['private']);
});

test('reports changed unit state and boot without repeating a read or claiming acceptance',async()=>{
 const f=fixture(),original=f.deps.exec;let shows=0,boots=0;f.deps.exec=(program,args,options)=>{const response=original(program,args,options);if(program==='/usr/bin/systemctl'&&++shows===2)response.stdout=response.stdout.replace('ExecMainStatus=0','ExecMainStatus=1');return response;};f.deps.readBootId=async()=>++boots===1?f.bootId:randomUUID();const result=await f.collect();assert.equal(result.units.preflight.stateStable,false);assert.equal(result.bootStable,false);assert.equal(f.calls.length,6);assert.equal(result.diagnosticOnly,true);assert.equal(Object.hasOwn(result,'passed'),false);assert.equal(Object.hasOwn(result,'cleanupConfirmed'),false);
});

test('hostile nested journal payload and invalid later boot fail as fixed unknowns',async()=>{
 const f=fixture();const deep='{"event":"image-preparation-worker-preflight-passed","private":'+'['.repeat(15000)+'0'+']'.repeat(15000)+'}';f.journals.preflight=serialized(f.event('preflight',undefined,{MESSAGE:deep}));f.journals.worker=serialized({MESSAGE:serialized({event:{toString:'private'}})});let boots=0;f.deps.readBootId=async()=>++boots===1?f.bootId:'private invalid boot';const result=await f.collect();assert.equal(result.units.preflight.journal.failure,'journal-parse-unknown');assert.equal(result.units.worker.journal.ignoredRows,1);assert.equal(result.failure,'boot-observation-unknown');assert.equal(result.bootStable,null);redacted(result,['private']);
});
