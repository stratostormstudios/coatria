import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import {spawn} from 'node:child_process';
import {createRuntimeClient,runtimeOrigin,stableRequestId,RuntimeError,openWorkerState,workOnce} from '../public/downloads/agent-worker.mjs';
import {createMcpBridge} from '../public/downloads/agent-mcp.mjs';

const runId='10000000-0000-4000-8000-000000000881',otherRun='10000000-0000-4000-8000-000000000882';
const token='ca_local-runtime-fixture-only',lease='fixture-lease-not-a-real-credential';
const claim=()=>({run:{id:runId,status:'running',prompt:'Read the workspace',capabilities:['workspace:read']},leaseToken:lease,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),replayed:false});
const controller=()=>new AbortController();
function memoryState(initial?:any){let saved:any;const state={data:initial||{workerId:'worker-fixture',claimId:null,job:null},async save(){saved=structuredClone(state.data);},get saved(){return saved;}};return state;}
function fakeClient(overrides:any={}){return {origin:'https://coatria.com',claim:async()=>claim(),context:async()=>({run:claim().run,messages:[],capabilities:['workspace:read']}),heartbeat:async()=>({run:claim().run,leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),complete:async()=>({run:{id:runId,status:'succeeded'},replayed:false}),fail:async()=>({run:{id:runId,status:'queued'},replayed:false}),listTools:async()=>({tools:[]}),callTool:async()=>({result:{ok:true},replayed:false}),...overrides};}
async function listen(server:Server){await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert(address&&typeof address!=='string');return 'http://127.0.0.1:'+address.port;}
const close=(server:Server)=>new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
type RpcResponse=Awaited<ReturnType<ReturnType<typeof createMcpBridge>['handle']>>;
function rpcResult(value:RpcResponse){assert(value&&'result' in value);return value.result;}
function rpcError(value:RpcResponse){assert(value&&'error' in value);return value.error;}

test('runtime credentials never follow redirects and origins reject embedded credentials or paths',async()=>{
 for(const url of ['http://example.com','https://name:password@example.com','https://example.com/path','https://example.com/?token=secret','file:///tmp/run'])assert.throws(()=>runtimeOrigin(url));
 assert.equal(runtimeOrigin('http://127.0.0.1:4180'),'http://127.0.0.1:4180');
 let leaked=0,received='';const target=createServer((_request,response)=>{leaked++;response.end('{}');});const targetUrl=await listen(target);
 const source=createServer((request,response)=>{received=request.headers.authorization||'';response.writeHead(302,{Location:targetUrl+'/capture'});response.end();});const url=await listen(source);
 try{const client=createRuntimeClient({url,token,retryBaseMs:0});await assert.rejects(()=>client.listTools(),error=>!String(error).includes(token));assert.equal(received,'Bearer '+token);assert.equal(leaked,0);}finally{await close(source);await close(target);}
});

test('safe tool retries preserve IDs and content, enforce deadlines and bound response bytes',async()=>{
 const bodies:any[]=[];let requests=0;
 const transport=async(_url:any,options:any)=>{requests++;bodies.push(JSON.parse(options.body));if(requests===1)throw new Error('Lost response after a committed tool effect');return Response.json({result:{id:'existing-result'},replayed:true});};
 const client=createRuntimeClient({token,fetch:transport as typeof fetch,retryBaseMs:0});
 const result=await client.callTool('tasks_create',{runId,leaseToken:lease,requestId:stableRequestId(runId,'create-task'),arguments:{title:'Review'}},undefined);
 assert.equal(result.replayed,true);assert.equal(requests,2);assert.deepEqual(bodies[1],bodies[0]);
 let timedOut=0;const stalled=async(_url:any,options:any)=>new Promise<Response>((_done,reject)=>{options.signal.addEventListener('abort',()=>{timedOut++;reject(options.signal.reason);},{once:true});});
 const keepAlive=setTimeout(()=>{},5000);
 try{await assert.rejects(()=>createRuntimeClient({token,fetch:stalled as typeof fetch,timeoutMs:15,retryBaseMs:0}).listTools(),{code:'NETWORK_ERROR'});assert.equal(timedOut,3);}finally{clearTimeout(keepAlive);}
 await assert.rejects(()=>createRuntimeClient({token,retryBaseMs:0,fetch:async()=>new Response('x'.repeat(1024*1024+1))}).listTools(),{code:'RESPONSE_TOO_LARGE'});
});

test('private state is identity-bound, exclusively locked and writes cannot finish out of order',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coatria-worker-state-')),path=join(directory,'worker.json'),client=createRuntimeClient({token});
 try{const state=await openWorkerState(path,client);try{await assert.rejects(()=>openWorkerState(path,client),/Another worker/);state.data.claimId=stableRequestId(runId,'first');const first=state.save();state.data.claimId=stableRequestId(runId,'last');const last=state.save();await Promise.all([first,last]);assert.equal(JSON.parse(await readFile(path,'utf8')).claimId,state.data.claimId);}finally{await state.close();}await assert.rejects(()=>openWorkerState(path,createRuntimeClient({token:'ca_other-runtime-fixture-only'})),/different origin, credential or format/);}finally{const inside=relative(tmpdir(),directory);assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside));await rm(directory,{recursive:true,force:true});}
});

