import test from 'node:test';
import assert from 'node:assert/strict';
import {startPolling,latestWriter} from '../src/lib/polling';
const wait=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));

test('a slow poll stays single-flight and teardown aborts its signal',async()=>{
 let calls=0,active=0,max=0,signal:AbortSignal|undefined,finish:()=>void=()=>{};
 const stop=startPolling(async s=>{calls++;active++;max=Math.max(max,active);signal=s;await new Promise<void>(resolve=>{finish=resolve;});active--;},{intervalMs:5});
 await wait();assert.equal(calls,1);await wait();assert.equal(calls,1);assert.equal(max,1);stop();assert.equal(signal?.aborted,true);finish();await wait();assert.equal(calls,1);
});
test('inactive polling does not run, and errors use a bounded retry loop',async()=>{
 let active=false,calls=0,errors=0;const stop=startPolling(async()=>{calls++;throw new Error('Offline');},{intervalMs:5,active:()=>active,onError:()=>{errors++;}});
 await wait();assert.equal(calls,0);active=true;await wait();assert.equal(calls,1);assert.equal(errors,1);stop();await wait();assert.equal(calls,1);
});
test('movement coalesces pending positions and never writes after closing',async()=>{
 const values:number[]=[];let finish:()=>void=()=>{},signal:AbortSignal|undefined;
 const writer=latestWriter<number>(async(value,s)=>{values.push(value);signal=s;await new Promise<void>(resolve=>{finish=resolve;});},()=>{},5);
 writer.write(1);writer.write(2);writer.write(3);assert.deepEqual(values,[1]);await wait();finish();await wait();assert.deepEqual(values,[1,3]);writer.write(4);writer.close();assert.equal(signal?.aborted,true);finish();await wait();assert.deepEqual(values,[1,3]);
});
test('writer recovers from a failed request using the latest pending position',async()=>{
 let errors=0;const values:number[]=[];const writer=latestWriter<number>(async value=>{values.push(value);if(value===1)throw new Error('Offline');},()=>{errors++;},5);
 writer.write(1);writer.write(2);await wait();assert.deepEqual(values,[1,2]);assert.equal(errors,1);writer.close();
});
