import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {access,copyFile,link,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {inspectHiggsfieldArchiveMedia,HiggsfieldMediaInspectionError,type HiggsfieldArchiveMediaInput,type HiggsfieldMediaInspectionCode,type HiggsfieldMediaInspectionOptions} from '../src/lib/higgsfield-media-inspection';

const fixtures=fileURLToPath(new URL('./fixtures/media/',import.meta.url));
const localBin=process.platform==='win32'?join(process.env.LOCALAPPDATA??'', 'Microsoft','WinGet','Links'):'/usr/bin';
const options:HiggsfieldMediaInspectionOptions={
 ffprobePath:process.env.COATRIA_TEST_FFPROBE_PATH??process.env.COATRIA_FFPROBE_PATH??join(localBin,process.platform==='win32'?'ffprobe.exe':'ffprobe'),
 ffmpegPath:process.env.COATRIA_TEST_FFMPEG_PATH??process.env.COATRIA_FFMPEG_PATH??join(localBin,process.platform==='win32'?'ffmpeg.exe':'ffmpeg'),
};
const cases=[['png','image','image/png'],['jpeg','image','image/jpeg'],['webp','image','image/webp'],['mp4','video','video/mp4'],['mov','video','video/quicktime'],['wav','audio','audio/wav'],['mp3','audio','audio/mpeg']] as const;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function input(name:string,expectedKind:HiggsfieldArchiveMediaInput['expectedKind']):Promise<HiggsfieldArchiveMediaInput>{const path=resolve(fixtures,name),bytes=await readFile(path);return {path,expectedKind,expectedBytes:bytes.length,expectedSha256:digest(bytes)};}
function rejects(code:HiggsfieldMediaInspectionCode|HiggsfieldMediaInspectionCode[]){return(error:unknown)=>{assert.ok(error instanceof HiggsfieldMediaInspectionError);assert.ok((Array.isArray(code)?code:[code]).includes(error.code),error.code);assert.doesNotMatch(error.message,/synthetic|secret|credential|https?:|ffmpeg|ffprobe|[A-Z]:\\/i);return true;};}
async function scratch(run:(directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'coatria-media-inspection-'));try{await run(directory);}finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});}}

// These tests deliberately do not skip when a decoder is absent: CI prepares a
// pinned build, and a local developer must provide an actual fd-capable decoder.
test('real decoder prerequisites are installed and expose the seekable fd protocol',async()=>{
 for(const binary of [options.ffprobePath!,options.ffmpegPath!]){
  await assert.doesNotReject(access(binary),'Install a trusted FFmpeg build or configure COATRIA_TEST_FFMPEG_PATH and COATRIA_TEST_FFPROBE_PATH; this is actual decoding proof, not a mock.');
  const result=spawnSync(binary,['-hide_banner','-h','protocol=fd'],{shell:false,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:65536});
  assert.equal(result.status,0);assert.match(result.stdout+result.stderr,/fd AVOptions:/);
 }
});

test('real decoders verify original PNG/JPEG/WebP, MP4/MOV, and WAV/MP3 bytes',{timeout:60000},async t=>{
 for(const[format,kind,mime]of cases)await t.test(format,async()=>{
  const value=await input('synthetic.'+format,kind),result=await inspectHiggsfieldArchiveMedia(value,options);
  assert.equal(result.kind,kind);assert.equal(result.contentType,mime);assert.equal(result.format,format);assert.equal(result.bytes,value.expectedBytes);assert.equal(result.sha256,value.expectedSha256);assert.equal(result.verification,'full_decode');assert.equal(result.inspectionVersion,1);
  if(result.kind==='image'){assert.equal(result.width,16);assert.equal(result.height,16);assert.equal(result.color.primaries,null);assert.equal(result.color.transfer,null);}
  else if(result.kind==='video'){assert.equal(result.width,16);assert.equal(result.height,16);assert.equal(result.durationMs,500);assert.equal(result.frameCount,3);assert.deepEqual(result.frameRate,{numerator:6,denominator:1});assert.equal(result.vfr,false);assert.equal(result.audio,null);assert.deepEqual(result.color,{space:null,primaries:null,transfer:null,range:null});}
  else{assert.equal(result.durationMs,100);assert.equal(result.channels,1);assert.equal(result.sampleRateHz,format==='wav'?8000:44100);assert.equal(result.decodedSamples,format==='wav'?800:4410);}
 });
});

