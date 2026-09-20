import {z} from 'zod';
import {higgsfieldArchiveProposalInput,higgsfieldArchiveApproveInput,higgsfieldArchiveRevokeInput,HIGGSFIELD_ARCHIVE_STATUSES} from './higgsfield-archive-protocol';

const uuid=z.string().uuid(),date=z.string().datetime(),sha=z.string().regex(/^[a-f0-9]{64}$/),revision=z.number().int().positive();
const archiveSchema=z.object({
 id:uuid,projectId:uuid,requestId:uuid,jobId:uuid,outputId:uuid,outputIdentity:sha,kind:z.enum(['image','video','audio']),status:z.enum(HIGGSFIELD_ARCHIVE_STATUSES),revision,requestHash:sha,
 projectRevision:revision,bindingId:uuid,bindingRevision:revision,storageConnectionId:uuid,storageConnectionRevision:revision,
 destination:z.object({parentId:uuid.nullable(),fileId:uuid.nullable(),name:z.string(),ancestors:z.array(z.object({id:uuid,name:z.string()}))}),maxBytes:z.number().int().positive(),
 sourceAttribution:z.object({requestedBy:uuid,agentId:uuid.nullable(),runId:uuid.nullable(),agentSponsorId:uuid.nullable(),approvedBy:uuid}),
 proposedBy:uuid,proposedAgentId:uuid.nullable(),createdAt:date,approvedBy:uuid.nullable(),approvedAt:date.nullable(),expiresAt:date.nullable(),revokedAt:date.nullable(),
 approvedProjectRevision:revision.nullable(),approvedBindingRevision:revision.nullable(),uploadId:uuid.nullable(),versionId:uuid.nullable(),diagnosticCode:z.string().nullable(),fetched:z.object({bytes:z.number().int().positive(),sha256:sha}).nullable(),bytesVerified:z.boolean()
}).strict();
const detailSchema=z.object({archive:archiveSchema,replayed:z.boolean().optional(),storedBytesDeleted:z.literal(false).optional()});
const pageSchema=z.object({archives:z.array(archiveSchema),hasMore:z.boolean(),nextAfter:uuid.nullable(),processing:z.object({enabled:z.boolean(),message:z.string()})});

const parameter=(name:string,location='path',required=true)=>({name,in:location,required,schema:{type:'string',format:'uuid'}});
const company=[parameter('companyId')],archive=[...company,parameter('archiveId')];
const errors=Object.fromEntries([400,401,403,404,409,413,429,503].map(status=>[String(status),{description:'Invalid, stale, unavailable or unauthorized archive operation. Do not repeat a provider generation or uncertain storage write.'}]));
function operation(summary:string,parameters:unknown[],input?:z.ZodType,output:z.ZodType=detailSchema){const response={description:'Company-scoped archive metadata. No signed source locators, storage credentials or worker leases.',content:{'application/json':{schema:z.toJSONSchema(output,{io:'output',unrepresentable:'any'})}}};return {summary,tags:['Higgsfield archives'],security:[{sessionCookie:[]}],parameters:input?[...parameters,{name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'},description:'Accepted application origin; current session membership is required.'}]:parameters,...input?{'x-coatria-roles':input===higgsfieldArchiveProposalInput?['owner','admin','member']:['owner','admin']}: {},...input?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(input,{io:'input',unrepresentable:'any'})}}}}:{},responses:{'200':response,...input===higgsfieldArchiveProposalInput?{'201':response}:{},...errors}};}
export const higgsfieldArchivePaths={
 '/api/companies/{companyId}/higgsfield/archives':{
  get:operation('Page project archive proposals and durable transfer outcomes with deployment processing availability. Verification establishes immutable stored bytes; media QC, work acceptance and client delivery remain separate.',[...company,parameter('projectId','query'),parameter('after','query',false),{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}}],undefined,pageSchema),
  post:operation('Propose saving one exact completed adopted provider output. Pins source identity, destination storage/folder, current revisions and finite byte limit; does not authorize a download or upload.',company,higgsfieldArchiveProposalInput)},
 '/api/companies/{companyId}/higgsfield/archives/{archiveId}':{get:operation('Read an exact same-company archive and its measured result without exposing provider links or worker authority.',archive)},
 '/api/companies/{companyId}/higgsfield/archives/{archiveId}/approve':{post:operation('Human administrator approves the exact proposal hash, revisions, byte limit and expiry. Creates separate bounded archive authority; never extends the producing agent lease or approves media. Current source/destination authority is rechecked throughout transfer.',archive,higgsfieldArchiveApproveInput)},
 '/api/companies/{companyId}/higgsfield/archives/{archiveId}/revoke':{post:operation('Human administrator revokes future archive work. Active transfers stop on their next bounded authority check. This preserves receipts and does not erase already stored or downloaded bytes.',archive,higgsfieldArchiveRevokeInput)},
};
for(const[path,methods]of Object.entries(higgsfieldArchivePaths))for(const[method,definition]of Object.entries(methods))Object.assign(definition,{operationId:'higgsfield_archive_'+method+'_'+path.replace(/[^a-zA-Z0-9]+/g,'_')});
