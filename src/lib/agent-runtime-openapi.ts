import {projectStoragePaths} from './project-storage-openapi';
import {higgsfieldPaths} from './higgsfield-openapi';
import {studioCreativeFollowupPaths,studioCreativeFollowupSchemas} from './studio-creative-followup-openapi';
import {studioOperationsPaths,studioOperationsSchemas} from './studio-operations-openapi';
import {studioHostProvisioningPaths,studioHostProvisioningSchemas} from './studio-host-provisioning-openapi';
import {studioClientDeliveryPaths,studioClientDeliverySchemas} from './studio-client-delivery-openapi';
import {studioInferencePaths,studioInferenceSchemas} from './studio-inference-openapi';
import {z} from 'zod';
import {AGENT_TOOLS} from './agent-tools';
import {AGENT_CAPABILITIES} from './agent-policy';
import {claimInput,completeInput,failInput,leaseInput,runInput} from './agent-runs';
import {pluginInstallInput,pluginPatchInput} from './plugin-marketplace';
import {missionCreateInput,missionPatchInput} from './agent-missions';
import {uuid as uuidInput} from './security';
import {studioSetupInput,studioProjectInput,studioProjectPatchInput,studioDispatchInput,studioSpecInput,studioGateInput,studioArtifactInput,studioReviewInput,studioDeliveryInput} from './studio-protocol';

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
 ['413','Request body exceeds the endpoint limit.'],['415','Send an application/json request body.'],['429','Rate limit; honor Retry-After seconds.'],
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
 '/api/agent/identity':{get:operation('readAgentIdentity','Read the authenticated agent identity and grants for a pinned worker host; no run lease required',object({agent:object({id:uuid,companyId:uuid,name:{type:'string'},status:{const:'active'},capabilities:{type:'array',items:{type:'string',enum:AGENT_CAPABILITIES}}})}))},
 '/api/agent/runs/claim':{post:operation('claimAgentRun','Claim or replay one explicit request; use a new claimId after a confirmed idle result',object({run:nullable(ref('AgentRun')),leaseToken:{type:'string',writeOnly:false},leaseExpiresAt:date,replayed:{type:'boolean'}},['run','replayed']),input(claimInput))},
 '/api/agent/runs/{runId}/heartbeat':{post:operation('renewAgentRun','Renew the owned lease; cannot exceed the run deadline',object({run:ref('AgentRun'),leaseExpiresAt:date}),input(leaseInput),runParameters)},
 '/api/agent/runs/{runId}/context':{get:operation('readAgentRunContext','Read bounded source messages, effective capabilities and the approved runtime installation with a live lease',ref('AgentRunContext'),undefined,[...runParameters,{name:'X-Coatria-Run-Lease',in:'header',required:true,schema:{type:'string',minLength:20,maxLength:200}}])},
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
 ...(['storage_upload_reserve','storage_file_access'].includes(name)?{parameters:[{name:'X-Coatria-Storage-Transport',in:'header',required:true,schema:{type:'string',const:'1'},description:'Trusted worker transport v1: keep temporary transfer capabilities out of model context. Missing or unsupported version returns STORAGE_TRANSPORT_UPGRADE_REQUIRED.'}]}:{}),
 'x-coatria-capability':tool.capability,'x-coatria-mutating':tool.mutating,
 ...((['studio.write','studio.execute','studio.review'].includes(tool.capability)||name==='studio_staffing_get')?{'x-coatria-requester-roles':['owner','admin'],'x-coatria-approval-authority':tool.capability==='studio.review'?'machine_planning_policy_only':false}:{}),
 description:'Live run lease required in the JSON body. Keep requestId stable for the same logical mutation across retries. Mutation receipts commit with effects; reads return the current view. Input schemas cannot express every authorization or cross-field constraint; server validation remains authoritative.'+((['studio.write','studio.execute'].includes(tool.capability)||name==='studio_staffing_get')?' The requester must remain a company owner or administrator. Studio planning review tools may decide exact submissions under a separately approved machine-review policy. They never approve business gates, verify media or record client acceptance. Other studio tools retain their explicit proposal and reference boundaries.':''),
}};

