// CI only: fixed public dependencies and synthetic output. No company/provider API.
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {buildRendererBootstrap} from './build-renderer-bootstrap.mjs';
import {BLENDER_RELEASE,RENDERER_RUNTIME_PACKAGES,downloadVerifiedFile} from './renderer-bootstrap-runtime.mjs';

if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0)throw Error('The Linux renderer canary requires the reviewed root container.');
const root=process.cwd(),base=join(root,'.devdata','renderer-linux-canary'),app=join(base,'app'),blender=join(base,'blender'),evidence=join(base,'evidence');
const run=(command,args,cwd=root,timeout=120000)=>{const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout,maxBuffer:1024*1024,env:{PATH:process.env.PATH,HOME:'/root',LANG:'C.UTF-8',DEBIAN_FRONTEND:'noninteractive'}});if(result.status!==0)throw Error('CANARY_SETUP_COMMAND_FAILED: '+command);return result.stdout;};
await mkdir(evidence,{recursive:true});
try{
 const commit=process.env.GITHUB_SHA;if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('A reviewed GitHub source SHA is required.');
 const artifact=await buildRendererBootstrap({root,commit});
 for(const file of artifact.manifest){const target=join(app,file.target);await mkdir(dirname(target),{recursive:true});await writeFile(target,(await readFile(join(root,file.path),'utf8')).replaceAll('\r\n','\n'),{flag:'wx'});}
 const canary='scripts/hosting/renderer-linux-canary.mts';await writeFile(join(app,canary),await readFile(join(root,canary)),{flag:'wx'});
 run('/usr/bin/apt-get',['update','-qq']);run('/usr/bin/apt-get',['install','-y','--no-install-recommends',...RENDERER_RUNTIME_PACKAGES]);
 await writeFile(join(evidence,'runtime-packages.txt'),run('/usr/bin/dpkg-query',['-W',...RENDERER_RUNTIME_PACKAGES]));
 run('/usr/local/bin/npm',['ci','--ignore-scripts','--no-audit','--no-fund'],app);
 run(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./scripts/hosting/run-renderer-host.mts')"],app,30000);
 await mkdir(blender,{recursive:false});const archive=join(base,'blender.tar.xz');
 await downloadVerifiedFile({url:BLENDER_RELEASE.url,path:archive,bytes:BLENDER_RELEASE.bytes,sha256:BLENDER_RELEASE.sha256,signal:AbortSignal.timeout(180000)});
 run('/usr/bin/tar',['-xJf',archive,'--strip-components=1','-C',blender]);
 const binary=join(blender,'blender');if(!(await lstat(binary)).isFile())throw Error('BLENDER_BINARY_MISSING');
 const linked=run('/usr/bin/ldd',[binary],root,30000);await writeFile(join(evidence,'linked-libraries.txt'),linked);if(linked.includes('not found'))throw Error('BLENDER_LIBRARY_UNAVAILABLE');
 const version=run(binary,['--background','--factory-startup','--disable-autoexec','--offline-mode','--python-exit-code','1','--python-expr','import bpy; assert bpy.app.version == (5, 2, 2); assert bpy.app.build_options.cycles'],root,60000);await writeFile(join(evidence,'blender-version.txt'),version);
 await writeFile(join(evidence,'setup.json'),JSON.stringify({status:'prepared',commit,node:process.version,platform:process.platform,image:artifact.image,blenderArchive:BLENDER_RELEASE,sourceManifest:artifact.manifest,dependencyInstall:'npm ci --ignore-scripts --no-audit --no-fund',isolatedWorkerImport:true,companyOrProviderApiUsed:false},null,2)+'\n');
 console.log('Reviewed Linux renderer canary dependencies prepared.');
}catch(error){await writeFile(join(evidence,'setup-failure.json'),JSON.stringify({status:'failed',code:error instanceof Error?error.message:'CANARY_SETUP_FAILED',companyOrProviderApiUsed:false},null,2)+'\n');throw error;}
