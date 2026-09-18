import {z} from 'zod';

const uuid=z.string().uuid(),text=(max:number)=>z.string().trim().min(1).max(max);
export const HIGGSFIELD_REPORTED_STATUSES=['pending','waiting','queued','dna','script','visuals','vision','flow','in_progress','ip_detect','completed','canceled','failed','nsfw','ip_detected','lookup_failed'] as const;
export const HIGGSFIELD_RECEIPT_TOOLS=['generate_image','generate_image_batch','generate_video','generate_video_batch','generate_audio','generate_audio_batch','execute_preset','jobs_wait','job_display'] as const;
const mediaKind=z.enum(['image','video','audio','3d']);
const role=z.enum(['image','start_image','end_image','video','audio','ref_element']);
/** Stored navigation metadata only. Signed links and private filesystem locations
 * are deliberately not persisted in immutable company receipts. Never fetched. */
export const creativePublicUrl=z.string().url().max(2048).refine(value=>{
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.port&&u.hostname.includes('.')&&!u.hostname.includes(':')&&!/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)&&!u.hostname.endsWith('.local');}catch{return false;}
},'Use an unsigned public HTTPS reference without credentials, parameters, fragments or local network addresses.');
export const studioCreativeReference=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('generation'),generationId:uuid,role}).strict(),
 z.object({kind:z.literal('storage'),storageReferenceId:uuid,role}).strict(),
 z.object({kind:z.literal('higgsfield_media'),mediaId:uuid,role}).strict(),
]);
const output=z.object({kind:mediaKind,mediaId:uuid.optional(),url:creativePublicUrl.optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),bytes:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),width:z.number().int().min(1).max(32768).optional(),height:z.number().int().min(1).max(32768).optional(),durationMilliseconds:z.number().int().min(1).max(86400000).optional()}).strict().refine(value=>Boolean(value.mediaId||value.url),'An output requires a returned media ID or unsigned URL.');
export const studioGenerationImportPlanInput=z.object({
 revision:z.number().int().min(1),workItemId:uuid.nullable().default(null),providerJobId:uuid,kind:mediaKind,
 model:text(160),prompt:z.string().trim().max(12000).default(''),references:z.array(studioCreativeReference).max(20).default([]),
 sourceTool:z.enum(HIGGSFIELD_RECEIPT_TOOLS),observedStatus:z.enum(HIGGSFIELD_REPORTED_STATUSES),observedAt:z.iso.datetime({offset:true}),
 outputs:z.array(output).max(8).default([]),note:z.string().trim().max(2000).default(''),
}).strict().refine(value=>new Set(value.references.map(reference=>JSON.stringify(reference))).size===value.references.length,'Reference bindings must be unique.')
 .refine(value=>value.observedStatus==='completed'||value.outputs.length===0,'Only a reported completed job may include output references.');
export const studioGenerationImportInput=studioGenerationImportPlanInput.safeExtend({clientId:uuid});
export const creativeStoragePath=z.string().min(1).max(1024).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!/^[a-zA-Z]:/.test(value)&&!/[\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Use an indexed relative path with forward slashes and no traversal.');
export const studioStorageReferencePlanInput=z.object({revision:z.number().int().min(1),workItemId:uuid.nullable().default(null),driveId:uuid,path:creativeStoragePath,expectedBytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),expectedModifiedAt:z.iso.datetime({offset:true}),name:text(160),purpose:z.enum(['source','reference','output','archive']).default('reference')}).strict();
export const studioStorageReferenceInput=studioStorageReferencePlanInput.extend({clientId:uuid});
export const studioCreativeListInput=z.object({after:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict();
export type StudioGenerationReference=z.infer<typeof studioCreativeReference>;
export type StudioCreativeActor={companyId:string;userId:string;agentId?:string;runId?:string;agentSponsorId?:string};
export type StudioGenerationReceipt={id:string;generationId:string;sourceTool:string;observedStatus:string;observedAt:string;outputs:z.infer<typeof output>[];note:string;importedBy:string;importedAgentId:string|null;runId:string|null;receivedAt:string;evidenceSource:'imported_report';providerVerified:false;bytesVerified:false;independentlyReviewed:false};
export type StudioGeneration={id:string;projectId:string;workItemId:string|null;provider:'higgsfield';providerJobId:string;kind:string;model:string;prompt:string;references:StudioGenerationReference[];createdAt:string;latestReceipt:StudioGenerationReceipt|null};
export type StudioStorageReference={id:string;projectId:string;workItemId:string|null;driveId:string;driveName:string;path:string;bytes:number;modifiedAt:string;indexedAt:string;name:string;purpose:string;createdAt:string;indexState:'unchanged'|'changed'|'missing'|'revoked';verificationSource:'metadata_only';bytesVerified:false;fileAccessGranted:false;uploadedToHiggsfield:false};
