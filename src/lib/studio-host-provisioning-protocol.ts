import {z} from 'zod';

const uuid=z.string().uuid(),revision=z.number().int().positive();
export const studioHostProvisionPlanInput=z.object({clientId:uuid,durationMinutes:z.union([z.literal(15),z.literal(20),z.literal(30),z.literal(60)]).default(20),installations:z.array(z.object({installationId:uuid,revision}).strict()).min(1).max(11).refine(items=>new Set(items.map(item=>item.installationId)).size===items.length,'Choose each installation once.')}).strict();
export const studioHostProvisionStartInput=z.object({clientId:uuid,revision,planHash:z.string().regex(/^[a-f0-9]{64}$/),acknowledgeCharges:z.literal(true),activateAgents:z.literal(true)}).strict();
export const studioHostProvisionStopInput=z.object({clientId:uuid,revision}).strict();
export type StudioHostProvisionPhase='planned'|'approved'|'submitting'|'uncertain'|'provisioning'|'running'|'stopping'|'stopped'|'failed'|'needs_attention';
export type StudioHostProvisionReadiness={ready:boolean;reasons:string[]};
export type StudioHostProvisionPlan={
 version:1;companyId:string;durationMinutes:number;reviewExpiresAt:string;
 installations:Array<{installationId:string;revision:number;agentId:string;name:string;pluginId:string;manifestVersion:string;capabilities:string[];invocationAccess:string;conversationAccess:unknown;runtimeConfig:Record<string,unknown>;character:Record<string,unknown>}>;
 preset:{id:string;hash:string;releaseCommit:string;bootstrapHash:string;image:string;cpuTypeId:'cpu3c';vcpuCount:2;memoryGb:4;dataCenterId:string;volumeId:string;concurrency:1;modelId:string;maxHourlyMicrousd:number};
 reservation:{cpuMicrousd:number;companyLifetimeAllowanceMicrousd:number;previouslyReservedMicrousd:number;inferenceIncluded:false;storageIncluded:false;billingCapGuaranteed:false};
 effects:{activateAgents:true;rotateCredentials:true;cancelPreviousRuns:true;startCpu:true;startGpu:false;independentHumanReviewPreserved:true};
};
export type StudioHostProvision={id:string;companyId:string;revision:number;phase:StudioHostProvisionPhase;planHash:string;plan:StudioHostProvisionPlan;hostId:string|null;podId:string|null;providerStatus:string|null;expiresAt:string|null;stopRequestedAt:string|null;submittedAt:string|null;lastReconciledAt:string|null;createdAt:string;errorCode:string|null;readiness:StudioHostProvisionReadiness;computeStopped:boolean;credentialsRevoked:false;billingVerified:false};
