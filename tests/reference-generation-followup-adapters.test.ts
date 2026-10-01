import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {AGENT_TOOLS} from '../src/lib/agent-tools';
import {referenceGenerationFollowupToolNames} from '../src/lib/studio-reference-generation-followups';
import {coordinatorGenerationInferenceToolNames,assertCoordinatorGenerationTool} from '../src/lib/studio-coordination';
import {createProviderExecutor,modelRequestContext,referenceGenerationToolNames} from '../public/downloads/provider-adapter.mjs';
import {createMcpBridge} from '../public/downloads/agent-mcp.mjs';
import {codexInvocation} from '../public/downloads/codex-adapter.mjs';
import {claudeInvocation} from '../public/downloads/claude-code-adapter.mjs';

const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const run={id:id(90),prompt:'Use referenceGenerationFollowup and stop after the saved proposal.',attempts:1};
const context={projectId:id(1),workItemId:id(2),taskId:id(3),referenceId:id(4),handoffSha256:'a'.repeat(64),requestId:null as string|null,nextStep:'claim',advanceTool:'studio_reference_generation_followup_advance',serverOwnsOperationIds:true,contentInspected:false,canGenerate:false,canTransfer:false,canApprove:false};
const caps=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];
const secret='private-fixture-context-never-sent',unrelated='UNRELATED-CONVERSATION';
const scoped={capabilities:caps,messages:[{body:unrelated}],referenceGenerationFollowup:{...context,privateLocator:secret,claimRequestId:secret},lease:secret};
const expected={verifiedRequest:{id:run.id,prompt:run.prompt},untrustedConversationContext:{messages:[]},referenceGenerationFollowup:context};
const catalog=Object.entries(AGENT_TOOLS).filter(([,tool])=>[tool.capability,...tool.additionalCapabilities??[]].every(cap=>caps.includes(cap))).map(([name,tool])=>({name,capability:tool.capability,mutating:tool.mutating,description:tool.description,inputSchema:z.toJSONSchema(tool.schema,{io:'input',unrepresentable:'any'})}));
const settings:NodeJS.ProcessEnv={NODE_ENV:'test',OPENAI_API_KEY:'fixture-provider-key',XAI_API_KEY:'fixture-provider-key',ANTHROPIC_API_KEY:'fixture-provider-key',FIREWORKS_API_KEY:'fixture-provider-key',TOGETHER_API_KEY:'fixture-provider-key',RUNPOD_API_KEY:'fixture-provider-key',COATRIA_RUNPOD_ENDPOINT_ID:'fixture-endpoint'};
const models:Record<string,string>={openai:'gpt-6-astra',xai:'grok-4.6',anthropic:'claude-sonnet-5',fireworks:'accounts/fireworks/models/qwen3p8-max',together:'Qwen/Qwen3.5-9B',runpod:'Qwen/Qwen3.5-9B'};

test('new continuation projection preserves legacy data, strips private fields and rejects ambiguous or expanded authority',()=>{
 const ordinary={messages:[{body:unrelated}]};assert.deepEqual(modelRequestContext(run,ordinary),{verifiedRequest:{id:run.id,prompt:run.prompt},untrustedConversationContext:ordinary});
 const before=JSON.stringify(scoped);assert.deepEqual(modelRequestContext(run,scoped),expected);assert.equal(JSON.stringify(scoped),before);
 assert(!JSON.stringify(modelRequestContext(run,scoped)).includes(secret));
 for(const nextStep of ['claim','proposal','proposed']){const value={...context,nextStep,requestId:nextStep==='proposed'?id(5):null};assert.deepEqual(modelRequestContext(run,{referenceGenerationFollowup:value}).referenceGenerationFollowup,value);}
 for(const value of [false,{},null as any,...['projectId','workItemId','taskId','referenceId','handoffSha256'].map(key=>({...context,[key]:secret})),...['canGenerate','canTransfer','canApprove','contentInspected'].map(key=>({...context,[key]:true})),{...context,nextStep:'approve'},{...context,advanceTool:'higgsfield_generation_propose'},{...context,serverOwnsOperationIds:false},{...context,nextStep:'proposed'},{...context,nextStep:'claim',requestId:id(5)}].filter(x=>x!==null))assert.throws(()=>modelRequestContext(run,{referenceGenerationFollowup:value}),/^Error: Invalid reference-generation continuation context\.$/);
 assert.throws(()=>modelRequestContext(run,{...scoped,generatedFollowup:{}}),/Invalid reference-generation continuation context/);
 assert.deepEqual([...referenceGenerationToolNames].sort(),[...referenceGenerationFollowupToolNames].sort());
 assert.equal(referenceGenerationToolNames.length,6);
});

