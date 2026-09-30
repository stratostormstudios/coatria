/** Pure reference configuration/receipt contract. No CLI, host mutation or IO. */
import {posix} from 'node:path';
import {z} from 'zod';
import {referenceServiceOrigin} from '../../src/lib/higgsfield-reference-service-client';
import {createHiggsfieldReferenceUploader} from '../../src/lib/higgsfield-reference-transport';
import {referenceRunnerConfigurationHash,deriveReferenceRunnerConfiguration as derive} from './reference-runner-identity.mjs';
export {referenceRunnerConfigurationHash} from './reference-runner-identity.mjs';

export class ReferenceRunnerError extends Error {constructor(readonly code:'REFERENCE_RUNNER_CONFIGURATION_INVALID'|'REFERENCE_RUNNER_UNQUALIFIED'|'REFERENCE_RUNNER_STOPPED'){super(code);this.name='ReferenceRunnerError';}}
export function referenceRunnerFailure(code:ReferenceRunnerError['code']='REFERENCE_RUNNER_CONFIGURATION_INVALID'):never{throw new ReferenceRunnerError(code);}
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid(),absolute=z.string().max(1024).refine(v=>posix.isAbsolute(v)&&v.startsWith('/')&&!v.includes('\\')&&!v.includes('\0')&&posix.normalize(v)===v);
const projects=z.array(uuid).min(1).max(100).refine(ids=>new Set(ids).size===ids.length);
const configSchema=z.object({version:z.literal(1),serviceId:uuid,companyId:uuid,projectIds:projects,origin:z.string(),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),releaseSha256:hash,runtimePath:absolute,expiresAt:z.iso.datetime(),scratchRoot:absolute,profilePath:absolute,profileSha256:hash,cgroupRoot:absolute,uploadHosts:z.array(z.string()).min(1).max(32),qualification:z.object({path:absolute,sha256:hash}).strict()}).strict();
export type ReferenceRunnerConfiguration=z.infer<typeof configSchema>;
type Unit={name:string;sha256:string};
export type ReferenceHostConfiguration={version:1;bundleSha256:string;commit:string;tree:string;release:string;uid:number;gid:number;scope:{serviceId:string;companyId:string;projectIds:string[];origin:string;expiresAt:string;uploadHosts:string[]};profiles:{real:{profilePath:string;expectedProfileSha256:string};conformance:{profilePath:string;expectedProfileSha256:string}};worker:{path:string;sha256:string};qualifier:{path:string;sha256:string};units:{qualify:Unit;preflight:Unit;worker:Unit}};
const unit=z.object({name:z.string().regex(/^coatria-reference-[a-f0-9-]{36}-(?:qualify|preflight|worker)\.service$/),sha256:hash}).strict();
const receiptSchema=z.object({version:z.literal(2),kind:z.literal('coatria-reference-worker-qualification'),serviceId:uuid,companyId:uuid,projectIds:projects,sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),sourceTree:z.string().regex(/^[a-f0-9]{40}$/),bundleSha256:hash,releaseSha256:hash,qualifierSha256:hash,configurationSha256:hash,hostConfigurationSha256:hash,profileSha256:hash,conformanceProfileSha256:hash,bootId:uuid,uid:z.number().int().positive(),gid:z.number().int().positive(),expiresAt:z.iso.datetime(),units:z.object({qualify:unit,preflight:unit,worker:unit}).strict(),qualifierInvocationId:z.string().regex(/^[a-f0-9]{32}$/).refine(v=>!/^0+$/.test(v)),serviceRoot:absolute,evidenceSha256:hash,reportSha256:hash,acceptedAt:z.iso.datetime(),qualified:z.literal(true),checks:z.object({isolation:z.literal(true),resourceLimits:z.literal(true),descendantCleanup:z.literal(true),preparedImages:z.literal(true)}).strict()}).strict();
const sameProjects=(a:readonly string[],b:readonly string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
/** Only the receipt locator/hash is omitted to avoid a circular digest. */
export function parseReferenceRunnerConfiguration(input:unknown,now=Date.now()){
 const parsed=configSchema.safeParse(input);if(!parsed.success)referenceRunnerFailure();const c=parsed.data;
 referenceServiceOrigin(c.origin);const expiry=Date.parse(c.expiresAt);
 if(expiry<=now||expiry-now>3600000||c.scratchRoot!==`/var/lib/coatria-reference-worker/${c.serviceId}/scratch`||!c.runtimePath.endsWith('/runtime.mjs')||c.cgroupRoot!==`/sys/fs/cgroup/system.slice/coatria-reference-${c.serviceId}-worker.service/decoders`)referenceRunnerFailure();
 createHiggsfieldReferenceUploader({allowedHosts:c.uploadHosts});return c;
}
/** Stable across acceptance: the qualification digest is deliberately excluded
 * from configurationSha256. Unit commands pin host path and bundle, not receipt. */
export function deriveReferenceRunnerConfiguration(host:ReferenceHostConfiguration,qualificationSha256:string):ReferenceRunnerConfiguration{
 return derive(host,qualificationSha256) as ReferenceRunnerConfiguration;
}
export function assertReferenceRunnerReceipt(input:unknown,c:ReferenceRunnerConfiguration,identity:{bootId:string;uid:number;gid:number;hostConfigurationSha256:string;host:ReferenceHostConfiguration},now=Date.now()){
 const parsed=receiptSchema.safeParse(input);if(!parsed.success)referenceRunnerFailure('REFERENCE_RUNNER_UNQUALIFIED');const r=parsed.data,h=identity.host;
 if(r.serviceId!==c.serviceId||r.companyId!==c.companyId||!sameProjects(r.projectIds,c.projectIds)||r.sourceCommit!==c.sourceCommit||r.releaseSha256!==c.releaseSha256||r.profileSha256!==c.profileSha256||r.configurationSha256!==referenceRunnerConfigurationHash(c)||r.bootId!==identity.bootId||r.uid!==identity.uid||r.gid!==identity.gid||r.uid!==h.uid||r.gid!==h.gid||r.expiresAt!==c.expiresAt||Date.parse(r.expiresAt)<=now||Date.parse(r.expiresAt)-now>3600000||Date.parse(r.acceptedAt)>now||r.hostConfigurationSha256!==identity.hostConfigurationSha256||r.sourceTree!==h.tree||r.bundleSha256!==h.bundleSha256||r.qualifierSha256!==h.qualifier.sha256||r.conformanceProfileSha256!==h.profiles.conformance.expectedProfileSha256||canonical(r.units)!==canonical(h.units)||r.serviceRoot!==`/sys/fs/cgroup/system.slice/${h.units.qualify.name}`)referenceRunnerFailure('REFERENCE_RUNNER_UNQUALIFIED');
 return r;
}
