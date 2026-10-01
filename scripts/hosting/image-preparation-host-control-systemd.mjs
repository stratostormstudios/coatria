/** Exact installed image-preparation units only. Command acceptance, runner
 * readiness, process exit and confirmed local cleanup are separate observations.
 * No enable/reset/restart/retry, credential access or remote outcome inference. */
import {spawnSync} from 'node:child_process';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {archiveHostRead,archiveHostTrusted} from './archive-host-package.mjs';
import {IMAGE_PREPARATION_HOST_CONFIG,IMAGE_PREPARATION_HOST_RELEASES,IMAGE_PREPARATION_HOST_SERVICE_USER,imagePreparationHostHash,imagePreparationHostUnit,imagePreparationHostUnitName} from './image-preparation-host-package.mjs';

const invocation=v=>typeof v==='string'&&/^(?!0{32}$)[a-f0-9]{32}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>typeof v==='string'&&/^(?:0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const MODES=['preflight','worker'];
const ENV=Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
const BOOT_PATH='/proc/sys/kernel/random/boot_id';
export const IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES='LoadState,ActiveState,SubState,MainPID,ExecMainPID,ControlPID,Result,ExecMainCode,ExecMainStatus,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic,InvocationID,FragmentPath,DropInPaths,NeedDaemonReload,Transient,UnitFileState,User,Group,ControlGroup,Type,RemainAfterExit,KillMode,Restart,Job';
export class ImagePreparationHostSystemdError extends Error{
 constructor(code='IMAGE_PREPARATION_HOST_SYSTEMD_REJECTED'){super(code);this.name='ImagePreparationHostSystemdError';this.code=code;}
}
/** @returns {never} */
function fail(code){throw new ImagePreparationHostSystemdError(code);}
function modeName(host,mode){if(!MODES.includes(mode))fail();return imagePreparationHostUnitName(host.scope.serviceId,mode);}
function assertIdentity(identity){
 const h=identity?.host;if(!h||!uuid(h.scope?.serviceId)||!sha(h.bundleSha256)||h.release!==IMAGE_PREPARATION_HOST_RELEASES+'/'+h.bundleSha256||!/^[a-f0-9]{40}$/.test(h.commit??'')||!Number.isSafeInteger(h.uid)||h.uid<1||!Number.isSafeInteger(h.gid)||h.gid<1||h.node?.path!==h.release+'/runtime/node'||h.worker?.path!==h.release+'/worker/runtime.mjs'||!uuid(identity.bootId)||!sha(identity.hostConfigurationSha256)||!sha(identity.configurationSha256)||!sha(identity.qualificationSha256))fail();
 for(const mode of MODES){const name=modeName(h,mode),content=imagePreparationHostUnit(mode,h.release,h.bundleSha256,h.scope.serviceId);if(h.units?.[mode]?.name!==name||h.units[mode].sha256!==imagePreparationHostHash(content))fail();}
}

/** Strict loaded metadata. Inactive oneshots deliberately do not need a retained
 * InvocationID: systemd can clear it; the last ExecMain identity plus journal
 * proves the completed invocation. Missing/unloaded history cannot prove success. */
export function parseImagePreparationControlState(raw,host,mode){
 const unit=modeName(host,mode),keys=IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES.split(','),state={};
 if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)fail();
 for(const line of raw.trim().split('\n')){const at=line.indexOf('='),key=line.slice(0,at);if(at<1||!keys.includes(key)||Object.hasOwn(state,key))fail();state[key]=line.slice(at+1);}
 if(Object.keys(state).length!==keys.length||state.LoadState!=='loaded'||state.FragmentPath!=='/etc/systemd/system/'+unit||state.DropInPaths!==''||state.NeedDaemonReload!=='no'||state.Transient!=='no'||state.UnitFileState!=='static'||state.User!==IMAGE_PREPARATION_HOST_SERVICE_USER||state.Group!==IMAGE_PREPARATION_HOST_SERVICE_USER||state.Type!==(mode==='worker'?'simple':'oneshot')||state.RemainAfterExit!=='no'||state.KillMode!=='control-group'||state.Restart!=='no')fail();
 if(!['inactive','active','activating','deactivating','failed'].includes(state.ActiveState)||!['dead','running','exited','start-pre','start','start-post','condition','stop','stop-watchdog','stop-sigterm','stop-sigkill','stop-post','final-watchdog','final-sigterm','final-sigkill','failed','cleaning'].includes(state.SubState)||state.Job!==''&&!/^\d+/.test(state.Job))fail();
 for(const key of ['MainPID','ExecMainPID','ControlPID','ExecMainCode','ExecMainStatus','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic'])if(!integer(state[key]))fail();
 if(state.InvocationID!==''&&!invocation(state.InvocationID)||!['','/system.slice/'+unit].includes(state.ControlGroup))fail();
 const started=Number(state.ExecMainStartTimestampMonotonic),exited=Number(state.ExecMainExitTimestampMonotonic);
 if((Number(state.ExecMainPID)===0)!==(started===0)||exited!==0&&exited<started||Number(state.MainPID)!==0&&(state.MainPID!==state.ExecMainPID||state.ControlGroup!=='/system.slice/'+unit))fail();
 if(state.ActiveState==='active'&&(mode!=='worker'||state.SubState!=='running'||Number(state.MainPID)===0||!invocation(state.InvocationID)))fail();
 if(['inactive','failed'].includes(state.ActiveState)&&(state.MainPID!=='0'||state.ControlPID!=='0'||!['dead','failed'].includes(state.SubState)))fail();
 return state;
}

