import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {database,query,transaction} from '../src/lib/db';
import type {Membership} from '../src/lib/auth';
import {hashToken} from '../src/lib/security';
import {trustedServicePlanInput,trustedServiceStartInput} from '../src/lib/trusted-service-protocol';
import {TRUSTED_SERVICE_IMAGE,trustedServicePreset,trustedServiceHash,trustedServiceEnvironment,trustedServiceReadiness,loadTrustedServicePreset,companyTrustedServiceEnvironment,type TrustedServicePreset} from '../src/lib/trusted-service-config';
import {planTrustedService,startTrustedService,stopTrustedService,getTrustedServiceProvision,listTrustedServiceProvisions,reconcileTrustedService,reconcileTrustedServices} from '../src/lib/trusted-service-provisioning';
import {handleApi} from '../src/lib/api';
import {VERCEL_MEDIA_IMAGE} from '../src/lib/higgsfield-vercel-media-sandbox';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';
import {selectCompanyRuntimeConfiguration,revokeCompanyRuntimeConfiguration,companyRuntimeHash} from '../src/lib/company-runtime-config';
import {companyArchiveRuntimeFixture} from './fixtures/company-archive-runtime';
import {revokeArchiveExecutorCredential} from '../src/lib/company-runtime-executor';

const code=(value:string)=>({code:value});
const bootstrapArgs=`node --input-type=module -e "import('data:text/javascript;base64,${Buffer.from('throw Error("Synthetic bootstrap must never execute")').toString('base64')}').catch(()=>{console.error('COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED');process.exit(1)})"`;
const secrets={runtime:'synthetic-runtime-password',archive:'synthetic-archive-password',gateway:'synthetic-gateway-password',lifecycle:'synthetic-lifecycle-private',executor:'synthetic-executor-private'};
function preset(companyId:string,service:'archive'|'gateway',expiresAt=new Date(Date.now()+600000).toISOString()):TrustedServicePreset{
 const projectIds=[randomUUID()],releaseCommit='a'.repeat(40),scope={companyId,projectIds,sourceCommit:releaseCommit,expiresAt};
 const configuration=service==='gateway'?{version:1,...scope,appOrigin:'https://coatria.com',host:'0.0.0.0',port:4190,maxTransfers:8,verifierConcurrency:1}:{version:1,policy:{...scope,pilotId:randomUUID(),maxLaunches:6,binding:{teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:'b'.repeat(64),limits:{maxInputBytes:128*1024**2,maxClosureBytes:256*1024**2,timeoutMs:120000,maxOutputBytes:1024**2,maxStderrBytes:65536}}},closure:{root:'/opt/coatria/closure',files:[{path:'bin/ffmpeg',bytes:4096,sha256:'b'.repeat(64)},{path:'bin/ffprobe',bytes:4096,sha256:'c'.repeat(64)}]},qualification:{receiptPath:'/opt/coatria/qualification.json',sha256:'d'.repeat(64)},scratchRoot:'/var/lib/coatria-scratch',outputHosts:['media.example.invalid'],operationDeadlineMs:600000,inspection:{timeoutMs:300000,sandboxTimeoutMs:90000}};
 return {id:'synthetic-'+service,service,companyId,projectIds,releaseCommit,bootstrapArgs,bootstrapHash:hashToken(bootstrapArgs),dataCenterId:'US-NC-2',expiresAt,maxHourlyMicrousd:60000,lifetimeAllowanceMicrousd:500000,configuration,configurationHash:trustedServiceHash(configuration)};
}
const fixtureDatabaseUrl=(role:string,password:string,pooled=false)=>{const url=new URL('postgresql://ep-synthetic.us-east-2.aws.neon.tech/neondb?sslmode=require');if(pooled)url.hostname='ep-synthetic-pooler.us-east-2.aws.neon.tech';url.username=role;url.password=password;return url.href;};
const settings=(presets:TrustedServicePreset[])=>({COATRIA_TRUSTED_SERVICE_PRESETS:JSON.stringify({version:1,presets}),DATABASE_URL:fixtureDatabaseUrl('coatria_runtime_v1',secrets.runtime,true),COATRIA_ARCHIVE_DATABASE_URL:fixtureDatabaseUrl('coatria_higgsfield_archive_worker_v1',secrets.archive),COATRIA_STORAGE_GATEWAY_DATABASE_URL:fixtureDatabaseUrl('coatria_storage_gateway_v1',secrets.gateway),COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,23).toString('base64')}}),MANAGED_RUNPOD_API_KEY:secrets.lifecycle,COATRIA_VERCEL_MEDIA_TOKEN:secrets.executor});

