import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {database,query,transaction} from '../src/lib/db';
import {hashToken,errorResponse} from '../src/lib/security';
import {setupStudio,createStudioProject} from '../src/lib/studio';
import {studioExecutionRoute,submitStudioExecution,validateExecutionManifest} from '../src/lib/studio-execution';
import {handleApi} from '../src/lib/api';
import {EXECUTION_BUILTIN_PROFILES,executionPlanInput,executionConnectorInput,executionStorageKey,executionManifestInput} from '../src/lib/studio-execution-protocol';

const profile=EXECUTION_BUILTIN_PROFILES[0],spec={width:128,height:128,fpsNumerator:24000,fpsDenominator:1001,format:'exr' as const,colorSpace:'Linear Rec.709'};
const manifest=()=>({schemaVersion:1 as const,engineVersion:'fixture-renderer-1',spec,verification:{fileHashes:true as const,fileSizes:true as const,frameCoverage:true,imageMetadata:true},files:[{path:'frames/0001.exr',kind:'image' as const,frame:1,sha256:'a'.repeat(64),bytes:40},{path:'frames/0002.exr',kind:'image' as const,frame:2,sha256:'b'.repeat(64),bytes:42},{path:'scene.blend',kind:'scene' as const,sha256:'c'.repeat(64),bytes:60},{path:'preview.png',kind:'media' as const,sha256:'d'.repeat(64),bytes:50}]});

