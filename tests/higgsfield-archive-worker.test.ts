import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {database,query,transaction} from '../src/lib/db';
import {createHiggsfieldArchiveWorker} from '../src/lib/higgsfield-archive-worker';
import {proposeHiggsfieldArchive,approveHiggsfieldArchive,revokeHiggsfieldArchive,getHiggsfieldArchive} from '../src/lib/higgsfield-archives';
import {recordHiggsfieldSubmission} from '../src/lib/higgsfield-jobs';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {bindProjectStorage,createProjectStorageConnection} from '../src/lib/project-storage';
import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {inspectHiggsfieldArchiveMedia,type HiggsfieldMediaDescriptor} from '../src/lib/higgsfield-media-inspection';
import type {RunpodProjectStorage,RunpodProjectStorageConfig,RunpodMultipartUpload} from '../src/lib/project-storage-runpod';

const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const never=<T>()=>new Promise<T>(()=>{});
const stream=(value:Uint8Array)=>new ReadableStream<Uint8Array>({start(controller){for(let i=0;i<value.length;i+=65536)controller.enqueue(value.subarray(i,i+65536));controller.close();}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};

// Always ephemeral PGlite. Provider operations and the source reader are
// injected; no stored environment database or network provider is used.
test('archive worker joins separate approval, real scratch streams, durable multipart intent and stored-byte verification',{timeout:180000},async t=>{
 const before={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,enabled:process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED,fetch:globalThis.fetch};
 // PGlite reads its JavaScript runtime clock. Keep the database in a separate
 // runtime so Date.now clock-skew tests cannot also move PostgreSQL's clock.
 const dbWorker=new Worker(`const {parentPort}=require('node:worker_threads');(async()=>{const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),{readdir,readFile}=require('node:fs/promises'),db=await PGlite.create();for(const name of(await readdir('database')).filter(name=>/^\\d.*\\.sql$/.test(name)).sort())await db.exec(await readFile('database/'+name,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();parentPort.postMessage({url:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres'});parentPort.once('message',async()=>{await socket.stop();await db.close();parentPort.postMessage({stopped:true});parentPort.close();});})().catch(error=>{throw error;});`,{eval:true,execArgv:[]});
 const databaseUrl=await new Promise<string>((yes,no)=>{dbWorker.once('error',no);dbWorker.once('message',value=>yes(value.url));});
 process.env.DATABASE_URL=databaseUrl;process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'archive-fixture',keys:{'archive-fixture':Buffer.alloc(32,72).toString('base64')}});
 let network=0;globalThis.fetch=async()=>{network++;throw Error('Archive fixtures must never contact a provider');};
 const scratchRoot=await mkdtemp(join(tmpdir(),'coatria-archive-worker-')),userId=randomUUID(),companies:string[]=[];
 type Hooks={beforeFetch?:()=>Promise<void>;beforeInspect?:()=>Promise<void>;beforeCreate?:()=>Promise<void>;beforePart?:()=>Promise<void>;beforeComplete?:()=>Promise<void>;beforeRead?:()=>Promise<void>;afterStoredChunk?:()=>Promise<void>;failCreate?:boolean;failPart?:boolean;failComplete?:boolean;corrupt?:boolean;truncated?:boolean;wrongEtag?:boolean;stallFetch?:boolean;stallRead?:boolean;source?:Buffer};
 async function fixture(input:{body?:Buffer;name?:string;approve?:boolean}={}){
  const companyId=randomUUID(),projectId=randomUUID(),providerId=randomUUID(),requestId=randomUUID(),taskId=randomUUID(),workId=randomUUID(),providerJobId=randomUUID(),body=input.body??Buffer.from('synthetic-media-bytes'),hooks:Hooks={};companies.push(companyId);
  const actor={companyId,userId},privateLocator=`https://media.reviewed.example/output/${randomUUID()}.png?signature=private-fixture-query`;
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Archive worker fixture',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
  const gates=Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved',recordedBy:userId}]));
  await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Synthetic archive','Internal','No production or paid media',$3,'allowed','production',$4,$5,'higgsfield')",[projectId,companyId,JSON.stringify({width:32,height:32,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),JSON.stringify(gates),userId]);
  await query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Synthetic archive task',$3)",[taskId,companyId,userId]);await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[workId,companyId,projectId,taskId]);await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[companyId,userId]);
  const sealed=sealHiggsfieldSecret({token:{access_token:'synthetic-not-used',token_type:'Bearer'}},{companyId,id:providerId,purpose:'oauth-connection'});
  await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[companyId,providerId,userId,JSON.stringify(sealed)]);
  const request=(await query("INSERT INTO higgsfield_requests(id,company_id,project_id,requested_by,client_id,project_revision,connection_id,connection_revision,tool,arguments,note,request_hash,status,approved_by,dispatched_at,work_item_id,task_revision,role_human_id) VALUES($1,$2,$3,$4,$5,1,$6,1,'generate_image',$7,'Synthetic receipt',$8,'returned',$4,clock_timestamp(),$9,1,$4) RETURNING *",[requestId,companyId,projectId,userId,randomUUID(),providerId,JSON.stringify({prompt:'Synthetic original fixture'}),sha(requestId),workId])).rows[0];
  await transaction(client=>recordHiggsfieldSubmission(client,request,{structuredContent:{results:[{id:providerJobId,type:'image',status:'completed',model:'synthetic-model',params:{prompt:'Synthetic original fixture'},results:{rawUrl:privateLocator}}]}}));
  const output=(await query('SELECT * FROM higgsfield_job_outputs WHERE company_id=$1',[companyId])).rows[0];assert(output);
  const connection=(await transaction(client=>createProjectStorageConnection(client,actor,{clientId:randomUUID(),name:'Synthetic volume',region:'US-NC-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_fixture-storage-key'}))).connection;
  const binding=(await transaction(client=>bindProjectStorage(client,actor,projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  const proposal=(await transaction(client=>proposeHiggsfieldArchive(client,actor,{clientId:randomUUID(),projectId,projectRevision:1,jobId:output.job_id,outputId:output.id,outputIdentity:output.locator_identity,bindingId:binding.id,bindingRevision:binding.revision,name:input.name??'output-fixture',maxBytes:Math.max(body.length+1024,4096)}))).archive;
  const approve=()=>transaction(client=>approveHiggsfieldArchive(client,actor,proposal.id,{clientId:randomUUID(),revision:proposal.revision,requestHash:proposal.requestHash,projectRevision:1,bindingRevision:binding.revision,expiresInHours:1,archiveConsent:true}));
  if(input.approve!==false)await approve();
  const counts={fetch:0,inspect:0,create:0,part:0,complete:0,get:0,close:0},parts=new Map<string,Map<number,Buffer>>(),objects=new Map<string,Buffer>(),scratchPaths:string[]=[];
  const archive=()=>query('SELECT * FROM higgsfield_output_archives WHERE company_id=$1 AND id=$2',[companyId,proposal.id]).then(r=>r.rows[0]);
  const view=()=>transaction(client=>getHiggsfieldArchive(client,actor,proposal.id));
  async function checkIntent(operation:string){const row=await archive();const upload=(await query('SELECT * FROM project_storage_uploads WHERE company_id=$1 AND id=$2',[companyId,row.upload_id])).rows[0];assert(upload.action_id);assert.equal(upload.archive_id,proposal.id);assert.equal(upload.actor_key,'archive:'+proposal.id);assert.equal(upload.actor_agent_id,null);assert.equal(upload.run_id,null);assert.equal(upload.verification_grant_id,null);assert.equal((await query("SELECT count(*)::int n FROM higgsfield_archive_receipts WHERE company_id=$1 AND archive_id=$2 AND action_id=$3 AND operation=$4 AND phase='intent'",[companyId,proposal.id,upload.action_id,operation])).rows[0].n,1);}
  const providerFactory=(config:RunpodProjectStorageConfig):RunpodProjectStorage=>{
   assert.equal(config.companyId,companyId);assert.equal(config.projectId,projectId);assert.equal(config.volumeId,'fixture-volume');assert.equal(config.partBytes,5*1024**2);
   return {verifyBucketAccess:async()=>{throw Error('Operator preflight is not part of this archive test');},list:async()=>({objects:[],cursor:null}),head:async()=>null,validateMultipart(value){const descriptor=value as RunpodMultipartUpload;assert.equal(descriptor.scope,companyId);return descriptor;},
    async createMultipart(value){counts.create++;await checkIntent('initiate');await hooks.beforeCreate?.();if(hooks.failCreate)throw Error(privateLocator);const descriptor={scope:companyId,versionId:value.versionId,uploadId:randomUUID(),bytes:value.bytes,partBytes:config.partBytes!};parts.set(descriptor.uploadId,new Map());return descriptor;},
    async uploadPart(value){counts.part++;await checkIntent('part');await hooks.beforePart?.();if(hooks.failPart)throw Error(privateLocator);const data=value.body instanceof Uint8Array?Buffer.from(value.body):Buffer.from(await new Response(value.body as ReadableStream<Uint8Array>).arrayBuffer());parts.get(value.upload.uploadId)!.set(value.partNumber,data);return {partNumber:value.partNumber,bytes:data.length,etag:'"part-'+sha(data)+'"'};},
    async completeMultipart(value){counts.complete++;await checkIntent('complete');await hooks.beforeComplete?.();if(hooks.failComplete)throw Error(privateLocator);objects.set(value.upload.versionId,Buffer.concat(value.parts.map(p=>parts.get(value.upload.uploadId)!.get(p.partNumber)!)));return {versionId:value.upload.versionId,etag:'"stored-object"'};},
    abortMultipart:async()=>{throw Error('No unapproved provider abort');},
    async get(value){counts.get++;await hooks.beforeRead?.();assert.equal(value.ifMatch,'"stored-object"');const stored=objects.get(value.versionId)!;assert(stored);const data=hooks.corrupt?Buffer.alloc(stored.length,0):hooks.truncated?stored.subarray(0,-1):stored;let sent=false;const body=hooks.stallRead?new ReadableStream<Uint8Array>({pull:()=>never()}):hooks.afterStoredChunk?new ReadableStream<Uint8Array>({async pull(controller){if(sent){await hooks.afterStoredChunk!();controller.close();return;}sent=true;controller.enqueue(data);}}):stream(data);return {stream:body,bytes:stored.length,totalBytes:stored.length,etag:hooks.wrongEtag?'"wrong-object"':'"stored-object"',contentType:'image/png',contentRange:null,range:null};},close(){counts.close++;}};
  };
  const fetchOutput:Parameters<typeof createHiggsfieldArchiveWorker>[0]['fetchOutput']=async value=>{counts.fetch++;assert.equal(value.locator,privateLocator);await value.assertAuthority(value.signal!);await hooks.beforeFetch?.();if(hooks.stallFetch)return never();const bytes=hooks.source??body;for(let offset=0;offset<bytes.length;offset+=65536){value.signal?.throwIfAborted();await value.consume(bytes.subarray(offset,offset+65536),value.signal!);}return {bytes:bytes.length,sha256:sha(bytes)};};
  const inspectMedia:Parameters<typeof createHiggsfieldArchiveWorker>[0]['inspectMedia']=async value=>{counts.inspect++;scratchPaths.push(value.path);assert.equal(basename(value.path),'source');assert.match(basename(dirname(value.path)),/^[a-f0-9-]{36}$/);assert.equal(dirname(dirname(value.path)),await realRoot());const bytes=await readFile(value.path);assert.equal(bytes.length,value.expectedBytes);assert.equal(sha(bytes),value.expectedSha256);await hooks.beforeInspect?.();return {kind:'image',format:'png',contentType:'image/png',bytes:bytes.length,sha256:sha(bytes),verification:'full_decode',inspectionVersion:1,width:32,height:32,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}} satisfies HiggsfieldMediaDescriptor;};
  const worker=(patch:Partial<Parameters<typeof createHiggsfieldArchiveWorker>[0]>={})=>createHiggsfieldArchiveWorker({scratchRoot,fetchOutput,inspectMedia,providerFactory,partBytes:5*1024**2,authorityIntervalMs:40,authorityTimeoutMs:3000,operationDeadlineMs:30000,...patch});
  const revoke=async()=>{const current=await archive();return transaction(client=>revokeHiggsfieldArchive(client,actor,proposal.id,{clientId:randomUUID(),revision:current.revision,note:'Synthetic revoke'}));};
  return {actor,companyId,projectId,proposal,output,connection,binding,counts,parts,objects,hooks,archive,view,approve,revoke,worker,body,scratchPaths,privateLocator};
 }
 async function realRoot(){const {realpath}=await import('node:fs/promises');return realpath(scratchRoot);}
 const caseTest=(name:string,run:()=>Promise<void>)=>t.test(name,async()=>{try{await run();}finally{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);assert.deepEqual(await readdir(scratchRoot),[]);}});
 try{
  await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Archive fixture',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  await caseTest('unapproved output cannot be fetched or written; an approved multipart archive publishes exact stored bytes',async()=>{
   const f=await fixture({approve:false,body:Buffer.alloc(5*1024**2+123,42)}),worker=f.worker();assert.deepEqual(await worker.runNext(),{processed:false});assert.equal(f.counts.fetch,0);await f.approve();
   assert.deepEqual(await worker.runNext(),{processed:true,archiveId:f.proposal.id,status:'verified'});assert.equal(f.counts.fetch,1);assert.equal(f.counts.create,1);assert.equal(f.counts.part,2);assert.equal(f.counts.complete,1);assert.equal(f.counts.get,1);assert.deepEqual(await worker.runNext(),{processed:false});
   const saved=await f.archive(),verified=(await query('SELECT * FROM project_storage_verifications WHERE company_id=$1 AND version_id=$2',[f.companyId,saved.version_id])).rows[0];assert.equal(Number(verified.bytes),f.body.length);assert.equal(verified.sha256,sha(f.body));assert.deepEqual(f.objects.get(saved.version_id),f.body);assert.equal((await f.view()).archive.bytesVerified,true);
   assert.equal((await query('SELECT count(*)::int n FROM project_storage_access_receipts WHERE company_id=$1',[f.companyId])).rows[0].n,0);assert.equal((await query('SELECT count(*)::int n FROM studio_artifacts WHERE company_id=$1',[f.companyId])).rows[0].n,0);assert(!JSON.stringify(await f.view()).includes('private-fixture-query'));
  });
  await caseTest('declared filename cannot mislabel inspected bytes and decoded content type is authoritative',async()=>{
   for(const name of['misleading.mp4','unsupported.exe']){const f=await fixture({name});const result=await f.worker().runNext();assert.equal(result.code,'HIGGSFIELD_ARCHIVE_MEDIA_REJECTED');assert.equal(f.counts.create,0);}
   const f=await fixture({name:'correct.PNG'});assert.equal((await f.worker().runNext()).status,'verified');assert.equal((await query('SELECT content_type FROM project_storage_versions WHERE company_id=$1',[f.companyId])).rows[0].content_type,'image/png');
  });
  await caseTest('all provider mutations have durable intents and ambiguous outcomes never replay',async()=>{
   for(const stage of['Create','Part','Complete'] as const){const f=await fixture();f.hooks['fail'+stage as 'failCreate']=true;const first=await f.worker().runNext();assert.equal(first.status,'uncertain');assert.equal(first.code,'HIGGSFIELD_ARCHIVE_STORAGE_UNCERTAIN');const counts={...f.counts};assert.deepEqual(await f.worker().runNext(),{processed:false});assert.deepEqual(f.counts,counts);assert.equal((await query('SELECT count(*)::int n FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].n,0);assert(!JSON.stringify(first).includes(f.privateLocator));}
  });
  await caseTest('stored-byte corruption, truncated stream and changed ETag cannot produce a verification',async()=>{
   for(const hook of['corrupt','truncated','wrongEtag'] as const){const f=await fixture();f.hooks[hook]=true;const result=await f.worker().runNext();assert.equal(result.code,'HIGGSFIELD_ARCHIVE_STORED_BYTES_MISMATCH');assert.equal((await f.view()).archive.bytesVerified,false);assert.equal((await query('SELECT count(*)::int n FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].n,0);}
  });
  await caseTest('revocation during fetch, a provider write, and final stored EOF never publishes bytes',async()=>{
   for(const hook of['beforeFetch','beforeCreate','afterStoredChunk'] as const){const f=await fixture();f.hooks[hook]=f.revoke as ()=>Promise<void>;await f.worker().runNext();assert.equal((await f.archive()).status,'cancelled');assert.equal((await query('SELECT count(*)::int n FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].n,0);if(hook==='beforeFetch')assert.equal(f.counts.create,0);if(hook==='beforeCreate')assert.equal(f.counts.create,1);}
  });
  await caseTest('private source identity, sponsor, destination and tenant changes stop work before storage I/O',async()=>{
   for(const change of['locator','sponsor','destination','account']){const f=await fixture();if(change==='locator'){const bad=sealHiggsfieldSecret({locator:'https://media.reviewed.example/different.png?signature=other'},{companyId:f.companyId,id:f.output.id,purpose:'provider-output'});await query('UPDATE higgsfield_output_locators SET sealed=$3 WHERE company_id=$1 AND output_id=$2',[f.companyId,f.output.id,JSON.stringify(bad)]);}if(change==='sponsor')await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.companyId,userId]);if(change==='destination')await query("UPDATE project_storage_connections SET volume_id='changed-volume' WHERE company_id=$1",[f.companyId]);if(change==='account')await query('UPDATE higgsfield_connections SET id=$2 WHERE company_id=$1',[f.companyId,randomUUID()]);const result=await f.worker().runNext();assert.equal(result.status,'blocked');assert.equal(f.counts.create,0);if(change!=='locator')assert.equal(f.counts.fetch,0);}
   const a=await fixture({approve:false}),b=await fixture({approve:false});await assert.rejects(()=>transaction(client=>getHiggsfieldArchive(client,a.actor,b.proposal.id)),/not found/);assert.equal(a.counts.fetch+b.counts.fetch,0);
  });
  await caseTest('a failed stored read restarts without refetching or replaying a provider mutation; ordinary gateway cannot claim it',async()=>{
   const f=await fixture();f.hooks.beforeRead=async()=>{throw Error(f.privateLocator);};assert.equal((await f.worker().runNext()).status,'verifying');assert.equal(await createProjectStorageGateway({providerFactory:()=>{throw Error('Ordinary gateway must never adopt an archive');}}).verifyNext(),false);f.hooks.beforeRead=undefined;
   assert.equal((await f.worker().runNext()).status,'verified');assert.deepEqual({fetch:f.counts.fetch,create:f.counts.create,part:f.counts.part,complete:f.counts.complete,get:f.counts.get},{fetch:1,create:1,part:1,complete:1,get:2});
  });
  await caseTest('a persisted confirmed part resumes with the same source hash and never replays initiation or the confirmed part',async()=>{
   const f=await fixture({body:Buffer.alloc(5*1024**2+123,57)}),saved=await f.archive(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID(),providerUploadId=randomUUID(),partBytes=5*1024**2,first=f.body.subarray(0,partBytes),descriptor={scope:f.companyId,versionId,uploadId:providerUploadId,bytes:f.body.length,partBytes};
   f.parts.set(providerUploadId,new Map([[1,first]]));
   const media={kind:'image',format:'png',contentType:'image/png',bytes:f.body.length,sha256:sha(f.body),verification:'full_decode',inspectionVersion:1,width:32,height:32,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};
   await transaction(async client=>{
    await client.query('INSERT INTO higgsfield_archive_fetches(company_id,project_id,archive_id,locator_identity,bytes,sha256,media) VALUES($1,$2,$3,$4,$5,$6,$7)',[f.companyId,f.projectId,saved.id,saved.locator_identity,f.body.length,sha(f.body),JSON.stringify(media)]);
    await client.query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,NULL,$5,$6,$7)',[fileId,f.companyId,f.projectId,f.binding.id,saved.destination_name,saved.destination_name_key,userId]);
    await client.query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,\'image/png\',$7,$8)',[versionId,f.companyId,f.projectId,fileId,f.body.length,sha(f.body),`coatria/companies/${f.companyId}/projects/${f.projectId}/objects/${versionId}`,userId]);
    await client.query("INSERT INTO project_storage_uploads(id,company_id,project_id,version_id,actor_key,actor_user_id,client_id,request_hash,status,provider_upload_id,provider_descriptor,part_bytes,expires_at,archive_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'uploading',$9,$10,$11,$12,$7)",[uploadId,f.companyId,f.projectId,versionId,'archive:'+saved.id,userId,saved.id,saved.request_hash,providerUploadId,JSON.stringify(descriptor),partBytes,saved.expires_at]);
    await client.query('INSERT INTO project_storage_upload_parts(company_id,upload_id,part_number,bytes,sha256,provider_etag) VALUES($1,$2,1,$3,$4,$5)',[f.companyId,uploadId,first.length,sha(first),'"part-'+sha(first)+'"']);
    await client.query("UPDATE higgsfield_output_archives SET status='uploading',upload_id=$2,version_id=$3,lease_id=$4,lease_expires_at=clock_timestamp()-interval '1 second',attempt_count=1 WHERE id=$1",[saved.id,uploadId,versionId,randomUUID()]);
    await client.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id]);
   });
   assert.equal((await f.worker().runNext()).status,'verified');assert.deepEqual({fetch:f.counts.fetch,create:f.counts.create,part:f.counts.part,complete:f.counts.complete,get:f.counts.get},{fetch:1,create:0,part:1,complete:1,get:1});assert.equal((await query('SELECT count(*)::int n FROM higgsfield_archive_fetches WHERE archive_id=$1',[saved.id])).rows[0].n,1);assert.deepEqual(f.objects.get(versionId),f.body);
  });
  await caseTest('an expired mutation lease is quarantined and an old worker cannot adopt its eventual response',async()=>{
   const f=await fixture(),entered=deferred(),release=deferred();f.hooks.beforeCreate=async()=>{entered.resolve();await release.promise;};const running=f.worker({authorityIntervalMs:5000}).runNext();await entered.promise;
   await query("UPDATE higgsfield_output_archives SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.proposal.id]);assert.equal((await f.worker().runNext()).status,'uncertain');release.resolve();await running;assert.equal(f.counts.create,1);assert.equal((await f.archive()).status,'uncertain');assert.equal((await query('SELECT count(*)::int n FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].n,0);
  });
  await caseTest('an expired read lease permits a fresh read with isolated scratch while fencing the old worker',async()=>{
   const f=await fixture(),entered=deferred(),release=deferred();let first=true;f.hooks.beforeFetch=async()=>{if(first){first=false;entered.resolve();await release.promise;}};
   const running=f.worker({authorityIntervalMs:5000}).runNext();await entered.promise;const oldDirs=await readdir(scratchRoot);assert.equal(oldDirs.length,1);assert.deepEqual(await f.worker().runNext(),{processed:false});
   await query("UPDATE higgsfield_output_archives SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.proposal.id]);assert.equal((await f.worker().runNext()).status,'verified');assert.notEqual(basename(dirname(f.scratchPaths[0])),oldDirs[0]);release.resolve();await running;assert.equal((await f.archive()).status,'verified');assert.equal(f.counts.create,1);assert.equal(f.counts.fetch,2);
  });
  await caseTest('a worker clock behind PostgreSQL cannot revive expired leases or approvals and cannot reach storage writes',async()=>{
   for(const expired of['lease','approval']){
    const f=await fixture(),originalNow=Date.now;
    f.hooks.beforeFetch=async()=>{
     if(expired==='lease')await query("UPDATE higgsfield_output_archives SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.proposal.id]);
     else await query("UPDATE higgsfield_output_archives SET approved_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.proposal.id]);
     Date.now=()=>originalNow()-24*60*60*1000;
    };
    try{const result=await f.worker({authorityIntervalMs:5000}).runNext();assert.equal(result.status,'blocked');assert.equal(result.code,'HIGGSFIELD_ARCHIVE_AUTHORITY_CHANGED');}finally{Date.now=originalNow;}
    const saved=await f.archive();assert.equal(saved.lease_id,null);assert.equal(saved.lease_expires_at,null);assert.equal(f.counts.create,0);assert.equal(f.counts.part,0);assert.equal(f.counts.complete,0);assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1',[f.companyId])).rows[0].n,0);assert.equal((await query('SELECT count(*)::int n FROM project_storage_verifications WHERE company_id=$1',[f.companyId])).rows[0].n,0);
   }
  });
  await caseTest('stalled reads and signal shutdown remain bounded; mutation shutdown is uncertain',async()=>{
   const f=await fixture();f.hooks.stallFetch=true;assert.equal((await f.worker({operationDeadlineMs:1000}).runNext()).code,'HIGGSFIELD_ARCHIVE_DEADLINE');assert.equal(f.counts.create,0);
   await query("UPDATE higgsfield_output_archives SET status='cancelled' WHERE id=$1",[f.proposal.id]);const g=await fixture(),controller=new AbortController();g.hooks.beforeCreate=async()=>{controller.abort(Error(g.privateLocator));return never();};const result=await g.worker().runNext({signal:controller.signal});assert.equal(result.status,'uncertain');assert.equal(g.counts.create,1);assert(!JSON.stringify(result).includes(g.privateLocator));
  });
  await caseTest('read recovery rejects new source bytes against the immutable fetch receipt',async()=>{
   const f=await fixture();f.hooks.beforeRead=async()=>{throw Error('Synthetic failed read');};await f.worker().runNext();const saved=await f.archive();await query("UPDATE higgsfield_output_archives SET status='uploading' WHERE id=$1",[f.proposal.id]);await query("UPDATE project_storage_uploads SET status='uploading' WHERE id=$1",[saved.upload_id]);f.hooks.source=Buffer.from('different-source-bytes');f.hooks.beforeRead=undefined;
   const result=await f.worker().runNext();assert.equal(result.code,'HIGGSFIELD_ARCHIVE_SOURCE_CHANGED');assert.equal(f.counts.create,1);assert.equal(f.counts.complete,1);assert.equal((await f.view()).archive.bytesVerified,false);assert.equal(f.scratchPaths.length,1,'Changed bytes must be rejected before decoding again');
  });
  await caseTest('real PNG decoder facts join the approved source and stored byte hash',async()=>{
   const bin=process.platform==='win32'?join(process.env.LOCALAPPDATA??'C:/Users/pecem/AppData/Local','Microsoft/WinGet/Links'):'/usr/bin',ffprobePath=process.env.COATRIA_TEST_FFPROBE_PATH??join(bin,process.platform==='win32'?'ffprobe.exe':'ffprobe'),ffmpegPath=process.env.COATRIA_TEST_FFMPEG_PATH??join(bin,process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
   await assert.doesNotReject(access(ffprobePath),'Configure COATRIA_TEST_FFPROBE_PATH for the actual decoder proof.');await assert.doesNotReject(access(ffmpegPath),'Configure COATRIA_TEST_FFMPEG_PATH for the actual decoder proof.');
   const f=await fixture({body:await readFile(resolve('tests/fixtures/media/synthetic.png')),name:'decoded.png'});const result=await f.worker({inspectMedia:value=>inspectHiggsfieldArchiveMedia(value,{nativeTestMode:true,ffprobePath,ffmpegPath})}).runNext();assert.equal(result.status,'verified',JSON.stringify(result));const evidence=(await query('SELECT media,sha256 FROM higgsfield_archive_fetches WHERE archive_id=$1',[f.proposal.id])).rows[0];assert.equal(evidence.media.verification,'full_decode');assert.equal(evidence.media.codec,'png');assert.equal(evidence.sha256,sha(f.body));
  });
  assert.equal(network,0);
 }finally{
  globalThis.fetch=before.fetch;await database().end();delete(globalThis as any).coatriaPool;
  try{await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('Fixture database shutdown timed out')),5000);dbWorker.once('message',()=>{clearTimeout(timer);yes();});dbWorker.postMessage('stop');});}finally{await dbWorker.terminate();}
  await rm(scratchRoot,{recursive:true,force:true});
  for(const[key,value]of Object.entries({DATABASE_URL:before.url,DATABASE_POOL_MAX:before.pool,COATRIA_HOSTING_KEYRING:before.key,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:before.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
