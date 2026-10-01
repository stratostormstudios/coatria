import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Pool} from 'pg';
import {createLoadClientDiagnostics,createLoadDatabaseDiagnostics,createLoadServerDiagnosticCollector,validLoadServerDiagnostic,projectLoadDatabaseRows,LOAD_DATABASE_SAMPLE_SQL,loadDiagnosticCoverage} from '../scripts/load-office-diagnostics.mjs';
import {parseLoadOptions,readLoadResponse,summarizeRequests,meetsLoadBudget,OFFICE_LOAD_POLICY} from '../scripts/load-office.mjs';
const require=createRequire(import.meta.url);
const {createCollector}=require('../scripts/load-office-server-diagnostics.cjs');
type Row=Record<string,any>;
const tick=()=>new Promise<void>(yes=>setImmediate(yes));
const databaseRows=[{state:'active',wait_type:'Lock',sessions:2,blocked_sessions:1,max_query_age_ms:12.5,max_transaction_age_ms:20}];
const queryResults=()=>[{rows:[]},{rows:[]},{rows:databaseRows},{rows:[]}];

function actualServerRows(){
 let time=0;const rows:Row[]=[];
 const producer=createCollector({emit:(row:Row)=>{rows.push(structuredClone(row));return true;},now:()=>time,wall:()=>100000});
 producer.ready();producer.track({totalCount:5,idleCount:2,waitingCount:3});
 for(let i=0;i<3;i++){
  producer.count('poolAcquireCalls');producer.count('poolQueryCalls');producer.count('clientQueryCalls');
  const acquired=producer.begin('acquire');time+=20;acquired(false);
  const queried=producer.begin('sql');time+=30;queried(false);producer.sample();time=(i+1)*5000;producer.flush();
 }
 producer.stop();return rows;
}
function collected(rows:Row[],start=100000,end=115000){const collector=createLoadServerDiagnosticCollector();for(const row of rows){const bytes=Buffer.from(JSON.stringify(row)+'\n');collector.push(bytes.subarray(0,7));collector.push(bytes.subarray(7));}collector.close();return collector.report(start,end);}

test('diagnostics require explicit paired opt-in and preserve traffic and latency gates',()=>{
 assert.equal(parseLoadOptions([]).diagnostics,false);assert.equal(parseLoadOptions(['--diagnostics','false']).diagnostics,false);assert.equal(parseLoadOptions(['--diagnostics','true']).diagnostics,true);
 for(const value of ['1','yes','TRUE',''])assert.throws(()=>parseLoadOptions(['--diagnostics',value]));
 assert.deepEqual(OFFICE_LOAD_POLICY,{movementMs:1000,presencePollMs:2000,workspaceMs:5000,sessionMs:15000,noOverlap:true});
 const records=[{ms:1000,ok:true,bytes:10}],before=structuredClone(records);
 assert.equal(meetsLoadBudget(summarizeRequests(records)),true);records[0].ms=1000.01;assert.equal(meetsLoadBudget(summarizeRequests(records)),false);records[0].ms=before[0].ms;assert.deepEqual(records,before);
});

test('optional response timing preserves exact body/status parsing and failures',async()=>{
 for(const body of ['{"value":1}','broken','null']){
  const timings:Row={};assert.deepEqual(await readLoadResponse(new Response(body),200,timings),await readLoadResponse(new Response(body),200,undefined));
  assert(timings.body>=0);assert(timings.parse>=0);assert.deepEqual(Object.keys(timings).sort(),['body','parse']);
 }
 const timings:Row={},stream=new ReadableStream({start(c){c.error(Error('private failure'));}});
 assert.equal((await readLoadResponse(new Response(stream),200,timings)).ok,false);assert(timings.body>=0);assert.doesNotMatch(JSON.stringify(timings),/private/);
});

test('client metrics retain request-start windows, per-operation concurrency and operation-overrun lag',()=>{
 let time=0,wall=100000;const c=createLoadClientDiagnostics({now:()=>time,unixNow:()=>wall,processSample:false});c.start();
 c.begin('presence-write',4999);c.begin('presence-write',4999);c.begin('workspace-read',4999);
 // The cadence target is previous tick + period, even when the operation took
 // two seconds. Moving the target to completion + wait would hide this lag.
 c.scheduled('presence-write',1000,2000);time=9000;wall=-100000;
 c.complete('presence-write',4999,{total:4001,headers:3000,body:1000,parse:1});c.complete('presence-write',4999,{total:4000});c.complete('workspace-read',4999,{total:4000});
 const result=c.stop(),window=result.windows[0];assert.equal(result.startedAtUnixMs,100000);assert.equal(result.endedAtUnixMs,109000);assert.equal(result.requests,3);assert.equal(result.inFlightAtEnd,0);
 assert.equal(window.requests,3);assert.equal(window.inFlightMax,3);assert.equal(window.operations['presence-write'].inFlightMax,2);assert.equal(window.operations['workspace-read'].inFlightMax,1);assert.equal(window.operations['presence-write'].schedulingLag.maxMs,1000);assert.equal(window.operations['presence-write'].total.maxMs,4001);
 assert.equal(result.windows.length,1);assert.equal(result.status,'collected');
});

