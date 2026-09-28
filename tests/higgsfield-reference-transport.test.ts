import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter,getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {Agent,type RequestOptions} from 'node:https';
import {createHiggsfieldReferenceUploader,HiggsfieldReferenceTransportError,type HiggsfieldReferenceUpload,type HiggsfieldReferenceTransportCode} from '../src/lib/higgsfield-reference-transport';

const host='uploads.reviewed.example',locator=`https://${host}/private/only.png?signature=synthetic-private-value`,bytes=Buffer.from('exact approved image');
const sha=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex'),public4={address:'93.184.216.34',family:4};
type Deps=NonNullable<Parameters<typeof createHiggsfieldReferenceUploader>[1]>;
function harness(options:{resolve?:Deps['resolve'];onRequest?:(request:RequestOptions)=>void;write?:(chunk:Uint8Array,done:(error?:Error)=>void)=>void;status?:number;headers?:Record<string,string>;reply?:Uint8Array;stallReply?:boolean;earlyResponse?:boolean;rawHeaders?:string[]}={}){
 const state={requests:0,dns:0,writes:[] as Buffer[],destroyed:0,options:[] as RequestOptions[],response:undefined as (IncomingMessage&PassThrough)|undefined};
 const deps:Deps={resolve:async(h,s)=>{state.dns++;return options.resolve?options.resolve(h,s):[{...public4}];},request:(o,reply)=>{
  state.requests++;state.options.push(o);options.onRequest?.(o);const req=new EventEmitter() as ClientRequest;let destroyed=false;
  req.destroy=(error?:Error)=>{if(!destroyed){destroyed=true;state.destroyed++;if(error)queueMicrotask(()=>req.emit('error',error));}return req;};
  req.write=((chunk:Uint8Array,done:(error?:Error)=>void)=>{state.writes.push(Buffer.from(chunk));if(options.write)options.write(chunk,done);else queueMicrotask(()=>done());return false;}) as ClientRequest['write'];
  const respond=()=>{const response=new PassThrough() as IncomingMessage&PassThrough;state.response=response;response.statusCode=options.status??200;response.headers=options.headers??{};response.rawHeaders=options.rawHeaders??Object.entries(response.headers).flatMap(([k,v])=>[k,String(v)]);response.complete=false;reply(response);if(!options.stallReply){response.complete=true;response.end(options.reply??Buffer.alloc(0));}};
  if(options.earlyResponse)queueMicrotask(respond);
  req.end=((done:()=>void)=>{queueMicrotask(()=>{done();if(!options.earlyResponse)respond();});return req;}) as ClientRequest['end'];return req;
 }};
 const upload=createHiggsfieldReferenceUploader({allowedHosts:[host],authorityIntervalMs:10,authorityTimeoutMs:30},deps);
 const input=(patch:Partial<HiggsfieldReferenceUpload>={}):HiggsfieldReferenceUpload=>({locator,body:bytes,bytes:bytes.length,sha256:sha(bytes),contentType:'image/png',deadlineMs:500,assertAuthority:async()=>true,...patch});
 return {state,deps,upload,input};
}
async function rejected(run:()=>Promise<unknown>,code:HiggsfieldReferenceTransportCode){await assert.rejects(run,error=>{assert(error instanceof HiggsfieldReferenceTransportError);assert.equal(error.code,code);assert.equal(error.message,code);assert.equal((error as any).cause,undefined);assert(!JSON.stringify(error).includes('synthetic-private'));assert(!String(error.stack).includes(locator));return true;});}
test('no default, wildcard, private-literal, suffix or mutable upload policy',async()=>{
 for(const allowedHosts of[[],['*.example'],['localhost'],['127.0.0.1'],['[::1]'],['UPPER.example'],['a..example']])assert.throws(()=>createHiggsfieldReferenceUploader({allowedHosts}),{code:'REFERENCE_UPLOAD_POLICY_INVALID'});
 const h=harness(),hosts=[host],upload=createHiggsfieldReferenceUploader({allowedHosts:hosts},h.deps);hosts.push('other.example');await rejected(()=>upload(h.input({locator:'https://other.example/private'})),'REFERENCE_UPLOAD_URL_REJECTED');assert.equal(h.state.dns,0);
});
test('private HTTPS capability is exact, unambiguous, credential-free and checked before DNS',async()=>{
 for(const url of[`http://${host}/p`,`https://user:secret@${host}/p`,`https://${host}:444/p`,`https://${host}:0443/p`,`https://${host}/p#x`,`https://${host}/p#`,`https://${host}.evil.example/p`,`https://${host}./p`,`https://%75ploads.reviewed.example/p`,`https://${host}/p\n`,`https://${host}/p x`,`https://ｍuploads.reviewed.example/p`,'https://127.1/p','https://[::1]/p']){const h=harness();await rejected(()=>h.upload(h.input({locator:url})),'REFERENCE_UPLOAD_URL_REJECTED');assert.equal(h.state.requests,0);assert.equal(h.state.dns,0);}
 const h=harness();await h.upload(h.input({locator:`https://${host}:443/p`}));assert.equal(h.state.requests,1);
});
test('all DNS answers must be public and addresses are copied and pinned to original TLS host',async()=>{
 for(const address of['0.0.0.1','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','198.18.0.1','224.0.0.1','168.63.129.16','::1','::ffff:93.184.216.34','2001:db8::1','2002::1','fc00::1','fe80::1']){const h=harness({resolve:async()=>[public4,{address,family:address.includes(':')?6:4}]});await rejected(()=>h.upload(h.input()),'REFERENCE_UPLOAD_DNS_REJECTED');assert.equal(h.state.requests,0);}
 const answers=[{...public4}],h=harness({resolve:async()=>answers,onRequest:o=>{
  answers[0].address='127.0.0.1';o.lookup!(host,{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,public4.address);assert.equal(family,4);});o.lookup!('wrong.example',{},error=>assert(error));
  assert.equal(o.method,'PUT');assert.equal(o.hostname,host);assert.equal(o.servername,host);assert.equal(o.port,443);assert.equal(o.rejectUnauthorized,true);assert.equal(o.insecureHTTPParser,false);assert.equal(o.auth,undefined);assert.equal(o.socketPath,undefined);assert.equal(o.createConnection,undefined);
  assert.deepEqual(o.headers,{Host:host,'Content-Type':'image/png','Content-Length':String(bytes.length),Accept:'*/*','Accept-Encoding':'identity',Connection:'close'});
  assert.equal(o.checkServerIdentity!('wrong.example',{subjectaltname:'DNS:'+host} as any),undefined);assert(o.checkServerIdentity!(host,{subjectaltname:'DNS:wrong.example'} as any));assert(o.agent instanceof Agent);assert.equal(o.agent.options.keepAlive,false);assert.equal(o.agent.options.maxCachedSessions,0);assert.deepEqual((o.agent.options as any).proxyEnv,{});
 }});assert.deepEqual(await h.upload(h.input()),{bytes:bytes.length,sha256:sha(bytes),status:200});assert.equal(h.state.requests,1);
});
test('byte length/hash are checked before disclosure and snapshot survives caller mutation',async()=>{
 const h=harness();await rejected(()=>h.upload(h.input({sha256:'0'.repeat(64)})),'REFERENCE_UPLOAD_BYTES_CHANGED');assert.equal(h.state.dns,0);
 await rejected(()=>h.upload(h.input({bytes:bytes.length+1})),'REFERENCE_UPLOAD_POLICY_INVALID');assert.equal(h.state.requests,0);
 const body=Buffer.alloc(150000,42),digest=sha(body),big=harness({resolve:async()=>{body.fill(0);return[public4];}});await big.upload(big.input({body,bytes:body.length,sha256:digest}));assert.equal(sha(Buffer.concat(big.state.writes)),digest);assert(big.state.writes.every(b=>b.length<=65536));assert.equal(big.state.writes.length,3);
});
test('only exact 200 complete bounded identity response succeeds; no redirects or retries',async()=>{
 const scenarios:Parameters<typeof harness>[0][]=[{status:302,headers:{location:'https://private.example/secret'}},{status:201},{status:204},{status:403},{status:500},{headers:{'content-encoding':'gzip'}},{headers:{'content-range':'bytes 0-1/2'}},{headers:{'content-length':'1','transfer-encoding':'chunked'}},{headers:{'content-length':'1'},reply:Buffer.from('too long')},{reply:Buffer.alloc(16385)},{headers:{'content-length':'0'},rawHeaders:['Content-Length','0','content-length','0']}];
 for(const scenario of scenarios){
  const h=harness(scenario);await rejected(()=>h.upload(h.input()),'REFERENCE_UPLOAD_RESPONSE_REJECTED');assert.equal(h.state.requests,1);assert.equal(h.state.dns,1);
 }
 const h=harness({status:403,earlyResponse:true,write:()=>{}});await rejected(()=>h.upload(h.input()),'REFERENCE_UPLOAD_RESPONSE_REJECTED');assert(h.state.writes.length<=1);
});
test('authority prevents initial disclosure and remains enforced while DNS, writes or response stall',async()=>{
 const denied=harness();await rejected(()=>denied.upload(denied.input({assertAuthority:async()=>false})),'REFERENCE_UPLOAD_AUTHORITY_REVOKED');assert.equal(denied.state.dns,0);
 for(const phase of['dns','write','response']){
  let active=true;const h=harness({...(phase==='dns'?{resolve:()=>new Promise(()=>{})}:{}),...(phase==='write'?{write:()=>{}}:{}),...(phase==='response'?{stallReply:true}:{})});
  const revoke=setTimeout(()=>{active=false;},35);await rejected(()=>h.upload(h.input({assertAuthority:async()=>active})),'REFERENCE_UPLOAD_AUTHORITY_REVOKED');clearTimeout(revoke);assert.equal(h.state.requests,phase==='dns'?0:1);
 }
});
test('hung authority, deadline, abort and transport failures are bounded, sanitized, and never retried',async()=>{
 const hung=harness();await rejected(()=>hung.upload(hung.input({assertAuthority:()=>new Promise(()=>{})})),'REFERENCE_UPLOAD_AUTHORITY_REVOKED');assert.equal(hung.state.requests,0);
 const stall=harness({write:()=>{}});await rejected(()=>stall.upload(stall.input({deadlineMs:30})),'REFERENCE_UPLOAD_DEADLINE');assert.equal(stall.state.requests,1);
 const h=harness({write:(_chunk,done)=>done(new Error(locator))});await rejected(()=>h.upload(h.input()),'REFERENCE_UPLOAD_TRANSPORT_FAILED');assert.equal(h.state.requests,1);
 const controller=new AbortController(),aborted=harness({stallReply:true});const timer=setTimeout(()=>controller.abort(),30);await rejected(()=>aborted.upload(aborted.input({signal:controller.signal})),'REFERENCE_UPLOAD_ABORTED');clearTimeout(timer);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
