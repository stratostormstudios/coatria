import {fail} from './security';
import {acceptsHiggsfieldReferenceSchema} from './higgsfield-reference-schema';

type ModelRead={tool:'models_get'|'models_list'|'models_explore';arguments:Record<string,unknown>};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function reviewedSchema(schema:unknown):unknown{
 if(!object(schema)||!Object.hasOwn(schema,'$schema'))return schema;
 if(schema.$schema!=='https://json-schema.org/draft/2020-12/schema')return null;
 // Only this reviewed root dialect declaration is an annotation. Preserve
 // every assertion and nested schema for the bounded matcher to check.
 const {$schema:_dialect,...assertions}=schema;return assertions;
}

/** A server-selected metadata read, never arbitrary provider arguments, URLs or
 * actions. Validate the entire emitted argument object, including required
 * fields and union constraints, against the current advertised schema. */
export function selectHiggsfieldModelRefresh(tools:unknown,modelId?:string):ModelRead{
 if(modelId!==undefined&&(typeof modelId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(modelId)))fail(400,'Choose one exact supported model identifier.','HIGGSFIELD_MODEL_REFRESH_INVALID');
 const candidates:ModelRead[]=modelId===undefined
  ?[{tool:'models_list',arguments:{}},{tool:'models_explore',arguments:{action:'list'}}]
  :[{tool:'models_get',arguments:{model_id:modelId}},{tool:'models_explore',arguments:{action:'get',model_id:modelId}}];
 if(Array.isArray(tools)&&tools.length<=512){
  for(const candidate of candidates){
   const matches=tools.filter(tool=>object(tool)&&tool.name===candidate.tool);
   if(matches.length===1&&acceptsHiggsfieldReferenceSchema(reviewedSchema(matches[0].inputSchema),candidate.arguments))return candidate;
  }
 }
 fail(409,'The connected account does not advertise a supported read-only model lookup. Ask an administrator to review its model tools.','HIGGSFIELD_MODEL_REFRESH_UNSUPPORTED');
}
