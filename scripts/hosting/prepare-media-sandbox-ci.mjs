// Explicit root CI host preparation, never a worker startup download/install.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {appendFile,chmod,chown,copyFile,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareMediaInspectorCI,MEDIA_INSPECTOR_CI_BUILD} from './prepare-media-inspector-ci.mjs';
import {prepareMediaAppArmorCI} from './prepare-media-apparmor-ci.mjs';

export const MEDIA_RUNTIME_IMAGE='node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174';
// Includes USN-8779-1 and the follow-up regression correction, never an older
// vulnerable Noble build. A missing package needs an explicit reviewed pin update.
export const BUBBLEWRAP_PACKAGE='0.9.0-1ubuntu0.3';
export const MEDIA_ELF_LIBRARIES=Object.freeze(['ld-linux-x86-64.so.2','libc.so.6','libdl.so.2','libgcc_s.so.1','libm.so.6','libmvec.so.1','libpthread.so.0','librt.so.1']);
const env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive'};
const sha=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
function command(binary,args,{timeout=120000}={}){const r=spawnSync(binary,args,{shell:false,env,encoding:'utf8',timeout,maxBuffer:2*1024**2});if(r.status!==0||r.error){if(r.stderr)process.stderr.write(r.stderr.slice(-6000));throw Error('MEDIA_CI_PREPARATION_FAILED: '+binary);}return r.stdout;}

/** Inspect trusted ELF bytes without executing ldd or an unreviewed interpreter. */
export function elfNeeded(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<64||!bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(18)!==62)throw Error('Unexpected ELF architecture.');
 const safe=(offset,length)=>{if(!Number.isSafeInteger(offset)||offset<0||offset+length>bytes.length)throw Error('Invalid ELF bounds.');};
 const number=(offset)=>{safe(offset,8);const value=Number(bytes.readBigUInt64LE(offset));if(!Number.isSafeInteger(value))throw Error('Invalid ELF integer.');return value;};
 const offset=number(32),size=bytes.readUInt16LE(54),count=bytes.readUInt16LE(56),segments=[];if(size<56||count>256)throw Error('Invalid ELF program headers.');
 for(let i=0;i<count;i++){const at=offset+i*size;safe(at,56);const item={type:bytes.readUInt32LE(at),offset:number(at+8),va:number(at+16),bytes:number(at+32)};safe(item.offset,item.bytes);segments.push(item);}
 const interp=segments.find(s=>s.type===3),dynamic=segments.find(s=>s.type===2);let interpreter=null;if(interp){if(bytes[interp.offset+interp.bytes-1]!==0)throw Error('Invalid ELF interpreter.');interpreter=bytes.toString('utf8',interp.offset,interp.offset+interp.bytes-1);}
 if(!dynamic)return {interpreter,needed:[]};const entries=[];
 for(let at=dynamic.offset;at<dynamic.offset+dynamic.bytes;at+=16){safe(at,16);const tag=number(at),value=number(at+8);if(!tag)break;entries.push({tag,value});}
 const stringsVA=entries.find(e=>e.tag===5)?.value,load=segments.find(s=>s.type===1&&stringsVA>=s.va&&stringsVA<s.va+s.bytes);if(!load)throw Error('Missing ELF strings.');const strings=load.offset+stringsVA-load.va;
 const needed=entries.filter(e=>e.tag===1).map(e=>{const start=strings+e.value,end=bytes.indexOf(0,start);safe(start,1);if(end<start||end-start>100)throw Error('Invalid ELF dependency.');const name=bytes.toString('utf8',start,end);if(!/^[A-Za-z0-9_.+-]+$/.test(name))throw Error('Invalid ELF dependency name.');return name;});return {interpreter,needed};
}

async function filesAt(root,directory=root){
 const files=[];for(const name of (await readdir(directory)).sort()){const path=join(directory,name),info=await lstat(path);if(info.isSymbolicLink())throw Error('No symlinks in media closure.');if(info.isDirectory())files.push(...await filesAt(root,path));else if(info.isFile()&&info.nlink===1)files.push({path:path.slice(root.length),bytes:info.size,sha256:await sha(path)});else throw Error('Invalid media closure member.');}return files;
}
async function sealTree(root){for(const name of await readdir(root)){const path=join(root,name),info=await lstat(path);if(info.isDirectory())await sealTree(path);else await chmod(path,path.includes('/bin/')?0o555:0o444);}await chmod(root,0o555);}

