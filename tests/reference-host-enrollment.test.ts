import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,unlink,writeFile,link,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createReferenceEnrollmentStore,withReferenceEnrollmentLock,makeReferenceEnrollmentIntent,assertReferenceEnrollmentPending,executeReferenceHostEnrollment,enrollmentBytesHash,referenceEnrollmentRequestFromHost,referenceEnrollmentTokenHash,ReferenceHostEnrollmentError} from '../scripts/hosting/reference-host-enrollment.mjs';
import {deriveReferenceRunnerConfiguration,referenceRunnerConfigurationHash} from '../scripts/hosting/reference-runner-identity.mjs';

const json=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+'\n'),hash=enrollmentBytesHash;
function fixture(){
 const serviceId=randomUUID(),companyId=randomUUID(),projectId=randomUUID(),bundleSha256='a'.repeat(64),release='/var/lib/coatria-reference-releases/'+bundleSha256,now=Date.now();
 const host={version:1,bundleSha256,commit:'b'.repeat(40),tree:'c'.repeat(40),release,uid:1234,gid:1234,scope:{serviceId,companyId,projectIds:[projectId],origin:'https://coatria.example',expiresAt:new Date(now+30*60*1000).toISOString(),uploadHosts:['upload.example']},profiles:{real:{profilePath:`/etc/coatria-reference/${serviceId}/real.json`,expectedProfileSha256:'d'.repeat(64)},conformance:{profilePath:`/etc/coatria-reference/${serviceId}/conformance.json`,expectedProfileSha256:'e'.repeat(64)}},worker:{path:release+'/worker/runtime.mjs',sha256:'f'.repeat(64)},qualifier:{path:release+'/qualifier/runtime.mjs',sha256:'1'.repeat(64)},units:Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:`coatria-reference-${serviceId}-${mode}.service`,sha256:hash(mode)}]))};
 const hostBytes=json(host),receipt={version:2,kind:'coatria-reference-worker-qualification',serviceId,companyId,projectIds:[projectId],sourceCommit:host.commit,sourceTree:host.tree,bundleSha256,releaseSha256:host.worker.sha256,qualifierSha256:host.qualifier.sha256,hostConfigurationSha256:hash(hostBytes),configurationSha256:referenceRunnerConfigurationHash(deriveReferenceRunnerConfiguration(host,'0'.repeat(64))),profileSha256:host.profiles.real.expectedProfileSha256,conformanceProfileSha256:host.profiles.conformance.expectedProfileSha256,bootId:randomUUID(),uid:host.uid,gid:host.gid,expiresAt:host.scope.expiresAt,units:host.units,qualifierInvocationId:'2'.repeat(32),serviceRoot:'/sys/fs/cgroup/system.slice/'+host.units.qualify.name,evidenceSha256:'3'.repeat(64),reportSha256:'4'.repeat(64),acceptedAt:new Date(now-1000).toISOString(),qualified:true,checks:{isolation:true,resourceLimits:true,descendantCleanup:true,preparedImages:true}};
 const receiptBytes=json(receipt),qualified={host,hostBytes,receipt,receiptBytes,qualificationSha256:hash(receiptBytes)},scope={version:1,enrolledBy:randomUUID(),provider:{connectionId:randomUUID(),connectionRevision:1,catalogSha256:'5'.repeat(64)},projects:[{projectId,projectRevision:1,storageBindingId:randomUUID(),storageBindingRevision:1,storageConnectionId:randomUUID(),storageConnectionRevision:1}]},token='rfs_'+'x'.repeat(43),scopeSha256=hash(json(scope)),registrarBundleSha256='6'.repeat(64),requestId=randomUUID();
 const intent=makeReferenceEnrollmentIntent(qualified,scope,{token,scopeSha256,registrarBundleSha256,requestId});return {qualified,scope,token,intent,scopeSha256,registrarBundleSha256};
}
async function prepared(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),'coatria-enrollment-'));t.after(()=>rm(root,{recursive:true,force:true}));const f=fixture(),store=createReferenceEnrollmentStore(root,{trusted:false}),pending=await store.prepare({intent:f.intent,token:f.token,hostBytes:f.qualified.hostBytes,receiptBytes:f.qualified.receiptBytes});assert.ok(pending);return {...f,root,store,pending};}
const outcome=(f:Awaited<ReturnType<typeof prepared>>,status:'absent'|'committed',active=false)=>({status,active,serviceId:f.intent.request.serviceId,requestId:f.intent.request.requestId,requestHash:f.intent.requestHash});

