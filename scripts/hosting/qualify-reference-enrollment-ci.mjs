/** Disposable root Linux CI only. Execute the installed registrar with synthetic
 * PostgreSQL authority. This is separate from credential-free host qualification;
 * it neither enrolls production nor enables/starts any worker. */
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFile,lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {archiveHostHash as hash,archiveHostRead,archiveHostTrusted,verifyArchiveTree} from './archive-host-package.mjs';
import {readReferenceHostConfiguration} from './reference-host-package.mjs';
import {acceptReferenceHostQualification,readCurrentReferenceHostQualification,referenceHostQualificationState,referenceHostJournalProof} from './reference-host-qualification.mjs';
import {createReferenceHostCiCommand} from './reference-host-ci-command.mjs';
import {buildTrustedServiceBundle} from './build-trusted-service-bundle.mjs';
import {createReferenceEnrollmentStore,assertReferenceEnrollmentPending,referenceEnrollmentTokenHash} from './reference-host-enrollment.mjs';
import {provisionReferenceRegistrarRole} from '../provision-reference-registrar-role.mjs';
import {HIGGSFIELD_REFERENCE_REGISTRAR_ROLE as ROLE,assertHiggsfieldReferenceRegistrarDatabase} from '../../src/lib/higgsfield-reference-registrar-database.mjs';
import {referenceEnrollmentHash,referenceEnrollmentCanonical as canonical,referenceEnrollmentServiceIdentity,referenceEnrollmentProjectIdentity} from '../../src/lib/higgsfield-reference-enrollment-contract.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/,json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const fail=()=>{throw Error('REFERENCE_ENROLLMENT_CI_REJECTED');};
const check=value=>{if(!value)fail();};
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const same=(a,b)=>canonical(a)===canonical(b);
const absent=async path=>{try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}fail();};

/** No raw child output escapes this function, even on a malformed/error reply. */
export function parseReferenceEnrollmentCiReply(mode,result){
 if(!result||result.error||!Number.isInteger(result.status))fail();
 if(result.status!==0){
  let failure;try{failure=JSON.parse(result.stderr);}catch{fail();}
  if(result.stdout?.trim()||!exact(failure,['event','code','workerEnabled'])||failure.event!=='reference-host-enrollment-stopped'||failure.workerEnabled!==false||!/^REFERENCE_HOST_ENROLLMENT_[A-Z_]{1,80}$/.test(failure.code))fail();
  return {ok:false,code:failure.code};
 }
 if(result.stderr?.trim())fail();let value;try{value=JSON.parse(result.stdout);}catch{fail();}
 if(mode==='plan'){
  check(exact(value,['mode','serviceId','companyId','enrolledBy','projects','provider','expiresAt','qualificationSha256','databaseAuthorityVerified','credentialCreated','workerEnabled'])&&value.mode==='plan'&&uuid.test(value.serviceId)&&uuid.test(value.companyId)&&uuid.test(value.enrolledBy)&&Array.isArray(value.projects)&&plain(value.provider)&&sha.test(value.qualificationSha256)&&value.databaseAuthorityVerified===false&&value.credentialCreated===false&&value.workerEnabled===false);
 }else{
  check(exact(value,['requestId','requestHash','serviceId','status','active','credentialReady','workerEnabled',...Object.hasOwn(value??{},'reason')?['reason']:[]])&&uuid.test(value.requestId)&&uuid.test(value.serviceId)&&sha.test(value.requestHash)&&['committed','absent'].includes(value.status)&&typeof value.active==='boolean'&&typeof value.credentialReady==='boolean'&&value.workerEnabled===false&&(!Object.hasOwn(value,'reason')||value.reason==='local-qualification-inactive'));
  check(!value.credentialReady||value.status==='committed'&&value.active);
 }
 return {ok:true,value};
}

/** Fixed installed paths, modes, minimal environment and stdin-only credential.
 * The run seam is test code only; no HTTP/config selects an implementation. */