function eventExpected(identity,event){
 const common={event,serviceId:identity.host.scope.serviceId,sourceCommit:identity.host.commit,configurationSha256:identity.configurationSha256,qualificationSha256:identity.qualificationSha256};
 return event==='image-preparation-worker-drained'?{...common,clientsDrained:true,scratchEmpty:true,temporaryEmpty:true,nativeDescendantsEmpty:true,remoteOutcomeResolved:false}:{...common,workClaimed:false,providerCalled:false};
}
/** Only trusted journald fields attest the exact executable/main PID. A MESSAGE
 * cannot nominate another process, boot or invocation. No raw journal is returned. */
export function imagePreparationControlJournalProof(raw,identity,mode,state,expectedInvocationId){
 assertIdentity(identity);modeName(identity.host,mode);if(expectedInvocationId!==undefined&&!invocation(expectedInvocationId))fail();
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)fail();const lines=raw.trim()?raw.trim().split('\n'):[];if(lines.length>1024)fail();
 const h=identity.host,unit=h.units[mode].name,found=new Map(),ids=new Set(),minimum=Number(state.ExecMainStartTimestampMonotonic),boot=identity.bootId.replaceAll('-','');
 const events=mode==='worker'?['image-preparation-worker-ready','image-preparation-worker-drained']:['image-preparation-worker-preflight-passed'];
 for(const line of lines){let row;try{row=JSON.parse(line);}catch{fail();}if(!row||typeof row!=='object'||Array.isArray(row))fail();
  let message;try{message=typeof row.MESSAGE==='string'?JSON.parse(row.MESSAGE):null;}catch{continue;}if(!events.includes(message?.event))continue;
  if(!integer(row.__MONOTONIC_TIMESTAMP))fail();if(Number(row.__MONOTONIC_TIMESTAMP)<minimum)continue;
  if(!minimum||!invocation(row._SYSTEMD_INVOCATION_ID)||row._SYSTEMD_UNIT!==unit||row._BOOT_ID!==boot||row._PID!==state.ExecMainPID||row._UID!==String(h.uid)||row._GID!==String(h.gid)||row._EXE!==h.node.path||row._TRANSPORT!=='stdout')fail();
  const id=row._SYSTEMD_INVOCATION_ID;if(state.InvocationID&&id!==state.InvocationID||expectedInvocationId&&id!==expectedInvocationId||canonical(message)!==canonical(eventExpected(identity,message.event))||found.has(message.event))fail();
  found.set(message.event,Number(row.__MONOTONIC_TIMESTAMP));ids.add(id);
 }
 if(ids.size>1)fail();const id=state.InvocationID||[...ids][0]||null;if(expectedInvocationId&&id!==expectedInvocationId)fail();
 const ready=found.has('image-preparation-worker-ready'),drained=found.has('image-preparation-worker-drained');
 if(ready&&drained&&found.get('image-preparation-worker-drained')<found.get('image-preparation-worker-ready'))fail();
 return {invocationId:id,ready,drained,preflight:found.has('image-preparation-worker-preflight-passed')};
}

async function trustedFile(path,maximum){if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0)fail();await archiveHostTrusted(path);return archiveHostRead(path,maximum);}
async function bootId(){const value=(await readFile(BOOT_PATH,'utf8')).trim();if(!uuid(value))fail();return value;}
/** cgroup.events populated includes descendants; a removed, exact service group
 * under the checked kernel parent is also empty. No PID guessing or deletion. */
