import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret,openHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {recordHiggsfieldSubmission,listHiggsfieldJobs,reconcileHiggsfieldJobs} from '../src/lib/higgsfield-jobs';

const pollSchema={type:'object',additionalProperties:false,required:['jobs'],properties:{jobs:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['index','job_id'],properties:{index:{type:'integer',minimum:0},job_id:{type:'string',format:'uuid'}}}},timeout_seconds:{type:'number',minimum:0,maximum:300}}};
const envelope=(structuredContent:unknown)=>({content:[{type:'text',text:'Untrusted provider prose is not execution authority.'}],structuredContent});
const submission=(providerJobId:string,patch:Record<string,unknown>={})=>envelope({results:[{id:providerJobId,type:'image',model:'synthetic-model',params:{prompt:'Synthetic original concept'},status:'queued',...patch}]});
const poll=(providerJobId:string,patch:Record<string,unknown>={})=>{const status=String(patch.status??'queued'),terminal=['completed','failed','canceled'].includes(status)||status==='lookup_failed'&&patch.retryable===false;return envelope({jobs:[{index:0,job_id:providerJobId,type:'image',model:'synthetic-model',status,...patch}],all_terminal:terminal,summary:{active:terminal?0:1,completed:status==='completed'?1:0,failed:status==='failed'?1:0,errors:0,total:1}});};

