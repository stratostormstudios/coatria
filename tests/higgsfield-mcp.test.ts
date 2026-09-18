import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  HIGGSFIELD_MCP_ENDPOINT, HIGGSFIELD_OAUTH_REDIRECT_URI, HiggsfieldMcpError,
  discoverHiggsfield, registerHiggsfield, higgsfieldAuthorizationUrl,
  exchangeHiggsfieldCode, refreshHiggsfieldToken, listHiggsfieldTools, callHiggsfieldTool,
  type HiggsfieldMetadata, type HiggsfieldClient,
} from '../src/lib/higgsfield-mcp';

const metadata: HiggsfieldMetadata = {resource: HIGGSFIELD_MCP_ENDPOINT, issuer: 'https://clerk.higgsfield.ai',
  authorization_endpoint: 'https://clerk.higgsfield.ai/oauth/authorize', token_endpoint: 'https://clerk.higgsfield.ai/oauth/token',
  registration_endpoint: 'https://clerk.higgsfield.ai/oauth/register', scopes: ['openid','email','offline_access']};
const client: HiggsfieldClient = {client_id: 'fixture-public-client', redirect_uris: [HIGGSFIELD_OAUTH_REDIRECT_URI], token_endpoint_auth_method: 'none'};
const codeVerifier = 'v'.repeat(43), state = 's'.repeat(43), accessToken = 'fixture-oauth-access-not-a-real-token';
const j = (value: unknown, status = 200, headers: Record<string,string> = {}) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json',...headers}});
const errorCode = (code: string) => (error: unknown) => error instanceof HiggsfieldMcpError && error.code === code;
const serverMetadata = {...metadata, code_challenge_methods_supported:['S256'], grant_types_supported:['authorization_code','refresh_token'], token_endpoint_auth_methods_supported:['none'], client_id_metadata_document_supported:true};
const protectedResource = {resource:HIGGSFIELD_MCP_ENDPOINT, authorization_servers:[metadata.issuer,'https://fnf-device-auth.higgsfield.ai'], scopes_supported:metadata.scopes};

function fixture(action: (payload: any, init: RequestInit, number: number) => Response | Promise<Response>, options: {sessionId?: string; version?: string} = {}) {
  const calls: {url:string;init:RequestInit;payload:any}[] = [];
  const transport: typeof fetch = async (url, init = {}) => {
    assert.equal(String(url),HIGGSFIELD_MCP_ENDPOINT); assert.equal(init.redirect,'error'); assert.equal(init.cache,'no-store');
    assert(init.signal); const headers = new Headers(init.headers); assert.equal(headers.get('authorization'),'Bearer '+accessToken);
    assert.equal(headers.get('accept'),'application/json, text/event-stream');
    const payload = JSON.parse(String(init.body)); calls.push({url:String(url),init,payload});
    if (payload.method === 'initialize') {
      assert.equal(headers.get('mcp-session-id'),null);
      return j({jsonrpc:'2.0',id:payload.id,result:{protocolVersion:options.version??'2025-11-25',capabilities:{tools:{}}}},200,options.sessionId?{'MCP-Session-Id':options.sessionId}:{});
    }
    assert.equal(headers.get('mcp-protocol-version'),options.version??'2025-11-25');
    assert.equal(headers.get('mcp-session-id'),options.sessionId??null);
    if(payload.method==='notifications/initialized'){assert.equal(payload.id,undefined);return new Response(null,{status:202});}
    return action(payload,init,calls.length);
  };
  return {transport,calls};
}
const tool = {name:'official_fixture_tool',description:'An actual discovered fixture schema',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}};