const runProperties:Record<string,Schema>={
 ...Object.fromEntries(['id','companyId','conversationId','requestedBy','agentId'].map(key=>[key,uuid])),
 ...Object.fromEntries(['parentId','resultMessageId'].map(key=>[key,nullable(uuid)])),
 ...Object.fromEntries(['channel','prompt','requesterName','agentName','result','error'].map(key=>[key,{type:'string'}])),
 ...Object.fromEntries(['availableAt','createdAt','updatedAt'].map(key=>[key,date])),
 ...Object.fromEntries(['leaseExpiresAt','startedAt','deadlineAt','finishedAt'].map(key=>[key,nullable(date)])),
 status:{type:'string',enum:['queued','running','succeeded','failed','cancelled']},
 purpose:{type:'string',enum:['task','connection_test'],readOnly:true,description:'Server-assigned run purpose. Connection tests have no tool capabilities or source conversation history. Public run creation cannot select this field.'},
 attempts:{type:'integer',minimum:0,maximum:3},maxAttempts:{type:'integer',enum:[1,3],minimum:1,maximum:3,description:'Delegated specialist and planning review requests use one attempt; ordinary requests may allow up to three.'},artifactUrl:nullable({type:'string',format:'uri'}),
 capabilities:{type:'array',items:{type:'string',enum:AGENT_CAPABILITIES}},
};

