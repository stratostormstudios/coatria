import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createProviderExecutor,modelRequestContext} from '../public/downloads/provider-adapter.mjs';
import {codexInvocation,execute as executeCodex} from '../public/downloads/codex-adapter.mjs';
import {claudeInvocation,execute as executeClaude} from '../public/downloads/claude-code-adapter.mjs';

const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const run={id:id(90),prompt:'Read your generatedFollowup context and advance only the approved continuation.',attempts:1};
const generated={projectId:id(1),workItemId:id(2),taskId:id(3),archiveId:id(4),requestId:id(5),storageVersionId:id(6),fileSha256:'a'.repeat(64),specSha256:'b'.repeat(64),artifactId:null as string|null,nextStep:'claim',advanceTool:'studio_generated_followup_advance',serverOwnsOperationIds:true,contentInspected:false,canGenerate:false,canTransfer:false,canApprove:false};
const secret='fixture-private-metadata-never-to-model',unrelated='UNRELATED-COMMONS-MESSAGE';
const messages=[{body:unrelated}];
const dirty={...generated,providerUrl:'https://private.invalid/'+secret,token:secret,capabilities:['studio.review'],unknownNested:{authorization:secret}};
const scoped={messages,generatedFollowup:dirty,lease:secret,privateProfile:secret};
const expected={verifiedRequest:{id:run.id,prompt:run.prompt},untrustedConversationContext:{messages:[]},generatedFollowup:generated};

test('the prompt projection preserves ordinary wire data and copies only bounded exact continuation metadata',()=>{
 const ordinary={messages,installation:{privateDetail:secret}};
 const legacy={verifiedRequest:{id:run.id,prompt:run.prompt},untrustedConversationContext:{messages}};
 assert.equal(JSON.stringify(modelRequestContext(run,ordinary)),JSON.stringify(legacy));
 assert.equal(JSON.stringify(modelRequestContext(run,{...ordinary,generatedFollowup:null})),JSON.stringify(legacy));
 const original=JSON.stringify(scoped),projected=modelRequestContext(run,scoped);
 assert.deepEqual(projected,expected);assert.equal(JSON.stringify(scoped),original);
 assert.notEqual(projected.generatedFollowup,dirty);assert(!JSON.stringify(projected).includes(secret));assert(!JSON.stringify(projected).includes(unrelated));
 for(const nextStep of ['claim','register','submit','submitted']){
  const value={...generated,nextStep,artifactId:['submit','submitted'].includes(nextStep)?id(7):null};
  assert.deepEqual(modelRequestContext(run,{generatedFollowup:value}).generatedFollowup,value);
 }
 // A continuation may claim a task with an already registered exact artifact.
 assert.equal(modelRequestContext(run,{generatedFollowup:{...generated,artifactId:id(7)}}).generatedFollowup?.artifactId,id(7));
});

test('missing, malformed or authority-widening continuation fields fail closed without echoing values',()=>{
 const malformed:unknown[]=[false,[],secret,{},
  ...['projectId','workItemId','taskId','archiveId','requestId','storageVersionId'].flatMap(key=>[{...generated,[key]:secret},{...generated,[key]:undefined}]),
  ...['fileSha256','specSha256'].flatMap(key=>[{...generated,[key]:secret},{...generated,[key]:'A'.repeat(64)}]),
  ...['contentInspected','canGenerate','canTransfer','canApprove'].flatMap(key=>[{...generated,[key]:true},{...generated,[key]:undefined}]),
  {...generated,advanceTool:'creative_generate'},{...generated,serverOwnsOperationIds:false},{...generated,nextStep:'approve'},
  {...generated,artifactId:undefined},{...generated,artifactId:secret},{...generated,nextStep:'register',artifactId:id(7)},
  {...generated,nextStep:'submit'},{...generated,nextStep:'submitted'}];
 for(const value of malformed)assert.throws(()=>modelRequestContext(run,{generatedFollowup:value}),error=>String(error)==='Error: Invalid generated continuation context.');
});

