import {z} from 'zod';
import {verifyProjectGatewayInput,revokeProjectGatewayInput} from './project-gateway-bindings';
type Schema=Record<string,unknown>;
const uuid={type:'string',format:'uuid'},object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const gateway=object({origin:{type:'string',format:'uri',pattern:'^https://[a-z0-9-]+-4190\\.proxy\\.runpod\\.net$'},expiresAt:{type:'string',format:'date-time'},bindingId:uuid,provisionId:uuid,configurationHash:{type:'string',pattern:'^[a-f0-9]{64}$'}});
const result=object({gateway:{anyOf:[gateway,{type:'null'}]}}),json=(schema:Schema)=>({'application/json':{schema}});
function operation(operationId:string,summary:string,response:Schema,input?:z.ZodType){return {operationId,summary,security:[{sessionCookie:[]}],'x-coatria-roles':['owner','admin'],description:'Current human company owner/admin only. A provision ID selects the immutable company/project-scoped gateway. No URL, hostname, command or provider credential can be supplied. Verification requires a bounded signed fresh-nonce handshake, running reconciled provider identity and an active exact runtime configuration. Binding replacement, revocation, config changes, service stop or expiry invalidate existing member and external-client capabilities. Issued grants never outlive the service deadline. Reload the browser after binding to receive the updated authenticated Content Security Policy. Running status and HTTP 200 alone are insufficient.',parameters:[...['companyId','projectId'].map(name=>({name,in:'path',required:true,schema:uuid})),...input?[{name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'}}]:[]],...input?{requestBody:{required:true,content:json(z.toJSONSchema(input,{io:'input',unrepresentable:'any'}))}}:{},responses:{'200':{description:'Current project gateway or revocation receipt.',content:json(response)},...Object.fromEntries(['400','401','403','404','409','413','415','429','500','502','503'].map(status=>[status,{description:'Verification, current authority, input or service state rejected.',content:json({$ref:'#/components/schemas/Error'})}]))}};}
export const projectGatewayPaths={
 '/api/companies/{companyId}/studio/projects/{projectId}/gateway':{
  get:operation('getProjectGateway','Read the currently verified live project gateway',result),
  post:operation('verifyProjectGateway','Verify a known service and create a new project access epoch',result,verifyProjectGatewayInput),
  delete:operation('revokeProjectGateway','Revoke an exact project gateway epoch without deleting stored files',object({bindingId:uuid,revoked:{const:true}}),revokeProjectGatewayInput),
 },
};
