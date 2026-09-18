import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {nodeImage} from './build-runpod-bootstrap.mjs';

const paths=['public/downloads/agent-worker.mjs','public/downloads/provider-adapter.mjs','scripts/hosting/run-studio-host.mjs'];
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function studioHostStateDirectory(companyId,hostId){
 if(![companyId,hostId].every(id=>typeof id==='string'&&uuidPattern.test(id)))throw Error('Pinned company and host UUIDs are required.');
 return '/state/studio/'+companyId.toLowerCase()+'/'+hostId.toLowerCase();
}
// A source literal keeps the reviewed hash identical under native Node and
// TypeScript loaders; Function#toString would reflect loader transformations.
const stateDirectorySource=`function studioHostStateDirectory(companyId,hostId){if(![companyId,hostId].every(id=>typeof id==='string'&&${uuidPattern}.test(id)))throw Error('Pinned company and host UUIDs are required.');return '/state/studio/'+companyId.toLowerCase()+'/'+hostId.toLowerCase();}`;

/** Produces a reviewed immutable bootstrap, never a model-supplied command.
 * The caller provisions CPU/durable storage separately; this builder spends nothing.
 */
export async function buildStudioBootstrap({commit,root}){
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('A full reviewed commit SHA is required.');
 const manifest=[];for(const path of paths){const bytes=(await readFile(resolve(root,path),'utf8')).replaceAll('\r\n','\n');manifest.push({path,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const source=`
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,lstat,chown,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {spawn} from 'node:child_process';
const manifest=${JSON.stringify(manifest)},commit=${JSON.stringify(commit)};
const release='/opt/coatria/releases/'+commit;
const studioHostStateDirectory=${stateDirectorySource};
try {
 const directory=studioHostStateDirectory(process.env.COATRIA_HOST_COMPANY_ID,process.env.COATRIA_HOST_ID);
 const expires=Date.parse(process.env.COATRIA_HOST_EXPIRES_AT||'');
 if(!Number.isFinite(expires)||expires<=Date.now()||expires-Date.now()>86400000)throw Error('INVALID_EXPIRY');
 const mount=await lstat('/state');
 if(!mount.isDirectory()||mount.isSymbolicLink()||mount.dev===(await stat('/')).dev)throw Error('PERSISTENT_MOUNT_REQUIRED');
 // Each reviewed host receives a new namespace. Old expired-host journals,
 // including the historical /state/studio root journal, remain untouched.
 for(const folder of ['/state/studio',dirname(directory),directory]){
  await mkdir(folder,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw Error('PRIVATE_STATE_REQUIRED');
  await chown(folder,1000,1000);await chmod(folder,0o700);
 }
 for(const entry of manifest){
  const target=release+'/'+entry.path;
  try{
   const existing=await lstat(target);
   if(!existing.isFile()||existing.isSymbolicLink()||existing.uid!==0||(existing.mode&0o022)!==0||existing.size>1048576)throw Error('EXISTING_SOURCE_UNSAFE');
   if(createHash('sha256').update(await readFile(target)).digest('hex')!==entry.sha256)throw Error('EXISTING_SOURCE_INTEGRITY');
   continue;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const response=await fetch('https://raw.githubusercontent.com/stratostormstudios/coatria/'+commit+'/'+entry.path,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('SOURCE_UNAVAILABLE');
  const reader=response.body?.getReader();if(!reader)throw Error('SOURCE_UNAVAILABLE');
  const chunks=[];let size=0;
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1048576){void reader.cancel().catch(()=>{});throw Error('SOURCE_TOO_LARGE');}chunks.push(part.value);}
  const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('SOURCE_INTEGRITY');
  await mkdir(dirname(target),{recursive:true,mode:0o755});await writeFile(target,bytes,{flag:'wx',mode:0o444});
 }
 const allowed=['COATRIA_HOST_TOKEN','COATRIA_URL','COATRIA_HOST_ID','COATRIA_HOST_COMPANY_ID','COATRIA_HOST_MODEL_ID','COATRIA_HOST_CONCURRENCY','COATRIA_HOST_EXPIRES_AT','RUNPOD_API_KEY','COATRIA_RUNPOD_ENDPOINT_ID','COATRIA_MAX_STEPS','COATRIA_MAX_OUTPUT_TOKENS','COATRIA_MAX_TOTAL_TOKENS','COATRIA_TIMEOUT_SECONDS'];
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/node',COATRIA_HOST_STATE_DIR:directory};
 for(const key of allowed)if(process.env[key])env[key]=process.env[key];
 process.setgroups([]);
 const child=spawn('/usr/local/bin/node',[release+'/scripts/hosting/run-studio-host.mjs'],{env,uid:1000,gid:1000,stdio:['ignore','inherit','inherit']});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
 child.on('error',()=>{console.error('COATRIA_STUDIO_START_FAILED');process.exit(1);});child.on('exit',code=>process.exit(code??1));
 console.log(JSON.stringify({event:'verified_studio_bootstrap',commit,uid:1000,persistentState:true}));
}catch{console.error('COATRIA_STUDIO_BOOTSTRAP_FAILED');process.exit(1);}
`;
 const encoded=Buffer.from(source).toString('base64');
 return{image:nodeImage,manifest,args:`node --input-type=module -e "import('data:text/javascript;base64,${encoded}').catch(()=>{console.error('COATRIA_STUDIO_BOOTSTRAP_FAILED');process.exit(1)})"`};
}
