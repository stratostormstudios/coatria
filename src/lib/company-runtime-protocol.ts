import {z} from 'zod';

export const companyRuntimeKind=z.enum(['managed_agent','archive','gateway']);
export type CompanyRuntimeKind=z.infer<typeof companyRuntimeKind>;
export const companyRuntimeSelectInput=z.object({
 clientId:z.uuid(),expectedRevision:z.number().int().min(0).max(2147483646),
 phase:z.enum(['preflight','service']),expiresAt:z.iso.datetime(),
 configurationHash:z.string().regex(/^[a-f0-9]{64}$/),
 preset:z.record(z.string(),z.unknown()),
}).strict();
export const companyRuntimeRevokeInput=z.object({clientId:z.uuid(),expectedRevision:z.number().int().positive().max(2147483646)}).strict();
export type CompanyRuntimeSummary={
 companyId:string;kind:CompanyRuntimeKind;configurationId:string;selectionRevision:number;
 state:'active'|'revoked';enabled:boolean;configurationHash:string;
 phase:'preflight'|'service';expiresAt:string;createdAt:string;createdBy:string;
 computeStarted:false;spendingApproved:false;
};
