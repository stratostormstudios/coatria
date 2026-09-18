import {z} from 'zod';
import type {PluginRuntimeConfig,AgentCharacter} from './plugin-catalog';

const uuid=z.string().uuid(),revision=z.number().int().min(1),provider=z.enum(['runpod','openai','anthropic','xai','fireworks','together']);
export const STUDIO_HOST_LEASE_SECONDS=60;
export const STUDIO_HOST_MAX_HOURS=24;
export const studioHostRegisterInput=z.object({clientId:uuid,name:z.string().trim().min(1).max(100),maxAgents:z.number().int().min(1).max(11).default(1),providerIds:z.array(provider).min(1).max(6).refine(values=>new Set(values).size===values.length,'Providers must be unique.').default(['runpod']),expiresAt:z.iso.datetime({offset:true})}).strict();
export const studioHostEnrollInput=z.object({clientId:uuid,revision,activateAgents:z.literal(true),installations:z.array(z.object({installationId:uuid,revision}).strict()).min(1).max(11).refine(values=>new Set(values.map(value=>value.installationId)).size===values.length,'Installation IDs must be unique.')}).strict();
export const studioHostRevokeInput=z.object({clientId:uuid,revision}).strict();
export const studioHostCredentialsInput=z.object({supervisorId:uuid,leaseEpoch:z.number().int().min(0).optional()}).strict();
export type StudioHost={id:string;companyId:string;name:string;status:'active'|'revoked';revision:number;maxAgents:number;providerIds:string[];expiresAt:string;createdBy:string;createdAt:string;lastSeenAt:string|null;leaseEpoch:number;leaseExpiresAt:string|null;bindingCount?:number};
export type StudioHostBinding={agentId:string;installationId:string;name:string;credentialVersion:number;installationRevision:number;expiresAt:string;status:string;credentialState:string;capabilities:string[];enrolledBy:string};
export type StudioHostCredential={agentId:string;installationId:string;name:string;credentialVersion:number;installationRevision:number;agentToken:string;expiresAt:string;capabilities:string[];runtime:{pluginId:string;manifestVersion:string;runtimeConfig:PluginRuntimeConfig;character:AgentCharacter}};
export type StudioHostCredentials={host:StudioHost;supervisor:{id:string;epoch:number;expiresAt:string};credentials:StudioHostCredential[];unavailable:Array<{agentId:string;reason:string}>;pollAfterSeconds:20};
