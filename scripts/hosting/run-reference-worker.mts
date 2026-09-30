/** Dedicated prepared-image runner foundation. A reference-specific trusted
 * qualification producer, immutable bundle installer and service enrollment are
 * intentionally NOT supplied here. Archive receipts cannot authorize this entry. */
import {createHash} from 'node:crypto';
import {lstat,opendir,readFile,realpath} from 'node:fs/promises';
import {dirname,posix,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {createLinuxMediaSandbox} from '../../src/lib/higgsfield-media-sandbox';
import {createHiggsfieldReferenceInspector,createHiggsfieldReferenceWorker,type HiggsfieldReferenceWorkerResult} from '../../src/lib/higgsfield-reference-worker';
import {createHiggsfieldReferenceUploader} from '../../src/lib/higgsfield-reference-transport';
import {createHiggsfieldReferenceServiceClient,referenceServiceOrigin} from '../../src/lib/higgsfield-reference-service-client';
// Reuse only these filesystem-integrity checks, never archive configuration,
// identity, database grants, qualification or service enablement.
import {archiveHostTrusted,archiveHostRead,archiveHostNoExtendedAcls} from './archive-host-package.mjs';

export class ReferenceRunnerError extends Error {constructor(readonly code:'REFERENCE_RUNNER_CONFIGURATION_INVALID'|'REFERENCE_RUNNER_UNQUALIFIED'|'REFERENCE_RUNNER_STOPPED'){super(code);this.name='ReferenceRunnerError';}}
function bad(code:ReferenceRunnerError['code']='REFERENCE_RUNNER_CONFIGURATION_INVALID'):never{throw new ReferenceRunnerError(code);}
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid(),absolute=z.string().max(1024).refine(v=>posix.isAbsolute(v)&&v.startsWith('/')&&!v.includes('\\')&&!v.includes('\0')&&posix.normalize(v)===v);
const projects=z.array(uuid).min(1).max(100).refine(ids=>new Set(ids).size===ids.length);
const configSchema=z.object({version:z.literal(1),serviceId:uuid,companyId:uuid,projectIds:projects,origin:z.string(),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),releaseSha256:hash,runtimePath:absolute,expiresAt:z.iso.datetime(),scratchRoot:absolute,profilePath:absolute,profileSha256:hash,cgroupRoot:absolute,uploadHosts:z.array(z.string()).min(1).max(32),qualification:z.object({path:absolute,sha256:hash}).strict()}).strict();
export type ReferenceRunnerConfiguration=z.infer<typeof configSchema>;
const receiptSchema=z.object({version:z.literal(1),kind:z.literal('coatria-reference-worker-qualification'),serviceId:uuid,companyId:uuid,projectIds:projects,sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),releaseSha256:hash,profileSha256:hash,configurationSha256:hash,bootId:uuid,uid:z.number().int().positive(),expiresAt:z.iso.datetime(),qualified:z.literal(true),checks:z.object({isolation:z.literal(true),resourceLimits:z.literal(true),descendantCleanup:z.literal(true),preparedImages:z.literal(true)}).strict()}).strict();
const sameProjects=(a:readonly string[],b:readonly string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
/** The receipt location/hash is omitted to avoid a circular digest. All service
 * scope, egress, source, filesystem, decoder and deadline fields remain pinned. */
export function referenceRunnerConfigurationHash(c:ReferenceRunnerConfiguration){const {qualification:_receipt,...identity}=c;return createHash('sha256').update('coatria:reference-runner-configuration:v1\n'+canonical(identity)).digest('hex');}
export function parseReferenceRunnerConfiguration(input:unknown,now=Date.now()){
 const parsed=configSchema.safeParse(input);if(!parsed.success)bad();const c=parsed.data;
 referenceServiceOrigin(c.origin);const expiry=Date.parse(c.expiresAt);
 if(expiry<=now||expiry-now>86400000||c.scratchRoot!==`/var/lib/coatria-reference-worker/${c.serviceId}/scratch`||!c.runtimePath.endsWith('/runtime.mjs')||!c.cgroupRoot.startsWith('/sys/fs/cgroup/'))bad();
 // This is policy validation only; creating the uploader makes no HTTP calls.
 createHiggsfieldReferenceUploader({allowedHosts:c.uploadHosts});
 return c;
}
export function assertReferenceRunnerReceipt(input:unknown,c:ReferenceRunnerConfiguration,host:{bootId:string;uid:number},now=Date.now()){
 const parsed=receiptSchema.safeParse(input);if(!parsed.success)bad('REFERENCE_RUNNER_UNQUALIFIED');const r=parsed.data;
 if(r.serviceId!==c.serviceId||r.companyId!==c.companyId||!sameProjects(r.projectIds,c.projectIds)||r.sourceCommit!==c.sourceCommit||r.releaseSha256!==c.releaseSha256||r.profileSha256!==c.profileSha256||r.configurationSha256!==referenceRunnerConfigurationHash(c)||r.bootId!==host.bootId||r.uid!==host.uid||Date.parse(r.expiresAt)<Date.parse(c.expiresAt)||Date.parse(r.expiresAt)<=now||Date.parse(r.expiresAt)-now>86400000)bad('REFERENCE_RUNNER_UNQUALIFIED');
 return r;
}
export function referenceRunnerToken(settings:Readonly<Record<string,string|undefined>>){
 const token=settings.COATRIA_REFERENCE_SERVICE_TOKEN;
 if(typeof token!=='string'||!/^rfs_[A-Za-z0-9_-]{43}$/.test(token))bad();
 for(const [name,value]of Object.entries(settings))if(value&&name!=='COATRIA_REFERENCE_SERVICE_TOKEN'&&(/(?:DATABASE_URL|PGPASSWORD|KEYRING|API_KEY|ACCESS_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)/i.test(name)||['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH'].includes(name)))bad();
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
 if(args.length!==4&&args.length!==5||args[0]!=='--config'||args[2]!=='--sha256'||args.length===5&&args[4]!=='--preflight'||!hash.safeParse(args[3]).success||process.platform!=='linux'||process.arch!=='x64'||process.version!=='v24.19.0'||process.getuid?.()===0)bad();
 const preflight=args.length===5,token=referenceRunnerToken(settings),configPath=args[1];
 await archiveHostTrusted(configPath);const bytes=await archiveHostRead(configPath,65536);if(createHash('sha256').update(bytes).digest('hex')!==args[3])bad();
 let raw:unknown;try{raw=JSON.parse(bytes.toString('utf8'));}catch{bad();}const c=parseReferenceRunnerConfiguration(raw);
 await archiveHostTrusted(c.runtimePath);if(await realpath(fileURLToPath(import.meta.url))!==c.runtimePath||createHash('sha256').update(await archiveHostRead(c.runtimePath,8*1024**2)).digest('hex')!==c.releaseSha256)bad('REFERENCE_RUNNER_UNQUALIFIED');
 await archiveHostTrusted(c.qualification.path);const receiptBytes=await archiveHostRead(c.qualification.path,65536);if(createHash('sha256').update(receiptBytes).digest('hex')!==c.qualification.sha256)bad('REFERENCE_RUNNER_UNQUALIFIED');
 let receipt:unknown;try{receipt=JSON.parse(receiptBytes.toString('utf8'));}catch{bad('REFERENCE_RUNNER_UNQUALIFIED');}assertReferenceRunnerReceipt(receipt,c,{bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),uid:process.getuid!()});
 await archiveHostTrusted(dirname(c.scratchRoot),true);const info=await lstat(c.scratchRoot);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(c.scratchRoot)!==c.scratchRoot||info.uid!==process.getuid!()||info.mode&0o7077)bad();archiveHostNoExtendedAcls([c.scratchRoot]);
 await assertReferenceRunnerScratchEmpty(c.scratchRoot);
 const stop=new AbortController(),shutdown=()=>stop.abort(),timer=setTimeout(shutdown,Math.max(1,Date.parse(c.expiresAt)-Date.now()));process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 try{
  // Genuine immutable closure/cgroup checks and real native capability probes.
  // No injected inspector, fallback executable or environment qualification.
  const sandbox=await createLinuxMediaSandbox({profilePath:c.profilePath,expectedProfileSha256:c.profileSha256,cgroupRoot:c.cgroupRoot});stop.signal.throwIfAborted();
  const client=createHiggsfieldReferenceServiceClient({...c,token,qualificationSha256:c.qualification.sha256}),ready=await client.readiness!(stop.signal);
  if(!ready.enabled||!ready.hostQualified||!ready.catalogVerified||!ready.storageVerified)bad('REFERENCE_RUNNER_UNQUALIFIED');
  if(preflight){console.log(JSON.stringify({event:'reference-worker-preflight-passed',serviceId:c.serviceId,sourceCommit:c.sourceCommit,workClaimed:false,providerCalled:false}));return;}
  const worker=createHiggsfieldReferenceWorker({scratchRoot:c.scratchRoot,inspectionProfileSha256:c.profileSha256,companyId:c.companyId,projectIds:c.projectIds},{...client,inspectMedia:createHiggsfieldReferenceInspector(sandbox),upload:createHiggsfieldReferenceUploader({allowedHosts:c.uploadHosts})});
  await runReferenceWorkerLoop(worker,{signal:stop.signal,onResult:r=>{if(r.processed)console.log(JSON.stringify({event:'reference-worker-attempt',...r}));}});
 }finally{clearTimeout(timer);process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);stop.abort();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void runReferenceWorker(process.argv.slice(2)).catch(()=>{console.error(JSON.stringify({event:'reference-worker-stopped',code:'REFERENCE_RUNNER_UNAVAILABLE'}));process.exitCode=1;});
