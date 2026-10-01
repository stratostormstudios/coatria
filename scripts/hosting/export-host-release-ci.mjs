/** CI transfer packaging only. Existing immutable releases remain unqualified on
 * every destination. Never reads installed configuration, state or credentials. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,open,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ARCHIVE_HOST_PINS,archiveHostHash,archiveHostRead,archiveHostTrusted,archiveHostRelative,parseArchiveBundle,verifyArchiveTree,copyArchiveFiles} from './archive-host-package.mjs';
import {parseReferenceHostBundle} from './reference-host-package.mjs';
import {parseImagePreparationHostBundle} from './image-preparation-host-package.mjs';

export const CI_HOST_RELEASE_COMPONENTS=Object.freeze(['archive-host','reference-host','image-preparation-host','reference-registrar','image-preparation-registrar','image-preparation-control']);
export const CI_HOST_OPERATOR_SOURCES=Object.freeze(['install-archive-host.mjs','install-reference-host.mjs','install-image-preparation-host.mjs','archive-host-package.mjs','reference-host-package.mjs','image-preparation-host-package.mjs','prepare-media-apparmor-ci.mjs'].map(p=>'scripts/hosting/'+p));
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),gitId=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const fail=()=>{throw Error('HOST_RELEASE_CI_EXPORT_REJECTED');};
const check=v=>{if(!v)fail();};
const flags=Object.freeze({qualified:false,productionQualified:false,credentialsIncluded:false,activationAuthorized:false});
const maximumArchiveBytes=4*1024**3;

async function directory(path){check(await realpath(path)===resolve(path));const s=await lstat(path);check(s.isDirectory()&&!s.isSymbolicLink());}
function outside(parent,path){const r=relative(parent,path);return r!==''&&(r==='..'||r.startsWith('../')||r.startsWith('..\\')||isAbsolute(r));}
async function freshDirectory(path,source){path=resolve(path);await directory(dirname(path));check(outside(resolve(source),path));await mkdir(path,{mode:0o755});return path;}
/** Streaming hash also supports the existing archive bundle's bounded 3-GiB closure. */
export async function hostReleaseArchiveHash(path){
 const before=await lstat(path);check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=maximumArchiveBytes&&await realpath(path)===resolve(path));
 const f=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)),hash=createHash('sha256');try{const s=await f.stat();check(s.dev===before.dev&&s.ino===before.ino);const buffer=Buffer.alloc(1024*1024);let bytes=0;while(bytes<before.size){const read=await f.read(buffer,0,Math.min(buffer.length,before.size-bytes),bytes);check(read.bytesRead>0);hash.update(buffer.subarray(0,read.bytesRead));bytes+=read.bytesRead;}const after=await f.stat();check(after.size===before.size&&after.mtimeMs===before.mtimeMs);return {bytes,sha256:hash.digest('hex')};}finally{await f.close();}
}
function standalone(value,component,commit,tree){
 check(exact(value,['version','kind','service','sourceCommit','sourceTree','image','nodeVersion','compiler','packageLockSha256','inputs','runtime','deployable','qualified'])&&value.version===1&&value.kind==='coatria-trusted-service-bundle'&&value.service===component&&value.sourceCommit===commit&&value.sourceTree===tree&&value.image===ARCHIVE_HOST_PINS.nodeImage&&value.nodeVersion===ARCHIVE_HOST_PINS.nodeVersion&&value.deployable===true&&value.qualified===false&&sha(value.packageLockSha256));
 check(exact(value.compiler,['name','version','packageIntegrity'])&&value.compiler.name==='esbuild'&&value.compiler.version==='0.28.2'&&/^sha512-[A-Za-z0-9+/=]+$/.test(value.compiler.packageIntegrity));
 check(exact(value.runtime,['path','bytes','sha256'])&&value.runtime.path==='runtime.mjs'&&Number.isSafeInteger(value.runtime.bytes)&&value.runtime.bytes>0&&value.runtime.bytes<=8*1024**2&&sha(value.runtime.sha256));
 check(Array.isArray(value.inputs)&&value.inputs.length>0&&value.inputs.length<=2000);const seen=new Set();
 for(const input of value.inputs){check(exact(input,['path','bytes','sha256','kind'])&&sha(input.sha256)&&Number.isSafeInteger(input.bytes)&&input.bytes>=0&&input.bytes<=16*1024**2&&!seen.has(input.path));seen.add(input.path);check(input.kind==='reviewed-stub'?input.path==='forbidden:pg-native':archiveHostRelative(input.path)&&['source','dependency'].includes(input.kind)&&(input.kind==='dependency')===input.path.startsWith('node_modules/'));}
 const entry={'reference-registrar':'register-reference-host.mts','image-preparation-registrar':'register-image-preparation-host.mts','image-preparation-control':'control-image-preparation-host.mts'}[component];check(value.inputs.some(i=>i.kind==='source'&&i.path==='scripts/hosting/'+entry));
 return {files:[{...value.runtime,mode:0o444}],emptyDirectories:[],packageLockSha256:value.packageLockSha256};
}
export async function inspectCiHostRelease(component,sourceDirectory,bundleSha256,commit,tree,{trusted=false}={}){
 check(CI_HOST_RELEASE_COMPONENTS.includes(component)&&sha(bundleSha256)&&gitId(commit)&&gitId(tree));sourceDirectory=resolve(sourceDirectory);if(trusted)await archiveHostTrusted(sourceDirectory,true);
 const bytes=await archiveHostRead(join(sourceDirectory,'bundle.json'));check(archiveHostHash(bytes)===bundleSha256);const value=JSON.parse(bytes.toString());let parsed;
 if(component==='archive-host')parsed=parseArchiveBundle(value);else if(component==='reference-host')parsed=parseReferenceHostBundle(value);else if(component==='image-preparation-host')parsed=parseImagePreparationHostBundle(value);else parsed=standalone(value,component,commit,tree);
 check(bytes.equals(json(value)));if(component.endsWith('-host'))check(parsed.commit===commit&&parsed.tree===tree);
 await verifyArchiveTree(sourceDirectory,parsed.files,{trusted,extra:['bundle.json'],emptyDirectories:parsed.emptyDirectories});
 return {bytes,files:parsed.files,emptyDirectories:parsed.emptyDirectories,packageLockSha256:component.endsWith('-host')?parsed.runtime.packageLockSha256:parsed.packageLockSha256,runtimeSha256:component.endsWith('-host')?null:value.runtime.sha256};
}
function tar(directory,path){
 // The exact-Git kit is created after privilege drop. Normalize numeric archive
 // ownership too, so extraction by a reviewed root operator cannot install
 // source owned by the CI runner UID. This never changes local ownership.
 const ownership=process.platform==='win32'?['--uid=0','--gid=0']:['--owner=0','--group=0','--numeric-owner'];
 const r=spawnSync(process.platform==='win32'?'tar.exe':'/usr/bin/tar',[...ownership,'-czf',path,'-C',directory,'.'],{shell:false,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:120000,maxBuffer:65536});check(r.status===0&&!r.error);
}
/** Portable packaging primitive; the CI wrapper below additionally requires root trust. */
export async function createCiHostReleaseArchive({component,sourceDirectory,bundleSha256,commit,tree,output}){
 const source=await inspectCiHostRelease(component,sourceDirectory,bundleSha256,commit,tree),root=await freshDirectory(output,sourceDirectory),stage=join(root,'contents');await mkdir(stage,{mode:0o755});
 await copyArchiveFiles(sourceDirectory,stage,source.files,{emptyDirectories:source.emptyDirectories});await writeFile(join(stage,'bundle.json'),source.bytes,{flag:'wx',mode:0o444});
 await inspectCiHostRelease(component,stage,bundleSha256,commit,tree);const archive=component+'.tar.gz',path=join(root,archive);tar(stage,path);await chmod(path,0o444);
 // Recheck the actual source and staged tree after packing, before publishing any receipt.
 await inspectCiHostRelease(component,sourceDirectory,bundleSha256,commit,tree);await inspectCiHostRelease(component,stage,bundleSha256,commit,tree);
 const facts=await hostReleaseArchiveHash(path),receipt={version:1,kind:'coatria-host-release-transfer',component,sourceCommit:commit,sourceTree:tree,bundleSha256,packageLockSha256:source.packageLockSha256,runtimeSha256:source.runtimeSha256,archive:{path:archive,...facts},...flags};
 await writeFile(join(root,component+'.json'),json(receipt),{flag:'wx',mode:0o444});return {root,receipt};
}
export async function retainCiHostRelease({component,sourceDirectory,bundleSha256,commit,tree,base}){
 check(process.env.CI==='true'&&process.platform==='linux'&&process.arch==='x64'&&process.getuid?.()===0);base=resolve(base);await archiveHostTrusted(base,true);await inspectCiHostRelease(component,sourceDirectory,bundleSha256,commit,tree,{trusted:true});
 // Registrar bases are intentionally0700 and contain private enrollment state.
 // A new0755 sibling contains only the verified manifest archive, so the later
 // runner-UID publication never needs private-base traversal or a mode change.
 return createCiHostReleaseArchive({component,sourceDirectory,bundleSha256,commit,tree,output:base+'-transfer-'+component});
}
function receiptShape(v){
 check(exact(v,['version','kind','component','sourceCommit','sourceTree','bundleSha256','packageLockSha256','runtimeSha256','archive',...Object.keys(flags)])&&v.version===1&&v.kind==='coatria-host-release-transfer'&&CI_HOST_RELEASE_COMPONENTS.includes(v.component)&&gitId(v.sourceCommit)&&gitId(v.sourceTree)&&sha(v.bundleSha256)&&sha(v.packageLockSha256)&&(v.component.endsWith('-host')?v.runtimeSha256===null:sha(v.runtimeSha256))&&Object.entries(flags).every(([k,x])=>v[k]===x));
 check(exact(v.archive,['path','bytes','sha256'])&&v.archive.path===v.component+'.tar.gz'&&Number.isSafeInteger(v.archive.bytes)&&v.archive.bytes>0&&v.archive.bytes<=maximumArchiveBytes&&sha(v.archive.sha256));return v;
}
export async function publishCiHostRelease(retained,output=resolve('.devdata/media-sandbox-linux/releases')){
 check(process.env.CI==='true'&&process.platform==='linux'&&process.getuid?.()!==0);const receipt=receiptShape(retained.receipt);await archiveHostTrusted(retained.root,true);
 await directory(dirname(output));try{await mkdir(output,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await directory(output);
 const receiptBytes=await archiveHostRead(join(retained.root,receipt.component+'.json'));check(receiptBytes.equals(json(receipt)));
 const source=join(retained.root,receipt.archive.path),actual=await hostReleaseArchiveHash(source);check(actual.bytes===receipt.archive.bytes&&actual.sha256===receipt.archive.sha256);
 const target=join(output,receipt.archive.path);await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);const copied=await hostReleaseArchiveHash(target);check(copied.bytes===actual.bytes&&copied.sha256===actual.sha256);await writeFile(join(output,receipt.component+'.json'),receiptBytes,{flag:'wx',mode:0o600});
}
function git(root,args){const r=spawnSync('git',['-c','safe.directory='+root,'-C',root,...args],{shell:false,encoding:null,timeout:30000,maxBuffer:16*1024**2,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,LANG:'C',LC_ALL:'C',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}});check(r.status===0&&!r.error);return r.stdout;}
/** Final index is exclusive and written LAST. Failed/partial exports stay incomplete;
 * there is deliberately no cleanup, overwrite, inferred qualification or retry. */
