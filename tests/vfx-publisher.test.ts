import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {controlledRenderJobSchema,renderJobDigest,RenderError,sha256File,type RenderManifest,type RenderResult} from '../scripts/vfx/renderer.mjs';
import {publishExecutionOutputs,publicationRequestId} from '../scripts/vfx/publish.mjs';
import {BUILTIN_EXECUTION_PROFILE,executionManifestFromResult,executionWorkerBinding,executionWorkerMode,runExecutionWorkerOnce} from '../scripts/vfx/worker.mjs';

const token='ce_'+randomUUID().replaceAll('-',''),companyId=randomUUID();
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fails=(code:string)=>(error:unknown)=>error instanceof RenderError&&error.code===code;
// Header-only fixtures exercise transport and byte integrity, not render quality.
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'coatria-publisher-test-'));
 const job=controlledRenderJobSchema.parse({schemaVersion:1,jobId:randomUUID(),profile:'coatria-product-turntable-v1',frameStart:1,frameEnd:1,width:64,height:64,fpsNumerator:24,fpsDenominator:1,timeoutSeconds:600});
 const attempt=path.join(root,job.jobId,'attempts','0001');await mkdir(path.join(attempt,'frames'),{recursive:true});
 const png=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);
 const exr=Buffer.alloc(80);exr.writeUInt32LE(20000630);exr.writeUInt32LE(2,4);const attr=Buffer.from('dataWindow\0box2i\0');attr.copy(exr,8);exr.writeUInt32LE(16,8+attr.length);exr.writeInt32LE(63,8+attr.length+12);exr.writeInt32LE(63,8+attr.length+16);
 const files:RenderManifest['files']=[];
 for(const [name,kind,bytes] of [['scene.blend','scene',Buffer.concat([Buffer.from('BLENDER'),Buffer.alloc(64)])],['review.png','review',png],['frames/frame-0001.exr','frame',exr]] as const){await writeFile(path.join(attempt,name),bytes);files.push({path:name,kind,sizeBytes:bytes.length,sha256:hash(bytes),...kind==='scene'?{}:{width:64,height:64},...kind==='frame'?{frame:1}:{}});}
 const manifest:RenderManifest={schemaVersion:1,job,jobSpecSha256:renderJobDigest(job),profileSha256:'a'.repeat(64),attempt:1,files,evidence:{blenderVersion:'unit fixture',blenderBuildHash:'fixture'},createdAt:new Date().toISOString()};
 await writeFile(path.join(attempt,'manifest.json'),JSON.stringify(manifest));
 const result:RenderResult={schemaVersion:1,status:'succeeded',jobId:job.jobId,attempt:1,manifestPath:'attempts/0001/manifest.json',manifestSha256:await sha256File(path.join(attempt,'manifest.json')),elapsedMs:1,replayed:false};
 await writeFile(path.join(root,job.jobId,'result.json'),JSON.stringify(result));
 const expected=new Map<string,{sha256:string;bytes:number;contentType:string}>();for(const file of files)expected.set(`${job.jobId}/attempts/0001/${file.path}`,{sha256:file.sha256,bytes:file.sizeBytes,contentType:file.path.endsWith('.png')?'image/png':file.path.endsWith('.exr')?'image/x-exr':'application/octet-stream'});
 const report=await readFile(path.join(attempt,'manifest.json'));expected.set(`${job.jobId}/attempts/0001/manifest.json`,{sha256:hash(report),bytes:report.length,contentType:'application/json'});
 return{root,job,attempt,expected,options:{origin:'https://coatria.com',token,outputRoot:root,jobId:job.jobId},clean:async()=>{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert(path.basename(root).startsWith('coatria-publisher-test-'));await rm(root,{recursive:true,force:true});}};
}
function service(f:Awaited<ReturnType<typeof fixture>>,changes:{url?:(url:URL)=>void;headers?:(headers:Record<string,string>)=>void;uploadStatus?:number;uncertainOnce?:boolean;wrongFile?:boolean}={}){
 const records=new Map<string,any>(),stored=new Map<string,Buffer>(),ids:any[]=[],calls:string[]=[];let lost=false;
 const transport=async(input:any,options:any)=>{
  const url=new URL(String(input));calls.push(options.method+' '+url.pathname);assert.equal(options.redirect,'error');
  if(url.origin==='https://coatria.com'){
   assert.equal(options.headers.Authorization,'Bearer '+token);const body=options.body?JSON.parse(options.body):{};
   if(url.pathname==='/api/execution/identity')return Response.json({connector:{id:randomUUID(),companyId}});
   if(url.pathname.endsWith('/upload')){
    ids.push(body);const expected=f.expected.get(body.path);assert(expected);let file=records.get(body.path);
    if(!file){file={id:randomUUID(),path:body.path,...expected,verifiedState:'awaiting_upload_or_verification'};records.set(body.path,file);}
    const extension=body.path.split('.').at(-1),blob=new URL('https://vercel.com/api/blob/');blob.searchParams.set('pathname',`studio/${companyId}/${f.job.jobId}/${expected.sha256}/${file.id}.${extension}`);blob.searchParams.set('signed','fixture');changes.url?.(blob);
    const headers={'Content-Type':file.contentType,'x-content-type':file.contentType};changes.headers?.(headers);
    return Response.json({file:changes.wrongFile?{...file,sha256:'f'.repeat(64)}:file,upload:file.verifiedState==='verified'?null:{url:blob.href,method:'PUT',headers,expiresAt:new Date(Date.now()+60000).toISOString()}});
   }
   if(url.pathname.endsWith('/verify')){
    ids.push(body);const file=[...records.values()].find(item=>item.id===body.fileId);assert(file);const bytes=stored.get(file.id);
    if(!bytes||bytes.length!==file.bytes||hash(bytes)!==file.sha256)return Response.json({code:'MEDIA_VERIFICATION_FAILED'},{status:409});
    file.verifiedState='verified';return Response.json({file});
   }
   throw Error('Unexpected API path.');
  }
  assert.equal(url.origin,'https://vercel.com');assert.equal(url.pathname,'/api/blob/');assert.deepEqual(Object.keys(options.headers),['Content-Type','x-content-type']);assert.equal(options.headers['x-content-type'],options.headers['Content-Type']);assert(!JSON.stringify(options.headers).includes(token));
  const id=url.searchParams.get('pathname')!.split('/').at(-1)!.split('.')[0];
  if(changes.uploadStatus)return Response.json({code:'fixture'},{status:changes.uploadStatus});
  if(stored.has(id))return Response.json({code:'existing_file'},{status:409});
  stored.set(id,Buffer.from(options.body));if(changes.uncertainOnce&&!lost){lost=true;throw Error('Response lost after storing bytes.');}
  return Response.json({ok:true});
 };
 return{transport,records,stored,ids,calls};
}

