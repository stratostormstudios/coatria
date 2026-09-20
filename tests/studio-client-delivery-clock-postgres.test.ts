import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {query,transaction} from '../src/lib/db';
import {errorResponse,hashToken} from '../src/lib/security';
import {setupStudio,createStudioProject,studioProjectDetail,studioRoute} from '../src/lib/studio';
import {canonicalStudioMedia,type StudioMediaProvider} from '../src/lib/studio-media';
import {studioClientDeliveryRoute} from '../src/lib/studio-client-delivery';
import {EXECUTION_BUILTIN_PROFILES} from '../src/lib/studio-execution-protocol';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
type Row=Record<string,any>;

// PostgreSQL runs outside this process: overriding Date.now must never move the
// authoritative database clock as it would with same-process PGlite. All file,
// review and provider rows below are synthetic authority fixtures, not renders.
test('client delivery deadlines use PostgreSQL after row and idempotency lock waits',{skip:!localPostgres,timeout:120000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_client_clock_'+suffix,applicationName='client-clock-'+suffix;
 const prior={url:process.env.DATABASE_URL,appUrl:process.env.APP_URL,pool:(globalThis as any).coatriaPool as Pool|undefined,now:Date.now};
 const control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000}),ownerUrl=new URL(integration!);ownerUrl.pathname='/'+dbName;
 let owner:Pool|undefined,app:Pool|undefined,created=false;
 const companyId=randomUUID(),users={owner:randomUUID(),reviewer:randomUUID(),client:randomUUID()},sessions={owner:randomUUID(),client:randomUUID()},origin='http://localhost:4180';
 const signed:number[]=[];let onSign:((expiresAt:number)=>Promise<void>)|undefined;
 const provider:StudioMediaProvider={signUpload:async()=>{throw Error('Synthetic read-only provider');},read:async()=>null,signRead:async(_path,expiresAt)=>{signed.push(expiresAt);await onSign?.(expiresAt);return 'https://fixture.invalid/private?temporary=synthetic';}};
 const request=async(path:string,method='GET',payload?:unknown,actor:'owner'|'client'='client')=>{
  const req=new Request(origin+'/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+sessions[actor],...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  try{return await studioClientDeliveryRoute(req,path.split('/'),method,provider)??await studioRoute(req,path.split('/'),method)??new Response(null,{status:404});}catch(error){return errorResponse(error);}
 };
 const call=async(path:string,method='GET',payload?:unknown,actor:'owner'|'client'='client',expected=200)=>{const response=await request(path,method,payload,actor),value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;};
 const dbAt=async(expression="clock_timestamp()")=>(await owner!.query(`SELECT ${expression} AS at`)).rows[0].at as Date;
 const withSkew=async<T>(offset:number,run:()=>Promise<T>)=>{Date.now=()=>prior.now()+offset;try{return await run();}finally{Date.now=prior.now;}};
 const adminPath=(projectId:string)=>`companies/${companyId}/studio/projects/${projectId}/client-deliveries`;
 const path=(share:Row)=>'client-deliveries/'+share.id;
 async function lockWait(pattern:string){
  const until=performance.now()+10000;
  while(performance.now()<until){const found=(await owner!.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock' AND query ILIKE $3",[dbName,applicationName,pattern])).rowCount;if(found)return;await delay(25);}
  assert.fail('The HTTP control operation did not reach the expected PostgreSQL lock wait');
 }
 async function shortlyExpires(share:Row){await owner!.query("UPDATE studio_client_deliveries SET created_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",[share.id]);}
 async function waitPastExpiry(share:Row){await owner!.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))::float8+0.03) FROM studio_client_deliveries WHERE id=$1",[share.id]);}
 async function counts(share:Row){return (await owner!.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE kind='download_access_issued')::int AS downloads FROM studio_client_delivery_receipts WHERE share_id=$1",[share.id])).rows[0];}
 try{
  await control.query(`CREATE DATABASE ${dbName}`);created=true;
  owner=new Pool({connectionString:ownerUrl.href,max:4,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){await owner.query(await readFile('database/'+file,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
  app=new Pool({connectionString:ownerUrl.href,max:4,application_name:applicationName,connectionTimeoutMillis:10000,statement_timeout:15000});
  (globalThis as any).coatriaPool=app;process.env.DATABASE_URL=ownerUrl.href;process.env.APP_URL=origin;
  for(const[name,userId]of Object.entries(users))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,name,userId+'@example.invalid','fixture']);
  for(const[name,session]of Object.entries(sessions))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')",[hashToken(session),users[name as keyof typeof users]]);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Clock authority fixture',$2,'blank')",[companyId,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')",[companyId,users.owner,users.reviewer]);
  await transaction(client=>setupStudio(client,{companyId,userId:users.owner},{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:0,assignments:[]}));
  const spec={width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'Linear Rec.709'},profile=EXECUTION_BUILTIN_PROFILES[0];
  const projectId=(await transaction(client=>createStudioProject(client,{companyId,userId:users.owner},{clientId:randomUUID(),name:'Synthetic clock fixture',clientName:'Synthetic client',brief:'Database authority timing only; no real render or client decision.',spec,aiPolicy:'allowed',shots:[{code:'SH010',description:'Synthetic sequence',frameStart:1,frameEnd:1,handles:0,disciplines:['compositing']}]}))).project.id;
  await query("UPDATE tasks SET status='done' WHERE id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2)",[companyId,projectId]);
  await query('UPDATE studio_projects SET gates=$3 WHERE company_id=$1 AND id=$2',[companyId,projectId,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);
  const connectorId=(await query("INSERT INTO studio_execution_connectors(company_id,name,token_hash,profiles,created_by,expires_at) VALUES($1,'Synthetic fixture',$2,$3,$4,clock_timestamp()+interval '1 day') RETURNING id",[companyId,hashToken(randomUUID()),JSON.stringify([profile]),users.owner])).rows[0].id;
  const workId=(await query("SELECT id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND execution='dcc'",[companyId,projectId])).rows[0].id;
  const jobId=(await query("INSERT INTO studio_execution_jobs(company_id,project_id,work_item_id,connector_id,requested_by,approved_by,profile,spec,input_snapshot,frame_start,frame_end,output_kind,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]',1,1,'image_sequence','succeeded') RETURNING id",[companyId,projectId,workId,connectorId,users.owner,users.reviewer,JSON.stringify(profile),JSON.stringify(spec)])).rows[0].id;
  const fileId=randomUUID(),bytes=Buffer.from('synthetic-clock-frame'),fileHash=hashToken(bytes.toString()),filePath=jobId+'/frames/1.exr';
  await query("INSERT INTO studio_media_files(id,company_id,project_id,job_id,output_path,kind,frame,sha256,bytes,blob_pathname,content_type) VALUES($1,$2,$3,$4,$5,'image',1,$6,$7,$8,'image/x-exr')",[fileId,companyId,projectId,jobId,filePath,fileHash,bytes.length,`studio/${companyId}/${jobId}/${fileHash}/${fileId}.exr`]);
  await query('INSERT INTO studio_media_verifications(company_id,file_id,etag,sha256,bytes) VALUES($1,$2,$3,$4,$5)',[companyId,fileId,'synthetic',fileHash,bytes.length]);
  const sequence=canonicalStudioMedia({schemaVersion:1,kind:'verified_image_sequence',companyId,projectId,jobId,frameStart:1,frameEnd:1,spec,frames:[{fileId,frame:1,path:filePath,sha256:fileHash,bytes:bytes.length}]}),sha256=hashToken(sequence);
  const artifactId=(await query('INSERT INTO studio_artifacts(company_id,project_id,work_item_id,name,version,url,sha256,metadata,produced_by) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8) RETURNING id',[companyId,projectId,workId,'Synthetic sequence','https://fixture.invalid/manifest',sha256,JSON.stringify({...spec,frameStart:1,frameEnd:1,notes:'Synthetic.'}),users.owner])).rows[0].id;
  await query('INSERT INTO studio_media_promotions(company_id,project_id,job_id,artifact_id,manifest_text,manifest_sha256,promoted_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,projectId,jobId,artifactId,sequence,sha256,users.owner]);
  await query("INSERT INTO studio_reviews(company_id,project_id,artifact_id,decision,note,technical_qc,reviewed_by) VALUES($1,$2,$3,'approved','Synthetic authority fixture.',true,$4)",[companyId,projectId,artifactId,users.reviewer]);
  const revision=(await transaction(client=>studioProjectDetail(client,companyId,projectId))).project.revision;
  const delivery=(await call(`companies/${companyId}/studio/projects/${projectId}/deliveries`,'POST',{clientId:randomUUID(),revision,name:'Synthetic clock package',artifactIds:[artifactId],note:'Not a real client delivery.'},'owner',201)).delivery;
  async function shareData(expiresAt?:Date){return {clientId:randomUUID(),revision:(await owner!.query('SELECT revision FROM studio_projects WHERE id=$1',[projectId])).rows[0].revision,deliveryId:delivery.id,recipientUserId:users.client,identityConfirmation:'confirmed_out_of_band',expiresAt:(expiresAt??await dbAt("clock_timestamp()+interval '1 hour'")).toISOString()};}
  async function share(){return (await call(adminPath(projectId),'POST',await shareData(),'owner',201)).share as Row;}

  await t.test('create validates the DB thirty-day interval regardless of either application clock skew',async()=>{
   const valid=await shareData();const accepted=await withSkew(40*86400000,()=>call(adminPath(projectId),'POST',valid,'owner',201));
   assert.equal(accepted.share.expired,false);assert.equal(accepted.share.transferStatus,'not_observed');
   const stored=(await owner!.query('SELECT expires_at>created_at AND expires_at<=created_at+interval \'30 days\' AS valid FROM studio_client_deliveries WHERE id=$1',[accepted.share.id])).rows[0];assert.equal(stored.valid,true);
   await withSkew(-40*86400000,async()=>{await call(adminPath(projectId),'POST',await shareData(await dbAt("clock_timestamp()-interval '1 second'")),'owner',400);});
   await withSkew(2*86400000,async()=>{await call(adminPath(projectId),'POST',await shareData(await dbAt("clock_timestamp()+interval '31 days'")),'owner',400);});
   await owner!.query("UPDATE studio_client_deliveries SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[accepted.share.id]);
   const replay=await call(adminPath(projectId),'POST',valid,'owner');assert.equal(replay.replayed,true);assert.equal(replay.share.expired,true,'Historical administrator create replay remains available');
  });
  await t.test('expired grant denies manifest/open/response/file access even when host is behind',async()=>{
   const s=await share();await owner!.query("UPDATE studio_client_deliveries SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[s.id]);const before=signed.length;
   await withSkew(-86400000,async()=>{
    assert.equal((await request(path(s)+'/manifest')).status,410);
    for(const[endpoint,payload]of[['open',{clientId:randomUUID()}],['responses',{clientId:randomUUID(),revision:1,decision:'acknowledged',note:'Must not record.'}],[`files/${fileId}/access`,{clientId:randomUUID()}]] as const)await call(path(s)+'/'+endpoint,'POST',payload,'client',410);
   });assert.equal(signed.length,before);assert.equal((await counts(s)).total,0);
  });
  await t.test('active grant and exact sixty-second file deadline ignore host skew and retain v1 bytes',async()=>{
   const s=await share(),requestId=randomUUID();
   for(const offset of[-86400000,86400000])await withSkew(offset,async()=>{
    const before=await dbAt(),access=await call(path(s)+`/files/${fileId}/access`,'POST',{clientId:requestId}),after=await dbAt();
    const until=Date.parse(access.access.expiresAt);assert(until>=before.getTime()+59000);assert(until<=after.getTime()+60000);assert.equal(signed.at(-1),until);assert.equal(access.access.bytesReceivedByClient,'not_observed');
    const manifest=await request(path(s)+'/manifest'),text=await manifest.text();assert.equal(manifest.status,200);assert.equal(hashToken(text),s.packageSha256);assert.equal(JSON.parse(text).schemaVersion,1);
   });assert.equal((await counts(s)).downloads,1);
  });
  await t.test('grant row lock wait cannot authorize from a pre-wait clock sample',async()=>{
   const s=await share();await shortlyExpires(s);const blocker=await owner!.connect();let pending:Promise<Response>|undefined;
   try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM studio_client_deliveries WHERE id=$1 FOR UPDATE',[s.id]);pending=withSkew(-86400000,()=>request(path(s)+'/manifest'));await lockWait('%SELECT * FROM studio_client_deliveries%');await waitPastExpiry(s);await blocker.query('ROLLBACK');assert.equal((await pending).status,410);}
   finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}assert.equal((await counts(s)).total,0);
  });
  await t.test('new and replayed open requests expire while waiting for their idempotency lock',async()=>{
   for(const replay of[false,true]){
    const s=await share(),clientId=randomUUID();if(replay)await call(path(s)+'/open','POST',{clientId});await shortlyExpires(s);const blocker=await owner!.connect();let pending:Promise<Response>|undefined;
    try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-client-delivery:${companyId}:${users.client}:${clientId}`]);pending=request(path(s)+'/open','POST',{clientId});await lockWait('%pg_advisory_xact_lock%');await waitPastExpiry(s);await blocker.query('ROLLBACK');assert.equal((await pending).status,410);}
    finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}assert.equal((await counts(s)).total,replay?1:0);
   }
  });
  await t.test('new and replayed signed file requests cannot outlive their idempotency lock wait',async()=>{
   for(const replay of[false,true]){
    const s=await share(),clientId=randomUUID(),endpoint=path(s)+`/files/${fileId}/access`;if(replay)await call(endpoint,'POST',{clientId});await shortlyExpires(s);const blocker=await owner!.connect();let pending:Promise<Response>|undefined;
    try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-client-delivery:${companyId}:${users.client}:${clientId}`]);pending=request(endpoint,'POST',{clientId});await lockWait('%pg_advisory_xact_lock%');await waitPastExpiry(s);await blocker.query('ROLLBACK');const result=await pending;assert.equal(result.status,410);assert.equal((await result.json()).access,undefined);}
    finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}assert.equal((await counts(s)).downloads,replay?1:0,'Signing a URL must not commit a late access receipt or return the URL');
   }
  });
  await t.test('acknowledgement that expires on its idempotency lock rolls back all acceptance effects',async()=>{
   const s=await share(),clientId=randomUUID(),before=(await owner!.query('SELECT status,revision,gates FROM studio_projects WHERE id=$1',[projectId])).rows[0],deliveryBefore=(await owner!.query('SELECT status FROM studio_deliveries WHERE id=$1',[delivery.id])).rows[0];
   await shortlyExpires(s);const blocker=await owner!.connect();let pending:Promise<Response>|undefined;
   try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-client-delivery:${companyId}:${users.client}:${clientId}`]);pending=request(path(s)+'/responses','POST',{clientId,revision:1,decision:'acknowledged',note:'This expired response must roll back.'});await lockWait('%pg_advisory_xact_lock%');await waitPastExpiry(s);await blocker.query('ROLLBACK');assert.equal((await pending).status,410);}
   finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
   assert.deepEqual((await owner!.query('SELECT status,revision,gates FROM studio_projects WHERE id=$1',[projectId])).rows[0],before);assert.deepEqual((await owner!.query('SELECT status FROM studio_deliveries WHERE id=$1',[delivery.id])).rows[0],deliveryBefore);assert.equal((await counts(s)).total,0);
   assert.equal((await owner!.query("SELECT count(*)::int AS total FROM studio_gate_events WHERE company_id=$1 AND project_id=$2 AND gate='client_acceptance'",[companyId,projectId])).rows[0].total,0);
  });
  await t.test('creation expiry is revalidated after waiting on its project row lock',async()=>{
   const payload=await shareData(await dbAt("clock_timestamp()+interval '2 seconds'")),blocker=await owner!.connect();let pending:Promise<Response>|undefined;
   try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM studio_projects WHERE id=$1 FOR UPDATE',[projectId]);pending=request(adminPath(projectId),'POST',payload,'owner');await lockWait('%SELECT revision,status,created_by FROM studio_projects%');await owner!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp()))::float8+0.03)',[payload.expiresAt]);await blocker.query('ROLLBACK');const result=await pending;assert.equal(result.status,400);assert.equal((await result.json()).code,'CLIENT_EXPIRY_INVALID');}
   finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
  });
  await t.test('signing that crosses the share-capped file deadline returns no URL or receipt',async()=>{
   const s=await share();await shortlyExpires(s);onSign=async expiresAt=>{const pinned=(await owner!.query('SELECT expires_at FROM studio_client_deliveries WHERE id=$1',[s.id])).rows[0].expires_at as Date;assert(expiresAt<=pinned.getTime());await waitPastExpiry(s);};
   try{await withSkew(-86400000,async()=>{const result=await call(path(s)+`/files/${fileId}/access`,'POST',{clientId:randomUUID()},'client',410);assert.equal(result.access,undefined);});}finally{onSign=undefined;}assert.equal((await counts(s)).downloads,0);
  });
 }finally{
  Date.now=prior.now;if(prior.pool)(globalThis as any).coatriaPool=prior.pool;else delete(globalThis as any).coatriaPool;
  for(const[key,value]of Object.entries({DATABASE_URL:prior.url,APP_URL:prior.appUrl})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  try{await app?.end();await owner?.end();}finally{try{if(created)await control.query(`DROP DATABASE ${dbName}`);}finally{await control.end();}}
 }
});