test('lost claim response reuses its durable claim ID before any adapter execution',async()=>{
 const state=memoryState(),ids:string[]=[];let executed=0;
 const client=fakeClient({claim:async(_workerId:string,claimId:string)=>{ids.push(claimId);if(ids.length===1)throw new RuntimeError(503,'SERVER_ERROR');return claim();}});
 const execute=async()=>{executed++;return {result:'Completed actual fixture work'};};
 await assert.rejects(()=>workOnce({client,state,execute,signal:controller().signal}),{status:503});assert.equal(executed,0);assert.equal(state.saved.claimId,ids[0]);
 await workOnce({client,state,execute,signal:controller().signal});assert.equal(ids[1],ids[0]);assert.equal(executed,1);assert.equal(state.data.job,null);
});

test('uncertain completion survives worker restart and expired local lease without rerunning the adapter',async()=>{
 const state=memoryState(),payloads:any[]=[];let executions=0;
 const client=fakeClient({complete:async(_id:string,payload:any)=>{payloads.push(structuredClone(payload));if(payloads.length===1)throw new RuntimeError(503,'SERVER_ERROR');return {run:{id:runId,status:'succeeded'},replayed:true};}});
 const execute=async()=>{executions++;return {result:'One accepted artifact',artifactUrl:'https://example.com/review/1'};};
 await assert.rejects(()=>workOnce({client,state,execute,signal:controller().signal}),{status:503});assert.equal(state.saved.job.outcome.kind,'complete');
 const restarted=memoryState(state.saved);restarted.data.job.leaseExpiresAt=new Date(Date.now()-60000).toISOString();
 await workOnce({client,state:restarted,execute,signal:controller().signal});assert.equal(executions,1);assert.deepEqual(payloads[1],payloads[0]);assert.equal(restarted.data.job,null);
});

test('lease cancellation aborts an uncooperative adapter and prevents later tools or completion',async()=>{
 const state=memoryState();let calls=0,completed=0,tools:any,adapterSignal:AbortSignal|undefined;
 const client=fakeClient({heartbeat:async()=>{throw new RuntimeError(409,'RUN_CANCELLED');},callTool:async()=>{calls++;return {result:{}};},complete:async()=>{completed++;return {};}});
 const execute=({signal,tools:boundTools}:any)=>{adapterSignal=signal;tools=boundTools;return new Promise(()=>{});};
 await assert.rejects(()=>workOnce({client,state,execute,signal:controller().signal,heartbeatMs:10}),{code:'RUN_CANCELLED'});assert.equal(adapterSignal?.aborted,true);
 await assert.rejects(()=>tools.call('workspace_get',{}, {requestId:tools.key('late')}),{code:'RUN_CANCELLED'});assert.equal(calls,0);assert.equal(completed,0);assert.equal(state.data.job,null);
});

test('adapter failure records a bounded generic report and explicit tool keys remain stable across attempts',async()=>{
 const state=memoryState();let reported:any,toolPayload:any;
 const client=fakeClient({callTool:async(_name:string,payload:any)=>{toolPayload=payload;return {result:{value:1}};},fail:async(_id:string,payload:any)=>{reported=payload;return {run:{status:'queued'}};}});
 await workOnce({client,state,signal:controller().signal,execute:async({tools}:any)=>{await assert.rejects(()=>tools.call('workspace_get',{}),/stable requestId/);await tools.call('workspace_get',{}, {requestId:tools.key('workspace')});throw new Error('Sensitive adapter error '+token);}});
 assert.equal(toolPayload.requestId,stableRequestId(runId,'workspace'));assert.notEqual(stableRequestId(runId,'workspace'),stableRequestId(otherRun,'workspace'));assert.equal(reported.error.includes(token),false);assert.match(reported.clientId,/^[0-9a-f-]{36}$/);
});

