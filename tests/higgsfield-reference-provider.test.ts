import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {referenceCatalogDigest,buildReferenceUploadArguments,parseReferenceAllocation,parseReferenceConfirmation} from '../src/lib/higgsfield-reference-provider';
import {createHiggsfieldReferenceBroker} from '../src/lib/higgsfield-reference-broker';
import type {HiggsfieldTool} from '../src/lib/higgsfield-mcp';
import type {HiggsfieldReferenceLease,HiggsfieldReferencePhaseResult} from '../src/lib/higgsfield-references-protocol';

export const referenceTools:HiggsfieldTool[]=[
 {name:'media_upload',description:'fixture',inputSchema:{type:'object',properties:{filename:{type:'string'},content_type:{type:'string'},method:{type:'string',enum:['upload_url']}},additionalProperties:false}},
 {name:'media_confirm',description:'fixture',inputSchema:{type:'object',properties:{media_id:{type:'string'},type:{type:'string',enum:['image','video','audio','file']}},required:['type'],additionalProperties:false}},
];
const lease=():HiggsfieldReferenceLease=>({companyId:randomUUID(),projectId:randomUUID(),referenceId:randomUUID(),leaseId:randomUUID(),requestHash:'a'.repeat(64),phase:'transfer',expiresAt:new Date(Date.now()+60000).toISOString(),proxy:{versionId:randomUUID(),fileId:randomUUID(),name:'private-client-name.png',version:3,bytes:42,sha256:'b'.repeat(64),contentType:'image/png'},role:'image',inspection:null});
const uploaded=(id:string)=>({content:[],structuredContent:{uploads:[{media_id:id,content_type:'image/png',method:'PUT',expires_in_seconds:60,upload_url:'https://qualified.example/upload?signature=private'}]}});
const confirmed=(id:string)=>({content:[],structuredContent:{results:[{media_id:id,status:'confirmed',type:'image'}]}});
test('company schema compatibility is narrow, stable and does not expose original filenames',()=>{
 const l=lease(),args=buildReferenceUploadArguments(referenceTools,l);assert.equal(args.filename,`reference-${l.referenceId}.png`);assert(!JSON.stringify(args).includes(l.proxy.name));
 assert.match(referenceCatalogDigest(referenceTools),/^[a-f0-9]{64}$/);
 for(const tools of [[],[referenceTools[0]], [...referenceTools,referenceTools[0]],referenceTools.map(t=>({...t,inputSchema:{...t.inputSchema,required:['api_key']}})),referenceTools.map(t=>({...t,inputSchema:{$ref:'https://untrusted.example/schema'}}))])assert.throws(()=>referenceCatalogDigest(tools));
 const changed=structuredClone(referenceTools);changed[0].inputSchema.properties={filename:{type:'string'},content_type:{type:'string'},method:{type:'string',enum:['fetch_url']}};assert.throws(()=>referenceCatalogDigest(changed));
});

