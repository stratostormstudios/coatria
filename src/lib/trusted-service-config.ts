/** Fixed operator presets and private server-only credential composition. */
import {z} from 'zod';
import {hashToken,fail} from './security';
import {parseRemoteArchiveConfiguration} from './higgsfield-remote-archive-config';
import {trustedServiceKind,type TrustedServiceKind} from './trusted-service-protocol';
export const TRUSTED_SERVICE_IMAGE='node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174';
export const TRUSTED_SERVICE_DATABASE_ROLES={archive:'coatria_higgsfield_archive_worker_v1',gateway:'coatria_storage_gateway_v1'} as const;
const providerId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),sha=z.string().regex(/^[a-f0-9]{64}$/);
const presetSchema=z.object({id:z.string().regex(/^[a-z0-9_-]{1,60}$/),service:trustedServiceKind,companyId:z.uuid(),projectIds:z.array(z.uuid()).min(1).max(100),releaseCommit:z.string().regex(/^[a-f0-9]{40}$/),bootstrapArgs:z.string().min(100).max(100000),bootstrapHash:sha,dataCenterId:providerId,expiresAt:z.iso.datetime(),maxHourlyMicrousd:z.number().int().min(1000).max(1000000),lifetimeAllowanceMicrousd:z.number().int().min(1).max(5000000),configuration:z.unknown(),configurationHash:sha}).strict();
const gatewayConfig=z.object({version:z.literal(1),companyId:z.uuid(),projectIds:z.array(z.uuid()).min(1).max(100),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),expiresAt:z.iso.datetime(),appOrigin:z.literal('https://coatria.com'),host:z.literal('0.0.0.0'),port:z.literal(4190),maxTransfers:z.literal(8),verifierConcurrency:z.literal(1)}).strict();
export const parseTrustedServiceGatewayConfiguration=(value:unknown)=>gatewayConfig.parse(value);
export type TrustedServicePreset=z.infer<typeof presetSchema>;
export function canonicalServiceValue(value:unknown):string{return Array.isArray(value)?'['+value.map(canonicalServiceValue).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonicalServiceValue(item)).join(',')+'}':JSON.stringify(value);}
export const trustedServiceHash=(value:unknown)=>hashToken(canonicalServiceValue(value));
export function trustedServicePreset(companyId:string,service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>=process.env){
 let raw:unknown;try{raw=JSON.parse(settings.COATRIA_TRUSTED_SERVICE_PRESETS||'');}catch{fail(503,'A reviewed trusted service preset is not installed.','SERVICE_PRESET_UNAVAILABLE');}
 const parsed=z.object({version:z.literal(1),presets:z.array(presetSchema).min(1).max(20)}).strict().safeParse(raw);if(!parsed.success)fail(503,'Trusted service presets are invalid.','SERVICE_PRESET_UNAVAILABLE');
 const presets=parsed.data.presets;if(new Set(presets.map(p=>p.companyId+':'+p.service)).size!==presets.length)fail(503,'Duplicate service presets are not allowed.','SERVICE_PRESET_UNAVAILABLE');
 for(const p of presets){
  if(new Set(p.projectIds).size!==p.projectIds.length||hashToken(p.bootstrapArgs)!==p.bootstrapHash||!/^node --input-type=module -e "import\('data:text\/javascript;base64,[A-Za-z0-9+/=]+'\)\.catch\(\(\)=>\{console\.error\('COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED'\);process\.exit\(1\)\}\)"$/.test(p.bootstrapArgs)||trustedServiceHash(p.configuration)!==p.configurationHash)fail(503,'The immutable service release does not match its reviewed hashes.','SERVICE_PRESET_UNAVAILABLE');
  let config;try{config=p.service==='archive'?parseRemoteArchiveConfiguration(p.configuration):gatewayConfig.parse(p.configuration);}catch{fail(503,'The reviewed service configuration is invalid.','SERVICE_PRESET_UNAVAILABLE');}
  const scope=p.service==='archive'?(config as ReturnType<typeof parseRemoteArchiveConfiguration>).policy:config as z.infer<typeof gatewayConfig>;
  if(scope.companyId!==p.companyId||scope.expiresAt!==p.expiresAt||scope.sourceCommit!==p.releaseCommit||canonicalServiceValue([...scope.projectIds].sort())!==canonicalServiceValue([...p.projectIds].sort()))fail(503,'The service scope differs from its immutable configuration.','SERVICE_PRESET_UNAVAILABLE');
 }
 const found=presets.find(p=>p.companyId===companyId&&p.service===service);if(!found)fail(503,'This trusted service is not enabled for the company.','SERVICE_COMPANY_NOT_ENABLED');return found;
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
export function trustedServiceEnvironment(preset:TrustedServicePreset,settings:Readonly<Record<string,string|undefined>>=process.env):Record<string,string>{
 const shared={NODE_ENV:'production',DATABASE_URL:databaseUrl(preset.service,settings),COATRIA_HOSTING_KEYRING:keyring(settings),COATRIA_SERVICE_CONFIGURATION:canonicalServiceValue(preset.configuration),COATRIA_SERVICE_CONFIGURATION_SHA256:preset.configurationHash,COATRIA_SERVICE_KIND:preset.service,COATRIA_SERVICE_EXPIRES_AT:preset.expiresAt,COATRIA_SERVICE_SOURCE_COMMIT:preset.releaseCommit};
 if(preset.service==='gateway')return {...shared,APP_URL:'https://coatria.com',HOST:'0.0.0.0',PORT:'4190'};
 const token=settings.COATRIA_VERCEL_MEDIA_TOKEN;if(!token||token===settings.MANAGED_RUNPOD_API_KEY||token.length<8||token.length>4096||/[\r\n]/.test(token))fail(503,'The archive-only remote executor credential is unavailable.','SERVICE_EXECUTOR_UNAVAILABLE');
 return {...shared,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:'true',COATRIA_VERCEL_MEDIA_TOKEN:token};
}
export function trustedServiceReadiness(companyId:string,service:TrustedServiceKind,settings:Readonly<Record<string,string|undefined>>=process.env){
 try{const preset=trustedServicePreset(companyId,service,settings);if(!settings.MANAGED_RUNPOD_API_KEY)fail(503,'Configure the server-only lifecycle credential.','SERVICE_PROVIDER_UNAVAILABLE');trustedServiceEnvironment(preset,settings);return {configured:true as const,code:null,serviceVerified:false as const};}
 catch(error){return {configured:false as const,code:typeof(error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'SERVICE_PRESET_UNAVAILABLE',serviceVerified:false as const};}
}
