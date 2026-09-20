import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,mkdir,cp,lstat,unlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {runRendererHost,rendererHostConfiguration,rendererStateDirectory,RENDER_ORIGIN} from '../scripts/hosting/run-renderer-host.mjs';
import {BUILTIN_EXECUTION_PROFILE} from '../scripts/vfx/worker.mjs';
import {buildRendererBootstrap,RENDERER_SOURCE_PATHS} from '../scripts/hosting/build-renderer-bootstrap.mjs';
import {downloadVerifiedFile,rendererChildEnvironment,superviseRendererChild,BLENDER_RELEASE} from '../scripts/hosting/renderer-bootstrap-runtime.mjs';
import {nodeImage} from '../scripts/hosting/build-runpod-bootstrap.mjs';

const token='ce_'+randomUUID().replaceAll('-',''),companyId=randomUUID(),connectorId=randomUUID();
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'coatria-render-host-')),deadlineMs=Date.now()+60000,jobId=randomUUID(),claimId=randomUUID(),calls:string[]=[],events:unknown[]=[];
 const connector={id:connectorId,companyId,status:'active',expiresAt:new Date(deadlineMs+60000).toISOString(),revision:1,profiles:[BUILTIN_EXECUTION_PROFILE]};
 const transport:typeof fetch=async(url)=>{calls.push(String(url));return String(url).endsWith('/identity')?json({connector}):String(url).endsWith('/claim')?json({job:{id:jobId,companyId,connectorId,profile:BUILTIN_EXECUTION_PROFILE}}):json({});};
 const options={directory,companyId,connectorId,deadlineMs,token,blenderPath:resolve('fixture-blender-not-executed'),fetch:transport,claimReserveMs:0,pollMs:1,log:(value:unknown)=>events.push(value)};
 const claim=async(o:any,id=claimId)=>o.fetch(RENDER_ORIGIN+'/api/execution/jobs/claim',{method:'POST',body:JSON.stringify({claimId:id,workerId:o.workerId})});
 const complete=()=>({status:'completed' as const,jobId,publication:{status:'verified' as const,files:7,verificationSource:'server_bytes' as const,independentlyReviewed:false as const}});
 return{directory,deadlineMs,jobId,claimId,calls,events,connector,options,claim,complete,remove:async()=>{const local=relative(tmpdir(),directory);assert(local&&!local.startsWith('..')&&!isAbsolute(local));await rm(directory,{recursive:true,force:true});}};
}
test('renderer configuration pins company/connector, origin, paths and absolute finite expiry',()=>{
 const settings={COATRIA_RENDER_COMPANY_ID:companyId,COATRIA_RENDER_CONNECTOR_ID:connectorId,COATRIA_RENDER_EXPIRES_AT:new Date(Date.now()+60000).toISOString(),COATRIA_EXECUTION_TOKEN:token};
 assert.equal(rendererHostConfiguration(settings).directory,rendererStateDirectory(companyId,connectorId));
 for(const change of[{COATRIA_RENDER_COMPANY_ID:'../escape'},{COATRIA_RENDER_CONNECTOR_ID:'bad'},{COATRIA_BASE_URL:'https://untrusted.example'},{COATRIA_RENDER_EXPIRES_AT:new Date(Date.now()+90000000).toISOString()},{COATRIA_RENDER_EXPIRES_AT:'tomorrow'},{COATRIA_EXECUTION_TOKEN:'ca_not_connector'}])assert.throws(()=>rendererHostConfiguration({...settings,...change}));
 assert.equal(rendererHostConfiguration({...settings,COATRIA_RENDER_EXPIRES_AT:'2025-01-01T00:00:00Z'}).deadlineMs,Date.parse('2025-01-01T00:00:00Z'));
});
test('single job publishes then stops; restarting completed state makes no API call or new claim',async()=>{
 const f=await fixture();try{
  let cycles=0;const cycle=async(o:any)=>{cycles++;assert.equal(o.publishPrivateMedia,true);await f.claim(o);return f.complete();};
  assert.equal((await runRendererHost({...f.options,cycle})).reason,'completed');assert.equal(cycles,1);
  const before=f.calls.length;assert.equal((await runRendererHost({...f.options,cycle})).reason,'completed');assert.equal(f.calls.length,before);assert.equal(cycles,1);
  const journal=JSON.parse(await readFile(join(f.directory,'renderer-host.json'),'utf8'));assert.equal(journal.jobId,f.jobId);assert.equal(journal.phase,'completed');assert(!JSON.stringify(journal).includes(token));assert(!JSON.stringify(f.events).includes(token));assert(!(await readdir(f.directory)).includes('renderer-host.lock'));
 }finally{await f.remove();}
});
test('publication_pending retries only the same durable job before terminal success',async()=>{
 const f=await fixture();try{let cycles=0;const result=await runRendererHost({...f.options,cycle:async o=>{cycles++;if(cycles===1){await f.claim(o);return{status:'publication_pending',jobId:f.jobId,code:'PUBLISH_RETRY_WAIT',nextRetryAt:new Date(Date.now()+5).toISOString()};}assert.equal(cycles,2);return f.complete();}});assert.equal(result.reason,'completed');assert.equal(cycles,2);assert.equal(f.calls.filter(url=>url.endsWith('/claim')).length,1);}finally{await f.remove();}
});
test('real worker protocol records a failed-start receipt and host never claims another job',async()=>{
 const f=await fixture();try{
  let claims=0,failures=0;const transport:typeof fetch=async(url,init)=>{
   if(String(url).endsWith('/identity'))return json({connector:f.connector});
   if(String(url).endsWith('/claim')){claims++;return json({job:{id:f.jobId,companyId,connectorId,projectId:randomUUID(),workItemId:randomUUID(),profile:BUILTIN_EXECUTION_PROFILE,spec:{width:64,height:64,fpsNumerator:24,fpsDenominator:1,colorSpace:'Linear Rec.709',format:'exr'},inputReferences:[],frameStart:1,frameEnd:1,outputKind:'image_sequence'},leaseToken:'fixture-execution-lease-token-only'});}
   if(String(url).endsWith('/fail')){failures++;const body=JSON.parse(String(init?.body));assert.equal(body.reason,'renderer_failed');assert.equal(body.leaseToken,'fixture-execution-lease-token-only');return json({job:{id:f.jobId,status:'failed'}});}
   assert(String(url).endsWith('/heartbeat'));return json({});
  };
  assert.equal((await runRendererHost({...f.options,fetch:transport})).reason,'failed');assert.equal(claims,1);assert.equal(failures,1);
  assert.equal((await runRendererHost({...f.options,fetch:transport})).reason,'failed');assert.equal(claims,1);assert.equal(failures,1);
 }finally{await f.remove();}
});
test('a crash after claim/worker completion cannot claim a second job on restart',async()=>{
 const f=await fixture();try{
  assert.equal((await runRendererHost({...f.options,cycle:async o=>{await f.claim(o);throw Error('Simulated lost terminal wrapper receipt');}})).reason,'reconciliation_required');
  assert.equal((await runRendererHost({...f.options,cycle:async o=>{await f.claim(o,randomUUID());return f.complete();}})).reason,'reconciliation_required');assert.equal(f.calls.filter(url=>url.endsWith('/claim')).length,1);
  // A pending original worker receipt can still be reconciled for the same job.
  assert.equal((await runRendererHost({...f.options,cycle:async()=>f.complete()})).reason,'completed');
 }finally{await f.remove();}
});
test('journal binding cannot be moved to another company, token, connector or extended deadline',async()=>{
 const f=await fixture();try{
  await runRendererHost({...f.options,cycle:async o=>{await f.claim(o);throw Error('interrupted');}});const before=f.calls.length;
  for(const change of[{companyId:randomUUID()},{connectorId:randomUUID()},{token:'ce_'+randomUUID().replaceAll('-','')},{deadlineMs:f.deadlineMs+1000}])assert.equal((await runRendererHost({...f.options,...change,cycle:async()=>f.complete()})).reason,'reconciliation_required');assert.equal(f.calls.length,before);
 }finally{await f.remove();}
});
test('fresh wrong-company, wrong connector, expiry or profile identity prevents claims',async()=>{
 for(const change of[{companyId:randomUUID()},{id:randomUUID()},{expiresAt:'invalid'},{expiresAt:new Date().toISOString()},{status:'paused'},{profiles:[{...BUILTIN_EXECUTION_PROFILE,inputKinds:['scene']}]}]){
  const f=await fixture();try{Object.assign(f.connector,change);let cycles=0;assert.equal((await runRendererHost({...f.options,cycle:async()=>{cycles++;return f.complete();}})).reason,'reconciliation_required');assert.equal(cycles,0);assert(!f.calls.some(url=>url.endsWith('/claim')));}finally{await f.remove();}
 }
});
test('foreign claimed job is never exposed to renderer; unsafe origins never receive credentials',async()=>{
 const f=await fixture();try{
  let reached=false;const fetcher:typeof fetch=async(url,...rest)=>String(url).endsWith('/claim')?json({job:{id:f.jobId,companyId:randomUUID(),connectorId,profile:BUILTIN_EXECUTION_PROFILE}}):f.options.fetch(url,...rest);
  assert.equal((await runRendererHost({...f.options,fetch:fetcher,cycle:async o=>{await f.claim(o);reached=true;return f.complete();}})).reason,'reconciliation_required');assert.equal(reached,false);
  assert.equal((await runRendererHost({...f.options,cycle:async o=>{await o.fetch!('https://untrusted.example',{headers:{Authorization:token}});return f.complete();}})).reason,'reconciliation_required');assert(!f.calls.some(url=>url.includes('untrusted')));
 }finally{await f.remove();}
});
test('storage transport always enforces no redirects and the host cancellation boundary',async()=>{
 const f=await fixture(),control=new AbortController();try{let observed=false;const transport:typeof fetch=async(url,init)=>{if(String(url).startsWith('https://vercel.com/')){assert.equal(init?.redirect,'error');assert(init?.signal);control.abort();observed=init.signal.aborted;return new Response(null,{status:200});}return f.options.fetch(url,init);};const result=await runRendererHost({...f.options,signal:control.signal,fetch:transport,cycle:async o=>{await f.claim(o);await o.fetch!('https://vercel.com/api/blob?pathname=fixture',{method:'PUT',redirect:'follow'});return f.complete();}});assert.equal(result.reason,'operator_stop');assert.equal(observed,true);}finally{await f.remove();}
});
test('expiry and insufficient remaining render window prevent starting any job',async()=>{
 const f=await fixture();try{let cycles=0;const cycle=async()=>{cycles++;return f.complete();};assert.equal((await runRendererHost({...f.options,deadlineMs:Date.now()-1,cycle})).reason,'deadline');assert.equal(f.calls.length,0);assert.equal((await runRendererHost({...f.options,claimReserveMs:900000,cycle})).reason,'insufficient_time');assert.equal(cycles,0);}finally{await f.remove();}
});
test('absolute deadline aborts an active cycle and releases its clean lock',async()=>{
 const f=await fixture();try{
  let observed=false;const result=await runRendererHost({...f.options,deadlineMs:Date.now()+1500,cycle:async o=>{await f.claim(o);await new Promise<void>(done=>{const stopped=()=>{observed=true;done();};if(o.signal?.aborted)stopped();else o.signal?.addEventListener('abort',stopped,{once:true});});throw Error('aborted');}});assert.equal(result.reason,'deadline');assert.equal(observed,true);assert.equal(result.cleanupComplete,true);assert(!(await readdir(f.directory)).includes('renderer-host.lock'));
 }finally{await f.remove();}
});
test('operator cancellation while publication waits preserves same-job recovery',async()=>{
 const f=await fixture(),control=new AbortController();try{
  const result=await runRendererHost({...f.options,signal:control.signal,cycle:async o=>{await f.claim(o);control.abort();return{status:'publication_pending',jobId:f.jobId,code:'PUBLISH_RETRY_WAIT',nextRetryAt:new Date(Date.now()+60000).toISOString()};}});assert.equal(result.reason,'operator_stop');assert.equal(result.cleanupComplete,true);
  assert.equal((await runRendererHost({...f.options,cycle:async()=>f.complete()})).reason,'completed');assert.equal(f.calls.filter(url=>url.endsWith('/claim')).length,1);
 }finally{await f.remove();}
});
test('uncooperative cleanup retains lock; uncertain restart never erases it',async()=>{
 const f=await fixture(),control=new AbortController();let release!:(value:any)=>void;try{
  const result=await runRendererHost({...f.options,signal:control.signal,cleanupMs:20,cycle:async o=>{await f.claim(o);control.abort();return new Promise(done=>{release=done;});}});assert.equal(result.cleanupComplete,false);assert.equal(result.exitCode,1);assert((await readdir(f.directory)).includes('renderer-host.lock'));await assert.rejects(runRendererHost({...f.options,cycle:async()=>f.complete()}));release(f.complete());
 }finally{await f.remove();}
});
test('stalled or oversized identity bodies are aborted before a claim',async()=>{
 const f=await fixture(),control=new AbortController();try{let cancelled=false;const oversized:typeof fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1048577));},cancel(){cancelled=true;}}));assert.equal((await runRendererHost({...f.options,fetch:oversized,cycle:async()=>f.complete()})).reason,'reconciliation_required');assert.equal(cancelled,true);
  const stalled:typeof fetch=async()=>{queueMicrotask(()=>control.abort());return new Response(new ReadableStream({cancel(){cancelled=true;}}));};assert.equal((await runRendererHost({...f.options,fetch:stalled,signal:control.signal})).reason,'operator_stop');assert.equal(f.calls.length,0);
 }finally{await f.remove();}
});
test('verified archive downloader enforces exact size/hash and preserves existing destinations',async()=>{
 const f=await fixture();try{const bytes=Buffer.from('synthetic archive bytes, not Linux proof'),file=join(f.directory,'archive'),signal=AbortSignal.timeout(10000);let calls=0;const transport:typeof fetch=async(_url,init)=>{calls++;assert.equal(init?.redirect,'error');return new Response(bytes);};
  await downloadVerifiedFile({url:'https://download.blender.org/fixture',path:file,bytes:bytes.length,sha256:digest(bytes),signal,fetch:transport});assert.equal((await readFile(file)).toString(),bytes.toString());
  await assert.rejects(downloadVerifiedFile({url:'https://download.blender.org/fixture',path:file,bytes:bytes.length,sha256:digest(bytes),signal,fetch:transport}),/DESTINATION_EXISTS/);assert.equal((await readFile(file)).toString(),bytes.toString());
  for(const change of[{bytes:bytes.length-1},{bytes:bytes.length+1},{sha256:'0'.repeat(64)}])await assert.rejects(downloadVerifiedFile({url:'https://download.blender.org/fixture',path:file+'bad',bytes:bytes.length,sha256:digest(bytes),signal,fetch:transport,...change}));assert(!(await readdir(f.directory)).some(name=>name.endsWith('.download')));assert.equal(calls,5);
 }finally{await f.remove();}
});
test('stalled archive download is bounded and removes partial installation bytes',async()=>{
 const f=await fixture();try{let cancelled=false;const control=new AbortController(),transport:typeof fetch=async()=>{queueMicrotask(()=>control.abort());return new Response(new ReadableStream({cancel(){cancelled=true;}}));};await assert.rejects(downloadVerifiedFile({url:'https://download.blender.org/fixture',path:join(f.directory,'archive'),bytes:5,sha256:'0'.repeat(64),signal:control.signal,fetch:transport}));assert.equal(cancelled,true);assert.deepEqual(await readdir(f.directory),[]);}finally{await f.remove();}
});
test('renderer child environment never forwards provider, Blob, shell or model configuration',()=>{
 const settings={COATRIA_RENDER_COMPANY_ID:companyId,COATRIA_RENDER_CONNECTOR_ID:connectorId,COATRIA_RENDER_EXPIRES_AT:new Date(Date.now()+60000).toISOString(),COATRIA_EXECUTION_TOKEN:token,RUNPOD_API_KEY:'private',BLOB_READ_WRITE_TOKEN:'private',NODE_OPTIONS:'--require /untrusted',COATRIA_BASE_URL:'https://untrusted.example',COATRIA_BLENDER_PATH:'/untrusted'};
 const env=rendererChildEnvironment(settings);assert.equal(env.COATRIA_BASE_URL,RENDER_ORIGIN);assert.equal(env.COATRIA_EXECUTION_TOKEN,token);for(const key of['RUNPOD_API_KEY','BLOB_READ_WRITE_TOKEN','NODE_OPTIONS','COATRIA_BLENDER_PATH'])assert(!(key in env));
});
test('root parent escalates an uncooperative child and bounds even an unconfirmed SIGKILL',async()=>{
 const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill:(signal:string)=>{signals.push(signal);return true;}}),signals:string[]=[],control=new AbortController();
 const waiting=superviseRendererChild(child as any,control.signal,{termMs:10,killMs:10});control.abort();const result=await waiting;
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(result.forced,true);assert.equal(result.terminationConfirmed,false);assert.equal(result.code,1);assert.equal(child.listenerCount('exit'),0);
});
test('root parent accepts graceful shutdown and does not escalate after confirmed exit',async()=>{
 const signals:string[]=[],child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill:(signal:string)=>{signals.push(signal);queueMicrotask(()=>child.emit('exit',0,null));return true;}}),control=new AbortController();
 const waiting=superviseRendererChild(child as any,control.signal,{termMs:10,killMs:10});control.abort();const result=await waiting;
 assert.deepEqual(signals,['SIGTERM']);assert.equal(result.forced,false);assert.equal(result.terminationConfirmed,true);assert.equal(result.code,0);
});
test('bootstrap pins exact LF source bytes, dependencies and official Blender archive without secrets',async()=>{
 const root=resolve('.'),commit='1'.repeat(40);await assert.rejects(buildRendererBootstrap({commit:'main',root}));const built=await buildRendererBootstrap({commit,root});assert.equal(built.image,nodeImage);assert.equal(built.manifest.length,13);assert.deepEqual(built.manifest.map((item:any)=>item.path),RENDERER_SOURCE_PATHS);
 for(const item of built.manifest){const text=(await readFile(join(root,item.path),'utf8')).replaceAll('\r\n','\n');assert.equal(item.bytes,Buffer.byteLength(text));assert.equal(item.sha256,digest(text));}
 assert.equal(built.blender.sha256,'84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168');assert.equal(built.blender.bytes,383295504);assert.equal(built.blender,BLENDER_RELEASE);assert(!built.args.includes(token));
 const lock=JSON.parse(await readFile(join(root,'scripts/hosting/renderer-runtime/package-lock.json'),'utf8'));assert.equal(lock.packages[''].dependencies.tsx,'4.23.13');assert.equal(lock.packages[''].dependencies.zod,'4.5.4');assert(lock.packages['node_modules/@esbuild/linux-x64'].integrity);assert(Object.keys(lock.packages).every(key=>key===''||/^node_modules\/(tsx|zod|esbuild|fsevents|@esbuild\/[^/]+)$/.test(key)));
});

