import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter,getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ClientRequest,IncomingMessage,IncomingHttpHeaders} from 'node:http';
import {Agent,type RequestOptions} from 'node:https';
import type {LookupAddress} from 'node:dns';
import {createHiggsfieldOutputFetcher,HiggsfieldOutputFetchError,type HiggsfieldOutputRead,type HiggsfieldOutputFetchCode} from '../src/lib/higgsfield-output-fetch';

const host='media.reviewed.example',locator=`https://${host}/private/output.png?signature=synthetic-private-token`;
const public4={address:'93.184.216.34',family:4},public6={address:'2606:4700:4700::1111',family:6};
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const forever=<T>()=>new Promise<T>(()=>{});
type Dependencies=NonNullable<Parameters<typeof createHiggsfieldOutputFetcher>[1]>;
type ResponseStream=IncomingMessage&PassThrough;
function incoming(headers:IncomingHttpHeaders={},statusCode=200){
 const stream=new PassThrough({highWaterMark:64*1024}) as ResponseStream;
 stream.statusCode=statusCode;stream.headers=headers;stream.rawHeaders=Object.entries(headers).flatMap(([key,value])=>(Array.isArray(value)?value:[String(value)]).flatMap(value=>[key,value]));stream.complete=false;return stream;
}
function finish(response:ResponseStream,body:Uint8Array=Buffer.from('abcdef')){response.complete=true;response.end(body);}
function harness(options:{answers?:LookupAddress[];resolve?:Dependencies['resolve'];onRequest?:(options:RequestOptions)=>void;onEnd?:(callback:(response:IncomingMessage)=>void,req:ClientRequest)=>void;headers?:IncomingHttpHeaders;status?:number;body?:Uint8Array}={}){
 const state={dns:0,requests:0,destroyedAgents:0,requestOptions:[] as RequestOptions[],requestObjects:[] as ClientRequest[],responses:[] as ResponseStream[],destroyedRequests:0};
 const dependencies:Dependencies={
  resolve:async(name,signal)=>{state.dns++;assert.equal(name,host);return options.resolve?options.resolve(name,signal):options.answers??[{...public4}];},
  request:(config,callback)=>{
   state.requests++;state.requestOptions.push(config);assert(config.agent instanceof Agent);
   const close=config.agent.destroy.bind(config.agent);config.agent.destroy=()=>{state.destroyedAgents++;close();};options.onRequest?.(config);
   const req=new EventEmitter() as ClientRequest;let destroyed=false;
   Object.defineProperty(req,'destroyed',{get:()=>destroyed});
   req.destroy=(error?:Error)=>{if(!destroyed){destroyed=true;state.destroyedRequests++;if(error)queueMicrotask(()=>req.emit('error',error));}return req;};
   req.end=(()=>{queueMicrotask(()=>{
    if(options.onEnd){options.onEnd(callback,req);return;}
    const response=incoming(options.headers,options.status);state.responses.push(response);callback(response);finish(response,options.body);
   });return req;}) as ClientRequest['end'];state.requestObjects.push(req);return req;
  }
 };
 const read=createHiggsfieldOutputFetcher({allowedHosts:[host],authorityIntervalMs:10,authorityTimeoutMs:60},dependencies);
 const chunks:Buffer[]=[];
 const input=(patch:Partial<HiggsfieldOutputRead>={}):HiggsfieldOutputRead=>({locator,maxBytes:1024,deadlineMs:500,assertAuthority:async()=>true,consume:async bytes=>{chunks.push(Buffer.from(bytes));},...patch});
 return {state,dependencies,read,input,chunks};
}
async function rejectsCode(run:()=>Promise<unknown>,code:HiggsfieldOutputFetchCode){
 await assert.rejects(run,error=>{assert(error instanceof HiggsfieldOutputFetchError);assert.equal(error.code,code);assert.equal(error.message,code);assert.equal((error as any).cause,undefined);assert(!JSON.stringify(error).includes('synthetic-private-token'));assert(!String(error.stack).includes(locator));return true;});
}
function pinned(options:RequestOptions,all=false){
 let result:string|LookupAddress[]|undefined,family:number|undefined;let called=false;
 options.lookup!(host,{all},(error,address,resolvedFamily)=>{assert.equal(error,null);called=true;result=address;family=resolvedFamily;});assert(called);return {result,family};
}