const string:Schema={type:'string'},boolean:Schema={type:'boolean'};
const capabilities:Schema={type:'array',uniqueItems:true,maxItems:AGENT_CAPABILITIES.length,items:{type:'string',enum:AGENT_CAPABILITIES}};
const revision:Schema={type:'integer',minimum:1};
const runStatus:Schema={type:'string',enum:['queued','running','succeeded','failed','cancelled']};
const pluginParameters=[...companyParameters,parameter('installationId')];
const missionParameters=[...companyParameters,parameter('missionId')];
const pageParameters=[{name:'after',in:'query',schema:uuid,description:'Last item ID from the preceding page; cursor must belong to this company.'},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:50}}];
const oneTimeToken:Schema={type:'string',pattern:'^ca_',readOnly:true,description:'One-time Coatria worker credential. Store privately; this is never a model provider key.'};
const installationResult=object({installation:ref('PluginInstallation')});
const missionResult=object({mission:ref('AgentMission')});
const installResult=object({installation:ref('PluginInstallation'),token:nullable(oneTimeToken),replayed:boolean});
const createMissionResult=object({mission:ref('AgentMission'),replayed:boolean});
const originParameter={name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'},description:'Must match the configured Coatria application origin. Cookie authentication and current administrator membership are required.'};
const humanAdminOperation=(name:string,summary:string,result:Schema,body:Schema,parameters:unknown[])=>({...operation(name,summary,result,body,[...parameters,originParameter],true),'x-coatria-roles':['owner','admin'],description:'A current human owner or administrator must authorize this change. Agent bearer tokens cannot install plugins, increase permissions or budgets, rotate credentials, or enable missions. Server-side role, tenant and optimistic revision checks remain authoritative.'});
const createdResponses=(schema:Schema)=>({'200':response(schema,'Idempotent replay'),'201':response(schema,'Created'),...errors});

Object.assign(paths,{
 '/api/plugins/catalog':{get:{operationId:'listPluginCatalog',summary:'Read the public, versioned Coatria bridge catalog',description:'Curated Coatria manifests, not third-party executable packages. Availability in this catalog does not prove provider account access or a connected worker.',security:[],responses:{'200':response(ref('PluginCatalog'))}}},
 '/api/companies/{companyId}/plugin-installations':{
  get:operation('listPluginInstallations','List company plugin installations as a current member',object({installations:{type:'array',maxItems:100,items:ref('PluginInstallation')},hasMore:boolean,nextAfter:nullable(uuid)}),undefined,[...companyParameters,...pageParameters],true),
  post:{...humanAdminOperation('installPlugin','Install an exact curated manifest and issue a one-time worker credential',installResult,input(pluginInstallInput),companyParameters),responses:createdResponses(installResult)},
 },
 '/api/companies/{companyId}/plugin-installations/{installationId}':{
  get:operation('getPluginInstallation','Read a company installation without exposing credentials',installationResult,undefined,pluginParameters,true),
  patch:humanAdminOperation('updatePluginInstallation','Review and update a plugin; cancel its pending and running requests',installationResult,input(pluginPatchInput),pluginParameters),
 },
 '/api/companies/{companyId}/plugin-installations/{installationId}/rotate':{post:humanAdminOperation('rotatePluginCredential','Rotate the worker credential and cancel pending requests',object({installation:ref('PluginInstallation'),token:oneTimeToken}),input(z.object({revision:z.number().int().min(1).max(2147483646),expiresInDays:z.number().int().min(1).max(365).default(90)}).strict()),pluginParameters)},
 '/api/companies/{companyId}/plugin-installations/{installationId}/connection-test':{post:{...humanAdminOperation('testPluginConnection','Queue an actual model connection check with no tools or source history; a running worker and provider account are required',runResult,input(z.object({clientId:uuidInput}).strict()),pluginParameters),responses:createdResponses(runResult)}},
 '/api/companies/{companyId}/autonomy/missions':{
  get:operation('listAgentMissions','List bounded company missions as a current member',object({missions:{type:'array',maxItems:100,items:ref('AgentMission')},hasMore:boolean,nextAfter:nullable(uuid)}),undefined,[...companyParameters,...pageParameters],true),
  post:{...humanAdminOperation('createAgentMission','Create a bounded mission, paused unless explicitly activated',createMissionResult,input(missionCreateInput),companyParameters),responses:createdResponses(createMissionResult)},
 },
 '/api/companies/{companyId}/autonomy/missions/{missionId}':{
  get:operation('getAgentMission','Read current mission settings and last-cycle status',missionResult,undefined,missionParameters,true),
  patch:humanAdminOperation('updateAgentMission','Edit or pause a mission; an explicit resume acknowledges review of uncertain prior effects',missionResult,input(missionPatchInput),missionParameters),
 },
 '/api/companies/{companyId}/autonomy/missions/{missionId}/run-now':{post:{...humanAdminOperation('runAgentMissionNow','Queue the next approved cycle using a stable clientId',ref('MissionDispatchResult'),input(z.object({clientId:uuidInput}).strict()),missionParameters),responses:{...createdResponses(ref('MissionDispatchResult')),'409':response({oneOf:[ref('MissionDispatchResult'),ref('Error')]},'Mission cannot dispatch, or an authorization/idempotency constraint prevented dispatch. A mission refusal includes queued:false, reason and code.')}}},
 '/api/companies/{companyId}/autonomy/missions/{missionId}/runs':{get:operation('listAgentMissionCycles','Read recorded cycles in descending ordinal order',object({cycles:{type:'array',maxItems:100,items:ref('AgentMissionCycle')},hasMore:boolean,nextAfter:nullable({type:'integer',minimum:1,maximum:100})}),undefined,[...missionParameters,{name:'after',in:'query',schema:{type:'integer',minimum:1,maximum:101,default:101},description:'Exclusive ordinal cursor. Initially 101; then use nextAfter.'},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:20}}],true)},
 '/api/agent/autonomy/tick':{post:{...operation('tickAgentMissions','Queue due approved missions for this agent only',ref('AgentAutonomyTick'),input(z.object({maxMissions:z.number().int().min(1).max(5).default(5)}).strict())),description:'Worker-scoped scheduling only. The server enforces current administrator authorship, agent sponsor authority, cycle limits and duplicate-cycle prevention. It does not execute inference or authorize new missions. The provided worker calls this at most once per minute while idle and after uncertain work is reconciled; it must remain online. Failed or expired mission runs require administrator review before another cycle.','x-coatria-worker-scoped':true}},
});

