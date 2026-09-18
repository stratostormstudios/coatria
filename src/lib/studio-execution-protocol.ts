import {z} from 'zod';
import {studioSpecInput} from './studio-protocol';

const uuid=z.string().uuid(),revision=z.number().int().min(1).max(2147483646);
const name=z.string().trim().min(1).max(160);
export const executionStorageKey=z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value=>value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Use an approved relative storage key without traversal.');
export const executionDigest=z.string().regex(/^[a-f0-9]{64}$/);
export const EXECUTION_INPUT_KINDS=['scene','cache','image_sequence','media'] as const;
export const EXECUTION_OUTPUT_KINDS=['image_sequence','scene','cache','media'] as const;
export const executionProfileInput=z.object({
 key:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),version:z.number().int().min(1).max(1000),engine:z.literal('blender'),
 inputKinds:z.array(z.enum(EXECUTION_INPUT_KINDS)).max(4),outputKinds:z.array(z.enum(EXECUTION_OUTPUT_KINDS)).min(1).max(4),
 maxFrames:z.number().int().min(1).max(1000),minWidth:z.number().int().min(16).max(32768).default(16),minHeight:z.number().int().min(16).max(32768).default(16),maxWidth:z.number().int().min(16).max(32768),maxHeight:z.number().int().min(16).max(32768),
 maxTotalPixels:z.number().int().min(256).max(1_000_000_000_000).default(8_000_000),maxFps:z.number().min(1).max(240).default(60),colorSpaces:z.array(z.string().trim().min(1).max(120)).min(1).max(8).default(['Linear Rec.709','ACEScg']),
 maxInputBytes:z.number().int().min(1).max(100_000_000_000),maxOutputBytes:z.number().int().min(1).max(100_000_000_000),timeoutSeconds:z.number().int().min(30).max(3600),
}).strict().refine(value=>new Set(value.inputKinds).size===value.inputKinds.length&&new Set(value.outputKinds).size===value.outputKinds.length,'Profile kinds must be unique.').refine(value=>value.minWidth<=value.maxWidth&&value.minHeight<=value.maxHeight,'Profile dimension bounds must be ordered.');
export const executionConnectorInput=z.object({clientId:uuid,name,profiles:z.array(executionProfileInput).min(1).max(8),expiresInDays:z.number().int().min(1).max(365).default(30)}).strict().refine(value=>new Set(value.profiles.map(profile=>profile.key+':'+profile.version)).size===value.profiles.length,'Profile keys and versions must be unique.');
export const executionConnectorPatchInput=z.object({clientId:uuid,revision,status:z.enum(['active','paused','revoked'])}).strict();
export const executionInputRegisterInput=z.object({clientId:uuid,projectId:uuid,name,kind:z.enum(EXECUTION_INPUT_KINDS),storageKey:executionStorageKey,sha256:executionDigest,bytes:z.number().int().min(1).max(100_000_000_000)}).strict();
export const executionPlanInput=z.object({projectId:uuid,revision,workItemId:uuid,connectorId:uuid,profileKey:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),profileVersion:z.number().int().min(1).max(1000),inputIds:z.array(uuid).max(32),frameStart:z.number().int().min(0).max(10_000_000),frameEnd:z.number().int().min(0).max(10_000_000),outputKind:z.enum(EXECUTION_OUTPUT_KINDS)}).strict().refine(value=>value.frameEnd>=value.frameStart&&value.frameEnd-value.frameStart<1000,'Use an inclusive range of at most 1,000 frames.').refine(value=>new Set(value.inputIds).size===value.inputIds.length,'Input references must be unique.');
export const executionSubmitInput=executionPlanInput.safeExtend({clientId:uuid});
export const executionJobActionInput=z.object({clientId:uuid,revision}).strict();
export const executionClaimInput=z.object({claimId:uuid,workerId:z.string().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/)}).strict();
export const executionLeaseInput=z.object({leaseToken:z.string().min(20).max(200)}).strict();
export const executionOutputFile=z.object({path:executionStorageKey,kind:z.enum(['image','scene','cache','media','report']),sha256:executionDigest,bytes:z.number().int().min(1).max(100_000_000_000),frame:z.number().int().min(0).max(10_000_000).optional()}).strict();
export const executionManifestInput=z.object({schemaVersion:z.literal(1),files:z.array(executionOutputFile).min(1).max(1000),spec:studioSpecInput.optional(),engineVersion:z.string().trim().min(1).max(80),verification:z.object({fileHashes:z.literal(true),fileSizes:z.literal(true),frameCoverage:z.boolean(),imageMetadata:z.boolean()}).strict()}).strict().refine(value=>new Set(value.files.map(file=>file.path)).size===value.files.length,'Output paths must be unique.');
export const executionCompleteInput=executionLeaseInput.extend({clientId:uuid,manifest:executionManifestInput}).strict();
export const executionFailureInput=executionLeaseInput.extend({clientId:uuid,reason:z.enum(['input_unavailable','input_verification_failed','profile_unavailable','renderer_failed','output_verification_failed','worker_interrupted'])}).strict();
export type ExecutionProfile=z.infer<typeof executionProfileInput>;
export type ExecutionManifest=z.infer<typeof executionManifestInput>;
export type ExecutionStatus='awaiting_approval'|'queued'|'running'|'succeeded'|'failed'|'failed_uncertain'|'cancelled';
/** Reviewed procedural geometry; it consumes no uploaded scene or footage. */
export const EXECUTION_BUILTIN_PROFILES:ExecutionProfile[]=[{key:'coatria-product-turntable-v1',version:1,engine:'blender',inputKinds:[],outputKinds:['image_sequence'],maxFrames:24,minWidth:64,minHeight:64,maxWidth:1024,maxHeight:1024,maxTotalPixels:8_000_000,maxFps:60,colorSpaces:['Linear Rec.709','ACEScg'],maxInputBytes:1,maxOutputBytes:512*1024*1024,timeoutSeconds:600}];
