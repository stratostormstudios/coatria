import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRuntimeClient,createRunInferenceClient,isBrokerInferenceCompletion,stableRequestId,RuntimeError,workOnce} from '../public/downloads/agent-worker.mjs';
import {createProviderExecutor,providerConfiguration} from '../public/downloads/provider-adapter.mjs';

const runId=randomUUID(),inferenceId=randomUUID(),token='ca_private-inference-fixture',lease='private-fixture-lease';
const settings:NodeJS.ProcessEnv={NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'};
const stepKey=(step=0)=>stableRequestId(runId,'inference:'+step);
const context=()=>({run:{id:runId,prompt:'Read the workspace through the approved tools.',attempts:1},messages:[],capabilities:['workspace.read'],installation:{pluginId:'runpod',revision:1,runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}}});
const output=(call=false)=>({usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:call?'tool_calls':'stop',message:{role:'assistant',content:call?null:'Verified workspace result.',...(call?{reasoning_content:'Preserve exact reasoning continuation.',tool_calls:[{id:'read_workspace',type:'function',function:{name:'workspace_get',arguments:'{}'}}]}:{})}}]});
const record=(status='queued',extra:Record<string,unknown>={})=>({inference:{id:inferenceId,runId,step:0,status,protocolVersion:2,deadlineAt:new Date(Date.now()+60000).toISOString(),...(status==='succeeded'?{output:output(),disposition:'execute',usage:{promptTokens:100,completionTokens:20,totalTokens:120}}:{}),...extra}});
const brokerOutput=(value:any,step=0,extra:Record<string,unknown>={})=>createRunInferenceClient({client:{submitInference:async()=>record('succeeded',{step,output:value,usage:{promptTokens:value.usage?.prompt_tokens,completionTokens:value.usage?.completion_tokens,totalTokens:value.usage?.prompt_tokens+value.usage?.completion_tokens},...extra})},runId,leaseToken:lease}).complete({step,requestId:stepKey(step)});
const tool={name:'workspace_get',description:'Read the workspace.',capability:'workspace.read',inputSchema:{type:'object',additionalProperties:false}};
function feedbackRecord(step=0,correction=1){
 const data=output(true);data.choices[0].message.tool_calls=[{id:'invalid_'+step,type:'function',function:{name:'workspace_get',arguments:'{private-invalid-json'}},{id:'sibling_'+step,type:'function',function:{name:'workspace_get',arguments:'{}'}}];
 return record('succeeded',{step,output:data,disposition:'validation_feedback',validationFeedback:{version:1,correction,calls:data.choices[0].message.tool_calls.map((call,index)=>({id:call.id,name:call.function.name,requestId:stableRequestId(runId,'provider:'+step+':'+call.id),response:{version:1,executed:false,code:index?'BATCH_NOT_EXECUTED':'ARGUMENT_JSON_INVALID',issues:index?[]:[{path:[],code:'custom'}]}}))}});
}
const fixtureBroker=(getRecord:(step:number)=>any,onSubmit:(payload:any)=>void=()=>{})=>createRunInferenceClient({client:{submitInference:async(_run:string,payload:any)=>{onSubmit(payload);return getRecord(payload.step);}},runId,leaseToken:lease,pollMs:0});

test('typed broker feedback skips the whole rejected batch and executes only fresh corrected calls',async()=>{
 const requests:any[]=[],calls:any[]=[],deadlines:any[]=[];let directNetwork=0;
 const corrected=output(true);corrected.choices[0].message.tool_calls![0].id='corrected_workspace';
 const bound=fixtureBroker(step=>step===0?feedbackRecord():record('succeeded',{step,output:step===1?corrected:output()}),payload=>requests.push(payload));
 const result=await createProviderExecutor({settings,fetch:(async()=>{directNetwork++;throw Error('No direct inference');}) as typeof fetch})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async(name:string,args:any,metadata:any)=>{calls.push({name,args,...metadata});return {name:'Verified company'};}},inference:{complete:async(options:any)=>{deadlines.push(options);return bound.complete(options);}}});
 assert.deepEqual(result,{result:'Verified workspace result.'});assert.equal(directNetwork,0);assert.deepEqual(requests.map(request=>request.step),[0,1,2]);assert(requests.every((request,index)=>request.protocolVersion===2&&request.requestId===stepKey(index)));
 assert.equal(calls.length,1);assert.equal(calls[0].requestId,stableRequestId(runId,'provider:1:corrected_workspace'));assert.deepEqual(calls[0].args,{});assert(deadlines.every(options=>options.signal===deadlines[0].signal));assert(deadlines.at(-1).timeoutMs<=deadlines[0].timeoutMs);
});