test('sealed renderer source manifest imports outside the repository with only its locked dependencies',{timeout:60000},async()=>{
 const root=resolve('.'),directory=await mkdtemp(join(tmpdir(),'coatria-renderer-closure-')),outside=relative(root,directory);
 assert(outside&&(outside.startsWith('..')||isAbsolute(outside)),'Closure fixture must be outside the checkout.');
 try{
  const built=await buildRendererBootstrap({commit:'1'.repeat(40),root});
  for(const entry of built.manifest){assert(typeof entry.target==='string');const target=join(directory,entry.target);await mkdir(dirname(target),{recursive:true});const content=(await readFile(join(root,entry.path),'utf8')).replaceAll('\r\n','\n');assert.equal(digest(content),entry.sha256);await writeFile(target,content,{flag:'wx'});}
  // Copy only packages declared by this sealed runtime's lock, not the app's
  // node_modules tree or symlinks back into the repository. No install scripts,
  // network, provider credentials, native Blender or renderer jobs are used.
  const lock=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'));
  for(const[packagePath,entry]of Object.entries(lock.packages)as[string,any][]){
   if(!packagePath)continue;assert(/^node_modules\/(tsx|zod|esbuild|fsevents|@esbuild\/[^/]+)$/.test(packagePath));
   const source=join(root,packagePath);let info;try{info=await lstat(source);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&entry.optional)continue;throw error;}
   assert(info.isDirectory()&&!info.isSymbolicLink(),'Dependency must be a local package directory.');assert.equal(JSON.parse(await readFile(join(source,'package.json'),'utf8')).version,entry.version,'Installed fixture dependency must match the sealed runtime lock.');
   const target=join(directory,packagePath);await mkdir(dirname(target),{recursive:true});await cp(source,target,{recursive:true,dereference:false,errorOnExist:true,force:false});
  }
  for(const dependency of Object.keys(lock.packages[''].dependencies))assert((await lstat(join(directory,'node_modules',dependency))).isDirectory());
  const sources=built.manifest.map(entry=>entry.target).filter((file):file is string=>typeof file==='string'&&/\.(?:mts|mjs|ts)$/.test(file));
  const probe=`globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN_IN_IMPORT_PROBE')};try{for(const path of ${JSON.stringify(sources)})await import('./'+path);console.log('RENDERER_SOURCE_IMPORT_OK');}catch(error){console.error(['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error?.code)&&String(error?.message).includes('studio-generated-protocol')?'RENDERER_SOURCE_GENERATED_PROTOCOL_MISSING':'RENDERER_SOURCE_IMPORT_FAILED');process.exitCode=1;}`;
  const importClosure=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',probe],{cwd:directory,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536,env:{...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),HOME:directory,TEMP:directory,TMP:directory,LANG:'C.UTF-8',NODE_ENV:'test'}});
  const complete=importClosure();assert.equal(complete.error,undefined);assert.equal(complete.status,0,complete.stderr);assert.equal(complete.stdout.trim(),'RENDERER_SOURCE_IMPORT_OK');assert.equal(complete.stderr,'');
  // Negative control proves the probe cannot resolve this dependency from the
  // original checkout or a stale tsx cache after the successful import.
  await unlink(join(directory,'src/lib/studio-generated-protocol.ts'));
  const missing=importClosure();assert.equal(missing.error,undefined);assert.equal(missing.status,1);assert.equal(missing.stdout,'');assert.equal(missing.stderr.trim(),'RENDERER_SOURCE_GENERATED_PROTOCOL_MISSING');
 }finally{const contained=relative(tmpdir(),directory);assert(contained&&!contained.startsWith('..')&&!isAbsolute(contained));await rm(directory,{recursive:true,force:true});}
});
