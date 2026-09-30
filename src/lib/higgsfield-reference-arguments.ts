import {prepareHiggsfieldCostArguments} from './higgsfield-cost-arguments';
import {fail} from './security';
import type {HiggsfieldTool} from './higgsfield-mcp';
import {acceptsHiggsfieldReferenceSchema} from './higgsfield-reference-schema';
import {higgsfieldModelTransportTool,validateHiggsfieldModelArguments,type HiggsfieldModelContract} from './higgsfield-model-contract';

type Media={role:'image'|'start_image'|'end_image';value:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function reject():never{fail(409,'Use confirmed Coatria references with one reviewed params object and a supported image or video tool. Do not also supply reference or media arguments.','HIGGSFIELD_REFERENCE_ARGUMENTS_UNSUPPORTED');}
function branches(schema:unknown,depth=0):Record<string,unknown>[] {
 if(!object(schema)||depth>8)return [];
 return [schema,...(['anyOf','oneOf'] as const).flatMap(key=>Array.isArray(schema[key])?schema[key].slice(0,32).flatMap(value=>branches(value,depth+1)):[])];
}
/** Only the server's resolved, approved roles/media IDs enter this function.
 * Caller media aliases and URLs cannot add a second unapproved disclosure path. */
export function bindHiggsfieldReferenceArguments(tool:HiggsfieldTool,input:Record<string,unknown>,medias:Media[],modelContract?:HiggsfieldModelContract):Record<string,unknown>{
 if(!['generate_image','generate_video'].includes(tool.name)||!object(input.params)||Object.hasOwn(input.params,'medias'))reject();
 // Reuse the reviewed scalar parameter grammar; it rejects unknown aliases,
 // serialized objects and raw locators. Restore the caller's get_cost semantics
 // because this is an exact proposal, not the later read-only estimate copy.
 const modelCommon=modelContract?validateHiggsfieldModelArguments(modelContract,tool.name,{...input.params,medias}):null;
 const {medias:_managed,...common}=modelCommon??{};
 const validated=prepareHiggsfieldCostArguments(tool.name,modelCommon?{params:common}:input),params={...validated.params,...modelContract?input.params:{}};
 if(Object.hasOwn(input.params,'get_cost'))params.get_cost=input.params.get_cost;else delete params.get_cost;
 if(medias.length<1||medias.length>8)reject();
 if(medias.filter(m=>m.role==='start_image').length>1||medias.filter(m=>m.role==='end_image').length>1)reject();
 const result={params:{...params,medias:medias.map(m=>({...m}))}};
 if(modelContract){
  if(Object.keys(input).some(key=>key!=='params')||!acceptsHiggsfieldReferenceSchema(higgsfieldModelTransportTool(tool,modelContract).inputSchema,result))reject();
  return result;
 }
 // Validate the complete emitted values, including sibling/union assertions.
 // A broad role enum proves neither a specific model nor its accepted inputs.
 // Until a reviewed per-model descriptor is integrated, require a literal
 // selected-model binding in an applicable advertised params branch.
 if(!acceptsHiggsfieldReferenceSchema(tool.inputSchema,result))reject();
 const p=object(tool.inputSchema.properties)?tool.inputSchema.properties.params:undefined;
 const supported=branches(p).some(candidate=>{
  if(candidate.type!=='object'||!object(candidate.properties)||!acceptsHiggsfieldReferenceSchema(candidate,result.params))return false;
  const model=candidate.properties.model;
  if(!object(model)||!(model.const===params.model||Array.isArray(model.enum)&&model.enum.length===1&&model.enum[0]===params.model))return false;
  return branches(candidate.properties.medias).some(schema=>{
   if(schema.type!=='array'||!acceptsHiggsfieldReferenceSchema(schema,result.params.medias))return false;
   return medias.every(media=>branches(schema.items).some(item=>{
    if(item.type!=='object'||!object(item.properties)||!acceptsHiggsfieldReferenceSchema(item,media))return false;
    const role=item.properties.role;
    return object(role)&&(role.const===media.role||Array.isArray(role.enum)&&role.enum.includes(media.role));
   }));
  });
 });
 if(!supported)reject();
 return result;
}
