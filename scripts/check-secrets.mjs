import {execFileSync} from 'node:child_process';
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const patterns=[
  ['Vercel token',/\bvcp_[A-Za-z0-9]{20,}\b/],
  ['Meshy token',/\bmsy_[A-Za-z0-9]{20,}\b/],
  ['GitHub token',/\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained token',/\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['model provider key',/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/],
  ['Neon token',/\bnapi_[A-Za-z0-9_-]{20,}\b/],
  ['Supabase secret',/\b(?:sb_secret_|sbp_)[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Coatria scoped token',/\b(?:ca|cd|ci)_[A-Za-z0-9_-]{40,}\b/],
  ['private key',/-----BEGIN (?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN (?:PGP) PRIVATE KEY BLOCK-----/]
];

/** @param {string} path */
export function forbiddenPath(path){
  const name=path.replaceAll('\\','/');
  return (/(^|\/)\.env(?:\.|$)/i.test(name)&&!/(^|\/)\.env\.example$/i.test(name))||/(^|\/)(?:\.vercel|\.devdata)(?:\/|$)/i.test(name);
}

/** Return categories only; never include matching values in logs or test failures.
 * @param {string|Buffer} input @param {string} sourcePath */
export function detectSecrets(input,sourcePath=''){
  const contents=Buffer.isBuffer(input)?input.toString('utf8'):input;
  const findings=patterns.filter(([,pattern])=>pattern.test(contents)).map(([name])=>name);
  for(const match of contents.matchAll(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'`<>]+/gi)){
    const candidate=match[0];
    if(candidate.includes('${')&&sourcePath.startsWith('tests/')&&candidate.startsWith('postgresql://postgres:postgres@'))continue;
    try{
      const url=new URL(candidate);
      if(!url.password)continue;
      if(url.username==='USER'&&url.password==='PASSWORD'&&url.hostname.toLowerCase()==='host')continue;
      if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.username==='coatria_test'&&url.password==='local_ci_test_only'&&url.pathname==='/coatria_test')continue;
      findings.push('database credential URL');
    }catch{/* An incomplete expression is not a literal connection string. */}
  }
  for(const match of contents.matchAll(/^(?:\/\/[^\s]+:)?(?:_authToken|_auth)\s*=\s*([^\s#]+)/gm))if(!match[1].startsWith('${'))findings.push('package registry credential');
  return [...new Set(findings)];
}

/** @param {string} value */
function safeLabel(value){
  let label=value;
  for(const[,pattern]of patterns)label=label.replace(new RegExp(pattern.source,'g'),'[redacted]');
  return JSON.stringify(label.replace(/[\u0000-\u001f\u007f]/g,'?'));
}

/** @param {{cwd?:string,history?:boolean}} options */
export async function scanRepository({cwd=process.cwd(),history=false}={}){
  const git=(args)=>execFileSync('git',args,{cwd,maxBuffer:128*1024*1024,stdio:['ignore','pipe','pipe']});
  const failures=[],paths=[...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).toString('utf8').split('\0').filter(Boolean))];
  const checkedObjects=new Map();
  const inspect=(source,contents,path='')=>{
    const kinds=detectSecrets(contents,path);if(kinds.length)failures.push({source,kinds});
  };
  const inspectObject=(object,source,path='')=>{
    // Identical blobs can appear under different paths, whose path policy is
    // checked separately. Content is read once, then diagnosed per source.
    if(!checkedObjects.has(object))checkedObjects.set(object,git(['cat-file','-p',object]));
    inspect(source,checkedObjects.get(object),path);
  };
  for(const path of paths){
    if(forbiddenPath(path))failures.push({source:`worktree:${path}`,kinds:['local environment or deployment state']});
    try{
      const metadata=await lstat(resolve(cwd,path));
      if(metadata.isSymbolicLink()){failures.push({source:`worktree:${path}`,kinds:['unscanned symbolic link']});continue;}
      if(metadata.isFile())inspect(`worktree:${path}`,await readFile(resolve(cwd,path)),path);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const staged=git(['ls-files','--stage','-z']).toString('utf8').split('\0').filter(Boolean);
  for(const entry of staged){
    const match=/^\d+ ([a-f\d]+) \d\t([\s\S]+)$/.exec(entry);if(!match)throw new Error('Could not inspect the Git index.');
    const[,object,path]=match;if(forbiddenPath(path))failures.push({source:`index:${path}`,kinds:['local environment or deployment state']});
    inspectObject(object,`index:${path}`,path);
  }
  let historyObjects=0;
  if(history){
    if(git(['rev-parse','--is-shallow-repository']).toString('utf8').trim()==='true')throw new Error('History scan requires a complete checkout (fetch-depth: 0).');
    const revisions=git(['rev-list','--all']).toString('utf8').trim();
    if(revisions){
      const entries=git(['rev-list','--objects','--all']).toString('utf8').split('\n').filter(Boolean);
      for(const entry of entries){
        const split=entry.indexOf(' '),object=split<0?entry:entry.slice(0,split),path=split<0?'':entry.slice(split+1);
        if(!/^[a-f\d]{40,64}$/.test(object))throw new Error('Could not enumerate complete Git history.');
        if(path&&forbiddenPath(path))failures.push({source:`history:${object}`,kinds:['historical local environment or deployment state']});
        inspectObject(object,`history:${object}`,path);historyObjects++;
      }
    }
  }
  return{paths:paths.length,staged:staged.length,historyObjects,failures};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(args.some(arg=>arg!=='--history')){console.error('Usage: node scripts/check-secrets.mjs [--history]');process.exitCode=1;}
  else scanRepository({history:args.includes('--history')}).then(result=>{
    if(result.failures.length){
      console.error('Credential/local-state checks failed (matching values are never printed):');
      for(const failure of result.failures)console.error(`- ${safeLabel(failure.source)}: ${failure.kinds.join(', ')}`);
      process.exitCode=1;
    }else console.log(`Checked ${result.paths} working paths, ${result.staged} index entries and ${result.historyObjects} history objects: no recognized credentials or local environment files.`);
  }).catch(()=>{console.error('Secret scan could not complete. Check Git availability, repository state and file permissions.');process.exitCode=1;});
}
