#!/usr/bin/env node
// Operator-owned execution. No model SDK, generated command, or shell is launched here.
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,open,unlink,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalCodes=new Set(['RUN_LEASE_LOST','RUN_CANCELLED','COORDINATION_AUTHORITY_ENDED','STUDIO_REVIEW_AUTHORITY_ENDED']);
// Failure of external execution is not evidence that replay is safe.
// Never copy arbitrary Error.message, code, stack, cause or CLI diagnostics.
const terminalClaudeFailures=new Set(['CLAUDE_REPLAY_UNSAFE','CLAUDE_CONFIGURATION','CLAUDE_CONTEXT_LIMIT','CLAUDE_TOOL_CATALOG','CLAUDE_START_FAILED','CLAUDE_CANCELLED','CLAUDE_TIMEOUT','CLAUDE_TOKEN_LIMIT','CLAUDE_OUTPUT_LIMIT','CLAUDE_PROTOCOL_INVALID','CLAUDE_MCP_UNAVAILABLE','CLAUDE_TOOL_SCOPE','CLAUDE_RESULT_INVALID','CLAUDE_TURN_LIMIT','CLAUDE_COST_LIMIT','CLAUDE_EXIT_FAILED']);
const inferenceFailureCodes=new Set(['INFERENCE_FAILED','INFERENCE_CANCELLED','INFERENCE_EXPIRED','INFERENCE_UNCERTAIN','INFERENCE_OUTPUT_INVALID','INFERENCE_VALIDATION_LIMIT','INFERENCE_PROTOCOL_REQUIRED','INFERENCE_CONTEXT_LIMIT','INFERENCE_DEADLINE','INFERENCE_HOST_UNAVAILABLE','INFERENCE_JOB_BUDGET','INFERENCE_LIMITS_INVALID','INFERENCE_MONEY_BUDGET','INFERENCE_PROVIDER_IDENTITY','INFERENCE_PROVIDER_UNCONFIRMED','INFERENCE_SEQUENCE','INFERENCE_SUBMISSION_UNCERTAIN','INFERENCE_TOKEN_BUDGET','INFERENCE_TOOL_MISMATCH','INFERENCE_TOOLS_PENDING','INFERENCE_UNAVAILABLE','INVALID_INFERENCE_RESPONSE','INVALID_INFERENCE_OUTPUT','NETWORK_ERROR']);
const diagnosticCodes=new Set(['ADAPTER_FAILED',...terminalClaudeFailures,...inferenceFailureCodes]);
function adapterFailure(error){
 let code;
 if(error&&typeof error==='object'){
  const own=key=>Object.getOwnPropertyDescriptor(error,key)?.value;
  if(own('name')==='ClaudeAdapterError'&&own('retryable')===false&&terminalClaudeFailures.has(own('code')))code=own('code');
  else if(error instanceof RuntimeError&&inferenceFailureCodes.has(own('code')))code=own('code');
 }
 return code?{code,retryable:false,error:code==='CLAUDE_TOKEN_LIMIT'?'Claude Code reached the configured cumulative token limit, including cached context. Review the run limits and any committed actions before creating a new request.':terminalClaudeFailures.has(code)?`Claude Code stopped (${code}). Review the configuration and any committed actions before creating a new request; automatic replay was disabled.`:`The agent stopped (${code}). Review the inference status and committed actions before creating a new request; automatic replay was disabled.`}:{code:'ADAPTER_FAILED',retryable:false,error:'The external adapter failed (ADAPTER_FAILED). Review the run actions and provider status before creating a new request; external effects may require reconciliation and automatic replay was disabled.'};
}
/** Only fixed codes, run identity and disposition may enter host diagnostics. */
export function workerDiagnostic(entry){
 if(!entry||typeof entry!=='object')return null;
 const own=key=>Object.getOwnPropertyDescriptor(entry,key)?.value,event=own('event');
 if(!['adapter-failed','failure-recorded','result-recorded','heartbeat-delayed'].includes(event))return null;
 const result={event},runId=own('runId'),code=own('code'),status=own('status');
 if(typeof runId==='string'&&UUID.test(runId))result.runId=runId;
 if(event==='adapter-failed')result.code=diagnosticCodes.has(code)?code:'ADAPTER_FAILED';
 if(['failure-recorded','result-recorded'].includes(event)&&['queued','running','succeeded','failed','cancelled'].includes(status))result.status=status;
 return result;
}
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
export function stableRequestId(runId,key){
 if(!UUID.test(runId)||typeof key!=='string'||!key||key.length>200)throw new Error('A run UUID and a nonempty logical operation key are required.');
 const bytes=Buffer.from(fingerprint(runId+'\0'+key).slice(0,32),'hex');bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function runtimeOrigin(value){
 let url;try{url=new URL(value);}catch{throw new Error('Use a valid Coatria HTTPS origin.');}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(local&&url.protocol==='http:')))throw new Error('Use a plain HTTPS Coatria origin; HTTP is allowed only on loopback.');
 return url.origin;
}
export class RuntimeError extends Error{
 constructor(status,code,retryAfter=0){super('Coatria request failed'+(status?' ('+status+')':'')+'.');this.status=status;this.code=typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'REQUEST_FAILED';this.retryAfter=retryAfter;}
}
export function pause(ms,signal){return new Promise((resolvePause,reject)=>{if(signal?.aborted)return reject(signal.reason);const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolvePause();},ms);signal?.addEventListener('abort',abort,{once:true});});}
async function untilStopped(operation,signal){
 signal.throwIfAborted();let abort;
 const stopped=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),stopped]);}finally{signal.removeEventListener('abort',abort);}
}
async function boundedJson(response,signal){
 const reader=response.body?.getReader();if(!reader)throw new RuntimeError(502,'INVALID_RESPONSE');let size=0;const chunks=[];
 try{while(true){const chunk=await untilStopped(()=>reader.read(),signal);if(chunk.done)break;size+=chunk.value.byteLength;if(size>1024*1024)throw new RuntimeError(502,'RESPONSE_TOO_LARGE');chunks.push(chunk.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RuntimeError(502,'INVALID_RESPONSE');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError(502,'INVALID_RESPONSE');return value;
}
/** @param {{token?:string,url?:string,fetch?:typeof globalThis.fetch,timeoutMs?:number,retryBaseMs?:number}} options */
export function createRuntimeClient({token=process.env.COATRIA_AGENT_TOKEN,url=process.env.COATRIA_URL||'https://coatria.com',fetch:transport=globalThis.fetch,timeoutMs=20000,retryBaseMs=300}={}){
 if(typeof token!=='string'||!/^ca_[A-Za-z0-9_-]{8,200}$/.test(token))throw new Error('Set a valid COATRIA_AGENT_TOKEN in the worker environment.');
 const origin=runtimeOrigin(url);
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new Error('Invalid request timeout.');
 async function request(path,{method='GET',body=undefined,signal=undefined,headers={}}={}){
  const target=new URL(path,origin);if(target.origin!==origin||!target.pathname.startsWith('/api/agent/')||target.username||target.password||target.hash)throw new Error('Only Coatria agent API paths are allowed.');
  const encoded=body===undefined?undefined:JSON.stringify(body),maxBytes=target.pathname.startsWith('/api/agent/tools/')?256*1024:65000;if(encoded&&Buffer.byteLength(encoded)>maxBytes)throw new RuntimeError(413,'REQUEST_TOO_LARGE');
  for(let attempt=0;;attempt++){
   signal?.throwIfAborted();let error;
   try{
    const deadline=AbortSignal.timeout(timeoutMs),active=signal?AbortSignal.any([signal,deadline]):deadline,response=await untilStopped(()=>transport(target,{method,redirect:'error',headers:{...headers,Authorization:'Bearer '+token,...(encoded===undefined?{}:{'Content-Type':'application/json'})},body:encoded,signal:active}),active);
    const data=await boundedJson(response,active);
    if(response.ok)return data;
    const retry=Number(response.headers.get('retry-after'));throw new RuntimeError(response.status,data.code,Number.isFinite(retry)&&retry>0?retry:0);
   }catch(caught){if(signal?.aborted)throw signal.reason;error=caught instanceof RuntimeError?caught:new RuntimeError(0,'NETWORK_ERROR');}
   if(attempt>=2||!(error.status===0||error.status===429||error.status>=500))throw error;
   const delay=error.retryAfter?error.retryAfter*1000:retryBaseMs*2**attempt;
   if(delay>10000)throw error;await pause(delay,signal);
  }
 }
 const runPath=runId=>{if(!UUID.test(runId))throw new Error('A run UUID is required.');return '/api/agent/runs/'+runId;};
 const post=(path,body,signal)=>request(path,{method:'POST',body,signal});
 return {origin,identity:fingerprint(token),
  readIdentity:signal=>request('/api/agent/identity',{signal}),
  autonomyTick:signal=>post('/api/agent/autonomy/tick',{},signal),
  claim:(workerId,claimId,signal)=>post('/api/agent/runs/claim',{workerId,claimId},signal),
  heartbeat:(runId,leaseToken,signal)=>post(runPath(runId)+'/heartbeat',{leaseToken},signal),
  context:(runId,leaseToken,signal)=>request(runPath(runId)+'/context',{headers:{'X-Coatria-Run-Lease':leaseToken},signal}),
  submitInference:(runId,{leaseToken,requestId,step,protocolVersion},signal)=>{if(!UUID.test(requestId)||!Number.isSafeInteger(step)||step<0||step>19||protocolVersion!==undefined&&protocolVersion!==2)throw new Error('A stable inference request UUID and bounded step are required.');return post(runPath(runId)+'/inference',{leaseToken,requestId,step,...protocolVersion===2?{protocolVersion}:{}},signal);},
  readInference:(runId,inferenceId,leaseToken,signal)=>{if(!UUID.test(inferenceId))throw new Error('An inference UUID is required.');return request(runPath(runId)+'/inference/'+inferenceId,{headers:{'X-Coatria-Run-Lease':leaseToken},signal});},
  cancelInference:(runId,inferenceId,{leaseToken,requestId},signal)=>{if(!UUID.test(inferenceId)||!UUID.test(requestId))throw new Error('Inference and cancellation UUIDs are required.');return post(runPath(runId)+'/inference/'+inferenceId+'/cancel',{leaseToken,requestId},signal);},
  complete:(runId,payload,signal)=>post(runPath(runId)+'/complete',payload,signal),
  fail:(runId,payload,signal)=>post(runPath(runId)+'/fail',payload,signal),
  listTools:signal=>request('/api/agent/tools',{signal}),
  /** @param {string} name @param {{runId:string,leaseToken:string,requestId:string,arguments:Record<string,any>,storageTransportVersion?:string}} payload @param {AbortSignal=} signal */
  callTool:(name,{runId,leaseToken,requestId,arguments:args,storageTransportVersion=undefined},signal)=>{
   if(typeof name!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(name)||!UUID.test(runId)||!UUID.test(requestId)||!args||typeof args!=='object'||Array.isArray(args))throw new Error('A named tool, run UUID, request UUID and arguments object are required.');
   if(storageTransportVersion!==undefined&&(storageTransportVersion!=='1'||!['storage_upload_reserve','storage_file_access'].includes(name)))throw new Error('Unsupported storage transport protocol or tool.');
   return request('/api/agent/tools/'+encodeURIComponent(name),{method:'POST',body:{runId,leaseToken,requestId,arguments:args},signal,headers:storageTransportVersion==='1'?{'X-Coatria-Storage-Transport':'1'}:{}});
  }};
}

// Only the trusted HTTP client can brand an inference result. Provider JSON,
// including objects with these same field names, never acquires this identity.
const brokerCompletions=new WeakSet();
export const isBrokerInferenceCompletion=value=>!!value&&typeof value==='object'&&brokerCompletions.has(value);
const inferenceObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const inferenceKeys=(value,required,optional=[])=>inferenceObject(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const feedbackCodes=new Set(['ARGUMENT_JSON_INVALID','ARGUMENT_SCHEMA_INVALID','STAFFING_VALIDATION_INVALID','BATCH_NOT_EXECUTED']);
const feedbackIssueCodes=new Set(['invalid_type','invalid_value','too_small','too_big','invalid_format','unrecognized_keys','custom','invalid_union','staffing_roles','staffing_identity','staffing_reviewer']);
const feedbackExpected=new Set(['string','number','integer','boolean','object','array','null']);
const inferenceName=/^[-a-zA-Z0-9_]{1,80}$/,inferenceCallId=/^[-a-zA-Z0-9_]{1,120}$/;
function brokerCompletion(item,runId,step){
 const invalid=()=>{throw new RuntimeError(502,'INVALID_INFERENCE_RESPONSE');};
 if(!['execute','validation_feedback'].includes(item.disposition)||!inferenceObject(item.output)||!inferenceKeys(item.usage,['promptTokens','completionTokens','totalTokens']))invalid();
 const usage=item.usage;
 if(![usage.promptTokens,usage.completionTokens].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=10000000)||usage.totalTokens!==usage.promptTokens+usage.completionTokens||item.output.usage?.prompt_tokens!==usage.promptTokens||item.output.usage?.completion_tokens!==usage.completionTokens)invalid();
 if(item.disposition==='execute'){if(Object.hasOwn(item,'validationFeedback'))invalid();}
 else{
  const feedback=item.validationFeedback;
  if(!inferenceKeys(feedback,['version','correction','calls'])||feedback.version!==1||!Number.isSafeInteger(feedback.correction)||feedback.correction<1||feedback.correction>2||!Array.isArray(feedback.calls)||feedback.calls.length<1||feedback.calls.length>8)invalid();
  const choices=item.output.choices,message=Array.isArray(choices)&&choices.length===1?choices[0]?.message:null;
  if(choices?.[0]?.finish_reason!=='tool_calls'||message?.role!=='assistant'||!Array.isArray(message.tool_calls)||message.tool_calls.length!==feedback.calls.length)invalid();
  const seen=new Set();let invalidCalls=0;
  for(const [index,call]of feedback.calls.entries()){
   if(!inferenceKeys(call,['id','name','requestId','response'])||typeof call.id!=='string'||!inferenceCallId.test(call.id)||seen.has(call.id)||typeof call.name!=='string'||!inferenceName.test(call.name)||call.requestId!==stableRequestId(runId,'provider:'+step+':'+call.id))invalid();
   seen.add(call.id);const raw=message.tool_calls[index];if(raw?.type!=='function'||raw.id!==call.id||raw.function?.name!==call.name)invalid();
   const response=call.response;if(!inferenceKeys(response,['version','executed','code','issues'])||response.version!==1||response.executed!==false||!feedbackCodes.has(response.code)||!Array.isArray(response.issues)||response.issues.length>12)invalid();
   if(response.code==='BATCH_NOT_EXECUTED'){if(response.issues.length)invalid();}else{invalidCalls++;if(!response.issues.length)invalid();}
   for(const issue of response.issues){
    if(!inferenceKeys(issue,['path','code'],['expected','allowed','minimum','maximum'])||!feedbackIssueCodes.has(issue.code)||!Array.isArray(issue.path)||issue.path.length>12||issue.path.some(part=>typeof part!=='string'||part!=='*'&&!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(part)))invalid();
    if(Object.hasOwn(issue,'expected')&&!feedbackExpected.has(issue.expected))invalid();
    if(Object.hasOwn(issue,'allowed')&&(!Array.isArray(issue.allowed)||issue.allowed.length>40||issue.allowed.some(value=>typeof value!=='string'||value.length>160)))invalid();
    for(const name of ['minimum','maximum'])if(Object.hasOwn(issue,name)&&(!Number.isFinite(issue[name])||issue[name]<0||issue[name]>1e9))invalid();
   }
  }
  if(!invalidCalls)invalid();
 }
 // Copy the bounded JSON before branding so the caller cannot mutate a raw
 // transport object later and turn rejected work into an executable batch.
 let result;try{const text=JSON.stringify({runId,step,inferenceId:item.id,output:item.output,disposition:item.disposition,usage,...item.disposition==='validation_feedback'?{validationFeedback:item.validationFeedback}:{}});if(Buffer.byteLength(text)>1048576)invalid();result=JSON.parse(text);}catch{invalid();}
 const freeze=value=>{if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}};freeze(result);brokerCompletions.add(result);return result;
}

/** A trusted adapter facility, never a model tool or provider configuration.
 * Only run identity, its live lease, the stable step key and step reach Coatria.
 * The server reconstructs all messages, tools, model settings and receipts.
 * @param {{client:any,runId:string,leaseToken:string,signal?:AbortSignal,pollMs?:number,cancelTimeoutMs?:number}} options
 */
export function createRunInferenceClient({client,runId,leaseToken,signal,pollMs=1000,cancelTimeoutMs=3000}){
 if(!UUID.test(runId)||typeof leaseToken!=='string'||!leaseToken||!Number.isSafeInteger(pollMs)||pollMs<0||pollMs>10000||!Number.isSafeInteger(cancelTimeoutMs)||cancelTimeoutMs<1||cancelTimeoutMs>3000)throw new Error('Invalid trusted inference client configuration.');
 return {
 /** @param {{step:number,requestId:string,signal?:AbortSignal,timeoutMs?:number}} options */
 async complete({step,requestId,signal:extra,timeoutMs=180000}){
  if(!Number.isSafeInteger(step)||step<0||step>19||requestId!==stableRequestId(runId,'inference:'+step)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Use the exact stable inference step key and bounded deadline.');
  const active=AbortSignal.any([AbortSignal.timeout(timeoutMs),...[signal,extra].filter(Boolean)]);let inferenceId,terminal=false;
  function inspect(value){
   const item=value?.inference;
   if(!item||item.protocolVersion!==2||!UUID.test(item.id)||item.runId!==runId||item.step!==step||inferenceId&&item.id!==inferenceId||!Number.isFinite(Date.parse(item.deadlineAt)))throw new RuntimeError(502,'INVALID_INFERENCE_RESPONSE');
   inferenceId=item.id;
   if(item.status==='succeeded'){terminal=true;if(!item.output||typeof item.output!=='object'||Array.isArray(item.output))throw new RuntimeError(502,'INVALID_INFERENCE_OUTPUT');return brokerCompletion(item,runId,step);}
   if(['failed','cancelled','expired'].includes(item.status)){terminal=true;const code=item.status==='failed'&&inferenceFailureCodes.has(item.errorCode)?item.errorCode:'INFERENCE_'+item.status.toUpperCase();throw new RuntimeError(409,code);}
   if(item.status==='uncertain')throw new RuntimeError(409,'INFERENCE_UNCERTAIN');
   if(!['submitting','queued','running','cancel_requested'].includes(item.status)||Object.hasOwn(item,'output'))throw new RuntimeError(502,'INVALID_INFERENCE_RESPONSE');
   if(Date.parse(item.deadlineAt)<=Date.now())throw new RuntimeError(409,'INFERENCE_EXPIRED');
   return null;
  }
  try{
   let output=inspect(await untilStopped(()=>client.submitInference(runId,{leaseToken,requestId,step,protocolVersion:2},active),active));if(output)return output;
   while(true){await pause(pollMs,active);output=inspect(await untilStopped(()=>client.readInference(runId,inferenceId,leaseToken,active),active));if(output)return output;}
  }finally{
   if(inferenceId&&!terminal){const cancellation=AbortSignal.timeout(cancelTimeoutMs);try{await untilStopped(()=>client.cancelInference(runId,inferenceId,{leaseToken,requestId:stableRequestId(runId,'inference-cancel:'+step)},cancellation),cancellation);}catch{/* Server deadlines/reconciliation also bound jobs when cancellation cannot be confirmed. */}}
  }
 }};
}

/** Private state stores lease credentials. Use one state file per worker. */
export async function openWorkerState(path,client){
 path=resolve(path);await mkdir(dirname(path),{recursive:true,mode:0o700});const lockPath=path+'.lock',lockId=randomUUID();
 async function acquire(){try{const handle=await open(lockPath,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,id:lockId}));await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;let lock;try{const info=await lstat(lockPath);if(!info.isFile()||info.isSymbolicLink())throw new Error();lock=JSON.parse(await readFile(lockPath,'utf8'));if(!Number.isInteger(lock.pid)||lock.pid<1)throw new Error();}catch{throw new Error('Worker state is locked; inspect the private lock file before restarting.');}try{process.kill(lock.pid,0);}catch(probe){if(probe.code==='ESRCH'){await unlink(lockPath);return acquire();}}throw new Error('Another worker owns this state file.');}}
 await acquire();
 const close=async()=>{try{const lock=JSON.parse(await readFile(lockPath,'utf8'));if(lock.id===lockId)await unlink(lockPath);}catch(error){if(error.code!=='ENOENT')throw error;}};
 try{
  let data;try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>512000)throw new Error('Invalid worker state file.');data=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Worker state is unreadable; keep it for recovery rather than overwriting it.');}
  data||={version:1,origin:client.origin,identity:client.identity,workerId:'worker-'+randomUUID(),claimId:null,job:null};
  if(data.version!==1||data.origin!==client.origin||data.identity!==client.identity||typeof data.workerId!=='string'||data.workerId.length>80)throw new Error('Worker state belongs to a different origin, credential or format.');
  let writing=Promise.resolve();
  const save=()=>{const bytes=JSON.stringify(data);if(Buffer.byteLength(bytes)>512000)throw new Error('Worker state exceeds its size limit.');writing=writing.then(async()=>{const temporary=path+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}});return writing;};
  await save();return {data,save,close};
 }catch(error){await close();throw error;}
}

