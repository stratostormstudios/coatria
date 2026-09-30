/** Provider metadata is data, never permission to invoke another tool or fetch a
 * locator. This deliberately supports a small reviewed scalar parameter set. */
import {z} from 'zod';
import {fail,hashToken} from './security';
import type {HiggsfieldTool} from './higgsfield-mcp';
import {acceptsHiggsfieldReferenceSchema} from './higgsfield-reference-schema';
import {prepareHiggsfieldCostArguments} from './higgsfield-cost-arguments';

const identifier=z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const annotation=z.string().max(12000).optional();
const scalar=z.union([z.string().max(256),z.number().finite(),z.boolean()]);
const parameter=z.object({name:identifier,type:z.enum(['string','number','bool','string_array']),required:z.enum(['required','optional']),description:annotation,min:z.number().finite().optional(),max:z.number().finite().optional(),options:z.array(z.union([z.string().max(256),z.number().finite()])).min(1).max(256).optional(),default:scalar.optional(),nullable:z.boolean().optional(),format:z.string().max(64).optional(),pattern:z.string().max(2048).optional(),item_format:z.string().max(64).optional(),item_pattern:z.string().max(2048).optional()}).strict();
const model=z.object({id:identifier,name:annotation,provider_name:annotation,description:annotation,output_type:z.enum(['image','video']),parameters:z.array(parameter).max(64),medias:z.array(z.object({name:z.literal('medias'),type:z.literal('image'),roles:z.array(z.enum(['image','start_image','end_image'])).min(1).max(3),max:z.number().int().positive().max(100).optional(),required:z.boolean().optional(),description:annotation}).strict()).length(1),aspect_ratios:z.array(z.string().max(32).regex(/^(?:auto|[1-9]\d*(?:\.\d+)?:[1-9]\d*(?:\.\d+)?)$/)).max(64),durations:z.array(z.number().int().positive().max(3600)).min(1).max(100).optional(),duration_range:z.object({min:z.number().int().positive().max(3600),max:z.number().int().positive().max(3600)}).strict().optional(),tags:z.array(z.string().max(128)).max(128).optional(),supports_unlim:z.boolean().optional()}).strict();
const reviewed:Record<string,string>={quality:'string',resolution:'string',genre:'string',generate_audio:'bool'};
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(value);
export const higgsfieldModelDigest=(v:unknown)=>hashToken(canonical(v));
export type HiggsfieldModelContract={version:1;modelId:string;outputType:'image'|'video';parameters:Array<Omit<z.infer<typeof parameter>,'description'>>;medias:{roles:Array<'image'|'start_image'|'end_image'>;maximum:number|null;required:boolean};aspectRatios:string[];durations:number[]|null;durationRange:{min:number;max:number}|null};
function unsupported():never{fail(409,'Refresh this model in the company Higgsfield connection. Its exact reference roles and parameters must have a current supported contract.','HIGGSFIELD_MODEL_CONTRACT_UNSUPPORTED');}
export function normalizeHiggsfieldModelContract(input:unknown):HiggsfieldModelContract{
 const parsed=model.safeParse(input);if(!parsed.success)unsupported();const m=parsed.data;
 if(new Set(m.parameters.map(p=>p.name)).size!==m.parameters.length||new Set(m.medias[0].roles).size!==m.medias[0].roles.length||m.duration_range&&m.duration_range.min>m.duration_range.max)unsupported();
 for(const p of m.parameters){
  if(['model','prompt','medias','count','get_cost','use_unlim','aspect_ratio','duration'].includes(p.name))unsupported();
  if(p.required==='required'&&(!Object.hasOwn(reviewed,p.name)||reviewed[p.name]!==p.type||p.nullable||p.format||p.pattern||p.item_format||p.item_pattern))unsupported();
  if(p.min!==undefined&&p.max!==undefined&&p.min>p.max)unsupported();
 }
 return {version:1,modelId:m.id,outputType:m.output_type,parameters:m.parameters.map(({description:_description,...p})=>p),medias:{roles:m.medias[0].roles,maximum:m.medias[0].max??null,required:m.medias[0].required??false},aspectRatios:m.aspect_ratios,durations:m.durations??null,durationRange:m.duration_range??null};
}
/** Reconstruct and validate persisted contracts; never trust caller-made shapes. */
export function checkHiggsfieldModelContract(value:HiggsfieldModelContract):HiggsfieldModelContract{
 if(!value||value.version!==1)unsupported();
 const normalized=normalizeHiggsfieldModelContract({id:value.modelId,output_type:value.outputType,parameters:value.parameters,medias:[{name:'medias',type:'image',roles:value.medias?.roles,...value.medias?.maximum===null?{}:{max:value.medias?.maximum},required:value.medias?.required}],aspect_ratios:value.aspectRatios,...value.durations===null?{}:{durations:value.durations},...value.durationRange===null?{}:{duration_range:value.durationRange}});
 if(higgsfieldModelDigest(value)!==higgsfieldModelDigest(normalized))unsupported();return normalized;
}
/** Validate model-specific values and return the common transport fields. The
 * generic provider envelope is checked separately; no defaults are injected. */