test('observed VFR, insufficient cadence evidence, and embedded audio remain distinct',async()=>{
 const variable=await inspectHiggsfieldArchiveMedia(await input('synthetic-vfr.mp4','video'),options);assert.equal(variable.kind,'video');if(variable.kind!=='video')return;assert.equal(variable.vfr,true);assert.equal(variable.frameRate,null);assert.equal(variable.frameCount,5);assert.equal(variable.durationMs,700,'Decoded timeline includes the last frame duration even when container summary is shorter.');
 const short=await inspectHiggsfieldArchiveMedia(await input('synthetic-short.mp4','video'),options);assert.equal(short.kind,'video');if(short.kind!=='video')return;assert.equal(short.vfr,null);assert.equal(short.frameRate,null);assert.equal(short.frameCount,2);assert.deepEqual(short.averageFrameRate,{numerator:6,denominator:1});
 const withAudio=await inspectHiggsfieldArchiveMedia(await input('synthetic-video-audio.mp4','video'),options);assert.equal(withAudio.kind,'video');if(withAudio.kind!=='video')return;assert.deepEqual(withAudio.audio,{codec:'aac',sampleRateHz:8000,channels:1});
});

test('byte signatures, not file extensions or provider labels, establish the supported format',async()=>scratch(async directory=>{
 const png=await input('synthetic.png','image'),renamed=join(directory,'untrusted.html');await copyFile(png.path,renamed);assert.equal((await inspectHiggsfieldArchiveMedia({...png,path:renamed},options)).contentType,'image/png');
 for(const data of ['<html>private-credential-do-not-log</html>','{"url":"https://private.invalid/secret"}','not a media payload']){const bytes=Buffer.from(data),path=join(directory,'pretends-to-be-image.png');await writeFile(path,bytes);await assert.rejects(inspectHiggsfieldArchiveMedia({path,expectedKind:'image',expectedBytes:bytes.length,expectedSha256:digest(bytes)},options),rejects('MEDIA_UNSUPPORTED'));}
 await assert.rejects(inspectHiggsfieldArchiveMedia({...png,expectedKind:'video'},options),rejects('MEDIA_KIND_MISMATCH'));
}));

test('both half-file and one-byte truncation fail across every supported format',{timeout:60000},async t=>scratch(async directory=>{
 for(const[format,kind]of cases)await t.test(format,async()=>{
  const original=await readFile(join(fixtures,'synthetic.'+format));for(const cut of [1,Math.floor(original.length/2)]){const bytes=original.subarray(0,original.length-cut),path=join(directory,'truncated.'+format);await writeFile(path,bytes);await assert.rejects(inspectHiggsfieldArchiveMedia({path,expectedKind:kind,expectedBytes:bytes.length,expectedSha256:digest(bytes)},options),rejects(['MEDIA_DECODE_FAILED','MEDIA_LIMIT_EXCEEDED']));}
 });
}));

test('exact length/hash and regular private local-file identity are required',async()=>scratch(async directory=>{
 const png=await input('synthetic.png','image');
 await assert.rejects(inspectHiggsfieldArchiveMedia({...png,expectedBytes:png.expectedBytes+1},options),rejects('MEDIA_BYTES_CHANGED'));
 await assert.rejects(inspectHiggsfieldArchiveMedia({...png,expectedSha256:'0'.repeat(64)},options),rejects('MEDIA_BYTES_CHANGED'));
 for(const path of ['https://private.invalid/secret','relative.png',directory,'\\\\private-server\\share\\secret.png'])await assert.rejects(inspectHiggsfieldArchiveMedia({...png,path},options),rejects('MEDIA_INPUT_INVALID'));
 const original=join(directory,'original.png'),alias=join(directory,'hard-link.png');await copyFile(png.path,original);await link(original,alias);await assert.rejects(inspectHiggsfieldArchiveMedia({...png,path:alias},options),rejects('MEDIA_INPUT_INVALID'));
}));

