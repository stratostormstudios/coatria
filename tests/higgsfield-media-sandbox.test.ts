import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {captureMediaSandboxOutput,createLinuxMediaSandbox,isQualifiedLinuxMediaSandbox,parseMediaSandboxProfile,MediaSandboxError} from '../src/lib/higgsfield-media-sandbox';
import {inspectHiggsfieldArchiveMedia,HiggsfieldMediaInspectionError} from '../src/lib/higgsfield-media-inspection';

function profile(){return {version:1,platform:'linux-x64',runtimeRoot:'/opt/coatria/media/rootfs',files:[{path:'/bin/ffmpeg',bytes:1,sha256:'a'.repeat(64)},{path:'/bin/ffprobe',bytes:2,sha256:'b'.repeat(64)}],launcher:{path:'/opt/coatria/media/launch',sha256:'c'.repeat(64)},bubblewrap:{path:'/usr/bin/bwrap',sha256:'d'.repeat(64)},limits:{memoryBytes:256*1024**2,cpuQuotaMicros:100000,cpuPeriodMicros:100000,pids:32,openFiles:64,wallTimeMs:60000}};}
const invalid=(error:unknown)=>error instanceof MediaSandboxError&&error.code==='INVALID_PROFILE';
test('offline profile parsing snapshots policy but cannot certify host isolation',()=>{
 const source=profile(),parsed=parseMediaSandboxProfile(source);source.files[0].path='/bin/sh';source.limits.pids=100000;
 assert.equal(parsed.files[0].path,'/bin/ffmpeg');assert.equal(parsed.limits.pids,32);assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.files));assert.ok(Object.isFrozen(parsed.files[0]));assert.ok(Object.isFrozen(parsed.limits));
 assert.equal(isQualifiedLinuxMediaSandbox(parsed),false);assert.equal(isQualifiedLinuxMediaSandbox({run:async()=>''}),false);assert.equal(isQualifiedLinuxMediaSandbox({qualified:true}),false);
});
test('profiles reject ambiguous closure paths, alternate launch policy, missing decoders and unlimited resources',()=>{
 const cases:((v:ReturnType<typeof profile>)=>void)[]=[
  v=>{v.files[0].path='/bin/../ffmpeg';},v=>{v.files[0].path='/bin//ffmpeg';},v=>{v.files[0].path='/bin/ffmpeg\0';},
  v=>{v.files.push({...v.files[0]});},v=>{v.files.pop();},v=>{v.files[0].path='/bin/sh';},v=>{v.runtimeRoot='https://untrusted.invalid/runtime';},
  v=>{v.bubblewrap.path='/tmp/bwrap';},v=>{(v as any).extraArgs=['--share-net'];},v=>{(v.files[0] as any).symlink='/usr/bin/ffmpeg';},
  v=>{v.launcher.sha256='latest';},v=>{v.files[0].bytes=Number.MAX_SAFE_INTEGER;},v=>{v.limits.memoryBytes=2**40;},v=>{v.limits.memoryBytes+=1;},
  v=>{v.limits.cpuQuotaMicros=Infinity;},v=>{v.limits.cpuQuotaMicros=v.limits.cpuPeriodMicros+1;},v=>{v.limits.pids=100000;},
  v=>{v.limits.openFiles=100000;},v=>{v.limits.wallTimeMs=0;},v=>{(v.limits as any).allowNetwork=true;},
 ];for(const change of cases){const value=profile();change(value);assert.throws(()=>parseMediaSandboxProfile(value),invalid);}
});
test('an unavailable host or unpinned profile fails with fixed diagnostics and no raw paths',async()=>{
 await assert.rejects(createLinuxMediaSandbox({profilePath:'/private/credential-canary/profile.json',expectedProfileSha256:'not-a-pin',cgroupRoot:'/private/credential-canary/group'}),error=>{
  assert.ok(error instanceof MediaSandboxError);assert.ok(['SANDBOX_UNAVAILABLE','INVALID_PROFILE'].includes(error.code));assert.doesNotMatch(error.message,/credential|private|profile\.json/);assert.equal(error.cause,undefined);return true;
 });
});
async function png(){const path=resolve('tests/fixtures/media/synthetic.png'),bytes=await readFile(path);return {path,expectedKind:'image' as const,expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex')};}
const unavailable=(error:unknown)=>error instanceof HiggsfieldMediaInspectionError&&error.code==='MEDIA_INSPECTOR_UNAVAILABLE';
test('inspector never falls back to native execution when no qualified boundary exists',async()=>{
 const input=await png();await assert.rejects(inspectHiggsfieldArchiveMedia(input),unavailable);
 let invoked=false;await assert.rejects(inspectHiggsfieldArchiveMedia(input,{sandbox:{run:async()=>{invoked=true;return '';}}}),unavailable);assert.equal(invoked,false);
});
test('production rejects the explicit native test option even when configured binary paths exist',async()=>{
 const old=process.env.NODE_ENV;try{Object.defineProperty(process.env,'NODE_ENV',{value:'production',writable:true,configurable:true,enumerable:true});await assert.rejects(inspectHiggsfieldArchiveMedia(await png(),{nativeTestMode:true,ffprobePath:process.execPath,ffmpegPath:process.execPath}),unavailable);}finally{if(old===undefined)delete(process.env as Record<string,string|undefined>).NODE_ENV;else Object.defineProperty(process.env,'NODE_ENV',{value:old,writable:true,configurable:true,enumerable:true});}
});
test('stdout and stderr I/O errors become fixed process failures without unhandled errors',async()=>{
 for(const streamName of ['stdout','stderr'] as const){const stdout=new PassThrough(),stderr=new PassThrough(),codes:string[]=[];
  captureMediaSandboxOutput(stdout,stderr,{maxOutputBytes:1024,maxStderrBytes:1024},code=>codes.push(code));
  const stream=streamName==='stdout'?stdout:stderr;stream.destroy(Error('Synthetic sensitive path and provider credential must never escape'));
  await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(codes,['PROCESS_FAILED']);stdout.destroy();stderr.destroy();
 }
});
test('output capture sees warnings arriving after apparent completion and snapshots byte limits',()=>{
 const stdout=new PassThrough(),stderr=new PassThrough(),codes:string[]=[],bounds={maxOutputBytes:4,maxStderrBytes:4};
 const output=captureMediaSandboxOutput(stdout,stderr,bounds,code=>codes.push(code));stdout.write(Buffer.from('safe'));assert.equal(output.value(),'safe');assert.equal(output.hasWarnings(),false);
 stderr.write(Buffer.from('late'));assert.equal(output.hasWarnings(),true);bounds.maxOutputBytes=1024;stdout.write(Buffer.from('overflow'));assert.deepEqual(codes,['OUTPUT_LIMIT']);assert.equal(output.value(),'safe');stdout.destroy();stderr.destroy();
});
