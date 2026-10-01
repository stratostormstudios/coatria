/** Actual Web Request/Response boundary, synthetic executor only. No database,
 * provider, processor enrollment or production qualification is exercised. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ApiError} from '../src/lib/security';
import {createProjectImagePreparationServiceHttpHandler,type ProjectImagePreparationHttpExecutor} from '../src/lib/project-image-preparation-service-http';
import {createImagePreparationServiceClient} from '../src/lib/project-image-preparation-service-client';
const origin='https://app.example.com',serviceId=randomUUID(),token='ips_'+'s'.repeat(43),path='/api/internal/image-preparation-services/'+serviceId+'/claim';
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
const input=()=>({requestId:randomUUID(),deadlineAt:new Date(Date.now()+25000).toISOString()});
function request({url=origin+path,method='POST',body=JSON.stringify(input()),headers={},signal}: {url?:string;method?:string;body?:BodyInit;headers?:Record<string,string>;signal?:AbortSignal}={}){
 return new Request(url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json','accept-encoding':'identity',...headers},...method==='GET'?{}:{body},signal,...body instanceof ReadableStream?{duplex:'half'}:{}} as RequestInit);
}
function fixture(execute?:ProjectImagePreparationHttpExecutor,requestTimeoutMs?:number){
 const calls:Parameters<ProjectImagePreparationHttpExecutor>[]=[],handler=createProjectImagePreparationServiceHttpHandler({origin,requestTimeoutMs,execute:async(...args)=>{calls.push(args);return execute?execute(...args):{lease:null};}});return {handler,calls};
}
async function rejected(response:Response,status:number,code?:string){assert.equal(response.status,status);const json=await response.json();if(code)assert.equal(json.code,code);assert.match(json.code,/^(?:PREPARATION_SERVICE_|IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN)/);assert.doesNotMatch(JSON.stringify(json),/PRIVATE|ips_|ipt_|postgres|SELECT|https:/);assert.match(response.headers.get('cache-control')!,/no-store/);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('access-control-allow-origin'),null);}

test('exact POST composition supplies only parsed authority and signal, with bounded non-cacheable response',async()=>{
 const f=fixture(),body=input(),response=await f.handler(request({body:JSON.stringify(body)}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{lease:null});
 assert.equal(f.calls.length,1);const [id,bearer,operation,value,options]=f.calls[0];assert.equal(id,serviceId);assert.equal(bearer,token);assert.equal(operation,'claim');assert.deepEqual(value,body);assert.ok(options.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);assert.equal(response.headers.get('content-length'),String(Buffer.byteLength('{"lease":null}')));assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});

test('wrong path/origin/query/method and ambiguous credentials never reach the executor',async()=>{
 const f=fixture();
 for(const url of ['https://other.example.com'+path,origin+path+'?token=PRIVATE',origin+path+'#PRIVATE',origin+path+'/',origin+path.replace('/claim','/%63laim'),origin+path.replace(serviceId,serviceId.toUpperCase()),origin+path.replace('/claim','/constructor'),origin+'/v1/image-preparations/capabilities/'+serviceId+'/read-source'])await rejected(await f.handler(request({url})),404);
 const method=await f.handler(request({method:'GET'}));assert.equal(method.headers.get('allow'),'POST');await rejected(method,405);
 for(const authorization of ['Basic PRIVATE','Bearer '+token+', Bearer '+token,'Bearer ipt_'+'x'.repeat(43),'bearer '+token,'Bearer '+token+' extra'])await rejected(await f.handler(request({headers:{authorization}})),401);
 assert.equal(f.calls.length,0);
});

test('unsupported encodings, browser credentials, range and inconsistent framing are rejected',async()=>{
 const f=fixture();
 for(const headers of [{'content-type':'text/plain'},{'content-type':'application/json;charset=latin1'}])await rejected(await f.handler(request({headers})),415);
 const invalidHeaders:Record<string,string>[]=[{accept:'*/*'},{'accept-encoding':'gzip'},{'content-encoding':'gzip'},{'content-range':'bytes 0-1/2'},{range:'bytes=0-'},{cookie:'PRIVATE'},{origin},{expect:'100-continue'},{trailer:'PRIVATE'},{'content-length':'1, 1'},{'content-length':'001'},{'content-length':'-1'},{'content-length':'1','transfer-encoding':'chunked'},{'transfer-encoding':'gzip'},{'content-length':'1'}];
 for(const headers of invalidHeaders)await rejected(await f.handler(request({headers})),400);
 await rejected(await f.handler(request({headers:{'content-length':'65537'}})),413);assert.equal(f.calls.length,0);
});

test('streaming byte limit cancels the real request body before any execution',async()=>{
 let cancelled=0;const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(32769));},cancel(){cancelled++;}},{highWaterMark:0}),f=fixture();
 await rejected(await f.handler(request({body:stream})),413);assert.equal(cancelled,1);assert.equal(f.calls.length,0);assert.equal(stream.locked,false);
});

test('fatal UTF8, malformed JSON, unknown fields and operation schema mismatch fail closed',async()=>{
 const f=fixture();for(const body of [new Uint8Array([123,255,125]),'null','{"requestId":','[]',JSON.stringify({...input(),secret:'PRIVATE'}),JSON.stringify({...input(),preparationId:randomUUID()}),JSON.stringify({...input(),deadlineAt:'2026-01-01T00:00:00+00:00'})])await rejected(await f.handler(request({body})),400);
 assert.equal(f.calls.length,0);
});

