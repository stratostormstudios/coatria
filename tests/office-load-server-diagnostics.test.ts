import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import type {Readable} from 'node:stream';
const require=createRequire(import.meta.url);
const {allowedEnvironment,createCollector,instrumentPg,MAX_WINDOWS,MAX_POOLS,BUCKET_UPPER_MS}=require('../scripts/load-office-server-diagnostics.cjs');
const preload=resolve('scripts/load-office-server-diagnostics.cjs');
const fixtureUrl='postgresql://127.0.0.1:5432/coatria_load_test123';

test('server preload only admits an explicitly selected isolated loopback load database',()=>{
 assert(allowedEnvironment({COATRIA_LOAD_DIAGNOSTICS:'1',DATABASE_URL:fixtureUrl}));
 assert(allowedEnvironment({COATRIA_LOAD_DIAGNOSTICS:'1',DATABASE_URL:'postgres://localhost/coatria_load_abcd'}));
 for(const value of [undefined,'','postgresql://remote.invalid/coatria_load_test123','postgresql://127.0.0.1/postgres','postgresql://localhost/coatria_load_abc','postgresql://localhost/coatria_load_test123?options=secret','postgresql://localhost/coatria_load_test123#fragment','postgresql://localhost:1/coatria_load_test123','postgresql://localhost:1023/coatria_load_test123','postgresql://localhost:65536/coatria_load_test123','https://localhost/coatria_load_test123'])assert.equal(allowedEnvironment({COATRIA_LOAD_DIAGNOSTICS:'1',DATABASE_URL:value}),false);
 for(const value of [undefined,'','true','0'])assert.equal(allowedEnvironment({COATRIA_LOAD_DIAGNOSTICS:value,DATABASE_URL:fixtureUrl}),false);
});

test('collector is fixed-schema, bounded, completion-assigned and honest about absent driver coverage',()=>{
 let now=0;const rows:any[]=[];const collector=createCollector({emit:(row:any)=>{rows.push(structuredClone(row));return rows.length!==2;},now:()=>now,wall:()=>123456});collector.ready();
 assert.equal(rows[0].phase,'ready');assert.equal(rows[0].elapsedMs,0);assert.equal(rows[0].coverage.poolAcquireCalls,0);assert.equal(rows[0].coverage.clientQueryCalls,0);
 for(let i=0;i<MAX_POOLS+1;i++)assert.equal(collector.track({totalCount:2,idleCount:1,waitingCount:3}),i<MAX_POOLS);
 collector.count('poolAcquireCalls');const complete=collector.begin('acquire');now=100;complete(false);complete(true);
 const sql=collector.begin('sql');now=120;sql(true);collector.sample();now=4999;assert(collector.flush());assert.equal(rows.length,1);now=5000;collector.flush();
 assert.deepEqual(rows[1].acquire,{count:1,errorCount:0,totalMs:100,maxMs:100,buckets:BUCKET_UPPER_MS.map((n:number|null)=>n===100?1:0)});
 assert.equal(rows[1].sql.errorCount,1);assert.equal(rows[1].pool.waitingMax,12);assert.equal(rows[1].coverage.poolsSeen,4);assert.equal(rows[1].coverage.poolsOverflow,true);
 now=10000;collector.flush();assert.equal(rows[2].droppedWindows,1);assert.equal(rows[2].acquire.count,0);assert.equal(rows[2].coverage.poolAcquireCalls,1);
 for(let i=2;i<MAX_WINDOWS+8;i++){now+=5000;collector.flush();}assert.equal(rows.length,MAX_WINDOWS+1);assert.equal(rows.at(-1).sequence,MAX_WINDOWS);
 assert(rows.every(row=>Buffer.byteLength(JSON.stringify(row))<4096));
 assert.deepEqual(Object.keys(rows[0]),['version','kind','phase','sequence','startedAtUnixMs','endedAtUnixMs','elapsedMs','coverage','acquire','sql','pool','process','droppedWindows']);
});

