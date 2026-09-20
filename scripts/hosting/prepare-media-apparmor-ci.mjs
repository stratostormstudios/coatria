// Explicit root CI installation of one reviewed official profile pair. This is
// not imported by the production worker and never disables a host restriction.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {access,lstat,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const MEDIA_APPARMOR=Object.freeze({version:'4.0.1really4.0.1-0ubuntu0.24.04.7',packageSha256:'bdac5b74d884643653565c52ed7483c9582e646ff72cce8d95d0eb8467a3139c',packageBytes:39626,profileSha256:'11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9',profileBytes:1936,source:'https://archive.ubuntu.com/ubuntu/pool/main/a/apparmor/apparmor-profiles_4.0.1really4.0.1-0ubuntu0.24.04.7_all.deb'});
const env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive'};
const hash=data=>createHash('sha256').update(data).digest('hex');
const text=async path=>(await readFile(path,'utf8')).trim();
const failed=()=>{throw Error('MEDIA_CI_APPARMOR_POLICY_REJECTED; inspect apparmor-policy.json.');};
function command(path,args,options={}){const result=spawnSync(path,args,{shell:false,env,timeout:30000,maxBuffer:8*1024**2,...options});if(result.status!==0||result.error)throw Error('MEDIA_CI_APPARMOR_COMMAND_FAILED: '+path);return result.stdout;}
export function relevantLoadedProfiles(value){return value.split('\n').filter(line=>/^(?:bwrap|unpriv_bwrap)(?: |\/\/)/.test(line)).map(line=>({profile:line.startsWith('unpriv_bwrap')?'unpriv_bwrap':line.startsWith('bwrap//')?'bwrap_child_stack':'bwrap',mode:/\(enforce\)$/.test(line)?'enforce':/\(complain\)$/.test(line)?'complain':'other'}));}
export function assertReviewedProfile(bytes){if(bytes.length!==MEDIA_APPARMOR.profileBytes||hash(bytes)!==MEDIA_APPARMOR.profileSha256)failed();return bytes;}
export function hasBwrapDeclaration(value){return /(?:^|\n)\s*(?:profile\s+["']?(?:bwrap|unpriv_bwrap)(?:\/\/[^\s"'{}]+)?["']?(?=[\s{])|(?:profile\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s+)?["']?\/usr\/bin\/bwrap["']?(?=[\s{]))/m.test(value);}
async function globals(){const result={};for(const[name,path]of Object.entries({enabled:'/sys/module/apparmor/parameters/enabled',restrictedUserns:'/proc/sys/kernel/apparmor_restrict_unprivileged_userns',restrictedUnconfined:'/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined',unprivilegedUsernsClone:'/proc/sys/kernel/unprivileged_userns_clone'})){try{const value=await text(path);if(!/^(?:[YN]|\d{1,12})$/.test(value))failed();result[name]=value;}catch(error){if(error.code==='ENOENT')result[name]=null;else throw error;}}return result;}
async function rootFile(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==0||info.mode&0o6022||await realpath(path)!==path)failed();return info;}

export async function prepareMediaAppArmorCI({base,evidence}){
 const report={qualified:false,scope:'fixed-/usr/bin/bwrap-and-capability-denied-child',source:MEDIA_APPARMOR};
 try{
  if(process.platform!=='linux'||process.getuid?.()!==0||process.env.CI!=='true'||!/^\/var\/lib\/coatria-media-ci-[a-f0-9-]+$/.test(base)||await realpath(base)!==base)failed();
  for(const path of [base,'/etc/apparmor.d','/etc/apparmor.d/local']){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||info.mode&0o022||await realpath(path)!==path)failed();}
  const before=await globals();report.globalBefore=before;if(before.enabled!=='Y'||before.restrictedUserns!=='1')failed();
  await rootFile('/usr/sbin/apparmor_parser');await rootFile('/usr/bin/bwrap');await access('/etc/apparmor.d/abi/4.0');
  report.loadedBefore=relevantLoadedProfiles(await text('/sys/kernel/security/apparmor/profiles'));
  // An on-disk hash cannot authenticate an already loaded kernel policy. This
  // fresh CI host must have neither target loaded; --add cannot replace one.
  if(report.loadedBefore.length)failed();
  // Download from signed APT indexes, but do not install unrelated package
  // profiles. The exact .deb and selected member must also match reviewed hashes.
  command('/usr/bin/apt-get',['download','apparmor-profiles='+MEDIA_APPARMOR.version],{cwd:base});
  const deb=join(base,'apparmor-profiles_'+MEDIA_APPARMOR.version+'_all.deb');const data=await readFile(deb);if(data.length!==MEDIA_APPARMOR.packageBytes||hash(data)!==MEDIA_APPARMOR.packageSha256)failed();
  const tar=command('/usr/bin/dpkg-deb',['--fsys-tarfile',deb]);const policy=assertReviewedProfile(command('/usr/bin/tar',['-xOf','-','./usr/share/apparmor/extra-profiles/bwrap-userns-restrict'],{input:tar,maxBuffer:8192}));
  report.downloadVerified=true;
  // Reject conflicting attachment/name declarations, unknown loaded target
  // profiles, local rule overrides and any disabled-force-complain override.
  const approved=[];let total=0;
  for(const name of await readdir('/etc/apparmor.d')){const path=join('/etc/apparmor.d',name),entry=await lstat(path),info=entry.isSymbolicLink()?await stat(path):entry;if(!info.isFile())continue;if(entry.isSymbolicLink()||info.uid!==0||info.mode&0o022||info.size>1024*1024)failed();total+=info.size;if(total>8*1024*1024)failed();const bytes=await readFile(path);if(hasBwrapDeclaration(bytes.toString('utf8'))){await rootFile(path);assertReviewedProfile(bytes);approved.push(path);}}
  for(const name of ['bwrap-userns-restrict','unpriv_bwrap']){try{const path=join('/etc/apparmor.d/local',name);await rootFile(path);if((await text(path)).split('\n').some(line=>line.replace(/#.*/,'').trim()))failed();}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(approved.length>1)failed();
  const policyPath=approved[0]??'/etc/apparmor.d/coatria-bwrap-userns-restrict';
  for(const directory of ['disable','force-complain'])for(const name of ['bwrap','bwrap-userns-restrict','coatria-bwrap-userns-restrict']){try{await lstat(join('/etc/apparmor.d',directory,name));failed();}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!approved.length)await writeFile(policyPath,policy,{mode:0o644,flag:'wx'});
  command('/usr/sbin/apparmor_parser',['--add','--skip-read-cache',policyPath]);
  report.loadedAfter=relevantLoadedProfiles(await text('/sys/kernel/security/apparmor/profiles'));
  if(!report.loadedAfter.some(value=>value.profile==='bwrap'&&value.mode==='enforce')||!report.loadedAfter.some(value=>value.profile==='unpriv_bwrap'&&value.mode==='enforce')||report.loadedAfter.some(value=>value.mode!=='enforce'))failed();
  report.globalAfter=await globals();if(JSON.stringify(report.globalAfter)!==JSON.stringify(before))failed();
  report.profilePath=policyPath;report.profileSha256=hash(await readFile(policyPath));report.parserVersion=command('/usr/sbin/apparmor_parser',['--version'],{encoding:'utf8',maxBuffer:8192}).split('\n')[0].replace(/[^A-Za-z0-9 .()+_-]/g,'').slice(0,120);report.activated=true;
  return report;
 }catch(error){report.failureCode='SCOPED_PROFILE_ACTIVATION_FAILED';throw error;}
 finally{await writeFile(join(evidence,'apparmor-policy.json'),JSON.stringify(report,null,2)+'\n',{mode:0o444});}
}
