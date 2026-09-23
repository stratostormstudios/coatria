import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,open,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {
 VERCEL_MEDIA_IMAGE,VERCEL_MEDIA_CHECKS,parseVercelMediaQualification,
 createVercelMediaSandboxCandidate,isQualifiedVercelMediaSandbox,
 type VercelMediaSandboxOptions,
} from '../src/lib/higgsfield-vercel-media-sandbox';
import {MediaSandboxError} from '../src/lib/higgsfield-media-sandbox';
import {inspectHiggsfieldArchiveMedia,HiggsfieldMediaInspectionError} from '../src/lib/higgsfield-media-inspection';

const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const now=Date.parse('2026-09-21T12:00:00Z');
const limits={maxInputBytes:1024*1024,maxClosureBytes:1024*1024,timeoutMs:1000,maxOutputBytes:4096,maxStderrBytes:1024};
const binding={teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1' as const,image:VERCEL_MEDIA_IMAGE,closureSha256:'a'.repeat(64),limits};
function receipt(){return {version:1,backend:'vercel-firecracker',mode:'live-provider',...binding,limits:{...limits},issuedAtMs:now-1000,expiresAtMs:now+60000,checks:Object.fromEntries(VERCEL_MEDIA_CHECKS.map(key=>[key,true])),evidence:[{sessionId:'sbx_synthetic',sha256:'b'.repeat(64)}]};}
function fixedError(error:unknown){assert.ok(error instanceof MediaSandboxError);assert.doesNotMatch(error.message,/synthetic-secret|private\.invalid|credential|https?:|[A-Z]:\\/i);assert.equal(error.cause,undefined);return true;}

test('provider qualification snapshots exact reviewed scope without conferring runtime branding',()=>{
 const raw=receipt(),parsed=parseVercelMediaQualification(raw,binding,now);
 raw.checks[VERCEL_MEDIA_CHECKS[0]]=false;raw.evidence[0].sha256='c'.repeat(64);raw.limits.timeoutMs=900;
 assert.equal(parsed.checks[VERCEL_MEDIA_CHECKS[0]],true);assert.equal(parsed.evidence[0].sha256,'b'.repeat(64));assert.equal(parsed.limits.timeoutMs,1000);
 assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.checks));assert.ok(Object.isFrozen(parsed.evidence));assert.ok(Object.isFrozen(parsed.evidence[0]));assert.ok(Object.isFrozen(parsed.limits));
 assert.equal(isQualifiedVercelMediaSandbox(parsed),false);assert.equal(isQualifiedVercelMediaSandbox({run:async()=>'',qualified:true}),false);
});

test('provider receipt rejects different account/project/region/image/closure and weakened evidence',()=>{
 const mutations:Array<(v:any)=>void>=[
  v=>{v.teamId='team_other';},v=>{v.projectId='prj_other';},v=>{v.region='sfo1';},v=>{v.image='node:latest';},v=>{v.closureSha256='c'.repeat(64);},
  v=>{v.mode='fixture';},v=>{v.backend='linux-bubblewrap';},v=>{v.version=2;},v=>{v.checks[VERCEL_MEDIA_CHECKS[0]]=false;},v=>{delete v.checks[VERCEL_MEDIA_CHECKS[0]];},
  v=>{v.checks.unobservedControl=true;},v=>{v.evidence=[];},v=>{v.evidence[0].sha256='not-a-hash';},v=>{v.evidence[0].sessionId='https://private.invalid/synthetic-secret';},
  v=>{v.issuedAtMs=now+1000;},v=>{v.expiresAtMs=now;},v=>{v.issuedAtMs=0;},v=>{v.limits.timeoutMs+=1;},v=>{v.limits.allowNetwork=true;},v=>{v.secret='synthetic-secret';},
 ];for(const change of mutations){const value=receipt();change(value);assert.throws(()=>parseVercelMediaQualification(value,binding,now),fixedError);}
});

