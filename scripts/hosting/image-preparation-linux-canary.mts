/** Actual isolated transform evidence only. No service enrollment, remote byte
 * transport, provider credentials or production-host acceptance is implied. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {isQualifiedLinuxMediaSandbox,type QualifiedLinuxMediaSandbox,type MediaSandboxExitEvidence} from '../../src/lib/higgsfield-media-sandbox';
import {IMAGE_PREPARATION_RECIPE_HASH,type PreparedReferenceImage} from '../../src/lib/higgsfield-image-preparation';
import {ImagePreparationError} from '../../src/lib/higgsfield-image-preparation-policy';
import {validatePreparedPng} from '../../src/lib/higgsfield-image-preparation-png';
import {createLinuxImagePreparationTransform} from '../../src/lib/project-image-preparation-sandbox';
import {observeReferenceWorkerAttempt} from './reference-worker-linux-canary.mts';
import {mediaSandboxDecoderDisappeared} from './media-sandbox-cgroup-observer.mjs';

type CaseName='png'|'jpeg'|'webp'|'wrong-source-hash'|'pre-aborted'|'cancel-native';
type CaseEvidence={name:CaseName;passed:boolean;outputSha256:string|null;outputBytes:number|null;failureCode:string|null;nativeExecutions:number;nativeEvidence:readonly MediaSandboxExitEvidence[];observedProcesses:number;cancelledDuringNativeRun:boolean;drainedAtReturn:boolean;sourceHandleClosedAtReturn:boolean;sourceUnchanged:boolean};
export type ImagePreparationTransformEvidence={version:1;kind:'image-preparation-isolated-linux-transform';passed:boolean;productionQualified:false;installedServiceQualified:false;enrollmentExercised:false;remoteTransportExercised:false;providerCalls:0;actualLinuxTransform:boolean;recipeSha256:string;profileSha256:string|null;qualificationExecutions:number;cases:CaseEvidence[]};
export function imagePreparationTransformEvidence():ImagePreparationTransformEvidence{return {version:1,kind:'image-preparation-isolated-linux-transform',passed:false,productionQualified:false,installedServiceQualified:false,enrollmentExercised:false,remoteTransportExercised:false,providerCalls:0,actualLinuxTransform:false,recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,profileSha256:null,qualificationExecutions:0,cases:[]};}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';
const snapshots=async()=>(await readdir(tmpdir())).filter(name=>/^coatria-preparation-(?:sandbox|qualification)-/.test(name)).sort();
async function observe(root:string,pids:Set<number>){
 let populated=false;
 for(const name of await readdir(root))if(/^decoder-[a-f0-9-]+$/.test(name)){
  try{const text=(await readFile(join(root,name,'cgroup.procs'),'utf8')).trim();for(const id of text.split(/\s+/).filter(Boolean)){assert.match(id,/^[1-9]\d*$/);pids.add(Number(id));populated=true;}}
  catch(error){if(!await mediaSandboxDecoderDisappeared(error,join(root,name)))throw error;}
 }
 return populated;
}
async function drained(root:string,pids:Set<number>,sourcePath?:string){
 assert.equal((await readdir(root)).filter(name=>name.startsWith('decoder-')).length,0);
 for(const pid of pids)try{const text=await readFile('/proc/'+pid+'/stat','utf8');assert.equal(text.slice(text.lastIndexOf(')')+2).split(' ')[0],'Z');}catch(error){if(!missing(error))throw error;}
 if(sourcePath)for(const fd of await readdir('/proc/self/fd'))try{assert.notEqual(await readlink('/proc/self/fd/'+fd),sourcePath,'Transform retained its source descriptor.');}catch(error){if(!missing(error))throw error;}
}

export async function runImagePreparationLinuxCanary(input:{sandbox:QualifiedLinuxMediaSandbox;profileSha256:string;fixtureRoot:string;cgroupRoot:string;decoderEvents:readonly MediaSandboxExitEvidence[]},report=imagePreparationTransformEvidence()){
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.ok(process.getuid&&process.getuid()>0);assert.ok(isQualifiedLinuxMediaSandbox(input.sandbox));assert.match(input.profileSha256,/^[a-f0-9]{64}$/);
 const qualificationStart=input.decoderEvents.length,initialSnapshots=await snapshots();
 const transform=await createLinuxImagePreparationTransform({sandbox:input.sandbox,expectedProfileSha256:input.profileSha256,recipeSha256:IMAGE_PREPARATION_RECIPE_HASH});
 report.profileSha256=input.profileSha256;report.qualificationExecutions=input.decoderEvents.length-qualificationStart;
 assert.ok(report.qualificationExecutions>=1,'The binary capability must execute its real probe.');report.actualLinuxTransform=true;await drained(input.cgroupRoot,new Set());assert.deepEqual(await snapshots(),initialSnapshots);
 for(const name of ['png','jpeg','webp','wrong-source-hash','pre-aborted','cancel-native'] as const){
  const entry:CaseEvidence={name,passed:false,outputSha256:null,outputBytes:null,failureCode:null,nativeExecutions:0,nativeEvidence:[],observedProcesses:0,cancelledDuringNativeRun:false,drainedAtReturn:false,sourceHandleClosedAtReturn:false,sourceUnchanged:false};report.cases.push(entry);
  const extension=name==='jpeg'||name==='webp'?name:'png',path=join(input.fixtureRoot,'synthetic.'+extension),original=await readFile(path),before=hash(original),controller=new AbortController(),pids=new Set<number>(),eventStart=input.decoderEvents.length;
  if(name==='pre-aborted')controller.abort();
  const outcome=await observeReferenceWorkerAttempt(async()=>{
   try{return {value:await transform({path,expectedBytes:original.length,expectedSha256:name==='wrong-source-hash'?'0'.repeat(64):before,signal:controller.signal})};}
   catch(error){if(!(error instanceof ImagePreparationError))throw error;return {error};}
  },{observe:()=>observe(input.cgroupRoot,pids),cancelOnObservation:name==='cancel-native',stop:()=>{entry.cancelledDuringNativeRun=true;controller.abort();},drained:async()=>{await drained(input.cgroupRoot,pids,path);entry.drainedAtReturn=true;entry.sourceHandleClosedAtReturn=true;}});
  entry.nativeEvidence=input.decoderEvents.slice(eventStart);entry.nativeExecutions=entry.nativeEvidence.length;entry.observedProcesses=pids.size;assert.ok(entry.nativeEvidence.every(event=>event.drained));
  if(['png','jpeg','webp'].includes(name)){
   assert.ok('value'in outcome&&outcome.value);const value:PreparedReferenceImage=outcome.value;
   assert.ok(Buffer.isBuffer(value.bytes));assert.equal(value.bytes[0],0x89);assert.equal(value.source.format,extension);assert.equal(value.recipeHash,IMAGE_PREPARATION_RECIPE_HASH);
   assert.equal(value.output.width,16);assert.equal(value.output.height,16);assert.equal(value.output.metadataRemoved,true);assert.equal(value.output.bytes,value.bytes.length);assert.equal(value.output.sha256,hash(value.bytes));
   validatePreparedPng(value.bytes,{width:16,height:16});entry.outputSha256=value.output.sha256;entry.outputBytes=value.output.bytes;assert.ok(entry.nativeExecutions>=1);value.bytes.fill(0);
  }else{
   assert.ok('error'in outcome&&outcome.error);entry.failureCode=outcome.error.code;
   assert.equal(entry.failureCode,name==='wrong-source-hash'?'PREPARATION_BYTES_CHANGED':'PREPARATION_ABORTED');
   if(name==='cancel-native'){assert.equal(entry.cancelledDuringNativeRun,true);assert.ok(pids.size>0);assert.ok(entry.nativeExecutions>=1);}else assert.equal(entry.nativeExecutions,0);
  }
  assert.equal(hash(await readFile(path)),before);assert.deepEqual(await snapshots(),initialSnapshots);entry.sourceUnchanged=true;entry.passed=true;
 }
 report.passed=true;return report;
}
