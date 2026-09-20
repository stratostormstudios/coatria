/** Fixed startup diagnostics only. Never retain process arguments, paths,
 * environment, provider data, raw journal messages or exception text. */
const stages=new Set(['arguments','host_platform','host_configuration','host_identity','bundle_integrity','profile_integrity','delegation_path','delegation_ownership','delegation_memory_limit','delegation_swap_limit','delegation_process_limit','delegation_cpu_limit','delegation_empty_parent','delegation_controllers','delegation_enable','delegation_create','delegation_child_integrity','delegation_child_enable','qualification_staging','qualification_canary','qualification_result','qualification_receipt','worker_receipt','worker_enablement','worker_environment','worker_scratch','worker_process']);
const codes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','ENOMEM','EAGAIN','EMFILE','ENFILE','EINVAL','EEXIST','ENOSPC','EROFS','EBUSY','ENOTDIR','ELOOP','ERR_ASSERTION','SANDBOX_UNAVAILABLE','INVALID_PROFILE','INPUT_INVALID','ABORTED','TIMEOUT','OUTPUT_LIMIT','PROCESS_FAILED','CLEANUP_FAILED','CANARY_ASSERTION_FAILED','CHECK_FAILED']);
const fixedCode=value=>codes.has(value)?value:'UNKNOWN';
const startupPhases=new Set(['pins_checked','cgroup_capped','spawned','helper_ready','membership_verified','gate_released','exited','drained']);
const helperStages=new Set(['ARGUMENT_IDENTITY','INPUT_FD','ROOT_DIRECTORY','CGROUP_FD','PARENT_NO_NEW_PRIVILEGES','RESOURCE_LIMITS','SCHEDULER','CGROUP_JOIN','READY_WRITE','GATE_PARENT_CHECK','CLOSE_RANGE','BWRAP_EXEC']);
const stderrClasses=new Set(['NAMESPACE_PERMISSION','NAMESPACE_CREATE','USER_ID_MAPPING','CGROUP_NAMESPACE','NESTED_USER_NAMESPACE','NETWORK_SETUP','PROC_SETUP','MOUNT_SETUP','APPARMOR','EXECUTABLE_START','ARGUMENT_REJECTED','UNCLASSIFIED']);
const stderrErrnos=new Set(['EPERM','EACCES','ENOENT','EROFS','ENOSPC','ENOMEM','EMFILE','EINVAL']);
const numeric=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
export function archiveHostStartupSummary(value){
 if(!value||value.diagnosticOnly!==true||value.qualified!==false||!['conformance','real'].includes(value.profileKind)||!Array.isArray(value.phases)||value.phases.length>16)return null;
 const selected=(values,allowed)=>Array.isArray(values)&&values.length<=16?[...new Set(values.filter(v=>allowed.has(v)))]:[];
 return {diagnosticOnly:true,qualified:false,profileKind:value.profileKind,phases:selected(value.phases,startupPhases),exitCode:numeric(value.exitCode,255),signal:['SIGKILL','SIGSEGV','SIGSYS','SIGABRT','SIGXFSZ','SIGTERM','OTHER'].includes(value.signal)?value.signal:null,helperExitStage:helperStages.has(value.helperExitStage)?value.helperExitStage:null,stopCode:['DEADLINE','STREAM_ERROR','OUTPUT_LIMIT'].includes(value.stopCode)?value.stopCode:null,failureCode:value.failureCode==='DIAGNOSTIC_STARTUP_FAILED'?'DIAGNOSTIC_STARTUP_FAILED':null,spawnError:value.spawnError===true,drained:value.drained===true,cleanupFailed:value.cleanupFailed===true,stdoutBytes:numeric(value.stdoutBytes,1024**2),stderrBytes:numeric(value.stderrBytes,1024**2),fdHelpObserved:value.fdHelpObserved===true,stderrClassification:{classes:selected(value.stderrClassification?.classes,stderrClasses),errno:selected(value.stderrClassification?.errno,stderrErrnos),truncated:value.stderrClassification?.truncated===true}};
}
export function archiveHostCanarySummary(value){
 if(!value||value.qualified!==false||!Array.isArray(value.tests)||value.tests.length>10||!Array.isArray(value.realFormats)||value.realFormats.length>7)return null;
 return {failureCode:fixedCode(value.failureCode),testsPassed:value.tests.filter(t=>t?.passed===true).length,formatsPassed:value.realFormats.length,startup:archiveHostStartupSummary(value.startupDiagnostic)};
}
export class ArchiveHostRunError extends Error{
 /** @param {string} stage @param {unknown} error @param {{failureCode:string,testsPassed:number,formatsPassed:number,startup?:unknown}|null} [canary] */
 constructor(stage,error,canary=null){
  super('ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED');this.name='ArchiveHostRunError';
  this.diagnostic=Object.freeze({event:'archive-host-failed',code:'ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED',stage:stages.has(stage)?stage:'unknown_stage',errorCode:error?.message==='ARCHIVE_HOST_PACKAGE_REJECTED'?'CHECK_FAILED':fixedCode(error?.code),canary:canary&&Number.isInteger(canary.testsPassed)&&canary.testsPassed>=0&&canary.testsPassed<=10&&Number.isInteger(canary.formatsPassed)&&canary.formatsPassed>=0&&canary.formatsPassed<=7?{failureCode:fixedCode(canary.failureCode),testsPassed:canary.testsPassed,formatsPassed:canary.formatsPassed,startup:archiveHostStartupSummary(canary.startup)}:null});
 }
}
/** Only the current service invocation's fixed JSON is eligible. Raw journal
 * rows are transient input and never included in the exported evidence. */
export function archiveHostJournalFailure(raw,invocationId){
 if(typeof raw!=='string'||raw.length>2*1024**2||!/^[a-f0-9]{32}$/.test(invocationId))return null;
 let result=null;
 for(const line of raw.split('\n')){
  if(line.length>16384)continue;
  try{const row=JSON.parse(line);if(row._SYSTEMD_INVOCATION_ID!==invocationId||typeof row.MESSAGE!=='string'||row.MESSAGE.length>4096)continue;const message=JSON.parse(row.MESSAGE);
   if(message.event!=='archive-host-failed'||message.code!=='ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED'||!stages.has(message.stage))continue;
   result=new ArchiveHostRunError(message.stage,{code:message.errorCode},message.canary).diagnostic;
  }catch{/* Non-JSON and unrelated process output is deliberately discarded. */}
 }
 return result;
}
