import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {errorResponse,hashToken} from '../src/lib/security';
import {projectStorageConnectionInput,projectStorageFolderPlanInput,projectStorageFolderInput,projectStorageUploadInput,RUNPOD_STORAGE_REGIONS,runpodStorageEndpoint} from '../src/lib/project-storage-protocol';
import {projectStorageRoute,openProjectStorageCredentials,createProjectStorageFolder,listProjectStorageFiles,type ProjectStorageTransferIntegration} from '../src/lib/project-storage';

const connectionInput=(extra:Record<string,unknown>={})=>({clientId:randomUUID(),name:'Private footage',region:'US-CA-2',volumeId:'fixture-volume',accessKeyId:'user_fixtureaccess',secretAccessKey:'rps_fixturesecretvalue',...extra});
test('storage schemas confine destinations, paths, credentials, and bounded uploads',()=>{
 for(const region of RUNPOD_STORAGE_REGIONS)assert.equal(runpodStorageEndpoint(region),`https://s3api-${region.toLowerCase()}.runpod.io`);
 for(const patch of [{endpoint:'https://evil.invalid'},{region:'localhost'},{volumeId:'../other'},{accessKeyId:'rpa_apitoken'},{secretAccessKey:'rps_password\n'},{createdBy:randomUUID()}])assert.equal(projectStorageConnectionInput.safeParse(connectionInput(patch)).success,false);
 for(const name of ['..','.','a/b','a\\b','a\u0000b','a:stream','trailing.'])assert.equal(projectStorageFolderInput.safeParse({clientId:randomUUID(),revision:1,name}).success,false,name);
 for(const paths of [['/absolute'],['a/../b'],['a//b'],['C:/private'],[Array.from({length:13},()=> 'a').join('/')]])assert.equal(projectStorageFolderPlanInput.safeParse({clientId:randomUUID(),revision:1,paths}).success,false);
 const upload={clientId:randomUUID(),revision:1,name:'camera.mov',bytes:100*1024**3,contentType:'video/quicktime'};assert(projectStorageUploadInput.safeParse(upload).success);assert(!projectStorageUploadInput.safeParse({...upload,bytes:upload.bytes+1}).success);assert(!projectStorageUploadInput.safeParse({...upload,sha256:'not-a-hash'}).success);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('project storage API: encrypted connections, exact folder plans, tenant and transfer authority',{skip:!emulate&&!integrationUrl,timeout:180000},async t=>{
 const previous={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING};process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();const url=new URL('postgresql://'+server.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),project=randomUUID(),otherProject=randomUUID(),foreignProject=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),sessions={owner:randomUUID(),member:randomUUID(),outsider:randomUUID()},users={owner,member,outsider},origin='http://localhost:4180',base=`companies/${company}/studio/projects/${project}`,connections=`companies/${company}/storage-connections`;
 type User=keyof typeof sessions|'anonymous';
 async function call(path:string,method='GET',payload?:unknown,user:User='owner',expected:number|number[]=200,transfer?:ProjectStorageTransferIntegration){const headers:Record<string,string>={Origin:origin};if(user!=='anonymous')headers.Cookie='coatria_session='+sessions[user];if(payload!==undefined)headers['Content-Type']='application/json';const request=new Request(origin+'/api/'+path,{method,headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})});let response:Response|null;try{response=await projectStorageRoute(request,path.split('?')[0].split('/'),method,transfer);}catch(error){response=errorResponse(error);}assert(response,'route handled');const result=await response.json();assert((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);return result;}
 let connection:any,binding:any,a:any,b:any,leaf:any,plan:any,fileId:string,versionId:string;
 async function current(){binding=(await call(base+'/storage')).binding;return binding.revision;}
 const folder=(name:string,parentId:string|null=null,revision=binding.revision)=>call(base+'/files/folders','POST',{clientId:randomUUID(),revision,parentId,name},'owner',201);
 try{
  for(const [key,userId]of Object.entries(users))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Storage fixture '+key,userId+'@example.invalid','fixture']);
  for(const companyId of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Storage fixture',$2,'blank')",[companyId,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[company,owner,member,foreign,outsider]);
  for(const [key,userId]of Object.entries(users))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[key as keyof typeof sessions]),userId]);
  for(const [companyId,userId]of [[company,owner],[foreign,outsider]])await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
  for(const [projectId,companyId,userId]of [[project,company,owner],[otherProject,company,owner],[foreignProject,foreign,outsider]])await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,created_by) VALUES($1,$2,'Files fixture','Synthetic client','Storage test only','{}','allowed',$3)",[projectId,companyId,userId]);

  await t.test('connection creation is current-admin only and never persists plaintext credentials or returns them',async()=>{
   const payload=connectionInput();await call(connections,'POST',payload,'member',403);await call(connections,'GET',undefined,'outsider',404);await call(connections,'GET',undefined,'anonymous',401);
   const result=await call(connections,'POST',payload,'owner',201);connection=result.connection;assert.equal(connection.providerVerified,false);assert.equal(result.transfers.available,false);assert.equal(JSON.stringify(result).includes(payload.secretAccessKey as string),false);
   const replay=await call(connections,'POST',payload);assert.equal(replay.replayed,true);assert.equal(replay.connection.id,connection.id);assert.equal((await call(connections,'POST',{...payload,volumeId:'different-volume'},'owner',409)).code,'IDEMPOTENCY_CONFLICT');
   const saved=(await query('SELECT secret_envelope FROM project_storage_connections WHERE id=$1',[connection.id])).rows[0].secret_envelope;assert(!JSON.stringify(saved).includes(payload.secretAccessKey as string));assert(!JSON.stringify((await query('SELECT response FROM project_storage_requests WHERE company_id=$1',[company])).rows).includes(payload.secretAccessKey as string));
   const opened=await transaction(client=>openProjectStorageCredentials(client,company,connection.id));assert.equal(opened.accessKeyId,payload.accessKeyId);assert.equal(opened.secretAccessKey,payload.secretAccessKey);
   const second=(await call(connections,'POST',connectionInput({name:'Tamper fixture'}),'owner',201)).connection;await query('UPDATE project_storage_connections SET secret_envelope=$2 WHERE id=$1',[second.id,JSON.stringify(saved)]);await assert.rejects(()=>transaction(client=>openProjectStorageCredentials(client,company,second.id)),(error:any)=>error.code==='STORAGE_VAULT_INTEGRITY');
   assert.equal((await call(connections,'GET',undefined,'member')).connections.length,2);
  });
  await t.test('a binding requires an owned active connection and catalog reads reveal no provider key',async()=>{
   await call(`companies/${foreign}/studio/projects/${foreignProject}/storage`,'PUT',{clientId:randomUUID(),revision:0,connectionId:connection.id},'outsider',404);
   const payload={clientId:randomUUID(),revision:0,connectionId:connection.id};binding=(await call(base+'/storage','PUT',payload)).binding;assert.equal(binding.revision,1);assert.equal((await call(base+'/storage','PUT',payload)).replayed,true);
   const empty=await call(base+'/files','GET',undefined,'member');assert.deepEqual(empty.items,[]);assert.deepEqual(empty.breadcrumbs,[]);assert.equal(empty.transfers.available,false);
   assert(!JSON.stringify(empty).includes('secret_envelope'));assert(!JSON.stringify(empty).includes('accessKeyId'));await call(base+'/storage','PUT',{...payload,clientId:randomUUID(),revision:0},'owner',409);
  });
  await t.test('folders are revisioned, replayable, case-safe and cannot escape or cycle',async()=>{
   const request={clientId:randomUUID(),revision:binding.revision,name:'Shots',parentId:null},created=await call(base+'/files/folders','POST',request,'owner',201);a=created.folder;binding=created.binding;
   assert.equal((await call(base+'/files/folders','POST',request)).replayed,true);await call(base+'/files/folders','POST',{...request,clientId:randomUUID(),name:'Stale'},'owner',409);
   assert.equal((await call(base+'/files/folders','POST',{...request,clientId:randomUUID(),revision:binding.revision,name:'shots'},'owner',409)).code,'STORAGE_NAME_CONFLICT');
   let result=await folder('SH010',a.id);b=result.folder;binding=result.binding;result=await folder('Reference',b.id);leaf=result.folder;binding=result.binding;
   assert.equal((await call(base+'/files/folders/'+a.id,'PATCH',{clientId:randomUUID(),revision:binding.revision,name:'Shots',parentId:leaf.id},'owner',409)).code,'STORAGE_FOLDER_CYCLE');
   await call(`companies/${company}/studio/projects/${otherProject}/files?parentId=${a.id}`,'GET',undefined,'owner',404);await call(base+'/files/folders','POST',{clientId:randomUUID(),revision:binding.revision,name:'Wrong parent',parentId:randomUUID()},'owner',404);
   result=await call(base+'/files/folders/'+leaf.id,'PATCH',{clientId:randomUUID(),revision:binding.revision,name:'References',parentId:a.id});binding=result.binding;
   const view=await call(base+'/files?parentId='+leaf.id);assert.deepEqual(view.breadcrumbs.map((item:any)=>item.name),['Shots','References']);
   await call(base+'/files/folders','POST',{clientId:randomUUID(),revision:binding.revision,name:'Not allowed'},'member',403);
  });
  await t.test('plans add missing parents only, require exact hash/revision, and have real paginated review routes',async()=>{
   const request={clientId:randomUUID(),revision:binding.revision,paths:['Shots/SH010/Inputs','Delivery/Approved','References']};plan=(await call(base+'/files/folder-plans','POST',request,'owner',201)).plan;
   assert.equal(plan.createsFolderCount,4);assert.equal(plan.folders.find((row:any)=>row.path==='Shots').exists,true);assert.equal((await call(base+'/files/folder-plans/'+plan.id)).plan.planHash,plan.planHash);
   assert.equal((await call(base+'/files/folder-plans?limit=1')).plans[0].folders,undefined);
   const approval={clientId:randomUUID(),revision:binding.revision,planHash:plan.planHash};await call(base+'/files/folder-plans/'+plan.id+'/apply','POST',{...approval,planHash:'0'.repeat(64)},'owner',409);
   const applied=await call(base+'/files/folder-plans/'+plan.id+'/apply','POST',approval);assert.equal(applied.createdFolderCount,4);binding=applied.binding;assert.equal(applied.plan.applied,true);assert.equal((await call(base+'/files/folder-plans/'+plan.id+'/apply','POST',approval)).replayed,true);
   const stale=(await call(base+'/files/folder-plans','POST',{clientId:randomUUID(),revision:binding.revision,paths:['New work']},'owner',201)).plan;binding=(await folder('Catalog changed')).binding;assert.equal((await call(base+'/files/folder-plans/'+stale.id+'/apply','POST',{clientId:randomUUID(),revision:binding.revision,planHash:stale.planHash},'owner',409)).code,'STORAGE_REVISION_CONFLICT');
   const expired=(await call(base+'/files/folder-plans','POST',{clientId:randomUUID(),revision:binding.revision,paths:['Expired work']},'owner',201)).plan;await query("UPDATE project_storage_folder_plans SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal((await call(base+'/files/folder-plans/'+expired.id+'/apply','POST',{clientId:randomUUID(),revision:binding.revision,planHash:expired.planHash},'owner',409)).code,'STORAGE_PLAN_EXPIRED');
   const first=await call(base+'/files/folder-plans?limit=1'),next=await call(base+'/files/folder-plans?limit=1&after='+first.page.nextAfter);assert.notEqual(first.plans[0].id,next.plans[0].id);await call(`companies/${foreign}/studio/projects/${foreignProject}/files/folder-plans/${plan.id}`,'GET',undefined,'outsider',404);
  });
  await t.test('listing cursors stay in one folder and missing gateways create neither uploads nor grants',async()=>{
   const page=await call(base+'/files?limit=1');assert.equal(page.items.length,1);assert.equal(page.page.hasMore,true);const next=await call(base+'/files?limit=1&after='+page.page.nextAfter);assert.notEqual(next.items[0].id,page.items[0].id);
   await call(base+'/files?parentId='+a.id+'&after='+page.items[0].id,'GET',undefined,'owner',404);
   const upload={clientId:randomUUID(),revision:binding.revision,name:'Actual footage.mov',bytes:999999999,contentType:'video/quicktime'};assert.equal((await call(base+'/files/uploads','POST',upload,'owner',503)).code,'STORAGE_GATEWAY_UNAVAILABLE');
   assert.equal(Number((await query('SELECT count(*) FROM project_storage_uploads WHERE company_id=$1',[company])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM project_storage_access_receipts WHERE company_id=$1',[company])).rows[0].count),0);
  });
  await t.test('immutable versions use opaque keys; verified server hash wins and member access reaches only real transfer integration',async()=>{
   fileId=randomUUID();versionId=randomUUID();await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[fileId,company,project,binding.id,'Provider output.mp4','provider output.mp4',owner]);
   await assert.rejects(()=>transaction(client=>client.query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,30,$5,$6,$7)',[versionId,company,project,fileId,'video/mp4','../outside',owner])));
   const objectKey=`coatria/companies/${company}/projects/${project}/objects/${versionId}`;await query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,30,$5,$6,$7)',[versionId,company,project,fileId,'video/mp4',objectKey,owner]);
   let view=(await call(base+'/files')).items.find((item:any)=>item.id===fileId);assert.equal(view.latestVersion.verified,false);assert.equal(view.latestVersion.sha256,null);
   await call(base+'/files/versions/'+versionId+'/access','POST',{clientId:randomUUID()},'member',404);
   await query('INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,30,$4,$5,$6)',[company,project,versionId,'a'.repeat(64),'fixture-etag',randomUUID()]);
   view=(await call(base+'/files')).items.find((item:any)=>item.id===fileId);assert.equal(view.latestVersion.verified,true);assert.equal(view.latestVersion.sha256,'a'.repeat(64));await call(base+'/files/versions/'+versionId+'/access','POST',{clientId:randomUUID()},'member',503);
   let called=0;const integration:ProjectStorageTransferIntegration={availability:()=>({available:true,gatewayOrigin:'https://gateway.example.invalid',maxFileBytes:1000,partBytes:500}),reserveUpload:async()=>{throw Error('Not this test');},accessVersion:async(_client,actor,pid,version)=>{called++;assert.equal(actor.userId,member);assert.equal(pid,project);assert.equal(version.id,versionId);assert.equal(version.verified_sha256,'a'.repeat(64));assert.equal(version.connectionId,connection.id);return {access:{testOnly:true}};}};
   assert.equal((await call(base+'/files/versions/'+versionId+'/access','POST',{clientId:randomUUID()},'member',200,integration)).access.testOnly,true);assert.equal(called,1);await call(`companies/${company}/studio/projects/${otherProject}/files/versions/${versionId}/access`,'POST',{clientId:randomUUID()},'member',404,integration);assert.equal(called,1);
   const moved=await call(base+'/files/items/'+fileId,'PATCH',{clientId:randomUUID(),revision:binding.revision,parentId:a.id,name:'Reviewed output.mp4'});binding=moved.binding;assert.equal((await query('SELECT object_key FROM project_storage_versions WHERE id=$1',[versionId])).rows[0].object_key,objectKey);
  });
  await t.test('agent service methods require current opt-in grants and a leased run; credentials remain human-only',async()=>{
   const agentId=randomUUID(),runId=randomUUID(),conversationId=randomUUID(),caps=['storage.read','storage.organize'];await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Storage agent','custom',$3,$4,'admins',$5)",[agentId,company,hashToken(randomUUID()),owner,JSON.stringify(caps)]);await query('INSERT INTO conversations(id,company_id) VALUES($1,$2)',[conversationId,company]);await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Organize approved project folders',$8,'running','fixture',$9,now()+interval '1 hour')",[runId,company,agentId,owner,conversationId,randomUUID(),'1'.repeat(64),JSON.stringify(caps),'2'.repeat(64)]);
   const actor={companyId:company,userId:owner,agentId,runId};await assert.rejects(()=>transaction(client=>createProjectStorageFolder(client,{...actor,runId:undefined},project,{clientId:randomUUID(),revision:binding.revision,name:'No lease'})),(error:any)=>error.code==='AGENT_RUN_REQUIRED');
   const created=await transaction(client=>createProjectStorageFolder(client,actor,project,{clientId:randomUUID(),revision:binding.revision,name:'Agent organized'}));binding=created.binding;assert.equal((await query('SELECT created_agent_id,run_id FROM project_storage_folders WHERE id=$1',[created.folder.id])).rows[0].run_id,runId);
   await query("UPDATE agents SET capabilities='[\"storage.read\"]' WHERE id=$1",[agentId]);await assert.rejects(()=>transaction(client=>createProjectStorageFolder(client,actor,project,{clientId:randomUUID(),revision:binding.revision,name:'Revoked grant'})),(error:any)=>error.code==='AGENT_CAPABILITY_REQUIRED');assert((await transaction(client=>listProjectStorageFiles(client,actor,project))).items.length>0);
   await query("UPDATE agent_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[runId]);await assert.rejects(()=>transaction(client=>listProjectStorageFiles(client,actor,project)),(error:any)=>error.code==='AGENT_CAPABILITY_REQUIRED');
  });
  await t.test('PostgreSQL concurrent catalog mutations consume one revision exactly once',{skip:emulate},async()=>{
   const revision=await current(),responses=await Promise.all(['Concurrent A','Concurrent B'].map(name=>call(base+'/files/folders','POST',{clientId:randomUUID(),revision,name},'owner',[201,409])));
   assert.equal(responses.filter(result=>result.folder).length,1);assert.equal(responses.filter(result=>result.code==='STORAGE_REVISION_CONFLICT').length,1);assert.equal(await current(),revision+1);
  });
  await t.test('current sponsor loss and revocation fence writes and new file access',async()=>{
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);await assert.rejects(()=>transaction(client=>openProjectStorageCredentials(client,company,connection.id)),(error:any)=>error.code==='STORAGE_CONNECTION_UNAVAILABLE');await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);
   const revoke={clientId:randomUUID(),revision:connection.revision,status:'revoked'};assert.equal((await call(connections+'/'+connection.id,'PATCH',revoke)).connection.credentialsConfigured,false);assert.equal((await call(connections+'/'+connection.id,'PATCH',revoke)).replayed,true);
   await call(base+'/files/folders','POST',{clientId:randomUUID(),revision:binding.revision,name:'After revoke'},'owner',409);await call(base+'/files/versions/'+versionId+'/access','POST',{clientId:randomUUID()},'member',409);assert.equal((await call(base+'/files')).binding.connection.status,'revoked');
   assert.equal((await query('SELECT secret_envelope FROM project_storage_connections WHERE id=$1',[connection.id])).rows[0].secret_envelope,null);
  });
  await t.test('company deletion removes file and folder provenance atomically without deleting users first',async()=>{
   await transaction(client=>client.query('DELETE FROM companies WHERE id=$1',[company]));assert.equal(Number((await query('SELECT count(*) FROM project_storage_connections WHERE company_id=$1',[company])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM project_storage_versions WHERE company_id=$1',[company])).rows[0].count),0);
  });
 }finally{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]).catch(()=>{});await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member,outsider]]).catch(()=>{});await database().end();if(stop)await stop();for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
