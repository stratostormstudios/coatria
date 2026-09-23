import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {studioGeneratedSpecInput,generatedSpecificationSha256,type GeneratedProjectSpec} from '../src/lib/studio-generated-protocol';
import {buildStudioGeneratedArtifactManifest} from '../src/lib/studio-generated-artifacts';
import {recordGeneratedStudioReview,prepareGeneratedStudioDelivery,assertGeneratedStudioTaskArtifact} from '../src/lib/studio-generated-review';
import {lockedStudioProject} from '../src/lib/studio';
import {studioReviewInput,studioDeliveryInput} from '../src/lib/studio-protocol';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL,emulate=process.env.COATRIA_TEST_EMULATOR==='1';
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
type Db={query(sql:string,values?:any[]):Promise<{rows:any[]}>};
type Row=Record<string,any>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const specs={image:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},video:{kind:'video',format:'mp4',codec:'h264',width:16,height:16,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}},audio:{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:1}};

test('generated persistence enforces typed projects and immutable verified provenance while preserving v1',{skip:!emulate&&!localPostgres,timeout:180000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_generated_'+suffix,role='coatria_generated_runtime_'+suffix;
 let db:Db,pool:Pool|undefined,control:Pool|undefined,close:(()=>Promise<void>)|undefined,created=false,roleCreated=false;
 const insert=async(client:Db,table:string,data:Row)=>{const keys=Object.keys(data);return(await client.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(data))).rows[0];};
 async function tx<T>(run:(client:Db)=>Promise<T>,asRole=false):Promise<T>{const client:Db=pool?await pool.connect():db;try{await client.query('BEGIN');if(asRole)await client.query('SET LOCAL ROLE '+role);const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{if(pool)(client as PoolClient).release();}}
 const rejects=async(run:(client:Db)=>Promise<unknown>,codes=['23514','23503','23505'])=>assert.rejects(()=>tx(run),(error:any)=>codes.includes(error.code), 'Database must reject the invalid transaction');
 try{
  if(emulate){const{PGlite}=await import('@electric-sql/pglite'),pg=await PGlite.create();db={query:async(sql,values)=>values?pg.query(sql,values):(/^(?:--|CREATE|ALTER|GRANT|REVOKE)/.test(sql.trim())?{rows:await pg.exec(sql)}:pg.query(sql))};close=()=>pg.close();}
  else{control=new Pool({connectionString:integration,max:1});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;pool=new Pool({connectionString:url.href,max:4,statement_timeout:15000});db=pool;close=()=>pool!.end();}
  await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const migrations=(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort();
  for(const file of migrations.filter(file=>file<'030_'))await db.query(await readFile('database/'+file,'utf8'));
  const producer=randomUUID(),registrar=randomUUID(),reviewer=randomUUID(),company=randomUUID(),foreignCompany=randomUUID();
  for(const id of[producer,registrar,reviewer])await insert(db,'users',{id,name:'Synthetic persistence fixture',email:id+'@example.invalid',password_hash:'not-a-login'});
  for(const id of[company,foreignCompany]){await insert(db,'companies',{id,name:'Synthetic generated fixture',slug:id,template:'blank'});await insert(db,'studio_profiles',{company_id:id,template_id:'ai-production',template_version:1,created_by:producer});for(const user of[producer,registrar,reviewer])await insert(db,'memberships',{company_id:id,user_id:user,role:'admin'});}
  const legacySpec={width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'Linear Rec.709'};
  const legacy=await insert(db,'studio_projects',{company_id:company,name:'Legacy stays intact',client_name:'Internal',brief:'Preserve exact v1 evidence',spec:JSON.stringify(legacySpec),ai_policy:'allowed',created_by:producer});
  const legacyShot=await insert(db,'studio_shots',{company_id:company,project_id:legacy.id,code:'SH010',description:'Legacy',frame_start:1,frame_end:24,handles:8,disciplines:'["compositing"]'});
  const legacyTask=await insert(db,'tasks',{company_id:company,title:'Legacy task',created_by:producer});
  const legacyWork=await insert(db,'studio_work_items',{company_id:company,project_id:legacy.id,shot_id:legacyShot.id,logical_key:'legacy',task_id:legacyTask.id,stage:'compositing',role_key:'comp',execution:'dcc'});
  const legacyArtifact=await insert(db,'studio_artifacts',{company_id:company,project_id:legacy.id,work_item_id:legacyWork.id,name:'Legacy artifact',version:1,url:'https://fixture.invalid/legacy',sha256:sha('legacy manifest'),metadata:JSON.stringify({...legacySpec,frameStart:1,frameEnd:24,notes:'Keep exactly'}),produced_by:producer});
  const requestBody='{"productionPath":"vfx","name":"untouched"}',requestHash=sha(requestBody);await insert(db,'studio_requests',{company_id:company,actor_key:'human:'+producer,client_id:randomUUID(),request_hash:requestHash,response:requestBody});
  const before=(await db.query('SELECT spec::text AS spec,(SELECT metadata::text FROM studio_artifacts WHERE id=$2) AS metadata,(SELECT response::text FROM studio_requests WHERE request_hash=$3) AS response FROM studio_projects WHERE id=$1',[legacy.id,legacyArtifact.id,requestHash])).rows[0];
  await db.query(await readFile('database/030_studio_generated_media.sql','utf8'));

  async function project(kind:keyof typeof specs='image',scope=company){const spec=studioGeneratedSpecInput.parse(specs[kind]),row=await insert(db,'studio_projects',{company_id:scope,name:'Generated '+kind,client_name:'Internal',brief:'Synthetic persistence only',spec:JSON.stringify(spec),ai_policy:'allowed',created_by:producer,production_path:'higgsfield',contract_version:2});return {...row,spec} as Row&{spec:GeneratedProjectSpec};}
  async function unit(p:Row,code='D010'){return insert(db,'studio_shots',{company_id:p.company_id,project_id:p.id,media_kind:p.spec.kind,code,description:'Synthetic deliverable 🎬',frame_start:null,frame_end:null,handles:null,disciplines:'[]',duration_min_ms:p.spec.kind==='image'?null:999,duration_max_ms:p.spec.kind==='image'?null:1001});}
  async function work(p:Row,u:Row){const task=await insert(db,'tasks',{company_id:p.company_id,title:'Synthetic generation',created_by:producer});return insert(db,'studio_work_items',{company_id:p.company_id,project_id:p.id,shot_id:u.id,logical_key:u.code,task_id:task.id,stage:'generation',role_key:'comp',execution:'creative'});}
  async function fixture(kind:keyof typeof specs='image',providerSponsorId=producer,mediaPatch:Row={}){
   const p=await project(kind),u=await unit(p),w=await work(p,u),connectionId=randomUUID(),requestId=randomUUID(),providerJobId=randomUUID(),jobId=randomUUID(),outputId=randomUUID(),archiveId=randomUUID(),storageId=randomUUID(),bindingId=randomUUID(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID();
   const requestHash=sha(requestId),receiptHash=sha('receipt:'+requestId),identity=sha(outputId),bytes=1024,fileHash=sha('synthetic file '+versionId),contentType=kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/wav';
   await insert(db,'higgsfield_requests',{id:requestId,company_id:company,project_id:p.id,requested_by:producer,client_id:randomUUID(),project_revision:1,connection_id:connectionId,connection_revision:1,tool:'generate_'+kind,arguments:'{}',note:'Synthetic',request_hash:requestHash,status:'returned',approved_by:reviewer,work_item_id:w.id,task_revision:1,role_human_id:producer});
   await insert(db,'higgsfield_job_receipts',{request_id:requestId,company_id:company,project_id:p.id,connection_id:connectionId,connection_revision:1,approved_by:reviewer,request_hash:requestHash,contract:'synthetic-reviewed-contract',source_sha256:receiptHash,outcome:'jobs'});
   await insert(db,'higgsfield_jobs',{id:jobId,company_id:company,project_id:p.id,request_id:requestId,connection_id:connectionId,provider_job_id:providerJobId,kind,status:'completed'});
   await insert(db,'higgsfield_job_outputs',{id:outputId,company_id:company,project_id:p.id,job_id:jobId,ordinal:0,kind,locator_identity:identity});
   await insert(db,'project_storage_connections',{id:storageId,company_id:company,name:'Synthetic storage',region:'US-CA-2',volume_id:'synthetic-only',secret_envelope:'{}',created_by:producer});
   await insert(db,'project_storage_bindings',{id:bindingId,company_id:company,project_id:p.id,connection_id:storageId,created_by:producer});
   await insert(db,'project_storage_files',{id:fileId,company_id:company,project_id:p.id,binding_id:bindingId,name:'output.'+p.spec.format,name_key:'output.'+p.spec.format,created_by:producer});
   await insert(db,'project_storage_versions',{id:versionId,company_id:company,project_id:p.id,file_id:fileId,version:1,bytes,sha256:fileHash,content_type:contentType,object_key:`coatria/companies/${company}/projects/${p.id}/objects/${versionId}`,created_by:producer});
   const snapshot={requestId,requestHash,receiptHash,contract:'synthetic-reviewed-contract',providerConnectionId:connectionId,requestConnectionRevision:1,providerSponsorId,providerJobId,kind,model:null,outputId,ordinal:0,outputIdentity:identity,requestedBy:producer,agentId:null,runId:null,agentSponsorId:null,approvedBy:reviewer,workItemId:w.id,roleAgentId:null,roleHumanId:producer,taskId:w.task_id,roleKey:'comp'};
   const common={kind,format:p.spec.format,bytes,sha256:fileHash,contentType,verification:'full_decode',inspectionVersion:1},color={space:null,primaries:null,transfer:null,range:null};
   const media=kind==='image'?{...common,width:16,height:16,codec:'png',color}:kind==='video'?{...common,width:16,height:16,codec:'h264',color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null}:{...common,codec:'pcm_s16le',sampleRateHz:48000,channels:1,durationMs:1000,decodedSamples:48000};
   Object.assign(media,mediaPatch);
   const facts={bytes,sha256:fileHash,contentType};
   await tx(async client=>{
    await insert(client,'higgsfield_output_archives',{id:archiveId,company_id:company,project_id:p.id,request_id:requestId,job_id:jobId,output_id:outputId,locator_identity:identity,source_snapshot:JSON.stringify(snapshot),provider_connection_id:connectionId,provider_connection_revision:1,storage_binding_id:bindingId,storage_binding_revision:1,storage_connection_id:storageId,storage_connection_revision:1,storage_connection_snapshot:JSON.stringify({id:storageId,region:'US-CA-2',volumeId:'synthetic-only',sponsorId:producer,revision:1}),destination_name:'output.'+p.spec.format,destination_name_key:'output.'+p.spec.format,destination_ancestors:'[]',max_bytes:2048,project_revision:1,request_hash:sha(archiveId),proposed_by:producer,status:'verified',approved_by:reviewer,approved_at:'2026-01-01T00:00:00Z',expires_at:'2026-01-02T00:00:00Z',approved_project_revision:1,approved_binding_revision:1,upload_id:uploadId,version_id:versionId});
    await insert(client,'project_storage_uploads',{id:uploadId,company_id:company,project_id:p.id,version_id:versionId,actor_key:'archive:'+archiveId,actor_user_id:reviewer,archive_id:archiveId,client_id:randomUUID(),request_hash:sha(uploadId),status:'ready',part_bytes:67108864,provider_etag:'synthetic-etag',expires_at:'2026-01-02T00:00:00Z'});
   });
   await insert(db,'higgsfield_archive_fetches',{company_id:company,project_id:p.id,archive_id:archiveId,locator_identity:identity,bytes,sha256:fileHash,media:JSON.stringify(media)});
   await insert(db,'project_storage_verifications',{company_id:company,project_id:p.id,version_id:versionId,bytes,sha256:fileHash,provider_etag:'synthetic-etag',gateway_receipt_id:randomUUID()});
   const specHash=await generatedSpecificationSha256(p.spec,{kind,code:u.code,description:u.description,...kind==='image'?{}:{durationMs:{min:u.duration_min_ms,max:u.duration_max_ms}}});
   function artifactSource(patch:Row={}){const artifactId=randomUUID(),built=buildStudioGeneratedArtifactManifest({companyId:company,projectId:p.id,artifactId,workItemId:w.id,archiveId,archiveApprovedBy:reviewer,requestId,jobId,outputId,storageVersionId:versionId,specSha256:specHash,sourceSnapshot:snapshot,observedMedia:media,fileFacts:facts}),manifestText=built.manifestText,manifestHash=built.manifestSha256;return {artifact:{id:artifactId,company_id:company,project_id:p.id,work_item_id:w.id,name:'Synthetic generated artifact',version:1,url:`/api/companies/${company}/studio/projects/${p.id}/generated-artifacts/${artifactId}/manifest`,sha256:manifestHash,metadata:JSON.stringify({notes:''}),produced_by:producer,contract_version:2},source:{company_id:company,project_id:p.id,artifact_id:artifactId,work_item_id:w.id,archive_id:archiveId,request_id:requestId,job_id:jobId,output_id:outputId,storage_version_id:versionId,spec_sha256:specHash,manifest_text:manifestText,manifest_sha256:manifestHash,source_snapshot:JSON.stringify(snapshot),observed_media:JSON.stringify(media),file_facts:JSON.stringify(facts),archive_approved_by:reviewer,registered_by:registrar,...patch}};}
   const publish=(client:Db,pair=artifactSource())=>insert(client,'studio_artifacts',pair.artifact).then(()=>insert(client,'studio_generated_artifact_sources',pair.source));
   return {p,u,w,archiveId,requestId,jobId,outputId,versionId,uploadId,connectionId,snapshot,media,facts,specHash,artifactSource,publish};
  }

  await t.test('migration preserves legacy JSON/receipt bytes and existing default frame rows',async()=>{
   assert.deepEqual((await db.query('SELECT spec::text AS spec,(SELECT metadata::text FROM studio_artifacts WHERE id=$2) AS metadata,(SELECT response::text FROM studio_requests WHERE request_hash=$3) AS response FROM studio_projects WHERE id=$1',[legacy.id,legacyArtifact.id,requestHash])).rows[0],before);
   assert.deepEqual((await db.query('SELECT contract_version FROM studio_projects WHERE id=$1',[legacy.id])).rows[0],{contract_version:1});assert.equal((await db.query('SELECT media_kind FROM studio_shots WHERE id=$1',[legacyShot.id])).rows[0].media_kind,'legacy_frames');
   await rejects(client=>client.query('UPDATE studio_projects SET contract_version=2 WHERE id=$1',[legacy.id]));
  });
  await t.test('all media specs are strict and typed units reject NULL/cross-kind/legacy mixtures',async()=>{
   for(const kind of['image','video','audio'] as const){const p=await project(kind),u=await unit(p);assert.equal(u.frame_start,null);assert.equal(u.handles,null);
    await rejects(client=>client.query('UPDATE studio_projects SET spec=$2 WHERE id=$1',[p.id,JSON.stringify({...p.spec,unknown:true})]));await rejects(client=>client.query('UPDATE studio_shots SET description=$2 WHERE id=$1',[u.id,'Changed approved intent']));
    const base={company_id:company,project_id:p.id,media_kind:kind,code:'BAD'+kind,description:'Invalid',frame_start:null,frame_end:null,handles:null,disciplines:'[]',duration_min_ms:kind==='image'?null:1,duration_max_ms:kind==='image'?null:2};
    for(const patch of[{frame_start:0},{handles:0},{media_kind:'legacy_frames'},{media_kind:'other'},{disciplines:'["compositing"]'},...(kind==='image'?[{duration_min_ms:1}]:[{duration_max_ms:null},{duration_min_ms:0},{duration_min_ms:3},{duration_max_ms:3600001}])])await rejects(client=>insert(client,'studio_shots',{...base,...patch}));
    await rejects(client=>insert(client,'studio_shots',{...base,code:u.code.toLowerCase()}));
   }
   for(const spec of[{},null,{...specs.image,width:0},{...specs.image,width:16384,height:16384},{...specs.image,color:{}},{...specs.image,durationMs:1},{...specs.video,codec:'prores'},{...specs.video,frameRate:{mode:'constant',numerator:48000,denominator:2000}},{...specs.audio,format:'mp3'},{...specs.audio,channels:null}])await rejects(client=>insert(client,'studio_projects',{company_id:company,name:'Invalid spec',client_name:'Internal',brief:'Invalid',spec:JSON.stringify(spec),ai_policy:'allowed',created_by:producer,production_path:'higgsfield',contract_version:2}));
   await rejects(client=>insert(client,'studio_projects',{company_id:company,name:'Wrong path',client_name:'Internal',brief:'Invalid',spec:JSON.stringify(specs.image),ai_policy:'allowed',created_by:producer,contract_version:2}));
   await rejects(client=>insert(client,'studio_shots',{company_id:company,project_id:legacy.id,media_kind:'image',code:'NOTV1',description:'Invalid',frame_start:null,frame_end:null,handles:null,disciplines:'[]'}));
  });
  await t.test('generated work cannot enter DCC or be silently relinked; v1 artifacts cannot downgrade it',async()=>{
   const f=await fixture();await rejects(client=>client.query("UPDATE studio_work_items SET execution='dcc' WHERE id=$1",[f.w.id]));await rejects(client=>client.query('UPDATE studio_work_items SET shot_id=NULL WHERE id=$1',[f.w.id]));
   await rejects(client=>client.query('UPDATE studio_work_items SET project_id=$2,shot_id=NULL WHERE id=$1',[f.w.id,legacy.id]));
   const pair=f.artifactSource();await rejects(client=>insert(client,'studio_artifacts',pair.artifact));await rejects(client=>insert(client,'studio_artifacts',{...pair.artifact,contract_version:1}));
  });
  await t.test('image/video/audio publication pins canonical spec and verified bytes after transfer lease expiry',async()=>{
   for(const kind of['image','video','audio'] as const){const f=await fixture(kind),pair=f.artifactSource();await tx(async client=>{if(kind==='audio'){await insert(client,'studio_generated_artifact_sources',pair.source);await insert(client,'studio_artifacts',pair.artifact);}else await f.publish(client,pair);});const saved=(await db.query('SELECT manifest_sha256,spec_sha256 FROM studio_generated_artifact_sources WHERE artifact_id=$1',[pair.artifact.id])).rows[0];assert.equal(saved.spec_sha256,f.specHash);assert.equal(saved.manifest_sha256,sha(pair.source.manifest_text));}
  });
  await t.test('exact evidence substitutions and missing byte verification are rejected transactionally',async()=>{
   const f=await fixture(),other=await fixture(),foreign=await project('image',foreignCompany);
   for(const patch of[{project_id:other.p.id},{company_id:foreignCompany},{work_item_id:other.w.id},{archive_id:other.archiveId},{request_id:other.requestId},{job_id:other.jobId},{output_id:other.outputId},{storage_version_id:other.versionId},{spec_sha256:'0'.repeat(64)},{manifest_sha256:'0'.repeat(64)},{observed_media:JSON.stringify({...f.media,width:999})},{source_snapshot:JSON.stringify({...f.snapshot,requestedBy:registrar})},{file_facts:JSON.stringify({...f.facts,bytes:2048})}])await rejects(client=>f.publish(client,f.artifactSource(patch)));
   assert.notEqual(foreign.company_id,company);
   for(const[table,key,patch]of[['higgsfield_output_archives','id',{status:'uncertain'}],['higgsfield_output_archives','id',{revoked_at:'2026-01-01T00:00:00Z',revoked_by:reviewer}],['higgsfield_jobs','id',{status:'conflict'}],['higgsfield_requests','id',{connection_id:randomUUID()}],['project_storage_uploads','id',{status:'verifying'}]] as const){
    const id=table==='higgsfield_output_archives'?f.archiveId:table==='higgsfield_jobs'?f.jobId:table==='higgsfield_requests'?f.requestId:f.uploadId;
    await rejects(async client=>{const keys=Object.keys(patch);await client.query(`UPDATE ${table} SET ${keys.map((name,i)=>name+'=$'+(i+2)).join(',')} WHERE ${key}=$1`,[id,...Object.values(patch)]);return f.publish(client);});
   }
   await rejects(async client=>{await client.query('DELETE FROM project_storage_verifications WHERE version_id=$1',[f.versionId]);return f.publish(client);});
   for(const patch of[{url:'https://fixture.invalid/untrusted'},{sha256:'0'.repeat(64)},{produced_by:registrar}]){const pair=f.artifactSource();await rejects(client=>f.publish(client,{...pair,artifact:{...pair.artifact,...patch}}));}
   for(const patch of[{requestId:other.requestId},{jobId:other.jobId},{mediaKind:'audio'},{source:{...f.snapshot,requestedBy:registrar}},{media:{...f.media,bytes:2048}}]){const pair=f.artifactSource(),text=JSON.stringify({...JSON.parse(pair.source.manifest_text),...patch}),hash=sha(text);await rejects(client=>f.publish(client,{artifact:{...pair.artifact,sha256:hash},source:{...pair.source,manifest_text:text,manifest_sha256:hash}}));}
   await rejects(client=>f.publish(client,f.artifactSource({archive_approved_by:registrar})));
   for(const duplicate of[(text:string)=>'{"kind":"conflicting-earlier-kind",'+text.slice(1),(text:string)=>text.replace('"source":{','"source":{"requestedBy":"conflicting-earlier-author",')]){const pair=f.artifactSource(),text=duplicate(pair.source.manifest_text),hash=sha(text);await rejects(client=>f.publish(client,{artifact:{...pair.artifact,sha256:hash},source:{...pair.source,manifest_text:text,manifest_sha256:hash}}));}
  });
  await t.test('source output/archive/version are single-use and immutable',async()=>{
   const f=await fixture(),pair=f.artifactSource();await tx(client=>f.publish(client,pair));
   const second=f.artifactSource();second.artifact.version=2;await rejects(client=>f.publish(client,second));
   await rejects(client=>client.query("UPDATE studio_generated_artifact_sources SET observed_media='{}' WHERE artifact_id=$1",[pair.artifact.id]));await rejects(client=>client.query('DELETE FROM studio_generated_artifact_sources WHERE artifact_id=$1',[pair.artifact.id]));
   await rejects(client=>client.query("UPDATE studio_artifacts SET metadata='{\"changed\":true}' WHERE id=$1",[pair.artifact.id]));await rejects(client=>client.query('UPDATE studio_artifacts SET contract_version=1 WHERE id=$1',[pair.artifact.id]));
  });
  await t.test('another archive and physical storage version cannot mint the same provider output again',async()=>{
   const f=await fixture(),first=f.artifactSource();await tx(client=>f.publish(client,first));const archiveId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID();
   const archive=(await db.query('SELECT * FROM higgsfield_output_archives WHERE id=$1',[f.archiveId])).rows[0],upload=(await db.query('SELECT * FROM project_storage_uploads WHERE id=$1',[f.uploadId])).rows[0],version=(await db.query('SELECT * FROM project_storage_versions WHERE id=$1',[f.versionId])).rows[0],fetch=(await db.query('SELECT * FROM higgsfield_archive_fetches WHERE archive_id=$1',[f.archiveId])).rows[0],verified=(await db.query('SELECT * FROM project_storage_verifications WHERE version_id=$1',[f.versionId])).rows[0];
   await tx(async client=>{
    await insert(client,'project_storage_versions',{...version,id:versionId,version:2,object_key:`coatria/companies/${company}/projects/${f.p.id}/objects/${versionId}`});
    await insert(client,'higgsfield_output_archives',{...archive,id:archiveId,upload_id:uploadId,version_id:versionId,source_snapshot:JSON.stringify(archive.source_snapshot),storage_connection_snapshot:JSON.stringify(archive.storage_connection_snapshot),destination_ancestors:JSON.stringify(archive.destination_ancestors)});
    await insert(client,'project_storage_uploads',{...upload,id:uploadId,version_id:versionId,archive_id:archiveId,actor_key:'archive:'+archiveId,client_id:randomUUID()});
    await insert(client,'higgsfield_archive_fetches',{...fetch,archive_id:archiveId,media:JSON.stringify(fetch.media)});
    await insert(client,'project_storage_verifications',{...verified,version_id:versionId,gateway_receipt_id:randomUUID()});
   });
   const next=f.artifactSource({archive_id:archiveId,storage_version_id:versionId});next.artifact.version=2;const text=JSON.stringify({...JSON.parse(next.source.manifest_text),archiveId,storageVersionId:versionId}),hash=sha(text);next.source.manifest_text=text;next.source.manifest_sha256=hash;next.artifact.sha256=hash;
   await rejects(client=>f.publish(client,next),['23505']);
  });
  await t.test('reviews require exact append-only evidence and independent admin; old review write cannot approve v2',async()=>{
   const f=await fixture(),pair=f.artifactSource();await tx(client=>f.publish(client,pair));
   const review={id:randomUUID(),company_id:company,project_id:f.p.id,artifact_id:pair.artifact.id,decision:'approved',note:'Synthetic independent attestation',technical_qc:true,reviewed_by:reviewer};
   const evidence={company_id:company,project_id:f.p.id,review_id:review.id,artifact_id:pair.artifact.id,spec_sha256:f.specHash,manifest_sha256:pair.source.manifest_sha256,attestation_version:1,technical_match:JSON.stringify({matches:true,issues:[],limitations:['COLOR_METADATA_NOT_REQUIRED']})};
   await rejects(client=>insert(client,'studio_reviews',review));
   for(const author of[producer,registrar])await rejects(async client=>{await insert(client,'studio_reviews',{...review,reviewed_by:author});await insert(client,'studio_generated_review_evidence',evidence);});
   await rejects(async client=>{await insert(client,'studio_reviews',review);await insert(client,'studio_generated_review_evidence',{...evidence,spec_sha256:'0'.repeat(64)});});
   await rejects(async client=>{await insert(client,'studio_reviews',review);await insert(client,'studio_generated_review_evidence',{...evidence,technical_match:JSON.stringify({matches:false,issues:[{code:'SPEC_INVALID',path:'spec'}],limitations:[]})});});
   await tx(async client=>{await insert(client,'studio_reviews',review);await insert(client,'studio_generated_review_evidence',evidence);});
   await rejects(client=>client.query('DELETE FROM studio_generated_review_evidence WHERE review_id=$1',[review.id]));
   await rejects(client=>client.query("UPDATE studio_reviews SET decision='changes_requested' WHERE id=$1",[review.id]));
  });
  // Persistence assertions above isolate030; current service readers require
  // the complete schema, including immutable delivery revision scopes.
  for(const file of migrations.filter(file=>file>'030_studio_generated_media.sql'))await db.query(await readFile('database/'+file,'utf8'));
  async function generatedOperation<T>(projectId:string,actorId:string,run:(client:PoolClient,project:import('../src/lib/studio-protocol').StudioGeneratedProject)=>Promise<T>){
   return tx(async client=>{
    await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[company]);
    await client.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[company,actorId]);
    await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,projectId]);
    const project=await lockedStudioProject(client as PoolClient,company,projectId);
    if(project.contractVersion!==2)throw new Error('Expected generated project');
    return run(client as PoolClient,project);
   });
  }
  const actor=(userId:string)=>({companyId:company,userId});
  async function authorizeFixture(projectId:string){await db.query(`UPDATE studio_projects SET gates=$3,status='production' WHERE company_id=$1 AND id=$2`,[company,projectId,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);}
  await t.test('actual image/video/audio review services bind exact evidence and cannot substitute for task acceptance or transfer',async()=>{
   for(const kind of['image','video','audio'] as const){
    const f=await fixture(kind),pair=f.artifactSource();await tx(client=>f.publish(client,pair));await authorizeFixture(f.p.id);
    const data=studioReviewInput.parse({clientId:randomUUID(),revision:1,artifactId:pair.artifact.id,decision:'approved',note:'Synthetic decoded-evidence fixture; no real client media inspected.',technicalQc:true});
    for(const userId of[producer,registrar])await assert.rejects(()=>generatedOperation(f.p.id,userId,(client,p)=>recordGeneratedStudioReview(client,actor(userId),p,data)),(error:any)=>error.code==='STUDIO_INDEPENDENT_REVIEW');
    await assert.rejects(()=>generatedOperation(f.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,{...data,technicalQc:false})),(error:any)=>error.code==='STUDIO_QC_REQUIRED');
    await generatedOperation(f.p.id,reviewer,client=>assertGeneratedStudioTaskArtifact(client,company,f.p.id,f.w.id,false));
    await assert.rejects(()=>generatedOperation(f.p.id,reviewer,client=>assertGeneratedStudioTaskArtifact(client,company,f.p.id,f.w.id,true)),(error:any)=>error.code==='STUDIO_ARTIFACT_REVIEW_REQUIRED');
    const result=await generatedOperation(f.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,data));
    assert.equal(result.review.contractVersion,2);assert.equal(result.review.technicalMatch.matches,true);assert.equal(result.review.manifestSha256,pair.source.manifest_sha256);assert.equal(result.review.specSha256,f.specHash);
    await generatedOperation(f.p.id,reviewer,client=>assertGeneratedStudioTaskArtifact(client,company,f.p.id,f.w.id,true));
    assert.equal((await db.query('SELECT status FROM tasks WHERE id=$1',[f.w.task_id])).rows[0].status,'todo');
    const packageInput=studioDeliveryInput.parse({clientId:randomUUID(),revision:1,name:'Synthetic internal package',artifactIds:[pair.artifact.id],note:'Internal fixture only; no download or client acceptance.'});
    await assert.rejects(()=>generatedOperation(f.p.id,reviewer,(client,p)=>prepareGeneratedStudioDelivery(client,actor(reviewer),p,packageInput)),(error:any)=>error.code==='STUDIO_REVISION_SCOPE_INVALID');
    await db.query("UPDATE tasks SET status='done',approved_by=$2 WHERE id=$1",[f.w.task_id,reviewer]);
    await assert.rejects(()=>generatedOperation(f.p.id,reviewer,(client,p)=>prepareGeneratedStudioDelivery(client,actor(reviewer),p,packageInput)),(error:any)=>error.code==='STUDIO_REVISION_SCOPE_INVALID');
    const qcTask=await insert(db,'tasks',{company_id:company,title:'Synthetic independent QC',created_by:producer,status:'done',approved_by:reviewer});
    const qc=await insert(db,'studio_work_items',{company_id:company,project_id:f.p.id,shot_id:f.u.id,logical_key:'qc',task_id:qcTask.id,stage:'qc',role_key:'qc',execution:'human'});
    await insert(db,'studio_dependencies',{company_id:company,project_id:f.p.id,work_item_id:qc.id,predecessor_id:f.w.id});
    const packed=await generatedOperation(f.p.id,reviewer,(client,p)=>prepareGeneratedStudioDelivery(client,actor(reviewer),p,packageInput));
    assert.equal(packed.delivery.manifest.schemaVersion,2);assert.equal(packed.delivery.manifest.kind,'generated_media_package');assert.equal(packed.delivery.manifest.transportStatus,'not_transferred');
    assert.equal(packed.delivery.manifest.artifacts[0].file.sha256,f.facts.sha256);assert.equal(packed.delivery.manifest.artifacts[0].sha256,pair.source.manifest_sha256);assert.notEqual(f.facts.sha256,pair.source.manifest_sha256);
    assert.equal(packed.delivery.manifest.reviewReceipts[0].id,result.review.id);assert.equal(packed.delivery.manifest.artifacts[0].mediaKind,kind);assert.equal('frameStart' in packed.delivery.manifest.artifacts[0],false);
    const current=(await db.query('SELECT status,gates FROM studio_projects WHERE id=$1',[f.p.id])).rows[0];assert.equal(current.status,'delivery');assert.equal(current.gates.client_acceptance,undefined);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM studio_client_deliveries WHERE project_id=$1',[f.p.id])).rows[0].n,0);
    await assert.rejects(()=>generatedOperation(f.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,data)),(error:any)=>error.code==='STUDIO_WORK_CLOSED');
   }
  });
  await t.test('actual review rejects mismatched decoded media, provider sponsors, revoked admins and lost production approval',async()=>{
   const f=await fixture('image',producer,{width:32}),pair=f.artifactSource();await tx(client=>f.publish(client,pair));await authorizeFixture(f.p.id);
   const data=studioReviewInput.parse({clientId:randomUUID(),revision:1,artifactId:pair.artifact.id,decision:'approved',note:'Synthetic mismatch rejection',technicalQc:true});
   await assert.rejects(()=>generatedOperation(f.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,data)),(error:any)=>error.code==='STUDIO_GENERATED_SPEC_MISMATCH');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM studio_reviews WHERE artifact_id=$1',[pair.artifact.id])).rows[0].n,0);
   const good=await fixture('image',reviewer),goodPair=good.artifactSource();await tx(client=>good.publish(client,goodPair));await authorizeFixture(good.p.id);
   await assert.rejects(()=>generatedOperation(good.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,{...data,artifactId:goodPair.artifact.id})),(error:any)=>error.code==='STUDIO_INDEPENDENT_REVIEW');
   const clean=await fixture(),cleanPair=clean.artifactSource();await tx(client=>clean.publish(client,cleanPair));await authorizeFixture(clean.p.id);
   const cleanData={...data,artifactId:cleanPair.artifact.id};
   await db.query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);
   try{await assert.rejects(()=>generatedOperation(clean.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,cleanData)),(error:any)=>error.code==='STUDIO_ADMIN_REQUIRED');}finally{await db.query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);}
   await db.query("UPDATE studio_projects SET gates='{}' WHERE id=$1",[clean.p.id]);
   await assert.rejects(()=>generatedOperation(clean.p.id,reviewer,(client,p)=>recordGeneratedStudioReview(client,actor(reviewer),p,cleanData)),(error:any)=>error.code==='STUDIO_GATE_REQUIRED');
  });
  await t.test('packaging rejects QC dependencies swapped between deliverables before considering artifacts',async()=>{
   const f=await fixture(),secondUnit=await unit(f.p,'D020'),secondWork=await work(f.p,secondUnit);await authorizeFixture(f.p.id);
   await db.query("UPDATE tasks SET status='done',approved_by=$2 WHERE id=ANY($1::uuid[])",[[f.w.task_id,secondWork.task_id],reviewer]);
   for(const [u,predecessor]of [[f.u,secondWork],[secondUnit,f.w]]){
    const task=await insert(db,'tasks',{company_id:company,title:'Synthetic mislinked QC',created_by:producer,status:'done',approved_by:reviewer});
    const qc=await insert(db,'studio_work_items',{company_id:company,project_id:f.p.id,shot_id:u.id,logical_key:u.code+':qc',task_id:task.id,stage:'qc',role_key:'qc',execution:'human'});
    await insert(db,'studio_dependencies',{company_id:company,project_id:f.p.id,work_item_id:qc.id,predecessor_id:predecessor.id});
   }
   const data=studioDeliveryInput.parse({clientId:randomUUID(),revision:1,name:'Reject swapped QC',artifactIds:[randomUUID(),randomUUID()],note:'QC must cover its own deliverable before artifact selection is evaluated.'});
   await assert.rejects(()=>generatedOperation(f.p.id,reviewer,(client,p)=>prepareGeneratedStudioDelivery(client,actor(reviewer),p,data)),(error:any)=>error.code==='STUDIO_REVISION_SCOPE_INVALID');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM studio_deliveries WHERE project_id=$1',[f.p.id])).rows[0].n,0);
  });
  await t.test('runtime grants retain v1 writes and allow only append/read access to generated source and review evidence',async()=>{
   // Runtime grants target the complete current schema applied before service cases.
   await(control??db).query('CREATE ROLE '+role+' NOLOGIN');roleCreated=true;await db.query((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',role));
   await tx(async client=>{await insert(client,'studio_artifacts',{...legacyArtifact,id:randomUUID(),version:2,metadata:JSON.stringify(legacyArtifact.metadata)});await insert(client,'studio_reviews',{company_id:company,project_id:legacy.id,artifact_id:legacyArtifact.id,decision:'changes_requested',note:'Legacy remains usable',technical_qc:false,reviewed_by:reviewer});},true);
   await tx(client=>client.query('SELECT artifact_id FROM studio_generated_artifact_sources LIMIT 1'),true);
   const f=await fixture(),pair=f.artifactSource();await tx(client=>f.publish(client,pair),true);
   for(const table of['studio_generated_artifact_sources','studio_generated_review_evidence'])await assert.rejects(()=>tx(client=>client.query(`DELETE FROM ${table} WHERE false`),true),(error:any)=>error.code==='42501');
  });
  await t.test('a distinct provider sponsor cannot self-review through another producer or registrar',async()=>{
   const f=await fixture('image',reviewer),pair=f.artifactSource();await tx(client=>f.publish(client,pair));assert.notEqual(reviewer,producer);assert.notEqual(reviewer,registrar);
   await rejects(async client=>{const reviewId=randomUUID();await insert(client,'studio_reviews',{id:reviewId,company_id:company,project_id:f.p.id,artifact_id:pair.artifact.id,decision:'approved',note:'Provider sponsor must remain excluded',technical_qc:true,reviewed_by:reviewer});await insert(client,'studio_generated_review_evidence',{company_id:company,project_id:f.p.id,review_id:reviewId,artifact_id:pair.artifact.id,spec_sha256:f.specHash,manifest_sha256:pair.source.manifest_sha256,attestation_version:1,technical_match:JSON.stringify({matches:true,issues:[],limitations:[]})});});
  });
  await t.test('concurrent distinct artifact IDs cannot publish the same source twice',{skip:emulate},async()=>{
   const f=await fixture(),one=f.artifactSource(),two=f.artifactSource();two.artifact.version=2;
   const results=await Promise.allSettled([tx(client=>f.publish(client,one)),tx(client=>f.publish(client,two))]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.code,'23505');assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_generated_artifact_sources WHERE output_id=$1',[f.outputId])).rows[0].count,1);
  });
  await t.test('review commit waits for current admin membership and cannot race committed revocation',{skip:emulate},async()=>{
   const f=await fixture(),pair=f.artifactSource();await tx(client=>f.publish(client,pair));const reviewId=randomUUID(),blocker=await pool!.connect();let pending:Promise<{ok:boolean;code?:string}>|undefined,pid=0;
   try{
    await blocker.query('BEGIN');await blocker.query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);
    pending=tx(async client=>{pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await insert(client,'studio_reviews',{id:reviewId,company_id:company,project_id:f.p.id,artifact_id:pair.artifact.id,decision:'approved',note:'Synthetic race',technical_qc:true,reviewed_by:reviewer});await insert(client,'studio_generated_review_evidence',{company_id:company,project_id:f.p.id,review_id:reviewId,artifact_id:pair.artifact.id,spec_sha256:f.specHash,manifest_sha256:pair.source.manifest_sha256,attestation_version:1,technical_match:JSON.stringify({matches:true,issues:[],limitations:[]})});}).then(()=>({ok:true}),(error:any)=>({ok:false,code:error.code}));
    const deadline=performance.now()+10000;let waiting=false;while(performance.now()<deadline){if(pid&&(await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0].waiting){waiting=true;break;}await delay(25);}assert(waiting,'Review must actually wait for the membership lock');
    await blocker.query('COMMIT');assert.deepEqual(await pending,{ok:false,code:'23514'});assert.equal((await db.query('SELECT count(*)::int AS count FROM studio_reviews WHERE id=$1',[reviewId])).rows[0].count,0);
   }finally{await blocker.query('ROLLBACK');blocker.release();await pending;await db.query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);}
  });
 }finally{
  try{await close?.();}finally{if(control){try{if(created)await control.query('DROP DATABASE '+dbName);}finally{try{if(roleCreated)await control.query('DROP ROLE '+role);}finally{await control.end();}}}}
 }
});