const studioProjectParameters=[...companyParameters,parameter('projectId')];
const studioProjectResult=object({project:ref('StudioProject'),replayed:boolean});
const studioWrite=(name:string,summary:string,result:Schema,schema:z.ZodType,parameters:unknown[]=studioProjectParameters)=>({
 ...humanAdminOperation(name,summary,result,input(schema),parameters),
 description:'Current human owner or administrator required. Use a stable clientId and the current revision where specified. Studio roles and skill text do not grant permissions. Declared file references and metadata are not automated media verification. Recording an approval or acceptance is an administrator attestation; preparing a manifest does not transfer files.',
 responses:createdResponses(result),
});
Object.assign(paths,{
 '/api/companies/{companyId}/studio':{get:operation('readStudio','Read company studio structure and a bounded project page',ref('StudioSnapshot'),undefined,[...companyParameters,...pageParameters],true)},
 '/api/companies/{companyId}/studio/setup':{post:studioWrite('configureStudio','Apply a versioned company role structure without creating workers or changing grants',object({profile:ref('StudioProfile'),replayed:boolean}),studioSetupInput,companyParameters)},
 '/api/companies/{companyId}/studio/projects':{post:studioWrite('planStudioProject','Create a draft project, shots, tasks and production dependencies',studioProjectResult,studioProjectInput,companyParameters)},
 '/api/companies/{companyId}/studio/projects/{projectId}':{
  get:operation('readStudioProject','Read one complete project and its bounded version and review history',ref('StudioProjectDetail'),undefined,studioProjectParameters,true),
  patch:{...studioWrite('updateStudioProject','Update project scope or AI-use policy with revision protection and approval invalidation',studioProjectResult,studioProjectPatchInput),responses:{'200':response(studioProjectResult),...errors}},
 },
 '/api/companies/{companyId}/studio/projects/{projectId}/dispatch':{post:studioWrite('dispatchStudioWork','Queue one ready planning task for its assigned, explicitly permissioned agent',object({run:ref('AgentRun'),project:ref('StudioProject'),replayed:boolean}),studioDispatchInput)},
 '/api/companies/{companyId}/studio/projects/{projectId}/gates':{post:studioWrite('recordStudioGate','Record an authorized business approval or acceptance attestation',studioProjectResult,studioGateInput)},
 '/api/companies/{companyId}/studio/projects/{projectId}/artifacts':{post:studioWrite('registerStudioArtifact','Register an immutable external media reference; no file is fetched',object({artifact:ref('StudioArtifact'),project:ref('StudioProject'),replayed:boolean}),studioArtifactInput)},
 '/api/companies/{companyId}/studio/projects/{projectId}/reviews':{post:studioWrite('reviewStudioArtifact','Record an independent review of the exact latest media version',object({review:ref('StudioReview'),project:ref('StudioProject'),replayed:boolean}),studioReviewInput)},
 '/api/companies/{companyId}/studio/projects/{projectId}/deliveries':{post:studioWrite('prepareStudioDelivery','Prepare an approved-version manifest with no media transfer',object({delivery:ref('StudioDelivery'),project:ref('StudioProject'),replayed:boolean}),studioDeliveryInput)},
});

