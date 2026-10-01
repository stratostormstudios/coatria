import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {Pool, type PoolClient} from 'pg';
import {ApiError, hashToken} from '../src/lib/security';
import {createProjectStorageConnection, bindProjectStorage} from '../src/lib/project-storage';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import * as preparation from '../src/lib/project-image-preparations';
import {executeAgentTaskAction} from '../src/lib/agent-task-actions';
import {canonicalStudioReview,decideStudioPlanningReview,readStudioPlanningReview,saveStudioReviewPolicy} from '../src/lib/studio-review-policy';
import type {ProjectImagePreparationActor, ProjectImagePreparationLease, ProjectImagePreparationProcessor, ProjectImagePreparationTransformResult} from '../src/lib/project-image-preparations-protocol';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

type Row = Record<string, any>;
type Options = {runtime: (db: PoolClient, companyId: string, projectId: string, processorId?: string) => Promise<ProjectImagePreparationProcessor | null>};
const capabilities = ['storage.read', 'studio.read', 'studio.write', 'tasks.write'];
function denied(statuses = [400, 403, 404, 409, 503]) {
  return (error: unknown) => { assert.ok(error instanceof ApiError, 'Expected an intentional authority/admission rejection, not a SQL/runtime failure'); assert.ok(statuses.includes(error.status), `${error.status}: ${error.code}`); assert.doesNotMatch(error.message, /rps_synthetic|user_synthetic|private-etag|coatria\/companies\/|postgresql:/); return true; };
}

