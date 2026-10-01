import {z} from 'zod';
import {studioGeneratedRevisionDraftInput,studioGeneratedRevisionApplyInput,studioGeneratedRevisionSnapshotInput,studioGeneratedRevisionSourceInput} from './studio-generated-revision-protocol';

type Schema=Record<string,any>;
const uuid={type:'string',format:'uuid'},hash={type:'string',pattern:'^[a-f0-9]{64}$'},date={type:'string',format:'date-time'},revision={type:'integer',minimum:1};
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const nullable=(s:Schema)=>({anyOf:[s,{type:'null'}]});
const object=(properties:Schema,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const schema=(s:z.ZodType)=>z.toJSONSchema(s,{io:'input',unrepresentable:'any'}) as Schema;
const planInput=schema(studioGeneratedRevisionSnapshotInput);
const round=object({id:uuid,number:{type:'integer',minimum:1,maximum:20},planId:uuid,planSha256:hash,approvedBy:uuid,createdAt:date});
const summary=object({id:uuid,planSha256:hash,projectRevision:revision,createdBy:uuid,createdAgentId:nullable(uuid),createdAt:date,appliedRoundId:nullable(uuid),summary:{type:'string',maxLength:320},source:object({shareId:uuid,receiptId:uuid,deliveryId:uuid,packageSha256:hash,roundId:nullable(uuid)}),changedCount:{type:'integer',minimum:1,maximum:100},carryCount:{type:'integer',minimum:0,maximum:99}});
export const studioGeneratedRevisionSchemas={
 StudioGeneratedRevisionPlan:object({...planInput.properties,id:uuid,planSha256:hash,createdBy:uuid,createdAgentId:nullable(uuid),createdAt:date,appliedRoundId:nullable(uuid)}),
 StudioGeneratedRevisionRound:round,
 StudioGeneratedRevisionSnapshot:object({projectRevision:revision,currentRound:nullable(ref('StudioGeneratedRevisionRound')),source:nullable(object({source:schema(studioGeneratedRevisionSourceInput),items:{type:'array',minItems:1,maxItems:100,items:object(Object.fromEntries(Object.entries(planInput.properties.items.items.properties).filter(([key])=>!['action','instructions'].includes(key))))}})),sourceBlockedReason:nullable({type:'string'}),plan:nullable(ref('StudioGeneratedRevisionPlan')),plans:{type:'array',maxItems:50,items:summary},page:object({hasMore:{type:'boolean'},nextAfter:nullable(uuid),limit:{type:'integer',minimum:1,maximum:50}})}),
 StudioGeneratedRevisionDraftResult:object({plan:ref('StudioGeneratedRevisionPlan'),replayed:{type:'boolean'}}),
 StudioGeneratedRevisionApplyResult:object({plan:ref('StudioGeneratedRevisionPlan'),round:ref('StudioGeneratedRevisionRound'),project:ref('StudioGeneratedProject'),replayed:{type:'boolean'}}),
};
const pagedPlan=object({...studioGeneratedRevisionSchemas.StudioGeneratedRevisionPlan.properties,items:{...planInput.properties.items,minItems:0,maxItems:20}});
const sourceProperties=studioGeneratedRevisionSchemas.StudioGeneratedRevisionSnapshot.properties.source.anyOf[0].properties;
const pagedSource=object({...sourceProperties,items:{...sourceProperties.items,minItems:0,maxItems:20}});
export const studioGeneratedRevisionToolResults:Record<string,Schema>={studio_generated_revisions_get:object({...studioGeneratedRevisionSchemas.StudioGeneratedRevisionSnapshot.properties,plan:nullable(pagedPlan),source:nullable(pagedSource),itemPage:object({kind:{enum:['plan','source',null]},after:nullable(uuid),total:{type:'integer',minimum:0,maximum:100},returned:{type:'integer',minimum:0,maximum:20},hasMore:{type:'boolean'},nextAfter:nullable(uuid)}),contentInspected:{const:false},canApply:{const:false}}),studio_generated_revision_draft:object({planId:uuid,planSha256:hash,projectId:uuid,projectRevision:revision,changedCount:{type:'integer',minimum:1,maximum:100},carryCount:{type:'integer',minimum:0,maximum:99},readTool:{const:'studio_generated_revisions_get'},requiresHumanApplication:{const:true},replayed:{type:'boolean'}})};
const parameters=['companyId','projectId'].map(name=>({name,in:'path',required:true,schema:uuid}));
const responses=(name:string)=>({...Object.fromEntries((name==='StudioGeneratedRevisionSnapshot'?[200]:[200,201]).map(code=>[String(code),{description:'Immutable revision metadata; no generation or transfer is started.',content:{'application/json':{schema:ref(name)}}}])),...Object.fromEntries([400,401,403,404,409,413,429].map(code=>[code,{description:'Invalid input, unavailable authority or stale pinned evidence.',content:{'application/json':{schema:ref('Error')}}}]))});
const body=(s:z.ZodType)=>({required:true,content:{'application/json':{schema:schema(s)}}});
const description='Creative revisions within the unchanged generated-media specification and deliverable set. The source must be an exact authenticated external client changes_requested receipt on the current package. Every deliverable is classified; at least one is regenerated. Carry-forward items pin exact original artifact, independent review and storage-version identities. Plans are immutable, and stale source or project revisions fail closed. Approval creates fresh tasks and pauses coordinator authority; original tasks, files and client receipts stay immutable. Production gates, provider credit consent, independent QC, delivery handoff and external acceptance remain separate. No automatic provider calls, file transfers or client messages. Retry uncertain mutations with the identical clientId and body.';
export const studioGeneratedRevisionPaths={
 '/api/companies/{companyId}/studio/projects/{projectId}/generated-revisions':{
  get:{operationId:'listStudioGeneratedRevisions',summary:'Read client feedback and immutable revision plans',description,security:[{sessionCookie:[]}],parameters:[...parameters,...['planId','after'].map(name=>({name,in:'query',schema:uuid})),{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}}],responses:responses('StudioGeneratedRevisionSnapshot')},
  post:{operationId:'draftStudioGeneratedRevision',summary:'Draft a selective creative revision',description,security:[{sessionCookie:[]}],parameters,requestBody:body(studioGeneratedRevisionDraftInput),responses:responses('StudioGeneratedRevisionDraftResult')},
 },
 '/api/companies/{companyId}/studio/projects/{projectId}/generated-revisions/{planId}/apply':{post:{operationId:'applyStudioGeneratedRevision',summary:'Human administrator applies the exact reviewed plan',description:description+' This route accepts only a current human administrator session. There is deliberately no agent apply or approval tool.',security:[{sessionCookie:[]}],parameters:[...parameters,{name:'planId',in:'path',required:true,schema:uuid}],requestBody:body(studioGeneratedRevisionApplyInput),responses:responses('StudioGeneratedRevisionApplyResult')}},
};