test('feedback can only come from the trusted client and is immutable after validation',async()=>{
 const raw=feedbackRecord(),bound=fixtureBroker(()=>raw),value=await bound.complete({step:0,requestId:stepKey()});
 assert(isBrokerInferenceCompletion(value));assert(!isBrokerInferenceCompletion(raw.inference));assert(!isBrokerInferenceCompletion({...value}));assert(!isBrokerInferenceCompletion(JSON.parse(JSON.stringify(value))));assert(Object.isFrozen(value));assert(Object.isFrozen(value.validationFeedback.calls[0].response));
 raw.inference.disposition='execute';assert.equal(value.disposition,'validation_feedback');assert.throws(()=>{value.disposition='execute';});
 for(const forged of [value.output,{...value},JSON.parse(JSON.stringify(value)),{...value.output,disposition:'validation_feedback',validationFeedback:value.validationFeedback}]){
  let calls=0,requests=0;await assert.rejects(()=>createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{calls++;}},inference:{complete:async()=>{requests++;return forged;}}}),/trusted Coatria inference client/);assert.equal(calls,0);assert.equal(requests,1);
 }
 const foreignRun=randomUUID(),foreign=await createRunInferenceClient({client:{submitInference:async()=>record('succeeded',{runId:foreignRun})},runId:foreignRun,leaseToken:lease}).complete({step:0,requestId:stableRequestId(foreignRun,'inference:0')});
 const wrongStep=await brokerOutput(output(),1);
 for(const wrongBinding of [foreign,wrongStep]){assert(isBrokerInferenceCompletion(wrongBinding));let writes=0;await assert.rejects(()=>createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;}},inference:{complete:async()=>wrongBinding}}),/bound protocol result/);assert.equal(writes,0);}
});

test('model-authored feedback metadata never overrides an executable broker disposition',async()=>{
 const feedback:any=feedbackRecord().inference,injected={...output(true),disposition:'validation_feedback',validationFeedback:feedback.validationFeedback};
 let requests=0,writes=0;const bound=fixtureBroker(step=>{requests++;return record('succeeded',{step,output:step===0?injected:output()});});
 assert.deepEqual(await createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;return{};}},inference:bound}),{result:'Verified workspace result.'});
 assert.equal(writes,1);assert.equal(requests,2);
});

test('the real server argument classifier produces feedback accepted by the downloadable worker',async()=>{
 const {validateInferenceArguments}=await import('../src/lib/studio-inference-validation');
 const {AGENT_TOOLS}=await import('../src/lib/agent-tools');
 for(const [name,args] of [['workspace_get','{malformed'],['workspace_get','{"privateUnknownField":"private-supplied-value"}'],['storage_get','{"projectId":3}']]){
  const checked=validateInferenceArguments(name,AGENT_TOOLS[name].schema,args);assert(checked.validation);
  const value:any=feedbackRecord();value.inference.output.choices[0].message.tool_calls[0].function={name,arguments:args};value.inference.validationFeedback.calls[0].name=name;value.inference.validationFeedback.calls[0].response=checked.validation;
  const result=await fixtureBroker(()=>value).complete({step:0,requestId:stepKey()});assert(isBrokerInferenceCompletion(result));assert.equal(result.disposition,'validation_feedback');
  assert.equal(JSON.stringify(result.validationFeedback).includes('privateUnknownField'),false);assert.equal(JSON.stringify(result.validationFeedback).includes('private-supplied-value'),false);
 }
});

