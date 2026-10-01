'use strict';
/** Test-only preload for scripts/load-office.mjs. Never log a query, parameter,
 * connection string, error text, identifier or caller-controlled label.
 * Durations include driver/network/event-loop time, not server execution alone. */
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {fstatSync,createWriteStream}=require('node:fs');
const WINDOW_MS=5000,MAX_WINDOWS=60,MAX_POOLS=4,MAX_COUNTER=1000000000;
const BUCKET_UPPER_MS=Object.freeze([1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,30000,60000,null]);
const finite=value=>Number.isFinite(value)&&value>=0?Math.min(value,MAX_COUNTER):0;
const rounded=value=>Math.round(finite(value)*100)/100;
const bytes=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const increment=value=>Math.min(MAX_COUNTER,value+1);
const duration=()=>({count:0,errorCount:0,totalMs:0,maxMs:0,buckets:Array(16).fill(0)});
const emptyPool=()=>({samples:0,totalMax:0,idleMax:0,waitingMax:0,waitingTotal:0});
const emptyProcess=()=>({cpuUserMs:0,cpuSystemMs:0,eventLoopUtilization:0,loopDelayMeanMs:0,loopDelayP95Ms:0,loopDelayMaxMs:0,rssBytes:0,heapUsedBytes:0});
function allowedEnvironment(env){
 if(env.COATRIA_LOAD_DIAGNOSTICS!=='1'||!env.DATABASE_URL)return false;
 try{const u=new URL(env.DATABASE_URL);return ['postgres:','postgresql:'].includes(u.protocol)&&['127.0.0.1','localhost'].includes(u.hostname)&&/^\/coatria_load_[a-z0-9_]{4,50}$/.test(u.pathname)&&!u.search&&!u.hash&&(!u.port||(/^\d+$/.test(u.port)&&Number(u.port)>=1024&&Number(u.port)<=65535));}catch{return false;}
}
/** Pure bounded collector. Injection is confined to this test-only script. */
function createCollector({emit,now=()=>performance.now(),wall=()=>Date.now(),system=emptyProcess}){
 const anchor=now(),epoch=wall(),pools=new Set();let last=anchor,sequence=0,stopped=false,droppedWindows=0,acquire=duration(),sql=duration(),pool=emptyPool();
 const coverage={patchInstalled:true,poolAcquireCalls:0,poolQueryCalls:0,clientQueryCalls:0,unmeasuredClientQueryCalls:0,poolsSeen:0,poolsOverflow:false};
 const send=(phase,end,processStats)=>{
  const row={version:1,kind:'coatria-load-server-diagnostics',phase,sequence,startedAtUnixMs:epoch+last-anchor,endedAtUnixMs:epoch+end-anchor,elapsedMs:rounded(end-last),coverage:{...coverage},acquire,sql,pool,process:processStats,droppedWindows};
  try{if(emit(row)===false)droppedWindows=increment(droppedWindows);}catch{droppedWindows=increment(droppedWindows);}
 };
 function sample(){if(stopped)return;let total=0,idle=0,waiting=0;for(const p of pools){total+=finite(p.totalCount);idle+=finite(p.idleCount);waiting+=finite(p.waitingCount);}pool.samples=increment(pool.samples);pool.totalMax=Math.max(pool.totalMax,finite(total));pool.idleMax=Math.max(pool.idleMax,finite(idle));pool.waitingMax=Math.max(pool.waitingMax,finite(waiting));pool.waitingTotal=finite(pool.waitingTotal+waiting);}
 function count(key){if(!stopped)coverage[key]=increment(coverage[key]);}
 return {
  ready(){send('ready',anchor,emptyProcess());},
  track(p){if(stopped)return false;if(pools.has(p))return true;if(pools.size===MAX_POOLS){coverage.poolsOverflow=true;return false;}pools.add(p);coverage.poolsSeen=pools.size;return true;},
  count,sample,
  begin(kind){const start=now();let done=false;return error=>{if(done||stopped)return;done=true;const value=finite(now()-start),target=kind==='acquire'?acquire:sql;target.count=increment(target.count);if(error)target.errorCount=increment(target.errorCount);target.totalMs=rounded(target.totalMs+value);target.maxMs=Math.max(target.maxMs,rounded(value));const index=BUCKET_UPPER_MS.findIndex(bound=>bound===null||value<=bound);target.buckets[index]=increment(target.buckets[index]);};},
  flush(force=false){if(stopped)return false;const end=now();if(!force&&end-last<WINDOW_MS)return true;sequence++;send('window',end,system());last=end;acquire=duration();sql=duration();pool=emptyPool();if(sequence>=MAX_WINDOWS){stopped=true;pools.clear();}return !stopped;},
  stop(){stopped=true;pools.clear();}
 };
}
/** Preserve callback arity/results/this and each original Promise constructor.
 * Release callbacks are passed through untouched. Advanced custom Query or
 * callback-in-config calls are deliberately unmeasured rather than rewritten. */
