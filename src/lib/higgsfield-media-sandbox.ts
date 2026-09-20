/** Linux-only decoder boundary. No network, provider state or runtime downloads.
 * The privileged host installer supplies an immutable, hash-pinned executable
 * closure and delegates an empty cgroup-v2 subtree. Namespace support is tested,
 * never inferred from the presence of a container or an environment flag. */
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,mkdir,open,readFile,readdir,realpath,rmdir,statfs,writeFile,type FileHandle} from 'node:fs/promises';
import {dirname,join,posix} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Readable,Writable} from 'node:stream';

export type MediaSandboxCode='SANDBOX_UNAVAILABLE'|'INVALID_PROFILE'|'INPUT_INVALID'|'ABORTED'|'TIMEOUT'|'OUTPUT_LIMIT'|'PROCESS_FAILED'|'CLEANUP_FAILED';
export class MediaSandboxError extends Error {
 constructor(readonly code:MediaSandboxCode){super('The isolated media process could not complete its verified execution.');this.name='MediaSandboxError';}
}
function fail(code:MediaSandboxCode):never{throw new MediaSandboxError(code);}
export type MediaSandboxLimits=Readonly<{memoryBytes:number;cpuQuotaMicros:number;cpuPeriodMicros:number;pids:number;openFiles:number;wallTimeMs:number}>;
type PinnedFile={path:string;sha256:string};
export type MediaSandboxProfile={version:1;platform:'linux-x64';runtimeRoot:string;files:(PinnedFile&{bytes:number})[];launcher:PinnedFile;bubblewrap:PinnedFile;limits:MediaSandboxLimits};
export type MediaSandboxRun={tool:'ffprobe'|'ffmpeg';args:readonly string[];inputFd:number;signal?:AbortSignal;maxOutputBytes:number;maxStderrBytes:number;timeoutMs:number};
export type MediaSandboxExitEvidence=Readonly<{memoryEvents:Readonly<Record<string,number>>;pidsEvents:Readonly<Record<string,number>>;cpuUsageUsec:number;limits:MediaSandboxLimits;drained:true}>;
export type QualifiedLinuxMediaSandbox=Readonly<{run:(input:MediaSandboxRun)=>Promise<string>}>;
export type LinuxMediaSandboxOptions={profilePath:string;expectedProfileSha256:string;cgroupRoot:string;onExitEvidence?:(evidence:MediaSandboxExitEvidence)=>void};
const qualified=new WeakSet<object>();
export function isQualifiedLinuxMediaSandbox(value:unknown):value is QualifiedLinuxMediaSandbox{return !!value&&typeof value==='object'&&qualified.has(value);}
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const ownKeys=(value:object,keys:string[])=>Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('/')&&!value.includes('\0')&&!value.includes('\\')&&posix.normalize(value)===value&&value!=='/';
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const bounded=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;

/** Pure strict parsing is exported for offline installer validation; it does not
 * qualify anything. No regex, command, callback or alternate binary is accepted. */
