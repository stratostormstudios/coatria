/** Synthetic reference integration only. Actual Linux decoder, local bytes and
 * in-memory authority receipts; no installed-service or provider qualification. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,readlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isQualifiedLinuxMediaSandbox,type QualifiedLinuxMediaSandbox,type MediaSandboxExitEvidence} from '../../src/lib/higgsfield-media-sandbox';
import {createHiggsfieldReferenceInspector,createHiggsfieldReferenceWorker,type HiggsfieldReferenceWorkerResult} from '../../src/lib/higgsfield-reference-worker';
import type {HiggsfieldReferenceLease} from '../../src/lib/higgsfield-references-protocol';

type CaseName='png'|'jpeg'|'webp'|'wrong-kind'|'corrupt-png'|'cancel-native';
type CaseEvidence={name:CaseName;passed:boolean;status:HiggsfieldReferenceWorkerResult['status']|null;inspectionRecorded:boolean;nativeExecutions:number;nativeEvidence:MediaSandboxExitEvidence[];observedProcesses:number;cancelledDuringNativeRun:boolean;drainedAtReturn:boolean;scratchEmptyAtReturn:boolean;scratchHandlesClosedAtReturn:boolean;sourceUnchanged:boolean};
export type ReferenceWorkerIntegrationEvidence={version:1;kind:'reference-worker-synthetic-linux-integration';passed:boolean;productionQualified:false;installedServiceQualified:false;enrollmentExercised:false;providerCalls:number;syntheticAuthority:true;syntheticStorage:true;actualLinuxInspector:true;unchangedPreparedImages:true;cases:CaseEvidence[]};
export function referenceWorkerIntegrationEvidence():ReferenceWorkerIntegrationEvidence{return {version:1,kind:'reference-worker-synthetic-linux-integration',passed:false,productionQualified:false,installedServiceQualified:false,enrollmentExercised:false,providerCalls:0,syntheticAuthority:true,syntheticStorage:true,actualLinuxInspector:true,unchangedPreparedImages:true,cases:[]};}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const text=async(path:string)=>(await readFile(path,'utf8')).trim();
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';

/** Observation failure must still abort and drain the actual worker attempt.
 * No observer timer or rejected outcome can detach native cleanup. */
export async function observeReferenceWorkerAttempt<T>(run:()=>Promise<T>,io:{observe:()=>Promise<boolean>;stop:()=>void;drained:()=>Promise<void>;cancelOnObservation?:boolean}){
 let settled=false,cancelled=false;
 const outcome=Promise.resolve().then(run).then(value=>({ok:true as const,value}),error=>({ok:false as const,error})).finally(()=>{settled=true;});
 try{
  while(!settled){if(await io.observe()&&!settled&&io.cancelOnObservation&&!cancelled){cancelled=true;io.stop();}if(!settled)await delay(1);}
  const result=await outcome;if(!result.ok)throw result.error;return result.value;
 }finally{if(!settled)io.stop();await outcome;await io.drained();}
}

async function observeGroups(root:string,pids:Set<number>){
 let populated=false;
 for(const name of await readdir(root))if(/^decoder-[a-f0-9-]+$/.test(name)){
  try{const value=await text(join(root,name,'cgroup.procs'));for(const id of value.split(/\s+/).filter(Boolean)){assert.match(id,/^[1-9]\d*$/);pids.add(Number(id));populated=true;}}catch(error){if(!missing(error))throw error;}
 }
 return populated;
}
async function assertNoDescendants(root:string,pids:Set<number>){
 // Check at worker return, without waiting for cleanup to catch up afterwards.
 assert.equal((await readdir(root)).filter(name=>name.startsWith('decoder-')).length,0);
 for(const pid of pids)try{const value=await text('/proc/'+pid+'/stat');assert.equal(value.slice(value.lastIndexOf(')')+2).split(' ')[0],'Z');}catch(error){if(!missing(error))throw error;}
}
async function assertNoScratchHandles(root:string){
 for(const name of await readdir('/proc/self/fd'))try{const target=await readlink('/proc/self/fd/'+name);assert.ok(target!==root&&!target.startsWith(root+'/'),'Worker retained a scratch file descriptor.');}catch(error){if(!missing(error))throw error;}
}

