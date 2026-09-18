import {z} from 'zod';
import {executionStorageKey} from './studio-execution-protocol';

export const STUDIO_MEDIA_MAX_FILE_BYTES=20*1024*1024;
export const STUDIO_MEDIA_UPLOAD_SECONDS=300;
export const STUDIO_MEDIA_READ_SECONDS=60;
export const studioMediaUploadInput=z.object({clientId:z.string().uuid(),path:executionStorageKey}).strict();
export const studioMediaVerifyInput=z.object({clientId:z.string().uuid(),fileId:z.string().uuid()}).strict();
export const studioMediaPromoteInput=z.object({clientId:z.string().uuid(),revision:z.number().int().min(1),name:z.string().trim().min(1).max(160)}).strict();
export const studioMediaListInput=z.object({jobId:z.string().uuid(),after:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict();
