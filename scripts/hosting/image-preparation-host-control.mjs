/** Root-owned one-attempt activation. No SQL, provider or enrollment publication
 * implementation is imported. Fences are permanent, including after failure. */
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {archiveHostTrusted} from './archive-host-package.mjs';
import {imagePreparationRunnerCanonical as canonical} from './image-preparation-runner-identity.mjs';
import {parseImagePreparationHostConfiguration,deriveImagePreparationRunnerConfiguration,imagePreparationRunnerConfigurationHash,imagePreparationRunnerReceiptSchema,assertImagePreparationRunnerReceipt} from './image-preparation-runner-configuration.mjs';

export class ImagePreparationHostControlError extends Error{constructor(code='IMAGE_PREPARATION_HOST_CONTROL_REJECTED'){super(code);this.name='ImagePreparationHostControlError';this.code=code;}}
/** @param {string} [code] @returns {never} */
function fail(code){throw new ImagePreparationHostControlError(code);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),same=(a,b)=>canonical(a)===canonical(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...keys].sort());
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),invocation=v=>typeof v==='string'&&/^(?!0{32}$)[a-f0-9]{32}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n'),nofollow=constants.O_NOFOLLOW??0;
const statuses=['not-started','preflight-unknown','start-unknown','running-ready','running-unready','stopped','stop-unknown'];
const identityKeys=['host','hostBytes','receipt','receiptBytes','qualificationSha256','configurationSha256','enrollmentIntentSha256','controllerBundleSha256'];

/** Historical identity validation is deliberately independent of current boot or
 * expiry. Only start's separate callbacks may assert present authority. */
export function assertImagePreparationHostControlIdentity(identity){
 try{
  if(!exact(identity,identityKeys)||!Buffer.isBuffer(identity.hostBytes)||!Buffer.isBuffer(identity.receiptBytes)||identity.hostBytes.length>65536||identity.receiptBytes.length>65536||!same(JSON.parse(identity.hostBytes),identity.host)||!same(JSON.parse(identity.receiptBytes),identity.receipt)||!['qualificationSha256','configurationSha256','enrollmentIntentSha256','controllerBundleSha256'].every(key=>sha(identity[key]))||hash(identity.receiptBytes)!==identity.qualificationSha256)fail();
  const receipt=imagePreparationRunnerReceiptSchema.parse(identity.receipt),host=parseImagePreparationHostConfiguration(identity.host,Date.parse(receipt.acceptedAt)),hostConfigurationSha256=hash(identity.hostBytes),configuration=deriveImagePreparationRunnerConfiguration(host,hostConfigurationSha256,identity.qualificationSha256);
  assertImagePreparationRunnerReceipt(receipt,configuration,{bootId:receipt.bootId,uid:host.uid,gid:host.gid,hostConfigurationSha256,host},Date.parse(receipt.acceptedAt));
  if(imagePreparationRunnerConfigurationHash(configuration)!==identity.configurationSha256||Date.parse(receipt.acceptedAt)>Date.now())fail();
  return {host,configuration,receipt,hostConfigurationSha256,serviceId:host.scope.serviceId,qualificationSha256:identity.qualificationSha256,configurationSha256:identity.configurationSha256,enrollmentIntentSha256:identity.enrollmentIntentSha256,controllerBundleSha256:identity.controllerBundleSha256,expiresAt:host.scope.expiresAt};
 }catch{fail('IMAGE_PREPARATION_HOST_CONTROL_IDENTITY_INVALID');}
}
function identityFacts(identity){const i=assertImagePreparationHostControlIdentity(identity);return {serviceId:i.serviceId,hostConfigurationSha256:i.hostConfigurationSha256,qualificationSha256:i.qualificationSha256,configurationSha256:i.configurationSha256,enrollmentIntentSha256:i.enrollmentIntentSha256,controllerBundleSha256:i.controllerBundleSha256,expiresAt:i.expiresAt};}
function marker(identity){const i=assertImagePreparationHostControlIdentity(identity);return {version:1,serviceId:i.serviceId,configurationSha256:i.configurationSha256,qualificationSha256:i.qualificationSha256,expiresAt:i.expiresAt};}
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function directory(path,trusted,privateMode=false){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==resolve(path))fail();if(trusted){await archiveHostTrusted(path,true);if(privateMode&&(info.mode&0o7777)!==0o700)fail();}return info;}
async function fileIdentity(path,handle,trusted,{mode=0o600,gid}={}){const info=await handle.stat(),entry=await lstat(path);if(!info.isFile()||entry.isSymbolicLink()||info.nlink!==1||entry.nlink!==1||info.dev!==entry.dev||info.ino!==entry.ino||await realpath(path)!==resolve(path))fail();if(trusted){if(info.uid!==0||(info.mode&0o7777)!==mode||gid!==undefined&&info.gid!==gid)fail();await archiveHostTrusted(path);}return info;}
async function syncDirectory(path,trusted){if(process.platform==='win32'&&!trusted)return;const h=await open(path,'r');try{await h.sync();}finally{await h.close();}}
async function readPrivate(path,maxBytes,trusted,permissions){const h=await open(path,constants.O_RDONLY|nofollow);try{const before=await fileIdentity(path,h,trusted,permissions);if(before.size<1||before.size>maxBytes)fail();const bytes=await h.readFile(),after=await fileIdentity(path,h,trusted,permissions);if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail();return bytes;}finally{await h.close();}}
async function writePrivate(path,bytes,trusted){const h=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);try{await fileIdentity(path,h,trusted);await h.writeFile(bytes);await h.sync();await fileIdentity(path,h,trusted);const actual=Buffer.alloc(bytes.length),read=await h.read(actual,0,actual.length,0);if(read.bytesRead!==actual.length||!actual.equals(bytes))fail();}finally{await h.close();}}

