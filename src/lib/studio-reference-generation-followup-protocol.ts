import {z} from 'zod';
import {higgsfieldProposalInput} from './higgsfield-protocol';
const uuid=z.string().uuid(),revision=z.number().int().min(1).max(2147483646);
export const studioReferenceGenerationFollowupGetInput=z.object({projectId:uuid,referenceId:uuid.optional(),after:uuid.optional(),historyAfter:uuid.optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const studioReferenceGenerationFollowupDispatchInput=z.object({projectId:uuid,workItemId:uuid,referenceId:uuid,projectRevision:revision,policyRevision:revision}).strict();
const scope={projectId:uuid,workItemId:uuid};
export const studioReferenceGenerationFollowupAdvanceInput=z.discriminatedUnion('step',[
 z.object({...scope,step:z.literal('claim')}).strict(),
 z.object({...scope,step:z.literal('proposal'),proposal:higgsfieldProposalInput.pick({tool:true,arguments:true,note:true})}).strict(),
]);
export type StudioReferenceGenerationFollowupContext={projectId:string;workItemId:string;taskId:string;referenceId:string;handoffSha256:string;requestId:string|null;nextStep:'claim'|'proposal'|'proposed';advanceTool:'studio_reference_generation_followup_advance';serverOwnsOperationIds:true;contentInspected:false;canGenerate:false;canTransfer:false;canApprove:false};
