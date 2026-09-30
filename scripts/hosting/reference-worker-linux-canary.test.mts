import test from 'node:test';
import assert from 'node:assert/strict';
import {observeReferenceWorkerAttempt,referenceWorkerIntegrationEvidence,runReferenceWorkerLinuxCanary} from './reference-worker-linux-canary.mts';
import {setTimeout as delay} from 'node:timers/promises';

test('integration evidence cannot be mistaken for an installed service qualification',async()=>{
 const report=referenceWorkerIntegrationEvidence();assert.equal(report.passed,false);assert.equal(report.productionQualified,false);assert.equal(report.installedServiceQualified,false);assert.equal(report.enrollmentExercised,false);assert.equal(report.providerCalls,0);
 let invoked=false;
 await assert.rejects(runReferenceWorkerLinuxCanary({sandbox:{run:async()=>{invoked=true;return ''; }},profileSha256:'a'.repeat(64),fixtureRoot:'/missing',scratchParent:'/missing',cgroupRoot:'/missing',decoderEvents:[]},report));
 assert.equal(invoked,false);assert.equal(report.passed,false);assert.deepEqual(report.cases,[]);
});

test('observer-triggered cancellation awaits worker settlement before asserting drain',async()=>{
 const order:string[]=[],controller=new AbortController();let observations=0,stops=0;
 const result=await observeReferenceWorkerAttempt(async()=>{order.push('started');await new Promise<void>(resolve=>controller.signal.addEventListener('abort',()=>resolve(),{once:true}));await delay(15);order.push('native-drained');return 'failed';},{
  observe:async()=>++observations>1,stop:()=>{stops++;order.push('abort');controller.abort();},cancelOnObservation:true,drained:async()=>{order.push('assert-drain');assert.equal(order.at(-2),'native-drained');}
 });
 assert.equal(result,'failed');assert.equal(stops,1);assert.deepEqual(order,['started','abort','native-drained','assert-drain']);
});

test('a failing observer cannot detach the worker or its pending cleanup',async()=>{
 const order:string[]=[],controller=new AbortController(),observerFailure=Error('synthetic observer failure');let observations=0;
 await assert.rejects(observeReferenceWorkerAttempt(async()=>{await new Promise<void>(resolve=>controller.signal.addEventListener('abort',()=>resolve(),{once:true}));await delay(15);order.push('settled');return 'failed';},{
  observe:async()=>{if(++observations>1)throw observerFailure;return false;},stop:()=>{order.push('abort');controller.abort();},drained:async()=>{assert.equal(order.at(-1),'settled');order.push('verified');}
 }),error=>error===observerFailure);
 assert.deepEqual(order,['abort','settled','verified']);
});

test('a dirty return fails even after the worker reports successful inspection',async()=>{
 await assert.rejects(observeReferenceWorkerAttempt(async()=>({status:'awaiting_approval'}),{observe:async()=>false,stop:()=>assert.fail('Completed worker must not be cancelled.'),drained:async()=>{throw Error('synthetic retained scratch');}}),/synthetic retained scratch/);
});
