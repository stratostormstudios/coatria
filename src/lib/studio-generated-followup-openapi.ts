type Schema=Record<string,unknown>;
const uuid:Schema={type:'string',format:'uuid'},text:Schema={type:'string'},boolean:Schema={type:'boolean'},hash:Schema={type:'string',pattern:'^[a-f0-9]{64}$'};
const ref=(name:string):Schema=>({$ref:'#/components/schemas/'+name});
const nullable=(value:Schema):Schema=>({anyOf:[value,{type:'null'}]});
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const receipt=object({...Object.fromEntries(['projectId','workItemId','taskId','sourceChildRunId','parentRunId','childRunId','specialistAgentId','archiveId','requestId','storageVersionId'].map(key=>[key,uuid])),specSha256:hash,fileSha256:hash,artifactId:nullable(uuid),policyRevision:{type:'integer',minimum:1},createdAt:{type:'string',format:'date-time'},status:{enum:['queued','running','succeeded','failed','cancelled']}});
const candidate=object({archiveId:uuid,workItemId:uuid,taskId:uuid,sourceChildRunId:uuid,artifactId:nullable(uuid),eligible:boolean,blocker:nullable(text),continuation:nullable(ref('StudioGeneratedFollowupReceipt'))},['archiveId','workItemId','eligible','blocker','continuation']);
export const studioGeneratedFollowupSchemas={
 StudioGeneratedFollowupReceipt:receipt,
 StudioGeneratedFollowupSnapshot:object({candidates:{type:'array',maxItems:50,items:candidate},history:{type:'array',maxItems:50,items:ref('StudioGeneratedFollowupReceipt')},hasMore:boolean,nextAfter:nullable(uuid),historyHasMore:boolean,historyNextAfter:nullable(uuid),requiresExplicitPolicy:{const:true},automaticProviderActions:{const:false},contentInspected:{const:false}}),
 StudioGeneratedFollowupContext:object({...Object.fromEntries(['projectId','workItemId','taskId','archiveId','requestId','storageVersionId'].map(key=>[key,uuid])),fileSha256:hash,specSha256:hash,artifactId:nullable(uuid),nextStep:{enum:['claim','register','submit','submitted']},advanceTool:{const:'studio_generated_followup_advance'},serverOwnsOperationIds:{const:true},contentInspected:{const:false},canGenerate:{const:false},canTransfer:{const:false},canApprove:{const:false}}),
};
export const studioGeneratedFollowupToolResults:Record<string,Schema>={
 studio_generated_followups_get:ref('StudioGeneratedFollowupSnapshot'),
 studio_generated_followup_dispatch:object({continuation:ref('StudioGeneratedFollowupReceipt'),replayed:boolean}),
 studio_generated_followup_advance:{oneOf:[
  object({step:{enum:['claim','submit']},task:{type:'object',description:'Current committed task mutation receipt. Submission remains pending independent review.'},replayed:boolean}),
  object({step:{const:'register'},artifact:ref('StudioGeneratedArtifact'),project:ref('StudioGeneratedProject'),replayed:boolean}),
  object({step:{const:'register'},artifact:ref('StudioGeneratedArtifact'),reused:{const:true},replayed:{const:true}}),
 ]},
};
const response=(schema:Schema)=>({description:'Current company-scoped metadata. No provider calls or file access URLs.',content:{'application/json':{schema}}});
export const studioGeneratedFollowupPaths={
 '/api/companies/{companyId}/studio/projects/{projectId}/generated-followups':{get:{
  operationId:'listStudioGeneratedFollowups',summary:'Read eligible verified generated outputs and source-bound continuation history',security:[{sessionCookie:[]}],
  parameters:[...['companyId','projectId'].map(name=>({name,in:'path',required:true,schema:uuid})),...['archiveId','after','historyAfter'].map(name=>({name,in:'query',schema:uuid})),{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}}],
  description:'Generated contractVersion 2 only. Candidate archives use ascending archive-ID pagination via after/nextAfter; history independently uses ascending child-run-ID pagination via historyAfter/historyNextAfter. Follow both cursors to exhaust their respective pages. archiveId restricts both lists to one exact source. Eligibility is advisory and rechecked by dispatch. Existing history does not authorize another run. A current administrator must explicitly opt in through the finite coordination policy; the coordinator mission requester must be that approving administrator. Continuations share initial and DCC child lifetime/concurrency limits. No archive completion itself invokes inference. Unrelated conversation history is omitted from continuation context. Advance has server-owned inner operation IDs, revisions and source metadata so changing harness transport UUIDs cannot duplicate claim, registration or submission; effects and receipts are atomic. Revoked policy, source, assignment or storage authority fences new actions and cached replays. Failed or expired children never requeue automatically. Successful completion requires task submission; media QC and task acceptance remain separate.',
  responses:{'200':response(ref('StudioGeneratedFollowupSnapshot')),...Object.fromEntries([400,401,403,404,409,429].map(status=>[String(status),response(ref('Error'))]))},
 }},
};