test('dimension, duration, total decoded pixels/samples, frame count, and output budgets are enforced',async()=>{
 const checks:[string,HiggsfieldArchiveMediaInput['expectedKind'],HiggsfieldMediaInspectionOptions['limits']][]=[
  ['synthetic.png','image',{maxDimension:8}],['synthetic.png','image',{maxDecodedPixels:255}],['synthetic.mp4','video',{maxDurationMs:499}],['synthetic-vfr.mp4','video',{maxDurationMs:650}],['synthetic.mp4','video',{maxVideoFrames:2}],['synthetic.mp4','video',{maxDecodedPixels:767}],['synthetic.wav','audio',{maxDecodedSamples:799}],['synthetic.png','image',{maxProbeBytes:16}],
 ];
 for(const[name,kind,limits]of checks)await assert.rejects(inspectHiggsfieldArchiveMedia(await input(name,kind),{...options,limits}),rejects('MEDIA_LIMIT_EXCEEDED'));
 const png=await input('synthetic.png','image');await assert.rejects(inspectHiggsfieldArchiveMedia(png,{...options,limits:{timeoutMs:0}}),rejects('MEDIA_INPUT_INVALID'));await assert.rejects(inspectHiggsfieldArchiveMedia(png,{...options,limits:{maxBytes:png.expectedBytes-1}}),rejects('MEDIA_INPUT_INVALID'));
});

test('abort, deadline, and executable failures use fixed sanitized diagnostics',async()=>{
 const png=await input('synthetic.png','image'),controller=new AbortController();controller.abort(new Error('https://private.invalid/secret'));
 await assert.rejects(inspectHiggsfieldArchiveMedia({...png,signal:controller.signal},options),rejects('MEDIA_INSPECTION_ABORTED'));
 await assert.rejects(inspectHiggsfieldArchiveMedia(png,{...options,limits:{timeoutMs:1}}),rejects('MEDIA_INSPECTION_TIMEOUT'));
 await assert.rejects(inspectHiggsfieldArchiveMedia(png,{...options,ffmpegPath:resolve(fixtures,'missing-private-credential.exe')}),rejects('MEDIA_INSPECTOR_UNAVAILABLE'));
 await assert.rejects(inspectHiggsfieldArchiveMedia(png,{...options,ffmpegPath:'ffmpeg'}),rejects('MEDIA_INSPECTOR_UNAVAILABLE'));
});

test('decoder does not inherit FFREPORT or attempt to write a host diagnostic file',async()=>scratch(async directory=>{
 const report=join(directory,'private-decoder-report.log'),previous=process.env.FFREPORT;
 // FFmpeg normally consumes FFREPORT from the parent environment. The inspector
 // supplies an explicit minimal child environment, so this side effect is absent.
 process.env.FFREPORT='file='+report.replaceAll('\\','/').replaceAll(':','\\:')+':level=48';
 try{
  const control=spawnSync(options.ffprobePath!,['-v','error','-version'],{shell:false,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:65536,env:{NODE_ENV:'production',LANG:'C',LC_ALL:'C',FFREPORT:process.env.FFREPORT,...process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{}}});
  assert.equal(control.status,0);await access(report);await rm(report);
  await inspectHiggsfieldArchiveMedia(await input('synthetic.png','image'),options);await assert.rejects(access(report));
 }finally{if(previous===undefined)delete process.env.FFREPORT;else process.env.FFREPORT=previous;}
}));