test('publishes every sealed file, verifies server bytes, replays without another PUT and keeps connector token off storage',async()=>{
 const f=await fixture(),api=service(f);
 try{const first=await publishExecutionOutputs({...f.options,fetch:api.transport}),puts=api.calls.filter(call=>call.startsWith('PUT')).length;assert.equal(first.files.length,4);assert.equal(first.independentlyReviewed,false);assert.equal(first.verificationSource,'server_bytes');assert.equal(puts,4);const second=await publishExecutionOutputs({...f.options,fetch:api.transport});assert.deepEqual(second,first);assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,puts);assert.equal(new Set(api.ids.map(item=>item.clientId)).size,8);assert(!JSON.stringify(first).includes(token));}finally{await f.clean();}
});

test('lost upload response is reconciled with stable IDs, write-once conflict and actual server verification',async()=>{
 const f=await fixture(),api=service(f,{uncertainOnce:true});
 try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_UPLOAD_UNCERTAIN'));assert.equal(api.stored.size,1);const result=await publishExecutionOutputs({...f.options,fetch:api.transport});assert.equal(result.status,'verified');assert.equal(result.files.length,4);assert.equal(api.ids[0].clientId,api.ids[1].clientId);}finally{await f.clean();}
});

test('a storage conflict or bad request alone cannot mark missing bytes verified',async()=>{
 for(const status of [400,409]){const f=await fixture(),api=service(f,{uploadStatus:status});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_API_REJECTED'));assert(api.calls.some(call=>call.endsWith('/verify')));assert.equal(api.stored.size,0);}finally{await f.clean();}}
});

test('rejects untrusted upload hosts, routes, physical path changes and mismatched manifest metadata before PUT',async()=>{
 for(const change of [(url:URL)=>{url.hostname='attacker.invalid';},(url:URL)=>{url.pathname='/api/other';},(url:URL)=>{url.searchParams.set('pathname','studio/other');},(url:URL)=>{url.username='private';}]){
  const f=await fixture(),api=service(f,{url:change});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_UPLOAD_REJECTED'));assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,0);}finally{await f.clean();}
 }
 const f=await fixture(),api=service(f,{wrongFile:true});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_PROTOCOL'));assert.equal(api.stored.size,0);}finally{await f.clean();}
});

test('changed local bytes or a different job never request an upload grant',async()=>{
 const f=await fixture(),api=service(f);try{await writeFile(path.join(f.attempt,'review.png'),Buffer.from('tampered'));await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}));assert.equal(api.calls.length,0);}finally{await f.clean();}
 const other=await fixture(),second=service(other);try{const file=path.join(other.root,other.job.jobId,'result.json'),result=JSON.parse(await readFile(file,'utf8'));result.jobId=randomUUID();await writeFile(file,JSON.stringify(result));await assert.rejects(publishExecutionOutputs({...other.options,fetch:second.transport}),fails('PUBLISH_JOB_MISMATCH'));assert.equal(second.calls.length,0);}finally{await other.clean();}
});

