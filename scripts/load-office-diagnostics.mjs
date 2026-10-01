/** Bounded, report-only load observations. Never changes workload or its gate. */
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';

export const LOAD_DIAGNOSTIC_BUCKETS=Object.freeze([1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,30000,60000,null]);
const operations=new Set(['chat-write','chat-retry','task-write','presence-write','presence-read','conversation-events','workspace-read','session-read']);
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const metric=()=>({count:0,totalMs:0,maxMs:0,buckets:Array(16).fill(0)});
function add(m,value){if(!number(value))return;const index=LOAD_DIAGNOSTIC_BUCKETS.findIndex(limit=>limit===null||value<=limit);m.count++;m.totalMs+=value;m.maxMs=Math.max(m.maxMs,value);m.buckets[index]++;}
const round=v=>Math.round(v*1000)/1000;

export function createLoadClientDiagnostics({now=()=>performance.now(),unixNow=()=>Date.now(),processSample=true}={}){
 const windows=new Map(),errors=new Set(),operationInFlight=new Map();let started=null,ended=null,inFlight=0,requests=0,timer,histogram,cpu,utilization,last;
 const window=offset=>{const index=Math.floor(offset/5000);if(index<0||index>60||windows.size>=61&&!windows.has(index)){errors.add('CLIENT_WINDOW_LIMIT');return null;}if(!windows.has(index))windows.set(index,{startMs:index*5000,endMs:(index+1)*5000,requests:0,inFlightMax:0,operations:{},processSamples:[]});return windows.get(index);};
 const sample=()=>{if(!started||!processSample)return;try{const time=now(),w=window(time-started.monotonicMs),delta=process.cpuUsage(cpu),next=process.cpuUsage(),eventLoop=performance.eventLoopUtilization(utilization);utilization=performance.eventLoopUtilization();cpu=next;
  if(w&&w.processSamples.length<8)w.processSamples.push({elapsedMs:round(time-last),cpuUserMs:delta.user/1000,cpuSystemMs:delta.system/1000,eventLoopUtilization:eventLoop.utilization,loopDelayMeanMs:Number.isFinite(histogram.mean)?histogram.mean/1e6:null,loopDelayP95Ms:histogram.count?histogram.percentile(95)/1e6:null,loopDelayMaxMs:histogram.count?histogram.max/1e6:null,rssBytes:process.memoryUsage().rss});histogram.reset();last=time;}catch{errors.add('CLIENT_PROCESS_SAMPLE_FAILED');}};
 const op=(name,offset)=>{if(!operations.has(name)){errors.add('CLIENT_OPERATION_INVALID');return null;}const w=window(offset);if(!w)return null;if(!w.operations[name])w.operations[name]={requests:0,inFlightMax:0,total:metric(),headers:metric(),body:metric(),parse:metric(),schedulingLag:metric()};return {w,m:w.operations[name]};};
 return {
  start(monotonicMs=now()){if(started)return;started={unixMs:unixNow(),monotonicMs};last=monotonicMs;if(processSample){try{cpu=process.cpuUsage();utilization=performance.eventLoopUtilization();histogram=monitorEventLoopDelay({resolution:20});histogram.enable();timer=setInterval(sample,1000);timer.unref();}catch{errors.add('CLIENT_PROCESS_SAMPLE_FAILED');}}},
  begin(name,offset){if(!started||ended)return;inFlight++;const count=(operationInFlight.get(name)??0)+1;operationInFlight.set(name,count);const value=op(name,offset);if(value){value.w.inFlightMax=Math.max(value.w.inFlightMax,inFlight);value.m.inFlightMax=Math.max(value.m.inFlightMax,count);}},
  complete(name,offset,timings){if(!started||ended)return;inFlight=Math.max(0,inFlight-1);operationInFlight.set(name,Math.max(0,(operationInFlight.get(name)??0)-1));if(++requests>20000){errors.add('CLIENT_REQUEST_LIMIT');return;}const value=op(name,offset);if(!value)return;value.w.requests++;value.m.requests++;for(const key of ['total','headers','body','parse'])add(value.m[key],timings[key]);},
  scheduled(name,target,actual=now()){if(!started||ended)return;const value=op(name,actual-started.monotonicMs);if(value)add(value.m.schedulingLag,Math.max(0,actual-target));},
  stop(){if(started&&!ended){clearInterval(timer);sample();histogram?.disable();const time=now();ended={unixMs:started.unixMs+time-started.monotonicMs,monotonicMs:time};}return {status:!started?'not-started':errors.size?'partial':'collected',startedAtUnixMs:started?.unixMs??null,endedAtUnixMs:ended?.unixMs??null,elapsedMs:started&&ended?ended.monotonicMs-started.monotonicMs:null,scope:'measured-load-only',windowMs:5000,bucketUpperBoundsMs:LOAD_DIAGNOSTIC_BUCKETS,requests,inFlightAtEnd:inFlight,errors:[...errors],windows:[...windows.values()].sort((a,b)=>a.startMs-b.startMs)};}
 };
}

