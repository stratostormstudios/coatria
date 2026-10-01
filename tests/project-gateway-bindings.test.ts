import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFile,readdir} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {PGlite} from '@electric-sql/pglite';
import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {createGatewayChallenge,answerGatewayChallenge,verifyGatewayAnswer,type GatewayIdentity} from '../src/lib/project-gateway-identity';
import {trustedServiceHash} from '../src/lib/trusted-service-config';
import {verifyAndBindProjectGateway,verifiedProjectGateway,resolveProjectGateway,revokeProjectGateway,authorizeProjectGatewayGrant,verifiedGatewayOriginsForUser,projectGatewayServiceIdentity} from '../src/lib/project-gateway-bindings';
import {createProjectStorageConnection,bindProjectStorage,reserveProjectStorageUpload} from '../src/lib/project-storage';
import {projectStorageTransfer} from '../src/lib/project-storage-transfer';
import {hashToken} from '../src/lib/security';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';

const keyring=JSON.stringify({activeKeyId:'test-gateway',keys:{'test-gateway':Buffer.alloc(32,47).toString('base64')}});
const baseIdentity=():GatewayIdentity=>({version:1,companyId:randomUUID(),projectIds:[randomUUID()],provisionId:randomUUID(),configurationHash:'a'.repeat(64),sourceCommit:'b'.repeat(40),expiresAt:new Date(Date.now()+600000).toISOString()});
test('signed gateway identity rejects forged, expired, reflected and cross-project answers',()=>{
 const before=process.env.COATRIA_HOSTING_KEYRING;process.env.COATRIA_HOSTING_KEYRING=keyring;
 try{const identity=baseIdentity(),challenge=createGatewayChallenge(identity),answer=answerGatewayChallenge(challenge,identity);assert(verifyGatewayAnswer(answer,challenge));
  assert.throws(()=>answerGatewayChallenge({...challenge,mac:'0'.repeat(64)},identity));assert.throws(()=>answerGatewayChallenge(challenge,{...identity,projectIds:[randomUUID()]}));assert.throws(()=>verifyGatewayAnswer({challenge,mac:challenge.mac},challenge));assert.throws(()=>verifyGatewayAnswer(answer,createGatewayChallenge(identity)));assert.throws(()=>verifyGatewayAnswer(answer,challenge,challenge.expiresAt+1));
 }finally{if(before===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=before;}
});

test('project routes require a real signed HTTP handshake; epochs stop both token classes and legacy fallback',{timeout:120000},async()=>{
 const env={COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING,COATRIA_STORAGE_GATEWAY_ENABLED:process.env.COATRIA_STORAGE_GATEWAY_ENABLED,COATRIA_STORAGE_GATEWAY_URL:process.env.COATRIA_STORAGE_GATEWAY_URL};process.env.COATRIA_HOSTING_KEYRING=keyring;process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';process.env.COATRIA_STORAGE_GATEWAY_URL='https://legacy.example.invalid';
 const db=await PGlite.create();let server:ReturnType<typeof createServer>|undefined;
 const client={query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows};}} as unknown as PoolClient;
 try{
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));
  const userId=randomUUID(),outsider=randomUUID();for(const u of[userId,outsider])await db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Gateway fixture',$2,'fixture')",[u,u+'@example.invalid']);
  async function fixture(){const companyId=randomUUID(),projectId=randomUUID(),extraProject=randomUUID(),provisionId=randomUUID();await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1::uuid,'Gateway fixture',$1::uuid::text,'blank')",[companyId]);await db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await db.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
   for(const p of[projectId,extraProject])await db.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,production_path,created_by) VALUES($1,$2,'Gateway fixture','Internal','Synthetic', $3,'allowed','higgsfield',$4)",[p,companyId,JSON.stringify({width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),userId]);
   const configuration={version:1,companyId,projectIds:[projectId],sourceCommit:'b'.repeat(40),expiresAt:new Date(Date.now()+600000).toISOString(),appOrigin:'https://coatria.com',host:'0.0.0.0',port:4190,maxTransfers:8,verifierConcurrency:1};const preset={service:'gateway',companyId,projectIds:[projectId],releaseCommit:configuration.sourceCommit,expiresAt:configuration.expiresAt,configuration,configurationHash:trustedServiceHash(configuration)},plan={preset:{hash:trustedServiceHash(preset)}};
   await db.query("INSERT INTO trusted_service_provisions(id,company_id,service,created_by,client_id,request_hash,preset,plan,plan_hash,pod_name,pod_id,expires_at,phase,provider_status,last_reconciled_at) VALUES($1,$2,'gateway',$3,$4,$5,$6,$7,$8,$9,$10,$11,'running','RUNNING',clock_timestamp())",[provisionId,companyId,userId,randomUUID(),'c'.repeat(64),JSON.stringify(preset),JSON.stringify(plan),trustedServiceHash(plan),'gateway-'+provisionId,provisionId.replaceAll('-',''),configuration.expiresAt]);
   const identity:GatewayIdentity={version:1,companyId,projectIds:[projectId],provisionId,configurationHash:preset.configurationHash,sourceCommit:configuration.sourceCommit,expiresAt:configuration.expiresAt},member={companyId,userId,role:'owner' as const,user:{id:userId,name:'Fixture',email:userId+'@example.invalid',roleTitle:'Owner',avatarColor:'#000000',avatarId:null,emailVerified:true}};return {companyId,projectId,extraProject,provisionId,identity,member};}
  const a=await fixture(),b=await fixture();let active=a.identity;
  server=createServer(async(req,res)=>{try{const gateway=createProjectStorageGateway({scope:{companyId:active.companyId,projectIds:active.projectIds},identity:active}),request=new Request('http://localhost'+req.url,{method:req.method,headers:{'Content-Type':'application/json'},body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'} as RequestInit),response=await gateway.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}catch{res.writeHead(500);res.end();}});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
  const transport:typeof fetch=(url,init)=>{assert.match(String(url),/^https:\/\/[a-z0-9]+-4190\.proxy\.runpod\.net\/v1\/identity$/);return fetch(`http://127.0.0.1:${address.port}/v1/identity`,init);};
  assert.equal(await resolveProjectGateway(client,a.companyId,a.projectId),null);assert.equal((await resolveProjectGateway(client,a.companyId,a.extraProject))?.origin,'https://legacy.example.invalid');
  await assert.rejects(verifyAndBindProjectGateway(client,a.member,a.projectId,{provisionId:b.provisionId,expectedBindingId:null},transport));await assert.rejects(verifyAndBindProjectGateway(client,a.member,a.extraProject,{provisionId:a.provisionId,expectedBindingId:null},transport));await assert.rejects(verifyAndBindProjectGateway(client,a.member,a.projectId,{provisionId:a.provisionId,expectedBindingId:null},async()=>new Response('{}')));
  const first=(await verifyAndBindProjectGateway(client,a.member,a.projectId,{provisionId:a.provisionId,expectedBindingId:null},transport)).gateway!;assert(first);assert.equal(first.provisionId,a.provisionId);assert.deepEqual(await verifiedGatewayOriginsForUser(client,userId),[first.origin,'https://legacy.example.invalid'].sort());assert.deepEqual(await verifiedGatewayOriginsForUser(client,outsider),[]);
  const connection=(await createProjectStorageConnection(client,a.member,{clientId:randomUUID(),name:'Synthetic storage',region:'US-NC-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_fixturevalue'})).connection;await bindProjectStorage(client,a.member,a.projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id});
  const upload=await reserveProjectStorageUpload(client,a.member,a.projectId,{clientId:randomUUID(),revision:1,parentId:null,name:'fixture.txt',bytes:6,contentType:'text/plain'},projectStorageTransfer);const receipt=(await client.query('SELECT * FROM project_storage_access_receipts WHERE token_hash=$1',[hashToken(upload.upload.token)])).rows[0];assert.equal(receipt.service_binding_id,first.bindingId);assert.equal(receipt.service_provision_id,a.provisionId);assert(+new Date(receipt.expires_at)<=Date.parse(first.expiresAt));
  await authorizeProjectGatewayGrant(client,receipt,a.identity);await assert.rejects(authorizeProjectGatewayGrant(client,receipt,b.identity));await assert.rejects(authorizeProjectGatewayGrant(client,{...receipt,project_id:a.extraProject},a.identity));
  await db.query('UPDATE trusted_service_provisions SET stop_requested_at=clock_timestamp() WHERE id=$1',[a.provisionId]);assert.equal(await verifiedProjectGateway(client,a.companyId,a.projectId),null);await assert.rejects(authorizeProjectGatewayGrant(client,receipt,a.identity));await db.query('UPDATE trusted_service_provisions SET stop_requested_at=NULL WHERE id=$1',[a.provisionId]);
  const replacement=(await verifyAndBindProjectGateway(client,a.member,a.projectId,{provisionId:a.provisionId,expectedBindingId:first.bindingId},transport)).gateway!;assert.notEqual(replacement.bindingId,first.bindingId);await assert.rejects(authorizeProjectGatewayGrant(client,receipt,a.identity));
  const clientReceipt={company_id:a.companyId,project_id:a.projectId,service_binding_id:replacement.bindingId,service_provision_id:a.provisionId};await authorizeProjectGatewayGrant(client,clientReceipt,a.identity);
  const configurationId=randomUUID(),configurationHash='d'.repeat(64),pin={configurationId,configurationHash,selectionRevision:1,expiresAt:a.identity.expiresAt};
  await db.query("INSERT INTO company_runtime_configurations(id,company_id,kind,phase,preset,configuration_hash,expires_at,created_by) VALUES($1,$2,'gateway','service','{}',$3,$4,$5)",[configurationId,a.companyId,configurationHash,a.identity.expiresAt,userId]);
  await db.query("INSERT INTO company_runtime_selections(company_id,kind,configuration_id,revision,state,selected_by) VALUES($1,'gateway',$2,1,'active',$3)",[a.companyId,configurationId,userId]);
  assert.equal(await verifiedProjectGateway(client,a.companyId,a.projectId),null,'a legacy provision cannot survive a newly selected managed configuration');assert.equal(await resolveProjectGateway(client,a.companyId,a.extraProject),null,'selection history disables global fallback company-wide');
  const updatePin=async(value:unknown)=>{const prior=(await db.query<{plan:Record<string,unknown>}>('SELECT plan FROM trusted_service_provisions WHERE id=$1',[a.provisionId])).rows[0].plan,next={...prior,runtimeConfiguration:value};await db.query('UPDATE trusted_service_provisions SET plan=$2,plan_hash=$3 WHERE id=$1',[a.provisionId,JSON.stringify(next),trustedServiceHash(next)]);};await updatePin(pin);assert(await verifiedProjectGateway(client,a.companyId,a.projectId));
  await db.query("UPDATE company_runtime_selections SET state='revoked' WHERE company_id=$1 AND kind='gateway'",[a.companyId]);await assert.rejects(authorizeProjectGatewayGrant(client,clientReceipt,a.identity));assert.equal(await verifiedProjectGateway(client,a.companyId,a.projectId),null);
  await db.query("UPDATE company_runtime_selections SET state='active',revision=2 WHERE company_id=$1 AND kind='gateway'",[a.companyId]);await assert.rejects(authorizeProjectGatewayGrant(client,clientReceipt,a.identity));
  await updatePin({...pin,selectionRevision:2});await authorizeProjectGatewayGrant(client,clientReceipt,a.identity);
  await revokeProjectGateway(client,a.member,a.projectId,{bindingId:replacement.bindingId});await assert.rejects(authorizeProjectGatewayGrant(client,clientReceipt,a.identity));await assert.rejects(authorizeProjectGatewayGrant(client,{...clientReceipt,service_binding_id:null,service_provision_id:null}));assert.equal(await resolveProjectGateway(client,a.companyId,a.projectId),null);
  active=b.identity;const bound=(await verifyAndBindProjectGateway(client,b.member,b.projectId,{provisionId:b.provisionId,expectedBindingId:null},transport)).gateway!;await db.query("UPDATE project_gateway_bindings SET expires_at=verified_at+interval '1 millisecond' WHERE id=$1",[bound.bindingId]);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(await verifiedProjectGateway(client,b.companyId,b.projectId),null);
  const row=(await db.query<Record<string,any>>('SELECT * FROM trusted_service_provisions WHERE id=$1',[a.provisionId])).rows[0];assert.equal(projectGatewayServiceIdentity({...row,last_reconciled_at:new Date(Date.now()-120001)},a.projectId,Date.now()),null);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await db.close();for(const[k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});


// Reuse only synthetic relational source/gateway metadata; no processor is
// enrolled and no source bytes or live provider are contacted in these checks.
test('timestamp-only gateway sponsor revocation stops resolution, grants and CSP without legacy fallback',{timeout:120000},async()=>{
 const database=await openImagePreparationServiceDatabase(),prior={COATRIA_STORAGE_GATEWAY_ENABLED:process.env.COATRIA_STORAGE_GATEWAY_ENABLED,COATRIA_STORAGE_GATEWAY_URL:process.env.COATRIA_STORAGE_GATEWAY_URL};
 process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';process.env.COATRIA_STORAGE_GATEWAY_URL='https://legacy.example.invalid';
 try{
  for(const principal of ['provisionSponsorId','verifierId'] as const){
   const f=await database.tx(db=>imagePreparationServiceFixture(db,{enroll:false,propose:false,preparationGateway:false,distinctGatewayPrincipals:true}));
   assert.notEqual(f.userId,f.gateway[principal]);assert.notEqual(f.gateway.provisionSponsorId,f.gateway.verifierId);
   const grant={company_id:f.companyId,project_id:f.projectId,service_binding_id:f.gateway.bindingId,service_provision_id:f.gateway.provisionId};
   const identity:GatewayIdentity={version:1,companyId:f.companyId,projectIds:[f.projectId],provisionId:f.gateway.provisionId,configurationHash:f.gateway.configurationHash,sourceCommit:'b'.repeat(40),expiresAt:f.gateway.expiresAt};
   assert.equal((await verifiedProjectGateway(database.db,f.companyId,f.projectId))?.origin,f.gateway.origin);
   assert.equal((await resolveProjectGateway(database.db,f.companyId,f.projectId))?.origin,f.gateway.origin);
   assert.deepEqual(await verifiedGatewayOriginsForUser(database.db,f.userId),[f.gateway.origin]);
   await authorizeProjectGatewayGrant(database.db,grant,identity);
   await database.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.companyId,f.gateway[principal]]);
   assert.equal((await database.db.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[f.companyId,f.gateway[principal]])).rows[0].role,'admin');
   assert.equal(await verifiedProjectGateway(database.db,f.companyId,f.projectId),null,principal);
   assert.equal(await resolveProjectGateway(database.db,f.companyId,f.projectId),null,'Historical managed routing must not fall back to the legacy endpoint.');
   assert.deepEqual(await verifiedGatewayOriginsForUser(database.db,f.userId),[],principal);
   await assert.rejects(authorizeProjectGatewayGrant(database.db,grant,identity),(error:any)=>error.code==='STORAGE_ACCESS_DENIED');
   await assert.rejects(authorizeProjectGatewayGrant(database.db,{...grant,service_binding_id:null,service_provision_id:null}),(error:any)=>error.code==='STORAGE_ACCESS_DENIED');
   if(principal==='provisionSponsorId'){
    let calls=0;const member={companyId:f.companyId,userId:f.userId,role:'owner' as const,user:{id:f.userId,name:'Fixture',email:'fixture@example.invalid',roleTitle:'Owner',avatarColor:'#000000',avatarId:null,emailVerified:true}};
    await assert.rejects(database.tx(db=>verifyAndBindProjectGateway(db,member,f.projectId,{provisionId:f.gateway.provisionId,expectedBindingId:null},async()=>{calls++;return new Response('{}');})),(error:any)=>error.code==='STORAGE_GATEWAY_UNAVAILABLE');assert.equal(calls,0,'Revoked provisioning authority is denied before the signed handshake.');
   }
  }
 }finally{await database.close();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('timestamp-only ordinary membership revocation removes managed and legacy CSP origins',{timeout:120000},async()=>{
 const database=await openImagePreparationServiceDatabase(),prior={COATRIA_STORAGE_GATEWAY_ENABLED:process.env.COATRIA_STORAGE_GATEWAY_ENABLED,COATRIA_STORAGE_GATEWAY_URL:process.env.COATRIA_STORAGE_GATEWAY_URL};
 process.env.COATRIA_STORAGE_GATEWAY_ENABLED='true';process.env.COATRIA_STORAGE_GATEWAY_URL='https://legacy.example.invalid';
 try{
  const f=await database.tx(db=>imagePreparationServiceFixture(db,{enroll:false,propose:false,preparationGateway:false,distinctGatewayPrincipals:true})),viewer=randomUUID(),legacyProject=randomUUID();
  await database.db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Ordinary gateway viewer',$2,'fixture')",[viewer,viewer+'@example.invalid']);
  await database.db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'member')",[f.companyId,viewer]);
  await database.db.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,production_path,created_by) SELECT $1,company_id,'Legacy project',client_name,brief,spec,ai_policy,production_path,created_by FROM studio_projects WHERE id=$2",[legacyProject,f.projectId]);
  assert.deepEqual(await verifiedGatewayOriginsForUser(database.db,viewer),[f.gateway.origin,'https://legacy.example.invalid'].sort());
  await database.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.companyId,viewer]);
  assert.equal((await database.db.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[f.companyId,viewer])).rows[0].role,'member');
  assert.deepEqual(await verifiedGatewayOriginsForUser(database.db,viewer),[]);
  assert(await verifiedProjectGateway(database.db,f.companyId,f.projectId),'Revoking an unrelated viewer does not revoke the gateway sponsors.');
 }finally{await database.close();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