const studioRoleProperties={key:string,title:string,department:string,skills:{type:'array',items:string},reportsTo:nullable(string)};
const studioSpec=z.toJSONSchema(studioSpecInput,{io:'output',unrepresentable:'any'});
const studioSchemas:Record<string,Schema>={
 StudioSpec:studioSpec,
 StudioTemplateRole:object(studioRoleProperties),
 StudioRole:object({...studioRoleProperties,agentId:nullable(uuid),humanId:nullable(uuid),agentName:nullable(string),humanName:nullable(string),connectionState:nullable(string)},[...Object.keys(studioRoleProperties),'agentId','humanId']),
 StudioSkill:object({key:string,title:string,version:revision,instructions:string}),
 StudioTemplate:object({id:string,version:revision,name:string,description:string,roles:{type:'array',items:ref('StudioTemplateRole')},stages:{type:'array',items:string},gates:{type:'array',items:object({key:string,title:string})},integrations:{type:'array',items:object({key:string,title:string,requiredFor:string})}}),
 StudioProfile:object({templateId:string,revision,roles:{type:'array',maxItems:30,items:ref('StudioRole')}}),
 StudioProject:object({id:uuid,productionPath:{type:'string',enum:['vfx','higgsfield']},name:string,clientName:string,brief:string,dueDate:nullable({type:'string',format:'date'}),spec:ref('StudioSpec'),aiPolicy:{type:'string',enum:['unknown','allowed','restricted']},revision,status:{type:'string',enum:['intake','planning','production','review','delivery','delivered']},gates:{type:'object',additionalProperties:object({decision:{type:'string',enum:['approved','changes_requested']},note:string,recordedBy:uuid,at:date,deliveryId:uuid,source:{type:'string',enum:['authenticated_external_client']},clientDeliveryId:uuid,clientReceiptId:uuid,packageSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},['decision','note','recordedBy','at'])},createdAt:date,updatedAt:date,shotCount:{type:'integer',minimum:0},workCount:{type:'integer',minimum:0},acceptedCount:{type:'integer',minimum:0}},['id','productionPath','name','clientName','brief','dueDate','spec','aiPolicy','revision','status','gates','createdAt','updatedAt']),
 StudioShot:object({id:uuid,code:string,description:string,frameStart:{type:'integer',minimum:0},frameEnd:{type:'integer',minimum:0},handles:{type:'integer',minimum:0},disciplines:{type:'array',items:string}}),
 StudioWorkItem:object({id:uuid,taskId:uuid,title:string,stage:string,roleKey:string,shotId:nullable(uuid),dependencies:{type:'array',items:uuid},status:{type:'string',enum:['todo','doing','review','done']},readiness:{type:'string',enum:['blocked','ready','queued','running','review','accepted']},blockedReason:nullable(string),revision,execution:{type:'string',enum:['agent','dcc','creative','human']},agentId:nullable(uuid),humanId:nullable(uuid),submissionSummary:string,approvedBy:nullable(uuid),approvedAgentId:nullable(uuid),machineReviewId:nullable(uuid),runId:nullable(uuid),runStatus:nullable(runStatus)},['id','taskId','title','stage','roleKey','shotId','dependencies','status','readiness','blockedReason','revision','execution','agentId','humanId']),
 StudioArtifact:object({id:uuid,workItemId:uuid,name:string,version:revision,url:{type:'string',format:'uri',description:'External artifact reference or member-only JSON sequence manifest. Only storageVerification=server_bytes records verified stored file bytes; independent creative review remains separate.'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},frameStart:{type:'integer',minimum:0},frameEnd:{type:'integer',minimum:0},...(studioSpec as any).properties,notes:string,reviewStatus:{type:'string',enum:['pending','approved','changes_requested']},createdAt:date,producedBy:uuid,producedAgentId:nullable(uuid),executionProvenance:ref('StudioExecutionProvenance'),storageVerification:{const:'server_bytes'},referenceKind:{const:'image_sequence_manifest'}},['id','workItemId','name','version','url','sha256','frameStart','frameEnd','width','height','fpsNumerator','fpsDenominator','colorSpace','format','notes','reviewStatus']),
 StudioReview:object({id:uuid,artifactId:uuid,decision:{type:'string',enum:['approved','changes_requested']},note:string,technicalQc:boolean,reviewedBy:uuid,createdAt:date}),
 StudioDelivery:object({id:uuid,name:string,status:{type:'string',enum:['prepared','acknowledged']},manifest:{type:'object',additionalProperties:true,description:'Versioned delivery manifest; transportStatus records that preparing this document does not transfer media.'},note:string,createdAt:date}),
 StudioSnapshot:object({templates:{type:'array',items:ref('StudioTemplate')},skills:{type:'array',items:ref('StudioSkill')},profile:nullable(ref('StudioProfile')),projects:{type:'array',maxItems:100,items:ref('StudioProject')},hasMore:boolean,nextAfter:nullable(uuid)}),
 StudioProjectDetail:object({project:ref('StudioProject'),shots:{type:'array',maxItems:100,items:ref('StudioShot')},workItems:{type:'array',maxItems:1000,items:ref('StudioWorkItem')},artifacts:{type:'array',maxItems:1000,items:ref('StudioArtifact')},reviews:{type:'array',maxItems:1000,items:ref('StudioReview')},deliveries:{type:'array',maxItems:100,items:ref('StudioDelivery')},roles:{type:'array',maxItems:30,items:ref('StudioRole')},skills:{type:'array',items:ref('StudioSkill')}}),
};

