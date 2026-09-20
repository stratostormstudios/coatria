import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {prepareStorageConformance,runStorageConformance,verifyStorageConformance,storageConformancePlanSha256,STORAGE_CONFORMANCE_BYTES,type ConformanceEvent} from '../src/lib/project-storage-conformance';
import {RunpodStorageError,type RunpodProjectStorage,type RunpodProjectStorageConfig} from '../src/lib/project-storage-runpod';
import {appendConformanceJournal,main as conformanceCli} from '../scripts/verify-project-storage-provider';

const credentials={accessKeyId:['user','synthetic'].join('_'),secretAccessKey:['rps','synthetic-conformance-secret'].join('_')};
function fixture(){
 const plan=prepareStorageConformance('synthetic-volume','US-NC-2'),events:ConformanceEvent[]=[],calls:string[]=[],objects=new Map<string,Buffer>(),parts=new Map<string,Map<number,Buffer>>();let clients=0,failStep='',corrupt=false;
 const factory=(config:RunpodProjectStorageConfig):RunpodProjectStorage=>{clients++;return {
  async head(id){calls.push('head');const bytes=objects.get(id);return bytes?{versionId:id,bytes:bytes.length,etag:'"stored"',contentType:'application/octet-stream',modifiedAt:null}:null;},
  async createMultipart(input){calls.push('create');if(failStep==='create')throw new RunpodStorageError('STORAGE_PROVIDER_UNCERTAIN');parts.set(input.versionId,new Map());return {scope:'synthetic',versionId:input.versionId,uploadId:'private-'+input.versionId,bytes:input.bytes,partBytes:config.partBytes!};},
  validateMultipart(input){return input as any;},
  async uploadPart(input){calls.push('part');if(failStep==='part')throw new RunpodStorageError('STORAGE_PROVIDER_UNCERTAIN');const bytes=Buffer.from(input.body as Uint8Array);parts.get(input.upload.versionId)!.set(input.partNumber,bytes);return {partNumber:input.partNumber,bytes:bytes.length,etag:'"part-'+input.partNumber+'"'};},
  async completeMultipart(input){calls.push('complete');if(failStep==='complete')throw new RunpodStorageError('STORAGE_PROVIDER_UNCERTAIN');objects.set(input.upload.versionId,Buffer.concat([...parts.get(input.upload.versionId)!.values()]));return {versionId:input.upload.versionId,etag:'"stored"'};},
  async abortMultipart(input){calls.push('abort');parts.delete(input.upload.versionId);},
  async get(input){calls.push(input.range?'range':'get');if(input.ifMatch!=='"stored"')throw new RunpodStorageError('STORAGE_OBJECT_CHANGED');let data=objects.get(input.versionId)!;const totalBytes=data.length;if(input.range)data=data.subarray(input.range.start,input.range.end+1);if(corrupt)data=Buffer.alloc(data.length,3);return {stream:new ReadableStream({start(c){c.enqueue(data);c.close();}}),bytes:data.length,totalBytes,etag:'"stored"',contentType:'application/octet-stream',range:input.range??null,contentRange:input.range?`bytes ${input.range.start}-${input.range.end}/${totalBytes}`:null};},
  async list(){throw Error('Qualification must not browse unrelated objects.');},close(){calls.push('close');},
 };};
 return {plan,events,calls,objects,parts,factory,record:async(event:ConformanceEvent)=>{events.push(event);},clients:()=>clients,failAt(value:string){failStep=value;},corrupt(){corrupt=true;}};
}
test('offline plan never targets retained inference storage or accepts extra controls',()=>{
 assert.throws(()=>prepareStorageConformance('k4mj9x0yas','US-NC-2'));assert.throws(()=>prepareStorageConformance('synthetic-volume','attacker.example'));
 const a=prepareStorageConformance('synthetic-volume','US-NC-2'),b=prepareStorageConformance('synthetic-volume','US-NC-2');assert.notEqual(a.projectId,b.projectId);assert.notEqual(storageConformancePlanSha256(a),storageConformancePlanSha256(b));assert.equal(a.bytes,STORAGE_CONFORMANCE_BYTES);
});
test('qualification records exact write intents, streams two parts and verifies an independent client',async()=>{
 const f=fixture(),result=await runStorageConformance(f.plan,{credentials,factory:f.factory,record:f.record});assert.equal(result.providerTransportPassed,true);assert.equal(result.verified.sha256,createHash('sha256').update(f.objects.get(f.plan.versionId)!).digest('hex'));assert.equal(f.clients(),3);assert.equal(f.objects.size,1);assert.equal(f.parts.has(f.plan.abortVersionId),false);assert.equal(f.calls.filter(x=>x==='part').length,3);assert.equal(f.calls.filter(x=>x==='complete').length,1);
 assert.deepEqual(f.events.filter(e=>e.phase==='intent').map(e=>e.step),['create-multipart','upload-part-1','upload-part-2','complete-multipart','create-abort-test','upload-abort-test','abort-confirmed-multipart']);assert(result.notEstablished.includes('tenant-isolation'));assert(result.notEstablished.includes('grant-revocation'));assert(result.notEstablished.includes('aborted-part-reclamation'));assert(result.notEstablished.includes('power-loss-journal-durability'));assert(result.coverage.includes('multipart-abort-acknowledgement'));assert(!JSON.stringify(result).includes(credentials.secretAccessKey));
 const mutationCount=f.calls.filter(x=>['create','part','complete','abort'].includes(x)).length;await verifyStorageConformance(f.plan,{credentials,factory:f.factory,record:f.record});assert.equal(f.calls.filter(x=>['create','part','complete','abort'].includes(x)).length,mutationCount);
});
test('uncertain create, part or complete never retries or automatically aborts another operation',async()=>{
 for(const step of ['create','part','complete']){const f=fixture();f.failAt(step);await assert.rejects(runStorageConformance(f.plan,{credentials,factory:f.factory,record:f.record}),e=>e instanceof RunpodStorageError&&e.code==='STORAGE_PROVIDER_UNCERTAIN');assert.equal(f.calls.filter(x=>x===step).length,1);assert(!f.calls.includes('abort'));assert.equal(f.events.at(-1)?.detail?.automaticRetry,false);}
});
test('failed durable intent blocks the provider mutation and pre-existing object blocks all writes',async()=>{
 const f=fixture();await assert.rejects(runStorageConformance(f.plan,{credentials,factory:f.factory,record:async(e)=>{if(e.phase==='intent')throw Error('disk unavailable');await f.record(e);}}));assert(!f.calls.includes('create'));
 const existing=fixture();existing.objects.set(existing.plan.versionId,Buffer.from('retained'));await assert.rejects(runStorageConformance(existing.plan,{credentials,factory:existing.factory,record:existing.record}));assert(!existing.calls.includes('create'));
});
test('corrupt stored bytes fail rather than asserting provider readiness',async()=>{const f=fixture();f.corrupt();await assert.rejects(runStorageConformance(f.plan,{credentials,factory:f.factory,record:f.record}));assert(!f.events.some(e=>e.step==='completed'));assert(!f.calls.includes('abort'));});
test('complete journal records are synced only after all short writes; zero/failing writes block provider I/O',async()=>{
 const chunks:Buffer[]=[];let synced=false;const event={step:'create-multipart',phase:'intent',detail:{label:'Unicode journal 🧪'}};
 await appendConformanceJournal({async write(buffer,offset,length){const bytesWritten=Math.min(7,length);chunks.push(Buffer.from(buffer.subarray(offset,offset+bytesWritten)));return {bytesWritten};},async sync(){const record=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.deepEqual(record.event,event);synced=true;}},event);assert.equal(synced,true);
 for(const mode of['zero','throw','sync']){
  const f=fixture();let writes=0;await assert.rejects(runStorageConformance(f.plan,{credentials,factory:f.factory,record:async e=>{if(e.phase!=='intent')return f.record(e);await appendConformanceJournal({async write(_buffer,_offset,length){writes++;if(mode==='throw')throw Error(credentials.secretAccessKey);return {bytesWritten:mode==='zero'?0:length};},async sync(){if(mode==='sync')throw Error('sync failed');}},e);}}));assert.equal(writes,1);assert(!f.calls.includes('create'));
 }
});
test('abort during durable intent prevents provider I/O even if a caller replaces the dependency signal',async()=>{
 const f=fixture(),stop=new AbortController();const deps:Parameters<typeof runStorageConformance>[1]={credentials,factory:f.factory,signal:stop.signal,record:async event=>{await f.record(event);if(event.phase==='intent'){stop.abort(new Error('private reason'));deps.signal=undefined;}}};
 await assert.rejects(runStorageConformance(f.plan,deps),e=>e instanceof RunpodStorageError&&e.code==='STORAGE_ABORTED');assert(!f.calls.includes('create'));assert(!JSON.stringify(f.events).includes('private reason'));
});
test('read-only cancellation settles on a stalled stream even when its cleanup callback does not cooperate',{timeout:3000},async()=>{
 const f=fixture();await runStorageConformance(f.plan,{credentials,factory:f.factory,record:f.record});const stop=new AbortController();let cancelled=false;
 const factory=(config:RunpodProjectStorageConfig):RunpodProjectStorage=>{
  const real=f.factory(config);return {...real,async get(input){
   const response=await real.get(input);void response.stream.cancel();setTimeout(()=>stop.abort(),10);
   return {...response,stream:new ReadableStream<Uint8Array>({pull:()=>new Promise(()=>{}),cancel(){cancelled=true;return new Promise(()=>{});}})};
  }};
 };
 await assert.rejects(verifyStorageConformance(f.plan,{credentials,factory,record:f.record,signal:stop.signal}),e=>e instanceof RunpodStorageError&&e.code==='STORAGE_ABORTED');assert.equal(cancelled,true);
});
test('full-read metadata inconsistency cannot pass merely because bytes happen to match',async()=>{
 const f=fixture();await runStorageConformance(f.plan,{credentials,factory:f.factory,record:f.record});
 for(const patch of[{etag:'"changed"'},{contentType:'text/html'},{contentRange:'bytes 0-10/11'}]){
  const factory=(config:RunpodProjectStorageConfig):RunpodProjectStorage=>{const real=f.factory(config);return {...real,async get(input){return {...await real.get(input),...patch};}};};
  await assert.rejects(verifyStorageConformance(f.plan,{credentials,factory,record:f.record}),e=>e instanceof RunpodStorageError&&e.code==='STORAGE_PROVIDER_PROTOCOL');
 }
});
test('CLI prepares offline and refuses an existing mutation journal before any network call',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'coatria-conformance-')),directory=join(temporary,'run'),invoke=promisify(execFile),script=resolve('scripts/verify-project-storage-provider.ts');
 try{
  const prepared=await invoke(process.execPath,['--import','tsx',script,'prepare','synthetic-volume','US-NC-2',directory],{env:{...process.env,COATRIA_CONFORMANCE_S3_ACCESS_KEY_ID:'',COATRIA_CONFORMANCE_S3_SECRET_ACCESS_KEY:''}}),report=JSON.parse(prepared.stdout),plan=JSON.parse(await readFile(join(directory,'plan.json'),'utf8'));assert.equal(report.planSha256,storageConformancePlanSha256(plan));assert.equal(report.startsCompute,false);
  await writeFile(join(directory,'mutation-journal.jsonl'),'existing uncertain intent\n');
  await assert.rejects(invoke(process.execPath,['--import','tsx',script,'run',directory,report.planSha256],{timeout:5000,env:{...process.env,COATRIA_CONFORMANCE_S3_ACCESS_KEY_ID:credentials.accessKeyId,COATRIA_CONFORMANCE_S3_SECRET_ACCESS_KEY:credentials.secretAccessKey}}),(error:any)=>{assert.equal(error.code,1);assert.match(error.stderr,/STORAGE_CONFORMANCE_SETUP_OR_JOURNAL_FAILED/);assert(!error.stderr.includes(credentials.secretAccessKey));return true;});
  assert.equal(await readFile(join(directory,'mutation-journal.jsonl'),'utf8'),'existing uncertain intent\n');
 }finally{const target=resolve(temporary);assert(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('coatria-conformance-'));await rm(target,{recursive:true,force:true});}
});
test('CLI refuses symlink/junction directories, hard-linked or oversized plans and network/device paths before any credential or network use',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coatria-conformance-path-')),plan=prepareStorageConformance('synthetic-volume','US-NC-2'),hash=storageConformancePlanSha256(plan),planPath=join(directory,'plan.json'),alias=directory+'-alias';
 const removeAlias=async()=>{const path=resolve(alias);assert(path.startsWith(resolve(tmpdir())+sep)&&basename(path)===basename(directory)+'-alias');await rm(path,{recursive:true,force:true});};
 try{
  await writeFile(planPath,JSON.stringify(plan));await symlink(directory,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(conformanceCli(['run',alias,hash]),/symlink or junction/);await assert.rejects(conformanceCli(['prepare','synthetic-volume','US-NC-2',join(alias,'unexpected')]),/symlink or junction/);await removeAlias();
  const other=join(directory,'plan-link');await link(planPath,other);await assert.rejects(conformanceCli(['run',directory,hash]),/bounded regular plan file/);await rm(other);
  await writeFile(planPath,' '.repeat(16385));await assert.rejects(conformanceCli(['run',directory,hash]),/bounded regular plan file/);
  for(const path of['//untrusted-server/share','\\\\untrusted-server\\share',...(process.platform==='win32'?['\\\\?\\C:\\private','C:\\private:alternate']:[])])await assert.rejects(conformanceCli(['run',path,hash]));
 }finally{const target=resolve(directory);assert(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('coatria-conformance-'));await removeAlias();await rm(target,{recursive:true,force:true});}
});
