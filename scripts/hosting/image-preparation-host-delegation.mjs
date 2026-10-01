/** Image-preparation-only systemd boundary. No credential, network or provider access. */
import {spawnSync} from 'node:child_process';
import {lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

function fail(){throw Error('IMAGE_PREPARATION_HOST_DELEGATION_REJECTED');}
const id=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function imagePreparationHostUnitName(serviceId,mode){if(!id(serviceId)||!['qualify','preflight','worker'].includes(mode))fail();return `coatria-image-preparation-${serviceId}-${mode}.service`;}
export function imagePreparationHostDelegatedPath(raw,serviceId,mode){
 const unit=imagePreparationHostUnitName(serviceId,mode),relative=`/system.slice/${unit}`,expected=`0::${relative}/supervisor`;
 if(typeof raw!=='string'||raw!==expected&&raw!==expected+'\n')fail();const serviceRoot='/sys/fs/cgroup'+relative;
 return {serviceRoot,supervisorGroup:serviceRoot+'/supervisor',cgroupRoot:serviceRoot+'/decoders'};
}
export const IMAGE_PREPARATION_HOST_UNIT_PROPERTIES='FragmentPath,DropInPaths,NeedDaemonReload,Transient,ControlGroup,User,Group,InvocationID,MainPID,UnitFileState';
export function assertImagePreparationHostUnitState(raw,serviceId,mode,pid,invocationId){
 const name=imagePreparationHostUnitName(serviceId,mode),keys=IMAGE_PREPARATION_HOST_UNIT_PROPERTIES.split(','),state={};if(typeof raw!=='string'||raw.length>8192||!Number.isSafeInteger(pid)||pid<1)fail();
 for(const line of raw.trim().split('\n')){const at=line.indexOf('='),key=line.slice(0,at);if(at<1||!keys.includes(key)||Object.hasOwn(state,key))fail();state[key]=line.slice(at+1);}
 if(Object.keys(state).length!==keys.length||state.FragmentPath!==`/etc/systemd/system/${name}`||state.DropInPaths!==''||state.NeedDaemonReload!=='no'||state.Transient!=='no'||state.ControlGroup!==`/system.slice/${name}`||state.User!=='coatria-image-preparation'||state.Group!=='coatria-image-preparation'||state.MainPID!==String(pid)||state.UnitFileState!=='static'||!/^[a-f0-9]{32}$/.test(state.InvocationID)||/^0+$/.test(state.InvocationID)||state.InvocationID!==invocationId)fail();return state.InvocationID;
}
const text=async path=>(await readFile(path,'utf8')).trim();
export async function initializeImagePreparationHostDelegation(serviceId,mode){
 if(process.platform!=='linux'||process.arch!=='x64'||!process.getuid||process.getuid()===0||!process.getgid||process.getgid()===0||process.getgroups?.().some(gid=>gid!==process.getgid()))fail();
 const unit=imagePreparationHostUnitName(serviceId,mode),paths=imagePreparationHostDelegatedPath(await readFile('/proc/self/cgroup','utf8'),serviceId,mode);
 const result=spawnSync('/usr/bin/systemctl',['show',unit,'--property='+IMAGE_PREPARATION_HOST_UNIT_PROPERTIES],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:16384});if(result.status!==0||result.error)fail();assertImagePreparationHostUnitState(result.stdout,serviceId,mode,process.pid,process.env.INVOCATION_ID);
 for(const path of [paths.serviceRoot,paths.supervisorGroup]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||![0,process.getuid()].includes(info.uid)||info.mode&0o022)fail();}
 const limits={'memory.max':'2147483648','memory.swap.max':'0','pids.max':'256','cpu.max':'200000 100000'};
 for(const [name,value]of Object.entries(limits))if(await text(join(paths.serviceRoot,name))!==value)fail();
 if(await text(join(paths.serviceRoot,'cgroup.procs'))!==''||await text(join(paths.serviceRoot,'cgroup.type'))!=='domain'||await text(join(paths.supervisorGroup,'cgroup.procs'))!==String(process.pid))fail();
 const controllers=(await text(join(paths.serviceRoot,'cgroup.controllers'))).split(/\s+/);if(['cpu','memory','pids'].some(c=>!controllers.includes(c)))fail();
 // Only the exact delegated service is writable, never an ancestor or host root.
 await writeFile(join(paths.serviceRoot,'cgroup.subtree_control'),'+cpu +memory +pids');
 try{await mkdir(paths.cgroupRoot,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const info=await lstat(paths.cgroupRoot);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077||await realpath(paths.cgroupRoot)!==paths.cgroupRoot||await text(join(paths.cgroupRoot,'cgroup.procs'))!=='')fail();
 for(const entry of await readdir(paths.cgroupRoot))if((await lstat(join(paths.cgroupRoot,entry))).isDirectory())fail();
 await writeFile(join(paths.cgroupRoot,'cgroup.subtree_control'),'+cpu +memory +pids');return paths;
}