test('trusted host policy has no defaults, wildcards, IP literals, suffix matching or mutable allowlist',async()=>{
 for(const allowedHosts of[[],['*.example'],['example'],['127.0.0.1'],['[::1]'],['MEDIA.example'],['media.example.'],['a..example'],['https://media.example'],['media.example:443'],[host.repeat(20)]])assert.throws(()=>createHiggsfieldOutputFetcher({allowedHosts}),{code:'HIGGSFIELD_OUTPUT_POLICY_INVALID'});
 const h=harness(),allowedHosts=[host],read=createHiggsfieldOutputFetcher({allowedHosts},h.dependencies);allowedHosts.push('unreviewed.example');
 await rejectsCode(()=>read(h.input({locator:'https://unreviewed.example/private'})),'HIGGSFIELD_OUTPUT_URL_REJECTED');
 assert.equal(h.state.dns,0);assert.equal(h.state.requests,0);
});
test('strict HTTPS locator rejects ambiguous authorities, credentials, fragments, IP forms and other ports before DNS',async()=>{
 const bad=[`http://${host}/x`,`https://user:pass@${host}/x`,`https://@${host}/x`,`https://${host}:444/x`,`https://${host}:0443/x`,`https://${host}:/x`,`https://${host}/x#`,`https://${host}/x#fragment`,`https://${host}.evil.example/x`,`https://prefix.${host}/x`,`https://${host}./x`,`https://%6dedia.reviewed.example/x`,`https:\\${host}/x`,`https://${host}/x\n`,`https://${host}/x y`,'https://127.1/x','https://2130706433/x','https://0x7f000001/x','https://[::1]/x','https://[::ffff:127.0.0.1]/x','https://[fe80::1%25eth0]/x','https://ｍedia.reviewed.example/x'];
 for(const value of bad){const h=harness();await rejectsCode(()=>h.read(h.input({locator:value})),'HIGGSFIELD_OUTPUT_URL_REJECTED');assert.equal(h.state.dns,0);}
 const h=harness();assert.equal((await h.read(h.input({locator:`https://${host}:443/x`}))).bytes,6);
});
test('all DNS answers must be public, including expanded IPv6 and public/private mixed answers',async()=>{
 const private4=['0.1.2.3','10.1.1.1','100.64.0.1','100.127.255.254','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.254','192.0.0.9','192.0.2.1','192.88.99.1','192.168.1.1','198.18.0.1','198.19.255.254','198.51.100.1','203.0.113.1','224.0.0.1','239.255.255.255','240.0.0.1','255.255.255.255','168.63.129.16'];
 const private6=['::','::1','::ffff:127.0.0.1','::ffff:93.184.216.34','64:ff9b::a00:1','64:ff9b:1::1','100::1','100:0:0:1::1','2001::1','2001:0:0:0:0:0:0:1','2001:2::1','2001:db8::1','2002:7f00:1::','3ffe::1','3fff:fff::1','5f00::1','fc00::1','fe80::1','fe80::1%eth0','ff02::1'];
 for(const answer of [...private4.map(address=>({address,family:4})),...private6.map(address=>({address,family:6})),{address:'93.184.216.34',family:6},{address:'not-an-ip',family:4}]){
  const h=harness({answers:[public4,answer]});await rejectsCode(()=>h.read(h.input()),'HIGGSFIELD_OUTPUT_DNS_REJECTED');assert.equal(h.state.requests,0);
 }
 for(const answers of[[],Array.from({length:33},()=>public4)]){const h=harness({answers});await rejectsCode(()=>h.read(h.input()),'HIGGSFIELD_OUTPUT_DNS_REJECTED');}
 const h=harness({answers:[public6,public4]});assert.equal((await h.read(h.input())).bytes,6);assert.equal(h.state.requestOptions[0].family,6);assert.deepEqual(pinned(h.state.requestOptions[0],true).result,[public6]);
});
test('native request configuration pins one validated address, retains TLS hostname verification, and never reuses a proxy or pool',async()=>{
 const answers=[{...public4},public6],h=harness({answers,onRequest:options=>{
  answers[0].address='127.0.0.1';assert.deepEqual(pinned(options),{result:public4.address,family:4});assert.deepEqual(pinned(options,true),{result:[public4],family:undefined});
  let mismatched:Error|null|undefined;options.lookup!('other.example',{},error=>{mismatched=error;});assert(mismatched);
  assert.equal(options.hostname,host);assert.equal(options.servername,host);assert.equal(options.port,443);assert.equal(options.method,'GET');assert.equal(options.protocol,'https:');assert.equal(options.path,'/private/output.png?signature=synthetic-private-token');
  assert.equal(options.rejectUnauthorized,true);assert.equal(options.insecureHTTPParser,false);assert.equal(options.maxHeaderSize,16384);assert.equal(options.auth,undefined);assert.equal(options.socketPath,undefined);assert.equal(options.createConnection,undefined);
  const tls=options.checkServerIdentity!;assert.equal(tls('attacker.example',{subjectaltname:'DNS:'+host} as any),undefined);assert(tls(host,{subjectaltname:'DNS:attacker.example'} as any));
  assert.deepEqual(options.headers,{Host:host,Accept:'*/*','Accept-Encoding':'identity',Connection:'close'});
  const agent=options.agent as Agent;assert.equal(agent.options.keepAlive,false);assert.equal(agent.options.maxCachedSessions,0);assert.equal(agent.options.autoSelectFamily,false);assert.deepEqual((agent.options as any).proxyEnv,{});
 }});
 const first=await h.read(h.input());assert.equal(first.sha256,createHash('sha256').update('abcdef').digest('hex'));assert.equal(first.bytes,6);assert.equal(h.state.dns,1);assert.equal(h.state.requests,1);assert(h.state.destroyedAgents>=1);
 answers[0]={...public4};await h.read(h.input());assert.notEqual(h.state.requestOptions[0].agent,h.state.requestOptions[1].agent);assert.equal(h.state.dns,2);assert.equal(Buffer.concat(h.chunks).toString(),'abcdefabcdef');
});
test('response policy rejects redirects, partial/error statuses, transformations and ambiguous lengths without exposing bodies',async()=>{
 const cases:Array<[number,IncomingHttpHeaders,HiggsfieldOutputFetchCode]>=[
  [301,{location:'http://169.254.169.254/private'},'HIGGSFIELD_OUTPUT_REDIRECT_REJECTED'],[302,{location:`https://${host}/again`},'HIGGSFIELD_OUTPUT_REDIRECT_REJECTED'],[307,{},'HIGGSFIELD_OUTPUT_REDIRECT_REJECTED'],[204,{},'HIGGSFIELD_OUTPUT_STATUS_REJECTED'],[206,{},'HIGGSFIELD_OUTPUT_STATUS_REJECTED'],[403,{},'HIGGSFIELD_OUTPUT_STATUS_REJECTED'],
  [200,{'content-encoding':'gzip'},'HIGGSFIELD_OUTPUT_ENCODING_REJECTED'],[200,{'content-encoding':'br'},'HIGGSFIELD_OUTPUT_ENCODING_REJECTED'],[200,{'content-encoding':'identity, gzip'},'HIGGSFIELD_OUTPUT_ENCODING_REJECTED'],[200,{'content-range':'bytes 0-5/6'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':'6','transfer-encoding':'chunked'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'transfer-encoding':'gzip,chunked'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':['6','6']} as unknown as IncomingHttpHeaders,'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':'6, 6'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':'-1'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':'6e0'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':'9007199254740993'},'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[200,{'content-length':'1025'},'HIGGSFIELD_OUTPUT_SIZE_EXCEEDED']
 ];
 for(const [status,headers,code]of cases){const h=harness({status,headers});await rejectsCode(()=>h.read(h.input()),code);assert.equal(h.chunks.length,0);assert.equal(h.state.requests,1);assert(h.state.responses[0].destroyed);}
 const h=harness({headers:{'content-encoding':'identity','transfer-encoding':'chunked'}});assert.equal((await h.read(h.input())).bytes,6);
});
test('actual stream length, incomplete EOF and byte ceilings are enforced independently of provider headers',async()=>{
 for(const [headers,maxBytes,code]of [[{},5,'HIGGSFIELD_OUTPUT_SIZE_EXCEEDED'],[{'content-length':'5'},1024,'HIGGSFIELD_OUTPUT_LENGTH_INVALID'],[{'content-length':'7'},1024,'HIGGSFIELD_OUTPUT_LENGTH_INVALID']] as const){const h=harness({headers});await rejectsCode(()=>h.read(h.input({maxBytes})),code);}
 const h=harness({onEnd:callback=>{const r=incoming();callback(r);r.end('abcdef');}});await rejectsCode(()=>h.read(h.input()),'HIGGSFIELD_OUTPUT_LENGTH_INVALID');
 const good=harness({headers:{'content-length':'6'}});assert.equal((await good.read(good.input({maxBytes:6}))).bytes,6);
});
test('consumer backpressure is sequential, chunk-bounded and hashed without full-media aggregation',async()=>{
 const bytes=Buffer.alloc(190000,42),h=harness({body:bytes});let busy=false,calls=0,total=0;
 const result=await h.read(h.input({maxBytes:bytes.length,consume:async chunk=>{assert(!busy);busy=true;assert(chunk.byteLength<=65536);calls++;total+=chunk.byteLength;await wait(2);busy=false;}}));
 assert.equal(total,bytes.length);assert.equal(calls,3);assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
});
test('per-read scalar limits and callbacks cannot change during asynchronous DNS or consumption',async()=>{
 let input:HiggsfieldOutputRead,originalCalls=0;
 const h=harness({resolve:async()=>{input.maxBytes=10000;input.deadlineMs=10000;input.consume=async()=>{throw Error('replacement consumer');};input.assertAuthority=async()=>{throw Error('replacement authority');};return [public4];}});
 input=h.input({maxBytes:5,assertAuthority:async()=>{originalCalls++;return true;}});await rejectsCode(()=>h.read(input),'HIGGSFIELD_OUTPUT_SIZE_EXCEEDED');assert(originalCalls>=3);assert.equal(h.chunks.length,0);
 const other=harness();const stable=other.input({consume:async chunk=>{other.chunks.push(Buffer.from(chunk));stable.assertAuthority=async()=>false;}});assert.equal((await other.read(stable)).bytes,6);assert.equal(other.chunks.length,1);
});
test('revoked initial authority prevents DNS and network access and strips callback diagnostics',async()=>{
 for(const callback of[async()=>false,async()=>{throw Error(locator);}]){const h=harness();await rejectsCode(()=>h.read(h.input({assertAuthority:callback})),'HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED');assert.equal(h.state.dns,0);assert.equal(h.state.requests,0);}
 const h=harness();await rejectsCode(()=>h.read(h.input({assertAuthority:async()=>forever()})),'HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED');assert.equal(h.state.requests,0);
});
test('periodic authority checks abort stalled DNS, headers, body and destination',async()=>{
 for(const stage of['dns','headers','body','consumer']){
  let active=false,checks=0,seenSignal:AbortSignal|undefined,body:ResponseStream|undefined;
  const h=harness({resolve:stage==='dns'?async()=>{active=true;return forever();}:undefined,onEnd:(callback)=>{if(stage==='headers'){active=true;return;}body=incoming();callback(body);if(stage==='body'){active=true;return;}finish(body);}});
  await rejectsCode(()=>h.read(h.input({assertAuthority:async()=>{checks++;return !active;},...(stage==='consumer'?{consume:async(_chunk:Uint8Array,signal:AbortSignal)=>{active=true;seenSignal=signal;return forever<void>();}}:{})})),'HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED');
  assert(checks>=2,stage);if(stage==='dns')assert.equal(h.state.requests,0);else assert(h.state.destroyedRequests>=1);if(body)assert(body.destroyed);if(seenSignal){assert(seenSignal.aborted);assert.equal(getEventListeners(seenSignal,'abort').length,0);}
 }
});
test('absolute deadline covers stalled DNS, headers, body, consumer and authority',async()=>{
 for(const stage of['dns','headers','body','consumer','authority']){
  const h=harness({resolve:stage==='dns'?async()=>forever():undefined,onEnd:callback=>{if(stage==='headers')return;const r=incoming();callback(r);if(stage!=='body')finish(r);}});
  await rejectsCode(()=>h.read(h.input({deadlineMs:25,...stage==='consumer'?{consume:async()=>forever<void>()}:{},...stage==='authority'?{assertAuthority:async()=>forever()}:{}})),'HIGGSFIELD_OUTPUT_DEADLINE');
 }
});
test('external abort reason remains private and listeners are removed even when the consumer never settles',async()=>{
 const h=harness(),controller=new AbortController();let signal:AbortSignal|undefined;
 await rejectsCode(()=>h.read(h.input({signal:controller.signal,consume:async(_chunk,current)=>{signal=current;controller.abort(Error(locator));return forever<void>();}})),'HIGGSFIELD_OUTPUT_ABORTED');
 assert.equal(getEventListeners(controller.signal,'abort').length,0);assert(signal?.aborted);assert.equal(getEventListeners(signal!,'abort').length,0);
 const early=harness();await rejectsCode(()=>early.read(early.input({signal:controller.signal})),'HIGGSFIELD_OUTPUT_ABORTED');assert.equal(early.state.dns,0);
});
test('authority is rechecked after the final consumer and EOF before a successful digest can escape',async()=>{
 const h=harness();let allowed=true;
 await rejectsCode(()=>h.read(h.input({assertAuthority:async()=>allowed,consume:async()=>{allowed=false;}})),'HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED');
 assert.equal(h.state.requests,1);
});
test('late response callbacks after deadline are destroyed and cannot start consuming',async()=>{
 let deliver:((response:IncomingMessage)=>void)|undefined;
 const h=harness({onEnd:callback=>{deliver=callback;}});await rejectsCode(()=>h.read(h.input({deadlineMs:20})),'HIGGSFIELD_OUTPUT_DEADLINE');
 assert(deliver);const late=incoming();deliver(late);assert(late.destroyed);assert.equal(h.chunks.length,0);
});
test('resolver, request, stream and consumer failures expose only fixed diagnostic codes',async()=>{
 const dns=harness({resolve:async()=>{throw Error(locator);}});await rejectsCode(()=>dns.read(dns.input()),'HIGGSFIELD_OUTPUT_DNS_REJECTED');
 const native=harness();const broken=createHiggsfieldOutputFetcher({allowedHosts:[host]},{...native.dependencies,request:()=>{throw Error(locator);}});await rejectsCode(()=>broken(native.input()),'HIGGSFIELD_OUTPUT_TRANSPORT_FAILED');
 const stream=harness({onEnd:callback=>{const r=incoming();callback(r);r.destroy(Error(locator));}});await rejectsCode(()=>stream.read(stream.input()),'HIGGSFIELD_OUTPUT_TRANSPORT_FAILED');
 const sink=harness();await rejectsCode(()=>sink.read(sink.input({consume:async()=>{throw Error(locator);}})),'HIGGSFIELD_OUTPUT_CONSUMER_FAILED');
});
test('finite limits are required and malformed bounds have no provider effect',async()=>{
 for(const patch of[{maxBytes:0},{maxBytes:Infinity},{maxBytes:101*1024**3},{maxBytes:0.5},{deadlineMs:0},{deadlineMs:Infinity},{deadlineMs:2*60*60*1000+1}]){const h=harness();await rejectsCode(()=>h.read(h.input(patch)),'HIGGSFIELD_OUTPUT_POLICY_INVALID');assert.equal(h.state.dns,0);}
 for(const patch of[{authorityIntervalMs:0},{authorityIntervalMs:5001},{authorityTimeoutMs:0},{authorityTimeoutMs:5001}])assert.throws(()=>createHiggsfieldOutputFetcher({allowedHosts:[host],...patch}),{code:'HIGGSFIELD_OUTPUT_POLICY_INVALID'});
});
