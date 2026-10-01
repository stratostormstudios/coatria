import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleHostDiagnostics} from '../scripts/load-office-host-diagnostics.mjs';

const system={cpus:()=>[{model:'AMD EPYC 7763 64-Core Processor',times:{user:1,nice:2,sys:3,idle:4,irq:5}},{model:'AMD EPYC 7763 64-Core Processor',times:{user:10,nice:20,sys:30,idle:40,irq:50}}],loadavg:()=>[1.5,2,0.25],totalmem:()=>8192,freemem:()=>4096};
const pressure='some avg10=0.00 avg60=0.25 avg300=1.50 total=42\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
const cpu='usage_usec 1000\nuser_usec 700\nsystem_usec 300\nnr_periods 12\nnr_throttled 2\nthrottled_usec 45\n';
const memory='low 0\nhigh 1\nmax 2\noom 0\noom_kill 0\n';
const fixedPaths=['/proc/pressure/cpu','/proc/pressure/memory','/proc/pressure/io','/sys/fs/cgroup/cpu.stat','/sys/fs/cgroup/memory.events'];
const textFor=(path:string)=>path.endsWith('cpu.stat')?cpu:path.endsWith('memory.events')?memory:pressure;

test('host sample reads only five fixed pseudo-files and projects numeric counters with explicit units',async()=>{
 const paths:string[]=[];
 const result=await sampleHostDiagnostics({platform:'linux',system,readText:async(path:string,{signal}:{signal:AbortSignal})=>{paths.push(path);assert.equal(signal.aborted,false);return textFor(path);}});
 assert.deepEqual(paths,fixedPaths);assert.equal(result.schemaVersion,1);assert.equal(Date.parse(result.sampledAt),result.observedAtUnixMs);
 assert.deepEqual(result.cpu,{count:2,models:['AMD EPYC 7763 64-Core Processor'],timesMs:{user:11,nice:22,sys:33,idle:44,irq:55}});
 assert.deepEqual(result.loadAverage,{one:1.5,five:2,fifteen:0.25});assert.deepEqual(result.memoryBytes,{total:8192,free:4096});
 assert.deepEqual(result.linux.pressure.cpu,{some:{avg10:0,avg60:0.25,avg300:1.5,total:42},full:{avg10:0,avg60:0,avg300:0,total:0}});
 assert.deepEqual(result.linux.cgroup.cpuStat,{usage_usec:1000,user_usec:700,system_usec:300,nr_periods:12,nr_throttled:2,throttled_usec:45,nr_bursts:null,burst_usec:null});
 assert.deepEqual(result.linux.cgroup.memoryEvents,{low:0,high:1,max:2,oom:0,oom_kill:0,oom_group_kill:null});
 assert.equal(result.linux.cgroup.scope,'mounted_cgroup_root');
});

test('unsupported or unavailable observations remain null rather than reporting healthy zeros or leaking errors',async()=>{
 let reads=0;
 const absent=()=>{throw Error('private hostname and credential must never be returned');};
 const unavailable=await sampleHostDiagnostics({platform:'linux',system:{cpus:absent,loadavg:absent,totalmem:absent,freemem:absent},readText:async()=>{reads++;throw Error('secret pseudo-file error');}});
 assert.equal(reads,5);assert.equal(unavailable.cpu,null);assert.equal(unavailable.loadAverage,null);assert.deepEqual(unavailable.memoryBytes,{total:null,free:null});
 assert.deepEqual(unavailable.linux.pressure,{cpu:null,memory:null,io:null});assert.equal(unavailable.linux.cgroup.cpuStat,null);assert.equal(unavailable.linux.cgroup.memoryEvents,null);
 assert(!JSON.stringify(unavailable).includes('secret'));assert(!JSON.stringify(unavailable).includes('private'));
 const windows=await sampleHostDiagnostics({platform:'win32',system,readText:async()=>{throw Error('must not read Linux paths');}});
 assert.equal(windows.loadAverage,null);assert.equal(windows.cpu?.count,2);assert.equal(windows.linux.pressure.cpu,null);
});

