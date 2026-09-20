/** Disposable Ubuntu VM integration. No provider or database credentials. */
import {randomUUID} from 'node:crypto';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ARCHIVE_HOST_PINS,archiveHostHash,archiveHostNoExtendedAcls,archiveHostRead,archiveHostReceiptCurrent} from './archive-host-package.mjs';
import {exportArchiveHostRuntime,ArchiveRuntimeExportError} from './export-archive-host-runtime.mjs';
import {buildArchiveHostBundle} from './build-archive-host-bundle.mjs';
import {installArchiveHost,acceptArchiveHostQualification} from './install-archive-host.mjs';
import {createArchiveHostCiCommand,ArchiveHostCiCommandError} from './archive-host-ci-command.mjs';

const command=createArchiveHostCiCommand();
if(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==0||process.env.CI!=='true'||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))throw Error('Explicit root disposable Linux CI required.');
const repo=process.cwd(),output=resolve('.devdata/media-sandbox-linux/evidence'),base='/var/lib/coatria-archive-build-'+randomUUID(),configPath=process.env.COATRIA_MEDIA_QUALIFICATION;
if(!configPath||!process.env.COATRIA_NPM_CACHE)throw Error('Pinned CI preparation and cache required.');const config=JSON.parse(await archiveHostRead(configPath));await mkdir(base,{mode:0o755});
const report={qualified:false,noProviderCalls:true,noCredentials:true,phase:'prerequisites'},exports=new Map();let failed=false;
async function latestEvidence(){
 const invocationId=command('read_invocation',['show','coatria-archive-qualify.service','--property=InvocationID','--value']),names=await readdir('/var/lib/coatria-archive-state');if(names.length>1000)throw Error('ARCHIVE_HOST_CI_EVIDENCE_LIMIT');
 for(const name of names.filter(n=>/^qualification-[a-f0-9-]{36}$/.test(n))){const path=join('/var/lib/coatria-archive-state',name,'host-evidence.json');let raw;try{raw=await archiveHostRead(path,32768);}catch(error){if(error.code==='ENOENT')continue;throw error;}const host=JSON.parse(raw);if(host.invocationId===invocationId){const proof=await archiveHostRead(join('/var/lib/coatria-archive-state',name,'qualification.json'));if(archiveHostHash(proof)!==host.qualificationSha256)throw Error('ARCHIVE_HOST_CI_EVIDENCE_CHANGED');return {path,raw,host,proof};}}
 throw Error('ARCHIVE_HOST_CI_EVIDENCE_MISSING');
}
try{
 command('install_acl',['install','-y','--no-install-recommends','acl']);command('create_service_user',['--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','coatria-archive']);
 report.phase='offline-runtime-export';const runtime=await exportArchiveHostRuntime({sourceRoot:repo,qualificationPath:configPath,npmCache:process.env.COATRIA_NPM_CACHE,output:join(base,'prepared-runtime')});
 report.phase='exact-source-bundle';const build=await buildArchiveHostBundle({sourceRoot:repo,commit:process.env.GITHUB_SHA,runtimeRoot:runtime.output,runtimeManifestSha256:runtime.runtimeManifestSha256,output:join(base,'bundle')});
 const aclCanary=join(base,'acl-rejection-control');await writeFile(aclCanary,'original synthetic ACL control',{mode:0o444});command('set_acl_control',['-m','u:coatria-archive:r',aclCanary]);let aclRejected=false;try{archiveHostNoExtendedAcls([aclCanary]);}catch{aclRejected=true;}if(!aclRejected)throw Error('ARCHIVE_HOST_CI_ACL_GUARD_FAILED');
 report.phase='install-disabled';const plan=await installArchiveHost(build.output,build.bundleSha256);command('reload_units',['daemon-reload']);
 for(const unit of plan.units)if(command('read_unit_state',['show',unit.name,'--property=ActiveState','--value'])!=='inactive')throw Error('ARCHIVE_HOST_CI_EAGER_START');
 if(command('read_unit_install_state',['show','coatria-archive-worker.service','--property=UnitFileState','--value'])!=='static')throw Error('ARCHIVE_HOST_CI_ENABLED_UNIT');
 report.phase='systemd-first-qualification';command('start_qualifier',['start','coatria-archive-qualify.service'],210000);const first=await latestEvidence();await acceptArchiveHostQualification(first.path,archiveHostHash(first.raw));
 const previous=await archiveHostRead('/etc/coatria-archive/qualified.json');
 report.phase='systemd-repeat-qualification';command('start_qualifier',['start','coatria-archive-qualify.service'],210000);const second=await latestEvidence();if(first.path===second.path)throw Error('ARCHIVE_HOST_CI_ATTEMPT_REUSED');
 let wrongCas=false;try{await acceptArchiveHostQualification(second.path,archiveHostHash(second.raw),'0'.repeat(64));}catch{wrongCas=true;}if(!wrongCas||archiveHostHash(await archiveHostRead('/etc/coatria-archive/qualified.json'))!==archiveHostHash(previous))throw Error('ARCHIVE_HOST_CI_REVIEW_CAS_FAILED');
 await acceptArchiveHostQualification(second.path,archiveHostHash(second.raw),archiveHostHash(previous));const receipt=JSON.parse(await archiveHostRead('/etc/coatria-archive/qualified.json'));if(archiveHostReceiptCurrent(receipt,build.bundleSha256,'synthetic-different-boot'))throw Error('ARCHIVE_HOST_CI_STALE_BOOT_ACCEPTED');
 report.phase='worker-remains-disabled';command('start_disabled_worker',['start','coatria-archive-worker.service']);if(command('read_unit_state',['show','coatria-archive-worker.service','--property=ActiveState','--value'])!=='inactive')throw Error('ARCHIVE_HOST_CI_UNAPPROVED_WORKER_START');
 const unit=await archiveHostRead('/etc/systemd/system/coatria-archive-qualify.service');Object.assign(report,{qualified:true,phase:'complete',commit:build.commit,tree:build.tree,bundleSha256:build.bundleSha256,runtimeManifestSha256:runtime.runtimeManifestSha256,nodeVersion:ARCHIVE_HOST_PINS.nodeVersion,unitSha256:archiveHostHash(unit),aclGuardProved:true,workerRemainedInactive:true,repeatQualificationPassed:true,receiptCasProved:true,staleBootRejected:true,systemd:command('read_systemd_version',['--version']).split('\n')[0],first:first.host,second:second.host});exports.set('archive-host-qualification.json',second.proof);
}catch(error){failed=true;report.failureCode='ARCHIVE_HOST_CI_FAILED';if(error instanceof ArchiveHostCiCommandError)report.commandFailure=error.diagnostic;if(error instanceof ArchiveRuntimeExportError)report.exportFailure=error.diagnostic;try{report.unitStatus=command('read_failure_state',['show','coatria-archive-qualify.service','--property=ActiveState,Result,ExecMainStatus']);}catch{report.unitStatus='unavailable';}}
finally{
 exports.set('archive-host-bundle.json',Buffer.from(JSON.stringify(report,null,2)+'\n'));
 // Root never follows a workspace or service-owned destination. First preserve
 // bytes exclusively under this protected root, then export as the runner UID.
 for(const [name,bytes]of exports)await writeFile(join(base,name),bytes,{flag:'wx',mode:0o444});
 if(!Number.isInteger(config.uid)||config.uid<1||!Number.isInteger(config.gid)||config.gid<1)throw Error('ARCHIVE_HOST_CI_EXPORT_IDENTITY');process.setgroups([]);process.setgid(config.gid);process.setuid(config.uid);
 for(const [name,bytes]of exports)await writeFile(join(output,name),bytes,{flag:'wx',mode:0o600});
}
if(failed)throw Error('Archive host package/systemd qualification failed; see bounded evidence.');
