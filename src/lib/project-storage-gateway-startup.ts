/** Trusted Node startup and request ownership. Configuration comes only from
 * the immutable operator file; HTTP headers and targets cannot select scope. */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
type Gateway={handle(request:Request):Promise<Response>;verifyNext():Promise<unknown>};
type PreparationGateway={handle(request:Request):Promise<Response>;close():void;drain():Promise<void>};

export function createStorageGatewayNodeServer(options:{gateway:Gateway;preparation?:PreparationGateway;host:string;port:number;maxTransfers?:number;expiresAt?:string;closePool:()=>Promise<void>;onVerificationError:()=>void;onShutdownError:()=>void}){
 const maxTransfers=options.maxTransfers??8;
 if(!Number.isInteger(options.port)||options.port<0||options.port>65535||!Number.isInteger(maxTransfers)||maxTransfers<1||maxTransfers>8||options.expiresAt!==undefined&&!Number.isFinite(Date.parse(options.expiresAt)))throw Error('STORAGE_GATEWAY_CONFIGURATION_INVALID');
 const pending=new Map<Promise<void>,AbortController>();let closing=false,listening=false,started=false,verifying:Promise<void>|undefined,worker:ReturnType<typeof setInterval>|undefined,expiry:ReturnType<typeof setTimeout>|undefined,stopping:Promise<void>|undefined;
 const reply=(res:ServerResponse,status:number,code:string)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'The transfer service cannot complete this request.',code}));};
 async function handle(req:IncomingMessage,res:ServerResponse,abort:AbortController){
  const aborted=()=>abort.abort(),disconnected=()=>{if(!res.writableFinished)abort.abort();},cancelSocket=()=>res.destroy();req.on('aborted',aborted);res.on('close',disconnected);abort.signal.addEventListener('abort',cancelSocket,{once:true});
  try{
   const target=req.url??'/';
   // Only origin-form request targets. Host and Forwarded are never URL bases.
   if(!target.startsWith('/')||target.startsWith('//')||/[\\\u0000-\u0020\u007f#]/.test(target)){reply(res,400,'STORAGE_REQUEST_TARGET_INVALID');return;}
   const url=new URL(target,'http://127.0.0.1:'+options.port),headers=new Headers();
   for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
   const method=req.method??'GET',request=new Request(url,{method,headers,signal:abort.signal,...!['GET','HEAD'].includes(method)?{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'}:{}} as RequestInit);
   const preparation=url.pathname==='/v1/image-preparations'||url.pathname.startsWith('/v1/image-preparations/');
   if(preparation&&!options.preparation){reply(res,404,'STORAGE_ENDPOINT_NOT_FOUND');return;}
   const response=await (preparation?options.preparation!:options.gateway).handle(request);
   if(abort.signal.aborted||res.destroyed){await response.body?.cancel();return;}
   res.writeHead(response.status,Object.fromEntries(response.headers));
   if(response.body)await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),res,{signal:abort.signal});else res.end();
  }catch{if(!res.headersSent)reply(res,502,'STORAGE_OUTCOME_UNCERTAIN');else res.destroy();}
  finally{req.removeListener('aborted',aborted);res.removeListener('close',disconnected);abort.signal.removeEventListener('abort',cancelSocket);}
 }
 const server=createServer((req,res)=>{
  if(closing||pending.size>=maxTransfers){reply(res,503,'STORAGE_TRANSFER_LIMIT');return;}
  const abort=new AbortController(),operation=handle(req,res,abort).finally(()=>pending.delete(operation));pending.set(operation,abort);
 });
 server.requestTimeout=5*60*1000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
 function stop():Promise<void>{
  return stopping??=(async()=>{
   closing=true;clearInterval(worker);clearTimeout(expiry);
   // Abort starts cancellation; only completed drain proves cleanup. Never
   // close the pool or report success merely because a grace timer elapsed.
   for(const controller of pending.values())controller.abort();
   let closeFailure=false;try{options.preparation?.close();}catch{closeFailure=true;}
   const closed=listening?new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();}):Promise.resolve();
   const drained=await Promise.allSettled([closed,...pending.keys(),...verifying?[verifying]:[],Promise.resolve().then(()=>options.preparation?.drain())]);
   if(closeFailure||drained.some(result=>result.status==='rejected'))throw Error('STORAGE_GATEWAY_CLEANUP_UNCONFIRMED');
   await options.closePool();
  })();
 }
 return {
  async listen(){
   if(started||closing||options.expiresAt!==undefined&&Date.parse(options.expiresAt)<=Date.now())throw Error('STORAGE_GATEWAY_CONFIGURATION_INVALID');started=true;
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,options.host,()=>{server.removeListener('error',reject);listening=true;resolve();});});
   if(options.expiresAt!==undefined&&Date.parse(options.expiresAt)<=Date.now()){await stop();throw Error('STORAGE_GATEWAY_CONFIGURATION_INVALID');}
   worker=setInterval(()=>{if(closing||verifying)return;verifying=options.gateway.verifyNext().then(()=>{},()=>{options.onVerificationError();}).finally(()=>{verifying=undefined;});},2000);
   if(options.expiresAt!==undefined)expiry=setTimeout(()=>void stop().catch(options.onShutdownError),Math.max(1,Date.parse(options.expiresAt)-Date.now()));
  },
  address:()=>server.address(),stop,
 };
}