test('MCP discovery respects run capabilities, stable IDs replay, changed arguments and revoked leases fail',async()=>{
 const calls:any[]=[];let revoked=false;
 const client=fakeClient({context:async()=>{if(revoked)throw new RuntimeError(401,'AGENT_ACCESS_ENDED');return {capabilities:['workspace:read']};},listTools:async()=>({tools:[{name:'workspace_get',description:'Read workspace',inputSchema:{type:'object'},capability:'workspace:read',mutating:false},{name:'layout_propose',description:'Propose layout',inputSchema:{type:'object'},capability:'layout:propose',mutating:true}]}),callTool:async(_name:string,payload:any)=>{calls.push(payload);return {result:{ok:true},replayed:calls.length>1};}});
 const bridge=createMcpBridge({client,runId,leaseToken:lease});
 assert.equal(rpcError(await bridge.handle({jsonrpc:'2.0',id:1,method:'tools/list'})).code,-32002);
 assert.equal(rpcResult(await bridge.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}})).protocolVersion,'2025-11-25');
 const list=rpcResult(await bridge.handle({jsonrpc:'2.0',id:2,method:'tools/list'}));assert.equal(list.tools.length,1);assert.equal(list.tools[0].name,'workspace_get');
 const call={jsonrpc:'2.0',id:'operation-3',method:'tools/call',params:{name:'workspace_get',arguments:{a:1,b:2}}};
 await bridge.handle(call);await bridge.handle({...call,params:{name:'workspace_get',arguments:{b:2,a:1}}});assert.equal(calls[0].requestId,calls[1].requestId);
 assert.equal(rpcError(await bridge.handle({...call,params:{name:'workspace_get',arguments:{a:9}}})).code,-32602);assert.equal(calls.length,2);
 revoked=true;const denied=rpcError(await bridge.handle({jsonrpc:'2.0',id:4,method:'tools/list'}));assert.equal(denied.code,-32000);assert.match(denied.message,/AGENT_ACCESS_ENDED/);assert.equal(JSON.stringify(denied).includes(token),false);bridge.close();
});

test('only the trusted adapter connection receives the lease; task context and shared records do not',async()=>{
 const state=memoryState(),logs:any[]=[],outcomes:any[]=[];
 const client=fakeClient({complete:async(_id:string,payload:any)=>{outcomes.push(payload);return{run:{id:runId,status:'succeeded'},replayed:false};}});
 await workOnce({client,state,signal:controller().signal,log:(entry:any)=>logs.push(entry),execute:async({run,context,mcpEnvironment}:any)=>{
  assert.deepEqual(mcpEnvironment,{COATRIA_URL:client.origin,COATRIA_RUN_ID:runId,COATRIA_RUN_LEASE:lease});
  assert.equal(JSON.stringify({run,context}).includes(lease),false);assert.equal(JSON.stringify({run,context,mcpEnvironment}).includes(token),false);
  return{result:'Reviewed authorized workspace data.'};
 }});
 assert.equal(JSON.stringify(logs).includes(lease),false);assert.equal(JSON.stringify(logs).includes(token),false);
 assert.equal(outcomes[0].result.includes(lease),false);assert.equal(outcomes[0].leaseToken,lease);
});

test('an ended lease during context loading prevents invoking the adapter',async()=>{
 const state=memoryState(),control=controller();let executed=0;
 const client=fakeClient({context:async()=>{control.abort(new RuntimeError(409,'RUN_CANCELLED'));return{run:claim().run,capabilities:[]};}});
 await assert.rejects(()=>workOnce({client,state,signal:control.signal,execute:async()=>{executed++;return{result:'must not execute'};}}),{code:'RUN_CANCELLED'});
 assert.equal(executed,0);assert.equal(state.data.job,null);
});

