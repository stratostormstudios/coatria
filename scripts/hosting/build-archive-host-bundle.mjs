/** Reads exact Git objects and an independently pinned prepared Linux runtime.
 * Offline only: no npm install, downloads, executable invocation or credentials. */
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,realpath,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {archiveHostHash,archiveHostFailure,archiveHostRead,parseArchiveRuntime,parseArchiveBundle,verifyArchiveTree,copyArchiveFiles,archiveRuntimeTarget} from './archive-host-package.mjs';

export const ARCHIVE_HOST_SOURCE_FILES=Object.freeze(['archive-host-package.mjs','archive-host-diagnostics.mjs','build-archive-host-bundle.mjs','install-archive-host.mjs','run-archive-host.mts','media-sandbox-linux-canary.mts','media-sandbox-startup-diagnostic.mts','media-sandbox-launch.c','media-sandbox-probe.c','prepare-media-sandbox-ci.mjs','run-media-sandbox-ci.mjs','prepare-media-apparmor-ci.mjs','collect-media-apparmor-ci.mjs']);
function git(root,args,maxBuffer=32*1024**2){const r=spawnSync('git',['-c','safe.directory='+root,'-C',root,...args],{shell:false,encoding:null,maxBuffer,timeout:30000,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,LANG:'C',LC_ALL:'C',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}});if(r.status!==0||r.error)archiveHostFailure();return r.stdout;}
export async function buildArchiveHostBundle({sourceRoot,commit,runtimeRoot,runtimeManifestSha256,output}){
 if(!/^[a-f0-9]{40}$/.test(commit)||!/^[a-f0-9]{64}$/.test(runtimeManifestSha256))archiveHostFailure();
 const root=await realpath(sourceRoot),runtimePath=await realpath(runtimeRoot),target=resolve(output),within=base=>{const rel=relative(base,target);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};if(within(root)||within(runtimePath))archiveHostFailure();
 const raw=await archiveHostRead(join(runtimePath,'runtime-manifest.json'));if(archiveHostHash(raw)!==runtimeManifestSha256)archiveHostFailure();const runtime=parseArchiveRuntime(JSON.parse(raw));
 await verifyArchiveTree(runtimePath,runtime.files,{extra:['runtime-manifest.json']});
 if(git(root,['rev-parse','--verify',commit+'^{commit}']).toString().trim()!==commit)archiveHostFailure();const tree=git(root,['rev-parse',commit+'^{tree}']).toString().trim();
 const treeEntries=new Map(git(root,['ls-tree','-r',commit]).toString().trim().split('\n').filter(Boolean).map(line=>{const at=line.indexOf('\t');return [line.slice(at+1),line.slice(0,at)];}));
 const listed=[...treeEntries.keys()].filter(p=>p.startsWith('src/lib/'));if(!listed.length||listed.length>1000||listed.some(p=>!/^src\/lib\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|json)$/.test(p)))archiveHostFailure();
 const sources=['package.json','package-lock.json','scripts/higgsfield-archive-worker.ts',...listed,...ARCHIVE_HOST_SOURCE_FILES.map(f=>'scripts/hosting/'+f),...['png','jpeg','webp','mp4','mov','wav','mp3'].map(e=>'tests/fixtures/media/synthetic.'+e)];
 for(const path of sources)if(!/^100(?:644|755) blob [a-f0-9]{40}$/.test(treeEntries.get(path)??''))archiveHostFailure();
 // Both package and source locks are exact Git bytes, not a mutable checkout.
 const lock=git(root,['show',commit+':package-lock.json']);if(archiveHostHash(lock)!==runtime.packageLockSha256)archiveHostFailure();
 const parent=dirname(target);if(await realpath(parent)!==parent||!(await lstat(parent)).isDirectory())archiveHostFailure();await mkdir(target,{mode:0o755});
 const files=[];for(const path of sources){const bytes=path==='package-lock.json'?lock:git(root,['show',commit+':'+path]);const destination=join(target,'app',path);await mkdir(dirname(destination),{recursive:true,mode:0o755});await writeFile(destination,bytes,{flag:'wx',mode:0o444});files.push({path:'app/'+path,bytes:bytes.length,sha256:archiveHostHash(bytes),mode:0o444});}
 // Node resolves packages from the source ancestors; do not rely on NODE_PATH,
 // which does not provide equivalent ESM package resolution.
 const runtimeOnly=runtime.files.filter(f=>!f.path.startsWith('node_modules/')),modules=runtime.files.filter(f=>f.path.startsWith('node_modules/'));
 await mkdir(join(target,'runtime'),{mode:0o755});await copyArchiveFiles(runtimePath,join(target,'runtime'),runtimeOnly);await copyArchiveFiles(runtimePath,join(target,'app'),modules);files.push(...runtime.files.map(f=>({...f,path:archiveRuntimeTarget(f.path)})));files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const manifest=parseArchiveBundle({version:1,kind:'coatria-archive-host',commit,tree,runtimeManifestSha256:archiveHostHash(JSON.stringify(runtime)+'\n'),runtime,files});const manifestBytes=JSON.stringify(manifest,null,2)+'\n';await writeFile(join(target,'bundle.json'),manifestBytes,{flag:'wx',mode:0o444});
 await verifyArchiveTree(target,files,{extra:['bundle.json']});return {commit,tree,bundleSha256:archiveHostHash(manifestBytes),runtimeInputSha256:runtimeManifestSha256,output:target,qualified:false,servicesEnabled:false,providerCalls:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void(async()=>{const [sourceRoot,commit,runtimeRoot,runtimeManifestSha256,output,...extra]=process.argv.slice(2);if(extra.length||!output)throw Error('Expected <source-root> <commit> <prepared-runtime> <runtime-manifest-sha256> <new-output-directory>.');try{console.log(JSON.stringify(await buildArchiveHostBundle({sourceRoot,commit,runtimeRoot,runtimeManifestSha256,output})));}catch{console.error('ARCHIVE_HOST_BUILD_FAILED: inspect reviewed inputs; no runtime was installed or started.');process.exitCode=1;}})();}
