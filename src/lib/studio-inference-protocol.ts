import {z} from 'zod';
const leaseToken=z.string().min(20).max(200),requestId=z.string().uuid();
export const studioInferenceSubmitInput=z.object({leaseToken,requestId,step:z.number().int().min(0).max(19)}).strict();
export const studioInferenceCancelInput=z.object({leaseToken,requestId}).strict();
export const studioInferenceLeaseInput=z.object({leaseToken}).strict();
export const studioInferenceConfigInput=z.object({mode:z.literal('coatria_broker_v1'),maxJobs:z.number().int().min(1).max(100),maxHourlyMicrousd:z.number().int().min(1000).max(10000000),lifetimeAllowanceMicrousd:z.number().int().positive().max(20000000)}).strict();
export type StudioInferenceStatus='submitting'|'queued'|'running'|'succeeded'|'failed'|'uncertain'|'cancel_requested'|'cancelled'|'expired';
export type StudioInference={id:string;runId:string;step:number;status:StudioInferenceStatus;createdAt:string;deadlineAt:string;errorCode:string|null;reservedTokens:number;usedTokens:number|null;billingVerified:false;output?:Record<string,unknown>};