const pluginSchemas:Record<string,Schema>={
 PluginRuntimeConfig:z.toJSONSchema(pluginInstallInput.shape.runtimeConfig,{io:'output',unrepresentable:'any'}),
 AgentCharacter:z.toJSONSchema(pluginInstallInput.shape.character,{io:'output',unrepresentable:'any'}),
 PluginModel:object({id:string,label:string,tier:{type:'string',enum:['flagship','balanced','economy','custom']},toolSupport:{type:'string',enum:['documented','unverified']}}),
 PluginProvider:object({id:string,models:{type:'array',items:ref('PluginModel')},allowCustomModel:boolean}),
 PluginManifest:object({id:string,version:string,name:string,description:string,summary:string,publisher:{type:'string',const:'Coatria'},vendor:string,category:{type:'string',enum:['coding','assistant','inference']},harness:{type:'string',enum:['codex','claude-code','custom']},runtime:{type:'string',enum:['codex-cli','claude-code-cli','responses','anthropic-messages','chat-completions']},providers:{type:'array',items:ref('PluginProvider')},capabilities,docsUrl:{type:'string',format:'uri'},setupFiles:{type:'array',items:{type:'string',pattern:'^/downloads/'}},credentialEnv:string,limitations:{type:'array',items:string},verifiedAt:{type:'string',format:'date'}}),
 PluginCatalog:object({version:string,plugins:{type:'array',items:ref('PluginManifest')}}),
 PluginInstallation:object({id:uuid,companyId:uuid,agentId:uuid,pluginId:string,manifestVersion:string,revision,runtimeConfig:ref('PluginRuntimeConfig'),character:ref('AgentCharacter'),createdAt:date,updatedAt:date,installedBy:uuid,name:string,status:{type:'string',enum:['active','paused','revoked']},invocationAccess:{type:'string',enum:['none','members','admins']},capabilities,lastSeenAt:nullable(date),expiresAt:date,connectionState:{type:'string',enum:['installed','worker_contact','worker_offline','paused','revoked','expired','sponsor_unavailable']}}),
 RuntimeInstallation:object({id:uuid,pluginId:string,manifestVersion:string,runtimeConfig:ref('PluginRuntimeConfig'),character:ref('AgentCharacter'),revision}),
 AgentContextMessage:object({id:uuid,body:string,parentId:nullable(uuid),sequence:{type:'string',pattern:'^[0-9]+$'},deletedAt:nullable(date),actorKind:{type:'string',enum:['human','agent']},actorId:nullable(uuid),authorName:string}),
 AgentRunContext:object({run:ref('AgentRun'),messages:{type:'array',maxItems:30,items:ref('AgentContextMessage')},capabilities,installation:nullable(ref('RuntimeInstallation'))}),
 AgentMission:object({id:uuid,companyId:uuid,agentId:uuid,agentName:string,createdBy:uuid,name:string,objective:string,intervalMinutes:{type:'integer',minimum:15,maximum:1440},maxCycles:{type:'integer',minimum:1,maximum:100},cyclesStarted:{type:'integer',minimum:0,maximum:100},status:{type:'string',enum:['active','paused','completed']},revision,nextRunAt:date,lastRunId:nullable(uuid),lastRunStatus:nullable(runStatus),pauseReason:string,createdAt:date,updatedAt:date}),
 MissionDispatchResult:object({mission:ref('AgentMission'),queued:boolean,runId:uuid,status:runStatus,replayed:boolean,reason:string,code:string},['mission','queued']),
 AgentMissionCycle:object({ordinal:{type:'integer',minimum:1,maximum:100},trigger:{type:'string',enum:['scheduled','manual']},createdAt:date,run:object({id:uuid,status:runStatus,agentName:string,prompt:string,result:string,error:string,createdAt:date,finishedAt:nullable(date),resultMessageId:nullable(uuid)})}),
 AgentAutonomyTick:object({runs:{type:'array',maxItems:5,items:object({missionId:uuid,runId:uuid,status:runStatus})},pausedMissionIds:{type:'array',maxItems:5,items:uuid},deferred:{type:'array',maxItems:5,items:object({missionId:uuid,queued:boolean,reason:string,code:string,runId:uuid,status:runStatus,replayed:boolean},['missionId','queued'])}}),
};