export function createReferenceEnrollmentCiRegistrar(host,registrarSha,scopePath,scopeSha,run=spawnSync){
 check(uuid.test(host?.scope?.serviceId)&&sha.test(host?.bundleSha256)&&sha.test(registrarSha)&&sha.test(scopeSha));
 check(host.release==='/var/lib/coatria-reference-releases/'+host.bundleSha256&&/^\/var\/lib\/coatria-reference-enrollment-ci-[a-f0-9-]{36}\/scope\.json$/.test(scopePath));
 const node=host.release+'/runtime/node',entry='/var/lib/coatria-reference-registrars/'+registrarSha+'/runtime.mjs',base=['--host','/etc/coatria-reference/'+host.scope.serviceId+'/host.json','--bundle',host.bundleSha256,'--registrar-bundle',registrarSha];
 return (mode,connectionString)=>{
  check(['plan','enroll','reconcile'].includes(mode));
  if(mode==='plan')check(connectionString===undefined);else{let url;try{url=new URL(connectionString);}catch{fail();}check(url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'&&url.username===ROLE&&url.password&&url.port==='5432'&&/^\/coatria_ref_host_ci_[a-f0-9]{32}$/.test(url.pathname)&&!url.search&&!url.hash);}
  let result;try{result=run(node,[entry,mode,...base,...mode==='reconcile'?[]:['--scope',scopePath,'--scope-sha256',scopeSha]],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},input:mode==='plan'?'':JSON.stringify({connectionString}),encoding:'utf8',timeout:60000,maxBuffer:65536});}catch{fail();}
  const reply=parseReferenceEnrollmentCiReply(mode,result);if(reply.ok)check(reply.value.serviceId===host.scope.serviceId);return reply;
 };
}

/** Independent SQL/file agreement, not the registrar's success flag alone. */
export function referenceEnrollmentCiDatabaseProof(pending,rows,workerEnv){
 const request=assertReferenceEnrollmentPending(pending),identity=referenceEnrollmentServiceIdentity(request);
 check(rows.services.length===1&&rows.projects.length===request.projects.length&&rows.enrollments.length===1);
 const service=rows.services[0],enrollment=rows.enrollments[0];
 check(Object.entries(identity).every(([key,value])=>service[key]===value)&&new Date(service.expires_at).toISOString()===request.expiresAt&&same(service.upload_hosts,request.uploadHosts)&&!service.revoked_at);
 check(same(rows.projects,referenceEnrollmentProjectIdentity(request))&&enrollment.request_id===request.requestId&&enrollment.service_id===request.serviceId&&enrollment.company_id===request.companyId&&enrollment.request_hash===referenceEnrollmentHash(request)&&same(enrollment.identity,request));
 check(service.token_hash===referenceEnrollmentTokenHash(pending.token)&&workerEnv.toString('utf8')==='COATRIA_REFERENCE_SERVICE_TOKEN='+pending.token+'\n');
 return {requestId:request.requestId,requestHash:referenceEnrollmentHash(request),serviceId:request.serviceId,companyId:request.companyId,projectCount:rows.projects.length,qualificationSha256:request.qualificationSha256,hostConfigurationSha256:request.qualification.hostConfigurationSha256,tokenHashMatches:true,credentialSha256:hash(workerEnv),databaseSnapshotSha256:hash(canonical(JSON.parse(JSON.stringify(rows))))};
}