function ended(error){return error instanceof RuntimeError&&(terminalCodes.has(error.code)||[401,403].includes(error.status));}
/** Only the owning worker queues due, explicitly enabled missions for its agent.
 * Scheduling is skipped until an uncertain claim or completion is reconciled.
 * The server atomically deduplicates due cycles; a transport retry is safe.
 */
export function createAutonomyTicker(client,{now=()=>performance.now(),intervalMs=60000}={}){
 if(!Number.isFinite(intervalMs)||intervalMs<60000)throw new Error('Autonomy polling must be at least one minute apart.');
 let lastTick=-Infinity,inFlight=false;
 return async(state,signal)=>{
  signal?.throwIfAborted();if(state.data.job||state.data.claimId||inFlight)return false;
  const current=now();if(!Number.isFinite(current)||current-lastTick<intervalMs)return false;
  lastTick=current;inFlight=true;
  try{await client.autonomyTick(signal);return true;}catch(error){if(error instanceof RuntimeError&&error.status===404)return false;throw error;}finally{inFlight=false;}
 };
}
/** Execute one durable claim. External execution failures are terminal;
 * only the same durable claim or outcome receipt may be reconciled on restart.
 * @param {{client:any,state:any,execute:(options:any)=>any,signal?:AbortSignal,heartbeatMs?:number,log?:(entry:Record<string,unknown>)=>void}} options
 */