function response(provider:string,call:boolean){
 const name=context.advanceTool,args={projectId:context.projectId,workItemId:context.workItemId,step:'claim'};
 if(['openai','xai'].includes(provider))return{status:'completed',usage:{input_tokens:100,output_tokens:20},output:call?[{type:'function_call',call_id:'call-one',name,arguments:JSON.stringify(args)}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Claim saved.'}]}]};
 if(provider==='anthropic')return{stop_reason:call?'tool_use':'end_turn',usage:{input_tokens:100,output_tokens:20},content:call?[{type:'tool_use',id:'call-one',name,input:args}]:[{type:'text',text:'Claim saved.'}]};
 return{usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:call?'tool_calls':'stop',message:{role:'assistant',content:call?null:'Claim saved.',...(call?{tool_calls:[{id:'call-one',type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{})}}]};
}
test('all direct provider protocols show only six server-enforced tools and execute the exact stable step',async t=>{
 for(const provider of Object.keys(models))await t.test(provider,async()=>{
  let reads=0,calls=0;const options={run,context:{...scoped,installation:{pluginId:provider,manifestVersion:'1.0.0',runtimeConfig:{providerId:provider,modelId:models[provider]}}},signal:new AbortController().signal,tools:{list:async()=>({tools:catalog}),key:(key:string)=>key,call:async(name:string,args:any,metadata:any)=>{calls++;assert.equal(name,context.advanceTool);assert.deepEqual(args,{projectId:id(1),workItemId:id(2),step:'claim'});assert.equal(metadata.requestId,'provider:0:call-one');return{step:'claim',task:{id:id(3)},replayed:false};}}};
  const execute=createProviderExecutor({settings,fetch:(async(_url:unknown,init:any)=>{
   const envelope=JSON.parse(init.body),body=provider==='runpod'?envelope.input.openai_input:envelope;
   const names=body.tools.map((tool:any)=>tool.function?.name??tool.name);assert.deepEqual(names.sort(),[...referenceGenerationFollowupToolNames].sort());
   assert(Buffer.byteLength(JSON.stringify(body.tools))<7000,'The six-tool profile remains bounded with its real schemas.');
   if(reads===0){const prompt=['openai','xai'].includes(provider)?body.input[0].content:provider==='anthropic'?body.messages[0].content:body.messages[1].content;assert.deepEqual(JSON.parse(prompt),expected);}
   assert(!init.body.includes(secret));assert(!init.body.includes(unrelated));const data=response(provider,reads++===0);return new Response(JSON.stringify(provider==='runpod'?{id:'fixture-job',status:'COMPLETED',output:[data]}:data));
  }) as typeof fetch});
  assert.deepEqual(await execute(options),{result:'Claim saved.'});assert.equal(reads,2);assert.equal(calls,1);
  await assert.rejects(()=>execute({...options,context:{...options.context,referenceGenerationFollowup:{...context,canGenerate:true}}}),/Invalid reference-generation continuation context/);assert.equal(reads,2);
 });
});

test('MCP discovery and direct calls share the exact scope with current run context',async()=>{
 let calls=0,contexts=0;const bridge=createMcpBridge({runId:run.id,leaseToken:'fixture-lease',client:{context:async()=>{contexts++;return scoped;},listTools:async()=>({tools:catalog}),callTool:async()=>{calls++;return{result:{saved:true}};}}});
 await bridge.handle({jsonrpc:'2.0',id:1,method:'initialize'});
 const listed:any=await bridge.handle({jsonrpc:'2.0',id:2,method:'tools/list'});assert.deepEqual(listed.result.tools.map((tool:any)=>tool.name).sort(),[...referenceGenerationFollowupToolNames].sort());
 const denied:any=await bridge.handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'tasks_submit',arguments:{}}});assert.equal(denied.result.isError,true);assert.equal(calls,0);
 const allowed:any=await bridge.handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:context.advanceTool,arguments:{projectId:id(1),workItemId:id(2),step:'claim'}}});assert.equal(allowed.result.isError,false);assert.equal(calls,1);assert.equal(contexts,3);bridge.close();
});