test('a durable worker completes a corrected run and replays only its final receipt after lost acknowledgement',async()=>{
 const runtime=context(),state:any={data:{workerId:'fixture-worker',claimId:null,job:null},save:async()=>{}},steps:number[]=[],writes:any[]=[],completions:any[]=[];let adapterCalls=0;
 const corrected=output(true);corrected.choices[0].message.tool_calls![0].id='corrected_after_validation';
 const client={origin:'https://coatria.com',claim:async()=>({run:runtime.run,leaseToken:lease,leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),context:async()=>runtime,listTools:async()=>({tools:[tool]}),
  submitInference:async(_id:string,payload:any)=>{steps.push(payload.step);assert.equal(payload.protocolVersion,2);return payload.step===0?feedbackRecord():record('succeeded',{step:payload.step,output:payload.step===1?corrected:output()});},
  callTool:async(name:string,payload:any)=>{writes.push({name,...payload});return{result:{name:'Verified workspace'}};},
  complete:async(_id:string,payload:any)=>{completions.push(payload);if(completions.length===1)throw new RuntimeError(503,'NETWORK_ERROR');return{run:{status:'succeeded'}};},
 };
 const execute=async(options:any)=>{adapterCalls++;return createProviderExecutor({settings})(options);};
 await assert.rejects(()=>workOnce({client,state,execute}),{code:'NETWORK_ERROR'});assert.equal(state.data.job.outcome.kind,'complete');assert.equal(state.data.job.outcome.payload.result,'Verified workspace result.');
 assert.deepEqual(steps,[0,1,2]);assert.equal(writes.length,1);assert.equal(writes[0].requestId,stableRequestId(runId,'provider:1:corrected_after_validation'));assert.equal(writes[0].leaseToken,lease);
 await workOnce({client,state,execute});assert.equal(adapterCalls,1);assert.equal(completions.length,2);assert.deepEqual(completions[0],completions[1]);assert.deepEqual(steps,[0,1,2]);assert.equal(writes.length,1);assert.equal(state.data.job,null);
});

test('client rejects downgraded, mismatched and unbounded validation feedback without exposing supplied text',async()=>{
 const patches:Array<(value:any)=>void>=[
  value=>{delete value.protocolVersion;},value=>{value.protocolVersion=1;},value=>{value.disposition='invented';},value=>{value.usage.totalTokens++;},value=>{value.usage.promptTokens++;value.usage.totalTokens++;},value=>{value.validationFeedback.correction=3;},value=>{value.validationFeedback.correction=0;},value=>{value.validationFeedback.version=2;},
  value=>{value.validationFeedback.calls[0].requestId=randomUUID();},value=>{value.validationFeedback.calls[0].id='different';},value=>{value.validationFeedback.calls[0].name='other';},value=>{value.validationFeedback.calls[0].response.executed=true;},value=>{value.validationFeedback.calls[0].response.code='private-unknown';},value=>{value.validationFeedback.calls[0].response.issues=[];},value=>{value.validationFeedback.calls[1].response.issues=[{path:[],code:'custom'}];},
  value=>{value.validationFeedback.calls[0].response.issues[0].message='private-unknown';},value=>{value.validationFeedback.calls[0].response.issues[0].code='private-unknown';},value=>{value.validationFeedback.calls[0].response.issues[0].path=['private/raw-value'];},value=>{value.validationFeedback.calls[0].response.issues[0].expected='private-unknown';},value=>{value.validationFeedback.calls[0].response.issues[0].allowed=Array(41).fill('x');},value=>{value.validationFeedback.calls[0].response.issues[0].minimum=-1;},value=>{value.validationFeedback.calls[0].response.issues[0].maximum=Infinity;},value=>{for(const call of value.validationFeedback.calls){call.response.code='BATCH_NOT_EXECUTED';call.response.issues=[];}},
  value=>{value.output.choices[0].finish_reason='length';},value=>{value.output.choices[0].message.tool_calls[1].id=value.output.choices[0].message.tool_calls[0].id;},value=>{value.validationFeedback.calls=value.validationFeedback.calls.slice(0,1);},
 ];
 for(const patch of patches){const value=feedbackRecord();patch(value.inference);let reads=0;const bound=fixtureBroker(()=>value,()=>reads++);await assert.rejects(()=>bound.complete({step:0,requestId:stepKey()}),(error:any)=>error.code==='INVALID_INFERENCE_RESPONSE'&&!String(error).includes('private-unknown'));assert.equal(reads,1);}
 for(const protocolVersion of [undefined,1,3]){let reads=0;const client={submitInference:async()=>record('queued',{protocolVersion}),readInference:async()=>{reads++;return record('succeeded');}};await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey()}),{code:'INVALID_INFERENCE_RESPONSE'});assert.equal(reads,0);}
 let reads=0,cancels=0;const client={submitInference:async()=>record(),readInference:async()=>{reads++;return record('succeeded',{protocolVersion:undefined});},cancelInference:async()=>{cancels++;}};await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey()}),{code:'INVALID_INFERENCE_RESPONSE'});assert.equal(reads,1);assert.equal(cancels,1);
});

