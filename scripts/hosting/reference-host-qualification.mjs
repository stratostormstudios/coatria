/** Reference-only qualification evidence and root acceptance. No credentials,
 * enrollment or enablement. A successful decoder/archive receipt is not enough. */
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {copyFile,lstat,open,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {archiveHostRead,archiveHostTrusted,archiveHostNoExtendedAcls} from './archive-host-package.mjs';
import {readReferenceHostConfiguration,REFERENCE_HOST_CONFIG,REFERENCE_HOST_STATE,REFERENCE_HOST_SERVICE_USER} from './reference-host-package.mjs';
import {deriveReferenceRunnerConfiguration,referenceRunnerConfigurationHash} from './reference-runner-identity.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),uuid=z.uuid(),invocation=z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/),integer=z.number().int().positive(),date=z.iso.datetime();
const projects=z.array(uuid).min(1).max(100).refine(value=>new Set(value).size===value.length),unit=z.object({name:z.string().regex(/^coatria-reference-[a-f0-9-]{36}-(?:qualify|preflight|worker)\.service$/),sha256:hash}).strict();
const binding={serviceId:uuid,companyId:uuid,projectIds:projects,sourceCommit:commit,sourceTree:commit,bundleSha256:hash,releaseSha256:hash,qualifierSha256:hash,hostConfigurationSha256:hash,configurationSha256:hash,profileSha256:hash,conformanceProfileSha256:hash,bootId:uuid,uid:integer,gid:integer,expiresAt:date,units:z.object({qualify:unit,preflight:unit,worker:unit}).strict(),qualifierInvocationId:invocation,serviceRoot:z.string().max(256)};
const checks=z.object({isolation:z.literal(true),resourceLimits:z.literal(true),descendantCleanup:z.literal(true),preparedImages:z.literal(true)}).strict();
export const referenceHostEvidenceSchema=z.object({version:z.literal(1),kind:z.literal('coatria-reference-host-evidence'),...binding,reportSha256:hash,qualified:z.literal(true),noCredentials:z.literal(true),noProviderCalls:z.literal(true),testsPassed:z.literal(10),formatsPassed:z.literal(7),referenceCasesPassed:z.literal(6),checks}).strict();
export const referenceHostReceiptSchema=z.object({version:z.literal(2),kind:z.literal('coatria-reference-worker-qualification'),...binding,evidenceSha256:hash,reportSha256:hash,acceptedAt:date,qualified:z.literal(true),checks}).strict();
export const referenceHostQualificationHash=value=>createHash('sha256').update(value).digest('hex');
export function referenceHostQualificationFailure(){throw Error('REFERENCE_HOST_QUALIFICATION_REJECTED');}
const fail=referenceHostQualificationFailure;
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);

/** @param {readonly string[]} args
 * @returns {{mode:'qualify',hostPath:string,bundleSha256:string}|{mode:'accept',hostPath:string,bundleSha256:string,evidencePath:string,evidenceSha256:string,previousReceiptSha256?:string}|{mode:'crash-child'}} */
export function parseReferenceHostQualificationArguments(args){
 if(!Array.isArray(args)||args.some(v=>typeof v!=='string'))fail();
 if(args.length===1&&args[0]==='--supervisor-crash-child')return {mode:'crash-child'};
 const accept=args[0]==='--accept-qualification',a=accept?args.slice(1):args;
 if(accept?(a.length!==8&&a.length!==10||a[4]!=='--evidence'||a[6]!=='--sha256'||a.length===10&&a[8]!=='--previous'):a.length!==4)fail();
 if(a[0]!=='--host'||a[2]!=='--bundle'||!hash.safeParse(a[3]).success)fail();
 const match=/^\/etc\/coatria-reference\/([a-f0-9-]{36})\/host\.json$/.exec(a[1]);if(!match||!uuid.safeParse(match[1]).success)fail();
 if(!accept)return {mode:'qualify',hostPath:a[1],bundleSha256:a[3]};
 if(!new RegExp('^'+REFERENCE_HOST_STATE+'/'+match[1]+'/evidence/qualification-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/host-evidence\\.json$').test(a[5])||!hash.safeParse(a[7]).success||a.length===10&&!hash.safeParse(a[9]).success)fail();
 return {mode:'accept',hostPath:a[1],bundleSha256:a[3],evidencePath:a[5],evidenceSha256:a[7],...a.length===10?{previousReceiptSha256:a[9]}:{}};
}

