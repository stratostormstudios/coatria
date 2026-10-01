import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import fs from 'node:fs/promises';
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
 const options={scratchRoot,inspectionProfileSha256:profile,companyId:lease.companyId,projectIds:[lease.projectId],operationDeadlineMs:1000,authorityIntervalMs:10,authorityTimeoutMs:40,cleanupTimeoutMs:100};
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
test('authority is enforced during stalled source and inspection, and noncooperative work poisons admission',async t=>{
 for(const stage of['read','inspect','readiness']){const f=await fixture(t),release=deferred<void>();if(stage==='read'){const read=f.deps.readProxy;f.deps.readProxy=async(...args)=>{f.state.active=false;await release.promise;return read(...args);};}else f.deps.inspectMedia=async()=>{if(stage==='readiness')f.state.enabled=false;else f.state.active=false;await release.promise;return f.descriptor;};const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=await worker.runNext();assert.equal(result.code,'REFERENCE_AUTHORITY_CHANGED');assert.equal(result.status,'failed');unchanged(f);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);assert.equal((await readdir(f.scratchRoot)).length,1,'Unfinished local work is not certified clean or unlinked underneath a decoder');release.resolve();await scratchDrained(f);}
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
 const f=await fixture(t),release=deferred<void>();f.options.operationDeadlineMs=35;f.deps.inspectMedia=async()=>{await release.promise;return f.descriptor;};f.deps.fail=()=>release.promise;const start=Date.now();assert.equal((await f.run()).code,'REFERENCE_WORKER_DEADLINE');assert(Date.now()-start<1000);unchanged(f);release.resolve();await scratchDrained(f);
 const g=await fixture(t);g.deps.inspectMedia=async()=>{throw new Error(g.allocation.uploadUrl);};const result=await g.run();assert.equal(result.code,'REFERENCE_WORKER_FAILED');assert(!JSON.stringify(result).includes('synthetic-private'));unchanged(g);
 const aborted=await fixture(t),controller=new AbortController(),finish=deferred<void>();aborted.deps.inspectMedia=async()=>{controller.abort();await finish.promise;return aborted.descriptor;};const worker=createHiggsfieldReferenceWorker(aborted.options,aborted.deps);assert.equal((await worker.runNext({signal:controller.signal})).code,'REFERENCE_WORKER_ABORTED');unchanged(aborted);assert.equal((await worker.runNext()).status,'disabled');assert.equal(aborted.state.claimCount,1);finish.resolve();await scratchDrained(aborted);
});

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,10));
async function scratchDrained(f:Fixture){for(let i=0;i<30&&(await readdir(f.scratchRoot)).length;i++)await turn();assert.deepEqual(await readdir(f.scratchRoot),[]);}

test('terminal handoff retains cancellation and deadline, drains the final RPC and never retries it',async t=>{
 for(const phase of ['inspect','transfer'] as const)for(const interruption of ['abort','deadline']){
  const f=await fixture(t,phase),entered=deferred<void>(),aborted=deferred<void>(),release=deferred<void>(),controller=new AbortController();
  f.options.operationDeadlineMs=1000;f.options.cleanupTimeoutMs=300;
  let terminalCalls=0,terminalSettled=false,resultSettled=false;
  const waitForAcknowledgement=async(signal:AbortSignal)=>{
   terminalCalls++;entered.resolve();
   signal.addEventListener('abort',()=>aborted.resolve(),{once:true});if(signal.aborted)aborted.resolve();
   await release.promise;terminalSettled=true;
  };
  if(phase==='inspect'){const original=f.deps.recordInspection;f.deps.recordInspection=async(...args)=>{await original(...args);await waitForAcknowledgement(args[2]);};}
  else {const original=f.deps.broker.confirm;f.deps.broker.confirm=async(...args)=>{await original(...args);await waitForAcknowledgement(args[1]);};}
  const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=worker.runNext({signal:controller.signal}).then(value=>{resultSettled=true;return value;});
  await Promise.race([entered.promise,result.then(()=>assert.fail('Worker finished before entering the terminal RPC'))]);
  if(interruption==='abort')controller.abort();await aborted.promise;await turn();
  assert.equal(resultSettled,false,'The cancelled terminal response must drain before scratch cleanup');assert.equal(terminalSettled,false);assert.equal((await readdir(f.scratchRoot)).length,1);
  release.resolve();const outcome=await result;assert.equal(terminalSettled,true);
  assert.equal(outcome.status,phase==='transfer'?'uncertain':'failed');
  assert.equal(outcome.code,phase==='transfer'?'REFERENCE_PROVIDER_UNCERTAIN':interruption==='abort'?'REFERENCE_WORKER_ABORTED':'REFERENCE_WORKER_DEADLINE');
  assert.deepEqual(await readdir(f.scratchRoot),[]);assert.equal(terminalCalls,1);assert.equal((await worker.runNext()).status,'idle');assert.equal(terminalCalls,1);
 }
});

