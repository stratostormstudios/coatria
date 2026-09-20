/** Explicit root installer. Default is a read-only plan. Never installs packages,
 * credentials, activates AppArmor, enables units, starts work or calls providers. */
import {spawnSync} from 'node:child_process';
import {copyFile,lstat,mkdir,open,readFile,unlink,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ARCHIVE_HOST_PINS,ARCHIVE_HOST_CONFIG,ARCHIVE_HOST_RELEASES,ARCHIVE_HOST_STATE,ARCHIVE_HOST_SERVICE_USER,archiveHostFailure,archiveHostHash,archiveHostRead,archiveHostTrusted,parseArchiveBundle,verifyArchiveTree,copyArchiveFiles,archiveHostProfiles} from './archive-host-package.mjs';

export function archiveHostUnit(mode,release,bundleSha256){
 if(!['qualify','preflight','worker'].includes(mode)||!new RegExp('^'+ARCHIVE_HOST_RELEASES+'/[a-f0-9]{64}$').test(release)||!/^[a-f0-9]{64}$/.test(bundleSha256))archiveHostFailure();
 const gated=mode!=='qualify';return `[Unit]\nDescription=Coatria archive host ${mode}\nAfter=network-online.target\n${gated?'ConditionPathExists='+ARCHIVE_HOST_CONFIG+'/qualified.json\n':''}${mode==='worker'?'ConditionPathExists='+ARCHIVE_HOST_CONFIG+'/worker-enabled\n':''}\n[Service]\nType=${mode==='worker'?'simple':'oneshot'}\n${mode==='qualify'?'RemainAfterExit=yes\n':''}User=${ARCHIVE_HOST_SERVICE_USER}\nGroup=${ARCHIVE_HOST_SERVICE_USER}\nWorkingDirectory=${release}/app\nExecStart=${release}/runtime/node --import tsx scripts/hosting/run-archive-host.mts ${mode} ${bundleSha256}\nEnvironment=NODE_ENV=production\nEnvironment=LANG=C\nEnvironment=LC_ALL=C\nEnvironment=PATH=/usr/bin:/bin\nEnvironment=TSX_DISABLE_CACHE=1\n${gated?'EnvironmentFile='+ARCHIVE_HOST_CONFIG+'/worker.env\n':'UnsetEnvironment=DATABASE_URL COATRIA_HOSTING_KEYRING RUNPOD_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY\n'}UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH\nStateDirectory=coatria-archive-state\nStateDirectoryMode=0700\nDelegate=cpu memory pids\nDelegateSubgroup=supervisor\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=256\nCPUQuota=200%\nCPUQuotaPeriodSec=100ms\nLimitNOFILE=1024\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=full\nProtectHome=yes\nPrivateTmp=yes\nKillMode=control-group\nTimeoutStartSec=${mode==='qualify'?'180':'60'}\nTimeoutStopSec=45\nSendSIGKILL=yes\nRestart=no\n# Deliberately no [Install] section: installation never enables this service.\n`;
}
function command(binary,args){const r=spawnSync(binary,args,{shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:16384});if(r.status!==0||r.error)archiveHostFailure();return r.stdout.trim();}
export const ARCHIVE_QUALIFIER_STATE_PROPERTIES='ActiveState,SubState,MainPID,ControlPID,Result,ExecMainStatus,InvocationID';
/** A retained successful oneshot is active/exited with no process. Active/running
 * or an inactive unit cannot authorize acceptance of a historical attempt. */
