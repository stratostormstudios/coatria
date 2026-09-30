/** Credential-free installed Linux qualification. The report is evidence for a
 * separate root acceptance step; this entry never enrolls or starts a worker. */
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {archiveHostTrusted,archiveHostRead,archiveHostNoExtendedAcls} from './archive-host-package.mjs';
import {readReferenceHostConfiguration,REFERENCE_HOST_STATE,REFERENCE_HOST_PINS} from './reference-host-package.mjs';
import {initializeReferenceHostDelegation,referenceHostDelegatedPath,REFERENCE_HOST_UNIT_PROPERTIES,assertReferenceHostUnitState} from './reference-host-delegation.mjs';
import {parseReferenceHostQualificationArguments,acceptReferenceHostQualification,assertReferenceHostQualificationEnvironment,makeReferenceHostEvidence,referenceHostQualificationHash as hash,referenceHostQualificationFailure as fail} from './reference-host-qualification.mjs';
import {runMediaSandboxCanary,runMediaSandboxCrashChild,parseMediaSandboxCrashChildInput,type MediaSandboxCanaryConfig} from './media-sandbox-linux-canary.mts';

const text=async(path:string)=>(await readFile(path,'utf8')).trim();
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
async function identity(hostPath:string,bundleSha256:string){
 if(process.platform!=='linux'||process.arch!=='x64'||process.version!==REFERENCE_HOST_PINS.nodeVersion||!process.getuid?.()||!process.getgid?.())fail();
 assertReferenceHostQualificationEnvironment(process.env);
 const installation=await readReferenceHostConfiguration(hostPath,bundleSha256,{trusted:true}),{host}=installation;
 if(process.getuid!()!==host.uid||process.getgid!()!==host.gid||process.getgroups?.().some(gid=>gid!==host.gid)||await realpath(process.execPath)!==host.release+'/runtime/node'||await realpath(fileURLToPath(import.meta.url))!==host.qualifier.path||resolve(process.cwd())!==host.release)fail();
 // Full package verification also pins Node/native closure/source; verify the
 // executing qualifier identity, rather than a sibling source checkout.
 if(hash(await archiveHostRead(host.qualifier.path,8*1024**2))!==host.qualifier.sha256)fail();
 return installation;
}
async function privateDirectory(path:string,uid:number,gid:number){
 const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||info.uid!==uid||info.gid!==gid||(info.mode&0o7777)!==0o700)fail();archiveHostNoExtendedAcls([path]);
}
function canaryConfiguration(host:Awaited<ReturnType<typeof readReferenceHostConfiguration>>['host'],paths:ReturnType<typeof referenceHostDelegatedPath>,evidence:string,hostCanarySha256:string):MediaSandboxCanaryConfig{
 return {version:1,...paths,profiles:host.profiles,uid:host.uid,gid:host.gid,hostCanaryPath:join(evidence,'private-host-canary'),hostCanarySha256,evidence,fixtureRoot:join(evidence,'fixtures'),sourceRoot:host.release+'/source',compiledCrashEntrypoint:host.qualifier.path,diagnostics:false};
}
/** Private IPC-only crash route. No report/receipt write or normal startup path.
 * The parent's exact retained systemd identity and installed pins still apply. */