/** Public contract only. No credentials, company records or runtime queries. */
export const agentRuntimeOpenApi={
 openapi:'3.1.0',info:{title:'Coatria agent runtime',version:'1.9.0',description:'External execution, durable invocations, scoped company and studio tools, curated plugin installations and bounded autonomous missions. This is the REST protocol used by the downloadable worker and local MCP stdio bridge; it includes a bounded managed-host inference broker and is not a remote OAuth MCP server. Current human administrators approve provider/model choices, permissions, studio production gates and mission budgets; agent bearer tokens cannot elevate themselves. Human mutations require a same-origin Origin header; X-Coatria-User may pin the intended session identity. Direct external harnesses keep provider credentials on their workers. Explicit managed broker sessions keep the provider key only on the Coatria server; installation APIs never accept provider secrets. Read API errors before retrying. Legacy /api/agent/work and /api/agent/report are retired with HTTP 410.'},
 servers:[{url:'https://coatria.com',description:'Production; confirm deployment support before connecting'}],
 externalDocs:{description:'Worker, Codex and MCP setup',url:'https://coatria.com/downloads/AGENT_RUNTIME.md'},
 paths:{...projectStoragePaths,...higgsfieldPaths,...studioCreativeFollowupPaths,...paths,...studioOperationsPaths,...studioHostProvisioningPaths,...studioClientDeliveryPaths,...studioInferencePaths},components:{securitySchemes:{hostBearer:{type:'http',scheme:'bearer',description:'Company-scoped ch_ managed host credential, usable only for host identity and supervisor enrollment.'},executionBearer:{type:'http',scheme:'bearer',description:'Company-scoped ce_ render connector credential; never a provider or agent key.'},agentBearer:{type:'http',scheme:'bearer',description:'Company-scoped agent credential, never a provider key. Runs also require their live lease.'},sessionCookie:{type:'apiKey',in:'cookie',name:'coatria_session'}},schemas:{AgentRun:object(runProperties),...pluginSchemas,...studioSchemas,...studioOperationsSchemas,...studioHostProvisioningSchemas,...studioClientDeliverySchemas,...studioInferenceSchemas,...studioCreativeFollowupSchemas,Error:{type:'object',properties:{error:{type:'string'},code:{type:'string'}},required:['error']}}},
};
