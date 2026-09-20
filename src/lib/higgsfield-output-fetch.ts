/** Trusted Node worker foundation only. No routes, storage writes or default CDN
 * policy. A successful read proves bytes received, not media safety or storage. */
import {createHash} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import type {LookupAddress} from 'node:dns';
import {Agent,request as httpsRequest,type RequestOptions} from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {BlockList,isIP,type LookupFunction} from 'node:net';
import {checkServerIdentity} from 'node:tls';

export type HiggsfieldOutputFetchCode=
 |'HIGGSFIELD_OUTPUT_POLICY_INVALID'|'HIGGSFIELD_OUTPUT_URL_REJECTED'
 |'HIGGSFIELD_OUTPUT_DNS_REJECTED'|'HIGGSFIELD_OUTPUT_TRANSPORT_FAILED'
 |'HIGGSFIELD_OUTPUT_REDIRECT_REJECTED'|'HIGGSFIELD_OUTPUT_STATUS_REJECTED'
 |'HIGGSFIELD_OUTPUT_ENCODING_REJECTED'|'HIGGSFIELD_OUTPUT_LENGTH_INVALID'
 |'HIGGSFIELD_OUTPUT_SIZE_EXCEEDED'|'HIGGSFIELD_OUTPUT_DEADLINE'
 |'HIGGSFIELD_OUTPUT_ABORTED'|'HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED'
 |'HIGGSFIELD_OUTPUT_CONSUMER_FAILED';
export class HiggsfieldOutputFetchError extends Error {
 constructor(readonly code:HiggsfieldOutputFetchCode){super(code);this.name='HiggsfieldOutputFetchError';}
}
const fail=(code:HiggsfieldOutputFetchCode):never=>{throw new HiggsfieldOutputFetchError(code);};
export type HiggsfieldOutputRead={
 locator:string;
 maxBytes:number;
 /** Absolute operation duration, including DNS, authority and the consumer. */
 deadlineMs:number;
 signal?:AbortSignal;
 /** Throw or return false when current, separately approved archive authority ends. */
 assertAuthority:(signal:AbortSignal)=>Promise<unknown>;
 /** Await backpressure and honor abort. On any failure, discard partial scratch
  * output. This reader never ends/publishes a destination or retries a write. */
 consume:(chunk:Uint8Array,signal:AbortSignal)=>Promise<void>;
};
type Dependencies={
 resolve?:(hostname:string,signal:AbortSignal)=>Promise<LookupAddress[]>;
 request?:(options:RequestOptions,callback:(response:IncomingMessage)=>void)=>ClientRequest;
};
type Policy={allowedHosts:readonly string[];authorityIntervalMs?:number;authorityTimeoutMs?:number};
const positive=(value:number,max:number)=>Number.isSafeInteger(value)&&value>=1&&value<=max;
const hostname=(value:string)=>typeof value==='string'&&value.length<=253&&value===value.toLowerCase()&&value.includes('.')&&!isIP(value)&&value.split('.').every(label=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));

