import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,stat,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseLoadOptions,summarizeRequests,summarizeRequestWindows,assertUnusedPort,loadPosition,validateLoadDatabaseUrl,assertEmptyLoadDatabase,meetsLoadBudget,loadFloorDocument,loadOfficeMetadata,prepareLoadCheckout,releaseLoadCheckoutDependencies,OFFICE_LOAD_POLICY,readLoadResponse} from '../scripts/load-office.mjs';
import {OFFICE_50_PRESET} from '../src/lib/office-presets';

test('load harness refuses remote targets, existing databases and unbounded traffic',()=>{
 assert.equal(parseLoadOptions([]).clients,50);
 for(const args of [['--url','https://coatria.com'],['--database-url','postgresql://localhost/postgres'],['--clients','51'],['--clients','0'],['--clients','NaN'],['--duration','61'],['--duration','-1'],['--port','80'],['--clients'],['--report','src/app/page.tsx'],['--mode','remote']])assert.throws(()=>parseLoadOptions(args));
 assert.equal(parseLoadOptions(['--clients','50','--duration','30','--port','4196']).port,4196);
 assert.equal(parseLoadOptions(['--mode','production']).mode,'production');
});
test('real PostgreSQL load targets must be explicit empty-database names on loopback',async()=>{
 assert.equal(validateLoadDatabaseUrl('postgresql://127.0.0.1:5432/coatria_load_1234'),'postgresql://127.0.0.1:5432/coatria_load_1234');
 for(const url of ['postgresql://example.com/coatria_load_1234','postgresql://127.0.0.1/coatria_test','postgresql://127.0.0.1/postgres','postgresql://127.0.0.1/coatria_load_','postgresql://127.0.0.1/coatria_load_1234?options=-csearch_path=private','https://localhost/coatria_load_1234'])assert.throws(()=>validateLoadDatabaseUrl(url));
 const statements:string[]=[];
 await assert.rejects(assertEmptyLoadDatabase({query:async(sql:string)=>{statements.push(sql);return {rows:[{count:1}]};}}),/not empty/);
 assert.equal(statements.length,1);assert.match(statements[0],/^SELECT /);assert.doesNotMatch(statements[0],/DELETE|DROP|INSERT|UPDATE/);
 await assertEmptyLoadDatabase({query:async()=>({rows:[{count:0}]})});
});
test('load report percentiles and error rates reflect independent request measurements',()=>{
 const result=summarizeRequests(Array.from({length:100},(_,i)=>({ms:i+1,ok:i!==0,bytes:10})));
 assert.deepEqual(result,{requests:100,unexpectedErrors:1,errorRate:.01,p50Ms:50,p95Ms:95,maxMs:100,bytesReceived:1000});
 assert.equal(summarizeRequests([]).errorRate,0);assert.equal(summarizeRequests([]).p95Ms,0);
 assert.equal(meetsLoadBudget({...result,unexpectedErrors:0,p95Ms:1000}),true);
 assert.equal(meetsLoadBudget({...result,unexpectedErrors:0,p95Ms:1000.01}),false);
 assert.equal(meetsLoadBudget(result),false);assert.equal(meetsLoadBudget(summarizeRequests([])),false);
});
test('load error metrics reject malformed or truncated successful response bodies',async()=>{
 assert.equal((await readLoadResponse(new Response('{"presence":[]}'),200)).ok,true);
 for(const body of ['{broken','','null'])assert.equal((await readLoadResponse(new Response(body),200)).ok,false);
 const stream=new ReadableStream({start(controller){controller.error(new Error('Truncated body'));}});
 assert.equal((await readLoadResponse(new Response(stream),200)).ok,false);
 assert.equal((await readLoadResponse(new Response('{"error":"Not found"}',{status:404}),404)).ok,true);
});

