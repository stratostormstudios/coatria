/** Reviewed root bootstrap. Only pinned bytes enter immutable release paths;
 * only the separately scoped service child receives its required credentials. */
import {createHash} from 'node:crypto';
import {open,readFile,lstat,mkdir,rename,realpath,chown,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {spawn} from 'node:child_process';
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const fail=()=>{throw Error('COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED');};
export const TRUSTED_PRIVATE_ARTIFACT_HOST='w3g7pnchlhdmqpb5.private.blob.vercel-storage.com';
function publicArtifactUrl(value){let url;try{url=new URL(value);}catch{fail();}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.hostname.includes('.')||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.includes(':')||/^\d+(?:\.\d+){3}$/.test(url.hostname)||url.href!==value)fail();return url;}
export function trustedServiceRelease(service,sourceCommit){if(!['archive','gateway'].includes(service)||!commit(sourceCommit))fail();return '/opt/coatria/trusted-services/'+service+'/'+sourceCommit;}
export function parseTrustedServiceBootstrap(value){
 if(!exact(value,['version','service','sourceCommit','configurationHash','expiresAt','assetsBaseUrl','files','mode'])||value.version!==1||!['archive','gateway'].includes(value.service)||!commit(value.sourceCommit)||!hash(value.configurationHash)||!['preflight','service'].includes(value.mode)||typeof value.expiresAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.expiresAt)||!Number.isFinite(Date.parse(value.expiresAt)))fail();
 const url=publicArtifactUrl(value.assetsBaseUrl);if(!url.pathname.endsWith('/'))fail();
 if(!Array.isArray(value.files)||value.files.length<2||value.files.length>68)fail();let total=0;const names=new Set();
 for(const file of value.files){if(!exact(file,['path','bytes','sha256',...Object.hasOwn(file??{},'url')?['url']:[],...Object.hasOwn(file??{},'auth')?['auth']:[]])||typeof file.path!=='string'||file.path.length>100||!['runtime.mjs','bundle.json','qualification.json'].includes(file.path)&&!/^closure\/[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(file.path)||file.path.split('/').some(part=>part==='.'||part==='..')||names.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>256*1024**2||!hash(file.sha256))fail();const location=file.url!==undefined?publicArtifactUrl(file.url):undefined;if(file.auth!==undefined&&(value.service!=='archive'||file.auth!=='vercel-project-oidc'||!file.path.startsWith('closure/')||location?.hostname!==TRUSTED_PRIVATE_ARTIFACT_HOST))fail();names.add(file.path);total+=file.bytes;}
 if(total>272*1024**2||!names.has('runtime.mjs')||!names.has('bundle.json')||value.files.find(file=>file.path==='runtime.mjs').bytes>8*1024**2||value.files.find(file=>file.path==='bundle.json').bytes>1024*1024)fail();
 if(value.service==='gateway'&&names.size!==2||value.service==='archive'&&(!names.has('qualification.json')||!names.has('closure/bin/ffmpeg')||!names.has('closure/bin/ffprobe')))fail();
 return Object.freeze({...value,files:Object.freeze(value.files.map(file=>Object.freeze({...file})))});
}
/** @param {any} manifest @param {Readonly<Record<string,string|undefined>>} settings */
export function trustedServiceChildEnvironment(manifest,settings=process.env){
 manifest=parseTrustedServiceBootstrap(manifest);let configuration;try{configuration=JSON.parse(settings.COATRIA_SERVICE_CONFIGURATION??'');}catch{fail();}
 if(sha(canonical(configuration))!==manifest.configurationHash||settings.COATRIA_SERVICE_CONFIGURATION_SHA256!==manifest.configurationHash||settings.COATRIA_SERVICE_KIND!==manifest.service||settings.COATRIA_SERVICE_SOURCE_COMMIT!==manifest.sourceCommit||settings.COATRIA_SERVICE_EXPIRES_AT!==manifest.expiresAt)fail();
 const scope=manifest.service==='archive'?configuration.policy:configuration;
 if(!scope||scope.sourceCommit!==manifest.sourceCommit||scope.expiresAt!==manifest.expiresAt||!Array.isArray(scope.projectIds)||scope.projectIds.length<1)fail();
 const release=trustedServiceRelease(manifest.service,manifest.sourceCommit);
 if(manifest.service==='archive'&&(configuration.closure?.root!==release+'/closure'||configuration.qualification?.receiptPath!==release+'/qualification.json'||configuration.qualification?.sha256!==manifest.files.find(file=>file.path==='qualification.json').sha256||configuration.scratchRoot!=='/var/lib/coatria-archive-scratch'))fail();
 if(manifest.service==='gateway'&&(configuration.host!=='0.0.0.0'||configuration.port!==4190||configuration.appOrigin!=='https://coatria.com'))fail();
 let database;try{database=new URL(settings.DATABASE_URL??'');}catch{fail();}
 const role=manifest.service==='archive'?'coatria_higgsfield_archive_worker_v1':'coatria_storage_gateway_v1';
 if(!['postgres:','postgresql:'].includes(database.protocol)||decodeURIComponent(database.username)!==role||!database.password||database.hash||database.searchParams.get('sslmode')!=='require')fail();
 let ring;try{ring=JSON.parse(settings.COATRIA_HOSTING_KEYRING??'');}catch{fail();}if(!ring?.keys?.[ring.activeKeyId])fail();
 const env=/** @type {Record<string,string>} */({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/node',LANG:'C.UTF-8',NODE_ENV:'production',DATABASE_URL:settings.DATABASE_URL,COATRIA_HOSTING_KEYRING:settings.COATRIA_HOSTING_KEYRING});
 if(manifest.service==='archive'){const token=settings.COATRIA_VERCEL_MEDIA_TOKEN;if(typeof token!=='string'||token.length<8||token.length>4096||/[\r\n]/.test(token)||settings.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED!=='true')fail();env.COATRIA_VERCEL_MEDIA_TOKEN=token;env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';}
 else{const provisionId=settings.COATRIA_SERVICE_PROVISION_ID;if(typeof provisionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provisionId))fail();env.COATRIA_SERVICE_PROVISION_ID=provisionId;env.APP_URL='https://coatria.com';env.HOST='0.0.0.0';env.PORT='4190';}
 return {env,configuration,configurationBytes:Buffer.from(canonical(configuration)),release};
}
async function rootDirectory(path){await mkdir(path,{recursive:true,mode:0o755});let current=path;for(;;){const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)||await realpath(current)!==current)fail();const parent=dirname(current);if(parent===current)break;current=parent;}}
async function verifiedExisting(path,file){try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==0||(info.mode&0o222)||info.size!==file.bytes||sha(await readFile(path))!==file.sha256)fail();return true;}catch(error){if(error.code!=='ENOENT')throw error;return false;}}
async function download(file,manifest,release,signal){
 const path=release+'/'+file.path;await rootDirectory(dirname(path));if(await verifiedExisting(path,file))return;
 const temporary=path+'.partial',handle=await open(temporary,'wx',0o600);let reader;
 try{const headers=trustedServiceArtifactHeaders(file,manifest.service,process.env);const response=await fetch(file.url??new URL(file.path,manifest.assetsBaseUrl),{redirect:'error',headers,signal});if(!response.ok||!response.body)fail();reader=response.body.getReader();const digest=createHash('sha256');let bytes=0;
  for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>file.bytes)fail();digest.update(next.value);await handle.writeFile(next.value);}
  if(bytes!==file.bytes||digest.digest('hex')!==file.sha256)fail();await handle.sync();await handle.chmod(0o444);await handle.close();await rename(temporary,path);
 }finally{if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}await handle.close().catch(()=>{});}
}
/** @param {any} file @param {string} service @param {Readonly<Record<string,string|undefined>>} settings */
export function trustedServiceArtifactHeaders(file,service,settings=process.env){if(file.auth===undefined)return {};if(service!=='archive'||file.auth!=='vercel-project-oidc'||!file.path.startsWith('closure/')||publicArtifactUrl(file.url).hostname!==TRUSTED_PRIVATE_ARTIFACT_HOST)fail();const token=settings.COATRIA_VERCEL_MEDIA_TOKEN;if(typeof token!=='string'||token.length<8||token.length>4096||/[\r\n]/.test(token))fail();return {Authorization:'Bearer '+token};}
/** Absolute expiry stops the entire child process group, with bounded grace for
 * the archive executor's independent provider cleanup and durable journal. */