export function validateHiggsfieldModelArguments(contract:HiggsfieldModelContract,toolName:string,params:Record<string,unknown>):Record<string,unknown>{
 const c=checkHiggsfieldModelContract(contract);if(toolName!==`generate_${c.outputType}`||params.model!==c.modelId)unsupported();
 const common={...params};
 for(const p of c.parameters){
  const supplied=Object.hasOwn(params,p.name);if(!supplied){if(p.required==='required')unsupported();continue;}
  if(!Object.hasOwn(reviewed,p.name)||reviewed[p.name]!==p.type||p.nullable||p.format||p.pattern||p.item_format||p.item_pattern||p.type==='string'&&!p.options)unsupported();
  const value=params[p.name],type=p.type==='bool'?'boolean':p.type;
  const schema={type,...p.options?{enum:p.options}:{},...p.min===undefined?{}:{minimum:p.min},...p.max===undefined?{}:{maximum:p.max}};
  if(!acceptsHiggsfieldReferenceSchema(schema,value))unsupported();delete common[p.name];
 }
 if(params.aspect_ratio!==undefined&&!c.aspectRatios.includes(params.aspect_ratio as string))unsupported();
 if(params.duration!==undefined){const d=params.duration;if(typeof d!=='number'||!Number.isInteger(d)||c.outputType!=='video'||(!c.durations&&!c.durationRange)||c.durations&&!c.durations.includes(d)||c.durationRange&&(d<c.durationRange.min||d>c.durationRange.max))unsupported();}
 if(!Array.isArray(params.medias)||params.medias.length<1||params.medias.length>8||c.medias.maximum!==null&&params.medias.length>c.medias.maximum)unsupported();
 if(params.medias.some(m=>!m||typeof m!=='object'||!c.medias.roles.includes(m.role)))unsupported();
 return common;
}
export function prepareHiggsfieldModelCostArguments(tool:string,input:Record<string,unknown>,contract:HiggsfieldModelContract):{params:Record<string,unknown>}{
 if(!input.params||typeof input.params!=='object'||Array.isArray(input.params)||Object.keys(input).some(k=>k!=='params'))unsupported();
 const params=input.params as Record<string,unknown>,common=validateHiggsfieldModelArguments(contract,tool,params);
 prepareHiggsfieldCostArguments(tool,{params:common});return {params:{...params,get_cost:true}};
}
/** The observed MCP schema advertises extra scalar model parameters through
 * additionalProperties:{}. Only values independently validated above may use
 * that extension; unrelated schema assertions are preserved and fail closed. */
export function higgsfieldModelTransportTool(tool:HiggsfieldTool,contract:HiggsfieldModelContract):HiggsfieldTool{
 const c=checkHiggsfieldModelContract(contract);
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const extendParams=(schema:unknown,depth=0):unknown=>{
  if(depth>12)unsupported();if(!object(schema))return schema;const next={...schema};
  for(const union of ['anyOf','oneOf'])if(Array.isArray(next[union]))next[union]=next[union].map(value=>extendParams(value,depth+1));
  // A model contract can fill only the provider's explicit open extension.
  // It never replaces a declared constraint or opens a closed params object.
  if(schema.type==='object'&&object(schema.properties)&&object(schema.additionalProperties)&&Object.keys(schema.additionalProperties).length===0){
   const properties={...schema.properties};for(const p of c.parameters)if(Object.hasOwn(reviewed,p.name)&&!Object.hasOwn(properties,p.name))properties[p.name]={type:p.type==='bool'?'boolean':p.type,...p.options?{enum:p.options}:{},...p.min===undefined?{}:{minimum:p.min},...p.max===undefined?{}:{maximum:p.max}};
   next.properties=properties;
  }return next;
 };
 if(!object(tool.inputSchema.properties))unsupported();
 const enriched={...tool.inputSchema,properties:{...tool.inputSchema.properties,params:extendParams(tool.inputSchema.properties.params)}};
 const convert=(value:unknown,depth=0):unknown=>{
  if(depth>12)unsupported();if(Array.isArray(value))return value.map(v=>convert(v,depth+1));if(!value||typeof value!=='object')return value;
  const result:Record<string,unknown>=Object.create(null);for(const [key,v] of Object.entries(value)){
   if(key==='$schema'){if(v!=='https://json-schema.org/draft/2020-12/schema')unsupported();continue;}
   if(key==='additionalProperties'&&v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0){result[key]=false;continue;}
   result[key]=convert(v,depth+1);
  }return result;
 };
 return {...tool,inputSchema:convert(enriched) as Record<string,unknown>};
}