test('official discovery uses only public fixed metadata, selects Clerk PKCE and rejects changed endpoints',async()=>{
  const seen:string[]=[];
  const transport:typeof fetch=async(url,init)=>{seen.push(String(url));assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),null);return j(seen.length===1?protectedResource:serverMetadata);};
  const found=await discoverHiggsfield(transport);assert.equal(found.issuer,metadata.issuer);assert.equal(found.client_id_metadata_document_supported,true);
  assert.deepEqual(seen,['https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp','https://clerk.higgsfield.ai/.well-known/oauth-authorization-server']);
  for(const patch of [{issuer:'https://evil.invalid'},{token_endpoint:'https://clerk.higgsfield.ai.evil.invalid/oauth/token'},{registration_endpoint:'https://clerk.higgsfield.ai/oauth/other'},{code_challenge_methods_supported:['plain']},{token_endpoint_auth_methods_supported:['client_secret_basic']}]){
    let n=0;await assert.rejects(discoverHiggsfield(async()=>j(++n===1?protectedResource:{...serverMetadata,...patch})),errorCode('HIGGSFIELD_DISCOVERY_CHANGED'));
  }
  await assert.rejects(discoverHiggsfield(async()=>j({...protectedResource,authorization_servers:['https://evil.invalid']})),errorCode('HIGGSFIELD_DISCOVERY_CHANGED'));
});

test('metadata discovery uses fixed OpenID fallback only for unavailable discovery paths',async()=>{
  const seen:string[]=[];
  const value=await discoverHiggsfield(async(url)=>{seen.push(String(url));return seen.length===1?j(protectedResource):seen.length===2?j({},404):j(serverMetadata);});
  assert.equal(value.token_endpoint,metadata.token_endpoint);assert.equal(seen[2],metadata.issuer+'/.well-known/openid-configuration');
  let calls=0;await assert.rejects(discoverHiggsfield(async()=>++calls===1?j(protectedResource):j({},401)),errorCode('HIGGSFIELD_UNAUTHORIZED'));assert.equal(calls,2);
});

test('public PKCE registration and authorization bind exact production callback and MCP resource',async()=>{
  let calls=0;
  const registered=await registerHiggsfield(metadata,HIGGSFIELD_OAUTH_REDIRECT_URI,async(url,init)=>{
    calls++;assert.equal(String(url),metadata.registration_endpoint);assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),null);
    const input=JSON.parse(String(init?.body));assert.equal(input.token_endpoint_auth_method,'none');assert.deepEqual(input.redirect_uris,[HIGGSFIELD_OAUTH_REDIRECT_URI]);
    return j({...client,registration_access_token:'do-not-persist-extra-provider-secret',client_secret:'not-needed-by-public-client'});
  });
  assert.deepEqual(registered,client);assert.equal(calls,1);
  const url=new URL(higgsfieldAuthorizationUrl(metadata,registered,HIGGSFIELD_OAUTH_REDIRECT_URI,state,codeVerifier));
  assert.equal(url.origin,metadata.issuer);assert.equal(url.pathname,'/oauth/authorize');assert.equal(url.searchParams.get('state'),state);
  assert.equal(url.searchParams.get('resource'),HIGGSFIELD_MCP_ENDPOINT);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(codeVerifier).digest('base64url'));assert(!url.href.includes(codeVerifier));
  for(const redirect of ['https://evil.invalid/api/higgsfield/callback',HIGGSFIELD_OAUTH_REDIRECT_URI+'?next=https://evil.invalid','http://localhost:3000/callback']){
    await assert.rejects(registerHiggsfield(metadata,redirect,async()=>{throw new Error('must not call');}),errorCode('HIGGSFIELD_REDIRECT_INVALID'));
    assert.throws(()=>higgsfieldAuthorizationUrl(metadata,client,redirect,state,codeVerifier),errorCode('HIGGSFIELD_REDIRECT_INVALID'));
  }
  assert.throws(()=>higgsfieldAuthorizationUrl(metadata,client,HIGGSFIELD_OAUTH_REDIRECT_URI,'weak',codeVerifier),errorCode('HIGGSFIELD_STATE_INVALID'));
  assert.throws(()=>higgsfieldAuthorizationUrl(metadata,client,HIGGSFIELD_OAUTH_REDIRECT_URI,state,'weak'),errorCode('HIGGSFIELD_PKCE_INVALID'));
});

