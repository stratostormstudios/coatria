#!/usr/bin/env node
// Newline-delimited stdio MCP. This bridge never opens a listening port or shell.
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntimeClient,stableRequestId,RuntimeError} from './agent-worker.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
/** MCP access uses the same live agent/run/lease policy as direct HTTP calls. */
export function createMcpBridge({client,runId,leaseToken}){
 if(!UUID.test(runId)||typeof leaseToken!=='string'||leaseToken.length<8||leaseToken.length>4096)throw new Error('Set COATRIA_RUN_ID and COATRIA_RUN_LEASE for an active run.');
 const calls=new Map(),pending=new Map();let initialized=false;
 const result=(id,value)=>({jsonrpc:'2.0',id,result:value});
 async function handle(message){
  const id=message?.id??null;
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string'||typeof message.id==='string'&&message.id.length>160||(message.id!==undefined&&typeof message.id!=='string'&&!(typeof message.id==='number'&&Number.isSafeInteger(message.id))))return error(id,-32600,'Invalid JSON-RPC request.');
  if(message.method==='notifications/initialized')return null;
  if(message.method==='notifications/cancelled'){const target=message.params?.requestId;pending.get(JSON.stringify(target))?.abort(new Error('Tool call cancelled by client.'));return null;}
  if(message.id===undefined)return null;
  if(message.method==='initialize'){
   if(initialized)return error(id,-32600,'This bridge is already initialized.');initialized=true;
   return result(id,{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'coatria-agent-tools',version:'1.0.0'},instructions:'Tools act as the configured agent within the active run. Administrative changes may return proposals for human review. Do not reuse a request ID for different arguments.'});
  }
  if(!initialized)return error(id,-32002,'Initialize the MCP connection first.');
  if(message.method==='ping')return result(id,{});
  if(message.method!=='tools/list'&&message.method!=='tools/call')return error(id,-32601,'Method not found.');
  const key=JSON.stringify(id),controller=new AbortController();
  if(pending.has(key))return error(id,-32600,'A request with this ID is still pending.');
  pending.set(key,controller);
  try{
   // Recheck live lease and effective run permissions even for tool discovery.
   const context=await client.context(runId,leaseToken,controller.signal);
   if(message.method==='tools/list'){
    if(message.params?.cursor)return error(id,-32602,'Tool-list cursors are not supported.');
    const catalog=await client.listTools(controller.signal);if(!Array.isArray(catalog.tools)||catalog.tools.length>100)throw new RuntimeError(502,'INVALID_CATALOG');
    return result(id,{tools:catalog.tools.filter(tool=>Array.isArray(context.capabilities)&&context.capabilities.includes(tool.capability)).map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,annotations:{readOnlyHint:!tool.mutating}}))});
   }
   const params=message.params;
   const args=params?.arguments??{};
   if(!params||typeof params.name!=='string'||typeof args!=='object'||Array.isArray(args))return error(id,-32602,'A tool name and arguments object are required.');
   const signature=createHash('sha256').update(JSON.stringify({name:params.name,arguments:canonical(args)})).digest('hex');
   const previous=calls.get(key);if(previous&&previous!==signature)return error(id,-32602,'A tool request ID cannot be reused for different arguments.');
   if(calls.size>=10000&&!previous)return error(id,-32000,'This bridge session has reached its operation limit.');calls.set(key,signature);
   const response=await client.callTool(params.name,{runId,leaseToken,requestId:stableRequestId(runId,'mcp:'+key),arguments:args},controller.signal);
   return result(id,{content:[{type:'text',text:JSON.stringify(response.result)}],structuredContent:{result:response.result},isError:false});
  }catch(caught){const code=caught instanceof RuntimeError?caught.code:controller.signal.aborted?'REQUEST_CANCELLED':'REQUEST_FAILED';if(message.method==='tools/list')return error(id,-32000,'Coatria discovery failed: '+code+'.');return result(id,{content:[{type:'text',text:'Coatria tool request failed: '+code+'.'}],isError:true});}
  finally{pending.delete(key);}
 }
 return {handle,close(){for(const controller of pending.values())controller.abort(new Error('MCP bridge closed.'));pending.clear();}};
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}

async function main(){
 if(process.argv.includes('--help')){console.log('MCP stdio: set COATRIA_AGENT_TOKEN, COATRIA_RUN_ID, COATRIA_RUN_LEASE and optional COATRIA_URL. Run node agent-mcp.mjs from an approved MCP host. Requires adjacent agent-worker.mjs.');return;}
 const bridge=createMcpBridge({client:createRuntimeClient(),runId:process.env.COATRIA_RUN_ID,leaseToken:process.env.COATRIA_RUN_LEASE});
 let buffer=Buffer.alloc(0),active=0,closed=false;
 const emit=value=>{if(value&&!closed)process.stdout.write(JSON.stringify(value)+'\n');};
 process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){const index=buffer.indexOf(10);if(index<0)break;const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);if(!line.toString('utf8').trim())continue;if(line.length>256*1024){emit(error(null,-32600,'Request exceeds size limit.'));continue;}
   let message;try{message=JSON.parse(line.toString('utf8'));}catch{emit(error(null,-32700,'Invalid JSON.'));continue;}
   if(active>=8&&message.method!=='notifications/cancelled'){emit(error(message.id??null,-32000,'Too many concurrent requests.'));continue;}
   active++;void bridge.handle(message).then(emit,()=>emit(error(message.id??null,-32603,'Request could not be handled.'))).finally(()=>active--);
  }
  if(buffer.length>256*1024){emit(error(null,-32600,'Request exceeds size limit.'));closed=true;bridge.close();process.stdin.destroy();process.exitCode=1;}
 });
 process.stdin.on('end',()=>{closed=true;bridge.close();});process.stdin.on('error',()=>{closed=true;bridge.close();process.exitCode=1;});
 const stop=()=>{closed=true;bridge.close();process.stdin.destroy();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('MCP bridge could not start. Check private runtime configuration.');process.exitCode=1;});
