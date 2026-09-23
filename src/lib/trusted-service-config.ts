/** Fixed operator presets and private server-only credential composition. */
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {fail} from './security';
import type {TrustedServiceKind} from './trusted-service-protocol';
import {parseTrustedServicePreset,canonicalServiceValue,runtimeConfigurationPin,type RuntimeConfigurationPin,type TrustedServicePreset} from './company-runtime-preset';
import {loadCompanyRuntimeConfiguration} from './company-runtime-config';
export {parseTrustedServiceGatewayConfiguration,canonicalServiceValue,trustedServiceHash,type TrustedServicePreset} from './company-runtime-preset';
export const TRUSTED_SERVICE_IMAGE='node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174';
export const TRUSTED_SERVICE_DATABASE_ROLES={archive:'coatria_higgsfield_archive_worker_v1',gateway:'coatria_storage_gateway_v1'} as const;
export function trustedServicePreset(companyId:string,service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>=process.env){
 let raw:unknown;try{raw=JSON.parse(settings.COATRIA_TRUSTED_SERVICE_PRESETS||'');}catch{fail(503,'A reviewed trusted service preset is not installed.','SERVICE_PRESET_UNAVAILABLE');}
 const parsed=z.object({version:z.literal(1),presets:z.array(z.unknown()).min(1).max(20)}).strict().safeParse(raw);if(!parsed.success)fail(503,'Trusted service presets are invalid.','SERVICE_PRESET_UNAVAILABLE');
 const presets=parsed.data.presets.map(value=>parseTrustedServicePreset(value));if(new Set(presets.map(p=>p.companyId+':'+p.service)).size!==presets.length)fail(503,'Duplicate service presets are not allowed.','SERVICE_PRESET_UNAVAILABLE');
 const found=presets.find(p=>p.companyId===companyId&&p.service===service);if(!found)fail(503,'This trusted service is not enabled for the company.','SERVICE_COMPANY_NOT_ENABLED');return found;
}

export type ResolvedTrustedService={preset:TrustedServicePreset;runtimeConfiguration:RuntimeConfigurationPin|null};
/** Only companies that never selected a durable configuration may use legacy env presets. */
export async function loadTrustedServicePreset(db:PoolClient,companyId:string,service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>=process.env):Promise<ResolvedTrustedService>{
 const selected=await loadCompanyRuntimeConfiguration(db,companyId,service);
 if(!selected){const preset=trustedServicePreset(companyId,service,settings);if(Date.parse(preset.expiresAt)<=Date.now())fail(409,'The reviewed service deadline has ended.','SERVICE_PRESET_EXPIRED');return {preset,runtimeConfiguration:null};}
 if(!selected.enabled)fail(409,'The company service configuration is disabled, revoked or expired.','SERVICE_CONFIGURATION_INACTIVE');
 return {preset:selected.preset as TrustedServicePreset,runtimeConfiguration:runtimeConfigurationPin(selected)};
}

function databaseUrl(service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>){
 const value=settings[service==='archive'?'COATRIA_ARCHIVE_DATABASE_URL':'COATRIA_STORAGE_GATEWAY_DATABASE_URL'];let url:URL,main:URL;
 try{url=new URL(value||'');main=new URL(settings.DATABASE_URL||'');}catch{fail(503,'Dedicated service database configuration is unavailable.','SERVICE_DATABASE_UNAVAILABLE');}
 const endpoint=(u:URL)=>u.hostname.replace('-pooler.','.');
 let other:URL|undefined;try{const raw=settings[service==='archive'?'COATRIA_STORAGE_GATEWAY_DATABASE_URL':'COATRIA_ARCHIVE_DATABASE_URL'];if(raw)other=new URL(raw);}catch{fail(503,'Dedicated service credentials must be reviewed.','SERVICE_DATABASE_UNAVAILABLE');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!==TRUSTED_SERVICE_DATABASE_ROLES[service]||!url.password||decodeURIComponent(url.password)===decodeURIComponent(main.password)||other&&decodeURIComponent(url.password)===decodeURIComponent(other.password)||url.hash||url.searchParams.get('sslmode')!=='require'||[...url.searchParams.keys()].some(key=>!['sslmode','channel_binding'].includes(key))||!url.hostname.endsWith('.neon.tech')||endpoint(url)!==endpoint(main)||url.pathname!==main.pathname)fail(503,'The dedicated service database must match the application branch and role with separate credentials.','SERVICE_DATABASE_UNAVAILABLE');return value!;
}
function keyring(settings:Readonly<Record<string,string|undefined>>){
 const value=settings.COATRIA_HOSTING_KEYRING;try{const ring=JSON.parse(value||'');if(!ring||typeof ring!=='object'||typeof ring.activeKeyId!=='string'||!ring.keys||typeof ring.keys!=='object'||Array.isArray(ring.keys)||Object.keys(ring.keys).length<1||Object.keys(ring.keys).length>5||!ring.keys[ring.activeKeyId]||Object.entries(ring.keys).some(([id,key])=>!/^[A-Za-z0-9_-]{1,40}$/.test(id)||typeof key!=='string'||Buffer.from(key,'base64').length!==32||Buffer.from(key,'base64').toString('base64')!==key))throw Error();}catch{fail(503,'The existing server encryption keyring is unavailable.','SERVICE_KEYRING_UNAVAILABLE');}return value!;
}
/** Caller must keep the return value in server memory only, send directly to
 * the provider and persist hashes only. Never expose this through an API. */
