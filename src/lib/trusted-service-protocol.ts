import {z} from 'zod';
export const trustedServiceKind=z.enum(['archive','gateway']);
export type TrustedServiceKind=z.infer<typeof trustedServiceKind>;
export const trustedServicePlanInput=z.object({clientId:z.uuid(),service:trustedServiceKind}).strict();
export const trustedServiceStartInput=z.object({clientId:z.uuid(),revision:z.number().int().positive(),planHash:z.string().regex(/^[a-f0-9]{64}$/),acknowledgeCharges:z.literal(true)}).strict();
export const trustedServiceStopInput=z.object({clientId:z.uuid(),revision:z.number().int().positive()}).strict();
