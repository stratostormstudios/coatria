/** Browser-safe metadata contract. No native execution, credentials or byte transport. */
import {z} from 'zod';
import {projectStorageName} from './project-storage-protocol';

const uuid=z.string().uuid(),revision=z.number().int().positive(),sha=z.string().regex(/^[a-f0-9]{64}$/);
// The server checks these admission bounds against the versioned M1 policy.
export const PROJECT_IMAGE_PREPARATION_LIMITS=Object.freeze({sourceMaxBytes:32*1024**2,outputMaxBytes:10*1024**2,sourceMaxDimension:8192,sourceMaxPixels:32_000_000,outputMaxDimension:2048,maxApprovalMinutes:60,maxCostMicrousd:1_000_000,maxJobSeconds:120,maxTransformSeconds:30,maxAttempts:1,maxQueuedPerCompany:8});
export const PROJECT_IMAGE_PREPARATION_STATUSES=['proposed','queued','reading','transforming','validating','storing','verifying','ready','uncertain','blocked','failed','revoked'] as const;
export const PROJECT_IMAGE_PREPARATION_OPERATIONS=['claim','approve','revoke','read','transform','validate','allocation','store','store_initiate','store_part','store_complete','verify','publish','cleanup'] as const;
export const PROJECT_IMAGE_PREPARATION_PHASES=['intent','returned','uncertain','blocked','failed','revoked'] as const;
export const projectImagePreparationProposalInput=z.object({clientId:uuid,projectId:uuid,projectRevision:revision,workItemId:uuid,sourceVersionId:uuid,sourceSha256:sha,sourceBytes:z.number().int().positive().max(PROJECT_IMAGE_PREPARATION_LIMITS.sourceMaxBytes),destinationFolderId:uuid.nullable(),destinationName:projectStorageName.refine(name=>name.toLowerCase().endsWith('.png'),'Use a PNG derivative filename.'),purpose:z.string().trim().min(1).max(1000),continuation:z.literal('submitted_plan_v1').optional()}).strict();
export const projectImagePreparationApproveInput=z.object({clientId:uuid,revision,requestHash:sha,processorId:uuid,qualificationSha256:sha,expiresInMinutes:z.number().int().min(1).max(PROJECT_IMAGE_PREPARATION_LIMITS.maxApprovalMinutes),maxCostMicrousd:z.number().int().min(0).max(PROJECT_IMAGE_PREPARATION_LIMITS.maxCostMicrousd),processingConsent:z.literal(true),derivativeWriteConsent:z.literal(true),adoptionConsent:z.literal(true)}).strict();
export const projectImagePreparationRevokeInput=z.object({clientId:uuid,revision,note:z.string().trim().max(1000).default('')}).strict();
export const projectImagePreparationListInput=z.object({projectId:uuid,after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export const projectImagePreparationReferenceInput=z.object({clientId:uuid,revision,projectRevision:revision,workItemId:uuid,role:z.enum(['image','start_image','end_image']),purpose:z.string().trim().min(1).max(1000)}).strict();
/** Server-resolved qualification snapshot. A public input cannot assert this. */
export const projectImagePreparationProcessorSchema=z.object({id:uuid,location:z.string().trim().min(1).max(200),qualificationSha256:sha,releaseSha256:sha,profileSha256:sha,sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),closureSha256:sha,transport:z.enum(['linux_binary_v1','vercel_binary_v1']),recipeSha256:sha,expiresAt:z.string().datetime({offset:true})}).strict();
export type ProjectImagePreparationActor={companyId:string;userId:string;agentId?:string;runId?:string};
export type ProjectImagePreparationStatus=typeof PROJECT_IMAGE_PREPARATION_STATUSES[number];
export type ProjectImagePreparationOperation=typeof PROJECT_IMAGE_PREPARATION_OPERATIONS[number];
export type ProjectImagePreparationProcessor=z.infer<typeof projectImagePreparationProcessorSchema>;
export type ProjectImagePreparationAvailability={enabled:boolean;message:string;processor:ProjectImagePreparationProcessor|null};
export type ProjectImagePreparationSource={versionId:string;fileId:string;name:string;version:number;bytes:number;sha256:string;contentType:string};
/** Private storage facts. Never return physical object keys or ETags in public metadata. */
export type ProjectImagePreparationSourceSnapshot=ProjectImagePreparationSource&{objectKey:string;providerEtag:string};
export type ProjectImagePreparationApproval={approvedBy:string;approvedAt:string;expiresAt:string;approvalHash:string;processor:ProjectImagePreparationProcessor;maxCostMicrousd:number;processingConsent:true;derivativeWriteConsent:true;adoptionConsent:true};
export type ProjectImagePreparationTransformResult={sourceVersionId:string;sourceSha256:string;sourceBytes:number;source:{format:'png'|'jpeg'|'webp';width:number;height:number;orientation:1|2|3|4|5|6|7|8};recipeSha256:string;processor:ProjectImagePreparationProcessor;output:{sha256:string;bytes:number;width:number;height:number;format:'png';pixelFormat:'rgba8';metadataRemoved:true}};
export type ProjectImagePreparationDerivation={sourceVersionId:string;outputFileId:string;outputVersionId:string;uploadId:string;recipeSha256:string;sourceSha256:string;sourceBytes:number;outputSha256:string;outputBytes:number;outputWidth:number;outputHeight:number;receiptSha256:string;createdAt:string};
type ProjectImagePreparationFacts={id:string;projectId:string;workItemId:string;projectRevision:number;status:ProjectImagePreparationStatus;revision:number;requestHash:string;purpose:string;source:ProjectImagePreparationSource;destinationFolderId:string|null;destinationName:string;bindingId:string;bindingRevision:number;storageConnectionId:string;storageConnectionRevision:number;recipeSha256:string;proposedBy:string;proposedAgentId:string|null;createdAt:string;updatedAt:string;approval:ProjectImagePreparationApproval|null;attempt:number;claimedAt:string|null;cleanupConfirmedAt:string|null;revokedAt:string|null;diagnosticCode:string|null;derivation:ProjectImagePreparationDerivation|null};
export type ProjectImagePreparationDTO=ProjectImagePreparationFacts & {continuationMode:'exact_task_v1'|'submitted_plan_v1'};
export type ProjectImagePreparation=ProjectImagePreparationDTO;
export type ProjectImagePreparationPage={preparations:ProjectImagePreparationDTO[];hasMore:boolean;nextAfter:string|null};
/** Private service lease: never returned by public or ordinary agent routes. */
export type ProjectImagePreparationLease={companyId:string;projectId:string;preparationId:string;leaseId:string;requestHash:string;expiresAt:string;claimedAt:string;recipeSha256:string;source:ProjectImagePreparationSource;processor:ProjectImagePreparationProcessor};
