/** Offline policy/capture tests. These never brand a mock as a qualified host;
 * actual Linux namespace/cgroup/binary conformance is a separate CI canary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,readFile,lstat,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureMediaSandboxBinaryOutput,isQualifiedLinuxImageMediaSandbox} from '../src/lib/higgsfield-media-sandbox';
import {createLinuxImagePreparationTransform,isQualifiedLinuxImagePreparationTransform,finishPrivateImagePreparationScratch,type QualifiedLinuxImagePreparationTransform} from '../src/lib/project-image-preparation-sandbox';
import {fixedImagePreparationCommand,IMAGE_PREPARATION_RECIPE_HASH,prepareReferenceImage,isAllowedPreparationDiagnostic,type ImagePreparationInput,type PreparedReferenceImage} from '../src/lib/higgsfield-image-preparation';
import {ImagePreparationError,IMAGE_PREPARATION_POLICY} from '../src/lib/higgsfield-image-preparation-policy';

// Public contract must remain callable; Readonly<function & props> erases it.
// This type-check-only witness never creates or qualifies a transform.
const invokeQualifiedTransform=(transform:QualifiedLinuxImagePreparationTransform,input:ImagePreparationInput):Promise<PreparedReferenceImage>=>transform(input);
void invokeQualifiedTransform;

test('binary capture preserves invalid UTF8, embedded NUL and split byte sequences without aliasing',()=>{
 const stdout=new PassThrough(),stderr=new PassThrough(),codes:string[]=[],capture=captureMediaSandboxBinaryOutput(stdout,stderr,{maxOutputBytes:1024,maxStderrBytes:1024},code=>codes.push(code));
 const bytes=Buffer.from([0,255,254,128,192,175,226,130,172,0,137,80,78,71]),original=Buffer.from(bytes);
 stdout.write(bytes.subarray(0,7));stdout.write(bytes.subarray(7));bytes.fill(42);
 assert.ok(Buffer.isBuffer(capture.value()));assert.deepEqual(capture.value(),original);
 const leaked=capture.value();leaked.fill(0);assert.deepEqual(capture.value(),original,'Returned bytes cannot mutate the captured buffer');
 assert.deepEqual(codes,[]);stdout.destroy();stderr.destroy();
});

test('binary output and stderr bounds are snapshotted and late pipe errors fail closed',async()=>{
 for(const stream of ['stdout','stderr'] as const){
  const stdout=new PassThrough(),stderr=new PassThrough(),codes:string[]=[],bounds={maxOutputBytes:4,maxStderrBytes:4};
  const capture=captureMediaSandboxBinaryOutput(stdout,stderr,bounds,code=>codes.push(code));
  const selected=stream==='stdout'?stdout:stderr;selected.write(Buffer.from([0,255,1,128]));bounds.maxOutputBytes=4096;bounds.maxStderrBytes=4096;selected.write(Buffer.from([5]));
  assert.deepEqual(codes,['OUTPUT_LIMIT']);assert.equal(stream==='stdout'?capture.value().length:capture.diagnostics().length,4);
  selected.destroy(Error('PRIVATE_PROVIDER_SECRET must never escape'));await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(codes,['OUTPUT_LIMIT','PROCESS_FAILED']);stdout.destroy();stderr.destroy();
 }
});

test('binary diagnostics are considered after all bytes including late damage notices',()=>{
 const stdout=new PassThrough(),stderr=new PassThrough(),capture=captureMediaSandboxBinaryOutput(stdout,stderr,{maxOutputBytes:1024,maxStderrBytes:65536},()=>assert.fail('Unexpected bound exceeded'));
 stdout.write(Buffer.from([137,80,78,71]));const first=capture.value();
 stderr.write(Buffer.from('[swscaler @ 0x123AbC] deprecated pixel format used, make sure you did set range correctly\n'));
 assert.equal(isAllowedPreparationDiagnostic('jpeg',capture.diagnostics()),true);assert.equal(isAllowedPreparationDiagnostic('png',capture.diagnostics()),false);
 stderr.write(Buffer.from('corrupt frame\n'));assert.equal(isAllowedPreparationDiagnostic('jpeg',capture.diagnostics()),false);assert.deepEqual(capture.value(),first);stdout.destroy();stderr.destroy();
});

test('fixed transform derives only reviewed demuxer, orientation and bounded size',()=>{
 const input={format:'jpeg' as const,width:4096,height:2048,orientation:6 as const},command=fixedImagePreparationCommand(input);
 input.width=1;assert.deepEqual(command.size,{width:1024,height:2048});assert.ok(Object.isFrozen(command)&&Object.isFrozen(command.args)&&Object.isFrozen(command.size));
 assert.equal(command.args[command.args.indexOf('-protocol_whitelist')+1],'fd,pipe');assert.equal(command.args[command.args.indexOf('-i')+1],'fd:');
 assert.equal(command.args[command.args.indexOf('-format_whitelist')+1],'jpeg_pipe');assert.equal(command.args[command.args.indexOf('-codec_whitelist')+1],'mjpeg');
 assert.match(command.args[command.args.indexOf('-vf')+1],/^sidedata=mode=delete,transpose=1,scale=1024:2048:flags=lanczos:in_range=full:out_range=full,/);
 assert.deepEqual(command.args.slice(-3),['-f','image2pipe','pipe:1']);assert.equal(command.args.includes('-noautorotate'),true);
 for(const format of ['png','webp'] as const)assert.deepEqual(fixedImagePreparationCommand({format,width:31,height:17,orientation:1}).size,{width:31,height:17});
 const source={format:'png',width:96,height:64,orientation:1};
 for(const patch of [{args:['-i','https://private.invalid']},{tool:'ffprobe'},{format:'https://private.invalid'},{orientation:9},{orientation:1.5},{width:NaN},{height:8193},{width:8192,height:8192}]){
  assert.throws(()=>fixedImagePreparationCommand({...source,...patch} as any),error=>error instanceof ImagePreparationError&&['PREPARATION_INPUT_INVALID','PREPARATION_LIMIT_EXCEEDED'].includes(error.code));
 }
});

test('production factory refuses fake qualification, stale recipe and all request callbacks before execution',async()=>{
 let calls=0;const sandbox={profileSha256:'a'.repeat(64),run:async()=>{calls++;return 'not qualified';},prepareImage:async()=>{calls++;return Buffer.from('not a PNG');}};
 for(const supplied of [sandbox,Object.freeze({...sandbox}),new Proxy(sandbox,{}),{...sandbox,qualified:true}]){
  assert.equal(isQualifiedLinuxImageMediaSandbox(supplied),false);
  for(const patch of [{},{recipeSha256:'b'.repeat(64)},{expectedProfileSha256:'wrong'},{onOutput:()=>{}},{nativeTestMode:true},{args:['-i','https://private.invalid']}]){
   await assert.rejects(createLinuxImagePreparationTransform({sandbox:supplied,expectedProfileSha256:'a'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,...patch} as any),error=>{
    assert.ok(error instanceof ImagePreparationError);assert.equal(error.code,'PREPARATION_UNAVAILABLE');assert.doesNotMatch(error.message,/private|https|qualified;/);assert.equal(error.cause,undefined);return true;
   });
  }
 }
 const imitation=Object.assign(async()=>({}),{profileSha256:'a'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH});assert.equal(isQualifiedLinuxImagePreparationTransform(imitation),false);assert.equal(calls,0);
});

test('native fixture execution remains unavailable in production even with explicit opt-in',async()=>{
 const environment=process.env as Record<string,string|undefined>,before=environment.NODE_ENV;environment.NODE_ENV='production';
 try{await assert.rejects(prepareReferenceImage({path:'/private/source.png',expectedBytes:1,expectedSha256:'a'.repeat(64)},{nativeTestMode:true,ffmpegPath:process.execPath,ffmpegSha256:'a'.repeat(64)}),{code:'PREPARATION_UNAVAILABLE'});}
 finally{if(before===undefined)delete environment.NODE_ENV;else environment.NODE_ENV=before;}
 assert.equal(IMAGE_PREPARATION_POLICY.outputMaxBytes,10*1024**2);
});

test('private snapshots remain after unknown descendant or local cleanup, without granting qualification',async()=>{
 for(const failure of ['descendants','descriptor','none'] as const){
  const directory=await mkdtemp(join(tmpdir(),'coatria-sandbox-cleanup-test-')),path=join(directory,'input'),bytes=Buffer.from([0,255,137,80,78,71]);
  await writeFile(path,bytes);const identity=await lstat(directory),file=await open(path,'r'),close=file.close.bind(file);let closed=false;
  file.close=async()=>{await close();closed=true;if(failure==='descriptor')throw Error('PRIVATE_CLEANUP_PATH');};
  try{
   const completion=finishPrivateImagePreparationScratch([file],{path:directory,identity},failure!=='descendants');
   if(failure==='none'){await completion;await assert.rejects(lstat(directory),{code:'ENOENT'});}
   else{await assert.rejects(completion,error=>error instanceof ImagePreparationError&&error.code==='PREPARATION_CLEANUP_FAILED'&&!error.message.includes('PRIVATE'));assert.deepEqual(await readFile(path),bytes);}
   assert.equal(closed,true,'Supervisor FD close does not certify descendant drain');assert.equal(isQualifiedLinuxImagePreparationTransform(finishPrivateImagePreparationScratch),false);
  }finally{await close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
 }
});
