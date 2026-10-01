/** Root-only disposable Linux CI. Synthetic installed-host qualification; no
 * enrollment, credentials, database/provider requests or worker enablement. */
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {archiveHostHash,archiveHostRead} from './archive-host-package.mjs';
import {ArchiveRuntimeExportError} from './export-archive-host-runtime.mjs';
import {ImagePreparationHostCiCommandError} from './image-preparation-host-ci-command.mjs';
import {makeImagePreparationHostReport} from './image-preparation-host-qualification.mjs';


const fail=()=>{throw Error('IMAGE_PREPARATION_HOST_CI_CHECK_FAILED');};
/** Presence alone fails: CI never opens or uses any installed credential. */
export async function assertImagePreparationHostCiDisabledFiles(configRoot){
 for(const name of ['worker.env','worker-enabled','service.env','token','service-token.json']){
  try{await lstat(join(configRoot,name));}catch(error){if(error.code==='ENOENT')continue;throw error;}fail();
 }
}
/** The artifact export preserves the exact two reports reviewed in acceptance. */
export function assertImagePreparationHostCiReportBytes(envelope,isolation,transform){
 if(![envelope,isolation,transform].every(Buffer.isBuffer)||envelope.length>1024**2||!envelope.equals(Buffer.from(makeImagePreparationHostReport(isolation,transform))))fail();
 return {isolationSha256:archiveHostHash(isolation),transformSha256:archiveHostHash(transform),reportSha256:archiveHostHash(envelope)};
}
/** The live implementation supplies exact current-invocation evidence and
 * privileged acceptance. This seam tests negative evidence without weakening it. */
