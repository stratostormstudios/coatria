/** Immutable operator enrollment request. No IO, credentials or activation. */
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';

export class ReferenceEnrollmentError extends Error {
 constructor(code){super(code);this.name='ReferenceEnrollmentError';this.code=code;}
}
/** @param {string} [code] @returns {never} */
export function referenceEnrollmentFailure(code='REFERENCE_ENROLLMENT_INVALID'){throw new ReferenceEnrollmentError(code);}
const uuid=z.uuid().refine(value=>value===value.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),revision=z.number().int().positive().max(2147483647),date=z.iso.datetime().refine(value=>new Date(value).toISOString()===value);
const host=z.string().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/).refine(value=>!isIP(value)&&!value.endsWith('.localhost')&&value.split('.').every(part=>part.length<=63));
const origin=z.string().max(512).refine(value=>{try{const u=new URL(value);return u.origin===value&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&host.safeParse(u.hostname).success;}catch{return false;}});
const project=z.object({projectId:uuid,projectRevision:revision,storageBindingId:uuid,storageBindingRevision:revision,storageConnectionId:uuid,storageConnectionRevision:revision}).strict();
const qualification=z.object({sourceCommit:commit,sourceTree:commit,bundleSha256:hash,hostConfigurationSha256:hash,configurationSha256:hash,qualifierSha256:hash,conformanceProfileSha256:hash,bootId:uuid,uid:revision,gid:revision,qualifierInvocationId:z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/),evidenceSha256:hash,reportSha256:hash,acceptedAt:date}).strict();
export const referenceEnrollmentRequestSchema=z.object({version:z.literal(1),requestId:uuid,serviceId:uuid,companyId:uuid,enrolledBy:uuid,tokenHash:hash,origin,releaseSha256:hash,qualificationSha256:hash,profileSha256:hash,expiresAt:date,uploadHosts:z.array(host).min(1).max(8).refine(values=>new Set(values).size===values.length),provider:z.object({connectionId:uuid,connectionRevision:revision,catalogSha256:hash}).strict(),projects:z.array(project).min(1).max(32).refine(values=>new Set(values.map(item=>item.projectId)).size===values.length),qualification}).strict();
/** @typedef {z.infer<typeof referenceEnrollmentRequestSchema>} ReferenceEnrollmentRequest */

/** Historical reconciliation never extends an expired request.
 * @param {unknown} value
 * @param {{allowExpired?:boolean,now?:number}} [options]
 * @returns {ReferenceEnrollmentRequest} */
export function parseReferenceEnrollmentRequest(value,{allowExpired=false,now=Date.now()}={}){
 const parsed=referenceEnrollmentRequestSchema.safeParse(value);if(!parsed.success||!Number.isSafeInteger(now))referenceEnrollmentFailure();
 const request=parsed.data,expiry=Date.parse(request.expiresAt),accepted=Date.parse(request.qualification.acceptedAt);
 if(Buffer.byteLength(JSON.stringify(request))>65536||accepted>now||expiry<=accepted||expiry-accepted>3600000)referenceEnrollmentFailure();
 if(!allowExpired&&(expiry<=now||expiry-now>3600000))referenceEnrollmentFailure('REFERENCE_ENROLLMENT_EXPIRED');
 const connections=new Map();for(const item of request.projects){if(connections.has(item.storageConnectionId)&&connections.get(item.storageConnectionId)!==item.storageConnectionRevision)referenceEnrollmentFailure();connections.set(item.storageConnectionId,item.storageConnectionRevision);}
 return request;
}
/** @param {any} value @returns {string} */
export const referenceEnrollmentCanonical=value=>Array.isArray(value)?'['+value.map(referenceEnrollmentCanonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+referenceEnrollmentCanonical(item)).join(',')+'}':JSON.stringify(value);
export const referenceEnrollmentHash=value=>createHash('sha256').update('coatria-reference-enrollment-v1\0'+referenceEnrollmentCanonical(value)).digest('hex');
export const referenceEnrollmentCatalogHash=value=>createHash('sha256').update(referenceEnrollmentCanonical(value)).digest('hex');
/** @param {Pick<ReferenceEnrollmentRequest,'companyId'|'serviceId'>} request */
export const referenceEnrollmentLockKey=request=>'reference-enrollment:'+request.companyId+':'+request.serviceId;
/** @param {ReferenceEnrollmentRequest} request */
export function referenceEnrollmentServiceIdentity(request){return {id:request.serviceId,company_id:request.companyId,token_hash:request.tokenHash,enrolled_by:request.enrolledBy,release_sha256:request.releaseSha256,qualification_sha256:request.qualificationSha256,profile_sha256:request.profileSha256,provider_connection_id:request.provider.connectionId,provider_connection_revision:request.provider.connectionRevision,catalog_sha256:request.provider.catalogSha256};}
/** @param {ReferenceEnrollmentRequest} request */
export function referenceEnrollmentProjectIdentity(request){return request.projects.map(p=>({service_id:request.serviceId,company_id:request.companyId,project_id:p.projectId,storage_binding_id:p.storageBindingId,storage_binding_revision:p.storageBindingRevision,storage_connection_id:p.storageConnectionId,storage_connection_revision:p.storageConnectionRevision})).sort((a,b)=>a.project_id.localeCompare(b.project_id));}
