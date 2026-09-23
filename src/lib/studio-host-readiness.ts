import type {PoolClient} from 'pg';
import type {Membership} from './auth';
import {memberMutation} from './company';
import {loadCompanyRuntimeConfiguration} from './company-runtime-config';
import {parseStudioCpuPreset,sameRuntimeConfiguration,trustedServiceHash,type PinnedStudioCpuPreset} from './company-runtime-preset';
import {studioCpuPreset} from './studio-host-provisioning';
import {ApiError,fail,id} from './security';

export const PROVIDER_READINESS_CODES=['ready','credential_missing','http_unauthorized','http_rate_limited','http_failed','redirect_rejected','timeout','network_error','response_too_large','invalid_json','invalid_response','endpoint_mismatch','worker_limit_invalid','endpoint_disabled','health_workers_invalid'] as const;
type Code=typeof PROVIDER_READINESS_CODES[number];
type FieldType='missing'|'null'|'array'|'object'|'number'|'string'|'boolean'|'undefined';
export type StudioHostProviderCheck={stage:'lifecycle'|'health';ready:boolean;code:Code;httpStatus:number|null;endpointIdMatches?:boolean;endpointType?:'QUEUE'|'LOAD_BALANCER'|'other'|'missing';workersMax?:number|null;workersMaxType?:FieldType;workersMin?:number|null;workersMinType?:FieldType;workersType?:FieldType;workerCounts?:Record<string,number|null>};
export type StudioHostProviderReadiness={provisionId:string;checkedAt:string;readOnly:true;authorizesStart:false;ready:boolean;providerReady:boolean;configuration:{state:'current'|'inactive'|'changed'|'unavailable'};checks:StudioHostProviderCheck[]};
const MAX_RESPONSE=2*1024*1024,TIMEOUT_MS=10000,providerId=/^[A-Za-z0-9_-]{1,100}$/;
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fieldType=(v:unknown):FieldType=>v===undefined?'missing':v===null?'null':Array.isArray(v)?'array':typeof v as FieldType;
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
class ProbeError extends Error{constructor(readonly code:Code){super(code);}}

/** This projection never includes endpoint environments, provider URLs, errors,
 * arbitrary text, keys, credentials, or the raw response. */
export function projectStudioProviderCheck(stage:'lifecycle'|'health',endpointId:string,value:unknown,status:number):StudioHostProviderCheck{
 const base:StudioHostProviderCheck={stage,ready:false,code:'invalid_response',httpStatus:status};
 if(status>=300&&status<400)return {...base,code:'redirect_rejected'};
 if(status<200||status>=300)return {...base,code:status===401||status===403?'http_unauthorized':status===429?'http_rate_limited':'http_failed'};
 if(!isObject(value))return base;
 if(stage==='health'){
  const workers=value.workers,result={...base,workersType:fieldType(workers)};
  if(!isObject(workers))return {...result,code:'health_workers_invalid'};
  return {...result,ready:true,code:'ready',workerCounts:Object.fromEntries(['idle','initializing','ready','running','throttled','unhealthy'].map(key=>[key,count(workers[key])]))};
 }
 const workers=isObject(value.workers)?value.workers:{},maximum=count(workers.max),minimum=count(workers.min),matches=value.id===endpointId;
 const endpointType=value.type===undefined?'missing':value.type==='QUEUE'||value.type==='LOAD_BALANCER'?value.type:'other';
 const result:StudioHostProviderCheck={...base,endpointIdMatches:matches,endpointType,workersMax:maximum,workersMaxType:fieldType(workers.max),workersMin:minimum,workersMinType:fieldType(workers.min)};
 if(!matches)return {...result,code:'endpoint_mismatch'};
 if(maximum===null)return {...result,code:'worker_limit_invalid'};
 return {...result,ready:maximum>=1,code:maximum>=1?'ready':'endpoint_disabled'};
}
async function responseJson(response:Response){
 const length=response.headers.get('content-length');if(length&&/^\d+$/.test(length)&&Number(length)>MAX_RESPONSE){await response.body?.cancel().catch(()=>{});throw new ProbeError('response_too_large');}
 const reader=response.body?.getReader();if(!reader)throw new ProbeError('invalid_json');const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_RESPONSE)throw new ProbeError('response_too_large');chunks.push(part.value);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProbeError('invalid_json');}}
 finally{await reader.cancel().catch(()=>{});for(const chunk of chunks)chunk.fill(0);}
}
/** Fixed provider origins; each stage is independent, including when max=0.
 * A health GET cannot start inference. No fallback credential or retry. */