test('native Codex and Claude receive bounded continuation stdin, with the Claude catalog restricted',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coatria-reference-adapter-'));try{
  for(const provider of ['codex','claude']){
   const character={roleTitle:'Production artist',persona:'Accurate.',workStyle:'methodical'};
   const options={run,context:{...scoped,installation:{pluginId:provider==='codex'?'codex':'claude-code',manifestVersion:'1.0.0',runtimeConfig:{providerId:provider==='codex'?'openai':'anthropic',modelId:provider==='codex'?'gpt-6-astra':'claude-sonnet-5',timeoutSeconds:180},character}},tools:{list:async()=>({tools:catalog})},mcpEnvironment:{COATRIA_URL:'https://coatria.com',COATRIA_RUN_ID:run.id,COATRIA_RUN_LEASE:'fixture-lease'}};
   const local={...settings,COATRIA_AGENT_TOKEN:'fixture-agent-token',COATRIA_CODEX_WORKSPACE:directory,COATRIA_CLAUDE_WORKSPACE:directory};
   const invoke=provider==='codex'?codexInvocation:claudeInvocation,result=await invoke(options,local);assert.deepEqual(JSON.parse(result.input),provider==='codex'?{...expected,configuredCompanyCharacter:character}:expected);assert(!result.input.includes(secret));assert(!result.input.includes(unrelated));
   if(provider==='claude')assert.deepEqual((result as any).allowedTools.sort(),referenceGenerationFollowupToolNames.map(name=>'mcp__coatria__'+name).sort());
   await assert.rejects(()=>invoke({...options,context:{...options.context,referenceGenerationFollowup:{...context,canApprove:true}}},local));
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('initial coordinator generation gains only derivative metadata/reference tools under the explicit current flag',async()=>{
 let opted=false;const scope={project_id:id(1),work_item_id:id(2),task_id:id(3)},db={query:async(sql:string,values:any[])=>{
  if(sql.includes('FROM studio_coordination_dispatches'))return{rows:[{...scope,reference_generation_continuations:opted}]};
  assert(sql.includes('FROM project_image_preparations'));assert.deepEqual(values,[id(9),id(1),id(4)]);return{rowCount:1,rows:[{}]};
 }} as any;
 const ordinary=await coordinatorGenerationInferenceToolNames(db,id(9),id(90));assert.equal(ordinary?.length,7);
 await assert.rejects(()=>assertCoordinatorGenerationTool(db,{company_id:id(9)},{id:id(90)},'project_image_preparation_reference',{preparationId:id(4),workItemId:id(2)}),{code:'COORDINATOR_GENERATION_SCOPE'});
 opted=true;const enabled=await coordinatorGenerationInferenceToolNames(db,id(9),id(90));assert.deepEqual(enabled?.filter(name=>!ordinary?.includes(name)).sort(),['project_image_preparation_get','project_image_preparation_reference','project_image_preparations_list']);
 await assertCoordinatorGenerationTool(db,{company_id:id(9)},{id:id(90)},'project_image_preparation_reference',{preparationId:id(4),workItemId:id(2)});
 for(const name of ['tasks_submit','storage_version_access','studio_reference_generation_followup_dispatch','project_image_preparation_propose'])await assert.rejects(()=>assertCoordinatorGenerationTool(db,{company_id:id(9)},{id:id(90)},name,{}),{code:'COORDINATOR_GENERATION_SCOPE'});
 await assert.rejects(()=>assertCoordinatorGenerationTool(db,{company_id:id(9)},{id:id(90)},'project_image_preparation_reference',{preparationId:id(4),workItemId:id(8)}),{code:'COORDINATOR_GENERATION_SCOPE'});
});
