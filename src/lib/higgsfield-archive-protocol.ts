import {z} from 'zod';
import {projectStorageName} from './project-storage-protocol';

const uuid=z.string().uuid(),revision=z.number().int().positive(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const HIGGSFIELD_ARCHIVE_MAX_BYTES=100*1024**3;
export const HIGGSFIELD_ARCHIVE_STATUSES=['proposed','queued','fetching','uploading','verifying','verified','uncertain','blocked','cancelled','failed'] as const;
export const higgsfieldArchiveProposalInput=z.object({clientId:uuid,projectId:uuid,projectRevision:revision,jobId:uuid,outputId:uuid,outputIdentity:sha,bindingId:uuid,bindingRevision:revision,parentId:uuid.nullable().default(null),fileId:uuid.optional(),name:projectStorageName,maxBytes:z.number().int().min(1).max(HIGGSFIELD_ARCHIVE_MAX_BYTES)}).strict();
export const higgsfieldArchiveListInput=z.object({projectId:uuid,after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export const higgsfieldArchiveApproveInput=z.object({clientId:uuid,revision,requestHash:sha,projectRevision:revision,bindingRevision:revision,expiresInHours:z.number().int().min(1).max(24),archiveConsent:z.literal(true)}).strict();
export const higgsfieldArchiveRevokeInput=z.object({clientId:uuid,revision,note:z.string().trim().max(1000).default('')}).strict();
export type HiggsfieldArchiveActor={companyId:string;userId:string;agentId?:string;runId?:string};
export type HiggsfieldArchive={
 id:string;projectId:string;requestId:string;jobId:string;outputId:string;outputIdentity:string;kind:'image'|'video'|'audio';
 status:typeof HIGGSFIELD_ARCHIVE_STATUSES[number];revision:number;requestHash:string;
 projectRevision:number;bindingId:string;bindingRevision:number;storageConnectionId:string;storageConnectionRevision:number;
 destination:{parentId:string|null;fileId:string|null;name:string;ancestors:{id:string;name:string}[]};maxBytes:number;
 sourceAttribution:{requestedBy:string;agentId:string|null;runId:string|null;agentSponsorId:string|null;approvedBy:string};
 proposedBy:string;proposedAgentId:string|null;createdAt:string;approvedBy:string|null;approvedAt:string|null;expiresAt:string|null;revokedAt:string|null;
 approvedProjectRevision:number|null;approvedBindingRevision:number|null;uploadId:string|null;versionId:string|null;diagnosticCode:string|null;
 fetched:{bytes:number;sha256:string}|null;bytesVerified:boolean;
};
export type HiggsfieldArchivePage={archives:HiggsfieldArchive[];hasMore:boolean;nextAfter:string|null};
