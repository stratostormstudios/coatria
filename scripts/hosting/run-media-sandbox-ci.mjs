// CI-only root entry. Enter this one delegated service before dropping identity;
// never grant a worker write access to the host's root cgroup.procs.
import {lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.env.CI!=='true')throw Error('Explicit root Linux CI launch required.');
const path=process.env.COATRIA_MEDIA_QUALIFICATION;
if(!path||!/^\/opt\/coatria-media-ci-[a-f0-9-]+\/qualification\.json$/.test(path)||await realpath(path)!==path)throw Error('Invalid CI qualification path.');
const stat=await lstat(path);if(!stat.isFile()||stat.uid!==0||stat.mode&0o022)throw Error('CI qualification must be immutable to the worker.');
const config=JSON.parse(await readFile(path,'utf8'));
if(!Number.isInteger(config.uid)||config.uid<1||!Number.isInteger(config.gid)||config.gid<1||!/^\/sys\/fs\/cgroup\/coatria-media-ci-[a-f0-9-]+$/.test(config.serviceRoot)||config.supervisorGroup!==config.serviceRoot+'/supervisor'||config.cgroupRoot!==config.serviceRoot+'/decoders')throw Error('Invalid delegated CI service.');
await writeFile(config.supervisorGroup+'/cgroup.procs',String(process.pid));
process.setgroups([]);process.setgid(config.gid);process.setuid(config.uid);
if(process.getuid()===0||process.getgid()===0)throw Error('CI privilege drop failed.');
const child=spawn(process.execPath,['--import','tsx',resolve('scripts/hosting/media-sandbox-linux-canary.mts')],{shell:false,stdio:'inherit',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',CI:'true',COATRIA_MEDIA_QUALIFICATION:path}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{process.exitCode=1;});child.on('exit',(code)=>{process.exitCode=code??1;});