test('requires the exact MIME override pair and rejects missing, changed or extra upload headers',async()=>{
 for(const change of[(headers:Record<string,string>)=>{delete headers['x-content-type'];},(headers:Record<string,string>)=>{headers['x-content-type']='image/aces';},(headers:Record<string,string>)=>{headers.Authorization='fixture-do-not-forward';}]){
  const f=await fixture(),api=service(f,{headers:change});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_UPLOAD_REJECTED'));assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,0);}finally{await f.clean();}
 }
});

test('publisher bounds API body consumption and derives deterministic job-scoped operation IDs',async()=>{
 const jobId=randomUUID();assert.equal(publicationRequestId(jobId,'scene.blend','upload'),publicationRequestId(jobId,'scene.blend','upload'));assert.notEqual(publicationRequestId(jobId,'scene.blend','upload'),publicationRequestId(jobId,'scene.blend','verify'));assert.notEqual(publicationRequestId(jobId,'scene.blend','upload'),publicationRequestId(randomUUID(),'scene.blend','upload'));
 const f=await fixture();let cancelled=false;try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}))}),fails('PUBLISH_PROTOCOL'));assert.equal(cancelled,true);}finally{await f.clean();}
});

async function pendingWorker(f:Awaited<ReturnType<typeof fixture>>,phase:'completing'|'publishing'='completing',publishPrivateMedia=true){
 const workerId='publication-fixture',directory=path.join(f.root,'.connector-state');await mkdir(directory,{recursive:true});
 const result=JSON.parse(await readFile(path.join(f.root,f.job.jobId,'result.json'),'utf8'));
 const state={schemaVersion:1,workerId,binding:executionWorkerBinding(f.options.origin,token),claimId:randomUUID(),phase,jobId:f.job.jobId,publishPrivateMedia,...phase==='completing'?{body:{clientId:randomUUID(),leaseToken:'fixture-lease-value-long-enough',manifest:await executionManifestFromResult(f.root,result)}}:{publication:{attempts:0,nextAttemptAt:0}}};
 const stateFile=path.join(directory,workerId+'.json');await writeFile(stateFile,JSON.stringify(state));
 return{state,stateFile,receiptFile:path.join(directory,workerId+'.publications',f.job.jobId+'.json'),options:{...f.options,workerId,blenderPath:path.join(f.root,'must-not-render'),publishPrivateMedia:true}};
}