test('two corrections remain cumulative across executable batches and rejected identities cannot be reused',async()=>{
 let completedCalls=0;const completedSteps:number[]=[],twice=fixtureBroker(step=>{completedSteps.push(step);return step===0?feedbackRecord(0,1):step===2?feedbackRecord(2,2):record('succeeded',{step,output:output(step===1)});});
 assert.deepEqual(await createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{completedCalls++;return{};}},inference:twice}),{result:'Verified workspace result.'});assert.deepEqual(completedSteps,[0,1,2,3]);assert.equal(completedCalls,1);
 for(const mode of ['ordinal-replay','third-correction','reuse-invalid','reuse-sibling','unauthorized']){
  let calls=0,requests=0;const bound=fixtureBroker(step=>{
   requests++;if(step===0)return feedbackRecord();
   if(mode==='reuse-invalid'||mode==='reuse-sibling'){const value=output(true);value.choices[0].message.tool_calls![0].id=mode==='reuse-invalid'?'invalid_0':'sibling_0';return record('succeeded',{step,output:value});}
   if(step===1)return record('succeeded',{step,output:output(true)});
   const value=feedbackRecord(step,mode==='ordinal-replay'?1:mode==='third-correction'&&step===3?3:2);
   if(mode==='unauthorized'){const entry:any=value.inference;entry.output.choices[0].message.tool_calls[0].function.name='studio_review_decide';entry.validationFeedback.calls[0].name='studio_review_decide';}return value;
  });
  await assert.rejects(()=>createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{calls++;return{};}},inference:bound}));assert.equal(calls,mode.startsWith('reuse')?0:1);assert.equal(requests,mode.startsWith('reuse')?2:mode==='third-correction'?4:3);
 }
});

test('feedback consumes the original token and step allowance and never creates a fresh deadline',async()=>{
 for(const exhausted of ['tokens','steps']){const runtime=context();if(exhausted==='steps')runtime.installation.runtimeConfig.maxSteps=1;let requests=0,calls=0;const bound=fixtureBroker(step=>{requests++;const value=feedbackRecord(step);if(exhausted==='tokens'){const item:any=value.inference;item.output.usage.prompt_tokens=23900;item.usage={promptTokens:23900,completionTokens:20,totalTokens:23920};}return value;});
  await assert.rejects(()=>createProviderExecutor({settings})({run:runtime.run,context:runtime,tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{calls++;}},inference:bound}),exhausted==='tokens'?/token budget/:/reasoning steps/);assert.equal(requests,1);assert.equal(calls,0);
 }
 const control=new AbortController();let requests=0,calls=0;const bound=fixtureBroker(()=>{requests++;const value=feedbackRecord();control.abort();return value;});await assert.rejects(()=>createProviderExecutor({settings})({run:context().run,context:context(),signal:control.signal,tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{calls++;}},inference:bound}));assert.equal(requests,1);assert.equal(calls,0);
});

test('rejected siblings count toward the cumulative call ceiling before any later batch executes',async()=>{
 const runtime=context();runtime.installation.runtimeConfig.maxSteps=20;let requests=0,writes=0;
 const bound=fixtureBroker(step=>{
  requests++;if(step===0){const record:any=feedbackRecord(),first=record.inference.validationFeedback.calls[0];for(let i=2;i<8;i++){const raw={id:'sibling_0_'+i,type:'function',function:{name:'workspace_get',arguments:'{}'}};record.inference.output.choices[0].message.tool_calls.push(raw);record.inference.validationFeedback.calls.push({...first,id:raw.id,requestId:stableRequestId(runId,'provider:0:'+raw.id),response:{version:1,executed:false,code:'BATCH_NOT_EXECUTED',issues:[]}});}return record;}
  const value=output(true);value.choices[0].message.tool_calls=Array.from({length:step===8?1:8},(_,index)=>({id:'valid_'+step+'_'+index,type:'function',function:{name:'workspace_get',arguments:'{}'}}));return record('succeeded',{step,output:value});
 });
 await assert.rejects(()=>createProviderExecutor({settings})({run:runtime.run,context:runtime,tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;return{};}},inference:bound}),/tool call limit/);assert.equal(requests,9);assert.equal(writes,56);
});

