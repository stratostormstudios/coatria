import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {buildStudioGeneratedArtifactManifest,loadStoredGeneratedArtifact,loadStoredGeneratedArtifacts,loadVerifiedGeneratedSource,registerStudioGeneratedArtifact,studioGeneratedSourceInput} from '../src/lib/studio-generated-artifacts';
import {studioProjectDetail} from '../src/lib/studio';
import {studioGeneratedSpecInput} from '../src/lib/studio-generated-protocol';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
type Db={query(sql:string,values?:any[]):Promise<{rows:any[];rowCount?:number}>};
type Row=Record<string,any>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const caps=['studio.write','creative.read','creative.write','storage.read'];
const specs={image:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},video:{kind:'video',format:'mp4',codec:'h264',width:16,height:16,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}},audio:{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:1}};

test('generated source contract rejects unscoped provider locators and unknown provenance',()=>{
 assert.equal(studioGeneratedSourceInput.safeParse({locator:'https://example.invalid/private?token=synthetic'}).success,false);
 assert.throws(()=>buildStudioGeneratedArtifactManifest({sourceSnapshot:{},observedMedia:{},fileFacts:{}} as any),(e:any)=>e.code==='STUDIO_GENERATED_EVIDENCE_INVALID');
});

test('generated registration authenticates verified synthetic storage and preserves original attribution',{skip:!emulate&&!localPostgres,timeout:180000},async t=>{
 const dbName='coatria_generated_artifacts_'+randomUUID().replaceAll('-','');let db:Db,pool:Pool|undefined,control:Pool|undefined,close:(()=>Promise<void>)|undefined,created=false;
 const insert=async(c:Db,table:string,data:Row)=>{const keys=Object.keys(data);return(await c.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(data))).rows[0];};
 async function tx<T>(run:(c:PoolClient)=>Promise<T>):Promise<T>{const c=pool?await pool.connect():db as PoolClient;try{await c.query('BEGIN');const result=await run(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{if(pool)c.release();}}
 const rejects=(run:(c:PoolClient)=>Promise<unknown>,code:string)=>assert.rejects(()=>tx(run),(error:any)=>error.code===code);
 try{
  if(emulate){const{PGlite}=await import('@electric-sql/pglite'),pg=await PGlite.create();db={query:async(sql,values)=>{if(!values&&/^(?:--|CREATE|ALTER|GRANT|REVOKE)/.test(sql.trim()))return{rows:await pg.exec(sql)};const r=await pg.query(sql,values);return{rows:r.rows,rowCount:r.affectedRows??r.rows.length};}};close=()=>pg.close();}
  else{control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;pool=new Pool({connectionString:url.href,max:4,statement_timeout:15000});db=pool;close=()=>pool!.end();}
  await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)&&f<'031_').sort())await db.query(await readFile('database/'+file,'utf8'));

  async function fixture(kind:keyof typeof specs='image',options:{media?:Row;missingVerification?:boolean;agent?:boolean;shared?:Row}={}){
   const shared=options.shared,company=shared?.company??randomUUID(),producer=shared?.producer??randomUUID(),registrar=shared?.registrar??randomUUID(),reviewer=shared?.reviewer??randomUUID();
   if(!shared){for(const user of[producer,registrar,reviewer])await insert(db,'users',{id:user,name:'Synthetic registration fixture',email:user+'@example.invalid',password_hash:'not-a-login'});
    await insert(db,'companies',{id:company,name:'Synthetic registration',slug:company,template:'blank'});await insert(db,'studio_profiles',{company_id:company,template_id:'ai-production',template_version:1,created_by:producer});for(const user of[producer,registrar,reviewer])await insert(db,'memberships',{company_id:company,user_id:user,role:'admin'});
   }
   const spec=studioGeneratedSpecInput.parse(specs[kind]),gates={brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}};
   const p=shared?.p??await insert(db,'studio_projects',{company_id:company,name:'Generated '+kind,client_name:'Internal',brief:'Synthetic verified DB facts only; no provider calls',spec:JSON.stringify(spec),gates:JSON.stringify(gates),status:'production',ai_policy:'allowed',created_by:producer,production_path:'higgsfield',contract_version:2});
   const u=shared?.u??await insert(db,'studio_shots',{company_id:company,project_id:p.id,media_kind:kind,code:'D010',description:'Synthetic deliverable 🎬',frame_start:null,frame_end:null,handles:null,disciplines:'[]',duration_min_ms:kind==='image'?null:999,duration_max_ms:kind==='image'?null:1001});
   const task=shared?.task??await insert(db,'tasks',{company_id:company,title:'Synthetic generation',created_by:producer}),w=shared?.w??await insert(db,'studio_work_items',{company_id:company,project_id:p.id,shot_id:u.id,logical_key:'D010:generation',task_id:task.id,stage:'generation',role_key:'comp',execution:'creative'});
   if(!shared)await insert(db,'studio_role_bindings',{company_id:company,role_key:'comp',human_id:producer});
   const connectionId=randomUUID(),requestId=randomUUID(),providerJobId=randomUUID(),jobId=randomUUID(),outputId=randomUUID(),archiveId=randomUUID(),storageId=shared?.storageId??randomUUID(),bindingId=shared?.bindingId??randomUUID(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID(),destinationName='output-'+versionId+'.'+spec.format;
   const requestHash=sha(requestId),receiptHash=sha('receipt:'+requestId),identity=sha(outputId),bytes=1024,fileHash=sha('synthetic file '+versionId),contentType=kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/wav';
   await insert(db,'higgsfield_requests',{id:requestId,company_id:company,project_id:p.id,requested_by:producer,client_id:randomUUID(),project_revision:1,connection_id:connectionId,connection_revision:1,tool:'generate_'+kind,arguments:'{}',note:'Synthetic',request_hash:requestHash,status:'returned',approved_by:reviewer,work_item_id:w.id,task_revision:1,role_human_id:producer});
   await insert(db,'higgsfield_job_receipts',{request_id:requestId,company_id:company,project_id:p.id,connection_id:connectionId,connection_revision:1,approved_by:reviewer,request_hash:requestHash,contract:'synthetic-reviewed-contract',source_sha256:receiptHash,outcome:'jobs'});
   await insert(db,'higgsfield_jobs',{id:jobId,company_id:company,project_id:p.id,request_id:requestId,connection_id:connectionId,provider_job_id:providerJobId,kind,status:'completed'});
   await insert(db,'higgsfield_job_outputs',{id:outputId,company_id:company,project_id:p.id,job_id:jobId,ordinal:0,kind,locator_identity:identity});
   if(!shared){await insert(db,'project_storage_connections',{id:storageId,company_id:company,name:'Synthetic storage',region:'US-CA-2',volume_id:'synthetic-only',secret_envelope:'{}',created_by:producer});
    await insert(db,'project_storage_bindings',{id:bindingId,company_id:company,project_id:p.id,connection_id:storageId,created_by:producer});}
   await insert(db,'project_storage_files',{id:fileId,company_id:company,project_id:p.id,binding_id:bindingId,name:destinationName,name_key:destinationName,created_by:producer});
   await insert(db,'project_storage_versions',{id:versionId,company_id:company,project_id:p.id,file_id:fileId,version:1,bytes,sha256:fileHash,content_type:contentType,object_key:`coatria/companies/${company}/projects/${p.id}/objects/${versionId}`,created_by:producer});
   const snapshot={requestId,requestHash,receiptHash,contract:'synthetic-reviewed-contract',providerConnectionId:connectionId,requestConnectionRevision:1,providerSponsorId:producer,providerJobId,kind,model:null,outputId,ordinal:0,outputIdentity:identity,requestedBy:producer,agentId:null,runId:null,agentSponsorId:null,approvedBy:reviewer,workItemId:w.id,roleAgentId:null,roleHumanId:producer,taskId:task.id,roleKey:'comp'};
   const common={kind,format:spec.format,bytes,sha256:fileHash,contentType,verification:'full_decode',inspectionVersion:1},color={space:null,primaries:null,transfer:null,range:null};
   const observed=kind==='image'?{...common,width:16,height:16,codec:'png',color}:kind==='video'?{...common,width:16,height:16,codec:'h264',color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null}:{...common,codec:'pcm_s16le',sampleRateHz:48000,channels:1,durationMs:1000,decodedSamples:48000};
   const media={...observed,...options.media};
   await tx(async c=>{
    await insert(c,'higgsfield_output_archives',{id:archiveId,company_id:company,project_id:p.id,request_id:requestId,job_id:jobId,output_id:outputId,locator_identity:identity,source_snapshot:JSON.stringify(snapshot),provider_connection_id:connectionId,provider_connection_revision:1,storage_binding_id:bindingId,storage_binding_revision:1,storage_connection_id:storageId,storage_connection_revision:1,storage_connection_snapshot:JSON.stringify({id:storageId,region:'US-CA-2',volumeId:'synthetic-only',sponsorId:producer,revision:1}),destination_name:destinationName,destination_name_key:destinationName,destination_ancestors:'[]',max_bytes:2048,project_revision:1,request_hash:sha(archiveId),proposed_by:producer,status:'verified',approved_by:reviewer,approved_at:'2026-01-01T00:00:00Z',expires_at:'2026-01-02T00:00:00Z',approved_project_revision:1,approved_binding_revision:1,upload_id:uploadId,version_id:versionId});
    await insert(c,'project_storage_uploads',{id:uploadId,company_id:company,project_id:p.id,version_id:versionId,actor_key:'archive:'+archiveId,actor_user_id:reviewer,archive_id:archiveId,client_id:randomUUID(),request_hash:sha(uploadId),status:'ready',part_bytes:67108864,provider_etag:'synthetic-etag',expires_at:'2026-01-02T00:00:00Z'});
   });
   await insert(db,'higgsfield_archive_fetches',{company_id:company,project_id:p.id,archive_id:archiveId,locator_identity:identity,bytes,sha256:fileHash,media:JSON.stringify(media)});
   if(!options.missingVerification)await insert(db,'project_storage_verifications',{company_id:company,project_id:p.id,version_id:versionId,bytes,sha256:fileHash,provider_etag:'synthetic-etag',gateway_receipt_id:randomUUID()});
   let actor:{companyId:string;userId:string;agentId?:string;runId?:string}={companyId:company,userId:registrar};
   if(options.agent){
    const agent=await insert(db,'agents',{company_id:company,name:'Synthetic registrar',harness:'custom',token_hash:sha(randomUUID()),created_by:registrar,invocation_access:'admins',capabilities:JSON.stringify(caps)});
    const conversation=await insert(db,'conversations',{company_id:company});
    const run=await insert(db,'agent_runs',{company_id:company,agent_id:agent.id,requested_by:registrar,conversation_id:conversation.id,client_id:randomUUID(),payload_hash:sha(randomUUID()),prompt:'Synthetic registration only',capabilities:JSON.stringify(caps),status:'running',worker_id:'synthetic',lease_token_hash:sha(randomUUID()),lease_expires_at:'2099-01-01T00:00:00Z'});
    await db.query("UPDATE studio_role_bindings SET human_id=NULL,agent_id=$2 WHERE company_id=$1 AND role_key='comp'",[company,agent.id]);await db.query("UPDATE tasks SET status='doing',agent_run_id=$2 WHERE id=$1",[task.id,run.id]);actor={...actor,agentId:agent.id,runId:run.id};
   }
   const input={clientId:randomUUID(),revision:shared?(await db.query('SELECT revision FROM studio_projects WHERE id=$1',[p.id])).rows[0].revision:1,workItemId:w.id,archiveId,name:'Original generated media',notes:'Reviewed registration request'};
   return {company,producer,registrar,reviewer,p,u,w,task,archiveId,requestId,jobId,outputId,versionId,uploadId,connectionId,storageId,bindingId,snapshot,media,actor,input,register:(body=input)=>tx(c=>registerStudioGeneratedArtifact(c,actor,p.id,body))};
  }

  await t.test('image, video and audio publish exact canonical manifests after completed lease expiry',async()=>{
   for(const kind of['image','video','audio'] as const){const f=await fixture(kind),r=await f.register();assert.equal(r.replayed,false);assert.equal(r.project.revision,2);assert.equal(r.artifact.kind,'verified_generated_media');assert.equal(r.artifact.mediaKind,kind);assert.equal(r.artifact.reviewStatus,'pending');assert.equal(r.artifact.producedBy,f.producer);assert.equal(r.artifact.provenance.registeredBy,f.registrar);assert.equal(r.artifact.provenance.archiveApprovedBy,f.reviewer);
    const saved=await tx(c=>loadStoredGeneratedArtifact(c,f.company,f.p.id,r.artifact.id));assert.equal(saved.manifestSha256,sha(saved.manifestText));assert.deepEqual(JSON.parse(saved.manifestText).file,r.artifact.file);assert.equal(saved.sourceSnapshot.requestedBy,f.producer);assert.equal(saved.registeredBy,f.registrar);assert.deepEqual(saved.artifact,r.artifact);
    const reordered=Object.fromEntries(Object.entries(saved.sourceSnapshot).reverse()),rebuilt=buildStudioGeneratedArtifactManifest({companyId:f.company,projectId:f.p.id,artifactId:r.artifact.id,...saved,sourceSnapshot:reordered});assert.equal(rebuilt.manifestText,saved.manifestText);assert.equal(studioGeneratedSourceInput.safeParse({...saved.sourceSnapshot,locator:'https://example.invalid/private'}).success,false);
    assert(!/secret_envelope|object_key|locator|https:|gateway_receipt_id/.test(saved.manifestText));assert.equal((await db.query('SELECT status FROM tasks WHERE id=$1',[f.task.id])).rows[0].status,'todo');assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_reviews WHERE project_id=$1',[f.p.id])).rows[0].count,0);
    const replay=await f.register();assert.equal(replay.replayed,true);assert.deepEqual(replay.artifact,r.artifact);assert.equal(replay.project.revision,2);assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_artifacts WHERE project_id=$1',[f.p.id])).rows[0].count,1);
    await assert.rejects(()=>f.register({...f.input,notes:'Changed'}),(e:any)=>e.code==='IDEMPOTENCY_CONFLICT');await assert.rejects(()=>f.register({...f.input,clientId:randomUUID(),revision:2}),(e:any)=>e.code==='STUDIO_GENERATED_SOURCE_ALREADY_REGISTERED');
   }
  });
  await t.test('nonmatching inspection or missing independently verified bytes never publish',async()=>{
   for(const options of[{missingVerification:true},{media:{sha256:'0'.repeat(64)}},{media:{bytes:2048}},{media:{width:32}},{media:{contentType:'image/jpeg'}}]){const f=await fixture('image',options);await assert.rejects(()=>f.register(),(e:any)=>['STUDIO_GENERATED_EVIDENCE_INVALID','STUDIO_GENERATED_SPEC_MISMATCH'].includes(e.code));assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_artifacts WHERE project_id=$1',[f.p.id])).rows[0].count,0);}
   for(const patch of[{vfr:true},{frameRate:null,vfr:null},{durationMs:1001}]){const f=await fixture('video',{media:patch});await assert.rejects(()=>f.register(),(e:any)=>['STUDIO_GENERATED_EVIDENCE_INVALID','STUDIO_GENERATED_SPEC_MISMATCH'].includes(e.code));}
  });
  await t.test('tenant, source-account, current gates, role and accepted work are enforced',async()=>{
   const a=await fixture(),b=await fixture();await rejects(c=>loadVerifiedGeneratedSource(c,a.company,a.p.id,a.w.id,b.archiveId),'STUDIO_GENERATED_EVIDENCE_INVALID');
   for(const change of[async(c:PoolClient)=>c.query('UPDATE higgsfield_requests SET connection_id=$2 WHERE id=$1',[a.requestId,randomUUID()]),async(c:PoolClient)=>c.query("UPDATE higgsfield_jobs SET status='conflict' WHERE id=$1",[a.jobId]),async(c:PoolClient)=>c.query("UPDATE studio_projects SET gates='{}' WHERE id=$1",[a.p.id]),async(c:PoolClient)=>c.query("UPDATE tasks SET status='done' WHERE id=$1",[a.task.id]),async(c:PoolClient)=>c.query("UPDATE studio_role_bindings SET human_id=NULL WHERE company_id=$1",[a.company])])await assert.rejects(()=>tx(async c=>{await change(c);await registerStudioGeneratedArtifact(c,a.actor,a.p.id,a.input);}), (e:any)=>['STUDIO_GENERATED_EVIDENCE_INVALID','STUDIO_GATE_REQUIRED','STUDIO_WORK_BLOCKED','STUDIO_ROLE_REQUIRED'].includes(e.code));
   await assert.rejects(()=>tx(async c=>{await c.query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[a.company,a.registrar]);await registerStudioGeneratedArtifact(c,a.actor,a.p.id,a.input);}),(e:any)=>e.status===403);
  });
  await t.test('historical manifests survive revocation and disconnected storage without granting publication',async()=>{
   const f=await fixture(),result=await f.register();await db.query("UPDATE higgsfield_output_archives SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1",[f.archiveId,f.reviewer]);await db.query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL WHERE id=$1",[f.storageId]);
   const historical=await tx(c=>loadStoredGeneratedArtifact(c,f.company,f.p.id,result.artifact.id));assert.equal(historical.manifestSha256,result.artifact.sha256);
   await rejects(c=>loadStoredGeneratedArtifact(c,f.company,f.p.id,result.artifact.id,{requireAvailable:true}),'STUDIO_GENERATED_EVIDENCE_INVALID');await assert.rejects(()=>f.register(),(e:any)=>e.code==='STUDIO_GENERATED_EVIDENCE_INVALID');
   const offline=await fixture(),published=await offline.register();await db.query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL WHERE id=$1",[offline.storageId]);assert.equal((await tx(c=>loadStoredGeneratedArtifact(c,offline.company,offline.p.id,published.artifact.id))).artifact.id,published.artifact.id);await rejects(c=>loadStoredGeneratedArtifact(c,offline.company,offline.p.id,published.artifact.id,{requireAvailable:true}),'STUDIO_GENERATED_STORAGE_UNAVAILABLE');
  });
  await t.test('successful receipt replay still requires current caller, role, project and storage authority',async()=>{
   const f=await fixture();await f.register();
   for(const change of[async(c:PoolClient)=>c.query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[f.company,f.registrar]),async(c:PoolClient)=>c.query("UPDATE studio_role_bindings SET human_id=NULL WHERE company_id=$1",[f.company]),async(c:PoolClient)=>c.query("UPDATE studio_projects SET ai_policy='restricted' WHERE id=$1",[f.p.id]),async(c:PoolClient)=>c.query("UPDATE project_storage_connections SET volume_id='different-synthetic-volume' WHERE id=$1",[f.storageId])])await assert.rejects(()=>tx(async c=>{await change(c);return registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);}),(e:any)=>e.status===403||['STUDIO_ROLE_REQUIRED','STUDIO_GATE_REQUIRED','STUDIO_GENERATED_STORAGE_UNAVAILABLE'].includes(e.code));
   assert.equal((await db.query('SELECT revision FROM studio_projects WHERE id=$1',[f.p.id])).rows[0].revision,2);
  });
  await t.test('registration agent requires exact current assignment, reservation and every grant',async()=>{
   const f=await fixture('image',{agent:true});
   for(const missing of caps)await rejects(async c=>{await c.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[f.actor.agentId,JSON.stringify(caps.filter(cap=>cap!==missing))]);await registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);},'AGENT_CAPABILITY_REQUIRED');
   for(const missing of caps)await rejects(async c=>{await c.query('UPDATE agent_runs SET capabilities=$2 WHERE id=$1',[f.actor.runId,JSON.stringify(caps.filter(cap=>cap!==missing))]);await registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);},'AGENT_CAPABILITY_REQUIRED');
   await rejects(async c=>{await c.query("UPDATE agents SET invocation_access='members' WHERE id=$1",[f.actor.agentId]);await c.query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.company,f.registrar]);await registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);},'AGENT_CAPABILITY_REQUIRED');
   for(const change of[async(c:PoolClient)=>c.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.actor.runId]),async(c:PoolClient)=>c.query("UPDATE agents SET status='paused' WHERE id=$1",[f.actor.agentId])])await rejects(async c=>{await change(c);await registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);},'AGENT_CAPABILITY_REQUIRED');
   await rejects(async c=>{await c.query('UPDATE tasks SET agent_run_id=NULL WHERE id=$1',[f.task.id]);await registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);},'STUDIO_ROLE_REQUIRED');
   const result=await f.register();assert.equal(result.artifact.producedBy,f.producer);assert.equal(result.artifact.producedAgentId,null);assert.equal(result.artifact.provenance.registeredAgentId,f.actor.agentId);assert.equal(result.artifact.provenance.registeredRunId,f.actor.runId);
   await db.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.actor.runId]);await assert.rejects(()=>f.register(),(e:any)=>e.code==='AGENT_CAPABILITY_REQUIRED');
  });
  await t.test('100 historical artifacts use one source query and constant project queries with full validation',{timeout:60000},async t=>{
   const f=await fixture(),first=await f.register(),published=[first.artifact];
   const countQueries=async<T>(run:(c:PoolClient)=>Promise<T>)=>tx(async c=>{const statements:string[]=[],started=performance.now(),wrapped={query:async(sql:string,values?:any[])=>{statements.push(sql);return c.query(sql,values);}} as PoolClient;const result=await run(wrapped);return{result,statements,elapsedMs:performance.now()-started};});
   const single=await countQueries(c=>loadStoredGeneratedArtifacts(c,f.company,f.p.id,[first.artifact.id])),smallProject=await countQueries(c=>studioProjectDetail(c,f.company,f.p.id,2));assert.equal(single.statements.length,1);assert.equal(smallProject.result.artifacts.length,1);
   for(let index=1;index<100;index++){const another=await fixture('image',{shared:f});published.push((await another.register()).artifact);}
   const requested=published.map(a=>a.id).reverse(),batch=await countQueries(c=>loadStoredGeneratedArtifacts(c,f.company,f.p.id,requested));assert.equal(batch.statements.length,1);assert.deepEqual(batch.result.map(r=>r.artifact),[...published].reverse());
   assert(!/FOR\s+(?:SHARE|UPDATE|KEY)|secret_envelope|project_storage_connections|output_locators|response_journal/i.test(batch.statements[0]));
   const largeProject=await countQueries(c=>studioProjectDetail(c,f.company,f.p.id,2));assert.equal(largeProject.result.artifacts.length,100);assert.deepEqual(largeProject.result.artifacts,[...published].reverse());assert.equal(largeProject.statements.length,smallProject.statements.length);assert.equal(largeProject.statements.length,10);
   t.diagnostic(`Synthetic history 1/100 artifacts: ${single.elapsedMs.toFixed(1)}/${batch.elapsedMs.toFixed(1)} ms, 1/1 queries; project detail: ${smallProject.elapsedMs.toFixed(1)}/${largeProject.elapsedMs.toFixed(1)} ms, 10/10 queries.`);
   for(const record of batch.result)assert.equal(sha(record.manifestText),record.manifestSha256);
   // A revoked transfer and offline destination must not hide historical work.
   await db.query('UPDATE higgsfield_output_archives SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1',[f.archiveId,f.reviewer]);await db.query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL WHERE id=$1",[f.storageId]);
   const history=await countQueries(c=>studioProjectDetail(c,f.company,f.p.id,2));assert.deepEqual(history.result.artifacts,largeProject.result.artifacts);assert.equal(history.statements.length,10);await rejects(c=>loadStoredGeneratedArtifact(c,f.company,f.p.id,first.artifact.id,{requireAvailable:true}),'STUDIO_GENERATED_EVIDENCE_INVALID');
   const other=await fixture(),foreign=await other.register();for(const bad of[randomUUID(),foreign.artifact.id])await rejects(c=>loadStoredGeneratedArtifacts(c,f.company,f.p.id,[requested[0],bad]),'STUDIO_GENERATED_EVIDENCE_INVALID');
   for(const ids of[[requested[0],requested[0].toUpperCase()],Array.from({length:1001},()=>randomUUID())])await rejects(c=>loadStoredGeneratedArtifacts(c,f.company,f.p.id,ids),'VALIDATION_ERROR');
   assert.deepEqual((await countQueries(c=>loadStoredGeneratedArtifacts(c,f.company,f.p.id,[]))).statements,[]);
   // Decoder/hash/provenance checks remain per-row, even when SQL returned every
   // ID. Deliberately corrupt one synthetic returned record, never stored data.
   for(const corrupt of[(r:Row)=>{r.artifact.manifest_text+='\n';},(r:Row)=>{r.stored.verified_sha256='0'.repeat(64);},(r:Row)=>{r.source.receipt_connection_id=randomUUID();},(r:Row)=>{r.binding_id=randomUUID();},(r:Row)=>{r.artifact.source_snapshot.extra='https://example.invalid/forbidden';}])await rejects(async c=>{const wrapped={query:async(sql:string,values?:any[])=>{const result=await c.query(sql,values);corrupt(result.rows[42]);return result;}} as PoolClient;return loadStoredGeneratedArtifacts(wrapped,f.company,f.p.id,requested);},'STUDIO_GENERATED_EVIDENCE_INVALID');
  });
  await t.test('concurrent identical registrations commit once with an authorized replay',{skip:emulate},async()=>{
   const f=await fixture();const results=await Promise.all([f.register(),f.register()]);assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true]);assert.equal(results[0].artifact.id,results[1].artifact.id);
  });
  await t.test('concurrent distinct requests cannot allocate duplicate artifacts for one source',{skip:emulate},async()=>{
   const f=await fixture(),results=await Promise.allSettled([f.register(),f.register({...f.input,clientId:randomUUID()})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,'STUDIO_REVISION_CONFLICT');assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_generated_artifact_sources WHERE archive_id=$1',[f.archiveId])).rows[0].count,1);
  });
  await t.test('DB-expired agent lease after a project lock wait cannot publish despite host skew',{skip:emulate},async()=>{
   const f=await fixture('image',{agent:true}),blocker=await pool!.connect(),originalNow=Date.now;let pending:Promise<any>|undefined,pid=0;
   try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM studio_projects WHERE id=$1 FOR UPDATE',[f.p.id]);await db.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE id=$1",[f.actor.runId]);
    pending=tx(async c=>{pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return registerStudioGeneratedArtifact(c,f.actor,f.p.id,f.input);}).then(()=>({ok:true}),(e:any)=>({ok:false,code:e.code}));
    const deadline=performance.now()+10000;while(!pid||(await db.query('SELECT cardinality(pg_blocking_pids($1)) AS count',[pid])).rows[0].count===0){assert(performance.now()<deadline);await delay(20);}await delay(1300);Date.now=()=>originalNow()-86400000;await blocker.query('COMMIT');assert.deepEqual(await pending,{ok:false,code:'AGENT_CAPABILITY_REQUIRED'});assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_artifacts WHERE project_id=$1',[f.p.id])).rows[0].count,0);
   }finally{Date.now=originalNow;await blocker.query('ROLLBACK');blocker.release();await pending;}
  });
 }finally{await close?.();if(control){try{if(created){const until=performance.now()+10000;while(Number((await control.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0].count)){if(performance.now()>=until)throw Error('Synthetic database sessions did not drain');await delay(25);}await control.query('DROP DATABASE '+dbName);}}finally{await control.end();}}}
});