test('partial older Linux schemas keep missing counters distinct from valid zero values',async()=>{
 const result=await sampleHostDiagnostics({platform:'linux',system,readText:async(path:string)=>path.endsWith('cpu.stat')?'usage_usec 0\nuser_usec 0\nsystem_usec 0\nfuture_counter 123\n':path.endsWith('memory.events')?memory:'some avg300=0 avg60=0 avg10=0 total=0\n'});
 assert.deepEqual(result.linux.pressure.cpu,{some:{avg300:0,avg60:0,avg10:0,total:0},full:null});
 assert.equal(result.linux.cgroup.cpuStat?.usage_usec,0);assert.equal(result.linux.cgroup.cpuStat?.nr_throttled,null);assert(!JSON.stringify(result).includes('future_counter'));
});

test('malformed, conflicting, overflowing or oversized kernel data is unavailable, never silently coerced',async()=>{
 const cases=[
  {path:'/proc/pressure/cpu',text:'some avg10=101 avg60=0 avg300=0 total=1\n'},
  {path:'/proc/pressure/cpu',text:'some avg10=0 avg10=1 avg60=0 avg300=0 total=1\n'},
  {path:'/proc/pressure/cpu',text:'some avg10=0 avg60=0 avg300=0 total=1.5\n'},
  {path:'/proc/pressure/cpu',text:pressure+pressure},
  {path:'/proc/pressure/cpu',text:pressure+'\u0000'},
  {path:'/proc/pressure/cpu',text:' '.repeat(4097)},
  {path:'/sys/fs/cgroup/cpu.stat',text:cpu+'usage_usec 999\n'},
  {path:'/sys/fs/cgroup/cpu.stat',text:cpu.replace('1000','9007199254740992')},
  {path:'/sys/fs/cgroup/memory.events',text:'low 0\nhigh 0\nmax 0\noom 0\n'},
 ];
 for(const fixture of cases){const result=await sampleHostDiagnostics({platform:'linux',system,readText:async(path:string)=>path===fixture.path?fixture.text:textFor(path)});assert.equal(fixture.path.endsWith('cpu.stat')?result.linux.cgroup.cpuStat:fixture.path.endsWith('memory.events')?result.linux.cgroup.memoryEvents:result.linux.pressure.cpu,null,fixture.text.slice(0,70));}
});

test('untrusted OS-shaped values cannot emit arbitrary text, invalid numbers or inconsistent memory',async()=>{
 const result=await sampleHostDiagnostics({platform:'freebsd',system:{cpus:()=>[{model:'bad\n/path/secret',times:{user:NaN,nice:0,sys:0,idle:0,irq:0}}],loadavg:()=>[Infinity,0,0],totalmem:()=>10,freemem:()=>11}});
 assert.deepEqual(result.cpu,{count:1,models:null,timesMs:null});assert.equal(result.loadAverage,null);assert.deepEqual(result.memoryBytes,{total:10,free:null});assert(!JSON.stringify(result).includes('secret'));
});

test('a stalled optional read reaches the finite deadline and receives abort without blocking other fields',async()=>{
 let signal:AbortSignal|undefined;let release:((value:string)=>void)|undefined;
 const began=performance.now();
 const result=await sampleHostDiagnostics({platform:'linux',system,readText:async(path:string,options:{signal:AbortSignal})=>{if(path==='/proc/pressure/cpu'){signal=options.signal;return new Promise<string>(resolve=>{release=resolve;});}return textFor(path);}});
 assert.equal(result.linux.pressure.cpu,null);assert.equal(result.linux.pressure.memory?.some?.total,42);assert.equal(signal?.aborted,true);assert(performance.now()-began<2000);
 release?.(pressure);await new Promise(resolve=>setImmediate(resolve));assert.equal(result.linux.pressure.cpu,null);
});
