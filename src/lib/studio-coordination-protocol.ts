import {z} from 'zod';
import {STUDIO_TEMPLATES} from './studio-protocol';

const uuid=z.string().uuid(),revision=z.number().int().min(1).max(2147483646);
export const studioCoordinationInput=z.object({
 clientId:uuid,revision:z.number().int().min(0).max(2147483646),coordinatorAgentId:uuid,
 allowedRoleKeys:z.array(z.string().refine(key=>STUDIO_TEMPLATES[0].roles.some(role=>role.key===key),'Choose a curated studio role.')).min(1).max(11).refine(keys=>new Set(keys).size===keys.length,'Roles must be unique.'),
 generatedContinuations:z.boolean().optional(),
 coordinatorGeneration:z.boolean().optional().describe('Explicit human-reviewed opt-in for a separate generation child on the coordinator identity, only for generated-media projects. Defaults to false. Does not permit nested delegation or spending.'),
 status:z.enum(['active','paused']),maxRuns:z.number().int().min(1).max(100),maxConcurrentRuns:z.number().int().min(1).max(3),expiresAt:z.string().datetime(),
}).strict();
export const studioCoordinationGetInput=z.object({projectId:uuid}).strict();
export const studioWorkDispatchInput=z.object({projectId:uuid,workItemId:uuid,policyRevision:revision,projectRevision:revision,executionJobId:uuid.optional()}).strict();
export type StudioCoordinationPolicy={generatedContinuations?:boolean;coordinatorGeneration?:boolean;projectId:string;coordinatorAgentId:string;allowedRoleKeys:string[];status:'active'|'paused';effectiveStatus:'active'|'paused'|'expired'|'approval_required'|'exhausted';blocker:string|null;revision:number;maxRuns:number;runsStarted:number;remainingRuns:number;maxConcurrentRuns:number;approvedBy:string;expiresAt:string;updatedAt:string;profileRevision:number};
export type StudioCoordinationDispatch={workItemId:string;parentRunId:string;childRunId:string;coordinatorAgentId:string;specialistAgentId:string;policyRevision:number;createdAt:string;status:string;executionJobId?:string|null;sourceChildRunId?:string|null;artifactId?:string|null;archiveId?:string|null};
export type StudioRenderFollowup={projectId:string;workItemId:string;executionJobId:string;sourceChildRunId:string;specialistAgentId:string;taskId:string;roleKey:string;executionManifestSha256:string;artifactId:string;artifactSha256:string};
export type StudioCoordinationSnapshot={policy:StudioCoordinationPolicy|null;dispatches:StudioCoordinationDispatch[];renderFollowups?:StudioRenderFollowup[];budgetUnit:'specialist_runs';budgetScope:'coordinator_dispatched_runs_only';startsWorkers:false;startsInference:false};
