import {z} from 'zod';
import {draftStudioStaffing} from './studio-staffing-protocol';
import type {StudioInferenceValidationResponse} from './studio-inference-protocol';

type Issue=StudioInferenceValidationResponse['issues'][number];
type JsonSchema=Record<string,unknown>;
const field=/^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const issueCodes=new Set(['invalid_type','invalid_value','too_small','too_big','invalid_format','unrecognized_keys','custom','invalid_union']);
const types=new Set(['string','number','integer','boolean','object','array','null']);
const schemas=new WeakMap<z.ZodType,JsonSchema>();
const unsafe=():never=>{throw new Error('Provider completion is not JSON-safe.');};
function safeString(value:string){
 for(let i=0;i<value.length;i++){
  const unit=value.charCodeAt(i);
  if(unit===0)unsafe();
  if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))unsafe();}
  else if(unit>=0xdc00&&unit<=0xdfff)unsafe();
 }
}

/** JSONB rejects NUL and unpaired UTF-16 even inside otherwise valid JSON.
 * Reject non-JSON JavaScript values too: hashing/storage must not silently
 * omit properties, invoke accessors, coerce numbers, or serialize prototypes. */
export function assertInferenceJsonSafe(value:unknown):void{
 const ancestors=new Set<object>();
 const pending:Array<{value:unknown;exit?:boolean;depth:number}>=[{value,depth:0}];
 while(pending.length){
  const item=pending.pop()!,current=item.value;
  if(item.exit){ancestors.delete(current as object);continue;}
  if(item.depth>512)unsafe();
  if(current===null||typeof current==='boolean')continue;
  if(typeof current==='string'){safeString(current);continue;}
  if(typeof current==='number'){if(!Number.isFinite(current))unsafe();continue;}
  if(typeof current!=='object')unsafe();
  const object=current as object,array=Array.isArray(object),prototype=Object.getPrototypeOf(object);
  if(ancestors.has(object)||(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null))unsafe();
  ancestors.add(object);pending.push({value:object,exit:true,depth:item.depth});
  const keys=Reflect.ownKeys(object);
  if(array&&keys.length!==(object as unknown[]).length+1)unsafe();
  for(const key of keys){
   if(typeof key!=='string')return unsafe();
   if(array&&key==='length')continue;
   safeString(key);
   if(array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=(object as unknown[]).length))unsafe();
   const descriptor=Object.getOwnPropertyDescriptor(object,key)!;
   if(!('value' in descriptor)||!descriptor.enumerable)unsafe();
   pending.push({value:descriptor.value,depth:item.depth+1});
  }
 }
}

const objectSchema=(value:unknown):value is JsonSchema=>!!value&&typeof value==='object'&&!Array.isArray(value);
function schemaFor(schema:z.ZodType){
 let result=schemas.get(schema);
 if(!result){result=z.toJSONSchema(schema,{io:'input'}) as JsonSchema;schemas.set(schema,result);}
 return result;
}
/** Follow only local schema references. Neither input keys nor issue messages
 * can select a remote schema or supply feedback content. */
