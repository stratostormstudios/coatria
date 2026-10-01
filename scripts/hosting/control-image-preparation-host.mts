/** Explicit finite operator control. No enrollment, minting, provider setup or
 * automatic restart. Stop/reconcile remain available after authority expires. */
import {lstat,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {archiveHostRead,archiveHostTrusted,verifyArchiveTree} from './archive-host-package.mjs';
import {inspectImagePreparationHostBundle} from './image-preparation-host-package.mjs';
import {readCurrentImagePreparationHostQualification} from './image-preparation-host-qualification.mjs';
import {createImagePreparationEnrollmentStore,withImagePreparationEnrollmentLock,assertImagePreparationEnrollmentPending,enrollmentBytesHash} from './image-preparation-host-enrollment.mjs';
import {assertImagePreparationRegistrarEnvironment,readImagePreparationRegistrarConnectionInput,imagePreparationRegistrarLogin} from './image-preparation-registrar-connection.mjs';
import {reconcileImagePreparationService,observeImagePreparationServicePostStart} from './image-preparation-enrollment-transaction.mjs';
import {deriveImagePreparationRunnerConfiguration,parseImagePreparationRunnerToken} from './image-preparation-runner-configuration.mjs';
import {createImagePreparationHostControlStore,assertImagePreparationHostControlIdentity,executeImagePreparationHostControl} from './image-preparation-host-control.mjs';
import {createImagePreparationHostSystemdControl} from './image-preparation-host-control-systemd.mjs';

const rejected='IMAGE_PREPARATION_HOST_CONTROL_REJECTED',hash=/^[a-f0-9]{64}$/;
function fail():never{throw new Error(rejected);}
type Arguments={mode:'plan'|'start'|'reconcile'|'stop';hostPath:string;bundleSha256:string;controllerBundleSha256:string};
export function parseImagePreparationControlArguments(input:readonly string[]):Arguments{
 if(!Array.isArray(input)||input.some(v=>typeof v!=='string'||v.length>4096||/[\u0000-\u001f\u007f]/.test(v)))fail();
 const args=[...input],mode=(['plan','start','reconcile','stop'].includes(args[0])?args.shift():'plan') as Arguments['mode'];
 if(args.length!==6||args[0]!=='--host'||args[2]!=='--bundle'||args[4]!=='--controller-bundle'||!/^\/etc\/coatria-image-preparation\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/host\.json$/.test(args[1])||!hash.test(args[3])||!hash.test(args[5]))fail();
 return {mode,hostPath:args[1],bundleSha256:args[3],controllerBundleSha256:args[5]};
}

/** Project a fresh restricted LOGIN result into the engine's narrow authority
 * contract only after matching the original immutable enrollment identity. */
export function imagePreparationControlAuthority(result:unknown,expected:{serviceId:string;requestId:string;requestHash:string}){
 if(!result||typeof result!=='object'||Array.isArray(result))fail();
 const value=result as Record<string,unknown>;
 if(Object.keys(value).sort().join(',')!=='active,requestHash,requestId,serviceId,status'||value.status!=='committed'||value.active!==true||value.serviceId!==expected.serviceId||value.requestId!==expected.requestId||value.requestHash!==expected.requestHash)fail();
 return {status:'committed' as const,active:true as const,serviceId:expected.serviceId};
}

async function controllerIdentity(args:Arguments){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.version!=='v24.19.0')fail();
 assertImagePreparationRegistrarEnvironment(process.env);
 await archiveHostTrusted(args.hostPath);const hostBytes=await archiveHostRead(args.hostPath,65536);
 let host:any;try{host=JSON.parse(hostBytes.toString('utf8'));}catch{fail();}
 if(host?.bundleSha256!==args.bundleSha256||args.hostPath!==`/etc/coatria-image-preparation/${host.scope?.serviceId}/host.json`||host.release!==`/var/lib/coatria-image-preparation-releases/${args.bundleSha256}`)fail();
 const bundle=await inspectImagePreparationHostBundle(host.release,args.bundleSha256,{trusted:true});
 if(host.commit!==bundle.commit||host.tree!==bundle.tree||await realpath(process.execPath)!==host.release+'/runtime/node')fail();
 const root='/var/lib/coatria-image-preparation-controllers/'+args.controllerBundleSha256;await archiveHostTrusted(root,true);await archiveHostTrusted(join(root,'bundle.json'));
 const bytes=await archiveHostRead(join(root,'bundle.json'),1024**2);if(enrollmentBytesHash(bytes)!==args.controllerBundleSha256)fail();
 let manifest:any;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{fail();}
 if(manifest?.version!==1||manifest.kind!=='coatria-trusted-service-bundle'||manifest.service!=='image-preparation-control'||manifest.sourceCommit!==host.commit||manifest.sourceTree!==host.tree||manifest.packageLockSha256!==bundle.runtime.packageLockSha256||manifest.nodeVersion!==process.version||manifest.image!==bundle.runtime.pins.nodeImage||manifest.deployable!==true||manifest.qualified!==false||manifest.runtime?.path!=='runtime.mjs'||!hash.test(manifest.runtime.sha256)||!Number.isSafeInteger(manifest.runtime.bytes)||manifest.runtime.bytes<1||manifest.runtime.bytes>8*1024**2||await realpath(fileURLToPath(import.meta.url))!==root+'/runtime.mjs')fail();
 await verifyArchiveTree(root,[{path:'runtime.mjs',sha256:manifest.runtime.sha256,bytes:manifest.runtime.bytes,mode:0o444}],{trusted:true,extra:['bundle.json']});
 return {host,hostBytes,configRoot:`/etc/coatria-image-preparation/${host.scope.serviceId}`};
}