test('expired/far-future declared deadlines and pre-aborted requests do not execute',async()=>{
 const f=fixture();await rejected(await f.handler(request({body:JSON.stringify({...input(),deadlineAt:new Date(Date.now()-1000).toISOString()})})),408);
 await rejected(await f.handler(request({body:JSON.stringify({...input(),deadlineAt:new Date(Date.now()+60000).toISOString()})})),400);
 const stop=new AbortController();stop.abort(Error('PRIVATE'));await rejected(await f.handler(request({signal:stop.signal})),499);assert.equal(f.calls.length,0);
});

test('body stall deadline cancels and drains the reader without accepting a partial request',async()=>{
 const cancelled=deferred(),stream=new ReadableStream<Uint8Array>({pull(){},cancel(){cancelled.resolve();}},{highWaterMark:0}),f=fixture(undefined,30);
 const response=await f.handler(request({body:stream}));await cancelled.promise;await rejected(response,408,'PREPARATION_SERVICE_TIMEOUT');assert.equal(f.calls.length,0);assert.equal(stream.locked,false);
});

test('in-flight execution remains awaited after disconnect, and late success is explicitly uncertain',async()=>{
 const entered=deferred(),release=deferred(),aborted=deferred();let serviceSignal:AbortSignal|undefined,settled=false;
 const f=fixture(async(_id,_token,_op,_value,{signal})=>{serviceSignal=signal;signal.addEventListener('abort',()=>aborted.resolve(),{once:true});entered.resolve();await release.promise;return {lease:null};}),stop=new AbortController();
 const response=f.handler(request({signal:stop.signal})).finally(()=>{settled=true;});try{await entered.promise;stop.abort(Error('PRIVATE'));await aborted.promise;await delay(5);assert.equal(settled,false,'HTTP must not detach unfinished execution');assert.equal(serviceSignal?.aborted,true);release.resolve();await rejected(await response,503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');}finally{release.resolve();await response;}
});

test('declared deadline remains active while executor drains and suppresses success afterward',async()=>{
 const entered=deferred(),release=deferred(),aborted=deferred();let settled=false;
 const f=fixture(async(_id,_token,_op,_value,{signal})=>{entered.resolve();signal.addEventListener('abort',()=>aborted.resolve(),{once:true});await release.promise;return {lease:null};});
 const response=f.handler(request({body:JSON.stringify({...input(),deadlineAt:new Date(Date.now()+500).toISOString()})})).finally(()=>{settled=true;});
 try{await Promise.race([entered.promise,response.then(()=>assert.fail('Request ended before executor entry'))]);await aborted.promise;assert.equal(settled,false);release.resolve();await rejected(await response,503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');}finally{release.resolve();await response;}
});

test('executor errors and malformed responses never reflect private messages, headers or unknown data',async()=>{
 for(const [error,status,code]of [[new ApiError(403,'PRIVATE token postgres', 'PRIVATE',{'set-cookie':'PRIVATE'}),403,'PREPARATION_SERVICE_FORBIDDEN'],[new ApiError(503,'PRIVATE SQL', 'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN'),503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN'],[new Error('PRIVATE SQL SELECT token'),503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN']] as const){const f=fixture(async()=>{throw error;});await rejected(await f.handler(request()),status,code);assert.equal(f.calls.length,1);}
 for(const result of [{lease:null,token:'PRIVATE'},null,{authorized:true}])await rejected(await fixture(async()=>result).handler(request()),503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');
});

test('incoming body cancellation failure prevents execution and emits no raw cleanup error',async()=>{
 const stream=new ReadableStream<Uint8Array>({pull(){},cancel(){throw Error('PRIVATE cleanup path');}},{highWaterMark:0}),f=fixture();
 await rejected(await f.handler(request({body:stream,headers:{authorization:'invalid'}})),503,'PREPARATION_SERVICE_UNAVAILABLE');assert.equal(f.calls.length,0);
 const oversized=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(65537));},cancel(){throw Error('PRIVATE cleanup path');}},{highWaterMark:0});
 await rejected(await f.handler(request({body:oversized})),503,'PREPARATION_SERVICE_UNAVAILABLE');assert.equal(oversized.locked,false,'Own reader is released even when underlying cancellation fails');assert.equal(f.calls.length,0);
});

test('real preparation client composes through Request/Response without a route or database',async()=>{
 const companyId=randomUUID(),projectId=randomUUID(),expiresAt=new Date(Date.now()+300000).toISOString(),processor={id:serviceId,location:'Synthetic HTTP boundary',qualificationSha256:'a'.repeat(64),releaseSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),closureSha256:'e'.repeat(64),transport:'linux_binary_v1' as const,recipeSha256:'f'.repeat(64),expiresAt},f=fixture(async(_id,_token,op)=>op==='readiness'?{readiness:{serviceId,companyId,projectIds:[projectId],processor,expiresAt}}:{lease:null});
 const client=createImagePreparationServiceClient({origin,serviceId,companyId,projectIds:[projectId],gateways:[{projectId,origin:'https://gateway.example.com'}],token,expiresAt,processor},{fetch:async(url,init)=>f.handler(new Request(url,init))});
 try{assert.equal((await client.readiness()).serviceId,serviceId);assert.equal(await client.control.claim({companyId,projectIds:[projectId]},{signal:new AbortController().signal,assertCurrent(){}}),null);assert.equal(f.calls.length,2);}finally{client.close();await client.drain();}
});