export async function workOnce({client,state,execute,signal,heartbeatMs=15000,log=()=>{}}){
 const clear=async()=>{state.data.job=null;state.data.claimId=null;await state.save();};
 if(!state.data.claimId){state.data.claimId=randomUUID();await state.save();}
 if(!state.data.job){
  let claimed;try{claimed=await client.claim(state.data.workerId,state.data.claimId,signal);}catch(error){if(ended(error))await clear();throw error;}
  if(!claimed.run){await clear();return false;}
  if(!UUID.test(claimed.run.id)||typeof claimed.leaseToken!=='string'||!Number.isFinite(Date.parse(claimed.leaseExpiresAt)))throw new RuntimeError(502,'INVALID_CLAIM');
  state.data.job={run:claimed.run,leaseToken:claimed.leaseToken,leaseExpiresAt:claimed.leaseExpiresAt,started:false,outcome:null};await state.save();
 }
 const job=state.data.job;
 // A prior completion may already be committed. Reconcile it with its original
 // key even after local lease expiry; the server decides replay vs lease loss.
 if(job.outcome){try{await client[job.outcome.kind](job.run.id,job.outcome.payload,signal);await clear();return true;}catch(error){if(ended(error))await clear();throw error;}}
 const control=new AbortController(),stopHeartbeat=new AbortController();let expires=Date.parse(job.leaseExpiresAt),expiryTimer,heartbeatAfter=0;
 const externalAbort=()=>control.abort(signal.reason);if(signal?.aborted)externalAbort();else signal?.addEventListener('abort',externalAbort,{once:true});
 const arm=()=>{clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>control.abort(new RuntimeError(409,'RUN_LEASE_LOST')),Math.max(0,expires-Date.now()-1000));};arm();
 const heartbeat=(async()=>{while(!stopHeartbeat.signal.aborted&&!control.signal.aborted){try{const heartbeatSignal=AbortSignal.any([stopHeartbeat.signal,control.signal]);await pause(Math.max(heartbeatAfter-Date.now(),Math.min(heartbeatMs,Math.max(50,(expires-Date.now())/3))),heartbeatSignal);if(stopHeartbeat.signal.aborted||control.signal.aborted)return;const update=await client.heartbeat(job.run.id,job.leaseToken,heartbeatSignal);if(['cancelled','failed','succeeded'].includes(update.run?.status)){control.abort(new RuntimeError(409,update.run.status==='cancelled'?'RUN_CANCELLED':'RUN_LEASE_LOST'));return;}const next=Date.parse(update.leaseExpiresAt);if(!Number.isFinite(next))throw new RuntimeError(502,'INVALID_HEARTBEAT');expires=next;job.leaseExpiresAt=update.leaseExpiresAt;await state.save();arm();}catch(error){if(stopHeartbeat.signal.aborted||control.signal.aborted)return;if(ended(error)){control.abort(error);return;}if(error.retryAfter)heartbeatAfter=Date.now()+error.retryAfter*1000;log({event:'heartbeat-delayed',runId:job.run.id,code:error.code||'REQUEST_FAILED'});}}})();
 try{
  if(!job.outcome){
   const recovering=job.started;job.started=true;await state.save();const context=await client.context(job.run.id,job.leaseToken,control.signal);
   // Adapters may shorten a tool request with their own deadline, but cannot
   // detach it from lease cancellation. Aborted writes still require reconciliation.
   const toolSignal=extra=>extra?AbortSignal.any([control.signal,extra]):control.signal;
   const tools={storageTransportVersion:'1',key:key=>stableRequestId(job.run.id,key),list:({signal:extra}={})=>{const signal=toolSignal(extra);signal.throwIfAborted();return client.listTools(signal);},call:async(name,args,{requestId,signal:extra,storageTransportVersion}={})=>{const signal=toolSignal(extra);signal.throwIfAborted();if(!UUID.test(requestId||''))throw new Error('Pass a stable requestId, for example tools.key("logical-step").');const response=await client.callTool(name,{runId:job.run.id,leaseToken:job.leaseToken,requestId,arguments:args,...storageTransportVersion===undefined?{}:{storageTransportVersion}},signal);return response.result;}};
   const inference=createRunInferenceClient({client,runId:job.run.id,leaseToken:job.leaseToken,signal:control.signal});
   // Trusted adapter configuration is separate from model-visible run context.
   const mcpEnvironment={COATRIA_URL:client.origin,COATRIA_RUN_ID:job.run.id,COATRIA_RUN_LEASE:job.leaseToken};
   const execution=Promise.resolve().then(()=>{control.signal.throwIfAborted();return execute({run:context.run||job.run,context,tools,inference,signal:control.signal,recovering,mcpEnvironment});});
   let abortHandler;const aborted=new Promise((_,reject)=>{abortHandler=()=>reject(control.signal.reason);if(control.signal.aborted)abortHandler();else control.signal.addEventListener('abort',abortHandler,{once:true});});
   try{
    const result=await Promise.race([execution,aborted]);control.signal.throwIfAborted();
    if(!result||typeof result.result!=='string'||!result.result.trim()||result.result.length>12000)throw new Error('Adapter must return {result: nonempty text up to 12000 characters, artifactUrl?}.');
    if(result.artifactUrl!==undefined){const artifact=new URL(result.artifactUrl);if(!['https:','http:'].includes(artifact.protocol)||artifact.username||artifact.password)throw new Error('Adapter artifact URL is invalid.');}
    job.outcome={kind:'complete',payload:{leaseToken:job.leaseToken,clientId:randomUUID(),result:result.result,...(result.artifactUrl?{artifactUrl:result.artifactUrl}:{})}};
   }catch(error){if(control.signal.aborted||ended(error))throw error;const failure=adapterFailure(error);job.outcome={kind:'fail',payload:{leaseToken:job.leaseToken,clientId:randomUUID(),error:failure.error,...failure.retryable===false?{retryable:false}:{}}};log({event:'adapter-failed',runId:job.run.id,code:failure.code});}
   finally{control.signal.removeEventListener('abort',abortHandler);}
   await state.save();
  }
  stopHeartbeat.abort();await heartbeat;
  const result=await client[job.outcome.kind](job.run.id,job.outcome.payload,control.signal);
  log({event:job.outcome.kind==='complete'?'result-recorded':'failure-recorded',runId:job.run.id,status:result.run?.status||'unknown'});await clear();return true;
 }catch(error){if(ended(error)||control.signal.aborted&&ended(control.signal.reason)){await clear();}throw error;}
 finally{stopHeartbeat.abort();clearTimeout(expiryTimer);signal?.removeEventListener('abort',externalAbort);await heartbeat;}
}

