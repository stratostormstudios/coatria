import {z} from 'zod';

export const studioCreativeFollowupInput=z.object({
 clientId:z.string().uuid(),revision:z.number().int().positive(),workItemId:z.string().uuid(),requestId:z.string().uuid(),artifactId:z.string().uuid(),
 outputAttestation:z.literal(true).describe('A current administrator has checked that the selected existing output is the actual result of this exact approved Higgsfield request. This is a human provenance attestation, not server media verification or final QC.'),
 note:z.string().trim().min(1).max(2000),
}).strict();
export type StudioCreativeFollowupCandidate={workItemId:string;requestId:string;artifactId:string;sourceRunId:string};
export type StudioCreativeFollowupSnapshot={candidates:StudioCreativeFollowupCandidate[];requiresHumanOutputAttestation:true;automaticContinuation:false};
export type StudioCreativeFollowupReceipt={version:1;runId:string;projectId:string;workItemId:string;taskId:string;requestId:string;requestHash:string;artifactId:string;artifactSha256:string;sourceRunId:string;agentId:string;taskRevision:number;projectRevision:number;attestedBy:string;attestedAt:string;note:string;provenance:'human_attested';providerOutputVerified:false;mediaBytesVerified:false;mediaQcApproved:false;maxAttempts:1};