test('strict fixed service inputs and private credential composition fail closed',()=>{
 const companyId=randomUUID(),a=preset(companyId,'archive'),g=preset(companyId,'gateway'),env=settings([a,g]);assert(trustedServicePlanInput.safeParse({clientId:randomUUID(),service:'archive'}).success);
 for(const patch of [{service:'agent'},{command:'sh'},{image:'unreviewed'},{env:{}},{volumeId:'unreviewed'},{providerKey:'unreviewed'}])assert(!trustedServicePlanInput.safeParse({clientId:randomUUID(),service:'archive',...patch}).success);
 assert(!trustedServiceStartInput.safeParse({clientId:randomUUID(),revision:1,planHash:'a'.repeat(64),acknowledgeCharges:false}).success);
 assert.equal(trustedServicePreset(companyId,'archive',env).service,'archive');const ae=trustedServiceEnvironment(a,env),ge=trustedServiceEnvironment(g,env);
 assert.equal(ae.COATRIA_VERCEL_MEDIA_TOKEN,secrets.executor);assert(!('COATRIA_VERCEL_MEDIA_TOKEN'in ge));for(const item of [ae,ge]){assert(!Object.keys(item).some(key=>key.includes('RUNPOD')));assert(!JSON.stringify(item).includes(secrets.lifecycle));assert(!JSON.stringify(item).includes(secrets.runtime));}
 assert(!JSON.stringify(ae).includes(secrets.gateway));assert(!JSON.stringify(ge).includes(secrets.archive));assert.equal(trustedServiceReadiness(companyId,'archive',env).configured,true);
 for(const patch of [{COATRIA_TRUSTED_SERVICE_PRESETS:''},{COATRIA_HOSTING_KEYRING:'invalid'},{COATRIA_ARCHIVE_DATABASE_URL:env.DATABASE_URL},{COATRIA_ARCHIVE_DATABASE_URL:env.COATRIA_ARCHIVE_DATABASE_URL.replace('ep-synthetic','ep-other')},{COATRIA_ARCHIVE_DATABASE_URL:env.COATRIA_ARCHIVE_DATABASE_URL.replace(secrets.archive,secrets.gateway)},{COATRIA_VERCEL_MEDIA_TOKEN:secrets.lifecycle}])assert.equal(trustedServiceReadiness(companyId,'archive',{...env,...patch}).configured,false);
 for(const patch of [{companyId:randomUUID()},{bootstrapHash:'f'.repeat(64)},{configurationHash:'f'.repeat(64)},{volumeId:'forbidden'},{lifetimeAllowanceMicrousd:5000001}])assert.throws(()=>trustedServicePreset(companyId,'archive',settings([{...a,...patch},g])),code('SERVICE_PRESET_UNAVAILABLE'));
 assert.throws(()=>trustedServicePreset(randomUUID(),'archive',env),code('SERVICE_COMPANY_NOT_ENABLED'));
});

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL,localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
for(const postgres of [false,true])test(`${postgres?'PostgreSQL':'PGlite'} trusted service saga preserves admission, identity and stop fences`,{skip:postgres&&!localPostgres,timeout:180000},async t=>{
 const envKeys=[...Object.keys(settings([])),'DATABASE_POOL_MAX','APP_URL'],before=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),previousPool=(globalThis as any).coatriaPool,previousFetch=globalThis.fetch;
 const dbName='coatria_trusted_service_'+randomUUID().replaceAll('-','');let worker:Worker|undefined,admin:Pool|undefined,app:Pool|undefined,created=false,remoteCalls=0;
 try{
  if(postgres){admin=new Pool({connectionString:integration,max:1});await admin.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;app=new Pool({connectionString:url.href,max:5});for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await app.query(await readFile('database/'+file,'utf8'));(globalThis as any).coatriaPool=app;}
  else{worker=new Worker(`const {parentPort}=require('node:worker_threads');(async()=>{const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),{readdir,readFile}=require('node:fs/promises'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\\d.*\\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();parentPort.postMessage({url:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres'});parentPort.once('message',async()=>{await socket.stop();await db.close();parentPort.postMessage({stopped:true});parentPort.close();});})().catch(error=>{throw error;});`,{eval:true,execArgv:[]});process.env.DATABASE_URL=await new Promise<string>((yes,no)=>{worker!.once('error',no);worker!.once('message',value=>yes(value.url));});process.env.DATABASE_POOL_MAX='1';delete(globalThis as any).coatriaPool;app=database();}
  // The cached pool is the fixture. Synthetic Neon URLs exercise configuration
  // binding only; a supplied verifier prevents any attempt to connect to them.
  Object.assign(process.env,settings([]),{APP_URL:'http://localhost:4180'});globalThis.fetch=async()=>{remoteCalls++;throw Error('These tests must not reach a provider');};
  let presets:TrustedServicePreset[]=[];const install=()=>{process.env.COATRIA_TRUSTED_SERVICE_PRESETS=JSON.stringify({version:1,presets});};
  async function fixture(keep=false){
   if(!keep){await query("UPDATE trusted_service_provisions SET phase='stopped',lease_id=NULL,lease_expires_at=NULL");presets=[];}
   const companyId=randomUUID(),userId=randomUUID(),session=randomUUID();await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic operator',$2,'not-a-login')",[userId,userId+'@example.invalid']);await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic services',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),userId]);
   const entries=[preset(companyId,'archive'),preset(companyId,'gateway')];presets.push(...entries);install();const member={companyId,userId,role:'owner',user:{id:userId}} as Membership;
   const plan=(service:'archive'|'gateway'='archive',clientId=randomUUID())=>transaction(db=>planTrustedService(db,member,{clientId,service}));
   const start=(p:any,clientId=randomUUID())=>transaction(db=>startTrustedService(db,member,p.id,{clientId,revision:p.revision,planHash:p.planHash,acknowledgeCharges:true}));
   const get=(id:string)=>transaction(db=>getTrustedServiceProvision(db,companyId,id));
   const stop=async(id:string,clientId=randomUUID())=>{const p=await get(id);return transaction(db=>stopTrustedService(db,member,id,{clientId,revision:p.revision}));};
   return {companyId,userId,session,member,entries,plan,start,get,stop};
  }
  function provider(){
   const pods:any[]=[],calls:Array<{path:string;method:string}>=[];let lose=false,empty=false,price=.03,readHook:(()=>Promise<void>)|undefined,createHook:(()=>Promise<void>)|undefined;
   const fetch:typeof globalThis.fetch=async(url,init)=>{const u=new URL(String(url)),method=init?.method??'GET';assert.equal(u.origin,'https://api.runpod.io');assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+secrets.lifecycle);assert.equal(init?.redirect,'error');assert(init?.signal);calls.push({path:u.pathname,method});
    if(u.pathname==='/v2/catalog/cpus/cpu3c')return Response.json({id:'cpu3c',ramGbPerVcpu:2,vcpu:{min:2,max:32},price:{securePerVcpu:price}});
    if(u.pathname==='/v2/pods'&&method==='POST'){const body=JSON.parse(String(init?.body));assert.equal(body.image,TRUSTED_SERVICE_IMAGE);assert.equal(body.disk,10);assert.equal(body.startSsh,false);assert.equal(body.startJupyter,false);assert(!body.mounts);assert(!JSON.stringify(body).includes(secrets.lifecycle));const pod={...body,id:'pod-'+randomUUID(),cpu:{...body.cpu,memory:4},dataCenterId:body.dataCenterIds[0],status:'RUNNING',actions:['stop']};pods.push(pod);if(createHook)await createHook();if(lose)throw Error('Synthetic response loss with private data that must not be logged');return Response.json(pod);}
    if(u.pathname==='/v2/pods')return Response.json({pods:empty?[]:pods,pagination:{hasNextPage:false}});
    const pod=pods.find(p=>p.id===u.pathname.split('/')[3]);assert(pod,'Unexpected provider operation');if(u.pathname.endsWith('/action')){assert.equal(method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),{action:'stop'});pod.status='EXITED';return Response.json(pod);}if(readHook)await readHook();return Response.json(pod);
   };return {fetch,pods,calls,creates:()=>calls.filter(c=>c.path==='/v2/pods'&&c.method==='POST').length,stops:()=>calls.filter(c=>c.path.endsWith('/action')).length,setLose:(v:boolean)=>lose=v,setEmpty:(v:boolean)=>empty=v,setPrice:(v:number)=>price=v,onRead:(hook:()=>Promise<void>)=>readHook=hook,onCreate:(hook:()=>Promise<void>)=>createHook=hook};
  }
  const verifiedDatabase=async(service:'archive'|'gateway',url:string)=>{assert.equal(new URL(url).username,service==='archive'?'coatria_higgsfield_archive_worker_v1':'coatria_storage_gateway_v1');};
  const reconcile=(id:string,p:ReturnType<typeof provider>)=>reconcileTrustedService(id,{fetch:p.fetch,verifyDatabase:verifiedDatabase});
  async function selectRuntime(a:Awaited<ReturnType<typeof fixture>>,entry=a.entries[1],expectedRevision=0){
   await query("INSERT INTO platform_operator_grants(user_id,expires_at) VALUES($1,clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING",[a.userId]);
   await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'synthetic',1,$2) ON CONFLICT DO NOTHING",[a.companyId,a.userId]);
   for(const projectId of entry.projectIds)await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Synthetic','SIMULATED client','Synthetic brief','{}','allowed',$3) ON CONFLICT DO NOTHING",[projectId,a.companyId,a.userId]);
   return transaction(db=>selectCompanyRuntimeConfiguration(db,a.member,entry.service,{clientId:randomUUID(),expectedRevision,phase:'service',expiresAt:entry.expiresAt,preset:entry,configurationHash:companyRuntimeHash(entry)}));
  }
  const revokeRuntime=(a:Awaited<ReturnType<typeof fixture>>,expectedRevision=1)=>transaction(db=>revokeCompanyRuntimeConfiguration(db,a.member,'gateway',{clientId:randomUUID(),expectedRevision}));
  await t.test('a durable selection replaces legacy readiness and binds the exact registry epoch into plans',async()=>{
   const a=await fixture(),legacy=(await a.plan('gateway')).provision,selection=await selectRuntime(a),cloud=provider();
   await assert.rejects(a.start(legacy),code('SERVICE_PRESET_CHANGED'));
   delete process.env.COATRIA_TRUSTED_SERVICE_PRESETS;
   const current=(await a.plan('gateway')).provision;
   assert.equal(current.readiness.configured,true);assert.equal(current.plan.runtimeConfiguration.configurationId,selection.configuration.configurationId);
   assert.equal(current.plan.runtimeConfiguration.configurationHash,companyRuntimeHash(a.entries[1]));assert.equal(current.plan.runtimeConfiguration.selectionRevision,1);
   assert.equal((await transaction(db=>listTrustedServiceProvisions(db,a.companyId))).readiness.archive.configured,false);
   await selectRuntime(a,a.entries[1],1);await assert.rejects(a.start(current),code('SERVICE_PRESET_CHANGED'));
   assert.equal(cloud.calls.length,0);assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,0);
  });
  await t.test('revocation during provider create immediately stops the stored pod and never falls back to valid environment presets',async()=>{
   const a=await fixture();await selectRuntime(a);const p=(await a.plan('gateway')).provision,cloud=provider();await a.start(p);
   cloud.onCreate(async()=>{await revokeRuntime(a);});await reconcile(p.id,cloud);
   assert.equal(cloud.creates(),1);assert.equal(cloud.stops(),1);assert.equal(cloud.pods[0].env.COATRIA_SERVICE_PROVISION_ID,p.id);
   assert.equal((await a.get(p.id)).phase,'stopping');assert.equal((await a.get(p.id)).readiness.configured,false);
   await assert.rejects(a.plan('gateway'),code('SERVICE_CONFIGURATION_INACTIVE'));
   delete process.env.COATRIA_TRUSTED_SERVICE_PRESETS;await reconcile(p.id,cloud);assert.equal((await a.get(p.id)).phase,'stopped');
   assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,1);
   assert.equal(cloud.creates(),1);
  });
  await t.test('revocation while database preflight is in flight fences the final paid submission',async()=>{
   const a=await fixture();await selectRuntime(a);const p=(await a.plan('gateway')).provision,cloud=provider();await a.start(p);
   await reconcileTrustedService(p.id,{fetch:cloud.fetch,verifyDatabase:async()=>{await revokeRuntime(a);}});
   assert.equal(cloud.creates(),0);assert.equal((await a.get(p.id)).phase,'stopped');
   assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,1);
  });
  await t.test('revoking the archive executor stops the exact existing pod and cleanup needs no decryptable active executor',async()=>{
   const a=await fixture(),projectId=randomUUID();
   await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'synthetic',1,$2)",[a.companyId,a.userId]);
   await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Synthetic','SIMULATED client','Synthetic brief','{}','allowed',$3)",[projectId,a.companyId,a.userId]);
   const runtime=await companyArchiveRuntimeFixture(a.companyId,a.userId,projectId),cloud=provider();
   const env=await transaction(async db=>companyTrustedServiceEnvironment(db,await loadTrustedServicePreset(db,a.companyId,'archive'),runtime.provision.id));
   const pod={id:'synthetic-observation-'+runtime.provision.id,name:'coatria-archive-'+runtime.provision.id,image:TRUSTED_SERVICE_IMAGE,args:runtime.preset.bootstrapArgs,disk:10,cpu:{id:'cpu3c',vcpuCount:2,memory:4},cloud:'SECURE',dataCenterId:runtime.preset.dataCenterId,ports:[],env,status:'RUNNING',actions:['stop']};cloud.pods.push(pod);
   await query('UPDATE trusted_service_provisions SET expected_environment_hashes=$2 WHERE id=$1',[runtime.provision.id,JSON.stringify(Object.fromEntries(Object.entries(env).map(([key,value])=>[key,hashToken(value)])))]);
   const gateway=(await a.plan('gateway')).provision;await a.start(gateway);await reconcile(gateway.id,cloud);await query("UPDATE trusted_service_provisions SET last_reconciled_at='2000-01-01T00:00:00Z' WHERE id=$1",[gateway.id]);
   const before=await a.get(runtime.provision.id);
   await transaction(db=>revokeArchiveExecutorCredential(db,runtime.member,runtime.selection.configurationId,runtime.credential.id));
   const requested=await a.get(runtime.provision.id);assert(requested.stopRequestedAt);assert.equal(requested.revision,before.revision+1);assert.equal((await a.get(gateway.id)).stopRequestedAt,null);assert.equal(cloud.stops(),0);
   await transaction(db=>revokeArchiveExecutorCredential(db,runtime.member,runtime.selection.configurationId,runtime.credential.id));assert.equal((await a.get(runtime.provision.id)).revision,requested.revision);
   const batch=await reconcileTrustedServices(1,{fetch:cloud.fetch,verifyDatabase:verifiedDatabase});assert.equal((batch.results[0] as any).provision.id,runtime.provision.id);assert.equal(cloud.stops(),1);assert.equal((await a.get(runtime.provision.id)).phase,'stopping');
   await reconcile(runtime.provision.id,cloud);assert.equal((await a.get(runtime.provision.id)).phase,'stopped');assert.equal((await a.get(runtime.provision.id)).readiness.configured,false);assert.equal(cloud.creates(),1,'Only the unrelated synthetic gateway was created');
  });
  await t.test('registry gateway revocation records stop intent before cron and outranks older healthy services',async()=>{
   const healthy=await fixture(),cloud=provider(),healthyPlan=(await healthy.plan('gateway')).provision;await healthy.start(healthyPlan);await reconcile(healthyPlan.id,cloud);
   const target=await fixture(true);await selectRuntime(target);const plan=(await target.plan('gateway')).provision;await target.start(plan);await reconcile(plan.id,cloud);
   await query("UPDATE trusted_service_provisions SET last_reconciled_at='2000-01-01T00:00:00Z' WHERE id=$1",[healthyPlan.id]);
   const before=await target.get(plan.id),input={clientId:randomUUID(),expectedRevision:1};await transaction(db=>revokeCompanyRuntimeConfiguration(db,target.member,'gateway',input));
   const requested=await target.get(plan.id);assert(requested.stopRequestedAt);assert.equal(requested.revision,before.revision+1);assert.equal((await healthy.get(healthyPlan.id)).stopRequestedAt,null);assert.equal(cloud.stops(),0);
   assert.equal((await transaction(db=>revokeCompanyRuntimeConfiguration(db,target.member,'gateway',input))).replayed,true);assert.equal((await target.get(plan.id)).revision,requested.revision);
   const batch=await reconcileTrustedServices(1,{fetch:cloud.fetch,verifyDatabase:verifiedDatabase});assert.equal((batch.results[0] as any).provision.id,plan.id);assert.equal(cloud.stops(),1);
   assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[target.companyId])).rows[0].n,1);
  });
  await t.test('tenant scope, admin reauthorization, idempotent plan and explicit no-spend review',async()=>{
   const a=await fixture(),b=await fixture(true),clientId=randomUUID(),p=await a.plan('archive',clientId);assert.equal(p.provision.phase,'planned');assert.equal((await a.plan('archive',clientId)).provision.id,p.provision.id);assert.equal((await a.plan('archive',clientId)).replayed,true);await assert.rejects(a.plan('gateway',clientId),code('IDEMPOTENCY_CONFLICT'));await assert.rejects(transaction(db=>getTrustedServiceProvision(db,b.companyId,p.provision.id)),{status:404});
   assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,0);assert.equal((await query('SELECT count(*)::int n FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].n,0);await query("UPDATE memberships SET role='member' WHERE company_id=$1",[a.companyId]);await assert.rejects(a.start(p.provision),{status:403});
  });
  await t.test('separate archive and gateway pods receive minimal purpose-specific credentials with no plaintext persistence',async()=>{
   const a=await fixture(),p=provider();for(const kind of ['archive','gateway'] as const){const plan=(await a.plan(kind)).provision;await a.start(plan);await reconcile(plan.id,p);const current=await a.get(plan.id);assert.equal(current.phase,'running');assert.equal(current.serviceVerified,false);assert.equal(current.billingVerified,false);}
   assert.equal(p.creates(),2);assert.equal(new Set(p.pods.map(item=>item.id)).size,2);assert.deepEqual(p.pods.map(item=>item.ports),[[],['4190/http']]);assert(!('COATRIA_VERCEL_MEDIA_TOKEN'in p.pods[1].env));const rows=(await query('SELECT row_to_json(p) data FROM trusted_service_provisions p WHERE company_id=$1',[a.companyId])).rows;
   const publicData=await transaction(db=>listTrustedServiceProvisions(db,a.companyId));for(const value of [...Object.values(secrets),process.env.COATRIA_HOSTING_KEYRING!]){assert(!JSON.stringify(rows).includes(value));assert(!JSON.stringify(publicData).includes(value));}
   assert(!JSON.stringify(publicData).includes('expected_environment_hashes'));assert(!JSON.stringify(publicData).includes(bootstrapArgs));
  });
  await t.test('exact plan hash and revision required, duplicate approval replays and one active service blocks another',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,key=randomUUID();await assert.rejects(a.start({...p,planHash:'f'.repeat(64)}),code('SERVICE_PLAN_CONFLICT'));await a.start(p,key);assert.equal((await a.start(p,key)).replayed,true);const other=(await a.plan()).provision;await assert.rejects(a.start(other),code('SERVICE_ALREADY_PENDING'));assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,1);
  });
  await t.test('ambiguous POST never creates again, even when discovery is empty, and exact identity can be adopted',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);cloud.setLose(true);await reconcile(p.id,cloud);assert.equal((await a.get(p.id)).phase,'uncertain');cloud.setEmpty(true);await reconcile(p.id,cloud);await reconcile(p.id,cloud);assert.equal(cloud.creates(),1);assert.equal((await a.get(p.id)).podId,null);cloud.setEmpty(false);await reconcile(p.id,cloud);assert.equal((await a.get(p.id)).podId,cloud.pods[0].id);assert.equal(cloud.creates(),1);
  });
  await t.test('foreign or duplicate identities never authorize a stop or replacement',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);cloud.setLose(true);await reconcile(p.id,cloud);cloud.pods.push({...cloud.pods[0],id:'pod-duplicate'});await reconcile(p.id,cloud);assert.equal((await a.get(p.id)).errorCode,'SERVICE_DUPLICATE_IDENTITY');cloud.pods.pop();await a.stop(p.id);cloud.pods[0].env.NODE_OPTIONS='--inspect';await reconcile(p.id,cloud);assert.equal((await a.get(p.id)).errorCode,'SERVICE_IDENTITY_MISMATCH');assert.equal(cloud.stops(),0);assert.equal(cloud.creates(),1);
  });
  await t.test('stop is usable after preset removal; confirmed compute stop does not refund or revoke credentials',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);await reconcile(p.id,cloud);delete process.env.COATRIA_TRUSTED_SERVICE_PRESETS;await a.stop(p.id);await reconcile(p.id,cloud);assert.equal((await a.get(p.id)).phase,'stopping');await reconcile(p.id,cloud);const current=await a.get(p.id);assert.equal(current.phase,'stopped');assert.equal(current.computeStopped,true);assert.equal(current.credentialsRevoked,false);assert.equal(current.billingVerified,false);assert.equal(cloud.stops(),1);assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,1);assert(cloud.calls.every(c=>c.method!=='DELETE'));
  });
  await t.test('stop accepted during create or readback is applied in that reconciliation',async()=>{
   for(const atCreate of [true,false]){const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);if(atCreate)cloud.onCreate(async()=>{await a.stop(p.id);});else{await reconcile(p.id,cloud);cloud.onRead(async()=>{await a.stop(p.id);});}await reconcile(p.id,cloud);assert.equal(cloud.stops(),1);assert.equal((await a.get(p.id)).phase,'stopping');}
  });
  await t.test('expiry and administrator removal fence an already-running service',async()=>{
   for(const expiry of [true,false]){const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);await reconcile(p.id,cloud);if(expiry)await query("UPDATE trusted_service_provisions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[p.id]);else await query("UPDATE memberships SET role='removed' WHERE company_id=$1",[a.companyId]);await reconcile(p.id,cloud);assert.equal(cloud.stops(),1);assert.equal((await a.get(p.id)).phase,'stopping');}
  });
  await t.test('early stop and active reconciliation lease cannot start compute',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);await query("UPDATE trusted_service_provisions SET lease_id=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[p.id,randomUUID()]);assert.equal((await reconcile(p.id,cloud)).skipped,true);await a.stop(p.id);await query('UPDATE trusted_service_provisions SET lease_id=NULL,lease_expires_at=NULL WHERE id=$1',[p.id]);await reconcile(p.id,cloud);assert.equal(cloud.calls.length,0);assert.equal((await a.get(p.id)).phase,'stopped');
  });
  await t.test('role preflight, price drift and preset drift fail before any provider POST',async()=>{
   for(const fault of ['role','price','preset'] as const){const a=await fixture(),p=(await a.plan()).provision,cloud=provider();await a.start(p);if(fault==='price')cloud.setPrice(.04);if(fault==='preset'){a.entries[0].maxHourlyMicrousd=70000;install();}await reconcileTrustedService(p.id,{fetch:cloud.fetch,verifyDatabase:fault==='role'?async()=>{throw Error(secrets.archive);}:verifiedDatabase});assert.equal(cloud.creates(),0);assert.equal((await a.get(p.id)).phase,fault==='preset'?'stopped':'failed');assert(!JSON.stringify(await a.get(p.id)).includes(secrets.archive));}
  });
  await t.test('lifetime reservations are not reset by stopping and renewing a preset',async()=>{
   const a=await fixture();a.entries[0].lifetimeAllowanceMicrousd=16000;install();const p=(await a.plan()).provision;assert(p.plan.reservation.cpuMicrousd<=16000);await a.start(p);await a.stop(p.id);a.entries[0].id='renewed-preset';install();const next=(await a.plan()).provision;await assert.rejects(a.start(next),code('SERVICE_ALLOWANCE_EXHAUSTED'));
  });
  await t.test('cutoff work has priority over new admissions',async()=>{
   const a=await fixture(),first=(await a.plan()).provision,cloud=provider();await a.start(first);await reconcile(first.id,cloud);await query("UPDATE trusted_service_provisions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);const b=await fixture(true),second=(await b.plan()).provision;await b.start(second);await reconcileTrustedServices(1,{fetch:cloud.fetch,verifyDatabase:verifiedDatabase});assert.equal(cloud.stops(),1);assert.equal(cloud.creates(),1);assert.equal((await b.get(second.id)).phase,'approved');
  });
  await t.test('HTTP rejects unauthenticated, cross-company, member, cross-origin, stale identity and arbitrary caller infrastructure',async()=>{
   const a=await fixture(),b=await fixture(true),path=`companies/${a.companyId}/studio/trusted-services`;
   const request=(method='GET',payload?:unknown,headers:Record<string,string>={})=>handleApi(new Request('http://localhost:4180/api/'+path,{method,headers:{Origin:'http://localhost:4180',Cookie:'coatria_session='+a.session,'Content-Type':'application/json',...headers},...payload?{body:JSON.stringify(payload)}:{}}),path.split('/'));
   assert.equal((await request('GET',undefined,{Cookie:''})).status,401);assert.equal((await request('GET',undefined,{Cookie:'coatria_session='+b.session})).status,404);assert.equal((await request('GET',undefined,{'X-Coatria-User':b.userId})).status,409);assert.equal((await request('POST',{clientId:randomUUID(),service:'archive'},{Origin:'https://evil.invalid'})).status,403);assert.equal((await request('POST',{clientId:randomUUID(),service:'archive',command:'shell'})).status,400);await query("UPDATE memberships SET role='member' WHERE company_id=$1",[a.companyId]);assert.equal((await request()).status,403);
  });
  await t.test('real PostgreSQL concurrent starts serialize the last available service slot',{skip:!postgres},async()=>{
   const a=await fixture(),one=(await a.plan()).provision,two=(await a.plan()).provision,gate=await app!.connect();let results:Promise<PromiseSettledResult<unknown>[]>;try{await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`trusted-service-control:${a.companyId}`]);results=Promise.allSettled([a.start(one),a.start(two)]);await new Promise(resolve=>setTimeout(resolve,60));await gate.query('COMMIT');}finally{await gate.query('ROLLBACK');gate.release();}const settled=await results!;assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal((settled.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'SERVICE_ALREADY_PENDING');assert.equal((await query('SELECT count(*)::int n FROM trusted_service_reservations WHERE company_id=$1',[a.companyId])).rows[0].n,1);
  });
  assert.equal(remoteCalls,0);
 }finally{
  globalThis.fetch=previousFetch;await app?.end();(globalThis as any).coatriaPool=previousPool;
  if(worker){try{await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('Fixture shutdown timeout')),5000);worker!.once('message',()=>{clearTimeout(timer);yes();});worker!.postMessage('stop');});}finally{await worker.terminate();}}
  if(created)await dropFixtureDatabase(admin!,dbName);await admin?.end();for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
