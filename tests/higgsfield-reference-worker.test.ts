import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHiggsfieldReferenceInspector,createHiggsfieldReferenceWorker,type HiggsfieldReferenceWorkerDependencies} from '../src/lib/higgsfield-reference-worker';
import type {HiggsfieldReferenceLease,HiggsfieldReferenceInspection} from '../src/lib/higgsfield-references-protocol';
import type {HiggsfieldMediaDescriptor} from '../src/lib/higgsfield-media-inspection';

const bytes=Buffer.from('bounded synthetic prepared-image bytes'),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),profile='a'.repeat(64);
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},phase:'inspect'|'transfer'='transfer'){
 const scratchRoot=await mkdtemp(join(tmpdir(),'coatria-reference-'));t.after(()=>rm(scratchRoot,{recursive:true,force:true}));
 const descriptor:Extract<HiggsfieldMediaDescriptor,{kind:'image'}>={kind:'image',format:'png',contentType:'image/png',bytes:bytes.length,sha256:hash(bytes),verification:'full_decode',inspectionVersion:1,width:2,height:2,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};
 const inspection:HiggsfieldReferenceInspection={descriptor,profileSha256:profile,inspectionHash:'b'.repeat(64),inspectedAt:new Date().toISOString()};
 const lease:HiggsfieldReferenceLease={companyId:randomUUID(),projectId:randomUUID(),referenceId:randomUUID(),leaseId:randomUUID(),requestHash:'c'.repeat(64),phase,expiresAt:new Date(Date.now()+60000).toISOString(),role:'image',proxy:{versionId:randomUUID(),fileId:randomUUID(),name:'proxy.png',version:1,bytes:bytes.length,sha256:hash(bytes),contentType:'image/png'},inspection:phase==='transfer'?inspection:null};
 const journal:string[]=[],state={status:'queued',active:true,enabled:true,claimCount:0,reads:0,inspections:0,allocate:0,put:0,confirm:0,failed:[] as Array<{code:string;uncertain:boolean}>,storedInspection:null as HiggsfieldReferenceInspection|null,paths:[] as string[],seenLeases:[] as HiggsfieldReferenceLease[],uploaded:Buffer.alloc(0),readIds:[] as string[]};
 const allocation={mediaId:randomUUID(),uploadUrl:'https://uploads.reviewed.example/private?signature=synthetic-private-value',expiresAt:new Date(Date.now()+60000).toISOString()};
 const deps:HiggsfieldReferenceWorkerDependencies={
  readiness:async()=>({enabled:state.enabled,hostQualified:true,storageVerified:true,catalogVerified:true,profileSha256:profile,expiresAt:new Date(Date.now()+60000).toISOString()}),
  claim:async()=>{state.claimCount++;if(state.status!=='queued')return null;state.status=phase==='inspect'?'inspecting':'reading';return lease;},
  authorize:async l=>{state.seenLeases.push(l);return state.active;},
  readProxy:async l=>{state.reads++;state.readIds.push(l.proxy.versionId);journal.push('read');return{stream:new ReadableStream({start(c){c.enqueue(Buffer.from(bytes));c.close();}}),bytes:bytes.length,totalBytes:bytes.length,etag:'verified-etag',contentType:'image/png',range:null,contentRange:null};},
  inspectMedia:async input=>{state.inspections++;state.paths.push(input.path);journal.push('inspect');assert.equal(input.expectedKind,'image');assert.equal(input.expectedBytes,bytes.length);assert.equal(input.expectedSha256,hash(bytes));assert.equal(hash(await readFile(input.path)),hash(bytes));return structuredClone(descriptor);},
  recordInspection:async(_l,value)=>{journal.push('record-inspection');state.storedInspection={...value,inspectionHash:'d'.repeat(64),inspectedAt:new Date().toISOString()};state.status='awaiting_approval';},
  beginPut:async()=>{assert.equal(state.status,'allocated');journal.push('put-intent');state.status='uploading';return randomUUID();},
  completePut:async(_l,_action,result)=>{assert.equal(state.status,'uploading');assert.deepEqual(result,{phase:'put',bytes:bytes.length,sha256:hash(bytes),httpStatus:200});journal.push('put-complete');state.status='uploaded';},
  fail:async(_l,result)=>{journal.push('fail');state.failed.push(result);state.status=result.uncertain?'uncertain':'failed';},
  broker:{allocate:async()=>{assert.equal(state.status,'reading');state.allocate++;journal.push('allocate-intent');state.status='allocating';journal.push('allocate-complete');state.status='allocated';},uploadCapability:async()=>{assert.equal(state.status,'allocated');journal.push('private-capability');return allocation;},confirm:async()=>{assert.equal(state.status,'uploaded');state.confirm++;journal.push('confirm-intent');state.status='confirming';journal.push('confirm-complete');state.status='confirmed';}},
  upload:async input=>{assert.equal(state.status,'uploading');state.put++;journal.push('put');assert.equal(input.locator,allocation.uploadUrl);assert.equal(input.contentType,'image/png');assert.equal(input.bytes,bytes.length);assert.equal(input.sha256,hash(bytes));assert.equal(hash(input.body),hash(bytes));assert.equal(Object.hasOwn(input,'token'),false);await input.assertAuthority(new AbortController().signal);state.uploaded=Buffer.from(input.body);return{bytes:input.bytes,sha256:input.sha256,status:200};}
 };
 const options={scratchRoot,inspectionProfileSha256:profile,companyId:lease.companyId,projectIds:[lease.projectId],operationDeadlineMs:1000,authorityIntervalMs:10,authorityTimeoutMs:40};
 const run=()=>createHiggsfieldReferenceWorker(options,deps).runNext();return {lease,descriptor,inspection,allocation,state,journal,deps,options,run,scratchRoot};
}
const unchanged=(f:Fixture)=>{assert.equal(f.state.allocate,0);assert.equal(f.state.put,0);assert.equal(f.state.confirm,0);};
test('inspection prepares exact proxy evidence before separate approval and performs no provider operations',async t=>{
 const f=await fixture(t,'inspect');assert.deepEqual(await f.run(),{processed:true,referenceId:f.lease.referenceId,status:'awaiting_approval'});assert.deepEqual(f.journal,['read','inspect','record-inspection']);unchanged(f);assert.deepEqual(f.state.storedInspection?.descriptor,f.descriptor);assert.equal(f.state.storedInspection?.profileSha256,profile);assert.deepEqual(await readdir(f.scratchRoot),[]);
});
test('approved transfer executes exact full sequence, preserves bytes, has no original substitution or public capability',async t=>{
 const f=await fixture(t);(f.lease as any).source={versionId:randomUUID()};(f.lease as any).token='synthetic-private-value';
 const result=await f.run();assert.deepEqual(result,{processed:true,referenceId:f.lease.referenceId,status:'confirmed'});assert.deepEqual(f.journal,['read','inspect','allocate-intent','allocate-complete','private-capability','put-intent','put','put-complete','confirm-intent','confirm-complete']);assert.deepEqual(f.state.readIds,[f.lease.proxy.versionId]);assert.deepEqual(f.state.uploaded,bytes);assert(f.state.seenLeases.every(l=>!('token'in l)&&!('source'in l)));assert(!JSON.stringify(result).includes('synthetic-private'));assert.deepEqual(await readdir(f.scratchRoot),[]);
 assert.equal((await f.run()).status,'idle');assert.equal(f.state.allocate,1);assert.equal(f.state.put,1);assert.equal(f.state.confirm,1);
});
test('service remains disabled without every qualified host/storage/catalog/finite runtime fact',async t=>{
 for(const patch of[{enabled:false},{hostQualified:false},{storageVerified:false},{catalogVerified:false},{profileSha256:'b'.repeat(64)},{expiresAt:'invalid'},{expiresAt:new Date(0).toISOString()}]){const f=await fixture(t);const ready=f.deps.readiness!;f.deps.readiness=async s=>({...await ready(s),...patch});assert.equal((await f.run()).status,'disabled');assert.equal(f.state.claimCount,0);unchanged(f);}
 const f=await fixture(t);delete f.deps.readiness;assert.equal((await f.run()).status,'disabled');assert.equal(f.state.claimCount,0);assert.throws(()=>createHiggsfieldReferenceInspector({} as any),{code:'REFERENCE_WORKER_UNAVAILABLE'});
});
test('wrong company/project/version, oversize images or expired lease never read or allocate',async t=>{
 for(const mutate of[(f:Fixture)=>{f.lease.companyId=randomUUID();},(f:Fixture)=>{f.lease.projectId=randomUUID();},(f:Fixture)=>{f.lease.proxy.versionId='invalid';},(f:Fixture)=>{f.lease.proxy.bytes=10*1024**2+1;},(f:Fixture)=>{f.lease.expiresAt=new Date(0).toISOString();}]){const f=await fixture(t);mutate(f);assert.equal((await f.run()).status,'disabled');assert.equal(f.state.reads,0);unchanged(f);}
});
test('wrong storage response length/range/hash and truncated or extra bytes fail before upload allocation',async t=>{
 for(const scenario of['length','range','hash','short','extra']){const f=await fixture(t),read=f.deps.readProxy;f.deps.readProxy=async(...args)=>{const r=await read(...args);if(scenario==='length')r.totalBytes++;if(scenario==='range')r.range={start:0,end:bytes.length-1};if(['hash','short','extra'].includes(scenario)){void r.stream.cancel();const value=scenario==='short'?bytes.subarray(0,-1):scenario==='extra'?Buffer.concat([bytes,Buffer.from('x')]):Buffer.alloc(bytes.length);r.stream=new ReadableStream({start(c){c.enqueue(value);c.close();}});}return r;};const result=await f.run();assert.equal(result.code,'REFERENCE_SOURCE_CHANGED');unchanged(f);assert.equal(f.state.inspections,0);assert.deepEqual(await readdir(f.scratchRoot),[]);}
});
test('full decode kind, image limits, immutable descriptor and profile are rechecked before allocation',async t=>{
 for(const patch of[{kind:'video'},{width:4097},{width:4096,height:4096},{verification:'metadata_only'},{contentType:'image/jpeg'},{sha256:'0'.repeat(64)},{codec:'other-codec'}]){const f=await fixture(t),inspect=f.deps.inspectMedia;f.deps.inspectMedia=async input=>({...await inspect(input),...patch}) as HiggsfieldMediaDescriptor;assert.equal((await f.run()).code,'REFERENCE_IMAGE_REJECTED');unchanged(f);}
 const f=await fixture(t);f.lease.inspection!.profileSha256='0'.repeat(64);assert.equal((await f.run()).code,'REFERENCE_IMAGE_REJECTED');unchanged(f);
});
test('scratch tampering during decode is caught by exact same-handle snapshot before disclosure',async t=>{
 const f=await fixture(t),inspect=f.deps.inspectMedia;f.deps.inspectMedia=async input=>{const result=await inspect(input);await writeFile(input.path,Buffer.alloc(bytes.length));return result;};assert.equal((await f.run()).code,'REFERENCE_SOURCE_CHANGED');unchanged(f);assert.deepEqual(await readdir(f.scratchRoot),[]);
});
test('authority is enforced during stalled source and inspection, and readiness revocation blocks provider work',async t=>{
 for(const stage of['read','inspect','readiness']){const f=await fixture(t);if(stage==='read')f.deps.readProxy=()=>{f.state.active=false;return new Promise(()=>{});};else f.deps.inspectMedia=()=>{if(stage==='readiness')f.state.enabled=false;else f.state.active=false;return new Promise(()=>{});};const result=await f.run();assert.equal(result.code,'REFERENCE_AUTHORITY_CHANGED');unchanged(f);assert.deepEqual(await readdir(f.scratchRoot),[]);}
});
test('lost allocation, PUT or confirmation responses are durable uncertainty with no next-attempt replay',async t=>{
 for(const stage of['allocate','put','confirm','put-receipt']){const f=await fixture(t);if(stage==='allocate'){const original=f.deps.broker.allocate;f.deps.broker.allocate=async(...args)=>{await original(...args);throw new Error(f.allocation.uploadUrl);};}else if(stage==='put'){const original=f.deps.upload;f.deps.upload=async arg=>{await original(arg);throw new Error('synthetic-private-value');};}else if(stage==='put-receipt'){f.deps.completePut=async()=>{throw new Error('receipt response lost');};}else{const original=f.deps.broker.confirm;f.deps.broker.confirm=async(...args)=>{await original(...args);throw new Error('confirmation response lost');};}
  const result=await f.run();assert.equal(result.status,'uncertain');assert.equal(result.code,'REFERENCE_PROVIDER_UNCERTAIN');assert.deepEqual(f.state.failed,[{code:'REFERENCE_PROVIDER_UNCERTAIN',uncertain:true}]);assert(!JSON.stringify(result).includes('synthetic-private'));const counts=[f.state.allocate,f.state.put,f.state.confirm];assert.equal((await f.run()).status,'idle');assert.deepEqual([f.state.allocate,f.state.put,f.state.confirm],counts);assert.deepEqual(await readdir(f.scratchRoot),[]);
 }
});
test('revocation after allocation stops PUT and retains uncertain prior disclosure state',async t=>{
 const f=await fixture(t),allocate=f.deps.broker.allocate;f.deps.broker.allocate=async(...args)=>{await allocate(...args);f.state.active=false;};const result=await f.run();assert.equal(result.status,'uncertain');assert.equal(f.state.allocate,1);assert.equal(f.state.put,0);assert.equal(f.state.confirm,0);
});
test('deadline/abort and hung failure receipts remain bounded without exposing arbitrary dependency errors',async t=>{
 const f=await fixture(t);f.options.operationDeadlineMs=35;f.deps.inspectMedia=()=>new Promise(()=>{});f.deps.fail=()=>new Promise(()=>{});const start=Date.now();assert.equal((await f.run()).code,'REFERENCE_WORKER_DEADLINE');assert(Date.now()-start<1000);unchanged(f);
 const g=await fixture(t);g.deps.inspectMedia=async()=>{throw new Error(g.allocation.uploadUrl);};const result=await g.run();assert.equal(result.code,'REFERENCE_WORKER_FAILED');assert(!JSON.stringify(result).includes('synthetic-private'));unchanged(g);
 const aborted=await fixture(t),controller=new AbortController();aborted.deps.inspectMedia=()=>{controller.abort();return new Promise(()=>{});};assert.equal((await createHiggsfieldReferenceWorker(aborted.options,aborted.deps).runNext({signal:controller.signal})).code,'REFERENCE_WORKER_ABORTED');unchanged(aborted);assert.deepEqual(await readdir(aborted.scratchRoot),[]);
});