test('five-second diagnostics use unrounded start boundaries even when responses finish in another window',()=>{
 const records=[
  {startedMs:10000,operation:'workspace-read',ms:300,ok:true,bytes:30},
  {startedMs:4999.9999,operation:'presence-write',ms:9000,ok:true,bytes:20},
  {startedMs:0,operation:'presence-write',ms:100,ok:true,bytes:10},
  {startedMs:9999.9999,operation:'presence-read',ms:20,ok:false,bytes:4},
  {startedMs:5000,operation:'presence-read',ms:10,ok:true,bytes:3},
  {startedMs:59999.9999,operation:'conversation-events',ms:5000,ok:true,bytes:50},
  {startedMs:60000,operation:'conversation-events',ms:1000,ok:true,bytes:60},
 ];
 const before=structuredClone(records),overall=summarizeRequests(records),result=summarizeRequestWindows(records);
 assert.deepEqual(result.windows.map(w=>[w.startMs,w.endMs,w.requests]),[[0,5000,2],[5000,10000,2],[10000,15000,1],[55000,60000,1],[60000,65000,1]]);
 assert.equal(result.windows[0].p50Ms,100);assert.equal(result.windows[0].p95Ms,9000);assert.equal(result.windows[1].unexpectedErrors,1);
 assert.equal(result.windows.reduce((n,w)=>n+w.requests,0),records.length);assert.equal(result.windows.reduce((n,w)=>n+w.bytesReceived,0),overall.bytesReceived);assert.equal(result.windows.reduce((n,w)=>n+w.unexpectedErrors,0),overall.unexpectedErrors);
 assert.deepEqual(summarizeRequests(records),overall);assert.deepEqual(records,before);assert.deepEqual(summarizeRequestWindows([...records].reverse()),result);
});

test('window operation summaries partition every request without exposing identities or raw records',()=>{
 const records=Array.from({length:100},(_,i)=>({startedMs:i*650,operation:i%2?'workspace-read':'presence-write',ms:i+1,ok:i!==0,bytes:10,clientId:'private-client',token:'private-session',body:'private-body',url:'https://private.example/path'}));
 const result=summarizeRequestWindows(records),windows=result.windows;
 assert.equal(windows.flatMap(w=>w.operations).reduce((n,op)=>n+op.requests,0),100);
 for(const window of windows){assert.equal(window.operations.reduce((n,op)=>n+op.requests,0),window.requests);assert.equal(window.operations.reduce((n,op)=>n+op.bytesReceived,0),window.bytesReceived);assert.deepEqual(window.operations.map(op=>op.operation),['presence-write','workspace-read']);}
 for(const operation of ['presence-write','workspace-read'])assert.equal(windows.flatMap(w=>w.operations).filter(op=>op.operation===operation).reduce((n,op)=>n+op.requests,0),50);
 assert.doesNotMatch(JSON.stringify(result),/private-|clientId|token|body|https:|startedMs/);
 assert.deepEqual(summarizeRequests(records),{requests:100,unexpectedErrors:1,errorRate:.01,p50Ms:50,p95Ms:95,maxMs:100,bytesReceived:1000});
});

