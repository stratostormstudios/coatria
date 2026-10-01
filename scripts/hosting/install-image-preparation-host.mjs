/** Root installation only. No credential, qualification acceptance, service activation or enrollment. */
import {spawnSync} from 'node:child_process';
import {chown,lstat,mkdir,open,opendir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {archiveHostHash,archiveHostRead,archiveHostTrusted,copyArchiveFiles} from './archive-host-package.mjs';
import {IMAGE_PREPARATION_HOST_CONFIG,IMAGE_PREPARATION_HOST_RELEASES,IMAGE_PREPARATION_HOST_STATE,IMAGE_PREPARATION_HOST_SERVICE_USER,IMAGE_PREPARATION_HOST_PINS,imagePreparationHostFailure,parseImagePreparationHostScope,inspectImagePreparationHostBundle,imagePreparationHostInstallPlan,imagePreparationHostProfiles,createImagePreparationHostConfiguration,readImagePreparationHostConfiguration} from './image-preparation-host-package.mjs';
const command=(binary,args)=>{const r=spawnSync(binary,args,{shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:16384});if(r.status!==0||r.error)imagePreparationHostFailure();return r.stdout.trim();};
async function absent(path){try{await lstat(path);imagePreparationHostFailure();}catch(error){if(error.code!=='ENOENT')throw error;}}
export const IMAGE_PREPARATION_HOST_UNIT_SEARCH_PATHS=Object.freeze(['/etc/systemd/system.control','/run/systemd/system.control','/run/systemd/transient','/run/systemd/generator.early','/etc/systemd/system','/run/systemd/system','/run/systemd/generator','/usr/local/lib/systemd/system','/usr/lib/systemd/system','/lib/systemd/system','/run/systemd/generator.late']);
export function assertImagePreparationHostUnloadedUnit(raw){
 const expected={LoadState:'not-found',ActiveState:'inactive',FragmentPath:'',DropInPaths:'',UnitFileState:''},state={};if(typeof raw!=='string'||raw.length>8192)imagePreparationHostFailure();for(const line of raw.split('\n')){const at=line.indexOf('='),key=line.slice(0,at);if(at<1||!Object.hasOwn(expected,key)||Object.hasOwn(state,key))imagePreparationHostFailure();state[key]=line.slice(at+1);}if(Object.keys(state).length!==Object.keys(expected).length||Object.entries(expected).some(([k,v])=>state[k]!==v))imagePreparationHostFailure();
}
/** Bounded filesystem check includes masks, aliases, enable links and generic or
 * dash-prefix drop-ins; loaded manager state is checked independently. */
export async function assertImagePreparationHostUnitsAbsent(names,roots=IMAGE_PREPARATION_HOST_UNIT_SEARCH_PATHS){
 if(!Array.isArray(names)||names.length!==3||names.some(n=>!/^coatria-image-preparation-[a-f0-9-]{36}-(?:qualify|preflight|worker)\.service$/.test(n)))imagePreparationHostFailure();
 for(const root of roots){let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}if(entries.length>10000||entries.some(e=>e.name.startsWith('coatria-image-preparation-')&&/\.service(?:\.d)?$/.test(e.name)))imagePreparationHostFailure();
  for(const name of names){await absent(join(root,name));await absent(join(root,name+'.d'));await absent(join(root,'service.d'));const stem=name.slice(0,-'.service'.length);for(let at=stem.indexOf('-');at!==-1;at=stem.indexOf('-',at+1))await absent(join(root,stem.slice(0,at+1)+'.service.d'));}
  for(const entry of entries)if(/\.(?:wants|requires|upholds)$/.test(entry.name)){if(entry.isSymbolicLink()||!entry.isDirectory())imagePreparationHostFailure();for(const name of names)await absent(join(root,entry.name,name));}
 }
}
export async function assertImagePreparationHostVacantBase(path){try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())imagePreparationHostFailure();const directory=await opendir(path);try{if(await directory.read()!==null)imagePreparationHostFailure();}finally{await directory.close();}}catch(error){if(error.code!=='ENOENT')throw error;}}
/** Retained exclusive claim: even concurrent root installers cannot create two
 * service identities sharing this host's dedicated UID. Never removed on error. */