/** @param {Readonly<Record<string,string|undefined>>} settings */
export function assertReferenceHostQualificationEnvironment(settings){
 for(const [name,value]of Object.entries(settings))if(value&&(/(?:DATABASE_URL|PGPASSWORD|KEYRING|API_KEY|ACCESS_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)/i.test(name)||['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','LD_PRELOAD','LD_LIBRARY_PATH'].includes(name)))fail();
}

export const REFERENCE_QUALIFIER_STATE_PROPERTIES='LoadState,ActiveState,SubState,MainPID,ExecMainPID,ControlPID,Result,ExecMainStatus,InvocationID,FragmentPath,DropInPaths,NeedDaemonReload,Transient,UnitFileState,User,Group';
/** @param {string} raw @param {any} host @param {string} [expectedInvocation]
 * @returns {Record<string,string>} */
export function referenceHostQualificationState(raw,host,expectedInvocation){
 if(typeof raw!=='string'||raw.length>8192)fail();
 /** @type {Record<string,string>} */
 const state={};const keys=REFERENCE_QUALIFIER_STATE_PROPERTIES.split(',');
 for(const line of raw.trim().split('\n')){const at=line.indexOf('='),key=line.slice(0,at);if(at<1||!keys.includes(key)||Object.hasOwn(state,key))fail();state[key]=line.slice(at+1);}
 if(Object.keys(state).length!==keys.length||state.LoadState!=='loaded'||state.ActiveState!=='active'||state.SubState!=='exited'||state.MainPID!=='0'||!/^\d+$/.test(state.ExecMainPID)||!Number.isSafeInteger(Number(state.ExecMainPID))||Number(state.ExecMainPID)<1||state.ControlPID!=='0'||state.Result!=='success'||state.ExecMainStatus!=='0'||!invocation.safeParse(state.InvocationID).success||expectedInvocation!==undefined&&state.InvocationID!==expectedInvocation||state.FragmentPath!=='/etc/systemd/system/'+host.units.qualify.name||state.DropInPaths!==''||state.NeedDaemonReload!=='no'||state.Transient!=='no'||state.UnitFileState!=='static'||state.User!==REFERENCE_HOST_SERVICE_USER||state.Group!==REFERENCE_HOST_SERVICE_USER)fail();
 return state;
}
export function referenceHostQualificationInvocation(raw,host,expectedInvocation){return referenceHostQualificationState(raw,host,expectedInvocation).InvocationID;}

/** Journald's underscore fields are supplied by the journal, not MESSAGE. Only
 * the exact installed qualifier's main process may attest reviewed file hashes. */
export function referenceHostJournalProof(raw,host,state,expected){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1024**2)fail();const lines=raw.trim().split('\n');if(!raw.trim()||lines.length>256)fail();
 const event={event:'reference-host-qualified',...expected,qualified:true,enrolled:false,workerEnabled:false};let found;
 for(const line of lines){let record;try{record=JSON.parse(line);}catch{fail();}if(!record||typeof record!=='object'||Array.isArray(record))fail();
  if(typeof record.MESSAGE!=='string')continue;let message;try{message=JSON.parse(record.MESSAGE);}catch{continue;}
  if(message?.event!=='reference-host-qualified')continue;
  if(found||canonical(message)!==canonical(event)||record._SYSTEMD_INVOCATION_ID!==state.InvocationID||record._SYSTEMD_UNIT!==host.units.qualify.name||record._PID!==state.ExecMainPID||record._UID!==String(host.uid)||record._GID!==String(host.gid)||record._EXE!==host.release+'/runtime/node'||record._TRANSPORT!=='stdout')fail();
  found={version:1,kind:'coatria-reference-qualification-journal-proof',invocationId:state.InvocationID,unit:host.units.qualify.name,pid:Number(state.ExecMainPID),uid:host.uid,gid:host.gid,executable:record._EXE,...event};
 }
 if(!found)fail();return found;
}

