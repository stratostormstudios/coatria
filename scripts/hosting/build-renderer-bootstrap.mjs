import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {nodeImage} from './build-runpod-bootstrap.mjs';
import {BLENDER_RELEASE} from './renderer-bootstrap-runtime.mjs';

export const RENDERER_SOURCE_PATHS=Object.freeze(['scripts/vfx/worker.mts','scripts/vfx/renderer.mts','scripts/vfx/manifest.mts','scripts/vfx/publish.mts','scripts/vfx/product_turntable.py','src/lib/studio-execution-protocol.ts','src/lib/studio-protocol.ts','src/lib/studio-generated-protocol.ts','public/downloads/agent-worker.mjs','scripts/hosting/run-renderer-host.mts','scripts/hosting/renderer-bootstrap-runtime.mjs','scripts/hosting/renderer-runtime/package.json','scripts/hosting/renderer-runtime/package-lock.json']);
/** Local artifact creation only: never provisions a Pod or embeds a credential. */
export async function buildRendererBootstrap({commit,root}){
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('A full reviewed commit SHA is required.');
 const manifest=[];
 for(const path of RENDERER_SOURCE_PATHS){const bytes=Buffer.from((await readFile(resolve(root,path),'utf8')).replaceAll('\r\n','\n'));if(bytes.length>1048576)throw Error('Renderer source exceeds its bound.');manifest.push({path,target:path.startsWith('scripts/hosting/renderer-runtime/')?path.split('/').at(-1):path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const source=`
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const manifest=${JSON.stringify(manifest)},commit=${JSON.stringify(commit)},release='/opt/coatria/renderer-releases/'+commit;
try{
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid()!==0)throw Error('LINUX_RUNTIME_REQUIRED');
 const expiry=Date.parse(process.env.COATRIA_RENDER_EXPIRES_AT||'');if(!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+86400000)throw Error('INVALID_EXPIRY');
 for(const folder of ['/opt/coatria','/opt/coatria/renderer-releases',release]){await mkdir(folder,{recursive:true,mode:0o755});const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)!==0||await realpath(folder)!==folder)throw Error('UNSAFE_RELEASE');}
 for(const entry of manifest){
  const target=release+'/'+entry.target;
  try{const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)!==0||info.size!==entry.bytes||createHash('sha256').update(await readFile(target)).digest('hex')!==entry.sha256)throw Error('EXISTING_SOURCE_INTEGRITY');continue;}catch(error){if(error.code!=='ENOENT')throw error;}
  const response=await fetch('https://raw.githubusercontent.com/stratostormstudios/coatria/'+commit+'/'+entry.path,{redirect:'error',signal:AbortSignal.timeout(Math.min(30000,Math.max(1,expiry-Date.now())))});if(!response.ok||!response.body)throw Error('SOURCE_UNAVAILABLE');
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>entry.bytes)throw Error('SOURCE_SIZE');chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  const content=Buffer.concat(chunks);if(bytes!==entry.bytes||createHash('sha256').update(content).digest('hex')!==entry.sha256)throw Error('SOURCE_INTEGRITY');
  await mkdir(dirname(target),{recursive:true,mode:0o755});if(await realpath(dirname(target))!==dirname(target))throw Error('SOURCE_DIRECTORY_UNSAFE');await writeFile(target,content,{flag:'wx',mode:0o444});
 }
 const {prepareRendererRuntime}=await import(pathToFileURL(release+'/scripts/hosting/renderer-bootstrap-runtime.mjs').href);const result=await prepareRendererRuntime({release,commit});process.exit(result.code??1);
}catch{console.error('COATRIA_RENDERER_BOOTSTRAP_FAILED');process.exit(1);}
`;
 return {image:nodeImage,blender:BLENDER_RELEASE,manifest,args:`node --input-type=module -e "import('data:text/javascript;base64,${Buffer.from(source).toString('base64')}').catch(()=>{console.error('COATRIA_RENDERER_BOOTSTRAP_FAILED');process.exit(1)})"`};
}