export async function finalizeCiHostReleases({sourceRoot,commit,output,evidenceDirectory=join(dirname(output),'evidence')}){
 sourceRoot=await realpath(sourceRoot);output=resolve(output);await directory(output);check(gitId(commit)&&git(sourceRoot,['rev-parse','HEAD']).toString().trim()===commit);const tree=git(sourceRoot,['rev-parse',commit+'^{tree}']).toString().trim();check(gitId(tree));
 const expected=CI_HOST_RELEASE_COMPONENTS.flatMap(c=>[c+'.tar.gz',c+'.json']);check((await readdir(output)).sort().join('\n')===expected.sort().join('\n'));
 const lock=git(sourceRoot,['show',commit+':package-lock.json']),lockHash=archiveHostHash(lock),components=[];
 for(const component of CI_HOST_RELEASE_COMPONENTS){const raw=await archiveHostRead(join(output,component+'.json'),65536),receipt=receiptShape(JSON.parse(raw.toString()));check(raw.equals(json(receipt))&&receipt.component===component&&receipt.sourceCommit===commit&&receipt.sourceTree===tree&&receipt.packageLockSha256===lockHash);const facts=await hostReleaseArchiveHash(join(output,receipt.archive.path));check(facts.bytes===receipt.archive.bytes&&facts.sha256===receipt.archive.sha256);
  const evidence=await releaseEvidence(evidenceDirectory,receipt);components.push({...receipt,receiptSha256:archiveHostHash(raw),testedEvidence:evidence});}
 // This stage contains only fixed Git blobs, never a filesystem checkout copy.
 const stage=join(output,'operator-source'),files=[];await mkdir(stage,{mode:0o755});
 for(const path of CI_HOST_OPERATOR_SOURCES){check(/^100(?:644|755) blob [a-f0-9]{40}\t/.test(git(sourceRoot,['ls-tree',commit,'--',path]).toString()));const bytes=git(sourceRoot,['show',commit+':'+path]);await mkdir(dirname(join(stage,path)),{recursive:true,mode:0o755});await writeFile(join(stage,path),bytes,{flag:'wx',mode:0o444});files.push({path,bytes:bytes.length,sha256:archiveHostHash(bytes),mode:0o444});}
 await verifyArchiveTree(stage,files);const sourceArchive=join(output,'operator-source.tar.gz');tar(stage,sourceArchive);await chmod(sourceArchive,0o600);await verifyArchiveTree(stage,files);const installer={path:'operator-source.tar.gz',...await hostReleaseArchiveHash(sourceArchive),files};
 const index={version:1,kind:'coatria-host-release-transfer-index',sourceCommit:commit,sourceTree:tree,packageLockSha256:lockHash,components,operatorSource:installer,...flags};
 // The installer source directory is allowlisted credential-free Git content;
 // leave it intact rather than deleting any computed path in an exporter.
 await writeFile(join(output,'SHA256SUMS'),components.map(c=>c.archive.sha256+'  '+c.archive.path+'\n').join('')+installer.sha256+'  '+installer.path+'\n',{flag:'wx',mode:0o600});
 await writeFile(join(output,'release-index.json'),json(index),{flag:'wx',mode:0o600});return index;
}
async function releaseEvidence(directory,receipt){
 const names={'archive-host':'archive-host-bundle.json','reference-host':'reference-host-ci.json','image-preparation-host':'image-preparation-host-ci.json','reference-registrar':'reference-enrollment-ci.json','image-preparation-registrar':'image-preparation-enrollment-ci.json','image-preparation-control':'image-preparation-installed-flow-ci.json'},path=names[receipt.component],bytes=await archiveHostRead(join(directory,path),1024**2),value=JSON.parse(bytes.toString()),host=receipt.component.endsWith('-host'),controller=receipt.component==='image-preparation-control';
 check(value[host?'qualified':'passed']===true&&value[host?'commit':'sourceCommit']===receipt.sourceCommit&&value[host?'tree':'sourceTree']===receipt.sourceTree&&value[host?'bundleSha256':controller?'controllerBundleSha256':'registrarBundleSha256']===receipt.bundleSha256&&!value.failureCode&&!value.cleanupFailed&&!value.databaseCleanupFailed);
 if(!host)check(value[controller?'controllerRuntimeSha256':'registrarRuntimeSha256']===receipt.runtimeSha256);
 return {path,sha256:archiveHostHash(bytes)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void(async()=>{try{check(process.argv.length===2&&process.env.CI==='true'&&process.platform==='linux'&&process.arch==='x64'&&process.getuid?.()!==0);await finalizeCiHostReleases({sourceRoot:process.cwd(),commit:process.env.GITHUB_SHA,output:resolve('.devdata/media-sandbox-linux/releases')});console.log('HOST_RELEASE_CI_EXPORT_COMPLETE_UNQUALIFIED');}catch{console.error('HOST_RELEASE_CI_EXPORT_REJECTED');process.exitCode=1;}})();