/** @param {string} raw @param {string} [expectedInvocation] */
export function archiveHostQualificationInvocation(raw,expectedInvocation){
 if(typeof raw!=='string'||raw.length>4096)archiveHostFailure();const state={},allowed=ARCHIVE_QUALIFIER_STATE_PROPERTIES.split(',');
 for(const line of raw.trim().split('\n')){const at=line.indexOf('='),key=line.slice(0,at);if(at<1||!allowed.includes(key)||Object.hasOwn(state,key))archiveHostFailure();state[key]=line.slice(at+1);}
 if(Object.keys(state).length!==allowed.length||state.ActiveState!=='active'||state.SubState!=='exited'||state.MainPID!=='0'||state.ControlPID!=='0'||state.Result!=='success'||state.ExecMainStatus!=='0'||!/^[a-f0-9]{32}$/.test(state.InvocationID)||/^0+$/.test(state.InvocationID)||expectedInvocation!==undefined&&state.InvocationID!==expectedInvocation)archiveHostFailure();return state.InvocationID;
}
const qualifierInvocation=expected=>archiveHostQualificationInvocation(command('/usr/bin/systemctl',['show','coatria-archive-qualify.service','--property='+ARCHIVE_QUALIFIER_STATE_PROPERTIES]),expected);
export async function inspectArchiveHostBundle(bundlePath,expectedSha256,{trusted=false}={}){
 if(!/^[a-f0-9]{64}$/.test(expectedSha256))archiveHostFailure();const path=resolve(bundlePath);if(trusted)await archiveHostTrusted(path,true);const raw=await archiveHostRead(join(path,'bundle.json'));if(archiveHostHash(raw)!==expectedSha256)archiveHostFailure();if(trusted)await archiveHostTrusted(join(path,'bundle.json'));const bundle=parseArchiveBundle(JSON.parse(raw));await verifyArchiveTree(path,bundle.files,{trusted,extra:['bundle.json'],emptyDirectories:bundle.emptyDirectories});return bundle;
}
export function archiveHostInstallPlan(bundle,bundleSha256){const release=ARCHIVE_HOST_RELEASES+'/'+bundleSha256;return {version:1,commit:bundle.commit,tree:bundle.tree,bundleSha256,release,serviceUser:ARCHIVE_HOST_SERVICE_USER,configuration:ARCHIVE_HOST_CONFIG,state:ARCHIVE_HOST_STATE,units:['qualify','preflight','worker'].map(mode=>({name:'coatria-archive-'+mode+'.service',content:archiveHostUnit(mode,release,bundleSha256)})),packagesInstalled:false,profilesActivated:false,servicesEnabled:false,servicesStarted:false,credentialsIncluded:false,qualified:false};}
async function preconditions(bundle){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0)archiveHostFailure();
 const version=command('/usr/bin/systemctl',['--version']).match(/^systemd (\d+)/);if(!version||Number(version[1])<254||(await readFile('/proc/1/comm','utf8')).trim()!=='systemd')archiveHostFailure();
 if(command('/usr/bin/dpkg-query',['-W','-f=${Version}','bubblewrap'])!==ARCHIVE_HOST_PINS.bubblewrapPackage)archiveHostFailure();
 const bwrap=await archiveHostRead('/usr/bin/bwrap');if(archiveHostHash(bwrap)!==bundle.runtime.bubblewrapSha256)archiveHostFailure();await archiveHostTrusted('/usr/bin/bwrap');
 // Policy activation remains an explicit privileged host-preparation action.
 // The canary must still prove the actual enforcing child attachment.
 if(archiveHostHash(await archiveHostRead('/etc/apparmor.d/coatria-bwrap-userns-restrict'))!==ARCHIVE_HOST_PINS.apparmorProfileSha256)archiveHostFailure();await archiveHostTrusted('/etc/apparmor.d/coatria-bwrap-userns-restrict');
 const profiles=await readFile('/sys/kernel/security/apparmor/profiles','utf8');for(const name of ['bwrap','unpriv_bwrap'])if(!profiles.split('\n').includes(name+' (enforce)'))archiveHostFailure();
 if((await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8')).trim()!=='1')archiveHostFailure();
 const uid=Number(command('/usr/bin/id',['-u',ARCHIVE_HOST_SERVICE_USER])),gid=Number(command('/usr/bin/id',['-g',ARCHIVE_HOST_SERVICE_USER]));if(!Number.isInteger(uid)||uid<1||!Number.isInteger(gid)||gid<1)archiveHostFailure();
 for(const path of ['/var/lib','/etc','/etc/systemd/system'])await archiveHostTrusted(path,true);
 return {uid,gid};
}
export async function installArchiveHost(bundlePath,expectedSha256){
 const bundle=await inspectArchiveHostBundle(bundlePath,expectedSha256,{trusted:true}),identity=await preconditions(bundle),plan=archiveHostInstallPlan(bundle,expectedSha256);
 // Refuse an existing installation rather than silently replacing reviewed
 // source/configuration or carrying a previous qualification into a new release.
 for(const path of [ARCHIVE_HOST_CONFIG,...plan.units.map(u=>'/etc/systemd/system/'+u.name)]){try{await lstat(path);archiveHostFailure();}catch(error){if(error.code!=='ENOENT')throw error;}}
 try{await mkdir(ARCHIVE_HOST_RELEASES,{mode:0o755});}catch(error){if(error.code!=='EEXIST')throw error;}await archiveHostTrusted(ARCHIVE_HOST_RELEASES,true);
 await mkdir(plan.release,{mode:0o755});await copyArchiveFiles(resolve(bundlePath),plan.release,bundle.files,{emptyDirectories:bundle.emptyDirectories});await writeFile(join(plan.release,'bundle.json'),await archiveHostRead(join(resolve(bundlePath),'bundle.json')),{flag:'wx',mode:0o444});await verifyArchiveTree(plan.release,bundle.files,{trusted:true,extra:['bundle.json'],emptyDirectories:bundle.emptyDirectories});
 await mkdir(ARCHIVE_HOST_CONFIG,{mode:0o755});const profiles={};for(const [kind,profile] of Object.entries(archiveHostProfiles(bundle,plan.release))){const raw=JSON.stringify(profile,null,2)+'\n',path=join(ARCHIVE_HOST_CONFIG,kind+'.json');await writeFile(path,raw,{flag:'wx',mode:0o444});profiles[kind]={profilePath:path,expectedProfileSha256:archiveHostHash(raw)};}
 await writeFile(join(ARCHIVE_HOST_CONFIG,'host.json'),JSON.stringify({version:1,bundleSha256:expectedSha256,commit:bundle.commit,release:plan.release,...identity,profiles},null,2)+'\n',{flag:'wx',mode:0o444});
 for(const unit of plan.units)await writeFile('/etc/systemd/system/'+unit.name,unit.content,{flag:'wx',mode:0o644});
 return {...plan,installed:true,requiresDaemonReload:true};
}
/** Accepts only a completed, currently boot-bound qualification. This records a
 * root-reviewed receipt; it still does not create the worker enable marker. */
export async function acceptArchiveHostQualification(evidencePath,expectedEvidenceSha256,previousReceiptSha256){
 if(process.platform!=='linux'||process.getuid?.()!==0||!/^[a-f0-9]{64}$/.test(expectedEvidenceSha256)||!new RegExp('^'+ARCHIVE_HOST_STATE+'/qualification-[a-f0-9-]{36}/host-evidence\\.json$').test(evidencePath)||previousReceiptSha256!==undefined&&!/^[a-f0-9]{64}$/.test(previousReceiptSha256))archiveHostFailure();
 await archiveHostTrusted(join(ARCHIVE_HOST_CONFIG,'host.json'));const host=JSON.parse(await archiveHostRead(join(ARCHIVE_HOST_CONFIG,'host.json')));
 const invocationId=qualifierInvocation();
 const raw=await archiveHostRead(evidencePath);if(archiveHostHash(raw)!==expectedEvidenceSha256)archiveHostFailure();const report=JSON.parse(raw),bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 if(report.qualified!==true||report.bundleSha256!==host.bundleSha256||report.bootId!==bootId||report.invocationId!==invocationId||report.noProviderCalls!==true||report.testsPassed!==10||report.formatsPassed!==7)archiveHostFailure();
 const receipt={version:1,bundleSha256:host.bundleSha256,bootId,evidencePath,evidenceSha256:expectedEvidenceSha256,acceptedAt:new Date().toISOString()},receiptPath=join(ARCHIVE_HOST_CONFIG,'qualified.json'),lockPath=join(ARCHIVE_HOST_CONFIG,'accept.lock'),lock=await open(lockPath,'wx',0o600);
 try{
  let previous;try{await archiveHostTrusted(receiptPath);previous=await archiveHostRead(receiptPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  qualifierInvocation(invocationId);
  if(previous){const prior=JSON.parse(previous);if(prior.evidenceSha256===expectedEvidenceSha256&&prior.bundleSha256===host.bundleSha256&&prior.bootId===bootId)return {...prior,workerEnabled:false,replayed:true};if(archiveHostHash(previous)!==previousReceiptSha256)archiveHostFailure();const retained=join(ARCHIVE_HOST_CONFIG,'qualified-'+previousReceiptSha256+'.json');try{await copyFile(receiptPath,retained,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST'||archiveHostHash(await archiveHostRead(retained))!==previousReceiptSha256)throw error;}if(archiveHostHash(await archiveHostRead(receiptPath))!==previousReceiptSha256)archiveHostFailure();qualifierInvocation(invocationId);await unlink(receiptPath);
  }else if(previousReceiptSha256!==undefined)archiveHostFailure();
  await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o444});return {...receipt,workerEnabled:false};
 }finally{await lock.close();await unlink(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void(async()=>{try{const [mode='plan',path,hash,...extra]=process.argv.slice(2);if(mode==='accept-qualification'&&extra.length<=1){console.log(JSON.stringify(await acceptArchiveHostQualification(path,hash,extra[0])));}else if(['plan','install'].includes(mode)&&path&&hash&&!extra.length){const result=mode==='install'?await installArchiveHost(path,hash):archiveHostInstallPlan(await inspectArchiveHostBundle(path,hash),hash);console.log(JSON.stringify(result,null,2));}else archiveHostFailure();}catch{console.error('ARCHIVE_HOST_INSTALL_REJECTED: inspect prerequisites; no service was enabled or started.');process.exitCode=1;}})();}