test('automatic publication requires an explicit operator flag or exact environment value',()=>{
 assert.deepEqual(executionWorkerMode([],undefined),{once:false,publishPrivateMedia:false});
 assert.deepEqual(executionWorkerMode(['--once'],'false'),{once:true,publishPrivateMedia:false});
 assert.deepEqual(executionWorkerMode(['--once','--publish-private-media'],undefined),{once:true,publishPrivateMedia:true});
 assert.equal(executionWorkerMode([],'true').publishPrivateMedia,true);
 for(const value of ['1','yes','','TRUE'])assert.throws(()=>executionWorkerMode([],value),fails('USAGE'));
 for(const args of [['--upload'],['--once','--once'],['--publish-private-media','https://client.invalid']])assert.throws(()=>executionWorkerMode(args,undefined),fails('USAGE'));
});

test('a fresh opted-in claim follows verified render replay, completion acknowledgement, then publication',async()=>{
 const f=await fixture(),api=service(f),workerId='fresh-publication',stateFile=path.join(f.root,'.connector-state',workerId+'.json'),order:string[]=[];
 const spec={width:f.job.width,height:f.job.height,fpsNumerator:f.job.fpsNumerator,fpsDenominator:f.job.fpsDenominator,format:'exr',colorSpace:f.job.colorSpace};
 try{
  const result=await runExecutionWorkerOnce({...f.options,workerId,blenderPath:path.join(f.root,'must-not-render'),publishPrivateMedia:true,fetch:async(input:any,options:any)=>{
   const endpoint=new URL(String(input)).pathname.split('/').at(-1)!;order.push(endpoint);
   if(endpoint==='claim'){const state=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(state.phase,'claiming');assert.equal(state.publishPrivateMedia,true);return Response.json({job:{id:f.job.jobId,companyId,projectId:randomUUID(),workItemId:randomUUID(),profile:BUILTIN_EXECUTION_PROFILE,spec,inputReferences:[],frameStart:1,frameEnd:1,outputKind:'image_sequence'},leaseToken:'fixture-fresh-claim-lease-long-enough'});}
   if(endpoint==='heartbeat')return Response.json({renewed:true});
   if(endpoint==='complete'){const state=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(state.phase,'completing');assert.equal(state.publishPrivateMedia,true);assert.equal(JSON.parse(options.body).manifest.files.length,4);return Response.json({replayed:false});}
   if(endpoint==='upload')assert(order.includes('complete'),'Completion must be acknowledged before any storage grant');
   return api.transport(input,options);
  }});
  assert.equal(result.status,'completed');assert.equal(api.stored.size,4);assert.equal(order.filter(endpoint=>endpoint==='claim').length,1);assert.equal(order.filter(endpoint=>endpoint==='complete').length,1);assert(!order.includes('fail'));assert(await readFile(path.join(f.root,'.connector-state',workerId+'.publications',f.job.jobId+'.json')));
 }finally{await f.clean();}
});