test('optional process-observation failure is fixed partial evidence, not a thrown load failure',t=>{
 const c=createLoadClientDiagnostics();c.start();t.mock.method(process,'cpuUsage',()=>{throw Error('private process failure');});
 const result=c.stop();assert.equal(result.status,'partial');assert.deepEqual(result.errors,['CLIENT_PROCESS_SAMPLE_FAILED']);assert.doesNotMatch(JSON.stringify(result),/private process/);
});

test('client observations reject arbitrary labels and bound request/window retention',()=>{
 const c=createLoadClientDiagnostics({processSample:false});c.start(0);c.begin('private-token',1);c.complete('private-token',1,{total:1});c.scheduled('presence-read',0,400000);
 for(let i=0;i<20001;i++){c.begin('session-read',1);c.complete('session-read',1,{total:1});}
 const result=c.stop();assert.equal(result.status,'partial');assert(result.errors.includes('CLIENT_REQUEST_LIMIT'));assert(result.errors.includes('CLIENT_WINDOW_LIMIT'));assert.doesNotMatch(JSON.stringify(result),/private-token/);assert(result.windows.length<=61);
});

test('database sampler is nonoverlapping, at most once per second, monotonic and drains before stop',async()=>{
 let time=0,wall=100000,release:(value:unknown)=>void=()=>{};const queries:string[]=[];
 const db={query:(sql:string)=>{queries.push(sql);return new Promise(yes=>{release=yes;});}};
 const c=createLoadDatabaseDiagnostics({db,database:'PostgreSQL',now:()=>time,unixNow:()=>wall});c.start();c.sample();time=1000;c.sample();
 assert.deepEqual(queries,[LOAD_DATABASE_SAMPLE_SQL]);time=1200;wall=-123;release(queryResults());await tick();c.sample();assert.equal(queries.length,2);
 let settled=false;const stopping=c.stop().then(result=>{settled=true;return result;});await tick();assert.equal(settled,false);c.sample();assert.equal(queries.length,2);
 time=1400;release(queryResults());const report=await stopping;c.sample();assert.equal(queries.length,2);assert.equal(report.skippedBusy,1);assert.equal(report.samples.length,2);assert.equal(report.samples[0].startedAtUnixMs,100000);assert.equal(report.samples[1].endedAtUnixMs,101400);assert.equal(report.status,'collected');
 const fast=createLoadDatabaseDiagnostics({db:{query:async()=>queryResults()},database:'PostgreSQL',now:()=>time,unixNow:()=>0});fast.start();fast.sample();await tick();fast.sample();const limited=await fast.stop();assert.equal(limited.attempts,1);assert.equal(limited.skippedRate,1);
});

test('database projection excludes identifiers and query text; errors retain rollback ownership',async()=>{
 const projected=projectLoadDatabaseRows([{...databaseRows[0],pid:123,query:'secret SQL',application_name:'secret-token'}]);assert.deepEqual(projected,[{state:'active',waitType:'Lock',sessions:2,blockedSessions:1,maxQueryAgeMs:12.5,maxTransactionAgeMs:20}]);assert.doesNotMatch(JSON.stringify(projected),/secret|pid|query/);
 for(const row of [{...databaseRows[0],wait_type:'secret'},{...databaseRows[0],sessions:'2'},{...databaseRows[0],blocked_sessions:3}])assert.throws(()=>projectLoadDatabaseRows([row]));
 let rolledBack=false,release:()=>void=()=>{};const c=createLoadDatabaseDiagnostics({database:'PostgreSQL',db:{query:async(sql:string)=>{if(sql==='ROLLBACK'){await new Promise<void>(yes=>{release=yes;});rolledBack=true;return {};}throw Error('private database failure');}}});c.start();c.sample();await tick();let settled=false;const stop=c.stop().then(r=>{settled=true;return r;});await tick();assert.equal(settled,false);release();const result=await stop;assert(rolledBack);assert.deepEqual(result.errors,['DATABASE_SAMPLE_FAILED']);assert.equal(result.status,'partial');assert.doesNotMatch(JSON.stringify(result),/private database/);
 const bad=createLoadDatabaseDiagnostics({database:'PostgreSQL',db:{query:async()=>{throw Error('private rollback failure');}}});bad.start();bad.sample();const failed=await bad.stop();assert(failed.errors.includes('DATABASE_SAMPLE_ROLLBACK_FAILED'));
 const unavailable=createLoadDatabaseDiagnostics({database:'PGlite',db:{query:async()=>{throw Error('must not query');}}});unavailable.start();unavailable.sample();assert.equal((await unavailable.stop()).status,'unavailable');
});