test('code exchange and refresh are resource-bound single POSTs; only required tokens returned',async()=>{
  const calls:URLSearchParams[]=[];
  const transport:typeof fetch=async(url,init)=>{
    assert.equal(String(url),metadata.token_endpoint);assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),null);const form=new URLSearchParams(String(init?.body));calls.push(form);
    assert.equal(form.get('resource'),HIGGSFIELD_MCP_ENDPOINT);assert.equal(form.get('client_id'),client.client_id);
    return j({access_token:accessToken,refresh_token:calls.length===1?'fixture-refresh':undefined,token_type:'bearer',expires_in:3600,scope:'openid email offline_access',id_token:'never-pass-id-token'});
  };
  const value=await exchangeHiggsfieldCode(metadata,client,HIGGSFIELD_OAUTH_REDIRECT_URI,'fixture-code',codeVerifier,transport);
  assert.equal(value.token_type,'Bearer');assert.equal('id_token' in value,false);assert.equal(calls[0].get('code_verifier'),codeVerifier);assert.equal(calls[0].get('redirect_uri'),HIGGSFIELD_OAUTH_REDIRECT_URI);
  const renewed=await refreshHiggsfieldToken(metadata,client,value.refresh_token!,transport);assert.equal(renewed.refresh_token,'fixture-refresh');assert.equal(calls[1].get('grant_type'),'refresh_token');
  assert.equal(calls.length,2);
  await assert.rejects(exchangeHiggsfieldCode({...metadata,token_endpoint:'https://evil.invalid'},client,HIGGSFIELD_OAUTH_REDIRECT_URI,'fixture-code',codeVerifier,transport),errorCode('HIGGSFIELD_DISCOVERY_CHANGED'));assert.equal(calls.length,2);
  let attempts=0;await assert.rejects(refreshHiggsfieldToken(metadata,client,'fixture-refresh',async()=>{attempts++;throw new Error('refresh-secret-leaked-if-not-redacted');}),errorCode('HIGGSFIELD_TRANSPORT_UNCONFIRMED'));assert.equal(attempts,1);
});

test('OAuth malformed expiration or changed public-client registration fails closed',async()=>{
  for(const expires_in of [undefined,0,-1,1.5,31536001])await assert.rejects(exchangeHiggsfieldCode(metadata,client,HIGGSFIELD_OAUTH_REDIRECT_URI,'fixture-code',codeVerifier,async()=>j({access_token:accessToken,token_type:'Bearer',expires_in})),errorCode('HIGGSFIELD_INVALID_RESPONSE'));
  await assert.rejects(registerHiggsfield(metadata,HIGGSFIELD_OAUTH_REDIRECT_URI,async()=>j({...client,redirect_uris:['https://evil.invalid']})),errorCode('HIGGSFIELD_CLIENT_INVALID'));
});

test('MCP tools discovery negotiates protocol/session and follows bounded exact cursors without renaming tools',async()=>{
  const f=fixture(payload=>{assert.equal(payload.method,'tools/list');return j({jsonrpc:'2.0',id:payload.id,result:payload.params.cursor?{tools:[{...tool,name:'second.actual_name'}]}:{tools:[tool],nextCursor:'fixture-page-two'}});},{sessionId:'opaque-session-fixture',version:'2025-06-18'});
  const result=await listHiggsfieldTools(accessToken,f.transport);assert.deepEqual(result.map(value=>value.name),['official_fixture_tool','second.actual_name']);assert.deepEqual(result[0].annotations,{readOnlyHint:true});
  assert.equal(f.calls.length,4);assert.equal(f.calls[3].payload.params.cursor,'fixture-page-two');
});