function instrumentPg({Pool,Client,databaseUrl,collector}){
 const poolPrototype=Pool.prototype,clientPrototype=Client.prototype;
 const connect=poolPrototype.connect,poolQuery=poolPrototype.query,clientQuery=clientPrototype.query,clients=new WeakSet();
 const applies=pool=>pool?.options?.connectionString===databaseUrl&&collector.track(pool);
 function wrappedConnect(...args){
  if(!applies(this))return connect.apply(this,args);collector.count('poolAcquireCalls');collector.sample();const end=collector.begin('acquire'),pool=this;
  const completed=(error,client)=>{if(client)clients.add(client);end(Boolean(error));collector.sample();};
  if(typeof args[0]==='function'){const callback=args[0];args[0]=function(...values){completed(values[0],values[1]);return callback.apply(this,values);};}
  try{const result=connect.apply(pool,args);collector.sample();if(typeof args[0]==='function')return result;return result.then(client=>{completed(null,client);return client;},error=>{completed(error);throw error;});}catch(error){end(true);throw error;}
 }
 function wrappedPoolQuery(...args){if(applies(this))collector.count('poolQueryCalls');return poolQuery.apply(this,args);}
 function wrappedClientQuery(...args){
  if(!clients.has(this))return clientQuery.apply(this,args);collector.count('clientQueryCalls');
  // Do not inspect query text/parameters or alter custom EventEmitter behavior.
  // Config objects normalize/mutate callback properties inside pg itself; leave
  // every such call intact and report the instrumentation gap explicitly.
  if(args[0]!==null&&typeof args[0]==='object'){
   collector.count('unmeasuredClientQueryCalls');return clientQuery.apply(this,args);
  }
  const end=collector.begin('sql'),callbackIndex=typeof args[2]==='function'?2:typeof args[1]==='function'?1:-1;
  if(callbackIndex!==-1){const callback=args[callbackIndex];args[callbackIndex]=function(...values){end(Boolean(values[0]));return callback.apply(this,values);};}
  try{const result=clientQuery.apply(this,args);if(callbackIndex!==-1)return result;if(result&&typeof result.then==='function')return result.then(value=>{end(false);return value;},error=>{end(true);throw error;});collector.count('unmeasuredClientQueryCalls');return result;}catch(error){end(true);throw error;}
 }
 poolPrototype.connect=wrappedConnect;poolPrototype.query=wrappedPoolQuery;clientPrototype.query=wrappedClientQuery;
 return()=>{if(poolPrototype.connect===wrappedConnect)poolPrototype.connect=connect;if(poolPrototype.query===wrappedPoolQuery)poolPrototype.query=poolQuery;if(clientPrototype.query===wrappedClientQuery)clientPrototype.query=clientQuery;};
}
function startDiagnostics(env=process.env){
 if(!allowedEnvironment(env))return null;
 // The harness alone supplies this private pipe. Refuse ordinary files or
 // directories; Windows anonymous pipes do not set isFIFO/isSocket in fstat.
 try{const stat=fstatSync(3);if(process.platform==='win32'?stat.isFile()||stat.isDirectory()||stat.isCharacterDevice()||stat.isBlockDevice():!stat.isFIFO()&&!stat.isSocket())return null;}catch{return null;}
 let output,timer,unpatch,collector,histogram,failed=false,blocked=false;
 function stop(drain=false){if(failed)return;failed=true;if(timer)clearInterval(timer);histogram?.disable();collector?.stop();unpatch?.();if(drain===true)output?.end();else output?.destroy();}
 try{
  output=createWriteStream(null,{fd:3,autoClose:false,highWaterMark:4096});output.on('error',stop);output.on('drain',()=>{blocked=false;});
  histogram=monitorEventLoopDelay({resolution:20});histogram.enable();let cpu=process.cpuUsage(),loop=performance.eventLoopUtilization();
  const system=()=>{const currentCpu=process.cpuUsage(),currentLoop=performance.eventLoopUtilization(),delta=performance.eventLoopUtilization(currentLoop,loop),memory=process.memoryUsage();const value={cpuUserMs:rounded((currentCpu.user-cpu.user)/1000),cpuSystemMs:rounded((currentCpu.system-cpu.system)/1000),eventLoopUtilization:Math.min(1,finite(delta.utilization)),loopDelayMeanMs:rounded(histogram.mean/1e6),loopDelayP95Ms:rounded(histogram.percentile(95)/1e6),loopDelayMaxMs:rounded(histogram.max/1e6),rssBytes:bytes(memory.rss),heapUsedBytes:bytes(memory.heapUsed)};cpu=currentCpu;loop=currentLoop;histogram.reset();return value;};
  collector=createCollector({system,emit:row=>{if(failed||blocked)return false;const line=JSON.stringify(row)+'\n';if(Buffer.byteLength(line)>4096)return false;blocked=!output.write(line);return true;}});
  const pg=require('pg');unpatch=instrumentPg({Pool:pg.Pool,Client:pg.Client,databaseUrl:env.DATABASE_URL,collector});collector.ready();
  timer=setInterval(()=>{collector.sample();if(!collector.flush())stop(true);},250);timer.unref();return{stop:()=>stop(true)};
 }catch{stop();return null;}
}
module.exports={allowedEnvironment,createCollector,instrumentPg,startDiagnostics,WINDOW_MS,MAX_WINDOWS,MAX_POOLS,BUCKET_UPPER_MS};
startDiagnostics();