/** Exact host/source/scope binding, independent of an enrolled service token. */
export function referenceHostQualificationBinding(host,hostBytes,observed){
 if(!uuid.safeParse(observed.bootId).success||!invocation.safeParse(observed.invocationId).success||observed.uid!==host.uid||observed.gid!==host.gid||observed.serviceRoot!=='/sys/fs/cgroup/system.slice/'+host.units.qualify.name)fail();
 return {serviceId:host.scope.serviceId,companyId:host.scope.companyId,projectIds:host.scope.projectIds,sourceCommit:host.commit,sourceTree:host.tree,bundleSha256:host.bundleSha256,releaseSha256:host.worker.sha256,qualifierSha256:host.qualifier.sha256,hostConfigurationSha256:referenceHostQualificationHash(hostBytes),configurationSha256:referenceRunnerConfigurationHash(deriveReferenceRunnerConfiguration(host,'0'.repeat(64))),profileSha256:host.profiles.real.expectedProfileSha256,conformanceProfileSha256:host.profiles.conformance.expectedProfileSha256,bootId:observed.bootId,uid:host.uid,gid:host.gid,expiresAt:host.scope.expiresAt,units:host.units,qualifierInvocationId:observed.invocationId,serviceRoot:observed.serviceRoot};
}

const testNames=['boundary','file-descriptor-cap','pids-aggregate-cap','memory-aggregate-cap','aggregate-cpu-bandwidth','normal-exit-descendant-cleanup','deadline-kills-descendants','abort-kills-descendants','supervisor-sigkill-descendant-cleanup','invalid-pin-and-writable-input-denied'];
const formats=['png','jpeg','webp','mp4','mov','wav','mp3'],cases=['png','jpeg','webp','wrong-kind','corrupt-png','cancel-native'];
/** Report contents are checked, not just its success flag or summary counts. */
export function assertReferenceHostDetailedReport(report,host,bundle){
 if(!report||report.qualified!==true||report.runpodQualified!==false||report.noProviderCalls!==true||report.failureCode!==undefined||report.failingCheck!==undefined||report.tests?.length!==10||canonical(report.tests.map(test=>test.name))!==canonical(testNames)||report.tests.some(test=>test.passed!==true)||report.realFormats?.length!==7||canonical(report.realFormats.map(item=>item.format))!==canonical(formats)||report.realFormats.some(item=>item.verification!=='full_decode')||report.realDecoderEvents?.length!==23||report.realDecoderEvents.some(event=>event.drained!==true)||canonical(report.profiles)!==canonical(host.profiles))fail();
 const sourceFiles=new Map(bundle.files.filter(file=>file.path.startsWith('source/')).map(file=>[file.path.slice(7),file.sha256]));
 if(!report.sourceHashes||Object.keys(report.sourceHashes).length!==15||Object.entries(report.sourceHashes).some(([path,sha])=>sourceFiles.get(path)!==sha))fail();
 const reference=report.referenceWorkerIntegration;if(!reference||reference.kind!=='reference-worker-synthetic-linux-integration'||reference.version!==1||reference.passed!==true||reference.productionQualified!==false||reference.installedServiceQualified!==false||reference.enrollmentExercised!==false||reference.providerCalls!==0||reference.syntheticAuthority!==true||reference.syntheticStorage!==true||reference.actualLinuxInspector!==true||reference.unchangedPreparedImages!==true||reference.cases?.length!==6||canonical(reference.cases.map(item=>item.name))!==canonical(cases))fail();
 reference.cases.forEach((item,index)=>{const exits=item.nativeExecutions;if(!Number.isSafeInteger(exits)||(index<4?exits!==[3,3,3,0][index]:exits<1||exits>3)||item.passed!==true||item.drainedAtReturn!==true||item.scratchEmptyAtReturn!==true||item.scratchHandlesClosedAtReturn!==true||item.sourceUnchanged!==true||item.nativeEvidence?.length!==exits||item.nativeEvidence.some(event=>event.drained!==true)||item.status!==(index<3?'awaiting_approval':'failed')||item.inspectionRecorded!==(index<3)||index===5&&(item.cancelledDuringNativeRun!==true||!Number.isSafeInteger(item.observedProcesses)||item.observedProcesses<1))fail();});
 return {isolation:true,resourceLimits:true,descendantCleanup:true,preparedImages:true};
}

