/** Finite credential-free hosted image worker. Root-installed source and an
 * independently accepted current-host receipt precede any metadata request.
 * Enrollment/activation are separate; preflight never claims tenant work. */
import {createHash} from 'node:crypto';
import {lstat,opendir,readFile,readdir,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createLinuxMediaSandbox} from '../../src/lib/higgsfield-media-sandbox';
import {createLinuxImagePreparationTransform,isQualifiedLinuxImagePreparationTransform} from '../../src/lib/project-image-preparation-sandbox';
import {createProjectImagePreparationWorkerCore,type ProjectImagePreparationWorkerResult} from '../../src/lib/project-image-preparation-worker-core';
import {createImagePreparationServiceClient,type ImagePreparationServiceClient} from '../../src/lib/project-image-preparation-service-client';
import {archiveHostTrusted,archiveHostRead,archiveHostFileHash,archiveHostNoExtendedAcls} from './archive-host-package.mjs';
import {readImagePreparationHostConfiguration} from './image-preparation-host-package.mjs';
import {initializeImagePreparationHostDelegation} from './image-preparation-host-delegation.mjs';
import {imagePreparationRunnerFailure as bad,parseImagePreparationHostConfiguration,parseImagePreparationRunnerConfiguration,deriveImagePreparationRunnerConfiguration,assertImagePreparationRunnerReceipt,parseImagePreparationRunnerToken,imagePreparationRunnerProcessor,imagePreparationRunnerConfigurationHash,type ImagePreparationRunnerConfiguration} from './image-preparation-runner-configuration.mjs';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function assertImagePreparationRunnerEnvironment(settings:Readonly<Record<string,string|undefined>>){
 for(const [name,value]of Object.entries(settings))if(value&&(/(?:DATABASE_URL|PGPASSWORD|KEYRING|API_KEY|ACCESS_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|CREDENTIAL|AWS_PROFILE|AWS_CONFIG_FILE)/i.test(name)||['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','LD_PRELOAD','LD_LIBRARY_PATH'].includes(name)))bad();
}
/** Keep unresolved bytes intact across process restarts. Never enumerate or
 * automatically remove a predecessor's private scratch. */
export async function assertImagePreparationRunnerScratchEmpty(path:string){
 try{const directory=await opendir(path);try{if(await directory.read()!==null)bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');}finally{await directory.close();}}catch{bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');}
}
async function privateDirectory(path:string,c:ImagePreparationRunnerConfiguration){
 await archiveHostTrusted(dirname(path),true);const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||info.uid!==c.uid||info.gid!==c.gid||(info.mode&0o7777)!==0o700)bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');archiveHostNoExtendedAcls([path]);await assertImagePreparationRunnerScratchEmpty(path);
}
export async function drainImagePreparationRunnerClients(clients:Set<Pick<ImagePreparationServiceClient,'close'|'drain'>>){
 let failed=false;for(const client of clients)try{client.close();}catch{failed=true;}
 const results=await Promise.allSettled([...clients].map(client=>Promise.resolve().then(()=>client.drain())));
 if(failed||results.some(result=>result.status==='rejected'))bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');clients.clear();
}
/** Local cleanup is independent of an uncertain remote transaction. Never emit
 * its proof from a finally block until every actual resource has settled. */
export async function assertImagePreparationRunnerDescendantsEmpty(cgroupRoot:string){
 try{
  const info=await lstat(cgroupRoot);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(cgroupRoot)!==cgroupRoot)bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');
  if((await readFile(cgroupRoot+'/cgroup.procs','utf8')).trim()!=='')bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');
  const events=(await readFile(cgroupRoot+'/cgroup.events','utf8')).trim().split('\n');
  if(events.filter(line=>line.startsWith('populated ')).length!==1||!events.includes('populated 0'))bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');
  for(const entry of await readdir(cgroupRoot,{withFileTypes:true}))if(entry.isDirectory()||entry.isSymbolicLink())bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');
 }catch{bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');}
}
export async function finishImagePreparationRunnerSession(input:{clients:Set<Pick<ImagePreparationServiceClient,'close'|'drain'>>;verifyScratch:()=>Promise<void>;verifyTemporary:()=>Promise<void>;verifyDescendants:()=>Promise<void>;emit:()=>void}){
 await drainImagePreparationRunnerClients(input.clients);
 // Check all three, without reporting success when any check fails.
 const results=await Promise.allSettled([input.verifyScratch,input.verifyTemporary,input.verifyDescendants].map(verify=>Promise.resolve().then(verify)));
 if(results.some(result=>result.status==='rejected'))bad('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');
 input.emit();
}
/** The same disposable readiness client is drained before preflight returns or
 * the first work client can be constructed. This path has no claim operation. */
