import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from './db';
import {authenticateAgent} from './integrations';
import {authorizeRunTool,authorizeStoredAgentRun,type AgentRunIdentity} from './agent-runs';
import {installedRuntimeContext} from './plugin-marketplace';
import {AGENT_TOOLS} from './agent-tools';
import {generatedFollowupRunContext} from './studio-generated-followups';
import {body,fail,hashToken,id,json,rateLimit,ApiError} from './security';
import {stableRequestId} from '../../public/downloads/agent-worker.mjs';
import {bridgePolicy,characterInstructions,normalize,usageTokens,modelContextResult,modelRequestContext} from '../../public/downloads/provider-adapter.mjs';
import {studioInferenceSubmitInput,studioInferenceCancelInput,studioInferenceLeaseInput,studioInferenceConfigInput,type StudioInference} from './studio-inference-protocol';
import {assertInferenceJsonSafe,validateInferenceArguments} from './studio-inference-validation';

type Row=Record<string,any>;
export type StudioInferenceDependencies={fetch?:typeof fetch;transaction?:typeof transaction;requestTimeoutMs?:number;reconcileTimeoutMs?:number};
const terminal=new Set(['succeeded','failed','cancelled','expired']),providerId=/^[-a-zA-Z0-9]{1,160}$/;
const plain=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function canonical(v:unknown):string{return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);}
const digest=(v:unknown)=>hashToken(canonical(v));
function bounded(v:unknown,max=1048576){const text=JSON.stringify(v);if(typeof text!=='string'||Buffer.byteLength(text)>max)fail(413,'Inference context exceeds its approved size.','INFERENCE_CONTEXT_LIMIT');return text;}
const parse=<T>(schema:z.ZodType<T>,input:unknown)=>{const p=schema.safeParse(input);if(!p.success)fail(400,'Use the exact bounded inference request fields.','VALIDATION_ERROR');return p.data;};
async function control(client:PoolClient,companyId:string){await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[companyId]);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-cpu-control:${companyId}`]);}
export async function studioInferenceReserved(client:PoolClient,companyId:string){return Number((await client.query('SELECT COALESCE(sum(amount_microusd),0) AS amount FROM studio_inference_reservations WHERE company_id=$1',[companyId])).rows[0].amount);}
export function studioInferenceConfigured(){return typeof process.env.MANAGED_RUNPOD_API_KEY==='string'&&process.env.MANAGED_RUNPOD_API_KEY.length>=8;}
function projection(row:Row,includeOutput=true):StudioInference{
 const v2=row.limits?.protocolVersion===2,completed=includeOutput&&row.status==='succeeded',feedback=completed&&row.model_calls.some((call:Row)=>call.disposition==='validation_error');
 return plain({id:row.id,runId:row.run_id,step:row.step,status:row.status,createdAt:row.created_at,deadlineAt:row.deadline_at,errorCode:row.error_code,reservedTokens:row.reserved_tokens,usedTokens:row.used_tokens,billingVerified:false,...v2?{protocolVersion:2}:{},...completed?{output:row.output,...v2?{disposition:feedback?'validation_feedback':'execute',usage:{promptTokens:row.output.usage.prompt_tokens,completionTokens:row.output.usage.completion_tokens,totalTokens:row.used_tokens},...feedback?{validationFeedback:{version:1,correction:row.model_calls[0].correction,calls:row.model_calls.map((call:Row)=>({id:call.id,name:call.name,requestId:stableRequestId(row.run_id,'provider:'+row.step+':'+call.id),response:call.feedback}))}}:{}}:{}}:{}});
}
const argumentHash=(call:Row)=>call.argumentEncoding==='raw'?hashToken('raw:'+call.args):digest(call.args);
function identityOf(row:Row):AgentRunIdentity{return{id:row.agent_id,company_id:row.company_id,created_by:row.agent_sponsor_id,token_hash:row.agent_token_hash};}
async function binding(client:PoolClient,identity:AgentRunIdentity,installation:any){
 const row=(await client.query(`SELECT h.id AS host_id,h.expires_at AS host_expires_at,p.id AS provision_id,p.preset,p.plan_hash,p.expires_at AS provision_expires_at,c.configuration,c.configuration_hash FROM agents a JOIN studio_host_credentials c ON c.company_id=a.company_id AND c.agent_id=a.id AND c.token_hash=a.token_hash JOIN studio_managed_hosts h ON h.company_id=c.company_id AND h.id=c.host_id JOIN studio_host_provisions p ON p.company_id=h.company_id AND p.host_id=h.id WHERE a.company_id=$1 AND a.id=$2 AND a.token_hash=$3 AND a.managed_token_hash=a.token_hash AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND h.status='active' AND h.expires_at>clock_timestamp() AND h.lease_expires_at>clock_timestamp() AND h.lease_epoch=c.host_epoch AND c.installation_id=$4 AND c.installation_revision=$5 AND p.phase IN ('provisioning','running') AND p.stop_requested_at IS NULL AND p.expires_at>clock_timestamp()`,[identity.company_id,identity.id,identity.token_hash,installation.id,installation.revision])).rows[0];
 if(!row||installation.pluginId!=='runpod'||installation.runtimeConfig.providerId!=='runpod')fail(403,'This exact leased managed host has no approved inference broker.','INFERENCE_HOST_UNAVAILABLE');
 const config=studioInferenceConfigInput.safeParse(row.preset.inference);if(!config.success||!providerId.test(row.preset.endpointId)||row.preset.modelId!==installation.runtimeConfig.modelId)fail(403,'The managed host did not approve this inference transport or model.','INFERENCE_HOST_UNAVAILABLE');
 const current=(await client.query('SELECT name,created_by,capabilities,invocation_access,conversation_access FROM agents WHERE company_id=$1 AND id=$2',[identity.company_id,identity.id])).rows[0];
 const exact={installationId:installation.id,pluginId:installation.pluginId,manifestVersion:installation.manifestVersion,runtimeConfig:installation.runtimeConfig,character:installation.character,name:current.name,agentSponsorId:current.created_by,capabilities:current.capabilities,invocationAccess:current.invocation_access,conversationAccess:current.conversation_access};
 if(digest(exact)!==row.configuration_hash||digest(row.configuration)!==row.configuration_hash)fail(403,'The enrolled agent configuration changed.','INFERENCE_HOST_UNAVAILABLE');return{...row,inference:config.data};
}
async function authority(client:PoolClient,identity:AgentRunIdentity,runId:string,proof:string,stored=false){await control(client,identity.company_id);const access=stored?await authorizeStoredAgentRun(client,identity,runId,proof):await authorizeRunTool(client,identity,runId,proof),installation=await installedRuntimeContext(client,identity.company_id,identity.id);if(!installation)fail(403,'An installed managed runtime is required.','INFERENCE_HOST_UNAVAILABLE');return{...access,installation,host:await binding(client,identity,installation)};}
export async function buildStudioInferenceRequest(client:PoolClient,access:Row){
 const run=access.run,generatedFollowup=await generatedFollowupRunContext(client,run.company_id,run.id);
 if(!generatedFollowup)await client.query('SELECT id FROM conversations WHERE company_id=$1 AND id=$2 FOR SHARE',[run.company_id,run.conversation_id]);
 const messages=generatedFollowup||run.purpose==='connection_test'?[]:(await client.query(`SELECT m.id,m.body,m.parent_id AS "parentId",m.sequence::text AS sequence,m.deleted_at AS "deletedAt",m.actor_kind AS "actorKind",COALESCE(m.user_id,m.agent_id) AS "actorId",COALESCE(u.name,a.name,'Former teammate') AS "authorName" FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.company_id=m.company_id AND a.id=m.agent_id WHERE m.company_id=$1 AND m.conversation_id=$2 AND (($3::uuid IS NULL AND m.parent_id IS NULL) OR m.id=$3 OR m.parent_id=$3) ORDER BY (m.id=$3) DESC NULLS LAST,m.sequence DESC LIMIT 30`,[run.company_id,run.conversation_id,run.parent_id])).rows.sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1);
 const tools=Object.entries(AGENT_TOOLS).filter(([,tool])=>access.capabilities.includes(tool.capability)).map(([name,tool])=>({type:'function',function:{name,description:tool.description,parameters:z.toJSONSchema(tool.schema,{io:'input',unrepresentable:'any'})}}));
 return{model:access.installation.runtimeConfig.modelId,messages:[{role:'system',content:bridgePolicy+characterInstructions(access.installation)},{role:'user',content:bounded(modelRequestContext(run,{messages,...generatedFollowup?{generatedFollowup}:{}}),300000)}],...(tools.length?{tools}:{}),max_tokens:0,stream:false};
}
function effectiveLimits(access:Row){const p=access.host.preset,r=access.installation.runtimeConfig;const limits={maxSteps:Math.min(r.maxSteps??8,p.maxSteps,20),maxOutputTokens:Math.min(r.maxOutputTokens??2048,p.maxOutputTokens,8192),maxTotalTokens:Math.min(r.maxTotalTokens??24000,p.maxTotalTokens,100000),timeoutSeconds:Math.min(r.timeoutSeconds??180,p.timeoutSeconds,600)};if(Object.values(limits).some(v=>!Number.isSafeInteger(v)||v<1))fail(409,'The approved inference limits are invalid.','INFERENCE_LIMITS_INVALID');return limits;}
async function nextBody(client:PoolClient,prior:Row){
 if(prior.status!=='succeeded'||!Array.isArray(prior.model_calls)||!prior.model_calls.length)fail(409,'The previous reasoning step has not requested more tools.','INFERENCE_SEQUENCE');
 const normalized=normalize(prior.output,'chat'),request=plain(prior.request_body);request.messages.push(normalized.continuation);
 for(const call of prior.model_calls){const requestId=stableRequestId(prior.run_id,'provider:'+prior.step+':'+call.id),receipt=(await client.query('SELECT tool,arguments_hash,response FROM studio_inference_tool_receipts WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND inference_id=$4 AND request_id=$5',[prior.company_id,prior.agent_id,prior.run_id,prior.id,requestId])).rows[0];if(!receipt||receipt.tool!==call.name||receipt.arguments_hash!==argumentHash(call)||call.disposition&&call.disposition!=='execute'&&digest(receipt.response)!==digest(call.feedback))fail(409,'Complete every exact model-requested tool action before the next inference step.','INFERENCE_TOOLS_PENDING');request.messages.push({role:'tool',tool_call_id:call.id,content:bounded(call.disposition&&call.disposition!=='execute'?receipt.response:modelContextResult(call.name,receipt.response),262144)});}
 return request;
}
export async function submitStudioInference(identity:AgentRunIdentity,runId:string,input:unknown){
 const data=parse(studioInferenceSubmitInput,input);id(runId);return transaction(async client=>{const access=await authority(client,identity,runId,data.leaseToken),requestHash=digest({runId,step:data.step,...data.protocolVersion?{protocolVersion:data.protocolVersion}:{}});
  const old=(await client.query('SELECT * FROM studio_inference_jobs WHERE company_id=$1 AND agent_id=$2 AND request_id=$3',[identity.company_id,identity.id,data.requestId])).rows[0];if(old){if(old.run_id!==runId||old.request_hash!==requestHash||old.lease_token_hash!==hashToken(data.leaseToken))fail(409,'This inference key belongs to a different request or lease.','IDEMPOTENCY_CONFLICT');return{inference:projection(old),replayed:true};}
  const steps=(await client.query('SELECT * FROM studio_inference_jobs WHERE company_id=$1 AND run_id=$2 ORDER BY step',[identity.company_id,runId])).rows;
  if(steps.some(row=>(row.limits.protocolVersion??1)!==(data.protocolVersion??1)))fail(409,'Continue with this run’s pinned inference protocol.','INFERENCE_PROTOCOL_REQUIRED');
  const same=steps.find(row=>row.step===data.step);if(same){if(same.lease_token_hash!==hashToken(data.leaseToken))fail(409,'This inference belongs to another lease.','RUN_LEASE_LOST');return{inference:projection(same),replayed:true};}
  const limits={...effectiveLimits(access),...data.protocolVersion?{protocolVersion:2,maxValidationCorrections:2}:{}};if(data.step!==steps.length||data.step>=limits.maxSteps||steps.some(row=>row.status!=='succeeded'))fail(409,'The next exact completed reasoning step is required within the run limit.','INFERENCE_SEQUENCE');
  if(!studioInferenceConfigured())fail(503,'Server-managed inference is not configured.','INFERENCE_UNAVAILABLE');
  const request:any=steps.length?await nextBody(client,steps.at(-1)!):await buildStudioInferenceRequest(client,access);request.max_tokens=limits.maxOutputTokens;
  const reservedTokens=Buffer.byteLength(bounded(request))+limits.maxOutputTokens+1024;if(steps.reduce((sum,row)=>sum+(row.status==='succeeded'&&Number.isSafeInteger(row.used_tokens)?row.used_tokens:row.reserved_tokens),0)+reservedTokens>limits.maxTotalTokens)fail(409,'The run reached its cumulative inference token allowance.','INFERENCE_TOKEN_BUDGET');
  const deadline=Math.min(+new Date(access.run.started_at)+limits.timeoutSeconds*1000,+new Date(access.host.host_expires_at),+new Date(access.host.provision_expires_at),steps.length?+new Date(steps[0].deadline_at):Infinity),remaining=deadline-Date.now();if(remaining<10000)fail(409,'There is insufficient approved run time for another inference request.','INFERENCE_DEADLINE');
  const jobs=Number((await client.query('SELECT count(*) AS count FROM studio_inference_jobs WHERE company_id=$1 AND provision_id=$2',[identity.company_id,access.host.provision_id])).rows[0].count);if(jobs>=access.host.inference.maxJobs)fail(409,'This host reached its approved inference job limit.','INFERENCE_JOB_BUDGET');
  const amount=Math.ceil(access.host.inference.maxHourlyMicrousd*(remaining/1000+60)/3600);if(await studioInferenceReserved(client,identity.company_id)+amount>access.host.inference.lifetimeAllowanceMicrousd)fail(409,'The company inference allowance is fully reserved.','INFERENCE_MONEY_BUDGET');
  const row=(await client.query(`INSERT INTO studio_inference_jobs(company_id,agent_id,run_id,host_id,provision_id,request_id,step,request_hash,agent_sponsor_id,agent_token_hash,lease_token_hash,installation_id,installation_revision,preset_hash,endpoint_id,model_id,limits,request_body,reserved_tokens,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[identity.company_id,identity.id,runId,access.host.host_id,access.host.provision_id,data.requestId,data.step,requestHash,identity.created_by,identity.token_hash,hashToken(data.leaseToken),access.installation.id,access.installation.revision,access.host.plan_hash,access.host.preset.endpointId,access.installation.runtimeConfig.modelId,JSON.stringify(limits),JSON.stringify(request),reservedTokens,new Date(deadline).toISOString()])).rows[0];
  await client.query('INSERT INTO studio_inference_reservations(company_id,inference_id,provision_id,amount_microusd) VALUES($1,$2,$3,$4)',[identity.company_id,row.id,row.provision_id,amount]);return{inference:projection(row),replayed:false};
 });
}
async function scopedJob(client:PoolClient,identity:AgentRunIdentity,runId:string,inferenceId:string,leaseToken:string){await authority(client,identity,runId,leaseToken);const row=(await client.query('SELECT * FROM studio_inference_jobs WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND id=$4',[identity.company_id,identity.id,id(runId),id(inferenceId)])).rows[0];if(!row)fail(404,'Inference request not found.');if(row.lease_token_hash!==hashToken(leaseToken)||row.agent_token_hash!==identity.token_hash)fail(409,'This inference belongs to a different lease.','RUN_LEASE_LOST');return row;}
export async function readStudioInference(identity:AgentRunIdentity,runId:string,inferenceId:string,leaseToken:string){parse(studioInferenceLeaseInput,{leaseToken});return transaction(async client=>({inference:projection(await scopedJob(client,identity,runId,inferenceId,leaseToken))}));}
export async function cancelStudioInference(identity:AgentRunIdentity,runId:string,inferenceId:string,input:unknown){const data=parse(studioInferenceCancelInput,input);return transaction(async client=>{const row=await scopedJob(client,identity,runId,inferenceId,data.leaseToken);const other=(await client.query('SELECT id FROM studio_inference_jobs WHERE company_id=$1 AND agent_id=$2 AND cancel_request_id=$3',[identity.company_id,identity.id,data.requestId])).rows[0];if(other&&other.id!==row.id)fail(409,'This cancellation key belongs to another inference request.','IDEMPOTENCY_CONFLICT');if(terminal.has(row.status)||row.cancel_requested_at)return{inference:projection(row),replayed:true};const saved=(await client.query("UPDATE studio_inference_jobs SET status='cancel_requested',cancel_requested_at=clock_timestamp(),cancel_request_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,data.requestId])).rows[0];return{inference:projection(saved),replayed:false};});}

/** Called after ordinary tool authorization while the caller owns the run lock.
 * Never acquire CPU control here: doing so would invert admission's lock order.
 */
export async function assertStudioInferenceTool(client:PoolClient,identity:Record<string,any>,runId:string,requestId:string,name:string,rawArguments:unknown){
 const evidence=(await client.query('SELECT j.run_id,j.step,j.model_calls FROM studio_inference_tool_receipts t JOIN studio_inference_jobs j ON j.company_id=t.company_id AND j.agent_id=t.agent_id AND j.run_id=t.run_id AND j.id=t.inference_id WHERE t.company_id=$1 AND t.agent_id=$2 AND t.request_id=$3',[identity.company_id,identity.id,requestId])).rows[0];
 if(evidence?.model_calls.some((call:Row)=>call.disposition&&call.disposition!=='execute'&&stableRequestId(evidence.run_id,'provider:'+evidence.step+':'+call.id)===requestId))fail(409,'A server-recorded nonexecution key cannot execute a tool.','INFERENCE_TOOL_MISMATCH');
 const latest=(await client.query('SELECT j.id,j.agent_id,j.agent_token_hash,j.lease_token_hash,j.step,j.status,j.model_calls,j.deadline_at>clock_timestamp() AS deadline_live,j.cancel_requested_at,r.lease_token_hash AS current_lease_token_hash FROM studio_inference_jobs j JOIN agent_runs r ON r.company_id=j.company_id AND r.id=j.run_id WHERE j.company_id=$1 AND j.run_id=$2 ORDER BY j.step DESC LIMIT 1',[identity.company_id,runId])).rows[0];
 if(!latest)return; // Direct harnesses retain their ordinary tool authority.
 const call=latest.model_calls.find((call:Row)=>stableRequestId(runId,'provider:'+latest.step+':'+call.id)===requestId);
 if(latest.agent_id!==identity.id||latest.agent_token_hash!==identity.token_hash||latest.lease_token_hash!==latest.current_lease_token_hash||latest.status!=='succeeded'||latest.cancel_requested_at||!latest.deadline_live||!call||call.disposition&&call.disposition!=='execute'||call.name!==name||argumentHash(call)!==digest(rawArguments))fail(409,'Only an exact executable call from the current inference batch may use this tool.','INFERENCE_TOOL_MISMATCH');
}
export async function recordStudioInferenceToolReceipt(client:PoolClient,identity:Record<string,any>,runId:string,requestId:string,name:string,rawArguments:unknown,result:unknown):Promise<unknown>{
 await assertStudioInferenceTool(client,identity,runId,requestId,name,rawArguments);
 const steps=(await client.query("SELECT id,step,model_calls FROM studio_inference_jobs WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND status='succeeded' ORDER BY step",[identity.company_id,identity.id,runId])).rows;
 let match:Row|undefined;for(const step of steps)for(const call of step.model_calls)if(stableRequestId(runId,'provider:'+step.step+':'+call.id)===requestId)match={inferenceId:step.id,...call};if(!match)return result;
 if(match.name!==name||digest(rawArguments)!==digest(match.args))fail(409,'This tool receipt does not match the exact model request.','INFERENCE_TOOL_MISMATCH');const projected=modelContextResult(name,result);bounded(projected,262144);
 const old=(await client.query('SELECT run_id,inference_id,tool,arguments_hash,response FROM studio_inference_tool_receipts WHERE company_id=$1 AND agent_id=$2 AND request_id=$3',[identity.company_id,identity.id,requestId])).rows[0];if(old){if(old.run_id!==runId||old.inference_id!==match.inferenceId||old.tool!==name||old.arguments_hash!==digest(rawArguments))fail(409,'This tool evidence key changed.','INFERENCE_TOOL_MISMATCH');return result;}
 await client.query('INSERT INTO studio_inference_tool_receipts(company_id,agent_id,run_id,inference_id,request_id,tool,arguments_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[identity.company_id,identity.id,runId,match.inferenceId,requestId,name,digest(rawArguments),JSON.stringify(projected)]);return result;
}

function untilAborted<T>(call:()=>Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??new Error('Inference request expired'));signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(call).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
async function provider(path:string,method:string,payload:unknown,transport:typeof fetch,signal:AbortSignal,timeoutMs=10000){signal=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);if(!studioInferenceConfigured())fail(503,'Server inference is unavailable.','INFERENCE_UNAVAILABLE');const response=await untilAborted(()=>transport('https://api.runpod.ai/v2/'+path,{method,headers:{Authorization:'Bearer '+process.env.MANAGED_RUNPOD_API_KEY,...payload===undefined?{}:{'Content-Type':'application/json'}},...payload===undefined?{}:{body:bounded(payload)},redirect:'error',cache:'no-store',signal}),signal);if(!response.ok){void response.body?.cancel().catch(()=>{});fail(503,'Provider inference state was not confirmed.','INFERENCE_PROVIDER_UNCONFIRMED');}const reader=response.body?.getReader();if(!reader)fail(503,'Empty provider result.','INFERENCE_PROVIDER_UNCONFIRMED');const chunks:Uint8Array[]=[];let size=0;for(;;){let part:ReadableStreamReadResult<Uint8Array>;try{part=await untilAborted(()=>reader.read(),signal);}catch(error){void reader.cancel().catch(()=>{});throw error;}if(part.done)break;size+=part.value.length;if(size>1048576){void reader.cancel().catch(()=>{});fail(503,'Provider result is too large.','INFERENCE_PROVIDER_UNCONFIRMED');}chunks.push(part.value);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail(503,'Invalid provider result.','INFERENCE_PROVIDER_UNCONFIRMED');}}
type CompletionFailureReason='provider_error'|'response_shape'|'response_size'|'normalization'|'usage'|'output_limits'|'tool_count'|'tool_identity'|'tool_name'|'tool_arguments_json'|'tool_arguments_schema';
function completion(row:Row,job:Row){
 if(!job||typeof job.id!=='string'||!providerId.test(job.id)||row.provider_job_id&&row.provider_job_id!==job.id)fail(503,'Provider job identity changed.','INFERENCE_PROVIDER_IDENTITY');
 if(job.status==='COMPLETED'){
  let reason:CompletionFailureReason='provider_error';
  try{
   if(job.error)fail(503,'Provider completion contains an error.','INFERENCE_OUTPUT_INVALID');
   reason='response_shape';const output=Array.isArray(job.output)?job.output.length===1?job.output[0]:null:job.output;
   if(!output||typeof output!=='object'||Array.isArray(output))fail(503,'Provider output is not an object.','INFERENCE_OUTPUT_INVALID');
   reason='provider_error';if(output.error)fail(503,'Provider output contains an error.','INFERENCE_OUTPUT_INVALID');
   reason='response_size';bounded(output);assertInferenceJsonSafe(output);
   reason='normalization';const normalized=normalize(output,'chat');
   reason='usage';const used=usageTokens(output,'chat');
   reason='output_limits';if(output.usage.completion_tokens>row.limits.maxOutputTokens||used>row.reserved_tokens||!normalized.calls.length&&(!normalized.text||normalized.text.length>12000))fail(503,'Provider result exceeds the approved output limits.','INFERENCE_OUTPUT_INVALID');
   reason='tool_count';const priorCalls=row.request_body.messages.flatMap((message:Row)=>message.role==='assistant'&&Array.isArray(message.tool_calls)?message.tool_calls:[]);if(normalized.calls.length>8||priorCalls.length+normalized.calls.length>64)fail(503,'The run tool-call allowance was exceeded.','INFERENCE_OUTPUT_INVALID');
   const allowed=new Set((row.request_body.tools??[]).map((tool:any)=>tool.function.name)),seen=new Set(priorCalls.map((call:Row)=>call.id)),calls:any[]=[];
   for(const raw of normalized.calls){
    reason='tool_identity';if(typeof raw.id!=='string'||!/^[-a-zA-Z0-9_]{1,120}$/.test(raw.id)||seen.has(raw.id))fail(503,'Provider requested an invalid or duplicate tool identity.','INFERENCE_OUTPUT_INVALID');seen.add(raw.id);
    reason='tool_name';if(!allowed.has(raw.name)||!AGENT_TOOLS[raw.name])fail(503,'Provider requested an unsupported tool.','INFERENCE_OUTPUT_INVALID');
    if(row.limits.protocolVersion===2){
     reason='tool_arguments_schema';const checked=validateInferenceArguments(raw.name,AGENT_TOOLS[raw.name].schema,raw.args);
     calls.push({id:raw.id,name:raw.name,args:checked.args,argumentEncoding:checked.argumentEncoding,disposition:checked.validation?'validation_error':'execute',...checked.validation?{feedback:checked.validation}:{}});
    }else{
     reason='tool_arguments_json';let args=raw.args;if(typeof args==='string')args=JSON.parse(args);assertInferenceJsonSafe(args);
     reason='tool_arguments_schema';if(!AGENT_TOOLS[raw.name].schema.safeParse(args).success)fail(503,'Provider tool arguments are outside the approved schema.','INFERENCE_OUTPUT_INVALID');
     calls.push({id:raw.id,name:raw.name,args});
    }
   }
   // No execution receipt is admitted until every identity and every argument
   // was checked. One rejected argument suppresses the entire sibling batch.
   if(calls.some(call=>call.disposition==='validation_error'))for(const call of calls)if(call.disposition==='execute'){call.disposition='batch_not_executed';call.feedback={version:1,executed:false,code:'BATCH_NOT_EXECUTED',issues:[]};}
   return{status:'succeeded',output,calls,used};
  }catch{
   // Only fixed categories and database identities enter server diagnostics.
   // Never retain output, tool names/arguments, provider errors or parser text.
   console.warn(JSON.stringify({event:'studio_inference_output_invalid',inferenceId:row.id,runId:row.run_id,step:row.step,reason}));
   // A matching provider job is terminal. Keep its reservation, but do not
   // poll it as an ambiguous transport failure or submit another paid request.
   return{status:'failed',output:null,calls:[],used:null,error:'INFERENCE_OUTPUT_INVALID'};
  }
 }
 if(['IN_QUEUE','IN_PROGRESS','FAILED','CANCELLED','TIMED_OUT'].includes(job.status))return{status:({IN_QUEUE:'queued',IN_PROGRESS:'running',FAILED:'failed',CANCELLED:'cancelled',TIMED_OUT:'expired'} as Record<string,string>)[job.status],output:null,calls:[],used:null};fail(503,'Provider returned an unsupported job state.','INFERENCE_PROVIDER_UNCONFIRMED');}
export async function reconcileStudioInferenceJob(inferenceId:string,dependencies:StudioInferenceDependencies={}){
 id(inferenceId);const tx=dependencies.transaction??transaction,transport=dependencies.fetch??fetch,leaseId=randomUUID(),signal=AbortSignal.timeout(Math.max(1,Math.min(25000,dependencies.reconcileTimeoutMs??25000))),requestTimeout=Math.max(1,Math.min(10000,dependencies.requestTimeoutMs??10000));
 const row=await tx(async client=>{const found=(await client.query('SELECT * FROM studio_inference_jobs WHERE id=$1',[inferenceId])).rows[0];if(!found)fail(404,'Inference request not found.');await control(client,found.company_id);let valid=true;try{const access=await authority(client,identityOf(found),found.run_id,found.lease_token_hash,true);if(access.host.provision_id!==found.provision_id||access.installation.revision!==found.installation_revision)valid=false;}catch(error){if(error instanceof ApiError&&[401,403,404,409].includes(error.status))valid=false;else throw error;}
  const current=(await client.query('SELECT * FROM studio_inference_jobs WHERE id=$1 FOR UPDATE',[inferenceId])).rows[0];if(terminal.has(current.status)||current.poll_lease_expires_at&&+new Date(current.poll_lease_expires_at)>Date.now())return null;
  if(!valid||+new Date(current.deadline_at)<=Date.now())current.cancel_requested_at=current.cancel_requested_at??new Date();await client.query("UPDATE studio_inference_jobs SET poll_lease_id=$2,poll_lease_expires_at=clock_timestamp()+interval '35 seconds',cancel_requested_at=$3 WHERE id=$1",[inferenceId,leaseId,current.cancel_requested_at]);return current;});
 if(!row)return{skipped:true};
 const save=async(update:Row)=>tx(async client=>{
  await control(client,row.company_id);let valid=true;
  try{const access=await authority(client,identityOf(row),row.run_id,row.lease_token_hash,true);if(access.host.provision_id!==row.provision_id||access.installation.revision!==row.installation_revision)valid=false;}catch(error){if(error instanceof ApiError&&[401,403,404,409].includes(error.status))valid=false;else throw error;}
  const current=(await client.query('SELECT *,poll_lease_expires_at>clock_timestamp() AS poll_lease_live FROM studio_inference_jobs WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(current.poll_lease_id!==leaseId||!current.poll_lease_live)return{skipped:true};
  if(!valid||+new Date(current.deadline_at)<=Date.now()){current.cancel_requested_at=current.cancel_requested_at??new Date();await client.query('UPDATE studio_inference_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()) WHERE id=$1',[row.id]);}
  if(current.cancel_requested_at&&!['cancelled','expired'].includes(update.status))update={status:terminal.has(update.status)?'cancelled':'cancel_requested',providerId:update.providerId,error:update.error};
  if(update.status==='succeeded'&&update.calls?.some((call:Row)=>call.disposition==='validation_error')){
   const history=(await client.query('SELECT id,model_calls FROM studio_inference_jobs WHERE company_id=$1 AND run_id=$2 AND id<>$3',[row.company_id,row.run_id,row.id])).rows;
   const correction=history.filter(step=>step.model_calls.some((call:Row)=>call.disposition==='validation_error')).length+1;
   if(current.limits.protocolVersion!==2||current.limits.maxValidationCorrections!==2||correction>2)update={status:'failed',providerId:update.providerId,used:update.used,error:'INFERENCE_VALIDATION_LIMIT'};
   else for(const call of update.calls){
    call.correction=correction;
    const requestId=stableRequestId(row.run_id,'provider:'+row.step+':'+call.id),argumentsHash=argumentHash(call);bounded(call.feedback,262144);
    const old=(await client.query('SELECT run_id,inference_id,tool,arguments_hash,response FROM studio_inference_tool_receipts WHERE company_id=$1 AND agent_id=$2 AND request_id=$3',[row.company_id,row.agent_id,requestId])).rows[0];
    if(old){if(old.run_id!==row.run_id||old.inference_id!==row.id||old.tool!==call.name||old.arguments_hash!==argumentsHash||digest(old.response)!==digest(call.feedback))fail(409,'The exact server validation receipt changed.','INFERENCE_TOOL_MISMATCH');}
    else await client.query('INSERT INTO studio_inference_tool_receipts(company_id,agent_id,run_id,inference_id,request_id,tool,arguments_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[row.company_id,row.agent_id,row.run_id,row.id,requestId,call.name,argumentsHash,JSON.stringify(call.feedback)]);
   }
  }
  // Receipt persistence can wait on storage or locks. Recheck current run and
  // host authority afterward, while this transaction can still roll every
  // feedback receipt back. A failed final predicate must throw, never commit
  // partial receipts with a skipped completion.
  if(update.status==='succeeded'){
   const access=await authority(client,identityOf(row),row.run_id,row.lease_token_hash,true);
   if(access.host.provision_id!==row.provision_id||access.installation.revision!==row.installation_revision)fail(409,'The inference completion authority ended.','INFERENCE_SAVE_AUTHORITY_ENDED');
  }
  const saved=(await client.query(`UPDATE studio_inference_jobs j SET status=$2,provider_job_id=COALESCE($3,provider_job_id),output=$4,model_calls=$5,used_tokens=$6,error_code=$7,poll_lease_id=NULL,poll_lease_expires_at=NULL,last_reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE j.id=$1 AND j.poll_lease_id=$8 AND j.poll_lease_expires_at>clock_timestamp()
    AND ($2<>'succeeded' OR (j.cancel_requested_at IS NULL AND j.deadline_at>clock_timestamp() AND EXISTS(
     SELECT 1 FROM agent_runs r
     JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id
     JOIN studio_host_credentials c ON c.company_id=a.company_id AND c.agent_id=a.id AND c.token_hash=a.token_hash
     JOIN studio_managed_hosts h ON h.company_id=c.company_id AND h.id=c.host_id
     JOIN studio_host_provisions p ON p.company_id=h.company_id AND p.host_id=h.id
     WHERE r.company_id=j.company_id AND r.id=j.run_id AND r.agent_id=j.agent_id
      AND r.status='running' AND r.lease_token_hash=j.lease_token_hash AND r.lease_expires_at>clock_timestamp() AND r.started_at>clock_timestamp()-interval '30 minutes'
      AND a.status='active' AND a.token_hash=j.agent_token_hash AND a.managed_token_hash=a.token_hash AND a.expires_at>clock_timestamp()
      AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND c.installation_id=j.installation_id AND c.installation_revision=j.installation_revision
      AND h.id=j.host_id AND h.status='active' AND h.expires_at>clock_timestamp() AND h.lease_expires_at>clock_timestamp() AND h.lease_epoch=c.host_epoch
      AND p.id=j.provision_id AND p.phase IN ('provisioning','running') AND p.stop_requested_at IS NULL AND p.expires_at>clock_timestamp()
    ))) RETURNING j.*`,[row.id,update.status,update.providerId??null,update.output?JSON.stringify(update.output):null,JSON.stringify(update.calls??[]),update.used??null,update.error??null,leaseId])).rows[0];
  if(!saved)fail(409,'The inference completion authority ended.','INFERENCE_SAVE_AUTHORITY_ENDED');
  return{inference:projection(saved,false),skipped:false};
 });
 let submitted=Boolean(row.submitted_at),knownProviderId=row.provider_job_id;const observe=(job:Row)=>{if(job&&typeof job.id==='string'&&providerId.test(job.id)&&(!knownProviderId||knownProviderId===job.id))knownProviderId=job.id;return completion({...row,provider_job_id:knownProviderId},job);};
 try{
  if(row.cancel_requested_at){
   if(!submitted)return await save({status:'cancelled'});
   if(!row.provider_job_id)return await save({status:+new Date(row.deadline_at)<=Date.now()?'expired':'uncertain',error:'INFERENCE_SUBMISSION_UNCERTAIN'});
   // A rejected, empty or lost cancellation response cannot prove the job is
   // still running. Independently read the exact known job, within the same
   // overall deadline. Only that identity's terminal status can close cleanup;
   // neither cancellation acknowledgement nor unavailable status is success.
   try{await provider(row.endpoint_id+'/cancel/'+row.provider_job_id,'POST',undefined,transport,signal,requestTimeout);}catch{signal.throwIfAborted();}
   const job=await provider(row.endpoint_id+'/status/'+row.provider_job_id,'GET',undefined,transport,signal,requestTimeout),seen=observe(job);
   return await save({status:terminal.has(seen.status)?'cancelled':'cancel_requested',providerId:job.id});
  }
  if(!submitted){const authorized=await tx(async client=>{const access=await authority(client,identityOf(row),row.run_id,row.lease_token_hash,true);const current=(await client.query('SELECT * FROM studio_inference_jobs WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(current.poll_lease_id!==leaseId||current.submitted_at||current.cancel_requested_at||+new Date(current.deadline_at)-Date.now()<10000||access.host.provision_id!==row.provision_id)return false;await client.query('UPDATE studio_inference_jobs SET submitted_at=clock_timestamp() WHERE id=$1',[row.id]);return true;});if(!authorized)return await save({status:'cancelled'});submitted=true;const remaining=Math.max(10000,+new Date(row.deadline_at)-Date.now()),job=await provider(row.endpoint_id+'/run','POST',{input:{openai_route:'/v1/chat/completions',openai_input:row.request_body},policy:{ttl:remaining,executionTimeout:Math.max(5000,remaining)}},transport,signal,requestTimeout);const seen=observe(job);return await save({...seen,providerId:job.id});}
  if(!row.provider_job_id)return await save({status:+new Date(row.deadline_at)<=Date.now()?'expired':'uncertain',error:'INFERENCE_SUBMISSION_UNCERTAIN'});const job=await provider(row.endpoint_id+'/status/'+row.provider_job_id,'GET',undefined,transport,signal,requestTimeout),seen=observe(job);return await save({...seen,providerId:job.id});
 }catch(error){const rawCode=(error as any)?.code,code=typeof rawCode==='string'?rawCode:undefined;return await save({status:submitted?row.cancel_requested_at?'cancel_requested':knownProviderId&&(!code||code==='INFERENCE_PROVIDER_UNCONFIRMED')&&['queued','running'].includes(row.status)?row.status:'uncertain':'failed',providerId:knownProviderId,error:typeof code==='string'&&code.startsWith('INFERENCE_')?code:'INFERENCE_PROVIDER_UNCONFIRMED'});}
}
export async function reconcileStudioInferenceJobs(limit=2,dependencies:StudioInferenceDependencies={}){const tx=dependencies.transaction??transaction,ids=await tx(async client=>(await client.query("SELECT id FROM studio_inference_jobs WHERE status IN ('submitting','queued','running','uncertain','cancel_requested') AND (poll_lease_expires_at IS NULL OR poll_lease_expires_at<=clock_timestamp()) ORDER BY last_reconciled_at NULLS FIRST,id LIMIT $1",[Math.max(1,Math.min(10,limit))])).rows.map(row=>row.id));const results=[];for(const inferenceId of ids)results.push(await reconcileStudioInferenceJob(inferenceId,dependencies));return{results};}

export async function studioInferenceRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='agent'||parts[1]!=='runs'||parts[3]!=='inference'||![4,5,6].includes(parts.length))return null;
 const identity=await authenticateAgent(request),runId=id(parts[2]);await rateLimit(`studio-inference:${identity.id}`,120,60);
 if(parts.length===4&&method==='POST'){const input=await body(request,studioInferenceSubmitInput,2000),result=await submitStudioInference(identity,runId,input);await reconcileStudioInferenceJob(result.inference.id);return json({...result,...await readStudioInference(identity,runId,result.inference.id,input.leaseToken)},result.replayed?200:201);}
 if(parts.length===5&&method==='GET'){const proof=request.headers.get('X-Coatria-Run-Lease')??'';await readStudioInference(identity,runId,id(parts[4]),proof);await reconcileStudioInferenceJob(parts[4]);return json(await readStudioInference(identity,runId,parts[4],proof));}
 if(parts.length===6&&parts[5]==='cancel'&&method==='POST'){const input=await body(request,studioInferenceCancelInput,2000),result=await cancelStudioInference(identity,runId,id(parts[4]),input);await reconcileStudioInferenceJob(parts[4]);return json({...result,...await readStudioInference(identity,runId,parts[4],input.leaseToken)});}
 return null;
}
