import {z} from 'zod';
import {executorCredentialInput} from './company-runtime-executor';
type Schema=Record<string,unknown>;
const uuid={type:'string',format:'uuid'},date={type:'string',format:'date-time'};
const credential={type:'object',additionalProperties:false,properties:{id:uuid,configurationId:uuid,expiresAt:date,createdAt:date,revokedAt:{anyOf:[date,{type:'null'}]}},required:['id','configurationId','expiresAt','createdAt','revokedAt']};
const response=(schema:Schema)=>({description:'Response',content:{'application/json':{schema}}});
function operation(operationId:string,summary:string,method:'GET'|'POST'|'DELETE'){
 const properties=method==='DELETE'?{revoked:{const:true}}:{credential:{anyOf:[credential,{type:'null'}]},...method==='POST'?{replayed:{type:'boolean'}}:{}};
 const requestSchema=z.toJSONSchema(executorCredentialInput,{io:'input'}) as any;requestSchema.properties.token.writeOnly=true;
 return {operationId,summary,description:'Requires a current platform runtime operator grant and human company administrator membership. The short-lived Vercel OIDC token must have a verified signature, exact reviewed team and project, and expiry beyond the archive policy deadline. It is encrypted for this immutable configuration and never returned. Replacement is forbidden while archive compute is active or uncertain. Revocation disables new work immediately; provider shutdown remains a separately reconciled action. No compute is started and no charges are approved.',security:[{sessionCookie:[]}],'x-coatria-roles':['platform_runtime_operator_and_company_admin'],parameters:[...['companyId','configurationId',...method==='DELETE'?['credentialId']:[]].map(name=>({name,in:'path',required:true,schema:uuid})),...method!=='GET'?[{name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'}}]:[]],...method==='POST'?{requestBody:{required:true,content:{'application/json':{schema:requestSchema}}}}:{},responses:{'200':response({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}),...method==='POST'?{'201':response({type:'object',additionalProperties:false,properties,required:Object.keys(properties)})}:{},...Object.fromEntries(['400','401','403','404','409','413','415','500','503'].map(status=>[status,response({$ref:'#/components/schemas/Error'})]))}};
}
const path='/api/operator/companies/{companyId}/runtime-configurations/archive/{configurationId}/executor-credentials';
export const companyRuntimeExecutorPaths={
 [path]:{get:operation('getArchiveExecutorCredential','Read executor credential metadata','GET'),post:operation('saveArchiveExecutorCredential','Install a scoped write-only executor credential','POST')},
 [path+'/{credentialId}']:{delete:operation('revokeArchiveExecutorCredential','Revoke an exact executor credential','DELETE')},
};
