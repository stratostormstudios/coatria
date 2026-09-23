import {z} from 'zod';
const uuid=z.string().uuid(),revision=z.number().int().min(1).max(2147483646);
export const studioGeneratedFollowupGetInput=z.object({projectId:uuid,archiveId:uuid.optional(),after:uuid.optional(),historyAfter:uuid.optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const studioGeneratedFollowupDispatchInput=z.object({projectId:uuid,workItemId:uuid,archiveId:uuid,projectRevision:revision,policyRevision:revision}).strict();
/** Harness transport IDs are independent of the immutable inner operation IDs.
 * Every step uses the source, revisions and reviewed metadata pinned by the server. */
export const studioGeneratedFollowupAdvanceInput=z.object({projectId:uuid,workItemId:uuid,step:z.enum(['claim','register','submit'])}).strict();
export type StudioGeneratedFollowupStep=z.infer<typeof studioGeneratedFollowupAdvanceInput>['step'];
