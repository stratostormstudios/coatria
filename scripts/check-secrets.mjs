import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const patterns=[/\bvcp_[A-Za-z0-9]{20,}\b/,/\bmsy_[A-Za-z0-9]{20,}\b/,/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,/\bsk-ant-[A-Za-z0-9_-]{20,}\b/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const failures=[];
for(const path of [...new Set(paths)]){
  if(/\.(?:png|webp|jpg|glb|woff2?)$/i.test(path))continue;
  const contents=await readFile(path,'utf8');
  if(patterns.some(pattern=>pattern.test(contents)))failures.push(path);
  if(/^\.env(?:\.|$)/.test(path)&&path!=='.env.example')failures.push(path);
  if(path.startsWith('.vercel/')||path.startsWith('.devdata/'))failures.push(path);
}
if(failures.length){console.error('Possible credentials or local state found in: '+[...new Set(failures)].join(', '));process.exitCode=1;}
else console.log(`Checked ${new Set(paths).size} source paths: no recognized provider credentials or local environment files.`);