// One existing fixture connection, not the five-connection application pool.
// SET LOCAL is confined to this read transaction; no stats reset or SQL text.
export const LOAD_DATABASE_SAMPLE_SQL=`BEGIN; SET LOCAL statement_timeout='500ms';
SELECT CASE WHEN state IN ('active','idle','idle in transaction','idle in transaction (aborted)','fastpath function call','disabled') THEN state ELSE 'other' END AS state,
 CASE WHEN wait_event_type IN ('Activity','BufferPin','Client','Extension','IO','IPC','Lock','LWLock','Timeout') THEN wait_event_type WHEN wait_event_type IS NULL THEN 'none' ELSE 'other' END AS wait_type,
 count(*)::integer AS sessions,count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid))>0)::integer AS blocked_sessions,
 GREATEST(0,max(extract(epoch FROM clock_timestamp()-query_start)*1000))::double precision AS max_query_age_ms,
 GREATEST(0,max(extract(epoch FROM clock_timestamp()-xact_start)*1000))::double precision AS max_transaction_age_ms
FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
GROUP BY 1,2; COMMIT`;
const states=new Set(['active','idle','idle in transaction','idle in transaction (aborted)','fastpath function call','disabled','other']);
const waits=new Set(['Activity','BufferPin','Client','Extension','IO','IPC','Lock','LWLock','Timeout','none','other']);
export function projectLoadDatabaseRows(rows){if(!Array.isArray(rows)||rows.length>80)throw Error('DATABASE_SAMPLE_INVALID');return rows.map(r=>{if(!r||!states.has(r.state)||!waits.has(r.wait_type)||!Number.isSafeInteger(r.sessions)||r.sessions<0||!Number.isSafeInteger(r.blocked_sessions)||r.blocked_sessions<0||r.blocked_sessions>r.sessions||!number(r.max_query_age_ms)||!number(r.max_transaction_age_ms))throw Error('DATABASE_SAMPLE_INVALID');return {state:r.state,waitType:r.wait_type,sessions:r.sessions,blockedSessions:r.blocked_sessions,maxQueryAgeMs:r.max_query_age_ms,maxTransactionAgeMs:r.max_transaction_age_ms};});}
export function createLoadDatabaseDiagnostics({db,database,now=()=>performance.now(),unixNow=()=>Date.now()}){
 const samples=[],errors=new Set();let started,ended,timer,inFlight=null,attempts=0,skippedBusy=0,skippedRate=0,lastAttempt=-Infinity,stopping=false;
 const sample=()=>{if(!started||ended||stopping||database!=='PostgreSQL')return;if(inFlight){skippedBusy++;return;}const time=now();if(time-lastAttempt<1000){skippedRate++;return;}if(attempts>=65){errors.add('DATABASE_SAMPLE_LIMIT');return;}attempts++;lastAttempt=time;const began={unixMs:started.unixMs+time-started.monotonicMs,monotonicMs:time};
  inFlight=(async()=>{try{const results=await db.query(LOAD_DATABASE_SAMPLE_SQL),rows=projectLoadDatabaseRows(results?.[2]?.rows),end=now();samples.push({startedAtUnixMs:began.unixMs,endedAtUnixMs:started.unixMs+end-started.monotonicMs,startedMs:began.monotonicMs-started.monotonicMs,elapsedMs:end-began.monotonicMs,rows});}catch{errors.add('DATABASE_SAMPLE_FAILED');try{await db.query('ROLLBACK');}catch{errors.add('DATABASE_SAMPLE_ROLLBACK_FAILED');}}})().finally(()=>{inFlight=null;});
 };
 return {start(monotonicMs=now()){if(started)return;started={unixMs:unixNow(),monotonicMs};if(database==='PostgreSQL'){timer=setInterval(sample,1000);timer.unref();}},sample,
  async stop(){stopping=true;clearInterval(timer);if(inFlight)await inFlight;const time=now();ended={unixMs:started?started.unixMs+time-started.monotonicMs:unixNow(),monotonicMs:time};return {status:database!=='PostgreSQL'?'unavailable':!started?'not-started':errors.size?'partial':samples.length?'collected':'missing',reason:database!=='PostgreSQL'?'POSTGRESQL_ONLY':null,startedAtUnixMs:started?.unixMs??null,endedAtUnixMs:ended.unixMs,elapsedMs:started?ended.monotonicMs-started.monotonicMs:null,scope:'measured-load-only',intervalMs:1000,queryTimeoutMs:500,attempts,skippedBusy,skippedRate,errors:[...errors],samples};}}
}

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function histogram(value){return exact(value,['count','errorCount','totalMs','maxMs','buckets'])&&['count','errorCount','totalMs','maxMs'].every(k=>number(value[k]))&&Array.isArray(value.buckets)&&value.buckets.length===16&&value.buckets.every(n=>Number.isSafeInteger(n)&&n>=0);}
export function validLoadServerDiagnostic(value){
 if(!exact(value,['version','kind','phase','sequence','startedAtUnixMs','endedAtUnixMs','elapsedMs','coverage','acquire','sql','pool','process','droppedWindows'])||value.version!==1||value.kind!=='coatria-load-server-diagnostics'||!['ready','window'].includes(value.phase)||!['sequence','startedAtUnixMs','endedAtUnixMs','elapsedMs','droppedWindows'].every(k=>number(value[k])))return false;
 if(!Number.isSafeInteger(value.sequence)||value.sequence>60||value.endedAtUnixMs<value.startedAtUnixMs||Math.abs(value.endedAtUnixMs-value.startedAtUnixMs-value.elapsedMs)>1||value.phase==='ready'&&(value.sequence!==0||value.elapsedMs!==0)||value.phase==='window'&&value.sequence===0)return false;
 if(!exact(value.coverage,['patchInstalled','poolAcquireCalls','poolQueryCalls','clientQueryCalls','unmeasuredClientQueryCalls','poolsSeen','poolsOverflow'])||typeof value.coverage.patchInstalled!=='boolean'||typeof value.coverage.poolsOverflow!=='boolean'||Object.entries(value.coverage).some(([k,v])=>!['patchInstalled','poolsOverflow'].includes(k)&&!number(v))||!histogram(value.acquire)||!histogram(value.sql))return false;
 if(!exact(value.pool,['samples','totalMax','idleMax','waitingMax','waitingTotal'])||Object.values(value.pool).some(v=>!number(v)))return false;
 return exact(value.process,['cpuUserMs','cpuSystemMs','eventLoopUtilization','loopDelayMeanMs','loopDelayP95Ms','loopDelayMaxMs','rssBytes','heapUsedBytes'])&&Object.values(value.process).every(v=>v===null||number(v));
}
export function createLoadServerDiagnosticCollector(){
 let pending='',bytes=0,closed=false;const rows=[],errors=new Set();
 const consume=line=>{if(!line.trim())return;let value;try{value=JSON.parse(line);}catch{errors.add('SERVER_INVALID_JSON');return;}if(!validLoadServerDiagnostic(value)){errors.add('SERVER_INVALID_SCHEMA');return;}if(rows.length>=64){errors.add('SERVER_ROW_LIMIT');return;}if(value.sequence!==(rows.length?rows.at(-1).sequence+1:0)){errors.add('SERVER_SEQUENCE_INVALID');return;}rows.push(value);};
 return {push(chunk){if(closed)return;bytes+=Buffer.byteLength(chunk);if(bytes>262144){errors.add('SERVER_BYTE_LIMIT');pending='';return;}pending+=chunk.toString('utf8');if(pending.length>16384&&!pending.includes('\n')){errors.add('SERVER_LINE_LIMIT');pending='';return;}let index;while((index=pending.indexOf('\n'))!==-1){const line=pending.slice(0,index);pending=pending.slice(index+1);if(Buffer.byteLength(line)>16384)errors.add('SERVER_LINE_LIMIT');else consume(line);}},
  fail(){errors.add('SERVER_PIPE_FAILED');},close(){if(!closed){closed=true;if(pending.trim())errors.add('SERVER_TRUNCATED_LINE');pending='';}},
  report(loadStartedAtUnixMs=0,loadEndedAtUnixMs=Infinity){const ready=rows.some(r=>r.phase==='ready'&&r.coverage.patchInstalled),coverage=rows.at(-1)?.coverage,duringLoad=rows.filter(r=>r.phase==='window'&&r.endedAtUnixMs>loadStartedAtUnixMs&&r.startedAtUnixMs<loadEndedAtUnixMs),measured=duringLoad.some(r=>r.acquire.count>0&&r.sql.count>0&&r.pool.samples>0),recent=loadEndedAtUnixMs===Infinity||duringLoad.some(r=>r.endedAtUnixMs>=loadEndedAtUnixMs-7000);return {status:errors.size?'partial':rows.length?'collected':'missing',scope:'server-lifetime-including-startup-and-precheck',bucketUpperBoundsMs:LOAD_DIAGNOSTIC_BUCKETS,bytes,errors:[...errors],rows,requiredCoveragePassed:ready&&measured&&recent&&coverage?.poolAcquireCalls>0&&coverage?.clientQueryCalls>0&&coverage?.unmeasuredClientQueryCalls===0&&!rows.some(r=>r.droppedWindows>0||r.coverage.poolsOverflow)&&!errors.size};}}
}

export function loadDiagnosticCoverage({client,database,server},measuredRequests){
 const reasons=[];
 if(!server.requiredCoveragePassed)reasons.push('SERVER_POOL_SQL_COVERAGE_REQUIRED');
 if(!database.samples.length)reasons.push('DATABASE_WAIT_SAMPLE_REQUIRED');
 if(database.errors.includes('DATABASE_SAMPLE_ROLLBACK_FAILED')||database.errors.includes('DATABASE_COLLECTION_FAILED'))reasons.push('DATABASE_COLLECTION_UNSAFE');
 if(client.requests!==measuredRequests||client.inFlightAtEnd!==0||client.errors.length)reasons.push('CLIENT_COVERAGE_INCOMPLETE');
 return {passed:reasons.length===0,reasons,meaning:'Observed server pool acquisition and SQL completion during load, valid bounded transport, at least one PostgreSQL wait sample, and complete client observations. Independent of the unchanged performance gate.'};
}
