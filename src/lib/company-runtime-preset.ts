/** Strict, side-effect-free preset validation shared by legacy configuration and the durable registry. */
import {z} from 'zod';
import {fail,hashToken} from './security';
import {parseRemoteArchiveConfiguration} from './higgsfield-remote-archive-config';
import {trustedServiceKind,type TrustedServiceKind} from './trusted-service-protocol';
export type RuntimeConfigurationPin={configurationId:string;selectionRevision:number;configurationHash:string;expiresAt:string};
export function runtimeConfigurationPin(value:RuntimeConfigurationPin):RuntimeConfigurationPin{return {configurationId:value.configurationId,selectionRevision:value.selectionRevision,configurationHash:value.configurationHash,expiresAt:value.expiresAt};}
export function sameRuntimeConfiguration(a:RuntimeConfigurationPin|null|undefined,b:RuntimeConfigurationPin|null|undefined){return !a&&!b||!!a&&!!b&&a.configurationId===b.configurationId&&a.selectionRevision===b.selectionRevision&&a.configurationHash===b.configurationHash&&a.expiresAt===b.expiresAt;}
const providerId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),sha=z.string().regex(/^[a-f0-9]{64}$/);
const trustedPresetSchema=z.object({id:z.string().regex(/^[a-z0-9_-]{1,60}$/),service:trustedServiceKind,companyId:z.uuid(),projectIds:z.array(z.uuid()).min(1).max(100),releaseCommit:z.string().regex(/^[a-f0-9]{40}$/),bootstrapArgs:z.string().min(100).max(100000),bootstrapHash:sha,dataCenterId:providerId,expiresAt:z.iso.datetime(),maxHourlyMicrousd:z.number().int().min(1000).max(1000000),lifetimeAllowanceMicrousd:z.number().int().min(1).max(5000000),configuration:z.unknown(),configurationHash:sha}).strict();
const gatewayConfig=z.object({version:z.literal(1),companyId:z.uuid(),projectIds:z.array(z.uuid()).min(1).max(100),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),expiresAt:z.iso.datetime(),appOrigin:z.literal('https://coatria.com'),host:z.literal('0.0.0.0'),port:z.literal(4190),maxTransfers:z.literal(8),verifierConcurrency:z.literal(1)}).strict();
export const parseTrustedServiceGatewayConfiguration=(value:unknown)=>gatewayConfig.parse(value);
export type TrustedServicePreset=z.infer<typeof trustedPresetSchema>;
export function canonicalServiceValue(value:unknown):string{return Array.isArray(value)?'['+value.map(canonicalServiceValue).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonicalServiceValue(item)).join(',')+'}':JSON.stringify(value);}
export const trustedServiceHash=(value:unknown)=>hashToken(canonicalServiceValue(value));

const safeProviderId=/^[A-Za-z0-9_-]{1,100}$/;
const inferencePresetSchema=z.object({mode:z.literal('coatria_broker_v1'),maxJobs:z.number().int().min(1).max(100),maxHourlyMicrousd:z.number().int().min(1000).max(10000000),lifetimeAllowanceMicrousd:z.number().int().positive().max(20000000)}).strict();
const studioPresetSchema=z.object({inference:inferencePresetSchema.optional(),id:z.string().regex(/^[a-z0-9_-]{1,60}$/),releaseCommit:z.string().regex(/^[a-f0-9]{40}$/),bootstrapArgs:z.string().min(100).max(100000),bootstrapHash:z.string().regex(/^[a-f0-9]{64}$/),modelId:z.string().min(1).max(150),endpointId:z.string().regex(safeProviderId),maxHourlyMicrousd:z.number().int().min(1000).max(1000000),maxSteps:z.number().int().min(1).max(24),maxOutputTokens:z.number().int().min(512).max(8192),maxTotalTokens:z.number().int().min(4096).max(200000),timeoutSeconds:z.number().int().min(30).max(600),companies:z.array(z.object({companyId:z.string().uuid(),volumeId:z.string().regex(safeProviderId),dataCenterId:z.string().regex(safeProviderId),lifetimeAllowanceMicrousd:z.number().int().positive().max(5000000)}).strict()).min(1).max(100)}).strict();
export type StudioCpuPreset=z.infer<typeof studioPresetSchema>;
export type PinnedStudioCpuPreset=Omit<StudioCpuPreset,'companies'>&{company:StudioCpuPreset['companies'][number]};