const tools=[
 {name:'media_upload',description:'Synthetic upload schema',inputSchema:{type:'object',properties:{filename:{type:'string'},content_type:{type:'string'},method:{type:'string',enum:['upload_url']}},additionalProperties:false}},
 {name:'media_confirm',description:'Synthetic confirmation schema',inputSchema:{type:'object',properties:{media_id:{type:'string'},type:{type:'string',enum:['image','video','audio','file']}},required:['type'],additionalProperties:false}}
];
async function seed(db,host){
 const companyId=host.scope.companyId,enrolledBy=randomUUID(),providerSponsor=randomUUID(),storageSponsor=randomUUID(),connectionId=randomUUID(),storageConnectionId=randomUUID();
 for(const id of[enrolledBy,providerSponsor,storageSponsor])await db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Installed registrar CI',$2,'not-a-login')",[id,id+'@example.invalid']);
 await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Installed registrar CI',$1::text,'blank')",[companyId]);
 for(const id of[enrolledBy,providerSponsor,storageSponsor])await db.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[companyId,id,id===enrolledBy?'owner':'admin']);
 await db.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,enrolledBy]);
 await db.query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,tools,expires_at) VALUES($1,$2,'connected',$3,'{}',$4,$5)",[companyId,connectionId,providerSponsor,JSON.stringify(tools),host.scope.expiresAt]);
 await db.query("INSERT INTO project_storage_connections(id,company_id,name,region,volume_id,secret_envelope,created_by) VALUES($1,$2,'Synthetic only','US-CA-2','synthetic-fixture-volume','{}',$3)",[storageConnectionId,companyId,storageSponsor]);
 const projects=[];for(const projectId of host.scope.projectIds){
  const bindingId=randomUUID(),gates=Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:enrolledBy}]));
  await db.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Installed registrar CI','Synthetic','Exact prepared image','{\"kind\":\"image\",\"width\":16,\"height\":16,\"format\":\"png\",\"color\":{\"mode\":\"not_required\"}}','allowed','production',$3,$4,'higgsfield',2)",[projectId,companyId,JSON.stringify(gates),enrolledBy]);
  await db.query('INSERT INTO project_storage_bindings(id,company_id,project_id,connection_id,created_by) VALUES($1,$2,$3,$4,$5)',[bindingId,companyId,projectId,storageConnectionId,storageSponsor]);
  projects.push({projectId,projectRevision:1,storageBindingId:bindingId,storageBindingRevision:1,storageConnectionId,storageConnectionRevision:1});
 }
 return {version:1,enrolledBy,provider:{connectionId,connectionRevision:1,catalogSha256:hash(canonical(tools))},projects};
}
async function privateFile(path){await archiveHostTrusted(path);const stat=await lstat(path);check(stat.uid===0&&stat.gid===0&&(stat.mode&0o7777)===0o600&&stat.nlink===1);return archiveHostRead(path,128*1024);}
async function currentEvidence(host,command){
 const unit=referenceHostQualificationState(command('read_qualifier_state'),host),root='/var/lib/coatria-reference-worker/'+host.scope.serviceId+'/evidence',names=await readdir(root);check(names.length<=1000);
 for(const name of names.filter(n=>/^qualification-[a-f0-9-]{36}$/.test(n))){
  const path=join(root,name,'host-evidence.json');let raw;try{raw=await archiveHostRead(path,65536);}catch(error){if(error.code==='ENOENT')continue;throw error;}const evidence=JSON.parse(raw);
  if(evidence.qualifierInvocationId!==unit.InvocationID)continue;
  const reportPath=join(root,name,'qualification.json'),proof=await archiveHostRead(reportPath,1024**2);check(hash(proof)===evidence.reportSha256);command('sync_journal');
  const journalProof=referenceHostJournalProof(command('read_qualifier_diagnostics',unit.InvocationID),host,unit,{evidencePath:path,evidenceSha256:hash(raw),reportPath,reportSha256:hash(proof)});return {path,raw,proof,journalProof};
 }fail();
}

