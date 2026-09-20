/** Offline package format. Integrity is not host qualification. No network or secrets. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {access,chmod,copyFile,lstat,mkdir,open,readdir,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';

export const ARCHIVE_HOST_PINS=Object.freeze({nodeVersion:'v24.19.0',nodeImage:'node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174',ffmpegArchiveSha256:'7d6d93e9c39e0e461feb13c118e91e4eec2515e4da3a01d4ad6790996731bbee',bubblewrapPackage:'0.9.0-1ubuntu0.3',apparmorProfileSha256:'11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9'});
export const ARCHIVE_HOST_LIMITS=Object.freeze({memoryBytes:2147483648,swapBytes:0,pids:256,cpuQuotaMicros:200000,cpuPeriodMicros:100000});
export const ARCHIVE_HOST_SERVICE_USER='coatria-archive';
export const ARCHIVE_HOST_RELEASES='/var/lib/coatria-archive-releases';
export const ARCHIVE_HOST_CONFIG='/etc/coatria-archive';
export const ARCHIVE_HOST_STATE='/var/lib/coatria-archive-state';
export const archiveHostHash=value=>createHash('sha256').update(value).digest('hex');
export const archiveRuntimeTarget=path=>path.startsWith('node_modules/')?'app/'+path:'runtime/'+path;
export const archiveHostReceiptCurrent=(receipt,bundleSha256,bootId)=>!!receipt&&receipt.version===1&&receipt.bundleSha256===bundleSha256&&receipt.bootId===bootId;
export function archiveHostDelegatedPath(value,mode){
 if(!['qualify','preflight','worker'].includes(mode))archiveHostFailure();const match=/^0::(\/[^\n]+)\n?$/.exec(value);if(!match||!match[1].endsWith('/coatria-archive-'+mode+'.service/supervisor')||match[1].includes('..')||match[1].includes('\\')||match[1].includes('//'))archiveHostFailure();const supervisorGroup='/sys/fs/cgroup'+match[1],serviceRoot=supervisorGroup.slice(0,-'/supervisor'.length);return {serviceRoot,supervisorGroup,cgroupRoot:serviceRoot+'/decoders'};
}
export function archiveHostFailure(){throw Error('ARCHIVE_HOST_PACKAGE_REJECTED');}
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const archiveHostRelative=v=>typeof v==='string'&&v.length<=240&&/^[A-Za-z0-9_@.+/~\-]+$/.test(v)&&!v.startsWith('/')&&!v.split('/').some(p=>!p||p==='.'||p==='..');
function entries(value){
 if(!Array.isArray(value)||value.length<1||value.length>60000)archiveHostFailure();const seen=new Set();let total=0;
 return value.map(v=>{if(!exact(v,['path','bytes','sha256','mode'])||!archiveHostRelative(v.path)||seen.has(v.path)||!Number.isSafeInteger(v.bytes)||v.bytes<0||v.bytes>512*1024**2||!sha(v.sha256)||![0o444,0o555].includes(v.mode))archiveHostFailure();seen.add(v.path);total+=v.bytes;if(total>3*1024**3)archiveHostFailure();return {...v};});
}
const requiredRuntime=['node','media-sandbox-launch','media/real/bin/ffmpeg','media/real/bin/ffprobe','media/conformance/bin/ffmpeg','media/conformance/bin/ffprobe','node_modules/tsx/package.json','node_modules/pg/package.json'];
export function parseArchiveRuntime(value){
 if(!exact(value,['version','platform','pins','sourceHashes','packageLockSha256','bubblewrapSha256','files'])||value.version!==1||value.platform!=='linux-x64'||JSON.stringify(value.pins)!==JSON.stringify(ARCHIVE_HOST_PINS)||!exact(value.sourceHashes,['launcher','probe'])||!sha(value.sourceHashes.launcher)||!sha(value.sourceHashes.probe)||!sha(value.packageLockSha256)||!sha(value.bubblewrapSha256))archiveHostFailure();
 const files=entries(value.files),paths=new Map(files.map(f=>[f.path,f]));
 for(const file of requiredRuntime)if(!paths.has(file))archiveHostFailure();
 for(const file of files){if(!['node','media-sandbox-launch'].includes(file.path)&&!file.path.startsWith('node_modules/')&&!file.path.startsWith('media/real/')&&!file.path.startsWith('media/conformance/'))archiveHostFailure();if(file.path.split('/').includes('.bin'))archiveHostFailure();if((file.path==='node'||file.path==='media-sandbox-launch'||/^media\/(?:real|conformance)\/(?:bin\/ff(?:mpeg|probe)|lib64\/ld-linux-x86-64.so.2)$/.test(file.path))&&file.mode!==0o555)archiveHostFailure();}
 for(const kind of ['real','conformance']){
  const members=files.filter(f=>f.path.startsWith('media/'+kind+'/'));if(members.length<2||members.length>64)archiveHostFailure();
  for(const f of members)if(!/^media\/(?:real|conformance)\/(?:bin\/ff(?:mpeg|probe)|lib(?:64|\/x86_64-linux-gnu)\/[A-Za-z0-9_.+-]+)$/.test(f.path)||!f.path.includes('/bin/')&&!f.path.endsWith('/lib64/ld-linux-x86-64.so.2')&&f.mode!==0o444)archiveHostFailure();
 }
 if(paths.get('media/conformance/bin/ffmpeg').sha256!==paths.get('media/conformance/bin/ffprobe').sha256)archiveHostFailure();
 return {...value,files};
}
export function parseArchiveBundle(value){
 if(!exact(value,['version','kind','commit','tree','runtimeManifestSha256','runtime','files'])||value.version!==1||value.kind!=='coatria-archive-host'||!(/^[a-f0-9]{40}$/).test(value.commit)||!(/^[a-f0-9]{40}$/).test(value.tree)||!sha(value.runtimeManifestSha256))archiveHostFailure();
 const runtime=parseArchiveRuntime(value.runtime),files=entries(value.files);if(archiveHostHash(JSON.stringify(runtime)+'\n')!==value.runtimeManifestSha256)archiveHostFailure();
 const map=new Map(files.map(f=>[f.path,f]));for(const f of runtime.files){const item=map.get(archiveRuntimeTarget(f.path));if(!item||item.sha256!==f.sha256||item.bytes!==f.bytes||item.mode!==f.mode)archiveHostFailure();}
 for(const f of files)if(!f.path.startsWith('app/')&&!f.path.startsWith('runtime/'))archiveHostFailure();
 if(files.filter(f=>f.path.startsWith('runtime/')||f.path.startsWith('app/node_modules/')).length!==runtime.files.length)archiveHostFailure();
 if(map.get('app/package-lock.json')?.sha256!==runtime.packageLockSha256)archiveHostFailure();
 if(map.get('app/scripts/hosting/media-sandbox-launch.c')?.sha256!==runtime.sourceHashes.launcher||map.get('app/scripts/hosting/media-sandbox-probe.c')?.sha256!==runtime.sourceHashes.probe)archiveHostFailure();
 for(const path of ['app/scripts/hosting/run-archive-host.mts','app/scripts/hosting/install-archive-host.mjs','app/scripts/higgsfield-archive-worker.ts','app/scripts/hosting/media-sandbox-linux-canary.mts'])if(!map.has(path))archiveHostFailure();
 return {...value,runtime,files};
}
export async function archiveHostRead(path,maxBytes=16*1024**2){
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maxBytes||await realpath(path)!==resolve(path))archiveHostFailure();
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const now=await file.stat();if(now.ino!==info.ino||now.dev!==info.dev)archiveHostFailure();const bytes=await file.readFile();const after=await file.stat();if(bytes.length!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs)archiveHostFailure();return bytes;}finally{await file.close();}
}
export async function archiveHostFileHash(path){
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>512*1024**2||await realpath(path)!==resolve(path))archiveHostFailure();
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)),hash=createHash('sha256');try{const now=await file.stat();if(now.ino!==before.ino||now.dev!==before.dev)archiveHostFailure();const buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(position<before.size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)archiveHostFailure();hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}const after=await file.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)archiveHostFailure();return {bytes:position,sha256:hash.digest('hex')};}finally{await file.close();}
}
export function archiveHostNoExtendedAcls(paths,recursive=false){
 if(process.platform!=='linux')archiveHostFailure();const result=spawnSync('/usr/bin/getfacl',[...recursive?['-R','-P']:[],'-c','-p','-s','--',...paths],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:30000,maxBuffer:1024*1024});if(result.status!==0||result.error||result.stdout.trim())archiveHostFailure();
}
export async function archiveHostTrusted(path,directory=false,{checkAcl=true}={}){
 if(await realpath(path)!==resolve(path))archiveHostFailure();let p=resolve(path),first=true;
 const paths=[];for(;;){paths.push(p);const info=await lstat(p);if(info.uid!==0||info.mode&0o6022||info.isSymbolicLink()||(first&&!directory?!info.isFile()||info.nlink!==1:!info.isDirectory()))archiveHostFailure();if(process.getuid?.()!==0){try{await access(p,constants.W_OK);archiveHostFailure();}catch(error){if(!['EACCES','EROFS'].includes(error.code??''))throw error;}}first=false;const parent=dirname(p);if(parent===p)break;p=parent;}if(checkAcl)archiveHostNoExtendedAcls(paths);
}
export async function verifyArchiveTree(root,files,{trusted=false,extra=/** @type {string[]} */([])}={}){
 if(await realpath(root)!==resolve(root)||(await lstat(root)).isSymbolicLink())archiveHostFailure();const expected=new Map(files.map(f=>[f.path,f])),allowedExtra=new Set(extra);let count=0;
 async function walk(path,relative=''){
  const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())archiveHostFailure();if(trusted)await archiveHostTrusted(path,true,{checkAcl:false});
  for(const name of await readdir(path)){const rel=relative?relative+'/'+name:name,p=join(path,name),stat=await lstat(p);if(stat.isDirectory()){await walk(p,rel);continue;}if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)archiveHostFailure();if(allowedExtra.delete(rel))continue;const entry=expected.get(rel);if(!entry)archiveHostFailure();if(trusted){await archiveHostTrusted(p,false,{checkAcl:false});if((stat.mode&0o777)!==entry.mode)archiveHostFailure();}const facts=await archiveHostFileHash(p);if(facts.bytes!==entry.bytes||facts.sha256!==entry.sha256)archiveHostFailure();expected.delete(rel);if(++count>60000)archiveHostFailure();}
 }if(trusted){await archiveHostTrusted(root,true);archiveHostNoExtendedAcls([root],true);}await walk(root);if(expected.size||allowedExtra.size)archiveHostFailure();if(trusted)archiveHostNoExtendedAcls([root],true);
}
export async function copyArchiveFiles(from,to,files){
 for(const f of files){if(!archiveHostRelative(f.path))archiveHostFailure();const target=join(to,f.path);await mkdir(dirname(target),{recursive:true,mode:0o755});await copyFile(join(from,f.path),target,constants.COPYFILE_EXCL);const check=await archiveHostFileHash(target);if(check.bytes!==f.bytes||check.sha256!==f.sha256)archiveHostFailure();await chmod(target,f.mode);}
}
export function archiveHostProfiles(bundle,release){
 return Object.fromEntries(['real','conformance'].map(kind=>{const files=bundle.runtime.files.filter(f=>f.path.startsWith('media/'+kind+'/')).map(f=>({path:f.path.slice(('media/'+kind).length),bytes:f.bytes,sha256:f.sha256}));return [kind,{version:1,platform:'linux-x64',runtimeRoot:release+'/runtime/media/'+kind,files,launcher:{path:release+'/runtime/media-sandbox-launch',sha256:bundle.runtime.files.find(f=>f.path==='media-sandbox-launch').sha256},bubblewrap:{path:'/usr/bin/bwrap',sha256:bundle.runtime.bubblewrapSha256},limits:kind==='real'?{memoryBytes:512*1024**2,cpuQuotaMicros:100000,cpuPeriodMicros:100000,pids:64,openFiles:64,wallTimeMs:60000}:{memoryBytes:64*1024**2,cpuQuotaMicros:20000,cpuPeriodMicros:100000,pids:16,openFiles:64,wallTimeMs:10000}}];}));
}
