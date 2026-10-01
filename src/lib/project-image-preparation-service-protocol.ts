/** Private finite metadata protocol. This contract conveys no database,
 * provider, object-key or ordinary user upload authority. Binary bytes use the
 * separately scoped gateway, never these JSON operations. */
import {isIP} from 'node:net';
import {z} from 'zod';
import {projectImagePreparationProcessorSchema,PROJECT_IMAGE_PREPARATION_STATUSES,PROJECT_IMAGE_PREPARATION_LIMITS as limits} from './project-image-preparations-protocol';

export const preparationServiceUuid=z.uuid().refine(value=>value===value.toLowerCase());
export const preparationServiceHash=z.string().regex(/^[a-f0-9]{64}$/);
export const preparationServiceDate=z.iso.datetime().refine(value=>new Date(value).toISOString()===value);
const uuid=preparationServiceUuid,sha=preparationServiceHash,date=preparationServiceDate;
const positive=z.number().int().positive(),etag=z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f,]+$/).refine(value=>value!=='*'&&!value.startsWith('W/'));
export const preparationServiceOrigin=z.string().max(512).refine(value=>{
 try{const u=new URL(value);return u.origin===value&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!isIP(u.hostname)&&u.hostname.includes('.')&&!u.hostname.endsWith('.localhost')&&u.hostname.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));}catch{return false;}
});
export const preparationServiceToken=z.string().regex(/^ips_[A-Za-z0-9_-]{43}$/);
export const preparationByteToken=z.string().regex(/^ipt_[A-Za-z0-9_-]{43}$/);
const imageType=z.enum(['image/png','image/jpeg','image/webp']);
const source=z.object({versionId:uuid,fileId:uuid,name:z.string().min(1).max(1024),version:positive,bytes:positive.max(limits.sourceMaxBytes),sha256:sha,contentType:imageType}).strict();
export const preparationServiceLeaseSchema=z.object({companyId:uuid,projectId:uuid,preparationId:uuid,leaseId:uuid,requestHash:sha,expiresAt:date,claimedAt:date,recipeSha256:sha,source,processor:projectImagePreparationProcessorSchema}).strict();
export const preparationServiceSourceSchema=source.pick({versionId:true,bytes:true,sha256:true,contentType:true}).extend({etag}).strict();
export const preparationServiceOutputSchema=z.object({fileId:uuid,versionId:uuid,uploadId:uuid,bytes:positive.max(limits.outputMaxBytes),sha256:sha,partBytes:z.literal(64*1024**2)}).strict();
export const preparationStoreOperationSchema=z.enum(['initiate','part','complete']);
const store={actionId:uuid,output:preparationServiceOutputSchema};
export const preparationStoreIntentSchema=z.object({...store,operation:preparationStoreOperationSchema}).strict();
export const preparationStoreReceiptSchema=z.discriminatedUnion('operation',[
 z.object({...store,operation:z.literal('initiate')}).strict(),
 z.object({...store,operation:z.literal('part'),partNumber:z.literal(1),bytes:positive.max(limits.outputMaxBytes),sha256:sha}).strict(),
 z.object({...store,operation:z.literal('complete'),etag}).strict()
]);
export const preparationTransformResultSchema=z.object({operation:z.literal('transform'),sourceVersionId:uuid,sourceSha256:sha,sourceBytes:positive.max(limits.sourceMaxBytes),source:z.object({format:z.enum(['png','jpeg','webp']),width:positive.max(limits.sourceMaxDimension),height:positive.max(limits.sourceMaxDimension),orientation:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.literal(7),z.literal(8)])}).strict(),recipeSha256:sha,processor:projectImagePreparationProcessorSchema,output:z.object({sha256:sha,bytes:positive.max(limits.outputMaxBytes),width:positive.max(limits.outputMaxDimension),height:positive.max(limits.outputMaxDimension),format:z.literal('png'),pixelFormat:z.literal('rgba8'),metadataRemoved:z.literal(true)}).strict()}).strict();
export const preparationPublicationSchema=z.object({bytes:positive.max(limits.outputMaxBytes),sha256:sha,etag,cleanupConfirmed:z.literal(true)}).strict();
export const preparationByteOperationSchema=z.enum(['read-source','initiate','part','complete','read-output']);
export type PreparationByteOperation=z.infer<typeof preparationByteOperationSchema>;
export const preparationByteCapabilitySchema=z.object({id:uuid,token:preparationByteToken,origin:preparationServiceOrigin,operation:preparationByteOperationSchema,preparationId:uuid,leaseId:uuid,requestHash:sha,versionId:uuid,bytes:positive.max(limits.sourceMaxBytes),sha256:sha,contentType:imageType,etag:etag.nullable(),actionId:uuid.nullable(),expiresAt:date}).strict().superRefine((value,ctx)=>{
 const read=value.operation==='read-source'||value.operation==='read-output';
 if(read?value.actionId!==null||value.etag===null:value.actionId===null||value.etag!==null)ctx.addIssue({code:'custom',message:'The byte operation requires its exact read or write identity.'});
 if(value.operation!=='read-source'&&(value.bytes>limits.outputMaxBytes||value.contentType!=='image/png'))ctx.addIssue({code:'custom',message:'Derivative transport accepts only bounded PNG bytes.'});
});
export type PreparationByteCapability=z.infer<typeof preparationByteCapabilitySchema>;

