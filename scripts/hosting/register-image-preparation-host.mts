/** Privileged explicit operator registrar. Credentials arrive only on bounded
 * stdin; no activation, unit start, provider request or automatic submission. */
import {randomBytes,randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {join,posix,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {archiveHostRead,archiveHostTrusted,verifyArchiveTree} from './archive-host-package.mjs';
import {inspectImagePreparationHostBundle} from './image-preparation-host-package.mjs';
import {readCurrentImagePreparationHostQualification} from './image-preparation-host-qualification.mjs';
import {createImagePreparationEnrollmentStore,withImagePreparationEnrollmentLock,makeImagePreparationEnrollmentIntent,assertImagePreparationEnrollmentPending,executeImagePreparationHostEnrollment,enrollmentBytesHash,imagePreparationEnrollmentRequestFromHost,ImagePreparationHostEnrollmentError} from './image-preparation-host-enrollment.mjs';
import {enrollImagePreparationService,reconcileImagePreparationService} from './image-preparation-enrollment-transaction.mjs';
import type {ImagePreparationEnrollmentRequest} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
import {assertImagePreparationRegistrarEnvironment,readImagePreparationRegistrarConnectionInput,imagePreparationRegistrarLogin} from './image-preparation-registrar-connection.mjs';
export {parseImagePreparationRegistrarConnectionInput,assertImagePreparationRegistrarEnvironment,readImagePreparationRegistrarConnectionInput,imagePreparationRegistrarLogin} from './image-preparation-registrar-connection.mjs';

const hash=/^[a-f0-9]{64}$/,uuid='(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)';
const rejected='IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED';
function fail():never{throw new ImagePreparationHostEnrollmentError(rejected);}
type Arguments={mode:'plan'|'enroll'|'reconcile';hostPath:string;bundleSha256:string;registrarBundleSha256:string;scopePath?:string;scopeSha256?:string};

export function parseImagePreparationRegistrarArguments(input:readonly string[]):Arguments{
 if(!Array.isArray(input)||input.some(v=>typeof v!=='string'||v.length>4096||/[\u0000-\u001f\u007f]/.test(v)))fail();
 const args=[...input],mode=(['plan','enroll','reconcile'].includes(args[0])?args.shift():'plan') as Arguments['mode'];
 if(args.length!==(mode==='reconcile'?6:10)||args[0]!=='--host'||args[2]!=='--bundle'||args[4]!=='--registrar-bundle'||!new RegExp('^/etc/coatria-image-preparation/'+uuid+'/host\\.json$').test(args[1])||!hash.test(args[3])||!hash.test(args[5]))fail();
 if(mode!=='reconcile'&&(args[6]!=='--scope'||args[8]!=='--scope-sha256'||!posix.isAbsolute(args[7])||posix.normalize(args[7])!==args[7]||args[7].includes('\\')||!hash.test(args[9])))fail();
 return {mode,hostPath:args[1],bundleSha256:args[3],registrarBundleSha256:args[5],...mode==='reconcile'?{}:{scopePath:args[7],scopeSha256:args[9]}};
}

/** Historical identity only: no current expiry or boot check here. The exact
 * pending host/receipt are separately validated before historical SQL lookup. */
async function registrarIdentity(args:Arguments){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.version!=='v24.19.0')fail();
 assertImagePreparationRegistrarEnvironment(process.env);
 await archiveHostTrusted(args.hostPath);const hostBytes=await archiveHostRead(args.hostPath,65536);let host:any;try{host=JSON.parse(hostBytes.toString('utf8'));}catch{fail();}
 if(host?.bundleSha256!==args.bundleSha256||args.hostPath!==`/etc/coatria-image-preparation/${host.scope?.serviceId}/host.json`||host.release!==`/var/lib/coatria-image-preparation-releases/${args.bundleSha256}`)fail();
 const bundle=await inspectImagePreparationHostBundle(host.release,args.bundleSha256,{trusted:true});
 if(host.commit!==bundle.commit||host.tree!==bundle.tree||await realpath(process.execPath)!==host.release+'/runtime/node')fail();
 const root='/var/lib/coatria-image-preparation-registrars/'+args.registrarBundleSha256;await archiveHostTrusted(root,true);await archiveHostTrusted(join(root,'bundle.json'));
 const manifestBytes=await archiveHostRead(join(root,'bundle.json'),1024**2);if(enrollmentBytesHash(manifestBytes)!==args.registrarBundleSha256)fail();
 let manifest:any;try{manifest=JSON.parse(manifestBytes.toString('utf8'));}catch{fail();}
 if(manifest?.version!==1||manifest.kind!=='coatria-trusted-service-bundle'||manifest.service!=='image-preparation-registrar'||manifest.sourceCommit!==host.commit||manifest.sourceTree!==host.tree||manifest.packageLockSha256!==bundle.runtime.packageLockSha256||manifest.nodeVersion!==process.version||manifest.image!==bundle.runtime.pins.nodeImage||manifest.deployable!==true||manifest.qualified!==false||manifest.runtime?.path!=='runtime.mjs'||!hash.test(manifest.runtime.sha256)||!Number.isSafeInteger(manifest.runtime.bytes)||manifest.runtime.bytes<1||manifest.runtime.bytes>8*1024**2||await realpath(fileURLToPath(import.meta.url))!==root+'/runtime.mjs')fail();
 await verifyArchiveTree(root,[{path:'runtime.mjs',sha256:manifest.runtime.sha256,bytes:manifest.runtime.bytes,mode:0o444}],{trusted:true,extra:['bundle.json']});
 return {host,hostBytes,configRoot:`/etc/coatria-image-preparation/${host.scope.serviceId}`};
}

export async function registerImagePreparationHost(argv:readonly string[]){
 const args=parseImagePreparationRegistrarArguments(argv),identity=await registrarIdentity(args);
 let scope:unknown;if(args.mode!=='reconcile'){
  await archiveHostTrusted(args.scopePath!);const bytes=await archiveHostRead(args.scopePath!,65536);if(enrollmentBytesHash(bytes)!==args.scopeSha256)fail();try{scope=JSON.parse(bytes.toString('utf8'));}catch{fail();}
 }
 if(args.mode==='plan'){
  const qualified=await readCurrentImagePreparationHostQualification(args.hostPath,args.bundleSha256),request=imagePreparationEnrollmentRequestFromHost(qualified,scope,'00000000-0000-4000-8000-000000000001','0'.repeat(64));
  return {mode:'plan' as const,serviceId:request.serviceId,companyId:request.companyId,enrolledBy:request.enrolledBy,projects:request.projects,expiresAt:request.expiresAt,qualificationSha256:request.qualificationSha256,databaseAuthorityVerified:false,credentialCreated:false,workerEnabled:false};
 }
 const connection=await readImagePreparationRegistrarConnectionInput();
 try{return await withImagePreparationEnrollmentLock(identity.configRoot,async()=>{
  const store=createImagePreparationEnrollmentStore(identity.configRoot);let pending=await store.read();
  if(!pending){
   if(args.mode!=='enroll')throw new ImagePreparationHostEnrollmentError('IMAGE_PREPARATION_HOST_ENROLLMENT_PENDING_MISSING');
   const qualified=await readCurrentImagePreparationHostQualification(args.hostPath,args.bundleSha256),token='ips_'+randomBytes(32).toString('base64url');
   const intent=makeImagePreparationEnrollmentIntent(qualified,scope,{token,requestId:randomUUID(),scopeSha256:args.scopeSha256,registrarBundleSha256:args.registrarBundleSha256});
   pending=await store.prepare({intent,token,hostBytes:qualified.hostBytes,receiptBytes:qualified.receiptBytes});
  }
  if(!pending)fail();const request=assertImagePreparationEnrollmentPending(pending,{registrarBundleSha256:args.registrarBundleSha256,...args.mode==='enroll'?{scopeSha256:args.scopeSha256}:{}});
  if(enrollmentBytesHash(identity.hostBytes)!==request.qualification.hostConfigurationSha256||request.serviceId!==identity.host.scope.serviceId||request.qualification.bundleSha256!==args.bundleSha256)fail();
  const verifyLocal=async()=>{
   const qualified=await readCurrentImagePreparationHostQualification(args.hostPath,args.bundleSha256);
   if(qualified.qualificationSha256!==request.qualificationSha256||enrollmentBytesHash(qualified.hostBytes)!==request.qualification.hostConfigurationSha256)fail();
  };
  return executeImagePreparationHostEnrollment({mode:args.mode,store,pending,verifyLocal,enroll:(r:ImagePreparationEnrollmentRequest)=>imagePreparationRegistrarLogin(connection,enrollImagePreparationService,r),reconcile:(r:ImagePreparationEnrollmentRequest)=>imagePreparationRegistrarLogin(connection,reconcileImagePreparationService,r)});
 });}finally{connection.password='';}
}

const safeCodes=new Set([rejected,...['BUSY','PENDING_MISSING','PENDING_INCOMPLETE','PENDING_EXISTS','SUBMIT_INVALID','JOURNAL_FULL','ACTIVATION_PRESENT','CREDENTIAL_CONFLICT','RECONCILIATION_INVALID','LOCAL_INACTIVE','AUTHORITY_INACTIVE','OUTCOME_UNKNOWN'].map(code=>'IMAGE_PREPARATION_HOST_ENROLLMENT_'+code)]);
export function imagePreparationRegistrarFailureResult(error:unknown){const code=error instanceof ImagePreparationHostEnrollmentError&&safeCodes.has(error.code)?error.code:rejected;return {event:'image-preparation-host-enrollment-stopped',code,workerEnabled:false};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void registerImagePreparationHost(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));}).catch(error=>{console.error(JSON.stringify(imagePreparationRegistrarFailureResult(error)));process.exitCode=1;});