export async function imagePreparationControlCgroupEmpty(unit,uid){
 if(!/^coatria-image-preparation-[a-f0-9-]{36}-(?:preflight|worker)\.service$/.test(unit)||!Number.isSafeInteger(uid)||uid<1)fail();
 for(const path of ['/sys/fs/cgroup','/sys/fs/cgroup/system.slice']){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||info.mode&0o022||await realpath(path)!==path)fail();}
 const path='/sys/fs/cgroup/system.slice/'+unit;let before;try{before=await lstat(path);}catch(error){if(error.code==='ENOENT')return true;throw error;}
 if(!before.isDirectory()||before.isSymbolicLink()||![0,uid].includes(before.uid)||before.mode&0o022||await realpath(path)!==path)fail();
 const raw=await readFile(path+'/cgroup.events','utf8');if(Buffer.byteLength(raw)>4096)fail();const values=new Map();
 for(const line of raw.trim().split('\n')){const match=/^([a-z_]+) ([0-9]+)$/.exec(line);if(!match||values.has(match[1]))fail();values.set(match[1],match[2]);}
 if(!['0','1'].includes(values.get('populated')))fail();
 const after=await lstat(path);if(before.ino!==after.ino||before.dev!==after.dev)fail();return values.get('populated')==='0';
}

/** @typedef {{shell:false,env:Record<string,string>,encoding:'utf8',timeout:number,maxBuffer:number,windowsHide:true,killSignal:'SIGKILL'}} ImagePreparationSystemdCommandOptions */
/** @typedef {{status:number|null,stdout:string,stderr?:string,error?:unknown,signal?:string|null}} ImagePreparationSystemdCommandResult */
/** @typedef {{exec?:(program:string,args:string[],options:ImagePreparationSystemdCommandOptions)=>ImagePreparationSystemdCommandResult,readTrustedFile?:(path:string,maximum:number)=>Promise<Buffer|string>,readBootId?:()=>Promise<string>,inspectCgroup?:(unit:string,uid:number)=>Promise<boolean>}} ImagePreparationSystemdDependencies */
/** I/O injection is constructor-only for offline fixtures; no environment or CLI
 * switch replaces production checks. The caller owns the durable exclusive start
 * fence and accepted host/receipt identity. This adapter never renews authority.
 * @param {object} input
 * @param {ImagePreparationSystemdDependencies} dependencies
 */
