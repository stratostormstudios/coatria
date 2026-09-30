import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {createHiggsfieldReferenceService,referenceServiceAvailability} from '../src/lib/higgsfield-reference-service';
import * as refs from '../src/lib/higgsfield-references';
import type {HiggsfieldReferenceLease} from '../src/lib/higgsfield-references-protocol';
import {createHiggsfieldReferenceServiceClient} from '../src/lib/higgsfield-reference-service-client';
import {createHiggsfieldReferenceWorker} from '../src/lib/higgsfield-reference-worker';
import type {HiggsfieldMediaDescriptor} from '../src/lib/higgsfield-media-inspection';

type Row=Record<string,any>;
test('finite reference service API: exact stored bytes, consent, durable mutation fences and revocation (PGlite)',{timeout:180000},async t=>{
 const prior={pool:(globalThis as any).coatriaPool,url:process.env.DATABASE_URL,max:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,broker:process.env.COATRIA_REFERENCE_BROKER_DATABASE_URL};
 const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),pg=await PGlite.create();
 for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await pg.exec(await readFile('database/'+file,'utf8'));
 const socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();
 delete(globalThis as any).coatriaPool;process.env.DATABASE_URL='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres';process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});process.env.COATRIA_REFERENCE_BROKER_DATABASE_URL='synthetic-readiness-only';
 const bytes=await readFile('tests/fixtures/media/synthetic.png'),sha256=createHash('sha256').update(bytes).digest('hex');
 const insert=async(table:string,row:Row)=>{const keys=Object.keys(row);return(await query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row))).rows[0];};
 async function fixture(trace?:string[][]){
  const company=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),project=randomUUID(),task=randomUUID(),work=randomUUID(),providerId=randomUUID(),serviceId=randomUUID(),token='rfs_'+randomBytes(32).toString('base64url');
  for(const user of[owner,reviewer])await insert('users',{id:user,name:'Synthetic reference service',email:user+'@example.invalid',password_hash:'not-a-login'});
  await insert('companies',{id:company,name:'Reference service fixture',slug:company,template:'blank'});await insert('memberships',{company_id:company,user_id:owner,role:'owner'});await insert('memberships',{company_id:company,user_id:reviewer,role:'admin'});
  await insert('studio_profiles',{company_id:company,template_id:'ai-production',template_version:1,created_by:owner});
  await insert('studio_projects',{id:project,company_id:company,name:'Synthetic prepared image',client_name:'Internal',brief:'One exact image',spec:JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}}),ai_policy:'allowed',status:'production',gates:JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:reviewer}]))),created_by:owner,production_path:'higgsfield',contract_version:2});
  await insert('tasks',{id:task,company_id:company,title:'Choose prepared image',description:'Synthetic stored image',created_by:owner,assignee_id:owner});
  await insert('studio_work_items',{id:work,company_id:company,project_id:project,logical_key:'reference',task_id:task,stage:'references',role_key:'comp',execution:'creative'});
  await insert('studio_role_bindings',{company_id:company,role_key:'comp',human_id:owner});
  await insert('higgsfield_connections',{company_id:company,id:providerId,revision:1,status:'connected',connected_by:owner,sealed:JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId:company,id:providerId,purpose:'oauth-connection'})),expires_at:new Date(Date.now()+3600000),tools:'[]'});
  const actor={companyId:company,userId:owner},admin={companyId:company,userId:reviewer},connection=(await transaction(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic prepared images',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_syntheticsecret'}))).connection;
  const binding=(await transaction(db=>bindProjectStorage(db,actor,project,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding,file=randomUUID(),version=randomUUID();
  await insert('project_storage_files',{id:file,company_id:company,project_id:project,binding_id:binding.id,name:'prepared.png',name_key:'prepared.png',created_by:owner});
  await insert('project_storage_versions',{id:version,company_id:company,project_id:project,file_id:file,version:1,bytes:bytes.length,sha256,content_type:'image/png',object_key:`coatria/companies/${company}/projects/${project}/objects/${version}`,created_by:owner});
  await insert('project_storage_verifications',{company_id:company,project_id:project,version_id:version,bytes:bytes.length,sha256,provider_etag:'"synthetic-etag"',gateway_receipt_id:randomUUID()});
  // Synthetic enrollment is fixture setup, not a host qualification or a public API.
  await insert('higgsfield_reference_services',{id:serviceId,company_id:company,token_hash:hashToken(token),enrolled_by:owner,release_sha256:'a'.repeat(64),qualification_sha256:'b'.repeat(64),profile_sha256:'c'.repeat(64),provider_connection_id:providerId,provider_connection_revision:1,catalog_sha256:refs.higgsfieldReferenceDigest([]),upload_hosts:JSON.stringify(['uploads.example.com']),expires_at:new Date(Date.now()+1200000)});
  await insert('higgsfield_reference_service_projects',{service_id:serviceId,company_id:company,project_id:project,storage_binding_id:binding.id,storage_binding_revision:binding.revision,storage_connection_id:connection.id,storage_connection_revision:connection.revision});
  const proposal=await transaction(db=>refs.proposeHiggsfieldReference(db,actor,{clientId:randomUUID(),projectId:project,projectRevision:1,workItemId:work,proxyVersionId:version,proxyBytes:bytes.length,proxySha256:sha256,role:'image',purpose:'Synthetic prepared image; approval still pending'}));
  let reads=0,closes=0,allocations=0,confirmations=0,loseAllocation=false;const options={availability:(db:any,c:string,p:string)=>referenceServiceAvailability(db,c,p,{brokerReady:async()=>true})},mediaId=randomUUID();
  const handler=createHiggsfieldReferenceService({transaction:trace?run=>transaction(db=>{
   const statements:string[]=[];trace.push(statements);
   return run(new Proxy(db,{get(target,key,receiver){if(key!=='query')return Reflect.get(target,key,receiver);return (...args:any[])=>{statements.push(String(args[0]));return Reflect.apply(target.query,target,args);};}}));
  }):transaction,providerFactory:config=>({get:async (input:{versionId:string;ifMatch?:string;range?:unknown})=>{reads++;assert.equal(config.companyId,company);assert.equal(config.projectId,project);assert.equal(input.versionId,version);assert.equal(input.ifMatch,'"synthetic-etag"');assert.equal(input.range,undefined);return {stream:new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),bytes:bytes.length,totalBytes:bytes.length,etag:'"synthetic-etag"',range:null,contentRange:null,contentType:'image/png'};},close(){closes++;}} as any),brokerFactory:()=>({
   allocate:async(l,signal)=>{signal.throwIfAborted();const intent=await transaction(db=>refs.beginHiggsfieldReferencePhase(db,l,'allocate',options));allocations++;if(loseAllocation)throw Error('Synthetic provider response lost');await transaction(db=>refs.completeHiggsfieldReferencePhase(db,l,intent.actionId,{phase:'allocate',allocation:{mediaId,uploadUrl:'https://uploads.example.com/private?opaque=synthetic',expiresAt:new Date(Date.now()+600000).toISOString()}},options));},
   uploadCapability:async l=>transaction(db=>refs.getHiggsfieldReferenceTransport(db,l,options)),
   confirm:async(l,signal)=>{signal.throwIfAborted();const intent=await transaction(db=>refs.beginHiggsfieldReferencePhase(db,l,'confirm',options));confirmations++;await transaction(db=>refs.completeHiggsfieldReferencePhase(db,l,intent.actionId,{phase:'confirm',mediaId,confirmed:true},options));}
  })});
  const request=(op:string,payload:Row={},headers:Row={})=>handler(new Request('https://coatria.com/api/internal/reference-services/'+serviceId+'/'+op,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:JSON.stringify({requestId:randomUUID(),...payload})}),serviceId,op);
  const call=async(op:string,payload:Row={},status=200,headers:Row={})=>{const response=await request(op,payload,headers),result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
  const scope=(l:HiggsfieldReferenceLease)=>({referenceId:l.referenceId,leaseId:l.leaseId,requestHash:l.requestHash});
  const descriptor={kind:'image',format:'png',contentType:'image/png',bytes:bytes.length,sha256,verification:'full_decode',inspectionVersion:1,width:16,height:16,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};
  const inspect=async()=>{const l=(await call('claim')).lease;await call('inspection',{...scope(l),inspection:{descriptor,profileSha256:'c'.repeat(64)}});return l;};
  const approve=async()=>{const r=(await transaction(db=>refs.getHiggsfieldReference(db,actor,proposal.reference.id))).reference;return transaction(db=>refs.approveHiggsfieldReference(db,admin,r.id,{clientId:randomUUID(),revision:r.revision,requestHash:r.requestHash,inspectionHash:r.inspection!.inspectionHash,expiresInMinutes:10,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true},options));};
  return {company,owner,project,serviceId,token,version,handler,request,call,scope,inspect,approve,proposal,descriptor,stats:()=>({reads,closes,allocations,confirmations}),lose:()=>{loseAllocation=true;}};
 }
 try{
  await t.test('service transactions acquire the company lifecycle lock before sponsor and work locks, including revoked cleanup',async()=>{
   const trace:string[][]=[],f=await fixture(trace);
   await f.call('readiness');const l=(await f.call('claim')).lease;await f.call('authorize',f.scope(l));
   const read=await f.request('read-proxy',f.scope(l));assert.equal(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);
   await query('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp(),revoked_by=enrolled_by WHERE id=$1',[f.serviceId]);
   await f.call('fail',{...f.scope(l),failure:{code:'REFERENCE_AUTHORITY_CHANGED',uncertain:false}});
   // PGlite serializes clients, so this proves actual SQL lock order rather than
   // claiming a concurrent PostgreSQL deadlock test. Company removal takes the
   // same company lock exclusively before changing any membership.
   assert(trace.length>=8);
   for(const statements of trace){
    const locks=statements.filter(sql=>/\bFOR (?:KEY SHARE|SHARE|UPDATE)\b/.test(sql));
    assert.equal(locks[0],'SELECT id FROM companies WHERE id=$1 FOR KEY SHARE');
   }
   assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[l.referenceId])).rows[0].status,'failed');
   assert.equal(f.stats().allocations,0);
  });
  await t.test('runner client and actual service API complete synthetic inspection and consented transfer, preserving uncertainty',async()=>{
   for(const lost of [false,true]){
    const f=await fixture(),scratch=await mkdtemp(join(tmpdir(),'coatria-reference-api-roundtrip-'));
    try{
     const ready=(await f.call('readiness')).readiness,client=createHiggsfieldReferenceServiceClient({origin:'https://coatria.com',serviceId:f.serviceId,companyId:f.company,projectIds:[f.project],token:f.token,expiresAt:ready.expiresAt,profileSha256:'c'.repeat(64),qualificationSha256:'b'.repeat(64)},{fetch:async(url,init)=>f.handler(new Request(String(url),init),f.serviceId,new URL(String(url)).pathname.split('/').at(-1)!)});
     let uploaded=0;
     // The worker/client/API/database are real. Inspector and provider I/O are
     // deliberately synthetic; this is not Linux or live provider qualification.
     const worker=createHiggsfieldReferenceWorker({companyId:f.company,projectIds:[f.project],scratchRoot:scratch,inspectionProfileSha256:'c'.repeat(64)},{...client,inspectMedia:async()=>f.descriptor as Extract<HiggsfieldMediaDescriptor,{kind:'image'}>,upload:async input=>{uploaded++;assert.deepEqual(input.body,bytes);assert.equal(input.sha256,sha256);assert(!JSON.stringify(input).includes(f.token));return {bytes:bytes.length,sha256,status:200};}});
     assert.equal((await worker.runNext()).status,'awaiting_approval');assert.deepEqual(f.stats(),{reads:1,closes:1,allocations:0,confirmations:0});assert.deepEqual(await readdir(scratch),[]);
     await f.approve();if(lost)f.lose();assert.equal((await worker.runNext()).status,lost?'uncertain':'confirmed');assert.deepEqual(f.stats(),{reads:2,closes:2,allocations:1,confirmations:lost?0:1});assert.equal(uploaded,lost?0:1);assert.deepEqual(await readdir(scratch),[]);
     assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[f.proposal.reference.id])).rows[0].status,lost?'uncertain':'confirmed');assert.equal((await worker.runNext()).status,'idle');assert.equal(f.stats().allocations,1);
    }finally{await rm(scratch,{recursive:true,force:true});}
   }
  });
  await t.test('exact scoped read, separate consent and once-only transfer',async()=>{
   const f=await fixture();assert.equal((await f.call('readiness')).readiness.qualificationSha256,'b'.repeat(64));
   const requestId=randomUUID(),claim=await f.call('claim',{requestId}),l=claim.lease;assert.equal((await f.call('claim',{requestId})).lease.leaseId,l.leaseId);await f.call('claim',{},409);
   await f.call('authorize',{...f.scope(l),referenceId:randomUUID()},403);await f.call('authorize',{...f.scope(l),projectId:randomUUID()},400);
   const read=await f.request('read-proxy',f.scope(l));assert.equal(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);assert.equal(read.headers.get('X-Coatria-Reference-Sha256'),sha256);await f.call('read-proxy',f.scope(l),409);assert.deepEqual(f.stats(),{reads:1,closes:1,allocations:0,confirmations:0});
   await f.call('inspection',{...f.scope(l),inspection:{descriptor:f.descriptor,profileSha256:'c'.repeat(64)}});assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[l.referenceId])).rows[0].status,'awaiting_approval');assert.equal((await f.call('claim')).lease,null);
   await f.approve();const transfer=(await f.call('claim')).lease;assert.equal(transfer.phase,'transfer');const a=randomUUID();await f.call('allocate',{...f.scope(transfer),requestId:a});await f.call('allocate',{...f.scope(transfer),requestId:a});assert.equal(f.stats().allocations,1);
   const cap=await f.call('upload-capability',f.scope(transfer));assert.match(cap.allocation.uploadUrl,/uploads\.example\.com/);
   const put=await f.call('begin-put',f.scope(transfer));await f.call('complete-put',{...f.scope(transfer),actionId:put.actionId,result:{phase:'put',bytes:bytes.length,sha256,httpStatus:200}});await f.call('confirm',f.scope(transfer));assert.equal(f.stats().confirmations,1);assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[l.referenceId])).rows[0].status,'confirmed');
   await assert.rejects(transaction(db=>db.query("UPDATE higgsfield_reference_service_calls SET response='{}' WHERE service_id=$1 AND request_id=$2",[f.serviceId,a])),/immutable/);
  });
  await t.test('authentication, scope, expiry and revocation stop access; cleanup remains bounded',async()=>{
   const f=await fixture();await f.call('readiness',{},401,{Authorization:'Bearer bad'});await f.call('readiness',{},403,{Cookie:'coatria_session=synthetic'});await f.call('readiness',{},403,{Origin:'https://coatria.com'});
   const l=(await f.call('claim')).lease,other=await fixture();await other.call('authorize',f.scope(l),403);
   await query('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp(),revoked_by=enrolled_by WHERE id=$1',[f.serviceId]);await f.call('authorize',f.scope(l),403);await f.call('read-proxy',f.scope(l),403);assert.equal(f.stats().reads,0);
   await f.call('fail',{...f.scope(l),failure:{code:'REFERENCE_AUTHORITY_CHANGED',uncertain:false}});assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[l.referenceId])).rows[0].status,'failed');
   await query("UPDATE higgsfield_reference_services SET created_at=clock_timestamp()-interval '30 minutes',expires_at=clock_timestamp()-interval '20 minutes' WHERE id=$1",[f.serviceId]);await f.call('fail',{...f.scope(l),failure:{code:'REFERENCE_AUTHORITY_CHANGED',uncertain:false}},403);
  });
  await t.test('provider uncertainty never repeats allocation after a lost reply',async()=>{
   const f=await fixture();await f.inspect();await f.approve();const l=(await f.call('claim')).lease,requestId=randomUUID();f.lose();await f.call('allocate',{...f.scope(l),requestId},500);await f.call('allocate',{...f.scope(l),requestId},409);await f.call('allocate',f.scope(l),409);assert.equal(f.stats().allocations,1);
   await f.call('fail',{...f.scope(l),failure:{code:'REFERENCE_PROVIDER_UNCERTAIN',uncertain:true}});assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[l.referenceId])).rows[0].status,'uncertain');assert.equal((await f.call('claim')).lease,null);
  });
  await t.test('changed storage, provider catalog or sponsor invalidates readiness',async()=>{
   for(const field of['storage','provider','sponsor']){const f=await fixture();if(field==='storage')await query('UPDATE project_storage_bindings SET revision=revision+1 WHERE project_id=$1',[f.project]);if(field==='provider')await query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[f.company]);if(field==='sponsor')await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner]);await f.call('readiness',{},403);assert.equal(f.stats().reads,0);}
  });
 }finally{await database().end();await socket.stop();await pg.close();(globalThis as any).coatriaPool=prior.pool;for(const[key,value]of Object.entries({DATABASE_URL:prior.url,DATABASE_POOL_MAX:prior.max,COATRIA_HOSTING_KEYRING:prior.key,COATRIA_REFERENCE_BROKER_DATABASE_URL:prior.broker}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
