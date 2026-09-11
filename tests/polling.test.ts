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

test('seat commands form ordered barriers between coalesced movement and return their own acknowledgement',async()=>{
 const sent:string[]=[];let active=0,maximum=0;const release=new Map<string,()=>void>();
 const writer=latestWriter<string,string>(async value=>{sent.push(value);active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>release.set(value,resolve));active--;return 'ack:'+value;},()=>{},5);
 writer.write('approach');const claim=writer.command('seat');writer.write('outdated move');writer.write('newest move');writer.heartbeat('heartbeat must not replace move');
 assert.deepEqual(sent,['approach']);release.get('approach')!();await wait();assert.deepEqual(sent,['approach','seat']);release.get('seat')!();assert.equal(await claim,'ack:seat');await wait();assert.deepEqual(sent,['approach','seat','newest move']);assert.equal(maximum,1);release.get('newest move')!();writer.close();
});
test('commands remain lossless and heartbeat payload is rebuilt only after the latest acknowledgement',async()=>{
 let position='standing';const sent:string[]=[];
 const writer=latestWriter<()=>string,string>(async build=>{const value=build();sent.push(value);if(value==='seat')position='seated';return value;},()=>{},5);
 const seat=writer.command(()=>'seat'),reaction=writer.command(()=>'reaction');assert.deepEqual(await Promise.all([seat,reaction]),['seat','reaction']);await wait();writer.heartbeat(()=>position);await wait();assert.deepEqual(sent,['seat','reaction','seated']);writer.close();
});
test('a rejected command does not block the newer stand request',async()=>{
 const sent:string[]=[],errors:string[]=[];let fail:()=>void=()=>{};
 const writer=latestWriter<string,string>(async value=>{sent.push(value);if(value==='seat')await new Promise<void>((_,reject)=>{fail=()=>reject(new Error('Seat occupied'));});return value;},(error,kind)=>errors.push(kind+':'+(error as Error).message),5);
 const rejected=assert.rejects(writer.command('seat'),/Seat occupied/);writer.write('stand');fail();await rejected;await wait();assert.deepEqual(sent,['seat','stand']);assert.deepEqual(errors,['command:Seat occupied']);writer.close();
});
test('closing rejects active and queued commands immediately, aborts their signal and sends nothing else',async()=>{
 const sent:string[]=[];let signal:AbortSignal|undefined,release:()=>void=()=>{};
 const writer=latestWriter<string,string>(async(value,s)=>{sent.push(value);signal=s;await new Promise<void>(resolve=>{release=resolve;});return value;},()=>{},5);
 const active=assert.rejects(writer.command('active'),{name:'AbortError'}),pending=assert.rejects(writer.command('pending'),{name:'AbortError'});writer.write('last move');writer.close();await Promise.all([active,pending]);assert.equal(signal?.aborted,true);release();await wait();assert.deepEqual(sent,['active']);await assert.rejects(writer.command('after close'),{name:'AbortError'});
});
test('an unavailable connection cannot accumulate an unbounded command queue',async()=>{
 let release:()=>void=()=>{};const writer=latestWriter<number,number>(async value=>{await new Promise<void>(resolve=>{release=resolve;});return value;},()=>{});
 const pending=Array.from({length:8},(_,index)=>assert.rejects(writer.command(index),{name:'AbortError'}));await assert.rejects(writer.command(9),/Please wait/);writer.close();await Promise.all(pending);release();
});
