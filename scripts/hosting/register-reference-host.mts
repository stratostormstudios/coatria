/** Privileged explicit operator enrollment. Database credential input is stdin
 * only. No activation, service start, reload, resource or provider operations. */
import {randomBytes,randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {join,posix,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {archiveHostRead,archiveHostTrusted,verifyArchiveTree} from './archive-host-package.mjs';
import {inspectReferenceHostBundle} from './reference-host-package.mjs';
import {readCurrentReferenceHostQualification,assertReferenceHostQualificationEnvironment} from './reference-host-qualification.mjs';
import {createReferenceEnrollmentStore,withReferenceEnrollmentLock,makeReferenceEnrollmentIntent,assertReferenceEnrollmentPending,executeReferenceHostEnrollment,enrollmentBytesHash,referenceEnrollmentRequestFromHost,ReferenceHostEnrollmentError} from './reference-host-enrollment.mjs';
import {enrollReferenceService,reconcileReferenceService} from './reference-enrollment-transaction.mjs';

const ROLE='coatria_higgsfield_reference_registrar_v1',hash=/^[a-f0-9]{64}$/;
function fail():never{throw new ReferenceHostEnrollmentError();}
type Arguments={mode:'plan'|'enroll'|'reconcile';hostPath:string;bundleSha256:string;registrarBundleSha256:string;scopePath?:string;scopeSha256?:string};
export function parseReferenceRegistrarArguments(input:readonly string[]):Arguments{
 const args=[...input],mode=(['plan','enroll','reconcile'].includes(args[0])?args.shift():'plan') as Arguments['mode'];
 if(args.length!==(mode==='reconcile'?6:10)||args[0]!=='--host'||args[2]!=='--bundle'||args[4]!=='--registrar-bundle'||mode!=='reconcile'&&(args[6]!=='--scope'||args[8]!=='--scope-sha256')||!/^\/etc\/coatria-reference\/[a-f0-9-]{36}\/host\.json$/.test(args[1])||!hash.test(args[3])||!hash.test(args[5]))fail();
 if(mode!=='reconcile'&&(!posix.isAbsolute(args[7])||posix.normalize(args[7])!==args[7]||args[7].includes('\\')||args[7].includes('\0')||!hash.test(args[9])))fail();
 return {mode,hostPath:args[1],bundleSha256:args[3],registrarBundleSha256:args[5],...mode==='reconcile'?{}:{scopePath:args[7],scopeSha256:args[9]}};
}
/** Direct verified-TLS registrar LOGIN only. URL options never flow into pg. */
export function parseReferenceRegistrarConnectionInput(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!('connectionString'in value)||typeof value.connectionString!=='string'||Buffer.byteLength(value.connectionString)>16000||/[\u0000-\u001f\u007f]/.test(value.connectionString))fail();
 let url:URL;try{url=new URL(value.connectionString);}catch{fail();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash||!url.username||!url.password||url.pathname.length<2)fail();
 const hostname=url.hostname.toLowerCase(),local=['localhost','127.0.0.1','[::1]'].includes(hostname);
 if(!local&&(!hostname.endsWith('.neon.tech')||hostname.split('.')[0].endsWith('-pooler')))fail();
 for(const key of url.searchParams.keys())if(!['sslmode','channel_binding'].includes(key)||url.searchParams.getAll(key).length!==1)fail();
 const sslmode=url.searchParams.get('sslmode'),binding=url.searchParams.get('channel_binding');if(sslmode&&!['require','verify-ca','verify-full',...local?['disable']:[]].includes(sslmode)||binding&&!['require','prefer'].includes(binding))fail();
 let user:string,password:string,database:string;try{user=decodeURIComponent(url.username);password=decodeURIComponent(url.password);database=decodeURIComponent(url.pathname.slice(1));}catch{fail();}
 if(user!==ROLE||!password||!database||[user,password,database].some(v=>/[\u0000-\u001f\u007f]/.test(v))||database.includes('/'))fail();const port=url.port?Number(url.port):5432;if(!Number.isSafeInteger(port)||port<1||port>65535)fail();
 return {host:hostname==='[::1]'?'::1':hostname,port,user,password,database,ssl:local&&(!sslmode||sslmode==='disable')?false:{rejectUnauthorized:true},enableChannelBinding:true,application_name:'coatria-reference-host-registrar',connectionTimeoutMillis:10000,statement_timeout:15000,query_timeout:20000};
}
export function assertReferenceRegistrarEnvironment(settings:Readonly<Record<string,string|undefined>>){assertReferenceHostQualificationEnvironment(settings);if(Object.entries(settings).some(([key,value])=>value&&/^PG[A-Z_]*$/.test(key)))fail();}
async function input(){
 if(process.stdin.isTTY)fail();let length=0;const chunks:Buffer[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{for await(const chunk of process.stdin){length+=Buffer.byteLength(chunk);if(length>16384)fail();chunks.push(Buffer.from(chunk));}let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail();}return parseReferenceRegistrarConnectionInput(value);})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{process.stdin.destroy();reject(new ReferenceHostEnrollmentError());},10000);})]);}
 finally{if(timer)clearTimeout(timer);for(const chunk of chunks)chunk.fill(0);}
}
async function registrarIdentity(args:Arguments){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.version!=='v24.19.0')fail();assertReferenceRegistrarEnvironment(process.env);
 await archiveHostTrusted(args.hostPath);const hostBytes=await archiveHostRead(args.hostPath,65536),host=JSON.parse(hostBytes.toString('utf8'));
 if(host.bundleSha256!==args.bundleSha256||args.hostPath!==`/etc/coatria-reference/${host.scope?.serviceId}/host.json`||host.release!==`/var/lib/coatria-reference-releases/${args.bundleSha256}`)fail();
 const bundle=await inspectReferenceHostBundle(host.release,args.bundleSha256,{trusted:true});if(host.commit!==bundle.commit||host.tree!==bundle.tree||await realpath(process.execPath)!==host.release+'/runtime/node')fail();
 const root='/var/lib/coatria-reference-registrars/'+args.registrarBundleSha256;await archiveHostTrusted(root,true);await archiveHostTrusted(join(root,'bundle.json'));const manifestBytes=await archiveHostRead(join(root,'bundle.json'),1024**2);if(enrollmentBytesHash(manifestBytes)!==args.registrarBundleSha256)fail();
 const manifest=JSON.parse(manifestBytes.toString('utf8'));
 if(manifest.version!==1||manifest.kind!=='coatria-trusted-service-bundle'||manifest.service!=='reference-registrar'||manifest.sourceCommit!==host.commit||manifest.sourceTree!==host.tree||manifest.packageLockSha256!==bundle.runtime.packageLockSha256||manifest.nodeVersion!==process.version||manifest.image!==bundle.runtime.pins.nodeImage||manifest.deployable!==true||manifest.qualified!==false||manifest.runtime?.path!=='runtime.mjs'||!hash.test(manifest.runtime.sha256)||!Number.isSafeInteger(manifest.runtime.bytes)||manifest.runtime.bytes<1||manifest.runtime.bytes>8*1024**2||await realpath(fileURLToPath(import.meta.url))!==root+'/runtime.mjs')fail();
 await verifyArchiveTree(root,[{path:'runtime.mjs',sha256:manifest.runtime.sha256,bytes:manifest.runtime.bytes,mode:0o444}],{trusted:true,extra:['bundle.json']});
 return {host,hostBytes,bundle,configRoot:`/etc/coatria-reference/${host.scope.serviceId}`};
}
export async function registerReferenceHost(argv:readonly string[]){
 const args=parseReferenceRegistrarArguments(argv),identity=await registrarIdentity(args);
 let scope:unknown;if(args.mode!=='reconcile'){await archiveHostTrusted(args.scopePath!);const bytes=await archiveHostRead(args.scopePath!,65536);if(enrollmentBytesHash(bytes)!==args.scopeSha256)fail();scope=JSON.parse(bytes.toString('utf8'));}
 if(args.mode==='plan'){
  const qualified=await readCurrentReferenceHostQualification(args.hostPath,args.bundleSha256),request=referenceEnrollmentRequestFromHost(qualified,scope,'00000000-0000-4000-8000-000000000001','0'.repeat(64));
  console.log(JSON.stringify({mode:'plan',serviceId:request.serviceId,companyId:request.companyId,enrolledBy:request.enrolledBy,projects:request.projects,provider:request.provider,expiresAt:request.expiresAt,qualificationSha256:request.qualificationSha256,databaseAuthorityVerified:false,credentialCreated:false,workerEnabled:false}));return;
 }
 const connection=await input();
 const login=async(operation:typeof reconcileReferenceService|typeof enrollReferenceService,request:Parameters<typeof reconcileReferenceService>[1])=>{
  const client=new pg.Client(connection);client.on('error',()=>{});try{await client.connect();return await operation(client,request);}finally{await client.end();}
 };
 try{const result=await withReferenceEnrollmentLock(identity.configRoot,async()=>{
  const store=createReferenceEnrollmentStore(identity.configRoot);let pending=await store.read();
  if(!pending){if(args.mode!=='enroll')throw new ReferenceHostEnrollmentError('REFERENCE_HOST_ENROLLMENT_PENDING_MISSING');const qualified=await readCurrentReferenceHostQualification(args.hostPath,args.bundleSha256),token='rfs_'+randomBytes(32).toString('base64url'),intent=makeReferenceEnrollmentIntent(qualified,scope,{token,requestId:randomUUID(),scopeSha256:args.scopeSha256,registrarBundleSha256:args.registrarBundleSha256});pending=await store.prepare({intent,token,hostBytes:qualified.hostBytes,receiptBytes:qualified.receiptBytes});}
  if(!pending)fail();const request=assertReferenceEnrollmentPending(pending,{registrarBundleSha256:args.registrarBundleSha256,...args.mode==='enroll'?{scopeSha256:args.scopeSha256}:{}});
  if(enrollmentBytesHash(identity.hostBytes)!==request.qualification.hostConfigurationSha256||request.serviceId!==identity.host.scope.serviceId||request.qualification.bundleSha256!==args.bundleSha256)fail();
  const verifyLocal=async()=>{const qualified=await readCurrentReferenceHostQualification(args.hostPath,args.bundleSha256);if(qualified.qualificationSha256!==request.qualificationSha256||enrollmentBytesHash(qualified.hostBytes)!==request.qualification.hostConfigurationSha256)fail();};
  return executeReferenceHostEnrollment({mode:args.mode,store,pending,verifyLocal,enroll:(r:typeof request)=>login(enrollReferenceService,r),reconcile:(r:typeof request)=>login(reconcileReferenceService,r)});
 });
 console.log(JSON.stringify(result));}finally{connection.password='';}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void registerReferenceHost(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({event:'reference-host-enrollment-stopped',code:error instanceof ReferenceHostEnrollmentError?error.code:'REFERENCE_HOST_ENROLLMENT_REJECTED',workerEnabled:false}));process.exitCode=1;});