export function createImagePreparationHostSystemdControl(input,{exec=spawnSync,readTrustedFile=trustedFile,readBootId=bootId,inspectCgroup=imagePreparationControlCgroupEmpty}={}){
 const identity=structuredClone(input);assertIdentity(identity);const h=identity.host;let busy=false,preflightSent=false,startSent=false,stopSent=false;
 async function exclusive(run){if(busy)fail();busy=true;try{return await run();}catch(error){if(error instanceof ImagePreparationHostSystemdError)throw error;fail();}finally{busy=false;}}
 function command(program,args,timeout,maxBuffer,mutation=false,emptyGrep=false){let result;try{result=exec(program,args,{shell:false,env:{...ENV},encoding:'utf8',timeout,maxBuffer,windowsHide:true,killSignal:'SIGKILL'});}catch{fail(mutation?'IMAGE_PREPARATION_HOST_SYSTEMD_COMMAND_UNKNOWN':undefined);}const noMatch=emptyGrep&&result?.status===1&&result.stdout===''&&(result.stderr??'')==='';if(result?.status!==0&&!noMatch||result.error||result.signal||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>maxBuffer)fail(mutation?'IMAGE_PREPARATION_HOST_SYSTEMD_COMMAND_UNKNOWN':undefined);return result.stdout;}
 async function installation(mode){
  modeName(h,mode);const hostBytes=await readTrustedFile(IMAGE_PREPARATION_HOST_CONFIG+'/'+h.scope.serviceId+'/host.json',65536);
  if(imagePreparationHostHash(hostBytes)!==identity.hostConfigurationSha256||canonical(JSON.parse(hostBytes))!==canonical(h))fail();
  const unitBytes=await readTrustedFile('/etc/systemd/system/'+h.units[mode].name,16384),expected=imagePreparationHostUnit(mode,h.release,h.bundleSha256,h.scope.serviceId);
  if(imagePreparationHostHash(unitBytes)!==h.units[mode].sha256||Buffer.from(unitBytes).toString('utf8')!==expected||await readBootId()!==identity.bootId)fail();
 }
 function state(mode){return parseImagePreparationControlState(command('/usr/bin/systemctl',['show',h.units[mode].name,'--property='+IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES],10000,16384),h,mode);}
 async function observation(mode,expected){
  if(expected!==undefined&&!invocation(expected))fail();await installation(mode);const before=state(mode);
  if(expected&&before.InvocationID&&before.InvocationID!==expected)fail();
  // Filter the three fixed, JSON.stringify-emitted proof events before the line
  // bound: up to 1,800 ordinary attempt records in a finite hour must not evict
  // the original ready record. Full payload/trusted-field checks still follow.
  const eventPattern='^\\{"event":"image-preparation-worker-'+(mode==='worker'?'(ready|drained)':'preflight-passed')+'"';
  // systemd v255 returns status 1 for a grep with no matches. With --quiet only
  // empty stdout AND stderr is treated as absent proof, never ready/cleaned.
  let journal='';if(before.ExecMainPID!=='0')journal=command('/usr/bin/journalctl',['--unit='+h.units[mode].name,'_BOOT_ID='+identity.bootId.replaceAll('-',''),'_PID='+before.ExecMainPID,...before.InvocationID?['_SYSTEMD_INVOCATION_ID='+before.InvocationID]:expected?['_SYSTEMD_INVOCATION_ID='+expected]:[],'--grep='+eventPattern,'--output=json','--quiet','--no-pager','--all','--lines=1024'],10000,1024*1024,false,true);
  const proof=imagePreparationControlJournalProof(journal,identity,mode,before,expected),empty=await inspectCgroup(h.units[mode].name,h.uid);if(typeof empty!=='boolean')fail();
  // Bind facts gathered across independent reads to the same actual invocation.
  const after=state(mode);if(canonical(before)!==canonical(after)||await readBootId()!==identity.bootId)fail('IMAGE_PREPARATION_HOST_SYSTEMD_OBSERVATION_CHANGED');
  const stopped=['inactive','failed'].includes(before.ActiveState)&&before.MainPID==='0'&&before.ControlPID==='0'&&before.Job==='';
  const success=stopped&&before.ExecMainPID!=='0'&&before.Result==='success'&&before.ExecMainCode==='1'&&before.ExecMainStatus==='0'&&Number(before.ExecMainExitTimestampMonotonic)>=Number(before.ExecMainStartTimestampMonotonic);
  const preflightPassed=mode==='preflight'&&success&&empty&&proof.preflight;
  return {mode,unit:h.units[mode].name,bootId:identity.bootId,activeState:before.ActiveState,subState:before.SubState,invocationId:proof.invocationId,pid:Number(before.MainPID),result:before.ExecMainPID==='0'?null:success?'success':stopped?'failure':null,runningReady:mode==='worker'&&before.ActiveState==='active'&&before.SubState==='running'&&proof.ready&&!proof.drained,preflightPassed,processStopped:stopped,cgroupEmpty:empty,cleanupConfirmed:mode==='preflight'?preflightPassed:stopped&&empty&&proof.drained};
 }
 async function pristine(mode){const found=await observation(mode);if(!found.processStopped||!found.cgroupEmpty||found.activeState!=='inactive'||found.invocationId!==null||found.pid!==0)fail();await installation(mode);const current=state(mode);if(current.ActiveState!=='inactive'||current.SubState!=='dead'||current.Job!==''||current.ExecMainPID!=='0'||current.InvocationID!=='')fail();}
 return {
  observe:(mode,expectedInvocationId)=>exclusive(()=>observation(mode,expectedInvocationId)),
  preflight:()=>exclusive(async()=>{if(preflightSent)fail();await pristine('preflight');preflightSent=true;command('/usr/bin/systemctl',['start',h.units.preflight.name],60000,16384,true);return observation('preflight');}),
  // No readiness polling here: the engine persists the first observed ID before
  // separately reconciling trusted readiness. An unknown start is never retried.
  startWorker:()=>exclusive(async()=>{if(startSent)fail();await pristine('worker');startSent=true;command('/usr/bin/systemctl',['start',h.units.worker.name],60000,16384,true);return observation('worker');}),
  stopWorker:expected=>exclusive(async()=>{
   if(!invocation(expected))fail();const observed=await observation('worker',expected);if(observed.processStopped)return observed;if(stopSent)fail();
   await installation('worker');const current=state('worker');if(current.InvocationID!==expected||current.ExecMainPID!==String(observed.pid)||current.MainPID!==String(observed.pid)||!['active','activating'].includes(current.ActiveState)||current.Job!=='')fail();
   // There are no asynchronous operations between this identity check and stop.
   stopSent=true;command('/usr/bin/systemctl',['stop',h.units.worker.name],60000,16384,true);return observation('worker',expected);
  })
 };
}
