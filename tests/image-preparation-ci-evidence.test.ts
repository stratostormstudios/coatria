/** Artifact mechanics over synthetic reports; never native qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {archiveHostHash} from '../scripts/hosting/archive-host-package.mjs';
import {collectImagePreparationCiEvidence,preserveImagePreparationCiEvidence} from '../scripts/hosting/image-preparation-ci-evidence.mjs';
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
function fixture(kind:'reference'|'archive'='reference',invocationId='1'.repeat(32)){
 const sourceCommit='a'.repeat(40),sourceTree='b'.repeat(40),bundleSha256='c'.repeat(64),profileSha256='d'.repeat(64);
 const qualificationBytes=bytes({qualified:true,profiles:{real:{expectedProfileSha256:profileSha256}}});
 const hostEvidenceBytes=bytes(kind==='reference'?{qualified:true,sourceCommit,sourceTree,bundleSha256,qualifierInvocationId:invocationId,reportSha256:archiveHostHash(qualificationBytes)}:{qualified:true,commit:sourceCommit,bundleSha256,invocationId,qualificationSha256:archiveHostHash(qualificationBytes)});
 const image={version:1,kind:'image-preparation-isolated-linux-transform',passed:true,productionQualified:false,installedServiceQualified:false,enrollmentExercised:false,remoteTransportExercised:false,providerCalls:0,actualLinuxTransform:true,recipeSha256:'e'.repeat(64),profileSha256,qualificationExecutions:1,cases:['png','jpeg','webp','wrong-source-hash','pre-aborted','cancel-native'].map(name=>{const success=['png','jpeg','webp'].includes(name),executes=success||name==='cancel-native';return {name,passed:true,outputSha256:success?'f'.repeat(64):null,outputBytes:success?100:null,failureCode:success?null:name==='wrong-source-hash'?'PREPARATION_BYTES_CHANGED':'PREPARATION_ABORTED',nativeExecutions:executes?1:0,nativeEvidence:executes?[{drained:true}]:[],observedProcesses:executes?1:0,cancelledDuringNativeRun:name==='cancel-native',drainedAtReturn:true,sourceHandleClosedAtReturn:true,sourceUnchanged:true};})};
 return {context:{sourceCommit,sourceTree,bundleSha256,qualificationBytes,hostEvidenceBytes,invocationId},image};
}
async function withDirectory(run:(directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'coatria-image-ci-evidence-'));try{await run(directory);}finally{await rm(directory,{recursive:true,force:true});}}

test('CI preserves both installed invocations byte-for-byte and binds exact reports without changing acceptance',async()=>withDirectory(async directory=>{
 for(const kind of ['archive','reference'] as const){
  const exports=new Map<string,Buffer>(),bindings=[];
  for(const [label,id]of [['first','1'],['second','2']]){
   const f=fixture(kind,id.repeat(32)),original=bytes(f.image),originalHost=Buffer.from(f.context.hostEvidenceBytes),originalQualification=Buffer.from(f.context.qualificationBytes);await writeFile(join(directory,'image-preparation-transform.json'),original);
   const collected=await collectImagePreparationCiEvidence({directory,...f.context});preserveImagePreparationCiEvidence(exports,kind+'-host-'+label,collected);
   assert.deepEqual(collected.imageBytes,original);assert.deepEqual(f.context.hostEvidenceBytes,originalHost);assert.deepEqual(f.context.qualificationBytes,originalQualification);
   const binding=JSON.parse(collected.bindingBytes.toString());assert.equal(binding.invocationId,id.repeat(32));assert.equal(binding.qualifiedInvocation,true);assert.equal(binding.acceptanceAuthority,false);assert.equal(binding.hostEvidenceSha256,archiveHostHash(originalHost));assert.equal(binding.qualificationSha256,archiveHostHash(originalQualification));assert.equal(binding.imagePreparationSha256,archiveHostHash(original));bindings.push(binding);
  }
  assert.equal(exports.size,4);assert.notEqual(bindings[0].hostEvidenceSha256,bindings[1].hostEvidenceSha256);assert.equal(bindings[0].imagePreparationSha256,bindings[1].imagePreparationSha256,'Identical output does not erase distinct invocations');
 }
}));

test('CI binding rejects mismatched invocation/source/bundle/profile and stale qualification digest',async()=>withDirectory(async directory=>{
 const f=fixture();await writeFile(join(directory,'image-preparation-transform.json'),bytes(f.image));
 for(const patch of [{invocationId:'2'.repeat(32)},{sourceCommit:'f'.repeat(40)},{sourceTree:'f'.repeat(40)},{bundleSha256:'f'.repeat(64)},{qualificationBytes:bytes({qualified:true,profiles:{real:{expectedProfileSha256:'0'.repeat(64)}}})},{hostEvidenceBytes:bytes({...JSON.parse(f.context.hostEvidenceBytes.toString()),qualified:false})}])await assert.rejects(collectImagePreparationCiEvidence({directory,...f.context,...patch}),{message:'IMAGE_PREPARATION_CI_EVIDENCE_INVALID'});
 await writeFile(join(directory,'image-preparation-transform.json'),bytes({...f.image,profileSha256:'0'.repeat(64)}));await assert.rejects(collectImagePreparationCiEvidence({directory,...f.context}),{message:'IMAGE_PREPARATION_CI_EVIDENCE_INVALID'});
}));

test('successful evidence needs actual probe, complete cases and confirmed descendant/source cleanup',async()=>withDirectory(async directory=>{
 const f=fixture();
 const patches=[{qualificationExecutions:0},{actualLinuxTransform:false},{productionQualified:true},{providerCalls:1},{cases:f.image.cases.slice(1)},{cases:f.image.cases.map((c,i)=>i===0?{...c,drainedAtReturn:false}:c)},{cases:f.image.cases.map((c,i)=>i===0?{...c,nativeEvidence:[{drained:false}]}:c)},{cases:f.image.cases.map((c,i)=>i===0?{...c,sourceHandleClosedAtReturn:false}:c)},{cases:f.image.cases.map((c,i)=>i===0?{...c,sourceUnchanged:false}:c)},{cases:f.image.cases.map((c,i)=>i===5?{...c,cancelledDuringNativeRun:false}:c)},{cases:f.image.cases.map((c,i)=>i===3?{...c,failureCode:'PREPARATION_UNAVAILABLE'}:c)}];
 for(const patch of patches){await writeFile(join(directory,'image-preparation-transform.json'),bytes({...f.image,...patch}));await assert.rejects(collectImagePreparationCiEvidence({directory,...f.context}),{message:'IMAGE_PREPARATION_CI_EVIDENCE_INVALID'});}
}));

test('first-failure partial report retains its exact bytes and remains unaccepted with no inferred invocation',async()=>withDirectory(async directory=>{
 const f=fixture(),partial=bytes({...f.image,passed:false,actualLinuxTransform:false,qualificationExecutions:0,profileSha256:null,cases:[]}),qualificationBytes=bytes({qualified:false,activeCheck:'reference-worker'});
 await writeFile(join(directory,'image-preparation-transform.json'),partial);
 const context={directory,qualificationBytes,sourceCommit:f.context.sourceCommit,sourceTree:null,bundleSha256:null},collected=await collectImagePreparationCiEvidence(context),binding=JSON.parse(collected.bindingBytes.toString()),exports=new Map();
 preserveImagePreparationCiEvidence(exports,'reference-host-unaccepted-1',collected);assert.deepEqual(collected.imageBytes,partial);assert.equal(binding.qualifiedInvocation,false);assert.equal(binding.acceptanceAuthority,false);assert.equal(binding.invocationId,null);assert.equal(binding.hostEvidenceSha256,null);assert.equal(binding.passed,false);assert.equal(binding.imagePreparationSha256,archiveHostHash(partial));
 await assert.rejects(collectImagePreparationCiEvidence({...context,invocationId:f.context.invocationId}),{message:'IMAGE_PREPARATION_CI_EVIDENCE_INVALID'});
}));

test('retained evidence rejects missing, oversized, malformed and multiply-linked files',async()=>withDirectory(async directory=>{
 const f=fixture(),path=join(directory,'image-preparation-transform.json');await assert.rejects(collectImagePreparationCiEvidence({directory,...f.context}),{code:'ENOENT'});
 for(const value of [Buffer.alloc(1024**2+1),Buffer.from('not json'),Buffer.from('null')]){await writeFile(path,value);await assert.rejects(collectImagePreparationCiEvidence({directory,...f.context}));}
 await writeFile(path,bytes(f.image));await link(path,join(directory,'other-link'));await assert.rejects(collectImagePreparationCiEvidence({directory,...f.context}));assert.deepEqual(await readFile(path),bytes(f.image));
}));

test('artifact names are fixed and duplicate preservation never overwrites first evidence',()=>{
 const exports=new Map(),collected={imageBytes:Buffer.from('image'),bindingBytes:Buffer.from('binding')};preserveImagePreparationCiEvidence(exports,'reference-enrollment',collected);
 assert.throws(()=>preserveImagePreparationCiEvidence(exports,'reference-enrollment',collected),{message:'IMAGE_PREPARATION_CI_EVIDENCE_INVALID'});
 for(const prefix of ['../../private','reference-host-first/extra','archive-host-anything'])assert.throws(()=>preserveImagePreparationCiEvidence(exports,prefix,collected),{message:'IMAGE_PREPARATION_CI_EVIDENCE_INVALID'});
 assert.equal(exports.size,2);assert.equal(exports.get('reference-enrollment-image-preparation-transform.json')?.toString(),'image');
});