export async function exerciseImagePreparationHostCiLifecycle(io){
 const same=async expected=>{if(archiveHostHash(await io.receipt())!==archiveHostHash(expected))fail();};
 const accept=async(evidence,previous)=>{const result=await io.accept(evidence,previous);if(result.workerEnabled!==false||result.enrolled!==false)fail();return result;};
 const reject=async(evidence,previous,unchanged)=>{let rejected=false;try{await io.accept(evidence,previous);}catch(error){if(error?.message!=='IMAGE_PREPARATION_HOST_QUALIFICATION_REJECTED')throw error;rejected=true;}if(!rejected)fail();await same(unchanged);};
 const readAccepted=async(label,evidence,expected)=>{
  const value=await io.readAccepted(),receipt=value.receipt,source=io.source;
  if(archiveHostHash(value.receiptBytes)!==archiveHostHash(expected)||value.qualificationSha256!==archiveHostHash(expected)||archiveHostHash(value.hostBytes)!==source.hostSha256||value.bundle.commit!==source.commit||value.bundle.tree!==source.tree||receipt.kind!=='coatria-image-preparation-qualification-v1'||receipt.recipeSha256!==source.recipeSha256||receipt.closureSha256!==source.closureSha256||receipt.sourceCommit!==source.commit||receipt.sourceTree!==source.tree||receipt.bundleSha256!==source.bundleSha256||receipt.qualifierInvocationId!==evidence.evidence.qualifierInvocationId||receipt.evidenceSha256!==archiveHostHash(evidence.raw)||receipt.reportSha256!==archiveHostHash(evidence.proof))fail();
  await io.preserveCurrent(label,{version:1,kind:'coatria-image-preparation-current-qualification-read',sourceCommit:source.commit,sourceTree:source.tree,bundleSha256:source.bundleSha256,recipeSha256:source.recipeSha256,closureSha256:source.closureSha256,qualificationSha256:value.qualificationSha256,evidenceSha256:receipt.evidenceSha256,reportSha256:receipt.reportSha256,qualifierInvocationId:receipt.qualifierInvocationId,receiptUnchanged:true,journalProof:value.proof});
 };
 const rejectRead=async unchanged=>{let rejected=false;try{await io.readAccepted();}catch(error){if(error?.message!=='IMAGE_PREPARATION_HOST_QUALIFICATION_REJECTED')throw error;rejected=true;}if(!rejected)fail();await same(unchanged);};
 await io.disabled();await io.phase('systemd-first-qualification');await io.start();
 const first=await io.current();await io.preserve('first',first);await io.phase('accept-first-qualification');if((await accept(first)).replayed!==false)fail();
 const previous=await io.receipt();await io.preserveReceipt('first',previous);await io.disabled();
 await io.phase('read-first-current-qualification');await readAccepted('first',first,previous);
 await io.phase('retained-invocation-check');await io.start();const retained=await io.current();
 if(retained.path!==first.path||retained.evidence.qualifierInvocationId!==first.evidence.qualifierInvocationId||archiveHostHash(retained.raw)!==archiveHostHash(first.raw)||archiveHostHash(retained.proof)!==archiveHostHash(first.proof))fail();
 if((await accept(first)).replayed!==true)fail();await same(previous);
 await io.stop();await io.phase('stopped-invocation-rejection');await reject(first,undefined,previous);await rejectRead(previous);
 await io.phase('systemd-second-qualification');await io.start();const second=await io.current();await io.preserve('second',second);
 if(second.path===first.path||second.evidence.qualifierInvocationId===first.evidence.qualifierInvocationId)fail();
 await io.phase('prior-invocation-and-cas-rejection');await reject(first,archiveHostHash(previous),previous);await reject(second,'0'.repeat(64),previous);await reject(second,undefined,previous);
 await io.phase('accept-second-qualification');if((await accept(second,archiveHostHash(previous))).replayed!==false)fail();const current=await io.receipt();await io.preserveReceipt('second',current);
 await io.phase('read-second-current-qualification');await readAccepted('second',second,current);
 if(archiveHostHash(await io.history(archiveHostHash(previous)))!==archiveHostHash(previous))fail();
 if((await accept(second,archiveHostHash(current))).replayed!==true)fail();await same(current);
 await io.stop();await io.phase('stopped-current-qualification-rejection');await rejectRead(current);await io.phase('worker-remains-disabled');await io.disabled(true);
 return {first:first.evidence,second:second.evidence,repeatQualificationPassed:true,retainedInvocationProved:true,stoppedEvidenceRejected:true,priorInvocationRejected:true,missingCasRejected:true,wrongCasRejected:true,receiptHistoryProved:true,receiptReplayProved:true,currentQualificationReadProved:true,stoppedCurrentQualificationRejected:true,qualifierStoppedAfterAcceptance:true,workerRemainedInactive:true};
}

