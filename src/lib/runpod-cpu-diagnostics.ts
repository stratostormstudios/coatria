/** Bounded operator telemetry only. Never reads bodies or changes retries,
 * provisioning state, reservations, or the response returned to the caller. */
type Category='response_received'|'bad_request'|'unauthorized'|'payment_required'|'forbidden'|'not_found'|'conflict'|'payload_too_large'|'validation_rejected'|'rate_limited'|'provider_server_error'|'http_failure'|'timeout_or_abort'|'network_error';
export type CpuCreateDiagnostic={version:1;event:'runpod.cpu_create_observation';provisionId:string;httpStatus:number|null;category:Category;requestId:string|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const traceId=/^[a-f0-9]{32}$/i;
const categories:Record<number,Category>={400:'bad_request',401:'unauthorized',402:'payment_required',403:'forbidden',404:'not_found',409:'conflict',413:'payload_too_large',422:'validation_rejected',429:'rate_limited'};
const log=(value:CpuCreateDiagnostic)=>console.warn(JSON.stringify(value));

/** Runpod v2 documents no stable provider error code; categories are ours.
 * Only a canonical request/trace identifier in x-request-id is retained. */
export async function observeRunpodCpuCreate(provisionId:string,request:()=>Promise<Response>,emit:(value:CpuCreateDiagnostic)=>void=log):Promise<Response>{
 const record=(response:Response|null,error?:unknown)=>{
  try{
   if(!uuid.test(provisionId))return;
   const status=response?.status??null,raw=response?.headers.get('x-request-id')??null;
   const requestId=raw&&(uuid.test(raw)||traceId.test(raw))?raw.toLowerCase():null;
   const name=error instanceof Error?error.name:'';
   const category:Category=status===null?['AbortError','TimeoutError'].includes(name)?'timeout_or_abort':'network_error':status>=200&&status<300?'response_received':categories[status]??(status>=500?'provider_server_error':'http_failure');
   emit({version:1,event:'runpod.cpu_create_observation',provisionId,httpStatus:status,category,requestId});
  }catch{/* Observability cannot replace the original response or failure. */}
 };
 let response:Response;try{response=await request();}catch(error){record(null,error);throw error;}
 record(response);return response;
}
