/** Produces an operator-reviewed command from an existing pinned service bundle.
 * URLs and hashes are nonsecret release metadata; this performs no network work. */
import {createHash} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {nodeImage} from './build-runpod-bootstrap.mjs';
import {parseTrustedServiceBootstrap,trustedServiceRelease} from './trusted-service-bootstrap-runtime.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
function fail(){throw Error('TRUSTED_SERVICE_BOOTSTRAP_BUILD_REJECTED');}
async function file(path,max=256*1024**2){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<1||info.size>max||await realpath(path)!==resolve(path))fail();const content=await readFile(path);if(content.length!==info.size)fail();return content;}
export async function buildTrustedServiceBootstrap({root,bundleDirectory,bundleSha256,configuration,assetsBaseUrl,archive,mode='preflight'}){
 root=await realpath(root);bundleDirectory=await realpath(bundleDirectory);if(!/^[a-f0-9]{64}$/.test(bundleSha256))fail();
 const raw=await file(join(bundleDirectory,'bundle.json'),1024*1024);if(hash(raw)!==bundleSha256)fail();const bundle=JSON.parse(raw);
 if(bundle.version!==1||bundle.kind!=='coatria-trusted-service-bundle'||bundle.deployable!==true||bundle.qualified!==false||bundle.image!==nodeImage||bundle.nodeVersion!=='v24.19.0'||!['archive','gateway'].includes(bundle.service)||!/^[a-f0-9]{40}$/.test(bundle.sourceCommit)||bundle.runtime?.path!=='runtime.mjs')fail();
 const runtime=await file(join(bundleDirectory,'runtime.mjs'),8*1024**2);if(runtime.length!==bundle.runtime.bytes||hash(runtime)!==bundle.runtime.sha256)fail();
 const sourcePath='scripts/hosting/trusted-service-bootstrap-runtime.mjs',bootstrapBytes=Buffer.from((await file(join(root,sourcePath),128*1024)).toString().replaceAll('\r\n','\n'));
 const committed=spawnSync('git',['-C',root,'show',bundle.sourceCommit+':'+sourcePath],{shell:false,encoding:'utf8',maxBuffer:128*1024,timeout:30000,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}});if(committed.status!==0||bootstrapBytes.toString()!==committed.stdout.replaceAll('\r\n','\n'))fail();
 const configurationHash=hash(canonical(configuration)),scope=bundle.service==='archive'?configuration?.policy:configuration,release=trustedServiceRelease(bundle.service,bundle.sourceCommit);
 if(scope?.sourceCommit!==bundle.sourceCommit||typeof scope.expiresAt!=='string')fail();
 const files=[{...bundle.runtime},{path:'bundle.json',bytes:raw.length,sha256:bundleSha256}];
 if(bundle.service==='archive'){
  if(!archive||configuration.closure?.root!==release+'/closure'||configuration.qualification?.receiptPath!==release+'/qualification.json'||configuration.scratchRoot!=='/var/lib/coatria-archive-scratch')fail();
  const receipt=await file(resolve(archive.receiptPath),1024*1024);if(hash(receipt)!==configuration.qualification.sha256)fail();files.push({path:'qualification.json',bytes:receipt.length,sha256:hash(receipt),...archive.urls?.['qualification.json']?{url:archive.urls['qualification.json']}:{}});
  for(const entry of configuration.closure.files??[]){const path='closure/'+entry.path;if(!/^closure\/[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(path)||path.split('/').some(part=>part==='.'||part==='..'))fail();const bytes=await file(join(resolve(archive.closureRoot),entry.path));if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)fail();files.push({path,bytes:entry.bytes,sha256:entry.sha256,...archive.urls?.[path]?{url:archive.urls[path]}:{},...archive.auth?.[path]?{auth:archive.auth[path]}:{}});}
  if(archive.urls&&Object.keys(archive.urls).some(path=>!files.some(entry=>entry.path===path))||archive.auth&&Object.keys(archive.auth).some(path=>!files.some(entry=>entry.path===path)))fail();
 }else if(archive!==undefined)fail();
 const manifest=parseTrustedServiceBootstrap({version:1,service:bundle.service,sourceCommit:bundle.sourceCommit,configurationHash,expiresAt:scope.expiresAt,assetsBaseUrl,files,mode});
 const source=bootstrapBytes.toString()+'\nconst result=await runTrustedServiceBootstrap('+JSON.stringify(manifest)+');process.exit(result.code??1);\n';
 const args=`node --input-type=module -e "import('data:text/javascript;base64,${Buffer.from(source).toString('base64')}').catch(()=>{console.error('COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED');process.exit(1)})"`;
 if(args.length>100000)fail();return {image:nodeImage,args,bootstrapHash:hash(args),configurationHash,manifest,qualified:false,providerCalled:false};
}
