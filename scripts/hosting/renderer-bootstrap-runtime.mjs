// Operator-reviewed installation code. No executable, package or URL comes from a job.
import {createHash} from 'node:crypto';
import {open,readFile,lstat,stat,mkdir,writeFile,rename,unlink,chown,chmod,realpath} from 'node:fs/promises';
import {dirname} from 'node:path';
import {spawn} from 'node:child_process';

export const BLENDER_RELEASE=Object.freeze({version:'5.2.2',url:'https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz',sha256:'84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168',bytes:383295504,directory:'/opt/coatria/blender-5.2.2'});
export const RENDERER_RUNTIME_PACKAGES=Object.freeze(['ca-certificates','xz-utils','libx11-6','libxxf86vm1','libxfixes3','libxi6','libxrender1','libxrandr2','libxcursor1','libxinerama1','libegl1','libgl1','libsm6','libice6','libxkbcommon0','libdbus-1-3','libwayland-client0','libwayland-cursor0','libwayland-egl1','libglib2.0-0','libgomp1']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeEnvironment=()=>({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8',DEBIAN_FRONTEND:'noninteractive'});
async function bounded(operation,signal){let abort;try{return await Promise.race([operation,new Promise((_resolve,reject)=>{abort=()=>reject(Error('BOOTSTRAP_DEADLINE'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}}

/** Streams and validates exact bytes before exposing a file to an installer. */
export async function downloadVerifiedFile({url,path,bytes,sha256,signal,fetch:transport=fetch}){
 if(!/^https:\/\//.test(url)||!Number.isSafeInteger(bytes)||bytes<1||bytes>400000000||!/^[a-f0-9]{64}$/.test(sha256))throw Error('DOWNLOAD_CONFIGURATION_INVALID');
 const temporary=path+'.download';let file,reader;
 try{
  file=await open(temporary,'wx',0o600);
  const response=await bounded(transport(url,{redirect:'error',signal}),signal);
  if(!response.ok)throw Error('DOWNLOAD_UNAVAILABLE');reader=response.body?.getReader();if(!reader)throw Error('DOWNLOAD_UNAVAILABLE');
  let count=0;const digest=createHash('sha256');
  for(;;){const next=await bounded(reader.read(),signal);if(next.done)break;count+=next.value.byteLength;if(count>bytes)throw Error('DOWNLOAD_SIZE');digest.update(next.value);await file.writeFile(next.value);}
  if(count!==bytes||digest.digest('hex')!==sha256)throw Error('DOWNLOAD_INTEGRITY');
  await file.sync();await file.close();file=undefined;
  // Destination may not be an operator's pre-existing file or symlink.
  try{await lstat(path);throw Error('DOWNLOAD_DESTINATION_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(temporary,path);
 }finally{if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
/** @param {Record<string,string|undefined>} settings */
export function rendererChildEnvironment(settings=process.env){
 const companyId=settings.COATRIA_RENDER_COMPANY_ID,connectorId=settings.COATRIA_RENDER_CONNECTOR_ID;
 if(!UUID.test(companyId||'')||!UUID.test(connectorId||'')||!/^ce_[A-Za-z0-9_-]{20,200}$/.test(settings.COATRIA_EXECUTION_TOKEN||''))throw Error('RENDERER_SCOPE_INVALID');
 return {PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/node',LANG:'C.UTF-8',COATRIA_BASE_URL:'https://coatria.com',COATRIA_RENDER_COMPANY_ID:companyId.toLowerCase(),COATRIA_RENDER_CONNECTOR_ID:connectorId.toLowerCase(),COATRIA_RENDER_EXPIRES_AT:settings.COATRIA_RENDER_EXPIRES_AT,COATRIA_EXECUTION_TOKEN:settings.COATRIA_EXECUTION_TOKEN};
}
async function command(executable,args,{cwd,signal,timeoutMs=120000}){
 const active=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]),child=spawn(executable,args,{cwd,env:safeEnvironment(),shell:false,detached:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-131072);});child.stderr.resume();
 const stop=()=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}};
 active.addEventListener('abort',stop,{once:true});if(active.aborted)stop();
 try{const code=await bounded(new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}),active);if(code!==0)throw Error('BOOTSTRAP_COMMAND_FAILED');return output;}
 finally{active.removeEventListener('abort',stop);if(active.aborted)stop();}
}
async function rootDirectory(directory){
 await mkdir(directory,{recursive:true,mode:0o755});
 const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)!==0||await realpath(directory)!==directory)throw Error('ROOT_DIRECTORY_UNSAFE');
}
async function rootFile(file,maxBytes){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)!==0||info.size>maxBytes)throw Error('ROOT_FILE_UNSAFE');return readFile(file);}

/** Root parent independently bounds an uncooperative child's shutdown. It never
 * clears private worker locks: forced/uncertain termination needs reconciliation.
 * @param {import('node:child_process').ChildProcess} child
 * @param {AbortSignal} signal
 * @returns {Promise<{code:number,signal:string|null,forced:boolean,terminationConfirmed:boolean}>}
 */
export async function superviseRendererChild(child,signal,{termMs=8000,killMs=2000}={}){
 if(!Number.isSafeInteger(termMs)||termMs<1||termMs>10000||!Number.isSafeInteger(killMs)||killMs<1||killMs>5000)throw Error('CHILD_SHUTDOWN_CONFIGURATION');
 let termTimer,killTimer,forced=false,settled=false;
 return new Promise(resolve=>{
  const finish=(code,exitSignal,confirmed)=>{if(settled)return;settled=true;clearTimeout(termTimer);clearTimeout(killTimer);signal.removeEventListener('abort',stop);child.removeListener('error',onError);child.removeListener('exit',onExit);resolve({code:forced?1:code??1,signal:exitSignal,forced,terminationConfirmed:confirmed});};
  const onExit=(code,exitSignal)=>finish(code,exitSignal,true),onError=()=>finish(1,null,false);
  const stop=()=>{
   if(settled||termTimer)return;
   try{child.kill('SIGTERM');}catch{/* Escalation still runs. */}
   if(settled)return;
   termTimer=setTimeout(()=>{forced=true;try{child.kill('SIGKILL');}catch{/* Parent must still exit on time. */}if(!settled)killTimer=setTimeout(()=>finish(1,'SIGKILL',false),killMs);},termMs);
  };
  child.once('error',onError);child.once('exit',onExit);signal.addEventListener('abort',stop,{once:true});
  if(child.exitCode!==null||child.signalCode!==null)finish(child.exitCode,child.signalCode,true);else if(signal.aborted)stop();
 });
}

/** Called only after all source hashes have been checked by the pinned bootstrap. */
export async function prepareRendererRuntime({release,commit}){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||!/^[a-f0-9]{40}$/.test(commit)||release!=='/opt/coatria/renderer-releases/'+commit)throw Error('LINUX_RUNTIME_REQUIRED');
 const env=rendererChildEnvironment(),expires=Date.parse(env.COATRIA_RENDER_EXPIRES_AT||'');
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(env.COATRIA_RENDER_EXPIRES_AT||'')||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+86400000)throw Error('INVALID_EXPIRY');
 if(!(await readFile('/proc/cpuinfo','utf8')).split(/\s+/).includes('sse4_2'))throw Error('CPU_FEATURE_UNAVAILABLE');
 const mount=await lstat('/state');if(!mount.isDirectory()||mount.isSymbolicLink()||mount.dev===(await stat('/')).dev)throw Error('PERSISTENT_MOUNT_REQUIRED');
 const control=new AbortController(),onStop=()=>control.abort();process.once('SIGTERM',onStop);process.once('SIGINT',onStop);
 const timer=setTimeout(()=>control.abort(),Math.max(0,expires-Date.now())),deadline=AbortSignal.any([control.signal,AbortSignal.timeout(600000)]);
 await rootDirectory('/opt/coatria');const lockFile='/opt/coatria/renderer-install.lock',lock=await open(lockFile,'wx',0o600);
 let child;
 try{
  await command('/usr/bin/apt-get',['update','-qq'],{signal:deadline});
  await command('/usr/bin/apt-get',['install','-y','--no-install-recommends',...RENDERER_RUNTIME_PACKAGES],{signal:deadline});
  const target=BLENDER_RELEASE.directory,marker=target+'/.coatria-archive.json';
  let existing=false;
  try{
   const saved=JSON.parse(String(await rootFile(marker,32768)));
   if(saved.archiveSha256!==BLENDER_RELEASE.sha256||saved.binarySha256!==sha(await rootFile(target+'/blender',400000000)))throw Error('BLENDER_INTEGRITY');existing=true;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(!existing){
   // An incomplete or unknown extraction is never silently replaced.
   try{await lstat(target);throw Error('BLENDER_RECONCILIATION_REQUIRED');}catch(error){if(error.code!=='ENOENT')throw error;}
   const archive='/opt/coatria/blender-5.2.2-linux-x64.tar.xz';
   await downloadVerifiedFile({url:BLENDER_RELEASE.url,path:archive,bytes:BLENDER_RELEASE.bytes,sha256:BLENDER_RELEASE.sha256,signal:deadline});
   await mkdir(target,{mode:0o755});
   await command('/usr/bin/tar',['-xJf',archive,'--strip-components=1','-C',target],{signal:deadline});
   await writeFile(marker,JSON.stringify({archiveSha256:BLENDER_RELEASE.sha256,binarySha256:sha(await rootFile(target+'/blender',400000000))}),{flag:'wx',mode:0o444});
   await unlink(archive);
  }
  const linked=await command('/usr/bin/ldd',[target+'/blender'],{signal:deadline,timeoutMs:30000});if(linked.includes('not found'))throw Error('BLENDER_LIBRARY_UNAVAILABLE');
  await command(target+'/blender',['--background','--factory-startup','--disable-autoexec','--offline-mode','--python-exit-code','1','--python-expr','import bpy; assert bpy.app.version == (5, 2, 2); assert bpy.app.build_options.cycles'],{signal:deadline,timeoutMs:60000});
  // Lock integrity covers all transitive packages. Keep optional esbuild binary
  // packages: tsx resolves them directly even though install scripts are disabled.
  await command('/usr/local/bin/npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:release,signal:deadline});
  await command('/usr/local/bin/node',['--import','tsx','--input-type=module','-e',"await import('./scripts/hosting/run-renderer-host.mts')"],{cwd:release,signal:deadline,timeoutMs:30000});
  await writeFile(release+'/renderer-runtime-packages.txt',await command('/usr/bin/dpkg-query',['-W',...RENDERER_RUNTIME_PACKAGES],{signal:deadline,timeoutMs:30000}),{mode:0o444});
  const directory='/state/renderers/'+env.COATRIA_RENDER_COMPANY_ID+'/'+env.COATRIA_RENDER_CONNECTOR_ID;
  for(const folder of ['/state/renderers',dirname(directory),directory]){
   await mkdir(folder,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(folder)!==folder)throw Error('PRIVATE_STATE_REQUIRED');await chown(folder,1000,1000);await chmod(folder,0o700);
  }
  deadline.throwIfAborted();await lock.close();await unlink(lockFile);
  // No renderer/provider/Blob credential is passed to apt, npm or Blender.
  process.setgroups([]);
  child=spawn('/usr/local/bin/node',['--import','tsx',release+'/scripts/hosting/run-renderer-host.mts'],{cwd:release,env,uid:1000,gid:1000,stdio:['ignore','inherit','inherit']});
  console.log(JSON.stringify({event:'verified_renderer_bootstrap',commit,blenderVersion:BLENDER_RELEASE.version,uid:1000,persistentState:true}));
  const result=await superviseRendererChild(child,control.signal);if(result.forced)console.error('COATRIA_RENDERER_FORCED_STOP');return result;
 }finally{clearTimeout(timer);process.removeListener('SIGTERM',onStop);process.removeListener('SIGINT',onStop);if(!child){await lock.close().catch(()=>{});await unlink(lockFile).catch(()=>{});}}
}
