/** Fixed startup diagnostics only. Never retain process arguments, paths,
 * environment, provider data, raw journal messages or exception text. */
const stages=new Set(['arguments','host_platform','host_configuration','host_identity','bundle_integrity','profile_integrity','delegation_path','delegation_ownership','delegation_memory_limit','delegation_swap_limit','delegation_process_limit','delegation_cpu_limit','delegation_empty_parent','delegation_controllers','delegation_enable','delegation_create','delegation_child_integrity','delegation_child_enable','qualification_staging','qualification_canary','qualification_result','qualification_receipt','worker_receipt','worker_enablement','worker_environment','worker_scratch','worker_process']);
const codes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','ENOMEM','EAGAIN','EMFILE','ENFILE','EINVAL','EEXIST','ENOSPC','EROFS','EBUSY','ENOTDIR','ELOOP','ERR_ASSERTION','SANDBOX_UNAVAILABLE','INVALID_PROFILE','INPUT_INVALID','ABORTED','TIMEOUT','OUTPUT_LIMIT','PROCESS_FAILED','CLEANUP_FAILED','CANARY_ASSERTION_FAILED','CHECK_FAILED']);
const fixedCode=value=>codes.has(value)?value:'UNKNOWN';
export function archiveHostCanarySummary(value){
 if(!value||value.qualified!==false||!Array.isArray(value.tests)||value.tests.length>10||!Array.isArray(value.realFormats)||value.realFormats.length>7)return null;
 return {failureCode:fixedCode(value.failureCode),testsPassed:value.tests.filter(t=>t?.passed===true).length,formatsPassed:value.realFormats.length};
}
export class ArchiveHostRunError extends Error{
 /** @param {string} stage @param {unknown} error @param {{failureCode:string,testsPassed:number,formatsPassed:number}|null} [canary] */
 constructor(stage,error,canary=null){
  super('ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED');this.name='ArchiveHostRunError';
  this.diagnostic=Object.freeze({event:'archive-host-failed',code:'ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED',stage:stages.has(stage)?stage:'unknown_stage',errorCode:error?.message==='ARCHIVE_HOST_PACKAGE_REJECTED'?'CHECK_FAILED':fixedCode(error?.code),canary:canary&&Number.isInteger(canary.testsPassed)&&canary.testsPassed>=0&&canary.testsPassed<=10&&Number.isInteger(canary.formatsPassed)&&canary.formatsPassed>=0&&canary.formatsPassed<=7?{failureCode:fixedCode(canary.failureCode),testsPassed:canary.testsPassed,formatsPassed:canary.formatsPassed}:null});
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
