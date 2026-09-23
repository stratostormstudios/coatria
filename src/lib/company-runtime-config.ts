/** Durable reviewed deployment configuration. This module performs no provider I/O. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {lockMembership,type Membership} from './auth';
import {fail,hashToken,id} from './security';
import {companyRuntimeKind,companyRuntimeSelectInput,companyRuntimeRevokeInput,type CompanyRuntimeKind,type CompanyRuntimeSummary} from './company-runtime-protocol';
import {parseCompanyRuntimePreset,type PinnedStudioCpuPreset,type TrustedServicePreset} from './company-runtime-preset';

type Row=Record<string,any>;
type RuntimePreset=PinnedStudioCpuPreset|TrustedServicePreset;
export type CompanyRuntimeConfiguration={configurationId:string;selectionRevision:number;enabled:boolean;preset:RuntimePreset;configurationHash:string;expiresAt:string};
export function canonicalCompanyRuntime(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonicalCompanyRuntime).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonicalCompanyRuntime(item)).join(',')+'}';
 return JSON.stringify(value);
}
export const companyRuntimeHash=(value:unknown)=>hashToken(canonicalCompanyRuntime(value));
const iso=(value:string|Date)=>new Date(value).toISOString();
const activePhases=['approved','submitting','uncertain','provisioning','running','stopping','needs_attention'];
function kindValue(kind:unknown){const parsed=companyRuntimeKind.safeParse(kind);if(!parsed.success)fail(400,'Choose a supported company runtime kind.','VALIDATION_ERROR');return parsed.data;}

/** Caller owns a transaction. Check after any waits, including grant revocation. */
export async function requirePlatformRuntimeOperator(db:PoolClient,member:Membership){
 await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[member.companyId]);
 await lockMembership(db,member,true);
 const allowed=(await db.query('SELECT public.coatria_lock_platform_runtime_operator($1) AS allowed',[member.userId])).rows[0]?.allowed;
 if(allowed!==true)fail(403,'A current platform runtime operator grant and company administrator membership are required.','PLATFORM_OPERATOR_REQUIRED');
}
export async function lockCompanyRuntimeControl(db:PoolClient,companyId:string,kind:CompanyRuntimeKind){
 await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[companyId]);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${kind==='managed_agent'?'studio-cpu-control':'trusted-service-control'}:${companyId}`]);
}
async function selection(db:PoolClient,companyId:string,kind:CompanyRuntimeKind){
 const row=(await db.query(`SELECT c.*,s.configuration_id,s.revision AS selection_revision,s.state
 FROM company_runtime_selections s JOIN company_runtime_configurations c ON c.company_id=s.company_id AND c.kind=s.kind AND c.id=s.configuration_id
 WHERE s.company_id=$1 AND s.kind=$2 FOR SHARE OF s`,[companyId,kind])).rows[0] as Row|undefined;
 // A SELECT projection can be evaluated before a row-lock wait. Sample the DB
 // clock only after that wait has finished so an expired grant cannot revive.
 if(row)row.enabled=row.state==='active'&&+new Date(row.expires_at)>+new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);
 return row;
}
function summary(row:Row):CompanyRuntimeSummary{return {companyId:row.company_id,kind:row.kind,configurationId:row.configuration_id,selectionRevision:row.selection_revision,state:row.state,enabled:row.enabled,configurationHash:row.configuration_hash,phase:row.phase,expiresAt:iso(row.expires_at),createdAt:iso(row.created_at),createdBy:row.created_by,computeStarted:false,spendingApproved:false};}
/** Null means never configured. Revoked and expired selections remain present;
 * consumers must not fall back to an older environment preset. */
export async function loadCompanyRuntimeConfiguration(db:PoolClient,companyId:string,kind:CompanyRuntimeKind):Promise<CompanyRuntimeConfiguration|null>{
 id(companyId);kindValue(kind);await lockCompanyRuntimeControl(db,companyId,kind);
 const row=await selection(db,companyId,kind);if(!row)return null;
 if(companyRuntimeHash(row.preset)!==row.configuration_hash)fail(503,'Stored runtime configuration integrity could not be verified.','RUNTIME_CONFIGURATION_INTEGRITY');
 const preset=parseCompanyRuntimePreset(row.preset,companyId,kind);
 if(kind!=='managed_agent'&&Date.parse((preset as TrustedServicePreset).expiresAt)!==+new Date(row.expires_at))fail(503,'Stored service deadline differs from its reviewed configuration.','RUNTIME_CONFIGURATION_INTEGRITY');
 return {configurationId:row.configuration_id,selectionRevision:row.selection_revision,enabled:row.enabled,preset,configurationHash:row.configuration_hash,expiresAt:iso(row.expires_at)};
}
export async function getCompanyRuntimeConfiguration(db:PoolClient,member:Membership,kind:CompanyRuntimeKind){
 await requirePlatformRuntimeOperator(db,member);const row=await selection(db,member.companyId,kindValue(kind));return {configuration:row?summary(row):null};
}
async function replay(db:PoolClient,member:Membership,clientId:string,requestHash:string){
 const old=(await db.query('SELECT request_hash,response FROM company_runtime_requests WHERE company_id=$1 AND user_id=$2 AND client_id=$3',[member.companyId,member.userId,clientId])).rows[0];
 if(old&&old.request_hash!==requestHash)fail(409,'This request ID was used for different runtime configuration details.','IDEMPOTENCY_CONFLICT');
 return old?{...old.response,replayed:true}:null;
}
async function receipt(db:PoolClient,member:Membership,kind:CompanyRuntimeKind,operation:string,clientId:string,requestHash:string,result:unknown){await db.query('INSERT INTO company_runtime_requests(company_id,user_id,client_id,kind,operation,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[member.companyId,member.userId,clientId,kind,operation,requestHash,JSON.stringify(result)]);}
async function authority(db:PoolClient,member:Membership,kind:CompanyRuntimeKind,clientId:string){
 await lockCompanyRuntimeControl(db,member.companyId,kind);
 // Cross-kind re-use of an idempotency key must also serialize.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`company-runtime-request:${member.companyId}:${member.userId}:${clientId}`]);
 await requirePlatformRuntimeOperator(db,member);
}
function rejectEmbeddedSecrets(value:unknown){
 const inspect=(item:unknown):void=>{
  if(Array.isArray(item)){item.forEach(inspect);return;}
  if(item&&typeof item==='object'){for(const [key,child] of Object.entries(item)){if(/^(?:password|secret|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|authorization|env|environment|databaseUrl|database_url|credentials|token)$/i.test(key))fail(400,'Runtime presets cannot contain credentials or secret fields.','RUNTIME_SECRET_FORBIDDEN');inspect(child);}return;}
  if(typeof item!=='string')return;
  if(/(?:postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|\bBearer\s+[A-Za-z0-9._-]{8,}|\b(?:vcp|rpa|msy)_[A-Za-z0-9_-]{15,})/i.test(item))fail(400,'Runtime presets cannot contain embedded credentials.','RUNTIME_SECRET_FORBIDDEN');
  const bootstrap=/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/.exec(item);if(bootstrap)inspect(Buffer.from(bootstrap[1],'base64').toString('utf8'));
 };
 inspect(value);
}
async function admission(db:PoolClient,companyId:string,kind:CompanyRuntimeKind,preset:RuntimePreset){
 const active=kind==='managed_agent'
  ?await db.query('SELECT id FROM studio_host_provisions WHERE company_id=$1 AND phase=ANY($2::text[]) LIMIT 1',[companyId,activePhases])
  :await db.query('SELECT id FROM trusted_service_provisions WHERE company_id=$1 AND service=$2 AND phase=ANY($3::text[]) LIMIT 1',[companyId,kind,activePhases]);
 if(active.rowCount)fail(409,'Stop and reconcile existing runtime resources before selecting a replacement.','RUNTIME_PROVISION_ACTIVE');
 if(kind==='managed_agent'){
  const p=preset as PinnedStudioCpuPreset,volume=p.company.volumeId;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`company-runtime-volume:${volume}`]);
  const occupied=await db.query("SELECT company_id FROM company_runtime_configurations WHERE worker_volume_id=$1 AND company_id<>$2 UNION ALL SELECT company_id FROM studio_host_provisions WHERE preset->'company'->>'volumeId'=$1 AND company_id<>$2 LIMIT 1",[volume,companyId]);
  if(occupied.rowCount)fail(409,'Worker state volumes cannot be reassigned across companies.','RUNTIME_VOLUME_COMPANY_CONFLICT');
  const sums=(await db.query('SELECT (SELECT COALESCE(sum(amount_microusd),0) FROM studio_host_compute_reservations WHERE company_id=$1) AS cpu,(SELECT COALESCE(sum(amount_microusd),0) FROM studio_inference_reservations WHERE company_id=$1) AS inference',[companyId])).rows[0];
  if(Number(sums.cpu)>p.company.lifetimeAllowanceMicrousd||p.inference&&Number(sums.inference)>p.inference.lifetimeAllowanceMicrousd)fail(409,'The reviewed allowance is below existing lifetime reservations.','RUNTIME_ALLOWANCE_ALREADY_RESERVED');
 }else{
  const p=preset as TrustedServicePreset;
  const projects=await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',[companyId,p.projectIds]);
  if(projects.rowCount!==p.projectIds.length)fail(409,'Every runtime project must belong to this company.','RUNTIME_PROJECT_SCOPE');
  const reserved=Number((await db.query('SELECT COALESCE(sum(amount_microusd),0) AS amount FROM trusted_service_reservations WHERE company_id=$1 AND service=$2',[companyId,kind])).rows[0].amount);
  if(reserved>p.lifetimeAllowanceMicrousd)fail(409,'The reviewed allowance is below existing lifetime reservations.','RUNTIME_ALLOWANCE_ALREADY_RESERVED');
 }
}
export async function selectCompanyRuntimeConfiguration(db:PoolClient,member:Membership,kindInput:CompanyRuntimeKind,input:unknown){
 const kind=kindValue(kindInput),parsed=companyRuntimeSelectInput.safeParse(input);if(!parsed.success)fail(400,'Review the required runtime configuration fields.','VALIDATION_ERROR');const data=parsed.data;
 if(Buffer.byteLength(JSON.stringify(data.preset))>200000)fail(413,'Runtime preset exceeds the reviewable size limit.');
 const requestHash=companyRuntimeHash({kind,operation:'select',...data});await authority(db,member,kind,data.clientId);const old=await replay(db,member,data.clientId,requestHash);if(old)return old;
 const current=await selection(db,member.companyId,kind);if((current?.selection_revision??0)!==data.expectedRevision)fail(409,'The runtime selection changed. Review its current revision.','RUNTIME_SELECTION_CONFLICT');
 rejectEmbeddedSecrets(data.preset);let preset:RuntimePreset;try{preset=parseCompanyRuntimePreset(data.preset,member.companyId,kind);}catch{fail(400,'The preset is not a valid reviewed company runtime configuration.','RUNTIME_PRESET_INVALID');}
 if(companyRuntimeHash(data.preset)!==data.configurationHash)fail(409,'The submitted preset differs from the reviewed hash.','RUNTIME_CONFIGURATION_HASH');
 if(kind==='managed_agent'&&data.phase!=='service'||kind!=='managed_agent'&&(preset as TrustedServicePreset).expiresAt!==data.expiresAt)fail(400,'The phase or fixed deadline differs from the reviewed runtime.','RUNTIME_DEADLINE_INVALID');
 await admission(db,member.companyId,kind,preset);
 // Re-check expiry after every potentially blocking resource/scope lock.
 const now=+new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now),until=Date.parse(data.expiresAt);
 if(until<=now+60000||until>now+86400000)fail(400,'Select a fixed deadline between one minute and 24 hours away.','RUNTIME_DEADLINE_INVALID');
 await requirePlatformRuntimeOperator(db,member);
 const configurationId=randomUUID(),revision=data.expectedRevision+1;
 await db.query('INSERT INTO company_runtime_configurations(id,company_id,kind,phase,preset,configuration_hash,worker_volume_id,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[configurationId,member.companyId,kind,data.phase,JSON.stringify(data.preset),data.configurationHash,kind==='managed_agent'?(preset as PinnedStudioCpuPreset).company.volumeId:null,data.expiresAt,member.userId]);
 if(current){const updated=await db.query("UPDATE company_runtime_selections SET configuration_id=$3,revision=revision+1,state='active',selected_by=$4,updated_at=clock_timestamp() WHERE company_id=$1 AND kind=$2 AND revision=$5",[member.companyId,kind,configurationId,member.userId,data.expectedRevision]);if(updated.rowCount!==1)fail(409,'The runtime selection changed.','RUNTIME_SELECTION_CONFLICT');}
 else await db.query("INSERT INTO company_runtime_selections(company_id,kind,configuration_id,revision,state,selected_by) VALUES($1,$2,$3,$4,'active',$5)",[member.companyId,kind,configurationId,revision,member.userId]);
 const result={configuration:summary((await selection(db,member.companyId,kind))!),replayed:false};await receipt(db,member,kind,'select',data.clientId,requestHash,result);return result;
}
export async function revokeCompanyRuntimeConfiguration(db:PoolClient,member:Membership,kindInput:CompanyRuntimeKind,input:unknown){
 const kind=kindValue(kindInput),parsed=companyRuntimeRevokeInput.safeParse(input);if(!parsed.success)fail(400,'Review the current runtime selection revision.','VALIDATION_ERROR');const data=parsed.data,requestHash=companyRuntimeHash({kind,operation:'revoke',...data});
 await authority(db,member,kind,data.clientId);const old=await replay(db,member,data.clientId,requestHash);if(old)return old;
 const current=await selection(db,member.companyId,kind);if(!current)fail(404,'This company runtime has never been configured.');
 if(current.selection_revision!==data.expectedRevision)fail(409,'The runtime selection changed. Review its current revision.','RUNTIME_SELECTION_CONFLICT');
 await db.query("UPDATE company_runtime_selections SET state='revoked',revision=revision+1,selected_by=$3,updated_at=clock_timestamp() WHERE company_id=$1 AND kind=$2 AND revision=$4",[member.companyId,kind,member.userId,data.expectedRevision]);
 await requestCompanyRuntimeStop(db,member.companyId,kind,current.configuration_id);
 const result={configuration:summary((await selection(db,member.companyId,kind))!),replayed:false};await receipt(db,member,kind,'revoke',data.clientId,requestHash,result);return result;
}

/** Caller holds the company runtime control lock. Persist priority shutdown
 * intent only; the existing reconciler verifies the exact stored pod identity. */
export async function requestCompanyRuntimeStop(db:PoolClient,companyId:string,kind:CompanyRuntimeKind,configurationId:string){
 if(kind==='managed_agent')return db.query("UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND plan->'runtimeConfiguration'->>'configurationId'=$2 AND phase=ANY($3::text[]) AND stop_requested_at IS NULL",[companyId,configurationId,activePhases]);
 return db.query("UPDATE trusted_service_provisions SET stop_requested_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND service=$2 AND plan->'runtimeConfiguration'->>'configurationId'=$3 AND phase=ANY($4::text[]) AND stop_requested_at IS NULL",[companyId,kind,configurationId,activePhases]);
}