async function crashChild(){
 if(!process.connected||!process.send)fail();
 const inherited=parseMediaSandboxCrashChildInput(process.env.COATRIA_MEDIA_CANARY_CHILD,process.getuid?.(),process.getgid?.()),entry=fileURLToPath(import.meta.url),match=/^\/var\/lib\/coatria-reference-releases\/([a-f0-9]{64})\/qualifier\/runtime\.mjs$/.exec(entry),profile=/^\/etc\/coatria-reference\/([a-f0-9-]{36})\/real\.json$/.exec(inherited.profiles?.real?.profilePath??'');
 if(!match||!profile)fail();
 const {host}=await identity(`/etc/coatria-reference/${profile![1]}/host.json`,match![1]);
 const paths=referenceHostDelegatedPath(await readFile('/proc/self/cgroup','utf8'),host.scope.serviceId,'qualify'),root=join(REFERENCE_HOST_STATE,host.scope.serviceId),parent=join(root,'evidence');
 if(!new RegExp('^'+parent+'/qualification-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$').test(inherited.evidence))fail();
 await archiveHostTrusted(root,true);await privateDirectory(parent,host.uid,host.gid);await privateDirectory(inherited.evidence,host.uid,host.gid);
 const canaryHash=hash(await archiveHostRead(join(inherited.evidence,'private-host-canary'),32));
 if(canonical(inherited)!==canonical(canaryConfiguration(host,paths,inherited.evidence,canaryHash)))fail();
 const state=spawnSync('/usr/bin/systemctl',['show',host.units.qualify.name,'--property='+REFERENCE_HOST_UNIT_PROPERTIES],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:16384});
 if(state.status!==0||state.error)fail();assertReferenceHostUnitState(state.stdout,host.scope.serviceId,'qualify',process.ppid,process.env.INVOCATION_ID);
 const input=await archiveHostRead(join(inherited.fixtureRoot!,'synthetic.png'),1024**2),original=await archiveHostRead(join(host.release,'source/tests/fixtures/media/synthetic.png'),1024**2);if(!input.equals(original))fail();
 await runMediaSandboxCrashChild(inherited);
}
export async function qualifyReferenceHost(args:readonly string[]){
 const command=parseReferenceHostQualificationArguments(args);
 if(command.mode==='accept'){
  if(process.platform!=='linux'||process.arch!=='x64'||process.version!==REFERENCE_HOST_PINS.nodeVersion||process.getuid?.()!==0)fail();
  assertReferenceHostQualificationEnvironment(process.env);const {host}=await readReferenceHostConfiguration(command.hostPath,command.bundleSha256,{trusted:true});
  if(await realpath(process.execPath)!==host.release+'/runtime/node'||await realpath(fileURLToPath(import.meta.url))!==host.qualifier.path||hash(await archiveHostRead(host.qualifier.path,8*1024**2))!==host.qualifier.sha256)fail();
  console.log(JSON.stringify(await acceptReferenceHostQualification(command.hostPath,command.bundleSha256,command.evidencePath,command.evidenceSha256,command.previousReceiptSha256)));return;
 }
 if(command.mode==='crash-child'){await crashChild();return;}
 const {host,hostBytes,bundle}=await identity(command.hostPath,command.bundleSha256),state=join(REFERENCE_HOST_STATE,host.scope.serviceId),parent=join(state,'evidence');
 await archiveHostTrusted(state,true);await privateDirectory(parent,host.uid,host.gid);
 const paths=await initializeReferenceHostDelegation(host.scope.serviceId,'qualify'),root=join(parent,'qualification-'+randomUUID());await mkdir(root,{mode:0o700});
 const fixtureRoot=join(root,'fixtures');await mkdir(fixtureRoot,{mode:0o700});
 for(const extension of ['png','jpeg','webp','mp4','mov','wav','mp3']){const source=join(host.release,'source/tests/fixtures/media/synthetic.'+extension),target=join(fixtureRoot,'synthetic.'+extension);await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);if(hash(await archiveHostRead(source))!==hash(await archiveHostRead(target)))fail();}
 const canary=randomBytes(32),hostCanaryPath=join(root,'private-host-canary');await writeFile(hostCanaryPath,canary,{mode:0o600,flag:'wx'});
 await runMediaSandboxCanary(canaryConfiguration(host,paths,root,hash(canary)));
 if((await readdir(paths.cgroupRoot)).some(name=>name.startsWith('decoder-'))||Date.parse(host.scope.expiresAt)<=Date.now())fail();
 const reportPath=join(root,'qualification.json'),reportBytes=await archiveHostRead(reportPath,1024**2),observed={bootId:await text('/proc/sys/kernel/random/boot_id'),invocationId:process.env.INVOCATION_ID,uid:process.getuid!(),gid:process.getgid!(),serviceRoot:paths.serviceRoot};
 const evidence=makeReferenceHostEvidence(host,hostBytes,bundle,reportBytes,observed),evidenceBytes=JSON.stringify(evidence,null,2)+'\n',evidencePath=join(root,'host-evidence.json');await writeFile(evidencePath,evidenceBytes,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({event:'reference-host-qualified',evidencePath,evidenceSha256:hash(evidenceBytes),reportPath,reportSha256:hash(reportBytes),qualified:true,enrolled:false,workerEnabled:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void qualifyReferenceHost(process.argv.slice(2)).catch(()=>{console.error(JSON.stringify({event:'reference-host-qualification-failed',code:'REFERENCE_HOST_QUALIFICATION_REJECTED'}));process.exitCode=1;});
