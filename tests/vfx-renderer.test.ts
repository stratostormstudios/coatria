import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {controlledRenderJobSchema,executeControlledRender,imageDimensions,renderJobDigest,RenderError,runBoundedProcess,sha256File,verifyRenderDirectory,type ControlledRenderJob,type RenderManifest,type RenderResult} from '../scripts/vfx/renderer.mjs';
import {executionManifestFromResult,executionWorkerBinding,runExecutionWorkerOnce} from '../scripts/vfx/worker.mjs';

const baseJob=()=>controlledRenderJobSchema.parse({schemaVersion:1,jobId:randomUUID(),profile:'coatria-product-turntable-v1',frameStart:1001,frameEnd:1002,width:128,height:128,fpsNumerator:24000,fpsDenominator:1001,samples:4,timeoutSeconds:120});
const failsWith=(code:string)=>(error:unknown)=>error instanceof RenderError&&error.code===code;
async function temporary(){const root=await mkdtemp(path.join(tmpdir(),'coatria-vfx-test-'));return {root,async clean(){assert.equal(path.dirname(root),path.resolve(tmpdir()));assert(path.basename(root).startsWith('coatria-vfx-test-'));await rm(root,{recursive:true,force:true});}};}
function pngHeader(width:number,height:number){const buffer=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer);buffer.writeUInt32BE(13,8);buffer.write('IHDR',12);buffer.writeUInt32BE(width,16);buffer.writeUInt32BE(height,20);return buffer;}
function exrHeader(width:number,height:number){const names=Buffer.from('dataWindow\0box2i\0'),buffer=Buffer.alloc(8+names.length+4+16+40);buffer.writeUInt32LE(20000630);buffer.writeUInt32LE(2,4);names.copy(buffer,8);let offset=8+names.length;buffer.writeUInt32LE(16,offset);offset+=4;buffer.writeInt32LE(width-1,offset+8);buffer.writeInt32LE(height-1,offset+12);return buffer;}
/** Header-only unit data exercises verification logic; it is not render evidence. */
async function sealedFixture(root:string,job=baseJob()){
  const attempt=path.join(root,job.jobId,'attempts','0001');await mkdir(path.join(attempt,'frames'),{recursive:true});
  const files:RenderManifest['files']=[];
  const add=async(relative:string,kind:'scene'|'review'|'frame',bytes:Buffer,frame?:number)=>{const target=path.join(attempt,relative);await writeFile(target,bytes);files.push({path:relative,kind,sizeBytes:bytes.length,sha256:await sha256File(target),...kind==='scene'?{}:{width:job.width,height:job.height},...frame===undefined?{}:{frame}});};
  await add('scene.blend','scene',Buffer.concat([Buffer.from('BLENDER'),Buffer.alloc(64)]));await add('review.png','review',pngHeader(job.width,job.height));
  for(let frame=job.frameStart;frame<=job.frameEnd;frame++)await add(`frames/frame-${frame}.exr`,'frame',exrHeader(job.width,job.height),frame);
  const manifest:RenderManifest={schemaVersion:1,job,jobSpecSha256:renderJobDigest(job),profileSha256:'a'.repeat(64),attempt:1,files,evidence:{blenderVersion:'unit fixture',blenderBuildHash:'fixture'},createdAt:new Date().toISOString()};
  await writeFile(path.join(attempt,'manifest.json'),JSON.stringify(manifest));await writeFile(path.join(root,job.jobId,'job.json'),JSON.stringify(job));
  const result:RenderResult={schemaVersion:1,status:'succeeded',jobId:job.jobId,attempt:1,manifestPath:'attempts/0001/manifest.json',manifestSha256:await sha256File(path.join(attempt,'manifest.json')),elapsedMs:1,replayed:false};
  await writeFile(path.join(root,job.jobId,'result.json'),JSON.stringify(result));return {job,attempt,manifest,result};
}

