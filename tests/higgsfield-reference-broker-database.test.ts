import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {createDatabaseHiggsfieldReferenceBroker} from '../src/lib/higgsfield-reference-broker-db';
import {referenceServiceAvailability} from '../src/lib/higgsfield-reference-service';
import type {HiggsfieldTool} from '../src/lib/higgsfield-mcp';
import * as refs from '../src/lib/higgsfield-references';

const tools:HiggsfieldTool[]=[
 {name:'media_upload',description:'Synthetic upload catalog',inputSchema:{type:'object',properties:{filename:{type:'string'},content_type:{type:'string'},method:{type:'string',enum:['upload_url']}},additionalProperties:false}},
 {name:'media_confirm',description:'Synthetic confirmation catalog',inputSchema:{type:'object',properties:{media_id:{type:'string'},type:{type:'string',enum:['image']}},required:['type'],additionalProperties:false}},
];
type Row=Record<string,any>;
test('database broker locks company first in each independent phase and preserves revoked-service cleanup (PGlite)',{timeout:120000},async t=>{
 const prior={pool:(globalThis as any).coatriaPool,url:process.env.DATABASE_URL,max:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,broker:process.env.COATRIA_REFERENCE_BROKER_DATABASE_URL,fetch:globalThis.fetch};
 const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),pg=await PGlite.create();
 let socket:InstanceType<typeof PGLiteSocketServer>|undefined,configured=false,outbound=0;
 try{
  for(const name of(await readdir('database')).filter(n=>/^\d.*\.sql$/.test(n)).sort())await pg.exec(await readFile('database/'+name,'utf8'));
  socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();
  delete(globalThis as any).coatriaPool;process.env.DATABASE_URL='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres';process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});process.env.COATRIA_REFERENCE_BROKER_DATABASE_URL='synthetic-readiness-only';configured=true;
  globalThis.fetch=async()=>{outbound++;throw Error('No provider or OAuth network calls are permitted');};
  const insert=async(table:string,row:Row)=>{const keys=Object.keys(row);await query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));};
  for(const outcome of ['confirmed','lost-response','revoked-after-intent'] as const)await t.test(outcome,async()=>{
   const company=randomUUID(),owner=randomUUID(),project=randomUUID(),task=randomUUID(),work=randomUUID(),provider=randomUUID(),service=randomUUID(),file=randomUUID(),version=randomUUID(),sha='a'.repeat(64),media=randomUUID();
   await insert('users',{id:owner,name:'Synthetic broker fixture',email:owner+'@example.invalid',password_hash:'not-a-login'});
   await insert('companies',{id:company,name:'Synthetic broker fixture',slug:company,template:'blank'});await insert('memberships',{company_id:company,user_id:owner,role:'owner'});
   await insert('studio_profiles',{company_id:company,template_id:'ai-production',template_version:1,created_by:owner});
   await insert('studio_projects',{id:project,company_id:company,name:'Prepared image',client_name:'Internal',brief:'Exact approved bytes',spec:JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}}),ai_policy:'allowed',status:'production',gates:JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:owner}]))),created_by:owner,production_path:'higgsfield',contract_version:2});
   await insert('tasks',{id:task,company_id:company,title:'Prepared image',description:'Exact synthetic source',created_by:owner,assignee_id:owner});
   await insert('studio_work_items',{id:work,company_id:company,project_id:project,logical_key:'reference',task_id:task,stage:'references',role_key:'comp',execution:'creative'});await insert('studio_role_bindings',{company_id:company,role_key:'comp',human_id:owner});
   await insert('higgsfield_connections',{company_id:company,id:provider,revision:1,status:'connected',connected_by:owner,sealed:JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-control-plane-only'}},{companyId:company,id:provider,purpose:'oauth-connection'})),expires_at:new Date(Date.now()+3600000),tools:JSON.stringify(tools)});
   const actor={companyId:company,userId:owner},connection=(await transaction(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic storage',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_synthetic'}))).connection;
   const binding=(await transaction(db=>bindProjectStorage(db,actor,project,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
   await insert('project_storage_files',{id:file,company_id:company,project_id:project,binding_id:binding.id,name:'prepared.png',name_key:'prepared.png',created_by:owner});
   await insert('project_storage_versions',{id:version,company_id:company,project_id:project,file_id:file,version:1,bytes:100,sha256:sha,content_type:'image/png',object_key:`coatria/companies/${company}/projects/${project}/objects/${version}`,created_by:owner});
   await insert('project_storage_verifications',{company_id:company,project_id:project,version_id:version,bytes:100,sha256:sha,provider_etag:'"synthetic-etag"',gateway_receipt_id:randomUUID()});
   // Fixture enrollment is not production host qualification or activation.
   await insert('higgsfield_reference_services',{id:service,company_id:company,token_hash:hashToken('synthetic-'+service),enrolled_by:owner,release_sha256:'b'.repeat(64),qualification_sha256:'c'.repeat(64),profile_sha256:'d'.repeat(64),provider_connection_id:provider,provider_connection_revision:1,catalog_sha256:refs.higgsfieldReferenceDigest(tools),upload_hosts:JSON.stringify(['uploads.example.com']),expires_at:new Date(Date.now()+600000)});
   await insert('higgsfield_reference_service_projects',{service_id:service,company_id:company,project_id:project,storage_binding_id:binding.id,storage_binding_revision:binding.revision,storage_connection_id:connection.id,storage_connection_revision:connection.revision});
   const options:refs.HiggsfieldReferenceOptions={availability:(db,c,p)=>referenceServiceAvailability(db,c,p,{brokerReady:async()=>true})};
   await transaction(db=>refs.proposeHiggsfieldReference(db,actor,{clientId:randomUUID(),projectId:project,projectRevision:1,workItemId:work,proxyVersionId:version,proxyBytes:100,proxySha256:sha,role:'image',purpose:'Synthetic broker transaction test'}));
   const inspect=(await transaction(db=>refs.claimHiggsfieldReference(db,{companyId:company,projectIds:[project]},options)))!;
   const reviewed=(await transaction(db=>refs.recordHiggsfieldReferenceInspection(db,inspect,{profileSha256:'d'.repeat(64),descriptor:{kind:'image',format:'png',contentType:'image/png',bytes:100,sha256:sha,verification:'full_decode',inspectionVersion:1,width:16,height:16,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}}},options))).reference;
   await transaction(db=>refs.approveHiggsfieldReference(db,actor,reviewed.id,{clientId:randomUUID(),revision:reviewed.revision,requestHash:reviewed.requestHash,inspectionHash:reviewed.inspection!.inspectionHash,expiresInMinutes:5,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true},options));
   const lease=(await transaction(db=>refs.claimHiggsfieldReference(db,{companyId:company,projectIds:[project]},options)))!;
   const traces:{sql:string;values:unknown[]}[][]=[];let calls=0;
   const broker=createDatabaseHiggsfieldReferenceBroker(options,{transaction:run=>transaction(db=>{
    const trace:{sql:string;values:unknown[]}[]=[];traces.push(trace);
    return run(new Proxy(db,{get(target,key,receiver){if(key!=='query')return Reflect.get(target,key,receiver);return (...args:any[])=>{trace.push({sql:String(args[0]),values:args[1]??[]});return Reflect.apply(target.query,target,args);};}}));
   }),call:async(token,name)=>{
    calls++;assert.equal(token,'synthetic-control-plane-only');
    const intent=(await query('SELECT status,action_operation FROM higgsfield_references WHERE id=$1',[reviewed.id])).rows[0];assert.equal(intent.action_operation,name==='media_upload'?'allocate':'confirm');
    if(outcome==='lost-response')throw Error('Synthetic provider response lost after durable intent');
    if(outcome==='revoked-after-intent')await query('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp(),revoked_by=enrolled_by WHERE id=$1',[service]);
    return {content:[],structuredContent:name==='media_upload'?{uploads:[{media_id:media,content_type:'image/png',method:'PUT',expires_in_seconds:60,upload_url:'https://uploads.example.com/private?signature=synthetic'}]}:{results:[{media_id:media,status:'confirmed',type:'image'}]}};
   }});
   const signal=new AbortController().signal;
   if(outcome==='confirmed'){
    await broker.allocate(lease,signal);assert.equal((await broker.uploadCapability(lease,signal)).mediaId,media);
    const intent=await transaction(db=>refs.beginHiggsfieldReferencePhase(db,lease,'put',options));await transaction(db=>refs.completeHiggsfieldReferencePhase(db,lease,intent.actionId,{phase:'put',bytes:100,sha256:sha,httpStatus:200},options));
    await broker.confirm(lease,signal);assert.equal(calls,2);
   }else{
    await assert.rejects(()=>broker.allocate(lease,signal),{code:'HIGGSFIELD_REFERENCE_OUTCOME_UNCERTAIN'});
    await assert.rejects(()=>broker.allocate(lease,signal));assert.equal(calls,1);
    const cleanup=traces.find(trace=>
     trace.some(q=>q.sql.startsWith('UPDATE higgsfield_references SET status=$3')&&q.values[2]==='uncertain')&&
     trace.some(q=>q.sql.startsWith('INSERT INTO higgsfield_reference_receipts')&&q.values[5]==='uncertain'));
    assert(cleanup,'Failure cleanup must commit through the actual broker factory');
   }
   assert.equal((await query('SELECT status FROM higgsfield_references WHERE id=$1',[reviewed.id])).rows[0].status,outcome==='confirmed'?'confirmed':'uncertain');
   // Actual SQL ordering is checked, not a claimed concurrent-PG deadlock test.
   assert(traces.length>=6);for(const trace of traces){assert.deepEqual(trace[0],{sql:'SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',values:[company]});}
  });
  assert.equal(outbound,0);
 }finally{
  globalThis.fetch=prior.fetch;if(configured)await database().end();await socket?.stop();await pg.close();(globalThis as any).coatriaPool=prior.pool;
  for(const[key,value]of Object.entries({DATABASE_URL:prior.url,DATABASE_POOL_MAX:prior.max,COATRIA_HOSTING_KEYRING:prior.key,COATRIA_REFERENCE_BROKER_DATABASE_URL:prior.broker}))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
