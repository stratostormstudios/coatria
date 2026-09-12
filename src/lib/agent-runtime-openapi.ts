import {z} from 'zod';
import {AGENT_TOOLS} from './agent-tools';
import {AGENT_CAPABILITIES} from './agent-policy';
import {claimInput,completeInput,failInput,leaseInput,runInput} from './agent-runs';

type Schema=Record<string,unknown>;
const uuid:Schema={type:'string',format:'uuid'};
const date:Schema={type:'string',format:'date-time'};
const nullable=(schema:Schema):Schema=>({anyOf:[schema,{type:'null'}]});
const ref=(name:string):Schema=>({$ref:'#/components/schemas/'+name});
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const json=(schema:Schema)=>({'application/json':{schema}});
const response=(schema:Schema,description='Successful response')=>({description,content:json(schema)});
const input=(schema:z.ZodType):Schema=>z.toJSONSchema(schema,{io:'input',unrepresentable:'any'});
const parameter=(name:string,schema:Schema=uuid)=>({name,in:'path',required:true,schema});
const runParameters=[parameter('runId')];
const companyParameters=[parameter('companyId')];
const channelParameters=[...companyParameters,parameter('channel',{type:'string',description:'commons or a room UUID; not the conversation UUID'})];
const errors=Object.fromEntries([
 ['400','Invalid request or unsupported field.'],['401','Agent credential or session ended.'],
 ['403','Current sponsor/requester authority or required capability is missing.'],['404','Resource not found in this company.'],
 ['409','Lease lost/cancelled, idempotency mismatch or optimistic revision conflict.'],
 ['413','Request body exceeds the endpoint limit.'],['429','Rate limit; honor Retry-After seconds.'],
].map(([status,description])=>[status,{...response(ref('Error'),description),...(status==='429'?{headers:{'Retry-After':{description:'Seconds until another attempt',schema:{type:'integer',minimum:1}}}}:{})}]));
const agentSecurity=[{agentBearer:[]}];
const humanSecurity=[{sessionCookie:[]}];
const operation=(operationId:string,summary:string,result:Schema,body?:Schema,parameters:unknown[]=[],human=false)=>({
 operationId,summary,security:human?humanSecurity:agentSecurity,parameters,
 ...(body?{requestBody:{required:true,content:json(body)}}:{}),
 responses:{'200':response(result),...errors},
});
const runResult=object({run:ref('AgentRun'),replayed:{type:'boolean'}});
const listResult=object({runs:{type:'array',items:ref('AgentRun')}});
const listParameters=[
 {name:'agentId',in:'query',schema:uuid},{name:'parentId',in:'query',schema:uuid},
 {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}},
];
const paths:Record<string,unknown>={
 '/api/agent/runs/claim':{post:operation('claimAgentRun','Claim or replay one explicit request; use a new claimId after a confirmed idle result',object({run:nullable(ref('AgentRun')),leaseToken:{type:'string',writeOnly:false},leaseExpiresAt:date,replayed:{type:'boolean'}},['run','replayed']),input(claimInput))},
 '/api/agent/runs/{runId}/heartbeat':{post:operation('renewAgentRun','Renew the owned lease; cannot exceed the run deadline',object({run:ref('AgentRun'),leaseExpiresAt:date}),input(leaseInput),runParameters)},
 '/api/agent/runs/{runId}/context':{get:operation('readAgentRunContext','Read bounded source messages and effective capabilities with a live lease',object({run:ref('AgentRun'),messages:{type:'array',maxItems:30,items:{type:'object',additionalProperties:true}},capabilities:{type:'array',items:{type:'string',enum:AGENT_CAPABILITIES}}}),undefined,[...runParameters,{name:'X-Coatria-Run-Lease',in:'header',required:true,schema:{type:'string',minLength:20,maxLength:200}}])},
 '/api/agent/runs/{runId}/complete':{post:operation('completeAgentRun','Commit a result and its agent-authored conversation reply atomically',runResult,input(completeInput),runParameters)},
 '/api/agent/runs/{runId}/fail':{post:operation('failAgentRun','Report a bounded failure; the server may schedule another attempt',runResult,input(failInput),runParameters)},
 '/api/agent/tools':{get:operation('listAgentTools','Discover tools allowed by current agent grants; execution also checks the run intersection',object({protocolVersion:{const:'1.0'},requiresRunLease:{const:true},tools:{type:'array',items:object({name:{type:'string'},description:{type:'string'},capability:{type:'string',enum:AGENT_CAPABILITIES},mutating:{type:'boolean'},inputSchema:{type:'object',additionalProperties:true}})}}))},
 '/api/companies/{companyId}/conversations/{channel}/runs':{
  get:operation('listChannelAgentRuns','List recent requests in this company conversation',listResult,undefined,[...channelParameters,...listParameters],true),
  post:{...operation('createAgentRun','Create an explicit invocation using a stable clientId',runResult,input(runInput),channelParameters,true),responses:{'200':response(runResult,'Idempotent replay'),'201':response(runResult,'Created'),...errors}},
 },
 '/api/companies/{companyId}/agent-runs':{get:operation('listCompanyAgentRuns','List recent requests across the company',listResult,undefined,[...companyParameters,...listParameters],true)},
 '/api/companies/{companyId}/agent-runs/{runId}':{get:operation('getAgentRun','Read a run and committed action receipt metadata',object({run:ref('AgentRun'),actions:{type:'array',maxItems:200,items:object({requestId:uuid,tool:{type:'string'},createdAt:date})}}),undefined,[...companyParameters,...runParameters],true)},
 '/api/companies/{companyId}/agent-runs/{runId}/cancel':{post:operation('cancelAgentRun','Cancel as the requester or a current owner/administrator',object({run:ref('AgentRun')}),object({}),[...companyParameters,...runParameters],true)},
};
for(const[name,tool]of Object.entries(AGENT_TOOLS))paths['/api/agent/tools/'+name]={post:{
 ...operation('agentTool_'+name,tool.description,object({result:{},replayed:{type:'boolean'}}),object({runId:uuid,leaseToken:{type:'string',minLength:20,maxLength:200,writeOnly:true},requestId:uuid,arguments:input(tool.schema)})),
 'x-coatria-capability':tool.capability,'x-coatria-mutating':tool.mutating,
 description:'Live run lease required in the JSON body. Keep requestId stable for the same logical mutation across retries. Mutation receipts commit with effects; reads return the current view. Input schemas cannot express every authorization or cross-field constraint; server validation remains authoritative.',
}};