test('discovery rejects duplicate tools, repeated cursors, non-object schemas and unsupported protocol',async()=>{
  for(const result of [{tools:[tool,tool]},{tools:[{...tool,inputSchema:{type:'string'}}]}]){const f=fixture(payload=>j({jsonrpc:'2.0',id:payload.id,result}));await assert.rejects(listHiggsfieldTools(accessToken,f.transport),errorCode('HIGGSFIELD_CATALOG_INVALID'));}
  let pages=0;const repeated=fixture(payload=>j({jsonrpc:'2.0',id:payload.id,result:{tools:[{...tool,name:'page_'+(++pages)}],nextCursor:'same'}}));
  await assert.rejects(listHiggsfieldTools(accessToken,repeated.transport),errorCode('HIGGSFIELD_CATALOG_CURSOR'));assert.equal(pages,2);
  const unsupported=fixture(()=>{throw new Error('not reached');},{version:'2099-01-01'});await assert.rejects(listHiggsfieldTools(accessToken,unsupported.transport),errorCode('HIGGSFIELD_PROTOCOL_UNSUPPORTED'));assert.equal(unsupported.calls.length,1);
});

test('official tools/call preserves structured content and remote isError without executing remote instructions',async()=>{
  const expected={content:[{type:'text',text:'Official result'},{type:'resource_link',uri:'https://media.example.invalid/result.mp4',name:'result'}],structuredContent:{job_id:'fixture-job',status:'failed'},isError:true,_meta:{'ui/resourceUri':'ui://official-widget'}};
  const f=fixture(payload=>{assert.equal(payload.method,'tools/call');assert.deepEqual(payload.params,{name:tool.name,arguments:{prompt:'fixture prompt'}});return j({jsonrpc:'2.0',id:payload.id,result:expected});});
  assert.deepEqual(await callHiggsfieldTool(accessToken,tool.name,{prompt:'fixture prompt'},f.transport),expected);assert.equal(f.calls.length,3);
});

test('SSE handles chunked UTF-8, comments, progress and multiline data, then cancels stream after matching result',async()=>{
  let cancelled=false;
  const f=fixture(payload=>{
    const content=': comment\r\n\r\nevent: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progress:1}})+'\r\n\r\n'+
      'data: {"jsonrpc":"2.0",\n'+'data: "id":'+JSON.stringify(payload.id)+',"result":{"content":[{"type":"text","text":"café 🎬"}]}}\n\n';
    const bytes=new TextEncoder().encode(content);let offset=0;
    return new Response(new ReadableStream({pull(controller){if(offset<bytes.length){controller.enqueue(bytes.slice(offset,offset+3));offset+=3;}},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  });
  const result=await callHiggsfieldTool(accessToken,tool.name,{},f.transport);assert.equal(result.content[0].text,'café 🎬');assert.equal(cancelled,true);
});

test('RPC id/session mismatch or remote error is redacted, with no second generation submission',async()=>{
  for(const variant of ['id','session','error'] as const){let submits=0;const f=fixture(payload=>{submits++;return j({jsonrpc:'2.0',id:variant==='id'?'wrong':payload.id,...variant==='error'?{error:{code:-32603,message:'fixture-sensitive-argument',data:{access_token:accessToken}}}:{result:{content:[]}}},200,variant==='session'?{'MCP-Session-Id':'different'}:{});},{sessionId:'original'});
    await assert.rejects(callHiggsfieldTool(accessToken,tool.name,{},f.transport),(error:unknown)=>error instanceof HiggsfieldMcpError&&!String(error).includes(accessToken)&&!String(error).includes('fixture-sensitive-argument'));
    assert.equal(submits,1);
  }
});

test('lost paid response, incomplete SSE and session expiry never retry tools/call',async()=>{
  for(const kind of ['network','sse','expired']){let attempts=0;const f=fixture(()=>{attempts++;if(kind==='network')throw new Error('remote secret');if(kind==='expired')return j({},404);return new Response('id: fixture-event\ndata:\n\n',{headers:{'Content-Type':'text/event-stream'}});});
    await assert.rejects(callHiggsfieldTool(accessToken,tool.name,{},f.transport),error=>error instanceof HiggsfieldMcpError);assert.equal(attempts,1);assert.equal(f.calls.length,3);
  }
});

test('redirects and provider error bodies are never followed or reflected',async()=>{
  let attempts=0;await assert.rejects(discoverHiggsfield(async(_url,init)=>{attempts++;assert.equal(init?.redirect,'error');return new Response('secret',{status:302,headers:{Location:'https://evil.invalid'}});}),errorCode('HIGGSFIELD_HTTP_ERROR'));assert.equal(attempts,1);
  const f=fixture(()=>j({error:'fixture secret '+accessToken},429,{'Retry-After':'20'}));
  await assert.rejects(callHiggsfieldTool(accessToken,tool.name,{},f.transport),(error:unknown)=>error instanceof HiggsfieldMcpError&&error.status===429&&error.retryAfterSeconds===20&&!String(error).includes(accessToken));
});

test('streamed response size cap applies without Content-Length and cancels oversized bodies',async()=>{
  let cancelled=false;const f=fixture(()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(300000));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}}));
  await assert.rejects(callHiggsfieldTool(accessToken,tool.name,{},f.transport),errorCode('HIGGSFIELD_RESPONSE_LIMIT'));assert.equal(cancelled,true);
});