const models:Record<string,string>={openai:'gpt-6-astra',xai:'grok-4.6',anthropic:'claude-sonnet-5',fireworks:'accounts/fireworks/models/qwen3p8-max',together:'Qwen/Qwen3.5-9B',runpod:'Qwen/Qwen3.5-9B'};
const settings:NodeJS.ProcessEnv={NODE_ENV:'test',OPENAI_API_KEY:'fixture-provider-key',XAI_API_KEY:'fixture-provider-key',ANTHROPIC_API_KEY:'fixture-provider-key',FIREWORKS_API_KEY:'fixture-provider-key',TOGETHER_API_KEY:'fixture-provider-key',RUNPOD_API_KEY:'fixture-provider-key',COATRIA_RUNPOD_ENDPOINT_ID:'fixture-endpoint'};
const advanceArgs={projectId:generated.projectId,workItemId:generated.workItemId,step:'claim'};
const capability='studio.write',capabilities=['studio.write','studio.read','tasks.write','creative.read','creative.write','storage.read'];
function answer(provider:string,call:boolean){
 const name=generated.advanceTool;
 if(['openai','xai'].includes(provider))return{status:'completed',usage:{input_tokens:100,output_tokens:20},output:call?[{type:'function_call',call_id:'outer-call-one',name,arguments:JSON.stringify(advanceArgs)}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Approved continuation claimed.'}]}]};
 if(provider==='anthropic')return{stop_reason:call?'tool_use':'end_turn',usage:{input_tokens:100,output_tokens:20},content:call?[{type:'tool_use',id:'outer-call-one',name,input:advanceArgs}]:[{type:'text',text:'Approved continuation claimed.'}]};
 return{usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:call?'tool_calls':'stop',message:{role:'assistant',content:call?null:'Approved continuation claimed.',...(call?{tool_calls:[{id:'outer-call-one',type:'function',function:{name,arguments:JSON.stringify(advanceArgs)}}]}:{})}}]};
}

test('every provider wire receives exact server metadata and executes only the supplied advance tool',async t=>{
 const {AGENT_TOOLS}=await import('../src/lib/agent-tools');const {z}=await import('zod');
 const definition=AGENT_TOOLS.studio_generated_followup_advance;
 const tool={name:generated.advanceTool,description:definition.description,capability,inputSchema:z.toJSONSchema(definition.schema,{unrepresentable:'any',io:'input'})};
 for(const provider of Object.keys(models))await t.test(provider,async()=>{
  let requests=0,calls=0;
  const context={...scoped,capabilities,installation:{pluginId:provider,manifestVersion:'1.0.0',runtimeConfig:{providerId:provider,modelId:models[provider]}}};
  const options={run,context,signal:new AbortController().signal,tools:{list:async()=>({tools:[tool,{...tool,name:'unauthorized_review',capability:'studio.review'}]}),key:(key:string)=>key,call:async(name:string,args:unknown,metadata:{requestId:string})=>{calls++;assert.equal(name,generated.advanceTool);assert.deepEqual(args,advanceArgs);assert.equal(metadata.requestId,'provider:0:outer-call-one');assert.notEqual(metadata.requestId,generated.requestId);return{step:'claim',nextStep:'register'};}}};
  const execute=createProviderExecutor({settings,fetch:(async(_url:unknown,init:{body:string})=>{
   const envelope=JSON.parse(init.body),body=provider==='runpod'?envelope.input.openai_input:envelope;
   const prompt=['openai','xai'].includes(provider)?body.input[0].content:provider==='anthropic'?body.messages[0].content:body.messages[1].content;
   assert.deepEqual(JSON.parse(prompt),expected);assert(!init.body.includes(secret));assert(!init.body.includes(unrelated));assert(!init.body.includes('unauthorized_review'));
   const response=answer(provider,requests++===0);return new Response(JSON.stringify(provider==='runpod'?{id:'fixture-job',status:'COMPLETED',output:[response]}:response),{status:200});
  }) as typeof fetch});
  assert.deepEqual(await execute(options),{result:'Approved continuation claimed.'});assert.equal(requests,2);assert.equal(calls,1);
  await assert.rejects(()=>execute({...options,context:{...context,generatedFollowup:{...generated,canApprove:true}}}),/Invalid generated continuation context/);assert.equal(requests,2);assert.equal(calls,1);
 });
});

class FakeCli extends EventEmitter{
 stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();input='';exitCode:number|null=null;
 constructor(){super();this.stdin.on('data',chunk=>{this.input+=chunk.toString();});}
 kill(){this.exitCode=143;return true;}close(){this.exitCode=0;this.emit('close',0);}
}