function variants(nodes:JsonSchema[],root:JsonSchema):JsonSchema[]{
 const result:JsonSchema[]=[],pending=[...nodes],seen=new Set<JsonSchema>();
 while(pending.length){
  const node=pending.pop()!;if(seen.has(node))continue;seen.add(node);
  if(typeof node.$ref==='string'&&node.$ref.startsWith('#/')){
   let resolved:unknown=root;
   for(const part of node.$ref.slice(2).split('/'))resolved=objectSchema(resolved)?resolved[part.replace(/~1/g,'/').replace(/~0/g,'~')]:undefined;
   if(objectSchema(resolved))pending.push(resolved);
  }
  let composite=false;
  for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(node[key])){pending.push(...node[key].filter(objectSchema));composite=true;}
  if(!composite||node.type!==undefined||node.properties!==undefined||node.enum!==undefined||node.const!==undefined)result.push(node);
 }
 return result;
}
function location(root:JsonSchema,inputPath:readonly PropertyKey[]){
 let nodes=variants([root],root);const path:string[]=[];
 for(const part of inputPath.slice(0,12)){
  const direct:JsonSchema[]=[],dynamic:JsonSchema[]=[];
  for(const node of nodes){
   const properties=node.properties;
   if(typeof part==='string'&&field.test(part)&&objectSchema(properties)&&Object.hasOwn(properties,part)&&objectSchema(properties[part]))direct.push(properties[part]);
   if(typeof part==='number'){
    if(Array.isArray(node.prefixItems)&&Number.isInteger(part)&&part>=0&&objectSchema(node.prefixItems[part]))dynamic.push(node.prefixItems[part]);
    else if(objectSchema(node.items))dynamic.push(node.items);
   }else{
    if(objectSchema(node.additionalProperties))dynamic.push(node.additionalProperties);
    if(objectSchema(node.patternProperties))dynamic.push(...Object.values(node.patternProperties).filter(objectSchema));
   }
  }
  path.push(direct.length?String(part):'*');
  nodes=variants(direct.length?direct:dynamic,root);
 }
 return {path,nodes};
}
function hints(nodes:JsonSchema[]):Pick<Issue,'expected'|'allowed'|'minimum'|'maximum'>{
 const result:Pick<Issue,'expected'|'allowed'|'minimum'|'maximum'>={};
 const declared=[...new Set(nodes.flatMap(node=>typeof node.type==='string'?[node.type]:Array.isArray(node.type)?node.type:[]).filter((value):value is string=>typeof value==='string'&&types.has(value)))];
 if(declared.length===1)result.expected=declared[0];
 const values=nodes.flatMap(node=>Array.isArray(node.enum)?node.enum:Object.hasOwn(node,'const')?[node.const]:[]);
 if(values.length&&values.every(value=>typeof value==='string'&&value.length<=160)){
  const allowed=[...new Set(values as string[])];
  if(allowed.length<=40){for(const value of allowed)safeString(value);result.allowed=allowed;}
 }
 for(const [target,keys] of [['minimum',['minimum','minLength','minItems']],['maximum',['maximum','maxLength','maxItems']]] as const){
  const bounds=[...new Set(nodes.flatMap(node=>keys.map(key=>node[key])).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e9))];
  if(bounds.length===1)result[target]=bounds[0];
 }
 return result;
}
function feedbackIssues(schema:z.ZodType,issues:readonly z.core.$ZodIssue[]):Issue[]{
 const root=schemaFor(schema),result:Issue[]=[],seen=new Set<string>();
 // Zod union errors contain branch issues. Their messages, supplied values,
 // unrecognized keys and custom params are deliberately never copied.
 const pending=issues.slice(0,256);let examined=0;
 while(pending.length&&result.length<12&&examined++<256){
  const issue=pending.shift()!;
  if(issue.code==='invalid_union'&&issue.errors.length){pending.unshift(...issue.errors.flat().slice(0,256).map(child=>({...child,path:[...issue.path,...child.path]})));continue;}
  const {path,nodes}=location(root,issue.path);
  const safe:Issue={path,code:issueCodes.has(issue.code)?issue.code:'custom',...hints(nodes)},key=JSON.stringify(safe);
  if(!seen.has(key)){seen.add(key);result.push(safe);}
 }
 return result.length?result:[{path:[],code:'custom'}];
}

// Exact messages emitted by the pure grouping validator only. These are not
// parser substrings or a generic catch for authorization/database failures.
const staffingFailures:Readonly<Record<string,Issue>>={
 'Specialists must cover each required role exactly once within the requested team size, leaving a separate slot for any planning reviewer.':{path:['specialists'],code:'staffing_roles'},
 'Specialist names and existing agent identities must be unique. Combine roles to reuse one agent.':{path:['specialists'],code:'staffing_identity'},
 'A separate planning reviewer requires at least two AI team members.':{path:['teamSize'],code:'staffing_reviewer',minimum:2},
 'Give the separate planning reviewer a distinct name.':{path:['planningReviewer','name'],code:'staffing_reviewer'},
};

/** Preserve original parsed arguments for exact broker hashing. Defaults,
 * trims and other schema transforms belong to the authenticated tool API. */
export function validateInferenceArguments(name:string,schema:z.ZodType,raw:unknown):{args:unknown;argumentEncoding:'raw'|'json';validation?:StudioInferenceValidationResponse}{
 assertInferenceJsonSafe(raw);
 let args=raw;
 if(typeof raw==='string'){
  try{args=JSON.parse(raw);}catch(error){
   if(!(error instanceof SyntaxError))throw error;
   return {args:raw,argumentEncoding:'raw',validation:{version:1,executed:false,code:'ARGUMENT_JSON_INVALID',issues:[{path:[],code:'invalid_format'}]}};
  }
 }
 assertInferenceJsonSafe(args);
 const parsed=schema.safeParse(args);
 if(!parsed.success)return {args,argumentEncoding:'json',validation:{version:1,executed:false,code:'ARGUMENT_SCHEMA_INVALID',issues:feedbackIssues(schema,parsed.error.issues)}};
 if(name==='studio_staffing_propose'){
  try{draftStudioStaffing(parsed.data);}catch(error){
   if(!(error instanceof Error)||Object.getPrototypeOf(error)!==Error.prototype||!Object.hasOwn(staffingFailures,error.message))throw error;
   const issue=staffingFailures[error.message];
   return {args,argumentEncoding:'json',validation:{version:1,executed:false,code:'STAFFING_VALIDATION_INVALID',issues:[{...issue,path:[...issue.path]}]}};
  }
 }
 return {args,argumentEncoding:'json'};
}
