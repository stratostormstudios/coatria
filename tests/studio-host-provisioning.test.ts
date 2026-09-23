import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {memberMutation} from '../src/lib/company';
import type {Membership} from '../src/lib/auth';
import {hashToken} from '../src/lib/security';
import {createStudioHostProvisionPlan,startStudioHostProvision,stopStudioHostProvision,getStudioHostProvision,listStudioHostProvisions,reconcileStudioHostProvision,reconcileStudioHostProvisions,studioCpuPreset,studioCpuReadiness} from '../src/lib/studio-host-provisioning';
import {studioHostProvisionPlanInput,studioHostProvisionStartInput} from '../src/lib/studio-host-provisioning-protocol';
import {buildStudioBootstrap} from '../scripts/hosting/build-studio-bootstrap.mjs';
import {selectCompanyRuntimeConfiguration,revokeCompanyRuntimeConfiguration,companyRuntimeHash} from '../src/lib/company-runtime-config';

test('public CPU approval accepts only exact bounded plans and explicit charges and activation',()=>{
 const request={clientId:randomUUID(),durationMinutes:20,installations:[{installationId:randomUUID(),revision:1}]};assert(studioHostProvisionPlanInput.safeParse(request).success);
 for(const patch of [{durationMinutes:0},{durationMinutes:1440},{image:'unreviewed'},{providerKey:'fixture'},{volumeId:'foreign'},{endpointId:'foreign'},{command:'shell'},{inference:{mode:'coatria_broker_v1',maxJobs:100,maxHourlyMicrousd:10000000,lifetimeAllowanceMicrousd:20000000}},{inferenceMode:'coatria_broker_v1'},{installations:[request.installations[0],request.installations[0]]}])assert.equal(studioHostProvisionPlanInput.safeParse({...request,...patch}).success,false);
 const approval={clientId:randomUUID(),revision:1,planHash:'a'.repeat(64),acknowledgeCharges:true,activateAgents:true};assert(studioHostProvisionStartInput.safeParse(approval).success);assert(!studioHostProvisionStartInput.safeParse({...approval,acknowledgeCharges:false}).success);assert(!studioHostProvisionStartInput.safeParse({...approval,activateAgents:false}).success);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('managed CPU saga uses actual transactions and fake Runpod transport without cloud effects',{skip:!emulate&&!integrationUrl,timeout:180000},async t=>{
 const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING,COATRIA_MANAGED_CPU_PRESET:process.env.COATRIA_MANAGED_CPU_PRESET,MANAGED_RUNPOD_API_KEY:process.env.MANAGED_RUNPOD_API_KEY,COATRIA_MANAGED_RUNPOD_INFERENCE_KEY:process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY};
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));
 const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:Buffer.alloc(32,12).toString('base64')}});process.env.MANAGED_RUNPOD_API_KEY='fixture-lifecycle-secret';process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY='fixture-restricted-inference-secret';
 const release=await buildStudioBootstrap({root:process.cwd(),commit:'a'.repeat(40)}),modelId='Qwen/Qwen3.8-27B-FP8',runtimeConfig={providerId:'runpod',modelId,maxSteps:8,maxOutputTokens:8192,maxTotalTokens:80000,timeoutSeconds:600},origin='http://localhost:4180';
 const presetBase={id:'fixture-review-v1',releaseCommit:'a'.repeat(40),bootstrapArgs:release.args,bootstrapHash:hashToken(release.args),modelId,endpointId:'fixture-endpoint',maxHourlyMicrousd:60000,maxSteps:8,maxOutputTokens:8192,maxTotalTokens:80000,timeoutSeconds:600};
 const owners:string[]=[],companies:Array<{companyId:string;volumeId:string;dataCenterId:string;lifetimeAllowanceMicrousd:number}>=[];
 const brokerInference={mode:'coatria_broker_v1',maxJobs:12,maxHourlyMicrousd:600000,lifetimeAllowanceMicrousd:2000000};
 function updatePreset(inference?:Record<string,unknown>){process.env.COATRIA_MANAGED_CPU_PRESET=JSON.stringify({...presetBase,...inference?{inference}:{},companies});}
 async function fixture(allowance=500000,inference?:Record<string,unknown>){
  const companyId=randomUUID(),userId=randomUUID(),session=randomUUID();await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'CPU operator',userId+'@example.invalid','fixture']);await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'CPU fixture',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),userId]);
  owners.push(userId);companies.push({companyId,volumeId:'volume-'+companies.length,dataCenterId:'US-NC-2',lifetimeAllowanceMicrousd:allowance});updatePreset(inference);
  const {pluginMarketplaceRoute}=await import('../src/lib/plugin-marketplace');const path=`companies/${companyId}/plugin-installations`,response=await pluginMarketplaceRoute(new Request(origin+'/api/'+path,{method:'POST',headers:{Origin:origin,Cookie:'coatria_session='+session,'Content-Type':'application/json'},body:JSON.stringify({clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Producer',runtimeConfig,invocationAccess:'admins',capabilities:['workspace.read','studio.read','studio.write','tasks.write']})}),path.split('/'),'POST');assert(response);const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));
  const member={companyId,userId,role:'owner',user:{id:userId,name:'CPU operator',email:userId+'@example.invalid'}} as Membership;
  const planInput={clientId:randomUUID(),durationMinutes:20,installations:[{installationId:result.installation.id,revision:result.installation.revision}]};
  const plan=async(input=planInput)=>memberMutation(member,true,c=>createStudioHostProvisionPlan(c,member,input));
  const start=async(provision:any,input={clientId:randomUUID(),revision:provision.revision,planHash:provision.planHash,acknowledgeCharges:true,activateAgents:true})=>memberMutation(member,true,c=>startStudioHostProvision(c,member,provision.id,input));
  const get=(provisionId:string)=>transaction(c=>getStudioHostProvision(c,companyId,provisionId));
  return{companyId,userId,session,member,installation:result.installation,planInput,plan,start,get};
 }
 function transportFixture(mode:'direct'|'broker'='direct'){
  const calls:Array<{method:string;path:string}>=[],pods:any[]=[],requests:any[]=[];let loseCreate=false,emptyDiscovery=false,malformedDiscovery=false,price=.03,stopConfirmed=true,endpointEnabled=true,healthAllowed=true;
  const transport:typeof fetch=async(url,init)=>{const u=new URL(String(url)),method=init?.method??'GET';assert.equal(init?.redirect,'error');assert(init?.signal);calls.push({method,path:u.pathname});if(u.origin==='https://api.runpod.ai'){assert.equal(u.pathname,'/v2/fixture-endpoint/health');assert.equal((init?.headers as any).Authorization,'Bearer '+(mode==='broker'?'fixture-lifecycle-secret':'fixture-restricted-inference-secret'));return Response.json(healthAllowed?{workers:{idle:0,ready:0}}:{error:'Unauthorized'},{status:healthAllowed?200:401});}assert.equal(u.origin,'https://api.runpod.io');assert.equal((init?.headers as any).Authorization,'Bearer fixture-lifecycle-secret');
   if(u.pathname==='/v2/serverless/fixture-endpoint')return Response.json({id:'fixture-endpoint',workers:{min:0,max:endpointEnabled?1:0}});
   if(u.pathname==='/v2/catalog/cpus/cpu3c')return Response.json({id:'cpu3c',ramGbPerVcpu:2,vcpu:{min:2,max:32},price:{securePerVcpu:price}});
   if(u.pathname.startsWith('/v2/network-volumes/'))return Response.json({id:u.pathname.split('/').at(-1),dataCenter:'US-NC-2',size:10,type:'HIGH_PERFORMANCE'});
   if(u.pathname==='/v2/pods'&&method==='POST'){const body=JSON.parse(String(init?.body));requests.push(body);assert.equal(body.image,release.image);assert.equal(body.args,release.args);if(mode==='broker'){assert.equal(body.env.COATRIA_INFERENCE_MODE,'coatria_broker_v1');assert.equal(Object.keys(body.env).length,12);assert(!Object.hasOwn(body.env,'RUNPOD_API_KEY'));assert(!Object.hasOwn(body.env,'COATRIA_RUNPOD_ENDPOINT_ID'));assert(!JSON.stringify(body).includes('fixture-restricted-inference-secret'));assert(!JSON.stringify(body).includes('fixture-endpoint'));}else{assert.equal(body.env.RUNPOD_API_KEY,'fixture-restricted-inference-secret');assert.equal(body.env.COATRIA_RUNPOD_ENDPOINT_ID,'fixture-endpoint');assert.equal(Object.keys(body.env).length,13);assert(!Object.hasOwn(body.env,'COATRIA_INFERENCE_MODE'));}assert(!JSON.stringify(body).includes('fixture-lifecycle-secret'));assert.equal(body.startSsh,false);assert.equal(body.startJupyter,false);assert.deepEqual(body.ports,[]);assert(!('globalNetworking'in body));const pod={...body,id:'pod-'+randomUUID(),cpu:{...body.cpu,memory:4},dataCenterId:body.dataCenterIds[0],status:'PROVISIONING',actions:['stop']};pods.push(pod);if(loseCreate)throw Error('Synthetic lost response; credentials must not be logged.');return Response.json(pod,{status:201});}
   if(u.pathname==='/v2/pods')return Response.json(malformedDiscovery?{pods:[]}:{pods:emptyDiscovery?[]:pods,pagination:{hasNextPage:false,nextCursor:null}});
   const pod=pods.find(p=>p.id===u.pathname.split('/')[3]);assert(pod,'Unexpected provider read');if(u.pathname.endsWith('/action')){assert.equal(method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),{action:'stop'});if(stopConfirmed)pod.status='EXITED';return Response.json(pod);}return Response.json(pod);
  };
  return{transport,calls,pods,requests,setEndpoint:(v:boolean)=>endpointEnabled=v,setHealth:(v:boolean)=>healthAllowed=v,setLoseCreate:(v:boolean)=>loseCreate=v,setEmpty:(v:boolean)=>emptyDiscovery=v,setMalformed:(v:boolean)=>malformedDiscovery=v,setPrice:(v:number)=>price=v,setStopConfirmed:(v:boolean)=>stopConfirmed=v,creates:()=>calls.filter(c=>c.method==='POST'&&c.path==='/v2/pods').length,stops:()=>calls.filter(c=>c.method==='POST'&&c.path.endsWith('/action')).length};
 }
 const reconcile=(provisionId:string,provider:ReturnType<typeof transportFixture>)=>reconcileStudioHostProvision(provisionId,{fetch:provider.transport});
 async function selectRuntime(a:Awaited<ReturnType<typeof fixture>>,expectedRevision=0,expiresAt=new Date(Date.now()+3600000).toISOString()){
  await query("INSERT INTO platform_operator_grants(user_id,expires_at) VALUES($1,clock_timestamp()+interval '2 hours') ON CONFLICT DO NOTHING",[a.userId]);
  const preset={...presetBase,companies:companies.filter(c=>c.companyId===a.companyId)};
  return transaction(db=>selectCompanyRuntimeConfiguration(db,a.member,'managed_agent',{clientId:randomUUID(),expectedRevision,phase:'service',expiresAt,preset,configurationHash:companyRuntimeHash(preset)}));
 }
 const revokeRuntime=(a:Awaited<ReturnType<typeof fixture>>,expectedRevision=1)=>transaction(db=>revokeCompanyRuntimeConfiguration(db,a.member,'managed_agent',{clientId:randomUUID(),expectedRevision}));
 try{
  await t.test('durable CPU configuration pins the selection epoch, works without env presets, and rejects prior approvals',async()=>{
   const a=await fixture(),legacy=(await a.plan()).provision,selected=await selectRuntime(a);
   await assert.rejects(a.start(legacy),{code:'CPU_PRESET_CHANGED'});delete process.env.COATRIA_MANAGED_CPU_PRESET;
   const plan=(await a.plan({...a.planInput,clientId:randomUUID()})).provision;
   assert.equal(plan.readiness.ready,true);assert.equal(plan.plan.runtimeConfiguration?.configurationId,selected.configuration.configurationId);assert.equal(plan.plan.runtimeConfiguration?.selectionRevision,1);
   await selectRuntime(a,1);await assert.rejects(a.start(plan),{code:'CPU_PRESET_CHANGED'});
   assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),0);
   updatePreset();await revokeRuntime(a,2);await assert.rejects(a.plan({...a.planInput,clientId:randomUUID()}),{code:'CPU_CONFIGURATION_INACTIVE'});
   assert.equal((await transaction(db=>listStudioHostProvisions(db,a.companyId))).readiness.ready,false);
  });
  await t.test('company runtime deadline must cover the requested CPU lifetime',async()=>{
   const a=await fixture();await selectRuntime(a,0,new Date(Date.now()+600000).toISOString());
   await assert.rejects(a.plan(),{code:'CPU_CONFIGURATION_EXPIRED'});
   assert.equal(Number((await query('SELECT count(*) FROM studio_host_provisions WHERE company_id=$1',[a.companyId])).rows[0].count),0);
  });
  await t.test('revocation during catalog preflight fences CPU submission without refunding approval',async()=>{
   const a=await fixture();await selectRuntime(a);const plan=(await a.plan()).provision;await a.start(plan);const cloud=transportFixture();let revoked=false;
   const transport:typeof fetch=async(url,init)=>{const response=await cloud.transport(url,init);if(!revoked&&String(url).includes('/catalog/')){revoked=true;await revokeRuntime(a);}return response;};
   await reconcileStudioHostProvision(plan.id,{fetch:transport});assert.equal(cloud.creates(),0);assert.equal((await a.get(plan.id)).phase,'stopped');
   assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),1);
  });
  await t.test('revocation during provider create stops the same CPU before returning and cleanup survives removed configuration',async()=>{
   const a=await fixture();await selectRuntime(a);const plan=(await a.plan()).provision;await a.start(plan);const cloud=transportFixture();
   const transport:typeof fetch=async(url,init)=>{const response=await cloud.transport(url,init);if(String(url).endsWith('/pods')&&init?.method==='POST')await revokeRuntime(a);return response;};
   await reconcileStudioHostProvision(plan.id,{fetch:transport});assert.equal(cloud.creates(),1);assert.equal(cloud.stops(),1);assert.equal((await a.get(plan.id)).phase,'stopping');
   delete process.env.COATRIA_MANAGED_CPU_PRESET;await reconcile(plan.id,cloud);assert.equal((await a.get(plan.id)).phase,'stopped');assert.equal((await a.get(plan.id)).readiness.ready,false);
   assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),1);updatePreset();
  });
  await t.test('registry revocation durably prioritizes its pinned CPU over older healthy polls and replays without new revisions',async()=>{
   const healthy=await fixture(),cloud=transportFixture(),healthyPlan=(await healthy.plan()).provision;await healthy.start(healthyPlan);await reconcile(healthyPlan.id,cloud);
   const target=await fixture();await selectRuntime(target);const plan=(await target.plan()).provision;await target.start(plan);await reconcile(plan.id,cloud);
   await query("UPDATE studio_host_provisions SET last_reconciled_at='2000-01-01T00:00:00Z' WHERE id=$1",[healthyPlan.id]);
   const before=(await target.get(plan.id)),input={clientId:randomUUID(),expectedRevision:1};
   await transaction(db=>revokeCompanyRuntimeConfiguration(db,target.member,'managed_agent',input));
   const requested=await target.get(plan.id);assert(requested.stopRequestedAt);assert.equal(requested.revision,before.revision+1);assert.equal(requested.phase,before.phase);
   assert.equal((await healthy.get(healthyPlan.id)).stopRequestedAt,null);assert.equal(cloud.stops(),0);
   assert.equal((await transaction(db=>revokeCompanyRuntimeConfiguration(db,target.member,'managed_agent',input))).replayed,true);assert.equal((await target.get(plan.id)).revision,requested.revision);
   const batch=await reconcileStudioHostProvisions(1,{fetch:cloud.transport});assert.equal((batch.results[0] as any).provision.id,plan.id);assert.equal(cloud.stops(),1);
   assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[target.companyId])).rows[0].count),1);
   await query("UPDATE studio_host_provisions SET phase='stopped' WHERE id=ANY($1::uuid[])",[[healthyPlan.id,plan.id]]);
  });
  await t.test('fleet batches prioritize shutdowns and rotate deterministically within each priority class',async()=>{
   const provider=transportFixture(),ids:string[]=[];provider.setStopConfirmed(false);
   const batch=async()=>{const result=await reconcileStudioHostProvisions(2,{fetch:provider.transport});return result.results.map(item=>{assert('provision'in item&&item.provision&&typeof item.provision==='object');assert('id'in item.provision&&typeof item.provision.id==='string');return item.provision.id;});};
   try{
    for(let i=0;i<9;i++){const a=await fixture(),p=(await a.plan()).provision;await a.start(p);await reconcile(p.id,provider);ids.push(p.id);provider.pods.at(-1).status='RUNNING';}
    const [healthyA,healthyB,healthyOld,expiredUnseen,expiredOld,requestedA,requestedB,leased,terminal]=ids;
    // Ordinary polling has older work than the shutdowns, including two never
    // polled rows. A timestamp tie deliberately exercises the UUID tie-breaker.
    await query("UPDATE studio_host_provisions SET phase='running',last_reconciled_at='2000-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])",[ids]);
    await query('UPDATE studio_host_provisions SET last_reconciled_at=NULL WHERE id=ANY($1::uuid[])',[[healthyA,healthyB,expiredUnseen]]);
    await query("UPDATE studio_host_provisions SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])",[[expiredUnseen,expiredOld]]);
    await query("UPDATE studio_host_provisions SET last_reconciled_at='2020-01-01T00:00:00Z' WHERE id=$1",[expiredOld]);
    await query("UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp(),last_reconciled_at='2021-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])",[[requestedA,requestedB]]);
    await query("UPDATE studio_host_provisions SET stop_requested_at=clock_timestamp(),lease_id=$2,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[leased,randomUUID()]);
    await query("UPDATE studio_host_provisions SET phase='stopped',stop_requested_at=clock_timestamp() WHERE id=$1",[terminal]);
    provider.calls.length=0;
    assert.deepEqual(await batch(),[expiredUnseen,expiredOld]);
    assert.deepEqual(await batch(),[requestedA,requestedB].sort());
    // Unconfirmed stops remain eligible, but one failing stop cannot monopolize
    // the batch ahead of other pending shutdowns with an older reconciliation.
    assert.deepEqual(await batch(),[expiredUnseen,expiredOld]);
    assert.equal(provider.stops(),6);
    assert(provider.calls.every(call=>!call.path.includes(provider.pods[7].id)&&!call.path.includes(provider.pods[8].id)));
    const urgent=[expiredUnseen,expiredOld,requestedA,requestedB];
    for(const pod of provider.pods)if(urgent.some(id=>pod.name==='coatria-cpu-'+id))pod.status='EXITED';
    assert.deepEqual(await batch(),[requestedA,requestedB].sort());
    assert.deepEqual(await batch(),[expiredUnseen,expiredOld]);
    assert.deepEqual(await batch(),[healthyA,healthyB].sort());
    assert.equal((await batch())[0],healthyOld);
    assert.equal(provider.creates(),0,'Batch polling never submits another paid create');
    assert.equal(provider.stops(),6,'Terminal readback and healthy polls issue no stop');
   }finally{await query("UPDATE studio_host_provisions SET phase='stopped',lease_id=NULL,lease_expires_at=NULL WHERE id=ANY($1::uuid[])",[ids]);}
  });
  await t.test('review is tenant scoped, idempotent, non-billing and explicit about configuration readiness',async()=>{
   const a=await fixture(),b=await fixture(),p=await a.plan();assert.equal(p.provision.phase,'planned');assert.equal(p.provision.readiness.ready,true);assert.equal((await a.plan()).provision.id,p.provision.id);assert.equal((await a.plan()).replayed,true);await assert.rejects(a.plan({...a.planInput,durationMinutes:30}),/already used/);await assert.rejects(transaction(c=>getStudioHostProvision(c,b.companyId,p.provision.id)),/not found/);
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[a.companyId,a.userId]);await assert.rejects(a.plan(),/administrator|permission|access/i);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[a.companyId,a.userId]);
   assert.equal(Number((await query('SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].count),0);delete process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY;const read=await a.get(p.provision.id);assert.equal(read.readiness.ready,false);assert(read.readiness.reasons.some(r=>r.includes('separate restricted')));await assert.rejects(a.start(p.provision),/restricted/);assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),0);process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY='fixture-lifecycle-secret';assert.equal(studioCpuReadiness(a.companyId).ready,false);process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY='fixture-restricted-inference-secret';
  });
  await t.test('approval binds the exact hash and agent revision and rolls back all stale application',async()=>{
   const a=await fixture(),p=(await a.plan()).provision;await assert.rejects(a.start(p,{clientId:randomUUID(),revision:p.revision,planHash:'b'.repeat(64),acknowledgeCharges:true,activateAgents:true}),/exact reviewed/);
   await query('UPDATE plugin_installations SET revision=revision+1 WHERE company_id=$1 AND id=$2',[a.companyId,a.installation.id]);await assert.rejects(a.start(p),/installations changed/i);assert.equal(Number((await query('SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].count),0);
  });
  await t.test('one reviewed start encrypts the host token, preserves receipts and never duplicates enrollment or reservation',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,input={clientId:randomUUID(),revision:p.revision,planHash:p.planHash,acknowledgeCharges:true,activateAgents:true},s=await a.start(p,input);assert.equal(s.provision.phase,'approved');assert(s.provision.hostId);assert.equal(s.provision.plan.reservation.cpuMicrousd,25000);const repeat=await a.start(p,input);assert.equal(repeat.replayed,true);assert.equal(repeat.provision.hostId,s.provision.hostId);
   assert.equal(Number((await query('SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].count),1);assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),1);
   const privateRow=(await query('SELECT * FROM studio_host_provisions WHERE id=$1',[p.id])).rows[0];assert(privateRow.sealed_host_token.ciphertext);assert(!JSON.stringify(privateRow).includes('ch_'));const publicText=JSON.stringify(await transaction(c=>listStudioHostProvisions(c,a.companyId)))+JSON.stringify((await query('SELECT response FROM studio_host_provision_requests WHERE company_id=$1',[a.companyId])).rows);assert.doesNotMatch(publicText,/ciphertext|hostToken|RUNPOD_API_KEY|fixture-restricted|fixture-lifecycle|ch_[A-Za-z0-9_-]{43}/);
   const provider=transportFixture();await reconcile(p.id,provider);assert.equal(provider.creates(),1);assert.equal((await a.get(p.id)).phase,'provisioning');await reconcile(p.id,provider);assert.equal(provider.creates(),1);
  });
  await t.test('a lost create response remains discovery-only across retries, absent results and later adoption',async()=>{
   const a=await fixture(),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture();provider.setLoseCreate(true);await reconcile(p.id,provider);assert.equal((await a.get(p.id)).phase,'uncertain');assert.equal(provider.creates(),1);provider.setEmpty(true);for(let i=0;i<3;i++)await reconcile(p.id,provider);assert.equal(provider.creates(),1);assert.equal((await a.get(p.id)).podId,null);
   provider.setEmpty(false);await reconcile(p.id,provider);assert.equal((await a.get(p.id)).podId,provider.pods[0].id);assert.equal(provider.creates(),1);provider.pods[0].status='RUNNING';await reconcile(p.id,provider);assert.equal((await a.get(p.id)).phase,'running');
  });
  await t.test('stop compute is independently retried until EXITED, keeps credentials and volume, and never refunds uncertain costs',async()=>{
   const a=await fixture(),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture();await reconcile(p.id,provider);let current=await a.get(p.id);const stopInput={clientId:randomUUID(),revision:current.revision};await memberMutation(a.member,true,c=>stopStudioHostProvision(c,a.member,p.id,stopInput));provider.setStopConfirmed(false);await reconcile(p.id,provider);assert.equal((await a.get(p.id)).phase,'stopping');assert.equal((await a.get(p.id)).computeStopped,false);provider.setStopConfirmed(true);await reconcile(p.id,provider);await reconcile(p.id,provider);current=await a.get(p.id);assert.equal(current.phase,'stopped');assert.equal(current.computeStopped,true);assert.equal(current.billingVerified,false);assert.equal(current.credentialsRevoked,false);assert.equal(provider.stops(),2);assert.equal(provider.creates(),1);assert.equal((await query('SELECT status FROM studio_managed_hosts WHERE id=$1',[current.hostId])).rows[0].status,'active');assert.equal(Number((await query('SELECT sum(amount_microusd) amount FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].amount),25000);assert(provider.calls.every(c=>c.method!=='DELETE'));
  });
  await t.test('hard expiry and host revocation request stop without operator action',async()=>{
   for(const revoke of [false,true]){const a=await fixture(),p=(await a.plan()).provision,s=await a.start(p),provider=transportFixture();await reconcile(p.id,provider);if(revoke)await query("UPDATE studio_managed_hosts SET status='revoked' WHERE id=$1",[s.provision.hostId]);else await query("UPDATE studio_managed_hosts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[s.provision.hostId]);await reconcile(p.id,provider);assert.equal(provider.stops(),1);await reconcile(p.id,provider);assert.equal((await a.get(p.id)).phase,'stopped');}
  });
  await t.test('stop before submission performs no create and active submission leases suppress competing pollers',async()=>{
   const a=await fixture(),p=(await a.plan()).provision,s=await a.start(p),provider=transportFixture();await query("UPDATE studio_host_provisions SET lease_id=$2,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1",[p.id,randomUUID()]);assert.equal((await reconcile(p.id,provider)).skipped,true);assert.equal(provider.calls.length,0);await query('UPDATE studio_host_provisions SET lease_id=NULL,lease_expires_at=NULL WHERE id=$1',[p.id]);await memberMutation(a.member,true,c=>stopStudioHostProvision(c,a.member,p.id,{clientId:randomUUID(),revision:s.provision.revision}));await reconcile(p.id,provider);assert.equal(provider.creates(),0);assert.equal((await a.get(p.id)).phase,'stopped');
  });
  await t.test('catalog price, ciphertext tampering and missing keys fail closed before any paid create',async()=>{
   for(const fault of ['price','ciphertext','key'] as const){const a=await fixture(),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture();if(fault==='price')provider.setPrice(.04);if(fault==='ciphertext')await query("UPDATE studio_host_provisions SET sealed_host_token=jsonb_set(sealed_host_token,'{ciphertext}','\"AAAA\"') WHERE id=$1",[p.id]);const ring=process.env.COATRIA_HOSTING_KEYRING;if(fault==='key')delete process.env.COATRIA_HOSTING_KEYRING;await reconcile(p.id,provider);process.env.COATRIA_HOSTING_KEYRING=ring;assert.equal(provider.creates(),0);assert.equal((await a.get(p.id)).phase,'failed');}
  });
  await t.test('a late enrollment rejection rolls back the new host, token rotation and reservation',async()=>{
   const a=await fixture();await query("UPDATE agents SET invocation_access='none' WHERE id=$1",[a.installation.agentId]);const p=(await a.plan()).provision,before=(await query('SELECT token_hash FROM agents WHERE id=$1',[a.installation.agentId])).rows[0].token_hash;await assert.rejects(a.start(p),/invocation is disabled/);assert.equal(Number((await query('SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),0);assert.equal((await query('SELECT token_hash FROM agents WHERE id=$1',[a.installation.agentId])).rows[0].token_hash,before);assert.equal((await a.get(p.id)).phase,'planned');
  });
  await t.test('a disabled inference endpoint or restricted-key health denial never starts CPU or enables GPU',async()=>{
   for(const disabled of [true,false]){const a=await fixture(),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture();if(disabled)provider.setEndpoint(false);else provider.setHealth(false);await reconcile(p.id,provider);const current=await a.get(p.id);assert.equal(current.phase,'failed');assert.equal(current.errorCode,'CPU_INFERENCE_UNAVAILABLE');assert.equal(current.readiness.ready,false);assert.equal(provider.creates(),0);assert(provider.calls.every(c=>c.method==='GET'));}
  });
  await t.test('mutated origin, model, provider destination, budget or token environment is rejected before further control',async()=>{
   const a=await fixture(),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture();await reconcile(p.id,provider);const env=structuredClone(provider.pods[0].env);
   for(const key of ['COATRIA_URL','COATRIA_HOST_MODEL_ID','COATRIA_RUNPOD_ENDPOINT_ID','COATRIA_HOST_CONCURRENCY','COATRIA_MAX_TOTAL_TOKENS','COATRIA_HOST_TOKEN','RUNPOD_API_KEY']){provider.pods[0].env={...env,[key]:'mutated'};await reconcile(p.id,provider);assert.equal((await a.get(p.id)).errorCode,'CPU_IDENTITY_MISMATCH');}provider.pods[0].env={...env,NODE_OPTIONS:'--inspect=0.0.0.0'};await reconcile(p.id,provider);assert.equal((await a.get(p.id)).phase,'needs_attention');assert.equal(provider.creates(),1);assert.equal(provider.stops(),0);
  });
  await t.test('foreign provider identity and duplicate uncertain names are preserved for operator reconciliation',async()=>{
   const a=await fixture(),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture();provider.setLoseCreate(true);await reconcile(p.id,provider);provider.pods.push({...provider.pods[0],id:'another-pod'});await reconcile(p.id,provider);assert.equal((await a.get(p.id)).phase,'needs_attention');assert.equal(provider.creates(),1);assert.equal(provider.stops(),0);provider.pods.pop();provider.pods[0].env.COATRIA_HOST_COMPANY_ID=randomUUID();await reconcile(p.id,provider);assert.equal((await a.get(p.id)).errorCode,'CPU_IDENTITY_MISMATCH');assert.equal(provider.stops(),0);
  });
  await t.test('preset volume reuse across tenants is rejected and a non-resetting company allowance prevents repeated starts',async()=>{
   const a=await fixture(25000),p=(await a.plan()).provision,s=await a.start(p),provider=transportFixture();await memberMutation(a.member,true,c=>stopStudioHostProvision(c,a.member,p.id,{clientId:randomUUID(),revision:s.provision.revision}));await reconcile(p.id,provider);const revision=(await query('SELECT revision FROM plugin_installations WHERE id=$1',[a.installation.id])).rows[0].revision;const next=(await a.plan({clientId:randomUUID(),durationMinutes:20,installations:[{installationId:a.installation.id,revision}]})).provision;assert.equal(next.readiness.ready,false);await assert.rejects(a.start(next),/allowance is fully reserved/);
   const original=process.env.COATRIA_MANAGED_CPU_PRESET;const corrupted=JSON.parse(original!);corrupted.companies[1].volumeId=corrupted.companies[0].volumeId;process.env.COATRIA_MANAGED_CPU_PRESET=JSON.stringify(corrupted);assert.throws(()=>studioCpuPreset(a.companyId),/own approved retained volume/);process.env.COATRIA_MANAGED_CPU_PRESET=original;
  });
  await t.test('actual HTTP routes commit approval before provider effects and keep replay, tenant and origin gates',async()=>{
   const {handleApi}=await import('../src/lib/api'),a=await fixture(),foreign=await fixture(),provider=transportFixture(),originalFetch=globalThis.fetch;globalThis.fetch=provider.transport;
   async function call(suffix:string,method='GET',body?:unknown,session=a.session,withOrigin=true){const path=`companies/${a.companyId}/studio/host-provisions`+suffix,response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Cookie:'coatria_session='+session,...withOrigin?{Origin:origin}:{},...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}}),path.split('/'));return{status:response.status,data:await response.json()};}
   try{assert.equal((await call('','POST',a.planInput,a.session,false)).status,403);const planned=await call('','POST',a.planInput);assert.equal(planned.status,201);assert.equal(provider.calls.length,0);const p=planned.data.provision;assert.equal((await call('/'+p.id,'GET',undefined,foreign.session)).status,404);const input={clientId:randomUUID(),revision:p.revision,planHash:p.planHash,acknowledgeCharges:true,activateAgents:true};const started=await call('/'+p.id+'/start','POST',input);assert.equal(started.status,200);assert.equal(started.data.provision.phase,'provisioning');assert.equal(provider.creates(),1);assert.equal((await call('/'+p.id+'/start','POST',input)).data.replayed,true);assert.equal(provider.creates(),1);const current=(await call('/'+p.id)).data.provision;const stopped=await call('/'+p.id+'/stop','POST',{clientId:randomUUID(),revision:current.revision});assert.equal(stopped.status,200);assert.equal(stopped.data.provision.phase,'stopping');const reconciled=await call('/'+p.id+'/reconcile','POST',{clientId:randomUUID()});assert.equal(reconciled.data.provision.phase,'stopped');assert.equal(reconciled.data.provision.billingVerified,false);assert.doesNotMatch(JSON.stringify(reconciled),/ciphertext|fixture-lifecycle|fixture-restricted/);}finally{globalThis.fetch=originalFetch;}
  });
  await t.test('an agent pause between approval and provider submission prevents the paid create',async()=>{
   const a=await fixture(),p=(await a.plan()).provision;await a.start(p);await query("UPDATE agents SET status='paused' WHERE id=$1",[a.installation.agentId]);const provider=transportFixture();await reconcile(p.id,provider);assert.equal(provider.creates(),0);assert.equal((await a.get(p.id)).errorCode,'CPU_INSTALLATION_CHANGED');
  });
  await t.test('explicit broker approval uses only the server key and never copies provider credentials or endpoint into the Pod',async()=>{
   const a=await fixture(500000,brokerInference),prior=process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY;delete process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY;
   try{assert.equal(studioCpuReadiness(a.companyId).ready,true);const p=(await a.plan()).provision;assert.deepEqual(p.plan.inference,{...brokerInference,previouslyReservedMicrousd:0,billingVerified:false});assert.equal(p.plan.effects.startGpu,false);assert.equal(p.plan.reservation.inferenceIncluded,false);await a.start(p);const provider=transportFixture('broker');await reconcile(p.id,provider);assert.equal(provider.creates(),1);assert.equal((await a.get(p.id)).phase,'provisioning');assert(provider.calls.some(call=>call.path==='/v2/fixture-endpoint/health'));assert(provider.calls.every(call=>call.method==='GET'||call.path==='/v2/pods'));const payload=provider.requests[0];assert.equal(payload.env.COATRIA_INFERENCE_MODE,'coatria_broker_v1');assert.equal(Object.keys(payload.env).length,12);assert(!Object.keys(payload.env).some(key=>/RUNPOD|INFERENCE_KEY|LIFECYCLE/.test(key)));const stored=(await query('SELECT expected_environment_hashes FROM studio_host_provisions WHERE id=$1',[p.id])).rows[0].expected_environment_hashes;assert.equal(Object.keys(stored).length,12);assert.equal(stored.COATRIA_INFERENCE_MODE,hashToken('coatria_broker_v1'));assert(!Object.hasOwn(stored,'RUNPOD_API_KEY'));const publicResult=JSON.stringify(await a.get(p.id));assert.doesNotMatch(publicResult,/fixture-lifecycle|fixture-restricted|ciphertext|hostToken|ch_[A-Za-z0-9_-]{43}/);
   }finally{process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY=prior;updatePreset();}
  });
  await t.test('broker is an explicit reviewed transport: toggling it invalidates old plans and direct plans never fall back',async()=>{
   const a=await fixture(),direct=(await a.plan()).provision;assert.equal(direct.plan.inference,undefined);updatePreset(brokerInference);await assert.rejects(a.start(direct),/preset changed/i);assert.equal(Number((await query('SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].count),0);
   const broker=(await a.plan({...a.planInput,clientId:randomUUID()})).provision;assert(broker.plan.inference);updatePreset();await assert.rejects(a.start(broker),/preset changed/i);const key=process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY;delete process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY;try{assert.equal(studioCpuReadiness(a.companyId).ready,false);await assert.rejects(a.start(direct),/restricted/);}finally{process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY=key;}assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),0);
  });
  await t.test('broker mode still requires server credentials and enabled inference without starting GPU capacity',async()=>{
   for(const fault of ['server_key','endpoint','health'] as const){const a=await fixture(500000,brokerInference),provider=transportFixture('broker'),key=process.env.MANAGED_RUNPOD_API_KEY,p=(await a.plan()).provision;if(fault==='server_key'){delete process.env.MANAGED_RUNPOD_API_KEY;try{assert.equal(studioCpuReadiness(a.companyId).ready,false);await assert.rejects(a.start(p),/credential|configuration/i);}finally{process.env.MANAGED_RUNPOD_API_KEY=key;}assert.equal(provider.calls.length,0);}else{await a.start(p);if(fault==='endpoint')provider.setEndpoint(false);else provider.setHealth(false);await reconcile(p.id,provider);assert.equal((await a.get(p.id)).errorCode,'CPU_INFERENCE_UNAVAILABLE');assert.equal(provider.creates(),0);assert(provider.calls.every(call=>call.method==='GET'));}}updatePreset();
  });
  await t.test('broker environment tampering or attempted direct-key fallback blocks further provider control',async()=>{
   const a=await fixture(500000,brokerInference),p=(await a.plan()).provision;await a.start(p);const provider=transportFixture('broker');await reconcile(p.id,provider);assert.equal(provider.creates(),1);const original=structuredClone(provider.pods[0].env);
   for(const patch of [{COATRIA_INFERENCE_MODE:'direct'},{COATRIA_URL:'https://not-the-approved-origin.invalid'},{COATRIA_HOST_MODEL_ID:'unapproved-model'},{COATRIA_MAX_TOTAL_TOKENS:'999999'},{RUNPOD_API_KEY:'unexpected-key'},{COATRIA_RUNPOD_ENDPOINT_ID:'unexpected-endpoint'}]){provider.pods[0].env={...original,...patch};await reconcile(p.id,provider);assert.equal((await a.get(p.id)).errorCode,'CPU_IDENTITY_MISMATCH');}provider.pods[0].env={...original};delete provider.pods[0].env.COATRIA_INFERENCE_MODE;await reconcile(p.id,provider);assert.equal((await a.get(p.id)).errorCode,'CPU_IDENTITY_MISMATCH');assert.equal(provider.creates(),1);assert.equal(provider.stops(),0);updatePreset();
  });
  await t.test('broker approval cannot start CPU when its inference allowance cannot cover one bounded model step',async()=>{
   const a=await fixture(500000,{...brokerInference,lifetimeAllowanceMicrousd:1}),p=(await a.plan()).provision;assert.equal(p.plan.inference?.lifetimeAllowanceMicrousd,1);await assert.rejects(a.start(p),/inference allowance/i);assert.equal((await a.get(p.id)).phase,'planned');assert.equal(Number((await query('SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1',[a.companyId])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),0);updatePreset();
  });
  await t.test('real PostgreSQL concurrent approvals and reconcilers create exactly one host, reservation and Pod',{skip:emulate},async()=>{
   const a=await fixture(),p=(await a.plan()).provision,input={clientId:randomUUID(),revision:p.revision,planHash:p.planHash,acknowledgeCharges:true,activateAgents:true};const approvals=await Promise.all([a.start(p,input),a.start(p,input)]);assert.equal(approvals.filter(r=>r.replayed).length,1);assert.equal(approvals[0].provision.hostId,approvals[1].provision.hostId);assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[a.companyId])).rows[0].count),1);const provider=transportFixture();await Promise.all([reconcile(p.id,provider),reconcile(p.id,provider),reconcile(p.id,provider)]);assert.equal(provider.creates(),1);assert.equal((await a.get(p.id)).phase,'provisioning');
  });
 }finally{await transaction(async db=>{await db.query("SET LOCAL session_replication_role='replica'");const ids=companies.map(c=>c.companyId);await db.query('DELETE FROM company_runtime_requests WHERE company_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM company_runtime_selections WHERE company_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM company_runtime_configurations WHERE company_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM platform_operator_grants WHERE user_id=ANY($1::uuid[])',[owners]);});await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies.map(c=>c.companyId)]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[owners]);await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
