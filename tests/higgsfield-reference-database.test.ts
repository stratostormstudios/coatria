import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {HIGGSFIELD_REFERENCE_BROKER_ROLE as ROLE,REFERENCE_BROKER_CONTRACT,REFERENCE_BROKER_STATE_GUARDS,assertHiggsfieldReferenceDatabase} from '../src/lib/higgsfield-reference-database.mjs';
import {createHiggsfieldReferenceTransaction} from '../src/lib/higgsfield-reference-transaction';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {hashToken} from '../src/lib/security';
import {createHiggsfieldReferenceService} from '../src/lib/higgsfield-reference-service';
import * as refs from '../src/lib/higgsfield-references';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=(()=>{try{return !!integration&&['127.0.0.1','localhost'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();

test('reference broker provisioning takes secrets only in validated memory input',async()=>{
 const {parseReferenceBrokerProvisionInput}=await import('../scripts/provision-reference-broker-role.mjs');
 const url=new URL('postgresql://127.0.0.1:5432/fixture');url.username='owner';url.password='synthetic';
 const input={connectionString:url.href,password:'f'.repeat(40)};
 const parsed=parseReferenceBrokerProvisionInput(input);
 assert.equal(parsed.clientConfig.application_name,'coatria-reference-broker-role-provisioner');assert.equal(parsed.clientConfig.ssl,false);
 const remote=new URL(url);remote.hostname='attacker.invalid';
 for(const value of[{...input,unexpected:true},{...input,password:'short'},{...input,connectionString:remote.href},{...input,connectionString:input.connectionString+'?options=unsafe'}]){
  assert.throws(()=>parseReferenceBrokerProvisionInput(value),e=>{assert(!String(e).includes('owner:synthetic'));return true;});
 }
});
test('reference broker grants deny human authority and OAuth, and bind the exact SQL allowlist',async()=>{
 const sql=await readFile('database/reference-broker-permissions.sql','utf8');
 for(const[table,spec]of Object.entries(REFERENCE_BROKER_CONTRACT))for(const[priv,cols]of Object.entries(spec)){
  assert(sql.includes('GRANT '+priv+(Array.isArray(cols)?'('+cols.join(',')+')':'')+' ON '+table+' TO '+ROLE+';'));
 }
 const mutable=REFERENCE_BROKER_CONTRACT.higgsfield_references.UPDATE;
 for(const column of['project_id','request_hash','inspection_authority','inspect_expires_at','approved_by','approval_hash','expires_at','revoked_by','revoked_at'])assert(!mutable.includes(column));
 assert.deepEqual(REFERENCE_BROKER_CONTRACT.higgsfield_connections.UPDATE,['updated_at']);
 assert(!REFERENCE_BROKER_CONTRACT.higgsfield_connections.SELECT.includes('sealed'));
 assert(!Object.values(REFERENCE_BROKER_CONTRACT).some(c=>'DELETE'in c));
});
test('explicit broker transactions release one independent client and never retry a failed intent',async()=>{
 const statements:string[]=[];const original=Error('synthetic action failed');let releases=0,calls=0;
 const client={query:async(sql:string)=>{statements.push(sql);},release:()=>{releases++;}};
 const tx=createHiggsfieldReferenceTransaction({connect:async()=>client} as unknown as Pick<Pool,'connect'>);
 await assert.rejects(()=>tx(async()=>{calls++;throw original;}),e=>e===original);
 assert.deepEqual(statements,['BEGIN','ROLLBACK']);assert.equal(calls,1);assert.equal(releases,1);
 statements.length=0;assert.equal(await tx(async()=>42),42);assert.deepEqual(statements,['BEGIN','COMMIT']);assert.equal(releases,2);
});
test('broker startup pins the exact reviewed migration guard bodies and function identities',async()=>{
 const sql=(await readFile('database/043_higgsfield_reference_services.sql','utf8')).replaceAll('\r\n','\n');
 assert.equal(REFERENCE_BROKER_STATE_GUARDS.length,3);
 for(const guard of REFERENCE_BROKER_STATE_GUARDS){
  assert(sql.includes('CREATE FUNCTION '+guard.function+'() RETURNS trigger LANGUAGE plpgsql AS $$\n'+guard.body+' $$;'));
  assert(sql.includes('CREATE TRIGGER '+guard.trigger+' BEFORE UPDATE ON '+guard.table+'\n FOR EACH ROW EXECUTE FUNCTION '+guard.function+'();'));
  assert.equal(guard.config,null);
 }
});

// This suite creates an isolated database and genuine authenticated LOGINs.
// It never impersonates an owner with SET ROLE for positive execution and never
// substitutes PGlite. All provider/media results are synthetic local evidence.
test('PostgreSQL independent reference broker LOGIN fences authority and executes durable phases',{skip:!local,timeout:180000},async t=>{
 const {provisionReferenceBrokerRole}=await import('../scripts/provision-reference-broker-role.mjs');
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_ref_broker_'+suffix;
 const control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000});
 const ownerUrl=new URL(integration!);ownerUrl.pathname='/'+dbName;
 let owner:Pool|undefined,broker:Pool|undefined,app:Pool|undefined,controlClient:PoolClient|undefined,created=false,roleAbsent=false;
 const appRole='coatria_runtime_v1',appPassword=randomBytes(32).toString('hex');
 const auxiliary:string[]=[],priorKey=process.env.COATRIA_HOSTING_KEYRING,priorFetch=globalThis.fetch;let outbound=0;
 globalThis.fetch=async()=>{outbound++;throw Error('No live provider calls are permitted');};
 process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});
 const identity=async(db:Pool|PoolClient,role=ROLE)=>{const r=(await db.query('SELECT current_user,session_user')).rows[0];assert.equal(r.current_user,role);assert.equal(r.session_user,role);};
 const denied=async(sql:string,values:unknown[]=[])=>{const c=await broker!.connect();try{await identity(c);await assert.rejects(c.query(sql,values),{code:'42501'});}finally{c.release();}};
 try{
  controlClient=await control.connect();await controlClient.query('SELECT pg_advisory_lock(739284011)');
  assert.equal((await controlClient.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount,0,'Dedicated fixture role must not preexist');roleAbsent=true;
  await controlClient.query('CREATE DATABASE '+dbName);created=true;
  owner=new Pool({connectionString:ownerUrl.href,max:3,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of(await readdir('database')).filter(n=>/^\d.*\.sql$/.test(n)).sort()){await owner.query(await readFile('database/'+name,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
  // Existing principal grants must survive broker provisioning unchanged.
  for(const[kind,file]of [['runtime','runtime-permissions.sql'],['archive','higgsfield-archive-worker-permissions.sql'],['gateway','storage-gateway-permissions.sql']]){
   const role=kind==='runtime'?appRole:'coatria_ref_'+kind+'_'+suffix;
   assert.equal((await controlClient.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0,'Fixture role must not preexist');
   await controlClient.query('CREATE ROLE '+role+(kind==='runtime'?" LOGIN PASSWORD '"+appPassword+"'":' NOLOGIN')+' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');auxiliary.push(role);
   const original={runtime:'coatria_runtime_v1',archive:'coatria_higgsfield_archive_worker_v1',gateway:'coatria_storage_gateway_v1'}[kind]!;
   await owner.query((await readFile('database/'+file,'utf8')).replaceAll(original,role));
  }
  const appUrl=new URL(ownerUrl);appUrl.username=appRole;appUrl.password=appPassword;
  app=new Pool({connectionString:appUrl.href,max:1,connectionTimeoutMillis:10000});await identity(app,appRole);
  const grantsSnapshot=async()=>(await owner!.query(`SELECT n.nspname,c.relname,a.attname,r.name,p.priv,
   has_column_privilege(r.name,c.oid,a.attnum,p.priv) AS allowed
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   CROSS JOIN unnest($1::text[]) r(name) CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(priv)
   WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname,a.attname,r.name,p.priv`,[auxiliary])).rows;
  const before=await grantsSnapshot(),password=randomBytes(32).toString('hex');
  const provisioned=await provisionReferenceBrokerRole({connectionString:ownerUrl.href,password});
  assert(provisioned?.verification);
  assert.equal(provisioned.verification.independentLogin,true);
  assert.deepEqual(await grantsSnapshot(),before);
  const brokerUrl=new URL(ownerUrl);brokerUrl.username=ROLE;brokerUrl.password=password;
  broker=new Pool({connectionString:brokerUrl.href,max:2,connectionTimeoutMillis:10000});
  const tx=createHiggsfieldReferenceTransaction(broker),ownerTx=createHiggsfieldReferenceTransaction(owner);
  await t.test('startup requires independent LOGIN, exact privileges and enabled immutable lock guards',async()=>{
   await identity(broker!);assert.equal((await assertHiggsfieldReferenceDatabase(broker!))?.status,'passed');
   await assert.rejects(()=>assertHiggsfieldReferenceDatabase(owner!),{code:'REFERENCE_DB_IDENTITY'});
   const impersonation=await owner!.connect();try{await impersonation.query('SET ROLE '+ROLE);await assert.rejects(()=>assertHiggsfieldReferenceDatabase(impersonation),{code:'REFERENCE_DB_IDENTITY'});}finally{await impersonation.query('RESET ROLE');impersonation.release();}
   const grants=await readFile('database/reference-broker-permissions.sql','utf8');
   for(const sql of['GRANT UPDATE(approved_by) ON higgsfield_references TO '+ROLE,'GRANT SELECT(sealed) ON higgsfield_connections TO '+ROLE,'GRANT SELECT ON schema_migrations TO '+ROLE+' WITH GRANT OPTION']){
    await owner!.query(sql);try{await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_PRIVILEGES'});}finally{await owner!.query(grants);}
   }
   await owner!.query('ALTER TABLE studio_projects DISABLE TRIGGER coatria_reference_broker_lock_guard');
   try{await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_LOCK_GUARD'});}finally{await owner!.query(grants);}
   await owner!.query('ALTER TABLE higgsfield_references DISABLE TRIGGER higgsfield_reference_broker_attempts');
   try{await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_STATE_GUARD'});}finally{await owner!.query('ALTER TABLE higgsfield_references ENABLE TRIGGER higgsfield_reference_broker_attempts');}
   for(const guard of REFERENCE_BROKER_STATE_GUARDS){
    const original=(await owner!.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',['public.'+guard.function+'()'])).rows[0].definition;
    try{
     await owner!.query('CREATE OR REPLACE FUNCTION public.'+guard.function+"() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'");
     await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_STATE_GUARD'});
    }finally{await owner!.query(original);}
    try{
     await owner!.query('ALTER FUNCTION public.'+guard.function+'() SET search_path=public,pg_catalog');
     await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_STATE_GUARD'});
    }finally{await owner!.query('ALTER FUNCTION public.'+guard.function+'() RESET ALL');}
   }
   assert.equal((await assertHiggsfieldReferenceDatabase(broker!)).status,'passed');
   const triggerSql=(await owner!.query("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='public.higgsfield_references'::regclass AND tgname='higgsfield_reference_broker_attempts'")).rows[0].definition;
   try{
    await owner!.query('DROP TRIGGER higgsfield_reference_broker_attempts ON higgsfield_references');
    await owner!.query('CREATE TRIGGER higgsfield_reference_broker_attempts BEFORE UPDATE ON higgsfield_references FOR EACH ROW WHEN (false) EXECUTE FUNCTION guard_higgsfield_reference_broker_attempts()');
    await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_STATE_GUARD'});
   }finally{await owner!.query('DROP TRIGGER higgsfield_reference_broker_attempts ON higgsfield_references');await owner!.query(triggerSql);}
   await controlClient!.query('GRANT '+auxiliary[0]+' TO '+ROLE);
   try{await assert.rejects(()=>assertHiggsfieldReferenceDatabase(broker!),{code:'REFERENCE_DB_ROLE'});}finally{await controlClient!.query('REVOKE '+auxiliary[0]+' FROM '+ROLE);}
   await assert.rejects(()=>provisionReferenceBrokerRole({connectionString:ownerUrl.href,password:randomBytes(32).toString('hex')}),{code:'ROLE_EXISTS'});await identity(broker!);
  });
  const companyId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),taskId=randomUUID(),workId=randomUUID(),providerId=randomUUID(),versionId=randomUUID(),fileId=randomUUID(),actor={companyId,userId},sha='b'.repeat(64);
  await owner.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Reference broker fixture',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  await owner.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Reference broker fixture',$2,'blank')",[companyId,companyId]);
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);
  await owner.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
  await owner.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Reference fixture','Internal','Exact approved bytes',$3,'allowed','production',$4,$5,'higgsfield')",[projectId,companyId,JSON.stringify({width:16,height:16,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'sRGB'}),JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:userId}]))),userId]);
  await owner.query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Reference task',$3)",[taskId,companyId,userId]);
  await owner.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'reference',$4,'references','comp','agent')",[workId,companyId,projectId,taskId]);
  await owner.query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[companyId,userId]);
  await owner.query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,tools,expires_at) VALUES($1,$2,'connected',$3,$4,'[]',clock_timestamp()+interval '1 hour')",[companyId,providerId,userId,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId,id:providerId,purpose:'oauth-connection'}))]);
  const connection=(await ownerTx(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Exact private source',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_fixture-only'}))).connection;
  const binding=(await ownerTx(db=>bindProjectStorage(db,actor,projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  await ownerTx(async db=>{
   await db.query("INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,'proxy.png','proxy.png',$5)",[fileId,companyId,projectId,binding.id,userId]);
   await db.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,100,$5,'image/png',$6,$7)",[versionId,companyId,projectId,fileId,sha,'coatria/companies/'+companyId+'/projects/'+projectId+'/objects/'+versionId,userId]);
   await db.query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,100,$4,'fixture-etag',$5)",[companyId,projectId,versionId,sha,randomUUID()]);
  });
  const proposal=()=>ownerTx(db=>refs.proposeHiggsfieldReference(db,actor,{clientId:randomUUID(),projectId,projectRevision:1,workItemId:workId,proxyVersionId:versionId,proxyBytes:100,proxySha256:sha,role:'image',purpose:'Exact restricted broker fixture'}));
  const proposed=(await proposal()).reference;
  const options:refs.HiggsfieldReferenceOptions={availability:async()=>({enabled:true,code:'FIXTURE_ONLY',message:'Synthetic readiness',expiresAt:new Date(Date.now()+600000).toISOString(),qualificationSha256:'a'.repeat(64),catalogSha256:refs.higgsfieldReferenceDigest([])})};
  const claim=()=>tx(db=>refs.claimHiggsfieldReference(db,{companyId,projectIds:[projectId]},options));
  await t.test('restricted LOGIN locks authority but cannot change timestamps, approvals, source or work',async()=>{
   await tx(async db=>{await identity(db);await db.query('SELECT id FROM studio_projects WHERE id=$1 FOR UPDATE',[projectId]);await db.query('SELECT user_id FROM memberships WHERE company_id=$1 FOR SHARE',[companyId]);await db.query('SELECT id FROM project_storage_bindings WHERE id=$1 FOR SHARE',[binding.id]);});
   for(const sql of["UPDATE studio_projects SET updated_at=updated_at+interval '1 second' WHERE id=$1","UPDATE tasks SET updated_at=updated_at+interval '1 second' WHERE id=$1"])await denied(sql,[sql.includes('tasks')?taskId:projectId]);
   await denied("UPDATE project_storage_bindings SET created_at=created_at+interval '1 second' WHERE id=$1",[binding.id]);
   for(const column of['request_hash','inspection_authority','inspect_expires_at','approved_by','approval_hash','expires_at','proxy_snapshot','project_snapshot'])await denied('UPDATE higgsfield_references SET '+column+'='+column+' WHERE id=$1',[proposed.id]);
   await denied('UPDATE studio_projects SET brief=brief WHERE id=$1',[projectId]);await denied('UPDATE tasks SET status=status WHERE id=$1',[taskId]);await denied('UPDATE memberships SET role=role WHERE company_id=$1',[companyId]);
   await denied('INSERT INTO studio_reference_preparation_dispatches(company_id,project_id,work_item_id,run_id) VALUES($1,$2,$3,$4)',[companyId,projectId,workId,randomUUID()]);
   await denied('SELECT sealed FROM higgsfield_connections');await denied('SELECT password_hash FROM users');await denied('SELECT * FROM sessions');
   await denied('CREATE TABLE public.reference_escape(id int)');await denied('CREATE ROLE reference_escape');await denied('ALTER TABLE higgsfield_references DISABLE TRIGGER ALL');
   await denied('SET ROLE '+auxiliary[0]);
  });
  await t.test('independent LOGIN commits inspection and all once-only reference phases',async()=>{
   const inspect=await claim();assert(inspect);assert.equal(inspect.phase,'inspect');
   const result=await tx(db=>refs.recordHiggsfieldReferenceInspection(db,inspect,{profileSha256:'a'.repeat(64),descriptor:{kind:'image',format:'png',contentType:'image/png',bytes:100,sha256:sha,verification:'full_decode',inspectionVersion:1,width:16,height:16,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}}},options));
   const r=result.reference;
   await assert.rejects(()=>tx(db=>refs.approveHiggsfieldReference(db,actor,r.id,{clientId:randomUUID(),revision:r.revision,requestHash:r.requestHash,inspectionHash:r.inspection!.inspectionHash,expiresInMinutes:10,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true},options)),{code:'42501'});
   await ownerTx(db=>refs.approveHiggsfieldReference(db,actor,r.id,{clientId:randomUUID(),revision:r.revision,requestHash:r.requestHash,inspectionHash:r.inspection!.inspectionHash,expiresInMinutes:10,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true},options));
   const lease=await claim();assert(lease);assert.equal(lease.phase,'transfer');const mediaId=randomUUID();
   for(const phase of ['allocate','put','confirm'] as const){
    const intent=await tx(db=>refs.beginHiggsfieldReferencePhase(db,lease,phase,options));
    const value=phase==='allocate'?{phase,allocation:{mediaId,uploadUrl:'https://uploads.example.invalid/private?token=fixture',expiresAt:new Date(Date.now()+60000).toISOString()}}:phase==='put'?{phase,bytes:100,sha256:sha,httpStatus:200 as const}:{phase,mediaId,confirmed:true as const};
    await tx(db=>refs.completeHiggsfieldReferencePhase(db,lease,intent.actionId,value,options));
    await assert.rejects(()=>tx(db=>refs.beginHiggsfieldReferencePhase(db,lease,phase,options)));
   }
   assert.equal((await owner!.query('SELECT status FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].status,'confirmed');
   assert.equal((await broker!.query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE reference_id=$1 AND phase='intent'",[r.id])).rows[0].n,3);
   for(const table of['higgsfield_reference_inspections','higgsfield_reference_receipts','higgsfield_reference_transports','higgsfield_reference_confirmations']){await denied('DELETE FROM '+table+' WHERE reference_id=$1',[r.id]);await denied('UPDATE '+table+' SET reference_id=reference_id WHERE reference_id=$1',[r.id]);}
  });
  await t.test('expired external intent is uncertain and cannot obtain a second allocation',async()=>{
   const r=(await proposal()).reference;await owner!.query("UPDATE higgsfield_references SET status='allocating',lease_id=$2,lease_expires_at=clock_timestamp()-interval '1 second',action_id=$3,action_operation='allocate' WHERE id=$1",[r.id,randomUUID(),randomUUID()]);
   await owner!.query("INSERT INTO higgsfield_reference_receipts(company_id,project_id,reference_id,action_id,operation,phase) VALUES($1,$2,$3,$4,'allocate','intent')",[companyId,projectId,r.id,randomUUID()]);
   assert.equal(await claim(),null);assert.equal((await owner!.query('SELECT status FROM higgsfield_references WHERE id=$1',[r.id])).rows[0].status,'uncertain');assert.equal(await claim(),null);
  });
  await t.test('actual service API readiness, claim, authorization and inspection use the independent broker LOGIN',async()=>{
   const r=(await proposal()).reference,serviceId=randomUUID(),token='rfs_'+randomBytes(32).toString('base64url'),profile='a'.repeat(64);
   const provider=(await owner!.query('SELECT id,revision,tools FROM higgsfield_connections WHERE company_id=$1',[companyId])).rows[0];
   const storage=(await owner!.query('SELECT b.id,b.revision,b.connection_id,c.revision AS connection_revision FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE b.company_id=$1 AND b.project_id=$2',[companyId,projectId])).rows[0];
   // Owner setup enrolls only this synthetic finite service. Every handler
   // transaction below authenticates as the separate restricted LOGIN.
   await owner!.query("INSERT INTO higgsfield_reference_services(id,company_id,token_hash,enrolled_by,release_sha256,qualification_sha256,profile_sha256,provider_connection_id,provider_connection_revision,catalog_sha256,upload_hosts,expires_at) VALUES($1,$2,$3,$4,$5,$5,$5,$6,$7,$8,'[\"uploads.example.invalid\"]',clock_timestamp()+interval '10 minutes')",[serviceId,companyId,hashToken(token),userId,profile,provider.id,provider.revision,refs.higgsfieldReferenceDigest(provider.tools)]);
   await owner!.query('INSERT INTO higgsfield_reference_service_projects(service_id,company_id,project_id,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision) VALUES($1,$2,$3,$4,$5,$6,$7)',[serviceId,companyId,projectId,storage.id,storage.revision,storage.connection_id,storage.connection_revision]);
   let transactions=0,providerFactories=0;
   const handler=createHiggsfieldReferenceService({transaction:run=>tx(async db=>{await identity(db);transactions++;return run(db);}),providerFactory:()=>{providerFactories++;throw Error('Synthetic inspection must not open storage');},brokerFactory:()=>{providerFactories++;throw Error('Unapproved inspection must not open a provider broker');}});
   const call=async(operation:string,payload:Record<string,unknown>={},expected=200)=>{
    const response=await handler(new Request('https://coatria.com/api/internal/reference-services/'+serviceId+'/'+operation,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),...payload})}),serviceId,operation);
    const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));assert(!JSON.stringify(result).includes(token));return result;
   };
   const readiness=(await call('readiness')).readiness;assert.equal(readiness.enabled,true);assert.equal(readiness.profileSha256,profile);
   const requestId=randomUUID(),lease=(await call('claim',{requestId})).lease;
   assert.equal(lease.referenceId,r.id);assert.equal(lease.phase,'inspect');assert.equal((await call('claim',{requestId})).lease.leaseId,lease.leaseId);
   const scope={referenceId:lease.referenceId,leaseId:lease.leaseId,requestHash:lease.requestHash};
   assert.equal((await call('authorize',scope)).authorized,true);await call('authorize',{...scope,referenceId:randomUUID()},403);
   // This descriptor is explicit synthetic inspector evidence, not a real
   // decoder or host qualification. No storage/provider network is invoked.
   await call('inspection',{...scope,inspection:{profileSha256:profile,descriptor:{kind:'image',format:'png',contentType:'image/png',bytes:100,sha256:sha,verification:'full_decode',inspectionVersion:1,width:16,height:16,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}}}});
   const final=(await broker!.query('SELECT status,approved_by FROM higgsfield_references WHERE id=$1',[r.id])).rows[0];assert.equal(final.status,'awaiting_approval');assert.equal(final.approved_by,null);
   assert.equal((await broker!.query('SELECT count(*)::int n FROM higgsfield_reference_inspections WHERE reference_id=$1',[r.id])).rows[0].n,1);
   assert.equal((await broker!.query('SELECT count(*)::int n FROM higgsfield_reference_service_leases WHERE service_id=$1',[serviceId])).rows[0].n,1);
   const calls=(await broker!.query('SELECT operation,status FROM higgsfield_reference_service_calls WHERE service_id=$1 ORDER BY operation',[serviceId])).rows;
   assert.deepEqual(calls,[{operation:'claim',status:'completed'},{operation:'inspection',status:'completed'}]);assert(transactions>=10);assert.equal(providerFactories,0);assert.equal(outbound,0);
  });
  await t.test('service registry is immutable and lease/read/call evidence is append-only',async()=>{
   const serviceId=randomUUID(),leaseId=randomUUID(),requestId=randomUUID();
   await owner!.query("INSERT INTO higgsfield_reference_services(id,company_id,token_hash,enrolled_by,release_sha256,qualification_sha256,profile_sha256,provider_connection_id,provider_connection_revision,catalog_sha256,upload_hosts,expires_at) VALUES($1,$2,$3,$4,$3,$3,$3,$5,1,$3,'[\"uploads.example.invalid\"]',clock_timestamp()+interval '10 minutes')",[serviceId,companyId,'e'.repeat(64),userId,providerId]);
   await owner!.query('INSERT INTO higgsfield_reference_service_projects(service_id,company_id,project_id,storage_binding_id,storage_binding_revision,storage_connection_id,storage_connection_revision) VALUES($1,$2,$3,$4,1,$5,1)',[serviceId,companyId,projectId,binding.id,connection.id]);
   await tx(db=>db.query('SELECT id FROM higgsfield_reference_services WHERE id=$1 FOR SHARE',[serviceId]));
   await denied("UPDATE higgsfield_reference_services SET updated_at=updated_at+interval '1 second' WHERE id=$1",[serviceId]);
   await denied('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp() WHERE id=$1',[serviceId]);
   await denied('INSERT INTO higgsfield_reference_services(id) VALUES($1)',[randomUUID()]);
   await broker!.query("INSERT INTO higgsfield_reference_service_leases(service_id,company_id,project_id,reference_id,lease_id,request_hash,lease) VALUES($1,$2,$3,$4,$5,$6,'{}')",[serviceId,companyId,projectId,proposed.id,leaseId,proposed.requestHash]);
   await broker!.query("INSERT INTO higgsfield_reference_service_calls(service_id,request_id,operation,request_hash,status) VALUES($1,$2,'read-proxy',$3,'started')",[serviceId,requestId,'f'.repeat(64)]);
   await broker!.query('INSERT INTO higgsfield_reference_service_reads(service_id,lease_id,request_id) VALUES($1,$2,$3)',[serviceId,leaseId,requestId]);
   await assert.rejects(()=>broker!.query('INSERT INTO higgsfield_reference_service_reads(service_id,lease_id,request_id) VALUES($1,$2,$3)',[serviceId,leaseId,requestId]),{code:'23505'});
   await broker!.query("UPDATE higgsfield_reference_service_calls SET status='completed',response='{}',finished_at=clock_timestamp() WHERE service_id=$1 AND request_id=$2",[serviceId,requestId]);
   await denied("UPDATE higgsfield_reference_service_calls SET response='{\"changed\":true}' WHERE service_id=$1 AND request_id=$2",[serviceId,requestId]);
   for(const table of['higgsfield_reference_service_projects','higgsfield_reference_service_leases','higgsfield_reference_service_reads']){await denied('DELETE FROM '+table+' WHERE service_id=$1',[serviceId]);await denied('UPDATE '+table+' SET service_id=service_id WHERE service_id=$1',[serviceId]);}
   // Real ordinary application LOGIN: only the exact one-way stop transition
   // is available. Enrollment, extension and reactivation stay operator-owned.
   const application=await app!.connect();try{
    await identity(application,appRole);
    await assert.rejects(application.query('INSERT INTO higgsfield_reference_services(id) VALUES($1)',[randomUUID()]),{code:'42501'});
    await assert.rejects(application.query("UPDATE higgsfield_reference_services SET expires_at=expires_at+interval '1 minute' WHERE id=$1",[serviceId]),{code:'42501'});
    await assert.rejects(application.query("UPDATE higgsfield_reference_services SET token_hash=repeat('a',64) WHERE id=$1",[serviceId]),{code:'42501'});
    await assert.rejects(application.query('UPDATE higgsfield_reference_services SET revision=revision+1 WHERE id=$1',[serviceId]),{code:'42501'});
    const stopped=(await application.query('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp(),revoked_by=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=1 AND revoked_at IS NULL RETURNING revision,revoked_at,revoked_by',[serviceId,userId])).rows[0];
    assert.equal(stopped.revision,2);assert(stopped.revoked_at);assert.equal(stopped.revoked_by,userId);
    await assert.rejects(application.query('UPDATE higgsfield_reference_services SET revoked_at=NULL,revoked_by=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[serviceId]),{code:'42501'});
    await identity(application,appRole);
   }finally{application.release();}
  });
  await t.test('attempt guard rejects reset, jump, expired deadline and claims beyond three',async()=>{
   const r=(await proposal()).reference,agentId=randomUUID(),runId=randomUUID();
   await owner!.query("INSERT INTO agents(id,company_id,name,harness,created_by,token_hash) VALUES($1,$2,'Bounded fixture','custom',$3,$4)",[agentId,companyId,userId,'d'.repeat(64)]);
   const conversation=(await owner!.query('INSERT INTO conversations(company_id) VALUES($1) RETURNING id',[companyId])).rows[0].id;
   assert(conversation);
   await owner!.query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic authority boundary')",[runId,companyId,agentId,userId,conversation,randomUUID(),'c'.repeat(64)]);
   await owner!.query("UPDATE higgsfield_references SET proposed_agent_id=$2,proposed_run_id=$3,inspection_authority=$4,inspection_authority_sha256=$5 WHERE id=$1",[r.id,agentId,runId,JSON.stringify({version:1,mode:'prepared_image_v1'}),'c'.repeat(64)]);
   const attemptSql="UPDATE higgsfield_references SET inspection_attempts=$2,status='inspecting',lease_id=$3,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1";
   await denied("UPDATE higgsfield_references SET status='inspecting',lease_id=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",[r.id,randomUUID()]);
   await denied(attemptSql,[r.id,0,randomUUID()]);
   await denied(attemptSql,[r.id,2,randomUUID()]);
   for(let n=1;n<=3;n++){await broker!.query(attemptSql,[r.id,n,randomUUID()]);await denied(attemptSql,[r.id,0,randomUUID()]);await owner!.query("UPDATE higgsfield_references SET lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[r.id]);}
   await denied(attemptSql,[r.id,4,randomUUID()]);
   await denied(attemptSql,[r.id,3,randomUUID()]);
   await owner!.query("UPDATE higgsfield_references SET inspection_attempts=0,inspect_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[r.id]);
   await denied(attemptSql,[r.id,1,randomUUID()]);
  });
  assert.equal(outbound,0);
 }finally{
  globalThis.fetch=priorFetch;if(priorKey===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=priorKey;
  await broker?.end();await app?.end();await owner?.end();
  if(created)await controlClient!.query('DROP DATABASE '+dbName+' WITH (FORCE)');
  if(roleAbsent&&(await controlClient!.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ROLE])).rowCount)await controlClient!.query('DROP ROLE '+ROLE);
  for(const role of auxiliary)await controlClient!.query('DROP ROLE '+role);
  if(controlClient){await controlClient.query('SELECT pg_advisory_unlock(739284011)');controlClient.release();}await control.end();
 }
});