test('wrappers preserve callback context, exact errors, release identity, custom promises and untouched query objects',async()=>{
 const expectedError=new Error('synthetic private error must not enter diagnostics'),release=()=>undefined,callbackThis={marker:true},rows:any[]=[];let now=0;
 class SpecialPromise<T> extends Promise<T>{}
 class Client {
  query(...args:any[]):any{const cb=args[2]??args[1]??args[0]?.callback;if(typeof cb==='function'){cb.call(callbackThis,args[0]==='error'?expectedError:null,{ok:true});return undefined;}if(args[0]===null)throw expectedError;if(typeof args[0]==='object')return args[0];return args[0]==='error'?SpecialPromise.reject(expectedError):SpecialPromise.resolve({ok:true});}
 }
 const client=new Client();let acquisitionError=false;
 class Pool {
  options={connectionString:fixtureUrl};totalCount=1;idleCount=0;waitingCount=0;
  connect(cb?:any):any{if(cb){cb.call(callbackThis,acquisitionError?expectedError:null,acquisitionError?undefined:client,release);return undefined;}return acquisitionError?SpecialPromise.reject(expectedError):SpecialPromise.resolve(client);}
  query(...args:any[]){return args;}
 }
 const originalConnect=Pool.prototype.connect,originalQuery=Client.prototype.query;
 const collector=createCollector({emit:(row:any)=>rows.push(structuredClone(row)),now:()=>now++,wall:()=>1});const undo=instrumentPg({Pool,Client,databaseUrl:fixtureUrl,collector}),pool=new Pool();
 try{
  const connected=pool.connect();assert(connected instanceof SpecialPromise);assert.equal(await connected,client);
  assert.equal(pool.connect(function(this:unknown,error:unknown,actual:unknown,done:unknown){assert.equal(this,callbackThis);assert.equal(error,null);assert.equal(actual,client);assert.equal(done,release);}),undefined);
  const result=client.query('safe');assert(result instanceof SpecialPromise);assert.deepEqual(await result,{ok:true});
  assert.equal(client.query('safe',[],function(this:unknown,error:unknown,value:unknown){assert.equal(this,callbackThis);assert.equal(error,null);assert.deepEqual(value,{ok:true});}),undefined);
  assert.equal(client.query('error',function(this:unknown,error:unknown){assert.equal(this,callbackThis);assert.equal(error,expectedError);}),undefined);
  await assert.rejects(client.query('error'),error=>error===expectedError);assert.throws(()=>client.query(null),error=>error===expectedError);
  const custom={submit(){},callback(){}};assert.equal(client.query(custom),undefined);assert.equal(custom.callback.name,'callback');
  acquisitionError=true;await assert.rejects(pool.connect(),error=>error===expectedError);pool.connect(function(this:unknown,error:unknown,actual:unknown,done:unknown){assert.equal(this,callbackThis);assert.equal(error,expectedError);assert.equal(actual,undefined);assert.equal(done,release);});
  collector.flush(true);assert.equal(rows[0].coverage.unmeasuredClientQueryCalls,1);assert.equal(rows[0].acquire.count,4);assert.equal(rows[0].acquire.errorCount,2);assert.equal(rows[0].sql.count,5);assert.equal(rows[0].sql.errorCount,3);assert(!JSON.stringify(rows).includes(expectedError.message));
 }finally{undo();collector.stop();}assert.equal(Pool.prototype.connect,originalConnect);assert.equal(Client.prototype.query,originalQuery);
});

async function child(code:string,env:NodeJS.ProcessEnv,pipe=true){
 const processHandle=spawn(process.execPath,['--require',preload,'-e',code],{env,windowsHide:true,stdio:['ignore','pipe','pipe',pipe?'pipe':'ignore']});let stdout='',stderr='',diagnostics='';
 processHandle.stdout!.on('data',chunk=>{stdout+=chunk;});processHandle.stderr!.on('data',chunk=>{stderr+=chunk;});(processHandle.stdio[3] as Readable|null)?.on('data',chunk=>{diagnostics+=chunk;});
 const timer=setTimeout(()=>processHandle.kill(),20000);
 try{const exit=await new Promise<number|null>((yes,no)=>{processHandle.once('error',no);processHandle.once('exit',yes);});return{exit,stdout,stderr,diagnostics};}finally{clearTimeout(timer);}
}

test('preload fails inertly without opt-in, without the private pipe, or for a remote database',async()=>{
 for(const variant of [{COATRIA_LOAD_DIAGNOSTICS:'0',DATABASE_URL:fixtureUrl,pipe:true},{COATRIA_LOAD_DIAGNOSTICS:'1',DATABASE_URL:'postgresql://remote.invalid/coatria_load_test123',pipe:true},{COATRIA_LOAD_DIAGNOSTICS:'1',DATABASE_URL:fixtureUrl,pipe:false}]){
  const result=await child("const pg=require('pg');process.stdout.write(JSON.stringify({connect:pg.Pool.prototype.connect.name,query:pg.Client.prototype.query.name}))",{...process.env,COATRIA_LOAD_DIAGNOSTICS:variant.COATRIA_LOAD_DIAGNOSTICS,DATABASE_URL:variant.DATABASE_URL},variant.pipe);
  assert.equal(result.exit,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{connect:'connect',query:'query'});assert.equal(result.diagnostics,'');
 }
});