async function fixture(run:(value:{root:string;options:VercelMediaSandboxOptions;input:{tool:'ffprobe';args:string[];inputFd:number;timeoutMs:number;maxOutputBytes:number;maxStderrBytes:number};events:any[];inputPath:string;inputBytes:Buffer})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'coatria-vercel-sandbox-'));await mkdir(join(root,'bin'));
 const files=[];for(const tool of ['ffprobe','ffmpeg']){const bytes=Buffer.from('synthetic closed decoder '+tool);await writeFile(join(root,'bin',tool),bytes);files.push({path:'bin/'+tool,bytes:bytes.length,sha256:digest(bytes)});}
 const inputPath=resolve('tests/fixtures/media/synthetic.png'),inputBytes=await readFile(inputPath),file=await open(inputPath,'r'),events:any[]=[];
 const options:VercelMediaSandboxOptions={teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',token:async()=>'synthetic-secret-provider-token',closure:{root,files},limits:{...limits},journal:{reserve:async intent=>{events.push({journal:'reserve',...intent});},authorize:async intent=>{events.push({journal:'authorize',...intent});},record:async event=>{events.push({journal:'record',...event});}}};
 try{await run({root,options,input:{tool:'ffprobe',args:['-v','warning','-protocol_whitelist','fd','-fd','0','-show_format','-of','json','fd:'],inputFd:file.fd,timeoutMs:1000,maxOutputBytes:4096,maxStderrBytes:1024},events,inputPath,inputBytes});}
 finally{await file.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
}

test('an injected candidate can never be used as the production media-inspection boundary',async()=>fixture(async({options,inputPath,inputBytes})=>{
 let calls=0;const sandbox=await createVercelMediaSandboxCandidate(options,{fetch:async()=>{calls++;throw Error('synthetic-secret transport must not execute');}});
 assert.equal(isQualifiedVercelMediaSandbox(sandbox),false);
 await assert.rejects(inspectHiggsfieldArchiveMedia({path:inputPath,expectedKind:'image',expectedBytes:inputBytes.length,expectedSha256:digest(inputBytes)},{sandbox}),error=>error instanceof HiggsfieldMediaInspectionError&&error.code==='MEDIA_INSPECTOR_UNAVAILABLE');
 assert.equal(calls,0);
}));

test('a pre-aborted invocation cannot reserve funds or create a provider session',async()=>fixture(async({options,input,events})=>{
 let calls=0;const sandbox=await createVercelMediaSandboxCandidate(options,{fetch:async()=>{calls++;throw Error('must not create');}}),controller=new AbortController();controller.abort(Error('https://private.invalid/synthetic-secret'));
 await assert.rejects(sandbox.run({...input,signal:controller.signal}),fixedError);assert.equal(calls,0);assert.deepEqual(events,[]);
}));

test('authorization and durable reservation failures prevent provider dispatch',async()=>{
 for(const denied of ['authorize','reserve'] as const)await fixture(async({options,input})=>{
  let calls=0;options.journal[denied]=async()=>{throw Error('synthetic-secret journal unavailable');};
  const sandbox=await createVercelMediaSandboxCandidate(options,{fetch:async()=>{calls++;throw Error('must not create');}});
  await assert.rejects(sandbox.run(input),fixedError);assert.equal(calls,0);
 });
});

test('an oversized input never reaches provider upload',async()=>{
 await fixture(async({options,input,inputBytes})=>{
  let calls=0;options.limits={...options.limits,maxInputBytes:inputBytes.length-1};
  const sandbox=await createVercelMediaSandboxCandidate(options,{fetch:async()=>{calls++;throw Error('must not upload');}});
  await assert.rejects(sandbox.run(input),fixedError);assert.equal(calls,0);
 });
});

test('production cannot enable a fixture provider transport',async()=>fixture(async({options})=>{
 const prior=process.env.NODE_ENV;let calls=0;
 try{Object.defineProperty(process.env,'NODE_ENV',{value:'production',writable:true,configurable:true,enumerable:true});
  await assert.rejects(async()=>createVercelMediaSandboxCandidate(options,{fetch:async()=>{calls++;throw Error('synthetic-secret');}}),fixedError);
  assert.equal(calls,0);
 }finally{if(prior===undefined)delete(process.env as Record<string,string|undefined>).NODE_ENV;else Object.defineProperty(process.env,'NODE_ENV',{value:prior,writable:true,configurable:true,enumerable:true});}
}));

test('URL locators, bearer material and unexpected decoder switches never enter the guest',async()=>{
 for(const args of [['-i','https://private.invalid/synthetic-secret'],['-i','fd:','-headers','Authorization: Bearer synthetic-secret'],['-v','warning','-protocol_whitelist','fd,http','-fd','0','-show_format','-of','json','fd:'],['-v','warning','-protocol_whitelist','fd','-fd','0','-unsafe-synthetic','fd:']])await fixture(async({options,input})=>{
  let calls=0;const sandbox=await createVercelMediaSandboxCandidate(options,{fetch:async()=>{calls++;throw Error('must not create');}});
  await assert.rejects(sandbox.run({...input,args}),fixedError);assert.equal(calls,0);
 });
});

type Call={path:string;method:string;body:any;headers:Headers;signal:AbortSignal|null|undefined};
function provider({mutateCreate,mutateFinished,createLost=false,byNameMissing=false,recoverOwned=false,cleanupWrongSession=false,terminalAfter=1,stdout='synthetic decoder output',logOverride,onCommand,onTerminal}:{mutateCreate?:(value:any)=>void;mutateFinished?:(value:any)=>void;createLost?:boolean;byNameMissing?:boolean;recoverOwned?:boolean;cleanupWrongSession?:boolean;terminalAfter?:number;stdout?:string;logOverride?:()=>Response;onCommand?:()=>void;onTerminal?:()=>void}={}){
 const calls:Call[]=[],uploads=new Map<string,Buffer>();let created:any,ownedCreated:any,job:any;
 let statusReads=0;
 const response=(body:unknown)=>Response.json(body);
 const transport:typeof fetch=async(resource,init={})=>{
  const url=new URL(String(resource)),path=url.pathname,method=init.method??'GET',headers=new Headers(init.headers);
  assert.equal(url.origin,'https://api.vercel.com');assert.equal(url.searchParams.get('teamId'),'team_synthetic');assert.equal(init.redirect,'error');assert.equal(headers.get('authorization'),'Bearer synthetic-secret-provider-token');
  const body=typeof init.body==='string'?JSON.parse(init.body):init.body;calls.push({path,method,body,headers,signal:init.signal});
  if(path==='/v3/sandboxes'&&method==='POST'){
   created={sandbox:{name:body.name,currentSessionId:'sbx_synthetic',persistent:false,image:VERCEL_MEDIA_IMAGE,region:'iad1',timeout:1000,vcpus:2,memory:4096,failoverRegions:[],networkPolicy:{mode:'deny-all'}},session:{id:'sbx_synthetic',status:'running',vcpus:2,memory:4096,region:'iad1',timeout:1000,networkPolicy:{mode:'deny-all'},startedAt:Date.now()},routes:[]};ownedCreated=structuredClone(created);mutateCreate?.(created);
   if(createLost)throw Error('https://private.invalid/synthetic-secret lost create');return response(created);
  }
  if(path.startsWith('/v2/sandboxes/coatria-media-')){assert.equal(url.searchParams.get('resume'),'false');assert.equal(url.searchParams.get('projectId'),'prj_synthetic');return byNameMissing?Response.json({error:'synthetic not found'},{status:404}):response(recoverOwned?ownedCreated:created);}
  if(path.endsWith('/fs/write')){
   assert.equal(method,'POST');assert.equal(headers.get('content-type'),'application/gzip');assert.equal(headers.get('x-cwd'),'/vercel');
   const archive=gunzipSync(Buffer.from(body));let offset=0;
   while(offset+512<=archive.length){const header=archive.subarray(offset,offset+512);if(header.every(value=>value===0))break;const name=header.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);offset+=512;uploads.set(name,Buffer.from(archive.subarray(offset,offset+size)));offset+=Math.ceil(size/512)*512;}
   job=JSON.parse(uploads.get('coatria/job.json')!.toString());return response({});
  }
  if(path.endsWith('/cmd')&&method==='POST'){onCommand?.();return response({command:{id:'cmd_synthetic',sessionId:'sbx_synthetic'}});}
  if(path.endsWith('/cmd/cmd_synthetic')&&method==='GET'){const result={command:{id:'cmd_synthetic',sessionId:'sbx_synthetic',exitCode:0}};mutateFinished?.(result);return response(result);}
  if(path.endsWith('/logs'))return logOverride?.()??new Response(JSON.stringify({stream:'stdout',data:JSON.stringify({version:1,inputBytes:job.inputBytes,inputSha256:job.inputSha256,stdout:Buffer.from(stdout).toString('base64')})+'\n'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  if(path.endsWith('/stop')){assert.equal(method,'POST');assert.equal(init.signal?.aborted,false);return response({});}
  if(path==='/v2/sandboxes/sessions/sbx_synthetic'&&method==='GET'){statusReads++;if(statusReads>=terminalAfter)onTerminal?.();return response({session:{id:cleanupWrongSession?'sbx_other':'sbx_synthetic',status:statusReads>=terminalAfter?'stopped':'running'}});}
  throw Error('Unexpected synthetic request');
 };
 return {transport,calls,uploads};
}

test('a successful disposable run uses exact policy, sealed bytes, secret-free guest inputs and terminal cleanup',async()=>fixture(async({options,input,events,inputBytes,root})=>{
 let terminalObserved=false;const fake=provider({onTerminal:()=>{terminalObserved=true;}}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
 await writeFile(join(root,'bin','ffprobe'),'changed after the constructor snapshot');
 assert.equal(await sandbox.run(input),'synthetic decoder output');assert.equal(terminalObserved,true);
 const create=fake.calls.find(call=>call.path==='/v3/sandboxes')!.body;
 assert.deepEqual(create.resources,{vcpus:2});assert.equal(create.image,VERCEL_MEDIA_IMAGE);assert.equal(create.persistent,false);assert.deepEqual(create.networkPolicy,{mode:'deny-all'});assert.deepEqual(create.env,{});assert.deepEqual(create.ports,[]);assert.deepEqual(create.failoverRegions,[]);
 assert.deepEqual([...fake.uploads.keys()].sort(),['coatria/input.bin','coatria/job.json','coatria/launcher.cjs','coatria/runtime/bin/ffprobe']);
 assert.deepEqual(fake.uploads.get('coatria/input.bin'),inputBytes);assert.equal(fake.uploads.get('coatria/runtime/bin/ffprobe')!.toString(),'synthetic closed decoder ffprobe');
 for(const[name,bytes]of fake.uploads){assert.doesNotMatch(bytes.toString(),/synthetic-secret-provider-token|https:\/\/private\.invalid|authorization|Bearer /i,name);}
 const guest=fake.calls.find(call=>call.path.endsWith('/cmd')&&call.method==='POST')!.body;assert.equal(guest.sudo,false);assert.deepEqual(guest.env,{});assert.deepEqual(guest.args,['-i','PATH=/usr/local/bin:/usr/bin:/bin','node','/vercel/coatria/launcher.cjs']);
 assert.deepEqual(events.map(event=>event.journal==='record'?event.type:event.journal),['reserve','authorize','created','authorize','authorize','authorize','cleanup-intent','terminal','authorize']);
 assert.doesNotMatch(JSON.stringify(events),/synthetic-secret|Bearer|private\.invalid/);
 assert.equal(fake.calls.filter(call=>call.path==='/v3/sandboxes').length,1);assert.equal(fake.calls.at(-1)?.path,'/v2/sandboxes/sessions/sbx_synthetic');
}));

test('both tools are verified and bound even when only one tool is uploaded for a run',async()=>fixture(async({options,root})=>{
 const fake=provider(),first=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport}),changed=Buffer.from('synthetic replacement ffmpeg');
 await writeFile(join(root,'bin','ffmpeg'),changed);await assert.rejects(createVercelMediaSandboxCandidate(options,{fetch:fake.transport}),fixedError);
 const second=await createVercelMediaSandboxCandidate({...options,closure:{...options.closure,files:options.closure.files.map(file=>file.path==='bin/ffmpeg'?{...file,bytes:changed.length,sha256:digest(changed)}:file)}},{fetch:fake.transport});
 assert.notEqual(first.qualificationBinding.closureSha256,second.qualificationBinding.closureSha256);assert.equal(fake.calls.length,0);
}));

test('wrong provider session, image, network, resources, persistence or routes never receive media',async()=>{
 const mutations:Array<(value:any)=>void>=[value=>{value.sandbox.image='node:latest';},value=>{value.sandbox.networkPolicy.mode='allow-all';},value=>{value.session.networkPolicy.mode='allow-all';},value=>{value.sandbox.vcpus=4;},value=>{value.session.memory=8192;},value=>{value.sandbox.persistent=true;},value=>{value.sandbox.region='sfo1';},value=>{value.session.timeout=5000;},value=>{value.sandbox.currentSnapshotId='snapshot_synthetic';},value=>{value.routes=[{port:3000}];},value=>{value.resumed=true;}];
 for(const mutateCreate of mutations)await fixture(async({options,input,events})=>{
  const fake=provider({mutateCreate}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});await assert.rejects(sandbox.run(input),fixedError);
  assert.equal(fake.uploads.size,0);assert.equal(fake.calls.filter(call=>call.path.endsWith('/stop')).length,1);assert.ok(events.some(event=>event.type==='terminal'));
 });
});

test('foreign or internally mismatched create handles cannot authorize stopping an unrelated session',async()=>{
 const mutations:Array<(value:any)=>void>=[value=>{value.sandbox.name='unrelated-existing-company';},value=>{value.sandbox.projectId='prj_other';},value=>{value.session.teamId='team_other';},value=>{value.sandbox.currentSessionId='sbx_other';}];
 for(const mutateCreate of mutations)await fixture(async({options,input,events})=>{
  const fake=provider({mutateCreate,byNameMissing:true}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
  await assert.rejects(sandbox.run(input),fixedError);assert.equal(fake.uploads.size,0);assert.equal(fake.calls.filter(call=>call.path.endsWith('/stop')).length,0);
  assert.ok(events.some(event=>event.type==='cleanup-unknown'));await assert.rejects(sandbox.run(input),fixedError);assert.equal(fake.calls.filter(call=>call.path==='/v3/sandboxes').length,1);
 });
});

test('a foreign create response may reconcile only the exact intended session for cleanup, never for execution',async()=>fixture(async({options,input,events})=>{
 const fake=provider({recoverOwned:true,mutateCreate:value=>{value.sandbox.name='unrelated-existing-company';value.sandbox.currentSessionId='sbx_foreign';value.session.id='sbx_foreign';}}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
 await assert.rejects(sandbox.run(input),fixedError);assert.equal(fake.uploads.size,0);assert.deepEqual(fake.calls.filter(call=>call.path.endsWith('/stop')).map(call=>call.path),['/v2/sandboxes/sessions/sbx_synthetic/stop']);assert.ok(!fake.calls.some(call=>call.path.includes('sbx_foreign')));assert.ok(events.some(event=>event.type==='terminal'));
}));

test('a lost create response reconciles one exact name only for cleanup and permanently prevents another create',async()=>fixture(async({options,input,events})=>{
 const fake=provider({createLost:true}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
 await assert.rejects(sandbox.run(input),fixedError);await assert.rejects(sandbox.run(input),fixedError);
 assert.equal(fake.calls.filter(call=>call.path==='/v3/sandboxes').length,1);assert.equal(fake.calls.filter(call=>call.path.startsWith('/v2/sandboxes/coatria-media-')).length,1);assert.equal(fake.uploads.size,0);
 assert.ok(events.some(event=>event.type==='create-unknown'));assert.ok(events.some(event=>event.type==='terminal'));
}));

test('a failed create-unknown journal record cannot suppress scoped resource cleanup',async()=>fixture(async({options,input,events})=>{
 const save=options.journal.record;options.journal.record=async event=>{await save(event);if(event.type==='create-unknown')throw Error('synthetic-secret journal failure');};
 const fake=provider({createLost:true}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});await assert.rejects(sandbox.run(input),fixedError);
 assert.equal(fake.calls.filter(call=>call.path.startsWith('/v2/sandboxes/coatria-media-')).length,1);assert.equal(fake.calls.filter(call=>call.path.endsWith('/stop')).length,1);assert.equal(fake.uploads.size,0);assert.ok(events.some(event=>event.type==='terminal'));
}));

test('a 404 after an ambiguous create remains unresolved and cannot permit a replacement VM',async()=>fixture(async({options,input,events})=>{
 const fake=provider({createLost:true,byNameMissing:true}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
 await assert.rejects(sandbox.run(input),error=>fixedError(error)&&(error as MediaSandboxError).code==='CLEANUP_FAILED');await assert.rejects(sandbox.run(input),fixedError);
 assert.equal(fake.calls.filter(call=>call.path==='/v3/sandboxes').length,1);assert.equal(fake.uploads.size,0);assert.ok(events.some(event=>event.type==='create-unknown'));assert.ok(events.some(event=>event.type==='cleanup-unknown'));assert.ok(!events.some(event=>event.type==='terminal'));
}));

test('a successful stop acknowledgement alone cannot release output before terminal provider readback',async()=>fixture(async({options,input})=>{
 let stopped=false;const fake=provider({terminalAfter:2,onTerminal:()=>{stopped=true;}}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
 assert.equal(await sandbox.run(input),'synthetic decoder output');assert.equal(stopped,true);assert.equal(fake.calls.filter(call=>call.path==='/v2/sandboxes/sessions/sbx_synthetic').length,2);
}));

test('a command completion from a different session or command cannot supply trusted output',async()=>{
 for(const mutateFinished of [(value:any)=>{value.command.sessionId='sbx_other';},(value:any)=>{value.command.id='cmd_other';},(value:any)=>{value.command.exitCode=1;}])await fixture(async({options,input,events})=>{
  const fake=provider({mutateFinished}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});await assert.rejects(sandbox.run(input),fixedError);assert.ok(events.some(event=>event.type==='terminal'));assert.ok(!fake.calls.some(call=>call.path.endsWith('/logs')));
 });
});

test('caller cancellation still destroys the whole session through an independent cleanup signal',async()=>fixture(async({options,input,events})=>{
 const abort=new AbortController(),fake=provider({onCommand:()=>abort.abort(Error('synthetic-secret'))}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
 await assert.rejects(sandbox.run({...input,signal:abort.signal}),error=>fixedError(error)&&(error as MediaSandboxError).code==='ABORTED');
 assert.ok(events.some(event=>event.type==='terminal'));assert.equal(fake.calls.filter(call=>call.path.endsWith('/stop')).length,1);
}));

test('cancelling a pending authority callback prevents upload and still cleans the created session',async()=>fixture(async({options,input,events})=>{
 let entered!:()=>void,authorizations=0;const waiting=new Promise<void>(resolve=>{entered=resolve;}),abort=new AbortController();
 options.journal.authorize=async()=>{if(++authorizations===2){entered();await new Promise<void>(()=>{});}};
 const fake=provider(),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport}),pending=sandbox.run({...input,signal:abort.signal});
 await waiting;await assert.rejects(sandbox.run(input),fixedError);abort.abort(Error('synthetic-secret authority revoked'));
 await assert.rejects(pending,error=>fixedError(error)&&(error as MediaSandboxError).code==='ABORTED');assert.equal(fake.uploads.size,0);assert.equal(fake.calls.filter(call=>call.path==='/v3/sandboxes').length,1);assert.ok(events.some(event=>event.type==='terminal'));
}));

test('an abort immediately after create still retains and cleans the exact returned session',async()=>fixture(async({options,input,events})=>{
 const abort=new AbortController(),fake=provider();const transport:typeof fetch=async(resource,init)=>{const response=await fake.transport(resource,init);if(new URL(String(resource)).pathname==='/v3/sandboxes')abort.abort(Error('synthetic-secret'));return response;};
 const sandbox=await createVercelMediaSandboxCandidate(options,{fetch:transport});await assert.rejects(sandbox.run({...input,signal:abort.signal}),error=>fixedError(error)&&(error as MediaSandboxError).code==='ABORTED');assert.equal(fake.uploads.size,0);assert.ok(events.some(event=>event.type==='terminal'));
}));

test('a withdrawal at the final authorization gate withholds output after terminal cleanup',async()=>fixture(async({options,input,events})=>{
 let ended=false;const save=options.journal.record;options.journal.record=async event=>{await save(event);if(event.type==='terminal')ended=true;};options.journal.authorize=async()=>{if(ended)throw Error('synthetic-secret authority revoked');};
 const fake=provider(),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});await assert.rejects(sandbox.run(input),fixedError);assert.ok(events.some(event=>event.type==='terminal'));
}));

test('cleanup identity mismatch or a failed terminal journal fences output and poisons future execution',async()=>{
 for(const mode of ['identity','journal'] as const)await fixture(async({options,input,events})=>{
  if(mode==='journal'){const save=options.journal.record;options.journal.record=async event=>{await save(event);if(event.type==='terminal')throw Error('synthetic-secret journal failed');};}
  const fake=provider({cleanupWrongSession:mode==='identity'}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});
  await assert.rejects(sandbox.run(input),error=>fixedError(error)&&(error as MediaSandboxError).code==='CLEANUP_FAILED');await assert.rejects(sandbox.run(input),fixedError);
  assert.equal(fake.calls.filter(call=>call.path==='/v3/sandboxes').length,1);assert.ok(events.some(event=>event.type==='cleanup-unknown'));
 });
});