export function makeReferenceHostEvidence(host,hostBytes,bundle,reportBytes,observed){
 let report;try{report=JSON.parse(reportBytes);}catch{fail();}const checked=assertReferenceHostDetailedReport(report,host,bundle);
 return referenceHostEvidenceSchema.parse({version:1,kind:'coatria-reference-host-evidence',...referenceHostQualificationBinding(host,hostBytes,observed),reportSha256:referenceHostQualificationHash(reportBytes),qualified:true,noCredentials:true,noProviderCalls:true,testsPassed:10,formatsPassed:7,referenceCasesPassed:6,checks:checked});
}

export function makeReferenceHostReceipt(host,hostBytes,bundle,evidenceBytes,reportBytes,observed,now=Date.now()){
 let evidence;try{evidence=referenceHostEvidenceSchema.parse(JSON.parse(evidenceBytes));}catch{fail();}
 const expected=makeReferenceHostEvidence(host,hostBytes,bundle,reportBytes,observed);if(canonical(evidence)!==canonical(expected)||Date.parse(host.scope.expiresAt)<=now||Date.parse(host.scope.expiresAt)-now>3600000)fail();
 return referenceHostReceiptSchema.parse({version:2,kind:'coatria-reference-worker-qualification',...referenceHostQualificationBinding(host,hostBytes,observed),evidenceSha256:referenceHostQualificationHash(evidenceBytes),reportSha256:evidence.reportSha256,acceptedAt:new Date(now).toISOString(),qualified:true,checks:expected.checks});
}

/** Pure CAS decision; evidence replay does not silently replace a receipt. */
export function referenceHostReceiptReplacement(previous,receipt,expectedPreviousSha256){
 if(expectedPreviousSha256!==undefined&&!hash.safeParse(expectedPreviousSha256).success)fail();
 if(!previous){if(expectedPreviousSha256!==undefined)fail();return {replayed:false,previousSha256:null};}
 const previousSha256=referenceHostQualificationHash(previous);let prior;try{prior=referenceHostReceiptSchema.parse(JSON.parse(previous));}catch{fail();}
 const {acceptedAt:_old,...oldBinding}=prior,{acceptedAt:_new,...newBinding}=receipt;
 if(canonical(oldBinding)===canonical(newBinding)){if(expectedPreviousSha256!==undefined&&expectedPreviousSha256!==previousSha256)fail();return {replayed:true,previousSha256,receipt:prior};}
 if(expectedPreviousSha256!==previousSha256)fail();return {replayed:false,previousSha256};
}

const currentState=(host,expected)=>{const result=spawnSync('/usr/bin/systemctl',['show',host.units.qualify.name,'--property='+REFERENCE_QUALIFIER_STATE_PROPERTIES],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:16384});if(result.status!==0||result.error)fail();return referenceHostQualificationState(result.stdout,host,expected);};
const currentJournal=(host,state,expected)=>{const result=spawnSync('/usr/bin/journalctl',['--unit='+host.units.qualify.name,'_SYSTEMD_INVOCATION_ID='+state.InvocationID,'--output=json','--no-pager','--all'],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:1024**2});if(result.status!==0||result.error)fail();return referenceHostJournalProof(result.stdout,host,state,expected);};
/** Read-only operator prerequisite. Revalidates accepted root copies against
 * the current boot and retained qualifier's trusted journal emission. */
