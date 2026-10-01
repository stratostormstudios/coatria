import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES,createImagePreparationHostSystemdControl,imagePreparationControlJournalProof,parseImagePreparationControlState} from '../scripts/hosting/image-preparation-host-control-systemd.mjs';
import {imagePreparationHostHash,imagePreparationHostUnit,imagePreparationHostUnitName} from '../scripts/hosting/image-preparation-host-package.mjs';

type Mode='preflight'|'worker';
type State=Record<string,string>;
const fixed=/^IMAGE_PREPARATION_HOST_SYSTEMD_(?:REJECTED|COMMAND_UNKNOWN|OBSERVATION_CHANGED)$/;
const rejected=(error:unknown)=>error instanceof Error&&fixed.test(error.message)&&!error.message.includes('private');
function fixture(){
 const serviceId=randomUUID(),bundleSha256='a'.repeat(64),release='/var/lib/coatria-image-preparation-releases/'+bundleSha256,bootId=randomUUID(),invocationId='b'.repeat(32);
 const host={version:1,scope:{serviceId,companyId:randomUUID(),projectIds:[randomUUID()],expiresAt:'2020-01-01T00:00:00.000Z'},release,bundleSha256,commit:'c'.repeat(40),uid:1234,gid:1235,node:{path:release+'/runtime/node'},worker:{path:release+'/worker/runtime.mjs'},units:Object.fromEntries((['preflight','worker'] as const).map(mode=>[mode,{name:imagePreparationHostUnitName(serviceId,mode),sha256:imagePreparationHostHash(imagePreparationHostUnit(mode,release,bundleSha256,serviceId))}]))};
 const hostBytes=Buffer.from(JSON.stringify(host)),identity={host,bootId,hostConfigurationSha256:imagePreparationHostHash(hostBytes),configurationSha256:'d'.repeat(64),qualificationSha256:'e'.repeat(64)};
 const initial=(mode:Mode):State=>({LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0',ExecMainPID:'0',ControlPID:'0',Result:'success',ExecMainCode:'0',ExecMainStatus:'0',ExecMainStartTimestampMonotonic:'0',ExecMainExitTimestampMonotonic:'0',InvocationID:'',FragmentPath:'/etc/systemd/system/'+host.units[mode].name,DropInPaths:'',NeedDaemonReload:'no',Transient:'no',UnitFileState:'static',User:'coatria-image-preparation',Group:'coatria-image-preparation',ControlGroup:'',Type:mode==='worker'?'simple':'oneshot',RemainAfterExit:'no',KillMode:'control-group',Restart:'no',Job:''});
 const states:Record<Mode,State>={preflight:initial('preflight'),worker:initial('worker')},journals:Record<Mode,string>={preflight:'',worker:''},calls:{program:string,args:string[],options:Record<string,unknown>}[]=[];
 const raw=(s:State)=>IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES.split(',').map(k=>k+'='+s[k]).join('\n');
 const common={serviceId,sourceCommit:host.commit,configurationSha256:identity.configurationSha256,qualificationSha256:identity.qualificationSha256};
 const record=(mode:Mode,event:string,patch:Record<string,unknown>={})=>({_SYSTEMD_UNIT:host.units[mode].name,_SYSTEMD_INVOCATION_ID:invocationId,_BOOT_ID:bootId.replaceAll('-',''),_PID:'4321',_UID:String(host.uid),_GID:String(host.gid),_EXE:host.node.path,_TRANSPORT:'stdout',__MONOTONIC_TIMESTAMP:event==='image-preparation-worker-drained'?'1900':'1500',MESSAGE:JSON.stringify({event,...common,...event==='image-preparation-worker-drained'?{clientsDrained:true,scratchEmpty:true,temporaryEmpty:true,nativeDescendantsEmpty:true,remoteOutcomeResolved:false}:{workClaimed:false,providerCalled:false}}),...patch});
 const setRunning=()=>{Object.assign(states.worker,{ActiveState:'active',SubState:'running',MainPID:'4321',ExecMainPID:'4321',ExecMainStartTimestampMonotonic:'1000',InvocationID:invocationId,ControlGroup:'/system.slice/'+host.units.worker.name});};
 const setStopped=(mode:Mode)=>{Object.assign(states[mode],{ActiveState:'inactive',SubState:'dead',MainPID:'0',ExecMainPID:'4321',ExecMainCode:'1',ExecMainStartTimestampMonotonic:'1000',ExecMainExitTimestampMonotonic:'2000',InvocationID:'',ControlGroup:''});};
 let empty=true,currentBoot:string=bootId,corruptUnit=false,corruptHost=false,commandFailure=false,showCount=0,onShow:((mode:Mode,count:number)=>void)|undefined,onStart:((mode:Mode)=>void)|undefined,onStop:(()=>void)|undefined;
 const deps={
  exec:(program:string,args:string[],options:Record<string,unknown>)=>{
   calls.push({program,args:[...args],options});const mode:Mode=args.some(arg=>arg.includes(host.units.preflight.name))?'preflight':'worker';
   if(program==='/usr/bin/journalctl')return {status:0,stdout:journals[mode]};
   if(args[0]==='show'){onShow?.(mode,++showCount);return {status:0,stdout:raw(states[mode])};}
   if(commandFailure)return {status:null,stdout:'private-credential',stderr:'private-credential',error:new Error('private-credential')};
   if(args[0]==='start'){if(onStart)onStart(mode);else if(mode==='worker'){setRunning();empty=false;}else{setStopped(mode);journals.preflight=JSON.stringify(record(mode,'image-preparation-worker-preflight-passed'));}}
   if(args[0]==='stop'){if(onStop)onStop();else{setStopped('worker');empty=true;journals.worker+='\n'+JSON.stringify(record('worker','image-preparation-worker-drained'));}}
   return {status:0,stdout:''};
  },
  readTrustedFile:async(path:string)=>path.endsWith('/host.json')?corruptHost?Buffer.from('{}'):hostBytes:Buffer.from(imagePreparationHostUnit(path.includes('-preflight.service')?'preflight':'worker',release,bundleSha256,serviceId)+(corruptUnit?'# drift':'')),
  readBootId:async()=>currentBoot,
  inspectCgroup:async()=>empty
 };
 const control=createImagePreparationHostSystemdControl(identity,deps);
 return {host,identity,bootId,invocationId,states,journals,calls,raw,record,setRunning,setStopped,control,deps,setEmpty:(v:boolean)=>{empty=v;},setBoot:(v:string)=>{currentBoot=v;},tamperUnit:()=>{corruptUnit=true;},tamperHost:()=>{corruptHost=true;},failCommand:()=>{commandFailure=true;},onShow:(v:typeof onShow)=>{onShow=v;},onStart:(v:typeof onStart)=>{onStart=v;},onStop:(v:typeof onStop)=>{onStop=v;}};
}

test('never-started inactive baseline is observable but neither ready nor cleanup-confirmed; expired scope remains observable',async()=>{
 const f=fixture(),result=await f.control.observe('worker');
 assert.deepEqual(result,{mode:'worker',unit:f.host.units.worker.name,bootId:f.bootId,activeState:'inactive',subState:'dead',invocationId:null,pid:0,result:null,runningReady:false,preflightPassed:false,processStopped:true,cgroupEmpty:true,cleanupConfirmed:false});
 assert.equal(f.calls.filter(c=>c.args[0]==='start'||c.args[0]==='stop').length,0);
});
test('separate inactive oneshot proof binds finished main PID and cleared InvocationID',async()=>{
 const f=fixture(),result=await f.control.preflight();assert.equal(result.preflightPassed,true);assert.equal(result.processStopped,true);assert.equal(result.pid,0);assert.equal(result.cleanupConfirmed,true);assert.equal(result.invocationId,f.invocationId);assert.equal(result.result,'success');assert.equal(result.runningReady,false);
 assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);await assert.rejects(f.control.preflight(),rejected);assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);
 const patches:State[]=[{ActiveState:'active',SubState:'exited'},{RemainAfterExit:'yes'},{MainPID:'4321'}];for(const patch of patches)assert.throws(()=>parseImagePreparationControlState(f.raw({...f.states.preflight,...patch}),f.host,'preflight'),rejected);
});
test('systemctl start acceptance alone is not readiness and no polling delays invocation persistence',async()=>{
 const f=fixture(),result=await f.control.startWorker();assert.equal(result.invocationId,f.invocationId);assert.equal(result.runningReady,false);assert.equal(result.processStopped,false);assert.equal(result.cleanupConfirmed,false);
 const before=f.calls.length;f.journals.worker=JSON.stringify(f.record('worker','image-preparation-worker-ready'));assert.equal((await f.control.observe('worker',f.invocationId)).runningReady,true);assert.equal(f.calls.length-before,3);
 const journalCall=f.calls.find(c=>c.program==='/usr/bin/journalctl')!;assert(journalCall.args.includes('--grep=^\\{"event":"image-preparation-worker-(ready|drained)"'));assert(journalCall.args.includes('--lines=1024'));
 const filter=new RegExp(journalCall.args.find(arg=>arg.startsWith('--grep='))!.slice(7));assert(filter.test(f.record('worker','image-preparation-worker-ready').MESSAGE));assert(filter.test(f.record('worker','image-preparation-worker-drained').MESSAGE));for(let i=0;i<1800;i++)assert.equal(filter.test(JSON.stringify({event:'image-preparation-worker-attempt',preparationId:randomUUID(),status:'ready'})),false);
 await assert.rejects(f.control.startWorker(),rejected);assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);
});
test('same invocation stop requires exact drained record plus independent empty cgroup; historical expiry does not prevent stop',async()=>{
 const f=fixture();f.setRunning();f.setEmpty(false);f.journals.worker=JSON.stringify(f.record('worker','image-preparation-worker-ready'));
 const result=await f.control.stopWorker(f.invocationId);assert.equal(result.runningReady,false);assert.equal(result.processStopped,true);assert.equal(result.cgroupEmpty,true);assert.equal(result.cleanupConfirmed,true);assert.equal(result.invocationId,f.invocationId);
 assert.equal(f.calls.filter(c=>c.args[0]==='stop').length,1);assert.equal((await f.control.stopWorker(f.invocationId)).cleanupConfirmed,true);assert.equal(f.calls.filter(c=>c.args[0]==='stop').length,1);
});
test('journalctl grep status 1 with empty output means missing proof, not failed start or readiness',async()=>{
 const f=fixture(),exec=f.deps.exec,control=createImagePreparationHostSystemdControl(f.identity,{...f.deps,exec:(program:string,args:string[],options:Record<string,unknown>)=>program==='/usr/bin/journalctl'?{status:1,stdout:'',stderr:''}:exec(program,args,options)});
 const result=await control.startWorker();assert.equal(result.invocationId,f.invocationId);assert.equal(result.runningReady,false);assert.equal(result.cleanupConfirmed,false);assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);
 for(const patch of [{stdout:'private-output',stderr:''},{stdout:'',stderr:'private-error'}]){const rejectedControl=createImagePreparationHostSystemdControl(f.identity,{...f.deps,exec:(program:string,args:string[],options:Record<string,unknown>)=>program==='/usr/bin/journalctl'?{status:1,...patch}:exec(program,args,options)});await assert.rejects(rejectedControl.observe('worker'),rejected);}
});
test('process exit alone, forced exit or retained descendants cannot certify cleanup',async()=>{
 for(const mode of ['missing','populated','failed'] as const){const f=fixture();f.setStopped('worker');f.journals.worker=JSON.stringify(f.record('worker','image-preparation-worker-ready'));
  if(mode==='populated'){f.journals.worker+='\n'+JSON.stringify(f.record('worker','image-preparation-worker-drained'));f.setEmpty(false);}
  if(mode==='failed')Object.assign(f.states.worker,{ActiveState:'failed',SubState:'failed',Result:'signal',ExecMainCode:'2',ExecMainStatus:'9'});
  const result=await f.control.observe('worker',f.invocationId);assert.equal(result.processStopped,true);assert.equal(result.cleanupConfirmed,false);assert.equal(result.result,mode==='failed'?'failure':'success');
 }
 const f=fixture();f.setRunning();f.journals.worker=JSON.stringify(f.record('worker','image-preparation-worker-drained'));const result=await f.control.observe('worker');assert.equal(result.cleanupConfirmed,false);assert.equal(result.runningReady,false);
});
test('all trusted journal identity fields, exact safe payload and duplicate proof are enforced',()=>{
 const f=fixture();f.setRunning();const record=f.record('worker','image-preparation-worker-ready');
 assert.equal(imagePreparationControlJournalProof(JSON.stringify(record),f.identity,'worker',f.states.worker).ready,true);
 for(const patch of [{_SYSTEMD_INVOCATION_ID:'f'.repeat(32)},{_PID:'999'},{_UID:'0'},{_GID:'0'},{_BOOT_ID:randomUUID().replaceAll('-','')},{_EXE:'/usr/bin/node'},{_SYSTEMD_UNIT:f.host.units.preflight.name},{_TRANSPORT:'journal'},{__MONOTONIC_TIMESTAMP:'NaN'},{MESSAGE:JSON.stringify({...JSON.parse(record.MESSAGE),workClaimed:true})},{MESSAGE:JSON.stringify({...JSON.parse(record.MESSAGE),private:'credential'})}])assert.throws(()=>imagePreparationControlJournalProof(JSON.stringify({...record,...patch}),f.identity,'worker',f.states.worker),rejected);
 assert.throws(()=>imagePreparationControlJournalProof(JSON.stringify(record)+'\n'+JSON.stringify(record),f.identity,'worker',f.states.worker),rejected);
 assert.throws(()=>imagePreparationControlJournalProof('x'.repeat(1024*1024+1),f.identity,'worker',f.states.worker),rejected);
 assert.throws(()=>imagePreparationControlJournalProof('not-json',f.identity,'worker',f.states.worker),rejected);
});
test('last-run monotonic identity excludes old proof and ambiguity after inactive InvocationID clears',()=>{
 const f=fixture();f.setStopped('worker');const record=f.record('worker','image-preparation-worker-ready');
 assert.equal(imagePreparationControlJournalProof(JSON.stringify({...record,__MONOTONIC_TIMESTAMP:'999'}),f.identity,'worker',f.states.worker).invocationId,null);
 assert.throws(()=>imagePreparationControlJournalProof(JSON.stringify(record)+'\n'+JSON.stringify(f.record('worker','image-preparation-worker-drained',{_SYSTEMD_INVOCATION_ID:'f'.repeat(32)})),f.identity,'worker',f.states.worker),rejected);
 assert.throws(()=>imagePreparationControlJournalProof('',f.identity,'worker',f.states.worker,f.invocationId),rejected);
});
test('wrong boot, changed host/unit bytes and loaded drop-ins deny actions before command',async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>f.setBoot(randomUUID()),(f:ReturnType<typeof fixture>)=>f.tamperUnit(),(f:ReturnType<typeof fixture>)=>f.tamperHost(),(f:ReturnType<typeof fixture>)=>{f.states.worker.DropInPaths='/run/systemd/system/override.conf';},(f:ReturnType<typeof fixture>)=>{f.states.worker.NeedDaemonReload='yes';},(f:ReturnType<typeof fixture>)=>{f.states.worker.UnitFileState='enabled';}]){const f=fixture();change(f);await assert.rejects(f.control.startWorker(),rejected);assert.equal(f.calls.filter(c=>c.args[0]==='start').length,0);}
});
test('different and changed current invocation cannot be stopped, including race after initial observation',async()=>{
 for(const race of [false,true]){const f=fixture();f.setRunning();f.journals.worker=JSON.stringify(f.record('worker','image-preparation-worker-ready'));
  if(race)f.onShow((_mode,count)=>{if(count===3)f.states.worker.InvocationID='f'.repeat(32);});
  await assert.rejects(f.control.stopWorker(race?f.invocationId:'f'.repeat(32)),rejected);assert.equal(f.calls.filter(c=>c.args[0]==='stop').length,0);
 }
});
test('identity changes during journal/cgroup observation are explicit uncertainty, never stale success',async()=>{
 const f=fixture();f.setRunning();f.journals.worker=JSON.stringify(f.record('worker','image-preparation-worker-ready'));f.onShow((_mode,count)=>{if(count===2)f.states.worker.InvocationID='f'.repeat(32);});
 await assert.rejects(f.control.observe('worker'),error=>error instanceof Error&&error.message==='IMAGE_PREPARATION_HOST_SYSTEMD_OBSERVATION_CHANGED');
});
test('all commands are fixed, bounded and credential-free; failed start is never retried or reflected',async()=>{
 const f=fixture();f.failCommand();await assert.rejects(f.control.startWorker(),error=>error instanceof Error&&error.message==='IMAGE_PREPARATION_HOST_SYSTEMD_COMMAND_UNKNOWN');await assert.rejects(f.control.startWorker(),rejected);
 assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);
 for(const call of f.calls){assert(['/usr/bin/systemctl','/usr/bin/journalctl'].includes(call.program));assert.equal(call.options.shell,false);assert.equal(call.options.killSignal,'SIGKILL');assert(Number(call.options.timeout)<=60000);assert(Number(call.options.maxBuffer)<=1024*1024);assert.deepEqual(call.options.env,{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});assert(!call.args.some(arg=>['enable','restart','reset-failed','daemon-reload'].includes(arg)));}
});
test('malformed/duplicate loaded properties and contradictory identity are rejected',()=>{
 const f=fixture();for(const raw of [f.raw(f.states.worker)+'\nMainPID=0',f.raw(f.states.worker).replace('Type=simple\n',''),'private-credential',f.raw({...f.states.worker,ExecMainPID:'4321'}),f.raw({...f.states.worker,KillMode:'process'}),f.raw({...f.states.worker,Restart:'always'})])assert.throws(()=>parseImagePreparationControlState(raw,f.host,'worker'),rejected);
 assert.throws(()=>createImagePreparationHostSystemdControl({...f.identity,configurationSha256:'invalid'},f.deps),rejected);
 assert.throws(()=>createImagePreparationHostSystemdControl({...f.identity,host:{...f.host,units:{...f.host.units,worker:{...f.host.units.worker,sha256:'f'.repeat(64)}}}},f.deps),rejected);
});
