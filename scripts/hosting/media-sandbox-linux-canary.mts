/** No skip path: this command qualifies an actual Linux host or fails the job.
 * Original hostile ELF exists only in its separately pinned test profile. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,readFile,readlink,readdir,rmdir,writeFile} from 'node:fs/promises';
import {createServer,connect,type Server} from 'node:net';
import {release} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createLinuxMediaSandbox,MediaSandboxError,type MediaSandboxExitEvidence,type QualifiedLinuxMediaSandbox,type MediaSandboxLimits} from '../../src/lib/higgsfield-media-sandbox';
import {inspectHiggsfieldArchiveMedia,type HiggsfieldMediaDescriptor} from '../../src/lib/higgsfield-media-inspection';
import {diagnoseMediaSandboxStartup,diagnoseArchiveHostSandboxStartup} from './media-sandbox-startup-diagnostic.mts';
import {archiveHostCpuSummary} from './archive-host-diagnostics.mjs';

type ProfilePin={profilePath:string;expectedProfileSha256:string};
export type MediaSandboxCanaryConfig={fixtureRoot?:string;sourceRoot?:string;diagnostics?:boolean;diagnosticScope?:'archive-host-qualification';version:number;profiles:{real:ProfilePin;conformance:ProfilePin};serviceRoot:string;supervisorGroup:string;cgroupRoot:string;uid:number;gid:number;hostCanaryPath:string;hostCanarySha256:string;evidence:string};
type Config=MediaSandboxCanaryConfig;
type Observation={group:string;processes:Set<number>;controls:Record<string,string>};
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const fixture=(config:Config,name:string)=>resolve(config.fixtureRoot??'tests/fixtures/media',name);
const source=(config:Config,name:string)=>resolve(config.sourceRoot??'.',name);
const namespaceNames=['mnt','pid','net','ipc','uts','user','cgroup'] as const;
const namespaces=async()=>Object.fromEntries(await Promise.all(namespaceNames.map(async name=>[name,await readlink('/proc/self/ns/'+name)])));
const text=async(path:string)=>(await readFile(path,'utf8')).trim();
const code=(error:unknown)=>error instanceof MediaSandboxError?error.code:'CANARY_ASSERTION_FAILED';
const closed=async(server:Server)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
const alive=async(pid:number)=>{try{const value=await text('/proc/'+pid+'/stat');return value.slice(value.lastIndexOf(')')+2).split(' ')[0]!=='Z';}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
const processIds=async(path:string)=>(await text(join(path,'cgroup.procs'))).split(/\s+/).filter(Boolean).map(Number);
async function waitFor(condition:()=>Promise<boolean>,milliseconds=5000){const end=Date.now()+milliseconds;while(Date.now()<end){if(await condition())return;await delay(20);}assert.fail('Bounded host observation timed out.');}
async function observe(config:Config,observations:Map<string,Observation>){
 for(const name of await readdir(config.cgroupRoot))if(/^decoder-[a-f0-9-]+$/.test(name)){
  const path=join(config.cgroupRoot,name);try{const ids=await processIds(path);if(!ids.length)continue;let observation=observations.get(path);if(!observation){const controls:Record<string,string>={};for(const key of ['memory.max','memory.swap.max','memory.oom.group','pids.max','cpu.max'])controls[key]=await text(join(path,key));observation={group:path,processes:new Set(),controls};observations.set(path,observation);}ids.forEach(pid=>observation!.processes.add(pid));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
}
async function assertDrained(config:Config,observations:Map<string,Observation>){
 await waitFor(async()=>{for(const item of observations.values())for(const pid of item.processes)if(await alive(pid))return false;return true;});
 assert.equal((await readdir(config.cgroupRoot)).filter(name=>name.startsWith('decoder-')).length,0);
}
function checkControls(observations:Map<string,Observation>,limits:MediaSandboxLimits){assert.ok(observations.size>0,'A real decoder must be observed inside its assigned cgroup.');for(const item of observations.values())assert.deepEqual(item.controls,{'memory.max':String(limits.memoryBytes),'memory.swap.max':'0','memory.oom.group':'1','pids.max':String(limits.pids),'cpu.max':`${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`});}
const boundaryFacts=['hostFileHidden','hostProcHidden','environmentClean','extraHandlesClosed','inputReadonly','rootReadonly','capabilitiesZero','noNewPrivileges','nestedUsernsDenied','localNetworkDenied','externalNetworkDenied','ipv6Denied'] as const;
const boundaryNetwork=['interfacesLoopbackOnly','routableDefaultAbsent','apparmorChildStacked'] as const;
const boundaryErrorCodes=new Set(['SANDBOX_UNAVAILABLE','INVALID_PROFILE','INPUT_INVALID','ABORTED','TIMEOUT','OUTPUT_LIMIT','PROCESS_FAILED','CLEANUP_FAILED']);
const booleanFields=(value:unknown,keys:readonly string[])=>Object.fromEntries(keys.map(key=>[key,value&&typeof value==='object'&&typeof (value as Record<string,unknown>)[key]==='boolean'?(value as Record<string,unknown>)[key]:null]));
/** A diagnostic projection only: never raw process output, paths, PIDs or errors. */
export function mediaSandboxBoundaryObservation(observations:Map<string,Observation>,limits:MediaSandboxLimits,error:unknown=undefined){
 const expected={'memory.max':String(limits.memoryBytes),'memory.swap.max':'0','memory.oom.group':'1','pids.max':String(limits.pids),'cpu.max':`${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`};
 return {diagnosticOnly:true,qualified:false,execution:error===undefined?'not_observed':error===null?'succeeded':'failed',executionCode:error===undefined||error===null?null:error instanceof MediaSandboxError&&boundaryErrorCodes.has(error.code)?error.code:'CANARY_ASSERTION_FAILED',observedGroups:Math.min(observations.size,256),observationsTruncated:observations.size>16,controls:[...observations.values()].slice(0,16).map(item=>({keysMatch:Object.keys(item.controls).length===Object.keys(expected).length&&Object.keys(item.controls).every(key=>Object.hasOwn(expected,key)),...Object.fromEntries(Object.entries(expected).map(([key,value])=>[key,item.controls[key]===value]))}))};
}
/** Original boundary assertions, with a fixed ID written before each check. */
export function assertMediaSandboxBoundary(boundary:{stdout:string;error:unknown;observations:Map<string,Observation>},hostNamespaces:Record<string,string>,limits:MediaSandboxLimits,diagnostic:Record<string,unknown>){
 Object.assign(diagnostic,mediaSandboxBoundaryObservation(boundary.observations,limits,boundary.error));
 diagnostic.check='execution';assert.equal(boundary.error,null);
 diagnostic.check='output_json';const lines=boundary.stdout.trim().split('\n').map(value=>JSON.parse(value));
 diagnostic.outputLines=Math.min(lines.length,256);diagnostic.check='output_lines';assert.equal(lines.length,2);
 const network=lines[0],facts=lines[1];diagnostic.network=booleanFields(network,boundaryNetwork);diagnostic.facts=booleanFields(facts,boundaryFacts);
 diagnostic.namespaces=Object.fromEntries(namespaceNames.map(name=>{const value=facts?.namespaces?.[name];return[name,{valid:typeof value==='string'&&new RegExp('^'+name+':\\[\\d+\\]$').test(value),different:typeof value==='string'?value!==hostNamespaces[name]:null}];}));
 for(const key of boundaryNetwork){diagnostic.check='network_'+key;assert.equal(network[key],true);}
 for(const key of boundaryFacts){diagnostic.check='fact_'+key;assert.equal(facts[key],true,key);}
 for(const name of namespaceNames){diagnostic.check='namespace_format_'+name;assert.match(facts.namespaces[name],new RegExp('^'+name+':\\[\\d+\\]$'));diagnostic.check='namespace_isolated_'+name;assert.notEqual(facts.namespaces[name],hostNamespaces[name],name);}
 diagnostic.check='cgroup_presence';assert.ok(boundary.observations.size>0,'A real decoder must be observed inside its assigned cgroup.');
 diagnostic.check='cgroup_controls';checkControls(boundary.observations,limits);
 return {network,facts};
}
async function runObserved(config:Config,sandbox:QualifiedLinuxMediaSandbox,args:string[],options:{timeoutMs?:number;signal?:AbortSignal;diagnostic?:(check:'input_open'|'process_start'|'cgroup_observation'|'process_drain',observations:Map<string,Observation>,error?:unknown)=>void}={}){
 const mark=(check:'input_open'|'process_start'|'cgroup_observation'|'process_drain',observations:Map<string,Observation>,error?:unknown)=>options.diagnostic?.(check,observations,error);
 mark('input_open',new Map());
 const file=await open(fixture(config,'synthetic.png'),constants.O_RDONLY),observations=new Map<string,Observation>();let finished=false;
 try{mark('process_start',observations);const promise=sandbox.run({tool:'ffprobe',args,inputFd:file.fd,timeoutMs:options.timeoutMs??9000,signal:options.signal,maxOutputBytes:65536,maxStderrBytes:65536}).then(stdout=>({stdout,error:null}),error=>({stdout:'',error})).finally(()=>{finished=true;});
  while(!finished){mark('cgroup_observation',observations);await observe(config,observations);await delay(10);}const outcome=await promise;mark('process_drain',observations,outcome.error);await assertDrained(config,observations);return {...outcome,observations};
 }finally{await file.close();}
}