test('real preload collector rows pass fragmented transport validation with boolean pool coverage',()=>{
 const rows=actualServerRows();assert(rows.every(validLoadServerDiagnostic));const report=collected(rows);assert.equal(report.status,'collected');assert.equal(report.requiredCoveragePassed,true);assert.deepEqual(report.rows,rows);assert.equal(report.rows[0].coverage.poolsOverflow,false);
});

test('server coverage rejects dropped or unmeasured records, overflow, gaps, stale and precheck-only data',()=>{
 for(const mutate of [
  (rows:Row[])=>{rows[2].coverage.poolsOverflow=true;},(rows:Row[])=>{rows[2].droppedWindows=1;},
  (rows:Row[])=>{rows[3].coverage.unmeasuredClientQueryCalls=1;},(rows:Row[])=>{rows[2].sequence=4;},
  (rows:Row[])=>{rows.shift();},(rows:Row[])=>{rows[2].coverage.poolsOverflow=1;},
 ]){const rows=actualServerRows();mutate(rows);assert.equal(collected(rows).requiredCoveragePassed,false);}
 assert.equal(collected(actualServerRows(),115000,120000).requiredCoveragePassed,false);
 assert.equal(collected(actualServerRows().slice(0,2),100000,115000).requiredCoveragePassed,false);
});

test('malformed, oversized, truncated and failed server transports cannot claim complete coverage',()=>{
 for(const corrupt of ['private secret','x'.repeat(16385),'x'.repeat(262145)]){const c=createLoadServerDiagnosticCollector();c.push(Buffer.from(corrupt));c.close();const result=c.report();assert.equal(result.requiredCoveragePassed,false);assert.equal(result.status,'partial');assert.doesNotMatch(JSON.stringify(result),/private secret|xxxxx/);}
 const c=createLoadServerDiagnosticCollector();for(const row of actualServerRows())c.push(Buffer.from(JSON.stringify(row)+'\n'));c.fail();assert.equal(c.report().requiredCoveragePassed,false);
});

test('coverage is independent of latency and rejects rollback failure even after successful sampling',()=>{
 const evidence={client:{requests:1,inFlightAtEnd:0,errors:[] as string[]},database:{samples:[{}],errors:[] as string[]},server:collected(actualServerRows())};
 assert.equal(loadDiagnosticCoverage(evidence,1).passed,true);assert.equal(meetsLoadBudget({requests:1,unexpectedErrors:0,p95Ms:1001}),false);
 evidence.database.errors=['DATABASE_SAMPLE_FAILED'];assert.equal(loadDiagnosticCoverage(evidence,1).passed,true);
 evidence.database.errors.push('DATABASE_SAMPLE_ROLLBACK_FAILED');assert.equal(loadDiagnosticCoverage(evidence,1).passed,false);assert(loadDiagnosticCoverage(evidence,1).reasons.includes('DATABASE_COLLECTION_UNSAFE'));
 evidence.database.errors=[];evidence.client.inFlightAtEnd=1;assert.equal(loadDiagnosticCoverage(evidence,1).passed,false);
});

const integration=process.env.COATRIA_TEST_EMULATOR==='1'?undefined:process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('native PostgreSQL sampler returns the real multi-statement third result and bounded numeric activity projection',{skip:!integration?'Requires isolated native PostgreSQL integration URL':false,timeout:10000},async()=>{
 const url=new URL(integration!);assert(['postgres:','postgresql:'].includes(url.protocol));assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
 // Read-only on the existing disposable CI database: no schema, fixtures,
 // identifiers in output, global settings, or statistics reset.
 const pool=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:2000,query_timeout:2000});
 try{
  const results=await pool.query(LOAD_DATABASE_SAMPLE_SQL) as unknown as {rows:unknown[]}[];assert.equal(results.length,4);assert(Array.isArray(results[2].rows));
  for(const row of projectLoadDatabaseRows(results[2].rows)){assert.deepEqual(Object.keys(row),['state','waitType','sessions','blockedSessions','maxQueryAgeMs','maxTransactionAgeMs']);assert(Number.isSafeInteger(row.sessions));assert(Number.isFinite(row.maxQueryAgeMs));assert(Number.isFinite(row.maxTransactionAgeMs));}
  const c=createLoadDatabaseDiagnostics({db:pool,database:'PostgreSQL'});c.start();c.sample();const report=await c.stop();assert.equal(report.status,'collected');assert.equal(report.samples.length,1);assert.deepEqual(report.errors,[]);
 }finally{await pool.end();}
});