test('intent binds exact host project order, receipt bytes and scope; changing one fails',()=>{
 const f=fixture(),request=f.intent.request;assert.equal(request.tokenHash,referenceEnrollmentTokenHash(f.token));assert.equal(request.expiresAt,f.qualified.receipt.expiresAt);assert.equal(request.qualificationSha256,hash(f.qualified.receiptBytes));
 for(const change of [(v:typeof f.scope)=>{v.projects[0].projectId=randomUUID();},(v:typeof f.scope)=>{Object.assign(v,{companyId:randomUUID()});},(v:typeof f.scope)=>{v.projects[0].storageConnectionRevision=0;}]){const scope=structuredClone(f.scope);change(scope);assert.throws(()=>referenceEnrollmentRequestFromHost(f.qualified,scope,request.requestId,request.tokenHash));}
 assert.throws(()=>referenceEnrollmentRequestFromHost({...f.qualified,hostBytes:Buffer.concat([f.qualified.hostBytes,Buffer.from(' ')])},f.scope,request.requestId,request.tokenHash));assert.throws(()=>referenceEnrollmentRequestFromHost({...f.qualified,receiptBytes:Buffer.concat([f.qualified.receiptBytes,Buffer.from(' ')])},f.scope,request.requestId,request.tokenHash));
});
test('durable pending files preserve one exact token and reject changed scope/registrar',async t=>{
 const f=await prepared(t),again=await f.store.read();assert.ok(again);assert.equal(again.token,f.token);assert.equal(assertReferenceEnrollmentPending(again).requestId,f.intent.request.requestId);
 assert.throws(()=>assertReferenceEnrollmentPending(again,{scopeSha256:'0'.repeat(64)}));assert.throws(()=>assertReferenceEnrollmentPending(again,{registrarBundleSha256:'0'.repeat(64)}));
 await assert.rejects(f.store.prepare({intent:f.intent,token:f.token,hostBytes:f.qualified.hostBytes,receiptBytes:f.qualified.receiptBytes}),/PENDING_EXISTS/);assert.equal(await readFile(join(f.store.root,'token'),'utf8'),f.token);
});
test('partial first write and lost token retain evidence and never create replacement credentials',async t=>{
 const f=await prepared(t);await unlink(join(f.store.root,'token'));await assert.rejects(f.store.read(),/PENDING_INCOMPLETE/);await assert.rejects(f.store.prepare({intent:f.intent,token:'rfs_'+'y'.repeat(43),hostBytes:f.qualified.hostBytes,receiptBytes:f.qualified.receiptBytes}));assert.equal((await readFile(join(f.store.root,'intent.json'))).toString(),f.pending.intentBytes.toString());
 const other=join(f.root,'partial');await mkdir(other);const store=createReferenceEnrollmentStore(other,{trusted:false});await mkdir(store.root);await writeFile(join(store.root,'token'),f.token);await assert.rejects(store.read(),/PENDING_INCOMPLETE/);assert.equal(await readFile(join(store.root,'token'),'utf8'),f.token);
});
test('real filesystem hardlinks and directory substitution fail before pending identity is used',async t=>{
 const f=await prepared(t);await link(join(f.store.root,'token'),join(f.root,'linked-token'));await assert.rejects(f.store.read());assert.equal(await readFile(join(f.root,'linked-token'),'utf8'),f.token);
 await unlink(join(f.root,'linked-token'));await unlink(join(f.store.root,'token'));await mkdir(join(f.store.root,'token'));await assert.rejects(f.store.read());
});
test('real filesystem symlink does not supply pending credential', {skip:process.platform==='win32'},async t=>{
 const f=await prepared(t);await unlink(join(f.store.root,'token'));await writeFile(join(f.root,'elsewhere'),f.token);await symlink(join(f.root,'elsewhere'),join(f.store.root,'token'));await assert.rejects(f.store.read());
});
test('lost COMMIT response reconciles once with same token and only then publishes',async t=>{
 const f=await prepared(t);let reads=0,inserts=0;const sequence:string[]=[];
 const result=await executeReferenceHostEnrollment({mode:'enroll',store:f.store,pending:f.pending,verifyLocal:async()=>{sequence.push('local');},enroll:async(request:typeof f.intent.request)=>{inserts++;sequence.push('insert');assert.equal(request.tokenHash,referenceEnrollmentTokenHash(f.token));assert.equal(await readFile(join(f.store.root,'token'),'utf8'),f.token);throw Object.assign(Error('private transport error'),{code:'REFERENCE_ENROLLMENT_COMMIT_UNKNOWN'});},reconcile:async()=>{sequence.push('reconcile');return ++reads===1?outcome(f,'absent'):outcome(f,'committed',true);}});
 assert.equal(inserts,1);assert.equal(reads,2);assert.deepEqual(sequence,['reconcile','local','insert','reconcile','local']);assert.equal(result.credentialReady,true);assert.equal(result.workerEnabled,false);assert.equal(await readFile(join(f.root,'worker.env'),'utf8'),'COATRIA_REFERENCE_SERVICE_TOKEN='+f.token+'\n');assert(!JSON.stringify(result).includes(f.token));assert.equal((await f.store.read())!.token,f.token);
 const journal=(await readdir(f.store.root)).filter(n=>n.startsWith('event-'));const contents=(await Promise.all(journal.map(n=>readFile(join(f.store.root,n),'utf8')))).join('');assert(!contents.includes(f.token));assert(!contents.includes('private transport'));
});
test('unknown independent reconciliation preserves pending and never publishes or re-inserts',async t=>{
 const f=await prepared(t);let reads=0,inserts=0;
 await assert.rejects(executeReferenceHostEnrollment({mode:'enroll',store:f.store,pending:f.pending,verifyLocal:async()=>{},enroll:async()=>{inserts++;throw Error('unknown');},reconcile:async()=>{if(++reads===1)return outcome(f,'absent');throw Error('lock timeout');}}),/OUTCOME_UNKNOWN/);
 assert.equal(inserts,1);assert.equal(reads,2);assert.equal((await f.store.read())!.token,f.token);await assert.rejects(readFile(join(f.root,'worker.env')));
});
test('reconcile absent is read-only to SQL and cannot mint a different token',async t=>{
 const f=await prepared(t);let inserts=0;const result=await executeReferenceHostEnrollment({mode:'reconcile',store:f.store,pending:f.pending,verifyLocal:async()=>{throw Error('must not activate');},enroll:async()=>{inserts++;},reconcile:async()=>outcome(f,'absent')});assert.equal(result.status,'absent');assert.equal(result.credentialReady,false);assert.equal(inserts,0);assert.equal((await f.store.read())!.token,f.token);await assert.rejects(readFile(join(f.root,'worker.env')));
});
test('revoked committed row and stale local qualification are reported inactive without credential publication',async t=>{
 const f=await prepared(t);
 for(const active of [false,true]){const result=await executeReferenceHostEnrollment({mode:'reconcile',store:f.store,pending:f.pending,verifyLocal:async()=>{throw Error('qualification changed');},enroll:async()=>{throw Error('no mutation');},reconcile:async()=>outcome(f,'committed',active)});assert.equal(result.status,'committed');assert.equal(result.active,false);assert.equal(result.credentialReady,false);await assert.rejects(readFile(join(f.root,'worker.env')));}
});
test('foreign reconciliation tuple cannot publish a token even when active is true',async t=>{
 const f=await prepared(t);await assert.rejects(executeReferenceHostEnrollment({mode:'reconcile',store:f.store,pending:f.pending,verifyLocal:async()=>{},enroll:async()=>{},reconcile:async()=>({...outcome(f,'committed',true),requestHash:'0'.repeat(64)})}),/RECONCILIATION_INVALID/);await assert.rejects(readFile(join(f.root,'worker.env')));
});
test('post-publication journal failure preserves credential for exact later reconciliation without replacement',async t=>{
 const f=await prepared(t),original=f.store.record;let failComplete=true;const store={...f.store,record:async(event:Parameters<typeof original>[0])=>{if(event.kind==='complete'&&failComplete)throw Error('synthetic disk failure');return original(event);}};
 const invoke=()=>executeReferenceHostEnrollment({mode:'reconcile',store,pending:f.pending,verifyLocal:async()=>{},enroll:async()=>{throw Error('no mutation');},reconcile:async()=>outcome(f,'committed',true)});
 await assert.rejects(invoke(),/synthetic disk/);const before=await readFile(join(f.root,'worker.env'));failComplete=false;assert.equal((await invoke()).credentialReady,true);assert.ok((await readFile(join(f.root,'worker.env'))).equals(before));assert.equal((await f.store.read())!.token,f.token);
});
test('preexisting different credential or activation marker is never overwritten',async t=>{
 const f=await prepared(t);await writeFile(join(f.root,'worker.env'),'existing-private-value');await assert.rejects(f.store.publish(f.pending),/CREDENTIAL_CONFLICT/);assert.equal(await readFile(join(f.root,'worker.env'),'utf8'),'existing-private-value');await unlink(join(f.root,'worker.env'));await writeFile(join(f.root,'worker-enabled'),'');await assert.rejects(f.store.publish(f.pending),/ACTIVATION_PRESENT/);await assert.rejects(readFile(join(f.root,'worker.env')));
});
test('actual Linux flock rejects another process; durable child-written intent survives SIGKILL', {skip:process.platform!=='linux',timeout:20000},async t=>{
 const f=await prepared(t),crashRoot=join(f.root,'crash-child'),moduleUrl=pathToFileURL(join(process.cwd(),'scripts/hosting/reference-host-enrollment.mjs')).href;await mkdir(crashRoot);
 const script=`import{withReferenceEnrollmentLock,createReferenceEnrollmentStore}from${JSON.stringify(moduleUrl)};process.once('message',async data=>{await withReferenceEnrollmentLock(${JSON.stringify(crashRoot)},async()=>{await createReferenceEnrollmentStore(${JSON.stringify(crashRoot)},{trusted:false}).prepare({...data,hostBytes:Buffer.from(data.hostBytes),receiptBytes:Buffer.from(data.receiptBytes)});process.send({locked:true});await new Promise(()=>{setInterval(()=>{},1000);});},{trusted:false});});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,NODE_ENV:'test'}});t.after(()=>child.kill('SIGKILL'));
 const ready=new Promise<void>((res,rej)=>{child.once('message',()=>res());child.once('exit',()=>rej(Error('holder exited early')));child.once('error',rej);});child.send({intent:f.intent,token:f.token,hostBytes:f.qualified.hostBytes.toString(),receiptBytes:f.qualified.receiptBytes.toString()});
 await Promise.race([ready,delay(5000,undefined,{ref:false}).then(()=>{throw Error('holder did not acquire lock');})]);
 await assert.rejects(withReferenceEnrollmentLock(crashRoot,async()=>{}, {trusted:false}),/ENROLLMENT_BUSY/);const exited=new Promise<void>(res=>child.once('exit',()=>res()));child.kill('SIGKILL');await exited;
 let entered=false;await withReferenceEnrollmentLock(crashRoot,async()=>{entered=true;},{trusted:false});assert.equal(entered,true);assert.equal((await createReferenceEnrollmentStore(crashRoot,{trusted:false}).read())!.token,f.token);
});
test('registrar CLI is default plan and DB credential parser rejects alternate role/options/injection',async()=>{
 const modulePath='../scripts/hosting/register-reference-host.mts';const {parseReferenceRegistrarArguments,parseReferenceRegistrarConnectionInput,assertReferenceRegistrarEnvironment}=await import(modulePath);const f=fixture(),args=['--host',`/etc/coatria-reference/${f.qualified.host.scope.serviceId}/host.json`,'--bundle',f.qualified.host.bundleSha256,'--registrar-bundle',f.registrarBundleSha256,'--scope','/root/reviewed.json','--scope-sha256',f.scopeSha256];assert.equal(parseReferenceRegistrarArguments(args).mode,'plan');assert.equal(parseReferenceRegistrarArguments(['enroll',...args]).mode,'enroll');assert.equal(parseReferenceRegistrarArguments(['reconcile',...args.slice(0,6)]).mode,'reconcile');for(const bad of [[...args,'--yes'],['reconcile',...args],args.map(v=>v==='--scope'?'--connection-string':v)])assert.throws(()=>parseReferenceRegistrarArguments(bad));
 const user='coatria_higgsfield_reference_registrar_v1',connectionUrl=new URL('postgresql://ep-test.aws.neon.tech/coatria?sslmode=require');connectionUrl.username=user;connectionUrl.password=['synthetic','password'].join('-');const url=connectionUrl.toString();const value=parseReferenceRegistrarConnectionInput({connectionString:url});assert.deepEqual(value.ssl,{rejectUnauthorized:true});assert.equal(value.user,user);
 for(const connectionString of [url.replace(user,'postgres'),url.replace('ep-test','ep-test-pooler'),url+'&options=-c%20role=postgres',url.replace('require','disable'),url+'#private',url.replace('ep-test.aws.neon.tech','example.com')])assert.throws(()=>parseReferenceRegistrarConnectionInput({connectionString}));assert.throws(()=>parseReferenceRegistrarConnectionInput({connectionString:url,password:'extra'}));for(const key of ['PGOPTIONS','PGSSLMODE','PGHOST','DATABASE_URL','COATRIA_REFERENCE_SERVICE_TOKEN'])assert.throws(()=>assertReferenceRegistrarEnvironment({[key]:'private'}));
});
