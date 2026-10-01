/** Optional load-test observations, not resource limits or a capacity verdict.
 * Fixed pseudo-files only; never collect environment, hostnames or process paths.
 * Call before/after a workload. Counters are cumulative and missing is not zero. */
import * as os from 'node:os';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';

const MAX_TEXT_BYTES=4096,READ_TIMEOUT_MS=150;
const PATHS=Object.freeze({cpuPressure:'/proc/pressure/cpu',memoryPressure:'/proc/pressure/memory',ioPressure:'/proc/pressure/io',cpuStat:'/sys/fs/cgroup/cpu.stat',memoryEvents:'/sys/fs/cgroup/memory.events'});
const CPU_KEYS=['usage_usec','user_usec','system_usec','nr_periods','nr_throttled','throttled_usec','nr_bursts','burst_usec'];
const MEMORY_KEYS=['low','high','max','oom','oom_kill','oom_group_kill'];
const TIME_KEYS=['user','nice','sys','idle','irq'];
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const decimal=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const safeCall=fn=>{try{return fn();}catch{return null;}};
const parseInteger=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)?integer(Number(value)):null;

async function readFixedText(path,{signal}){
 let file;
 try{
  signal.throwIfAborted();
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  signal.throwIfAborted();
  const buffer=Buffer.alloc(MAX_TEXT_BYTES+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);
  signal.throwIfAborted();
  if(bytesRead>MAX_TEXT_BYTES)throw Error('Diagnostic source exceeds its bound.');
  return buffer.subarray(0,bytesRead).toString('utf8');
 }finally{await file?.close();}
}

async function readOptional(path,readText){
 const controller=new AbortController();let timer;
 try{
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},READ_TIMEOUT_MS);});
  // A late filesystem completion still closes its owned handle. Neither the
  // diagnostic result nor a read error can fail or delay the workload further.
  const read=Promise.resolve().then(()=>readText(path,{signal:controller.signal})).catch(()=>null);
  const value=await Promise.race([read,timeout]);
  return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=MAX_TEXT_BYTES&&/^[\x09\x0a\x0d\x20-\x7e]*$/.test(value)?value:null;
 }finally{clearTimeout(timer);}
}

function pressure(text){
 if(text===null)return null;
 const result={some:null,full:null};
 for(const line of text.trim().split(/\r?\n/)){
  const [kind,...tokens]=line.trim().split(/\s+/);
  if(!['some','full'].includes(kind)||result[kind]!==null)return null;
  const values={};
  for(const token of tokens){
   const match=/^(avg10|avg60|avg300|total)=([0-9]+(?:\.[0-9]+)?)$/.exec(token);
   if(!match||Object.hasOwn(values,match[1]))return null;
   const value=match[1]==='total'?parseInteger(match[2]):decimal(Number(match[2]));
   if(value===null||match[1]!=='total'&&value>100)return null;
   values[match[1]]=value;
  }
  if(Object.keys(values).length!==4)return null;
  result[kind]=values;
 }
 return result.some===null?null:result;
}

function counters(text,keys,required){
 if(text===null)return null;
 const result=Object.fromEntries(keys.map(key=>[key,null]));
 for(const line of text.trim().split(/\r?\n/)){
  const match=/^([a-z_]+)\s+([0-9]+)$/.exec(line.trim());
  if(!match)return null;
  if(!keys.includes(match[1]))continue; // Future counters never enter the report.
  const value=parseInteger(match[2]);
  if(value===null||result[match[1]]!==null)return null;
  result[match[1]]=value;
 }
 return required.some(key=>result[key]===null)?null:result;
}

function cpuSnapshot(system){
 const cpus=safeCall(()=>system.cpus());
 if(!Array.isArray(cpus)||!cpus.length||cpus.length>4096)return null;
 const models=[...new Set(cpus.map(cpu=>typeof cpu?.model==='string'&&/^[A-Za-z0-9 .()+@,_-]{1,160}$/.test(cpu.model)?cpu.model.trim():null).filter(Boolean))].sort();
 const sums=Object.fromEntries(TIME_KEYS.map(key=>[key,0]));let valid=true;
 for(const cpu of cpus)for(const key of TIME_KEYS){const value=integer(cpu?.times?.[key]);if(value===null||integer(sums[key]+value)===null)valid=false;else sums[key]+=value;}
 return {count:cpus.length,models:models.length&&models.length<=8?models:null,timesMs:valid?sums:null};
}

/** @typedef {{cpus:()=>unknown,loadavg:()=>unknown,totalmem:()=>unknown,freemem:()=>unknown}} HostSystem */
/** @typedef {{avg10:number,avg60:number,avg300:number,total:number}} PressureTimes */
/** @typedef {{some:PressureTimes,full:PressureTimes|null}|null} PressureSnapshot */
/** @typedef {{schemaVersion:number,observedAtUnixMs:number,sampledAt:string,platform:string,cpu:{count:number,models:string[]|null,timesMs:{user:number,nice:number,sys:number,idle:number,irq:number}|null}|null,loadAverage:{one:number,five:number,fifteen:number}|null,memoryBytes:{total:number|null,free:number|null},linux:{pressure:{cpu:PressureSnapshot,memory:PressureSnapshot,io:PressureSnapshot},cgroup:{scope:string,cpuStat:Record<string,number|null>|null,memoryEvents:Record<string,number|null>|null}}}} HostDiagnostics */
/** Injection is an offline test seam, not a source of caller-selected paths.
 * @param {{platform?:string,system?:HostSystem,readText?:(path:string,options:{signal:AbortSignal})=>Promise<unknown>}} [options]
 * @returns {Promise<HostDiagnostics>}
 */
export async function sampleHostDiagnostics({platform=process.platform,system=os,readText=readFixedText}={}){
 const observedAtUnixMs=Date.now();
 const observedPlatform=['linux','win32','darwin','freebsd','openbsd','aix','sunos','android'].includes(platform)?platform:'other';
 const load=safeCall(()=>system.loadavg()),total=integer(safeCall(()=>system.totalmem())),free=integer(safeCall(()=>system.freemem()));
 const result={schemaVersion:1,observedAtUnixMs,sampledAt:new Date(observedAtUnixMs).toISOString(),platform:observedPlatform,cpu:cpuSnapshot(system),loadAverage:observedPlatform==='win32'||!Array.isArray(load)||load.length!==3||load.some(value=>decimal(value)===null)?null:{one:load[0],five:load[1],fifteen:load[2]},memoryBytes:{total,free:free!==null&&total!==null&&free>total?null:free},linux:{pressure:{cpu:null,memory:null,io:null},cgroup:{scope:'mounted_cgroup_root',cpuStat:null,memoryEvents:null}}};
 if(platform!=='linux')return result;
 const [cpu,memory,io,cpuStat,memoryEvents]=await Promise.all(Object.values(PATHS).map(path=>readOptional(path,readText)));
 result.linux.pressure={cpu:pressure(cpu),memory:pressure(memory),io:pressure(io)};
 result.linux.cgroup.cpuStat=counters(cpuStat,CPU_KEYS,['usage_usec','user_usec','system_usec']);
 result.linux.cgroup.memoryEvents=counters(memoryEvents,MEMORY_KEYS,['low','high','max','oom','oom_kill']);
 return result;
}
