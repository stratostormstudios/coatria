import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Official Node 24.19.0 bookworm-slim, linux/amd64, verified 2026-09-17.
export const nodeImage='node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174';
const paths=['public/downloads/agent-worker.mjs','public/downloads/provider-adapter.mjs','scripts/hosting/run-company-worker.mjs'];

/** Bootstrap only reviewed commit-pinned source. Never accepts a task-supplied command. */
export async function buildRunpodBootstrap({commit,root}) {
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('A full reviewed commit SHA is required.');
  const manifest=[];
  for(const path of paths){
    // Git stores LF; normalize the Windows checkout to those exact published bytes.
    const content=(await readFile(resolve(root,path),'utf8')).replaceAll('\r\n','\n');
    manifest.push({path,sha256:createHash('sha256').update(content).digest('hex')});
  }
  const source=`
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,lstat,chown,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {spawn} from 'node:child_process';
const manifest=${JSON.stringify(manifest)}, commit=${JSON.stringify(commit)};
const release='/opt/coatria/releases/'+commit;
try {
  const expires=Date.parse(process.env.COATRIA_HOST_EXPIRES_AT||'');
  if(!Number.isFinite(expires)||expires<=Date.now()||expires-Date.now()>86400000)throw Error('INVALID_EXPIRY');
  const mount=await lstat('/state');
  if(!mount.isDirectory()||mount.isSymbolicLink()||mount.dev===(await stat('/')).dev)throw Error('PERSISTENT_MOUNT_REQUIRED');
  const directory='/state/avery';
  await mkdir(directory,{mode:0o700});
} catch(error) {
  if(error.code!=='EEXIST'){console.error('COATRIA_BOOTSTRAP_REJECTED');process.exit(1);}
}
try {
  const directory='/state/avery', info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('PRIVATE_STATE_REQUIRED');
  await chown(directory,1000,1000);await chmod(directory,0o700);
  for(const entry of manifest){
    const target=release+'/'+entry.path;
    // A stopped/restarted Pod may retain its writable container layer. Reuse
    // only the exact reviewed root-owned file; never overwrite an unknown one.
    try {
      const existing=await lstat(target);
      if(!existing.isFile()||existing.isSymbolicLink()||existing.uid!==0||(existing.mode&0o022)!==0||existing.size>1048576)throw Error('EXISTING_SOURCE_UNSAFE');
      if(createHash('sha256').update(await readFile(target)).digest('hex')!==entry.sha256)throw Error('EXISTING_SOURCE_INTEGRITY');
      continue;
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    const response=await fetch('https://raw.githubusercontent.com/stratostormstudios/coatria/'+commit+'/'+entry.path,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('SOURCE_UNAVAILABLE');
    const reader=response.body?.getReader();if(!reader)throw Error('SOURCE_UNAVAILABLE');
    const chunks=[];let size=0;
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1048576){void reader.cancel().catch(()=>{});throw Error('SOURCE_TOO_LARGE');}chunks.push(chunk.value);}
    const bytes=Buffer.concat(chunks);
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('SOURCE_INTEGRITY');
    await mkdir(dirname(target),{recursive:true,mode:0o755});
    await writeFile(target,bytes,{flag:'wx',mode:0o444});
  }
  const allowed=['COATRIA_AGENT_TOKEN','COATRIA_URL','RUNPOD_API_KEY','COATRIA_RUNPOD_ENDPOINT_ID','COATRIA_MAX_STEPS','COATRIA_MAX_OUTPUT_TOKENS','COATRIA_MAX_TOTAL_TOKENS','COATRIA_TIMEOUT_SECONDS','COATRIA_HOST_EXPIRES_AT','COATRIA_HOST_COMPANY_ID','COATRIA_HOST_AGENT_ID'];
  const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/node',COATRIA_HOST_STATE_DIR:'/state/avery'};
  for(const key of allowed)if(process.env[key])env[key]=process.env[key];
  process.setgroups([]);
  const child=spawn('/usr/local/bin/node',[release+'/scripts/hosting/run-company-worker.mjs'],{env,uid:1000,gid:1000,stdio:['ignore','inherit','inherit']});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
  child.on('error',()=>{console.error('COATRIA_HOST_START_FAILED');process.exit(1);});
  child.on('exit',(code)=>process.exit(code??1));
  console.log(JSON.stringify({event:'verified_cloud_bootstrap',commit,uid:1000,persistentState:true}));
} catch {console.error('COATRIA_BOOTSTRAP_FAILED');process.exit(1);}
`;
  const encoded=Buffer.from(source).toString('base64');
  return {image:nodeImage,manifest,args:`node --input-type=module -e "import('data:text/javascript;base64,${encoded}').catch(()=>{console.error('COATRIA_BOOTSTRAP_FAILED');process.exit(1)})"`};
}
