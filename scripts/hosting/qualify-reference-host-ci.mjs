/** Root-only disposable Linux CI. Synthetic installed-host qualification; no
 * enrollment, credentials, database/provider requests or worker enablement. */
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {archiveHostHash,archiveHostRead} from './archive-host-package.mjs';
import {ArchiveRuntimeExportError} from './export-archive-host-runtime.mjs';
import {ReferenceHostCiCommandError} from './reference-host-ci-command.mjs';

const fail=()=>{throw Error('REFERENCE_HOST_CI_CHECK_FAILED');};
/** The live implementation supplies exact current-invocation evidence and
 * privileged acceptance. This seam tests negative evidence without weakening it. */
export async function exerciseReferenceHostCiLifecycle(io){
 const same=async expected=>{if(archiveHostHash(await io.receipt())!==archiveHostHash(expected))fail();};
 const accept=async(evidence,previous)=>{const result=await io.accept(evidence,previous);if(result.workerEnabled!==false||result.enrolled!==false)fail();return result;};
 const reject=async(evidence,previous,unchanged)=>{let rejected=false;try{await io.accept(evidence,previous);}catch(error){if(error?.message!=='REFERENCE_HOST_QUALIFICATION_REJECTED')throw error;rejected=true;}if(!rejected)fail();await same(unchanged);};
 await io.disabled();await io.phase('systemd-first-qualification');await io.start();
 const first=await io.current();await io.preserve('first',first);await io.phase('accept-first-qualification');if((await accept(first)).replayed!==false)fail();
 const previous=await io.receipt();await io.preserveReceipt('first',previous);await io.disabled();
 await io.phase('retained-invocation-check');await io.start();const retained=await io.current();
 if(retained.path!==first.path||retained.evidence.qualifierInvocationId!==first.evidence.qualifierInvocationId||archiveHostHash(retained.raw)!==archiveHostHash(first.raw)||archiveHostHash(retained.proof)!==archiveHostHash(first.proof))fail();
 if((await accept(first)).replayed!==true)fail();await same(previous);
 await io.stop();await io.phase('stopped-invocation-rejection');await reject(first,undefined,previous);
 await io.phase('systemd-second-qualification');await io.start();const second=await io.current();await io.preserve('second',second);
 if(second.path===first.path||second.evidence.qualifierInvocationId===first.evidence.qualifierInvocationId)fail();
 await io.phase('prior-invocation-and-cas-rejection');await reject(first,archiveHostHash(previous),previous);await reject(second,'0'.repeat(64),previous);await reject(second,undefined,previous);
 await io.phase('accept-second-qualification');if((await accept(second,archiveHostHash(previous))).replayed!==false)fail();const current=await io.receipt();await io.preserveReceipt('second',current);
 if(archiveHostHash(await io.history(archiveHostHash(previous)))!==archiveHostHash(previous))fail();
 if((await accept(second,archiveHostHash(current))).replayed!==true)fail();await same(current);
 await io.stop();await io.phase('worker-remains-disabled');await io.disabled(true);
 return {first:first.evidence,second:second.evidence,repeatQualificationPassed:true,retainedInvocationProved:true,stoppedEvidenceRejected:true,priorInvocationRejected:true,missingCasRejected:true,wrongCasRejected:true,receiptHistoryProved:true,receiptReplayProved:true,qualifierStoppedAfterAcceptance:true,workerRemainedInactive:true};
}