async function main(){
 const {values}=parseArgs({options:{adapter:{type:'string'},state:{type:'string'},url:{type:'string'},once:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
 if(values.help){console.log('Usage: node agent-worker.mjs --adapter ./approved-adapter.mjs [--state PRIVATE_PATH] [--url https://coatria.com] [--once]\nSet COATRIA_AGENT_TOKEN privately. Adapter exports execute({run,context,tools,inference,signal,recovering}) and returns {result,artifactUrl?}. The trusted inference client uses server-approved model settings; it is never a model tool. No provider is installed or selected automatically.');return;}
 if(!values.adapter)throw new Error('Pass --adapter with an operator-approved local JavaScript module.');
 const client=createRuntimeClient({url:values.url});
 const path=values.state||join(homedir(),'.coatria','workers',fingerprint(client.origin+client.identity).slice(0,24)+'.json'),state=await openWorkerState(path,client),controller=new AbortController();
 const stop=()=>controller.abort(new Error('Worker stopped.'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const log=entry=>console.error(JSON.stringify(entry)),tick=createAutonomyTicker(client);
 try{const adapter=await import(pathToFileURL(resolve(values.adapter)).href);if(typeof adapter.execute!=='function')throw new Error('The adapter must export an execute function.');do{try{await tick(state,controller.signal);const worked=await workOnce({client,state,execute:adapter.execute,signal:controller.signal,log});if(values.once)return;if(!worked)await pause(3000,controller.signal);}catch(error){if(controller.signal.aborted)return;log({event:'worker-paused',code:error instanceof RuntimeError?error.code:'WORKER_ERROR',status:error instanceof RuntimeError?error.status:0});if(!(error instanceof RuntimeError)||[401,403].includes(error.status)||values.once)throw error;await pause(Math.max(3000,Math.min(300000,(error.retryAfter||0)*1000)),controller.signal);}}while(!controller.signal.aborted);}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await state.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Worker stopped. Check configuration and private state; credentials and server response bodies are not printed.');process.exitCode=1;});