export async function runReferenceWorkerLinuxCanary(input:{sandbox:QualifiedLinuxMediaSandbox;profileSha256:string;fixtureRoot:string;scratchParent:string;cgroupRoot:string;decoderEvents:readonly MediaSandboxExitEvidence[]},report=referenceWorkerIntegrationEvidence()){
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.ok(process.getuid&&process.getuid()>0);assert.ok(isQualifiedLinuxMediaSandbox(input.sandbox));assert.match(input.profileSha256,/^[a-f0-9]{64}$/);
 const inspect=createHiggsfieldReferenceInspector(input.sandbox),scratchRoot=await mkdtemp(join(input.scratchParent,'reference-worker-'));
 const companyId=randomUUID(),projectId=randomUUID();
 const forbidden=async():Promise<never>=>{report.providerCalls++;throw Error('REFERENCE_CANARY_PROVIDER_CALL_FORBIDDEN');};
 try{
  for(const name of ['png','jpeg','webp','wrong-kind','corrupt-png','cancel-native'] as const){
   const entry:CaseEvidence={name,passed:false,status:null,inspectionRecorded:false,nativeExecutions:0,nativeEvidence:[],observedProcesses:0,cancelledDuringNativeRun:false,drainedAtReturn:false,scratchEmptyAtReturn:false,scratchHandlesClosedAtReturn:false,sourceUnchanged:false};report.cases.push(entry);
   const extension=name==='wrong-kind'?'mp4':name==='corrupt-png'||name==='cancel-native'?'png':name,fixturePath=join(input.fixtureRoot,'synthetic.'+extension),original=await readFile(fixturePath),before=hash(original);
   const bytes=name==='corrupt-png'?original.subarray(0,Math.min(40,original.length-1)):original;
   const expiresAt=new Date(Date.now()+120000).toISOString(),contentType=name==='jpeg'?'image/jpeg':name==='webp'?'image/webp':'image/png';
   const lease:HiggsfieldReferenceLease={companyId,projectId,referenceId:randomUUID(),leaseId:randomUUID(),requestHash:hash(Buffer.from(name)),phase:'inspect',expiresAt,proxy:{versionId:randomUUID(),fileId:randomUUID(),name:'synthetic.'+extension,version:1,bytes:bytes.length,sha256:hash(bytes),contentType},role:'image',inspection:null};
   const controller=new AbortController(),pids=new Set<number>(),eventStart=input.decoderEvents.length;let failureReceipts=0,reads=0,inspections=0;
   const worker=createHiggsfieldReferenceWorker({scratchRoot,inspectionProfileSha256:input.profileSha256,companyId,projectIds:[projectId],operationDeadlineMs:30000},{
    readiness:async()=>({enabled:true,hostQualified:true,storageVerified:true,catalogVerified:true,profileSha256:input.profileSha256,expiresAt}),
    claim:async()=>lease,authorize:async received=>{assert.deepEqual(received,lease);return true;},
    readProxy:async received=>{reads++;assert.deepEqual(received,lease);return {stream:new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(bytes));c.close();}}),bytes:bytes.length,totalBytes:bytes.length,etag:'"synthetic-exact-version"',contentType,range:null,contentRange:null};},
    inspectMedia:inspect,
    recordInspection:async(received,inspection)=>{inspections++;assert.deepEqual(received,lease);assert.equal(inspection.profileSha256,input.profileSha256);assert.equal(inspection.descriptor.verification,'full_decode');assert.equal(inspection.descriptor.format,extension);assert.equal(inspection.descriptor.width,16);assert.equal(inspection.descriptor.height,16);assert.equal(inspection.descriptor.bytes,bytes.length);assert.equal(inspection.descriptor.sha256,hash(bytes));},
    fail:async(received,failure)=>{failureReceipts++;assert.deepEqual(received,lease);assert.equal(failure.uncertain,false);},
    beginPut:forbidden,completePut:forbidden,upload:forbidden,broker:{allocate:forbidden,uploadCapability:forbidden,confirm:forbidden}
   });
   const result=await observeReferenceWorkerAttempt(()=>worker.runNext({signal:controller.signal}),{
    observe:()=>observeGroups(input.cgroupRoot,pids),
    cancelOnObservation:name==='cancel-native',stop:()=>{entry.cancelledDuringNativeRun=true;controller.abort();},
    drained:async()=>{await assertNoDescendants(input.cgroupRoot,pids);entry.drainedAtReturn=true;assert.deepEqual(await readdir(scratchRoot),[]);entry.scratchEmptyAtReturn=true;await assertNoScratchHandles(scratchRoot);entry.scratchHandlesClosedAtReturn=true;}
   });
   entry.status=result.status;entry.inspectionRecorded=inspections>0;entry.nativeEvidence=input.decoderEvents.slice(eventStart);entry.nativeExecutions=entry.nativeEvidence.length;entry.observedProcesses=pids.size;
   assert.equal(reads,1);assert.ok(input.decoderEvents.slice(eventStart).every(event=>event.drained));assert.equal(report.providerCalls,0);
   if(['png','jpeg','webp'].includes(name)){assert.equal(result.status,'awaiting_approval');assert.equal(inspections,1);assert.equal(failureReceipts,0);assert.equal(entry.nativeExecutions,3);}
   else{assert.equal(result.status,'failed');assert.equal(inspections,0);assert.equal(failureReceipts,1);if(name==='wrong-kind')assert.equal(entry.nativeExecutions,0);else assert.ok(entry.nativeExecutions>=1);if(name==='cancel-native'){assert.equal(result.code,'REFERENCE_WORKER_ABORTED');assert.equal(entry.cancelledDuringNativeRun,true);assert.ok(pids.size>0);}}
   assert.equal(hash(await readFile(fixturePath)),before);entry.sourceUnchanged=true;entry.passed=true;
  }
  report.passed=true;return report;
 }finally{await rm(scratchRoot,{recursive:true,force:true});}
}