test('heartbeat backoff respects Retry-After while the dispatcher remains cancellable',async()=>{
 const state=memoryState(),control=controller();let heartbeats=0;
 const client=fakeClient({heartbeat:async()=>{heartbeats++;throw new RuntimeError(429,'RATE_LIMITED',2);}});
 const stop=setTimeout(()=>control.abort(new Error('Operator stop')),160);
 try{await assert.rejects(()=>workOnce({client,state,heartbeatMs:10,signal:control.signal,execute:async()=>new Promise(()=>{})}),/Operator stop/);assert.equal(heartbeats,1);}finally{clearTimeout(stop);}
});

test('runtime OpenAPI exposes current tool input constraints and keeps leases out of browser run projections',async()=>{
 const {agentRuntimeOpenApi}=await import('../src/lib/agent-runtime-openapi');
 const {AGENT_TOOLS}=await import('../src/lib/agent-tools');
 const spec:any=agentRuntimeOpenApi;
 assert.equal(spec.openapi,'3.1.0');assert.equal(Object.keys(AGENT_TOOLS).length,18);
 for(const[name,definition]of Object.entries(AGENT_TOOLS)){
  const operation=spec.paths['/api/agent/tools/'+name].post;assert.equal(operation['x-coatria-capability'],definition.capability);
  assert.deepEqual(operation.security,[{agentBearer:[]}]);
  const body=operation.requestBody.content['application/json'].schema;assert(body.required.includes('leaseToken'));assert(body.required.includes('requestId'));
 }
 assert.equal(spec.paths['/api/agent/tools/layout_propose'].post.requestBody.content['application/json'].schema.properties.arguments.properties.layout.maxItems,180);
 assert.equal(spec.paths['/api/agent/tools/tasks_submit'].post.requestBody.content['application/json'].schema.properties.arguments.properties.tokensUsed.maximum,1000000000);
 assert.equal('leaseToken' in spec.components.schemas.AgentRun.properties,false);assert.equal('token_hash' in spec.components.schemas.AgentRun.properties,false);
 assert(spec.paths['/api/agent/runs/{runId}/context'].get.parameters.some((entry:any)=>entry.name==='X-Coatria-Run-Lease'&&entry.in==='header'&&entry.required));
 assert.equal(JSON.stringify(spec).includes(token),false);assert.equal(JSON.stringify(spec).includes(lease),false);
});

test('the real stdio bridge initializes, discovers and calls authenticated Coatria tools without stdout secrets',async()=>{
 const seen:any[]=[];const server=createServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;seen.push({url:request.url,authorization:request.headers.authorization,lease:request.headers['x-coatria-run-lease'],body:body?JSON.parse(body):null});response.setHeader('Content-Type','application/json');response.end(JSON.stringify(request.url?.endsWith('/context')?{capabilities:['workspace:read']}:request.url==='/api/agent/tools'?{tools:[{name:'workspace_get',description:'Read workspace',inputSchema:{type:'object',additionalProperties:false},capability:'workspace:read',mutating:false}]}:{result:{name:'Fixture studio'},replayed:false}));});
 const url=await listen(server),processChild=spawn(process.execPath,[resolve('public/downloads/agent-mcp.mjs')],{stdio:['pipe','pipe','pipe'],env:{NODE_ENV:'test',PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,COATRIA_URL:url,COATRIA_AGENT_TOKEN:token,COATRIA_RUN_ID:runId,COATRIA_RUN_LEASE:lease}});let stdout='',stderr='';
 processChild.stdout.setEncoding('utf8');processChild.stderr.setEncoding('utf8');processChild.stdout.on('data',chunk=>stdout+=chunk);processChild.stderr.on('data',chunk=>stderr+=chunk);
 async function send(message:any){processChild.stdin.write(JSON.stringify(message)+'\n');const stop=Date.now()+5000;while(Date.now()<stop){const found=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(response=>response.id===message.id);if(found)return found;await new Promise(done=>setTimeout(done,10));}throw new Error('MCP response timed out.');}
 try{await send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}});assert.equal((await send({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools[0].name,'workspace_get');assert.equal((await send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'workspace_get',arguments:{}}})).result.structuredContent.result.name,'Fixture studio');assert(seen.every(request=>request.authorization==='Bearer '+token));assert(seen.filter(request=>request.url.endsWith('/context')).every(request=>request.lease===lease));assert.equal(seen.find(request=>request.url.endsWith('/workspace_get')).body.leaseToken,lease);assert.equal((stdout+stderr).includes(token),false);assert.equal((stdout+stderr).includes(lease),false);}finally{processChild.stdin.end();await new Promise<void>(done=>processChild.once('close',()=>done()));await close(server);}
});