test('explicit image preparation handoff preserves the submitted objective and finite authority', {timeout: 180_000}, async t => {
  const oldKey = process.env.COATRIA_HOSTING_KEYRING, oldFetch = globalThis.fetch;
  const integration = process.env.COATRIA_TEST_EMULATOR === '1' ? undefined : process.env.COATRIA_INTEGRATION_DATABASE_URL;
  const files = (await readdir('database')).filter(file => /^\d.*\.sql$/.test(file)).sort();
  let pool: Pool, stop: () => Promise<void>, outbound = 0;
  if (integration) {
    const url = new URL(integration); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only a disposable localhost integration database is allowed');
    const control = new Pool({connectionString: integration, max: 1}), name = 'coatria_image_preparation_' + randomUUID().replaceAll('-', '');
    await control.query('CREATE DATABASE ' + name); url.pathname = '/' + name;
    pool = new Pool({connectionString: url.href, max: 5});
    stop = async () => { await pool.end(); try { await dropFixtureDatabase(control, name); } finally { await control.end(); } };
    try { for (const file of files) await pool.query(await readFile('database/' + file, 'utf8')); } catch (error) { await stop(); throw error; }
  } else {
    const {PGlite} = await import('@electric-sql/pglite'), {PGLiteSocketServer} = await import('@electric-sql/pglite-socket'), db = await PGlite.create();
    try { for (const file of files) await db.exec(await readFile('database/' + file, 'utf8')); } catch (error) { await db.close(); throw error; }
    const socket = new PGLiteSocketServer({db, host: '127.0.0.1', port: 0, maxConnections: 1}); await socket.start();
    pool = new Pool({connectionString: 'postgresql://postgres:postgres@' + socket.getServerConn() + '/postgres', max: 1});
    stop = async () => { await pool.end(); await socket.stop(); await db.close(); };
  }
  process.env.COATRIA_HOSTING_KEYRING = JSON.stringify({activeKeyId: 'preparation-fixture', keys: {'preparation-fixture': randomBytes(32).toString('base64')}});
  globalThis.fetch = async () => { outbound++; throw Error('Offline image preparation control tests prohibit provider requests'); };
  const query = (sql: string, values: unknown[] = []) => pool.query(sql, values);
  async function transaction<T>(run: (db: PoolClient) => Promise<T>) { const db = await pool.connect(); try { await db.query('BEGIN'); const value = await run(db); await db.query('COMMIT'); return value; } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); } }
  async function fixture(stage='references',execution='agent') {
    const company = randomUUID(), owner = randomUUID(), admin = randomUUID(), member = randomUUID(), outsider = randomUUID(), agentSponsor = randomUUID(), storageSponsor = randomUUID(), project = randomUUID(), shot = randomUUID(), task = randomUUID(), work = randomUUID(), destination = randomUUID();
    for (const user of [owner, admin, member, outsider, agentSponsor, storageSponsor]) await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic preparation authority',$2,'not-a-login')", [user, user + '@example.invalid']);
    await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Offline preparation control fixture',$2,'blank')", [company, company]);
    await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($1,$5,'admin'),($1,$6,'admin')", [company, owner, admin, member, agentSponsor, storageSponsor]);
    await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)", [company, owner]);
    const gates = Object.fromEntries(['brief', 'estimate', 'production'].map(gate => [gate, {decision: 'approved', recordedBy: admin}]));
    await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Synthetic image preparation','Internal','Control metadata only; no media was transformed',$3,'allowed','production',$4,$5,'higgsfield',2)", [project, company, JSON.stringify({kind: 'image', format: 'png', width: 96, height: 64, color: {mode: 'not_required'}}), JSON.stringify(gates), owner]);
    await query("INSERT INTO studio_shots(id,company_id,project_id,code,description,frame_start,frame_end,handles,disciplines,media_kind) VALUES($1,$2,$3,'SYNTHETIC','Metadata fixture only',NULL,NULL,NULL,'[]','image')", [shot, company, project]);
    await query("INSERT INTO tasks(id,company_id,title,description,created_by,assignee_id) VALUES($1,$2,'Prepare one approved original','Keep the original intact and review a separate derivative',$3,$3)", [task, company, owner]);
    await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution,shot_id) VALUES($1,$2,$3,'preparation-fixture',$4,$6,'ingest',$7,$5)", [work, company, project, task, shot,stage,execution]);
    await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)", [company, owner]);
    const actor: ProjectImagePreparationActor = {companyId: company, userId: owner}, adminActor: ProjectImagePreparationActor = {companyId: company, userId: admin}, memberActor: ProjectImagePreparationActor = {companyId: company, userId: member}, outsiderActor: ProjectImagePreparationActor = {companyId: company, userId: outsider};
    const connection = (await transaction(db => createProjectStorageConnection(db, {companyId: company, userId: storageSponsor}, {clientId: randomUUID(), name: 'Private synthetic storage', region: 'US-CA-2', volumeId: 'synthetic-volume', accessKeyId: 'user_syntheticaccess', secretAccessKey: 'rps_syntheticsecret'}))).connection;
    const binding = (await transaction(db => bindProjectStorage(db, actor, project, {clientId: randomUUID(), revision: 0, connectionId: connection.id}))).binding;
    await query('INSERT INTO project_storage_folders(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)', [destination, company, project, binding.id, 'Prepared images', owner]);
    // These rows are synthetic database fixtures, not inspection, storage or
    // transformation proof. Real byte/pixel acceptance is tested separately.
    async function stored({bytes = 1000, contentType = 'image/png', verified = true} = {}) {
      const file = randomUUID(), version = randomUUID(), sha = hashToken(version), objectKey = `coatria/companies/${company}/projects/${project}/objects/${version}`;
      await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)', [file, company, project, binding.id, 'original-' + file + '.png', owner]);
      await query('INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)', [version, company, project, file, bytes, sha, contentType, objectKey, owner]);
      if (verified) await query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'private-etag',$6)", [company, project, version, bytes, sha, randomUUID()]);
      return {file, version, bytes, sha, objectKey};
    }
    const source = await stored();
    let processor: ProjectImagePreparationProcessor | null = {id: randomUUID(), location: 'Synthetic offline binary processor', transport: 'linux_binary_v1', qualificationSha256: 'a'.repeat(64), releaseSha256: 'b'.repeat(64), profileSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), closureSha256: 'e'.repeat(64), recipeSha256: IMAGE_PREPARATION_RECIPE_HASH, expiresAt: new Date(Date.now() + 3_600_000).toISOString()};
    const originalProcessor = structuredClone(processor);
    const options: Options = {runtime: async (_db, currentCompany, currentProject) => { assert.equal(currentCompany, company); assert.equal(currentProject, project); return processor ? structuredClone(processor) : null; }};
    const input = (patch: Row = {}) => ({clientId: randomUUID(), projectId: project, projectRevision: 1, workItemId: work, sourceVersionId: source.version, sourceSha256: source.sha, sourceBytes: source.bytes, destinationFolderId: destination, destinationName: 'prepared-' + randomUUID() + '.png', purpose: 'Synthetic control-plane fixture; no bytes transformed', ...patch});
    const propose = (data: unknown = input(), who = actor) => transaction(db => preparation.proposeProjectImagePreparation(db, who, data));
    const get = (id: string, who = actor) => transaction(db => preparation.getProjectImagePreparation(db, who, id));
    const approval = (row: Row, patch: Row = {}) => ({clientId: randomUUID(), revision: row.revision, requestHash: row.requestHash, processorId: originalProcessor.id, qualificationSha256: originalProcessor.qualificationSha256, expiresInMinutes: 30, maxCostMicrousd: 10_000, processingConsent: true, derivativeWriteConsent: true, adoptionConsent: true, ...patch});
    const approve = (row: Row, data: unknown = approval(row), who = adminActor, opts: Options | undefined = options) => transaction(db => preparation.approveProjectImagePreparation(db, who, row.id, data, opts));
    const claim = (opts: Options | undefined = options) => transaction(db => preparation.claimProjectImagePreparation(db, {companyId: company, projectIds: [project]}, opts));
    const authorize = (lease: ProjectImagePreparationLease, opts = options) => transaction(db => preparation.authorizeProjectImagePreparation(db, lease, opts));
    const begin = (lease: ProjectImagePreparationLease, opts = options) => transaction(db => preparation.beginProjectImagePreparationPhase(db, lease, 'transform', opts));
    const result = (patch: Row = {}): ProjectImagePreparationTransformResult & {operation: 'transform'} => ({operation: 'transform', sourceVersionId: source.version, sourceSha256: source.sha, sourceBytes: source.bytes, source: {format: 'png', width: 96, height: 64, orientation: 1}, recipeSha256: IMAGE_PREPARATION_RECIPE_HASH, processor: originalProcessor, output: {bytes: 250, sha256: 'f'.repeat(64), width: 96, height: 64, format: 'png', pixelFormat: 'rgba8', metadataRemoved: true}, ...patch});
    const complete = (lease: ProjectImagePreparationLease, actionId: string, value: unknown = result(), opts = options) => transaction(db => preparation.completeProjectImagePreparationPhase(db, lease, actionId, value, opts));
    const approved = async () => { const row = (await propose()).preparation; return (await approve(row)).preparation; };
    const leased = async () => { await approved(); const lease = await claim(); assert.ok(lease); return lease; };
    async function agent() {
      const agentId = randomUUID(), runId = randomUUID(), conversation = randomUUID(), tokenHash = hashToken(randomUUID());
      await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic preparation proposer','custom',$3,$4,'admins',$5)", [agentId, company, tokenHash, agentSponsor, JSON.stringify(capabilities)]);
      await query('INSERT INTO conversations(id,company_id) VALUES($1,$2)', [conversation, company]);
      await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at,started_at,attempts,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic image preparation proposal',$8,'running','fixture',$9,clock_timestamp()+interval '1 hour',clock_timestamp(),1,1)", [runId, company, agentId, owner, conversation, randomUUID(), '1'.repeat(64), JSON.stringify(capabilities), '2'.repeat(64)]);
      await query("UPDATE studio_role_bindings SET agent_id=$2,human_id=NULL WHERE company_id=$1 AND role_key='ingest'", [company, agentId]);
      await query("UPDATE tasks SET status='doing',agent_run_id=$2,assignee_id=NULL WHERE id=$1", [task, runId]);
      return {...actor, agentId, runId, tokenHash};
    }
    const safe = (value: unknown) => { const text = JSON.stringify(value); for (const secret of [source.objectKey, 'private-etag', 'rps_syntheticsecret', 'user_syntheticaccess']) assert.ok(!text.includes(secret)); assert.doesNotMatch(text, /"(?:objectKey|providerEtag|secret_envelope|leaseId|lease_token_hash)"/); };
    return {company, owner, admin, member, outsider, agentSponsor, storageSponsor, project, shot, task, work, destination, actor, adminActor, memberActor, outsiderActor, connection, binding, source, stored, input, propose, get, approval, approve, claim, authorize, begin, result, complete, approved, leased, agent, safe, options, originalProcessor, setProcessor: (value: ProjectImagePreparationProcessor | null) => { processor = value; }};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  type Agent=Awaited<ReturnType<Fixture['agent']>>;
  async function submitted(f:Fixture,a:Agent){
    return transaction(async db=>{
      const agent=(await db.query('SELECT * FROM agents WHERE id=$1',[a.agentId])).rows[0],run=(await db.query('SELECT * FROM agent_runs WHERE id=$1',[a.runId])).rows[0];
      const revision=(await db.query('SELECT revision FROM tasks WHERE id=$1',[f.task])).rows[0].revision;
      const args={taskId:f.task,revision,summary:'Prepare this exact original as a separate PNG; transformation and sharing still require separate human approval.',submissionUrl:'https://example.invalid/synthetic-plan',tokensUsed:0};
      const response=await executeAgentTaskAction(db,agent,run,'owner','tasks_submit',args);
      // Same committed tool result shape as dispatch, without a model/provider.
      await db.query("INSERT INTO agent_tool_receipts(company_id,agent_id,run_id,request_id,tool,request_hash,response) VALUES($1,$2,$3,$4,'tasks_submit',$5,$6)",[f.company,a.agentId,a.runId,randomUUID(),hashToken(JSON.stringify(args)),JSON.stringify(response)]);
      return response;
    });
  }
  async function finished(f:Fixture,a:Agent,withReceipt=true){
    return transaction(async db=>{
      const messageId=randomUUID();
      await db.query("INSERT INTO messages(id,company_id,conversation_id,sequence,last_event_sequence,actor_kind,agent_id,body) SELECT $2,company_id,conversation_id,1,1,'agent',agent_id,'Synthetic committed planning completion; no bytes were processed' FROM agent_runs WHERE id=$1",[a.runId,messageId]);
      await db.query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),result_message_id=$2 WHERE id=$1",[a.runId,messageId]);
      if(withReceipt)await db.query("INSERT INTO agent_run_receipts(company_id,run_id,client_id,kind,payload_hash,lease_token_hash,response) VALUES($1,$2,$3,'complete',$4,$5,$6)",[f.company,a.runId,randomUUID(),'3'.repeat(64),'2'.repeat(64),JSON.stringify({run:{id:a.runId,status:'succeeded',resultMessageId:messageId}})]);
      return messageId;
    });
  }
  async function accepted(f:Fixture,reviewer=f.admin){
    // Owner-level synthetic acceptance metadata matches the ordinary human task
    // API. The preparation API must independently validate the pinned evidence.
    await query("UPDATE tasks SET status='done',agent_run_id=NULL,approved_by=$2,revision=revision+1 WHERE id=$1",[f.task,reviewer]);
  }
  async function ready(mode:'submitted_plan_v1'|'exact_task_v1'='submitted_plan_v1'){
    const f=await fixture(),a=await f.agent(),data=f.input(mode==='submitted_plan_v1'?{continuation:mode}:{}),row=(await f.propose(data,a)).preparation;
    return {f,a,data,row};
  }
  async function machineAccepted(f:Fixture,a:Agent){
    const coordinator=randomUUID(),reviewer=randomUUID(),reviewerRun=randomUUID(),reviewId=randomUUID();
    for(const [agentId,sponsor,scope]of [[coordinator,f.owner,['studio.read','studio.write']],[reviewer,f.admin,['studio.read','studio.review']]] as const){
      await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic planning reviewer','custom',$3,$4,'admins',$5)",[agentId,f.company,hashToken(randomUUID()),sponsor,JSON.stringify(scope)]);
      await query("INSERT INTO plugin_installations(company_id,agent_id,installed_by,client_id,request_hash,plugin_id,manifest_version,runtime_config,character) VALUES($1,$2,$3,$4,$5,'synthetic','1','{}','{}')",[f.company,agentId,sponsor,randomUUID(),'5'.repeat(64)]);
    }
    await query("INSERT INTO studio_role_bindings(company_id,role_key,agent_id) VALUES($1,'producer',$2)",[f.company,coordinator]);
    await transaction(db=>saveStudioReviewPolicy(db,{companyId:f.company,userId:f.admin,role:'admin',user:{name:'Synthetic policy administrator'}} as any,f.project,{clientId:randomUUID(),revision:0,coordinatorAgentId:coordinator,reviewerAgentId:reviewer,allowedStages:['references'],allowSharedSponsor:false,maxReviews:10,status:'active',expiresAt:new Date(Date.now()+3_600_000).toISOString()}));
    await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at,started_at,attempts,max_attempts) SELECT $1,company_id,$2,$3,conversation_id,$4,$5,'Synthetic machine planning review','[\"studio.review\"]','running','fixture',$6,clock_timestamp()+interval '1 hour',clock_timestamp(),1,1 FROM agent_runs WHERE id=$7",[reviewerRun,reviewer,f.admin,randomUUID(),'6'.repeat(64),'7'.repeat(64),a.runId]);
    const p=(await query('SELECT * FROM studio_projects WHERE id=$1',[f.project])).rows[0],task=(await query('SELECT * FROM tasks WHERE id=$1',[f.task])).rows[0];
    const brief={id:p.id,name:p.name,brief:p.brief,spec:p.spec,aiPolicy:p.ai_policy,approvedBrief:p.gates.brief};
    const submission={schemaVersion:1,reviewKind:'machine_planning',independentHumanReview:false,contentInspected:false,project:brief,work:{id:f.work,stage:'references',execution:'agent'},task:{id:f.task,revision:task.revision,title:task.title,description:task.description,summary:task.submission_summary,url:task.submission_url,producerAgentId:a.agentId,producerRunId:a.runId},inputReferences:[]};
    const submissionSha=hashToken(canonicalStudioReview(submission));
    // Synthetic review context invokes the actual policy read/decision function.
    // The function, not the fixture, must record the project revision transition.
    await query('INSERT INTO studio_planning_reviews(id,company_id,project_id,work_item_id,task_id,task_revision,policy_revision,parent_run_id,reviewer_run_id,reviewer_agent_id,producer_agent_id,producer_run_id,submission,submission_sha256,brief_sha256) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$7,$11,$12,$13)',[reviewId,f.company,f.project,f.work,f.task,task.revision,a.runId,reviewerRun,reviewer,a.agentId,JSON.stringify(submission),submissionSha,hashToken(canonicalStudioReview(brief))]);
    const agent=(await query('SELECT * FROM agents WHERE id=$1',[reviewer])).rows[0],run=(await query('SELECT * FROM agent_runs WHERE id=$1',[reviewerRun])).rows[0];
    await transaction(db=>readStudioPlanningReview(db,agent,run,{reviewId}));
    const args={reviewId,policyRevision:1,submissionSha256:submissionSha,decision:'approve',note:'Synthetic independent machine planning acceptance of this exact objective; no media byte inspection was performed.'};
    const decision=await transaction(db=>decideStudioPlanningReview(db,agent,run,args));
    assert.equal(decision.task.status,'done');
    assert.equal((await transaction(db=>decideStudioPlanningReview(db,agent,run,args))).replayed,true);
    return {reviewId,reviewer,reviewerRun,before:p.revision};
  }
  try{
    await t.test('explicit agent handoff survives exact submission, committed completion and independent human acceptance',async()=>{
      const {f,a,row}=await ready(); assert.equal(row.continuationMode,'submitted_plan_v1');
      const before=(await query('SELECT work_snapshot,proposer_snapshot,request_hash FROM project_image_preparations WHERE id=$1',[row.id])).rows[0];
      await submitted(f,a); await finished(f,a); await accepted(f); await f.approve(row);
      const lease=await f.claim();assert.ok(lease);await f.authorize(lease);
      assert.deepEqual((await query('SELECT work_snapshot,proposer_snapshot,request_hash FROM project_image_preparations WHERE id=$1',[row.id])).rows[0],before);
      assert.equal((await f.get(row.id)).preparation.status,'reading');
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1',[f.company])).rows[0].n,0);
    });
    await t.test('current doing and review phases need separate finite adoption and never grant sharing or writes',async()=>{
      for(const phase of ['doing','review']){
        const {f,a,row}=await ready();if(phase==='review')await submitted(f,a);
        assert.equal(await f.claim(),null);await f.approve(row);const lease=await f.claim();assert.ok(lease);await f.authorize(lease);
        assert.equal((await f.get(row.id)).preparation.derivation,null);
      }
    });
    await t.test('actual machine decision records the exact project transition and independently accepted plans remain adoptable',async()=>{
      const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);const review=await machineAccepted(f,a);
      const d=(await query('SELECT project_revision_before,project_revision_after,task_revision FROM studio_planning_review_decisions WHERE review_id=$1',[review.reviewId])).rows[0];
      assert.deepEqual(d,{project_revision_before:review.before,project_revision_after:review.before+1,task_revision:3});
      assert.equal((await query('SELECT revision FROM studio_projects WHERE id=$1',[f.project])).rows[0].revision,review.before+1,'Decision replay cannot increment the project twice');
      await f.approve(row);const lease=await f.claim();assert.ok(lease);await f.authorize(lease);
      await assert.rejects(transaction(db=>db.query('UPDATE studio_planning_review_decisions SET project_revision_before=NULL,project_revision_after=NULL WHERE review_id=$1',[review.reviewId])),{code:'42501'});
      assert.equal((await f.get(row.id)).preparation.derivation,null);
    });
    await t.test('machine handoff rejects historical unbound decisions, wrong transition and unrelated project or task changes',async()=>{
      for(const change of ['historical','wrong-transition','wrong-task-revision','project-revision','project-content']){
        const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);const review=await machineAccepted(f,a);
        if(change==='project-revision')await query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.project]);
        else if(change==='project-content')await query("UPDATE studio_projects SET brief='Unrelated project change' WHERE id=$1",[f.project]);
        else await transaction(async db=>{
          // Owner-only fixture replacement simulates a legacy/unbound receipt.
          // Runtime has no UPDATE or DELETE grants on decisions.
          const old=(await db.query('DELETE FROM studio_planning_review_decisions WHERE review_id=$1 RETURNING *',[review.reviewId])).rows[0];
          if(change==='historical'){old.project_revision_before=null;old.project_revision_after=null;}
          if(change==='wrong-transition'){old.project_revision_before++;old.project_revision_after++;}
          if(change==='wrong-task-revision')old.task_revision++;
          const keys=Object.keys(old);await db.query(`INSERT INTO studio_planning_review_decisions(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(old));
        });
        await assert.rejects(f.approve(row),denied());
      }
    });
    await t.test('old exact-task proposals do not inherit submitted-plan authority',async()=>{
      const {f,a,row}=await ready('exact_task_v1');assert.equal(row.continuationMode,'exact_task_v1');
      const snapshot=(await query('SELECT proposer_snapshot FROM project_image_preparations WHERE id=$1',[row.id])).rows[0].proposer_snapshot;
      assert.equal(snapshot.agent.runIdentity,undefined);await submitted(f,a);await finished(f,a);
      await assert.rejects(f.approve(row),denied());
    });
    await t.test('only the current assigned reference agent can opt in; human, generation and unreserved requests fail',async()=>{
      const f=await fixture();await assert.rejects(f.propose(f.input({continuation:'submitted_plan_v1'})),denied([403]));
      for(const change of ['generation','creative','reservation','assignment']){
        const g=await fixture(change==='generation'?'generation':'references',['generation','creative'].includes(change)?'creative':'agent'),a=await g.agent();
        if(change==='reservation')await query('UPDATE tasks SET agent_run_id=NULL WHERE id=$1',[g.task]);
        if(change==='assignment')await query("UPDATE studio_role_bindings SET agent_id=NULL,human_id=$2 WHERE company_id=$1 AND role_key='ingest'",[g.company,g.owner]);
        await assert.rejects(g.propose(g.input({continuation:'submitted_plan_v1'}),a),denied());
      }
    });
    await t.test('same-source semantic objective, assignment and project changes cannot reuse consent',async()=>{
      const mutations=[
        (f:Fixture)=>query("UPDATE tasks SET title='A different objective' WHERE id=$1",[f.task]),
        (f:Fixture)=>query("UPDATE tasks SET description='Replace the original instead' WHERE id=$1",[f.task]),
        (f:Fixture)=>query('UPDATE tasks SET assignee_id=$2 WHERE id=$1',[f.task,f.admin]),
        (f:Fixture)=>query("UPDATE studio_role_bindings SET agent_id=NULL,human_id=$2 WHERE company_id=$1 AND role_key='ingest'",[f.company,f.admin]),
        (f:Fixture)=>query("UPDATE studio_projects SET brief='Different project objective' WHERE id=$1",[f.project]),
      ];
      for(const mutate of mutations){const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);await mutate(f);await assert.rejects(f.approve(row),denied());}
    });
    await t.test('submission requires the original run receipt and immutable revision, summary and URL',async()=>{
      for(const change of ['missing','summary','url','receipt-title','receipt-revision','extra-revision','resubmit']){
        const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);
        if(change==='missing')await query("DELETE FROM agent_tool_receipts WHERE run_id=$1 AND tool='tasks_submit'",[a.runId]);
        if(change==='summary')await query("UPDATE tasks SET submission_summary='Changed submission content' WHERE id=$1",[f.task]);
        if(change==='url')await query("UPDATE tasks SET submission_url='https://example.invalid/changed' WHERE id=$1",[f.task]);
        if(change==='receipt-title')await query("UPDATE agent_tool_receipts SET response=jsonb_set(response,'{title}','\"Changed title\"') WHERE run_id=$1",[a.runId]);
        if(change==='receipt-revision')await query("UPDATE agent_tool_receipts SET response=jsonb_set(response,'{revision}','999') WHERE run_id=$1",[a.runId]);
        if(change==='extra-revision')await query('UPDATE tasks SET revision=revision+1 WHERE id=$1',[f.task]);
        if(change==='resubmit')await query("UPDATE tasks SET status='review',revision=revision+2 WHERE id=$1",[f.task]);
        await assert.rejects(f.approve(row),denied());
      }
    });
    await t.test('a forged success flag, missing completion, mismatched message and expired running lease never revive a proposal',async()=>{
      for(const change of ['status-only','no-receipt','wrong-message','no-finished','expired']){
        const {f,a,row}=await ready();
        if(change==='status-only')await query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1",[a.runId]);
        else if(change==='expired')await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[a.runId]);
        else {await finished(f,a,change!=='no-receipt');if(change==='wrong-message')await query("UPDATE agent_run_receipts SET response=jsonb_set(response,'{run,resultMessageId}',to_jsonb($2::text)) WHERE run_id=$1",[a.runId,randomUUID()]);if(change==='no-finished')await query('UPDATE agent_runs SET finished_at=NULL WHERE id=$1',[a.runId]);}
        await assert.rejects(f.approve(row),denied());
      }
    });
    await t.test('run attempt, start, purpose and installation identity are pinned without changing old-mode grammar',async()=>{
      for(const change of ['attempt','start','purpose','new-installation','installation-revision']){
        const f=await fixture(),a=await f.agent();
        async function installation(){await query("INSERT INTO plugin_installations(company_id,agent_id,installed_by,client_id,request_hash,plugin_id,manifest_version,runtime_config,character) VALUES($1,$2,$3,$4,$5,'synthetic','1','{}','{}')",[f.company,a.agentId,f.owner,randomUUID(),'4'.repeat(64)]);}
        if(change==='installation-revision')await installation();
        const row=(await f.propose(f.input({continuation:'submitted_plan_v1'}),a)).preparation;
        if(change==='attempt')await query('UPDATE agent_runs SET attempts=2,max_attempts=3 WHERE id=$1',[a.runId]);
        if(change==='start')await query("UPDATE agent_runs SET started_at=started_at+interval '1 microsecond' WHERE id=$1",[a.runId]);
        if(change==='purpose')await query("UPDATE agent_runs SET purpose='connection_test' WHERE id=$1",[a.runId]);
        if(change==='new-installation')await installation();
        if(change==='installation-revision')await query('UPDATE plugin_installations SET revision=revision+1 WHERE agent_id=$1',[a.agentId]);
        await assert.rejects(f.approve(row),denied());
      }
    });
    await t.test('acceptance must belong to an independent current administrator and cannot skip review',async()=>{
      for(const reviewer of ['owner','agentSponsor','member','revoked','missing']){
        const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);
        if(reviewer==='revoked')await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.admin]);
        await accepted(f,reviewer==='missing'?null as any:reviewer==='revoked'?f.admin:f[reviewer as 'owner'|'agentSponsor'|'member']);
        await assert.rejects(f.approve(row,undefined,{companyId:f.company,userId:f.storageSponsor}),denied());
      }
      const {f,a,row}=await ready();await finished(f,a);await accepted(f);await assert.rejects(f.approve(row),denied());
    });
    await t.test('revocation and late callback changes fence already adopted handoffs',async()=>{
      for(const principal of ['owner','agentSponsor','storageSponsor','admin'] as const){
        const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);await accepted(f);await f.approve(row);const lease=await f.claim();assert.ok(lease);
        await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f[principal]]);await assert.rejects(f.authorize(lease),denied());
      }
      const {f,a,row}=await ready();await submitted(f,a);await finished(f,a);await accepted(f);
      const late:Options={runtime:async db=>{await db.query("UPDATE tasks SET submission_summary='Changed during qualification lookup' WHERE id=$1",[f.task]);return f.originalProcessor;}};
      await assert.rejects(f.approve(row,undefined,undefined,late),denied());
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparation_approvals WHERE preparation_id=$1',[row.id])).rows[0].n,0);
    });
    await t.test('replay is exact and migration keeps continuation immutable while checking the new snapshot shape',async()=>{
      const {f,a,data,row}=await ready(),replay=await f.propose(data,a);assert.equal(replay.replayed,true);assert.equal(replay.preparation.id,row.id);
      const oldMode:Row={...data};delete oldMode.continuation;await assert.rejects(f.propose(oldMode,a),{code:'IDEMPOTENCY_CONFLICT'});
      await assert.rejects(transaction(db=>db.query("UPDATE project_image_preparations SET continuation_mode='exact_task_v1' WHERE id=$1",[row.id])),{code:'42501'});
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparations WHERE company_id=$1',[f.company])).rows[0].n,1);
      const current=(await query('SELECT * FROM project_image_preparations WHERE id=$1',[row.id])).rows[0];
      for(const patch of [{proposed_agent_id:null,proposed_run_id:null},{work_snapshot:{...current.work_snapshot,status:'review'}},{proposer_snapshot:{...current.proposer_snapshot,agent:{...current.proposer_snapshot.agent,runIdentity:{attempt:1,maxAttempts:1}}}}]){
        const copy={...current,...patch,id:randomUUID()},keys=Object.keys(copy),values=Object.values(copy).map(value=>value&&typeof value==='object'&&!(value instanceof Date)?JSON.stringify(value):value);
        await assert.rejects(transaction(db=>db.query(`INSERT INTO project_image_preparations(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,values)),error=>{assert.ok(['23514','23502','42501'].includes((error as any).code));return true;});
      }
    });
    assert.equal(outbound,0);
  }finally{
    globalThis.fetch=oldFetch;
    if(oldKey===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=oldKey;
    await stop();
  }
});
