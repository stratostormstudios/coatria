/** Immutable systemd entry. Creates descendants only inside its delegated unit;
 * qualification is original synthetic media with no database/provider access. */
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {release as kernelRelease} from 'node:os';
import {pathToFileURL} from 'node:url';
import {ARCHIVE_HOST_CONFIG,ARCHIVE_HOST_STATE,ARCHIVE_HOST_PINS,archiveHostFailure,archiveHostHash,archiveHostRead,archiveHostTrusted,archiveHostProfiles,archiveHostReceiptCurrent,archiveHostDelegatedPath} from './archive-host-package.mjs';
import {inspectArchiveHostBundle} from './install-archive-host.mjs';
import {runMediaSandboxCanary,type MediaSandboxCanaryConfig} from './media-sandbox-linux-canary.mts';

type Mode='qualify'|'preflight'|'worker';
type Host={version:1;bundleSha256:string;commit:string;release:string;uid:number;gid:number;profiles:MediaSandboxCanaryConfig['profiles']};
const text=async(path:string)=>(await readFile(path,'utf8')).trim();
async function delegated(mode:Mode){
 const paths=archiveHostDelegatedPath(await readFile('/proc/self/cgroup','utf8'),mode);
 for(const path of [paths.serviceRoot,paths.supervisorGroup]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||![0,process.getuid!()].includes(info.uid)||info.mode&0o022)archiveHostFailure();}
 const limits={'memory.max':'2147483648','memory.swap.max':'0','pids.max':'256','cpu.max':'200000 100000'};for(const [name,value]of Object.entries(limits))if(await text(join(paths.serviceRoot,name))!==value)archiveHostFailure();
 if(await text(join(paths.serviceRoot,'cgroup.procs'))!==''||await text(join(paths.serviceRoot,'cgroup.type'))!=='domain')archiveHostFailure();
 const controllers=(await text(join(paths.serviceRoot,'cgroup.controllers'))).split(/\s+/);if(['cpu','memory','pids'].some(c=>!controllers.includes(c)))archiveHostFailure();
 // DelegateSubgroup placed us in supervisor already. Never write to an
 // ancestor or the host root; systemd owns the unit's aggregate limit values.
 await writeFile(join(paths.serviceRoot,'cgroup.subtree_control'),'+cpu +memory +pids');try{await mkdir(paths.cgroupRoot,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const info=await lstat(paths.cgroupRoot);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid!()||info.mode&0o077||await realpath(paths.cgroupRoot)!==paths.cgroupRoot||await text(join(paths.cgroupRoot,'cgroup.procs'))!=='')archiveHostFailure();for(const entry of await readdir(paths.cgroupRoot))if((await lstat(join(paths.cgroupRoot,entry))).isDirectory())archiveHostFailure();
 await writeFile(join(paths.cgroupRoot,'cgroup.subtree_control'),'+cpu +memory +pids');return paths;
}
async function hostInput(bundleSha256:string):Promise<Host>{
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()===0||process.version!==ARCHIVE_HOST_PINS.nodeVersion||!/^[a-f0-9]{64}$/.test(bundleSha256))archiveHostFailure();
 const path=join(ARCHIVE_HOST_CONFIG,'host.json');await archiveHostTrusted(path);const host=JSON.parse((await archiveHostRead(path)).toString('utf8')) as Host;
 if(host.version!==1||host.bundleSha256!==bundleSha256||host.release!=='/var/lib/coatria-archive-releases/'+bundleSha256||host.uid!==process.getuid?.()||host.gid!==process.getgid?.()||await realpath(process.execPath)!==host.release+'/runtime/node'||resolve(process.cwd())!==host.release+'/app')archiveHostFailure();
 const bundle=await inspectArchiveHostBundle(host.release,bundleSha256,{trusted:true});if(bundle.commit!==host.commit)archiveHostFailure();
 for(const [kind,profile]of Object.entries(archiveHostProfiles(bundle,host.release))){const pin=host.profiles[kind as 'real'|'conformance'],expected=JSON.stringify(profile,null,2)+'\n';if(pin.profilePath!==ARCHIVE_HOST_CONFIG+'/'+kind+'.json'||pin.expectedProfileSha256!==archiveHostHash(expected))archiveHostFailure();await archiveHostTrusted(pin.profilePath);if(archiveHostHash(await archiveHostRead(pin.profilePath))!==pin.expectedProfileSha256)archiveHostFailure();}return host;
}
async function qualify(host:Host,paths:ReturnType<typeof archiveHostDelegatedPath>){
 const root=join(ARCHIVE_HOST_STATE,'qualification-'+randomUUID());await mkdir(root,{mode:0o700});const fixtureRoot=join(root,'fixtures');await mkdir(fixtureRoot,{mode:0o700});
 for(const ext of ['png','jpeg','webp','mp4','mov','wav','mp3']){const target=join(fixtureRoot,'synthetic.'+ext);await copyFile(join(host.release,'app/tests/fixtures/media/synthetic.'+ext),target,constants.COPYFILE_EXCL);await chmod(target,0o600);}
 const canary=randomBytes(32),hostCanaryPath=join(root,'private-host-canary');await writeFile(hostCanaryPath,canary,{mode:0o600,flag:'wx'});
 const config:MediaSandboxCanaryConfig={version:1,...paths,profiles:host.profiles,uid:host.uid,gid:host.gid,hostCanaryPath,hostCanarySha256:archiveHostHash(canary),evidence:root,fixtureRoot,sourceRoot:host.release+'/app',diagnostics:false};
 await runMediaSandboxCanary(config);const report=JSON.parse((await archiveHostRead(join(root,'qualification.json'))).toString('utf8'));
 if(report.qualified!==true||report.tests.length!==10||report.tests.some((test:{passed?:boolean})=>test.passed!==true)||report.realFormats.length!==7||(await readdir(paths.cgroupRoot)).some(n=>n.startsWith('decoder-')))archiveHostFailure();
 const invocationId=process.env.INVOCATION_ID;if(!/^[a-f0-9]{32}$/.test(invocationId??''))archiveHostFailure();const evidence={version:1,qualified:true,noProviderCalls:true,bundleSha256:host.bundleSha256,commit:host.commit,bootId:await text('/proc/sys/kernel/random/boot_id'),invocationId,kernel:kernelRelease(),testsPassed:10,formatsPassed:7,qualificationSha256:archiveHostHash(await archiveHostRead(join(root,'qualification.json'))),serviceRoot:paths.serviceRoot};const bytes=JSON.stringify(evidence,null,2)+'\n';await writeFile(join(root,'host-evidence.json'),bytes,{flag:'wx',mode:0o600});console.log(JSON.stringify({event:'archive-host-qualified',evidencePath:join(root,'host-evidence.json'),evidenceSha256:archiveHostHash(bytes),...evidence}));
}
async function worker(host:Host,paths:ReturnType<typeof archiveHostDelegatedPath>,mode:'worker'|'preflight'){
 const receiptPath=join(ARCHIVE_HOST_CONFIG,'qualified.json');await archiveHostTrusted(receiptPath);const receipt=JSON.parse((await archiveHostRead(receiptPath)).toString('utf8'));if(!archiveHostReceiptCurrent(receipt,host.bundleSha256,await text('/proc/sys/kernel/random/boot_id')))archiveHostFailure();
 if(mode==='worker')await archiveHostTrusted(join(ARCHIVE_HOST_CONFIG,'worker-enabled'));
 const envPath=join(ARCHIVE_HOST_CONFIG,'worker.env'),info=await lstat(envPath);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||info.mode&0o077)archiveHostFailure();
 const scratch=join(ARCHIVE_HOST_STATE,'scratch');try{await mkdir(scratch,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',NODE_ENV:'production',TSX_DISABLE_CACHE:'1',DATABASE_URL:process.env.DATABASE_URL,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:mode==='worker'?'true':'false',COATRIA_ARCHIVE_SCRATCH_ROOT:scratch,COATRIA_MEDIA_SANDBOX_PROFILE:host.profiles.real.profilePath,COATRIA_MEDIA_SANDBOX_PROFILE_SHA256:host.profiles.real.expectedProfileSha256,COATRIA_MEDIA_CGROUP_ROOT:paths.cgroupRoot};
 for(const key of ['COATRIA_HIGGSFIELD_OUTPUT_HOSTS','COATRIA_ARCHIVE_MAX_SOURCE_BYTES','COATRIA_ARCHIVE_OPERATION_MS','DATABASE_POOL_MAX'])if(process.env[key]!==undefined)env[key]=process.env[key];
 const child=spawn(process.execPath,['--import','tsx','scripts/higgsfield-archive-worker.ts',...mode==='preflight'?['--preflight']:[]],{shell:false,stdio:'inherit',cwd:host.release+'/app',env});const stop=(signal:NodeJS.Signals)=>child.kill(signal);const term=()=>stop('SIGTERM'),interrupt=()=>stop('SIGINT');process.once('SIGTERM',term);process.once('SIGINT',interrupt);try{const status=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});if(status!==0)archiveHostFailure();}finally{process.removeListener('SIGTERM',term);process.removeListener('SIGINT',interrupt);}
}
export async function runArchiveHost(mode:Mode,bundleSha256:string){if(!['qualify','preflight','worker'].includes(mode))archiveHostFailure();const host=await hostInput(bundleSha256),paths=await delegated(mode);if(mode==='qualify')await qualify(host,paths);else await worker(host,paths,mode);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void(async()=>{const [mode,hash,...extra]=process.argv.slice(2);try{if(extra.length||!hash)archiveHostFailure();await runArchiveHost(mode as Mode,hash);}catch{console.error(JSON.stringify({event:'archive-host-failed',code:'ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED'}));process.exitCode=1;}})();}