test('broker mode is explicit, Runpod only, credential-free and never falls back to direct inference',async()=>{
 const config=providerConfiguration(context(),settings);assert.equal(config.inferenceMode,'coatria_broker_v1');assert.equal(config.protocol,'chat');assert(!('key'in config));assert(!('endpointId'in config));assert(!('url'in config));
 assert.throws(()=>providerConfiguration(context(),{NODE_ENV:'test'}),/credential/);
 for(const mode of ['','automatic','direct','coatria_broker_v2'])assert.throws(()=>providerConfiguration(context(),{...settings,COATRIA_INFERENCE_MODE:mode}),/explicit/);
 const other=context();other.installation.runtimeConfig.providerId='openai';assert.throws(()=>providerConfiguration(other,settings),/Runpod/);
 let network=0;const execute=createProviderExecutor({settings:{...settings,RUNPOD_API_KEY:'unused-private-key',COATRIA_RUNPOD_ENDPOINT_ID:'unused-endpoint'},fetch:(async()=>{network++;throw Error('No direct network allowed');}) as typeof fetch});
 await assert.rejects(()=>execute({run:context().run,context:context(),tools:{list:async()=>({tools:[tool]})},signal:new AbortController().signal}),/trusted Coatria inference client/);assert.equal(network,0);
});

test('broker adapter sends only stable step requests and preserves normal tool validation and receipt IDs',async()=>{
 const requests:any[]=[],calls:any[]=[];let network=0;
 const execute=createProviderExecutor({settings,fetch:(async()=>{network++;throw Error('Direct provider forbidden');}) as typeof fetch});
 const result=await execute({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async(name:string,args:unknown,metadata:any)=>{calls.push({name,args,...metadata});return {name:'Fixture workspace'};}},inference:{complete:async(options:any)=>{requests.push(options);assert.deepEqual(Object.keys(options).sort(),['requestId','signal','step','timeoutMs']);return brokerOutput(output(options.step===0),options.step);}},signal:new AbortController().signal,recovering:false});
 assert.equal(result.result,'Verified workspace result.');assert.equal(network,0);assert.equal(requests.length,2);assert.deepEqual(requests.map(item=>item.requestId),[stepKey(0),stepKey(1)]);assert(requests.every(item=>item.timeoutMs>0&&item.timeoutMs<=180000&&item.signal instanceof AbortSignal));assert.equal(calls[0].requestId,stableRequestId(runId,'provider:0:read_workspace'));assert.equal(calls[0].name,'workspace_get');assert.deepEqual(calls[0].args,{});
});

test('cached broker output never permits recovered attempts or unauthorized tool calls',async()=>{
 let requests=0,writes=0;const execute=createProviderExecutor({settings});const options={run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;return{};}},inference:{complete:async()=>{requests++;const value=output(true);value.choices[0].message.tool_calls![0].function.name='studio_review_decide';return brokerOutput(value);}},signal:new AbortController().signal};
 for(const extra of [{recovering:true},{run:{...options.run,attempts:2}}])await assert.rejects(()=>execute({...options,...extra}),/not replayed/);assert.equal(requests,0);
 await assert.rejects(()=>execute(options),/unauthorized/);assert.equal(requests,1);assert.equal(writes,0);
});

test('broker completion still enforces provider usage and malformed reasoning checks before tool writes',async()=>{
 let writes=0;for(const reply of [{...output(),usage:{prompt_tokens:24000,completion_tokens:1}},{...output(),usage:{}},{...output(),choices:[{finish_reason:'length',message:{role:'assistant',content:'Truncated'}}]}]){
  await assert.rejects(()=>createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;}},inference:{complete:async()=>brokerOutput(reply)},signal:new AbortController().signal}));
 }assert.equal(writes,0);
});

test('agent broker HTTP retries use the identical minimal step body and polls stay bound to the run lease',async()=>{
 const requests:any[]=[];let submits=0,reads=0;
 const client=createRuntimeClient({token,retryBaseMs:0,fetch:(async(url:any,init:any)=>{
  requests.push({url:String(url),method:init.method,headers:init.headers,body:init.body});assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+token);
  if(init.method==='POST'){submits++;assert.equal(String(url),'https://coatria.com/api/agent/runs/'+runId+'/inference');assert.deepEqual(JSON.parse(init.body),{leaseToken:lease,requestId:stepKey(),step:0,protocolVersion:2});if(submits===1)throw Error('Committed response lost');return Response.json(record());}
  reads++;assert.equal(init.headers['X-Coatria-Run-Lease'],lease);assert.equal(init.body,undefined);assert.equal(String(url),'https://coatria.com/api/agent/runs/'+runId+'/inference/'+inferenceId);return Response.json(record(reads===1?'running':'succeeded'));
 }) as typeof fetch});
 const result=await createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:5000});assert(isBrokerInferenceCompletion(result));assert.deepEqual(result.output,output());assert.equal(submits,2);assert.equal(reads,2);assert.equal(requests[0].body,requests[1].body);assert(!JSON.stringify(requests).includes('openai_input'));
});

