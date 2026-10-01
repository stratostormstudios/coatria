/** Root-owned enrollment journal. No SQL implementation, provider, credential
 * environment, activation marker or service-start operation exists here. */
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {archiveHostTrusted} from './archive-host-package.mjs';
import {parseImagePreparationEnrollmentRequest,imagePreparationEnrollmentHash,imagePreparationEnrollmentCanonical as canonical} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
import {parseImagePreparationHostConfiguration,deriveImagePreparationRunnerConfiguration,imagePreparationRunnerConfigurationHash,imagePreparationRunnerReceiptSchema,assertImagePreparationRunnerReceipt,parseImagePreparationRunnerToken} from './image-preparation-runner-configuration.mjs';

export const enrollmentBytesHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class ImagePreparationHostEnrollmentError extends Error{constructor(code='IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED'){super(code);this.name='ImagePreparationHostEnrollmentError';this.code=code;}}
/** @param {string} [code] @returns {never} */
function fail(code){throw new ImagePreparationHostEnrollmentError(code);}
const same=(a,b)=>canonical(a)===canonical(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...keys].sort());
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export const imagePreparationEnrollmentTokenHash=token=>{if(typeof token!=='string'||!/^ips_[A-Za-z0-9_-]{43}$/.test(token))fail();return enrollmentBytesHash(token);};
const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n'),nofollow=constants.O_NOFOLLOW??0;
const reasons=['revoked','expired','authority_changed','recipe_changed'];

/** Historical parsing uses the accepted receipt time, not today's boot/expiry.
 * This validates saved identity only; verifyLocal must prove current qualification. */
