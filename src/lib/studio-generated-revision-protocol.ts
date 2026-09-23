import {z} from 'zod';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),revision=z.number().int().min(1).max(2147483646);
const textBudget=(value:{summary:string;items:Array<{action:string;instructions?:string}>})=>new TextEncoder().encode(value.summary+value.items.map(item=>item.instructions??'').join('')).byteLength<=24576;
export const STUDIO_GENERATED_MAX_REVISION_ROUNDS=20;
export const studioGeneratedRevisionItemInput=z.discriminatedUnion('action',[
 z.object({unitId:uuid,action:z.literal('regenerate'),instructions:z.string().trim().min(1).max(4000)}).strict(),
 z.object({unitId:uuid,action:z.literal('carry')}).strict(),
]);
export const studioGeneratedRevisionDraftPlanInput=z.object({projectRevision:revision,shareId:uuid,receiptId:uuid,packageSha256:sha,summary:z.string().trim().min(1).max(4000),items:z.array(studioGeneratedRevisionItemInput).min(1).max(100)}).strict()
 .refine(v=>new Set(v.items.map(item=>item.unitId)).size===v.items.length,'Choose each deliverable exactly once.')
 .refine(v=>v.items.some(item=>item.action==='regenerate'),'A revision must regenerate at least one deliverable.')
 .refine(textBudget,'Keep the combined revision summary and correction instructions within 24 KiB.');
export const studioGeneratedRevisionDraftInput=studioGeneratedRevisionDraftPlanInput.safeExtend({clientId:uuid});
export const studioGeneratedRevisionApplyInput=z.object({clientId:uuid,projectRevision:revision,planSha256:sha}).strict();
export const studioGeneratedRevisionGetInput=z.object({planId:uuid.optional(),after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().refine(v=>!v.planId||!v.after,'Choose an exact plan or a page cursor.');

export const studioGeneratedRevisionBaseInput=z.object({artifactId:uuid,reviewId:uuid,storageVersionId:uuid,manifestSha256:sha,fileSha256:sha,generationWorkItemId:uuid,qcWorkItemId:uuid}).strict();
export const studioGeneratedRevisionSourceInput=z.object({shareId:uuid,receiptId:uuid,deliveryId:uuid,packageSha256:sha,sourceManifestSha256:sha,clientUserId:uuid,note:z.string().min(1).max(4000),roundId:uuid.nullable()}).strict();
const itemSnapshot=z.object({unitId:uuid,code:z.string().min(1).max(40),description:z.string().min(1).max(2000),mediaKind:z.enum(['image','video','audio']),base:studioGeneratedRevisionBaseInput,action:z.enum(['regenerate','carry']),instructions:z.string().max(4000)}).strict().refine(v=>v.action==='carry'?v.instructions==='':v.instructions.trim().length>0,'Only regenerated deliverables have new instructions.');
export const studioGeneratedRevisionSnapshotInput=z.object({schemaVersion:z.literal(1),projectId:uuid,projectRevision:revision,source:studioGeneratedRevisionSourceInput,summary:z.string().min(1).max(4000),items:z.array(itemSnapshot).min(1).max(100)}).strict().refine(v=>new Set(v.items.map(item=>item.unitId)).size===v.items.length&&v.items.some(item=>item.action==='regenerate'),'A complete revision has unique deliverables and changed work.');
export type StudioGeneratedRevisionBase=z.infer<typeof studioGeneratedRevisionBaseInput>;
export type StudioGeneratedRevisionSource=z.infer<typeof studioGeneratedRevisionSourceInput>;
export type StudioGeneratedRevisionPlan=z.infer<typeof studioGeneratedRevisionSnapshotInput>&{id:string;planSha256:string;createdBy:string;createdAgentId:string|null;createdAt:string;appliedRoundId:string|null};
export type StudioGeneratedRevisionRound={id:string;number:number;planId:string;planSha256:string;approvedBy:string;createdAt:string};
export type StudioGeneratedRevisionPlanSummary=Pick<StudioGeneratedRevisionPlan,'id'|'planSha256'|'createdBy'|'createdAgentId'|'createdAt'|'appliedRoundId'|'projectRevision'>&{summary:string;source:Pick<StudioGeneratedRevisionSource,'shareId'|'receiptId'|'deliveryId'|'packageSha256'|'roundId'>;changedCount:number;carryCount:number};
export type StudioGeneratedRevisionSourceDetail={source:StudioGeneratedRevisionSource;items:Array<Omit<StudioGeneratedRevisionPlan['items'][number],'action'|'instructions'>>};
export type StudioGeneratedRevisionSnapshot={projectRevision:number;currentRound:StudioGeneratedRevisionRound|null;source:StudioGeneratedRevisionSourceDetail|null;sourceBlockedReason:string|null;plan:StudioGeneratedRevisionPlan|null;plans:StudioGeneratedRevisionPlanSummary[];page:{hasMore:boolean;nextAfter:string|null;limit:number}};