test('controlled renderer accepts only bounded declarative parameters, exact rational rates and reviewed colors',()=>{
  const job=baseJob();assert.equal(job.fpsNumerator/job.fpsDenominator,24000/1001);
  for(const changed of [{command:'arbitrary'},{python:'arbitrary'},{inputPath:'private.blend'},{profile:'unreviewed'},{width:2048},{frameEnd:job.frameStart+24},{fpsNumerator:23.976},{fpsDenominator:0},{fpsNumerator:120},{colorSpace:'pretend-ACES'},{timeoutSeconds:601}])assert.equal(controlledRenderJobSchema.safeParse({...job,...changed}).success,false);
  assert.equal(controlledRenderJobSchema.safeParse({...job,width:1024,height:1024,frameEnd:job.frameStart+23}).success,false);
  assert.equal(controlledRenderJobSchema.safeParse({...job,colorSpace:'ACEScg'}).success,true);
  assert.equal(renderJobDigest({...job,samples:8})===renderJobDigest(job),false);
});

test('image metadata comes from actual PNG and EXR header fields and rejects malformed input',()=>{
  assert.deepEqual(imageDimensions(pngHeader(640,480)),{width:640,height:480,format:'png'});
  assert.deepEqual(imageDimensions(exrHeader(1920,1080)),{width:1920,height:1080,format:'exr'});
  assert.throws(()=>imageDimensions(Buffer.from('not media')),failsWith('OUTPUT_INVALID'));
  assert.throws(()=>imageDimensions(exrHeader(10,10).subarray(0,20)),failsWith('OUTPUT_INVALID'));
});

test('sealed outputs reject missing frames, changed hashes and wrong dimensions',async()=>{
  const temp=await temporary();try{
    const fixture=await sealedFixture(temp.root);assert.equal((await verifyRenderDirectory(fixture.attempt)).files.length,4);
    const frame=path.join(fixture.attempt,'frames','frame-1001.exr'),original=await readFile(frame);
    await writeFile(frame,exrHeader(fixture.job.width+1,fixture.job.height));await assert.rejects(verifyRenderDirectory(fixture.attempt),failsWith('OUTPUT_DIMENSIONS'));
    const altered=Buffer.from(original);altered[altered.length-1]=1;await writeFile(frame,altered);await assert.rejects(verifyRenderDirectory(fixture.attempt),failsWith('OUTPUT_HASH_MISMATCH'));
    await writeFile(frame,original);await rename(frame,frame+'.missing');await assert.rejects(verifyRenderDirectory(fixture.attempt),failsWith('FRAME_SET_MISMATCH'));
  }finally{await temp.clean();}
});

test('same-job restart verifies and replays sealed results; changed specs and corrupt outputs never rerender',async()=>{
  const temp=await temporary();try{
    const fixture=await sealedFixture(temp.root),options={outputRoot:temp.root,blenderPath:path.join(temp.root,'renderer-must-not-be-started.exe')};
    const replay=await executeControlledRender(fixture.job,options);assert.equal(replay.replayed,true);assert.equal(replay.manifestSha256,fixture.result.manifestSha256);
    await assert.rejects(executeControlledRender({...fixture.job,samples:8},options),failsWith('JOB_CONFLICT'));
    const frame=path.join(fixture.attempt,'frames','frame-1001.exr');await writeFile(frame,Buffer.concat([await readFile(frame),Buffer.from([1])]));
    await assert.rejects(executeControlledRender(fixture.job,options),failsWith('OUTPUT_HASH_MISMATCH'));
    assert.deepEqual(await readdir(path.join(temp.root,fixture.job.jobId,'attempts')),['0001']);
  }finally{await temp.clean();}
});

test('uncertain local attempts are retained and require reconciliation instead of automatic rerender',async()=>{
  const temp=await temporary();try{
    const job=baseJob();await mkdir(path.join(temp.root,job.jobId,'attempts','0001'),{recursive:true});
    await writeFile(path.join(temp.root,job.jobId,'job.json'),JSON.stringify(job));
    await assert.rejects(executeControlledRender(job,{outputRoot:temp.root,blenderPath:process.execPath}),failsWith('JOB_RECONCILIATION_REQUIRED'));
    assert.deepEqual(await readdir(path.join(temp.root,job.jobId,'attempts')),['0001']);
  }finally{await temp.clean();}
});