async function protectedAncestors(directory,uid,gid,evidence){
 const records=[];let path=directory;
 for(let depth=0;depth<16;depth++){
  const info=await lstat(path);records.push({path,uid:info.uid,gid:info.gid,mode:(info.mode&0o7777).toString(8),directory:info.isDirectory(),symlink:info.isSymbolicLink(),canonical:await realpath(path)===path});
  if(path==='/')break;path=dirname(path);
 }
 // A mode check alone misses ACLs. Probe write access as the actual worker UID,
 // without inherited supplementary groups or ordinary environment credentials.
 const source="import{access}from'node:fs/promises';import{constants}from'node:fs';process.setgroups([]);process.setgid(Number(process.argv[1]));process.setuid(Number(process.argv[2]));const result=[];for(const path of JSON.parse(process.argv[3])){try{await access(path,constants.W_OK);result.push(true);}catch(error){if(error.code!=='EACCES'&&error.code!=='EROFS')throw Error('PATH_ACCESS_PROBE_FAILED');result.push(false);}}process.stdout.write(JSON.stringify(result));";
 const probe=spawnSync(process.execPath,['--input-type=module','-e',source,String(gid),String(uid),JSON.stringify(records.map(record=>record.path))],{shell:false,env,encoding:'utf8',timeout:10000,maxBuffer:16384});
 let writable=[];try{if(probe.status===0&&!probe.error)writable=JSON.parse(probe.stdout);}catch{/* Fixed failure below; no inherited stderr is logged. */}
 const validProbe=Array.isArray(writable)&&writable.length===records.length&&writable.every(value=>typeof value==='boolean');
 for(let i=0;i<records.length;i++)records[i].workerWritable=validProbe?writable[i]:null;
 const safe=validProbe&&records.at(-1)?.path==='/'&&records.every(record=>record.uid===0&&!(parseInt(record.mode,8)&0o022)&&record.directory&&!record.symlink&&record.canonical&&record.workerWritable===false);
 await writeFile(join(evidence,'path-ancestors.json'),JSON.stringify({prepared:false,qualified:false,safe,workerUid:uid,workerGid:gid,ancestors:records},null,2)+'\n',{mode:0o444});
 if(!safe){const invalid=records.find(record=>record.uid!==0||(parseInt(record.mode,8)&0o022)||!record.directory||record.symlink||!record.canonical||record.workerWritable!==false);throw Error('MEDIA_CI_UNSAFE_PACKAGE_PARENT: '+(invalid?.path??directory)+'; see path-ancestors.json for uid/mode/write-access evidence.');}
 return records;
}