export function imagePreparationEnrollmentRequestFromHost(qualified,scope,requestId,tokenHash,{allowExpired=false}={}){
 try{
  if(!exact(scope,['version','enrolledBy','enroller','projects'])||scope.version!==1)fail();
  const {hostBytes,receiptBytes}=qualified,receipt=imagePreparationRunnerReceiptSchema.parse(qualified.receipt);
  if(!Buffer.isBuffer(hostBytes)||!Buffer.isBuffer(receiptBytes)||!same(JSON.parse(hostBytes),qualified.host)||!same(JSON.parse(receiptBytes),receipt)||enrollmentBytesHash(receiptBytes)!==qualified.qualificationSha256)fail();
  const host=parseImagePreparationHostConfiguration(qualified.host,allowExpired?Date.parse(receipt.acceptedAt):Date.now()),hostHash=enrollmentBytesHash(hostBytes),configuration=deriveImagePreparationRunnerConfiguration(host,hostHash,qualified.qualificationSha256);
  assertImagePreparationRunnerReceipt(receipt,configuration,{bootId:receipt.bootId,uid:host.uid,gid:host.gid,hostConfigurationSha256:hostHash,host},allowExpired?Date.parse(receipt.acceptedAt):Date.now());
  if(!same(scope.projects?.map(p=>p.projectId),host.scope.projectIds)||scope.projects.some(p=>host.scope.gateways.find(g=>g.projectId===p.projectId)?.origin!==p.gateway?.origin))fail();
  const qualification=Object.fromEntries(['kind','sourceCommit','sourceTree','bundleSha256','hostConfigurationSha256','configurationSha256','qualifierSha256','conformanceProfileSha256','bootId','uid','gid','qualifierInvocationId','evidenceSha256','reportSha256','acceptedAt'].map(key=>[key,receipt[key]]));
  return parseImagePreparationEnrollmentRequest({version:1,requestId,serviceId:host.scope.serviceId,companyId:host.scope.companyId,enrolledBy:scope.enrolledBy,enroller:scope.enroller,tokenHash,origin:host.scope.origin,location:host.scope.location,releaseSha256:host.worker.sha256,qualificationSha256:qualified.qualificationSha256,profileSha256:host.profiles.real.expectedProfileSha256,sourceCommit:host.commit,closureSha256:host.closureSha256,recipeSha256:host.recipeSha256,transport:'linux_binary_v1',expiresAt:host.scope.expiresAt,projects:scope.projects,qualification},{allowExpired});
 }catch{fail();}
}
export function makeImagePreparationEnrollmentIntent(qualified,scope,{requestId,token,scopeSha256,registrarBundleSha256}){
 if(!sha(scopeSha256)||!sha(registrarBundleSha256))fail();const tokenHash=imagePreparationEnrollmentTokenHash(token),request=imagePreparationEnrollmentRequestFromHost(qualified,scope,requestId,tokenHash);
 return {version:1,kind:'coatria-image-preparation-enrollment-intent',request,requestHash:imagePreparationEnrollmentHash(request),tokenHash,hostConfigurationSha256:request.qualification.hostConfigurationSha256,qualificationSha256:request.qualificationSha256,configurationSha256:request.qualification.configurationSha256,scopeSha256,registrarBundleSha256,createdAt:new Date().toISOString()};
}
export function assertImagePreparationEnrollmentPending(pending,{registrarBundleSha256,scopeSha256}={}){
 try{
  const i=pending?.intent;if(!exact(i,['version','kind','request','requestHash','tokenHash','hostConfigurationSha256','qualificationSha256','configurationSha256','scopeSha256','registrarBundleSha256','createdAt'])||i.version!==1||i.kind!=='coatria-image-preparation-enrollment-intent'||!sha(i.scopeSha256)||!sha(i.registrarBundleSha256)||registrarBundleSha256!==undefined&&registrarBundleSha256!==i.registrarBundleSha256||scopeSha256!==undefined&&scopeSha256!==i.scopeSha256||!date(i.createdAt))fail();
  if(pending.intentBytes!==undefined&&(!Buffer.isBuffer(pending.intentBytes)||!same(JSON.parse(pending.intentBytes),i)))fail();
  const request=parseImagePreparationEnrollmentRequest(i.request,{allowExpired:true});
  if(imagePreparationEnrollmentHash(request)!==i.requestHash||imagePreparationEnrollmentTokenHash(pending.token)!==i.tokenHash||request.tokenHash!==i.tokenHash||enrollmentBytesHash(pending.hostBytes)!==i.hostConfigurationSha256||enrollmentBytesHash(pending.receiptBytes)!==i.qualificationSha256||i.configurationSha256!==request.qualification.configurationSha256||Date.parse(i.createdAt)<Date.parse(request.qualification.acceptedAt)||Date.parse(i.createdAt)>=Date.parse(request.expiresAt)||Date.parse(i.createdAt)>Date.now())fail();
  const expected=imagePreparationEnrollmentRequestFromHost({host:JSON.parse(pending.hostBytes),hostBytes:pending.hostBytes,receipt:JSON.parse(pending.receiptBytes),receiptBytes:pending.receiptBytes,qualificationSha256:i.qualificationSha256},{version:1,enrolledBy:request.enrolledBy,enroller:request.enroller,projects:request.projects},request.requestId,request.tokenHash,{allowExpired:true});
  if(!same(expected,request))fail();return request;
 }catch{fail();}
}
function submission(value,pending){
 if(!exact(value,['version','kind','requestId','requestHash','tokenHash','createdAt'])||value.version!==1||value.kind!=='coatria-image-preparation-enrollment-submit'||value.requestId!==pending.intent.request.requestId||value.requestHash!==pending.intent.requestHash||value.tokenHash!==pending.intent.tokenHash||!date(value.createdAt)||Date.parse(value.createdAt)<Date.parse(pending.intent.createdAt)||Date.parse(value.createdAt)>=Date.parse(pending.intent.request.expiresAt)||Date.parse(value.createdAt)>Date.now())fail('IMAGE_PREPARATION_HOST_ENROLLMENT_SUBMIT_INVALID');return value;
}
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function directory(path,trusted,privateMode=false){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==resolve(path))fail();if(trusted){await archiveHostTrusted(path,true);if(privateMode&&(info.mode&0o7777)!==0o700)fail();}return info;}
async function fileIdentity(path,handle,trusted,{mode=0o600,gid}={}){const info=await handle.stat(),entry=await lstat(path);if(!info.isFile()||entry.isSymbolicLink()||info.nlink!==1||entry.nlink!==1||info.dev!==entry.dev||info.ino!==entry.ino||await realpath(path)!==resolve(path))fail();if(trusted){if(info.uid!==0||(info.mode&0o7777)!==mode||gid!==undefined&&info.gid!==gid)fail();await archiveHostTrusted(path);}return info;}
async function syncDirectory(path,trusted){if(process.platform==='win32'&&!trusted)return;const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
async function readPrivate(path,maxBytes,trusted,permissions){let handle;try{handle=await open(path,constants.O_RDONLY|nofollow);const before=await fileIdentity(path,handle,trusted,permissions);if(before.size<1||before.size>maxBytes)fail();const bytes=await handle.readFile(),after=await fileIdentity(path,handle,trusted,permissions);if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail();return bytes;}finally{await handle?.close();}}
async function writePrivate(path,bytes,trusted){const handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);try{await fileIdentity(path,handle,trusted);await handle.writeFile(bytes);await handle.sync();await fileIdentity(path,handle,trusted);const actual=Buffer.alloc(Buffer.byteLength(bytes));const {bytesRead}=await handle.read(actual,0,actual.length,0);if(bytesRead!==actual.length||!actual.equals(Buffer.from(bytes)))fail();}finally{await handle.close();}}