async function configInput(){assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.ok(process.getuid&&process.getuid()>0);const path=process.env.COATRIA_MEDIA_QUALIFICATION;assert.ok(path);const info=await lstat(path);assert.equal(info.uid,0);assert.equal(info.mode&0o022,0);const config=JSON.parse(await text(path)) as Config;assert.equal(config.version,1);assert.equal(process.getuid!(),config.uid);assert.equal(process.getgid!(),config.gid);assert.ok((await text('/proc/self/cgroup')).includes(config.supervisorGroup.slice('/sys/fs/cgroup'.length)));return config;}

async function crashChild(config:Config){
 const sandbox=await createLinuxMediaSandbox({...config.profiles.conformance,cgroupRoot:config.cgroupRoot});
 const file=await open(fixture(config,'synthetic.png'),constants.O_RDONLY);process.send?.({ready:true});
 try{await sandbox.run({tool:'ffprobe',args:['timeout'],inputFd:file.fd,timeoutMs:9000,maxOutputBytes:65536,maxStderrBytes:65536});}finally{await file.close();}throw Error('The parent-death test must terminate its supervisor.');
}

export async function runMediaSandboxCanary(config:Config){
 const report:Record<string,unknown>={qualified:false,runpodQualified:false,noProviderCalls:true,kernel:release(),profiles:config.profiles,tests:[],realFormats:[]};
 const results=report.tests as unknown[];let listener:Server|undefined,startingProfile:'conformance'|'real'|null='conformance';
 const checkpoint=(name:string)=>{report.activeCheck=name;};
 try{
  checkpoint('host_input_pins');
  const inputBefore=await readFile(fixture(config,'synthetic.png'));assert.equal(digest(await readFile(config.hostCanaryPath)),config.hostCanarySha256);
  const hostNamespaces=await namespaces();report.hostNamespaces=hostNamespaces;
  checkpoint('host_source_pins');const sourceHashes:Record<string,string>={};for(const file of ['scripts/hosting/media-sandbox-launch.c','scripts/hosting/media-sandbox-probe.c','scripts/hosting/prepare-media-sandbox-ci.mjs','scripts/hosting/run-media-sandbox-ci.mjs','scripts/hosting/media-sandbox-linux-canary.mts','scripts/hosting/media-sandbox-startup-diagnostic.mts','scripts/hosting/prepare-media-apparmor-ci.mjs','scripts/hosting/collect-media-apparmor-ci.mjs','src/lib/higgsfield-media-sandbox.ts','src/lib/higgsfield-media-inspection.ts'])sourceHashes[file]=digest(await readFile(source(config,file)));report.sourceHashes=sourceHashes;
  checkpoint('parent_cgroup_controls');const parentLimits:Record<string,string>={};for(const file of ['memory.max','memory.swap.max','pids.max','cpu.max'])parentLimits[file]=await text(join(config.serviceRoot,file));assert.deepEqual(parentLimits,{'memory.max':String(2*1024**3),'memory.swap.max':'0','pids.max':'256','cpu.max':'200000 100000'});report.aggregateParentLimits=parentLimits;
  checkpoint('conformance_profile');const events:MediaSandboxExitEvidence[]=[];report.adversarialEvents=events;const sandbox=await createLinuxMediaSandbox({...config.profiles.conformance,cgroupRoot:config.cgroupRoot,onExitEvidence:event=>events.push(event)});assert.equal(events.length,2);assert.ok(events.every(event=>event.drained));startingProfile=null;
  const limits=events[0].limits;
  checkpoint('label_parser');const labelCheck=await runObserved(config,sandbox,['label-check']);assert.equal(labelCheck.error,null);assert.equal(labelCheck.stdout.trim(),'label parser ok');
  checkpoint('boundary');const boundaryDiagnostic:Record<string,unknown>={diagnosticOnly:true,qualified:false,check:'host_listener_start'};report.boundaryDiagnostic=boundaryDiagnostic;
  let connections=0;listener=createServer(socket=>{connections++;socket.end();});await new Promise<void>((resolve,reject)=>{listener!.once('error',reject);listener!.listen(0,'127.0.0.1',resolve);});const address=listener.address();boundaryDiagnostic.check='host_listener_address';assert.ok(address&&typeof address==='object');
  boundaryDiagnostic.check='host_listener_positive_control';await new Promise<void>((resolve,reject)=>{const socket=connect(address.port,'127.0.0.1');socket.once('error',reject);socket.once('end',resolve);});boundaryDiagnostic.hostListenerPositiveControl=connections===1;assert.equal(connections,1);connections=0;
  const environmentBefore={...process.env};for(const key of ['COATRIA_SANDBOX_CANARY','DATABASE_URL','COATRIA_HOSTING_KEYRING','NODE_OPTIONS'])process.env[key]='synthetic-'+randomBytes(12).toString('hex');
  let boundary:Awaited<ReturnType<typeof runObserved>>;
  try{boundary=await runObserved(config,sandbox,['boundary',config.hostCanaryPath,String(process.pid),String(address.port)],{diagnostic:(check,observations,error)=>Object.assign(boundaryDiagnostic,mediaSandboxBoundaryObservation(observations,limits,error),{check})});}finally{for(const key of ['COATRIA_SANDBOX_CANARY','DATABASE_URL','COATRIA_HOSTING_KEYRING','NODE_OPTIONS']){if(environmentBefore[key]===undefined)delete process.env[key];else process.env[key]=environmentBefore[key];}}
  const {network,facts}=assertMediaSandboxBoundary(boundary,hostNamespaces,limits,boundaryDiagnostic);
  boundaryDiagnostic.check='host_listener_isolated';boundaryDiagnostic.hostListenerIsolated=connections===0;assert.equal(connections,0);
  boundaryDiagnostic.check='input_unchanged';const inputDigest=digest(await readFile(fixture(config,'synthetic.png')));boundaryDiagnostic.inputUnchanged=inputDigest===digest(inputBefore);assert.equal(inputDigest,digest(inputBefore));boundaryDiagnostic.check='complete';
  results.push({name:'boundary',passed:true,hostFilePositiveControl:true,hostListenerPositiveControl:true,network,isolatedNamespaces:facts.namespaces,facts,liveGroups:boundary.observations.size});await closed(listener);listener=undefined;
  checkpoint('file_descriptor_cap');const files=await runObserved(config,sandbox,['files']);assert.equal(files.error,null);const fdFacts=JSON.parse(files.stdout);assert.equal(fdFacts.limited,true);assert.ok(fdFacts.openFiles<limits.openFiles);results.push({name:'file-descriptor-cap',passed:true,...fdFacts});
  for(const name of ['pids','memory'] as const){checkpoint(name+'_aggregate_cap');const start=events.length,result=await runObserved(config,sandbox,[name]);assert.equal(code(result.error),'PROCESS_FAILED');const latest=events.slice(start);assert.equal(latest.length,1);assert.ok(latest[0].drained);if(name==='pids')assert.ok(latest[0].pidsEvents.max>0);else assert.ok((latest[0].memoryEvents.oom_kill??0)+(latest[0].memoryEvents.oom_group_kill??0)>0);checkControls(result.observations,limits);results.push({name:name+'-aggregate-cap',passed:true,evidence:latest[0],observedProcesses:[...result.observations.values()].reduce((n,v)=>n+v.processes.size,0)});}
  checkpoint('cpu_execution');const cpuStart=performance.now(),cpu=await runObserved(config,sandbox,['cpu']);report.cpuObservation=archiveHostCpuSummary({elapsedMs:Math.round(performance.now()-cpuStart),cgroupUsageUsec:events.at(-1)?.cpuUsageUsec,cgroupsObserved:cpu.observations.size,executionCode:cpu.error===null?null:code(cpu.error)});assert.equal(cpu.error,null);
  checkpoint('cpu_output');const usage=JSON.parse(cpu.stdout);report.cpuObservation=archiveHostCpuSummary({...report.cpuObservation as object,cpuNs:usage.cpuNs,wallNs:usage.wallNs,children:usage.children});
  checkpoint('cpu_usage');assert.ok(usage.cpuNs>=500_000_000);checkpoint('cpu_wall');assert.ok(usage.wallNs>=1_500_000_000);checkpoint('cpu_controls');checkControls(cpu.observations,limits);checkpoint('cpu_cgroup_usage');assert.ok(events.at(-1)!.cpuUsageUsec>=500000);results.push({name:'aggregate-cpu-bandwidth',passed:true,usage,evidence:events.at(-1)});
  checkpoint('orphan_cleanup');const orphan=await runObserved(config,sandbox,['orphan']);assert.equal(orphan.error,null);assert.equal(JSON.parse(orphan.stdout).forked,3);checkControls(orphan.observations,limits);assert.ok([...orphan.observations.values()].some(item=>item.processes.size>=5));results.push({name:'normal-exit-descendant-cleanup',passed:true,evidence:events.at(-1)});
  checkpoint('deadline_cleanup');const timeout=await runObserved(config,sandbox,['timeout'],{timeoutMs:900});assert.equal(code(timeout.error),'TIMEOUT');checkControls(timeout.observations,limits);results.push({name:'deadline-kills-descendants',passed:true,evidence:events.at(-1)});
  checkpoint('abort_cleanup');const controller=new AbortController(),abortTimer=setTimeout(()=>controller.abort(),600);const aborted=await runObserved(config,sandbox,['timeout'],{signal:controller.signal});clearTimeout(abortTimer);assert.equal(code(aborted.error),'ABORTED');checkControls(aborted.observations,limits);results.push({name:'abort-kills-descendants',passed:true,evidence:events.at(-1)});

  // Kill the Node supervisor itself: no JS finally can run. PDEATHSIG plus the
  // PID namespace must leave no running decoder/setsid descendant behind.
  checkpoint('supervisor_crash_cleanup');const crashObservations=new Map<string,Observation>();const child=spawn(process.execPath,['--import','tsx',source(config,'scripts/hosting/media-sandbox-linux-canary.mts'),'--supervisor-crash-child'],{shell:false,stdio:['ignore','ignore','ignore','ipc'],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',COATRIA_MEDIA_QUALIFICATION:process.env.COATRIA_MEDIA_QUALIFICATION,COATRIA_MEDIA_CANARY_CHILD:JSON.stringify(config)}});
  let childClosed=false;child.once('exit',()=>{childClosed=true;});const childExit=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Crash child failed to qualify.')),15000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(Error('Crash child exited before qualification.'));});});
   await waitFor(async()=>{await observe(config,crashObservations);return [...crashObservations.values()].some(item=>item.processes.size>=5);});assert.ok(child.kill('SIGKILL'));await childExit;
   await waitFor(async()=>{for(const item of crashObservations.values()){if(!(await text(join(item.group,'cgroup.events'))).includes('populated 0'))return false;for(const pid of item.processes)if(await alive(pid))return false;}return true;});
   checkControls(crashObservations,limits);for(const item of crashObservations.values())await rmdir(item.group);await assertDrained(config,crashObservations);results.push({name:'supervisor-sigkill-descendant-cleanup',passed:true,noJavascriptCleanup:true,observedProcesses:[...crashObservations.values()].reduce((n,item)=>n+item.processes.size,0)});
  }finally{if(!childClosed){child.kill('SIGKILL');await childExit;}for(const item of crashObservations.values()){try{await writeFile(join(item.group,'cgroup.kill'),'1');await waitFor(async()=>(await text(join(item.group,'cgroup.events'))).includes('populated 0'));await rmdir(item.group);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}

  checkpoint('invalid_pin_writable_input');await assert.rejects(createLinuxMediaSandbox({...config.profiles.real,expectedProfileSha256:'0'.repeat(64),cgroupRoot:config.cgroupRoot}),error=>error instanceof MediaSandboxError&&error.code==='INVALID_PROFILE');
  const writable=await open(fixture(config,'synthetic.png'),constants.O_RDWR);try{await assert.rejects(sandbox.run({tool:'ffprobe',args:['files'],inputFd:writable.fd,maxOutputBytes:65536,maxStderrBytes:65536,timeoutMs:1000}),error=>error instanceof MediaSandboxError&&error.code==='PROCESS_FAILED');}finally{await writable.close();}assert.equal(digest(await readFile(fixture(config,'synthetic.png'))),digest(inputBefore));results.push({name:'invalid-pin-and-writable-input-denied',passed:true});

  checkpoint('real_profile');const realEvents:MediaSandboxExitEvidence[]=[];report.realDecoderEvents=realEvents;startingProfile='real';const real=await createLinuxMediaSandbox({...config.profiles.real,cgroupRoot:config.cgroupRoot,onExitEvidence:event=>realEvents.push(event)});startingProfile=null;
  const formats=[['png','image','image/png'],['jpeg','image','image/jpeg'],['webp','image','image/webp'],['mp4','video','video/mp4'],['mov','video','video/quicktime'],['wav','audio','audio/wav'],['mp3','audio','audio/mpeg']] as const;
  const descriptors:HiggsfieldMediaDescriptor[]=[];
  for(const [format,kind,mime]of formats){checkpoint('real_'+format);const path=fixture(config,'synthetic.'+format),bytes=await readFile(path),sha256=digest(bytes);const value=await inspectHiggsfieldArchiveMedia({path,expectedKind:kind,expectedBytes:bytes.length,expectedSha256:sha256},{sandbox:real});assert.equal(value.kind,kind);assert.equal(value.contentType,mime);assert.equal(value.format,format);assert.equal(value.bytes,bytes.length);assert.equal(value.sha256,sha256);assert.equal(value.verification,'full_decode');
   if(value.kind==='image'){assert.equal(value.width,16);assert.equal(value.height,16);}else if(value.kind==='video'){assert.equal(value.durationMs,500);assert.equal(value.frameCount,3);assert.deepEqual(value.frameRate,{numerator:6,denominator:1});assert.equal(value.vfr,false);}else{assert.equal(value.durationMs,100);assert.equal(value.channels,1);assert.equal(value.sampleRateHz,format==='wav'?8000:44100);}descriptors.push(value);
  }
  checkpoint('real_cleanup');assert.ok(realEvents.length>=16);assert.ok(realEvents.every(event=>event.drained));assert.equal((await readdir(config.cgroupRoot)).filter(name=>name.startsWith('decoder-')).length,0);report.realFormats=descriptors;report.realDecoderEvents=realEvents;report.adversarialEvents=events;report.qualified=true;
 }catch(error){report.failureCode=code(error);report.failingCheck=report.activeCheck;if(startingProfile&&config.diagnostics!==false)report.startupDiagnostic=await(config.diagnosticScope==='archive-host-qualification'?diagnoseArchiveHostSandboxStartup(config,startingProfile):diagnoseMediaSandboxStartup(config,startingProfile));throw error;}finally{if(listener)await closed(listener);await writeFile(join(config.evidence,'qualification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
 console.log('Isolated Linux decoder qualified: boundary/resource/cleanup checks and all seven actual media formats passed.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void(async()=>{
 if(process.argv.length===3&&process.argv[2]==='--supervisor-crash-child'&&process.env.COATRIA_MEDIA_CANARY_CHILD){
  // Only a child of the trusted canary uses this private, bounded configuration.
  // It has no receipt authority; the actual sandbox still verifies every pin.
  const raw=process.env.COATRIA_MEDIA_CANARY_CHILD;assert.ok(raw.length<=16384);const config=JSON.parse(raw) as Config;assert.equal(config.uid,process.getuid?.());assert.equal(config.gid,process.getgid?.());await crashChild(config);
 }else{const config=await configInput();if(process.argv.includes('--supervisor-crash-child'))await crashChild(config);else await runMediaSandboxCanary(config);}
})().catch(()=>{console.error('MEDIA_SANDBOX_CANARY_FAILED');process.exitCode=1;});}
