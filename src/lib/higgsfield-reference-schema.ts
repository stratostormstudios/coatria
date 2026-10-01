/** Deliberately bounded JSON Schema subset for provider argument compatibility.
 * Unknown assertions fail closed. Provider regexes, references and executable
 * descriptions are never evaluated; successful validation is not model qualification. */
type ObjectValue=Record<string,unknown>;
const object=(value:unknown):value is ObjectValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const annotations=new Set(['title','description','default','examples','deprecated']);
const common=new Set(['type','enum','const','anyOf','oneOf']);
const specific:Record<string,Set<string>>={
 object:new Set(['properties','required','additionalProperties','minProperties','maxProperties']),
 array:new Set(['items','minItems','maxItems','uniqueItems']),
 string:new Set(['minLength','maxLength','format']),
 number:new Set(['minimum','maximum','exclusiveMinimum','exclusiveMaximum']),
 integer:new Set(['minimum','maximum','exclusiveMinimum','exclusiveMaximum']),
 boolean:new Set(),null:new Set(),
};
function equal(a:unknown,b:unknown,depth=0):boolean{
 if(depth>12)return false;if(a===b)return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,index)=>equal(value,b[index],depth+1));
 if(object(a)&&object(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key],depth+1));}
 return false;
}
const bound=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>=0;
/** Exact supplied values must be advertised. additionalProperties:true is not
 * authority to forward unreviewed parameters or alternative media aliases. */
export function acceptsHiggsfieldReferenceSchema(schema:unknown,value:unknown):boolean{
 let nodes=0;
 function accepts(current:unknown,input:unknown,depth:number):boolean{
  if(!object(current)||depth>12||++nodes>4096)return false;
  const type=typeof current.type==='string'?current.type:null;
  if(current.type!==undefined&&(!type||!Object.hasOwn(specific,type)))return false;
  if(Object.keys(current).some(key=>!annotations.has(key)&&!common.has(key)&&!(type&&specific[type].has(key))))return false;
  if(current.enum!==undefined&&(!Array.isArray(current.enum)||!current.enum.length||current.enum.length>256||!current.enum.some(item=>equal(item,input))))return false;
  if(Object.hasOwn(current,'const')&&!equal(current.const,input))return false;
  for(const union of ['anyOf','oneOf'] as const){
   if(current[union]===undefined)continue;
   const choices=current[union];if(!Array.isArray(choices)||!choices.length||choices.length>32)return false;
   const matches=choices.filter(choice=>accepts(choice,input,depth+1)).length;
   if(union==='anyOf'?matches===0:matches!==1)return false;
  }
  if(type===null)return Object.hasOwn(current,'const')||current.enum!==undefined||current.anyOf!==undefined||current.oneOf!==undefined;
  if(type==='object'){
   if(!object(input)||!object(current.properties))return false;
   const keys=Object.keys(input);
   if(current.additionalProperties!==undefined&&typeof current.additionalProperties!=='boolean')return false;
   if(current.required!==undefined&&(!Array.isArray(current.required)||!current.required.every(key=>typeof key==='string'&&Object.hasOwn(input,key)&&Object.hasOwn(current.properties as ObjectValue,key))))return false;
   for(const [key,maximum] of [['minProperties',false],['maxProperties',true]] as const)if(current[key]!==undefined&&(!bound(current[key])||(maximum?keys.length>(current[key] as number):keys.length<(current[key] as number))))return false;
   return keys.every(key=>Object.hasOwn(current.properties as ObjectValue,key)&&accepts((current.properties as ObjectValue)[key],input[key],depth+1));
  }
  if(type==='array'){
   if(!Array.isArray(input)||input.length>100||!object(current.items))return false;
   for(const [key,maximum] of [['minItems',false],['maxItems',true]] as const)if(current[key]!==undefined&&(!bound(current[key])||(maximum?input.length>(current[key] as number):input.length<(current[key] as number))))return false;
   if(current.uniqueItems!==undefined&&typeof current.uniqueItems!=='boolean')return false;
   if(current.uniqueItems===true&&input.some((item,index)=>input.slice(0,index).some(other=>equal(other,item))))return false;
   return input.every(item=>accepts(current.items,item,depth+1));
  }
  if(type==='string'){
   if(typeof input!=='string')return false;const length=Array.from(input).length;
   for(const [key,maximum] of [['minLength',false],['maxLength',true]] as const)if(current[key]!==undefined&&(!bound(current[key])||(maximum?length>(current[key] as number):length<(current[key] as number))))return false;
   if(current.format!==undefined&&(current.format!=='uuid'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input)))return false;
   return true;
  }
  if(type==='number'||type==='integer'){
   if(typeof input!=='number'||!Number.isFinite(input)||type==='integer'&&!Number.isSafeInteger(input))return false;
   for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum'] as const){
    const limit=current[key];if(limit===undefined)continue;if(typeof limit!=='number'||!Number.isFinite(limit))return false;
    if(key==='minimum'&&input<limit||key==='maximum'&&input>limit||key==='exclusiveMinimum'&&input<=limit||key==='exclusiveMaximum'&&input>=limit)return false;
   }
   return true;
  }
  return type==='boolean'?typeof input==='boolean':input===null;
 }
 try{return accepts(schema,value,0);}catch{return false;}
}