test('abort waits for inspector cleanup before closing scratch or reporting completion',async t=>{
 const f=await fixture(t,'inspect'),entered=deferred<void>(),drained=deferred<void>(),stop=new AbortController();let settled=false;
 f.deps.inspectMedia=async input=>{entered.resolve();await drained.promise;assert.equal(input.signal?.aborted,true);assert.deepEqual(await readFile(input.path),bytes,'Scratch remains readable until the inspector has drained');throw Error('inspection aborted after cleanup');};
 const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=worker.runNext({signal:stop.signal}).then(value=>{settled=true;return value;});
 await entered.promise;stop.abort();await turn();assert.equal(settled,false);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);
 drained.resolve();assert.equal((await result).code,'REFERENCE_WORKER_ABORTED');assert.deepEqual(await readdir(f.scratchRoot),[]);unchanged(f);
});

test('a late source response is owned and its asynchronous cancellation is drained',async t=>{
 const f=await fixture(t,'inspect'),entered=deferred<void>(),response=deferred<void>(),cancelled=deferred<void>(),finishCancel=deferred<void>(),stop=new AbortController();let settled=false,cancels=0;
 const read=f.deps.readProxy;f.deps.readProxy=async(...args)=>{entered.resolve();await response.promise;const source=await read(...args);await source.stream.cancel();source.stream=new ReadableStream({async cancel(){cancels++;cancelled.resolve();await finishCancel.promise;}});return source;};
 const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=worker.runNext({signal:stop.signal}).then(value=>{settled=true;return value;});
 await entered.promise;stop.abort();response.resolve();await cancelled.promise;await turn();assert.equal(settled,false);finishCancel.resolve();assert.equal((await result).code,'REFERENCE_WORKER_ABORTED');assert.equal(cancels,1);assert.deepEqual(await readdir(f.scratchRoot),[]);unchanged(f);
});

test('cleanup timeout stops future claims even after the late inspector finally settles',async t=>{
 const f=await fixture(t,'inspect'),entered=deferred<void>(),release=deferred<void>(),stop=new AbortController();f.options.cleanupTimeoutMs=25;
 f.deps.inspectMedia=async()=>{entered.resolve();await release.promise;return f.descriptor;};
 const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=worker.runNext({signal:stop.signal});await entered.promise;const start=Date.now();stop.abort();const outcome=await result;assert.equal(outcome.status,'failed');assert.equal(outcome.code,'REFERENCE_WORKER_ABORTED');assert(Date.now()-start<1000);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);
 assert.equal((await readdir(f.scratchRoot)).length,1);release.resolve();for(let i=0;i<20&&(await readdir(f.scratchRoot)).length;i++)await turn();assert.deepEqual(await readdir(f.scratchRoot),[]);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);unchanged(f);
});

