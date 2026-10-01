/** Private metadata HTTP composition only. No route registration, database,
 * credentials lookup, byte transport, logging or retry lives in this module. */
import {ApiError} from './security';
import {PREPARATION_SERVICE_MAX_JSON_BYTES,preparationServiceOrigin,preparationServiceToken,preparationServiceUuid,preparationServiceRequests,preparationServiceResponses,type PreparationServiceOperation} from './project-image-preparation-service-protocol';

export type ProjectImagePreparationHttpExecutor=(serviceId:string,token:string,operation:PreparationServiceOperation,input:unknown,options:{signal:AbortSignal})=>Promise<unknown>;
export type ProjectImagePreparationServiceHttpOptions={origin:string;execute:ProjectImagePreparationHttpExecutor;requestTimeoutMs?:number};
type Code='PREPARATION_SERVICE_REQUEST_INVALID'|'PREPARATION_SERVICE_NOT_FOUND'|'PREPARATION_SERVICE_METHOD_INVALID'|'PREPARATION_SERVICE_UNAUTHORIZED'|'PREPARATION_SERVICE_FORBIDDEN'|'PREPARATION_SERVICE_TOO_LARGE'|'PREPARATION_SERVICE_MEDIA_TYPE_INVALID'|'PREPARATION_SERVICE_CONFLICT'|'PREPARATION_SERVICE_RATE_LIMITED'|'PREPARATION_SERVICE_TIMEOUT'|'PREPARATION_SERVICE_ABORTED'|'PREPARATION_SERVICE_UNAVAILABLE'|'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN';
class HttpFailure extends Error {constructor(readonly status:number,readonly code:Code){super(code);}}
function fail(status:number,code:Code):never{throw new HttpFailure(status,code);}
function safeFailure(error:unknown,executing=false):HttpFailure{
 if(error instanceof HttpFailure)return error;
 if(error instanceof ApiError){
  if(error.code==='IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN')return new HttpFailure(503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');
  const codes:Partial<Record<number,Code>>={400:'PREPARATION_SERVICE_REQUEST_INVALID',401:'PREPARATION_SERVICE_UNAUTHORIZED',403:'PREPARATION_SERVICE_FORBIDDEN',404:'PREPARATION_SERVICE_NOT_FOUND',409:'PREPARATION_SERVICE_CONFLICT',413:'PREPARATION_SERVICE_TOO_LARGE',429:'PREPARATION_SERVICE_RATE_LIMITED'};
  if(codes[error.status])return new HttpFailure(error.status,codes[error.status]!);
 }
 return new HttpFailure(503,executing?'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN':'PREPARATION_SERVICE_UNAVAILABLE');
}
const headers={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};

/** The injected service must honor the signal and its own DB-clock/authority
 * commit fence. Execution is awaited even after abort, never detached by a
 * Promise.race; an interrupted response does not certify rollback or cleanup. */
export function createProjectImagePreparationServiceHttpHandler(options:ProjectImagePreparationServiceHttpOptions):(request:Request)=>Promise<Response>{
 const origin=preparationServiceOrigin.safeParse(options?.origin),timeout=options?.requestTimeoutMs??30000,execute=options?.execute;
 if(!origin.success||typeof execute!=='function'||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw new Error('PREPARATION_SERVICE_HTTP_CONFIGURATION_INVALID');
 const trustedOrigin=origin.data;
 return async(request:Request)=>{
  const controller=new AbortController(),started=Date.now();let deadline=started+timeout,timedOut=false,executing=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancellation:Promise<void>|undefined;
  let status=200,responseBody='',error:HttpFailure|undefined;
  const cancelBody=()=>cancellation??=Promise.resolve().then(async()=>{if(reader)await reader.cancel();else if(request.body&&!request.body.locked)await request.body.cancel();});
  const stop=()=>{controller.abort();void cancelBody().catch(()=>{});};
  const abort=()=>stop();request.signal.addEventListener('abort',abort,{once:true});
  let timer=setTimeout(()=>{timedOut=true;stop();},timeout);
  const current=()=>{
   if(Date.now()>=deadline){timedOut=true;stop();}
   if(controller.signal.aborted||request.signal.aborted)fail(executing?503:timedOut?408:499,executing?'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN':timedOut?'PREPARATION_SERVICE_TIMEOUT':'PREPARATION_SERVICE_ABORTED');
  };
  try{
   if(request.signal.aborted)stop();current();
   const url=new URL(request.url),match=/^\/api\/internal\/image-preparation-services\/([a-f0-9-]{36})\/([a-z-]+)$/.exec(url.pathname);
   if(url.origin!==trustedOrigin||url.username||url.password||url.search||url.hash||!match||!preparationServiceUuid.safeParse(match[1]).success||!Object.hasOwn(preparationServiceRequests,match[2]))fail(404,'PREPARATION_SERVICE_NOT_FOUND');
   if(request.method!=='POST')fail(405,'PREPARATION_SERVICE_METHOD_INVALID');
   const authorization=request.headers.get('authorization');
   if(!authorization?.startsWith('Bearer ')||!preparationServiceToken.safeParse(authorization.slice(7)).success)fail(401,'PREPARATION_SERVICE_UNAUTHORIZED');
   const type=request.headers.get('content-type')?.toLowerCase();
   if(type!=='application/json'&&type!=='application/json; charset=utf-8')fail(415,'PREPARATION_SERVICE_MEDIA_TYPE_INVALID');
   if(request.headers.get('accept')!=='application/json'||request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity'||request.headers.has('accept-encoding')&&request.headers.get('accept-encoding')!=='identity'||['content-range','range','cookie','origin','expect','trailer'].some(name=>request.headers.has(name)))fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');
   const length=request.headers.get('content-length'),transfer=request.headers.get('transfer-encoding');
   if(length!==null&&!/^(0|[1-9]\d*)$/.test(length)||transfer!==null&&(transfer!=='chunked'||length!==null))fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');
   if(length!==null&&Number(length)>PREPARATION_SERVICE_MAX_JSON_BYTES)fail(413,'PREPARATION_SERVICE_TOO_LARGE');
   if(!request.body||request.bodyUsed||request.body.locked)fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');
   reader=request.body.getReader();const chunks:Uint8Array[]=[];let received=0;
   for(;;){current();const part=await reader.read();current();if(part.done)break;if(!(part.value instanceof Uint8Array))fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');received+=part.value.byteLength;if(received>PREPARATION_SERVICE_MAX_JSON_BYTES)fail(413,'PREPARATION_SERVICE_TOO_LARGE');chunks.push(new Uint8Array(part.value));}
   if(length!==null&&received!==Number(length))fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');
   let input:unknown;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');}
   const operation=match[2] as PreparationServiceOperation,parsed=preparationServiceRequests[operation].safeParse(input);
   if(!parsed.success)fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');
   const requestedDeadline=Date.parse(parsed.data.deadlineAt),now=Date.now();
   if(requestedDeadline<=now)fail(408,'PREPARATION_SERVICE_TIMEOUT');
   if(requestedDeadline>now+30000)fail(400,'PREPARATION_SERVICE_REQUEST_INVALID');
   deadline=Math.min(deadline,requestedDeadline);clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;stop();},Math.max(1,deadline-Date.now()));
   await cancelBody();current();executing=true;
   const result=await execute(match[1],authorization.slice(7),operation,parsed.data,{signal:controller.signal});current();
   const output=preparationServiceResponses[operation].safeParse(result);if(!output.success)fail(503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');
   responseBody=JSON.stringify(output.data);if(Buffer.byteLength(responseBody)>PREPARATION_SERVICE_MAX_JSON_BYTES)fail(503,'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN');current();
  }catch(cause){try{current();error=safeFailure(cause,executing);}catch(stopped){error=safeFailure(stopped,executing);}}
  finally{
   let cleanupFailed=false;try{await cancelBody();}catch{cleanupFailed=true;}
   try{reader?.releaseLock();}catch{cleanupFailed=true;}
   if(cleanupFailed)error=new HttpFailure(503,executing?'IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN':'PREPARATION_SERVICE_UNAVAILABLE');
   clearTimeout(timer);request.signal.removeEventListener('abort',abort);
  }
  if(!error)try{current();}catch(cause){error=safeFailure(cause);}
  if(error){status=error.status;responseBody=JSON.stringify({error:'The preparation request could not be confirmed.',code:error.code});}
  return new Response(responseBody,{status,headers:{...headers,'content-length':String(Buffer.byteLength(responseBody)),...status===405?{allow:'POST'}:{}}});
 };
}