export async function prepareMediaSandboxCI(){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.env.CI!=='true')throw Error('Explicit root Linux x64 CI host preparation required.');
 const uid=Number(process.env.COATRIA_TEST_UID),gid=Number(process.env.COATRIA_TEST_GID);if(!Number.isInteger(uid)||uid<1||!Number.isInteger(gid)||gid<1)throw Error('An unprivileged qualification identity is required.');
 const repo=process.cwd(),packageParent='/var/lib',base=join(packageParent,'coatria-media-ci-'+randomUUID()),evidence=resolve('.devdata/media-sandbox-linux/evidence');await mkdir(evidence,{recursive:true});
 // GitHub runners may deliberately make /opt writable to the runner. Do not
 // relax runtime trust or chmod a shared host directory to accommodate that.
 await protectedAncestors(packageParent,uid,gid,evidence);await mkdir(base,{mode:0o755});const packageAncestors=await protectedAncestors(base,uid,gid,evidence);
 command('/usr/bin/apt-get',['update','-qq']);command('/usr/bin/apt-get',['install','-y','--no-install-recommends','bubblewrap='+BUBBLEWRAP_PACKAGE,'gcc','libc6-dev']);
 const apparmor=await prepareMediaAppArmorCI({base,evidence});
 const bwrap='/usr/bin/bwrap',installed=command('/usr/bin/dpkg-query',['-W','-f=${Version}','bubblewrap']).trim();if(installed!==BUBBLEWRAP_PACKAGE)throw Error('Bubblewrap package pin mismatch.');
 const help=command(bwrap,['--help']);for(const option of ['--unshare-user','--unshare-pid','--unshare-net','--unshare-cgroup','--disable-userns','--assert-userns-disabled','--die-with-parent'])if(!help.includes(option))throw Error('Required bubblewrap feature absent.');
 const native=await prepareMediaInspectorCI(),launcher=join(base,'media-sandbox-launch'),probe=join(base,'media-sandbox-probe');
 for(const[name,target]of[['media-sandbox-launch.c',launcher],['media-sandbox-probe.c',probe]]){
  command('/usr/bin/gcc',['-O2','-Wall','-Wextra','-Werror','-static','-fno-ident','-fstack-protector-strong','-ffile-prefix-map='+repo+'=/coatria','-Wl,--build-id=none',join(repo,'scripts/hosting',name),'-o',target]);
  const elf=elfNeeded(await readFile(target));if(elf.interpreter||elf.needed.length)throw Error('Qualification helper must be a self-contained static ELF.');await chmod(target,0o555);
 }
 const roots={real:join(base,'real'),conformance:join(base,'conformance')};for(const root of Object.values(roots))for(const name of ['bin','lib/x86_64-linux-gnu','lib64','proc','dev'])await mkdir(join(root,name),{recursive:true,mode:0o755});
 const container='coatria-media-closure-'+randomUUID();let created=false;
 try{
  command('/usr/bin/docker',['create','--name',container,'--network','none',MEDIA_RUNTIME_IMAGE],{timeout:180000});created=true;
  for(const name of MEDIA_ELF_LIBRARIES)command('/usr/bin/docker',['cp','-L',container+':/lib/x86_64-linux-gnu/'+name,join(roots.real,'lib/x86_64-linux-gnu',name)]);
 }finally{if(created)command('/usr/bin/docker',['rm',container]);}
 await copyFile(join(roots.real,'lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'),join(roots.real,'lib64/ld-linux-x86-64.so.2'));
 for(const[tool,path]of[['ffmpeg',native.ffmpegPath],['ffprobe',native.ffprobePath]]){const elf=elfNeeded(await readFile(path));if(elf.interpreter!=='/lib64/ld-linux-x86-64.so.2'||JSON.stringify([...elf.needed].sort())!==JSON.stringify(MEDIA_ELF_LIBRARIES))throw Error('FFmpeg dependency closure changed.');await copyFile(path,join(roots.real,'bin',tool));}
 for(const item of await filesAt(roots.real)){
  const from=join(roots.real,item.path),to=join(roots.conformance,item.path);await copyFile(item.path.startsWith('/bin/')?probe:from,to);
  if(!item.path.startsWith('/bin/')){const elf=elfNeeded(await readFile(from));if(elf.needed.some(name=>!MEDIA_ELF_LIBRARIES.includes(name)))throw Error('Unreviewed transitive ELF dependency.');}
 }
 const profiles={};for(const[kind,runtimeRoot]of Object.entries(roots)){
  await sealTree(runtimeRoot);const limits=kind==='real'?{memoryBytes:512*1024**2,cpuQuotaMicros:100000,cpuPeriodMicros:100000,pids:64,openFiles:64,wallTimeMs:60000}:{memoryBytes:64*1024**2,cpuQuotaMicros:20000,cpuPeriodMicros:100000,pids:16,openFiles:64,wallTimeMs:10000};
  const profile={version:1,platform:'linux-x64',runtimeRoot,files:await filesAt(runtimeRoot),launcher:{path:launcher,sha256:await sha(launcher)},bubblewrap:{path:bwrap,sha256:await sha(bwrap)},limits},path=join(base,kind+'.json');await writeFile(path,JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o444});profiles[kind]={profilePath:path,expectedProfileSha256:await sha(path)};
 }
 // Delegate only one empty subtree; fixed aggregate parent caps remain root-owned.
 const controllers=(await readFile('/sys/fs/cgroup/cgroup.controllers','utf8')).trim().split(/\s+/);if(['cpu','memory','pids'].some(name=>!controllers.includes(name)))throw Error('Required cgroup v2 controllers are absent.');
 const enabled=(await readFile('/sys/fs/cgroup/cgroup.subtree_control','utf8')).trim().split(/\s+/),missing=['cpu','memory','pids'].filter(name=>!enabled.includes(name));if(missing.length)await writeFile('/sys/fs/cgroup/cgroup.subtree_control',missing.map(name=>'+'+name).join(' '));
 const serviceRoot='/sys/fs/cgroup/coatria-media-ci-'+randomUUID();await mkdir(serviceRoot);for(const[name,value]of Object.entries({'memory.max':String(2*1024**3),'memory.swap.max':'0','pids.max':'256','cpu.max':'200000 100000','cgroup.subtree_control':'+cpu +memory +pids'}))await writeFile(join(serviceRoot,name),value);
 const supervisorGroup=join(serviceRoot,'supervisor'),cgroupRoot=join(serviceRoot,'decoders');await mkdir(supervisorGroup);await mkdir(cgroupRoot);await writeFile(join(cgroupRoot,'cgroup.subtree_control'),'+cpu +memory +pids');
 // Migration needs write authority on the common ancestor's cgroup.procs. The
 // CI launcher enters supervisor before dropping uid; only this service subtree
 // is delegated. Never chown /sys/fs/cgroup/cgroup.procs or its directory.
 for(const path of [serviceRoot,supervisorGroup,cgroupRoot]){await chown(path,uid,gid);await chmod(path,0o700);for(const name of ['cgroup.procs','cgroup.threads','cgroup.subtree_control'])await chown(join(path,name),uid,gid);}
 const hostCanaryPath=join(base,'host-private-key-canary'),canary=randomBytes(32).toString('hex');await writeFile(hostCanaryPath,canary,{flag:'wx',mode:0o600});await chown(hostCanaryPath,uid,gid);
 const qualification={version:1,profiles,serviceRoot,supervisorGroup,cgroupRoot,uid,gid,hostCanaryPath,hostCanarySha256:createHash('sha256').update(canary).digest('hex'),evidence};const qualificationPath=join(base,'qualification.json');await writeFile(qualificationPath,JSON.stringify(qualification,null,2)+'\n',{flag:'wx',mode:0o444});
 await chown(evidence,uid,gid);const sourceHashes={};for(const file of ['scripts/hosting/media-sandbox-launch.c','scripts/hosting/media-sandbox-probe.c','scripts/hosting/prepare-media-sandbox-ci.mjs','scripts/hosting/run-media-sandbox-ci.mjs','scripts/hosting/media-sandbox-linux-canary.mts','scripts/hosting/media-sandbox-startup-diagnostic.mts','scripts/hosting/prepare-media-apparmor-ci.mjs','scripts/hosting/collect-media-apparmor-ci.mjs','src/lib/higgsfield-media-sandbox.ts','src/lib/higgsfield-media-inspection.ts'])sourceHashes[file]=await sha(join(repo,file));
 await writeFile(join(evidence,'setup.json'),JSON.stringify({prepared:true,qualified:false,packageAncestors,apparmor,sourceHashes,ffmpeg:MEDIA_INSPECTOR_CI_BUILD,runtimeImage:MEDIA_RUNTIME_IMAGE,bubblewrapPackage:installed,bubblewrapSha256:await sha(bwrap),hostPackages:command('/usr/bin/dpkg-query',['-W','gcc','libc6','libc6-dev','libgcc-s1','libcap2','bubblewrap','apparmor']),profiles,aggregateParentLimits:{memoryBytes:2*1024**3,pids:256,cpu:'200000 100000',swapBytes:0},noHostSecurityDisabled:true,noProviderCalls:true},null,2)+'\n',{mode:0o444});
 if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,'COATRIA_MEDIA_QUALIFICATION='+qualificationPath+'\n');console.log('Pinned media closure and delegated cgroup prepared; adversarial qualification is still required.');return qualificationPath;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await prepareMediaSandboxCI();
