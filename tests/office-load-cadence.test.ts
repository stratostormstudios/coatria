import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_LOAD_POLICY,runLoadCadence} from '../scripts/load-office.mjs';

test('deadline-clamped early wake does not admit an extra session read',async()=>{
 let time=0,waits=0;const starts:number[]=[],targets:number[]=[];
 await runLoadCadence({period:15000,firstDelay:3000,until:60000,now:()=>time,
  wait:async ms=>{assert(++waits<20);time=time+ms===60000&&time<59999?59999:time+ms;},
  scheduled:(target,tick)=>{targets.push(target);assert.equal(tick,time);},
  operation:async()=>{starts.push(time);time+=20;}});
 assert.deepEqual(starts,[3000,18000,33000,48000]);assert.deepEqual(targets,starts);assert.equal(time,60000);
});

test('early initial and periodic timer wakes re-wait until the existing cadence target',async()=>{
 let time=0,waits=0;const starts:number[]=[];
 await runLoadCadence({period:1000,firstDelay:100,until:3100,now:()=>time,
  wait:async ms=>{assert(++waits<30);time+=ms>1?ms-.5:ms;},
  scheduled:(target,tick)=>assert(tick>=target),operation:async()=>{starts.push(time);time+=.25;}});
 assert.deepEqual(starts,[100,1100,2100]);assert.equal(time,3100);
});

test('fifty staggered clients retain every nominal period through the sixty-second boundary',async()=>{
 const periods=[OFFICE_LOAD_POLICY.movementMs,OFFICE_LOAD_POLICY.presencePollMs,2000,OFFICE_LOAD_POLICY.workspaceMs,OFFICE_LOAD_POLICY.sessionMs];
 const totals:number[]=[];
 for(const period of periods){let requests=0;
  for(let index=0;index<50;index++){let time=0,waits=0,last=-Infinity;
   await runLoadCadence({period,firstDelay:period*index/50,until:60000,now:()=>time,
    wait:async ms=>{assert(++waits<130);time=time+ms===60000&&time<59999?59999:time+ms;},
    scheduled:(target,tick)=>{assert(tick>=target);assert(tick<60000);assert(tick-last>=period);last=tick;},
    operation:async()=>{requests++;time+=10;}});
  }
  totals.push(requests);
 }
 assert.deepEqual(totals,[3000,1500,1500,600,200]);
});

test('operation overruns retain lag and start the next nonoverlapping operation without catch-up bursts',async()=>{
 let time=0;const dispatches:Array<[number,number]>=[],counts:number[]=[];
 await runLoadCadence({period:1000,firstDelay:0,until:3000,now:()=>time,wait:async ms=>{time+=ms;},
  scheduled:(target,tick)=>dispatches.push([target,tick]),
  operation:async count=>{counts.push(count);time=count===1?2500:3000;}});
 assert.deepEqual(dispatches,[[0,0],[1000,2500]]);assert.deepEqual(counts,[1,2]);
});

test('an operation admitted before the deadline is awaited through completion, without overlap or retry',async()=>{
 let time=0,calls=0,settled=false;let release!:()=>void,started!:()=>void;
 const held=new Promise<void>(yes=>{release=yes;}),entered=new Promise<void>(yes=>{started=yes;});
 const run=runLoadCadence({period:100,firstDelay:0,until:1000,now:()=>time,wait:async ms=>{time+=ms;},
  operation:async()=>{calls++;started();await held;}}).then(()=>{settled=true;});
 await entered;time=1001;await Promise.resolve();assert.equal(calls,1);assert.equal(settled,false);
 release();await run;assert.equal(calls,1);assert.equal(settled,true);
});

test('a timer waking at or after the deadline admits nothing and operation failure is not retried',async()=>{
 for(const wake of [1000,1001]){let time=0,calls=0;
  await runLoadCadence({period:100,firstDelay:100,until:1000,now:()=>time,wait:async()=>{time=wake;},operation:async()=>{calls++;}});
  assert.equal(calls,0);
 }
 let calls=0;const failure=new Error('synthetic operation failure');
 await assert.rejects(runLoadCadence({period:100,firstDelay:0,until:1000,now:()=>0,wait:async()=>{},operation:async()=>{calls++;throw failure;}}),error=>error===failure);
 assert.equal(calls,1);
});
