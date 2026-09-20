// Claude Code 2.1.248+ bridge. Native CLI login or API key, explicit Coatria MCP only.
import {spawn} from 'node:child_process';
import {realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {bridgePolicy,characterInstructions,providerConfiguration} from './provider-adapter.mjs';
const location=dirname(fileURLToPath(import.meta.url));
// Stable local classifications only. Raw CLI events, stderr and provider errors
// must never be included in worker logs or shared failure receipts.
export const CLAUDE_FAILURE_CODES=Object.freeze(['CLAUDE_REPLAY_UNSAFE','CLAUDE_CONFIGURATION','CLAUDE_CONTEXT_LIMIT','CLAUDE_TOOL_CATALOG','CLAUDE_START_FAILED','CLAUDE_CANCELLED','CLAUDE_TIMEOUT','CLAUDE_TOKEN_LIMIT','CLAUDE_OUTPUT_LIMIT','CLAUDE_PROTOCOL_INVALID','CLAUDE_MCP_UNAVAILABLE','CLAUDE_TOOL_SCOPE','CLAUDE_RESULT_INVALID','CLAUDE_TURN_LIMIT','CLAUDE_COST_LIMIT','CLAUDE_EXIT_FAILED']);
export class ClaudeAdapterError extends Error{
 constructor(code,message){
  super(typeof message==='string'&&message.length<=400?message:'Claude execution could not safely complete.');
  this.name='ClaudeAdapterError';this.code=CLAUDE_FAILURE_CODES.includes(code)?code:'CLAUDE_PROTOCOL_INVALID';this.retryable=false;
 }
}
const fault=(code,message)=>new ClaudeAdapterError(code,message);

export async function claudeInvocation({run,context,tools,mcpEnvironment},settings=process.env){
 const authMode=settings.COATRIA_CLAUDE_AUTH_MODE||'api-key';
 if(!['api-key','native'].includes(authMode))throw fault('CLAUDE_CONFIGURATION','Choose api-key or native Claude Code authentication.');
 if(authMode==='native'&&['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_PROFILE','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].some(key=>settings[key]))throw fault('CLAUDE_CONFIGURATION','Native login requires removing provider credential and endpoint overrides from this worker. Sign in using the official Claude Code CLI.');
 let config;try{config=providerConfiguration(context,settings,authMode==='native'?{nativeClaudeLogin:true}:undefined);}catch{throw fault('CLAUDE_CONFIGURATION','Review the approved Claude model, authentication mode and run limits.');}
 if(config.provider!=='anthropic'||context.installation.pluginId!=='claude-code')throw fault('CLAUDE_CONFIGURATION','Install the Claude Code bridge before using this adapter.');
 if(!settings.COATRIA_CLAUDE_WORKSPACE||!isAbsolute(settings.COATRIA_CLAUDE_WORKSPACE))throw fault('CLAUDE_CONFIGURATION','Set COATRIA_CLAUDE_WORKSPACE to an absolute, dedicated worker directory.');
 let cwd;try{cwd=await realpath(settings.COATRIA_CLAUDE_WORKSPACE);if(!(await stat(cwd)).isDirectory())throw new Error();}catch{throw fault('CLAUDE_CONFIGURATION','The dedicated Claude worker directory is unavailable.');}
 if(!mcpEnvironment||mcpEnvironment.COATRIA_RUN_ID!==run.id||!mcpEnvironment.COATRIA_RUN_LEASE||!settings.COATRIA_AGENT_TOKEN)throw fault('CLAUDE_CONFIGURATION','The trusted worker must supply an active Coatria run connection.');
 const catalog=await tools.list(),caps=new Set(context.capabilities||[]);if(!Array.isArray(catalog?.tools)||catalog.tools.length>100)throw fault('CLAUDE_TOOL_CATALOG','Invalid Coatria tool catalog.');
 const names=catalog.tools.filter(tool=>caps.has(tool.capability)).map(tool=>{if(!/^[-a-zA-Z0-9_]{1,80}$/.test(tool.name))throw fault('CLAUDE_TOOL_CATALOG','Invalid Coatria tool name.');return 'mcp__coatria__'+tool.name;});
 const mcp={mcpServers:{coatria:{command:process.execPath,args:[resolve(location,'agent-mcp.mjs')]}}};
 const args=['--print',...(authMode==='api-key'?['--bare']:[]),'--restricted','--no-chrome','--no-session-persistence','--disable-slash-commands','--setting-sources','',
  '--output-format','stream-json','--verbose','--input-format','text','--tools','','--strict-mcp-config','--mcp-config',JSON.stringify(mcp),
  '--permission-mode','dontAsk','--max-turns',String(config.limits.maxSteps),'--model',config.model,
  '--settings',JSON.stringify({disableAllHooks:true,autoMemoryEnabled:false}),
  '--append-system-prompt',bridgePolicy+characterInstructions(context.installation)];
 if(names.length)args.push('--allowedTools',names.join(','));
 const dollars=Number(settings.COATRIA_CLAUDE_MAX_BUDGET_USD||1);if(!Number.isFinite(dollars)||dollars<=0||dollars>100)throw fault('CLAUDE_CONFIGURATION','Configure a Claude cost guard between zero and 100 USD.');args.push('--max-budget-usd',String(dollars));
 const input=JSON.stringify({verifiedRequest:{id:run.id,prompt:run.prompt},untrustedConversationContext:{messages:context.messages||[]}});if(Buffer.byteLength(input)>300000)throw fault('CLAUDE_CONTEXT_LIMIT','The supplied conversation context is too large.');
 const env={};for(const key of['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','CLAUDE_CONFIG_DIR'])if(settings[key])env[key]=settings[key];
 Object.assign(env,{COATRIA_URL:mcpEnvironment.COATRIA_URL,COATRIA_RUN_ID:mcpEnvironment.COATRIA_RUN_ID,COATRIA_RUN_LEASE:mcpEnvironment.COATRIA_RUN_LEASE,COATRIA_AGENT_TOKEN:settings.COATRIA_AGENT_TOKEN,...(authMode==='api-key'?{ANTHROPIC_API_KEY:config.key}:{}),CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(config.limits.maxOutputTokens),CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY:'1',DISABLE_AUTOUPDATER:'1',MCP_TIMEOUT:'30000',MCP_TOOL_TIMEOUT:'45000',MAX_MCP_OUTPUT_TOKENS:'16000'});
 return {command:settings.COATRIA_CLAUDE_BIN||'claude',args,cwd,env,input,timeoutMs:config.limits.timeoutSeconds*1000,maxTotalTokens:config.limits.maxTotalTokens,allowedTools:names};
}

export async function execute(options){
 if(options.recovering===true||options.run?.attempts>1)throw fault('CLAUDE_REPLAY_UNSAFE','Review committed actions before creating a new request; uncertain Claude execution is not replayed.');
 options.signal?.throwIfAborted();const invocation=await claudeInvocation(options);options.signal?.throwIfAborted();
 return new Promise((resolveRun,reject)=>{
  const child=spawn(invocation.command,invocation.args,{cwd:invocation.cwd,env:invocation.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']}),signal=options.signal;
  let buffer='',bytes=0,result='',success=false,connected=false,failed=false,settled=false,killTimer;const decoder=new StringDecoder('utf8'),usage=new Map();
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolveRun(value);};
  const stop=()=>{if(child.exitCode===null&&!killTimer){child.kill('SIGTERM');killTimer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},2000);killTimer.unref();}};
  const abort=()=>{stop();finish(fault('CLAUDE_CANCELLED','Claude execution stopped because the Coatria request ended.'));};
  const timer=setTimeout(()=>{stop();finish(fault('CLAUDE_TIMEOUT','Claude execution reached its configured time limit.'));},invocation.timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  const tokenCount=value=>{if(!value||typeof value!=='object')throw new Error();let sum=0;for(const key of['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens']){const count=value[key]??0;if(!Number.isSafeInteger(count)||count<0)throw new Error();sum+=count;}return sum;};
  const parseLine=line=>{if(!line.trim()||settled)return;let event;try{event=JSON.parse(line);if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')throw new Error();
   if(event.type==='system'&&event.subtype==='init'){
    connected=Array.isArray(event.mcp_servers)&&event.mcp_servers.length===1&&event.mcp_servers[0].name==='coatria'&&event.mcp_servers[0].status==='connected';
    if(!connected)throw fault('CLAUDE_MCP_UNAVAILABLE','Claude did not connect to the required Coatria MCP server.');
    if(!Array.isArray(event.tools)||event.tools.some(name=>name!=='EndConversation'&&!invocation.allowedTools.includes(name)))throw fault('CLAUDE_TOOL_SCOPE','Claude exposed tools outside the approved Coatria tool set.');
   }
   if(event.type==='assistant'&&event.message?.usage){if(typeof event.message.id!=='string')throw new Error();usage.set(event.message.id,Math.max(usage.get(event.message.id)||0,tokenCount(event.message.usage)));if([...usage.values()].reduce((a,b)=>a+b,0)>invocation.maxTotalTokens){stop();finish(fault('CLAUDE_TOKEN_LIMIT','Claude reached its observed total token limit.'));return;}}
   if(event.type==='result'){
    if(event.subtype==='error_max_turns')throw fault('CLAUDE_TURN_LIMIT','Claude reached its configured turn limit.');
    if(event.subtype==='error_max_budget_usd')throw fault('CLAUDE_COST_LIMIT','Claude reached its configured cost guard.');
    if(event.subtype!=='success'||event.is_error!==false||typeof event.result!=='string'||!event.result.trim()||event.result.length>12000||!event.usage)throw fault('CLAUDE_RESULT_INVALID','Claude did not produce a valid bounded result.');
    if(tokenCount(event.usage)>invocation.maxTotalTokens)throw fault('CLAUDE_TOKEN_LIMIT','Claude reached its observed total token limit.');result=event.result.trim();success=true;
   }
   if(event.type==='error')throw new Error();
  }catch(error){failed=true;stop();finish(error instanceof ClaudeAdapterError?error:fault('CLAUDE_PROTOCOL_INVALID','Claude did not produce a valid bounded result with the required Coatria connection.'));}};
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){stop();finish(fault('CLAUDE_OUTPUT_LIMIT','Claude output exceeded the permitted size.'));return;}buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);parseLine(line);}});
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){stop();finish(fault('CLAUDE_OUTPUT_LIMIT','Claude diagnostics exceeded the permitted size.'));}});
  child.stdin.on('error',()=>{});
  child.on('error',()=>finish(fault('CLAUDE_START_FAILED','Claude could not start. Verify the CLI path, version and selected worker authentication.')));
  child.on('close',code=>{clearTimeout(killTimer);parseLine(buffer+decoder.end());if(signal?.aborted)return abort();if(code!==0||failed)return finish(fault('CLAUDE_EXIT_FAILED','Claude did not complete with the required Coatria MCP connection.'));if(!connected)return finish(fault('CLAUDE_MCP_UNAVAILABLE','Claude did not connect to the required Coatria MCP server.'));if(!success)return finish(fault('CLAUDE_RESULT_INVALID','Claude did not produce a valid bounded result.'));finish(null,{result});});
  if(signal?.aborted)return abort();child.stdin.end(invocation.input);
 });
}
