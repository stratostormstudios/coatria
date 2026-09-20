/** Offline producer: exact cached Node/npm image, fresh integrity-checked npm
 * staging, and the existing pinned media preparation. No target-host claims. */
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ARCHIVE_HOST_PINS,archiveHostFailure,archiveHostHash,archiveHostRead,archiveHostFileHash,parseArchiveRuntime,verifyArchiveTree} from './archive-host-package.mjs';

const stages=new Set(['platform','preparation_read','setup_pins','input_paths','build_staging','node_extract','node_version','npm_configuration','npm_install','runtime_copy','media_copy','dependency_copy','source_pins','manifest']);
const operations=new Set(['create_cached_container','copy_node','copy_npm','remove_cached_container','read_node_version','npm_ci_offline']);
const safeErrors=new Set(['ENOENT','EACCES','EPERM','EEXIST','ENOSPC','ETIMEDOUT','ENOBUFS','ENOMEM','EAGAIN','EMFILE','ENFILE','EINVAL']);
export class ArchiveRuntimeExportError extends Error{
 constructor(stage,error,operation,status){super('ARCHIVE_HOST_RUNTIME_EXPORT_FAILED');this.name='ArchiveRuntimeExportError';this.diagnostic=Object.freeze({stage:stages.has(stage)?stage:'unknown_stage',code:operation?'COMMAND_FAILED':'CHECK_FAILED',operation:operation?operations.has(operation)?operation:'unknown_operation':null,status:Number.isInteger(status)&&status>=0&&status<=255?status:null,errorCode:error?.code?safeErrors.has(error.code)?error.code:'UNKNOWN':null});}
}
export async function createArchiveNpmEnvironment(directory){
 // npm refuses to load the same source as both global and user configuration.
 // Separate empty files also avoid the actual builder account's private config.
 const user=join(directory,'npm-user.config'),global=join(directory,'npm-global.config');await writeFile(user,'',{flag:'wx',mode:0o600});await writeFile(global,'',{flag:'wx',mode:0o600});
 return {PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:directory,NPM_CONFIG_USERCONFIG:user,NPM_CONFIG_GLOBALCONFIG:global};
}
export async function exportArchiveHostRuntime({sourceRoot,qualificationPath,npmCache,output}){
 let stage='platform';try{
 if(process.platform!=='linux'||process.arch!=='x64')archiveHostFailure();stage='preparation_read';const repo=await realpath(sourceRoot),target=resolve(output),config=JSON.parse(await archiveHostRead(qualificationPath));
 stage='setup_pins';
 const setup=JSON.parse(await archiveHostRead(join(config.evidence,'setup.json')));if(setup.runtimeImage!==ARCHIVE_HOST_PINS.nodeImage||setup.ffmpeg.sha256!==ARCHIVE_HOST_PINS.ffmpegArchiveSha256||setup.bubblewrapPackage!==ARCHIVE_HOST_PINS.bubblewrapPackage||setup.apparmor.profileSha256!==ARCHIVE_HOST_PINS.apparmorProfileSha256)archiveHostFailure();
 stage='input_paths';const roots=[repo,await realpath(dirname(qualificationPath)),await realpath(npmCache)];for(const kind of ['real','conformance'])roots.push(await realpath(JSON.parse(await archiveHostRead(config.profiles[kind].profilePath)).runtimeRoot));
 for(const root of roots){const rel=relative(root,target);if(rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'))archiveHostFailure();}if(await realpath(dirname(target))!==dirname(target))archiveHostFailure();
 stage='build_staging';const lock=await archiveHostRead(join(repo,'package-lock.json')),tools=await mkdtemp(join(dirname(target),'archive-build-inputs-')),dependencyRoot=join(tools,'dependencies');await mkdir(dependencyRoot,{mode:0o700});
 stage='npm_configuration';const buildEnv=await createArchiveNpmEnvironment(tools);
 const command=(operation,binary,args,timeout=120000)=>{const r=spawnSync(binary,args,{shell:false,env:buildEnv,encoding:'utf8',timeout,maxBuffer:1024*1024});if(r.status!==0||r.error)throw new ArchiveRuntimeExportError(stage,r.error,operation,r.status);return r.stdout.trim();};
 // Never accepts an arbitrary executable labeled as the approved Node version.
 // The exact cached image supplies both Node and npm; the container is not run.
 stage='node_extract';const container='coatria-archive-export-'+randomUUID();let created=false;const nodePath=join(tools,'node');
 try{command('create_cached_container','/usr/bin/docker',['create','--pull','never','--network','none','--name',container,ARCHIVE_HOST_PINS.nodeImage]);created=true;command('copy_node','/usr/bin/docker',['cp',container+':/usr/local/bin/node',nodePath]);command('copy_npm','/usr/bin/docker',['cp',container+':/usr/local/lib/node_modules/npm',join(tools,'npm')]);}finally{if(created)command('remove_cached_container','/usr/bin/docker',['rm',container]);}
 stage='node_version';await chmod(nodePath,0o555);if(command('read_node_version',nodePath,['--version'])!==ARCHIVE_HOST_PINS.nodeVersion)archiveHostFailure();
 await writeFile(join(dependencyRoot,'package.json'),await archiveHostRead(join(repo,'package.json')),{flag:'wx',mode:0o600});await writeFile(join(dependencyRoot,'package-lock.json'),lock,{flag:'wx',mode:0o600});
 // Fresh staging and integrity-checked cached tarballs, never a developer's
 // mutable node_modules. Missing cache is terminal; there is no network fallback.
 stage='npm_install';command('npm_ci_offline',nodePath,[join(tools,'npm/bin/npm-cli.js'),'ci','--offline','--ignore-scripts','--no-audit','--no-fund','--include=dev','--cache',await realpath(npmCache),'--prefix',dependencyRoot],300000);
 stage='runtime_copy';await mkdir(target,{mode:0o755});const files=[];
 async function copy(source,path,mode){const before=await archiveHostFileHash(source),dest=join(target,path);await mkdir(dirname(dest),{recursive:true,mode:0o755});await copyFile(source,dest,constants.COPYFILE_EXCL);const actual=await archiveHostFileHash(dest);if(actual.sha256!==before.sha256||actual.bytes!==before.bytes)archiveHostFailure();await chmod(dest,mode);files.push({path,...actual,mode});}
 await copy(nodePath,'node',0o555);
 stage='media_copy';for(const kind of ['real','conformance']){
  const pin=config.profiles[kind],raw=await archiveHostRead(pin.profilePath);if(archiveHostHash(raw)!==pin.expectedProfileSha256)archiveHostFailure();const profile=JSON.parse(raw);
  if(profile.version!==1||profile.platform!=='linux-x64'||profile.bubblewrap.sha256!==setup.bubblewrapSha256)archiveHostFailure();
  for(const member of profile.files){if(!/^\/(?:bin\/ff(?:mpeg|probe)|lib(?:64|\/x86_64-linux-gnu)\/[A-Za-z0-9_.+-]+)$/.test(member.path))archiveHostFailure();const source=join(profile.runtimeRoot,member.path),facts=await archiveHostFileHash(source);if(facts.sha256!==member.sha256||facts.bytes!==member.bytes)archiveHostFailure();await copy(source,'media/'+kind+member.path,member.path.startsWith('/bin/')||member.path==='/lib64/ld-linux-x86-64.so.2'?0o555:0o444);}
  if(kind==='real'){if((await archiveHostFileHash(profile.launcher.path)).sha256!==profile.launcher.sha256)archiveHostFailure();await copy(profile.launcher.path,'media-sandbox-launch',0o555);}
 }
 async function modules(directory,relative='node_modules'){
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==resolve(directory))archiveHostFailure();
  for(const name of (await readdir(directory)).sort()){if(name==='.bin')continue;const from=join(directory,name),path=relative+'/'+name,stat=await lstat(from);if(stat.isSymbolicLink())archiveHostFailure();if(stat.isDirectory())await modules(from,path);else if(stat.isFile()&&stat.nlink===1)await copy(from,path,stat.mode&0o111?0o555:0o444);else archiveHostFailure();}
 }stage='dependency_copy';await modules(join(dependencyRoot,'node_modules'));files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 stage='source_pins';const sourceHashes={launcher:setup.sourceHashes['scripts/hosting/media-sandbox-launch.c'],probe:setup.sourceHashes['scripts/hosting/media-sandbox-probe.c']};
 for(const [name,file]of [['launcher','media-sandbox-launch.c'],['probe','media-sandbox-probe.c']])if(archiveHostHash(await archiveHostRead(join(repo,'scripts/hosting',file)))!==sourceHashes[name])archiveHostFailure();
 stage='manifest';const runtime=parseArchiveRuntime({version:1,platform:'linux-x64',pins:ARCHIVE_HOST_PINS,sourceHashes,packageLockSha256:archiveHostHash(lock),bubblewrapSha256:setup.bubblewrapSha256,files});const bytes=JSON.stringify(runtime)+'\n';await writeFile(join(target,'runtime-manifest.json'),bytes,{flag:'wx',mode:0o444});await verifyArchiveTree(target,runtime.files,{extra:['runtime-manifest.json']});return {runtimeManifestSha256:archiveHostHash(bytes),files:files.length,qualified:false,output:target};
 }catch(error){throw error instanceof ArchiveRuntimeExportError?error:new ArchiveRuntimeExportError(stage,error);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void(async()=>{try{const [sourceRoot,qualificationPath,npmCache,output,...extra]=process.argv.slice(2);if(extra.length||!output)archiveHostFailure();console.log(JSON.stringify(await exportArchiveHostRuntime({sourceRoot,qualificationPath,npmCache,output})));}catch(error){console.error(JSON.stringify({code:'ARCHIVE_HOST_RUNTIME_EXPORT_FAILED',...error instanceof ArchiveRuntimeExportError?{diagnostic:error.diagnostic}:{}}));process.exitCode=1;}})();}
