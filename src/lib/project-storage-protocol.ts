import {z} from 'zod';

/** Fixed official Runpod S3 regions; a connection cannot supply a destination URL. */
export const RUNPOD_STORAGE_REGIONS=['EU-CZ-1','EU-RO-1','EUR-IS-1','EUR-NO-1','US-CA-2','US-GA-2','US-IL-1','US-KS-2','US-MD-1','US-MO-1','US-MO-2','US-NC-1','US-NC-2','US-NE-1','US-WA-1'] as const;
export type RunpodStorageRegion=typeof RUNPOD_STORAGE_REGIONS[number];
export function runpodStorageEndpoint(region:RunpodStorageRegion){if(!RUNPOD_STORAGE_REGIONS.includes(region))throw new Error('Unsupported Runpod storage region.');return `https://s3api-${region.toLowerCase()}.runpod.io`;}
export const PROJECT_STORAGE_CAPABILITIES=['storage.read','storage.write','storage.organize'] as const;
export const PROJECT_STORAGE_MAX_FOLDERS=5000;
export const PROJECT_STORAGE_MAX_PLAN_FOLDERS=200;
const uuid=z.string().uuid(),revision=z.number().int().min(0),clientId=uuid;
export const projectStorageName=z.string().trim().min(1).max(160).regex(/^[^\\/\x00-\x1f\x7f:]+$/).refine(value=>value!=='.'&&value!=='..'&&!/[. ]$/.test(value)&&value===value.normalize('NFC'),'Use a normalized name without separators, control characters, or a trailing dot.');
export const projectStoragePath=z.string().min(1).max(2048).refine(value=>value.split('/').length<=12&&value.split('/').every(part=>projectStorageName.safeParse(part).success&&part===part.trim()),'Use a relative path with at most 12 normalized named folders.');
export const projectStorageConnectionInput=z.object({clientId,name:projectStorageName,region:z.enum(RUNPOD_STORAGE_REGIONS),volumeId:z.string().min(4).max(64).regex(/^[a-z0-9-]+$/),accessKeyId:z.string().regex(/^user_[a-zA-Z0-9_-]{4,160}$/),secretAccessKey:z.string().regex(/^rps_[a-zA-Z0-9_-]{8,256}$/)}).strict();
export const projectStorageConnectionRevokeInput=z.object({clientId,revision:z.number().int().min(1),status:z.literal('revoked')}).strict();
export const projectStorageBindingInput=z.object({clientId,revision,connectionId:uuid}).strict();
export const projectStorageListInput=z.object({parentId:uuid.nullable().optional(),after:uuid.optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const projectStoragePlanListInput=z.object({after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const projectStorageFolderInput=z.object({clientId,revision:z.number().int().min(1),parentId:uuid.nullable().default(null),name:projectStorageName}).strict();
export const projectStorageFolderUpdateInput=projectStorageFolderInput;
export const projectStorageFolderPlanInput=z.object({clientId,revision:z.number().int().min(1),paths:z.array(projectStoragePath).min(1).max(PROJECT_STORAGE_MAX_PLAN_FOLDERS)}).strict();
export const projectStorageFolderPlanApplyInput=z.object({clientId,revision:z.number().int().min(1),planHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const projectStorageUploadInput=z.object({clientId,revision:z.number().int().min(1),parentId:uuid.nullable().default(null),name:projectStorageName,fileId:uuid.optional(),bytes:z.number().int().min(1).max(100*1024**3),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),contentType:z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/)}).strict();
export const projectStorageAccessInput=z.object({clientId,disposition:z.enum(['inline','attachment']).default('attachment')}).strict();
export type ProjectStorageActor={companyId:string;userId:string;agentId?:string;runId?:string};
export type ProjectStorageConnection={id:string;name:string;provider:'runpod';region:RunpodStorageRegion;volumeId:string;status:'configured'|'revoked';revision:number;createdAt:string;credentialsConfigured:boolean;providerVerified:false};
export type ProjectStorageBinding={id:string;projectId:string;connectionId:string;revision:number;createdAt:string;connection:ProjectStorageConnection};
export type ProjectStorageTransferAvailability={available:false;code:'STORAGE_GATEWAY_UNAVAILABLE';message:string}|{available:true;gatewayOrigin:string;maxFileBytes:number;partBytes:number};
export type ProjectStorageFolder={kind:'folder';id:string;parentId:string|null;name:string;createdAt:string};
export type ProjectStorageFile={kind:'file';id:string;parentId:string|null;name:string;createdAt:string;latestVersion:null|{id:string;version:number;bytes:number;sha256:string|null;contentType:string;verified:boolean}};
export type ProjectStorageListing={binding:ProjectStorageBinding|null;items:(ProjectStorageFolder|ProjectStorageFile)[];breadcrumbs:{id:string;name:string}[];page:{limit:number;hasMore:boolean;nextAfter:string|null};transfers:ProjectStorageTransferAvailability};
export type ProjectStorageFolderPlan={id:string;projectId:string;bindingId:string;bindingRevision:number;planHash:string;folders:{path:string;exists:boolean}[];createdAt:string;expiresAt:string;createsFolderCount:number;applied:boolean};
export type ProjectStorageFolderPlanSummary=Omit<ProjectStorageFolderPlan,'folders'>;
