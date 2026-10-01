/** Disposable Linux acceptance of one installed worker invocation. Real TLS,
 * restricted PostgreSQL LOGINs, byte capabilities and native decoding; only
 * synthetic storage is reachable. No production credential or provider call. */
import {execFile} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg,{type PoolClient} from 'pg';
import {qualifyImagePreparationEnrollmentCi} from './qualify-image-preparation-enrollment-ci.mjs';
import {buildTrustedServiceBundle} from './build-trusted-service-bundle.mjs';
import {archiveHostRead,archiveHostTrusted,verifyArchiveTree} from './archive-host-package.mjs';
import {createImagePreparationInstalledNetworkCi} from './image-preparation-installed-network-ci.mjs';
import {createImagePreparationInstalledFixture} from './image-preparation-installed-fixture.mjs';
import {createProjectStorageConnection} from '../../src/lib/project-storage.js';
import {resolveProjectImagePreparationProcessor} from '../../src/lib/project-image-preparation-service-authority.js';
import {proposeProjectImagePreparation,approveProjectImagePreparation} from '../../src/lib/project-image-preparations.js';
import {IMAGE_PREPARATION_BROKER_ROLE,assertImagePreparationBrokerDatabase} from '../../src/lib/project-image-preparation-database.mjs';
import {assertImagePreparationGatewayDatabase} from '../../src/lib/project-image-preparation-gateway-database.mjs';
import {PROJECT_STORAGE_GATEWAY_ROLE} from '../../src/lib/project-storage-preflight.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex'),json=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+'\n');
function fail():never{throw Error('IMAGE_PREPARATION_INSTALLED_FLOW_CI_REJECTED');}
function check(value:unknown):asserts value{if(!value)fail();}
const environment={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'};
/** Async child execution is essential: the same parent must serve the worker's
 * real HTTPS requests while the compiled controller awaits its preflight. */
function child(program:string,args:string[],input='',timeout=60000):Promise<string>{
 return new Promise((res,rej)=>{
  const process=execFile(program,args,{shell:false,env:environment,encoding:'utf8',timeout,maxBuffer:65536,killSignal:'SIGKILL',windowsHide:true},(error,stdout,stderr)=>{
   if(error||stderr.trim()||Buffer.byteLength(stdout)>65536)rej(Error('IMAGE_PREPARATION_INSTALLED_FLOW_CHILD_REJECTED'));else res(stdout);
  });process.stdin?.on('error',()=>{});process.stdin?.end(input);
 });
}
type ControlMode='plan'|'start'|'reconcile'|'stop';
type ControlProof={serviceId:string;status:string;workerEnabled:boolean;invocationId:string|null;bootId:string|null;runningReady:boolean;processStopped:boolean;cleanupConfirmed:boolean};
export function parseImagePreparationInstalledControlReply(raw:string,serviceId:string):ControlProof{
 check(typeof raw==='string'&&Buffer.byteLength(raw)<=65536&&uuid.test(serviceId));let value;try{value=JSON.parse(raw);}catch{fail();}
 check(value&&Object.keys(value).sort().join(',')==='bootId,cleanupConfirmed,invocationId,processStopped,runningReady,serviceId,status,workerEnabled'&&value.serviceId===serviceId&&['not-started','preflight-unknown','start-unknown','running-ready','running-unready','stopped','stop-unknown'].includes(value.status));
 check(['workerEnabled','runningReady','processStopped','cleanupConfirmed'].every(k=>typeof value[k]==='boolean')&&(value.invocationId===null||/^(?!0{32}$)[a-f0-9]{32}$/.test(value.invocationId))&&(value.bootId===null||uuid.test(value.bootId)));
 check(!value.cleanupConfirmed||value.processStopped);check(!value.runningReady||value.status==='running-ready'&&value.workerEnabled&&!value.processStopped&&value.invocationId&&value.bootId);
 return value;
}
export function createImagePreparationInstalledController(host:any,bundleSha256:string,run=child){
 check(uuid.test(host?.scope?.serviceId)&&sha.test(host.bundleSha256)&&sha.test(bundleSha256)&&host.release==='/var/lib/coatria-image-preparation-releases/'+host.bundleSha256);
 return async(mode:ControlMode,connectionString?:string)=>{
  check(['plan','start','reconcile','stop'].includes(mode));let input='';
  if(mode==='start'){let url;try{url=new URL(connectionString!);}catch{fail();}check(url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'&&url.port==='5432'&&url.username==='coatria_image_preparation_registrar_v1'&&url.password&&/^\/coatria_image_prep_host_ci_[a-f0-9]{32}$/.test(url.pathname)&&!url.search&&!url.hash);input=JSON.stringify({connectionString});}else check(connectionString===undefined);
  const raw=await run(host.release+'/runtime/node',['/var/lib/coatria-image-preparation-controllers/'+bundleSha256+'/runtime.mjs',mode,'--host','/etc/coatria-image-preparation/'+host.scope.serviceId+'/host.json','--bundle',host.bundleSha256,'--controller-bundle',bundleSha256],input,180000);
  if(mode==='plan'){let value;try{value=JSON.parse(raw);}catch{fail();}check(Object.keys(value).sort().join(',')==='actionPerformed,configurationSha256,databaseAuthorityVerified,expiresAt,mode,qualificationSha256,serviceId'&&value.mode==='plan'&&value.serviceId===host.scope.serviceId&&value.actionPerformed===false&&value.databaseAuthorityVerified===false&&sha.test(value.configurationSha256)&&sha.test(value.qualificationSha256)&&value.expiresAt===host.scope.expiresAt);return value;}
  return parseImagePreparationInstalledControlReply(raw,host.scope.serviceId);
 };
}
export function imagePreparationInstalledCiPng(){
 const header=Buffer.alloc(13),rows=Buffer.alloc(16*65);header.writeUInt32BE(16);header.writeUInt32BE(16,4);header[8]=8;header[9]=6;
 for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=y*65+x*4+1;rows[i]=x*16;rows[i+1]=y*16;rows[i+2]=100;rows[i+3]=255;}
 const chunk=(name:string,bytes:Buffer)=>{const length=Buffer.alloc(4),type=Buffer.from(name),crc=Buffer.alloc(4);length.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([length,type,bytes,crc]);};
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('tEXt',Buffer.from('Comment\0synthetic confidential source metadata')),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
type Scope={enrolledBy:string;projects:{projectId:string;storageBindingId:string;storageBindingRevision:number;gateway:{origin:string;provisionId:string;configurationSha256:string;expiresAt:string}}[]};
export async function seedImagePreparationInstalledWork(db:PoolClient,companyId:string,scope:Scope,original:Buffer){
 check(uuid.test(companyId)&&uuid.test(scope.enrolledBy)&&scope.projects.length===1&&Buffer.isBuffer(original)&&original.length>0&&original.length<=32768);
 const userId=scope.enrolledBy,project=scope.projects[0],taskId=randomUUID(),workItemId=randomUUID(),fileId=randomUUID(),versionId=randomUUID(),sourceSha256=hash(original);
 await db.query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Installed worker synthetic preparation',$3)",[taskId,companyId,userId]);
 await db.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'installed-image-preparation',$4,'references','ingest','agent')",[workItemId,companyId,project.projectId,taskId]);
 await db.query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)",[companyId,userId]);
 await db.query("INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,'original.png','original.png',$5)",[fileId,companyId,project.projectId,project.storageBindingId,userId]);
 await db.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'image/png',$7,$8)",[versionId,companyId,project.projectId,fileId,original.length,sourceSha256,`coatria/companies/${companyId}/projects/${project.projectId}/objects/${versionId}`,userId]);
 await db.query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'synthetic-source-etag',$6)",[companyId,project.projectId,versionId,original.length,sourceSha256,randomUUID()]);
 return {actor:{companyId,userId},project,workItemId,versionId,sourceSha256,sourceBytes:original.length};
}
async function transaction<T>(pool:pg.Pool,run:(db:PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
async function eventually<T>(run:()=>Promise<T|undefined>,milliseconds:number):Promise<T>{const deadline=Date.now()+milliseconds;for(;;){const value=await run();if(value!==undefined)return value;if(Date.now()>=deadline)fail();await new Promise(res=>setTimeout(res,500));}}

async function exerciseInstalledWorker(context:any,storageKeyring:string){
 const {host,installation,base,scope,owner,pending,qualified,exports}=context;
 const report:any={version:1,kind:'image-preparation-installed-flow-ci',passed:false,phase:'prerequisites',sourceCommit:host.commit,sourceTree:host.tree,serviceId:host.scope.serviceId,productionQualified:false,syntheticStorageOnly:true,productionCredentialsUsed:false,noProviderCalls:true};
 const network=createImagePreparationInstalledNetworkCi(),pools:pg.Pool[]=[],roles:string[]=[];
 let fixture:Awaited<ReturnType<typeof createImagePreparationInstalledFixture>>|undefined,restore:(()=>void)|undefined,invoke:ReturnType<typeof createImagePreparationInstalledController>|undefined,failed=false,stopAttempted=false;
 const phase=(value:string)=>{report.phase=value;};
 try{
  check(scope.projects.length===1&&host.scope.origin==='https://coatria.com');
  phase('compile-install-controller');const build=await buildTrustedServiceBundle({root:process.cwd(),commit:host.commit,service:'image-preparation-control',output:join(base,'controller-build')});check(build.sourceCommit===host.commit&&build.sourceTree===host.tree);
  const directory='/var/lib/coatria-image-preparation-controllers';try{await mkdir(directory,{mode:0o755});}catch(error:any){if(error.code!=='EEXIST')throw error;}await archiveHostTrusted(directory,true);
  const root=join(directory,build.bundleSha256);await mkdir(root,{mode:0o755});for(const name of ['runtime.mjs','bundle.json'])await copyFile(join(build.output,name),join(root,name),constants.COPYFILE_EXCL);
  await verifyArchiveTree(root,[{...build.runtime,mode:0o444}],{trusted:true,extra:['bundle.json']});const bundleBytes=await archiveHostRead(join(root,'bundle.json'),1024**2),manifest=JSON.parse(bundleBytes.toString());
  check(hash(bundleBytes)===build.bundleSha256&&manifest.service==='image-preparation-control'&&manifest.sourceCommit===host.commit&&manifest.sourceTree===host.tree&&manifest.packageLockSha256===installation.bundle.runtime.packageLockSha256);
  exports.set('image-preparation-installed-controller-bundle.json',bundleBytes);exports.set('image-preparation-installed-controller-runtime.mjs',await archiveHostRead(join(root,'runtime.mjs'),8*1024**2));report.controllerBundleSha256=build.bundleSha256;report.controllerRuntimeSha256=build.runtime.sha256;report.controllerRuntimeBytes=build.runtime.bytes;
  invoke=createImagePreparationInstalledController(host,build.bundleSha256);report.plan=await invoke('plan');
  phase('restricted-logins');report.logins=[];report.permissionFiles={};
  for(const [role,files,preflight] of [
   [IMAGE_PREPARATION_BROKER_ROLE,['image-preparation-broker-permissions.sql'],assertImagePreparationBrokerDatabase],
   [PROJECT_STORAGE_GATEWAY_ROLE,['storage-gateway-permissions.sql','image-preparation-gateway-permissions.sql'],assertImagePreparationGatewayDatabase]
  ] as const){
   check(!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount);const password=randomBytes(32).toString('hex');check(/^[a-z0-9_]+$/.test(role)&&/^[a-f0-9]{64}$/.test(password));
   await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);roles.push(role);
   for(const file of files){const bytes=await readFile('database/'+file);await owner.query(bytes.toString());report.permissionFiles[file]=hash(bytes);}
   const url=new URL(context.ownerConnectionString);url.username=role;url.password=password;const pool=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:10000,statement_timeout:10000});pool.on('error',()=>{});pools.push(pool);
   const db=await pool.connect();try{await preflight(db);const identity=(await db.query('SELECT current_user,session_user')).rows[0];check(identity.current_user===role&&identity.session_user===role);report.logins.push(identity);}finally{db.release();}
  }
  const original=imagePreparationInstalledCiPng(),work=await seedImagePreparationInstalledWork(owner,host.scope.companyId,scope,original);
  await owner.query('UPDATE trusted_service_provisions SET last_reconciled_at=clock_timestamp() WHERE id=$1',[work.project.gateway.provisionId]);
  const processor=await resolveProjectImagePreparationProcessor(owner,host.scope.companyId,work.project.projectId,host.scope.serviceId);check(processor);
  fixture=await createImagePreparationInstalledFixture({controlTransaction:run=>transaction(pools[0],run),gatewayTransaction:run=>transaction(pools[1],run),identity:{serviceId:host.scope.serviceId,companyId:host.scope.companyId,projectIds:host.scope.projectIds,origin:host.scope.origin,expiresAt:host.scope.expiresAt,processor,token:pending.token},gateway:{origin:work.project.gateway.origin,provisionId:work.project.gateway.provisionId,configurationHash:work.project.gateway.configurationSha256,sourceCommit:host.commit,expiresAt:work.project.gateway.expiresAt},storageKeyring,sources:[{projectId:work.project.projectId,versionId:work.versionId,bytes:original,etag:'synthetic-source-etag'}]});restore=fixture.installSyntheticS3Fetch();
  phase('isolated-network-marker');await writeFile(join(base,'installed-network-authority.json'),json({version:1,kind:'coatria-image-preparation-disposable-network-ci',candidate:host.commit,serviceId:host.scope.serviceId,disposableHost:true}),{flag:'wx',mode:0o600});
  phase('isolated-network');
  const tls=await network.setup({host,base,candidate:host.commit});report.network=tls.proof;
  await fixture.startServer({tls:{key:await readFile(tls.keyPath),cert:await readFile(tls.certPath)},port:443,host:'127.0.0.1'});
  phase('approve-one-synthetic-image');await owner.query('UPDATE trusted_service_provisions SET last_reconciled_at=clock_timestamp() WHERE id=$1',[work.project.gateway.provisionId]);await owner.query('BEGIN');let preparation;
  try{preparation=(await proposeProjectImagePreparation(owner,work.actor,{clientId:randomUUID(),projectId:work.project.projectId,projectRevision:1,workItemId:work.workItemId,sourceVersionId:work.versionId,sourceSha256:work.sourceSha256,sourceBytes:work.sourceBytes,destinationFolderId:null,destinationName:'prepared.png',purpose:'Disposable installed worker acceptance'})).preparation;
   await approveProjectImagePreparation(owner,work.actor,preparation.id,{clientId:randomUUID(),revision:preparation.revision,requestHash:preparation.requestHash,processorId:host.scope.serviceId,qualificationSha256:qualified.qualificationSha256,expiresInMinutes:5,maxCostMicrousd:0,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},{runtime:resolveProjectImagePreparationProcessor});await owner.query('COMMIT');
  }catch(error){await owner.query('ROLLBACK');throw error;}
  const queued=(await owner.query('SELECT status,attempt FROM project_image_preparations WHERE id=$1',[preparation.id])).rows[0];check(queued.status==='queued'&&queued.attempt===0);report.workApprovedBeforeStart=true;
  // Real queued-work startup complements the deterministic transaction/control
  // race tests. It does not claim that Linux scheduled the allocation ahead of
  // this particular controller's post-start observation.
  phase('compiled-start-with-queued-work');const started=await invoke('start',context.registrarConnectionString);report.start=started;check(['running-ready','running-unready'].includes(started.status)&&started.invocationId&&started.bootId&&started.workerEnabled);
  const ready=await eventually(async()=>{const value=await invoke!('reconcile');report.lastObservation=value;check(value.invocationId===started.invocationId&&value.bootId===started.bootId&&['running-ready','running-unready'].includes(value.status));return value.runningReady?value:undefined;},90000);report.ready=ready;
  phase('installed-processing');const result=await eventually(async()=>{
   const row=(await owner.query('SELECT status,attempt,cleanup_confirmed_at,diagnostic_code FROM project_image_preparations WHERE id=$1',[preparation!.id])).rows[0];
   if(row)report.lastPreparationState={status:row.status,attempt:row.attempt,cleanupConfirmed:Boolean(row.cleanup_confirmed_at),diagnosticCode:typeof row.diagnostic_code==='string'&&/^[A-Z0-9_]{1,120}$/.test(row.diagnostic_code)?row.diagnostic_code:null};
   check(row&&!['uncertain','blocked','failed','revoked'].includes(row.status));return row.status==='ready'?row:undefined;
  },150000);check(result.attempt===1&&result.cleanup_confirmed_at);
  const derivations=(await owner.query('SELECT * FROM project_image_preparation_derivations WHERE preparation_id=$1',[preparation.id])).rows;check(derivations.length===1);const derivative=derivations[0],objects=fixture.objects();
  check(objects.sources.length===1&&objects.sources[0].bytes.equals(original)&&objects.outputs.length===1);const output=objects.outputs[0];check(output.versionId===derivative.output_version_id&&output.versionId!==work.versionId&&hash(output.bytes)===derivative.output_sha256&&output.bytes.length===Number(derivative.output_bytes)&&!output.bytes.includes(Buffer.from('confidential'))&&derivative.source_sha256===work.sourceSha256&&Number(derivative.source_bytes)===original.length&&derivative.output_width===16&&derivative.output_height===16);
  const source=(await owner.query('SELECT bytes,sha256 FROM project_storage_versions WHERE id=$1',[work.versionId])).rows[0];check(Number(source.bytes)===original.length&&source.sha256===work.sourceSha256);
  const catalog=(await owner.query('SELECT revision FROM project_storage_bindings WHERE id=$1',[work.project.storageBindingId])).rows[0];check(catalog.revision===work.project.storageBindingRevision+1);
  report.preparation={id:preparation.id,status:result.status,attempt:result.attempt,cleanupConfirmed:true,sourcePreserved:true,sourceSha256:work.sourceSha256,outputSha256:hash(output.bytes),outputBytes:output.bytes.length,outputWidth:16,outputHeight:16,distinctVersion:true,metadataRemoved:true,catalogRevisionAdvancedOnce:true};
  phase('compiled-stop');stopAttempted=true;report.stop=await invoke('stop');check(report.stop.status==='stopped'&&!report.stop.workerEnabled&&report.stop.processStopped&&report.stop.cleanupConfirmed&&report.stop.invocationId===started.invocationId&&report.stop.bootId===started.bootId);
  report.reconciledStop=await invoke('reconcile');check(JSON.stringify(report.reconciledStop)===JSON.stringify(report.stop));
  const audit=fixture.audit();check(audit.counts.readSource===1&&audit.counts.initiate===1&&audit.counts.part===1&&audit.counts.complete===1&&audit.counts.readOutput===1&&audit.counts.signatureVerified===5&&audit.counts.rejectedEgress===0&&audit.counts.transportRejected===0&&audit.counts.httpRejected===0&&audit.unconfirmedUploads===0);report.transport=audit;report.passed=true;phase('complete');
 }catch{failed=true;report.passed=false;report.failureCode='IMAGE_PREPARATION_INSTALLED_FLOW_CI_FAILED';}
 finally{
  const cleanupFailure=()=>{failed=true;report.passed=false;report.cleanupFailed=true;};
  // The helper exports fixed diagnostic enums and booleans only. Keep both
  // snapshots so cleanup cannot obscure the original setup failure boundary.
  report.networkBeforeCleanup=network.diagnostic();
  // Cleanup is independent of success. Failure-only systemctl stop contains a
  // disposable worker; it is never reported as a successful controller proof.
  if(invoke&&!stopAttempted)try{stopAttempted=true;await invoke('stop');}catch{cleanupFailure();}
  for(const mode of ['worker','preflight','qualify'])try{await child('/usr/bin/systemctl',['stop',host.units[mode].name]);}catch{cleanupFailure();}
  try{fixture?.close();await fixture?.drain();restore?.();report.fixtureDrained=true;}catch{cleanupFailure();}
  if(fixture)report.transport=fixture.audit();
  try{report.networkCleanup=await network.cleanup();}catch{cleanupFailure();}finally{report.networkAfterCleanup=network.diagnostic();}
  for(const pool of pools)try{await pool.end();}catch{cleanupFailure();}
  for(const role of roles.reverse())try{await owner.query('DROP OWNED BY '+role);await owner.query('DROP ROLE '+role);}catch{cleanupFailure();}
  report.disposableLoginsRemoved=!report.cleanupFailed;exports.set('image-preparation-installed-flow-ci.json',json(report));
 }
 if(failed)fail();return report;
}

export async function qualifyImagePreparationInstalledFlowCi(){
 check(process.platform==='linux'&&process.arch==='x64'&&process.getuid?.()===0&&process.env.CI==='true'&&/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''));
 const keyring=JSON.stringify({activeKeyId:'synthetic-installed-ci',keys:{'synthetic-installed-ci':randomBytes(32).toString('base64')}});
 return qualifyImagePreparationEnrollmentCi({
  createStorageConnection:async(db:PoolClient,actor:{companyId:string;userId:string})=>{const previous=process.env.COATRIA_HOSTING_KEYRING;process.env.COATRIA_HOSTING_KEYRING=keyring;try{return (await createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic installed worker storage',region:'US-CA-2',volumeId:'synthetic-fixture-volume',accessKeyId:'user_synthetic',secretAccessKey:'rps_synthetic'})).connection.id;}finally{if(previous===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=previous;}},
  exerciseInstalledWorker:(context:any)=>exerciseInstalledWorker(context,keyring)
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void qualifyImagePreparationInstalledFlowCi().catch(()=>{console.error('IMAGE_PREPARATION_INSTALLED_FLOW_CI_FAILED');process.exitCode=1;});
