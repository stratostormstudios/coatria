import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {database,query,transaction} from '../src/lib/db';
import {hashToken,errorResponse} from '../src/lib/security';
import {handleApi} from '../src/lib/api';
import {studioClientDeliveryRoute} from '../src/lib/studio-client-delivery';
import {canonicalStudioMedia,type StudioMediaProvider} from '../src/lib/studio-media';
import {buildGeneratedClientPackage,validateGeneratedClientPackage} from '../src/lib/studio-generated-client-package';
import {makeGeneratedClientPackageFixture,seedGeneratedClientSource,type GeneratedFixtureKind} from './fixtures/generated-client-delivery';

type Row=Record<string,any>;
const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();

test('generated client packages enforce source, independent approval, exact account and replay boundaries',{skip:!emulate&&!localPostgres,timeout:240000},async t=>{
 const environment={...process.env},dbName='coatria_generated_client_'+randomUUID().replaceAll('-','');let stop:(()=>Promise<void>)|undefined,control:Pool|undefined,created=false;
 process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';process.env.COATRIA_STORAGE_GATEWAY_URL='https://gateway.example.invalid';
 const files=(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort();
 if(emulate){
  const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();
  for(const file of files)await db.exec(await readFile('database/'+file,'utf8'));
  const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};
 }else{
  control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;process.env.DATABASE_URL=url.href;
  for(const file of files)await query(await readFile('database/'+file,'utf8'));
 }
 const company=randomUUID(),foreignCompany=randomUUID(),users={owner:randomUUID(),registrar:randomUUID(),reviewer:randomUUID(),client:randomUUID(),otherClient:randomUUID(),member:randomUUID(),foreignOwner:randomUUID()};
 type Actor=keyof typeof users|'anonymous';
 const sessions=Object.fromEntries(Object.keys(users).map(key=>[key,randomUUID()])),origin='http://localhost:4180';let legacyReads=0;
 const provider:StudioMediaProvider={signUpload:async()=>{throw Error('Fixture forbids uploads');},read:async()=>null,signRead:async()=>{legacyReads++;throw Error('Generated media must not enter legacy Blob signing');}};
 async function request(path:string,method='GET',payload?:unknown,actor:Actor='owner'){
  const headers:Record<string,string>={Origin:origin,...actor==='anonymous'?{}:{Cookie:'coatria_session='+sessions[actor]},...payload===undefined?{}:{'Content-Type':'application/json'}};
  const req=new Request(origin+'/api/'+path,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),parts=path.split('?')[0].split('/');
  try{return await studioClientDeliveryRoute(req,parts,method,provider)??await handleApi(req,parts);}catch(error){return errorResponse(error);}
 }
 async function call(path:string,method='GET',payload?:unknown,actor:Actor='owner',expected=200):Promise<Row>{const response=await request(path,method,payload,actor),text=await response.text();assert.equal(response.status,expected,`${method} ${path}: ${text}`);return JSON.parse(text);}
 const admin=(p:{projectId:string})=>`companies/${company}/studio/projects/${p.projectId}/client-deliveries`,portal=(share:{id:string})=>'client-deliveries/'+share.id;
 const fresh=(kind:GeneratedFixtureKind='image')=>makeGeneratedClientPackageFixture({db:database(),transaction,call,companyId:company,users},kind);
 const payload=(p:{revision:number;delivery:Row},patch:Row={})=>({clientId:randomUUID(),revision:p.revision,deliveryId:p.delivery.id,recipientUserId:users.client,identityConfirmation:'confirmed_out_of_band',expiresAt:new Date(Date.now()+3600000).toISOString(),...patch});
 const share=async(p:Awaited<ReturnType<typeof fresh>>,patch:Row={})=>(await call(admin(p),'POST',payload(p,patch),'owner',201)).share;
 const savedGrant=async(shareId:string)=>(await query('SELECT * FROM studio_client_deliveries WHERE id=$1',[shareId])).rows[0];
 const savedDelivery=async(deliveryId:string)=>(await query('SELECT * FROM studio_deliveries WHERE id=$1',[deliveryId])).rows[0];
 try{
  for(const [name,userId] of Object.entries(users)){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','synthetic-not-login']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name]),userId]);}
  for(const id of[company,foreignCompany])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic generated client studio',$2,'blank')",[id,id]);
  for(const [actor,role] of [['owner','owner'],['registrar','admin'],['reviewer','admin'],['member','member']] as const)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,users[actor],role]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[foreignCompany,users.foreignOwner]);
  await call(`companies/${company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'comp',humanId:users.owner},{roleKey:'qc',humanId:users.reviewer}]},'owner',201);

  await t.test('image, video and audio complete real registration, review, package, client access and exact acknowledgement handlers',async()=>{
   for(const kind of ['image','video','audio'] as const){
    const p=await fresh(kind),input=payload(p),created=await call(admin(p),'POST',input,'owner',201),s=created.share;
    const replay=await call(admin(p),'POST',input);assert.equal(replay.replayed,true);assert.equal(replay.share.id,s.id);
    await call(admin(p),'POST',{...input,recipientUserId:users.otherClient},'owner',409);
    const detail=await call(portal(s),'GET',undefined,'client'),file=detail.package.files[0];
    assert.equal(detail.package.schemaVersion,2);assert.equal(detail.canRespond,true);assert.equal(file.fileId,p.versionId);assert.equal(file.storageVersionId,p.versionId);assert.equal(file.mediaKind,kind);assert.equal(file.transport,'project_storage');assert.equal(file.frame,null);assert.equal(file.path,'MEDIA010_v1.'+(kind==='image'?'png':kind==='video'?'mp4':'wav'));assert.equal(file.sha256,p.fileHash);assert.equal(file.bytes,p.bytes);assert.equal(file.contentType,p.contentType);
    assert.equal((await query('SELECT count(*)::int count FROM studio_media_files WHERE project_id=$1',[p.projectId])).rows[0].count,0);
    const row=(await query('SELECT file_id,media_file_id,storage_version_id,storage_sha256 FROM studio_client_delivery_files WHERE share_id=$1',[s.id])).rows[0];assert.equal(row.file_id,p.versionId);assert.equal(row.media_file_id,null);assert.equal(row.storage_version_id,p.versionId);assert.equal(row.storage_sha256,p.fileHash);
    const manifest=await request(portal(s)+'/manifest','GET',undefined,'client'),bytes=await manifest.text();assert.equal(manifest.status,200);assert.equal(hashToken(bytes),s.packageSha256);assert.equal(manifest.headers.get('X-Content-SHA256'),s.packageSha256);assert.deepEqual(JSON.parse(bytes),detail.package);
    assert(!/object_key|secret_envelope|providerUrl|source_snapshot|sct_|stg_/.test(bytes));
    const opening={clientId:randomUUID()},opened=await call(portal(s)+'/open','POST',opening,'client');assert.equal((await call(portal(s)+'/open','POST',opening,'client')).receipt.id,opened.receipt.id);
    const accessInput={clientId:randomUUID()},access=await call(portal(s)+`/files/${p.versionId}/access`,'POST',accessInput,'client');
    assert.equal(access.access.transport,'project_storage');assert.match(access.access.headers.Authorization,/^Bearer sct_/);assert.equal(access.access.url,`https://gateway.example.invalid/v1/client-files/${p.versionId}`);assert.equal(access.access.bytesReceivedByClient,'not_observed');assert.equal(access.receipt.fileId,p.versionId);assert.equal(access.receipt.packageSha256,s.packageSha256);assert.equal(legacyReads,0);
    const retry=await call(portal(s)+`/files/${p.versionId}/access`,'POST',accessInput,'client');assert.equal(retry.replayed,true);assert.equal(retry.receipt.id,access.receipt.id);assert.notEqual(retry.access.headers.Authorization,access.access.headers.Authorization);
    const responseInput={clientId:randomUUID(),revision:1,decision:'acknowledged',note:'Synthetic client attestation of this exact package, not measured receipt of bytes.'};
    const acknowledged=await call(portal(s)+'/responses','POST',responseInput,'client',201),responseReplay=await call(portal(s)+'/responses','POST',responseInput,'client');assert.equal(responseReplay.replayed,true);assert.equal(responseReplay.receipt.id,acknowledged.receipt.id);
    const project=(await query('SELECT status,gates FROM studio_projects WHERE id=$1',[p.projectId])).rows[0];assert.equal(project.status,'delivered');assert.equal(project.gates.client_acceptance.recordedBy,users.client);assert.equal(project.gates.client_acceptance.packageSha256,s.packageSha256);assert.equal(project.gates.client_acceptance.clientReceiptId,acknowledged.receipt.id);
    assert.equal((await savedDelivery(p.delivery.id)).manifest.transportStatus,'not_transferred');assert.equal((await savedDelivery(p.delivery.id)).status,'acknowledged');assert.equal((await call(portal(s),'GET',undefined,'client')).canRespond,false);
    await call(portal(s)+'/responses','POST',{...responseInput,note:'Changed retry'},'client',409);
    const grant=await savedGrant(s.id);assert.equal(grant.package_hash,hashToken(canonicalStudioMedia(grant.package_snapshot)));assert.equal(grant.source_manifest_hash,hashToken(canonicalStudioMedia((await savedDelivery(p.delivery.id)).manifest)));
   }
  });

  await t.test('only the externally confirmed account can act, including after joining or membership removal',async()=>{
   const p=await fresh(),s=await share(p),path=portal(s),open={clientId:randomUUID()};
   for(const actor of ['owner','registrar','reviewer','otherClient','foreignOwner'] as const){await call(path,'GET',undefined,actor,404);await call(path+'/open','POST',open,actor,404);await call(path+'/responses','POST',{clientId:randomUUID(),revision:1,decision:'acknowledged',note:'Not the client'},actor,404);}
   await call(path,'GET',undefined,'anonymous',401);await call(admin(p),'POST',payload(p),'member',403);
   for(const recipientUserId of [users.owner,users.registrar,users.reviewer,users.member])await call(admin(p),'POST',payload(p,{recipientUserId}),'owner',403);
   await call(path+'/open','POST',open,'client');await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'member')",[company,users.client]);
   await call(path+'/open','POST',open,'client',403);await call(path,'GET',undefined,'client',403);
   await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[company,users.client]);await call(path,'GET',undefined,'client',403);
   await query('DELETE FROM memberships WHERE company_id=$1 AND user_id=$2',[company,users.client]);
   for(const actor of ['registrar','reviewer'] as const){await query('DELETE FROM memberships WHERE company_id=$1 AND user_id=$2',[company,users[actor]]);await call(admin(p),'POST',payload(p,{recipientUserId:users[actor]}),'owner',403);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin')",[company,users[actor]]);}
  });

  await t.test('unfinished delivery handoff and changed production policy deny first client acknowledgement',async()=>{
   for(const change of ['handoff','production','ai'] as const){const p=await fresh(),s=await share(p);
    if(change==='handoff')await query("UPDATE tasks SET status='review' WHERE id IN(SELECT task_id FROM studio_work_items WHERE project_id=$1 AND stage='delivery')",[p.projectId]);
    else if(change==='production')await query("UPDATE studio_projects SET gates=jsonb_set(gates,'{production,decision}','\"changes_requested\"') WHERE id=$1",[p.projectId]);
    else await query("UPDATE studio_projects SET ai_policy='restricted' WHERE id=$1",[p.projectId]);
    assert.equal((await call(portal(s),'GET',undefined,'client')).canRespond,false);
    await call(portal(s)+'/responses','POST',{clientId:randomUUID(),revision:1,decision:'acknowledged',note:'Must be denied'},'client',409);
    assert.equal((await query("SELECT count(*)::int count FROM studio_client_delivery_receipts WHERE share_id=$1 AND kind='acknowledged'",[s.id])).rows[0].count,0);
    await call(admin(p),'POST',payload(p),'owner',409);
   }
  });

  await t.test('offline or revoked storage preserves exact historical metadata but cannot issue access or acknowledge',async()=>{
   for(const change of ['offline','archive'] as const){const p=await fresh(),s=await share(p),before=await call(portal(s),'GET',undefined,'client');
    if(change==='offline')await query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL WHERE id=$1",[p.storageId]);
    else await query('UPDATE higgsfield_output_archives SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1',[p.archiveId,users.owner]);
    const after=await call(portal(s),'GET',undefined,'client');assert.deepEqual(after.package,before.package);assert.equal(after.canRespond,false);
    const manifest=await request(portal(s)+'/manifest','GET',undefined,'client');assert.equal(manifest.status,200);assert.equal(hashToken(await manifest.text()),s.packageSha256);
    await call(portal(s)+`/files/${p.versionId}/access`,'POST',{clientId:randomUUID()},'client',409);
    await call(portal(s)+'/responses','POST',{clientId:randomUUID(),revision:1,decision:'acknowledged',note:'Unavailable media'},'client',409);
    assert.equal((await query('SELECT count(*)::int count FROM studio_client_storage_grants WHERE share_id=$1',[s.id])).rows[0].count,0);
   }
  });

  await t.test('grant revocation, expiry and sponsor loss are rechecked before replaying a receipt',async()=>{
   for(const change of ['revoke','expire','sponsor'] as const){const p=await fresh(),s=await share(p,change==='expire'?{expiresAt:new Date(Date.now()+2500).toISOString()}:{}),open={clientId:randomUUID()};await call(portal(s)+'/open','POST',open,'client');
    if(change==='revoke')await call(admin(p)+'/'+s.id+'/revoke','POST',{clientId:randomUUID(),revision:1});
    else if(change==='expire')await delay(2600);
    else await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,users.owner]);
    await call(portal(s)+'/open','POST',open,'client',change==='sponsor'?403:410);
    if(change==='sponsor')await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,users.owner]);
   }
  });

  await t.test('package checks reject substituted evidence and foreign version IDs without granting access',async()=>{
   const p=await fresh(),other=await fresh('audio'),s=await share(p),grant=await savedGrant(s.id),delivery=await savedDelivery(p.delivery.id);
   await call(portal(s)+`/files/${other.versionId}/access`,'POST',{clientId:randomUUID()},'client',404);
   for(const mutate of [(value:Row)=>{value.package_snapshot.files[0].sha256='0'.repeat(64);},(value:Row)=>{value.source_manifest_hash='0'.repeat(64);},(value:Row)=>{value.package_hash='0'.repeat(64);},(value:Row)=>{value.package_snapshot.files[0].storageVersionId=other.versionId;}]){
    const bad=structuredClone(grant);mutate(bad);await assert.rejects(()=>transaction(client=>validateGeneratedClientPackage(client,bad,{requireReady:false,requireAvailable:false})),(error:Row)=>error.code==='CLIENT_PACKAGE_UNAVAILABLE');
   }
   for(const mutate of [(value:Row)=>{value.manifest.artifacts[0].file.sha256='0'.repeat(64);},(value:Row)=>{value.manifest.reviewReceipts[0].reviewedBy=users.owner;},(value:Row)=>{value.manifest.artifacts=[];},(value:Row)=>{value.manifest.project.spec.width=32;},(value:Row)=>{value.company_id=foreignCompany;}]){
    const bad=structuredClone(delivery);mutate(bad);await assert.rejects(()=>transaction(client=>buildGeneratedClientPackage(client,company,p.projectId,bad,users.client)),(error:Row)=>error.code==='CLIENT_PACKAGE_UNAVAILABLE');
   }
   await query("UPDATE project_storage_files SET name='renamed-private-file.png',name_key='renamed-private-file.png' WHERE id=$1",[p.fileId]);
   await query("UPDATE studio_projects SET name='Renamed current project',client_name='Renamed current client' WHERE id=$1",[p.projectId]);
   assert.deepEqual((await call(portal(s),'GET',undefined,'client')).package,grant.package_snapshot);
   const changes=await call(portal(s)+'/responses','POST',{clientId:randomUUID(),revision:1,decision:'changes_requested',note:'Request a new revision without authorizing new generation.'},'client',201);assert.equal(changes.project.status,'review');assert.equal((await savedDelivery(p.delivery.id)).status,'prepared');
  });

  await t.test('a later version or review cannot replace the pinned package or inherit client acceptance',async()=>{
   for(const changed of ['artifact','review'] as const){
    const p=await fresh(),s=await share(p),before=(await call(portal(s),'GET',undefined,'client')).package,prefix=`companies/${company}/studio/projects/${p.projectId}`;
    await query("UPDATE tasks SET status='todo' WHERE id=$1",[p.taskId]);
    if(changed==='artifact'){
     const source=await transaction(client=>seedGeneratedClientSource(client,{companyId:company,projectId:p.projectId,workItemId:p.workItemId,taskId:p.taskId,producerId:users.owner,approverId:users.owner,kind:'image',storage:p}));
     const registered=await call(prefix+'/generated-artifacts','POST',{clientId:randomUUID(),revision:p.revision,workItemId:p.workItemId,archiveId:source.archiveId,name:'Second generated version',notes:'A different immutable source'},'registrar',201);
     await call(prefix+'/reviews','POST',{clientId:randomUUID(),revision:registered.project.revision,artifactId:registered.artifact.id,decision:'approved',note:'Independent synthetic second-version review',technicalQc:true},'reviewer',201);
    }else await call(prefix+'/reviews','POST',{clientId:randomUUID(),revision:p.revision,artifactId:p.artifactId,decision:'changes_requested',note:'Independent reviewer requested changes after this package was prepared.',technicalQc:false},'reviewer',201);
    await query("UPDATE tasks SET status='done' WHERE id=$1",[p.taskId]);
    const current=await call(portal(s),'GET',undefined,'client');assert.deepEqual(current.package,before);assert.equal(current.canRespond,false);
    const response=await call(portal(s)+'/responses','POST',{clientId:randomUUID(),revision:1,decision:'acknowledged',note:'An old package cannot accept newer work.'},'client',409);assert.equal(response.code,'CLIENT_PACKAGE_SUPERSEDED');
    const grant=await savedGrant(s.id);assert.deepEqual(await transaction(client=>validateGeneratedClientPackage(client,grant,{requireReady:false,requireAvailable:false})),before);
   }
  });

  await t.test('migration 032 keeps generated shares, file identities and reviewed version pins immutable',async()=>{
   const p=await fresh(),s=await share(p),grant=await savedGrant(s.id);
   for(const statement of [
    {sql:"UPDATE studio_client_deliveries SET package_snapshot=jsonb_set(package_snapshot,'{files,0,sha256}',to_jsonb($2::text)) WHERE id=$1",values:[s.id,'0'.repeat(64)]},
    {sql:'UPDATE studio_client_delivery_files SET storage_sha256=$2 WHERE share_id=$1',values:[s.id,'0'.repeat(64)]},
    {sql:'UPDATE studio_client_delivery_files SET review_id=$2 WHERE share_id=$1',values:[s.id,randomUUID()]},
   ])await assert.rejects(()=>transaction(client=>client.query(statement.sql,statement.values)),(error:Row)=>error.code==='23514');
   assert.equal((await savedGrant(s.id)).package_hash,grant.package_hash);
   const pinned=(await query('SELECT review_id,storage_name FROM studio_client_delivery_files WHERE share_id=$1',[s.id])).rows[0];assert.equal(pinned.review_id,p.reviewId);assert.equal(pinned.storage_name,grant.package_snapshot.files[0].path);
  });
 }finally{
  await database().end();delete (globalThis as {coatriaPool?:Pool}).coatriaPool;await stop?.();
  if(control){if(created)await control.query('DROP DATABASE '+dbName);await control.end();}
  for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
 }
});
