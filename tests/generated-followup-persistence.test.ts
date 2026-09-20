import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {studioGeneratedSpecInput,generatedSpecificationSha256} from '../src/lib/studio-generated-protocol';
import {buildStudioGeneratedArtifactManifest} from '../src/lib/studio-generated-artifacts';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL,emulate=process.env.COATRIA_TEST_EMULATOR==='1';
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
type Row=Record<string,any>;
type Db={query(sql:string,values?:any[]):Promise<{rows:Row[]}>};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const specs={image:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},video:{kind:'video',format:'mp4',codec:'h264',width:16,height:16,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}},audio:{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:1}};

test('generated continuation persistence is immutable, scoped and source-bound',{skip:!emulate&&!localPostgres,timeout:180000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_followup_'+suffix,role='coatria_followup_runtime_'+suffix;
 let db:Db,pool:Pool|undefined,control:Pool|undefined,close:(()=>Promise<void>)|undefined,created=false,roleCreated=false;
 const insert=async(client:Db,table:string,data:Row)=>{const keys=Object.keys(data);return(await client.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(data))).rows[0];};
 async function tx<T>(run:(client:Db)=>Promise<T>,asRole=false):Promise<T>{const client:Db=pool?await pool.connect():db;try{await client.query('BEGIN');if(asRole)await client.query('SET LOCAL ROLE '+role);const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{if(pool)(client as PoolClient).release();}}
 const reject=async(run:(client:Db)=>Promise<unknown>,codes=['23503','23505','23514'])=>assert.rejects(()=>tx(run),(error:any)=>codes.includes(error.code), 'The database must reject a mismatched continuation');
 try{
  if(emulate){const {PGlite}=await import('@electric-sql/pglite'),pg=await PGlite.create();db={query:async(sql,values)=>values?pg.query(sql,values):(/^(?:--|CREATE|ALTER|GRANT|REVOKE)/.test(sql.trim())?{rows:await pg.exec(sql)}:pg.query(sql))};close=()=>pg.close();}
  else{control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;pool=new Pool({connectionString:url.href,max:4,statement_timeout:15000});db=pool;close=()=>pool!.end();}
  await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of (await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)&&file<'031_').sort())await db.query(await readFile('database/'+file,'utf8'));
  const company=randomUUID(),foreignCompany=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),coordinator=randomUUID(),specialist=randomUUID(),otherAgent=randomUUID();
  for(const user of [owner,reviewer])await insert(db,'users',{id:user,name:'Synthetic continuation fixture',email:user+'@example.invalid',password_hash:'not-a-login'});
  for(const scope of [company,foreignCompany]){await insert(db,'companies',{id:scope,name:'Synthetic continuation company',slug:scope,template:'blank'});await insert(db,'studio_profiles',{company_id:scope,template_id:'ai-production',template_version:1,created_by:owner});for(const user of[owner,reviewer])await insert(db,'memberships',{company_id:scope,user_id:user,role:'admin'});}
  for(const agent of [coordinator,specialist,otherAgent])await insert(db,'agents',{id:agent,company_id:company,name:'Fixture agent',harness:'custom',token_hash:hash(agent),created_by:owner});
  const conversation=await insert(db,'conversations',{company_id:company});
  async function run(agentId:string,status='queued',maxAttempts=1){return insert(db,'agent_runs',{company_id:company,agent_id:agentId,requested_by:owner,conversation_id:conversation.id,client_id:randomUUID(),payload_hash:hash(randomUUID()),prompt:'Synthetic persistence fixture; no inference.',status,max_attempts:maxAttempts,...status==='running'?{worker_id:'fixture',lease_token_hash:hash('fixture'),lease_expires_at:'2099-01-01T00:00:00Z'}:{}});}
  async function project(kind:keyof typeof specs='image',scope=company):Promise<Row&{spec:ReturnType<typeof studioGeneratedSpecInput.parse>}>{const spec=studioGeneratedSpecInput.parse(specs[kind]);return {...await insert(db,'studio_projects',{company_id:scope,name:'Generated '+kind,client_name:'Internal',brief:'Synthetic verified source fixture',spec:JSON.stringify(spec),ai_policy:'allowed',created_by:owner,production_path:'higgsfield',contract_version:2}),spec};}
  async function policy(projectId:string){return insert(db,'studio_coordination_policies',{company_id:company,project_id:projectId,coordinator_agent_id:coordinator,approved_by:owner,status:'active',allowed_role_keys:'["generation"]',profile_revision:1,authority_snapshot:'{"original":"preserve exactly"}',max_runs:10,runs_started:1,max_concurrent_runs:1,expires_at:'2099-01-01T00:00:00Z'});}
  const oldProject=await project(),oldPolicy=await policy(oldProject.id),before=(await db.query('SELECT to_jsonb(p)::text AS value FROM studio_coordination_policies p WHERE company_id=$1 AND project_id=$2',[company,oldProject.id])).rows[0].value;
  await db.query(await readFile('database/031_studio_generated_followups.sql','utf8'));
  await t.test('existing approvals stay off without changing prior policy values or lifetime budget',async()=>{
   const row=(await db.query("SELECT generated_continuations,(to_jsonb(p)-'generated_continuations')::text AS value FROM studio_coordination_policies p WHERE company_id=$1 AND project_id=$2",[company,oldProject.id])).rows[0];assert.equal(row.generated_continuations,false);assert.equal(row.value,before);assert.equal(oldPolicy.runs_started,1);
  });
  async function fixture(kind:keyof typeof specs='image',sourceStatus='succeeded'){
   const p=await project(kind);await policy(p.id);await db.query('UPDATE studio_coordination_policies SET generated_continuations=true WHERE company_id=$1 AND project_id=$2',[company,p.id]);
   const unit=await insert(db,'studio_shots',{company_id:company,project_id:p.id,media_kind:kind,code:'MEDIA01',description:'Synthetic original deliverable 🎬',frame_start:null,frame_end:null,handles:null,disciplines:'[]',duration_min_ms:kind==='image'?null:999,duration_max_ms:kind==='image'?null:1001});
   const source=await run(specialist,sourceStatus),parent=await run(coordinator,'running'),child=await run(specialist);
   const task=await insert(db,'tasks',{company_id:company,title:'Synthetic generation task',created_by:owner,status:'doing',agent_run_id:source.id,revision:3});
   const work=await insert(db,'studio_work_items',{company_id:company,project_id:p.id,shot_id:unit.id,logical_key:'generation',task_id:task.id,stage:'generation',role_key:'generation',execution:'creative'});
   await insert(db,'studio_coordination_dispatches',{company_id:company,project_id:p.id,work_item_id:work.id,parent_run_id:parent.id,child_run_id:source.id,coordinator_agent_id:coordinator,specialist_agent_id:specialist,policy_revision:1});
   const connectionId=randomUUID(),requestId=randomUUID(),jobId=randomUUID(),providerJobId=randomUUID(),outputId=randomUUID(),archiveId=randomUUID(),storageId=randomUUID(),bindingId=randomUUID(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID();
   const requestHash=hash(requestId),receiptHash=hash('receipt:'+requestId),locatorIdentity=hash(outputId),bytes=1024,fileHash=hash('synthetic bytes '+versionId),contentType=kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/wav';
   await insert(db,'higgsfield_requests',{id:requestId,company_id:company,project_id:p.id,requested_by:owner,agent_id:specialist,run_id:source.id,client_id:randomUUID(),project_revision:1,connection_id:connectionId,connection_revision:1,tool:'generate_'+kind,arguments:'{}',note:'Synthetic',request_hash:requestHash,status:'returned',approved_by:reviewer,work_item_id:work.id,task_revision:3,role_agent_id:specialist});
   await insert(db,'higgsfield_job_receipts',{request_id:requestId,company_id:company,project_id:p.id,connection_id:connectionId,connection_revision:1,approved_by:reviewer,request_hash:requestHash,contract:'synthetic-contract',source_sha256:receiptHash,outcome:'jobs'});
   await insert(db,'higgsfield_jobs',{id:jobId,company_id:company,project_id:p.id,request_id:requestId,connection_id:connectionId,provider_job_id:providerJobId,kind,status:'completed'});
   await insert(db,'higgsfield_job_outputs',{id:outputId,company_id:company,project_id:p.id,job_id:jobId,ordinal:0,kind,locator_identity:locatorIdentity});
   await insert(db,'project_storage_connections',{id:storageId,company_id:company,name:'Synthetic storage',region:'US-CA-2',volume_id:'synthetic-only',secret_envelope:'{}',created_by:owner});
   await insert(db,'project_storage_bindings',{id:bindingId,company_id:company,project_id:p.id,connection_id:storageId,created_by:owner});
   await insert(db,'project_storage_files',{id:fileId,company_id:company,project_id:p.id,binding_id:bindingId,name:'output.'+p.spec.format,name_key:'output.'+p.spec.format,created_by:owner});
   await insert(db,'project_storage_versions',{id:versionId,company_id:company,project_id:p.id,file_id:fileId,version:1,bytes,sha256:fileHash,content_type:contentType,object_key:`coatria/companies/${company}/projects/${p.id}/objects/${versionId}`,created_by:owner});
   const snapshot={requestId,requestHash,receiptHash,contract:'synthetic-contract',providerConnectionId:connectionId,requestConnectionRevision:1,providerSponsorId:owner,providerJobId,kind,model:null,outputId,ordinal:0,outputIdentity:locatorIdentity,requestedBy:owner,agentId:specialist,runId:source.id,agentSponsorId:owner,approvedBy:reviewer,workItemId:work.id,roleAgentId:specialist,roleHumanId:null,taskId:task.id,roleKey:'generation'};
   const common={kind,format:p.spec.format,bytes,sha256:fileHash,contentType,verification:'full_decode',inspectionVersion:1},color={space:null,primaries:null,transfer:null,range:null};
   const media=kind==='image'?{...common,width:16,height:16,codec:'png',color}:kind==='video'?{...common,width:16,height:16,codec:'h264',color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null}:{...common,codec:'pcm_s16le',sampleRateHz:48000,channels:1,durationMs:1000,decodedSamples:48000};
   await tx(async client=>{
    await insert(client,'higgsfield_output_archives',{id:archiveId,company_id:company,project_id:p.id,request_id:requestId,job_id:jobId,output_id:outputId,locator_identity:locatorIdentity,source_snapshot:JSON.stringify(snapshot),provider_connection_id:connectionId,provider_connection_revision:1,storage_binding_id:bindingId,storage_binding_revision:1,storage_connection_id:storageId,storage_connection_revision:1,storage_connection_snapshot:JSON.stringify({id:storageId,region:'US-CA-2',volumeId:'synthetic-only',sponsorId:owner,revision:1}),destination_name:'output.'+p.spec.format,destination_name_key:'output.'+p.spec.format,destination_ancestors:'[]',max_bytes:2048,project_revision:1,request_hash:hash(archiveId),proposed_by:owner,status:'verified',approved_by:reviewer,approved_at:'2026-01-01T00:00:00Z',expires_at:'2026-01-02T00:00:00Z',approved_project_revision:1,approved_binding_revision:1,upload_id:uploadId,version_id:versionId});
    await insert(client,'project_storage_uploads',{id:uploadId,company_id:company,project_id:p.id,version_id:versionId,actor_key:'archive:'+archiveId,actor_user_id:reviewer,archive_id:archiveId,client_id:randomUUID(),request_hash:hash(uploadId),status:'ready',part_bytes:67108864,provider_etag:'synthetic-etag',expires_at:'2026-01-02T00:00:00Z'});
   });
   await insert(db,'higgsfield_archive_fetches',{company_id:company,project_id:p.id,archive_id:archiveId,locator_identity:locatorIdentity,bytes,sha256:fileHash,media:JSON.stringify(media)});
   await insert(db,'project_storage_verifications',{company_id:company,project_id:p.id,version_id:versionId,bytes,sha256:fileHash,provider_etag:'synthetic-etag',gateway_receipt_id:randomUUID()});
   const specHash=await generatedSpecificationSha256(p.spec,{kind,code:unit.code,description:unit.description,...kind==='image'?{}:{durationMs:{min:unit.duration_min_ms,max:unit.duration_max_ms}}});
   const evidence={schemaVersion:1,projectId:p.id,workItemId:work.id,taskId:task.id,roleKey:'generation',source:snapshot,observedMedia:media,fileFacts:{bytes,sha256:fileHash,contentType},specSha256:specHash};
   const row={company_id:company,project_id:p.id,work_item_id:work.id,task_id:task.id,source_child_run_id:source.id,parent_run_id:parent.id,child_run_id:child.id,coordinator_agent_id:coordinator,specialist_agent_id:specialist,policy_revision:1,approved_by:owner,archive_id:archiveId,request_id:requestId,job_id:jobId,output_id:outputId,storage_version_id:versionId,spec_sha256:specHash,file_sha256:fileHash,file_bytes:bytes,source_snapshot:JSON.stringify(evidence),source_sha256:hash(canonical(evidence)),initial_task_revision:3,artifact_id:null as string|null,artifact_sha256:null as string|null,claim_request_id:randomUUID(),registration_request_id:randomUUID(),submission_request_id:randomUUID(),registration_name:'Synthetic archived final',registration_notes:'Independent review remains required.'};
   async function publishArtifact(){const artifactId=randomUUID(),built=buildStudioGeneratedArtifactManifest({companyId:company,projectId:p.id,artifactId,workItemId:work.id,archiveId,archiveApprovedBy:reviewer,requestId,jobId,outputId,storageVersionId:versionId,specSha256:specHash,sourceSnapshot:snapshot,observedMedia:media,fileFacts:evidence.fileFacts});
    await tx(async client=>{await insert(client,'studio_artifacts',{id:artifactId,company_id:company,project_id:p.id,work_item_id:work.id,name:'Existing output',version:1,url:`/api/companies/${company}/studio/projects/${p.id}/generated-artifacts/${artifactId}/manifest`,sha256:built.manifestSha256,metadata:'{"notes":""}',produced_by:owner,produced_agent_id:specialist,agent_sponsor_id:owner,run_id:source.id,contract_version:2});await insert(client,'studio_generated_artifact_sources',{company_id:company,project_id:p.id,artifact_id:artifactId,work_item_id:work.id,archive_id:archiveId,request_id:requestId,job_id:jobId,output_id:outputId,storage_version_id:versionId,spec_sha256:specHash,manifest_text:built.manifestText,manifest_sha256:built.manifestSha256,source_snapshot:JSON.stringify(snapshot),observed_media:JSON.stringify(media),file_facts:JSON.stringify(evidence.fileFacts),archive_approved_by:reviewer,registered_by:reviewer});});return {artifactId,manifestSha256:built.manifestSha256};}
   return {p,work,task,source,parent,child,row,snapshot,media,uploadId,publishArtifact};
  }
  const put=(client:Db,row:Row)=>insert(client,'studio_generated_followups',row);
  await t.test('image/video/audio receipts bind terminal original runs and verified archives after old lease expiry',async()=>{
   for(const [kind,status] of [['image','succeeded'],['video','failed'],['audio','cancelled']] as const){const f=await fixture(kind,status);await tx(client=>put(client,f.row));const steps=(await db.query('SELECT request_id,step FROM studio_generated_followup_steps WHERE company_id=$1 AND child_run_id=$2',[company,f.child.id])).rows;assert.equal(steps.length,3);assert.deepEqual(new Set(steps.map(step=>step.request_id)),new Set([f.row.claim_request_id,f.row.registration_request_id,f.row.submission_request_id]));}
  });
  await t.test('bounded canonical source snapshots reject bad hashes, JSON null, arrays and oversized objects',async()=>{
   const f=await fixture();for(const patch of[{source_sha256:'0'.repeat(64)},{source_snapshot:'null'},{source_snapshot:'[]'},{source_snapshot:JSON.stringify({tooLarge:'x'.repeat(131072)}),source_sha256:hash(canonical({tooLarge:'x'.repeat(131072)}))},{file_bytes:0},{initial_task_revision:0},{registration_name:'   '},{registration_notes:'x'.repeat(4001)}])await reject(client=>put(client,{...f.row,...patch}));
   const changed={canonical:'unicode 🎬',b:2,a:1};await tx(client=>put(client,{...f.row,source_snapshot:JSON.stringify(changed),source_sha256:hash(canonical(changed))}));
  });
  await t.test('each same-tenant foreign-key substitution is rejected by deferred relationships',async()=>{
   const f=await fixture(),other=await fixture(),foreign=await project('image',foreignCompany);
   for(const patch of[{project_id:other.p.id},{company_id:foreignCompany,project_id:foreign.id},{work_item_id:other.work.id},{task_id:other.task.id},{source_child_run_id:other.source.id},{parent_run_id:other.child.id},{child_run_id:other.parent.id},{specialist_agent_id:otherAgent},{coordinator_agent_id:otherAgent},{approved_by:reviewer},{policy_revision:2},{archive_id:other.row.archive_id},{request_id:other.row.request_id},{job_id:other.row.job_id},{output_id:other.row.output_id},{storage_version_id:other.row.storage_version_id},{file_sha256:other.row.file_sha256},{file_bytes:1023},{spec_sha256:other.row.spec_sha256==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64)},{initial_task_revision:4}])await reject(client=>put(client,{...f.row,...patch}));
   await reject(async client=>{await client.query('UPDATE agent_runs SET max_attempts=3 WHERE id=$1',[f.child.id]);return put(client,f.row);});
  });
  await t.test('current source conflicts, opt-out and missing verification fail without creating a continuation',async()=>{
   const f=await fixture();const changes:[string,string,Row][]=[['studio_coordination_policies',f.p.id,{generated_continuations:false}],['tasks',f.task.id,{agent_run_id:f.child.id}],['higgsfield_requests',f.row.request_id,{run_id:f.parent.id}],['higgsfield_requests',f.row.request_id,{role_agent_id:otherAgent}],['higgsfield_requests',f.row.request_id,{status:'uncertain'}],['higgsfield_jobs',f.row.job_id,{status:'blocked'}],['higgsfield_job_outputs',f.row.output_id,{kind:'audio'}],['higgsfield_output_archives',f.row.archive_id,{status:'verifying'}],['higgsfield_output_archives',f.row.archive_id,{revoked_at:'2026-01-01T00:00:00Z',revoked_by:reviewer}],['project_storage_uploads',f.uploadId,{status:'uncertain'}]];
   for(const[table,key,patch]of changes)await reject(async client=>{const keys=Object.keys(patch);await client.query(`UPDATE ${table} SET ${keys.map((name,index)=>name+'=$'+(index+2)).join(',')} WHERE ${table==='studio_coordination_policies'?'project_id':'id'}=$1`,[key,...Object.values(patch)]);return put(client,f.row);});
   for(const patch of[{runId:f.parent.id},{agentId:otherAgent},{workItemId:null},{taskId:randomUUID()},{outputId:null},{requestId:randomUUID()}])await reject(async client=>{await client.query('UPDATE higgsfield_output_archives SET source_snapshot=$2 WHERE id=$1',[f.row.archive_id,JSON.stringify({...f.snapshot,...patch})]);return put(client,f.row);});
   await reject(async client=>{await client.query('DELETE FROM project_storage_verifications WHERE version_id=$1',[f.row.storage_version_id]);return put(client,f.row);});
  });
  await t.test('newly approved coordinator may resume the same original specialist',async()=>{
   const f=await fixture(),replacement=await run(otherAgent,'running');await tx(async client=>{await client.query('UPDATE studio_coordination_policies SET coordinator_agent_id=$2,revision=2 WHERE project_id=$1',[f.p.id,otherAgent]);return put(client,{...f.row,parent_run_id:replacement.id,coordinator_agent_id:otherAgent,policy_revision:2});});
  });
  await t.test('existing artifact branch pins its exact manifest and source, never an unrelated approved output',async()=>{
   const f=await fixture(),other=await fixture(),artifact=await f.publishArtifact(),otherArtifact=await other.publishArtifact();
   await reject(client=>put(client,{...f.row,artifact_id:artifact.artifactId}));await reject(client=>put(client,{...f.row,artifact_sha256:artifact.manifestSha256}));
   await reject(client=>put(client,{...f.row,artifact_id:artifact.artifactId,artifact_sha256:'0'.repeat(64)}));
   await reject(client=>put(client,{...f.row,artifact_id:otherArtifact.artifactId,artifact_sha256:otherArtifact.manifestSha256}));
   await tx(client=>put(client,{...f.row,artifact_id:artifact.artifactId,artifact_sha256:artifact.manifestSha256}));
  });
  await t.test('one child/output/source continuation and cross-column company step uniqueness are immutable',async()=>{
   const f=await fixture();await tx(client=>put(client,f.row));const other=await fixture();
   for(const key of['claim_request_id','registration_request_id','submission_request_id'])for(const sourceKey of['claim_request_id','registration_request_id','submission_request_id'])await reject(client=>put(client,{...other.row,[key]:f.row[sourceKey as keyof typeof f.row]}),['23505']);
   await reject(client=>put(client,{...other.row,registration_request_id:other.row.claim_request_id}),['23514']);
   await reject(client=>put(client,{...f.row,claim_request_id:randomUUID(),registration_request_id:randomUUID(),submission_request_id:randomUUID()}),['23505']);
   for(const [patch,constraint] of [[{child_run_id:f.row.child_run_id},'studio_generated_followups_pkey'],[{output_id:f.row.output_id},'studio_generated_followup_output_once'],[{work_item_id:f.row.work_item_id,source_child_run_id:f.row.source_child_run_id},'studio_generated_followup_source_once']] as const)await assert.rejects(()=>tx(client=>put(client,{...other.row,...patch})),(error:any)=>error.code==='23505'&&error.constraint===constraint);
   await reject(client=>client.query('UPDATE studio_generated_followups SET registration_name=registration_name WHERE child_run_id=$1',[f.child.id]),['23514']);
   await reject(client=>client.query('DELETE FROM studio_generated_followups WHERE child_run_id=$1',[f.child.id]),['23514']);
   await reject(client=>client.query('DELETE FROM studio_generated_followup_steps WHERE child_run_id=$1',[f.child.id]),['23514']);
   await reject(client=>insert(client,'studio_generated_followup_steps',{company_id:company,project_id:other.p.id,child_run_id:other.child.id,step:'claim',request_id:randomUUID()}));
   await tx(client=>put(client,other.row));
  });
  await t.test('deferred validation permits a child inserted later in the same transaction',async()=>{
   const f=await fixture(),late:Row={...(await db.query('SELECT * FROM agent_runs WHERE id=$1',[f.child.id])).rows[0],id:randomUUID(),client_id:randomUUID()};
   await tx(async client=>{await put(client,{...f.row,child_run_id:late.id});await insert(client,'agent_runs',{...late,capabilities:JSON.stringify(late.capabilities)});});
  });
  await t.test('concurrent cross-column step collision has exactly one winner',{skip:emulate},async()=>{
   const a=await fixture(),b=await fixture();b.row.submission_request_id=a.row.claim_request_id;
   const results=await Promise.allSettled([tx(client=>put(client,a.row)),tx(client=>put(client,b.row))]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'23505');
  });
  await t.test('restricted runtime can append/read but cannot rewrite source or steal a step',async()=>{
   // Earlier assertions exercise the 031 boundary; current runtime grants also
   // require the additive client storage table introduced in 032.
   await db.query(await readFile('database/032_studio_generated_client_delivery.sql','utf8'));
   await db.query(await readFile('database/033_studio_generated_revisions.sql','utf8'));
   await(control??db).query('CREATE ROLE '+role+' NOLOGIN');roleCreated=true;await db.query((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',role));
   // These are the only new grants needed by the invoker-rights step trigger.
   await db.query('GRANT SELECT,INSERT ON studio_generated_followups,studio_generated_followup_steps TO '+role);
   const f=await fixture();await tx(client=>put(client,f.row),true);await tx(client=>client.query('SELECT source_sha256 FROM studio_generated_followups WHERE child_run_id=$1',[f.child.id]),true);
   for(const table of['studio_generated_followups','studio_generated_followup_steps'])for(const command of['DELETE FROM '+table+' WHERE false','UPDATE '+table+' SET company_id=company_id WHERE false'])await assert.rejects(()=>tx(client=>client.query(command),true),(error:any)=>error.code==='42501');
  });
 }finally{
  await close?.();if(control){if(created)await control.query('DROP DATABASE '+dbName+' WITH (FORCE)');if(roleCreated)await control.query('DROP ROLE '+role);await control.end();}
 }
});
