import assert from 'node:assert/strict';
import test from 'node:test';
import {archiveHostHash} from './archive-host-package.mjs';
import {exerciseReferenceHostCiLifecycle} from './qualify-reference-host-ci.mjs';
import {createReferenceHostCiCommand,createReferenceHostCiAcceptor,ReferenceHostCiCommandError} from './reference-host-ci-command.mjs';

const serviceId='af3078db-f6cf-4d5c-9d5d-afb4dcb8689b';
function fixture(){
 let active=false,invocation=0,receipt,acceptedInvocation=0,starts=0,stops=0;const preserved=new Map(),history=new Map(),events=[];
 const evidence=()=>({path:'/state/qualification-'+invocation+'/host-evidence.json',raw:Buffer.from('evidence-'+invocation),proof:Buffer.from('full-native-report-'+invocation),evidence:{qualifierInvocationId:String(invocation).repeat(32)}});
 const reject=()=>{throw Error('REFERENCE_HOST_QUALIFICATION_REJECTED');};
 const io={phase:name=>events.push(name),disabled:tryStart=>events.push(tryStart?'disabled-worker-start':'disabled'),start:()=>{starts++;if(!active){active=true;invocation++;}},stop:()=>{stops++;active=false;},current:async()=>evidence(),accept:async(e,previous)=>{
  if(!active||e.evidence.qualifierInvocationId!==evidence().evidence.qualifierInvocationId)reject();
  if(acceptedInvocation===invocation){if(previous!==undefined&&previous!==archiveHostHash(receipt))reject();return {replayed:true,enrolled:false,workerEnabled:false};}
  if(receipt){if(previous!==archiveHostHash(receipt))reject();history.set(previous,receipt);}else if(previous!==undefined)reject();
  receipt=Buffer.from('accepted-receipt-'+invocation);acceptedInvocation=invocation;return {replayed:false,enrolled:false,workerEnabled:false};
 },receipt:async()=>receipt,history:async sha=>history.get(sha),preserve:(label,e)=>preserved.set(label,e.proof),preserveReceipt:(label,bytes)=>preserved.set(label+'-receipt',bytes)};
 return {io,preserved,history,events,counts:()=>({starts,stops,invocation})};
}
test('two actual invocations preserve both detailed reports and receipts; retained start does not rerun',async()=>{
 const f=fixture(),result=await exerciseReferenceHostCiLifecycle(f.io);
 assert.deepEqual(f.counts(),{starts:3,stops:2,invocation:2});assert.equal(f.history.size,1);assert.deepEqual([...f.preserved.keys()],['first','first-receipt','second','second-receipt']);
 assert.equal(f.preserved.get('first').toString(),'full-native-report-1');assert.equal(f.preserved.get('second').toString(),'full-native-report-2');
 for(const key of ['stoppedEvidenceRejected','priorInvocationRejected','missingCasRejected','wrongCasRejected','receiptHistoryProved','receiptReplayProved','workerRemainedInactive'])assert.equal(result[key],true);
 assert.equal(f.events.at(-1),'disabled-worker-start');
});
test('unrelated acceptance errors cannot become proof of stopped-evidence rejection',async()=>{
 const f=fixture(),accept=f.io.accept;f.io.accept=async(...args)=>{if(f.events.at(-1)==='stopped-invocation-rejection')throw Error('DISK_IO_FAILED');return accept(...args);};
 await assert.rejects(exerciseReferenceHostCiLifecycle(f.io),{message:'DISK_IO_FAILED'});assert.equal(f.counts().invocation,1);
});
test('receipt bytes must remain unchanged after a negative decision',async()=>{
 const f=fixture(),read=f.io.receipt;f.io.receipt=async()=>f.events.at(-1)==='stopped-invocation-rejection'?Buffer.from('changed'):read();
 await assert.rejects(exerciseReferenceHostCiLifecycle(f.io),{message:'REFERENCE_HOST_CI_CHECK_FAILED'});assert.equal(f.counts().invocation,1);
});
test('replayed acceptance cannot mint credentials or enable work',async()=>{
 const f=fixture(),accept=f.io.accept;f.io.accept=async(...args)=>({...await accept(...args),workerEnabled:true});
 await assert.rejects(exerciseReferenceHostCiLifecycle(f.io),{message:'REFERENCE_HOST_CI_CHECK_FAILED'});assert.equal(f.counts().invocation,1);
});
test('reference CI commands use only fixed units, binaries and clean child environment',()=>{
 const calls=[],command=createReferenceHostCiCommand(serviceId,(...args)=>{calls.push(args);return {status:0,stdout:'inactive\n'};});
 command('start_qualifier');command('read_unit_state','worker');command('create_service_user');
 assert.deepEqual(calls[0].slice(0,2),['/usr/bin/systemctl',['start',`coatria-reference-${serviceId}-qualify.service`]]);
 assert.equal(calls[0][2].shell,false);assert.deepEqual(Object.keys(calls[0][2].env),['PATH','LANG','LC_ALL']);assert.equal(calls[0][2].timeout,360000);
 assert.equal(calls[2][0],'/usr/sbin/useradd');assert.equal(calls[2][1].at(-1),'coatria-reference');
});
test('commands reject arbitrary operations, unit names, extra arguments and journal identifiers before execution',()=>{
 let calls=0;const command=createReferenceHostCiCommand(serviceId,()=>{calls++;return {status:0,stdout:''};});
 for(const args of [['shell'],['read_unit_state','coatria-archive-worker.service'],['start_qualifier','anything'],['read_qualifier_diagnostics','0'.repeat(32)],['read_qualifier_diagnostics','a'.repeat(32)+' --all']])assert.throws(()=>command(...args),ReferenceHostCiCommandError);
 assert.equal(calls,0);assert.throws(()=>createReferenceHostCiCommand('../wrong'),/REFERENCE_HOST_DELEGATION_REJECTED/);
});
test('command failures retain fixed status and errno without reflecting args, errors or output',()=>{
 const command=createReferenceHostCiCommand(serviceId,()=>({status:1,stdout:'secret',stderr:'secret',error:{code:'EACCES',message:'secret'}}));
 assert.throws(()=>command('reload_units'),error=>{assert.deepEqual(error.diagnostic,{operation:'reload_units',status:1,errorCode:'EACCES'});assert.equal(JSON.stringify(error).includes('secret'),false);return true;});
});
test('initial acceptance executes only pinned installed Node and qualifier with no environment credentials',()=>{
 let called;const hash='a'.repeat(64),evidence='/var/lib/coatria-reference-worker/'+serviceId+'/evidence/qualification-'+serviceId+'/host-evidence.json';
 const accept=createReferenceHostCiAcceptor(serviceId,hash,(...args)=>{called=args;return {status:0,stdout:JSON.stringify({receipt:{kind:'coatria-reference-worker-qualification'},workerEnabled:false,enrolled:false,replayed:false})};});
 assert.equal(accept(evidence,'b'.repeat(64)).replayed,false);
 assert.equal(called[0],'/var/lib/coatria-reference-releases/'+hash+'/runtime/node');
 assert.deepEqual(called[1],['/var/lib/coatria-reference-releases/'+hash+'/qualifier/runtime.mjs','--accept-qualification','--host','/etc/coatria-reference/'+serviceId+'/host.json','--bundle',hash,'--evidence',evidence,'--sha256','b'.repeat(64)]);
 assert.deepEqual(Object.keys(called[2].env),['PATH','LANG','LC_ALL']);assert.equal(called[2].shell,false);
});
test('compiled acceptance denies cross-service evidence and malformed CLI results',()=>{
 let calls=0;const accept=createReferenceHostCiAcceptor(serviceId,'a'.repeat(64),()=>{calls++;return {status:0,stdout:JSON.stringify({workerEnabled:true,enrolled:false,replayed:false})};});
 assert.throws(()=>accept('/tmp/host-evidence.json','b'.repeat(64)),ReferenceHostCiCommandError);assert.equal(calls,0);
 assert.throws(()=>accept('/var/lib/coatria-reference-worker/'+serviceId+'/evidence/qualification-'+serviceId+'/host-evidence.json','b'.repeat(64)),ReferenceHostCiCommandError);assert.equal(calls,1);
});
