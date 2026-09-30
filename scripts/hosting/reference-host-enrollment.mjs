/** Privileged host-side enrollment journal. Files survive ambiguous SQL and
 * process death; this module never starts a service or changes a database. */
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {archiveHostTrusted,archiveHostNoExtendedAcls} from './archive-host-package.mjs';
import {parseReferenceEnrollmentRequest,referenceEnrollmentHash,referenceEnrollmentCanonical} from './reference-enrollment-contract.mjs';
import {referenceHostReceiptSchema} from './reference-host-qualification.mjs';

export const enrollmentBytesHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class ReferenceHostEnrollmentError extends Error{constructor(code='REFERENCE_HOST_ENROLLMENT_REJECTED'){super(code);this.code=code;}}
const fail=(code)=>{throw new ReferenceHostEnrollmentError(code);};
const tokenPattern=/^rfs_[A-Za-z0-9_-]{43}$/;
const nofollow=constants.O_NOFOLLOW??0;
export const referenceEnrollmentTokenHash=token=>{if(typeof token!=='string'||!tokenPattern.test(token))fail();return enrollmentBytesHash(token);};

async function directory(path,trusted){
 const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==resolve(path))fail();
 if(trusted){await archiveHostTrusted(path,true);if((info.mode&0o7777)!==0o700)fail();}
}
async function fileIdentity(path,handle,trusted){
 const info=await handle.stat(),entry=await lstat(path);if(!info.isFile()||entry.isSymbolicLink()||info.nlink!==1||entry.nlink!==1||info.dev!==entry.dev||info.ino!==entry.ino||await realpath(path)!==resolve(path))fail();
 if(trusted){if(info.uid!==0||(info.mode&0o7777)!==0o600)fail();await archiveHostTrusted(path);}
 return info;
}
async function syncDirectory(path,trusted){if(process.platform==='win32'&&!trusted)return;const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
async function readPrivate(path,maxBytes,trusted){
 let handle;try{handle=await open(path,constants.O_RDONLY|nofollow);const before=await fileIdentity(path,handle,trusted);if(before.size<1||before.size>maxBytes)fail();const bytes=await handle.readFile(),after=await fileIdentity(path,handle,trusted);if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail();return bytes;}finally{await handle?.close();}
}
async function writePrivate(path,bytes,trusted){
 const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);try{await fileIdentity(path,handle,trusted);await handle.writeFile(bytes);await handle.sync();await fileIdentity(path,handle,trusted);}finally{await handle.close();}
}
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

/** Linux flock is attached to this inherited open-file description. The parent
 * retains it after the fixed helper exits; OS close/crash releases it. No stale
 * PID-file takeover or deletion race. trusted:false is for isolated FS tests. */
export async function withReferenceEnrollmentLock(configRoot,operation,{trusted=true}={}){
 if(process.platform!=='linux'||trusted&&process.getuid?.()!==0)fail();
 if(trusted){await archiveHostTrusted(configRoot,true);await archiveHostTrusted('/usr/bin/flock');}
 const path=join(configRoot,'enrollment.lock'),handle=await open(path,constants.O_RDWR|constants.O_CREAT|nofollow,0o600);
 try{
  const info=await fileIdentity(path,handle,trusted);if(info.size!==0)fail();await handle.sync();await syncDirectory(configRoot,trusted);
  const locked=spawnSync('/usr/bin/flock',['-n','-x','3'],{shell:false,stdio:['ignore','pipe','pipe',handle.fd],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:5000,maxBuffer:1024});
  if(locked.error||locked.status!==0)fail(locked.status===1?'REFERENCE_HOST_ENROLLMENT_BUSY':'REFERENCE_HOST_ENROLLMENT_REJECTED');
  await fileIdentity(path,handle,trusted);return await operation();
 }finally{await handle.close();}
}

/** Fixed filenames under the protected company-service installation. A partial
 * first write is retained and rejected; it never generates another credential.
 * trusted:false enables portable real-filesystem tests, never used by the CLI. */