test('execution contracts exclude executable commands and URLs and preserve native output evidence',()=>{
 for(const key of['../secret','a/../b','a//b','/absolute','C:/secret','a\\b','https://example.invalid/file','a/%2e%2e/b'])assert.equal(executionStorageKey.safeParse(key).success,false,key);
 const data={projectId:randomUUID(),revision:1,workItemId:randomUUID(),connectorId:randomUUID(),profileKey:profile.key,profileVersion:1,inputIds:[],frameStart:1,frameEnd:2,outputKind:'image_sequence'};
 assert(executionPlanInput.safeParse(data).success);for(const field of ['clientId','approvedBy','command','shell','url','providerKey','companyId'])assert.equal(executionPlanInput.safeParse({...data,[field]:'not-authorized'}).success,false);
 assert(executionConnectorInput.safeParse({clientId:randomUUID(),name:'Fixture',profiles:[profile]}).success);assert.equal(executionConnectorInput.safeParse({clientId:randomUUID(),name:'Fixture',profiles:[{...profile,command:'blender'}]}).success,false);
 const output=manifest(),job={profile,spec,outputKind:'image_sequence',frameStart:1,frameEnd:2};assert.deepEqual(validateExecutionManifest(job,output),output);
 for(const bad of[{...output,files:output.files.slice(1)},{...output,files:[output.files[0],{...output.files[1],frame:1}]},{...output,spec:{...spec,width:256}},{...output,verification:{...output.verification,imageMetadata:false}},{...output,files:[...output.files,{...output.files[0],path:'other.exr',frame:3}]}])assert.throws(()=>validateExecutionManifest(job,bad),{status:400});
 assert.equal(executionManifestInput.safeParse({...output,verifiedByHuman:true}).success,false);
 assert.doesNotThrow(()=>validateExecutionManifest({...job,outputKind:'scene'},{...output,files:[output.files[2]],verification:{...output.verification,frameCoverage:false,imageMetadata:false}}));
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',connection=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('durable execution APIs enforce approval, tenant scope, lease fencing and immutable connector evidence',{skip:!emulate&&!connection,timeout:180000},async t=>{
 process.env.DATABASE_URL=connection;process.env.DATABASE_POOL_MAX='4';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:4});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const companies=[randomUUID(),randomUUID()],users={owner:randomUUID(),reviewer:randomUUID(),member:randomUUID(),outsider:randomUUID()},sessions=Object.fromEntries(Object.keys(users).map(key=>[key,randomUUID()])),origin='http://localhost:4180';
 let projectId='',workItemId='',connectorId='',token='',foreignConnector='',foreignToken='';const prefix=()=>`companies/${companies[0]}/studio/execution`;
 async function call(path:string,method='GET',payload?:unknown,actor='owner',expected=200){const headers:Record<string,string>=actor==='connector'||actor==='foreignConnector'?{Authorization:'Bearer '+(actor==='connector'?token:foreignToken)}:{Cookie:'coatria_session='+sessions[actor],Origin:origin};if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),path.split('?')[0].split('/'));const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;}
 const submit=(extra:Record<string,unknown>={},expected=201)=>call(prefix()+'/jobs','POST',{clientId:randomUUID(),projectId,revision:1,workItemId,connectorId,profileKey:profile.key,profileVersion:1,inputIds:[],frameStart:1,frameEnd:2,outputKind:'image_sequence',...extra},'owner',expected);
 const approve=(job:any,expected=200)=>call(prefix()+`/jobs/${job.id}/approve`,'POST',{clientId:randomUUID(),revision:job.revision},'reviewer',expected);
 const claim=(claimId=randomUUID(),actor='connector',expected=200)=>call('execution/jobs/claim','POST',{claimId,workerId:'execution-fixture'},actor,expected);
 async function cancel(job:any){return call(prefix()+`/jobs/${job.id}/cancel`,'POST',{clientId:randomUUID(),revision:job.revision});}
 try{
  for(const[key,userId]of Object.entries(users)){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,key,userId+'@example.invalid','fixture']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[key]),userId]);}
  for(const companyId of companies)await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Execution fixture',$2,'blank')",[companyId,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[companies[0],users.owner,users.reviewer,users.member,companies[1],users.outsider]);
  await transaction(async client=>{const actor={companyId:companies[0],userId:users.owner};await setupStudio(client,actor,{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:0,assignments:[]});const made=await createStudioProject(client,actor,{clientId:randomUUID(),name:'Execution fixture project',clientName:'Synthetic client',brief:'A controlled two-frame procedural fixture.',spec,aiPolicy:'allowed',shots:[{code:'SH010',description:'Fixture turntable.',frameStart:1,frameEnd:2,handles:0,disciplines:['compositing']}]});projectId=made.project.id;});
  workItemId=(await query("SELECT id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND execution='dcc'",[companies[0],projectId])).rows[0].id;
  await query("UPDATE tasks SET status='done' WHERE id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage IN ('estimate','breakdown','ingest'))",[companies[0],projectId]);
  await query('UPDATE studio_projects SET gates=$3 WHERE company_id=$1 AND id=$2',[companies[0],projectId,JSON.stringify({brief:{decision:'approved'},production:{decision:'approved'}})]);
  await t.test('registration is administrator-only, one-time and never accepts tenant injection',async()=>{
   const registration={clientId:randomUUID(),name:'Procedural test connector',profiles:[profile]};await call(prefix()+'/connectors','POST',registration,'member',403);await call(prefix()+'/connectors','POST',registration,'outsider',404);
   const installed=await call(prefix()+'/connectors','POST',registration,'owner',201);connectorId=installed.connector.id;token=installed.token;assert.match(token,/^ce_/);assert(!JSON.stringify(installed.connector).includes(token));
   const replay=await call(prefix()+'/connectors','POST',registration);assert.equal(replay.token,null);assert.equal(replay.connector.id,connectorId);
   await call(prefix()+'/connectors','POST',{...registration,name:'Changed'},'owner',409);await call(prefix()+'/connectors','POST',{...registration,companyId:companies[1]},'owner',400);
   const other=await call(`companies/${companies[1]}/studio/execution/connectors`,'POST',{clientId:randomUUID(),name:'Foreign fixture',profiles:[profile]},'outsider',201);foreignConnector=other.connector.id;foreignToken=other.token;
   assert.equal((await call('execution/identity','GET',undefined,'connector')).connector.id,connectorId);
  });
  await t.test('only bounded DCC proposals queue after exact human approval, with one pending effect',async()=>{
   await submit({connectorId:foreignConnector},404);await submit({revision:2},409);await submit({frameEnd:3},400);await submit({profileKey:'unknown'},400);
   await query("UPDATE studio_projects SET ai_policy='unknown' WHERE id=$1",[projectId]);await submit({},409);await query("UPDATE studio_projects SET ai_policy='allowed' WHERE id=$1",[projectId]);
   const requestId=randomUUID(),first=await submit({clientId:requestId}),replay=await submit({clientId:requestId},200);assert.equal(replay.job.id,first.job.id);assert.equal(replay.replayed,true);assert.equal(first.job.status,'awaiting_approval');assert.equal((await claim()).job,null);
   await submit({},409);await call(prefix()+`/jobs/${first.job.id}/approve`,'POST',{clientId:randomUUID(),revision:1},'member',403);
   const queued=await approve(first.job);assert.equal(queued.job.status,'queued');await approve(first.job,409);const claimed=await claim();assert.equal(claimed.job.id,first.job.id);assert.equal(claimed.job.profile.key,profile.key);assert.deepEqual(claimed.job.inputReferences,[]);await cancel(claimed.job);
  });
  await t.test('lost claim and completion responses replay without another execution or manifest',async()=>{
   const queued=await approve((await submit()).job),claimId=randomUUID(),leased=await claim(claimId),replay=await claim(claimId);assert.equal(leased.job.id,queued.job.id);assert.equal(replay.leaseToken,leased.leaseToken);assert.equal(replay.leaseExpiresAt,leased.leaseExpiresAt);assert.equal((await claim()).job,null);
   const body={clientId:randomUUID(),leaseToken:leased.leaseToken,manifest:manifest()};await call(`execution/jobs/${leased.job.id}/complete`,'POST',body,'foreignConnector',404);await call(`execution/jobs/${leased.job.id}/complete`,'POST',{...body,leaseToken:'wrong-lease-token-at-least-twenty'},'connector',409);
   await call(`execution/jobs/${leased.job.id}/complete`,'POST',{...body,manifest:{...body.manifest,files:body.manifest.files.slice(1)}},'connector',400);
   const completed=await call(`execution/jobs/${leased.job.id}/complete`,'POST',body,'connector');assert.equal(completed.job.status,'succeeded');assert.equal(completed.job.output.verificationSource,'connector_reported');assert.equal(completed.job.independentlyReviewed,false);
   await query("UPDATE studio_projects SET status='delivered' WHERE id=$1",[projectId]);const repeated=await call(`execution/jobs/${leased.job.id}/complete`,'POST',body,'connector');assert.equal(repeated.replayed,true);assert.deepEqual(repeated.job,completed.job);await query("UPDATE studio_projects SET status='intake' WHERE id=$1",[projectId]);
   await call(`execution/jobs/${leased.job.id}/complete`,'POST',{...body,manifest:{...body.manifest,engineVersion:'Changed'}},'connector',409);await claim(claimId,'connector',409);
   assert.equal((await query('SELECT count(*)::int AS count FROM studio_execution_manifests WHERE job_id=$1',[leased.job.id])).rows[0].count,1);assert.equal((await query('SELECT count(*)::int AS count FROM studio_artifacts WHERE project_id=$1',[projectId])).rows[0].count,0);
  });
  await t.test('competing connector claims grant only one execution lease',async()=>{
   await approve((await submit()).job);const claims=await Promise.all([claim(),claim()]);assert.equal(claims.filter(result=>result.job).length,1);const leased=claims.find(result=>result.job)!;assert.equal((await query("SELECT count(*)::int AS count FROM studio_execution_jobs WHERE company_id=$1 AND connector_id=$2 AND status='running'",[companies[0],connectorId])).rows[0].count,1);await cancel(leased.job);
  });
  await t.test('cancelled and expired leases cannot complete, while failure is terminal and retry-safe',async()=>{
   await approve((await submit()).job);const leased=await claim();await query("UPDATE studio_projects SET status='delivered' WHERE id=$1",[projectId]);await cancel(leased.job);await query("UPDATE studio_projects SET status='intake' WHERE id=$1",[projectId]);await call(`execution/jobs/${leased.job.id}/heartbeat`,'POST',{leaseToken:leased.leaseToken},'connector',409);await call(`execution/jobs/${leased.job.id}/complete`,'POST',{clientId:randomUUID(),leaseToken:leased.leaseToken,manifest:manifest()},'connector',409);
   await approve((await submit()).job);const expired=await claim();await query("UPDATE studio_execution_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.job.id]);const read=(await call(prefix()+`/jobs/${expired.job.id}`)).job;assert.equal(read.leaseExpired,true);assert.equal(read.effectiveStatus,'failed_uncertain');await call(`execution/jobs/${expired.job.id}/heartbeat`,'POST',{leaseToken:expired.leaseToken},'connector',409);assert.equal((await claim()).job,null);assert.equal((await call(prefix()+`/jobs/${expired.job.id}`)).job.status,'failed_uncertain');
   await approve((await submit()).job);const failed=await claim(),failure={clientId:randomUUID(),leaseToken:failed.leaseToken,reason:'renderer_failed'};assert.equal((await call(`execution/jobs/${failed.job.id}/fail`,'POST',failure,'connector')).job.status,'failed');assert.equal((await call(`execution/jobs/${failed.job.id}/fail`,'POST',failure,'connector')).replayed,true);assert.equal((await claim()).job,null);
  });
  await t.test('references remain immutable and tenant-bound; cursor pages are complete and explicit',async()=>{
   const ids=[];for(let index=0;index<4;index++)ids.push((await call(prefix()+'/inputs','POST',{clientId:randomUUID(),projectId,name:'Scene '+index,kind:'scene',storageKey:`approved/scene-${index}.blend`,sha256:'e'.repeat(64),bytes:100},'owner',201)).input.id);
   const seen:string[]=[];let after:string|undefined;do{const result=await call(prefix()+`?projectId=${projectId}&kind=inputs&limit=2${after?'&after='+after:''}`);seen.push(...result.inputs.map((input:any)=>input.id));after=result.page.nextAfter??undefined;}while(after);assert.deepEqual(seen,ids.sort());assert.equal((await call(prefix()+`/inputs/${ids[0]}`)).input.sha256,'e'.repeat(64));
   await call(prefix()+`?kind=jobs&after=${randomUUID()}`,'GET',undefined,'owner',404);await call(`companies/${companies[1]}/studio/execution/inputs/${ids[0]}`,'GET',undefined,'outsider',404);await submit({inputIds:[ids[0]]},400);
   const jobs=await call(prefix()+'?kind=jobs&limit=2');assert.equal(jobs.page.hasMore,true);assert(jobs.jobs.every((job:any)=>!('inputReferences'in job)));assert.equal((await call(prefix()+'?kind=connectors')).connectors[0].id,connectorId);
  });
  await t.test('source-agent capability and role checks survive a job approval without granting execution implicitly',async()=>{
   const agentId=randomUUID();await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Execution agent','custom',$3,$4,'admins','[\"studio.write\"]')",[agentId,companies[0],hashToken('fixture-'+randomUUID()),users.owner]);
   await assert.rejects(()=>transaction(client=>submitStudioExecution(client,{companyId:companies[0],userId:users.owner,agentId,runId:randomUUID()},{clientId:randomUUID(),projectId,revision:1,workItemId,connectorId,profileKey:profile.key,profileVersion:1,inputIds:[],frameStart:1,frameEnd:2,outputKind:'image_sequence'})),{status:403});
   await approve((await submit()).job);const leased=await claim();await query('UPDATE studio_execution_jobs SET requested_agent_id=$2 WHERE id=$1',[leased.job.id,agentId]);await call(`execution/jobs/${leased.job.id}/heartbeat`,'POST',{leaseToken:leased.leaseToken},'connector',403);await cancel(leased.job);
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companies[0],users.owner]);await call('execution/identity','GET',undefined,'connector',401);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[companies[0],users.owner]);
  });
  await t.test('a hosted producer cannot renew or complete execution after its separate host authority ends',async()=>{
   const previousKeyring=process.env.COATRIA_HOSTING_KEYRING;process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:Buffer.alloc(32,9).toString('base64')}});
   const hostPrefix=`companies/${companies[0]}/studio/hosts`;let installed:any,leased:any;
   try{
    installed=(await call(`companies/${companies[0]}/plugin-installations`,'POST',{clientId:randomUUID(),pluginId:'runpod',manifestVersion:'1.0.0',name:'Hosted execution fixture',invocationAccess:'admins',capabilities:['studio.read','studio.write','studio.execute','tasks.write'],runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:5,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}},'owner',201)).installation;
    const created=await call(hostPrefix,'POST',{clientId:randomUUID(),name:'Separate host sponsor fixture',maxAgents:1,expiresAt:new Date(Date.now()+3600000).toISOString()},'reviewer',201);
    const enrolled=await call(`${hostPrefix}/${created.host.id}/enroll`,'POST',{clientId:randomUUID(),revision:created.host.revision,activateAgents:true,installations:[{installationId:installed.id,revision:installed.revision}]},'owner',201);
    const response=await handleApi(new Request(origin+'/api/host/credentials',{method:'POST',headers:{Authorization:'Bearer '+created.hostToken,'Content-Type':'application/json'},body:JSON.stringify({supervisorId:randomUUID()})}),['host','credentials']);assert.equal(response.status,200);const bundle=await response.json();assert.equal(bundle.credentials.length,1);
    await query("UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1 AND role_key='comp'",[companies[0],installed.agentId]);
    const proposed=(await submit()).job;await call(prefix()+`/jobs/${proposed.id}/approve`,'POST',{clientId:randomUUID(),revision:proposed.revision},'owner');
    // A persisted producer reference is fixture setup, not an agent-grant path.
    await query('UPDATE studio_execution_jobs SET requested_agent_id=$2 WHERE id=$1',[proposed.id,installed.agentId]);const claimId=randomUUID();leased=await claim(claimId);assert.equal(leased.job.id,proposed.id);
    await call(`execution/jobs/${leased.job.id}/heartbeat`,'POST',{leaseToken:leased.leaseToken},'connector');
    await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[companies[0],users.reviewer]);
    await claim(claimId,'connector',403);await call(`execution/jobs/${leased.job.id}/complete`,'POST',{clientId:randomUUID(),leaseToken:leased.leaseToken,manifest:manifest()},'connector',403);
    await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[companies[0],users.reviewer]);
    await query("UPDATE studio_managed_hosts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.host.id]);await call(`execution/jobs/${leased.job.id}/heartbeat`,'POST',{leaseToken:leased.leaseToken},'connector',403);
    await call(`${hostPrefix}/${created.host.id}/revoke`,'POST',{clientId:randomUUID(),revision:enrolled.host.revision},'owner',201);await call(`execution/jobs/${leased.job.id}/heartbeat`,'POST',{leaseToken:leased.leaseToken},'connector',403);
    assert.equal((await query('SELECT count(*)::int AS count FROM studio_execution_manifests WHERE job_id=$1',[leased.job.id])).rows[0].count,0);
   }finally{
    await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[companies[0],users.reviewer]);
    if(leased)await cancel((await call(prefix()+`/jobs/${leased.job.id}`)).job);
    await query("UPDATE studio_role_bindings SET agent_id=NULL WHERE company_id=$1 AND role_key='comp'",[companies[0]]);
    if(previousKeyring===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=previousKeyring;
   }
  });
  await t.test('a real local Blender worker completes the same approved API job with actual hashed frames',{skip:process.env.COATRIA_TEST_BLENDER!=='1',timeout:120000},async()=>{
   const workerModule='../scripts/vfx/worker.mts';const {runExecutionWorkerOnce}=await import(workerModule);const {handleApi}=await import('../src/lib/api');const directory=await mkdtemp(join(tmpdir(),'coatria-execution-blender-'));let requests=0;
   const server=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const host='http://127.0.0.1:'+String((server.address()as any).port),path=new URL(req.url||'/',host),response=await handleApi(new Request(path,{method:req.method,headers:req.headers as HeadersInit,body:['GET','HEAD'].includes(req.method||'GET')?undefined:Buffer.concat(chunks)}),path.pathname.slice(5).split('/'));requests++;res.statusCode=response.status;response.headers.forEach((value,key)=>res.setHeader(key,value));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.statusCode=500;res.end('{}');}});
   await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
   try{const queued=await approve((await submit()).job);await runExecutionWorkerOnce({origin:`http://127.0.0.1:${(server.address()as any).port}`,token,workerId:'actual-blender-fixture',outputRoot:directory,blenderPath:process.env.COATRIA_BLENDER_PATH||'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe'});const completed=(await call(prefix()+`/jobs/${queued.job.id}`)).job;assert.equal(completed.status,'succeeded');assert.equal(completed.output.manifest.files.filter((file:any)=>file.kind==='image').length,2);assert(requests>=2);}
   finally{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));const local=relative(resolve(tmpdir()),resolve(directory));if(!local.startsWith('..')&&!isAbsolute(local)&&local)await rm(directory,{recursive:true,force:true});}
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[Object.values(users)]);}finally{await database().end();await stop?.();}}
});
