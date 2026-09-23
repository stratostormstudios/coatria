import {z} from 'zod';
import {studioCreativeFollowupInput} from './studio-creative-followup-protocol';

type Schema=Record<string,unknown>;
const uuid:Schema={type:'string',format:'uuid'},integer:Schema={type:'integer'},text:Schema={type:'string'};
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const candidate=object({workItemId:uuid,requestId:uuid,artifactId:uuid,sourceRunId:uuid});
const receipt=object({version:{const:1},runId:uuid,projectId:uuid,workItemId:uuid,taskId:uuid,requestId:uuid,requestHash:{type:'string',pattern:'^[a-f0-9]{64}$'},artifactId:uuid,artifactSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},sourceRunId:uuid,agentId:uuid,taskRevision:integer,projectRevision:integer,attestedBy:uuid,attestedAt:{type:'string',format:'date-time'},note:text,provenance:{const:'human_attested'},providerOutputVerified:{const:false},mediaBytesVerified:{const:false},mediaQcApproved:{const:false},maxAttempts:{const:1}});
export const studioCreativeFollowupSchemas={StudioCreativeFollowupReceipt:receipt};
const response=(schema:Schema)=>({description:'Company-scoped result; no provider generation, media verification or QC is performed.',content:{'application/json':{schema}}});
const parameters=['companyId','projectId'].map(name=>({name,in:'path',required:true,schema:uuid}));
const errors=Object.fromEntries([400,401,403,404,409].map(code=>[String(code),response({$ref:'#/components/schemas/Error'})]));
const result=object({run:{$ref:'#/components/schemas/AgentRun'},project:object({id:uuid,revision:integer}),creativeFollowup:{$ref:'#/components/schemas/StudioCreativeFollowupReceipt'},replayed:{type:'boolean'}});
export const studioCreativeFollowupPaths={
 '/api/companies/{companyId}/studio/projects/{projectId}/creative-followup':{
  get:{operationId:'listStudioCreativeFollowups',summary:'Preview exact ended-run/output pairs eligible for a manual administrator handoff.',description:'Legacy frame projects only. Generated contractVersion:2 returns STUDIO_GENERATED_FOLLOWUP_UNAVAILABLE; verified generated-media publication does not enable this attested legacy handoff.',security:[{sessionCookie:[]}],parameters,'x-coatria-roles':['owner','admin'],responses:{'200':response(object({candidates:{type:'array',maxItems:200,items:candidate},requiresHumanOutputAttestation:{const:true},automaticContinuation:{const:false}})),...errors}},
  post:{operationId:'dispatchStudioCreativeFollowup',summary:'Attest one existing output to its exact returned Higgsfield request and queue a single scoped submission run.',description:'Human owner/admin only. Generated contractVersion:2 returns STUDIO_GENERATED_FOLLOWUP_UNAVAILABLE. Requires an ended source run, unchanged source-owned task, current specialist and role grants, production gates and the latest registered artifact. A returned provider receipt alone is not media completion: the administrator explicitly attests provenance. The run can only read the exact task/artifact/request and claim/submit that task. It cannot generate, register artifacts, edit other work or delegate. One attempt; an uncertain or failed follow-up is not automatically retried. Exact request+artifact pair cannot be queued twice. This endpoint does not consume or expand the autonomous coordinator run allowance.',security:[{sessionCookie:[]}],parameters:[...parameters,{name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'}}],'x-coatria-roles':['owner','admin'],requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(studioCreativeFollowupInput,{io:'input'})}}},responses:{'200':response(result),'201':response(result),...errors}},
 },
};
