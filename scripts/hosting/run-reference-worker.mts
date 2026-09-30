/** Dedicated finite prepared-image runner. Requires a verified installed host,
 * reference-specific qualification and separate control-plane enrollment. */
import {createHash} from 'node:crypto';
import {lstat,opendir,readFile,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createLinuxMediaSandbox} from '../../src/lib/higgsfield-media-sandbox';
import {createHiggsfieldReferenceInspector,createHiggsfieldReferenceWorker,type HiggsfieldReferenceWorkerResult} from '../../src/lib/higgsfield-reference-worker';
import {createHiggsfieldReferenceUploader} from '../../src/lib/higgsfield-reference-transport';
import {createHiggsfieldReferenceServiceClient} from '../../src/lib/higgsfield-reference-service-client';
// Reuse only these filesystem-integrity checks, never archive configuration,
// identity, database grants, qualification or service enablement.
import {archiveHostTrusted,archiveHostRead,archiveHostNoExtendedAcls} from './archive-host-package.mjs';
import {readReferenceHostConfiguration} from './reference-host-package.mjs';
import {initializeReferenceHostDelegation} from './reference-host-delegation.mjs';
import {referenceRunnerFailure as bad,parseReferenceRunnerConfiguration,deriveReferenceRunnerConfiguration,assertReferenceRunnerReceipt} from './reference-runner-configuration.mjs';
export {ReferenceRunnerError,parseReferenceRunnerConfiguration,referenceRunnerConfigurationHash,deriveReferenceRunnerConfiguration,assertReferenceRunnerReceipt} from './reference-runner-configuration.mjs';
export type {ReferenceRunnerConfiguration} from './reference-runner-configuration.mjs';
export function referenceRunnerToken(settings:Readonly<Record<string,string|undefined>>){
 const token=settings.COATRIA_REFERENCE_SERVICE_TOKEN;
 if(typeof token!=='string'||!/^rfs_[A-Za-z0-9_-]{43}$/.test(token))bad();
 for(const [name,value]of Object.entries(settings))if(value&&name!=='COATRIA_REFERENCE_SERVICE_TOKEN'&&(/(?:DATABASE_URL|PGPASSWORD|KEYRING|API_KEY|ACCESS_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)/i.test(name)||['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','LD_PRELOAD','LD_LIBRARY_PATH'].includes(name)))bad();
 return token;
}
/** Emptiness only; caller must first verify the trusted directory identity.
 * A new process must not forget an earlier attempt's unresolved local cleanup.
 * Inspect one entry without listing names, following children or deleting them. */
export async function assertReferenceRunnerScratchEmpty(path:string){
 try{const directory=await opendir(path);try{if(await directory.read()!==null)bad('REFERENCE_RUNNER_UNQUALIFIED');}finally{await directory.close();}}
 catch{bad('REFERENCE_RUNNER_UNQUALIFIED');}
}
/** Sequential only. A failed/unknown claim or phase stops admission; it is never
 * hidden by an automatic reconnect/retry loop. Worker cleanup is awaited. */
