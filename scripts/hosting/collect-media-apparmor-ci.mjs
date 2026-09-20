// Root CI observation only. Never echo kernel messages, paths or arbitrary
// profile names; retain allowlisted denial categories for the synthetic lane.
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,readFile,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {relevantLoadedProfiles} from './prepare-media-apparmor-ci.mjs';

export function classifyMediaAppArmorDenials(lines){
 const result=[];for(const line of lines.split('\n').slice(-200)){let message;try{message=JSON.parse(line).MESSAGE;}catch{continue;}if(typeof message!=='string'||message.length>16384||!message.includes('apparmor="DENIED"'))continue;
  const comm=message.match(/\bcomm="([^"]*)"/)?.[1];if(!['bwrap','ffprobe','ffmpeg','media-sandbox-l'].includes(comm))continue;
  const operation=message.match(/\boperation="([^"]*)"/)?.[1],capability=message.match(/\bcapname="([^"]*)"/)?.[1],profile=message.match(/\bprofile="([^"]*)"/)?.[1]??'';
  result.push({comm,operation:['capable','userns_create','change_profile','exec','mount','pivotroot','network','file_mmap','open'].includes(operation)?operation:'other',capability:['net_admin','net_raw','sys_admin','setuid','setgid','sys_chroot','sys_ptrace','sys_resource','dac_override','dac_read_search'].includes(capability)?capability:null,profile:profile.includes('unpriv_bwrap')?'capability_denied_child':profile==='bwrap'?'bwrap':profile==='unprivileged_userns'?'default_restricted_userns':'other'});
 }return result;
}
export async function collectMediaAppArmorCI(){
 if(process.platform!=='linux'||process.getuid?.()!==0||process.env.CI!=='true')throw Error('Root CI observation required.');
 const path=process.env.COATRIA_MEDIA_QUALIFICATION;if(!path||!/^\/var\/lib\/coatria-media-ci-[a-f0-9-]+\/qualification\.json$/.test(path)||await realpath(path)!==path)throw Error('Invalid qualification path.');const info=await lstat(path);if(info.uid!==0||info.mode&0o022||!info.isFile()||info.nlink!==1)throw Error('Untrusted qualification.');
 let ancestor=dirname(path);while(ancestor!=='/'){const value=await lstat(ancestor);if(value.uid!==0||value.mode&0o022||!value.isDirectory()||value.isSymbolicLink())throw Error('Untrusted report ancestor.');ancestor=dirname(ancestor);}
 const config=JSON.parse(await readFile(path,'utf8'));if(!Number.isInteger(config.uid)||config.uid<1||!Number.isInteger(config.gid)||config.gid<1||config.evidence!==resolve('.devdata/media-sandbox-linux/evidence'))throw Error('Invalid report identity.');
 const report={diagnosticOnly:true,qualified:false};
 try{report.loadedProfiles=relevantLoadedProfiles((await readFile('/sys/kernel/security/apparmor/profiles','utf8')).trim());}catch{report.loadedProfilesAvailable=false;}
 const data=spawnSync('/usr/bin/journalctl',['--kernel','--since=-10min','--grep=apparmor','--lines=200','--no-pager','--output=json'],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 report.kernelJournalAvailable=data.status===0&&!data.error;report.denials=report.kernelJournalAvailable?classifyMediaAppArmorDenials(data.stdout):[];
 const bytes=JSON.stringify(report,null,2)+'\n',flags=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW;
 // The root write is confined to a new file under the immutable package parent.
 // Never write as root through the worker-owned artifact directory.
 const protectedFile=await open(join(dirname(path),'apparmor-kernel-denials.json'),flags,0o444);try{await protectedFile.writeFile(bytes);}finally{await protectedFile.close();}
 process.setgroups([]);process.setgid(config.gid);process.setuid(config.uid);
 if(await realpath(config.evidence)!==config.evidence)throw Error('Untrusted artifact directory.');
 const artifact=await open(join(config.evidence,'apparmor-kernel-denials.json'),flags,0o444);try{await artifact.writeFile(bytes);}finally{await artifact.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await collectMediaAppArmorCI();