const runProperties:Record<string,Schema>={
 ...Object.fromEntries(['id','companyId','conversationId','requestedBy','agentId'].map(key=>[key,uuid])),
 ...Object.fromEntries(['parentId','resultMessageId'].map(key=>[key,nullable(uuid)])),
 ...Object.fromEntries(['channel','prompt','requesterName','agentName','result','error'].map(key=>[key,{type:'string'}])),
 ...Object.fromEntries(['availableAt','createdAt','updatedAt'].map(key=>[key,date])),
 ...Object.fromEntries(['leaseExpiresAt','startedAt','deadlineAt','finishedAt'].map(key=>[key,nullable(date)])),
 status:{type:'string',enum:['queued','running','succeeded','failed','cancelled']},
 attempts:{type:'integer',minimum:0,maximum:3},maxAttempts:{type:'integer',const:3},artifactUrl:nullable({type:'string',format:'uri'}),
 capabilities:{type:'array',items:{type:'string',enum:AGENT_CAPABILITIES}},
};

/** Public contract only. No credentials, company records or runtime queries. */
export const agentRuntimeOpenApi={
 openapi:'3.1.0',info:{title:'Coatria agent runtime',version:'1.0.0',description:'External execution, durable invocations and scoped company tools. This is the REST protocol used by the downloadable worker and local MCP stdio bridge; it is not a hosted model provider or remote OAuth MCP server. Human mutations require a same-origin Origin header; X-Coatria-User may pin the intended session identity. Read API errors before retrying. Legacy /api/agent/work and /api/agent/report are retired with HTTP 410.'},
 servers:[{url:'https://coatria.com',description:'Production; confirm deployment support before connecting'}],
 externalDocs:{description:'Worker, Codex and MCP setup',url:'https://coatria.com/downloads/AGENT_RUNTIME.md'},
 paths,components:{securitySchemes:{agentBearer:{type:'http',scheme:'bearer',description:'Company-scoped agent credential, never a provider key. Runs also require their live lease.'},sessionCookie:{type:'apiKey',in:'cookie',name:'coatria_session'}},schemas:{AgentRun:object(runProperties),Error:{type:'object',properties:{error:{type:'string'},code:{type:'string'}},required:['error']}}},
};