export async function runReferenceWorkerLoop(worker:{runNext:(input:{signal:AbortSignal})=>Promise<HiggsfieldReferenceWorkerResult>},input:{signal:AbortSignal;onResult?:(result:HiggsfieldReferenceWorkerResult)=>void;idleMs?:number}){
 const idleMs=input.idleMs??2000;if(!Number.isSafeInteger(idleMs)||idleMs<1||idleMs>5000)bad();
 while(!input.signal.aborted){
  const result=await worker.runNext({signal:input.signal});input.onResult?.(result);
  if(['disabled','uncertain','failed','blocked'].includes(result.status))bad('REFERENCE_RUNNER_STOPPED');
  if(!input.signal.aborted)await delay(idleMs,undefined,{signal:input.signal}).catch(error=>{if(!input.signal.aborted)throw error;});
 }
}
export async function runReferenceWorker(args:readonly string[],settings:Readonly<Record<string,string|undefined>>=process.env){
 if(args.length!==4&&args.length!==5||args[0]!=='--host'||args[2]!=='--bundle'||args.length===5&&args[4]!=='--preflight'||!/^[a-f0-9]{64}$/.test(args[3]??'')||process.platform!=='linux'||process.arch!=='x64'||process.version!=='v24.19.0'||process.getuid?.()===0)bad();
 const preflight=args.length===5,token=referenceRunnerToken(settings),{host,hostBytes}=await readReferenceHostConfiguration(args[1],args[3],{trusted:true});
 if(host.uid!==process.getuid!()||host.gid!==process.getgid!()||await realpath(process.execPath)!==host.release+'/runtime/node')bad('REFERENCE_RUNNER_UNQUALIFIED');
 const receiptPath=`/etc/coatria-reference/${host.scope.serviceId}/qualified.json`;await archiveHostTrusted(receiptPath);const receiptBytes=await archiveHostRead(receiptPath,65536);
 const c=parseReferenceRunnerConfiguration(deriveReferenceRunnerConfiguration(host,createHash('sha256').update(receiptBytes).digest('hex')));
 await archiveHostTrusted(c.runtimePath);if(await realpath(fileURLToPath(import.meta.url))!==c.runtimePath||createHash('sha256').update(await archiveHostRead(c.runtimePath,8*1024**2)).digest('hex')!==c.releaseSha256)bad('REFERENCE_RUNNER_UNQUALIFIED');
 let receipt:unknown;try{receipt=JSON.parse(receiptBytes.toString('utf8'));}catch{bad('REFERENCE_RUNNER_UNQUALIFIED');}assertReferenceRunnerReceipt(receipt,c,{bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),uid:process.getuid!(),gid:process.getgid!(),hostConfigurationSha256:createHash('sha256').update(hostBytes).digest('hex'),host});
 if(!preflight)await archiveHostTrusted(`/etc/coatria-reference/${host.scope.serviceId}/worker-enabled`);
 await archiveHostTrusted(dirname(c.scratchRoot),true);const info=await lstat(c.scratchRoot);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(c.scratchRoot)!==c.scratchRoot||info.uid!==process.getuid!()||info.mode&0o7077)bad();archiveHostNoExtendedAcls([c.scratchRoot]);
 await assertReferenceRunnerScratchEmpty(c.scratchRoot);
 const stop=new AbortController(),shutdown=()=>stop.abort(),timer=setTimeout(shutdown,Math.max(1,Date.parse(c.expiresAt)-Date.now()));process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 try{
  // Genuine immutable closure/cgroup checks and real native capability probes.
  // No injected inspector, fallback executable or environment qualification.
  const paths=await initializeReferenceHostDelegation(c.serviceId,preflight?'preflight':'worker');
  const sandbox=await createLinuxMediaSandbox({profilePath:c.profilePath,expectedProfileSha256:c.profileSha256,cgroupRoot:paths.cgroupRoot});stop.signal.throwIfAborted();
  const client=createHiggsfieldReferenceServiceClient({...c,token,qualificationSha256:c.qualification.sha256}),ready=await client.readiness!(stop.signal);
  if(!ready.enabled||!ready.hostQualified||!ready.catalogVerified||!ready.storageVerified)bad('REFERENCE_RUNNER_UNQUALIFIED');
  if(preflight){console.log(JSON.stringify({event:'reference-worker-preflight-passed',serviceId:c.serviceId,sourceCommit:c.sourceCommit,workClaimed:false,providerCalled:false}));return;}
  const worker=createHiggsfieldReferenceWorker({scratchRoot:c.scratchRoot,inspectionProfileSha256:c.profileSha256,companyId:c.companyId,projectIds:c.projectIds},{...client,inspectMedia:createHiggsfieldReferenceInspector(sandbox),upload:createHiggsfieldReferenceUploader({allowedHosts:c.uploadHosts})});
  await runReferenceWorkerLoop(worker,{signal:stop.signal,onResult:r=>{if(r.processed)console.log(JSON.stringify({event:'reference-worker-attempt',...r}));}});
 }finally{clearTimeout(timer);process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);stop.abort();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void runReferenceWorker(process.argv.slice(2)).catch(()=>{console.error(JSON.stringify({event:'reference-worker-stopped',code:'REFERENCE_RUNNER_UNAVAILABLE'}));process.exitCode=1;});
