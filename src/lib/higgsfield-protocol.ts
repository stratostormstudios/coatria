import {z} from 'zod';

export const HIGGSFIELD_GENERATION_TOOLS=['generate_image','generate_video','generate_audio'] as const;
export const HIGGSFIELD_READ_TOOLS=['balance','models_explore','models_list','models_get','models_search','models_recommend','estimate_image_cost','estimate_video_cost','jobs_wait','list_workspaces'] as const;
const args=z.record(z.string().max(120),z.unknown()).refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=24000,'Use a generation request smaller than 24 KB.');
export const higgsfieldProposalInput=z.object({clientId:z.string().uuid(),projectId:z.string().uuid(),projectRevision:z.number().int().positive(),workItemId:z.string().uuid().optional().describe('Exact generation task; required for Higgsfield projects and agent proposals. Its revision and assignment are pinned by the server.'),tool:z.enum(HIGGSFIELD_GENERATION_TOOLS),arguments:args,note:z.string().trim().min(1).max(2000)}).strict();
export const higgsfieldReadInput=z.object({tool:z.enum(HIGGSFIELD_READ_TOOLS),arguments:args.default({})}).strict();
export const higgsfieldExecuteInput=z.object({requestHash:z.string().regex(/^[a-f0-9]{64}$/),creditConsent:z.literal(true)}).strict();
export const higgsfieldEstimateInput=z.object({requestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type HiggsfieldConnection={status:'disconnected'|'connected'|'reconnect_required';revision:number;connectedAt?:string;expiresAt?:string;officialEndpoint:string;toolCount:number;tools:{name:string;description:string;inputSchema:Record<string,unknown>;outputSchema?:Record<string,unknown>}[]};
export type HiggsfieldRequest={id:string;projectId:string;workItemId?:string|null;taskRevision?:number|null;tool:string;arguments:Record<string,unknown>;note:string;requestHash:string;status:'proposed'|'dispatching'|'returned'|'uncertain'|'rejected';createdAt:string;result?:unknown;errorCode?:string|null};
