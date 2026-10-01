/** Immutable registrar contract. Parsing never enrolls, qualifies or starts a host. */
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';

export class ImagePreparationEnrollmentError extends Error {
 constructor(code){super(code);this.name='ImagePreparationEnrollmentError';this.code=code;}
}
/** @param {string} [code] @returns {never} */
export function imagePreparationEnrollmentFailure(code='IMAGE_PREPARATION_ENROLLMENT_INVALID'){throw new ImagePreparationEnrollmentError(code);}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),sha=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),revision=z.number().int().positive().max(2147483647);
const date=z.iso.datetime().refine(v=>new Date(v).toISOString()===v);
// Membership epochs retain database microseconds. Truncating to JS milliseconds
// would permit a different remove/reinvite epoch to match an old enrollment.
const epoch=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(v=>Number.isFinite(Date.parse(v)));
const host=z.string().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/).refine(v=>!isIP(v)&&!v.endsWith('.localhost')&&v.split('.').every(p=>p.length<=63));
const origin=z.string().max(512).refine(v=>{try{const u=new URL(v);return u.origin===v&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&host.safeParse(u.hostname).success;}catch{return false;}});
const project=z.object({projectId:uuid,projectRevision:revision,storageBindingId:uuid,storageBindingRevision:revision,storageConnectionId:uuid,storageConnectionRevision:revision,
 gateway:z.object({bindingId:uuid,provisionId:uuid,configurationSha256:sha,origin,expiresAt:date}).strict()}).strict();
const qualification=z.object({kind:z.literal('coatria-image-preparation-qualification-v1'),sourceCommit:commit,sourceTree:commit,bundleSha256:sha,hostConfigurationSha256:sha,configurationSha256:sha,qualifierSha256:sha,conformanceProfileSha256:sha,bootId:uuid,uid:revision,gid:revision,qualifierInvocationId:z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/),evidenceSha256:sha,reportSha256:sha,acceptedAt:date}).strict();
export const imagePreparationEnrollmentRequestSchema=z.object({version:z.literal(1),requestId:uuid,serviceId:uuid,companyId:uuid,enrolledBy:uuid,enroller:z.object({role:z.enum(['owner','admin']),joinedAt:epoch}).strict(),tokenHash:sha,origin,
 location:z.string().trim().min(1).max(200),releaseSha256:sha,qualificationSha256:sha,profileSha256:sha,sourceCommit:commit,closureSha256:sha,recipeSha256:sha,transport:z.literal('linux_binary_v1'),expiresAt:date,
 projects:z.array(project).min(1).max(32).refine(v=>new Set(v.map(p=>p.projectId)).size===v.length),qualification}).strict();
/** @typedef {z.infer<typeof imagePreparationEnrollmentRequestSchema>} ImagePreparationEnrollmentRequest */
/** @param {unknown} value @param {{allowExpired?:boolean,now?:number}} [options] @returns {ImagePreparationEnrollmentRequest} */
export function parseImagePreparationEnrollmentRequest(value,{allowExpired=false,now=Date.now()}={}){
 const result=imagePreparationEnrollmentRequestSchema.safeParse(value);if(!result.success||!Number.isSafeInteger(now))imagePreparationEnrollmentFailure();
 const r=result.data,expiry=Date.parse(r.expiresAt),accepted=Date.parse(r.qualification.acceptedAt);
 if(Buffer.byteLength(JSON.stringify(r))>65536||r.sourceCommit!==r.qualification.sourceCommit||accepted>now||expiry<=accepted||expiry-accepted>3600000)imagePreparationEnrollmentFailure();
 if(!allowExpired&&(expiry<=now||expiry-now>3600000))imagePreparationEnrollmentFailure('IMAGE_PREPARATION_ENROLLMENT_EXPIRED');
 const connections=new Map();for(const p of r.projects){
  if(Date.parse(p.gateway.expiresAt)<expiry||connections.has(p.storageConnectionId)&&connections.get(p.storageConnectionId)!==p.storageConnectionRevision)imagePreparationEnrollmentFailure();
  connections.set(p.storageConnectionId,p.storageConnectionRevision);
 }
 return r;
}
/** @param {any} value @returns {string} */
export const imagePreparationEnrollmentCanonical=value=>Array.isArray(value)?'['+value.map(imagePreparationEnrollmentCanonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+imagePreparationEnrollmentCanonical(v)).join(',')+'}':JSON.stringify(value);
export const imagePreparationEnrollmentHash=value=>createHash('sha256').update('coatria-image-preparation-enrollment-v1\0'+imagePreparationEnrollmentCanonical(value)).digest('hex');
/** @param {Pick<ImagePreparationEnrollmentRequest,'companyId'|'serviceId'>} r */
export const imagePreparationEnrollmentLockKey=r=>'image-preparation-enrollment:'+r.companyId+':'+r.serviceId;
/** @param {ImagePreparationEnrollmentRequest} r */
export function imagePreparationEnrollmentServiceIdentity(r){return {id:r.serviceId,company_id:r.companyId,token_hash:r.tokenHash,enrolled_by:r.enrolledBy,sponsor_role:r.enroller.role,sponsor_joined_at:r.enroller.joinedAt,location:r.location,release_sha256:r.releaseSha256,qualification_sha256:r.qualificationSha256,profile_sha256:r.profileSha256,source_commit:r.sourceCommit,closure_sha256:r.closureSha256,recipe_sha256:r.recipeSha256,transport:r.transport};}
/** @param {ImagePreparationEnrollmentRequest} r */
export function imagePreparationEnrollmentProjectIdentity(r){return r.projects.map(p=>({service_id:r.serviceId,company_id:r.companyId,project_id:p.projectId,project_revision:p.projectRevision,storage_binding_id:p.storageBindingId,storage_binding_revision:p.storageBindingRevision,storage_connection_id:p.storageConnectionId,storage_connection_revision:p.storageConnectionRevision,gateway_binding_id:p.gateway.bindingId,gateway_provision_id:p.gateway.provisionId,gateway_configuration_sha256:p.gateway.configurationSha256,gateway_origin:p.gateway.origin,gateway_expires_at:p.gateway.expiresAt})).sort((a,b)=>a.project_id.localeCompare(b.project_id));}