export async function qualifyReferenceEnrollmentCi(){
 check(process.platform==='linux'&&process.arch==='x64'&&process.getuid?.()===0&&process.env.CI==='true'&&/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''));
 const config=JSON.parse(await archiveHostRead(process.env.COATRIA_MEDIA_QUALIFICATION)),output=resolve('.devdata/media-sandbox-linux/evidence');check(Number.isInteger(config.uid)&&config.uid>0&&Number.isInteger(config.gid)&&config.gid>0);
 const base='/var/lib/coatria-reference-enrollment-ci-'+randomUUID(),database='coatria_ref_host_ci_'+randomUUID().replaceAll('-',''),report={version:1,kind:'reference-installed-registrar-ci',passed:false,productionQualified:false,productionEnrolled:false,syntheticCredentialsUsed:true,productionCredentialsUsed:false,workerEnabled:false,noProviderCalls:true,phase:'prerequisites'},exports=new Map();
 let host,command,owner,control,created=false,roleCreated=false,failed=false;const started=Date.now();
 const phase=value=>{report.phase=value;};
 try{
  await mkdir(base,{mode:0o700});await archiveHostTrusted(base,true);
  // Exported host JSON supplies only a locator; the installed root-owned host,
  // complete release, profiles and units are independently verified again.
  const hint=JSON.parse(await archiveHostRead(join(output,'reference-host-host.json'),65536));check(uuid.test(hint?.scope?.serviceId)&&sha.test(hint.bundleSha256));
  const hostPath='/etc/coatria-reference/'+hint.scope.serviceId+'/host.json',installation=await readReferenceHostConfiguration(hostPath,hint.bundleSha256,{trusted:true});host=installation.host;check(host.commit===process.env.GITHUB_SHA&&same(host,hint));
  const configRoot='/etc/coatria-reference/'+host.scope.serviceId,receiptPath=join(configRoot,'qualified.json');command=createReferenceHostCiCommand(host.scope.serviceId);
  const inactive=async()=>{await absent(join(configRoot,'worker-enabled'));for(const mode of['worker','preflight'])check(command('read_unit_state',mode)==='inactive'&&command('read_unit_install_state',mode)==='static');};
  await inactive();check(command('read_unit_state','qualify')==='inactive');await absent(join(configRoot,'worker.env'));await absent(join(configRoot,'enrollment'));
  phase('compile-install-registrar');const build=await buildTrustedServiceBundle({root:process.cwd(),commit:host.commit,service:'reference-registrar',output:join(base,'build')});
  const registrars='/var/lib/coatria-reference-registrars';try{await mkdir(registrars,{mode:0o755});}catch(error){if(error.code!=='EEXIST')throw error;}await archiveHostTrusted(registrars,true);const registrarRoot=join(registrars,build.bundleSha256);await mkdir(registrarRoot,{mode:0o755});
  for(const name of['runtime.mjs','bundle.json'])await copyFile(join(build.output,name),join(registrarRoot,name),constants.COPYFILE_EXCL);
  await verifyArchiveTree(registrarRoot,[{path:'runtime.mjs',...build.runtime,mode:0o444}],{trusted:true,extra:['bundle.json']});check(hash(await archiveHostRead(join(registrarRoot,'bundle.json'),1024**2))===build.bundleSha256);
  exports.set('reference-enrollment-registrar-bundle.json',await archiveHostRead(join(registrarRoot,'bundle.json'),1024**2));
  phase('disposable-postgres');const local=new URL('postgresql://127.0.0.1:5432/coatria_reference_ci');local.username='coatria_test';local.password='local_ci_test_only';control=new pg.Client({connectionString:local.href});await control.connect();
  check(!(await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount);await control.query('CREATE DATABASE '+database);created=true;local.pathname='/'+database;owner=new pg.Client({connectionString:local.href});await owner.connect();
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');for(const name of(await readdir('database')).filter(n=>/^\d.*\.sql$/.test(n)).sort()){await owner.query(await readFile('database/'+name,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
  const scope=await seed(owner,host),scopeBytes=json(scope),scopePath=join(base,'scope.json');await writeFile(scopePath,scopeBytes,{flag:'wx',mode:0o600});
  const password=randomBytes(32).toString('hex'),provision=await provisionReferenceRegistrarRole({connectionString:local.href,password});roleCreated=true;check(provision.ok&&provision.created&&provision.role===ROLE);const restricted=new URL(local);restricted.username=ROLE;restricted.password=password;
  const login=new pg.Client({connectionString:restricted.href});try{await login.connect();await assertHiggsfieldReferenceRegistrarDatabase(login);const identity=(await login.query('SELECT current_user,session_user')).rows[0];check(identity.current_user===ROLE&&identity.session_user===ROLE);report.login=identity;}finally{await login.end();}
  const invoke=createReferenceEnrollmentCiRegistrar(host,build.bundleSha256,scopePath,hash(scopeBytes));
  const rows=async()=>({services:(await owner.query('SELECT * FROM higgsfield_reference_services WHERE id=$1',[host.scope.serviceId])).rows,projects:(await owner.query('SELECT * FROM higgsfield_reference_service_projects WHERE service_id=$1 ORDER BY project_id',[host.scope.serviceId])).rows,enrollments:(await owner.query('SELECT * FROM higgsfield_reference_service_enrollments WHERE service_id=$1',[host.scope.serviceId])).rows});
  phase('stopped-first-enrollment');const stopped=invoke('enroll',restricted.href);check(!stopped.ok&&stopped.code==='REFERENCE_HOST_ENROLLMENT_REJECTED');const empty=await rows();check(Object.values(empty).every(v=>v.length===0));await absent(join(configRoot,'enrollment'));await absent(join(configRoot,'worker.env'));report.stoppedFirstEnrollmentRejected=true;
  phase('requalify-installed-host');const previous=await archiveHostRead(receiptPath,65536);command('start_qualifier');const current=await currentEvidence(host,command);check(JSON.parse(previous).qualifierInvocationId!==JSON.parse(current.raw).qualifierInvocationId);
  await acceptReferenceHostQualification(hostPath,host.bundleSha256,current.path,hash(current.raw),hash(previous));const qualified=await readCurrentReferenceHostQualification(hostPath,host.bundleSha256);check(qualified.receipt.reportSha256===hash(current.proof));
  for(const [name,data]of[['evidence',current.raw],['qualification',current.proof],['receipt',qualified.receiptBytes],['journal-proof',json(current.journalProof)]])exports.set('reference-enrollment-'+name+'.json',data);
  phase('compiled-plan');const plan=invoke('plan');check(plan.ok&&plan.value.companyId===host.scope.companyId&&plan.value.enrolledBy===scope.enrolledBy&&same(plan.value.projects,scope.projects)&&same(plan.value.provider,scope.provider)&&plan.value.qualificationSha256===qualified.qualificationSha256);await absent(join(configRoot,'enrollment'));await absent(join(configRoot,'worker.env'));check(Object.values(await rows()).every(v=>v.length===0));report.planReadOnlyProved=true;
  phase('compiled-enroll');const enrolled=invoke('enroll',restricted.href);check(enrolled.ok&&enrolled.value.status==='committed'&&enrolled.value.active&&enrolled.value.credentialReady);
  const store=createReferenceEnrollmentStore(configRoot),pending=await store.read();check(pending);for(const name of['token','intent.json','host.json','qualified.json'])await privateFile(join(store.root,name));await archiveHostTrusted(store.root,true);const info=await lstat(store.root);check(info.uid===0&&info.gid===0&&(info.mode&0o7777)===0o700);
  const credential=await privateFile(join(configRoot,'worker.env')),proof=referenceEnrollmentCiDatabaseProof(pending,await rows(),credential);check(enrolled.value.requestHash===proof.requestHash&&enrolled.value.requestId===proof.requestId&&proof.qualificationSha256===qualified.qualificationSha256);await inactive();
  phase('compiled-reconcile');const reconciled=invoke('reconcile',restricted.href);check(reconciled.ok&&same(reconciled.value,enrolled.value));check(same(referenceEnrollmentCiDatabaseProof(await store.read(),await rows(),await privateFile(join(configRoot,'worker.env'))),proof));report.exactReplayProved=true;
  phase('stopped-reconciliation');command('stop_qualifier');check(command('read_unit_state','qualify')==='inactive');const inactiveReply=invoke('reconcile',restricted.href);check(inactiveReply.ok&&inactiveReply.value.status==='committed'&&!inactiveReply.value.active&&!inactiveReply.value.credentialReady&&inactiveReply.value.reason==='local-qualification-inactive'&&inactiveReply.value.requestHash===proof.requestHash);check(same(referenceEnrollmentCiDatabaseProof(await store.read(),await rows(),await privateFile(join(configRoot,'worker.env'))),proof));report.stoppedReconciliationInactive=true;
  phase('revoked-reconciliation');await owner.query('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp(),revoked_by=enrolled_by,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',[host.scope.serviceId]);const revoked=invoke('reconcile',restricted.href);check(revoked.ok&&revoked.value.status==='committed'&&!revoked.value.active&&!revoked.value.credentialReady&&revoked.value.requestHash===proof.requestHash);check((await store.read()).intentBytes.equals(pending.intentBytes)&&hash(await privateFile(join(configRoot,'worker.env')))===proof.credentialSha256);const final=await rows();check(final.services.length===1&&final.projects.length===scope.projects.length&&final.enrollments.length===1&&final.services[0].revoked_at&&final.enrollments[0].request_hash===proof.requestHash);await inactive();report.revokedReconciliationInactive=true;
  Object.assign(report,{passed:true,phase:'complete',sourceCommit:host.commit,sourceTree:host.tree,hostBundleSha256:host.bundleSha256,registrarBundleSha256:build.bundleSha256,registrarRuntimeSha256:build.runtime.sha256,registrarRuntimeBytes:build.runtime.bytes,scopeSha256:hash(scopeBytes),qualificationSha256:qualified.qualificationSha256,priorQualificationSha256:hash(previous),qualifierInvocationId:qualified.receipt.qualifierInvocationId,databaseProof:proof,rootPrivateModesProved:true,syntheticEnrollmentExercised:true,compiledRegistrarExecuted:true,independentReconciliationProved:true,credentialUnchangedAfterStopAndRevoke:true,workerRemainedInactive:true,roleGrantsSha256:provision.grantsSha256});
 }catch{failed=true;report.passed=false;report.failureCode='REFERENCE_ENROLLMENT_CI_FAILED';}
 finally{
  if(command&&host)try{command('stop_qualifier');for(const mode of['qualify','worker','preflight'])check(command('read_unit_state',mode)==='inactive');await absent('/etc/coatria-reference/'+host.scope.serviceId+'/worker-enabled');report.allServicesInactiveAtExit=true;}catch{failed=true;report.passed=false;report.cleanupFailed=true;}
  try{await owner?.end();if(created)await control.query('DROP DATABASE '+database+' WITH (FORCE)');if(roleCreated)await control.query('DROP ROLE '+ROLE);report.disposableDatabaseRemoved=created;report.disposableRoleRemoved=roleCreated;}catch{failed=true;report.passed=false;report.databaseCleanupFailed=true;}finally{await control?.end();}
  report.durationMs=Date.now()-started;exports.set('reference-enrollment-ci.json',json(report));
  // Only sanitized manifests, native evidence and summaries enter artifacts.
  // Pending files, token, worker.env and any database URL never leave /etc.
  for(const [name,data]of exports)await writeFile(join(base,name),data,{flag:'wx',mode:0o444});process.setgroups([]);process.setgid(config.gid);process.setuid(config.uid);
  for(const [name,data]of exports)await writeFile(join(output,name),data,{flag:'wx',mode:0o600});
 }
 if(failed)throw Error('REFERENCE_ENROLLMENT_CI_FAILED');return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void qualifyReferenceEnrollmentCi().catch(()=>{console.error('REFERENCE_ENROLLMENT_CI_FAILED');process.exitCode=1;});