const request=z.object({requestId:uuid,deadlineAt:date}).strict(),bound=request.extend({preparationId:uuid,leaseId:uuid});
const byteRequest=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('read-source')}).strict(),z.object({operation:z.literal('read-output')}).strict(),
 z.object({operation:z.literal('initiate'),actionId:uuid}).strict(),z.object({operation:z.literal('part'),actionId:uuid}).strict(),z.object({operation:z.literal('complete'),actionId:uuid}).strict()
]);
export const PREPARATION_SERVICE_FAILURE_CODES=['IMAGE_PREPARATION_WORKER_UNAVAILABLE','IMAGE_PREPARATION_WORKER_POLICY_INVALID','IMAGE_PREPARATION_AUTHORITY_CHANGED','PREPARATION_TIMEOUT','PREPARATION_ABORTED','PREPARATION_BYTES_CHANGED','PREPARATION_OUTPUT_INVALID','PREPARATION_CLEANUP_FAILED','IMAGE_PREPARATION_STORAGE_UNCERTAIN','IMAGE_PREPARATION_STORED_BYTES_CHANGED','IMAGE_PREPARATION_WORKER_FAILED','PREPARATION_UNAVAILABLE','PREPARATION_INPUT_INVALID','PREPARATION_LIMIT_EXCEEDED','PREPARATION_DECODE_FAILED'] as const;
export const preparationServiceRequests={
 readiness:request,claim:request,authorize:bound,source:bound,
 'begin-transform':bound,
 'complete-transform':bound.extend({actionId:uuid,result:preparationTransformResultSchema}).strict(),
 'reserve-output':bound,
 'begin-store':bound.extend({operation:preparationStoreOperationSchema}).strict(),
 'complete-store':bound.extend({receipt:preparationStoreReceiptSchema}).strict(),
 'byte-capability':bound.extend({transfer:byteRequest}).strict(),
 publish:bound.extend({result:preparationPublicationSchema}).strict(),
 fail:bound.extend({code:z.enum(PREPARATION_SERVICE_FAILURE_CODES)}).strict()
} as const;
export type PreparationServiceOperation=keyof typeof preparationServiceRequests;
export const preparationServiceResponses={
 readiness:z.object({readiness:z.object({serviceId:uuid,companyId:uuid,projectIds:z.array(uuid).min(1).max(32).refine(values=>new Set(values).size===values.length),processor:projectImagePreparationProcessorSchema,expiresAt:date}).strict()}).strict(),
 claim:z.object({lease:preparationServiceLeaseSchema.nullable()}).strict(),
 authorize:z.object({authorized:z.literal(true)}).strict(),
 source:z.object({source:preparationServiceSourceSchema}).strict(),
 'begin-transform':z.object({actionId:uuid}).strict(),
 'complete-transform':z.object({ok:z.literal(true)}).strict(),
 'reserve-output':z.object({output:preparationServiceOutputSchema}).strict(),
 'begin-store':z.object({intent:preparationStoreIntentSchema}).strict(),
 'complete-store':z.object({ok:z.literal(true)}).strict(),
 'byte-capability':z.object({capability:preparationByteCapabilitySchema}).strict(),
 publish:z.object({status:z.literal('ready')}).strict(),
 fail:z.object({status:z.enum(PROJECT_IMAGE_PREPARATION_STATUSES)}).strict()
} as const;
export const PREPARATION_SERVICE_MAX_JSON_BYTES=65536;
export function preparationBytePath(capability:Pick<PreparationByteCapability,'id'|'operation'>){
 return `/v1/image-preparations/capabilities/${uuid.parse(capability.id)}/${preparationByteOperationSchema.parse(capability.operation)}`;
}