export function parseMediaSandboxProfile(value:unknown):MediaSandboxProfile {
 if(!object(value)||!ownKeys(value,['version','platform','runtimeRoot','files','launcher','bubblewrap','limits'])||value.version!==1||value.platform!=='linux-x64'||!absolute(value.runtimeRoot)||!Array.isArray(value.files)||value.files.length<2||value.files.length>64)fail('INVALID_PROFILE');
 const paths=new Set<string>();const files=value.files.map((entry:unknown)=>{
  if(!object(entry)||!ownKeys(entry,['path','bytes','sha256'])||!absolute(entry.path)||!sha(entry.sha256)||!bounded(entry.bytes,1,512*1024**2)||paths.has(entry.path))fail('INVALID_PROFILE');
  paths.add(entry.path);return Object.freeze({path:entry.path,bytes:entry.bytes,sha256:entry.sha256});
 });
 if(!paths.has('/bin/ffprobe')||!paths.has('/bin/ffmpeg'))fail('INVALID_PROFILE');
 const pin=(entry:unknown)=>{if(!object(entry)||!ownKeys(entry,['path','sha256'])||!absolute(entry.path)||!sha(entry.sha256))fail('INVALID_PROFILE');return Object.freeze({path:entry.path,sha256:entry.sha256});};
 const launcher=pin(value.launcher),bubblewrap=pin(value.bubblewrap);if(bubblewrap.path!=='/usr/bin/bwrap')fail('INVALID_PROFILE');
 const l=value.limits;if(!object(l)||!ownKeys(l,['memoryBytes','cpuQuotaMicros','cpuPeriodMicros','pids','openFiles','wallTimeMs'])||!bounded(l.memoryBytes,64*1024**2,2*1024**3)||l.memoryBytes%4096||!bounded(l.cpuPeriodMicros,10000,1000000)||!bounded(l.cpuQuotaMicros,1000,l.cpuPeriodMicros)||!bounded(l.pids,8,128)||!bounded(l.openFiles,16,128)||!bounded(l.wallTimeMs,100,300000))fail('INVALID_PROFILE');
 return Object.freeze({version:1,platform:'linux-x64',runtimeRoot:value.runtimeRoot,files:Object.freeze(files) as unknown as MediaSandboxProfile['files'],launcher,bubblewrap,limits:Object.freeze({...l}) as MediaSandboxLimits});
}

async function unwriteable(path:string){try{await access(path,constants.W_OK);}catch(error){if((error as NodeJS.ErrnoException).code==='EACCES'||(error as NodeJS.ErrnoException).code==='EROFS')return;throw error;}fail('INVALID_PROFILE');}
async function trusted(path:string,kind:'file'|'directory'){
 if(!absolute(path)||await realpath(path)!==path)fail('INVALID_PROFILE');
 const info=await lstat(path);if(info.uid!==0||(info.mode&0o6022)!==0||info.isSymbolicLink()||(kind==='file'?!info.isFile()||info.nlink!==1:!info.isDirectory()))fail('INVALID_PROFILE');
 await unwriteable(path);let parent=dirname(path);
 while(parent!=='/') {const p=await lstat(parent);if(!p.isDirectory()||p.isSymbolicLink()||p.uid!==0||(p.mode&0o022))fail('INVALID_PROFILE');await unwriteable(parent);parent=dirname(parent);}
 return info;
}
async function digestFile(path:string,bytes?:number){const info=await trusted(path,'file');if(info.size>512*1024**2||bytes!==undefined&&info.size!==bytes)fail('INVALID_PROFILE');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const now=await file.stat();if(now.ino!==info.ino||now.dev!==info.dev)fail('INVALID_PROFILE');const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(position<info.size){const r=await file.read(buffer,0,Math.min(buffer.length,info.size-position),position);if(!r.bytesRead)fail('INVALID_PROFILE');digest.update(buffer.subarray(0,r.bytesRead));position+=r.bytesRead;}return digest.digest('hex');}finally{await file.close();}}
async function validateClosure(profile:MediaSandboxProfile){
 await trusted(profile.runtimeRoot,'directory');const expected=new Map(profile.files.map(f=>[f.path,f]));
 async function walk(directory:string,relative:string){for(const name of await readdir(directory)){const path=join(directory,name),inside=relative+'/'+name,info=await lstat(path);if(info.isDirectory()){await trusted(path,'directory');await walk(path,inside);}else{const entry=expected.get(inside);if(!entry||await digestFile(path,entry.bytes)!==entry.sha256)fail('INVALID_PROFILE');expected.delete(inside);}}}
 await walk(profile.runtimeRoot,'');if(expected.size)fail('INVALID_PROFILE');
 for(const pin of [profile.launcher,profile.bubblewrap]){if(await digestFile(pin.path)!==pin.sha256)fail('INVALID_PROFILE');await access(pin.path,constants.X_OK);}
 for(const tool of ['ffprobe','ffmpeg'])await access(join(profile.runtimeRoot,'bin',tool),constants.X_OK);
 // A declared ELF interpreter is itself executed by the kernel. Checking only
 // decoder X_OK misses a sealed-but-unexecutable loader; static profiles have
 // no interpreter and retain the existing minimal closure contract.
 if(profile.files.some(file=>file.path==='/lib64/ld-linux-x86-64.so.2'))await access(join(profile.runtimeRoot,'lib64','ld-linux-x86-64.so.2'),constants.X_OK);
}
const CGROUP2=0x63677270;
const text=async(path:string)=>(await readFile(path,'utf8')).trim();
async function groupRoot(path:string){
 if(!absolute(path)||!path.startsWith('/sys/fs/cgroup/')||await realpath(path)!==path||(await statfs(path)).type!==CGROUP2)fail('SANDBOX_UNAVAILABLE');
 let ancestor=path;while(ancestor!=='/sys/fs/cgroup'){const info=await lstat(ancestor);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o022)||![0,process.getuid!()].includes(info.uid))fail('SANDBOX_UNAVAILABLE');ancestor=dirname(ancestor);}
 if(await text(join(path,'cgroup.type'))!=='domain'||await text(join(path,'cgroup.procs'))!=='')fail('SANDBOX_UNAVAILABLE');
 const controllers=(await text(join(path,'cgroup.subtree_control'))).split(/\s+/);if(!['cpu','memory','pids'].every(x=>controllers.includes(x)))fail('SANDBOX_UNAVAILABLE');
}
const numericEvents=(value:string,allowed:string[])=>{const result:Record<string,number>={};for(const line of value.split('\n')){const[key,num]=line.split(/\s+/);if(allowed.includes(key)&&/^\d+$/.test(num)&&Number.isSafeInteger(Number(num)))result[key]=Number(num);}return Object.freeze(result);};
/** Bounded output capture, also independently testable without launching a
 * decoder. Pipe failures only pass a fixed code; raw OS errors never escape. */