/** Retained flock file, never stale-PID deletion. The inherited open-file
 * description stays locked in the parent until close/crash. */
export async function withImagePreparationEnrollmentLock(configRoot,operation,{trusted=true}={}){
 if(process.platform!=='linux'||trusted&&process.getuid?.()!==0)fail();await directory(configRoot,trusted);if(trusted)await archiveHostTrusted('/usr/bin/flock');
 const path=join(configRoot,'enrollment.lock'),handle=await open(path,constants.O_RDWR|constants.O_CREAT|nofollow,0o600);
 try{if((await fileIdentity(path,handle,trusted)).size!==0)fail();await handle.sync();await syncDirectory(configRoot,trusted);
  const result=spawnSync('/usr/bin/flock',['-n','-x','3'],{shell:false,stdio:['ignore','pipe','pipe',handle.fd],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},timeout:5000,maxBuffer:1024});if(result.error||result.status!==0)fail(result.status===1?'IMAGE_PREPARATION_HOST_ENROLLMENT_BUSY':undefined);
  await fileIdentity(path,handle,trusted);return await operation();
 }finally{await handle.close();}
}
/** trusted:false permits portable filesystem fixtures only. Installed callers
 * require Linux root, protected ancestors and exact file modes/ownership/ACLs. */
export function createImagePreparationEnrollmentStore(configRoot,{trusted=true}={}){
 if(typeof configRoot!=='string'||resolve(configRoot)!==configRoot||trusted&&(process.platform!=='linux'||process.getuid?.()!==0))fail();
 const root=join(configRoot,'enrollment'),pins=new Map();
 const pin=async(path,privateMode=false)=>{const info=await directory(path,trusted,privateMode),old=pins.get(path);if(old&&(old.dev!==info.dev||old.ino!==info.ino))fail();pins.set(path,{dev:info.dev,ino:info.ino});};
 const check=async()=>{await pin(configRoot);await pin(root,true);};
 const read=async()=>{
  await pin(configRoot);if(!await exists(root))return null;await check();const names=await readdir(root);if(!names.length)return null;
  try{
   if(names.length>261||names.filter(n=>n.startsWith('event-')).length>256||names.some(n=>!['token','host.json','qualified.json','intent.json','submit.json'].includes(n)&&!/^event-[a-f0-9-]{36}\.json$/.test(n)))fail();
   const intentBytes=await readPrivate(join(root,'intent.json'),128*1024,trusted),token=(await readPrivate(join(root,'token'),47,trusted)).toString('utf8'),hostBytes=await readPrivate(join(root,'host.json'),65536,trusted),receiptBytes=await readPrivate(join(root,'qualified.json'),65536,trusted),pending={intent:JSON.parse(intentBytes),intentBytes,token,hostBytes,receiptBytes,submission:null};
   assertImagePreparationEnrollmentPending(pending);
   if(names.includes('submit.json'))pending.submission=submission(JSON.parse(await readPrivate(join(root,'submit.json'),4096,trusted)),pending);
   for(const name of names.filter(n=>n.startsWith('event-')))validateEvent(JSON.parse(await readPrivate(join(root,name),4096,trusted)),pending);
   await check();return pending;
  }catch(error){if(error instanceof ImagePreparationHostEnrollmentError)throw error;fail('IMAGE_PREPARATION_HOST_ENROLLMENT_PENDING_INCOMPLETE');}
 };
 const unchanged=async pending=>{assertImagePreparationEnrollmentPending(pending);const current=await read();if(!current||!current.intentBytes.equals(pending.intentBytes)||current.token!==pending.token||!current.hostBytes.equals(pending.hostBytes)||!current.receiptBytes.equals(pending.receiptBytes))fail();return current;};
 const prepare=async input=>{
  assertImagePreparationEnrollmentPending(input);await pin(configRoot);if(await exists(root)){await check();if((await readdir(root)).length)fail('IMAGE_PREPARATION_HOST_ENROLLMENT_PENDING_EXISTS');}else{await mkdir(root,{mode:0o700});await syncDirectory(configRoot,trusted);}
  await check();await writePrivate(join(root,'token'),input.token,trusted);await syncDirectory(root,trusted);
  await writePrivate(join(root,'host.json'),input.hostBytes,trusted);await writePrivate(join(root,'qualified.json'),input.receiptBytes,trusted);await writePrivate(join(root,'intent.json'),json(input.intent),trusted);await syncDirectory(root,trusted);return read();
 };
 const claimSubmission=async pending=>{
  const current=await unchanged(pending);if(current.submission)return false;parseImagePreparationEnrollmentRequest(current.intent.request);
  const value={version:1,kind:'coatria-image-preparation-enrollment-submit',requestId:current.intent.request.requestId,requestHash:current.intent.requestHash,tokenHash:current.intent.tokenHash,createdAt:new Date().toISOString()};submission(value,current);
  try{await writePrivate(join(root,'submit.json'),json(value),trusted);}catch(error){if(error.code==='EEXIST'){const observed=await read();if(!observed?.submission)fail();return false;}throw error;}
  await syncDirectory(root,trusted);const observed=await unchanged(pending);if(!same(observed.submission,value))fail();return true;
 };
 function validateEvent(event,pending){if(!exact(event,['version','kind','requestId','requestHash','status','active','reason','createdAt'])||event.version!==1||!['outcome','complete'].includes(event.kind)||event.requestId!==pending.intent.request.requestId||event.requestHash!==pending.intent.requestHash||!['committed','absent','unknown','submission-unknown'].includes(event.status)||typeof event.active!=='boolean'||![null,...reasons,'local-qualification-inactive'].includes(event.reason)||!date(event.createdAt))fail();return event;}
 const recordOutcome=async event=>{const pending=await read();if(!pending)fail();validateEvent(event,pending);if((await readdir(root)).filter(n=>n.startsWith('event-')).length>=256)fail('IMAGE_PREPARATION_HOST_ENROLLMENT_JOURNAL_FULL');await writePrivate(join(root,'event-'+randomUUID()+'.json'),json(event),trusted);await syncDirectory(root,trusted);};
 const publish=async(pending,{authorize}={})=>{
  if(typeof authorize!=='function')fail();await unchanged(pending);const assertDisabled=async()=>{await check();if(await exists(join(configRoot,'worker-enabled')))fail('IMAGE_PREPARATION_HOST_ENROLLMENT_ACTIVATION_PRESENT');};await assertDisabled();
  const host=JSON.parse(pending.hostBytes),configuration=deriveImagePreparationRunnerConfiguration(host,pending.intent.hostConfigurationSha256,pending.intent.qualificationSha256),value={version:1,serviceId:host.scope.serviceId,configurationSha256:imagePreparationRunnerConfigurationHash(configuration),expiresAt:host.scope.expiresAt,token:pending.token};parseImagePreparationRunnerToken(value,configuration);
  const path=join(configRoot,'service-token.json'),expected=json(value),permissions={mode:0o640,gid:host.gid};
  if(await exists(path)){if(!(await readPrivate(path,4096,trusted,permissions)).equals(expected))fail('IMAGE_PREPARATION_HOST_ENROLLMENT_CREDENTIAL_CONFLICT');await authorize();await assertDisabled();if(!(await readPrivate(path,4096,trusted,permissions)).equals(expected))fail();return;}
  await authorize();await assertDisabled();await unchanged(pending);
  const handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);
  try{
   await fileIdentity(path,handle,trusted);await handle.writeFile(expected);await handle.sync();const actual=Buffer.alloc(expected.length),read=await handle.read(actual,0,actual.length,0);if(read.bytesRead!==expected.length||!actual.equals(expected))fail();
   await fileIdentity(path,handle,trusted);await syncDirectory(configRoot,trusted);await authorize();await assertDisabled();await unchanged(pending);await fileIdentity(path,handle,trusted);
   if(trusted)await handle.chown(0,host.gid);await handle.chmod(0o640);await handle.sync();await syncDirectory(configRoot,trusted);await fileIdentity(path,handle,trusted,permissions);
  }finally{await handle.close();}
  await assertDisabled();if(!(await readPrivate(path,4096,trusted,permissions)).equals(expected))fail();
 };
 return {root,read,prepare,claimSubmission,recordOutcome,publish};
}