test('scratch removal failure cannot report successful inspection or confirmation and cannot trigger provider replay',async t=>{
 for(const phase of ['inspect','transfer'] as const){const f=await fixture(t,phase),original=fs.rm;let failedRemovals=0;
  const removal=t.mock.method(fs,'rm',async(path:Parameters<typeof fs.rm>[0],options?:Parameters<typeof fs.rm>[1])=>{if(String(path).startsWith(f.scratchRoot)&&String(path)!==f.scratchRoot){failedRemovals++;throw Error('private filesystem details');}return original(path,options);});
  try{const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=await worker.runNext();assert.equal(result.status,phase==='transfer'?'uncertain':'failed');assert.equal(result.code,phase==='transfer'?'REFERENCE_PROVIDER_UNCERTAIN':'REFERENCE_WORKER_FAILED');assert(!JSON.stringify(result).includes('private'));assert.equal(failedRemovals,1);assert.equal(f.state.failed.length,0,'Do not rewrite a committed terminal receipt during local cleanup');assert.equal(f.state.status,phase==='transfer'?'confirmed':'awaiting_approval');assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);assert.equal(f.state.allocate,phase==='transfer'?1:0);assert.equal(f.state.confirm,phase==='transfer'?1:0);}finally{removal.mock.restore();}
 }
});

test('failed source cancellation poisons the worker without hiding the original byte rejection',async t=>{
 const f=await fixture(t,'inspect'),read=f.deps.readProxy;f.deps.readProxy=async(...args)=>{const source=await read(...args);await source.stream.cancel();source.totalBytes++;source.stream=new ReadableStream({cancel(){throw Error('private cancel details');}});return source;};
 const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=await worker.runNext();assert.equal(result.status,'failed');assert.equal(result.code,'REFERENCE_SOURCE_CHANGED');assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);assert.deepEqual(await readdir(f.scratchRoot),[]);unchanged(f);
});

test('a late source cancellation rejection cannot disappear into drained promise results',async t=>{
 const f=await fixture(t,'inspect'),entered=deferred<void>(),release=deferred<void>(),stop=new AbortController(),read=f.deps.readProxy;let cancels=0;
 f.deps.readProxy=async(...args)=>{entered.resolve();await release.promise;const source=await read(...args);await source.stream.cancel();source.stream=new ReadableStream({cancel(){cancels++;throw Error('private late cancellation failure');}});return source;};
 const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=worker.runNext({signal:stop.signal});await entered.promise;stop.abort();release.resolve();const outcome=await result;assert.equal(outcome.status,'failed');assert.equal(outcome.code,'REFERENCE_WORKER_ABORTED');assert.equal(cancels,1);assert(!JSON.stringify(outcome).includes('private'));assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);assert.deepEqual(await readdir(f.scratchRoot),[]);unchanged(f);
});

test('file close failure retains scratch and stops admission after a committed inspection',async t=>{
 const f=await fixture(t,'inspect'),originalOpen=fs.open;let opened:Awaited<ReturnType<typeof fs.open>>|undefined,restoreClose:(()=>void)|undefined,closes=0;
 const opening=t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await originalOpen(...args);if(args[1]==='wx+'){opened=handle;const close=t.mock.method(handle,'close',async()=>{closes++;throw Error('private close failure');});restoreClose=()=>close.mock.restore();}return handle;});
 try{const worker=createHiggsfieldReferenceWorker(f.options,f.deps),result=await worker.runNext();assert.equal(result.status,'failed');assert.equal(result.code,'REFERENCE_WORKER_FAILED');assert.equal(closes,1);assert.equal(f.state.status,'awaiting_approval');assert.equal(f.state.failed.length,0);assert.equal((await readdir(f.scratchRoot)).length,1);assert.equal((await worker.runNext()).status,'disabled');assert.equal(f.state.claimCount,1);unchanged(f);}finally{opening.mock.restore();restoreClose?.();await opened?.close();}
});