export async function probeStudioHostProviders(preset:Pick<PinnedStudioCpuPreset,'endpointId'|'inference'>,settings:NodeJS.ProcessEnv=process.env,transport:typeof fetch=fetch):Promise<StudioHostProviderCheck[]>{
 if(!providerId.test(preset.endpointId))fail(409,'The stored endpoint is invalid.','CPU_READINESS_SCOPE_INVALID');
 return Promise.all((['lifecycle','health'] as const).map(async stage=>{
  const key=stage==='lifecycle'||preset.inference?settings.MANAGED_RUNPOD_API_KEY:settings.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY;
  const base:StudioHostProviderCheck={stage,ready:false,code:'credential_missing',httpStatus:null};if(!key)return base;
  const url=stage==='lifecycle'?'https://api.runpod.io/v2/serverless/'+preset.endpointId:'https://api.runpod.ai/v2/'+preset.endpointId+'/health';
  const signal=AbortSignal.timeout(TIMEOUT_MS);let status:number|null=null;
  try{const response=await transport(url,{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'manual',cache:'no-store',signal});status=response.status;
   if(status<200||status>=300){await response.body?.cancel().catch(()=>{});return projectStudioProviderCheck(stage,preset.endpointId,null,status);}
   return projectStudioProviderCheck(stage,preset.endpointId,await responseJson(response),status);
  }catch(error){return {...base,httpStatus:status,code:signal.aborted?'timeout':error instanceof ProbeError?error.code:'network_error'};}
 }));
}
type Target={preset:PinnedStudioCpuPreset;planHash:string;presetHash:string;configuration:StudioHostProviderReadiness['configuration']};
async function readTarget(client:PoolClient,member:Membership,provisionId:string,settings:NodeJS.ProcessEnv):Promise<Target>{
 // Older general membership helpers do not check this field; diagnostic access
 // must stop as soon as this company's membership is revoked.
 const access=(await client.query('SELECT role,access_revoked_at FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[member.companyId,member.userId])).rows[0];
 if(!access||!['owner','admin'].includes(access.role)||access.access_revoked_at!==null)fail(403,'Current company administrator access is required.','CPU_READINESS_ADMIN_REQUIRED');
 const row=(await client.query('SELECT plan,plan_hash,preset FROM studio_host_provisions WHERE company_id=$1 AND id=$2',[member.companyId,id(provisionId)])).rows[0];if(!row)fail(404,'Managed CPU request not found.');
 if(!isObject(row.preset)||!isObject(row.plan)||!isObject(row.plan.preset))fail(409,'The stored reviewed provision is invalid.','CPU_READINESS_SCOPE_INVALID');
 const {company,...raw}=row.preset;let preset:PinnedStudioCpuPreset;
 try{preset=parseStudioCpuPreset({...raw,companies:[company]},member.companyId);}catch{fail(409,'The stored reviewed provision is invalid.','CPU_READINESS_SCOPE_INVALID');}
 const presetHash=trustedServiceHash(preset);
 if(row.plan.companyId!==member.companyId||trustedServiceHash(row.plan)!==row.plan_hash||trustedServiceHash(row.preset)!==presetHash||row.plan.preset.hash!==presetHash)fail(409,'The stored reviewed provision failed its integrity check.','CPU_READINESS_SCOPE_INVALID');
 let state:StudioHostProviderReadiness['configuration']['state']='unavailable';
 try{const selected=await loadCompanyRuntimeConfiguration(client,member.companyId,'managed_agent');
  if(selected){state=!selected.enabled?'inactive':sameRuntimeConfiguration(row.plan.runtimeConfiguration as any,selected)&&trustedServiceHash(selected.preset)===presetHash?'current':'changed';}
  else{state=!row.plan.runtimeConfiguration&&trustedServiceHash(studioCpuPreset(member.companyId,settings))===presetHash?'current':'changed';}
 }catch(error){if(!(error instanceof ApiError))throw error;}
 return {preset,presetHash,planHash:row.plan_hash,configuration:{state}};
}
export async function readStudioHostProviderReadiness(member:Membership,provisionId:string,options:{fetch?:typeof fetch;settings?:NodeJS.ProcessEnv}={}):Promise<StudioHostProviderReadiness>{
 id(provisionId);const settings=options.settings??process.env;
 const before=await memberMutation(member,true,client=>readTarget(client,member,provisionId,settings));
 const checks=await probeStudioHostProviders(before.preset,settings,options.fetch??fetch);
 // Release DB locks for network I/O, then recheck current admin membership and
 // immutable provision identity. Never return observations after losing access.
 const after=await memberMutation(member,true,client=>readTarget(client,member,provisionId,settings));
 if(before.planHash!==after.planHash||before.presetHash!==after.presetHash)fail(409,'The reviewed provision changed while checking it.','CPU_READINESS_SCOPE_CHANGED');
 const providerReady=checks.every(check=>check.ready);
 return {provisionId,checkedAt:new Date().toISOString(),readOnly:true,authorizesStart:false,providerReady,ready:providerReady&&after.configuration.state==='current',configuration:after.configuration,checks};
}