export async function preflightImagePreparationRunnerClient(client:Pick<ImagePreparationServiceClient,'readiness'|'close'|'drain'>,signal:AbortSignal){
 const clients=new Set([client]);try{if(signal.aborted)bad('IMAGE_PREPARATION_RUNNER_STOPPED');await client.readiness(signal);}finally{await drainImagePreparationRunnerClients(clients);}if(signal.aborted)bad('IMAGE_PREPARATION_RUNNER_STOPPED');
}
/** Sequential admission only. Always drain the actual attempt, even when the
 * worker throws or cancellation occurs. No failed/uncertain claim is retried. */
export async function runImagePreparationWorkerLoop(worker:{runNext:(input:{signal:AbortSignal})=>Promise<ProjectImagePreparationWorkerResult>},input:{signal:AbortSignal;afterAttempt:()=>Promise<void>;onResult?:(result:ProjectImagePreparationWorkerResult)=>void;idleMs?:number}){
 const idleMs=input.idleMs??2000;if(!Number.isSafeInteger(idleMs)||idleMs<1||idleMs>5000)bad();
 while(!input.signal.aborted){
  let result:ProjectImagePreparationWorkerResult;
  try{result=await worker.runNext({signal:input.signal});}finally{await input.afterAttempt();}
  input.onResult?.(result);
  if(result.status!=='idle'&&result.status!=='ready'||result.status==='idle'&&result.processed||result.status==='ready'&&!result.processed)bad('IMAGE_PREPARATION_RUNNER_STOPPED');
  if(!input.signal.aborted)await delay(idleMs,undefined,{signal:input.signal}).catch(error=>{if(!input.signal.aborted)throw error;});
 }
}
export async function readImagePreparationRunnerToken(c:ImagePreparationRunnerConfiguration){
 const path=`/etc/coatria-image-preparation/${c.serviceId}/service-token.json`;await archiveHostTrusted(path);const info=await lstat(path);
 if(info.uid!==0||info.gid!==c.gid||(info.mode&0o7777)!==0o640)bad();
 let value:unknown;try{value=JSON.parse((await archiveHostRead(path,4096)).toString('utf8'));}catch{bad();}return parseImagePreparationRunnerToken(value,c);
}
export function assertImagePreparationRunnerActivation(input:unknown,c:ImagePreparationRunnerConfiguration){
 const expected={version:1,serviceId:c.serviceId,configurationSha256:imagePreparationRunnerConfigurationHash(c),qualificationSha256:c.qualification.sha256,expiresAt:c.expiresAt};
 if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!==Object.keys(expected).sort().join(',')||Object.entries(expected).some(([key,value])=>(input as Record<string,unknown>)[key]!==value))bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');
}
export async function runImagePreparationWorker(args:readonly string[],settings:Readonly<Record<string,string|undefined>>=process.env){
 if(args.length!==4&&args.length!==5||args[0]!=='--host'||args[2]!=='--bundle'||args.length===5&&args[4]!=='--preflight'||!/^[a-f0-9]{64}$/.test(args[3]??'')||process.platform!=='linux'||process.arch!=='x64'||process.version!=='v24.19.0'||!process.getuid||process.getuid()===0||!process.getgid||process.getgid()===0||process.getgroups?.().some(gid=>gid!==process.getgid!()))bad();
 assertImagePreparationRunnerEnvironment(settings);
 const preflight=args.length===5,{host:rawHost,hostBytes}=await readImagePreparationHostConfiguration(args[1],args[3],{trusted:true}),host=parseImagePreparationHostConfiguration(rawHost);
 if(args[1]!==`/etc/coatria-image-preparation/${host.scope.serviceId}/host.json`||host.bundleSha256!==args[3]||host.uid!==process.getuid!()||host.gid!==process.getgid!()||await realpath(process.execPath)!==host.node.path||(await archiveHostFileHash(host.node.path)).sha256!==host.node.sha256)bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');
 const receiptPath=`/etc/coatria-image-preparation/${host.scope.serviceId}/qualified.json`;await archiveHostTrusted(receiptPath);const receiptBytes=await archiveHostRead(receiptPath,65536),hostConfigurationSha256=hash(hostBytes);
 const c=parseImagePreparationRunnerConfiguration(deriveImagePreparationRunnerConfiguration(host,hostConfigurationSha256,hash(receiptBytes)));
 await archiveHostTrusted(c.runtimePath);if(await realpath(fileURLToPath(import.meta.url))!==c.runtimePath||hash(await archiveHostRead(c.runtimePath,8*1024**2))!==c.releaseSha256)bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');
 let receipt:unknown;try{receipt=JSON.parse(receiptBytes.toString('utf8'));}catch{bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');}
 assertImagePreparationRunnerReceipt(receipt,c,{bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),uid:process.getuid!(),gid:process.getgid!(),hostConfigurationSha256,host});
 if(!preflight){const marker=`/etc/coatria-image-preparation/${c.serviceId}/worker-enabled`;await archiveHostTrusted(marker);let enabled:unknown;try{enabled=JSON.parse((await archiveHostRead(marker,4096)).toString('utf8'));}catch{bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');}assertImagePreparationRunnerActivation(enabled,c);}
 await privateDirectory(c.scratchRoot,c);await privateDirectory(c.temporaryRoot,c);
 const token=await readImagePreparationRunnerToken(c),stop=new AbortController(),shutdown=()=>stop.abort(),timer=setTimeout(shutdown,Math.max(1,Date.parse(c.expiresAt)-Date.now())),clients=new Set<ImagePreparationServiceClient>(),oldTmp=process.env.TMPDIR;
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);process.env.TMPDIR=c.temporaryRoot;
 const current=()=>{if(Date.now()>=Date.parse(c.expiresAt))stop.abort();if(stop.signal.aborted)bad('IMAGE_PREPARATION_RUNNER_STOPPED');};
 const client=()=>{current();const value=createImagePreparationServiceClient({...c,token,processor:imagePreparationRunnerProcessor(c)});clients.add(value);return value;};
 const evidence={serviceId:c.serviceId,sourceCommit:c.sourceCommit,configurationSha256:imagePreparationRunnerConfigurationHash(c),qualificationSha256:c.qualification.sha256};
 let delegated:Awaited<ReturnType<typeof initializeImagePreparationHostDelegation>>|undefined,preflightPassed=false;
 try{
  const paths=await initializeImagePreparationHostDelegation(c.serviceId,preflight?'preflight':'worker');delegated=paths;current();
  const sandbox=await createLinuxMediaSandbox({profilePath:c.profilePath,expectedProfileSha256:c.profileSha256,cgroupRoot:paths.cgroupRoot});current();
  const transform=await createLinuxImagePreparationTransform({sandbox,expectedProfileSha256:c.profileSha256,recipeSha256:c.recipeSha256});current();
  if(!isQualifiedLinuxImagePreparationTransform(transform))bad('IMAGE_PREPARATION_RUNNER_UNQUALIFIED');
  await preflightImagePreparationRunnerClient(client(),stop.signal);clients.clear();current();
  if(preflight){preflightPassed=true;return;}
  const worker=createProjectImagePreparationWorkerCore({scope:{companyId:c.companyId,projectIds:c.projectIds},scratchRoot:c.scratchRoot,transform,createPorts:client});
  console.log(JSON.stringify({event:'image-preparation-worker-ready',...evidence,workClaimed:false,providerCalled:false}));
  await runImagePreparationWorkerLoop(worker,{signal:stop.signal,afterAttempt:()=>drainImagePreparationRunnerClients(clients),onResult:r=>{if(r.processed)console.log(JSON.stringify({event:'image-preparation-worker-attempt',preparationId:r.preparationId,status:r.status}));}});
 }finally{
  stop.abort();try{
   if(delegated)await finishImagePreparationRunnerSession({clients,verifyScratch:()=>privateDirectory(c.scratchRoot,c),verifyTemporary:()=>privateDirectory(c.temporaryRoot,c),verifyDescendants:()=>assertImagePreparationRunnerDescendantsEmpty(delegated!.cgroupRoot),emit:()=>{
    if(preflight){if(preflightPassed)console.log(JSON.stringify({event:'image-preparation-worker-preflight-passed',...evidence,workClaimed:false,providerCalled:false}));}
    else console.log(JSON.stringify({event:'image-preparation-worker-drained',...evidence,clientsDrained:true,scratchEmpty:true,temporaryEmpty:true,nativeDescendantsEmpty:true,remoteOutcomeResolved:false}));
   }});
   else await drainImagePreparationRunnerClients(clients);
  }finally{clearTimeout(timer);process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void runImagePreparationWorker(process.argv.slice(2)).catch(()=>{console.error(JSON.stringify({event:'image-preparation-worker-stopped',code:'IMAGE_PREPARATION_RUNNER_UNAVAILABLE'}));process.exitCode=1;});