test('caller cancellation bounds uncooperative fetch and stream reads without exposing reason',async()=>{
  for(const phase of ['fetch','body']){
    const controller=new AbortController();let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});let cancelled=false;
    const f=fixture(()=>{began();if(phase==='fetch')return new Promise<Response>(()=>{});return new Response(new ReadableStream({pull(){return new Promise<void>(()=>{});},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});});
    const pending=callHiggsfieldTool(accessToken,tool.name,{}, {fetch:f.transport,signal:controller.signal,timeoutMs:3000});await started;controller.abort(new Error('private reason '+accessToken));
    await assert.rejects(pending,errorCode('HIGGSFIELD_TIMEOUT'));if(phase==='body')assert.equal(cancelled,true);assert.equal(f.calls.length,3);
  }
  const controller=new AbortController();controller.abort();let attempts=0;await assert.rejects(listHiggsfieldTools(accessToken,{fetch:async()=>{attempts++;throw new Error();},signal:controller.signal}),errorCode('HIGGSFIELD_TIMEOUT'));assert.equal(attempts,0);
});

test('request validation rejects oversized/cyclic arguments or token header injection before network',async()=>{
  let attempts=0;const transport:typeof fetch=async()=>{attempts++;throw new Error('network forbidden');};
  await assert.rejects(callHiggsfieldTool(accessToken,tool.name,{text:'x'.repeat(250001)},transport),errorCode('HIGGSFIELD_REQUEST_LIMIT'));
  const circular:Record<string,unknown>={};circular.self=circular;await assert.rejects(callHiggsfieldTool(accessToken,tool.name,circular,transport),errorCode('HIGGSFIELD_INVALID_INPUT'));
  await assert.rejects(callHiggsfieldTool('token\r\nX-Inject:secret',tool.name,{},transport),errorCode('HIGGSFIELD_TOKEN_INVALID'));
  assert.equal(attempts,0);
});

test('whole-operation deadline also bounds a provider that ignores AbortSignal',{timeout:1500},async()=>{
  let attempts=0;const keepAlive=setInterval(()=>{},1000);
  try{await assert.rejects(discoverHiggsfield({fetch:async()=>{attempts++;return new Promise<Response>(()=>{});},timeoutMs:25}),errorCode('HIGGSFIELD_TIMEOUT'));assert.equal(attempts,1);}
  finally{clearInterval(keepAlive);}
});
