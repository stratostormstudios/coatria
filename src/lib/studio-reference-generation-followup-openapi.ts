type Schema=Record<string,unknown>;
const uuid:Schema={type:'string',format:'uuid'},boolean:Schema={type:'boolean'},text:Schema={type:'string'};
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const ref=(name:string):Schema=>({$ref:'#/components/schemas/'+name});
const nullable=(schema:Schema):Schema=>({anyOf:[schema,{type:'null'}]});
export const studioReferenceGenerationFollowupSchemas={
 StudioReferenceGenerationFollowupReceipt:object({...Object.fromEntries(['projectId','workItemId','taskId','referenceId','sourceChildRunId','parentRunId','childRunId','specialistAgentId'].map(n=>[n,uuid])),policyRevision:{type:'integer',minimum:1},createdAt:{type:'string',format:'date-time'},status:{enum:['queued','running','succeeded','failed','cancelled']}}),
 StudioReferenceGenerationFollowupContext:object({...Object.fromEntries(['projectId','workItemId','taskId','referenceId'].map(n=>[n,uuid])),handoffSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},requestId:nullable(uuid),nextStep:{enum:['claim','proposal','proposed']},advanceTool:{const:'studio_reference_generation_followup_advance'},serverOwnsOperationIds:{const:true},contentInspected:{const:false},canGenerate:{const:false},canTransfer:{const:false},canApprove:{const:false}}),
 StudioReferenceGenerationFollowupSnapshot:object({candidates:{type:'array',maxItems:50,items:object({referenceId:uuid,workItemId:uuid,eligible:boolean,blocker:nullable(text),continuation:nullable(ref('StudioReferenceGenerationFollowupReceipt'))})},history:{type:'array',maxItems:50,items:ref('StudioReferenceGenerationFollowupReceipt')},hasMore:boolean,nextAfter:nullable(uuid),historyHasMore:boolean,historyNextAfter:nullable(uuid),requiresExplicitPolicy:{const:true},automaticProviderActions:{const:false},contentInspected:{const:false}}),
};
export const studioReferenceGenerationFollowupToolResults:Record<string,Schema>={
 studio_reference_generation_followups_get:ref('StudioReferenceGenerationFollowupSnapshot'),
 studio_reference_generation_followup_dispatch:object({continuation:ref('StudioReferenceGenerationFollowupReceipt'),replayed:boolean}),
 studio_reference_generation_followup_advance:{oneOf:[object({step:{const:'claim'},task:{type:'object'},replayed:boolean}),object({step:{const:'proposal'},request:{type:'object',description:'Exact stored generation proposal. Does not invoke the provider or spend credits.'},replayed:boolean})]},
};
const response=(schema:Schema)=>({description:'Current company-scoped metadata with no bytes or provider credentials.',content:{'application/json':{schema}}});
export const studioReferenceGenerationFollowupPaths={
 '/api/companies/{companyId}/studio/projects/{projectId}/reference-generation-followups':{get:{operationId:'listStudioReferenceGenerationFollowups',summary:'Read exact shared-reference continuation eligibility and history',security:[{sessionCookie:[]}],
  parameters:[...['companyId','projectId'].map(name=>({name,in:'path',required:true,schema:uuid})),...['referenceId','after','historyAfter'].map(name=>({name,in:'query',schema:uuid})),{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}}],
  description:'Explicit finite referenceGenerationContinuations policy required for dispatch. A completed initial specialist can hand off one exact prepared derivative for separate finite human inspection consent and separate sharing approval. Once confirmed, a current coordinator may queue one fresh specialist. It consumes the shared lifetime and concurrency limits and cannot spawn children. Server-owned claim/proposal IDs make retries exact across harness transport IDs; alternate proposal arguments conflict. The child may propose generation with only the pinned approved reference and must save that proposal before successful completion. Human credit approval and provider execution remain separate. Task reservation advances exactly once with immutable receipt evidence; project content revision and original reference remain unchanged. Failed/expired runs are not automatically replaced. Candidates and history have independent ascending UUID pagination; history itself grants no current authority.',
  responses:{'200':response(ref('StudioReferenceGenerationFollowupSnapshot')),...Object.fromEntries([400,401,403,404,409,429].map(n=>[String(n),response(ref('Error'))]))},
 }},
};