test('worker commits the exact completion before publishing and records an immutable secret-free receipt',async()=>{
 const f=await fixture(),api=service(f),worker=await pendingWorker(f);let completions=0;const bodies:string[]=[];
 const transport=async(input:any,options:any)=>{
  if(String(input).endsWith('/complete')){bodies.push(options.body);if(++completions===1)throw Error('Response lost after completion commit.');return Response.json({replayed:true});}
  const state=JSON.parse(await readFile(worker.stateFile,'utf8'));assert.equal(state.phase,'publishing');assert.equal(state.body,undefined,'Lease receipt must be removed after acknowledged completion');return api.transport(input,options);
 };
 try{
  await assert.rejects(runExecutionWorkerOnce({...worker.options,fetch:transport}));assert.equal(api.calls.length,0);assert.equal(JSON.parse(await readFile(worker.stateFile,'utf8')).phase,'completing');
  const result=await runExecutionWorkerOnce({...worker.options,fetch:transport});assert.equal(result.status,'completed');assert('body' in worker.state);assert.deepEqual(bodies,[JSON.stringify(worker.state.body),JSON.stringify(worker.state.body)]);
  if(result.status==='completed')assert.deepEqual(result.publication,{status:'verified',files:4,verificationSource:'server_bytes',independentlyReviewed:false});
  const receiptText=await readFile(worker.receiptFile,'utf8'),receipt=JSON.parse(receiptText);assert.equal(receipt.binding,worker.state.binding);assert.equal(receipt.result.files.length,4);assert(!receiptText.includes(token));assert(!receiptText.includes('fixture-lease'));assert(!receiptText.includes('signed'));assert(!receiptText.includes('https://'));
  await assert.rejects(readFile(worker.stateFile),{code:'ENOENT'});
  // A crash after writing the success receipt, before deleting pending state,
  // reconciles server hashes and accepts the same immutable local receipt.
  await writeFile(worker.stateFile,JSON.stringify({...worker.state,phase:'publishing',body:undefined,publication:{attempts:1,nextAttemptAt:0}}));
  const puts=api.calls.filter(call=>call.startsWith('PUT')).length;await runExecutionWorkerOnce({...worker.options,fetch:transport});assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,puts);assert.equal(await readFile(worker.receiptFile,'utf8'),receiptText);assert.equal(completions,2);
 }finally{await f.clean();}
});

test('partial publication survives restart, respects durable backoff and reconciles write-once conflicts before new work',async()=>{
 const f=await fixture(),api=service(f,{uncertainOnce:true}),worker=await pendingWorker(f,'publishing');
 try{
  const pending=await runExecutionWorkerOnce({...worker.options,fetch:api.transport});assert.equal(pending.status,'publication_pending');assert.equal(api.stored.size,1);
  const persisted=JSON.parse(await readFile(worker.stateFile,'utf8'));assert.equal(persisted.phase,'publishing');assert.equal(persisted.publication.attempts,1);assert.equal(persisted.publication.lastError,'PUBLISH_UPLOAD_UNCERTAIN');assert(persisted.publication.nextAttemptAt>Date.now());
  const calls=api.calls.length;assert.deepEqual(await runExecutionWorkerOnce({...worker.options,fetch:api.transport}),pending);assert.equal(api.calls.length,calls,'Backoff must make no network calls');
  persisted.publication.nextAttemptAt=0;await writeFile(worker.stateFile,JSON.stringify(persisted));const completed=await runExecutionWorkerOnce({...worker.options,fetch:api.transport});assert.equal(completed.status,'completed');assert.equal(api.stored.size,4);assert.equal(api.records.size,4);assert.equal(new Set(api.ids.map(item=>item.clientId)).size,8);assert(!api.calls.some(call=>call.includes('/claim')||call.includes('/fail')||call.includes('/complete')));
 }finally{await f.clean();}
});

test('publication opt-in is retained from the original claim and withdrawal stops before transport',async()=>{
 const f=await fixture(),api=service(f),worker=await pendingWorker(f,'completing',false);let completions=0;
 try{
  const result=await runExecutionWorkerOnce({...worker.options,fetch:async(input:any)=>{assert(String(input).endsWith('/complete'));completions++;return Response.json({replayed:true});}});assert.equal(result.status,'completed');assert.equal(completions,1);assert.equal(api.calls.length,0,'Enabling publication later cannot add it to an already accepted claim');
  const pending=await pendingWorker(f,'publishing');await assert.rejects(runExecutionWorkerOnce({...pending.options,publishPrivateMedia:false,fetch:async()=>{throw Error('No transport allowed');}}),fails('WORKER_PUBLICATION_OPT_IN_REQUIRED'));assert.equal(JSON.parse(await readFile(pending.stateFile,'utf8')).phase,'publishing');
  await assert.rejects(runExecutionWorkerOnce({...pending.options,token:'ce_'+randomUUID().replaceAll('-',''),fetch:async()=>{throw Error('No transport allowed');}}),fails('WORKER_STATE_INVALID'));
 }finally{await f.clean();}
});

