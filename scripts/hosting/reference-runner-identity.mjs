/** Stable byte-independent identities; no IO, CLI, secrets or source loaders. */
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
import {createHash} from 'node:crypto';
export function referenceRunnerConfigurationHash(configuration){const {qualification:_receipt,...identity}=configuration;return createHash('sha256').update('coatria:reference-runner-configuration:v1\n'+canonical(identity)).digest('hex');}
export function deriveReferenceRunnerConfiguration(host,qualificationSha256){
 const s=host.scope;return {version:1,serviceId:s.serviceId,companyId:s.companyId,projectIds:[...s.projectIds],origin:s.origin,sourceCommit:host.commit,releaseSha256:host.worker.sha256,runtimePath:host.worker.path,expiresAt:s.expiresAt,scratchRoot:`/var/lib/coatria-reference-worker/${s.serviceId}/scratch`,profilePath:host.profiles.real.profilePath,profileSha256:host.profiles.real.expectedProfileSha256,cgroupRoot:`/sys/fs/cgroup/system.slice/coatria-reference-${s.serviceId}-worker.service/decoders`,uploadHosts:[...s.uploadHosts],qualification:{path:`/etc/coatria-reference/${s.serviceId}/qualified.json`,sha256:qualificationSha256}};
}