export function parseStudioCpuPreset(value:unknown,companyId:string):PinnedStudioCpuPreset{
 const result=studioPresetSchema.safeParse(value);if(!result.success)fail(503,'The managed CPU preset is invalid.','CPU_PRESET_UNAVAILABLE');
 const p=result.data;if(new Set(p.companies.map(c=>c.companyId)).size!==p.companies.length||new Set(p.companies.map(c=>c.volumeId)).size!==p.companies.length)fail(503,'Each managed company requires its own approved retained volume.','CPU_PRESET_UNAVAILABLE');
 if(hashToken(p.bootstrapArgs)!==p.bootstrapHash||!/^node --input-type=module -e "import\('data:text\/javascript;base64,[A-Za-z0-9+/=]+'\)\.catch\(\(\)=>\{console\.error\('COATRIA_STUDIO_BOOTSTRAP_FAILED'\);process\.exit\(1\)\}\)"$/.test(p.bootstrapArgs))fail(503,'The reviewed bootstrap hash does not match.','CPU_PRESET_UNAVAILABLE');
 const company=p.companies.find(c=>c.companyId===companyId);if(!company)fail(503,'Managed CPU provisioning is not enabled for this company.','CPU_COMPANY_NOT_ENABLED');
 const{companies:_,...release}=p;return{...release,company};
}
export function parseTrustedServicePreset(value:unknown,companyId?:string,service?:TrustedServiceKind):TrustedServicePreset{
 const result=trustedPresetSchema.safeParse(value);if(!result.success)fail(503,'Trusted service presets are invalid.','SERVICE_PRESET_UNAVAILABLE');
 const p=result.data;
  if(new Set(p.projectIds).size!==p.projectIds.length||hashToken(p.bootstrapArgs)!==p.bootstrapHash||!/^node --input-type=module -e "import\('data:text\/javascript;base64,[A-Za-z0-9+/=]+'\)\.catch\(\(\)=>\{console\.error\('COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED'\);process\.exit\(1\)\}\)"$/.test(p.bootstrapArgs)||trustedServiceHash(p.configuration)!==p.configurationHash)fail(503,'The immutable service release does not match its reviewed hashes.','SERVICE_PRESET_UNAVAILABLE');
  let config;try{config=p.service==='archive'?parseRemoteArchiveConfiguration(p.configuration):gatewayConfig.parse(p.configuration);}catch{fail(503,'The reviewed service configuration is invalid.','SERVICE_PRESET_UNAVAILABLE');}
  const scope=p.service==='archive'?(config as ReturnType<typeof parseRemoteArchiveConfiguration>).policy:config as z.infer<typeof gatewayConfig>;
  if(scope.companyId!==p.companyId||scope.expiresAt!==p.expiresAt||scope.sourceCommit!==p.releaseCommit||canonicalServiceValue([...scope.projectIds].sort())!==canonicalServiceValue([...p.projectIds].sort()))fail(503,'The service scope differs from its immutable configuration.','SERVICE_PRESET_UNAVAILABLE');
 if(companyId!==undefined&&p.companyId!==companyId||service!==undefined&&p.service!==service)fail(503,'This trusted service is not enabled for the company.','SERVICE_COMPANY_NOT_ENABLED');return p;
}
export function parseCompanyRuntimePreset(value:unknown,companyId:string,kind:'managed_agent'|'archive'|'gateway'){
 if(kind==='managed_agent'){
  const raw=studioPresetSchema.safeParse(value);if(!raw.success||raw.data.companies.length!==1)fail(503,'A company runtime must contain exactly one company.','CPU_PRESET_UNAVAILABLE');
  return parseStudioCpuPreset(raw.data,companyId);
 }
 return parseTrustedServicePreset(value,companyId,kind);
}