export function createReferenceEnrollmentStore(configRoot,{trusted=true}={}){
 const root=join(configRoot,'enrollment');
 const check=async()=>{if(trusted)await archiveHostTrusted(configRoot,true);await directory(root,trusted);};
 const read=async()=>{
  if(!await exists(root))return null;await check();const names=await readdir(root);if(!names.length)return null;
  try{
   const intentBytes=await readPrivate(join(root,'intent.json'),128*1024,trusted),tokenBytes=await readPrivate(join(root,'token'),47,trusted),hostBytes=await readPrivate(join(root,'host.json'),65536,trusted),receiptBytes=await readPrivate(join(root,'qualified.json'),65536,trusted);
   const intent=JSON.parse(intentBytes),token=tokenBytes.toString('utf8');referenceEnrollmentTokenHash(token);
   if(intent?.version!==1||intent.kind!=='coatria-reference-enrollment-intent'||intent.tokenHash!==referenceEnrollmentTokenHash(token)||intent.hostConfigurationSha256!==enrollmentBytesHash(hostBytes)||intent.qualificationSha256!==enrollmentBytesHash(receiptBytes))fail();
   return {intent,intentBytes,token,hostBytes,receiptBytes};
  }catch(error){if(error instanceof ReferenceHostEnrollmentError)throw error;fail('REFERENCE_HOST_ENROLLMENT_PENDING_INCOMPLETE');}
 };
 const prepare=async({intent,token,hostBytes,receiptBytes})=>{
  if(trusted)await archiveHostTrusted(configRoot,true);if(await exists(root)){await check();if((await readdir(root)).length)fail('REFERENCE_HOST_ENROLLMENT_PENDING_EXISTS');}else{await mkdir(root,{mode:0o700});await syncDirectory(configRoot,trusted);}
  if(intent?.tokenHash!==referenceEnrollmentTokenHash(token)||intent.hostConfigurationSha256!==enrollmentBytesHash(hostBytes)||intent.qualificationSha256!==enrollmentBytesHash(receiptBytes))fail();
  // The token is never replaced, including when a later durable write fails.
  await writePrivate(join(root,'token'),token,trusted);await syncDirectory(root,trusted);
  await writePrivate(join(root,'host.json'),hostBytes,trusted);await writePrivate(join(root,'qualified.json'),receiptBytes,trusted);
  await writePrivate(join(root,'intent.json'),JSON.stringify(intent,null,2)+'\n',trusted);await syncDirectory(root,trusted);return read();
 };
 const record=async(event)=>{
  await check();if(!event||typeof event!=='object'||!['attempt','outcome','complete'].includes(event.kind)||Object.keys(event).some(k=>!['version','kind','requestId','requestHash','status','active','code','createdAt'].includes(k)))fail();
  const bytes=JSON.stringify(event,null,2)+'\n';if(Buffer.byteLength(bytes)>4096||/rfs_[A-Za-z0-9_-]{43}|postgres(?:ql)?:\/\//.test(bytes))fail();
  await writePrivate(join(root,'event-'+randomUUID()+'.json'),bytes,trusted);await syncDirectory(root,trusted);
 };
 const publish=async(pending)=>{
  await check();if(await exists(join(configRoot,'worker-enabled')))fail('REFERENCE_HOST_ENROLLMENT_ACTIVATION_PRESENT');
  const current=await read();if(!current||!current.intentBytes.equals(pending.intentBytes)||current.token!==pending.token)fail();
  const path=join(configRoot,'worker.env'),expected=Buffer.from('COATRIA_REFERENCE_SERVICE_TOKEN='+pending.token+'\n');
  if(await exists(path)){if(!(await readPrivate(path,512,trusted)).equals(expected))fail('REFERENCE_HOST_ENROLLMENT_CREDENTIAL_CONFLICT');}
  else{await writePrivate(path,expected,trusted);await syncDirectory(configRoot,trusted);}
 };
 return {root,read,prepare,record,publish};
}

const same=(a,b)=>referenceEnrollmentCanonical(a)===referenceEnrollmentCanonical(b);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** All host/runtime/receipt fields come from the verified installation. The
 * operator supplies only a reviewed sponsor and exact provider/storage pins. */
export function referenceEnrollmentRequestFromHost(qualified,scope,requestId,tokenHash,{allowExpired=false}={}){
 if(!scope||!same(Object.keys(scope).sort(),['enrolledBy','projects','provider','version'])||scope.version!==1)fail();
 const {host,hostBytes,receiptBytes}=qualified,receipt=referenceHostReceiptSchema.parse(qualified.receipt);
 if(enrollmentBytesHash(hostBytes)!==receipt.hostConfigurationSha256||enrollmentBytesHash(receiptBytes)!==qualified.qualificationSha256||host.scope.serviceId!==receipt.serviceId||host.scope.companyId!==receipt.companyId||!same(host.scope.projectIds,receipt.projectIds)||!same(scope.projects?.map(item=>item.projectId),host.scope.projectIds)||host.scope.expiresAt!==receipt.expiresAt||host.worker.sha256!==receipt.releaseSha256||host.profiles.real.expectedProfileSha256!==receipt.profileSha256||host.bundleSha256!==receipt.bundleSha256||host.commit!==receipt.sourceCommit||host.tree!==receipt.sourceTree)fail();
 const qualification=Object.fromEntries(['sourceCommit','sourceTree','bundleSha256','hostConfigurationSha256','configurationSha256','qualifierSha256','conformanceProfileSha256','bootId','uid','gid','qualifierInvocationId','evidenceSha256','reportSha256','acceptedAt'].map(key=>[key,receipt[key]]));
 return parseReferenceEnrollmentRequest({version:1,requestId,serviceId:receipt.serviceId,companyId:receipt.companyId,enrolledBy:scope.enrolledBy,tokenHash,origin:host.scope.origin,releaseSha256:receipt.releaseSha256,qualificationSha256:qualified.qualificationSha256,profileSha256:receipt.profileSha256,expiresAt:receipt.expiresAt,uploadHosts:host.scope.uploadHosts,provider:scope.provider,projects:scope.projects,qualification},{allowExpired});
}
export function makeReferenceEnrollmentIntent(qualified,scope,{requestId,token,scopeSha256,registrarBundleSha256}){
 if(!sha(scopeSha256)||!sha(registrarBundleSha256))fail();const tokenHash=referenceEnrollmentTokenHash(token),request=referenceEnrollmentRequestFromHost(qualified,scope,requestId,tokenHash);
 return {version:1,kind:'coatria-reference-enrollment-intent',request,requestHash:referenceEnrollmentHash(request),tokenHash,hostConfigurationSha256:request.qualification.hostConfigurationSha256,qualificationSha256:request.qualificationSha256,scopeSha256,registrarBundleSha256,createdAt:new Date().toISOString()};
}
/** Historical identity can be reconciled after expiry; this grants no current
 * authority and cannot publish a credential without a fresh local check. */
export function assertReferenceEnrollmentPending(pending,{registrarBundleSha256,scopeSha256}={}){
 const i=pending?.intent;if(!i||!same(Object.keys(i).sort(),['createdAt','hostConfigurationSha256','kind','qualificationSha256','registrarBundleSha256','request','requestHash','scopeSha256','tokenHash','version'])||i.version!==1||i.kind!=='coatria-reference-enrollment-intent'||!sha(i.scopeSha256)||!sha(i.registrarBundleSha256)||registrarBundleSha256!==undefined&&i.registrarBundleSha256!==registrarBundleSha256||scopeSha256!==undefined&&i.scopeSha256!==scopeSha256||!Number.isFinite(Date.parse(i.createdAt)))fail();
 const request=parseReferenceEnrollmentRequest(i.request,{allowExpired:true});
 if(referenceEnrollmentHash(request)!==i.requestHash||referenceEnrollmentTokenHash(pending.token)!==i.tokenHash||request.tokenHash!==i.tokenHash||enrollmentBytesHash(pending.hostBytes)!==i.hostConfigurationSha256||enrollmentBytesHash(pending.receiptBytes)!==i.qualificationSha256)fail();
 let host,receipt;try{host=JSON.parse(pending.hostBytes);receipt=JSON.parse(pending.receiptBytes);}catch{fail();}
 const expected=referenceEnrollmentRequestFromHost({host,hostBytes:pending.hostBytes,receipt,receiptBytes:pending.receiptBytes,qualificationSha256:i.qualificationSha256},{version:1,enrolledBy:request.enrolledBy,projects:request.projects,provider:request.provider},request.requestId,request.tokenHash,{allowExpired:true});
 if(!same(expected,request))fail();return request;
}

/** One mutation at most. Callbacks are code-owned connectors (the CLI always
 * creates independent registrar LOGIN clients), never HTTP/config parameters. */
export async function executeReferenceHostEnrollment({mode,store,pending,verifyLocal,enroll,reconcile}){
 if(!['enroll','reconcile'].includes(mode))fail();const request=assertReferenceEnrollmentPending(pending),base={requestId:request.requestId,requestHash:pending.intent.requestHash};
 const event=(kind,fields={})=>store.record({version:1,kind,...base,...fields,createdAt:new Date().toISOString()});
 const outcome=async()=>{const result=await reconcile(request);if(!result||!['committed','absent'].includes(result.status)||result.serviceId!==request.serviceId||result.requestId!==request.requestId||result.requestHash!==base.requestHash||typeof result.active!=='boolean'||result.status==='absent'&&result.active)fail('REFERENCE_HOST_ENROLLMENT_RECONCILIATION_INVALID');return result;};
 let result;
 try{
  result=await outcome();
  if(mode==='enroll'&&result.status==='absent'){
   parseReferenceEnrollmentRequest(request);await verifyLocal(pending);
   await event('attempt',{status:'started'});
   // A thrown COMMIT response never implies rollback and never causes another
   // INSERT here. Reconcile on a fresh LOGIN under the same database lock.
   try{await enroll(request);}catch(error){await event('outcome',{status:'mutation-response-error',code:/^REFERENCE_ENROLLMENT_[A-Z_]{1,80}$/.test(error?.code??'')?error.code:'REFERENCE_ENROLLMENT_UNKNOWN'});}
   result=await outcome();
  }
 }catch(error){await event('outcome',{status:'unknown',active:false,code:'REFERENCE_ENROLLMENT_UNKNOWN'});throw error instanceof ReferenceHostEnrollmentError?error:new ReferenceHostEnrollmentError('REFERENCE_HOST_ENROLLMENT_OUTCOME_UNKNOWN');}
 await event('outcome',{status:result.status,active:result.active});
 if(result.status==='absent')return {...base,serviceId:request.serviceId,status:'absent',active:false,credentialReady:false,workerEnabled:false};
 if(!result.active)return {...base,serviceId:request.serviceId,status:'committed',active:false,credentialReady:false,workerEnabled:false};
 try{parseReferenceEnrollmentRequest(request);await verifyLocal(pending);}catch{return {...base,serviceId:request.serviceId,status:'committed',active:false,credentialReady:false,workerEnabled:false,reason:'local-qualification-inactive'};}
 await store.publish(pending);await event('complete',{status:'committed',active:true});
 return {...base,serviceId:request.serviceId,status:'committed',active:true,credentialReady:true,workerEnabled:false};
}
