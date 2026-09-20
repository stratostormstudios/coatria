import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {query,transaction} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret,openHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {recordHiggsfieldSubmission,listHiggsfieldJobs,reconcileHiggsfieldJobs} from '../src/lib/higgsfield-jobs';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();
const pollSchema={type:'object',additionalProperties:false,required:['jobs'],properties:{jobs:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['index','job_id'],properties:{index:{type:'integer',minimum:0},job_id:{type:'string',format:'uuid'}}}},timeout_seconds:{type:'number',minimum:0,maximum:300}}};
const envelope=(structuredContent:unknown)=>({content:[],structuredContent});
const submission=(id:string)=>envelope({results:[{id,type:'image',model:'synthetic-model',params:{prompt:'Synthetic original concept'},status:'queued'}]});
const poll=(id:string,locator?:string)=>envelope({jobs:[{index:0,job_id:id,type:'image',model:'synthetic-model',status:locator?'completed':'in_progress',...(locator?{result_url:locator}:{})}],all_terminal:!!locator,summary:{active:locator?0:1,completed:locator?1:0,failed:0,errors:0,total:1}});

// CI's PostgreSQL owner creates a unique database and LOGIN. No shared test rows,
// global runtime-role mutations, real credentials or provider calls are used.
test('PostgreSQL runtime grants preserve Higgsfield execution, evidence and concurrent adoption',{skip:!localPostgres,timeout:180000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_higgsfield_'+suffix,role='coatria_higgsfield_runtime_'+suffix;
 const prior={url:process.env.DATABASE_URL,key:process.env.COATRIA_HOSTING_KEYRING,pool:(globalThis as any).coatriaPool as Pool|undefined,fetch:globalThis.fetch};
 const control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000});
 const ownerUrl=new URL(integration!);ownerUrl.pathname='/'+dbName;
 let owner:Pool|undefined,runtime:Pool|undefined,databaseCreated=false,roleCreated=false;
 const company=randomUUID(),ownerId=randomUUID(),project=randomUUID(),taskId=randomUUID(),workId=randomUUID(),connectionId=randomUUID(),session=randomUUID(),providerId=randomUUID();
 const access='fixture-access-'+randomUUID(),locator='https://media.higgsfield.example/synthetic.png?signature='+randomUUID();
 const prefix=`companies/${company}/higgsfield`;
 let generates=0,polls=0,completed=false;
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://mcp.higgsfield.ai/mcp','All outbound calls must be intercepted synthetic MCP requests');
  assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+access);
  const message=JSON.parse(String(init?.body));
  if(message.method==='notifications/initialized')return new Response(null,{status:202});
  if(message.method==='initialize')return Response.json({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
  assert.equal(message.method,'tools/call');let result:unknown;
  if(message.params.name==='generate_image'){generates++;assert.equal(generates,1,'The approved synthetic dispatch must never retry');result=submission(providerId);}
  else{assert.equal(message.params.name,'jobs_wait');assert.deepEqual(message.params.arguments,{jobs:[{index:0,job_id:providerId}],timeout_seconds:0});polls++;result=poll(providerId,completed?locator:undefined);}
  return Response.json({jsonrpc:'2.0',id:message.id,result});
 };
 const identity=async(client:Pool|PoolClient=runtime!)=>{const row=(await client.query('SELECT current_user,session_user,pg_backend_pid() AS pid')).rows[0];assert.equal(row.current_user,role);assert.equal(row.session_user,role);return row.pid as number;};
 const api=async(path:string,body?:unknown,expected=200)=>{
  const response=await handleApi(new Request('https://coatria.com/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://coatria.com',Cookie:'coatria_session='+session,...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}}),path.split('?')[0].split('/'));
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));for(const secret of[access,locator,'ciphertext'])assert(!JSON.stringify(value).includes(secret));return value;
 };
 try{
  // Identifiers and password are generated fixed-format test values, never URL input.
  await control.query(`CREATE DATABASE ${dbName}`);databaseCreated=true;
  owner=new Pool({connectionString:ownerUrl.href,max:2,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){
   await owner.query(await readFile('database/'+file,'utf8'));
   await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
  }
  const password=randomBytes(32).toString('hex');
  await control.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await owner.query((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',role));
  const runtimeUrl=new URL(ownerUrl);runtimeUrl.username=role;runtimeUrl.password=password;
  runtime=new Pool({connectionString:runtimeUrl.href,max:2,connectionTimeoutMillis:10000,statement_timeout:15000});
  (globalThis as any).coatriaPool=runtime;process.env.DATABASE_URL=runtimeUrl.href;
  process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}});
  await identity();
  const grants=(await runtime.query("SELECT has_table_privilege(current_user,'higgsfield_provider_responses','INSERT') AS can_insert,has_table_privilege(current_user,'higgsfield_provider_responses','SELECT') AS can_select,has_column_privilege(current_user,'higgsfield_provider_responses','sealed','SELECT') AS can_read_sealed")).rows[0];
  assert.deepEqual(grants,{can_insert:true,can_select:false,can_read_sealed:false});
  await owner.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic owner',$2,'not-a-login')",[ownerId,ownerId+'@example.invalid']);
  await owner.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Isolated PostgreSQL fixture',$2,'blank')",[company,company]);
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[company,ownerId]);
  await owner.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(session),ownerId]);
  await owner.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[company,ownerId]);
  const gates=Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved',recordedBy:ownerId}]));
  await owner.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Synthetic project','Internal','Synthetic original production',$3,'allowed','production',$4,$5,'higgsfield')",[project,company,JSON.stringify({width:128,height:128,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),JSON.stringify(gates),ownerId]);
  await owner.query("INSERT INTO tasks(id,company_id,title,created_by,assignee_id) VALUES($1,$2,'Synthetic generation task',$3,$3)",[taskId,company,ownerId]);
  await owner.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[workId,company,project,taskId]);
  await owner.query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[company,ownerId]);
  const sealed=sealHiggsfieldSecret({token:{access_token:access,token_type:'Bearer',expires_in:3600}},{companyId:company,id:connectionId,purpose:'oauth-connection'});
  const tools=[{name:'generate_image',description:'Synthetic generator',inputSchema:{type:'object',required:['prompt'],properties:{prompt:{type:'string'}},additionalProperties:false}},{name:'jobs_wait',description:'Synthetic status reader',inputSchema:pollSchema}];
  await owner.query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour',$5)",[company,connectionId,ownerId,JSON.stringify(sealed),JSON.stringify(tools)]);

  let requestId:string,jobId:string;
  await t.test('actual runtime proposal and execute commit a sealed receipt and exact replay never resubmits',async()=>{
   const proposed=await api(prefix+'/requests',{clientId:randomUUID(),projectId:project,projectRevision:1,workItemId:workId,tool:'generate_image',arguments:{prompt:'Synthetic original concept'},note:'Only the local mocked provider can receive this.'},201);
   requestId=proposed.request.id;
   const body={requestHash:proposed.request.requestHash,creditConsent:true},executed=await api(`${prefix}/requests/${requestId}/execute`,body);
   assert.equal(executed.status,'returned');assert.equal(executed.result.outcome,'jobs');assert.equal(executed.result.providerJobCount,1);assert.equal(executed.mediaCompleted,false);
   assert.equal((await api(`${prefix}/requests/${requestId}/execute`,body)).replayed,true);assert.equal(generates,1);
   const saved=(await query('SELECT * FROM higgsfield_requests WHERE id=$1',[requestId])).rows[0];
   assert.deepEqual(await transaction(db=>recordHiggsfieldSubmission(db,saved,submission(providerId))),executed.result);
   const page=await api(`${prefix}/jobs?projectId=${project}`);assert.equal(page.jobs.length,1);jobId=page.jobs[0].id;
   const rows=(await owner!.query("SELECT id,sealed FROM higgsfield_provider_responses WHERE request_id=$1 AND source='submission'",[requestId])).rows;
   assert.equal(rows.length,1);assert.deepEqual(openHiggsfieldSecret(rows[0].sealed,{companyId:company,id:rows[0].id,purpose:'provider-response'}),submission(providerId));
  });
  await t.test('restricted status polling handles identical encrypted ON CONFLICT receipts and completes without verifying bytes',async()=>{
   assert(jobId!,'The execute test must have created a durable job');
   // Identical running observations intentionally exercise the journal conflict
   // path twice without granting ordinary runtime SELECT on encrypted evidence.
   for(let i=0;i<3;i++){
    completed=i===2;
    await owner!.query("UPDATE higgsfield_jobs SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1",[jobId]);
    await identity();assert.deepEqual(await reconcileHiggsfieldJobs(2),{checked:1,blocked:0,providerGenerationsSubmitted:0});
   }
   assert.equal(polls,3);assert.equal(generates,1);
   const page=await transaction(db=>listHiggsfieldJobs(db,company,{projectId:project,requestId}));
   assert.equal(page.jobs[0].status,'completed');assert.equal(page.jobs[0].pollAttempts,3);assert.equal(page.jobs[0].outputs.length,1);assert.equal(page.jobs[0].outputs[0].bytesVerified,false);
   for(const secret of[access,locator,'ciphertext'])assert(!JSON.stringify(page).includes(secret));
   const rows=(await owner!.query("SELECT id,sealed FROM higgsfield_provider_responses WHERE request_id=$1 AND source='poll'",[requestId])).rows;
   assert.equal(rows.length,2,'Identical polls must keep one append-only encrypted response');
   assert(rows.some(row=>JSON.stringify(openHiggsfieldSecret(row.sealed,{companyId:company,id:row.id,purpose:'provider-response'}))===JSON.stringify(poll(providerId,locator))));
   assert.equal((await owner!.query('SELECT count(*)::int count FROM higgsfield_job_observations WHERE job_id=$1',[jobId])).rows[0].count,3);
   assert.equal((await query('SELECT status FROM tasks WHERE id=$1',[taskId])).rows[0].status,'todo');
   for(const table of['project_storage_versions','studio_artifacts','studio_reviews','studio_deliveries'])assert.equal((await owner!.query(`SELECT count(*)::int count FROM ${table} WHERE company_id=$1`,[company])).rows[0].count,0);
  });
  await t.test('runtime cannot rewrite immutable evidence or job identity, even after denied-query reconnection',async()=>{
   for(const table of['higgsfield_job_receipts','higgsfield_job_observations','higgsfield_job_outputs','higgsfield_output_locators','higgsfield_provider_responses']){
    const column=table==='higgsfield_output_locators'||table==='higgsfield_provider_responses'?'sealed':'company_id';
    await assert.rejects(query(`UPDATE ${table} SET ${column}=${column} WHERE company_id=$1`,[company]),{code:'42501'},table+' must be append-only');
    await assert.rejects(query(`DELETE FROM ${table} WHERE company_id=$1`,[company]),{code:'42501'});await identity();
   }
   for(const column of['connection_id','provider_job_id','request_id','company_id','project_id','kind','model','deadline_at']){
    await assert.rejects(query(`UPDATE higgsfield_jobs SET ${column}=${column} WHERE company_id=$1`,[company]),{code:'42501'},column+' must be immutable');await identity();
   }
   await assert.rejects(query('SELECT sealed FROM higgsfield_provider_responses WHERE company_id=$1',[company]),{code:'42501'});
   await assert.rejects(query('SELECT * FROM higgsfield_provider_responses'),{code:'42501'});
   const client=await runtime!.connect(),oldPid=await identity(client);client.release(true);
   assert.notEqual(await identity(),oldPid,'Replacement connections must authenticate as the restricted LOGIN too');
  });
  await t.test('two concurrent request transactions adopt the same provider account job at most once',async()=>{
   const sharedId=randomUUID(),response=submission(sharedId),requests:Record<string,any>[]=[];
   for(let i=0;i<2;i++){
    const id=randomUUID();requests.push((await owner!.query("INSERT INTO higgsfield_requests(id,company_id,project_id,requested_by,client_id,project_revision,connection_id,connection_revision,tool,arguments,note,request_hash,status,approved_by,dispatched_at,work_item_id,task_revision,role_human_id) VALUES($1,$2,$3,$4,$5,1,$6,1,'generate_image',$7,'Synthetic confirmed dispatch',$8,'returned',$4,clock_timestamp(),$9,1,$4) RETURNING *",[id,company,project,ownerId,randomUUID(),connectionId,JSON.stringify({prompt:'Synthetic '+i}),hashToken(id),workId])).rows[0]);
   }
   const clients=await Promise.all([runtime!.connect(),runtime!.connect()]);
   try{
    assert.notEqual(await identity(clients[0]),await identity(clients[1]),'Competing adoptions need independent PostgreSQL sessions');
    await Promise.all(clients.map(client=>client.query('BEGIN')));
    const adopt=async(client:PoolClient,index:number)=>{try{const result=await recordHiggsfieldSubmission(client,requests[index],response);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}};
    const settled=await Promise.allSettled(clients.map(adopt));
    for(const result of settled)if(result.status==='rejected')throw result.reason;
    const results=settled.map(result=>(result as PromiseFulfilledResult<Awaited<ReturnType<typeof recordHiggsfieldSubmission>>>).value);
    assert.deepEqual(results.map(result=>result.outcome).sort(),['jobs','unsupported']);
    assert.equal(results.find(result=>result.outcome==='unsupported')?.code,'HIGGSFIELD_JOB_ALREADY_BOUND');
    assert.deepEqual(results.map(result=>result.providerJobCount).sort(),[0,1]);
   }finally{clients.forEach(client=>client.release());}
   const bound=(await query('SELECT request_id FROM higgsfield_jobs WHERE company_id=$1 AND connection_id=$2 AND provider_job_id=$3',[company,connectionId,sharedId])).rows;
   assert.equal(bound.length,1);
   const receipts=(await query('SELECT request_id,outcome FROM higgsfield_job_receipts WHERE request_id=ANY($1::uuid[])',[requests.map(row=>row.id)])).rows;
   assert.equal(receipts.length,2);assert.equal(receipts.find(row=>row.outcome==='jobs')?.request_id,bound[0].request_id);
   assert.equal((await owner!.query('SELECT count(*)::int count FROM higgsfield_provider_responses WHERE request_id=ANY($1::uuid[])',[requests.map(row=>row.id)])).rows[0].count,2);
   assert.equal(generates,1);assert.equal(polls,3,'Adopting confirmed receipts must not call the provider');
  });
 }finally{
  globalThis.fetch=prior.fetch;if(prior.pool)(globalThis as any).coatriaPool=prior.pool;else delete(globalThis as any).coatriaPool;
  for(const[key,value]of Object.entries({DATABASE_URL:prior.url,COATRIA_HOSTING_KEYRING:prior.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  try{await runtime?.end();await owner?.end();}finally{
   try{if(databaseCreated){
    // Pool.end can resolve after its client list empties but before every backend
    // has finished disconnecting. A forced DROP then terminates an idle client's
    // socket and emits an error after the concurrent-adoption subtest passed.
    // Wait for this unique fixture database to drain; never hide leaked sessions.
    const deadline=performance.now()+10000;
    while((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0].count){
     assert(performance.now()<deadline,'Fixture database sessions must drain before teardown');await delay(20);
    }
    await control.query(`DROP DATABASE ${dbName}`);
   }}finally{try{if(roleCreated)await control.query(`DROP ROLE ${role}`);}finally{await control.end();}}
  }
 }
});
