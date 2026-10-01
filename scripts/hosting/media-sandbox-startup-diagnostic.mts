/** Synthetic qualification diagnostics, never an executor or qualification fallback. The only
 * process run is a pinned conformance probe or real decoder's fixed FD-help
 * command, with its own known executable as input, never arbitrary media.
 * Capture is bounded and only enum/numeric facts leave this module. */
import {createHash,randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {constants} from 'node:fs';
import {access,lstat,mkdir,open,readFile,readdir,realpath,rmdir,statfs,writeFile,type FileHandle} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {Readable,Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {parseMediaSandboxProfile} from '../../src/lib/higgsfield-media-sandbox';
import {archiveHostDelegatedPath} from './archive-host-package.mjs';

type Config={profiles:{conformance:{profilePath:string;expectedProfileSha256:string};real?:{profilePath:string;expectedProfileSha256:string}};cgroupRoot:string;supervisorGroup:string;uid:number;gid:number};
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const text=async(path:string)=>(await readFile(path,'utf8')).trim();
const problem=()=>{throw Error('CI_DIAGNOSTIC_PRECONDITION_FAILED');};
const helperStages:Record<number,string>={120:'ARGUMENT_IDENTITY',121:'INPUT_FD',122:'ROOT_DIRECTORY',123:'CGROUP_FD',124:'PARENT_NO_NEW_PRIVILEGES',125:'RESOURCE_LIMITS',126:'SCHEDULER',127:'CGROUP_JOIN',128:'READY_WRITE',129:'GATE_PARENT_CHECK',130:'CLOSE_RANGE',131:'BWRAP_EXEC'};

/** Strict classification: raw stderr, paths, arbitrary tokens and raw errors are
 * never returned. Unknown diagnostics remain explicitly unknown. */
export function classifySyntheticStartupStderr(bytes:Buffer){
 const value=bytes.subarray(0,8192).toString('utf8'),classes:string[]=[];
 const patterns:[string,RegExp][]=[
  ['NAMESPACE_PERMISSION',/No permissions to creat(?:e|ing) new namespace|non-privileged user namespaces/i],
  ['NAMESPACE_CREATE',/Creating new namespace failed|unshare.*failed/i],
  ['USER_ID_MAPPING',/(?:uid|gid)[ _-]?map|user namespace mapping/i],
  ['CGROUP_NAMESPACE',/cgroup namespace|\/proc\/self\/ns\/cgroup/i],
  ['NESTED_USER_NAMESPACE',/max_user_namespaces|disable.userns|assert.userns|nested.*namespace/i],
  ['NETWORK_SETUP',/loopback|network|SIOCSIFFLAGS|RTM_NEWLINK|RTM_NEWADDR/i],
  ['PROC_SETUP',/mount.*proc|proc.*mount|Can't open \/proc/i],
  ['MOUNT_SETUP',/mount|pivot_root/i],
  ['APPARMOR',/apparmor/i],
  ['EXECUTABLE_START',/execvp|execve|error while loading shared libraries/i],
  ['ARGUMENT_REJECTED',/Unknown option|unknown argument|invalid argument/i],
 ];for(const[name,pattern]of patterns)if(pattern.test(value))classes.push(name);
 const errors:[string,RegExp][]=[['EPERM',/Operation not permitted/i],['EACCES',/Permission denied/i],['ENOENT',/No such file or directory/i],['EROFS',/Read-only file system/i],['ENOSPC',/No space left on device|\bENOSPC\b/i],['ENOMEM',/Cannot allocate memory/i],['EMFILE',/Too many open files/i],['EINVAL',/Invalid argument/i]];
 return {classes:classes.length?classes:bytes.length?['UNCLASSIFIED']:[],errno:errors.filter(([,pattern])=>pattern.test(value)).map(([name])=>name),truncated:bytes.length>8192};
}

async function trusted(path:string,directory=false){
 if(await realpath(path)!==path)problem();const info=await lstat(path);if(info.uid!==0||info.mode&0o6022||info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()||info.nlink!==1))problem();
 let parent=dirname(path);while(parent!=='/'){const value=await lstat(parent);if(value.uid!==0||value.mode&0o022||!value.isDirectory()||value.isSymbolicLink())problem();parent=dirname(parent);}
 try{await access(path,constants.W_OK);problem();}catch(error){if(!['EACCES','EROFS'].includes((error as NodeJS.ErrnoException).code??''))throw error;}return info;
}
async function immutableFile(path:string,expectedHash:string,expectedBytes?:number){const info=await trusted(path);if(info.size>512*1024**2||expectedBytes!==undefined&&info.size!==expectedBytes||hash(await readFile(path))!==expectedHash)problem();}
const numbers=(value:string)=>Object.fromEntries(value.split('\n').map(line=>line.trim().split(/\s+/)).filter(([key,value])=>['low','high','max','oom','oom_kill','oom_group_kill','usage_usec'].includes(key)&&/^\d+$/.test(value)).map(([key,value])=>[key,Number(value)]));

/** Pure identity gate for the separate installed qualifier. No worker/preflight,
 * unrelated release, arbitrary profile or ancestor cgroup is accepted. */
export function archiveStartupIdentity(config:Config,profileKind:'conformance'|'real',profile:{runtimeRoot:string;launcher:{path:string}},selfCgroup:string,invocationId:string,executable:string){
 try{const paths=archiveHostDelegatedPath(selfCgroup,'qualify'),match=/^\/var\/lib\/coatria-archive-releases\/([a-f0-9]{64})\/runtime\/media\/(conformance|real)$/.exec(profile.runtimeRoot);
  return !!match&&match[2]===profileKind&&/^[a-f0-9]{32}$/.test(invocationId)&&config.profiles[profileKind]?.profilePath==='/etc/coatria-archive/'+profileKind+'.json'&&config.cgroupRoot===paths.cgroupRoot&&config.supervisorGroup===paths.supervisorGroup&&profile.launcher.path==='/var/lib/coatria-archive-releases/'+match[1]+'/runtime/media-sandbox-launch'&&executable==='/var/lib/coatria-archive-releases/'+match[1]+'/runtime/node';
 }catch{return false;}
}
export async function diagnoseMediaSandboxStartup(config:Config,profileKind:'conformance'|'real'='conformance'){return diagnoseStartup(config,profileKind,'ci');}
export async function diagnoseArchiveHostSandboxStartup(config:Config,profileKind:'conformance'|'real'='conformance'){return diagnoseStartup(config,profileKind,'archive');}
async function diagnoseStartup(config:Config,profileKind:'conformance'|'real',scope:'ci'|'archive'){
 const phases:string[]=[],report:Record<string,unknown>={diagnosticOnly:true,qualified:false,profileKind,phases};
 let group:string|undefined,created=false,control:FileHandle|undefined,input:FileHandle|undefined,child:ChildProcess|undefined,timer:ReturnType<typeof setTimeout>|undefined,exitPromise:Promise<void>|undefined;
 const stderr:Buffer[]=[],stdout:Buffer[]=[];let stderrBytes=0,stdoutBytes=0;
 try{
  if(scope==='ci'&&process.env.CI!=='true'||process.platform!=='linux'||process.arch!=='x64'||!process.getuid||process.getuid()===0||process.getuid()!==config.uid||process.getgid!()!==config.gid)problem();
  if(!['conformance','real'].includes(profileKind))problem();const pin=config.profiles[profileKind];if(!pin||!(scope==='ci'?new RegExp('^/var/lib/coatria-media-ci-[a-f0-9-]+/'+profileKind+'\\.json$').test(pin.profilePath):pin.profilePath==='/etc/coatria-archive/'+profileKind+'.json')||!/^[a-f0-9]{64}$/.test(pin.expectedProfileSha256))problem();
  await immutableFile(pin!.profilePath,pin!.expectedProfileSha256);const profile=parseMediaSandboxProfile(JSON.parse(await text(pin!.profilePath)));
  if(scope==='ci'?profile.runtimeRoot!==dirname(pin!.profilePath)+'/'+profileKind||profile.launcher.path!==dirname(pin!.profilePath)+'/media-sandbox-launch':!archiveStartupIdentity(config,profileKind,profile,await readFile('/proc/self/cgroup','utf8'),process.env.INVOCATION_ID??'',await realpath(process.execPath)))problem();await trusted(profile.runtimeRoot,true);
  const expected=new Map(profile.files.map(file=>[file.path,file]));async function closure(path:string,relative=''){for(const name of await readdir(path)){const member=join(path,name),inside=relative+'/'+name;if((await lstat(member)).isDirectory()){await trusted(member,true);await closure(member,inside);}else{const file=expected.get(inside);if(!file)problem();await immutableFile(member,file!.sha256,file!.bytes);expected.delete(inside);}}}await closure(profile.runtimeRoot);if(expected.size)problem();
  for(const file of [profile.launcher,profile.bubblewrap])await immutableFile(file.path,file.sha256);const probe=profile.files.find(file=>file.path==='/bin/ffprobe'),other=profile.files.find(file=>file.path==='/bin/ffmpeg');if(!probe||!other||profileKind==='conformance'&&probe.sha256!==other.sha256)problem();
  if(scope==='ci'&&!/^\/sys\/fs\/cgroup\/coatria-media-ci-[a-f0-9-]+\/decoders$/.test(config.cgroupRoot)||await realpath(config.cgroupRoot)!==config.cgroupRoot||(await statfs(config.cgroupRoot)).type!==0x63677270||await text(join(config.cgroupRoot,'cgroup.procs'))!==''||!(await text('/proc/self/cgroup')).includes(config.supervisorGroup.slice('/sys/fs/cgroup'.length)))problem();
  phases.push('pins_checked');report.profileSha256=pin!.expectedProfileSha256;
  const policy:Record<string,number|string|null>={};for(const[key,path]of Object.entries({apparmorRestrictedUserns:'/proc/sys/kernel/apparmor_restrict_unprivileged_userns',unprivilegedUsernsClone:'/proc/sys/kernel/unprivileged_userns_clone',maxUserNamespaces:'/proc/sys/user/max_user_namespaces',apparmorEnabled:'/sys/module/apparmor/parameters/enabled'})){try{const value=await text(path);policy[key]=/^\d{1,12}$/.test(value)?Number(value):/^[YN]$/.test(value)?value:null;}catch{policy[key]=null;}}try{policy.supervisorAppArmor=(await text('/proc/self/attr/current'))==='unconfined'?'unconfined':'confined';}catch{policy.supervisorAppArmor='unavailable';}report.hostPolicy=policy;
  group=join(config.cgroupRoot,'diagnostic-'+randomUUID());await mkdir(group,{mode:0o700});created=true;const limits=profile.limits;
  for(const[key,value]of Object.entries({'memory.max':String(limits.memoryBytes),'memory.swap.max':'0','memory.oom.group':'1','pids.max':String(limits.pids),'cpu.max':`${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`})){await writeFile(join(group,key),value);if(await text(join(group,key))!==value)problem();}phases.push('cgroup_capped');
  control=await open(join(group,'cgroup.procs'),constants.O_WRONLY|constants.O_NOFOLLOW);input=await open(join(profile.runtimeRoot,'bin/ffprobe'),constants.O_RDONLY|constants.O_NOFOLLOW);
  child=spawn(profile.launcher.path,[String(limits.openFiles),profile.runtimeRoot,'ffprobe','-hide_banner','-h','protocol=fd'],{shell:false,cwd:'/',env:{LANG:'C',LC_ALL:'C',PATH:'/usr/bin'},stdio:[input.fd,'pipe','pipe',control.fd,'pipe','pipe']});phases.push('spawned');
  let failWait!:(error:Error)=>void;const stopped=new Promise<never>((_,reject)=>{failWait=reject;});void stopped.catch(()=>{});const halt=(reason:string)=>{report.stopCode??=reason;child?.kill('SIGKILL');failWait(Error('CI_DIAGNOSTIC_STOPPED'));};
  timer=setTimeout(()=>halt('DEADLINE'),Math.min(limits.wallTimeMs,10000));const extra=child.stdio as (Readable|Writable|null|undefined)[],gate=extra[4] as Writable,ready=extra[5] as Readable;
  for(const stream of [child.stdout,child.stderr,gate,ready])stream?.on('error',()=>halt('STREAM_ERROR'));
  child.stdout!.on('data',(chunk:Buffer)=>{stdoutBytes+=chunk.length;if(stdoutBytes>65536)halt('OUTPUT_LIMIT');else stdout.push(chunk);});child.stderr!.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>8192)halt('OUTPUT_LIMIT');else stderr.push(chunk);});
  const ended=new Promise<void>(resolve=>{child!.once('error',()=>{report.spawnError=true;resolve();});child!.once('exit',(code,signal)=>{report.exitCode=code;report.signal=signal&&['SIGKILL','SIGSEGV','SIGSYS','SIGABRT','SIGXFSZ','SIGTERM'].includes(signal)?signal:signal?'OTHER':null;phases.push('exited');resolve();});});
  exitPromise=ended;
  const readyWait=new Promise<void>((resolve,reject)=>{ready.once('data',(chunk:Buffer)=>chunk.equals(Buffer.from('R'))?resolve():reject(Error('CI_DIAGNOSTIC_READY_INVALID')));ready.once('end',()=>reject(Error('CI_DIAGNOSTIC_READY_CLOSED')));});
  const first=await Promise.race([readyWait.then(()=>true),ended.then(()=>false),stopped]);if(first){phases.push('helper_ready');if(await text(join(group,'cgroup.procs'))!==String(child.pid))problem();phases.push('membership_verified');gate.end('G');phases.push('gate_released');await Promise.race([ended,stopped]);}
 }catch{report.failureCode??='DIAGNOSTIC_STARTUP_FAILED';}
 finally{
  if(timer)clearTimeout(timer);child?.kill('SIGKILL');
  try{if(created&&group){await writeFile(join(group,'cgroup.kill'),'1');const deadline=performance.now()+5000;while(!/^populated 0$/m.test(await text(join(group,'cgroup.events')))){if(performance.now()>deadline)throw Error('Drain deadline.');await delay(10);}
   if(child)await Promise.race([Promise.all([exitPromise,...[child.stdout,child.stderr].map(stream=>!stream||stream.readableEnded||stream.destroyed?Promise.resolve():new Promise<void>(resolve=>{stream.once('end',resolve);stream.once('close',resolve);}))]),delay(1000).then(()=>{throw Error('Pipe deadline.');})]);
   report.resourceEvents={memory:numbers(await text(join(group,'memory.events'))),pids:numbers(await text(join(group,'pids.events'))),cpu:numbers(await text(join(group,'cpu.stat')))};await control?.close();control=undefined;await rmdir(group);report.drained=true;phases.push('drained');
  }}catch{report.cleanupFailed=true;}finally{await control?.close().catch(()=>{});await input?.close().catch(()=>{});for(const stream of child?.stdio.slice(1)??[])if(stream&&'destroy'in stream)stream.destroy();}
  report.stdoutBytes=stdoutBytes;report.stderrBytes=stderrBytes;report.fdHelpObserved=Buffer.concat(stdout).includes(Buffer.from('fd AVOptions:'));report.stderrClassification={...classifySyntheticStartupStderr(Buffer.concat(stderr)),truncated:stderrBytes>8192};
  // Meaningful only for this fixed original probe. Arbitrary media-program exit
  // statuses could collide, so production never applies this diagnostic mapping.
  report.helperExitStage=profileKind==='conformance'&&typeof report.exitCode==='number'?helperStages[report.exitCode]??null:null;
 }
 return report;
}
