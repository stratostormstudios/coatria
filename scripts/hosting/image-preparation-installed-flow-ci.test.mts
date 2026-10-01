import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createImagePreparationInstalledController,parseImagePreparationInstalledControlReply,imagePreparationInstalledCiPng,seedImagePreparationInstalledWork,qualifyImagePreparationInstalledFlowCi} from './qualify-image-preparation-installed-flow-ci.mjs';
import {seedImagePreparationEnrollmentCiDatabase} from './qualify-image-preparation-enrollment-ci.mjs';
import {openImagePreparationServiceDatabase} from '../../tests/fixtures/image-preparation-service.js';
import {createProjectStorageConnection,openProjectStorageCredentials} from '../../src/lib/project-storage.js';

function identity(){const host={bundleSha256:'a'.repeat(64),release:'/var/lib/coatria-image-preparation-releases/'+'a'.repeat(64),scope:{serviceId:randomUUID(),expiresAt:new Date(Date.now()+600000).toISOString()}};const proof={serviceId:host.scope.serviceId,status:'running-ready',workerEnabled:true,invocationId:'b'.repeat(32),bootId:randomUUID(),runningReady:true,processStopped:false,cleanupConfirmed:false};return {host,proof};}
test('installed controller uses asynchronous fixed installed executable with stdin-only local registrar credentials',async()=>{
 const {host,proof}=identity(),calls:unknown[]=[],url=new URL('postgresql://127.0.0.1:5432/coatria_image_prep_host_ci_'+randomUUID().replaceAll('-',''));url.username='coatria_image_preparation_registrar_v1';url.password='synthetic-local-only';
 const invoke=createImagePreparationInstalledController(host,'c'.repeat(64),async(file,args,input,timeout)=>{await Promise.resolve();calls.push({file,args,input,timeout});return JSON.stringify(proof);});
 assert.deepEqual(await invoke('start',url.href),proof);assert.equal(calls.length,1);const call=calls[0] as any;
 assert.equal(call.file,host.release+'/runtime/node');assert.deepEqual(call.args,['/var/lib/coatria-image-preparation-controllers/'+'c'.repeat(64)+'/runtime.mjs','start','--host','/etc/coatria-image-preparation/'+host.scope.serviceId+'/host.json','--bundle',host.bundleSha256,'--controller-bundle','c'.repeat(64)]);assert.deepEqual(JSON.parse(call.input),{connectionString:url.href});assert(!JSON.stringify({file:call.file,args:call.args}).includes(url.password));
 for(const mutate of [(u:URL)=>u.hostname='coatria.com',(u:URL)=>u.username='postgres',(u:URL)=>u.pathname='/production',(u:URL)=>u.search='options=unsafe']){const bad=new URL(url);mutate(bad);await assert.rejects(invoke('start',bad.href));}
 await assert.rejects(invoke('stop',url.href));await assert.rejects(invoke('reconcile',url.href));assert.equal(calls.length,1);
});
test('controller proof rejects malformed, contradictory and extra untrusted child output',()=>{
 const {host,proof}=identity();assert.deepEqual(parseImagePreparationInstalledControlReply(JSON.stringify(proof),host.scope.serviceId),proof);
 for(const bad of [{...proof,token:'synthetic-private'}, {...proof,serviceId:randomUUID()}, {...proof,invocationId:'0'.repeat(32)}, {...proof,processStopped:true}, {...proof,cleanupConfirmed:true}, {...proof,workerEnabled:false}, {...proof,status:'start-unknown'}, {...proof,bootId:null}])assert.throws(()=>parseImagePreparationInstalledControlReply(JSON.stringify(bad),host.scope.serviceId));
 for(const raw of ['',JSON.stringify(proof)+'\n{}','x'.repeat(65537)])assert.throws(()=>parseImagePreparationInstalledControlReply(raw,host.scope.serviceId));
});
test('installed flow refuses a normal developer machine before any host or provider mutation',async()=>{
 if(process.platform==='linux'&&process.getuid?.()===0&&process.env.CI==='true'&&/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))return;
 await assert.rejects(qualifyImagePreparationInstalledFlowCi(),/IMAGE_PREPARATION_INSTALLED_FLOW_CI_REJECTED/);
});
test('installed seed seals only synthetic credentials before enrollment and creates an unapproved original', {timeout:120000},async()=>{
 const database=await openImagePreparationServiceDatabase(),previous=process.env.COATRIA_HOSTING_KEYRING;
 const keyring=JSON.stringify({activeKeyId:'synthetic-ci',keys:{'synthetic-ci':randomBytes(32).toString('base64')}});process.env.COATRIA_HOSTING_KEYRING=keyring;
 const projectId=randomUUID(),companyId=randomUUID(),host={commit:'a'.repeat(40),scope:{companyId,projectIds:[projectId],origin:'https://coatria.com',expiresAt:new Date(Date.now()+600000).toISOString(),gateways:[{projectId,origin:'https://imagepreparationci1-4190.proxy.runpod.net'}]}};
 try{
  const scope=await database.tx(db=>seedImagePreparationEnrollmentCiDatabase(db,host,{createStorageConnection:async(client:any,actor:any)=>(await createProjectStorageConnection(client,actor,{clientId:randomUUID(),name:'Synthetic only',region:'US-CA-2',volumeId:'synthetic-fixture-volume',accessKeyId:'user_synthetic',secretAccessKey:'rps_synthetic'})).connection.id}));
  const connectionId=scope.projects[0].storageConnectionId,credentials=await database.tx(db=>openProjectStorageCredentials(db,companyId,connectionId));assert.equal(credentials.secretAccessKey,'rps_synthetic');
  const stored=(await database.db.query('SELECT secret_envelope FROM project_storage_connections WHERE id=$1',[connectionId])).rows[0];assert(!JSON.stringify(stored).includes('rps_synthetic'));assert.equal(scope.projects[0].storageBindingRevision,1);
  const original=imagePreparationInstalledCiPng(),work=await database.tx(db=>seedImagePreparationInstalledWork(db,companyId,scope,original));assert(original.includes(Buffer.from('confidential')));assert.equal(work.sourceSha256,createHash('sha256').update(original).digest('hex'));
  const row=(await database.db.query('SELECT v.sha256,v.bytes,x.provider_etag FROM project_storage_versions v JOIN project_storage_verifications x ON x.version_id=v.id WHERE v.id=$1',[work.versionId])).rows[0];assert.equal(row.sha256,work.sourceSha256);assert.equal(Number(row.bytes),original.length);assert.equal(row.provider_etag,'synthetic-source-etag');
  for(const table of ['project_image_preparations','project_image_preparation_approvals','project_image_preparation_services'])assert.equal((await database.db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);
 }finally{if(previous===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=previous;await database.close();}
});
