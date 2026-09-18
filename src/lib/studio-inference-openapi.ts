import {z} from 'zod';
import {studioInferenceSubmitInput,studioInferenceCancelInput} from './studio-inference-protocol';
type Schema=Record<string,any>;
const uuid={type:'string',format:'uuid'},date={type:'string',format:'date-time'},ref=(name:string)=>({$ref:'#/components/schemas/'+name});
export const studioInferenceSchemas:Record<string,Schema>={StudioInference:{type:'object',additionalProperties:false,required:['id','runId','step','status','createdAt','deadlineAt','errorCode','reservedTokens','usedTokens','billingVerified'],properties:{id:uuid,runId:uuid,step:{type:'integer',minimum:0,maximum:19},status:{type:'string',enum:['submitting','queued','running','succeeded','failed','uncertain','cancel_requested','cancelled','expired']},createdAt:date,deadlineAt:date,errorCode:{type:['string','null']},reservedTokens:{type:'integer',minimum:1},usedTokens:{type:['integer','null'],minimum:0},billingVerified:{const:false},output:{type:'object',description:'Validated bounded OpenAI chat completion; present only for succeeded requests. Tool results must still execute through the leased Coatria tool API.'}}}};
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