export function captureMediaSandboxOutput(stdout:Readable,stderr:Readable,bounds:{maxOutputBytes:number;maxStderrBytes:number},halt:(code:MediaSandboxCode)=>void){
 const {maxOutputBytes,maxStderrBytes}=bounds;
 if(!bounded(maxOutputBytes,1,64*1024**2)||!bounded(maxStderrBytes,1,65536))fail('INPUT_INVALID');
 const chunks:Buffer[]=[];let bytes=0,warnings=0;
 stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxOutputBytes)halt('OUTPUT_LIMIT');else chunks.push(chunk);});
 stderr.on('data',(chunk:Buffer)=>{warnings+=chunk.length;if(warnings>maxStderrBytes)halt('OUTPUT_LIMIT');});
 stdout.on('error',()=>halt('PROCESS_FAILED'));stderr.on('error',()=>halt('PROCESS_FAILED'));
 return {value:()=>Buffer.concat(chunks).toString('utf8'),hasWarnings:()=>warnings>0};
}
async function verifyControls(path:string,limits:MediaSandboxLimits,write:boolean){
 const values={'memory.max':String(limits.memoryBytes),'memory.swap.max':'0','memory.oom.group':'1','pids.max':String(limits.pids),'cpu.max':`${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`};
 for(const[name,value]of Object.entries(values)){if(write)await writeFile(join(path,name),value);if(await text(join(path,name))!==value)fail('SANDBOX_UNAVAILABLE');}
 await access(join(path,'cgroup.kill'),constants.W_OK);
}

/** Qualification and all executions use the same launcher, cgroup and closure.
 * CPU quota is aggregate bandwidth, bounded additionally by wall time. Period
 * bursts and cleanup overhead mean this is not an exact CPU-seconds allowance.
 * FD hard limit is per task, with aggregate tasks bounded by pids.max. */
