// CI only. Exercises the fixed procedural renderer against actual Linux Blender.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeControlledRender,verifyRenderDirectory,imageDimensions} from '../vfx/renderer.mjs';
import {executionManifestFromResult} from '../vfx/manifest.mjs';

const blenderPath=process.env.COATRIA_BLENDER_PATH??'',outputRoot=process.env.COATRIA_RENDER_CANARY_OUTPUT??'';
if(process.platform!=='linux'||process.arch!=='x64'||!isAbsolute(blenderPath)||!isAbsolute(outputRoot))throw Error('Use the prepared Linux canary paths.');
// The renderer needs no HTTP transport; any accidental future API coupling fails.
globalThis.fetch=async()=>{throw Error('The procedural Linux canary must not call a company/provider API.');};
await mkdir(outputRoot,{recursive:true});
try{
 const job={schemaVersion:1 as const,jobId:randomUUID(),profile:'coatria-product-turntable-v1' as const,frameStart:1001,frameEnd:1004,width:128,height:128,fpsNumerator:24000,fpsDenominator:1001,colorSpace:'ACEScg' as const,samples:16,timeoutSeconds:180};
 const result=await executeControlledRender(job,{outputRoot:join(outputRoot,'renders'),blenderPath});
 assert.equal(result.attempt,1);assert.equal(result.replayed,false);
 const attempt=dirname(join(outputRoot,'renders',job.jobId,result.manifestPath)),manifest=await verifyRenderDirectory(attempt);
 assert.equal(manifest.files.length,6);assert.equal(manifest.files.filter(file=>file.kind==='frame').length,4);
 assert.match(String(manifest.evidence.blenderVersion),/^5\.2\.2(?: LTS)?$/);assert.equal(manifest.evidence.device,'CPU');assert.equal(manifest.evidence.threads,2);assert.equal(manifest.evidence.renderEngine,'CYCLES');assert.equal(manifest.evidence.workingColorSpace,'ACEScg');
 assert.equal(manifest.evidence.fpsNumerator,24000);assert.equal(manifest.evidence.fpsDenominator,1001);assert.match(String(manifest.evidence.ocioConfigSha256),/^[a-f0-9]{64}$/);
 const decoded=manifest.evidence.decodedFrames as Array<{frame:number;width:number;height:number;finitePixelValues:number}>;assert.equal(decoded.length,4);
 for(const [index,frame]of decoded.entries()){assert.equal(frame.frame,1001+index);assert.equal(frame.width,128);assert.equal(frame.height,128);assert.equal(frame.finitePixelValues,128*128*4);}
 assert.equal((await readFile(join(attempt,'scene.blend'))).toString('ascii',0,7),'BLENDER');
 assert.deepEqual(imageDimensions(await readFile(join(attempt,'review.png'))),{width:128,height:128,format:'png'});
 for(let frame=1001;frame<=1004;frame++)assert.deepEqual(imageDimensions(await readFile(join(attempt,'frames',`frame-${frame}.exr`))),{width:128,height:128,format:'exr'});
 const completion=await executionManifestFromResult(join(outputRoot,'renders'),result);assert.equal(completion.files.length,7);assert.deepEqual(completion.spec,{width:128,height:128,fpsNumerator:24000,fpsDenominator:1001,format:'exr',colorSpace:'ACEScg'});
 const replay=await executeControlledRender(job,{outputRoot:join(outputRoot,'renders'),blenderPath});assert.equal(replay.replayed,true);assert.equal(replay.manifestSha256,result.manifestSha256);assert.deepEqual(await readdir(join(outputRoot,'renders',job.jobId,'attempts')),['0001']);
 await copyFile(join(attempt,'review.png'),join(outputRoot,'preview.png'));
 await writeFile(join(outputRoot,'canary.json'),JSON.stringify({status:'passed',platform:process.platform,architecture:process.arch,node:process.version,job,result,completionManifest:completion,blenderEvidence:manifest.evidence,sameJobReplay:true,actualFrameCount:4,companyOrProviderApiUsed:false,runpodLifecycleVerified:false,files:manifest.files},null,2)+'\n');
 console.log(JSON.stringify({event:'linux-renderer-canary-passed',blender:manifest.evidence.blenderVersion,frames:4,width:128,height:128,files:completion.files.length,replayed:true,runpodLifecycleVerified:false}));
}catch(error){await writeFile(join(outputRoot,'canary-failure.json'),JSON.stringify({status:'failed',code:error instanceof Error?error.message:'LINUX_CANARY_FAILED',companyOrProviderApiUsed:false,runpodLifecycleVerified:false},null,2)+'\n');throw error;}