/** Mutation happens only after a durable fixed submit fence. A fence survives
 * all outcomes and makes every subsequent invocation reconcile-only. */
export async function executeImagePreparationHostEnrollment({mode,store,pending,verifyLocal,enroll,reconcile}){
 if(!['enroll','reconcile'].includes(mode)||![verifyLocal,enroll,reconcile].every(v=>typeof v==='function'))fail();
 const request=assertImagePreparationEnrollmentPending(pending),base={serviceId:request.serviceId,requestId:request.requestId,requestHash:pending.intent.requestHash};
 const event=(kind,status,active=false,reason=null)=>store.recordOutcome({version:1,kind,requestId:base.requestId,requestHash:base.requestHash,status,active,reason,createdAt:new Date().toISOString()});
 const outcome=async()=>{const result=await reconcile(request);if(!exact(result,result?.reason===undefined?['status','serviceId','requestId','requestHash','active']:['status','serviceId','requestId','requestHash','active','reason'])||!['committed','absent'].includes(result.status)||result.serviceId!==base.serviceId||result.requestId!==base.requestId||result.requestHash!==base.requestHash||typeof result.active!=='boolean'||result.status==='absent'&&result.active||result.reason!==undefined&&!reasons.includes(result.reason)||result.active&&result.reason!==undefined)fail('IMAGE_PREPARATION_HOST_ENROLLMENT_RECONCILIATION_INVALID');return result;};
 const response=result=>({...base,status:result.status,active:result.active,credentialReady:false,workerEnabled:false,...result.reason?{reason:result.reason}:{}});
 let result;
 try{
  const current=await store.read();if(!current||!current.intentBytes.equals(pending.intentBytes)||current.token!==pending.token)fail();
  result=await outcome();
  if(mode==='enroll'&&result.status==='absent'&&!current.submission){
   parseImagePreparationEnrollmentRequest(request);await verifyLocal(pending);
   if(await store.claimSubmission(pending)){parseImagePreparationEnrollmentRequest(request);await verifyLocal(pending);try{await enroll(request);}catch{await event('outcome','submission-unknown');}result=await outcome();}
  }
  await event('outcome',result.status,result.active,result.reason??null);
  if(result.status==='absent'||!result.active)return response(result);
  const authorize=async()=>{try{parseImagePreparationEnrollmentRequest(request);await verifyLocal(pending);}catch{result={...result,active:false,reason:'local-qualification-inactive'};fail('IMAGE_PREPARATION_HOST_ENROLLMENT_LOCAL_INACTIVE');}result=await outcome();if(result.status!=='committed'||!result.active)fail('IMAGE_PREPARATION_HOST_ENROLLMENT_AUTHORITY_INACTIVE');};
  try{await store.publish(pending,{authorize});await authorize();}catch(error){if(error instanceof ImagePreparationHostEnrollmentError&&['IMAGE_PREPARATION_HOST_ENROLLMENT_LOCAL_INACTIVE','IMAGE_PREPARATION_HOST_ENROLLMENT_AUTHORITY_INACTIVE'].includes(error.code))return response(result);throw error;}
  await event('complete','committed',true);return {...response(result),credentialReady:true};
 }catch(error){try{await event('outcome','unknown');}catch{/* Failed audit never licenses another submission. */}if(error instanceof ImagePreparationHostEnrollmentError)throw error;fail('IMAGE_PREPARATION_HOST_ENROLLMENT_OUTCOME_UNKNOWN');}
}