export async function createLinuxMediaSandbox(options:LinuxMediaSandboxOptions):Promise<QualifiedLinuxMediaSandbox>{
 if(process.platform!=='linux'||process.arch!=='x64'||!process.getuid||process.getuid()===0)fail('SANDBOX_UNAVAILABLE');
 const {profilePath,expectedProfileSha256,cgroupRoot,onExitEvidence}=options;
 let profile:MediaSandboxProfile;
 try{
  if(!absolute(profilePath)||!sha(expectedProfileSha256))fail('INVALID_PROFILE');await trusted(profilePath,'file');
  const raw=await readFile(profilePath);if(raw.length>65536||hash(raw)!==expectedProfileSha256)fail('INVALID_PROFILE');profile=parseMediaSandboxProfile(JSON.parse(raw.toString('utf8')));
  await validateClosure(profile);await groupRoot(cgroupRoot);
 }catch(error){throw error instanceof MediaSandboxError?error:new MediaSandboxError('INVALID_PROFILE');}
 let poisoned=false,busy=false;
 const run=async(value:MediaSandboxRun):Promise<string>=>{
  if(poisoned||busy)fail('SANDBOX_UNAVAILABLE');
  const input={...value,args:Array.isArray(value.args)?[...value.args]:[]};
  if(!['ffprobe','ffmpeg'].includes(input.tool)||!Array.isArray(value.args)||input.args.length>256||input.args.some(a=>typeof a!=='string'||a.includes('\0')||a.length>8192)||input.args.reduce((n,a)=>n+a.length,0)>32768||!bounded(input.inputFd,0,2**31-1)||!bounded(input.maxOutputBytes,1,64*1024**2)||!bounded(input.maxStderrBytes,1,64*1024)||!bounded(input.timeoutMs,1,300000))fail('INPUT_INVALID');
  if(input.signal?.aborted)fail('ABORTED');busy=true;
  const path=join(cgroupRoot,'decoder-'+randomUUID());let created=false,control:FileHandle|undefined,child:ReturnType<typeof spawn>|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  let reason:MediaSandboxCode|undefined;let result='',captured:ReturnType<typeof captureMediaSandboxOutput>|undefined;
  try{
   await groupRoot(cgroupRoot);await mkdir(path,{mode:0o700});created=true;await verifyControls(path,profile.limits,true);
   control=await open(join(path,'cgroup.procs'),constants.O_WRONLY|constants.O_NOFOLLOW);
   let stop!:(reason:MediaSandboxError)=>void;const stopped=new Promise<never>((_,reject)=>{stop=reject;});void stopped.catch(()=>{});
   const halt=(code:MediaSandboxCode)=>{reason??=code;stop(new MediaSandboxError(reason));child?.kill('SIGKILL');};
   abort=()=>halt('ABORTED');input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)halt('ABORTED');
   timer=setTimeout(()=>halt('TIMEOUT'),Math.min(input.timeoutMs,profile.limits.wallTimeMs));
   if(reason)fail(reason);
   child=spawn(profile.launcher.path,[String(profile.limits.openFiles),profile.runtimeRoot,input.tool,...input.args],{shell:false,cwd:'/',env:{NODE_ENV:'production',LANG:'C',LC_ALL:'C',PATH:'/usr/bin'},stdio:[input.inputFd,'pipe','pipe',control.fd,'pipe','pipe']});
   const extra=child.stdio as (Readable|Writable|null|undefined)[],gate=extra[4] as Writable,ready=extra[5] as Readable;gate.on('error',()=>halt('PROCESS_FAILED'));ready.on('error',()=>halt('PROCESS_FAILED'));
   const ended=new Promise<number|null>(resolve=>{child!.once('error',()=>{halt('SANDBOX_UNAVAILABLE');resolve(null);});child!.once('exit',(code)=>resolve(code));});
   captured=captureMediaSandboxOutput(child.stdout!,child.stderr!,input,halt);
   const isReady=new Promise<void>((resolve,reject)=>{ready.once('data',(chunk:Buffer)=>chunk.equals(Buffer.from('R'))?resolve():reject(new MediaSandboxError('PROCESS_FAILED')));ready.once('end',()=>reject(new MediaSandboxError('PROCESS_FAILED')));});
   await Promise.race([isReady,ended.then(()=>fail('PROCESS_FAILED')),stopped]);
   if(await text(join(path,'cgroup.procs'))!==String(child.pid))fail('SANDBOX_UNAVAILABLE');await verifyControls(path,profile.limits,false);
   if(reason)fail(reason);gate.end('G');
   const code=await Promise.race([ended,stopped]);if(reason)fail(reason);if(code!==0)fail('PROCESS_FAILED');
   // exit can precede delivery of the last stdout bytes. Drain pipes after the
   // cgroup is killed below; success is not reported until all descendants die.
   result=captured.value();
  }catch(error){reason=error instanceof MediaSandboxError?error.code:'SANDBOX_UNAVAILABLE';}
  finally{
   if(timer)clearTimeout(timer);if(abort)input.signal?.removeEventListener('abort',abort);
   try{
    if(created){
     // Kill even on normal leader exit: a decoder may orphan children or keep
     // inherited output pipes open. No cgroup is deleted while still populated.
     await writeFile(join(path,'cgroup.kill'),'1');child?.kill('SIGKILL');
     const deadline=performance.now()+5000;while(!/^populated 0$/m.test(await text(join(path,'cgroup.events')))){if(performance.now()>=deadline)fail('CLEANUP_FAILED');await delay(10);}
     if(child){await Promise.race([new Promise<void>(resolve=>{if(child!.exitCode!==null||child!.signalCode!==null){setImmediate(resolve);return;}child!.once('close',()=>resolve());}),delay(1000).then(()=>fail('CLEANUP_FAILED'))]);
      // Wait for end/close on both finite pipes before certifying captured bytes.
      await Promise.race([Promise.all([child.stdout,child.stderr].map(stream=>!stream||stream.readableEnded||stream.destroyed?Promise.resolve():new Promise<void>(resolve=>{stream.once('end',resolve);stream.once('close',resolve);}))),delay(1000).then(()=>fail('CLEANUP_FAILED'))]);
      if(captured)result=captured.value();if(captured?.hasWarnings())reason??='PROCESS_FAILED';
     }
     const mem=numericEvents(await text(join(path,'memory.events')),['low','high','max','oom','oom_kill','oom_group_kill']),pids=numericEvents(await text(join(path,'pids.events')),['max']),cpu=numericEvents(await text(join(path,'cpu.stat')),['usage_usec']);
     if(mem.oom||mem.oom_kill||mem.oom_group_kill||pids.max)reason??='PROCESS_FAILED';
     await control?.close();control=undefined;await rmdir(path);
     try{onExitEvidence?.(Object.freeze({memoryEvents:mem,pidsEvents:pids,cpuUsageUsec:cpu.usage_usec??0,limits:profile.limits,drained:true}));}catch{/* Numeric telemetry cannot grant execution or bypass cleanup. */}
    }
   }catch{poisoned=true;reason='CLEANUP_FAILED';child?.kill('SIGKILL');}
   finally{await control?.close().catch(()=>{});child?.stdout?.destroy();child?.stderr?.destroy();for(const stream of child?.stdio.slice(4)??[])if(stream&&'destroy'in stream)stream.destroy();busy=false;}
  }
  if(input.signal?.aborted)reason??='ABORTED';if(reason)fail(reason);return result;
 };
 const sandbox=Object.freeze({run});
 try{
  const input=await open(join(profile.runtimeRoot,'bin/ffprobe'),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{for(const tool of ['ffprobe','ffmpeg'] as const){const output=await run({tool,args:['-hide_banner','-h','protocol=fd'],inputFd:input.fd,maxOutputBytes:65536,maxStderrBytes:65536,timeoutMs:10000});if(!output.includes('fd AVOptions:'))fail('SANDBOX_UNAVAILABLE');}}finally{await input.close();}
 }catch(error){throw error instanceof MediaSandboxError?error:new MediaSandboxError('SANDBOX_UNAVAILABLE');}
 qualified.add(sandbox);return sandbox;
}