export function superviseTrustedService(child,signal,{graceMs=35000,killMs=5000,killGroup=(pid,kind)=>{process.kill(-pid,kind);},groupExists=pid=>{try{process.kill(-pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}}={}){
 if(!Number.isInteger(graceMs)||graceMs<1||graceMs>35000||!Number.isInteger(killMs)||killMs<1||killMs>5000)fail();
 return new Promise(resolve=>{let grace,kill,poll,ended=false,stopping=false,forced=false,leaderExited=false,exitCode=1,exitSignal=null;
  const finish=confirmed=>{if(ended)return;ended=true;clearTimeout(grace);clearTimeout(kill);clearInterval(poll);signal.removeEventListener('abort',stop);child.removeListener('exit',exited);child.removeListener('error',errored);resolve({code:forced?1:exitCode??1,signal:exitSignal,forced,terminationConfirmed:confirmed});};
  const absent=()=>{try{return !!child.pid&&!groupExists(child.pid);}catch{return false;}};
  const settle=()=>{if(leaderExited&&absent()){finish(true);return true;}return false;};
  const send=kind=>{try{if(child.pid)killGroup(child.pid,kind);else child.kill(kind);}catch{try{child.kill(kind);}catch{}}};
  const stop=()=>{if(ended||stopping)return;stopping=true;send('SIGTERM');if(settle())return;poll=setInterval(settle,Math.min(25,killMs));grace=setTimeout(()=>{forced=true;send('SIGKILL');if(!settle())kill=setTimeout(()=>{if(!settle())finish(false);},killMs);},graceMs);};
  const exited=(code,sig)=>{leaderExited=true;exitCode=code;exitSignal=sig;if(!settle())stop();};
  const errored=()=>{if(!child.pid)finish(false);else stop();};child.once('exit',exited);child.once('error',errored);signal.addEventListener('abort',stop,{once:true});if(child.exitCode!==null||child.signalCode!==null)exited(child.exitCode,child.signalCode);else if(signal.aborted)stop();
 });
}
export async function runTrustedServiceBootstrap(input){
 const manifest=parseTrustedServiceBootstrap(input);if(process.platform!=='linux'||process.arch!=='x64'||process.version!=='v24.19.0'||process.getuid?.()!==0)fail();
 const {env,configurationBytes,release}=trustedServiceChildEnvironment(manifest),expiry=Date.parse(manifest.expiresAt);if(expiry<=Date.now()||expiry-Date.now()>86400000)fail();
 const control=new AbortController(),stop=()=>control.abort(),timer=setTimeout(stop,Math.max(1,expiry-Date.now()));process.once('SIGTERM',stop);process.once('SIGINT',stop);let child;
 try{
  await rootDirectory(release);
  const deadline=AbortSignal.any([control.signal,AbortSignal.timeout(600000)]);for(const file of manifest.files){deadline.throwIfAborted();await download(file,manifest,release,deadline);}
  const configFile={bytes:configurationBytes.length,sha256:manifest.configurationHash},path=release+'/configuration.json';if(!await verifiedExisting(path,configFile)){const handle=await open(path,'wx',0o444);try{await handle.writeFile(configurationBytes);await handle.sync();}finally{await handle.close();}}
  if(manifest.service==='archive'){const scratch='/var/lib/coatria-archive-scratch';await rootDirectory(dirname(scratch));await mkdir(scratch,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(scratch);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(scratch)!==scratch)fail();await chown(scratch,1000,1000);await chmod(scratch,0o700);}
  deadline.throwIfAborted();process.setgroups([]);child=spawn('/usr/local/bin/node',[release+'/runtime.mjs','--config',path,'--sha256',manifest.configurationHash,...manifest.mode==='preflight'?['--preflight']:[]],{cwd:release,env,uid:1000,gid:1000,detached:true,stdio:['ignore','inherit','inherit'],shell:false});
  const result=await superviseTrustedService(child,control.signal);if(!result.terminationConfirmed||result.forced)console.error('COATRIA_TRUSTED_SERVICE_FORCED_STOP');return result;
 }finally{clearTimeout(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