test('bounded subprocess timeout terminates its owned process and returns measured failure',async()=>{
  const temp=await temporary();try{
    let pid=0;const started=Date.now();const result=await runBoundedProcess(process.execPath,['--eval','setInterval(()=>{},1000)'],{cwd:temp.root,timeoutMs:150,onSpawn:async value=>{pid=value;}});
    assert.equal(result.timedOut,true);assert.notEqual(result.code,0);assert(Date.now()-started<7000);assert.throws(()=>process.kill(pid,0));
  }finally{await temp.clean();}
});

test('lease cancellation signal terminates rendering instead of allowing background work to continue',async()=>{
  const temp=await temporary(),controller=new AbortController();try{
    let pid=0;const timer=setTimeout(()=>controller.abort(),150);
    const result=await runBoundedProcess(process.execPath,['--eval','setInterval(()=>{},1000)'],{cwd:temp.root,timeoutMs:10000,signal:controller.signal,onSpawn:async value=>{pid=value;}});clearTimeout(timer);
    assert.equal(result.interrupted,true);assert.equal(result.timedOut,false);assert.throws(()=>process.kill(pid,0));
  }finally{await temp.clean();}
});

test('connector manifests reference only exact verified files and preserve rational image spec',async()=>{
  const temp=await temporary();try{
    const fixture=await sealedFixture(temp.root),manifest=await executionManifestFromResult(temp.root,fixture.result);
    assert.equal(manifest.files.filter(file=>file.kind==='image').length,2);assert.equal(manifest.files.filter(file=>file.kind==='scene').length,1);
    assert.equal(manifest.spec?.fpsNumerator,24000);assert.equal(manifest.spec?.fpsDenominator,1001);assert.equal(manifest.spec?.colorSpace,'Linear Rec.709');
    assert(manifest.files.every(file=>file.path.startsWith(fixture.job.jobId+'/attempts/0001/')));
    assert.equal(manifest.verification.frameCoverage,true);
  }finally{await temp.clean();}
});

test('idle connector cycle uses only execution credentials and removes its private claim state',async()=>{
  const temp=await temporary();try{
    const calls:string[]=[],token='ce_'+'a'.repeat(40);
    const fakeFetch:typeof fetch=async(input,init)=>{const url=String(input);calls.push(url);assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+token);assert.equal(init?.redirect,'error');return Response.json(url.endsWith('/identity')?{id:randomUUID()}:{job:null});};
    const result=await runExecutionWorkerOnce({origin:'http://127.0.0.1:4180',token,workerId:'fixture-worker',outputRoot:temp.root,blenderPath:process.execPath,fetch:fakeFetch});
    assert.deepEqual(result,{status:'idle'});assert.equal(calls.length,2);assert.deepEqual(await readdir(path.join(temp.root,'.connector-state')),[]);
  }finally{await temp.clean();}
});

test('lost completion response replays the exact durable body before any new claim or render',async()=>{
  const temp=await temporary();try{
    const directory=path.join(temp.root,'.connector-state');await mkdir(directory);const jobId=randomUUID(),body={leaseToken:'lease-fixture-value-long-enough',clientId:randomUUID(),manifest:{fixture:true}},state={schemaVersion:1,workerId:'fixture-worker',binding:executionWorkerBinding('http://127.0.0.1:4180','ce_'+'a'.repeat(40)),claimId:randomUUID(),phase:'completing',jobId,body};
    const file=path.join(directory,'fixture-worker.json');await writeFile(file,JSON.stringify(state));
    const options={origin:'http://127.0.0.1:4180',token:'ce_'+'a'.repeat(40),workerId:'fixture-worker',outputRoot:temp.root,blenderPath:path.join(temp.root,'must-not-render.exe')};
    await assert.rejects(runExecutionWorkerOnce({...options,fetch:async()=>{throw new Error('Simulated lost response');}}));
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),state);
    const result=await runExecutionWorkerOnce({...options,fetch:async(input,init)=>{assert(String(input).endsWith(`/jobs/${jobId}/complete`));assert.deepEqual(JSON.parse(String(init?.body)),body);return Response.json({replayed:true});}});
    assert.equal(result.status,'completed');assert.equal('replayed'in result&&result.replayed,true);assert.deepEqual(await readdir(directory),[]);
  }finally{await temp.clean();}
});