test('transfer catalog compatibility enforces both unions and their sibling constraints',()=>{
 const valid=referenceTools[0].inputSchema;
 const positive=[{anyOf:[valid],oneOf:[valid,{type:'null'}]}, {...valid,anyOf:[valid],oneOf:[valid,{type:'null'}]}];
 for(const inputSchema of positive)assert.match(referenceCatalogDigest([{...referenceTools[0],inputSchema},referenceTools[1]]),/^[a-f0-9]{64}$/);
 const rejected=[
  {...valid,anyOf:[valid],oneOf:[valid,valid]},
  {...valid,anyOf:[valid],oneOf:[{type:'null'}]},
  {...valid,anyOf:[valid],required:['filename','content_type','method','unprovided']},
  {...valid,anyOf:[valid],maxProperties:2},
  {...valid,anyOf:[valid],const:{filename:'different.png',content_type:'image/png',method:'upload_url'}},
  {...valid,anyOf:[valid],properties:{...valid.properties as Record<string,unknown>,method:{type:'string',enum:['fetch_url']}}},
  {...valid,anyOf:[valid],pattern:'.*'},
  {...valid,anyOf:[valid],$ref:'#/unreviewed'},
 ];
 for(const inputSchema of rejected)assert.throws(()=>referenceCatalogDigest([{...referenceTools[0],inputSchema},referenceTools[1]]));
});
test('allocation and confirmation receipts require one matching structured result',()=>{
 const media=randomUUID();assert.equal(parseReferenceAllocation(uploaded(media),'image/png').mediaId,media);assert.deepEqual(parseReferenceConfirmation(confirmed(media),media),{mediaId:media,confirmed:true});
 for(const value of [{content:[{type:'text',text:JSON.stringify(uploaded(media).structuredContent)}]}, {...uploaded(media),isError:true}, {...uploaded(media),structuredContent:{...uploaded(media).structuredContent,error:'failed'}}, {...uploaded(media),structuredContent:{uploads:[...uploaded(media).structuredContent.uploads,...uploaded(media).structuredContent.uploads]}}])assert.throws(()=>parseReferenceAllocation(value,'image/png'));
 for(const change of [{method:'GET'},{content_type:'image/jpeg'},{media_id:'not-a-uuid'},{expires_in_seconds:0},{expires_in_seconds:3601},{upload_url:'http://example.com/upload'},{upload_url:'https://user:secret@example.com/upload'},{upload_url:'https://example.com/upload#fragment'}])assert.throws(()=>parseReferenceAllocation({content:[],structuredContent:{uploads:[{...uploaded(media).structuredContent.uploads[0],...change}]}},'image/png'));
 for(const change of [{media_id:randomUUID()},{status:'pending'},{type:'video'}])assert.throws(()=>parseReferenceConfirmation({content:[],structuredContent:{results:[{...confirmed(media).structuredContent.results[0],...change}]}},media));
});
test('broker persists each intent before the exact OAuth RPC and never returns credentials',async()=>{
 const l=lease(),media=randomUUID(),events:string[]=[],results:HiggsfieldReferencePhaseResult[]=[],intents=new Set<string>();
 const context={connectionId:randomUUID(),connectionRevision:2,catalogSha256:'c'.repeat(64),tools:referenceTools};
 const broker=createHiggsfieldReferenceBroker({authority:async()=>context,credential:async()=>({...context,token:'server-private'}),beginPhase:async(_l,phase)=>{assert(!intents.has(phase));intents.add(phase);events.push('intent:'+phase);return randomUUID();},completePhase:async(_l,_id,result)=>{results.push(result);events.push('receipt:'+result.phase);},failPhase:async()=>{events.push('uncertain');},allocation:async()=>({mediaId:media,uploadUrl:'https://qualified.example/upload',expiresAt:new Date(Date.now()+60000).toISOString()}),call:async(token,name,args)=>{assert.equal(token,'server-private');events.push('rpc:'+name);if(name==='media_upload'){assert.equal(args.filename,`reference-${l.referenceId}.png`);return uploaded(media);}assert.deepEqual(args,{media_id:media,type:'image'});return confirmed(media);}});
 assert.equal(await broker.allocate(l,AbortSignal.timeout(5000)),undefined);assert.equal(await broker.confirm(l,AbortSignal.timeout(5000)),undefined);
 assert.deepEqual(events,['intent:allocate','rpc:media_upload','receipt:allocate','intent:confirm','rpc:media_confirm','receipt:confirm']);assert.equal(results.length,2);
 await assert.rejects(broker.allocate(l,AbortSignal.timeout(5000)));assert.equal(events.filter(x=>x.startsWith('rpc')).length,2);
});
test('lost provider result or failed receipt commit stays uncertain without retries',async()=>{
 for(const lostCommit of [false,true]){
  const l=lease(),media=randomUUID();let calls=0,failures=0;const c={connectionId:randomUUID(),connectionRevision:1,catalogSha256:'c'.repeat(64),tools:referenceTools};
  const broker=createHiggsfieldReferenceBroker({authority:async()=>c,credential:async()=>({...c,token:'secret'}),beginPhase:async()=>randomUUID(),completePhase:async()=>{throw Error('commit lost');},failPhase:async()=>{failures++;},allocation:async()=>{throw Error('unused');},call:async()=>{calls++;if(!lostCommit)throw Error('private provider error');return uploaded(media);}});
  await assert.rejects(broker.allocate(l,AbortSignal.timeout(5000)),e=>e instanceof Error&&!e.message.includes('private')&&!e.message.includes('commit lost'));assert.equal(calls,1);assert.equal(failures,1);
 }
});
test('stale lease or changed connection after refresh cannot allocate',async()=>{
 for(const stale of [false,true]){
  const l=lease();if(stale)l.expiresAt=new Date(Date.now()-1).toISOString();let calls=0,intents=0;
  const c={connectionId:randomUUID(),connectionRevision:1,catalogSha256:'c'.repeat(64),tools:referenceTools};
  const broker=createHiggsfieldReferenceBroker({authority:async()=>c,credential:async()=>({...c,connectionRevision:2,token:'secret'}),beginPhase:async()=>{intents++;return randomUUID();},completePhase:async()=>{},failPhase:async()=>{},allocation:async()=>{throw Error('unused');},call:async()=>{calls++;return uploaded(randomUUID());}});
  await assert.rejects(broker.allocate(l,AbortSignal.timeout(5000)));assert.equal(calls,0);assert.equal(intents,0);
 }
});
