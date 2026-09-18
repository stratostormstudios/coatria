import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRuntimeClient,createRunInferenceClient,stableRequestId,RuntimeError,workOnce} from '../public/downloads/agent-worker.mjs';
import {createProviderExecutor,providerConfiguration} from '../public/downloads/provider-adapter.mjs';

const runId=randomUUID(),inferenceId=randomUUID(),token='ca_private-inference-fixture',lease='private-fixture-lease';
const settings:NodeJS.ProcessEnv={NODE_ENV:'test',COATRIA_INFERENCE_MODE:'coatria_broker_v1'};
const stepKey=(step=0)=>stableRequestId(runId,'inference:'+step);
const context=()=>({run:{id:runId,prompt:'Read the workspace through the approved tools.',attempts:1},messages:[],capabilities:['workspace.read'],installation:{pluginId:'runpod',revision:1,runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}}});
const output=(call=false)=>({usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:call?'tool_calls':'stop',message:{role:'assistant',content:call?null:'Verified workspace result.',...(call?{reasoning_content:'Preserve exact reasoning continuation.',tool_calls:[{id:'read_workspace',type:'function',function:{name:'workspace_get',arguments:'{}'}}]}:{})}}]});
const record=(status='queued',extra:Record<string,unknown>={})=>({inference:{id:inferenceId,runId,step:0,status,deadlineAt:new Date(Date.now()+60000).toISOString(),...(status==='succeeded'?{output:output()}:{}),...extra}});
const tool={name:'workspace_get',description:'Read the workspace.',capability:'workspace.read',inputSchema:{type:'object',additionalProperties:false}};

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
 const result=await execute({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async(name:string,args:unknown,metadata:any)=>{calls.push({name,args,...metadata});return {name:'Fixture workspace'};}},inference:{complete:async(options:any)=>{requests.push(options);assert.deepEqual(Object.keys(options).sort(),['requestId','signal','step','timeoutMs']);return output(options.step===0);}},signal:new AbortController().signal,recovering:false});
 assert.equal(result.result,'Verified workspace result.');assert.equal(network,0);assert.equal(requests.length,2);assert.deepEqual(requests.map(item=>item.requestId),[stepKey(0),stepKey(1)]);assert(requests.every(item=>item.timeoutMs>0&&item.timeoutMs<=180000&&item.signal instanceof AbortSignal));assert.equal(calls[0].requestId,stableRequestId(runId,'provider:0:read_workspace'));assert.equal(calls[0].name,'workspace_get');assert.deepEqual(calls[0].args,{});
});

test('cached broker output never permits recovered attempts or unauthorized tool calls',async()=>{
 let requests=0,writes=0;const execute=createProviderExecutor({settings});const options={run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;return{};}},inference:{complete:async()=>{requests++;const value=output(true);value.choices[0].message.tool_calls![0].function.name='studio_review_decide';return value;}},signal:new AbortController().signal};
 for(const extra of [{recovering:true},{run:{...options.run,attempts:2}}])await assert.rejects(()=>execute({...options,...extra}),/not replayed/);assert.equal(requests,0);
 await assert.rejects(()=>execute(options),/unauthorized/);assert.equal(requests,1);assert.equal(writes,0);
});

test('broker completion still enforces provider usage and malformed reasoning checks before tool writes',async()=>{
 let writes=0;for(const reply of [{...output(),usage:{prompt_tokens:24000,completion_tokens:1}},{...output(),usage:{}},{...output(),choices:[{finish_reason:'length',message:{role:'assistant',content:'Truncated'}}]}]){
  await assert.rejects(()=>createProviderExecutor({settings})({run:context().run,context:context(),tools:{key:(key:string)=>stableRequestId(runId,key),list:async()=>({tools:[tool]}),call:async()=>{writes++;}},inference:{complete:async()=>reply},signal:new AbortController().signal}));
 }assert.equal(writes,0);
});

test('agent broker HTTP retries use the identical minimal step body and polls stay bound to the run lease',async()=>{
 const requests:any[]=[];let submits=0,reads=0;
 const client=createRuntimeClient({token,retryBaseMs:0,fetch:(async(url:any,init:any)=>{
  requests.push({url:String(url),method:init.method,headers:init.headers,body:init.body});assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+token);
  if(init.method==='POST'){submits++;assert.equal(String(url),'https://coatria.com/api/agent/runs/'+runId+'/inference');assert.deepEqual(JSON.parse(init.body),{leaseToken:lease,requestId:stepKey(),step:0});if(submits===1)throw Error('Committed response lost');return Response.json(record());}
  reads++;assert.equal(init.headers['X-Coatria-Run-Lease'],lease);assert.equal(init.body,undefined);assert.equal(String(url),'https://coatria.com/api/agent/runs/'+runId+'/inference/'+inferenceId);return Response.json(record(reads===1?'running':'succeeded'));
 }) as typeof fetch});
 const result=await createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:5000});assert.deepEqual(result,output());assert.equal(submits,2);assert.equal(reads,2);assert.equal(requests[0].body,requests[1].body);assert(!JSON.stringify(requests).includes('openai_input'));
});

test('terminal and foreign broker records cannot produce a result or start another inference',async()=>{
 for(const patch of [{status:'failed'},{status:'cancelled'},{status:'expired'},{runId:randomUUID()},{step:1},{id:'not-a-uuid'},{status:'succeeded',output:null}]){
  let submits=0,reads=0,cancels=0;const client={submitInference:async()=>{submits++;return record('queued',patch);},readInference:async()=>{reads++;return record('succeeded');},cancelInference:async()=>{cancels++;}};
  await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:1000}));assert.equal(submits,1);assert.equal(reads,0);assert.equal(cancels,0);
 }
 let cancels=0;const client={submitInference:async()=>record(),readInference:async()=>record('running',{id:randomUUID()}),cancelInference:async(_run:string,id:string)=>{assert.equal(id,inferenceId);cancels++;}};
 await assert.rejects(()=>createRunInferenceClient({client,runId,leaseToken:lease,pollMs:0}).complete({step:0,requestId:stepKey(),timeoutMs:1000}),{code:'INVALID_INFERENCE_RESPONSE'});assert.equal(cancels,1);
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
 await workOnce({client,state,execute:async({inference,context:actual,tools,mcpEnvironment}:any)=>{assert.equal(actual,runtime);assert(!('inference'in actual));assert(!('COATRIA_INFERENCE_MODE'in mcpEnvironment));assert.deepEqual(Object.keys(inference),['complete']);const result=await inference.complete({step:0,requestId:tools.key('inference:0')});return{result:result.choices[0].message.content};}});
 assert.deepEqual(submitted,{leaseToken:lease,requestId:stepKey(),step:0});assert.equal(completion.result,'Verified workspace result.');assert.equal(state.data.job,null);
});