test('Codex and Claude native subprocess fixtures receive the continuation through stdin with unchanged tool restrictions',{timeout:30000},async t=>{
 const require=createRequire(import.meta.url),processes=require('node:child_process'),originalSpawn=processes.spawn;
 const directory=await mkdtemp(join(tmpdir(),'coatria-followup-adapters-')),environment={...process.env};
 const local={...settings,COATRIA_AGENT_TOKEN:'fixture-agent-token',CODEX_API_KEY:'fixture-provider-key',COATRIA_CODEX_WORKSPACE:directory,COATRIA_CLAUDE_WORKSPACE:directory};
 const mcpEnvironment={COATRIA_URL:'https://coatria.com',COATRIA_RUN_ID:run.id,COATRIA_RUN_LEASE:'fixture-lease'};
 try{
  Object.assign(process.env,local);delete process.env.COATRIA_CODEX_SANDBOX;delete process.env.COATRIA_CODEX_WORKSPACE_TOOLS;delete process.env.COATRIA_CODEX_ISOLATED_WORKER;delete process.env.COATRIA_CLAUDE_AUTH_MODE;
  for(const provider of ['codex','claude'])await t.test(provider,async()=>{
   const context={...scoped,capabilities,installation:{pluginId:provider==='codex'?'codex':'claude-code',manifestVersion:'1.0.0',runtimeConfig:{providerId:provider==='codex'?'openai':'anthropic',modelId:provider==='codex'?'gpt-6-astra':'claude-sonnet-5',timeoutSeconds:180},character:{roleTitle:'Production artist',persona:'Accurate and concise.',workStyle:'methodical'}}};
   const options={run,context,mcpEnvironment,tools:{list:async()=>({tools:[{name:generated.advanceTool,capability}]})},signal:new AbortController().signal};
   const invocation=provider==='codex'?await codexInvocation(options,local):await claudeInvocation(options,local);
   const wanted=provider==='codex'?{...expected,configuredCompanyCharacter:context.installation.character}:expected;
   assert.deepEqual(JSON.parse(invocation.input),wanted);
   const ordinaryOptions={...options,context:{...context,generatedFollowup:undefined}};
   const ordinary=provider==='codex'?await codexInvocation(ordinaryOptions,local):await claudeInvocation(ordinaryOptions,local);
   const oldPrompt=provider==='codex'?{verifiedRequest:{id:run.id,prompt:run.prompt},configuredCompanyCharacter:context.installation.character,untrustedConversationContext:ordinaryOptions.context}:{verifiedRequest:{id:run.id,prompt:run.prompt},untrustedConversationContext:{messages}};
   assert.equal(ordinary.input,JSON.stringify(oldPrompt));assert.deepEqual(invocation.args,ordinary.args,'Continuation metadata cannot grant more CLI tools.');
   const child=new FakeCli();let spawns=0;
   processes.spawn=(_command:string,args:string[],spawnOptions:{shell:boolean;windowsHide:boolean})=>{spawns++;assert.equal(spawnOptions.shell,false);assert.equal(spawnOptions.windowsHide,true);assert(!args.includes(run.prompt));queueMicrotask(()=>{
    assert.deepEqual(JSON.parse(child.input),wanted);assert(!child.input.includes(secret));assert(!child.input.includes(unrelated));
    const events=provider==='codex'?[{type:'item.completed',item:{type:'agent_message',text:'Continuation ready.'}},{type:'turn.completed'}]:[{type:'system',subtype:'init',mcp_servers:[{name:'coatria',status:'connected'}],tools:['mcp__coatria__'+generated.advanceTool,'EndConversation']},{type:'result',subtype:'success',is_error:false,result:'Continuation ready.',usage:{input_tokens:100,output_tokens:20}}];
    child.stdout.write(events.map(event=>JSON.stringify(event)).join('\n')+'\n');child.close();
   });return child;};syncBuiltinESMExports();
   const execute=provider==='codex'?executeCodex:executeClaude;
   assert.deepEqual(await execute(options),{result:'Continuation ready.'});assert.equal(spawns,1);
   await assert.rejects(()=>execute({...options,context:{...context,generatedFollowup:{...generated,canTransfer:true}}}),/continuation context is invalid|Invalid generated continuation context/);assert.equal(spawns,1,'Malformed continuation must fail before native launch.');
  });
 }finally{
  processes.spawn=originalSpawn;syncBuiltinESMExports();for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
  const inside=relative(tmpdir(),directory);assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside));await rm(directory,{recursive:true,force:true});
 }
});