test('connector restart with an uncertain render fails closed before network or execution',async()=>{
  const temp=await temporary();try{
    const directory=path.join(temp.root,'.connector-state');await mkdir(directory);await writeFile(path.join(directory,'fixture-worker.json'),JSON.stringify({schemaVersion:1,workerId:'fixture-worker',binding:executionWorkerBinding('http://127.0.0.1:4180','ce_'+'a'.repeat(40)),claimId:randomUUID(),phase:'uncertain',jobId:randomUUID()}));
    await assert.rejects(runExecutionWorkerOnce({origin:'http://127.0.0.1:4180',token:'ce_'+'a'.repeat(40),workerId:'fixture-worker',outputRoot:temp.root,blenderPath:process.execPath,fetch:async()=>{throw new Error('No request is allowed');}}),failsWith('WORKER_RECONCILIATION_REQUIRED'));
    assert((await readdir(directory)).includes('fixture-worker.json'));
  }finally{await temp.clean();}
});

test('pending private receipts cannot be replayed to another origin or connector credential',async()=>{
  const temp=await temporary();try{
    const directory=path.join(temp.root,'.connector-state');await mkdir(directory);await writeFile(path.join(directory,'fixture-worker.json'),JSON.stringify({schemaVersion:1,workerId:'fixture-worker',binding:executionWorkerBinding('https://coatria.example','ce_'+'b'.repeat(40)),claimId:randomUUID(),phase:'completing',jobId:randomUUID(),body:{private:'receipt'}}));
    let requests=0;
    await assert.rejects(runExecutionWorkerOnce({origin:'http://127.0.0.1:4180',token:'ce_'+'a'.repeat(40),workerId:'fixture-worker',outputRoot:temp.root,blenderPath:process.execPath,fetch:async()=>{requests++;return Response.json({});}}),failsWith('WORKER_STATE_INVALID'));
    assert.equal(requests,0);
  }finally{await temp.clean();}
});

test('connector HTTP responses are bounded while streaming',async()=>{
  const temp=await temporary();try{
    let cancelled=false;
    await assert.rejects(runExecutionWorkerOnce({origin:'http://127.0.0.1:4180',token:'ce_'+'a'.repeat(40),workerId:'fixture-worker',outputRoot:temp.root,blenderPath:process.execPath,fetch:async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}}))}),failsWith('WORKER_PROTOCOL'));
    assert.equal(cancelled,true);
  }finally{await temp.clean();}
});

test('installed Blender produces a native scene, actual EXR frames and a PNG; failed startup retries without overwriting evidence',{skip:process.env.COATRIA_TEST_BLENDER!=='1',timeout:180000},async()=>{
  const temp=await temporary();try{
    const blenderPath=process.env.COATRIA_BLENDER_PATH||'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',job=baseJob();
    await assert.rejects(executeControlledRender(job,{outputRoot:temp.root,blenderPath:path.join(temp.root,'missing-blender.exe')}),failsWith('PROCESS_START_FAILED'));
    const result=await executeControlledRender(job,{outputRoot:temp.root,blenderPath});assert.equal(result.attempt,2);
    const directory=path.dirname(path.join(temp.root,job.jobId,result.manifestPath)),manifest=await verifyRenderDirectory(directory);
    assert.equal(manifest.files.length,4);assert.equal(manifest.files.filter(file=>file.kind==='frame').length,2);assert.equal(manifest.evidence.workingColorSpace,'Linear Rec.709');assert.match(String(manifest.evidence.ocioConfigSha256),/^[a-f0-9]{64}$/);
    assert.equal((await readFile(path.join(directory,'scene.blend'))).toString('ascii',0,7),'BLENDER');
    assert.deepEqual(imageDimensions(await readFile(path.join(directory,'review.png'))),{width:128,height:128,format:'png'});
    const replay=await executeControlledRender(job,{outputRoot:temp.root,blenderPath});assert.equal(replay.replayed,true);assert.equal(replay.attempt,2);
    assert((await readdir(path.join(temp.root,job.jobId,'attempts','0001'))).includes('failure.json'));
    const frame=path.join(directory,'frames','frame-1001.exr');await rename(frame,frame+'.missing');await assert.rejects(verifyRenderDirectory(directory),failsWith('FRAME_SET_MISMATCH'));
  }finally{await temp.clean();}
});
