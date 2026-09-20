/** Offline producer: exact cached Node/npm image, fresh integrity-checked npm
 * staging, and the existing pinned media preparation. No target-host claims. */
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ARCHIVE_HOST_PINS,archiveHostFailure,archiveHostHash,archiveHostRead,archiveHostFileHash,parseArchiveRuntime,verifyArchiveTree} from './archive-host-package.mjs';

export async function exportArchiveHostRuntime({sourceRoot,qualificationPath,npmCache,output}){
 if(process.platform!=='linux'||process.arch!=='x64')archiveHostFailure();const repo=await realpath(sourceRoot),target=resolve(output),config=JSON.parse(await archiveHostRead(qualificationPath));
 const setup=JSON.parse(await archiveHostRead(join(config.evidence,'setup.json')));if(setup.runtimeImage!==ARCHIVE_HOST_PINS.nodeImage||setup.ffmpeg.sha256!==ARCHIVE_HOST_PINS.ffmpegArchiveSha256||setup.bubblewrapPackage!==ARCHIVE_HOST_PINS.bubblewrapPackage||setup.apparmor.profileSha256!==ARCHIVE_HOST_PINS.apparmorProfileSha256)archiveHostFailure();
 const roots=[repo,await realpath(dirname(qualificationPath)),await realpath(npmCache)];for(const kind of ['real','conformance'])roots.push(await realpath(JSON.parse(await archiveHostRead(config.profiles[kind].profilePath)).runtimeRoot));
 for(const root of roots){const rel=relative(root,target);if(rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'))archiveHostFailure();}if(await realpath(dirname(target))!==dirname(target))archiveHostFailure();
 const lock=await archiveHostRead(join(repo,'package-lock.json')),tools=await mkdtemp(join(dirname(target),'archive-build-inputs-')),dependencyRoot=join(tools,'dependencies');await mkdir(dependencyRoot,{mode:0o700});
 const buildEnv={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:tools,NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:'/dev/null'};
 const command=(binary,args,timeout=120000)=>{const r=spawnSync(binary,args,{shell:false,env:buildEnv,encoding:'utf8',timeout,maxBuffer:1024*1024});if(r.status!==0||r.error)archiveHostFailure();return r.stdout.trim();};
 // Never accepts an arbitrary executable labeled as the approved Node version.
 // The exact cached image supplies both Node and npm; the container is not run.
 const container='coatria-archive-export-'+randomUUID();let created=false;const nodePath=join(tools,'node');
 try{command('/usr/bin/docker',['create','--pull','never','--network','none','--name',container,ARCHIVE_HOST_PINS.nodeImage]);created=true;command('/usr/bin/docker',['cp',container+':/usr/local/bin/node',nodePath]);command('/usr/bin/docker',['cp',container+':/usr/local/lib/node_modules/npm',join(tools,'npm')]);}finally{if(created)command('/usr/bin/docker',['rm',container]);}
 await chmod(nodePath,0o555);if(command(nodePath,['--version'])!==ARCHIVE_HOST_PINS.nodeVersion)archiveHostFailure();
 await writeFile(join(dependencyRoot,'package.json'),await archiveHostRead(join(repo,'package.json')),{flag:'wx',mode:0o600});await writeFile(join(dependencyRoot,'package-lock.json'),lock,{flag:'wx',mode:0o600});
 // Fresh staging and integrity-checked cached tarballs, never a developer's
 // mutable node_modules. Missing cache is terminal; there is no network fallback.
 command(nodePath,[join(tools,'npm/bin/npm-cli.js'),'ci','--offline','--ignore-scripts','--no-audit','--no-fund','--include=dev','--cache',await realpath(npmCache),'--prefix',dependencyRoot],300000);
 await mkdir(target,{mode:0o755});const files=[];
 async function copy(source,path,mode){const before=await archiveHostFileHash(source),dest=join(target,path);await mkdir(dirname(dest),{recursive:true,mode:0o755});await copyFile(source,dest,constants.COPYFILE_EXCL);const actual=await archiveHostFileHash(dest);if(actual.sha256!==before.sha256||actual.bytes!==before.bytes)archiveHostFailure();await chmod(dest,mode);files.push({path,...actual,mode});}
 await copy(nodePath,'node',0o555);
 for(const kind of ['real','conformance']){
  const pin=config.profiles[kind],raw=await archiveHostRead(pin.profilePath);if(archiveHostHash(raw)!==pin.expectedProfileSha256)archiveHostFailure();const profile=JSON.parse(raw);
  if(profile.version!==1||profile.platform!=='linux-x64'||profile.bubblewrap.sha256!==setup.bubblewrapSha256)archiveHostFailure();
  for(const member of profile.files){if(!/^\/(?:bin\/ff(?:mpeg|probe)|lib(?:64|\/x86_64-linux-gnu)\/[A-Za-z0-9_.+-]+)$/.test(member.path))archiveHostFailure();const source=join(profile.runtimeRoot,member.path),facts=await archiveHostFileHash(source);if(facts.sha256!==member.sha256||facts.bytes!==member.bytes)archiveHostFailure();await copy(source,'media/'+kind+member.path,member.path.startsWith('/bin/')||member.path==='/lib64/ld-linux-x86-64.so.2'?0o555:0o444);}
  if(kind==='real'){if((await archiveHostFileHash(profile.launcher.path)).sha256!==profile.launcher.sha256)archiveHostFailure();await copy(profile.launcher.path,'media-sandbox-launch',0o555);}
 }
 async function modules(directory,relative='node_modules'){
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==resolve(directory))archiveHostFailure();
  for(const name of (await readdir(directory)).sort()){if(name==='.bin')continue;const from=join(directory,name),path=relative+'/'+name,stat=await lstat(from);if(stat.isSymbolicLink())archiveHostFailure();if(stat.isDirectory())await modules(from,path);else if(stat.isFile()&&stat.nlink===1)await copy(from,path,stat.mode&0o111?0o555:0o444);else archiveHostFailure();}
 }await modules(join(dependencyRoot,'node_modules'));files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const sourceHashes={launcher:setup.sourceHashes['scripts/hosting/media-sandbox-launch.c'],probe:setup.sourceHashes['scripts/hosting/media-sandbox-probe.c']};
 for(const [name,file]of [['launcher','media-sandbox-launch.c'],['probe','media-sandbox-probe.c']])if(archiveHostHash(await archiveHostRead(join(repo,'scripts/hosting',file)))!==sourceHashes[name])archiveHostFailure();
 const runtime=parseArchiveRuntime({version:1,platform:'linux-x64',pins:ARCHIVE_HOST_PINS,sourceHashes,packageLockSha256:archiveHostHash(lock),bubblewrapSha256:setup.bubblewrapSha256,files});const bytes=JSON.stringify(runtime)+'\n';await writeFile(join(target,'runtime-manifest.json'),bytes,{flag:'wx',mode:0o444});await verifyArchiveTree(target,runtime.files,{extra:['runtime-manifest.json']});return {runtimeManifestSha256:archiveHostHash(bytes),files:files.length,qualified:false,output:target};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void(async()=>{try{const [sourceRoot,qualificationPath,npmCache,output,...extra]=process.argv.slice(2);if(extra.length||!output)archiveHostFailure();console.log(JSON.stringify(await exportArchiveHostRuntime({sourceRoot,qualificationPath,npmCache,output})));}catch{console.error('ARCHIVE_HOST_RUNTIME_EXPORT_FAILED');process.exitCode=1;}})();}
