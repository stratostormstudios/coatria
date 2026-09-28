/** Trusted prepared-image PUT transport. No default host, OAuth, caller headers,
 * redirects, retries, or public route. URL/DNS/TLS policy deliberately matches
 * higgsfield-output-fetch; this separate writer does not widen that reader. */
import {createHash} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import type {LookupAddress} from 'node:dns';
import {Agent,request as httpsRequest,type RequestOptions} from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {BlockList,isIP,type LookupFunction} from 'node:net';
import {checkServerIdentity} from 'node:tls';

export const HIGGSFIELD_REFERENCE_MAX_BYTES=10*1024**2;
export type HiggsfieldReferenceTransportCode='REFERENCE_UPLOAD_POLICY_INVALID'|'REFERENCE_UPLOAD_URL_REJECTED'|'REFERENCE_UPLOAD_DNS_REJECTED'|'REFERENCE_UPLOAD_BYTES_CHANGED'|'REFERENCE_UPLOAD_TRANSPORT_FAILED'|'REFERENCE_UPLOAD_RESPONSE_REJECTED'|'REFERENCE_UPLOAD_AUTHORITY_REVOKED'|'REFERENCE_UPLOAD_DEADLINE'|'REFERENCE_UPLOAD_ABORTED';
export class HiggsfieldReferenceTransportError extends Error {constructor(readonly code:HiggsfieldReferenceTransportCode){super(code);this.name='HiggsfieldReferenceTransportError';}}
const fail=(code:HiggsfieldReferenceTransportCode):never=>{throw new HiggsfieldReferenceTransportError(code);};
export type HiggsfieldReferenceUpload={
 /** Broker-issued private capability; never agent input or public output. */
 locator:string;body:Uint8Array;bytes:number;sha256:string;contentType:'image/png'|'image/jpeg'|'image/webp';
 deadlineMs:number;signal?:AbortSignal;assertAuthority:(signal:AbortSignal)=>Promise<unknown>;
};
export type HiggsfieldReferenceUploadResult={bytes:number;sha256:string;status:200};
type Dependencies={resolve?:(hostname:string,signal:AbortSignal)=>Promise<LookupAddress[]>;request?:(options:RequestOptions,callback:(response:IncomingMessage)=>void)=>ClientRequest};
type Policy={allowedHosts:readonly string[];authorityIntervalMs?:number;authorityTimeoutMs?:number};
const positive=(n:number,max:number)=>Number.isSafeInteger(n)&&n>=1&&n<=max;
const hostname=(s:string)=>typeof s==='string'&&s.length<=253&&s===s.toLowerCase()&&s.includes('.')&&!isIP(s)&&s.split('.').every(label=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
const denied4=new BlockList(),denied6=new BlockList(),unicast6=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)denied4.addSubnet(ip,prefix,'ipv4');
denied4.addAddress('168.63.129.16','ipv4');unicast6.addSubnet('2000::',3,'ipv6');
for(const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3ffe::',16],['3fff::',20]] as const)denied6.addSubnet(ip,prefix,'ipv6');
function publicAddress(a:LookupAddress){return !!a&&typeof a.address==='string'&&!a.address.includes('%')&&isIP(a.address)===a.family&&(a.family===4?!denied4.check(a.address,'ipv4'):a.family===6&&unicast6.check(a.address,'ipv6')&&!denied6.check(a.address,'ipv6'));}
function locatorUrl(locator:string,hosts:Set<string>){
 if(typeof locator!=='string'||locator.length>8192||/[\u0000-\u0020\u007f\\#]/.test(locator))fail('REFERENCE_UPLOAD_URL_REJECTED');
 let url:URL;try{url=new URL(locator);}catch{return fail('REFERENCE_UPLOAD_URL_REJECTED');}
 const authority=/^https:\/\/([^/?#]+)/i.exec(locator)?.[1].toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!hostname(url.hostname)||!hosts.has(url.hostname)||![url.hostname,url.hostname+':443'].includes(authority??''))fail('REFERENCE_UPLOAD_URL_REJECTED');return url;
}
function header(response:IncomingMessage,name:string):string|undefined{
 if(response.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===name).length>1)fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');
 const value=response.headers[name];if(value!==undefined&&typeof value!=='string')return fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');return value;
}
function responsePolicy(response:IncomingMessage){
 if(response.statusCode!==200||response.headers['content-range']!==undefined)fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');
 const encoding=header(response,'content-encoding'),length=header(response,'content-length'),transfer=header(response,'transfer-encoding');
 if(encoding!==undefined&&encoding.trim().toLowerCase()!=='identity'||transfer!==undefined&&(transfer.trim().toLowerCase()!=='chunked'||length!==undefined))fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');
 if(length!==undefined&&(!/^(0|[1-9]\d*)$/.test(length)||Number(length)>16384||!Number.isSafeInteger(Number(length))))fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');
 return length===undefined?null:Number(length);
}

/** Construct only from a reviewed provider catalog/policy, never request input.
 * The caller MUST durably record its once-only PUT intent before invoking this.
 * Every thrown result after that intent is conservatively outcome-unknown. */
export function createHiggsfieldReferenceUploader(policy:Policy,dependencies:Dependencies={}){
 if(!policy||!Array.isArray(policy.allowedHosts)||policy.allowedHosts.length<1||policy.allowedHosts.length>32||policy.allowedHosts.some(host=>!hostname(host)))fail('REFERENCE_UPLOAD_POLICY_INVALID');
 const hosts=new Set(policy.allowedHosts),interval=policy.authorityIntervalMs??1000,checkTimeout=policy.authorityTimeoutMs??5000;
 if(!positive(interval,5000)||!positive(checkTimeout,5000))fail('REFERENCE_UPLOAD_POLICY_INVALID');
 const resolve=dependencies.resolve??((host:string)=>dnsLookup(host,{all:true,verbatim:true})),request=dependencies.request??httpsRequest;
 return async function upload(input:HiggsfieldReferenceUpload):Promise<HiggsfieldReferenceUploadResult>{
  if(!input||!(input.body instanceof Uint8Array)||!positive(input.bytes,HIGGSFIELD_REFERENCE_MAX_BYTES)||input.body.byteLength!==input.bytes||!/^[a-f0-9]{64}$/.test(input.sha256)||!['image/png','image/jpeg','image/webp'].includes(input.contentType)||!positive(input.deadlineMs,120000)||typeof input.assertAuthority!=='function')fail('REFERENCE_UPLOAD_POLICY_INVALID');
  const {bytes,sha256,contentType,deadlineMs,signal,assertAuthority}=input,url=locatorUrl(input.locator,hosts);
  // Bounded immutable snapshot, checked BEFORE DNS or disclosure. Subsequent
  // mutation of caller storage cannot change these bytes after approval checks.
  const body=Buffer.from(input.body);
  if(createHash('sha256').update(body).digest('hex')!==sha256){body.fill(0);fail('REFERENCE_UPLOAD_BYTES_CHANGED');}
  const controller=new AbortController();let failure:HiggsfieldReferenceTransportError|undefined,finished=false,req:ClientRequest|undefined,response:IncomingMessage|undefined,agent:Agent|undefined,pendingAuthority:Promise<void>|undefined,lastCheck=0;
  function stop(code:HiggsfieldReferenceTransportCode){if(failure||finished)return;failure=new HiggsfieldReferenceTransportError(code);controller.abort(failure);req?.destroy(failure);response?.destroy(failure);agent?.destroy();}
  function current(){if(failure)throw failure;if(controller.signal.aborted)fail('REFERENCE_UPLOAD_ABORTED');}
  function bounded<T>(promise:Promise<T>){return new Promise<T>((resolve,reject)=>{const abort=()=>{controller.signal.removeEventListener('abort',abort);reject(failure??new HiggsfieldReferenceTransportError('REFERENCE_UPLOAD_ABORTED'));};controller.signal.addEventListener('abort',abort,{once:true});promise.then(value=>{controller.signal.removeEventListener('abort',abort);try{current();resolve(value);}catch(error){reject(error);}},error=>{controller.signal.removeEventListener('abort',abort);reject(failure??error);});if(controller.signal.aborted)abort();});}
  async function authorize(force=false){
   current();if(finished)return;if(!pendingAuthority&&(force||Date.now()-lastCheck>=interval)){
    const timeout=setTimeout(()=>stop('REFERENCE_UPLOAD_AUTHORITY_REVOKED'),checkTimeout);
    pendingAuthority=bounded(Promise.resolve().then(()=>{current();return assertAuthority(controller.signal);})).then(value=>{if(value===false)stop('REFERENCE_UPLOAD_AUTHORITY_REVOKED');current();lastCheck=Date.now();}).catch(()=>{stop('REFERENCE_UPLOAD_AUTHORITY_REVOKED');current();}).finally(()=>{clearTimeout(timeout);pendingAuthority=undefined;});
   }if(pendingAuthority)await pendingAuthority;current();
  }
  const aborted=()=>stop('REFERENCE_UPLOAD_ABORTED');signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  const deadline=setTimeout(()=>stop('REFERENCE_UPLOAD_DEADLINE'),deadlineMs),watchdog=setInterval(()=>{void authorize(true).catch(()=>{});},interval);
  try{
   await authorize(true);let answers:LookupAddress[];
   try{answers=await bounded(Promise.resolve().then(()=>resolve(url.hostname,controller.signal)));}catch{current();return fail('REFERENCE_UPLOAD_DNS_REJECTED');}
   if(!Array.isArray(answers)||answers.length<1||answers.length>32||answers.some(a=>!publicAddress(a)))fail('REFERENCE_UPLOAD_DNS_REJECTED');
   const pinned={address:answers[0].address,family:answers[0].family};await authorize(true);
   const lookup:LookupFunction=(host,options,callback)=>{if(host!==url.hostname||controller.signal.aborted){callback(new HiggsfieldReferenceTransportError('REFERENCE_UPLOAD_DNS_REJECTED'),'',pinned.family);return;}if(options.all)callback(null,[{...pinned}]);else callback(null,pinned.address,pinned.family);};
   const agentOptions={keepAlive:false,maxSockets:1,maxCachedSessions:0,rejectUnauthorized:true,autoSelectFamily:false,proxyEnv:{}};agent=new Agent(agentOptions);
   const received=new Promise<IncomingMessage>((resolve,reject)=>{
    try{req=request({protocol:'https:',hostname:url.hostname,servername:url.hostname,port:443,method:'PUT',path:url.pathname+url.search,agent,family:pinned.family,lookup,rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>checkServerIdentity(url.hostname,cert),maxHeaderSize:16384,insecureHTTPParser:false,headers:{Host:url.hostname,'Content-Type':contentType,'Content-Length':String(bytes),Accept:'*/*','Accept-Encoding':'identity',Connection:'close'}},incoming=>{
     incoming.on('error',()=>stop('REFERENCE_UPLOAD_TRANSPORT_FAILED'));if(controller.signal.aborted||finished){incoming.destroy();return;}response=incoming;
     incoming.on('aborted',()=>stop('REFERENCE_UPLOAD_RESPONSE_REJECTED'));
     try{responsePolicy(incoming);resolve(incoming);}catch{stop('REFERENCE_UPLOAD_RESPONSE_REJECTED');reject(failure);}
    });req.on('error',()=>{stop('REFERENCE_UPLOAD_TRANSPORT_FAILED');reject(failure);});req.on('upgrade',(_incoming,socket)=>{socket.destroy();stop('REFERENCE_UPLOAD_RESPONSE_REJECTED');});}
    catch{stop('REFERENCE_UPLOAD_TRANSPORT_FAILED');reject(failure);}
   });
   // An early server rejection is observed while writes are still pending.
   void received.catch(()=>{});
   for(let offset=0;offset<body.length;offset+=65536){await authorize(true);await bounded(new Promise<void>((resolve,reject)=>{req!.write(body.subarray(offset,offset+65536),error=>error?reject(error):resolve());}));}
   await authorize(true);await bounded(new Promise<void>(resolve=>{req!.end(resolve);}));
   response=await bounded(received);const expected=responsePolicy(response),iterator=response[Symbol.asyncIterator]();let responseBytes=0;
   while(true){await authorize();const part=await bounded(iterator.next());if(part.done)break;if(!(part.value instanceof Uint8Array)||(responseBytes+=part.value.byteLength)>16384)fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');}
   if(!response.complete||expected!==null&&responseBytes!==expected)fail('REFERENCE_UPLOAD_RESPONSE_REJECTED');
   await authorize(true);return {bytes,sha256,status:200};
  }catch(error){const code=failure?.code??(error instanceof HiggsfieldReferenceTransportError?error.code:'REFERENCE_UPLOAD_TRANSPORT_FAILED');stop(code);throw failure??new HiggsfieldReferenceTransportError(code);}
  finally{finished=true;clearInterval(watchdog);clearTimeout(deadline);signal?.removeEventListener('abort',aborted);response?.destroy();req?.destroy();agent?.destroy();body.fill(0);}
 };
}