test('terminal and foreign broker records cannot produce a result or start another inference',async()=>{
 for(const patch of [{status:'failed'},{status:'cancelled'},{status:'expired'},{runId:randomUUID()},{step:1},{id:'not-a-uuid'},{status:'succeeded',output:null}]){
  let submits=0,reads=0,cancels=0;const client={submitInference:async()=>{submits++;return record('queued',patch);},readInference:async()=>{reads++;return record('succeeded');},cancelInference:async()=>{cancels++;}};
  await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:1000}));assert.equal(submits,1);assert.equal(reads,0);assert.equal(cancels,0);
 }
 let cancels=0;const client={submitInference:async()=>record(),readInference:async()=>record('running',{id:randomUUID()}),cancelInference:async(_run:string,id:string)=>{assert.equal(id,inferenceId);cancels++;}};
 await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:1000}),{code:'INVALID_INFERENCE_RESPONSE'});assert.equal(cancels,1);
});

test('failed broker output retains only allowlisted diagnostic codes and never retries the agent run',async()=>{
 const secret='private-provider-error-never-copy';
 for(const errorCode of ['INFERENCE_OUTPUT_INVALID','INFERENCE_PROVIDER_UNCONFIRMED','INFERENCE_VALIDATION_LIMIT','INFERENCE_PROTOCOL_REQUIRED',secret]){
  const state={data:{workerId:'fixture-worker',claimId:null,job:null},save:async()=>{}},logs:any[]=[];let submits=0,reads=0,cancels=0,failed:any,terminal=false;
  const runtime=context(),client={origin:'https://coatria.com',claim:async()=>terminal?{run:null}:{run:runtime.run,leaseToken:lease,leaseExpiresAt:new Date(Date.now()+60000).toISOString()},context:async()=>runtime,
   submitInference:async()=>{submits++;return record('failed',{errorCode,error:secret,output:null});},readInference:async()=>{reads++;return record('succeeded');},cancelInference:async()=>{cancels++;},
   fail:async(_id:string,payload:any)=>{failed=payload;assert.equal(payload.retryable,false);terminal=true;return{run:{status:'failed'}};},listTools:async()=>({tools:[tool]})};
  const execute=createProviderExecutor({settings});await workOnce({client,state,execute,log:(entry:any)=>logs.push(entry)});assert.equal(await workOnce({client,state,execute}),false);
  assert.equal(submits,1);assert.equal(reads,0);assert.equal(cancels,0);assert.equal(state.data.job,null);assert.equal(logs.find(row=>row.event==='adapter-failed').code,errorCode===secret?'INFERENCE_FAILED':errorCode);assert(!JSON.stringify(logs).includes(secret));assert(!failed.error.includes(secret));
 }
});

test('lease cancellation uses its own short signal and stable cancel receipt without resubmission',async()=>{
 const control=new AbortController();let reads=0,cancels=0,submits=0;const client={submitInference:async()=>{submits++;return record();},readInference:async()=>{reads++;control.abort(new RuntimeError(409,'RUN_LEASE_LOST'));return new Promise(()=>{});},cancelInference:async(id:string,target:string,payload:any,signal:AbortSignal)=>{assert.equal(id,runId);assert.equal(target,inferenceId);assert.deepEqual(payload,{leaseToken:lease,requestId:stableRequestId(runId,'inference-cancel:0')});assert.equal(signal.aborted,false);cancels++;}};
 await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,signal:control.signal,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:1000}),{code:'RUN_LEASE_LOST'});assert.equal(submits,1);assert.equal(reads,1);assert.equal(cancels,1);
});