export async function qualifyReferenceHostCi(){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.env.CI!=='true'||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))throw Error('Explicit root disposable Linux CI required.');
 const configPath=process.env.COATRIA_MEDIA_QUALIFICATION;if(!configPath||!process.env.COATRIA_NPM_CACHE)fail();
 const config=JSON.parse(await archiveHostRead(configPath)),output=resolve('.devdata/media-sandbox-linux/evidence'),base='/var/lib/coatria-reference-build-'+randomUUID(),serviceId=randomUUID(),started=Date.now();
 if(!Number.isInteger(config.uid)||config.uid<1||!Number.isInteger(config.gid)||config.gid<1)fail();await mkdir(base,{mode:0o755});
 const exports=new Map(),preserved=new Set(),report={version:1,qualified:false,productionQualified:false,enrolled:false,workerEnabled:false,noProviderCalls:true,noCredentials:true,phase:'prerequisites',phaseDurationsMs:{}};let failed=false,host,command,state,lastPhaseAt=Date.now();
 const phase=name=>{report.phaseDurationsMs[report.phase]=(report.phaseDurationsMs[report.phase]??0)+Date.now()-lastPhaseAt;report.phase=name;lastPhaseAt=Date.now();};
 try{
  const [{exportArchiveHostRuntime},{buildTrustedServiceBundle},{buildReferenceHostBundle},{installReferenceHost},{readReferenceHostConfiguration,REFERENCE_HOST_CONFIG,REFERENCE_HOST_STATE},{acceptReferenceHostQualification,referenceHostQualificationState,referenceHostJournalProof},{createReferenceHostCiCommand,createReferenceHostCiAcceptor}]=await Promise.all([
   import('./export-archive-host-runtime.mjs'),import('./build-trusted-service-bundle.mjs'),import('./build-reference-host-bundle.mjs'),import('./install-reference-host.mjs'),import('./reference-host-package.mjs'),import('./reference-host-qualification.mjs'),import('./reference-host-ci-command.mjs')]);
  command=createReferenceHostCiCommand(serviceId);command('create_service_user');
  phase('offline-runtime-export');const runtime=await exportArchiveHostRuntime({sourceRoot:process.cwd(),qualificationPath:configPath,npmCache:process.env.COATRIA_NPM_CACHE,output:join(base,'prepared-runtime')});
  phase('exact-standalone-bundles');const bundles={};for(const service of ['reference','reference-qualification'])bundles[service]=await buildTrustedServiceBundle({root:process.cwd(),commit:process.env.GITHUB_SHA,service,output:join(base,service)});
  phase('exact-host-bundle');const build=await buildReferenceHostBundle({sourceRoot:process.cwd(),commit:process.env.GITHUB_SHA,runtimeRoot:runtime.output,runtimeManifestSha256:runtime.runtimeManifestSha256,workerBundlePath:bundles.reference.output,workerBundleSha256:bundles.reference.bundleSha256,qualifierBundlePath:bundles['reference-qualification'].output,qualifierBundleSha256:bundles['reference-qualification'].bundleSha256,output:join(base,'bundle')});
  const scope={version:1,serviceId,companyId:randomUUID(),projectIds:[randomUUID()],origin:'https://coatria.com',expiresAt:new Date(Date.now()+3600000-1000).toISOString(),uploadHosts:['reference-qualification.invalid']},scopeBytes=Buffer.from(JSON.stringify(scope)+'\n'),scopePath=join(base,'scope.json');await writeFile(scopePath,scopeBytes,{flag:'wx',mode:0o444});
  phase('install-disabled');const plan=await installReferenceHost(build.output,build.bundleSha256,scopePath,archiveHostHash(scopeBytes));command('reload_units');
  const configRoot=join(REFERENCE_HOST_CONFIG,serviceId),hostPath=join(configRoot,'host.json'),receiptPath=join(configRoot,'qualified.json');state=join(REFERENCE_HOST_STATE,serviceId,'evidence');
  ({host}=await readReferenceHostConfiguration(hostPath,build.bundleSha256,{trusted:true}));const compiledAccept=createReferenceHostCiAcceptor(serviceId,build.bundleSha256);let compiledAcceptanceProved=false;
  const absent=async path=>{try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}fail();};
  const disabled=async(tryStart=false)=>{for(const mode of ['qualify','preflight','worker'])if(command('read_unit_install_state',mode)!=='static')fail();for(const name of ['worker.env','worker-enabled','service.env','token'])await absent(join(configRoot,name));if(tryStart)command('start_disabled_worker');for(const mode of ['worker','preflight'])if(command('read_unit_state',mode)!=='inactive')fail();};
  for(const mode of ['qualify','preflight','worker'])if(command('read_unit_state',mode)!=='inactive')fail();await absent(receiptPath);
  const current=async()=>{
   const unitState=referenceHostQualificationState(command('read_qualifier_state'),host),invocationId=unitState.InvocationID,names=await readdir(state);if(names.length>1000)fail();
   for(const name of names.filter(n=>/^qualification-[a-f0-9-]{36}$/.test(n))){const path=join(state,name,'host-evidence.json');let raw;try{raw=await archiveHostRead(path,65536);}catch(error){if(error.code==='ENOENT')continue;throw error;}const evidence=JSON.parse(raw);if(evidence.qualifierInvocationId===invocationId){const reportPath=join(state,name,'qualification.json'),proof=await archiveHostRead(reportPath,1024**2);if(archiveHostHash(proof)!==evidence.reportSha256)fail();command('sync_journal');const journalProof=referenceHostJournalProof(command('read_qualifier_diagnostics',invocationId),host,unitState,{evidencePath:path,evidenceSha256:archiveHostHash(raw),reportPath,reportSha256:archiveHostHash(proof)});return {path,raw,evidence,proof,journalProof};}}
   fail();
  };
  Object.assign(report,await exerciseReferenceHostCiLifecycle({phase,disabled,start:()=>command('start_qualifier'),stop:()=>{command('stop_qualifier');if(command('read_unit_state','qualify')!=='inactive')fail();},current,accept:(e,previous)=>{if(!compiledAcceptanceProved){if(previous!==undefined)fail();const result=compiledAccept(e.path,archiveHostHash(e.raw));compiledAcceptanceProved=true;return result;}return acceptReferenceHostQualification(hostPath,build.bundleSha256,e.path,archiveHostHash(e.raw),previous);},receipt:()=>archiveHostRead(receiptPath,65536),history:sha=>archiveHostRead(join(configRoot,'qualified-'+sha+'.json'),65536),preserve:(label,e)=>{preserved.add(archiveHostHash(e.proof));exports.set('reference-host-'+label+'-evidence.json',e.raw);exports.set('reference-host-'+label+'-qualification.json',e.proof);exports.set('reference-host-'+label+'-journal-proof.json',Buffer.from(JSON.stringify(e.journalProof,null,2)+'\n'));},preserveReceipt:(label,bytes)=>exports.set('reference-host-'+label+'-receipt.json',bytes)}));
  for(const [name,path]of [['bundle',join(build.output,'bundle.json')],['host',hostPath],['worker-bundle',join(bundles.reference.output,'bundle.json')],['qualifier-bundle',join(bundles['reference-qualification'].output,'bundle.json')]])exports.set('reference-host-'+name+'.json',await archiveHostRead(path));
  Object.assign(report,{qualified:true,compiledAcceptanceProved,commit:build.commit,tree:build.tree,bundleSha256:build.bundleSha256,runtimeManifestSha256:runtime.runtimeManifestSha256,workerRuntimeSha256:bundles.reference.runtime.sha256,qualifierRuntimeSha256:bundles['reference-qualification'].runtime.sha256,servicesInstalled:plan.installed===true,systemd:command('read_systemd_version').split('\n')[0]});phase('complete');
 }catch(error){failed=true;report.failureCode='REFERENCE_HOST_CI_FAILED';if(error instanceof ReferenceHostCiCommandError||error instanceof ArchiveRuntimeExportError)report.commandOrExportFailure=error.diagnostic;
  if(command)try{const invocationId=command('read_invocation');report.qualifierInvocationId=/^(?!0{32}$)[a-f0-9]{32}$/.test(invocationId)?invocationId:null;if(report.qualifierInvocationId){const raw=command('read_qualifier_diagnostics',invocationId);report.fixedQualificationRejection=raw.split('\n').some(line=>{try{const row=JSON.parse(line),message=JSON.parse(row.MESSAGE);return row._SYSTEMD_INVOCATION_ID===invocationId&&message.event==='reference-host-qualification-failed'&&message.code==='REFERENCE_HOST_QUALIFICATION_REJECTED';}catch{return false;}});}}catch{report.diagnosticUnavailable=true;}
 }finally{
  if(command&&host)try{command('stop_qualifier');report.qualifierInactiveAtExit=command('read_unit_state','qualify')==='inactive';report.workerInactiveAtExit=command('read_unit_state','worker')==='inactive';if(!report.qualifierInactiveAtExit||!report.workerInactiveAtExit){failed=true;report.qualified=false;report.failureCode='REFERENCE_HOST_CI_CLEANUP_FAILED';}}catch{failed=true;report.qualified=false;report.failureCode='REFERENCE_HOST_CI_CLEANUP_FAILED';}
  // A failed native invocation can emit a detailed report before host evidence
  // exists. Retain it as unaccepted evidence without turning it into a receipt.
  if(failed&&state)try{const names=await readdir(state);if(names.length>1000)fail();let index=0;for(const name of names.filter(n=>/^qualification-[a-f0-9-]{36}$/.test(n)).sort()){let bytes;try{bytes=await archiveHostRead(join(state,name,'qualification.json'),1024**2);}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!preserved.has(archiveHostHash(bytes)))exports.set('reference-host-unaccepted-'+(++index)+'-qualification.json',bytes);}}catch{report.detailedFailureReportUnavailable=true;}
  report.durationMs=Date.now()-started;exports.set('reference-host-ci.json',Buffer.from(JSON.stringify(report,null,2)+'\n'));
  // Preserve in a protected root first; only the unprivileged runner may write
  // artifact paths in the checkout. Neither write follows existing links.
  for(const [name,bytes]of exports)await writeFile(join(base,name),bytes,{flag:'wx',mode:0o444});process.setgroups([]);process.setgid(config.gid);process.setuid(config.uid);
  for(const [name,bytes]of exports)await writeFile(join(output,name),bytes,{flag:'wx',mode:0o600});
 }
 if(failed)throw Error('REFERENCE_HOST_CI_FAILED: inspect bounded qualification evidence.');
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void qualifyReferenceHostCi().catch(()=>{console.error('REFERENCE_HOST_CI_FAILED');process.exitCode=1;});
