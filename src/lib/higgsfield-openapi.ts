import {z} from 'zod';
import {higgsfieldProposalInput,higgsfieldExecuteInput,higgsfieldReadInput} from './higgsfield-protocol';
import {studioGenerationImportInput,studioStorageReferenceInput} from './studio-creative-assets-protocol';
const schema=(value:z.ZodType)=>z.toJSONSchema(value,{io:'input',unrepresentable:'any'});
const parameter=(name:string,where='path',required=true)=>({name,in:where,required,schema:{type:'string',format:'uuid'}});
const company=[parameter('companyId')],project=[...company,parameter('projectId')];
const errors=Object.fromEntries([400,401,403,404,409,413,429,502,503].map(code=>[String(code),{description:'Validation, company authority, revision, connection or bounded-provider error. Never retry a possibly sent generation automatically.'}]));
function operation(summary:string,parameters:unknown[],input?:z.ZodType,extra:Record<string,unknown>={}){return {summary,tags:['Higgsfield production'],security:[{sessionCookie:[]}],parameters,...input?{requestBody:{required:true,content:{'application/json':{schema:schema(input)}}}}:{},responses:{'200':{description:'Company-scoped response. Imported generation reports and storage metadata do not verify actual media or delivery.'},...input?{'201':{description:'Created immutable request or reference.'}}:{},...errors},...extra};}
export const higgsfieldPaths={
 '/api/companies/{companyId}/higgsfield':{get:operation('Official MCP connection status and discovered supported tools; no credentials.',company)},
 '/api/companies/{companyId}/higgsfield/connect':{post:operation('Begin a ten-minute session-bound, single-use PKCE authorization with the official Higgsfield service. Administrator only; no generations.',company,z.object({}).strict())},
 '/api/companies/{companyId}/higgsfield/disconnect':{post:operation('Disconnect local company access and erase encrypted OAuth credentials. Existing provider jobs are not cancelled.',company,z.object({revision:z.number().int().positive()}).strict())},
 '/api/companies/{companyId}/higgsfield/read':{post:operation('Invoke an explicitly allowed discovered read tool using company credentials. Administrator only.',company,higgsfieldReadInput)},
 '/api/companies/{companyId}/higgsfield/requests':{
  get:operation('Page bounded request summaries or requestId for one exact receipt. Follow nextAfter; default 20, maximum 50.',[...company,parameter('projectId','query'),parameter('requestId','query',false),parameter('after','query',false),{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}}]),
  post:operation('Prepare a generation request. Does not spend credits. Pins project revision, connection revision, exact tool and arguments.',company,higgsfieldProposalInput)},
 '/api/companies/{companyId}/higgsfield/requests/{requestId}/execute':{post:operation('Administrator approves the exact argument hash and provider credit charge. Requires current project gates. Dispatch intent is committed before tools/call; returned is not media completion; uncertain is never replayed.',[...company,parameter('requestId')],higgsfieldExecuteInput)},
 '/api/higgsfield/callback':{get:operation('Official OAuth GET callback, bound to initiating administrator session and exact state. Codes are exchanged once; redirects to Plugins.',[{name:'state',in:'query',required:true,schema:{type:'string'}},{name:'code',in:'query',schema:{type:'string'}},{name:'iss',in:'query',schema:{type:'string'}},{name:'error',in:'query',schema:{type:'string'}}],undefined,{responses:{'303':{description:'Return to Plugins without exposing tokens.'},...errors}})},
 '/api/companies/{companyId}/studio/projects/{projectId}/creative-assets/generations':{
  get:operation('Page immutable imported generation identities and latest reported observations. Provider existence/media bytes are not verified.',[...project,parameter('after','query',false),{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:25}}]),
  post:operation('Import a job observation from the official Higgsfield plugin. Append-only provenance, no provider execution, media approval or delivery.',project,studioGenerationImportInput)},
 '/api/companies/{companyId}/studio/projects/{projectId}/creative-assets/generations/{generationId}':{get:operation('Exact imported generation with paged immutable observations.',[...project,parameter('generationId')])},
 '/api/companies/{companyId}/studio/projects/{projectId}/creative-assets/storage-references':{
  get:operation('Page immutable storage index snapshots and current unchanged/changed/missing/revoked status. No file bytes or mount access.',[...project,parameter('after','query',false)]),
  post:operation('Pin a same-company drive index path, expected size and mtime to the project. Does not upload or access the original.',project,studioStorageReferenceInput)},
 '/api/companies/{companyId}/studio/projects/{projectId}/creative-assets/storage-references/{referenceId}':{get:operation('Exact storage reference and current index status.',[...project,parameter('referenceId')])},
};
for(const [path,methods]of Object.entries(higgsfieldPaths))for(const [method,operation]of Object.entries(methods))Object.assign(operation,{operationId:'higgsfield_'+method+'_'+path.replace(/[^a-zA-Z0-9]+/g,'_')});