export async function controlImagePreparationHost(argv:readonly string[]){
 const args=parseImagePreparationControlArguments(argv),installed=await controllerIdentity(args);
 const enrollment=createImagePreparationEnrollmentStore(installed.configRoot),loadIdentity=async()=>{
  const pending=await enrollment.read();if(!pending||!pending.submission||!pending.intentBytes)fail();
  const request=assertImagePreparationEnrollmentPending(pending);
  if(!pending.hostBytes.equals(installed.hostBytes)||request.serviceId!==installed.host.scope.serviceId||request.qualification.bundleSha256!==args.bundleSha256)fail();
  const receipt=JSON.parse(pending.receiptBytes.toString('utf8'));
  const identity={host:installed.host,hostBytes:installed.hostBytes,receipt,receiptBytes:pending.receiptBytes,qualificationSha256:pending.intent.qualificationSha256,configurationSha256:pending.intent.configurationSha256,enrollmentIntentSha256:enrollmentBytesHash(pending.intentBytes),controllerBundleSha256:args.controllerBundleSha256};
  assertImagePreparationHostControlIdentity(identity);return {identity,pending,request};
 };
 if(args.mode==='plan'){
  const {identity}=await loadIdentity();return {mode:'plan' as const,serviceId:identity.host.scope.serviceId,configurationSha256:identity.configurationSha256,qualificationSha256:identity.qualificationSha256,expiresAt:identity.host.scope.expiresAt,actionPerformed:false,databaseAuthorityVerified:false};
 }
 const connection=args.mode==='start'?await readImagePreparationRegistrarConnectionInput():undefined;
 try{return await withImagePreparationEnrollmentLock(installed.configRoot,async()=>{
  const {identity,pending,request}=await loadIdentity(),bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  const units=createImagePreparationHostSystemdControl({host:identity.host,hostConfigurationSha256:request.qualification.hostConfigurationSha256,configurationSha256:identity.configurationSha256,qualificationSha256:identity.qualificationSha256,bootId});
  const verifyLocal=async()=>{
   const current=await readCurrentImagePreparationHostQualification(args.hostPath,args.bundleSha256);
   if(current.qualificationSha256!==identity.qualificationSha256||!current.hostBytes.equals(identity.hostBytes))fail();
   const fresh=await enrollment.read();if(!fresh?.intentBytes?.equals(pending.intentBytes)||fresh.token!==pending.token||!fresh.submission)fail();
   const path=join(installed.configRoot,'service-token.json');await archiveHostTrusted(path);const info=await lstat(path);
   if(info.uid!==0||info.gid!==identity.host.gid||(info.mode&0o7777)!==0o640)fail();
   const published=JSON.parse((await archiveHostRead(path,4096)).toString('utf8')),configuration=deriveImagePreparationRunnerConfiguration(identity.host,request.qualification.hostConfigurationSha256,identity.qualificationSha256);
   if(parseImagePreparationRunnerToken(published,configuration)!==pending.token)fail();
  };
  const verifyAuthority=async()=>{
   if(!connection)fail();
   const result=await imagePreparationRegistrarLogin(connection,reconcileImagePreparationService,request);
   return imagePreparationControlAuthority(result,{serviceId:request.serviceId,requestId:request.requestId,requestHash:pending.intent.requestHash});
  };
  const verifyPostStartAuthority=async()=>{
   if(!connection)fail();
   const result=await imagePreparationRegistrarLogin(connection,observeImagePreparationServicePostStart,request);
   return imagePreparationControlAuthority(result,{serviceId:request.serviceId,requestId:request.requestId,requestHash:pending.intent.requestHash});
  };
  return executeImagePreparationHostControl({mode:args.mode,store:createImagePreparationHostControlStore(installed.configRoot),identity,verifyLocal,verifyAuthority,verifyPostStartAuthority,units});
 });}finally{if(connection)connection.password='';}
}

export function imagePreparationControlFailureResult(){return {event:'image-preparation-host-control-stopped',code:rejected,outcome:'unconfirmed' as const};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void controlImagePreparationHost(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));}).catch(()=>{console.error(JSON.stringify(imagePreparationControlFailureResult()));process.exitCode=1;});
