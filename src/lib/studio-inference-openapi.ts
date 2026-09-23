import {z} from 'zod';
import {studioInferenceSubmitInput,studioInferenceCancelInput} from './studio-inference-protocol';
type Schema=Record<string,any>;
const uuid={type:'string',format:'uuid'},date={type:'string',format:'date-time'},ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const validationIssue:Schema={
 type:'object',additionalProperties:false,required:['path','code'],
 properties:{
  path:{type:'array',maxItems:12,items:{type:'string',pattern:'^(?:[A-Za-z][A-Za-z0-9_]{0,79}|[*])$'}},
  code:{type:'string',enum:['invalid_type','invalid_value','too_small','too_big','invalid_format','unrecognized_keys','custom','invalid_union','staffing_roles','staffing_identity','staffing_reviewer']},
  expected:{type:'string',enum:['string','number','integer','boolean','object','array','null']},
  allowed:{type:'array',maxItems:40,items:{type:'string',maxLength:160}},
  minimum:{type:'number',minimum:0,maximum:1000000000},maximum:{type:'number',minimum:0,maximum:1000000000},
 },
};
const validationResponse:Schema={
 type:'object',additionalProperties:false,required:['version','executed','code','issues'],
 properties:{
  version:{const:1},executed:{const:false},
  code:{type:'string',enum:['ARGUMENT_JSON_INVALID','ARGUMENT_SCHEMA_INVALID','STAFFING_VALIDATION_INVALID','BATCH_NOT_EXECUTED']},
  issues:{type:'array',maxItems:12,items:validationIssue},
 },
};
export const studioInferenceSchemas:Record<string,Schema>={
 StudioInference:{
  type:'object',additionalProperties:false,
  required:['id','runId','step','status','createdAt','deadlineAt','errorCode','reservedTokens','usedTokens','billingVerified'],
  properties:{
   id:uuid,runId:uuid,step:{type:'integer',minimum:0,maximum:19},
   status:{type:'string',enum:['submitting','queued','running','succeeded','failed','uncertain','cancel_requested','cancelled','expired']},
   createdAt:date,deadlineAt:date,errorCode:{type:['string','null']},
   reservedTokens:{type:'integer',minimum:1},usedTokens:{type:['integer','null'],minimum:0},billingVerified:{const:false},
   output:{type:'object',description:'Original bounded OpenAI chat completion, present only for successful provider completion. In protocol 2, inspect server disposition before any tool execution; successful inference may instead contain server-recorded nonexecution feedback.'},
   protocolVersion:{type:'integer',const:2,description:'Explicitly negotiated on submission and pinned for the entire run. Omission retains the terminal-only legacy contract.'},
   disposition:{type:'string',enum:['execute','validation_feedback'],description:'Server-owned disposition, present with protocol 2 success. validation_feedback forbids execution of every call in the batch.'},
   usage:{type:'object',additionalProperties:false,required:['promptTokens','completionTokens','totalTokens'],properties:Object.fromEntries(['promptTokens','completionTokens','totalTokens'].map(key=>[key,{type:'integer',minimum:0}]))},
   validationFeedback:{
    type:'object',additionalProperties:false,required:['version','correction','calls'],
    properties:{
     version:{const:1},correction:{type:'integer',minimum:1,maximum:2},
     calls:{
      type:'array',minItems:1,maxItems:8,
      items:{
       type:'object',additionalProperties:false,required:['id','name','requestId','response'],
       properties:{id:{type:'string',pattern:'^[-a-zA-Z0-9_]{1,120}$'},name:{type:'string'},requestId:uuid,response:validationResponse},
      },
     },
    },
   },
  },
 },
};
function operation(operationId:string,summary:string,input?:z.ZodType,item=false){
 const result={type:'object',required:['inference'],properties:{inference:ref('StudioInference'),replayed:{type:'boolean'}}};
 const success={description:'Current bounded inference state. A replay does not submit another paid job.',content:{'application/json':{schema:result}}};
 return {
  operationId,summary,security:[{agentBearer:[]}],
  description:'Requires the exact live agent token and run lease, an active managed supervisor, and an administrator-approved CPU provision using coatria_broker_v1. The server owns prompt, persona, scoped context, tools, endpoint, model and limits. Caller model requests are forbidden. A durable run/step fence permits at most one provider submission; uncertain submissions are never resubmitted. Monetary reservations are not verified billing or a provider-enforced cap.',
  parameters:[{name:'runId',in:'path',required:true,schema:uuid},...(item?[{name:'inferenceId',in:'path',required:true,schema:uuid}]:[]),...(!input?[{name:'X-Coatria-Run-Lease',in:'header',required:true,schema:{type:'string',minLength:20,maxLength:200}}]:[])],
  ...(input?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(input,{io:'input'})}}}}:{}),
  responses:{'200':success,...(operationId==='submitStudioInference'?{'201':success}:{}),...Object.fromEntries(['400','401','403','404','409','413','429','503'].map(code=>[code,{description:'Validation, ended authority, unsupported sequence, budget or provider failure.',content:{'application/json':{schema:ref('Error')}}}]))}
 };
}
const base='/api/agent/runs/{runId}/inference';
export const studioInferencePaths:Record<string,unknown>={
 [base]:{post:operation('submitStudioInference','Admit one exact server-constructed reasoning step',studioInferenceSubmitInput)},
 [base+'/{inferenceId}']:{get:operation('readStudioInference','Read and reconcile an inference request under its original live run lease',undefined,true)},
 [base+'/{inferenceId}/cancel']:{post:operation('cancelStudioInference','Request bounded provider cancellation without refunding reservations',studioInferenceCancelInput,true)},
};