export function trustedServiceEnvironment(preset:TrustedServicePreset,settings:Readonly<Record<string,string|undefined>>=process.env,provisionId?:string):Record<string,string>{
 if(provisionId!==undefined&&!z.uuid().safeParse(provisionId).success)fail(503,'The service provision identity is invalid.','SERVICE_CONFIGURATION_REQUIRED');
 const shared={NODE_ENV:'production',DATABASE_URL:databaseUrl(preset.service,settings),COATRIA_HOSTING_KEYRING:keyring(settings),COATRIA_SERVICE_CONFIGURATION:canonicalServiceValue(preset.configuration),COATRIA_SERVICE_CONFIGURATION_SHA256:preset.configurationHash,COATRIA_SERVICE_KIND:preset.service,COATRIA_SERVICE_EXPIRES_AT:preset.expiresAt,COATRIA_SERVICE_SOURCE_COMMIT:preset.releaseCommit,...provisionId?{COATRIA_SERVICE_PROVISION_ID:provisionId}:{}};
 if(preset.service==='gateway')return {...shared,APP_URL:'https://coatria.com',HOST:'0.0.0.0',PORT:'4190'};
 const token=settings.COATRIA_VERCEL_MEDIA_TOKEN;if(!token||token===settings.MANAGED_RUNPOD_API_KEY||token.length<8||token.length>4096||/[\r\n]/.test(token))fail(503,'The archive-only remote executor credential is unavailable.','SERVICE_EXECUTOR_UNAVAILABLE');
 return {...shared,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:'true',COATRIA_VERCEL_MEDIA_TOKEN:token};
}
export async function companyTrustedServiceEnvironment(db:PoolClient,resolved:ResolvedTrustedService,provisionId?:string,settings:Readonly<Record<string,string|undefined>>=process.env){
 let privateSettings=settings;
 if(resolved.preset.service==='archive'&&resolved.runtimeConfiguration){
  const {resolveCompanyArchiveExecutor}=await import('./company-runtime-executor');
  const executor=await resolveCompanyArchiveExecutor(db,resolved.preset.companyId,resolved.runtimeConfiguration.configurationId,resolved.preset,settings);
  privateSettings={...settings,COATRIA_VERCEL_MEDIA_TOKEN:executor.token};
 }
 return trustedServiceEnvironment(resolved.preset,privateSettings,provisionId);
}
export async function companyTrustedServiceReadiness(db:PoolClient,companyId:string,service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>=process.env){
 try{const selected=await loadTrustedServicePreset(db,companyId,service,settings);if(!settings.MANAGED_RUNPOD_API_KEY)fail(503,'Configure the server-only lifecycle credential.','SERVICE_PROVIDER_UNAVAILABLE');await companyTrustedServiceEnvironment(db,selected,undefined,settings);return {configured:true as const,code:null,serviceVerified:false as const};}
 catch(error){return {configured:false as const,code:typeof(error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'SERVICE_PRESET_UNAVAILABLE',serviceVerified:false as const};}
}
export function trustedServiceReadiness(companyId:string,service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>=process.env){
 try{const preset=trustedServicePreset(companyId,service,settings);if(!settings.MANAGED_RUNPOD_API_KEY)fail(503,'Configure the server-only lifecycle credential.','SERVICE_PROVIDER_UNAVAILABLE');trustedServiceEnvironment(preset,settings);return {configured:true as const,code:null,serviceVerified:false as const};}
 catch(error){return {configured:false as const,code:typeof(error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'SERVICE_PRESET_UNAVAILABLE',serviceVerified:false as const};}
}