/** The retained flock inode is never removed or taken over using stale PIDs. */
export async function withImagePreparationHostControlLock(configRoot,operation,{trusted=true}={}){
 if(typeof operation!=='function'||process.platform!=='linux'||trusted&&process.getuid?.()!==0)fail();await directory(configRoot,trusted);if(trusted)await archiveHostTrusted('/usr/bin/flock');
 const path=join(configRoot,'control.lock'),h=await open(path,constants.O_RDWR|constants.O_CREAT|nofollow,0o600);
 try{if((await fileIdentity(path,h,trusted)).size!==0)fail();await h.sync();await syncDirectory(configRoot,trusted);const result=spawnSync('/usr/bin/flock',['-n','-x','3'],{shell:false,stdio:['ignore','pipe','pipe',h.fd],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},timeout:5000,maxBuffer:1024});if(result.error||result.status!==0)fail(result.status===1?'IMAGE_PREPARATION_HOST_CONTROL_BUSY':undefined);await fileIdentity(path,h,trusted);return await operation();}finally{await h.close();}
}
const portableLocks=new Set();
/** trusted:false exists only for portable fixtures; production requires root,
 * protected paths, precise file modes and the real Linux flock above. */
export function createImagePreparationHostControlStore(configRoot,{trusted=true}={}){
 if(typeof configRoot!=='string'||resolve(configRoot)!==configRoot||trusted&&(process.platform!=='linux'||process.getuid?.()!==0))fail();
 const root=join(configRoot,'control'),pins=new Map();let locked=false;
 const pin=async(path,privateMode=false)=>{const info=await directory(path,trusted,privateMode),old=pins.get(path);if(old&&(old.dev!==info.dev||old.ino!==info.ino))fail();pins.set(path,{dev:info.dev,ino:info.ino});};
 const check=async(identity,includeRoot=true)=>{const facts=identityFacts(identity);if(trusted&&configRoot!==`/etc/coatria-image-preparation/${facts.serviceId}`)fail();await pin(configRoot);if(includeRoot)await pin(root,true);};
 const mutation=()=>{if(trusted&&!locked)fail('IMAGE_PREPARATION_HOST_CONTROL_LOCK_REQUIRED');};
 const withLock=async operation=>{if(locked||portableLocks.has(configRoot))fail('IMAGE_PREPARATION_HOST_CONTROL_BUSY');const run=async()=>{locked=true;try{return await operation();}finally{locked=false;}};if(trusted)return withImagePreparationHostControlLock(configRoot,run);portableLocks.add(configRoot);try{return await run();}finally{portableLocks.delete(configRoot);}};
 function intentValue(value,identity){if(!exact(value,['version','kind',...Object.keys(identityFacts(identity)),'createdAt'])||value.version!==1||value.kind!=='coatria-image-preparation-control-intent'||!same(Object.fromEntries(Object.keys(identityFacts(identity)).map(k=>[k,value[k]])),identityFacts(identity))||!date(value.createdAt)||Date.parse(value.createdAt)>Date.now()||Date.parse(value.createdAt)<Date.parse(identity.receipt.acceptedAt))fail('IMAGE_PREPARATION_HOST_CONTROL_IDENTITY_CHANGED');return value;}
 function fenceValue(value,kind,intent){if(!exact(value,['version','kind','identitySha256','createdAt'])||value.version!==1||value.kind!==kind||value.identitySha256!==hash(json(intent))||!date(value.createdAt)||Date.parse(value.createdAt)<Date.parse(intent.createdAt)||Date.parse(value.createdAt)>Date.now())fail('IMAGE_PREPARATION_HOST_CONTROL_STATE_INCOMPLETE');return value;}
 function invocationValue(value,intent){if(!exact(value,['version','kind','identitySha256','bootId','invocationId','createdAt'])||value.version!==1||value.kind!=='worker-invocation'||value.identitySha256!==hash(json(intent))||!uuid(value.bootId)||!invocation(value.invocationId)||!date(value.createdAt)||Date.parse(value.createdAt)<Date.parse(intent.createdAt)||Date.parse(value.createdAt)>Date.now())fail();return value;}
 function eventValue(value,intent){if(!exact(value,['version','kind','identitySha256','status','invocationId','bootId','workerEnabled','runningReady','processStopped','cleanupConfirmed','createdAt'])||value.version!==1||value.kind!=='outcome'||value.identitySha256!==hash(json(intent))||!statuses.includes(value.status)||value.invocationId!==null&&!invocation(value.invocationId)||value.bootId!==null&&!uuid(value.bootId)||!['workerEnabled','runningReady','processStopped','cleanupConfirmed'].every(k=>typeof value[k]==='boolean')||value.runningReady&&value.processStopped||value.cleanupConfirmed&&!value.processStopped||!date(value.createdAt)||Date.parse(value.createdAt)<Date.parse(intent.createdAt)||Date.parse(value.createdAt)>Date.now())fail();return value;}
 const read=async identity=>{
  await check(identity,false);if(!await exists(root))return null;await check(identity);const names=await readdir(root);if(!names.length)return null;
  try{
   if(names.length>261||names.filter(n=>n.startsWith('event-')).length>256||names.some(n=>!['intent.json','preflight-start.json','start.json','stop.json','worker-invocation.json'].includes(n)&&!/^event-[a-f0-9-]{36}\.json$/.test(n)))fail();
   const intent=intentValue(JSON.parse(await readPrivate(join(root,'intent.json'),8192,trusted)),identity),fences={};
   for(const [name,kind]of [['preflight-start.json','preflight-start'],['start.json','start'],['stop.json','stop']])fences[kind]=names.includes(name)?fenceValue(JSON.parse(await readPrivate(join(root,name),4096,trusted)),kind,intent):null;
   const workerInvocation=names.includes('worker-invocation.json')?invocationValue(JSON.parse(await readPrivate(join(root,'worker-invocation.json'),4096,trusted)),intent):null;
   if(fences.start&&!fences['preflight-start']||workerInvocation&&!fences.start)fail();
   const outcomes=[];for(const name of names.filter(n=>n.startsWith('event-')))outcomes.push(eventValue(JSON.parse(await readPrivate(join(root,name),4096,trusted)),intent));
   await check(identity);return {intent,preflightStarted:!!fences['preflight-start'],startStarted:!!fences.start,stopRequested:!!fences.stop,workerInvocation:workerInvocation?{bootId:workerInvocation.bootId,invocationId:workerInvocation.invocationId}:null,outcomes};
  }catch(error){if(error instanceof ImagePreparationHostControlError)throw error;fail('IMAGE_PREPARATION_HOST_CONTROL_STATE_INCOMPLETE');}
 };
 const prepare=async identity=>{mutation();await check(identity,false);const prior=await read(identity);if(prior)return prior;if(!await exists(root)){await mkdir(root,{mode:0o700});await syncDirectory(configRoot,trusted);}await check(identity);if((await readdir(root)).length)fail();await writePrivate(join(root,'intent.json'),json({version:1,kind:'coatria-image-preparation-control-intent',...identityFacts(identity),createdAt:new Date().toISOString()}),trusted);await syncDirectory(root,trusted);return read(identity);};
 const fence=async(identity,kind)=>{mutation();if(!['preflight-start','start','stop'].includes(kind))fail();const state=await read(identity);if(!state)fail();if(kind==='preflight-start'&&(state.preflightStarted||state.stopRequested)||kind==='start'&&(!state.preflightStarted||state.startStarted||state.stopRequested)||kind==='stop'&&state.stopRequested)return false;await writePrivate(join(root,kind+'.json'),json({version:1,kind,identitySha256:hash(json(state.intent)),createdAt:new Date().toISOString()}),trusted);await syncDirectory(root,trusted);await read(identity);return true;};
 const recordInvocation=async(identity,observed)=>{mutation();const state=await read(identity);if(!state?.startStarted||!uuid(observed.bootId)||!invocation(observed.invocationId))fail();if(state.workerInvocation){if(!same(state.workerInvocation,{bootId:observed.bootId,invocationId:observed.invocationId}))fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');return;}await writePrivate(join(root,'worker-invocation.json'),json({version:1,kind:'worker-invocation',identitySha256:hash(json(state.intent)),bootId:observed.bootId,invocationId:observed.invocationId,createdAt:new Date().toISOString()}),trusted);await syncDirectory(root,trusted);await read(identity);};
 const recordOutcome=async(identity,result)=>{mutation();const state=await read(identity);if(!state)fail();if(state.outcomes.length>=256)fail('IMAGE_PREPARATION_HOST_CONTROL_JOURNAL_FULL');const {serviceId:_serviceId,...fields}=result,event={version:1,kind:'outcome',identitySha256:hash(json(state.intent)),...fields,createdAt:new Date().toISOString()};eventValue(event,state.intent);await writePrivate(join(root,'event-'+randomUUID()+'.json'),json(event),trusted);await syncDirectory(root,trusted);};
 const markerPresent=async identity=>{await check(identity,false);const path=join(configRoot,'worker-enabled');if(!await exists(path))return false;try{if(!(await readPrivate(path,4096,trusted,{mode:0o640,gid:identity.host.gid})).equals(json(marker(identity))))fail();}catch{fail('IMAGE_PREPARATION_HOST_CONTROL_MARKER_CONFLICT');}return true;};
 const publishMarker=async identity=>{mutation();const state=await read(identity);if(!state?.startStarted||state.stopRequested||await exists(join(configRoot,'worker-enabled')))fail('IMAGE_PREPARATION_HOST_CONTROL_MARKER_CONFLICT');await check(identity);const path=join(configRoot,'worker-enabled'),bytes=json(marker(identity)),h=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);try{await fileIdentity(path,h,trusted);await h.writeFile(bytes);await h.sync();await fileIdentity(path,h,trusted);if(trusted)await h.chown(0,identity.host.gid);await h.chmod(0o640);await h.sync();await syncDirectory(configRoot,trusted);await fileIdentity(path,h,trusted,{mode:0o640,gid:identity.host.gid});}finally{await h.close();}if(!await markerPresent(identity))fail();};
 const removeMarker=async identity=>{mutation();await check(identity,false);const path=join(configRoot,'worker-enabled');if(!await exists(path))return false;if(!await markerPresent(identity))fail();const h=await open(path,constants.O_RDONLY|nofollow);try{await fileIdentity(path,h,trusted,{mode:0o640,gid:identity.host.gid});if(!(await h.readFile()).equals(json(marker(identity))))fail();await check(identity,false);await fileIdentity(path,h,trusted,{mode:0o640,gid:identity.host.gid});await unlink(path);await syncDirectory(configRoot,trusted);}finally{await h.close();}return true;};
 return {root,withLock,read,prepare,fence,recordInvocation,recordOutcome,markerPresent,publishMarker,removeMarker};
}

function observation(value,mode,identity){
 const keys=['mode','unit','bootId','activeState','subState','invocationId','pid','result','runningReady','preflightPassed','processStopped','cgroupEmpty','cleanupConfirmed'];
 if(!exact(value,keys)||value.mode!==mode||value.unit!==identity.host.units[mode].name||!uuid(value.bootId)||!['active','inactive','failed','activating','deactivating','reloading','maintenance','refreshing'].includes(value.activeState)||typeof value.subState!=='string'||!/^[a-z][a-z-]{0,63}$/.test(value.subState)||value.invocationId!==null&&!invocation(value.invocationId)||!Number.isSafeInteger(value.pid)||value.pid<0||![null,'success','failure'].includes(value.result)||!['runningReady','preflightPassed','processStopped','cgroupEmpty','cleanupConfirmed'].every(k=>typeof value[k]==='boolean')||value.processStopped&&(value.pid!==0||!['inactive','failed'].includes(value.activeState))||value.cleanupConfirmed&&(!value.processStopped||!value.cgroupEmpty||!value.invocationId)||value.runningReady&&(mode!=='worker'||value.activeState!=='active'||value.pid===0||!value.invocationId||value.processStopped)||value.preflightPassed&&(mode!=='preflight'||value.result!=='success'||!value.cleanupConfirmed)||mode==='worker'&&value.preflightPassed||mode==='preflight'&&value.runningReady)fail('IMAGE_PREPARATION_HOST_CONTROL_OBSERVATION_INVALID');return value;
}

/** One controller call owns the flock through all observations and commands.
 * An existing preflight/start fence makes start observation-only, never retry. */
export async function executeImagePreparationHostControl({mode,store,identity,verifyLocal,verifyAuthority,verifyPostStartAuthority,units}){
 if(!['start','reconcile','stop'].includes(mode))fail();const facts=assertImagePreparationHostControlIdentity(identity),savedFacts=canonical(identityFacts(identity));
 const immutable=()=>{if(canonical(identityFacts(identity))!==savedFacts)fail('IMAGE_PREPARATION_HOST_CONTROL_IDENTITY_CHANGED');};
 const currentAuthority=async verify=>{immutable();if(Date.parse(facts.expiresAt)<=Date.now())fail('IMAGE_PREPARATION_HOST_CONTROL_EXPIRED');if(typeof verifyLocal!=='function'||typeof verify!=='function')fail();try{await verifyLocal(identity);}catch{fail('IMAGE_PREPARATION_HOST_CONTROL_LOCAL_INACTIVE');}immutable();if(Date.parse(facts.expiresAt)<=Date.now())fail('IMAGE_PREPARATION_HOST_CONTROL_EXPIRED');let authority;try{authority=await verify(identity);}catch{fail('IMAGE_PREPARATION_HOST_CONTROL_AUTHORITY_INACTIVE');}if(!exact(authority,['status','active','serviceId'])||authority.status!=='committed'||authority.active!==true||authority.serviceId!==facts.serviceId)fail('IMAGE_PREPARATION_HOST_CONTROL_AUTHORITY_INACTIVE');immutable();if(Date.parse(facts.expiresAt)<=Date.now())fail('IMAGE_PREPARATION_HOST_CONTROL_EXPIRED');};
 const current=()=>currentAuthority(verifyAuthority);
 return store.withLock(async()=>{
  let state=await store.read(identity),worker;const observe=async(unit,expected)=>{immutable();return observation(await units.observe(unit,expected),unit,identity);};
  const remember=async value=>{if(!state?.startStarted||!value.invocationId)return;const expected={bootId:value.bootId,invocationId:value.invocationId};if(value.bootId!==facts.receipt.bootId||state.workerInvocation&&!same(state.workerInvocation,expected))fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');await store.recordInvocation(identity,value);state=await store.read(identity);if(!state?.startStarted||!same(state.workerInvocation,expected))fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');};
  const response=async value=>{const enabled=await store.markerPresent(identity),known=state?.workerInvocation,status=state?.stopRequested?(value.processStopped?'stopped':'stop-unknown'):known&&value.processStopped?'stopped':value.runningReady&&known?'running-ready':known&&!value.processStopped?'running-unready':state?.startStarted?'start-unknown':state?.preflightStarted?'preflight-unknown':'not-started';return {serviceId:facts.serviceId,status,workerEnabled:enabled,invocationId:known?.invocationId??null,bootId:known?.bootId??null,runningReady:!!known&&value.runningReady,processStopped:value.processStopped,cleanupConfirmed:!!known&&value.cleanupConfirmed};};
  try{
   if(mode==='start'&&!state?.preflightStarted&&!state?.startStarted&&!state?.stopRequested){
    if(typeof verifyPostStartAuthority!=='function')fail();
    if(await store.markerPresent(identity))fail('IMAGE_PREPARATION_HOST_CONTROL_MARKER_CONFLICT');worker=await observe('worker');const preflight=await observe('preflight');if(!worker.processStopped||!worker.cgroupEmpty||worker.invocationId||!preflight.processStopped||!preflight.cgroupEmpty)fail('IMAGE_PREPARATION_HOST_CONTROL_BASELINE_ACTIVE');
    await current();state=await store.prepare(identity);await current();if(!await store.fence(identity,'preflight-start'))fail();state=await store.read(identity);await current();const completed=observation(await units.preflight(),'preflight',identity);if(!completed.preflightPassed||completed.bootId!==facts.receipt.bootId)fail('IMAGE_PREPARATION_HOST_CONTROL_PREFLIGHT_UNCONFIRMED');
    await current();worker=await observe('worker');if(!worker.processStopped||!worker.cgroupEmpty||worker.invocationId)fail('IMAGE_PREPARATION_HOST_CONTROL_BASELINE_ACTIVE');if(!await store.fence(identity,'start'))fail();state=await store.read(identity);await current();await store.publishMarker(identity);await current();
    worker=observation(await units.startWorker(),'worker',identity);await remember(worker);
    // Only this exact durably recorded invocation may have advanced the same
    // storage catalog while starting. Admission and unbound starts stay strict.
    if(state.workerInvocation)await currentAuthority(verifyPostStartAuthority);else await current();
    worker=await observe('worker',state.workerInvocation?.invocationId);if(state.workerInvocation)await remember(worker);
   }else if(mode==='stop'){
    state??=await store.prepare(identity);await store.fence(identity,'stop');state=await store.read(identity);await store.removeMarker(identity);worker=await observe('worker',state.workerInvocation?.invocationId);
    if(state.workerInvocation){if(worker.bootId!==state.workerInvocation.bootId||worker.invocationId!==state.workerInvocation.invocationId)fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');}
    else if(worker.invocationId)fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_UNBOUND');
    if(!worker.processStopped){if(!state.workerInvocation)fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');worker=observation(await units.stopWorker(state.workerInvocation.invocationId),'worker',identity);if(worker.bootId!==state.workerInvocation.bootId||worker.invocationId!==state.workerInvocation.invocationId)fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');}
    await store.removeMarker(identity);
   }else{worker=await observe('worker',state?.workerInvocation?.invocationId);if(state?.workerInvocation&&(worker.bootId!==state.workerInvocation.bootId||worker.invocationId!==state.workerInvocation.invocationId))fail('IMAGE_PREPARATION_HOST_CONTROL_INVOCATION_CHANGED');}
   const result=await response(worker);if(state)await store.recordOutcome(identity,result);return result;
  }catch(error){
   // A failed start can only withdraw its exact marker. Never stop an unpinned
   // invocation, remove a foreign marker, or erase the durable attempt fences.
   if(mode==='start')try{await store.removeMarker(identity);}catch{/* Retain ambiguous/foreign marker for explicit reconciliation. */}
   try{state=await store.read(identity);if(state)await store.recordOutcome(identity,{serviceId:facts.serviceId,status:mode==='stop'?'stop-unknown':state.startStarted?'start-unknown':state.preflightStarted?'preflight-unknown':'not-started',workerEnabled:await store.markerPresent(identity),invocationId:state.workerInvocation?.invocationId??null,bootId:state.workerInvocation?.bootId??null,runningReady:false,processStopped:false,cleanupConfirmed:false});}catch{/* Failed audit cannot license another attempt. */}
   if(error instanceof ImagePreparationHostControlError)throw error;fail('IMAGE_PREPARATION_HOST_CONTROL_OUTCOME_UNKNOWN');
  }
 });
}
