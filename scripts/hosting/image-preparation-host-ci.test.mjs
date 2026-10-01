import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeImagePreparationHostReport} from './image-preparation-host-qualification.mjs';
import {archiveHostHash} from './archive-host-package.mjs';
import {exerciseImagePreparationHostCiLifecycle,assertImagePreparationHostCiReportBytes,assertImagePreparationHostCiDisabledFiles} from './qualify-image-preparation-host-ci.mjs';
import {createImagePreparationHostCiCommand,createImagePreparationHostCiAcceptor,ImagePreparationHostCiCommandError} from './image-preparation-host-ci-command.mjs';

const serviceId='af3078db-f6cf-4d5c-9d5d-afb4dcb8689b';
function fixture(){
 let active=false,invocation=0,receipt,acceptedInvocation=0,starts=0,stops=0;const preserved=new Map(),history=new Map(),events=[];
 const hostBytes=Buffer.from('immutable-host'),source={commit:'a'.repeat(40),tree:'b'.repeat(40),bundleSha256:'c'.repeat(64),hostSha256:archiveHostHash(hostBytes),recipeSha256:'d'.repeat(64),closureSha256:'e'.repeat(64)};
 const evidence=()=>({path:'/state/qualification-'+invocation+'/host-evidence.json',raw:Buffer.from('evidence-'+invocation),proof:Buffer.from('full-native-report-'+invocation),evidence:{qualifierInvocationId:String(invocation).repeat(32)}});
 const reject=()=>{throw Error('IMAGE_PREPARATION_HOST_QUALIFICATION_REJECTED');};
 const io={source,phase:name=>events.push(name),disabled:tryStart=>events.push(tryStart?'disabled-worker-start':'disabled'),start:()=>{starts++;if(!active){active=true;invocation++;}},stop:()=>{stops++;active=false;},current:async()=>evidence(),readAccepted:async()=>{if(!active||acceptedInvocation!==invocation)reject();return {hostBytes,bundle:{commit:source.commit,tree:source.tree},receipt:JSON.parse(receipt),receiptBytes:receipt,qualificationSha256:archiveHostHash(receipt),proof:{invocationId:evidence().evidence.qualifierInvocationId}};},preserveCurrent:(label,value)=>preserved.set(label+'-current',value),accept:async(e,previous)=>{
  if(!active||e.evidence.qualifierInvocationId!==evidence().evidence.qualifierInvocationId)reject();
  if(acceptedInvocation===invocation){if(previous!==undefined&&previous!==archiveHostHash(receipt))reject();return {replayed:true,enrolled:false,workerEnabled:false};}
  if(receipt){if(previous!==archiveHostHash(receipt))reject();history.set(previous,receipt);}else if(previous!==undefined)reject();
  receipt=Buffer.from(JSON.stringify({kind:'coatria-image-preparation-qualification-v1',recipeSha256:source.recipeSha256,closureSha256:source.closureSha256,sourceCommit:source.commit,sourceTree:source.tree,bundleSha256:source.bundleSha256,qualifierInvocationId:e.evidence.qualifierInvocationId,evidenceSha256:archiveHostHash(e.raw),reportSha256:archiveHostHash(e.proof)}));acceptedInvocation=invocation;return {replayed:false,enrolled:false,workerEnabled:false};
 },receipt:async()=>receipt,history:async sha=>history.get(sha),preserve:(label,e)=>preserved.set(label,e.proof),preserveReceipt:(label,bytes)=>preserved.set(label+'-receipt',bytes)};
 return {io,preserved,history,events,counts:()=>({starts,stops,invocation})};
}
test('lifecycle requires two distinct invocations and retained start does not rerun',async()=>{
 const f=fixture(),result=await exerciseImagePreparationHostCiLifecycle(f.io);
 assert.deepEqual(f.counts(),{starts:3,stops:2,invocation:2});assert.equal(f.history.size,1);assert.deepEqual([...f.preserved.keys()],['first','first-receipt','first-current','second','second-receipt','second-current']);
 assert.equal(f.preserved.get('first').toString(),'full-native-report-1');assert.equal(f.preserved.get('second').toString(),'full-native-report-2');
 for(const key of ['stoppedEvidenceRejected','priorInvocationRejected','missingCasRejected','wrongCasRejected','receiptHistoryProved','receiptReplayProved','currentQualificationReadProved','stoppedCurrentQualificationRejected','workerRemainedInactive'])assert.equal(result[key],true);
 for(const label of ['first','second']){const proof=f.preserved.get(label+'-current');assert.equal(proof.qualificationSha256,archiveHostHash(f.preserved.get(label+'-receipt')));assert.equal(proof.sourceTree,f.io.source.tree);assert.equal(proof.receiptUnchanged,true);assert.deepEqual(Object.keys(proof),['version','kind','sourceCommit','sourceTree','bundleSha256','recipeSha256','closureSha256','qualificationSha256','evidenceSha256','reportSha256','qualifierInvocationId','receiptUnchanged','journalProof']);}
 assert.equal(f.events.at(-1),'disabled-worker-start');
});
test('unrelated acceptance errors cannot become proof of stopped-evidence rejection',async()=>{
 const f=fixture(),accept=f.io.accept;f.io.accept=async(...args)=>{if(f.events.at(-1)==='stopped-invocation-rejection')throw Error('DISK_IO_FAILED');return accept(...args);};
 await assert.rejects(exerciseImagePreparationHostCiLifecycle(f.io),{message:'DISK_IO_FAILED'});assert.equal(f.counts().invocation,1);
});
test('receipt bytes must remain unchanged after a negative decision',async()=>{
 const f=fixture(),read=f.io.receipt;f.io.receipt=async()=>f.events.at(-1)==='stopped-invocation-rejection'?Buffer.from('changed'):read();
 await assert.rejects(exerciseImagePreparationHostCiLifecycle(f.io),{message:'IMAGE_PREPARATION_HOST_CI_CHECK_FAILED'});assert.equal(f.counts().invocation,1);
});
test('replayed acceptance cannot mint credentials or enable work',async()=>{
 const f=fixture(),accept=f.io.accept;f.io.accept=async(...args)=>({...await accept(...args),workerEnabled:true});
 await assert.rejects(exerciseImagePreparationHostCiLifecycle(f.io),{message:'IMAGE_PREPARATION_HOST_CI_CHECK_FAILED'});assert.equal(f.counts().invocation,1);
});
test('current qualification reader binds original source, host bytes and exact accepted evidence',async()=>{
 for(const alter of [value=>({...value,bundle:{...value.bundle,tree:'d'.repeat(40)}}),value=>({...value,hostBytes:Buffer.from('changed-host')}),value=>({...value,receiptBytes:Buffer.from('changed-receipt')}),value=>({...value,qualificationSha256:'0'.repeat(64)}),value=>({...value,receipt:{...value.receipt,qualifierInvocationId:'e'.repeat(32)}}),value=>({...value,receipt:{...value.receipt,evidenceSha256:'f'.repeat(64)}}),value=>({...value,receipt:{...value.receipt,reportSha256:'f'.repeat(64)}})]){
  const f=fixture(),read=f.io.readAccepted;f.io.readAccepted=async()=>alter(await read());await assert.rejects(exerciseImagePreparationHostCiLifecycle(f.io),{message:'IMAGE_PREPARATION_HOST_CI_CHECK_FAILED'});assert.equal(f.preserved.has('first-current'),false);
 }
});
test('stopped current reader must reject with the qualification error and preserve receipt bytes',async()=>{
 for(const kind of ['accepted','unrelated','changed-receipt']){
  const f=fixture(),read=f.io.readAccepted,receipt=f.io.receipt;let last;
  f.io.readAccepted=async()=>{if(f.events.at(-1)==='stopped-current-qualification-rejection'){if(kind==='accepted')return last;if(kind==='unrelated')throw Error('DISK_IO_FAILED');}return last=await read();};
  if(kind==='changed-receipt')f.io.receipt=async()=>f.events.at(-1)==='stopped-current-qualification-rejection'?Buffer.from('changed'):receipt();
  await assert.rejects(exerciseImagePreparationHostCiLifecycle(f.io),{message:kind==='unrelated'?'DISK_IO_FAILED':'IMAGE_PREPARATION_HOST_CI_CHECK_FAILED'});
 }
});
test('imagePreparation CI commands use only fixed units, binaries and clean child environment',()=>{
 const calls=[],command=createImagePreparationHostCiCommand(serviceId,(...args)=>{calls.push(args);return {status:0,stdout:'inactive\n'};});
 command('start_qualifier');command('read_unit_state','worker');command('create_service_user');
 assert.deepEqual(calls[0].slice(0,2),['/usr/bin/systemctl',['start',`coatria-image-preparation-${serviceId}-qualify.service`]]);
 assert.equal(calls[0][2].shell,false);assert.deepEqual(Object.keys(calls[0][2].env),['PATH','LANG','LC_ALL']);assert.equal(calls[0][2].timeout,360000);
 assert.equal(calls[2][0],'/usr/sbin/useradd');assert.equal(calls[2][1].at(-1),'coatria-image-preparation');
});
test('commands reject arbitrary operations, unit names, extra arguments and journal identifiers before execution',()=>{
 let calls=0;const command=createImagePreparationHostCiCommand(serviceId,()=>{calls++;return {status:0,stdout:''};});
 for(const args of [['shell'],['read_unit_state','coatria-archive-worker.service'],['start_qualifier','anything'],['read_qualifier_diagnostics','0'.repeat(32)],['read_qualifier_diagnostics','a'.repeat(32)+' --all']])assert.throws(()=>command(...args),ImagePreparationHostCiCommandError);
 assert.equal(calls,0);assert.throws(()=>createImagePreparationHostCiCommand('../wrong'),/IMAGE_PREPARATION_HOST_DELEGATION_REJECTED/);
});
test('command failures retain fixed status and errno without reflecting args, errors or output',()=>{
 const command=createImagePreparationHostCiCommand(serviceId,()=>({status:1,stdout:'secret',stderr:'secret',error:{code:'EACCES',message:'secret'}}));
 assert.throws(()=>command('reload_units'),error=>{assert.deepEqual(error.diagnostic,{operation:'reload_units',status:1,errorCode:'EACCES'});assert.equal(JSON.stringify(error).includes('secret'),false);return true;});
});
test('initial acceptance executes only pinned installed Node and qualifier with no environment credentials',()=>{
 let called;const hash='a'.repeat(64),evidence='/var/lib/coatria-image-preparation-worker/'+serviceId+'/evidence/qualification-'+serviceId+'/host-evidence.json';
 const accept=createImagePreparationHostCiAcceptor(serviceId,hash,(...args)=>{called=args;return {status:0,stdout:JSON.stringify({receipt:{kind:'coatria-image-preparation-qualification-v1'},workerEnabled:false,enrolled:false,replayed:false})};});
 assert.equal(accept(evidence,'b'.repeat(64)).replayed,false);
 assert.equal(called[0],'/var/lib/coatria-image-preparation-releases/'+hash+'/runtime/node');
 assert.deepEqual(called[1],['/var/lib/coatria-image-preparation-releases/'+hash+'/qualifier/runtime.mjs','--accept-qualification','--host','/etc/coatria-image-preparation/'+serviceId+'/host.json','--bundle',hash,'--evidence',evidence,'--sha256','b'.repeat(64)]);
 assert.deepEqual(Object.keys(called[2].env),['PATH','LANG','LC_ALL']);assert.equal(called[2].shell,false);
});
test('compiled acceptance denies cross-service evidence and malformed CLI results',()=>{
 let calls=0;const accept=createImagePreparationHostCiAcceptor(serviceId,'a'.repeat(64),()=>{calls++;return {status:0,stdout:JSON.stringify({workerEnabled:true,enrolled:false,replayed:false})};});
 assert.throws(()=>accept('/tmp/host-evidence.json','b'.repeat(64)),ImagePreparationHostCiCommandError);assert.equal(calls,0);
 assert.throws(()=>accept('/var/lib/coatria-image-preparation-worker/'+serviceId+'/evidence/qualification-'+serviceId+'/host-evidence.json','b'.repeat(64)),ImagePreparationHostCiCommandError);assert.equal(calls,1);
});
test('CI retains the exact isolation and binary reports inside the accepted envelope',()=>{
 // Synthetic bytes only. Actual Linux installation and acceptance run in CI.
 const isolation=Buffer.from('{"synthetic":"isolation"}\n'),transform=Buffer.from('{"synthetic":"binary"}\n'),envelope=Buffer.from(makeImagePreparationHostReport(isolation,transform));
 assert.deepEqual(assertImagePreparationHostCiReportBytes(envelope,isolation,transform),{isolationSha256:archiveHostHash(isolation),transformSha256:archiveHostHash(transform),reportSha256:archiveHostHash(envelope)});
 for(const values of [[Buffer.concat([envelope,Buffer.from(' ')]),isolation,transform],[envelope,transform,isolation],[envelope,isolation,Buffer.from('{"changed":true}')],[envelope.toString(),isolation,transform]])assert.throws(()=>assertImagePreparationHostCiReportBytes(...values));
});
test('current accepted reader rejects recipe, native closure and legacy receipt identity drift',async()=>{
 for(const patch of [{recipeSha256:'0'.repeat(64)},{closureSha256:'0'.repeat(64)},{kind:'coatria-reference-worker-qualification'}]){
  const f=fixture(),read=f.io.readAccepted;f.io.readAccepted=async()=>{const value=await read();return {...value,receipt:{...value.receipt,...patch}};};
  await assert.rejects(exerciseImagePreparationHostCiLifecycle(f.io),{message:'IMAGE_PREPARATION_HOST_CI_CHECK_FAILED'});assert.equal(f.preserved.has('first-current'),false);
 }
});
test('disabled proof rejects the actual service-token.json path without reading its contents',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coatria-preparation-disabled-fixture-'));
 try{await assertImagePreparationHostCiDisabledFiles(root);await writeFile(join(root,'service-token.json'),'synthetic-marker-not-a-token',{flag:'wx'});await assert.rejects(assertImagePreparationHostCiDisabledFiles(root),{message:'IMAGE_PREPARATION_HOST_CI_CHECK_FAILED'});}
 finally{await rm(root,{recursive:true,force:true});}
});