export async function readCurrentReferenceHostQualification(hostPath,bundleSha256){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0)fail();
 const installation=await readReferenceHostConfiguration(hostPath,bundleSha256,{trusted:true}),{host,hostBytes,bundle}=installation,config=join(REFERENCE_HOST_CONFIG,host.scope.serviceId),receiptPath=join(config,'qualified.json');
 await archiveHostTrusted(receiptPath);const receiptBytes=await archiveHostRead(receiptPath,65536),receipt=referenceHostReceiptSchema.parse(JSON.parse(receiptBytes)),qualificationSha256=referenceHostQualificationHash(receiptBytes);
 const evidencePath=join(config,'evidence-'+receipt.evidenceSha256+'.json'),reportPath=join(config,'report-'+receipt.reportSha256+'.json');for(const path of [evidencePath,reportPath])await archiveHostTrusted(path);
 const evidenceBytes=await archiveHostRead(evidencePath,65536),reportBytes=await archiveHostRead(reportPath,1024**2),state=currentState(host,receipt.qualifierInvocationId),bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 const expected=makeReferenceHostReceipt(host,hostBytes,bundle,evidenceBytes,reportBytes,{bootId,invocationId:state.InvocationID,uid:host.uid,gid:host.gid,serviceRoot:'/sys/fs/cgroup/system.slice/'+host.units.qualify.name},Date.parse(receipt.acceptedAt));
 if(canonical(receipt)!==canonical(expected)||Date.parse(receipt.acceptedAt)>Date.now()||Date.parse(receipt.expiresAt)<=Date.now())fail();
 const result=spawnSync('/usr/bin/journalctl',['--unit='+host.units.qualify.name,'_SYSTEMD_INVOCATION_ID='+state.InvocationID,'--output=json','--no-pager','--all'],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:10000,maxBuffer:1024**2});if(result.status!==0||result.error)fail();
 const rows=result.stdout.trim().split('\n');if(rows.length>256)fail();let emitted;
 for(const line of rows){let row,message;try{row=JSON.parse(line);message=typeof row.MESSAGE==='string'?JSON.parse(row.MESSAGE):null;}catch{continue;}if(message?.event==='reference-host-qualified'){if(emitted)fail();emitted=message;}}
 const prefix=REFERENCE_HOST_STATE+'/'+host.scope.serviceId+'/evidence/qualification-';if(!emitted||!new RegExp('^'+prefix+'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/host-evidence\\.json$').test(emitted.evidencePath)||emitted.reportPath!==dirname(emitted.evidencePath)+'/qualification.json')fail();
 const proof=referenceHostJournalProof(result.stdout,host,state,{evidencePath:emitted.evidencePath,evidenceSha256:receipt.evidenceSha256,reportPath:emitted.reportPath,reportSha256:receipt.reportSha256});
 currentState(host,receipt.qualifierInvocationId);if(Date.parse(receipt.expiresAt)<=Date.now()||referenceHostQualificationHash(await archiveHostRead(receiptPath,65536))!==qualificationSha256)fail();
 return {...installation,receipt,receiptBytes,qualificationSha256,proof};
}
async function retained(path,bytes){let handle;try{handle=await open(path,'wx',0o444);await handle.writeFile(bytes);await handle.sync();}catch(error){if(error.code!=='EEXIST')throw error;await archiveHostTrusted(path);if(referenceHostQualificationHash(await archiveHostRead(path,1024**2))!==referenceHostQualificationHash(bytes))fail();}finally{await handle?.close();}}

