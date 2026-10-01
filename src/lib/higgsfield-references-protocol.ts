import {z} from 'zod';
import type {HiggsfieldMediaDescriptor} from './higgsfield-media-inspection';

const uuid=z.string().uuid(),revision=z.number().int().positive(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const HIGGSFIELD_REFERENCE_POLICY=Object.freeze({version:1,maxBytes:10*1024**2,maxDimension:4096,maxPixels:16_000_000,maxApprovalMinutes:60});
export const HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES=Object.freeze(['creative.read','studio.read','studio.write','tasks.write','storage.read'] as const);
export const HIGGSFIELD_REFERENCE_GENERATION_CAPABILITIES=Object.freeze([...HIGGSFIELD_REFERENCE_PREPARATION_CAPABILITIES,'creative.write'] as const);
export const HIGGSFIELD_REFERENCE_INSPECTION_LIMITS=Object.freeze({version:1,maxMinutes:60,maxAttempts:3,maxProposalsPerWork:8});
export type HiggsfieldReferenceCoordinationAuthority={version:1;parentRunId:string;parentAttempt:number;parentStartedAt:string;coordinatorAgentId:string;coordinatorSponsorId:string;coordinatorCredentialSha256:string;coordinatorInstallation:{id:string;revision:number};policyRevision:number;approvedBy:string;expiresAt:string;authoritySha256:string};
/** Private, server-derived authority. Never expose the credential fingerprint. */
export type HiggsfieldReferenceInspectionAuthority={version:1;mode:'prepared_image_v1';companyId:string;projectId:string;workItemId:string;runId:string;agentId:string;requestedBy:string;agentSponsorId:string;credentialSha256:string;installation:{id:string;revision:number}|null;startedAt:string;attempt:1;expiresAt:string;coordination?:HiggsfieldReferenceCoordinationAuthority};
export const HIGGSFIELD_REFERENCE_ROLES=['image','start_image','end_image'] as const;
export const HIGGSFIELD_REFERENCE_STATUSES=['proposed','inspecting','awaiting_approval','queued','reading','allocating','allocated','uploading','uploaded','confirming','confirmed','uncertain','blocked','failed','revoked'] as const;
export const higgsfieldReferenceProposalInput=z.object({clientId:uuid,projectId:uuid,projectRevision:revision,workItemId:uuid,proxyVersionId:uuid,proxySha256:sha,proxyBytes:z.number().int().positive().max(HIGGSFIELD_REFERENCE_POLICY.maxBytes),sourceVersionId:uuid.optional(),role:z.enum(HIGGSFIELD_REFERENCE_ROLES),purpose:z.string().trim().min(1).max(1000)}).strict().refine(v=>v.sourceVersionId!==v.proxyVersionId,'The linked original must be a distinct version from the prepared proxy.');
export const higgsfieldReferenceListInput=z.object({projectId:uuid,after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export const higgsfieldReferenceCandidatesInput=z.object({projectId:uuid,fileId:uuid.optional(),after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export const higgsfieldReferenceApproveInput=z.object({clientId:uuid,revision,requestHash:sha,inspectionHash:sha,expiresInMinutes:z.number().int().min(1).max(60),referenceSharingConsent:z.literal(true),preparedProxyConsent:z.literal(true),rightsConsent:z.literal(true),allBytesConsent:z.literal(true)}).strict();
export const higgsfieldReferenceRevokeInput=z.object({clientId:uuid,revision,note:z.string().trim().max(1000).default('')}).strict();
export const referenceGenerationInspectionAdoptInput=z.object({clientId:uuid,referenceRevision:revision,requestHash:sha,handoffSha256:sha,expiresInMinutes:z.number().int().min(1).max(60),inspectionConsent:z.literal(true)}).strict();
export type HiggsfieldReferenceActor={companyId:string;userId:string;agentId?:string;runId?:string};
export type HiggsfieldReferenceVersion={versionId:string;fileId:string;name:string;version:number;bytes:number;sha256:string;contentType:string};
export type HiggsfieldReferenceInspection={descriptor:Extract<HiggsfieldMediaDescriptor,{kind:'image'}>;profileSha256:string;inspectionHash:string;inspectedAt:string};
export type HiggsfieldReferenceAvailability={enabled:boolean;code:string;message:string;expiresAt:string|null;qualificationSha256:string|null;catalogSha256:string|null};
export type HiggsfieldReference={
 referenceGenerationHandoff?:{id:string;handoffSha256:string;inspectionAdoption:null|{id:string;approvedBy:string;approvedAt:string;expiresAt:string;approvalHash:string;maximumAttempts:1}};
 id:string;projectId:string;workItemId:string;projectRevision:number;taskRevision:number;role:typeof HIGGSFIELD_REFERENCE_ROLES[number];purpose:string;
 status:typeof HIGGSFIELD_REFERENCE_STATUSES[number];revision:number;requestHash:string;proxy:HiggsfieldReferenceVersion;source:HiggsfieldReferenceVersion|null;
 storageConnectionId:string;storageConnectionRevision:number;bindingId:string;bindingRevision:number;providerConnectionId:string;providerConnectionRevision:number;
 inspection:HiggsfieldReferenceInspection|null;proposedBy:string;proposedAgentId:string|null;createdAt:string;approvedBy:string|null;approvedAt:string|null;expiresAt:string|null;approvalHash:string|null;revokedAt:string|null;diagnosticCode:string|null;
 providerConfirmed:boolean;originalUploaded:false;bytesSharedUnchanged:true;metadataRemoved:false;
 inspectionAuthorityMode?:'live_run'|'prepared_image_v1'|'adopted_generation_v1';inspectionExpiresAt?:string;inspectionAttempts?:number;
 preparation?:{id:string;sourceVersionId:string;outputVersionId:string;recipeSha256:string;receiptSha256:string;metadataRemoved:true;outputWidth:number;outputHeight:number};
};
export type HiggsfieldReferencePage={references:HiggsfieldReference[];hasMore:boolean;nextAfter:string|null};
export type HiggsfieldReferenceCandidatePage={versions:HiggsfieldReferenceVersion[];hasMore:boolean;nextAfter:string|null};
/** Private trusted-worker envelope. Never return the lease through session or agent APIs. */
export type HiggsfieldReferenceLease={companyId:string;projectId:string;referenceId:string;leaseId:string;requestHash:string;phase:'inspect'|'transfer';expiresAt:string;proxy:HiggsfieldReferenceVersion;role:typeof HIGGSFIELD_REFERENCE_ROLES[number];inspection:HiggsfieldReferenceInspection|null};
export type HiggsfieldReferencePhase='allocate'|'put'|'confirm';
export type HiggsfieldReferenceAllocation={mediaId:string;uploadUrl:string;expiresAt:string};
export type HiggsfieldReferencePhaseResult={phase:'allocate';allocation:HiggsfieldReferenceAllocation}|{phase:'put';bytes:number;sha256:string;httpStatus:200}|{phase:'confirm';mediaId:string;confirmed:true};
/** Internal generation binding. Provider IDs are resolved only from confirmed records. */
export type HiggsfieldReferenceSnapshot={version:1;companyId:string;projectId:string;workItemId:string;references:Array<{referenceId:string;requestHash:string;approvalHash:string;inspectionHash:string;role:typeof HIGGSFIELD_REFERENCE_ROLES[number];mediaId:string;proxyVersionId:string;sha256:string;bytes:number;providerConnectionId:string;providerConnectionRevision:number}>};
export type HiggsfieldReferenceResolution={referenceIds:string[];medias:Array<{role:typeof HIGGSFIELD_REFERENCE_ROLES[number];value:string}>;snapshot:HiggsfieldReferenceSnapshot;snapshotHash:string};