// Always isolated PGlite, even when the caller has production/integration URLs.
// Every HTTP request is intercepted; this suite cannot generate paid media.
test('Higgsfield reconciliation records honest provenance and polls only adopted jobs under current authority',{timeout:120000},async t=>{
 const before={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch};
 const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();
 for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));
 const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
 process.env.DATABASE_URL='postgresql://postgres:postgres@'+server.getServerConn()+'/postgres';process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),approver=randomUUID(),outsider=randomUUID(),connectionId=randomUUID(),project=randomUUID(),foreignProject=randomUUID(),task=randomUUID(),work=randomUUID(),access='synthetic-access-'+randomUUID(),privateSignature='private-transfer-'+randomUUID();
 const tools=[{name:'jobs_wait',description:'Synthetic declared official jobs reader',inputSchema:pollSchema}];
 const gates=Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved',recordedBy:approver}]));
 let polled:string[]=[],onPoll:(id:string)=>Promise<unknown>=async id=>poll(id),requestSequence=0;
 const sealed=sealHiggsfieldSecret({token:{access_token:access,token_type:'Bearer',expires_in:3600}},{companyId:company,id:connectionId,purpose:'oauth-connection'});
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://mcp.higgsfield.ai/mcp','No real provider or output download is permitted');assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+access);
  const message=JSON.parse(String(init?.body));if(message.method==='notifications/initialized')return new Response(null,{status:202});
  if(message.method==='initialize')return Response.json({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
  assert.equal(message.method,'tools/call');assert.equal(message.params.name,'jobs_wait','Reconciliation must never submit a generation');assert.equal(message.params.arguments.timeout_seconds,0);assert.equal(message.params.arguments.jobs.length,1);assert.equal(message.params.arguments.jobs[0].index,0);
  const providerId=message.params.arguments.jobs[0].job_id;polled.push(providerId);return Response.json({jsonrpc:'2.0',id:message.id,result:await onPoll(providerId)});
 };
 async function restoreAuthority(){
  await query("UPDATE higgsfield_jobs SET next_poll_at=NULL,poll_lease_id=NULL,poll_lease_expires_at=NULL WHERE company_id=$1",[company]);
  await query("UPDATE memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'admin' END WHERE company_id=$1",[company,owner]);
  await query("UPDATE higgsfield_connections SET id=$2,revision=1,status='connected',sealed=$3,tools=$4,expires_at=clock_timestamp()+interval '1 hour' WHERE company_id=$1",[company,connectionId,JSON.stringify(sealed),JSON.stringify(tools)]);
  await query("UPDATE studio_projects SET status='production',ai_policy='allowed',gates=$2 WHERE id=$1",[project,JSON.stringify(gates)]);
  await query("UPDATE studio_role_bindings SET human_id=$2,agent_id=NULL WHERE company_id=$1 AND role_key='comp'",[company,owner]);onPoll=async id=>poll(id);polled=[];
 }
 async function request(patch:{status?:string;historical?:boolean;bound?:boolean}={}){
  const id=randomUUID(),bound=patch.bound??true;
  return(await query("INSERT INTO higgsfield_requests(id,company_id,project_id,requested_by,client_id,project_revision,connection_id,connection_revision,tool,arguments,note,request_hash,status,approved_by,dispatched_at,work_item_id,task_revision,role_human_id) VALUES($1,$2,$3,$4,$5,1,$6,1,'generate_image',$7,'Synthetic approved request',$8,$9,$10,clock_timestamp(),$11,$12,$13) RETURNING *",[id,company,project,owner,randomUUID(),patch.historical?null:connectionId,JSON.stringify({prompt:'Synthetic '+(++requestSequence)}),hashToken(id),patch.status??'returned',approver,bound?work:null,bound?1:null,bound?owner:null])).rows[0];
 }
 const record=(r:Record<string,any>,response:unknown)=>transaction(client=>recordHiggsfieldSubmission(client,r,response));
 const list=(input:Record<string,unknown>={})=>transaction(client=>listHiggsfieldJobs(client,company,{projectId:project,...input}));
 async function queued(patch:Parameters<typeof request>[0]={}){const r=await request(patch),providerId=randomUUID(),response=submission(providerId);await record(r,response);const j=(await query('SELECT * FROM higgsfield_jobs WHERE request_id=$1',[r.id])).rows[0];if(j)await query("UPDATE higgsfield_jobs SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);return{r,providerId,response,j};}
 const job=(id:string)=>query('SELECT * FROM higgsfield_jobs WHERE id=$1',[id]).then(result=>result.rows[0]);
 try{
  for(const id of[owner,approver,outsider])await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Job fixture',$2,'not-a-login')",[id,id+'@example.invalid']);
  for(const id of[company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Isolated job fixture',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($4,$5,'owner')",[company,owner,approver,foreign,outsider]);
  for(const[c,user]of[[company,owner],[foreign,outsider]])await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[c,user]);
  for(const[c,p,user]of[[company,project,owner],[foreign,foreignProject,outsider]])await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Synthetic project','Fixture','Synthetic approved original production',$3,'allowed','production',$4,$5,'higgsfield')",[p,c,JSON.stringify({width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),JSON.stringify(gates),user]);
  await query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Synthetic generation task',$3)",[task,company,owner]);await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[work,company,project,task]);await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[company,owner]);
  await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour',$5)",[company,connectionId,owner,JSON.stringify(sealed),JSON.stringify(tools)]);

  await t.test('one confirmed submission records one exact receipt and duplicate callbacks cannot invent a different job',async()=>{
   await restoreAuthority();const {r,providerId,response}=await queued();const replay=await record(r,response);assert.equal(replay.providerJobCount,1);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_job_receipts WHERE request_id=$1',[r.id])).rows[0].count,1);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_jobs WHERE request_id=$1',[r.id])).rows[0].count,1);
   await assert.rejects(()=>record(r,submission(randomUUID())),/different|conflict|match|receipt/i);assert.equal((await list({requestId:r.id})).jobs[0].providerJobId,providerId);assert.equal(polled.length,0);
  });
  await t.test('unknown envelopes, choices, rejected tools and historical identities do not create pollable jobs',async()=>{
   await restoreAuthority();for(const response of[envelope({job_ids:[randomUUID()]}),envelope({unlim_choice:{message:'Choose a plan',model:'synthetic'}}),{content:[],isError:true},envelope({error:'Synthetic rejection'})]){const r=await request();await record(r,response);assert.equal((await list({requestId:r.id})).jobs.length,0);}
   const r=await request({historical:true});await assert.rejects(()=>record(r,submission(randomUUID())),{code:'HIGGSFIELD_RECEIPT_NOT_ADOPTED'});assert.equal((await list({requestId:r.id})).jobs.length,0);
   await reconcileHiggsfieldJobs(2);assert.equal(polled.length,0);
  });
  await t.test('a second request cannot adopt a provider job already bound to the same company connection',async()=>{
   await restoreAuthority();const first=await queued(),other=await request(),blocked=await record(other,first.response);assert.equal(blocked.outcome,'unsupported');assert.equal(blocked.code,'HIGGSFIELD_JOB_ALREADY_BOUND');assert.equal(blocked.providerJobCount,0);assert.equal((await list({requestId:other.id})).jobs.length,0);
   assert.deepEqual(await record(other,first.response),blocked);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_jobs WHERE company_id=$1 AND connection_id=$2 AND provider_job_id=$3',[company,connectionId,first.providerId])).rows[0].count,1);
   await assert.rejects(()=>record({...other,approved_by:owner},first.response),{code:'HIGGSFIELD_RECEIPT_NOT_ADOPTED'});
  });
  await t.test('unsupported provider evidence remains privately recoverable without exposing raw signed locators',async()=>{
   await restoreAuthority();const r=await request(),privateEvidence=envelope({job_ids:[randomUUID()],transport:'https://media.higgsfield.example/private.png?signature='+privateSignature,debug:'x'.repeat(100000)}),summary=await record(r,privateEvidence);assert.equal(summary.outcome,'unsupported');assert(!JSON.stringify(summary).includes(privateSignature));assert(!JSON.stringify(await list({requestId:r.id})).includes(privateSignature));
   const journal=(await query("SELECT id,sealed,source_sha256 FROM higgsfield_provider_responses WHERE company_id=$1 AND request_id=$2 AND source='submission'",[company,r.id])).rows;assert.equal(journal.length,1);assert.equal(journal[0].source_sha256,hashToken(JSON.stringify(privateEvidence)));assert(!JSON.stringify(journal).includes(privateSignature));assert.deepEqual(openHiggsfieldSecret(journal[0].sealed,{companyId:company,id:journal[0].id,purpose:'provider-response'}),privateEvidence);
   await record(r,privateEvidence);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_provider_responses WHERE request_id=$1',[r.id])).rows[0].count,1);await reconcileHiggsfieldJobs(2);assert.equal(polled.length,0);
  });
  await t.test('uncertain paid outcomes never become another generation or provider status lookup',async()=>{
   await restoreAuthority();const uncertain=await request({status:'uncertain'});await assert.rejects(()=>record(uncertain,submission(randomUUID())),{code:'HIGGSFIELD_RECEIPT_NOT_ADOPTED'});assert.equal((await list({requestId:uncertain.id})).jobs.length,0);
   const {r,j}=await queued();await query("UPDATE higgsfield_requests SET status='uncertain' WHERE id=$1",[r.id]);await reconcileHiggsfieldJobs(2);assert.equal((await job(j.id)).diagnostic_code,'HIGGSFIELD_POLL_NOT_ADOPTED');assert.equal(polled.length,0);assert.equal((await query("SELECT count(*)::int count FROM higgsfield_jobs WHERE company_id=$1 AND next_poll_at IS NOT NULL",[company])).rows[0].count,0);
  });
  await t.test('completed provider output is encrypted private transport and never claims byte verification or approval',async()=>{
   await restoreAuthority();const {r,providerId,j}=await queued(),locator='https://media.higgsfield.example/output/synthetic.png?signature='+privateSignature;
   onPoll=async id=>poll(id,{status:'completed',result_url:locator});const reconciled=await reconcileHiggsfieldJobs(2);assert.equal(reconciled.providerGenerationsSubmitted,0);assert.deepEqual(polled,[providerId]);
   const publicJobs=await list({requestId:r.id}),done=publicJobs.jobs[0];assert.equal(done.status,'completed');assert.equal(done.outputs.length,1);assert.equal(done.outputs[0].bytesVerified,false);assert.equal(done.pollAttempts,1);for(const secret of[privateSignature,locator,access,'ciphertext'])assert(!JSON.stringify(publicJobs).includes(secret));assert.equal((await job(j.id)).next_poll_at,null);
   const saved=(await query('SELECT output_id,sealed FROM higgsfield_output_locators WHERE company_id=$1 AND output_id=$2',[company,done.outputs[0].id])).rows[0];assert(!JSON.stringify(saved.sealed).includes(privateSignature));assert.deepEqual(openHiggsfieldSecret(saved.sealed,{companyId:company,id:saved.output_id,purpose:'provider-output'}),{locator});assert.throws(()=>openHiggsfieldSecret(saved.sealed,{companyId:foreign,id:saved.output_id,purpose:'provider-output'}));
   const journal=(await query("SELECT id,sealed FROM higgsfield_provider_responses WHERE company_id=$1 AND job_id=$2 AND source='poll'",[company,j.id])).rows;assert.equal(journal.length,1);assert(!JSON.stringify(journal).includes(privateSignature));assert.deepEqual(openHiggsfieldSecret(journal[0].sealed,{companyId:company,id:journal[0].id,purpose:'provider-response'}),poll(providerId,{status:'completed',result_url:locator}));
   assert.equal((await query('SELECT status FROM tasks WHERE id=$1',[task])).rows[0].status,'todo');for(const table of['studio_artifacts','studio_reviews','studio_deliveries','project_storage_versions'])assert.equal((await query(`SELECT count(*)::int count FROM ${table} WHERE company_id=$1`,[company])).rows[0].count,0);
   await reconcileHiggsfieldJobs(2);assert.deepEqual(polled,[providerId]);
  });
  await t.test('current approver, connection sponsor, account identity, gates and exact work assignment revoke polling',async()=>{
   const changes:Array<[string,()=>Promise<unknown>]>=[
    ['HIGGSFIELD_APPROVER_UNAVAILABLE',()=>query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,approver])],
    ['HIGGSFIELD_CONNECTION_CHANGED',()=>query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner])],
    ['HIGGSFIELD_CONNECTION_CHANGED',()=>query("UPDATE higgsfield_connections SET status='disconnected',sealed=NULL WHERE company_id=$1",[company])],
    ['HIGGSFIELD_CONNECTION_CHANGED',()=>query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[company])],
    ['HIGGSFIELD_CONNECTION_CHANGED',()=>query('UPDATE higgsfield_connections SET id=$2 WHERE company_id=$1',[company,randomUUID()])],
    ['HIGGSFIELD_PROJECT_AUTHORITY_CHANGED',()=>query("UPDATE studio_projects SET ai_policy='restricted' WHERE id=$1",[project])],
    ['HIGGSFIELD_PROJECT_AUTHORITY_CHANGED',()=>query("UPDATE studio_projects SET gates='{}' WHERE id=$1",[project])],
    ['HIGGSFIELD_PROJECT_AUTHORITY_CHANGED',()=>query("UPDATE studio_projects SET status='delivered' WHERE id=$1",[project])],
    ['HIGGSFIELD_WORK_CHANGED',()=>query("UPDATE studio_role_bindings SET human_id=$2 WHERE company_id=$1 AND role_key='comp'",[company,approver])],
   ];
   for(const [code,change]of changes){await restoreAuthority();const {j}=await queued();await change();const result=await reconcileHiggsfieldJobs(2),stopped=await job(j.id);assert.equal(stopped.status,'blocked',code);assert.equal(stopped.diagnostic_code,code);assert.equal(stopped.next_poll_at,null);assert.equal(result.blocked,1);assert.equal(polled.length,0);}
  });
  await t.test('revocation while the official status read is in flight prevents accepting returned output',async()=>{
   await restoreAuthority();const {j}=await queued();onPoll=async id=>{await query("UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1",[company]);return poll(id,{status:'completed',result_url:'https://media.higgsfield.example/revoked.png?signature='+privateSignature});};
   await reconcileHiggsfieldJobs(2);assert.equal(polled.length,1);assert.equal((await job(j.id)).status,'blocked');assert.equal((await query('SELECT count(*)::int count FROM higgsfield_job_outputs WHERE job_id=$1',[j.id])).rows[0].count,0);
  });
  await t.test('unrecognized polling schema is stopped locally and mismatched provider job IDs stay unresolved',async()=>{
   await restoreAuthority();let q=await queued();await query('UPDATE higgsfield_connections SET tools=$2 WHERE company_id=$1',[company,JSON.stringify([{name:'jobs_wait',inputSchema:{type:'object',properties:{job_ids:{type:'array'}},required:['job_ids']}}])]);await reconcileHiggsfieldJobs(2);assert.equal((await job(q.j.id)).diagnostic_code,'HIGGSFIELD_POLL_SCHEMA_UNSUPPORTED');assert.equal(polled.length,0);
   await restoreAuthority();q=await queued();onPoll=async()=>poll(randomUUID(),{status:'completed',result_url:'https://media.higgsfield.example/wrong.png'});await reconcileHiggsfieldJobs(2);const unresolved=await job(q.j.id);assert.equal(unresolved.status,'unresolved');assert.equal(unresolved.diagnostic_code,'HIGGSFIELD_JOB_SET_MISMATCH');assert.equal(unresolved.next_poll_at,null);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_job_outputs WHERE job_id=$1',[q.j.id])).rows[0].count,0);
  });
  await t.test('a changed known model conflicts instead of silently relabeling the original job',async()=>{
   await restoreAuthority();const {j}=await queued();onPoll=async id=>poll(id,{model:'different-model',status:'completed',result_url:'https://media.higgsfield.example/different-model.png'});await reconcileHiggsfieldJobs(2);const changed=await job(j.id);assert.equal(changed.status,'conflict');assert.equal(changed.model,'synthetic-model');assert.equal(changed.diagnostic_code,'HIGGSFIELD_PROVIDER_CONFLICT');assert.equal((await query('SELECT count(*)::int count FROM higgsfield_job_outputs WHERE job_id=$1',[j.id])).rows[0].count,0);
  });
  await t.test('a same-connection OAuth refresh defers a read and resumes after credentials recover',async()=>{
   await restoreAuthority();const {j,providerId}=await queued();await query("UPDATE higgsfield_connections SET status='reconnect_required',sealed=NULL WHERE company_id=$1",[company]);await reconcileHiggsfieldJobs(2);const deferred=await job(j.id);assert.equal(deferred.status,'queued');assert.equal(deferred.diagnostic_code,'HIGGSFIELD_CONNECTION_REFRESH_PENDING');assert(deferred.next_poll_at);assert.equal(deferred.poll_attempts,0);assert.equal(polled.length,0);
   await query("UPDATE higgsfield_connections SET status='connected',sealed=$2 WHERE company_id=$1",[company,JSON.stringify(sealed)]);await query("UPDATE higgsfield_jobs SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);onPoll=async id=>poll(id,{status:'in_progress'});await reconcileHiggsfieldJobs(2);assert.deepEqual(polled,[providerId]);assert.equal((await job(j.id)).status,'running');assert.equal((await job(j.id)).poll_attempts,1);
  });
  await t.test('transport uncertainty and an expired worker lease retry only bounded status reads',async()=>{
   await restoreAuthority();const {providerId,j}=await queued();onPoll=async()=>{throw Error('Synthetic lost status response');};await reconcileHiggsfieldJobs(2);assert.equal((await job(j.id)).diagnostic_code,'HIGGSFIELD_POLL_TRANSPORT_UNCERTAIN');assert.equal((await job(j.id)).poll_lease_id,null);assert.deepEqual(polled,[providerId]);
   await query("UPDATE higgsfield_jobs SET next_poll_at=clock_timestamp()-interval '1 second',poll_lease_id=$2,poll_lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[j.id,randomUUID()]);await reconcileHiggsfieldJobs(2);assert.equal(polled.length,1);
   await query("UPDATE higgsfield_jobs SET poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);onPoll=async id=>poll(id,{status:'in_progress'});await reconcileHiggsfieldJobs(2);assert.deepEqual(polled,[providerId,providerId]);assert.equal((await job(j.id)).status,'running');assert.equal((await job(j.id)).poll_attempts,2);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_job_receipts WHERE request_id=$1',[(await job(j.id)).request_id])).rows[0].count,1);
  });
  await t.test('read budget, expiry and tenant-scoped cursor validation remain bounded',async()=>{
   for(const clause of["poll_attempts=1440","deadline_at=clock_timestamp()-interval '1 second'"]){await restoreAuthority();const {j}=await queued();await query(`UPDATE higgsfield_jobs SET ${clause} WHERE id=$1`,[j.id]);await reconcileHiggsfieldJobs(2);assert.equal((await job(j.id)).diagnostic_code,'HIGGSFIELD_POLL_BUDGET_EXHAUSTED');assert.equal(polled.length,0);}
   await assert.rejects(()=>reconcileHiggsfieldJobs(3),/limit/);await assert.rejects(()=>list({projectId:foreignProject}),/Project not found/);await assert.rejects(()=>list({requestId:randomUUID()}),/request not found/);await assert.rejects(()=>list({after:randomUUID()}),/cursor not found/);
   const first=await list({limit:1});assert.equal(first.jobs.length,1);assert.equal(first.hasMore,true);const next=await list({after:first.nextAfter!,limit:1});assert.notEqual(next.jobs[0].id,first.jobs[0].id);const different=next.jobs[0].requestId;await assert.rejects(()=>list({requestId:different,after:first.jobs[0].id}),/cursor not found/);
  });
  await t.test('company deletion removes the dependent job evidence and private locator graph',async()=>{
   await query('DELETE FROM companies WHERE id=$1',[company]);for(const table of['higgsfield_job_receipts','higgsfield_jobs','higgsfield_job_observations','higgsfield_job_outputs','higgsfield_output_locators','higgsfield_provider_responses'])assert.equal((await query(`SELECT count(*)::int count FROM ${table} WHERE company_id=$1`,[company])).rows[0].count,0);
  });
 }finally{
  globalThis.fetch=before.fetch;await database().end();delete(globalThis as any).coatriaPool;await server.stop();await db.close();
  for(const[key,value]of Object.entries({DATABASE_URL:before.url,DATABASE_POOL_MAX:before.pool,COATRIA_HOSTING_KEYRING:before.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
