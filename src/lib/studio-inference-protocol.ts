import {z} from 'zod';
const leaseToken=z.string().min(20).max(200),requestId=z.string().uuid();
export const studioInferenceSubmitInput=z.object({leaseToken,requestId,step:z.number().int().min(0).max(19),protocolVersion:z.literal(2).optional()}).strict();
export const studioInferenceCancelInput=z.object({leaseToken,requestId}).strict();
export const studioInferenceLeaseInput=z.object({leaseToken}).strict();
export const studioInferenceConfigInput=z.object({mode:z.literal('coatria_broker_v1'),maxJobs:z.number().int().min(1).max(100),maxHourlyMicrousd:z.number().int().min(1000).max(10000000),lifetimeAllowanceMicrousd:z.number().int().positive().max(20000000)}).strict();
export type StudioInferenceStatus='submitting'|'queued'|'running'|'succeeded'|'failed'|'uncertain'|'cancel_requested'|'cancelled'|'expired';
export type StudioInferenceValidationResponse={version:1;executed:false;code:'ARGUMENT_JSON_INVALID'|'ARGUMENT_SCHEMA_INVALID'|'STAFFING_VALIDATION_INVALID'|'BATCH_NOT_EXECUTED';issues:Array<{path:string[];code:string;expected?:string;allowed?:string[];minimum?:number;maximum?:number}>};
export type StudioInference={id:string;runId:string;step:number;status:StudioInferenceStatus;createdAt:string;deadlineAt:string;errorCode:string|null;reservedTokens:number;usedTokens:number|null;billingVerified:false;output?:Record<string,unknown>;protocolVersion?:2;disposition?:'execute'|'validation_feedback';usage?:{promptTokens:number;completionTokens:number;totalTokens:number};validationFeedback?:{version:1;correction:number;calls:Array<{id:string;name:string;requestId:string;response:StudioInferenceValidationResponse}>}};