test('changed outputs, exhausted retries and revoked or expired authority preserve completed jobs for reconciliation',async()=>{
 for(const variant of ['changed','exhausted','revoked','expired'] as const){
  const f=await fixture(),worker=await pendingWorker(f,'publishing');let calls=0;
  try{
   if(variant==='changed')await writeFile(path.join(f.attempt,'review.png'),'altered');
   if(variant==='exhausted')await writeFile(worker.stateFile,JSON.stringify({...worker.state,publication:{attempts:8,nextAttemptAt:0}}));
   await assert.rejects(runExecutionWorkerOnce({...worker.options,fetch:async()=>{calls++;return Response.json({error:variant==='expired'?'connector expired':'connector revoked'},{status:401});}}),fails('WORKER_PUBLICATION_RECONCILIATION_REQUIRED'));
   assert.equal(calls,variant==='revoked'||variant==='expired'?1:0);const state=JSON.parse(await readFile(worker.stateFile,'utf8'));assert.equal(state.phase,'publishing');assert(await readFile(path.join(f.root,f.job.jobId,'result.json')));
   await assert.rejects(runExecutionWorkerOnce({...worker.options,fetch:async()=>{throw Error('No retry allowed');}}),fails('WORKER_PUBLICATION_RECONCILIATION_REQUIRED'));
  }finally{await f.clean();}
 }
});

test('cancellation during a signed PUT preserves uncertain publication for hash-verified restart',async()=>{
 const f=await fixture(),api=service(f),worker=await pendingWorker(f,'publishing'),controller=new AbortController();
 try{
  const result=await runExecutionWorkerOnce({...worker.options,signal:controller.signal,fetch:async(input:any,options:any)=>{
   const response=await api.transport(input,options);
   if(options.method==='PUT'){controller.abort(new Error('Operator stopped the worker after bytes reached storage.'));return new Promise<Response>(()=>{});}
   return response;
  }});assert.equal(result.status,'publication_pending');assert.equal(api.stored.size,1);assert.equal(api.calls.some(call=>call.endsWith('/verify')),false);
  const state=JSON.parse(await readFile(worker.stateFile,'utf8'));assert.equal(state.phase,'publishing');assert.equal(state.publication.lastError,'PUBLISH_UPLOAD_UNCERTAIN');state.publication.nextAttemptAt=0;await writeFile(worker.stateFile,JSON.stringify(state));
  assert.equal((await runExecutionWorkerOnce({...worker.options,fetch:api.transport})).status,'completed');assert.equal(api.stored.size,4);assert(!api.calls.some(call=>/\/(claim|complete|fail)$/.test(call)));
 }finally{await f.clean();}
});

test('transient media service failures retry within the persisted budget without resetting a completed job',async()=>{
 const f=await fixture(),worker=await pendingWorker(f,'publishing');
 try{
  const result=await runExecutionWorkerOnce({...worker.options,fetch:async()=>Response.json({error:'temporarily unavailable'},{status:503})});assert.equal(result.status,'publication_pending');if(result.status==='publication_pending')assert.equal(result.code,'PUBLISH_API_RETRYABLE');
  const state=JSON.parse(await readFile(worker.stateFile,'utf8'));state.publication={attempts:7,nextAttemptAt:0};await writeFile(worker.stateFile,JSON.stringify(state));
  await assert.rejects(runExecutionWorkerOnce({...worker.options,fetch:async()=>Response.json({error:'busy'},{status:429})}),fails('WORKER_PUBLICATION_RECONCILIATION_REQUIRED'));const exhausted=JSON.parse(await readFile(worker.stateFile,'utf8'));assert.equal(exhausted.publication.attempts,8);assert.equal(exhausted.publication.blocked,true);
 }finally{await f.clean();}
});