// Conservative public-unicast policy: intentionally no exceptions for special
// anycast/translation allocations. Reviewed against the IANA special-purpose
// IPv4/IPv6 registries (2026-09-20). Updates need explicit security review.
const denied4=new BlockList(),denied6=new BlockList(),unicast6=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)denied4.addSubnet(address,prefix,'ipv4');
denied4.addAddress('168.63.129.16','ipv4'); // Azure platform virtual IP, not an output CDN.
unicast6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3ffe::',16],['3fff::',20]] as const)denied6.addSubnet(address,prefix,'ipv6');
function publicAddress(answer:LookupAddress){
 if(!answer||typeof answer.address!=='string'||answer.address.includes('%')||isIP(answer.address)!==answer.family)return false;
 return answer.family===4?!denied4.check(answer.address,'ipv4'):answer.family===6&&unicast6.check(answer.address,'ipv6')&&!denied6.check(answer.address,'ipv6');
}
function locatorUrl(locator:string,hosts:Set<string>){
 if(typeof locator!=='string'||locator.length>8192||/[\u0000-\u0020\u007f\\#]/.test(locator))fail('HIGGSFIELD_OUTPUT_URL_REJECTED');
 let url:URL;try{url=new URL(locator);}catch{return fail('HIGGSFIELD_OUTPUT_URL_REJECTED');}
 const authority=/^https:\/\/([^/?#]+)/i.exec(locator)?.[1].toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!hostname(url.hostname)||!hosts.has(url.hostname)||![url.hostname,url.hostname+':443'].includes(authority??''))fail('HIGGSFIELD_OUTPUT_URL_REJECTED');
 return url;
}
function singleHeader(response:IncomingMessage,name:string):string|undefined{
 if(response.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()===name).length>1)fail('HIGGSFIELD_OUTPUT_LENGTH_INVALID');
 const value=response.headers[name];if(value!==undefined&&typeof value!=='string')return fail('HIGGSFIELD_OUTPUT_LENGTH_INVALID');return value;
}
function responseLength(response:IncomingMessage,max:number){
 if(response.statusCode&&response.statusCode>=300&&response.statusCode<400)fail('HIGGSFIELD_OUTPUT_REDIRECT_REJECTED');
 if(response.statusCode!==200)fail('HIGGSFIELD_OUTPUT_STATUS_REJECTED');
 const encoding=singleHeader(response,'content-encoding');if(encoding!==undefined&&encoding.trim().toLowerCase()!=='identity')fail('HIGGSFIELD_OUTPUT_ENCODING_REJECTED');
 const length=singleHeader(response,'content-length'),transfer=singleHeader(response,'transfer-encoding');
 if(response.headers['content-range']!==undefined||transfer!==undefined&&(transfer.trim().toLowerCase()!=='chunked'||length!==undefined))fail('HIGGSFIELD_OUTPUT_LENGTH_INVALID');
 if(length===undefined)return null;
 if(!/^(0|[1-9]\d*)$/.test(length)||!Number.isSafeInteger(Number(length)))fail('HIGGSFIELD_OUTPUT_LENGTH_INVALID');
 if(Number(length)>max)fail('HIGGSFIELD_OUTPUT_SIZE_EXCEEDED');return Number(length);
}

/** Build only in trusted server composition. Dependencies are a test seam, never
 * request/agent input. There is deliberately no per-read host/transport override. */
export function createHiggsfieldOutputFetcher(policy:Policy,dependencies:Dependencies={}){
 if(!policy||!Array.isArray(policy.allowedHosts)||policy.allowedHosts.length<1||policy.allowedHosts.length>32||policy.allowedHosts.some(host=>!hostname(host)))fail('HIGGSFIELD_OUTPUT_POLICY_INVALID');
 const hosts=new Set(policy.allowedHosts),interval=policy.authorityIntervalMs??1000,checkTimeout=policy.authorityTimeoutMs??5000;
 if(!positive(interval,5000)||!positive(checkTimeout,5000))fail('HIGGSFIELD_OUTPUT_POLICY_INVALID');
 const resolve=dependencies.resolve??((host:string)=>dnsLookup(host,{all:true,verbatim:true}));
 const request=dependencies.request??httpsRequest;
 return async function read(input:HiggsfieldOutputRead):Promise<{bytes:number;sha256:string}>{
  if(!input||!positive(input.maxBytes,100*1024**3)||!positive(input.deadlineMs,2*60*60*1000)||typeof input.assertAuthority!=='function'||typeof input.consume!=='function')fail('HIGGSFIELD_OUTPUT_POLICY_INVALID');
  const {maxBytes,deadlineMs,signal,assertAuthority,consume}=input;
  const url=locatorUrl(input.locator,hosts),controller=new AbortController();
  let failure:HiggsfieldOutputFetchError|undefined,finished=false,req:ClientRequest|undefined,response:IncomingMessage|undefined,agent:Agent|undefined;
  let pendingAuthority:Promise<void>|undefined,lastCheck=0;
  function stop(code:HiggsfieldOutputFetchCode){
   if(failure||finished)return;failure=new HiggsfieldOutputFetchError(code);controller.abort(failure);
   req?.destroy(failure);response?.destroy(failure);agent?.destroy();
  }
  function current(){if(failure)throw failure;if(controller.signal.aborted)fail('HIGGSFIELD_OUTPUT_ABORTED');}
  function bounded<T>(promise:Promise<T>):Promise<T>{
   return new Promise<T>((resolve,reject)=>{
    const abort=()=>{controller.signal.removeEventListener('abort',abort);reject(failure??new HiggsfieldOutputFetchError('HIGGSFIELD_OUTPUT_ABORTED'));};
    controller.signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{controller.signal.removeEventListener('abort',abort);try{current();resolve(value);}catch(error){reject(error);}},error=>{controller.signal.removeEventListener('abort',abort);reject(failure??error);});
    if(controller.signal.aborted)abort();
   });
  }
  async function authorize(force=false){
   current();if(finished)return;
   if(!pendingAuthority&&(force||Date.now()-lastCheck>=interval)){
    const timer=setTimeout(()=>stop('HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED'),checkTimeout);
    pendingAuthority=bounded(Promise.resolve().then(()=>{current();return assertAuthority(controller.signal);})).then(value=>{
     if(value===false)stop('HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED');current();lastCheck=Date.now();
    }).catch(()=>{stop('HIGGSFIELD_OUTPUT_AUTHORITY_REVOKED');current();}).finally(()=>{clearTimeout(timer);pendingAuthority=undefined;});
   }
   if(pendingAuthority)await pendingAuthority;current();
  }
  const aborted=()=>stop('HIGGSFIELD_OUTPUT_ABORTED');
  signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  const deadline=setTimeout(()=>stop('HIGGSFIELD_OUTPUT_DEADLINE'),deadlineMs);
  const watchdog=setInterval(()=>{void authorize(true).catch(()=>{});},interval);
  try{
   await authorize(true);
   let answers:LookupAddress[];try{answers=await bounded(Promise.resolve().then(()=>resolve(url.hostname,controller.signal)));}catch{current();return fail('HIGGSFIELD_OUTPUT_DNS_REJECTED');}
   if(!Array.isArray(answers)||answers.length<1||answers.length>32||answers.some(answer=>!publicAddress(answer)))fail('HIGGSFIELD_OUTPUT_DNS_REJECTED');
   // Copy values: neither a later DNS response nor a mutable resolver answer
   // can redirect this connection after validation. No fallback/re-resolution.
   const pinned={address:answers[0].address,family:answers[0].family};
   await authorize(true);
   const lookup:LookupFunction=(host,options,callback)=>{
    if(host!==url.hostname||controller.signal.aborted){callback(new HiggsfieldOutputFetchError('HIGGSFIELD_OUTPUT_DNS_REJECTED'),'',pinned.family);return;}
    if(options.all)callback(null,[{...pinned}]);else callback(null,pinned.address,pinned.family);
   };
   // Never inherit global proxy/pooling/session-cache configuration. The newer
   // Node proxyEnv option is harmless on older supported Node 22 releases.
   const agentOptions={keepAlive:false,maxSockets:1,maxCachedSessions:0,rejectUnauthorized:true,autoSelectFamily:false,proxyEnv:{}};
   agent=new Agent(agentOptions);
   const received=new Promise<IncomingMessage>((resolve,reject)=>{
    try{
     req=request({protocol:'https:',hostname:url.hostname,servername:url.hostname,port:443,method:'GET',path:url.pathname+url.search,agent,family:pinned.family,lookup,rejectUnauthorized:true,checkServerIdentity:(_hostname,cert)=>checkServerIdentity(url.hostname,cert),maxHeaderSize:16*1024,insecureHTTPParser:false,headers:{Host:url.hostname,Accept:'*/*','Accept-Encoding':'identity',Connection:'close'}},incoming=>{
      incoming.on('error',()=>stop('HIGGSFIELD_OUTPUT_TRANSPORT_FAILED'));
      if(controller.signal.aborted||finished){incoming.destroy();return;}
      response=incoming;incoming.on('aborted',()=>stop('HIGGSFIELD_OUTPUT_LENGTH_INVALID'));resolve(incoming);
     });
     req.on('error',()=>{stop('HIGGSFIELD_OUTPUT_TRANSPORT_FAILED');reject(failure);});
     req.on('upgrade',(_incoming,socket)=>{socket.destroy();stop('HIGGSFIELD_OUTPUT_STATUS_REJECTED');});
     req.end();
    }catch{stop('HIGGSFIELD_OUTPUT_TRANSPORT_FAILED');reject(failure);}
   });
   response=await bounded(received);const expected=responseLength(response,maxBytes);
   await authorize(true);
   const hash=createHash('sha256'),iterator=response[Symbol.asyncIterator]();let bytes=0;
   while(true){
    await authorize();const part=await bounded(iterator.next());await authorize();if(part.done)break;
    if(!(part.value instanceof Uint8Array))fail('HIGGSFIELD_OUTPUT_TRANSPORT_FAILED');
    if(bytes+part.value.byteLength>maxBytes)fail('HIGGSFIELD_OUTPUT_SIZE_EXCEEDED');
    if(expected!==null&&bytes+part.value.byteLength>expected)fail('HIGGSFIELD_OUTPUT_LENGTH_INVALID');
    // Native IncomingMessage backpressure plus a 64KiB consumer chunk ceiling;
    // no full-media buffering and at most one awaited consumer invocation.
    for(let offset=0;offset<part.value.byteLength;offset+=64*1024){
     await authorize();const chunk=Buffer.from(part.value.subarray(offset,offset+64*1024));hash.update(chunk);bytes+=chunk.byteLength;
     try{await bounded(Promise.resolve().then(()=>{current();return consume(chunk,controller.signal);}));}catch{current();return fail('HIGGSFIELD_OUTPUT_CONSUMER_FAILED');}
    }
   }
   if(!response.complete||expected!==null&&bytes!==expected)fail('HIGGSFIELD_OUTPUT_LENGTH_INVALID');
   await authorize(true);current();return {bytes,sha256:hash.digest('hex')};
  }catch(error){
   const code=failure?.code??(error instanceof HiggsfieldOutputFetchError?error.code:'HIGGSFIELD_OUTPUT_TRANSPORT_FAILED');stop(code);throw failure??new HiggsfieldOutputFetchError(code);
  }finally{
   finished=true;clearInterval(watchdog);clearTimeout(deadline);signal?.removeEventListener('abort',aborted);
   response?.destroy();req?.destroy();agent?.destroy();
  }
 };
}