test('oversized provider output and unexpected stderr are bounded failures that still stop the session',async()=>{
 for(const logOverride of [()=>new Response('x'.repeat(100000),{headers:{'content-type':'application/x-ndjson'}}),()=>new Response(JSON.stringify({stream:'stderr',data:'https://private.invalid/synthetic-secret'})+'\n',{headers:{'content-type':'application/x-ndjson'}})])await fixture(async({options,input,events})=>{
  const fake=provider({logOverride}),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});await assert.rejects(sandbox.run(input),fixedError);assert.ok(events.some(event=>event.type==='terminal'));
 });
});

test('the bounded grammar accepts current inspector probe, full-decode and frame-pass commands for every supported demuxer',async()=>{
 const videoCodecs='h264,hevc,av1,mpeg4,prores,libdav1d,libaom-av1',audioCodecs='aac,mp3,mp3float,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_u8';
 const formats=[['png_pipe','png'],['jpeg_pipe','mjpeg'],['webp_pipe','webp'],['mov',videoCodecs+','+audioCodecs],['wav',audioCodecs],['mp3',audioCodecs]];
 const fields='stream=index,codec_type,codec_name,width,height,sample_rate,channels,time_base,avg_frame_rate,duration,color_space,color_primaries,color_transfer,color_range:format=duration';
 for(const[demuxer,codecs]of formats)await fixture(async({options,input})=>{
  const common=['-v','warning','-max_alloc','67108864','-threads','1','-max_pixels','33554432','-protocol_whitelist','fd','-format_whitelist',demuxer,'-codec_whitelist',codecs,'-probesize','5242880','-analyzeduration','5000000','-f',demuxer,...demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[],'-fd','0'];
  const commands:[typeof input.tool|'ffmpeg',string[]][]=[['ffprobe',[...common,'-show_entries',fields,'-of','json','fd:']],['ffmpeg',['-nostdin',...common,'-err_detect','explode','-xerror','-guess_layout_max','0','-i','fd:','-map','0:v?','-map','0:a?','-threads','1','-filter_threads','1','-filter_complex_threads','1','-f','null','-']],['ffprobe',[...common,'-err_detect','explode','-show_frames','-show_entries',fields+':frame=media_type,best_effort_timestamp,duration,pkt_duration,width,height,nb_samples','-of','json','fd:']]];
  for(const[tool,args]of commands){const fake=provider(),sandbox=await createVercelMediaSandboxCandidate(options,{fetch:fake.transport});assert.equal(await sandbox.run({...input,tool,args}),'synthetic decoder output');const job=JSON.parse(fake.uploads.get('coatria/job.json')!.toString());assert.deepEqual(job.args,args);assert.equal(job.tool,tool);}
 });
});
