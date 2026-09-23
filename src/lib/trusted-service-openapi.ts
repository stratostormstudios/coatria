import {z} from 'zod';
import {trustedServicePlanInput,trustedServiceStartInput,trustedServiceStopInput} from './trusted-service-protocol';

type Schema=Record<string,unknown>;
const uuid:Schema={type:'string',format:'uuid'},text:Schema={type:'string'},date:Schema={type:'string',format:'date-time'};
const nullable=(value:Schema):Schema=>({anyOf:[value,{type:'null'}]});
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const ref=(name:string):Schema=>({$ref:'#/components/schemas/'+name});
const response=(schema:Schema)=>({description:'Successful response',content:{'application/json':{schema}}});
const readiness=object({configured:{type:'boolean'},code:nullable(text),serviceVerified:{const:false}});
const provision=object({id:uuid,companyId:uuid,service:{enum:['archive','gateway']},revision:{type:'integer',minimum:1},phase:{enum:['planned','approved','submitting','uncertain','provisioning','running','stopping','stopped','failed','needs_attention']},plan:{type:'object',description:'Immutable reviewed server-owned service plan, including exact release/configuration hashes, fixed expiry and a conservative nonrefundable CPU reservation. Contains no credentials or caller-supplied commands.'},planHash:{type:'string',pattern:'^[a-f0-9]{64}$'},podId:nullable(text),providerStatus:nullable(text),expiresAt:date,stopRequestedAt:nullable(date),submittedAt:nullable(date),lastReconciledAt:nullable(date),errorCode:nullable(text),createdAt:date,computeStopped:{type:'boolean'},serviceVerified:{const:false},billingVerified:{const:false},credentialsRevoked:{const:false},readiness});
export const trustedServiceSchemas={TrustedServiceProvision:provision};
const base='/api/companies/{companyId}/studio/trusted-services';
function operation(operationId:string,summary:string,result:Schema,input?:z.ZodType,item=false,created=false){
 return {operationId,summary,description:'Current human company owner/admin session required. Agents cannot approve spending or supply infrastructure credentials. A running provider state is not verified application readiness. Unknown create outcomes are reconciled without creating a replacement. Stop confirmation does not certify billing settlement or credential revocation.',security:[{sessionCookie:[]}],'x-coatria-roles':['owner','admin'],parameters:[...['companyId',...item?['provisionId']:[]].map(name=>({name,in:'path',required:true,schema:uuid})),...input?[{name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'}}]:[]],...input?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(input,{io:'input',unrepresentable:'any'})}}}}:{},responses:{'200':response(result),...created?{'201':response(result)}:{},...Object.fromEntries(['400','401','403','404','409','413','415','429','500','503'].map(status=>[status,response(ref('Error'))]))}};
}
const result=object({provision:ref('TrustedServiceProvision'),replayed:{type:'boolean'}});
export const trustedServicePaths={
 [base]:{get:operation('listTrustedServices','Read fixed archive/gateway service plans and readiness',object({provisions:{type:'array',maxItems:50,items:ref('TrustedServiceProvision')},readiness:object({archive:readiness,gateway:readiness})})),post:operation('planTrustedService','Prepare a fixed service plan without starting compute',result,trustedServicePlanInput,false,true)},
 [base+'/{provisionId}']:{get:operation('getTrustedService','Read an exact company-owned service plan',object({provision:ref('TrustedServiceProvision')}),undefined,true)},
 [base+'/{provisionId}/start']:{post:operation('startTrustedService','Approve the current hashed plan and reserve CPU allowance',result,trustedServiceStartInput,true)},
 [base+'/{provisionId}/stop']:{post:operation('stopTrustedService','Persist a stop request and reconcile the exact owned machine',result,trustedServiceStopInput,true)},
 [base+'/{provisionId}/reconcile']:{post:operation('reconcileTrustedService','Refresh the owned service without granting a new launch',object({provision:ref('TrustedServiceProvision')}),z.object({clientId:z.uuid()}).strict(),true)},
};