test('actual pg over isolated PGlite socket preserves callback/promise SQL and release while fd3 proves coverage',{timeout:30000},async()=>{
 // This is real pg driver + pool behavior over an emulated server, not native
 // PostgreSQL performance or production-load qualification.
 const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:3});await server.start();
 try{
  const endpoint=new URL('postgresql://'+server.getServerConn()+'/coatria_load_test123');endpoint.username='postgres';endpoint.password='postgres';const url=endpoint.href;
  const code=String.raw`
   const assert=require('node:assert/strict'),pg=require('pg');
   // Only these memory counters are synthetic, to prove values above 1 GB remain exact.
   const memory=process.memoryUsage;process.memoryUsage=()=>({...memory(),rss:2147483648,heapUsed:1610612736});
   (async()=>{const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:2000});
    assert.equal((await pool.query('SELECT 7 AS number')).rows[0].number,7);
    await new Promise((yes,no)=>{assert.equal(pool.query('SELECT 8 AS number',(err,res)=>{try{assert.equal(err,undefined);assert.equal(res.rows[0].number,8);yes();}catch(e){no(e);}}),undefined);});
    await assert.rejects(pool.query('SELECT secret_fixture_invalid_column'),{code:'42703'});
    await new Promise((yes,no)=>pool.query('SELECT secret_fixture_invalid_column',(err)=>{try{assert.equal(err.code,'42703');yes();}catch(e){no(e);}}));
    const first=await pool.connect();const waiting=pool.query('SELECT 9 AS number');await new Promise(r=>setTimeout(r,30));const firstRelease=first.release;firstRelease();assert.throws(()=>firstRelease(),/already been released/);assert.equal((await waiting).rows[0].number,9);
    await new Promise((yes,no)=>{assert.equal(pool.connect((err,client,done)=>{try{assert.equal(err,undefined);assert.equal(done,client.release);client.query('SELECT 10 AS number',[],(error,res)=>{try{assert.equal(error,null);assert.equal(res.rows[0].number,10);done();yes();}catch(e){no(e);}});}catch(e){no(e);}}),undefined);});
    const client=await pool.connect();assert.throws(()=>client.query(null),TypeError);const object={text:'SELECT 11 AS number'};assert.equal((await client.query(object)).rows[0].number,11);client.release();
    await pool.end();await assert.rejects(pool.connect(),/Cannot use a pool after calling end/);await new Promise(yes=>pool.connect(err=>{assert.match(err.message,/Cannot use a pool after calling end/);yes();}));
    await new Promise(r=>setTimeout(r,5600));process.stdout.write(JSON.stringify({passed:true}));
   })().catch(()=>{process.stderr.write('SYNTHETIC_DRIVER_ASSERTION_FAILED');process.exitCode=1;});`;
  const result=await child(code,{...process.env,COATRIA_LOAD_DIAGNOSTICS:'1',DATABASE_URL:url});assert.equal(result.exit,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{passed:true});
  const rows=result.diagnostics.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows[0].phase,'ready');assert(rows.length>=2);const window=rows.find(row=>row.phase==='window');assert(window);
  assert(window.coverage.poolAcquireCalls>=10);assert(window.coverage.poolQueryCalls>=5);assert(window.coverage.clientQueryCalls>=8);assert.equal(window.coverage.unmeasuredClientQueryCalls,1);
  assert(window.acquire.count>=10);assert(window.acquire.errorCount>=2);assert(window.sql.count>=7);assert.equal(window.sql.errorCount,3);assert(window.pool.waitingMax>=1);assert(window.pool.totalMax===1);assert.equal(window.process.rssBytes,2147483648);assert.equal(window.process.heapUsedBytes,1610612736);assert(window.process.cpuUserMs>=0);assert(window.process.loopDelayMaxMs>0);
  assert.doesNotMatch(result.diagnostics,/SELECT|postgres|secret_fixture|42703|password|localhost|127\.0\.0\.1|coatria_load_test123/);
 }finally{await server.stop();await db.close();}
});

test('installed Next automatically externalizes pg so the native require preload can observe it',async()=>{
 const external=await readFile('node_modules/next/dist/lib/server-external-packages.jsonc','utf8');assert.match(external,/^\s*"pg",?\s*$/m);
});
