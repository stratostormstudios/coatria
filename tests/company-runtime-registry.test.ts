import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import type {Membership} from '../src/lib/auth';
import {hashToken} from '../src/lib/security';
import {companyRuntimeSelectInput,companyRuntimeRevokeInput} from '../src/lib/company-runtime-protocol';
import {companyRuntimeHash,loadCompanyRuntimeConfiguration,getCompanyRuntimeConfiguration,selectCompanyRuntimeConfiguration,revokeCompanyRuntimeConfiguration,requirePlatformRuntimeOperator} from '../src/lib/company-runtime-config';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';
import {saveArchiveExecutorCredential,getArchiveExecutorCredential,revokeArchiveExecutorCredential,resolveCompanyArchiveExecutor} from '../src/lib/company-runtime-executor';
import {VERCEL_MEDIA_IMAGE} from '../src/lib/higgsfield-vercel-media-sandbox';
import type {TrustedServicePreset} from '../src/lib/company-runtime-preset';

const error=(code:string)=>({code});
function preset(companyId:string,volumeId='volume_'+randomUUID().replaceAll('-','')){
 const bootstrapArgs=`node --input-type=module -e "import('data:text/javascript;base64,${Buffer.from('throw Error("Synthetic bootstrap is never executed")').toString('base64')}').catch(()=>{console.error('COATRIA_STUDIO_BOOTSTRAP_FAILED');process.exit(1)})"`;
 return {id:'synthetic-managed',releaseCommit:'a'.repeat(40),bootstrapArgs,bootstrapHash:hashToken(bootstrapArgs),modelId:'synthetic',endpointId:'synthetic_endpoint',maxHourlyMicrousd:60000,maxSteps:6,maxOutputTokens:1024,maxTotalTokens:8192,timeoutSeconds:120,inference:{mode:'coatria_broker_v1',maxJobs:4,maxHourlyMicrousd:100000,lifetimeAllowanceMicrousd:1000000},companies:[{companyId,volumeId,dataCenterId:'US-NC-2',lifetimeAllowanceMicrousd:500000}]};
}
const input=(value:ReturnType<typeof preset>,revision=0)=>({clientId:randomUUID(),expectedRevision:revision,phase:'service',expiresAt:new Date(Date.now()+3600000).toISOString(),configurationHash:companyRuntimeHash(value),preset:value});
test('runtime mutation inputs require exact revision, hash and explicit phase; hashes are stable across key order',()=>{
 const value=preset(randomUUID()),data=input(value);assert(companyRuntimeSelectInput.safeParse(data).success);
 for(const patch of [{expectedRevision:-1},{configurationHash:'oops'},{phase:'arbitrary'},{secret:'forbidden'},{expectedRevision:undefined}])assert(!companyRuntimeSelectInput.safeParse({...data,...patch}).success);
 assert(!companyRuntimeRevokeInput.safeParse({clientId:randomUUID(),expectedRevision:0}).success);
 assert.equal(companyRuntimeHash({z:1,a:{b:true,a:0}}),companyRuntimeHash({a:{a:0,b:true},z:1}));
});
const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
for(const postgres of [false,true])test(`${postgres?'PostgreSQL':'PGlite'} runtime registry preserves operator authority, isolation and history`,{skip:postgres&&!local,timeout:180000},async t=>{
 let owner:Pool|undefined,control:Pool|undefined,emulator:import('@electric-sql/pglite').PGlite|undefined;
 const name='coatria_runtime_registry_'+randomUUID().replaceAll('-','');
 try{
  if(postgres){control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+name);const url=new URL(integration!);url.pathname='/'+name;owner=new Pool({connectionString:url.href,max:4,application_name:name,statement_timeout:15000});}
  else{const{PGlite}=await import('@electric-sql/pglite');emulator=await PGlite.create();}
  const query=async(sql:string,values:unknown[]=[])=>{if(owner)return owner.query(sql,values);const result=await emulator!.query<Row>(sql,values);return {rows:result.rows,rowCount:result.rows.length||result.affectedRows||0};};
  type Row=Record<string,any>;
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){const sql=await readFile('database/'+file,'utf8');if(owner)await owner.query(sql);else await emulator!.exec(sql);}
  const tx=async<T>(fn:(db:PoolClient)=>Promise<T>)=>{const client=owner?await owner.connect():{query};try{await client.query('BEGIN');const result=await fn(client as PoolClient);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{if('release'in client)client.release();}};
  async function fixture(){
   const userId=randomUUID(),companyId=randomUUID();await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic operator',$2,'fixture')",[userId,userId+'@example.invalid']);
   await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic runtime registry',$2,'blank')",[companyId,companyId]);
   await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);
   await query("INSERT INTO platform_operator_grants(user_id,expires_at) VALUES($1,clock_timestamp()+interval '1 day')",[userId]);
   return {companyId,userId,role:'owner',user:{id:userId,name:'Synthetic operator',email:userId+'@example.invalid',roleTitle:'',avatarColor:'',avatarId:null,emailVerified:true}} as Membership;
  }
  await t.test('company administrator alone, removed member and revoked/expired operator cannot write or replay',async()=>{
   const member=await fixture(),data=input(preset(member.companyId));
   await query('DELETE FROM platform_operator_grants WHERE user_id=$1',[member.userId]);await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data)),error('PLATFORM_OPERATOR_REQUIRED'));
   await query("INSERT INTO platform_operator_grants(user_id,granted_at,expires_at) VALUES($1,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[member.userId]);await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data)),error('PLATFORM_OPERATOR_REQUIRED'));
   await query("UPDATE platform_operator_grants SET expires_at=clock_timestamp()+interval '1 day' WHERE user_id=$1",[member.userId]);const saved=await tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data));assert.equal(saved.replayed,false);
   await query('UPDATE platform_operator_grants SET revoked_at=clock_timestamp() WHERE user_id=$1',[member.userId]);await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data)),error('PLATFORM_OPERATOR_REQUIRED'));
   await query('UPDATE platform_operator_grants SET revoked_at=NULL WHERE user_id=$1',[member.userId]);await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[member.companyId,member.userId]);await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data)),{status:403});
  });
  await t.test('exact revision/hash, immutable receipts and replay do not expose raw bootstrap',async()=>{
   const member=await fixture(),p=preset(member.companyId),data=input(p);
   assert.equal(await tx(db=>loadCompanyRuntimeConfiguration(db,member.companyId,'managed_agent')),null);
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',{...data,configurationHash:'f'.repeat(64)})),error('RUNTIME_CONFIGURATION_HASH'));
   const first=await tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data));assert.equal(first.configuration.selectionRevision,1);assert.equal(first.configuration.computeStarted,false);
   assert(!JSON.stringify(first).includes('bootstrapArgs'));assert(!JSON.stringify(await tx(db=>getCompanyRuntimeConfiguration(db,member,'managed_agent'))).includes(p.bootstrapArgs));
   const replay=await tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data));assert.equal(replay.replayed,true);assert.deepEqual(replay.configuration,first.configuration);
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',{...data,expectedRevision:1})),error('IDEMPOTENCY_CONFLICT'));
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(p))),error('RUNTIME_SELECTION_CONFLICT'));
   await assert.rejects(query("UPDATE company_runtime_configurations SET phase='service' WHERE id=$1",[first.configuration.configurationId]),{code:'55000'});
   await assert.rejects(query('DELETE FROM company_runtime_requests WHERE company_id=$1',[member.companyId]),{code:'55000'});
   assert.equal((await query('SELECT count(*)::int AS n FROM company_runtime_configurations WHERE company_id=$1',[member.companyId])).rows[0].n,1);
   const loaded=await tx(db=>loadCompanyRuntimeConfiguration(db,member.companyId,'managed_agent'));assert(loaded?.enabled);assert.equal((loaded!.preset as any).company.companyId,member.companyId);
   const revoke={clientId:randomUUID(),expectedRevision:1};const disabled=await tx(db=>revokeCompanyRuntimeConfiguration(db,member,'managed_agent',revoke));assert.equal(disabled.configuration.selectionRevision,2);assert.equal(disabled.configuration.enabled,false);
   const tombstone=await tx(db=>loadCompanyRuntimeConfiguration(db,member.companyId,'managed_agent'));assert(tombstone);assert.equal(tombstone.enabled,false);assert.equal(tombstone.configurationId,loaded!.configurationId);
   assert.equal((await tx(db=>revokeCompanyRuntimeConfiguration(db,member,'managed_agent',revoke))).replayed,true);
   assert.equal((await tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(p,2)))).configuration.selectionRevision,3);
  });
  await t.test('secret fields, embedded credentials, multi-company presets and wrong company are rejected',async()=>{
   const member=await fixture(),p=preset(member.companyId);
   for(const bad of [{...p,apiKey:'not-allowed'},{...p,companies:[...p.companies,{...p.companies[0],companyId:randomUUID(),volumeId:'other'}]},{...p,companies:[{...p.companies[0],companyId:randomUUID()}]}])await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(bad as any))),{status:400});
   const secretCode='const apiKey="rpa_'+('x'.repeat(24))+'";';const args=p.bootstrapArgs.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/,'data:text/javascript;base64,'+Buffer.from(secretCode).toString('base64'));const bad={...p,bootstrapArgs:args,bootstrapHash:hashToken(args)};
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(bad))),error('RUNTIME_SECRET_FORBIDDEN'));
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',{...input(p),phase:'preflight'})),error('RUNTIME_DEADLINE_INVALID'));
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',{...input(p),expiresAt:new Date(Date.now()+3*86400000).toISOString()})),error('RUNTIME_DEADLINE_INVALID'));
  });
  await t.test('active and uncertain resources block replacement, while revocation remains possible',async()=>{
   const member=await fixture(),p=preset(member.companyId);await tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(p)));
   const provisionId=randomUUID();await query("INSERT INTO studio_host_provisions(id,company_id,created_by,client_id,request_hash,plan,plan_hash,preset,pod_name,phase) VALUES($1,$2,$3,$4,$5,'{}',$5,$6,$7,'uncertain')",[provisionId,member.companyId,member.userId,randomUUID(),'a'.repeat(64),JSON.stringify({company:p.companies[0]}),'synthetic-'+provisionId]);
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(p,1))),error('RUNTIME_PROVISION_ACTIVE'));
   assert.equal((await tx(db=>revokeCompanyRuntimeConfiguration(db,member,'managed_agent',{clientId:randomUUID(),expectedRevision:1}))).configuration.enabled,false);
   await query("UPDATE studio_host_provisions SET phase='stopped' WHERE id=$1",[provisionId]);
   await query('INSERT INTO studio_host_compute_reservations(company_id,provision_id,amount_microusd,approved_by) VALUES($1,$2,400000,$3)',[member.companyId,provisionId,member.userId]);
   const less={...p,companies:[{...p.companies[0],lifetimeAllowanceMicrousd:399999}]};await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(less,2))),error('RUNTIME_ALLOWANCE_ALREADY_RESERVED'));
   await tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',input(p,2)));
   assert.equal((await query('SELECT sum(amount_microusd)::text AS amount FROM studio_host_compute_reservations WHERE company_id=$1',[member.companyId])).rows[0].amount,'400000');
  });
  await t.test('worker-volume ownership survives revocation and is also read from legacy provision history',async()=>{
   const a=await fixture(),b=await fixture(),p=preset(a.companyId);await tx(db=>selectCompanyRuntimeConfiguration(db,a,'managed_agent',input(p)));await tx(db=>revokeCompanyRuntimeConfiguration(db,a,'managed_agent',{clientId:randomUUID(),expectedRevision:1}));
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,b,'managed_agent',input(preset(b.companyId,p.companies[0].volumeId)))),error('RUNTIME_VOLUME_COMPANY_CONFLICT'));
   const legacyVolume='legacy_'+randomUUID().replaceAll('-',''),legacy=randomUUID();await query("INSERT INTO studio_host_provisions(id,company_id,created_by,client_id,request_hash,plan,plan_hash,preset,pod_name,phase) VALUES($1,$2,$3,$4,$5,'{}',$5,$6,$7,'stopped')",[legacy,a.companyId,a.userId,randomUUID(),'a'.repeat(64),JSON.stringify({company:{volumeId:legacyVolume}}),'legacy-'+legacy]);
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,b,'managed_agent',input(preset(b.companyId,legacyVolume)))),error('RUNTIME_VOLUME_COMPANY_CONFLICT'));
  });
  await t.test('trusted service scope requires owned projects and exactly matching deadlines',async()=>{
   const member=await fixture(),projectId=randomUUID(),deadline=new Date(Date.now()+3600000).toISOString();const p=preset(member.companyId);const bootstrapArgs=p.bootstrapArgs.replace('COATRIA_STUDIO_BOOTSTRAP_FAILED','COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED');
   const configuration={version:1,companyId:member.companyId,projectIds:[projectId],sourceCommit:p.releaseCommit,expiresAt:deadline,appOrigin:'https://coatria.com',host:'0.0.0.0',port:4190,maxTransfers:8,verifierConcurrency:1};
   const service={id:'synthetic-gateway',service:'gateway',companyId:member.companyId,projectIds:[projectId],releaseCommit:p.releaseCommit,bootstrapArgs,bootstrapHash:hashToken(bootstrapArgs),dataCenterId:'US-NC-2',expiresAt:deadline,maxHourlyMicrousd:60000,lifetimeAllowanceMicrousd:500000,configuration,configurationHash:companyRuntimeHash(configuration)};
   const data={...input(service as any),expiresAt:deadline,phase:'preflight'};
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'gateway',data)),error('RUNTIME_PROJECT_SCOPE'));
   await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'synthetic',1,$2)",[member.companyId,member.userId]);await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Synthetic scope','Simulated client','No production work','{}','allowed',$3)",[projectId,member.companyId,member.userId]);
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'gateway',{...data,expiresAt:new Date(Date.now()+7200000).toISOString()})),error('RUNTIME_DEADLINE_INVALID'));
   assert.equal((await tx(db=>selectCompanyRuntimeConfiguration(db,member,'gateway',data))).configuration.phase,'preflight');
   const loaded=await tx(db=>loadCompanyRuntimeConfiguration(db,member.companyId,'gateway'));assert(loaded?.enabled);assert.equal(loaded!.expiresAt,deadline);
   await assert.rejects(tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',{...input(p),clientId:data.clientId})),error('IDEMPOTENCY_CONFLICT'));
  });
  const executorSettings={COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,51).toString('base64')}})};
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...keys.publicKey.export({format:'jwk'}),kid:'synthetic-test',alg:'RS256',use:'sig'};
  let jwksCalls=0;
  const jwksFetch:typeof fetch=async(url,init)=>{jwksCalls++;assert.equal(String(url),'https://oidc.vercel.com/synthetic-owner/.well-known/jwks');assert.equal((init?.headers as Record<string,string>).Authorization,undefined);return Response.json({keys:[jwk]});};
  const token=()=>{const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'synthetic-test'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:'https://oidc.vercel.com/synthetic-owner',aud:'https://vercel.com/synthetic-owner',sub:'owner:synthetic-owner:project:synthetic-project:environment:development',owner:'synthetic-owner',project:'synthetic-project',environment:'development',owner_id:'team_synthetic',project_id:'prj_synthetic',iat:now,exp:now+7200})).toString('base64url');return head+'.'+payload+'.'+sign('RSA-SHA256',Buffer.from(head+'.'+payload),keys.privateKey).toString('base64url');};
  async function archiveFixture(){
   const member=await fixture(),projectId=randomUUID(),expiresAt=new Date(Date.now()+3600000).toISOString(),base=preset(member.companyId),bootstrapArgs=base.bootstrapArgs.replace('COATRIA_STUDIO_BOOTSTRAP_FAILED','COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED');
   await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'synthetic',1,$2)",[member.companyId,member.userId]);await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Synthetic archive','Simulated client','No provider work','{}','allowed',$3)",[projectId,member.companyId,member.userId]);
   const configuration={version:1,policy:{companyId:member.companyId,projectIds:[projectId],sourceCommit:base.releaseCommit,expiresAt,pilotId:randomUUID(),maxLaunches:6,binding:{teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:'b'.repeat(64),limits:{maxInputBytes:128*1024**2,maxClosureBytes:256*1024**2,timeoutMs:120000,maxOutputBytes:1024**2,maxStderrBytes:65536}}},closure:{root:'/opt/coatria/closure',files:[{path:'bin/ffmpeg',bytes:4096,sha256:'b'.repeat(64)},{path:'bin/ffprobe',bytes:4096,sha256:'c'.repeat(64)}]},qualification:{receiptPath:'/opt/coatria/qualification.json',sha256:'d'.repeat(64)},scratchRoot:'/var/lib/coatria-scratch',outputHosts:['media.example.invalid'],operationDeadlineMs:600000,inspection:{timeoutMs:300000,sandboxTimeoutMs:90000}};
   const p:TrustedServicePreset={id:'synthetic-archive',service:'archive',companyId:member.companyId,projectIds:[projectId],releaseCommit:base.releaseCommit,bootstrapArgs,bootstrapHash:hashToken(bootstrapArgs),dataCenterId:'US-NC-2',expiresAt,maxHourlyMicrousd:60000,lifetimeAllowanceMicrousd:500000,configuration,configurationHash:companyRuntimeHash(configuration)};
   const configured=await tx(db=>selectCompanyRuntimeConfiguration(db,member,'archive',{...input(p as any),expiresAt}));return {member,p,configurationId:configured.configuration.configurationId};
  }
  await t.test('executor vault binds strict replay, safe metadata, selection authority and actual signature verification',async()=>{
   const {member,p,configurationId}=await archiveFixture(),data={clientId:randomUUID(),expectedCredentialId:null,token:token()},options={settings:executorSettings,fetch:jwksFetch};
   const first=await tx(db=>saveArchiveExecutorCredential(db,member,configurationId,data,options));assert.equal(first.replayed,false);assert(!JSON.stringify(first).includes(data.token));
   const before=jwksCalls;assert.equal((await tx(db=>saveArchiveExecutorCredential(db,member,configurationId,data,options))).replayed,true);assert.equal(jwksCalls,before,'An exact replay must not re-send or reverify the stored token');
   await assert.rejects(tx(db=>saveArchiveExecutorCredential(db,member,configurationId,{...data,expectedCredentialId:randomUUID()},options)),error('IDEMPOTENCY_CONFLICT'));
   const read=await tx(db=>getArchiveExecutorCredential(db,member,configurationId));assert(!JSON.stringify(read).includes(data.token));assert(!('sealed'in read.credential!));assert(!('tokenHash'in read.credential!));
   assert.equal((await tx(db=>resolveCompanyArchiveExecutor(db,member.companyId,configurationId,p,executorSettings))).token,data.token);
   const stored=(await query('SELECT * FROM company_runtime_executor_credentials WHERE id=$1',[first.credential!.id])).rows[0];assert(!JSON.stringify(stored).includes(data.token));assert.equal(stored.token_hash,hashToken(data.token));
   await assert.rejects(query("UPDATE company_runtime_executor_credentials SET token_hash=$2 WHERE id=$1",[stored.id,'f'.repeat(64)]),{code:'55000'});
   await assert.rejects(query('DELETE FROM company_runtime_executor_credentials WHERE id=$1',[stored.id]),{code:'55000'});
   await tx(db=>revokeCompanyRuntimeConfiguration(db,member,'archive',{clientId:randomUUID(),expectedRevision:1}));
   await assert.rejects(tx(db=>resolveCompanyArchiveExecutor(db,member.companyId,configurationId,p,executorSettings)),error('EXECUTOR_CREDENTIAL_UNAVAILABLE'));
   await tx(db=>revokeArchiveExecutorCredential(db,member,configurationId,stored.id));
   assert((await tx(db=>getArchiveExecutorCredential(db,member,configurationId))).credential?.revokedAt);
  });
  await t.test('executor credential replacement is denied during uncertain archive compute and revocation still works',async()=>{
   const {member,p,configurationId}=await archiveFixture(),options={settings:executorSettings,fetch:jwksFetch},first=await tx(db=>saveArchiveExecutorCredential(db,member,configurationId,{clientId:randomUUID(),expectedCredentialId:null,token:token()},options));
   const provisionId=randomUUID();await query("INSERT INTO trusted_service_provisions(id,company_id,service,created_by,client_id,request_hash,preset,plan,plan_hash,pod_name,expires_at,phase) VALUES($1,$2,'archive',$3,$4,$5,$6,'{}',$5,$7,$8,'uncertain')",[provisionId,member.companyId,member.userId,randomUUID(),'a'.repeat(64),JSON.stringify(p),'synthetic-'+provisionId,p.expiresAt]);
   await assert.rejects(tx(db=>saveArchiveExecutorCredential(db,member,configurationId,{clientId:randomUUID(),expectedCredentialId:first.credential!.id,token:token()},options)),error('RUNTIME_PROVISION_ACTIVE'));
   await tx(db=>revokeArchiveExecutorCredential(db,member,configurationId,first.credential!.id));
   await assert.rejects(tx(db=>resolveCompanyArchiveExecutor(db,member.companyId,configurationId,p,executorSettings)),error('EXECUTOR_CREDENTIAL_UNAVAILABLE'));
  });
  await t.test('replaying an old executor revoke cannot stop a later credential or a differently pinned configuration',async()=>{
   const {member,p,configurationId}=await archiveFixture(),options={settings:executorSettings,fetch:jwksFetch};
   const first=await tx(db=>saveArchiveExecutorCredential(db,member,configurationId,{clientId:randomUUID(),expectedCredentialId:null,token:token()},options));
   await tx(db=>revokeArchiveExecutorCredential(db,member,configurationId,first.credential!.id));
   const second=await tx(db=>saveArchiveExecutorCredential(db,member,configurationId,{clientId:randomUUID(),expectedCredentialId:null,token:token()},options)),provisionId=randomUUID();
   await query("INSERT INTO trusted_service_provisions(id,company_id,service,created_by,client_id,request_hash,preset,plan,plan_hash,pod_name,expires_at,phase) VALUES($1,$2,'archive',$3,$4,$5,$6,$7,$5,$8,$9,'uncertain')",[provisionId,member.companyId,member.userId,randomUUID(),'a'.repeat(64),JSON.stringify(p),JSON.stringify({runtimeConfiguration:{configurationId}}),'synthetic-'+provisionId,p.expiresAt]);
   await tx(db=>revokeArchiveExecutorCredential(db,member,configurationId,first.credential!.id));
   const unchanged=(await query('SELECT stop_requested_at,revision FROM trusted_service_provisions WHERE id=$1',[provisionId])).rows[0];assert.equal(unchanged.stop_requested_at,null);assert.equal(unchanged.revision,1);
   await query('UPDATE trusted_service_provisions SET plan=$2 WHERE id=$1',[provisionId,JSON.stringify({runtimeConfiguration:{configurationId:randomUUID()}})]);
   await tx(db=>revokeArchiveExecutorCredential(db,member,configurationId,second.credential!.id));
   assert.equal((await query('SELECT stop_requested_at FROM trusted_service_provisions WHERE id=$1',[provisionId])).rows[0].stop_requested_at,null);
  });
  await t.test('executor encryption rejects a copied cross-company envelope and wrong decryption keys',async()=>{
   const a=await archiveFixture(),b=await archiveFixture(),options={settings:executorSettings,fetch:jwksFetch},first=await tx(db=>saveArchiveExecutorCredential(db,a.member,a.configurationId,{clientId:randomUUID(),expectedCredentialId:null,token:token()},options));
   const stored=(await query('SELECT * FROM company_runtime_executor_credentials WHERE id=$1',[first.credential!.id])).rows[0];
   await query('INSERT INTO company_runtime_executor_credentials(id,company_id,configuration_id,client_id,token_hash,sealed,expires_at,created_by,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),b.member.companyId,b.configurationId,randomUUID(),stored.token_hash,JSON.stringify(stored.sealed),stored.expires_at,b.member.userId,'a'.repeat(64)]);
   await assert.rejects(tx(db=>resolveCompanyArchiveExecutor(db,b.member.companyId,b.configurationId,b.p,executorSettings)),error('EXECUTOR_CREDENTIAL_UNAVAILABLE'));
   await assert.rejects(tx(db=>resolveCompanyArchiveExecutor(db,a.member.companyId,a.configurationId,a.p,{COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,52).toString('base64')}})})),error('EXECUTOR_CREDENTIAL_UNAVAILABLE'));
   await assert.rejects(tx(db=>saveArchiveExecutorCredential(db,b.member,a.configurationId,{clientId:randomUUID(),expectedCredentialId:null,token:token()},options)),error('EXECUTOR_CREDENTIAL_UNAVAILABLE'));
  });
  if(postgres){
   await t.test('runtime expiry is sampled after waiting for the selection row lock',async()=>{
    const member=await fixture(),p=preset(member.companyId),configurationId=randomUUID();
    await query("INSERT INTO company_runtime_configurations(id,company_id,kind,phase,preset,configuration_hash,worker_volume_id,expires_at,created_by) VALUES($1,$2,'managed_agent','service',$3,$4,$5,clock_timestamp()+interval '2 seconds',$6)",[configurationId,member.companyId,JSON.stringify(p),companyRuntimeHash(p),p.companies[0].volumeId,member.userId]);
    await query("INSERT INTO company_runtime_selections(company_id,kind,configuration_id,revision,state,selected_by) VALUES($1,'managed_agent',$2,1,'active',$3)",[member.companyId,configurationId,member.userId]);
    const blocker=await owner!.connect();let pending:Promise<Awaited<ReturnType<typeof loadCompanyRuntimeConfiguration>>>|undefined;
    try{await blocker.query('BEGIN');await blocker.query("SELECT * FROM company_runtime_selections WHERE company_id=$1 AND kind='managed_agent' FOR UPDATE",[member.companyId]);pending=tx(db=>loadCompanyRuntimeConfiguration(db,member.companyId,'managed_agent'));
     for(let i=0;i<100;i++){const waiting=(await owner!.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF s%'")).rows[0].n;if(waiting)break;if(i===99)throw Error('Expected the selection row lock wait');await new Promise(r=>setTimeout(r,20));}
     await owner!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))::float8+0.02) FROM company_runtime_configurations WHERE id=$1',[configurationId]);await blocker.query('COMMIT');assert.equal((await pending)?.enabled,false);
    }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
   });
   await t.test('operator revocation while waiting for its grant row lock denies admission',async()=>{
    const member=await fixture(),data=input(preset(member.companyId)),blocker=await owner!.connect();let pending:Promise<unknown>|undefined;
    try{await blocker.query('BEGIN');await blocker.query('UPDATE platform_operator_grants SET revoked_at=clock_timestamp() WHERE user_id=$1',[member.userId]);pending=tx(db=>selectCompanyRuntimeConfiguration(db,member,'managed_agent',data));const failure=assert.rejects(pending,error('PLATFORM_OPERATOR_REQUIRED'));
     for(let i=0;i<100;i++){const waiting=(await owner!.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%coatria_lock_platform_runtime_operator%'")).rows[0].n;if(waiting)break;if(i===99)throw Error('Expected the operator grant lock wait');await new Promise(r=>setTimeout(r,20));}
     await blocker.query('COMMIT');await failure;assert.equal((await owner!.query('SELECT count(*)::int AS n FROM company_runtime_configurations WHERE company_id=$1',[member.companyId])).rows[0].n,0);
    }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
   });
   await t.test('runtime role can lock/read a grant but cannot mint, revoke or extend it',async()=>{
    const member=await fixture(),role='coatria_registry_role_'+randomUUID().replaceAll('-','');await tx(async db=>{await db.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await db.query(`GRANT SELECT ON companies,memberships,platform_operator_grants TO ${role}`);await db.query(`GRANT UPDATE(id) ON companies TO ${role}`);await db.query(`GRANT UPDATE(role) ON memberships TO ${role}`);await db.query(`GRANT EXECUTE ON FUNCTION coatria_lock_platform_runtime_operator(uuid) TO ${role}`);await db.query(`SET LOCAL ROLE ${role}`);await requirePlatformRuntimeOperator(db,member);
     for(const sql of ['INSERT INTO platform_operator_grants(user_id,expires_at) VALUES(gen_random_uuid(),clock_timestamp())','UPDATE platform_operator_grants SET revoked_at=clock_timestamp()','DELETE FROM platform_operator_grants']){await db.query('SAVEPOINT denied');await assert.rejects(db.query(sql),{code:'42501'});await db.query('ROLLBACK TO SAVEPOINT denied');}await db.query('RESET ROLE');await db.query(`DROP OWNED BY ${role}`);await db.query(`DROP ROLE ${role}`);});
   });
  }
 }finally{await owner?.end();if(control){await dropFixtureDatabase(control,name);await control.end();}await emulator?.close();}
});