export async function claimImagePreparationHostInstallation(configRoot,serviceId,bundleSha256){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(serviceId)||!/^[a-f0-9]{64}$/.test(bundleSha256))imagePreparationHostFailure();
 const handle=await open(join(configRoot,'installation.json'),'wx',0o444);try{await handle.writeFile(JSON.stringify({version:1,serviceId,bundleSha256})+'\n');await handle.sync();}finally{await handle.close();}
 const directory=await open(configRoot,'r');try{await directory.sync();}finally{await directory.close();}
}
async function assertNoServiceProcess(uid){const r=spawnSync('/usr/bin/pgrep',['-u',String(uid)],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:16384});if(r.status!==1||r.error||r.stdout.trim())imagePreparationHostFailure();}
async function preconditions(bundle,plan){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0)imagePreparationHostFailure();
 const version=command('/usr/bin/systemctl',['--version']).match(/^systemd (\d+)/);if(!version||Number(version[1])<254||(await readFile('/proc/1/comm','utf8')).trim()!=='systemd')imagePreparationHostFailure();
 if(command('/usr/bin/dpkg-query',['-W','-f=${Version}','bubblewrap'])!==IMAGE_PREPARATION_HOST_PINS.bubblewrapPackage)imagePreparationHostFailure();await archiveHostTrusted('/usr/bin/bwrap');if(archiveHostHash(await archiveHostRead('/usr/bin/bwrap'))!==bundle.runtime.bubblewrapSha256)imagePreparationHostFailure();
 await archiveHostTrusted('/etc/apparmor.d/coatria-bwrap-userns-restrict');if(archiveHostHash(await archiveHostRead('/etc/apparmor.d/coatria-bwrap-userns-restrict'))!==IMAGE_PREPARATION_HOST_PINS.apparmorProfileSha256)imagePreparationHostFailure();const profiles=(await readFile('/sys/kernel/security/apparmor/profiles','utf8')).split('\n');if(['bwrap','unpriv_bwrap'].some(p=>!profiles.includes(p+' (enforce)'))||(await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8')).trim()!=='1')imagePreparationHostFailure();
 const uid=Number(command('/usr/bin/id',['-u',IMAGE_PREPARATION_HOST_SERVICE_USER])),gid=Number(command('/usr/bin/id',['-g',IMAGE_PREPARATION_HOST_SERVICE_USER])),groups=command('/usr/bin/id',['-G',IMAGE_PREPARATION_HOST_SERVICE_USER]).split(/\s+/).map(Number);if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1||!groups.length||groups.some(g=>g!==gid)||command('/usr/bin/getent',['group',String(gid)]).split(':')[0]!==IMAGE_PREPARATION_HOST_SERVICE_USER)imagePreparationHostFailure();
 for(const path of ['/var/lib','/etc','/etc/systemd/system'])await archiveHostTrusted(path,true);for(const path of [IMAGE_PREPARATION_HOST_CONFIG,IMAGE_PREPARATION_HOST_STATE]){await assertImagePreparationHostVacantBase(path);try{await archiveHostTrusted(path,true);}catch(error){if(error.code!=='ENOENT')throw error;}}await assertNoServiceProcess(uid);await assertImagePreparationHostUnitsAbsent(plan.units.map(u=>u.name));for(const unit of plan.units)assertImagePreparationHostUnloadedUnit(command('/usr/bin/systemctl',['show',unit.name,'--property=LoadState,ActiveState,FragmentPath,DropInPaths,UnitFileState']));return {uid,gid};
}
export async function readImagePreparationInstallScope(scopePath,scopeSha256,{trusted=false}={}){if(typeof scopeSha256!=='string'||!/^[a-f0-9]{64}$/.test(scopeSha256))imagePreparationHostFailure();if(trusted)await archiveHostTrusted(scopePath);const raw=await archiveHostRead(scopePath,65536);if(archiveHostHash(raw)!==scopeSha256)imagePreparationHostFailure();return parseImagePreparationHostScope(JSON.parse(raw));}
export async function installImagePreparationHost(bundlePath,bundleSha256,scopePath,scopeSha256){
 // These checks happen before any writes. A partial installation is preserved
 // for explicit inspection; retries never overwrite files or delete evidence.
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0)imagePreparationHostFailure();const bundle=await inspectImagePreparationHostBundle(bundlePath,bundleSha256,{trusted:true}),scope=await readImagePreparationInstallScope(scopePath,scopeSha256,{trusted:true}),plan=imagePreparationHostInstallPlan(bundle,bundleSha256,scope),identity=await preconditions(bundle,plan);
 for(const path of [plan.configuration,plan.state,plan.release])await absent(path);
 for(const path of [IMAGE_PREPARATION_HOST_RELEASES,IMAGE_PREPARATION_HOST_CONFIG,IMAGE_PREPARATION_HOST_STATE]){try{await mkdir(path,{mode:0o755});}catch(error){if(error.code!=='EEXIST')throw error;}await archiveHostTrusted(path,true);}
 await claimImagePreparationHostInstallation(IMAGE_PREPARATION_HOST_CONFIG,scope.serviceId,bundleSha256);
 await mkdir(plan.release,{mode:0o755});await copyArchiveFiles(resolve(bundlePath),plan.release,bundle.files,{emptyDirectories:bundle.emptyDirectories});await writeFile(join(plan.release,'bundle.json'),await archiveHostRead(join(resolve(bundlePath),'bundle.json')),{flag:'wx',mode:0o444});await inspectImagePreparationHostBundle(plan.release,bundleSha256,{trusted:true});
 await mkdir(plan.configuration,{mode:0o755});for(const [kind,profile]of Object.entries(imagePreparationHostProfiles(bundle,plan.release)))await writeFile(join(plan.configuration,kind+'.json'),JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o444});
 const host=createImagePreparationHostConfiguration(bundle,bundleSha256,scope,identity);await writeFile(join(plan.configuration,'host.json'),JSON.stringify(host,null,2)+'\n',{flag:'wx',mode:0o444});
 await mkdir(plan.state,{mode:0o755});for(const name of ['scratch','temporary','evidence']){const path=join(plan.state,name);await mkdir(path,{mode:0o700});await chown(path,identity.uid,identity.gid);}await archiveHostTrusted(plan.state,true);
 // Recheck expiry and all absent units immediately before writing exact units.
 parseImagePreparationHostScope({version:1,...scope});await assertImagePreparationHostUnitsAbsent(plan.units.map(u=>u.name));for(const unit of plan.units)await writeFile('/etc/systemd/system/'+unit.name,unit.content,{flag:'wx',mode:0o644});
 await readImagePreparationHostConfiguration(plan.configuration+'/host.json',bundleSha256,{trusted:true});return {...plan,installed:true,requiresDaemonReload:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void(async()=>{try{const[mode='plan',path,hash,scopePath,scopeHash,...extra]=process.argv.slice(2);if(!['plan','install'].includes(mode)||!scopeHash||extra.length)imagePreparationHostFailure();const result=mode==='install'?await installImagePreparationHost(path,hash,scopePath,scopeHash):imagePreparationHostInstallPlan(await inspectImagePreparationHostBundle(path,hash,{trusted:false}),hash,await readImagePreparationInstallScope(scopePath,scopeHash));console.log(JSON.stringify(result,null,2));}catch{console.error('IMAGE_PREPARATION_HOST_INSTALL_REJECTED: no service was enabled or started.');process.exitCode=1;}})();
