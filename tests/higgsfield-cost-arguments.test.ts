import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareHiggsfieldCostArguments} from '../src/lib/higgsfield-cost-arguments';
import {ApiError} from '../src/lib/security';

const model='fixture-image';
const tools=['estimate_image_cost','estimate_video_cost','generate_image','generate_video','generate_audio'];
function rejected(tool:string,input:unknown,code='HIGGSFIELD_ESTIMATE_ARGUMENTS_UNSUPPORTED'){
 assert.throws(()=>prepareHiggsfieldCostArguments(tool,input),(error:unknown)=>{
  assert(error instanceof ApiError);assert.equal(error.status,409);assert.equal(error.code,code);
  assert.match(error.message,/No reference was uploaded/);assert(!error.message.includes('example.invalid'));
  return true;
 });
}

test('no-reference estimates retain reviewed costs; only generation preflight forces its flag',()=>{
 for(const tool of tools){
  const params={model,prompt:'An original product',aspect_ratio:'16:9',count:2,folder_id:randomUUID(),use_unlim:false,...tool.includes('video')?{duration:5,use_free_gens:false}:{},...tool==='generate_audio'?{voice_id:'voice_fixture',voice_type:'preset'}:{}};
  const original={params},snapshot=JSON.stringify(original),result=prepareHiggsfieldCostArguments(tool,original);
  assert.deepEqual(result,{params:{...params,...tool.startsWith('generate_')?{get_cost:true}:{}}});
  assert.equal(JSON.stringify(original),snapshot);assert.notEqual(result,original);assert.notEqual(result.params,params);
 }
});

test('canonical UUID references survive every cost route without claiming provenance or mutating input',()=>{
 const medias=['image','start_image','end_image','video','audio','ref_element'].map(role=>({role,value:randomUUID()}));
 for(const tool of tools){
  const input={params:{model,medias,...tool.startsWith('generate_')?{get_cost:false}:{}}},snapshot=JSON.stringify(input);
  const result=prepareHiggsfieldCostArguments(tool,input);
  assert.deepEqual(result.params.medias,medias);assert.notEqual(result.params.medias,medias);
  assert.equal(JSON.stringify(input),snapshot);assert.equal('providerVerified' in result,false);
  if(tool.startsWith('generate_'))assert.equal(result.params.get_cost,true);
 }
});

test('raw URL references and aliases are blocked in all cost paths, including unknown nested arguments',()=>{
 const url='https://example.invalid/private-image.png';
 const inputs=[
  {params:{model,medias:[{role:'image',value:url}]}},
  {params:{model,image:url}},
  {params:{model,image_url:url}},
  {params:{model,reference_images:[url]}},
  {params:{model,input_images:[{url}]}},
  {params:{model,options:{reference:{url}}}},
  {params:{model},image_url:url},
  {model,medias:[{role:'image',value:url}]},
  {params:JSON.stringify({model,medias:[{role:'image',value:url}]})},
  {params:{model,prompt:'Use '+url}},
 ];
 for(const tool of tools)for(const input of inputs)rejected(tool,input,'HIGGSFIELD_ESTIMATE_REFERENCE_UNSAFE');
});

test('alternate locators and malformed media cannot become a provider upload',()=>{
 const values=['HTTPS://example.invalid/a.png','//example.invalid/a.png','file:///private/a.png','data:image/png;base64,AA==','blob:fixture','C:\\private\\a.png','%68%74%74%70%73%3A%2F%2Fexample.invalid/a.png',JSON.stringify({url:'relative.png'}),'relative.png','not-a-uuid'];
 for(const value of values)for(const tool of tools)rejected(tool,{params:{model,medias:[{role:'image',value}]}},'HIGGSFIELD_ESTIMATE_REFERENCE_UNSAFE');
 for(const medias of [[{role:'image',value:randomUUID(),url:'relative.png'}],[{role:'unsupported',value:randomUUID()}],[{role:'image',data:{id:randomUUID()}}],randomUUID(),null])rejected('estimate_image_cost',{params:{model,medias}},'HIGGSFIELD_ESTIMATE_REFERENCE_UNSAFE');
});

test('unknown model-specific parameters and noncanonical envelopes fail closed rather than being stripped',()=>{
 const inputs=[{params:{model},get_cost:false},{model},{params:JSON.stringify({model})},{params:[{model}]},{params:null},null,[],{params:{model,resolution:'4k'}},{params:{model,reference_images:[randomUUID()]}},{params:{model,extension:randomUUID()}},{params:{model,options:{seed:1}}},{params:{model,extra:'%68%74%74%70%73%3A%2F%2Fexample.invalid/a.png'}}];
 for(const tool of tools)for(const input of inputs)rejected(tool,input);
 rejected('balance',{params:{model}});
 rejected('estimate_image_cost',{params:{model,get_cost:false}});
 rejected('estimate_video_cost',{params:{model,get_cost:true}});
});

test('invalid scalars are not coerced and errors never echo supplied values',()=>{
 for(const params of [{model:10},{model,count:'2'},{model,count:0},{model,count:5},{model,use_unlim:'false'},{model,aspect_ratio:'0:1'},{model,folder_id:'not-confirmed'},{model,duration:'5'},{model,duration:0},{model,duration:Infinity}])rejected('generate_video',{params});
 rejected('generate_image',{params:{model,get_cost:'true'}});
 rejected('generate_image',{params:{model,prompt:'x'.repeat(20001)}});
});