test('unknown submission outcomes do not trigger an unbound cancellation and pending cleanup is bounded',async()=>{
 let cancels=0;const client={submitInference:async()=>{throw new RuntimeError(0,'NETWORK_ERROR');},cancelInference:async()=>{cancels++;}};
 await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease}).complete({step:0,requestId:stepKey(),timeoutMs:1000}));assert.equal(cancels,0);
 const active=setTimeout(()=>{},1000);let cancellationSignal:AbortSignal|undefined;try{
  const control=new AbortController();const pending={submitInference:async()=>record(),readInference:async()=>{control.abort();return new Promise(()=>{});},cancelInference:async(_id:string,_target:string,_payload:any,signal:AbortSignal)=>{cancellationSignal=signal;return new Promise(()=>{});}};
  await assert.rejects(()=>createRunInferenceClient({client:pending,runId,leaseToken:lease,signal:control.signal,pollMs:0,cancelTimeoutMs:15}).complete({step:0,requestId:stepKey(),timeoutMs:1000}));assert.equal(cancellationSignal?.aborted,true);
 }finally{clearTimeout(active);}
});

test('broker adapter retains its execution promise until bounded inference cancellation cleanup finishes',{timeout:5000},async()=>{
 const control=new AbortController();let cancelling!:()=>void,release!:()=>void,settled=false;const ready=new Promise<void>(resolve=>cancelling=resolve),cleanup=new Promise<void>(resolve=>release=resolve);
 const client={submitInference:async()=>record(),readInference:async()=>{control.abort(new RuntimeError(409,'RUN_LEASE_LOST'));return new Promise(()=>{});},cancelInference:async()=>{cancelling();await cleanup;}};
 const inference=createRunInferenceClient({client,runId,leaseToken:lease,signal:control.signal,pollMs:0});
 const operation=createProviderExecutor({settings})({run:context().run,context:context(),inference,signal:control.signal,tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]})}});const outcome=operation.then(()=>{settled=true;},error=>{settled=true;assert.equal(error.code,'RUN_LEASE_LOST');});
 await ready;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);release();await outcome;assert.equal(settled,true);
});

test('broker step, deadline and cancellation checks reject invalid adapter input before transport',async()=>{
 let calls=0;const client={submitInference:async()=>{calls++;return record('succeeded');}};const bound=createRunInferenceClient({client,runId,leaseToken:lease});
 for(const patch of [{step:-1},{step:20},{step:0.5},{requestId:randomUUID()},{timeoutMs:0},{timeoutMs:600001}])await assert.rejects(()=>bound.complete({step:0,requestId:stepKey(),...patch}));
 const control=new AbortController();control.abort();await assert.rejects(()=>bound.complete({step:0,requestId:stepKey(),signal:control.signal}));assert.equal(calls,0);
});

test('runtime bounds an uncooperative response body through its complete read deadline',async()=>{
 let cancellations=0,requests=0;const keepAlive=setTimeout(()=>{},1000);
 try{const client=createRuntimeClient({token,timeoutMs:15,retryBaseMs:0,fetch:(async()=>{requests++;return new Response(new ReadableStream({cancel(){cancellations++;}}));}) as typeof fetch});await assert.rejects(()=>client.readInference(runId,inferenceId,lease,undefined),{code:'NETWORK_ERROR'});assert.equal(requests,3);assert.equal(cancellations,3);}finally{clearTimeout(keepAlive);}
});

test('workOnce exposes inference only to the trusted adapter and preserves its normal final receipt',async()=>{
 const state={data:{workerId:'fixture-worker',claimId:null,job:null},save:async()=>{}};let completion:any,submitted:any;
 const runtime=context();const client={origin:'https://coatria.com',claim:async()=>({run:runtime.run,leaseToken:lease,leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),context:async()=>runtime,submitInference:async(id:string,payload:any)=>{assert.equal(id,runId);submitted=payload;return record('succeeded');},complete:async(_id:string,payload:any)=>{completion=payload;return{run:{status:'succeeded'}};},listTools:async()=>({tools:[tool]})};
 await workOnce({client,state,execute:async({inference,context:actual,tools,mcpEnvironment}:any)=>{assert.equal(actual,runtime);assert(!('inference'in actual));assert(!('COATRIA_INFERENCE_MODE'in mcpEnvironment));assert.deepEqual(Object.keys(inference),['complete']);const result=await inference.complete({step:0,requestId:tools.key('inference:0')});return{result:result.output.choices[0].message.content};}});
 assert.deepEqual(submitted,{leaseToken:lease,requestId:stepKey(),step:0,protocolVersion:2});assert.equal(completion.result,'Verified workspace result.');assert.equal(state.data.job,null);
});
