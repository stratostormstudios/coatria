/** Read-only, disposable Linux CI diagnostics. This report is never admission,
 * readiness, cleanup or qualification evidence. No starts, stops or retries. */
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {archiveHostRead,archiveHostTrusted} from './archive-host-package.mjs';
import {IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES,parseImagePreparationControlState} from './image-preparation-host-control-systemd.mjs';
import {imagePreparationHostHash,imagePreparationHostUnit,imagePreparationHostUnitName,parseImagePreparationHostScope} from './image-preparation-host-package.mjs';

const MODES=['preflight','worker'],MAX_JOURNAL=1024*1024,MAX_ROWS=1024;
const ENV=Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const invocation=v=>typeof v==='string'&&/^(?!0{32}$)[a-f0-9]{32}$/.test(v);
const integer=v=>typeof v==='string'&&/^(?:0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const runtime=()=>({platform:process.platform,arch:process.arch,uid:process.getuid?.(),ci:process.env.CI,candidate:process.env.GITHUB_SHA});
const trustedFile=async(path,maximum)=>{await archiveHostTrusted(path);return archiveHostRead(path,maximum);};
const bootId=async()=>(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const enumValue=(value,allowed)=>allowed.includes(value)?value:'unknown';
const numberValue=(value,max)=>integer(value)&&Number(value)<=max?Number(value):null;
const hasNumber=value=>integer(value)?Number(value)>0:null;
const events=Object.freeze({
 'image-preparation-worker-preflight-passed':'preflightPassed',
 'image-preparation-worker-ready':'ready',
 'image-preparation-worker-drained':'drained',
 'image-preparation-worker-stopped':'stopped'
});
function admit(host,facts,current){
 if(current?.platform!=='linux'||current.arch!=='x64'||current.uid!==0||current.ci!=='true'||!/^[a-f0-9]{40}$/.test(current.candidate??'')||host?.commit!==current.candidate||!sha(facts?.configurationSha256)||!sha(facts?.qualificationSha256))return false;
 // Historical expiry must not hide a failed invocation. This parses the exact
 // finite scope structurally, without treating it as currently authorized.
 parseImagePreparationHostScope({version:1,...host.scope},Date.parse(host.scope?.expiresAt)-1);
 if(host.scope.origin!=='https://coatria.com'||host.scope.gateways.some(g=>g.origin!=='https://imagepreparationci1-4190.proxy.runpod.net')||!sha(host.bundleSha256)||host.release!=='/var/lib/coatria-image-preparation-releases/'+host.bundleSha256||host.node?.path!==host.release+'/runtime/node'||!sha(host.node.sha256)||host.worker?.path!==host.release+'/worker/runtime.mjs'||!sha(host.worker.sha256)||!Number.isSafeInteger(host.uid)||host.uid<1||!Number.isSafeInteger(host.gid)||host.gid<1)return false;
 for(const mode of ['qualify',...MODES])if(host.units?.[mode]?.name!==imagePreparationHostUnitName(host.scope.serviceId,mode)||host.units[mode].sha256!==imagePreparationHostHash(imagePreparationHostUnit(mode,host.release,host.bundleSha256,host.scope.serviceId)))return false;
 return true;
}
function parseState(raw,host,mode){
 const values=Object.create(null),keys=IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES.split(',');let wellFormed=true;
 for(const row of raw.trim().split('\n')){const at=row.indexOf('='),key=row.slice(0,at);if(at<1||!keys.includes(key)||Object.hasOwn(values,key)){wellFormed=false;if(Object.hasOwn(values,key))values[key]=null;continue;}values[key]=row.slice(at+1);}
 if(Object.keys(values).length!==keys.length)wellFormed=false;
 let contractMatches=false;try{parseImagePreparationControlState(raw,host,mode);contractMatches=true;}catch{}
 return {values,projection:{status:'collected',wellFormed,contractMatches,
  loadState:enumValue(values.LoadState,['stub','loaded','not-found','bad-setting','error','masked','merged']),
  phase:enumValue(values.ActiveState,['inactive','active','activating','deactivating','failed','reloading','maintenance']),
  subState:enumValue(values.SubState,['dead','running','exited','start-pre','start','start-post','condition','stop','stop-watchdog','stop-sigterm','stop-sigkill','stop-post','final-watchdog','final-sigterm','final-sigkill','failed','cleaning']),
  result:enumValue(values.Result,['success','resources','timeout','exit-code','signal','core-dump','watchdog','start-limit-hit','oom-kill','protocol','exec-condition']),
  exitCode:numberValue(values.ExecMainCode,6),exitStatus:numberValue(values.ExecMainStatus,255),
  mainProcessPresent:hasNumber(values.MainPID),lastProcessPresent:hasNumber(values.ExecMainPID),controlProcessPresent:hasNumber(values.ControlPID),
  invocationPresent:typeof values.InvocationID==='string'?invocation(values.InvocationID):null,
  jobPresent:typeof values.Job==='string'?values.Job!=='':null,
  startObserved:hasNumber(values.ExecMainStartTimestampMonotonic),exitObserved:hasNumber(values.ExecMainExitTimestampMonotonic)}};
}
function expectedPayload(host,facts,event){
 if(event==='image-preparation-worker-stopped')return {event,code:'IMAGE_PREPARATION_RUNNER_UNAVAILABLE'};
 const common={event,serviceId:host.scope.serviceId,sourceCommit:host.commit,configurationSha256:facts.configurationSha256,qualificationSha256:facts.qualificationSha256};
 return event==='image-preparation-worker-drained'?{...common,clientsDrained:true,scratchEmpty:true,temporaryEmpty:true,nativeDescendantsEmpty:true,remoteOutcomeResolved:false}:{...common,workClaimed:false,providerCalled:false};
}
function journalProjection(raw,host,facts,boot,mode,state){
 const lines=raw.trim()?raw.trim().split('\n'):[];
 if(lines.length>MAX_ROWS)return {status:'unknown',failure:'journal-bound'};
 const summaries=Object.fromEntries(Object.values(events).map(event=>[event,{count:0,allRequiredFieldsMatch:null,missingFields:[],mismatchedFields:[],unavailableFields:[]}]));
 let malformedRows=0,ignoredRows=0;const ids=new Set();
 for(const line of lines){
  let row,message;try{row=JSON.parse(line);if(!object(row))throw Error();}catch{malformedRows++;continue;}
  try{message=typeof row.MESSAGE==='string'?JSON.parse(row.MESSAGE):null;}catch{ignoredRows++;continue;}
  if(!object(message)||typeof message.event!=='string'||!Object.hasOwn(events,message.event)){ignoredRows++;continue;}
  const summary=summaries[events[message.event]];summary.count++;summary.allRequiredFieldsMatch??=true;
  const checks=[
   ['unit',row._SYSTEMD_UNIT,host.units[mode].name],['boot',row._BOOT_ID,boot.replaceAll('-','')],
   ['pid',row._PID,integer(state?.ExecMainPID)&&state.ExecMainPID!=='0'?state.ExecMainPID:undefined],
   ['uid',row._UID,String(host.uid)],['gid',row._GID,String(host.gid)],['executable',row._EXE,host.node.path],['transport',row._TRANSPORT,'stdout'],
   ['invocation',row._SYSTEMD_INVOCATION_ID,invocation(state?.InvocationID)?state.InvocationID:undefined]
  ];
  const record=(key,kind)=>{if(kind!=='match'){summary.allRequiredFieldsMatch=false;const field=kind+'Fields';if(!summary[field].includes(key))summary[field].push(key);}};
  for(const [key,actual,expected] of checks)record(key,actual===undefined||actual===null?'missing':expected===undefined?'unavailable':actual===expected?'match':'mismatched');
  record('invocationFormat',row._SYSTEMD_INVOCATION_ID===undefined?'missing':invocation(row._SYSTEMD_INVOCATION_ID)?'match':'mismatched');
  record('monotonicStart',row.__MONOTONIC_TIMESTAMP===undefined?'missing':!integer(row.__MONOTONIC_TIMESTAMP)?'mismatched':!integer(state?.ExecMainStartTimestampMonotonic)||state.ExecMainStartTimestampMonotonic==='0'?'unavailable':Number(row.__MONOTONIC_TIMESTAMP)>=Number(state.ExecMainStartTimestampMonotonic)?'match':'mismatched');
  record('payload',canonical(message)===canonical(expectedPayload(host,facts,message.event))?'match':'mismatched');
  record('mode',message.event==='image-preparation-worker-stopped'||(mode==='preflight')===(message.event==='image-preparation-worker-preflight-passed')?'match':'mismatched');
  if(invocation(row._SYSTEMD_INVOCATION_ID))ids.add(row._SYSTEMD_INVOCATION_ID);
 }
 return {status:'collected',rows:lines.length,malformedRows,ignoredRows,distinctInvocationCount:ids.size,events:summaries};
}
/** Constructor-only seams for offline fixtures. The default export is inert
 * until called, admits only this exact root CI source/scope and never reads a
 * token, environment dump, command line or unrestricted journal. */
export function createImagePreparationInstalledControlDiagnostic({exec=spawnSync,runtime:context=runtime,readTrustedFile=trustedFile,readBootId=bootId}={}){
 return async function collect(host,facts){
  const report={version:1,kind:'image-preparation-installed-control-diagnostic',diagnosticOnly:true,admission:'rejected',failure:null,bootStable:null,units:{}};
  let h,f,boot;
  try{h=structuredClone(host);f=structuredClone(facts);if(!admit(h,f,context()))throw Error();}catch{report.failure='admission-rejected';return report;}
  report.admission='accepted';
  try{const bytes=await readTrustedFile('/etc/coatria-image-preparation/'+h.scope.serviceId+'/host.json',65536);if(Buffer.byteLength(bytes)>65536||canonical(JSON.parse(Buffer.from(bytes).toString('utf8')))!==canonical(h))throw Error();boot=await readBootId();if(!uuid(boot))throw Error();}catch{report.failure='trusted-host-unavailable';return report;}
  function command(program,args,maximum,empty=false){
   let result;try{result=exec(program,args,{shell:false,env:{...ENV},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:3000,maxBuffer:maximum,windowsHide:true,killSignal:'SIGKILL'});}catch{return null;}
   if(result?.error||result?.signal||typeof result?.stdout!=='string'||typeof (result.stderr??'')!=='string'||Buffer.byteLength(result.stdout)>maximum||Buffer.byteLength(result.stderr??'')>maximum||result.status!==0&&!(empty&&result.status===1&&result.stdout===''&&(result.stderr??'')===''))return null;
   return result.stdout;
  }
  for(const mode of MODES){
   const unit={installation:'unknown',state:{status:'unknown'},journal:{status:'unknown'},stateStable:null,failure:null};report.units[mode]=unit;
   try{const bytes=await readTrustedFile('/etc/systemd/system/'+h.units[mode].name,16384),expected=imagePreparationHostUnit(mode,h.release,h.bundleSha256,h.scope.serviceId);if(Buffer.byteLength(bytes)>16384||Buffer.from(bytes).toString('utf8')!==expected||imagePreparationHostHash(bytes)!==h.units[mode].sha256)throw Error();unit.installation='matched';}catch{unit.failure='trusted-unit-unavailable';continue;}
   const args=['show',h.units[mode].name,'--property='+IMAGE_PREPARATION_CONTROL_STATE_PROPERTIES];
   const before=command('/usr/bin/systemctl',args,16384);let state;
   if(before===null)unit.failure='state-command-unknown';else{const parsed=parseState(before,h,mode);state=parsed.values;unit.state=parsed.projection;}
   // Keep exact unit and boot filters, but deliberately do not filter PID or
   // invocation: missing or mismatched trusted fields are diagnostic findings.
   const raw=command('/usr/bin/journalctl',['--unit='+h.units[mode].name,'_BOOT_ID='+boot.replaceAll('-',''),'--grep=^\\{"event":"image-preparation-worker-(preflight-passed|ready|drained|stopped)"','--output=json','--quiet','--no-pager','--all','--lines='+MAX_ROWS],MAX_JOURNAL,true);
   if(raw===null){unit.journal={status:'unknown',failure:'journal-command-unknown'};}else try{unit.journal=journalProjection(raw,h,f,boot,mode,state);}catch{unit.journal={status:'unknown',failure:'journal-parse-unknown'};}
   const after=command('/usr/bin/systemctl',args,16384);unit.stateStable=before!==null&&after!==null?before===after:null;
  }
  try{const after=await readBootId();if(!uuid(after))throw Error();report.bootStable=boot===after;}catch{report.failure='boot-observation-unknown';}
  return report;
 };
}
export async function collectImagePreparationInstalledControlDiagnostic(host,facts){return createImagePreparationInstalledControlDiagnostic()(host,facts);}