test('window diagnostics use monotonic offsets without wall-clock reads and reject unknown operation labels',t=>{
 t.mock.method(Date,'now',()=>{throw Error('Wall clock must not assign load buckets');});
 assert.deepEqual(summarizeRequestWindows([]),{windowMs:5000,clock:'performance.now',assignment:'request-start',interval:'start-inclusive-end-exclusive',emptyWindowsOmitted:true,windows:[]});
 assert.equal(summarizeRequestWindows([{startedMs:5000,operation:'session-read',ms:3,ok:true,bytes:1}]).windows[0].startMs,5000);
 for(const startedMs of [-1,NaN,Infinity,undefined])assert.throws(()=>summarizeRequestWindows([{startedMs,operation:'presence-read',ms:1,ok:true,bytes:1}]),/monotonic/);
 assert.throws(()=>summarizeRequestWindows([{startedMs:1,operation:'https://private.example/session',ms:1,ok:true,bytes:1}]),/known measured operations/);
});
test('load harness refuses to take over an existing loopback server',async()=>{
 const server=createServer();await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
 try{const address=server.address();assert(address&&typeof address!=='string');await assert.rejects(assertUnusedPort(address.port),/already in use/);}finally{await new Promise<void>(yes=>server.close(()=>yes()));}
});
test('every supported client count produces bounded movement inside the fixture floor',()=>{
 for(const clients of [2,10,11,50])for(let index=0;index<clients;index++)for(const step of [0,1,50,99]){
  const point=loadPosition(index,clients,step);assert(Math.abs(point.x)<15&&Math.abs(point.z)<10);
  assert.deepEqual(point,OFFICE_50_PRESET.workstations[(index+step)%50].approach);
 }
 assert.throws(()=>loadPosition(50,50,0));
});
test('HTTP load fixture and report metadata use the shipped complete 50-person office',()=>{
 const plan=loadFloorDocument(),metadata=loadOfficeMetadata();
 assert.deepEqual(OFFICE_LOAD_POLICY,{movementMs:1000,presencePollMs:2000,workspaceMs:5000,sessionMs:15000,noOverlap:true});
 assert.deepEqual(plan,{version:1,items:OFFICE_50_PRESET.layout,floor:OFFICE_50_PRESET.floor,revision:0});
 assert.deepEqual(metadata,{floor:{width:30,depth:20},layoutItems:148,uniqueAssetCount:new Set(OFFICE_50_PRESET.layout.map(item=>item.assetId)).size});
 plan.items.pop();plan.floor.width=8;assert.equal(loadFloorDocument().items.length,148);assert.equal(loadOfficeMetadata().floor.width,30);
});
test('load source copy excludes private state and isolates generated files without deleting dependency targets',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'coatria-load-copy-'));let copy:Awaited<ReturnType<typeof prepareLoadCheckout>>|undefined;
 try{
  for(const folder of ['src','public','node_modules','.runtime-assets','.git','.vercel'])await mkdir(resolve(root,folder));
  for(const [name,value] of Object.entries({'src/app.ts':'export const marker=true;','public/safe.txt':'public source','node_modules/keep.txt':'dependency target survives','package.json':'{}','package-lock.json':'{}','next.config.ts':'export default {};','tsconfig.json':'{"include":["src"]}','next-env.d.ts':'// original generated file','.env.local':'private environment','.runtime-assets/private.glb':'private fixture'}))await writeFile(resolve(root,name),value);
  copy=await prepareLoadCheckout(root,randomUUID());
  for(const excluded of ['.env.local','.runtime-assets','.git','.vercel'])await assert.rejects(stat(resolve(copy.directory,excluded)),{code:'ENOENT'});
  assert.equal(await readFile(resolve(copy.directory,'node_modules/keep.txt'),'utf8'),'dependency target survives');
  await writeFile(resolve(copy.directory,'tsconfig.json'),'rewritten by isolated Next');await writeFile(resolve(copy.directory,'next-env.d.ts'),'rewritten by isolated Next');
  assert.equal(await readFile(resolve(root,'tsconfig.json'),'utf8'),'{"include":["src"]}');assert.equal(await readFile(resolve(root,'next-env.d.ts'),'utf8'),'// original generated file');
  await releaseLoadCheckoutDependencies(copy);copy=undefined;
  assert.equal(await readFile(resolve(root,'node_modules/keep.txt'),'utf8'),'dependency target survives');
  await assert.rejects(prepareLoadCheckout(root,'../outside'),/owned random load directory/);
 }finally{
  if(copy)await releaseLoadCheckoutDependencies(copy);
  // This is an entirely synthetic test project, never the app's dependency tree.
  const target=await realpath(root);assert.equal(dirname(target),await realpath(tmpdir()));assert(basename(target).startsWith('coatria-load-copy-'));
  await rm(target,{recursive:true,force:true});
 }
});