export async function qualifyImagePreparationHostCi(){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.env.CI!=='true'||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))throw Error('Explicit root disposable Linux CI required.');
 const configPath=process.env.COATRIA_MEDIA_QUALIFICATION;if(!configPath||!process.env.COATRIA_NPM_CACHE)fail();
 const config=JSON.parse(await archiveHostRead(configPath)),output=resolve('.devdata/media-sandbox-linux/evidence'),base='/var/lib/coatria-image-preparation-build-'+randomUUID(),serviceId=randomUUID(),started=Date.now();
 if(!Number.isInteger(config.uid)||config.uid<1||!Number.isInteger(config.gid)||config.gid<1)fail();await mkdir(base,{mode:0o755});
 const exports=new Map(),report={version:1,qualified:false,productionQualified:false,enrolled:false,workerEnabled:false,noProviderCalls:true,noCredentials:true,phase:'prerequisites',phaseDurationsMs:{}};let failed=false,host,command,state,lastPhaseAt=Date.now();
 const phase=name=>{report.phaseDurationsMs[report.phase]=(report.phaseDurationsMs[report.phase]??0)+Date.now()-lastPhaseAt;report.phase=name;lastPhaseAt=Date.now();};
 try{
  const [{exportArchiveHostRuntime},{buildTrustedServiceBundle},{buildImagePreparationHostBundle},{installImagePreparationHost},{readImagePreparationHostConfiguration,IMAGE_PREPARATION_HOST_CONFIG,IMAGE_PREPARATION_HOST_STATE},{acceptImagePreparationHostQualification,readCurrentImagePreparationHostQualification,imagePreparationHostQualificationState,imagePreparationHostJournalProof},{createImagePreparationHostCiCommand,createImagePreparationHostCiAcceptor}]=await Promise.all([
   import('./export-archive-host-runtime.mjs'),import('./build-trusted-service-bundle.mjs'),import('./build-image-preparation-host-bundle.mjs'),import('./install-image-preparation-host.mjs'),import('./image-preparation-host-package.mjs'),import('./image-preparation-host-qualification.mjs'),import('./image-preparation-host-ci-command.mjs')]);
  command=createImagePreparationHostCiCommand(serviceId);command('create_service_user');
  phase('offline-runtime-export');const runtime=await exportArchiveHostRuntime({sourceRoot:process.cwd(),qualificationPath:configPath,npmCache:process.env.COATRIA_NPM_CACHE,output:join(base,'prepared-runtime')});
  phase('exact-standalone-bundles');const bundles={};for(const service of ['image-preparation','image-preparation-qualification'])bundles[service]=await buildTrustedServiceBundle({root:process.cwd(),commit:process.env.GITHUB_SHA,service,output:join(base,service)});
  phase('exact-host-bundle');const build=await buildImagePreparationHostBundle({sourceRoot:process.cwd(),commit:process.env.GITHUB_SHA,runtimeRoot:runtime.output,runtimeManifestSha256:runtime.runtimeManifestSha256,workerBundlePath:bundles['image-preparation'].output,workerBundleSha256:bundles['image-preparation'].bundleSha256,qualifierBundlePath:bundles['image-preparation-qualification'].output,qualifierBundleSha256:bundles['image-preparation-qualification'].bundleSha256,output:join(base,'bundle')});
  const projectIds=[randomUUID()],scope={version:1,serviceId,companyId:randomUUID(),projectIds,origin:'https://coatria.com',expiresAt:new Date(Date.now()+3600000-1000).toISOString(),location:'Disposable installed Linux CI',gateways:projectIds.map(projectId=>({projectId,origin:'https://preparation-qualification.invalid'}))},scopeBytes=Buffer.from(JSON.stringify(scope)+'\n'),scopePath=join(base,'scope.json');await writeFile(scopePath,scopeBytes,{flag:'wx',mode:0o444});
  phase('install-disabled');const plan=await installImagePreparationHost(build.output,build.bundleSha256,scopePath,archiveHostHash(scopeBytes));command('reload_units');
  const configRoot=join(IMAGE_PREPARATION_HOST_CONFIG,serviceId),hostPath=join(configRoot,'host.json'),receiptPath=join(configRoot,'qualified.json');state=join(IMAGE_PREPARATION_HOST_STATE,serviceId,'evidence');
  const installation=await readImagePreparationHostConfiguration(hostPath,build.bundleSha256,{trusted:true});host=installation.host;const compiledAccept=createImagePreparationHostCiAcceptor(serviceId,build.bundleSha256);let compiledAcceptanceProved=false;
  const absent=async path=>{try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}fail();};
  const disabled=async(tryStart=false)=>{for(const mode of ['qualify','preflight','worker'])if(command('read_unit_install_state',mode)!=='static')fail();await assertImagePreparationHostCiDisabledFiles(configRoot);if(tryStart)command('start_disabled_worker');for(const mode of ['worker','preflight'])if(command('read_unit_state',mode)!=='inactive')fail();};
  for(const mode of ['qualify','preflight','worker'])if(command('read_unit_state',mode)!=='inactive')fail();await absent(receiptPath);
  const current=async()=>{
   const unitState=imagePreparationHostQualificationState(command('read_qualifier_state'),host),invocationId=unitState.InvocationID,names=await readdir(state);if(names.length>1000)fail();
   for(const name of names.filter(n=>/^qualification-[a-f0-9-]{36}$/.test(n))){const path=join(state,name,'host-evidence.json');let raw;try{raw=await archiveHostRead(path,65536);}catch(error){if(error.code==='ENOENT')continue;throw error;}const evidence=JSON.parse(raw);if(evidence.qualifierInvocationId===invocationId){const reportPath=join(state,name,'image-preparation-qualification.json'),proof=await archiveHostRead(reportPath,1024**2);if(archiveHostHash(proof)!==evidence.reportSha256)fail();command('sync_journal');const journalProof=imagePreparationHostJournalProof(command('read_qualifier_diagnostics',invocationId),host,unitState,{evidencePath:path,evidenceSha256:archiveHostHash(raw),reportPath,reportSha256:archiveHostHash(proof)});const isolation=await archiveHostRead(join(state,name,'qualification.json'),1024**2),transform=await archiveHostRead(join(state,name,'image-preparation-transform.json'),1024**2);assertImagePreparationHostCiReportBytes(proof,isolation,transform);return {path,raw,evidence,proof,journalProof,isolation,transform};}}
   fail();
  };
  Object.assign(report,await exerciseImagePreparationHostCiLifecycle({phase,disabled,source:{commit:build.commit,tree:build.tree,bundleSha256:build.bundleSha256,hostSha256:archiveHostHash(installation.hostBytes),recipeSha256:host.recipeSha256,closureSha256:host.closureSha256},readAccepted:()=>readCurrentImagePreparationHostQualification(hostPath,build.bundleSha256),preserveCurrent:(label,value)=>exports.set('image-preparation-host-'+label+'-current-qualification.json',Buffer.from(JSON.stringify(value,null,2)+'\n')),start:()=>command('start_qualifier'),stop:()=>{command('stop_qualifier');if(command('read_unit_state','qualify')!=='inactive')fail();},current,accept:(e,previous)=>{if(!compiledAcceptanceProved){if(previous!==undefined)fail();const result=compiledAccept(e.path,archiveHostHash(e.raw));compiledAcceptanceProved=true;return result;}return acceptImagePreparationHostQualification(hostPath,build.bundleSha256,e.path,archiveHostHash(e.raw),previous);},receipt:()=>archiveHostRead(receiptPath,65536),history:sha=>archiveHostRead(join(configRoot,'qualified-'+sha+'.json'),65536),preserve:(label,e)=>{exports.set('image-preparation-host-'+label+'-evidence.json',e.raw);exports.set('image-preparation-host-'+label+'-qualification.json',e.proof);exports.set('image-preparation-host-'+label+'-journal-proof.json',Buffer.from(JSON.stringify(e.journalProof,null,2)+'\n'));exports.set('image-preparation-host-'+label+'-isolation.json',e.isolation);exports.set('image-preparation-host-'+label+'-transform.json',e.transform);},preserveReceipt:(label,bytes)=>exports.set('image-preparation-host-'+label+'-receipt.json',bytes)}));
  for(const [name,path]of [['bundle',join(build.output,'bundle.json')],['host',hostPath],['worker-bundle',join(bundles['image-preparation'].output,'bundle.json')],['qualifier-bundle',join(bundles['image-preparation-qualification'].output,'bundle.json')]])exports.set('image-preparation-host-'+name+'.json',await archiveHostRead(path));
  Object.assign(report,{qualified:true,compiledAcceptanceProved,recipeSha256:host.recipeSha256,closureSha256:host.closureSha256,commit:build.commit,tree:build.tree,bundleSha256:build.bundleSha256,runtimeManifestSha256:runtime.runtimeManifestSha256,workerRuntimeSha256:bundles['image-preparation'].runtime.sha256,qualifierRuntimeSha256:bundles['image-preparation-qualification'].runtime.sha256,servicesInstalled:plan.installed===true,systemd:command('read_systemd_version').split('\n')[0]});phase('complete');
 }catch(error){failed=true;report.failureCode='IMAGE_PREPARATION_HOST_CI_FAILED';if(error instanceof ImagePreparationHostCiCommandError||error instanceof ArchiveRuntimeExportError)report.commandOrExportFailure=error.diagnostic;
  if(command)try{const invocationId=command('read_invocation');report.qualifierInvocationId=/^(?!0{32}$)[a-f0-9]{32}$/.test(invocationId)?invocationId:null;if(report.qualifierInvocationId){const raw=command('read_qualifier_diagnostics',invocationId);report.fixedQualificationRejection=raw.split('\n').some(line=>{try{const row=JSON.parse(line),message=JSON.parse(row.MESSAGE);return row._SYSTEMD_INVOCATION_ID===invocationId&&message.event==='image-preparation-host-qualification-failed'&&message.code==='IMAGE_PREPARATION_HOST_QUALIFICATION_REJECTED';}catch{return false;}});}}catch{report.diagnosticUnavailable=true;}
 }finally{
  if(command&&host)try{command('stop_qualifier');report.qualifierInactiveAtExit=command('read_unit_state','qualify')==='inactive';report.workerInactiveAtExit=command('read_unit_state','worker')==='inactive';if(!report.qualifierInactiveAtExit||!report.workerInactiveAtExit){failed=true;report.qualified=false;report.failureCode='IMAGE_PREPARATION_HOST_CI_CLEANUP_FAILED';}}catch{failed=true;report.qualified=false;report.failureCode='IMAGE_PREPARATION_HOST_CI_CLEANUP_FAILED';}
  // A failed native invocation can emit a detailed report before host evidence
  // exists. Retain it as unaccepted evidence without turning it into a receipt.
  if(failed&&state)try{const names=await readdir(state);if(names.length>4)fail();let index=0;for(const name of names.filter(n=>/^qualification-[a-f0-9-]{36}$/.test(n)).sort()){
   const prefix='image-preparation-host-unaccepted-'+(++index),found={};
   for(const [label,file]of [['isolation','qualification.json'],['transform','image-preparation-transform.json'],['qualification','image-preparation-qualification.json']]){try{const bytes=await archiveHostRead(join(state,name,file),1024**2);exports.set(prefix+'-'+label+'.json',bytes);found[label+'Sha256']=archiveHostHash(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}}
   exports.set(prefix+'-binding.json',Buffer.from(JSON.stringify({version:1,kind:'image-preparation-host-unaccepted-ci-evidence',sourceCommit:process.env.GITHUB_SHA,sourceTree:host?.tree??null,bundleSha256:host?.bundleSha256??null,recipeSha256:host?.recipeSha256??null,closureSha256:host?.closureSha256??null,qualified:false,acceptanceAuthority:false,...found},null,2)+'\n'));
  }}catch{report.detailedFailureReportUnavailable=true;}
  report.durationMs=Date.now()-started;exports.set('image-preparation-host-ci.json',Buffer.from(JSON.stringify(report,null,2)+'\n'));
  // Preserve in a protected root first; only the unprivileged runner may write
  // artifact paths in the checkout. Neither write follows existing links.
  for(const [name,bytes]of exports)await writeFile(join(base,name),bytes,{flag:'wx',mode:0o444});process.setgroups([]);process.setgid(config.gid);process.setuid(config.uid);
  for(const [name,bytes]of exports)await writeFile(join(output,name),bytes,{flag:'wx',mode:0o600});
 }
 if(failed)throw Error('IMAGE_PREPARATION_HOST_CI_FAILED: inspect bounded qualification evidence.');
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void qualifyImagePreparationHostCi().catch(()=>{console.error('IMAGE_PREPARATION_HOST_CI_FAILED');process.exitCode=1;});