/** Root-only operator action. No credential mint, enrollment, reload or start. */
export async function acceptReferenceHostQualification(hostPath,bundleSha256,evidencePath,expectedEvidenceSha256,previousReceiptSha256){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||!hash.safeParse(expectedEvidenceSha256).success)fail();
 const installation=await readReferenceHostConfiguration(hostPath,bundleSha256,{trusted:true}),{host,hostBytes,bundle}=installation,config=join(REFERENCE_HOST_CONFIG,host.scope.serviceId),state=join(REFERENCE_HOST_STATE,host.scope.serviceId),evidenceRoot=dirname(evidencePath);
 if(!new RegExp('^'+state+'/evidence/qualification-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/host-evidence\\.json$').test(evidencePath))fail();
 await archiveHostTrusted(state,true);const evidenceParent=join(state,'evidence'),parent=await lstat(evidenceParent);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==host.uid||parent.gid!==host.gid||(parent.mode&0o7777)!==0o700)fail();
 const directory=await lstat(evidenceRoot);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==host.uid||directory.gid!==host.gid||(directory.mode&0o7777)!==0o700)fail();archiveHostNoExtendedAcls([evidenceParent,evidenceRoot]);
 const reportPath=join(evidenceRoot,'qualification.json');for(const path of [evidencePath,reportPath]){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==host.uid||info.gid!==host.gid||(info.mode&0o7777)!==0o600)fail();}
 const evidenceBytes=await archiveHostRead(evidencePath,65536),reportBytes=await archiveHostRead(reportPath,1024**2);if(referenceHostQualificationHash(evidenceBytes)!==expectedEvidenceSha256)fail();
 const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),initialState=currentState(host),invocationId=initialState.InvocationID,observed={bootId,invocationId,uid:host.uid,gid:host.gid,serviceRoot:'/sys/fs/cgroup/system.slice/'+host.units.qualify.name};
 let receipt=makeReferenceHostReceipt(host,hostBytes,bundle,evidenceBytes,reportBytes,observed);const journalExpected={evidencePath,evidenceSha256:expectedEvidenceSha256,reportPath,reportSha256:receipt.reportSha256};currentJournal(host,initialState,journalExpected);const receiptPath=join(config,'qualified.json'),lockPath=join(config,'accept.lock'),lock=await open(lockPath,'wx',0o600),temporary=join(config,'qualified.pending-'+randomUUID());
 try{
  let previous;try{await archiveHostTrusted(receiptPath);previous=await archiveHostRead(receiptPath,65536);}catch(error){if(error.code!=='ENOENT')throw error;}
  const decision=referenceHostReceiptReplacement(previous,receipt,previousReceiptSha256);currentJournal(host,currentState(host,invocationId),journalExpected);
  const fresh=await readReferenceHostConfiguration(hostPath,bundleSha256,{trusted:true});if(referenceHostQualificationHash(fresh.hostBytes)!==referenceHostQualificationHash(hostBytes)||referenceHostQualificationHash(await archiveHostRead(evidencePath,65536))!==expectedEvidenceSha256||referenceHostQualificationHash(await archiveHostRead(reportPath,1024**2))!==receipt.reportSha256)fail();
  if(Date.parse(host.scope.expiresAt)<=Date.now())fail();if(decision.replayed)return {receipt:decision.receipt,workerEnabled:false,enrolled:false,replayed:true};
  if(previous){const history=join(config,'qualified-'+decision.previousSha256+'.json');try{await copyFile(receiptPath,history,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;}await archiveHostTrusted(history);if(referenceHostQualificationHash(await archiveHostRead(history,65536))!==decision.previousSha256||referenceHostQualificationHash(await archiveHostRead(receiptPath,65536))!==decision.previousSha256)fail();}
  await retained(join(config,'evidence-'+expectedEvidenceSha256+'.json'),evidenceBytes);await retained(join(config,'report-'+receipt.reportSha256+'.json'),reportBytes);
  currentJournal(host,currentState(host,invocationId),journalExpected);receipt=makeReferenceHostReceipt(host,hostBytes,bundle,evidenceBytes,reportBytes,observed);
  const handle=await open(temporary,'wx',0o444);try{await handle.writeFile(JSON.stringify(receipt,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  currentJournal(host,currentState(host,invocationId),journalExpected);if(Date.parse(receipt.expiresAt)<=Date.now())fail();await rename(temporary,receiptPath);
  const directoryHandle=await open(config,'r');try{await directoryHandle.sync();}finally{await directoryHandle.close();}
  return {receipt,workerEnabled:false,enrolled:false,replayed:false};
 }finally{try{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}finally{try{await lock.close();}finally{await unlink(lockPath);}}}
}
