import {z} from 'zod';
import {taskInput,taskPatch} from './model';

const uuid={type:'string',format:'uuid'},text={type:'string'},nullable=(schema:object)=>({anyOf:[schema,{type:'null'}]});
const task={type:'object',additionalProperties:false,properties:{
 id:uuid,title:text,description:text,status:{type:'string',enum:['todo','doing','review','done']},revision:{type:'integer',minimum:1},
 assigneeId:nullable(uuid),createdBy:uuid,submissionUrl:nullable({type:'string',format:'uri'}),submissionSummary:text,reviewNote:nullable(text),
 submittedBy:nullable(uuid),submittedAgentId:nullable(uuid),approvedBy:nullable(uuid),approvedAgentId:nullable(uuid),machineReviewId:nullable(uuid),
 authorIds:{type:'array',items:uuid},createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'},
},required:['id','title','description','status','revision','assigneeId','createdBy','submissionUrl','submissionSummary','reviewNote','submittedBy','submittedAgentId','approvedBy','approvedAgentId','machineReviewId','authorIds','createdAt','updatedAt']};
const result={type:'object',properties:{task},required:['task'],additionalProperties:false};
const parameters=(detail=false)=>['companyId',...(detail?['taskId']:[])].map(name=>({name,in:'path',required:true,schema:uuid}));
const response={description:'Current task and monotonic revision',content:{'application/json':{schema:result}}};
const security=[{sessionCookie:[]}];
const errors=Object.fromEntries([['400','Missing/invalid expectedRevision or unsupported change.'],['401','Session required.'],['403','Task permission or independent-review authority missing.'],['404','Task/company not available to this member.'],['409','TASK_REVISION_CONFLICT or existing Studio/task state guard. Reload and inspect before making a new decision; never substitute a newer revision into an old acceptance.']].map(([status,description])=>[status,{description,content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}}]));
const body=(schema:z.ZodType)=>({required:true,content:{'application/json':{schema:z.toJSONSchema(schema,{io:'input',unrepresentable:'any'})}}});
const origin={name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'},description:'Must match the configured Coatria application origin.'};
export const workPaths={
 '/api/companies/{companyId}/tasks':{post:{operationId:'createCompanyTask',summary:'Create company work',security,parameters:[...parameters(),origin],requestBody:body(taskInput),responses:{'201':response,...errors}}},
 '/api/companies/{companyId}/tasks/{taskId}':{
  get:{operationId:'getCompanyTask',summary:'Read an exact task and its revision as a current company member',security,parameters:parameters(true),responses:{'200':response,...errors}},
  patch:{operationId:'updateCompanyTask',summary:'Update or independently review the exact observed task revision',description:'Every mutation requires expectedRevision from a task read or workspace snapshot. The locked transaction compares it before changing task, authorship or activity. Acceptance can include only expectedRevision, status:done and reviewNote; an independent current human administrator and all Studio gates remain required. Agent bearer tokens cannot approve work through this endpoint. A timeout is not permission to retry against a newer revision: GET the task and reconcile the observed outcome, then independently review any changed submission.',security,parameters:[...parameters(true),origin],requestBody:body(taskPatch),responses:{'200':response,...errors}},
 },
};
