import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bindHiggsfieldReferenceArguments} from '../src/lib/higgsfield-reference-arguments';
import {acceptsHiggsfieldReferenceSchema} from '../src/lib/higgsfield-reference-schema';
import {higgsfieldProposalInput} from '../src/lib/higgsfield-protocol';
import type {HiggsfieldTool} from '../src/lib/higgsfield-mcp';
const paramsSchema={type:'object',properties:{model:{type:'string',const:'fixture-model'},prompt:{type:'string'},duration:{type:'integer',minimum:1,maximum:10},get_cost:{type:'boolean'},medias:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{role:{type:'string',enum:['image','start_image','end_image']},value:{type:'string',format:'uuid'}},required:['role','value'],additionalProperties:false}}},required:['model','medias'],additionalProperties:false};
const tool:HiggsfieldTool={name:'generate_video',description:'fixture',inputSchema:{type:'object',properties:{params:paramsSchema},required:['params'],additionalProperties:false}};
const medias=[{role:'start_image' as const,value:randomUUID()}];
test('managed arguments preserve reviewed scalar values and replace no caller media',()=>{
 for(const cost of [undefined,false,true]){
  const input={params:{model:'fixture-model',prompt:'Approved product.',duration:5,...cost===undefined?{}:{get_cost:cost}}};const copy=structuredClone(input),result=bindHiggsfieldReferenceArguments(tool,input,medias);
  assert.deepEqual(input,copy);assert.deepEqual(result,{params:{...input.params,medias}});
 }
});
test('managed reference arguments reject raw media, URL aliases, unsupported roles and duplicate frames',()=>{
 for(const extra of [{medias:[]},{image:'00000000-0000-4000-8000-000000000000'},{reference_url:'https://example.com/private'},{params:'serialized'},{arbitrary:{image:'https://example.com/image'}}])assert.throws(()=>bindHiggsfieldReferenceArguments(tool,{params:{model:'fixture-model',...extra}},medias));
 assert.throws(()=>bindHiggsfieldReferenceArguments(tool,{params:{model:'fixture-model',prompt:'https://example.com/private'}},medias));
 assert.throws(()=>bindHiggsfieldReferenceArguments({...tool,name:'generate_audio'},{params:{model:'fixture-model'}},medias));
 assert.throws(()=>bindHiggsfieldReferenceArguments({...tool,inputSchema:{type:'object'}},{params:{model:'fixture-model'}},medias));
 assert.throws(()=>bindHiggsfieldReferenceArguments(tool,{params:{model:'fixture-model'}},[...medias,...medias]));
});
test('managed references reject array limits, additional required fields and incompatible media constraints',()=>{
 const media=paramsSchema.properties.medias;
 const variants=[{...media,maxItems:0},{...media,minItems:2},{...media,items:{...media.items,required:['role','value','unprovided']}},{...media,items:{...media.items,properties:{...media.items.properties,value:{type:'string',const:randomUUID()}}}},{...media,items:{...media.items,properties:{...media.items.properties,value:{type:'string',pattern:'.*'}}}},{...media,items:{...media.items,$ref:'#/$defs/reference'}},{...media,unevaluatedItems:false}];
 for(const value of variants){const changed={...tool,inputSchema:{...tool.inputSchema,properties:{params:{...paramsSchema,properties:{...paramsSchema.properties,medias:value}}}}};assert.throws(()=>bindHiggsfieldReferenceArguments(changed,{params:{model:'fixture-model'}},medias));}
 assert.throws(()=>bindHiggsfieldReferenceArguments(tool,{params:{model:'fixture-model',duration:11}},medias));
});
test('generic role support never substitutes for an applicable literal model binding',()=>{
 for(const model of [{type:'string'},{type:'string',enum:['fixture-model','other-model']},{type:'string',const:'other-model'}]){
  const changed={...tool,inputSchema:{...tool.inputSchema,properties:{params:{...paramsSchema,properties:{...paramsSchema.properties,model}}}}};assert.throws(()=>bindHiggsfieldReferenceArguments(changed,{params:{model:'fixture-model'}},medias));
 }
 const singleton={...paramsSchema,properties:{...paramsSchema.properties,model:{type:'string',enum:['fixture-model']}}};
 assert.deepEqual(bindHiggsfieldReferenceArguments({...tool,inputSchema:{...tool.inputSchema,properties:{params:{anyOf:[{type:'null'},singleton]}}}},{params:{model:'fixture-model'}},medias),{params:{model:'fixture-model',medias}});
 const conflicting={...paramsSchema,properties:{...paramsSchema.properties,model:{type:'string',const:'fixture-model',enum:['other-model']}}};
 assert.throws(()=>bindHiggsfieldReferenceArguments({...tool,inputSchema:{...tool.inputSchema,properties:{params:conflicting}}},{params:{model:'fixture-model'}},medias));
});
test('bounded schema validation honors sibling union constraints and rejects unknown assertions',()=>{
 const schema={type:'array',maxItems:1,items:{type:'integer',minimum:0},anyOf:[{type:'array',items:{type:'integer'}}]};
 assert.equal(acceptsHiggsfieldReferenceSchema(schema,[1]),true);assert.equal(acceptsHiggsfieldReferenceSchema(schema,[1,2]),false);
 assert.equal(acceptsHiggsfieldReferenceSchema({anyOf:[{type:'string'}],oneOf:[{type:'string'},{type:'string'}]},'x'),false);
 for(const value of [{type:'string',pattern:'.*'},{type:'string',$ref:'#/untrusted'},{type:'string',not:{const:'x'}},{type:'string',format:'uri'}])assert.equal(acceptsHiggsfieldReferenceSchema(value,'x'),false);
 assert.equal(acceptsHiggsfieldReferenceSchema({type:'object',properties:{known:{type:'string'}},additionalProperties:true},{unreviewed:'x'}),false);
 assert.equal(acceptsHiggsfieldReferenceSchema({type:'array',items:{type:'string'},uniqueItems:true},['x','x']),false);
 assert.equal(acceptsHiggsfieldReferenceSchema({type:'string',minLength:1,maxLength:1},'🙂'),true);
});
test('proposal reference IDs are optional, bounded and unique without changing legacy shape',()=>{
 const input={clientId:randomUUID(),projectId:randomUUID(),projectRevision:1,tool:'generate_image',arguments:{prompt:'Legacy'},note:'Fixture'};
 assert.deepEqual(higgsfieldProposalInput.parse(input),input);
 for(const referenceIds of [[],['not-a-uuid','not-a-uuid'],Array.from({length:9},()=>randomUUID())])assert.equal(higgsfieldProposalInput.safeParse({...input,referenceIds}).success,false);
 const id=randomUUID();assert.equal(higgsfieldProposalInput.safeParse({...input,referenceIds:[id,id]}).success,false);assert.equal(higgsfieldProposalInput.safeParse({...input,referenceIds:[id]}).success,true);
});
