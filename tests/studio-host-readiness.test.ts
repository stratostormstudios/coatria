import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {projectStudioProviderCheck,probeStudioHostProviders,readStudioHostProviderReadiness} from '../src/lib/studio-host-readiness';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {studioHostProvisioningRoute} from '../src/lib/studio-host-provisioning-api';
import {buildStudioBootstrap} from '../scripts/hosting/build-studio-bootstrap.mjs';
import {trustedServiceHash} from '../src/lib/company-runtime-preset';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import type {Membership} from '../src/lib/auth';

const endpointId='fixture-endpoint',settings={NODE_ENV:'test',MANAGED_RUNPOD_API_KEY:'fixture-lifecycle-private',COATRIA_MANAGED_RUNPOD_INFERENCE_KEY:'fixture-inference-private'} satisfies NodeJS.ProcessEnv,inference={mode:'coatria_broker_v1' as const,maxJobs:8,maxHourlyMicrousd:2000000,lifetimeAllowanceMicrousd:15000000};
test('independent fixed GETs check health even with max0; only safe numeric projection escapes',async()=>{
 const calls:Array<{url:string;init:RequestInit|undefined}>=[];
 const transport:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(String(url).includes('/serverless/')?{id:endpointId,type:'QUEUE',workers:{max:0,min:0},env:{SECRET:settings.MANAGED_RUNPOD_API_KEY},requestUrls:['https://private.invalid']}: {workers:{idle:0,ready:0,running:0,unhealthy:'PRIVATE_REASON'},message:settings.MANAGED_RUNPOD_API_KEY});};
 const result=await probeStudioHostProviders({endpointId,inference},settings,transport);
 assert.deepEqual(calls.map(c=>c.url),['https://api.runpod.io/v2/serverless/fixture-endpoint','https://api.runpod.ai/v2/fixture-endpoint/health']);
 for(const c of calls){assert.equal(c.init?.method,'GET');assert.equal(c.init?.redirect,'manual');assert.equal(c.init?.cache,'no-store');assert(c.init?.signal);assert.equal((c.init?.headers as any).Authorization,'Bearer '+settings.MANAGED_RUNPOD_API_KEY);assert.equal(c.init?.body,undefined);}
 assert.equal(result[0].code,'endpoint_disabled');assert.equal(result[0].workersMax,0);assert.equal(result[1].ready,true);assert.equal(result[1].workerCounts?.unhealthy,null);
 const serialized=JSON.stringify(result);for(const forbidden of [settings.MANAGED_RUNPOD_API_KEY,'PRIVATE_REASON','https://private.invalid','requestUrls','SECRET'])assert(!serialized.includes(forbidden));
});
test('management denial does not hide health authorization and legacy uses only its exact separate key',async()=>{
 let n=0;const calls:string[]=[];const checks=await probeStudioHostProviders({endpointId},settings,async(url,init)=>{n++;calls.push((init?.headers as any).Authorization);return new Response('private auth error '+settings.MANAGED_RUNPOD_API_KEY,{status:String(url).includes('/serverless/')?403:401});});
 assert.equal(n,2);assert.deepEqual(calls,['Bearer '+settings.MANAGED_RUNPOD_API_KEY,'Bearer '+settings.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY]);assert.deepEqual(checks.map(c=>c.code),['http_unauthorized','http_unauthorized']);assert(!JSON.stringify(checks).includes('private auth error'));
 let missingCalls=0;const missing=await probeStudioHostProviders({endpointId,inference},{NODE_ENV:'test'},async()=>{missingCalls++;throw Error();});assert.equal(missingCalls,0);assert.deepEqual(missing.map(c=>c.code),['credential_missing','credential_missing']);
});
test('redirects, body limits, malformed JSON and network failures are bounded and secret-free',async()=>{
 for(const [response,expected]of [[()=>new Response('private',{status:302,headers:{Location:'https://attacker.invalid'}}),'redirect_rejected'],[()=>new Response(new Uint8Array(2*1024*1024+1)),'response_too_large'],[()=>new Response('tiny',{headers:{'Content-Length':String(2*1024*1024+1)}}),'response_too_large'],[()=>new Response('not json private'),'invalid_json']]as const){let calls=0;const checks=await probeStudioHostProviders({endpointId,inference},settings,async()=>{calls++;return response();});assert.equal(calls,2);assert(checks.every(c=>c.code===expected));}
 const failed=await probeStudioHostProviders({endpointId,inference},settings,async()=>{throw Error(settings.MANAGED_RUNPOD_API_KEY);});assert(failed.every(c=>c.code==='network_error'));assert(!JSON.stringify(failed).includes(settings.MANAGED_RUNPOD_API_KEY));
 await assert.rejects(probeStudioHostProviders({endpointId:'../foreign',inference},settings,async()=>{throw Error('must not dispatch');}),{code:'CPU_READINESS_SCOPE_INVALID'});
});
test('provider shape errors distinguish mismatched endpoint, numeric type and malformed health workers',()=>{
 assert.equal(projectStudioProviderCheck('lifecycle',endpointId,{id:'other',workers:{max:1}},200).code,'endpoint_mismatch');
 const shape=projectStudioProviderCheck('lifecycle',endpointId,{id:endpointId,workers:{max:'1'}},200);assert.equal(shape.code,'worker_limit_invalid');assert.equal(shape.workersMaxType,'string');assert.equal(shape.workersMax,null);
 for(const workers of [null,[],0,'private'])assert.equal(projectStudioProviderCheck('health',endpointId,{workers},200).code,'health_workers_invalid');
 assert.equal(projectStudioProviderCheck('health',endpointId,{workers:{}},200).ready,true);
});
test('OpenAPI readiness is a bounded human-admin GET and cannot authorize a provider action',()=>{
 const spec:any=agentRuntimeOpenApi,path=spec.paths['/api/companies/{companyId}/studio/host-provisions/{provisionId}/readiness'];assert.deepEqual(Object.keys(path),['get']);assert.deepEqual(path.get.security,[{sessionCookie:[]}]);assert.deepEqual(path.get['x-coatria-roles'],['owner','admin']);assert.equal(path.get.requestBody,undefined);assert.match(path.get.description,/two independent GET/);assert.match(path.get.description,/after configuration revocation/);
 const schema=spec.components.schemas.StudioHostProviderReadiness;assert.equal(schema.properties.readOnly.const,true);assert.equal(schema.properties.authorizesStart.const,false);assert.equal(schema.properties.checks.maxItems,2);assert.equal(spec.info.version,'1.16.0');
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('readiness uses actual scoped stored provision and current admin authority across provider I/O',{skip:!emulate&&!integrationUrl,timeout:180000},async t=>{
 const before={NODE_ENV:process.env.NODE_ENV,DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,MANAGED_RUNPOD_API_KEY:process.env.MANAGED_RUNPOD_API_KEY,COATRIA_MANAGED_RUNPOD_INFERENCE_KEY:process.env.COATRIA_MANAGED_RUNPOD_INFERENCE_KEY};
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 Object.assign(process.env,settings);const companyId=randomUUID(),userId=randomUUID(),session=randomUUID(),configId=randomUUID(),provisionId=randomUUID(),deadline=new Date(Date.now()+3600000).toISOString();
 const bootstrap=await buildStudioBootstrap({root:process.cwd(),commit:'a'.repeat(40)}),company={companyId,volumeId:'fixture-volume',dataCenterId:'US-NC-2',lifetimeAllowanceMicrousd:500000};
 const rawPreset={id:'readiness-fixture',releaseCommit:'a'.repeat(40),bootstrapArgs:bootstrap.args,bootstrapHash:hashToken(bootstrap.args),modelId:'Qwen/Qwen3.8-27B-FP8',endpointId,maxHourlyMicrousd:100000,maxSteps:8,maxOutputTokens:8192,maxTotalTokens:100000,timeoutSeconds:600,inference};
 const preset={...rawPreset,company},configuration={...rawPreset,companies:[company]},configurationHash=trustedServiceHash(configuration),runtimeConfiguration={configurationId:configId,selectionRevision:1,configurationHash,expiresAt:deadline},plan={version:1,companyId,preset:{hash:trustedServiceHash(preset)},runtimeConfiguration},planHash=trustedServiceHash(plan);
 const member={companyId,userId,role:'owner',user:{id:userId,name:'Diagnostic owner',email:userId+'@example.invalid'}} as Membership;
 const invoke=(fetch:typeof globalThis.fetch)=>readStudioHostProviderReadiness(member,provisionId,{fetch,settings});
 let calls=0;const ok:typeof fetch=async url=>{calls++;return Response.json(String(url).includes('/serverless/')?{id:endpointId,workers:{min:0,max:1}}:{workers:{idle:0,ready:0}});};
 try{
  await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Diagnostic owner',$2,'fixture')",[userId,userId+'@example.invalid']);await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Readiness fixture',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),userId]);
  await query("INSERT INTO company_runtime_configurations(id,company_id,kind,phase,preset,configuration_hash,worker_volume_id,expires_at,created_by) VALUES($1,$2,'managed_agent','service',$3,$4,'fixture-volume',$5,$6)",[configId,companyId,JSON.stringify(configuration),configurationHash,deadline,userId]);await query("INSERT INTO company_runtime_selections(company_id,kind,configuration_id,revision,state,selected_by) VALUES($1,'managed_agent',$2,1,'active',$3)",[companyId,configId,userId]);
  await query("INSERT INTO studio_host_provisions(id,company_id,created_by,client_id,request_hash,plan,plan_hash,preset,pod_name,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed')",[provisionId,companyId,userId,randomUUID(),'b'.repeat(64),JSON.stringify(plan),planHash,JSON.stringify(preset),'fixture-'+provisionId]);
  await t.test('current selection succeeds without writes or spending, revoked selection still diagnoses provider safely',async()=>{
   const snapshot=JSON.stringify((await query('SELECT * FROM studio_host_provisions WHERE id=$1',[provisionId])).rows);const first=await invoke(ok);assert.equal(first.ready,true);assert.equal(first.authorizesStart,false);assert.equal(calls,2);assert.equal(JSON.stringify((await query('SELECT * FROM studio_host_provisions WHERE id=$1',[provisionId])).rows),snapshot);assert.equal(Number((await query('SELECT count(*) FROM studio_host_compute_reservations WHERE company_id=$1',[companyId])).rows[0].count),0);
   await query("UPDATE company_runtime_selections SET state='revoked',revision=2 WHERE company_id=$1",[companyId]);const historical=await invoke(ok);assert.equal(historical.ready,false);assert.equal(historical.providerReady,true);assert.equal(historical.configuration.state,'inactive');assert.equal(calls,4);
  });
  await t.test('wrong company, tampered plan and non-admin membership dispatch no provider reads',async()=>{
   const start=calls;await assert.rejects(readStudioHostProviderReadiness({...member,companyId:randomUUID()},provisionId,{fetch:ok,settings}));await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companyId,userId]);await assert.rejects(invoke(ok),{status:403});await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[companyId,userId]);await query("UPDATE studio_host_provisions SET plan_hash=$2 WHERE id=$1",[provisionId,'c'.repeat(64)]);await assert.rejects(invoke(ok),{code:'CPU_READINESS_SCOPE_INVALID'});await query('UPDATE studio_host_provisions SET plan_hash=$2 WHERE id=$1',[provisionId,planHash]);assert.equal(calls,start);
  });
  await t.test('membership access revoked during provider read suppresses the complete result',async()=>{
   let changed=false;const revoke:typeof fetch=async(url,init)=>{if(!changed){changed=true;await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[companyId,userId]);}return ok(url,init);};await assert.rejects(invoke(revoke),{code:'CPU_READINESS_ADMIN_REQUIRED'});await query('UPDATE memberships SET access_revoked_at=NULL WHERE company_id=$1 AND user_id=$2',[companyId,userId]);
  });
  await t.test('real authenticated GET rejects query overrides, returns no-store metadata and rate-limits repeated checks',async()=>{
   const path=`companies/${companyId}/studio/host-provisions/${provisionId}/readiness`,request=(suffix='')=>new Request('http://localhost:4180/api/'+path+suffix,{headers:{Cookie:'coatria_session='+session}});const mock=t.mock.method(globalThis,'fetch',ok);
   try{await assert.rejects(studioHostProvisioningRoute(request('?endpointId=foreign'),path.split('/'),'GET'),{code:'VALIDATION_ERROR'});for(let i=0;i<4;i++){const response=await studioHostProvisioningRoute(request(),path.split('/'),'GET');assert(response);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');const body=await response.json();assert.equal(body.readiness.provisionId,provisionId);assert(!JSON.stringify(body).includes(settings.MANAGED_RUNPOD_API_KEY));}await assert.rejects(studioHostProvisioningRoute(request(),path.split('/'),'GET'),{status:429});}finally{mock.mock.restore();}
  });
 }finally{await query('DELETE FROM companies WHERE id=$1',[companyId]).catch(()=>{});await query('DELETE FROM users WHERE id=$1',[userId]).catch(()=>{});await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
