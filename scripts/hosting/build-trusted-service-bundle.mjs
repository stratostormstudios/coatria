/** Offline bundling only. No provider, installation, credentials or npm calls. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {builtinModules} from 'node:module';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build,version as esbuildVersion} from 'esbuild';
import {nodeImage} from './build-runpod-bootstrap.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries=Object.freeze({archive:'scripts/higgsfield-remote-archive-worker.ts',gateway:'scripts/storage-gateway.ts','media-qualification':'scripts/hosting/qualify-vercel-media-service.mts'});
const compilerVersion='0.28.2',nativeStub='throw new Error("PG_NATIVE_DISABLED");';
const within=(root,path)=>{const value=relative(root,path);return value===''||!isAbsolute(value)&&value!=='..'&&!value.startsWith('../')&&!value.startsWith('..\\');};
function fail(){throw Error('TRUSTED_SERVICE_BUNDLE_REJECTED');}
function git(root,args){const result=spawnSync('git',['-c','safe.directory='+root,'-C',root,...args],{encoding:null,shell:false,timeout:30000,maxBuffer:16*1024**2,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,LANG:'C',LC_ALL:'C',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}});if(result.status!==0||result.error)fail();return result.stdout;}
async function readChecked(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16*1024**2||await realpath(path)!==resolve(path))fail();return readFile(path);}

/** Compilation is exposed for offline tests; its result is not deployable until
 * buildTrustedServiceBundle verifies the reviewed source commit and pins output. */
export async function compileTrustedService({root,service}){
 if(!Object.hasOwn(entries,service)||esbuildVersion!==compilerVersion)fail();root=await realpath(root);
 const lockBytes=await readChecked(join(root,'package-lock.json')),lock=JSON.parse(lockBytes);
 if(lock.packages?.['node_modules/esbuild']?.version!==compilerVersion||!/^sha512-[A-Za-z0-9+/=]+$/.test(lock.packages['node_modules/esbuild'].integrity??''))fail();
 const loaded=new Map();
 const result=await build({absWorkingDir:root,entryPoints:[entries[service]],bundle:true,platform:'node',format:'esm',target:'node24',tsconfigRaw:{},outfile:'runtime.mjs',write:false,metafile:true,logLevel:'silent',sourcemap:false,legalComments:'eof',minify:false,banner:{js:'import{createRequire as __coatriaCreateRequire}from"node:module";const require=__coatriaCreateRequire(import.meta.url);'},plugins:[{name:'coatria-pinned-inputs',setup(builder){builder.onResolve({filter:/^pg-native$/},()=>({path:'pg-native',namespace:'forbidden'}));builder.onLoad({filter:/.*/,namespace:'forbidden'},()=>({contents:nativeStub,loader:'js'}));builder.onLoad({filter:/.*/,namespace:'file'},async args=>{const absolute=resolve(args.path),extension=extname(absolute),loader={'.ts':'ts','.mts':'ts','.cts':'ts','.tsx':'tsx','.js':'js','.mjs':'js','.cjs':'js','.jsx':'jsx','.json':'json'}[extension];if(!within(root,absolute)||!loader)fail();const bytes=await readChecked(absolute),path=relative(root,absolute).replaceAll('\\','/');loaded.set(path,{path,bytes:bytes.length,sha256:hash(bytes),kind:path.startsWith('node_modules/')?'dependency':'source'});return {contents:bytes,loader,resolveDir:dirname(absolute)};});}}]});
 const builtins=new Set(builtinModules.flatMap(name=>[name,name.startsWith('node:')?name:'node:'+name]));
 if(result.outputFiles.length!==1||result.outputFiles[0].contents.length>8*1024**2||Object.values(result.metafile.outputs).some(output=>output.imports.some(item=>!item.external||!builtins.has(item.path))))fail();
 const inputs=[];
 for(const path of Object.keys(result.metafile.inputs).sort()){
  if(path==='forbidden:pg-native'){inputs.push({path,bytes:Buffer.byteLength(nativeStub),sha256:hash(nativeStub),kind:'reviewed-stub'});continue;}
  const absolute=resolve(root,path);if(!within(root,absolute)||path.includes('\\')||path.split('/').some(part=>part==='..'))fail();
  const bytes=await readChecked(absolute),snapshot=loaded.get(path);if(!snapshot||bytes.length!==snapshot.bytes||hash(bytes)!==snapshot.sha256)fail();inputs.push(snapshot);
 }
 if(inputs.length<1||inputs.length>2000||hash(await readChecked(join(root,'package-lock.json')))!==hash(lockBytes))fail();
 return {service,entry:entries[service],runtime:Buffer.from(result.outputFiles[0].contents),inputs,packageLockSha256:hash(lockBytes),compiler:{name:'esbuild',version:compilerVersion,packageIntegrity:lock.packages['node_modules/esbuild'].integrity},deployable:false};
}

export async function buildTrustedServiceBundle({root,commit,service,output}){
 if(!/^[a-f0-9]{40}$/.test(commit))fail();root=await realpath(root);const target=resolve(output);if(within(root,target)||await realpath(dirname(target))!==dirname(target))fail();
 if(git(root,['rev-parse','--verify',commit+'^{commit}']).toString().trim()!==commit)fail();const tree=git(root,['rev-parse',commit+'^{tree}']).toString().trim(),compiled=await compileTrustedService({root,service});
 // Verify every application input and build definition against actual Git bytes.
 const sources=[...compiled.inputs.filter(item=>item.kind==='source').map(item=>item.path),'package.json','package-lock.json','scripts/hosting/build-trusted-service-bundle.mjs','scripts/hosting/build-runpod-bootstrap.mjs','scripts/hosting/trusted-service-bootstrap-runtime.mjs'];
 for(const path of new Set(sources)){const mode=git(root,['ls-tree',commit,'--',path]).toString();if(!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(mode))fail();const checked=await readChecked(join(root,path)),committed=git(root,['show',commit+':'+path]),snapshot=compiled.inputs.find(item=>item.path===path);if(snapshot&&(checked.length!==snapshot.bytes||hash(checked)!==snapshot.sha256)||checked.includes(0)||committed.includes(0)||checked.toString('utf8').replaceAll('\r\n','\n')!==committed.toString('utf8').replaceAll('\r\n','\n'))fail();}
 const manifest={version:1,kind:'coatria-trusted-service-bundle',service,sourceCommit:commit,sourceTree:tree,image:nodeImage,nodeVersion:'v24.19.0',compiler:compiled.compiler,packageLockSha256:compiled.packageLockSha256,inputs:compiled.inputs,runtime:{path:'runtime.mjs',bytes:compiled.runtime.length,sha256:hash(compiled.runtime)},deployable:true,qualified:false};
 const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await mkdir(target,{mode:0o755});await writeFile(join(target,'runtime.mjs'),compiled.runtime,{flag:'wx',mode:0o444});await writeFile(join(target,'bundle.json'),manifestBytes,{flag:'wx',mode:0o444});
 return {output:target,bundleSha256:hash(manifestBytes),...manifest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const[root,commit,service,output,...extra]=process.argv.slice(2);if(extra.length||!output){console.error('Expected <source-root> <reviewed-commit> <archive|gateway> <new-output-directory>.');process.exitCode=1;}else buildTrustedServiceBundle({root,commit,service,output}).then(result=>console.log(JSON.stringify({output:result.output,bundleSha256:result.bundleSha256,service,sourceCommit:commit,qualified:false,providerCalled:false}))).catch(()=>{console.error('TRUSTED_SERVICE_BUNDLE_REJECTED');process.exitCode=1;});}
