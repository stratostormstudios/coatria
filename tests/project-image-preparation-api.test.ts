import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {database, query, transaction} from '../src/lib/db';
import {handleApi} from '../src/lib/api';
import {hashToken} from '../src/lib/security';
import {createProjectStorageConnection, bindProjectStorage} from '../src/lib/project-storage';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';
import * as preparations from '../src/lib/project-image-preparations';
import * as preparationStorage from '../src/lib/project-image-preparation-storage';
import {projectImagePreparationAvailability} from '../src/lib/project-image-preparation-availability';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import {runpodProjectRoot} from '../src/lib/project-storage-runpod';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import type {ProjectImagePreparationProcessor} from '../src/lib/project-image-preparations-protocol';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';

const origin = 'https://coatria.com';
type RequestOptions = {method?: string; payload?: unknown; raw?: string; token?: string | null; origin?: string | null; contentType?: string; headers?: Record<string, string>};

/** Real request dispatch, sessions, membership locks, schemas and persisted
 * control metadata. Stored source verification is synthetic; no bytes are read,
 * transformed or uploaded, and no processor resolver is supplied. */
test('image preparation metadata routes preserve authentication, consent and tenant boundaries', {timeout: 180_000}, async t => {
  const saved = {DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, COATRIA_HOSTING_KEYRING: process.env.COATRIA_HOSTING_KEYRING};
  const oldFetch = globalThis.fetch;
  const integration = process.env.COATRIA_TEST_EMULATOR === '1' ? undefined : process.env.COATRIA_INTEGRATION_DATABASE_URL;
  const migrations = (await readdir('database')).filter(file => /^\d.*\.sql$/.test(file)).sort();
  let stop: (() => Promise<void>) | undefined, outbound = 0;
  assert.equal((globalThis as {coatriaPool?: Pool}).coatriaPool, undefined, 'This test owns an isolated application pool');
  try {
    if (integration) {
      const url = new URL(integration);
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Never use an external database for this fixture');
      const control = new Pool({connectionString: integration, max: 1}), name = 'coatria_preparation_api_' + randomUUID().replaceAll('-', '');
      try { await control.query('CREATE DATABASE ' + name); } catch (error) { await control.end(); throw error; }
      url.pathname = '/' + name; process.env.DATABASE_URL = url.href; process.env.DATABASE_POOL_MAX = '5';
      stop = async () => { try { await dropFixtureDatabase(control, name); } finally { await control.end(); } };
      for (const file of migrations) await query(await readFile('database/' + file, 'utf8'));
    } else {
      const {PGlite} = await import('@electric-sql/pglite'), {PGLiteSocketServer} = await import('@electric-sql/pglite-socket'), db = await PGlite.create();
      try { for (const file of migrations) await db.exec(await readFile('database/' + file, 'utf8')); } catch (error) { await db.close(); throw error; }
      const socket = new PGLiteSocketServer({db, host: '127.0.0.1', port: 0, maxConnections: 1});
      try { await socket.start(); } catch (error) { await db.close(); throw error; }
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@' + socket.getServerConn() + '/postgres'; process.env.DATABASE_POOL_MAX = '1';
      stop = async () => { try { await socket.stop(); } finally { await db.close(); } };
    }
    process.env.COATRIA_HOSTING_KEYRING = JSON.stringify({activeKeyId: 'preparation-api-fixture', keys: {'preparation-api-fixture': randomBytes(32).toString('base64')}});
    globalThis.fetch = async () => { outbound++; throw Error('Image preparation API fixture forbids outbound requests'); };
    async function fixture() {
      const company = randomUUID(), owner = randomUUID(), admin = randomUUID(), member = randomUUID(), outsider = randomUUID(), project = randomUUID(), shot = randomUUID(), task = randomUUID(), work = randomUUID(), folder = randomUUID(), file = randomUUID(), version = randomUUID();
      const sessions = {owner: randomUUID(), admin: randomUUID(), member: randomUUID(), outsider: randomUUID()};
      for (const [name, user] of Object.entries({owner, admin, member, outsider})) {
        await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic API identity',$2,'not-a-login')", [user, user + '@example.invalid']);
        await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [hashToken(sessions[name as keyof typeof sessions]), user]);
      }
      await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic preparation API',$2,'blank')", [company, company]);
      await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member')", [company, owner, admin, member]);
      await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)", [company, owner]);
      const gates = Object.fromEntries(['brief', 'estimate', 'production'].map(key => [key, {decision: 'approved', recordedBy: owner}]));
      await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Synthetic prepared image','Internal','Metadata request fixture only',$3,'allowed','production',$4,$5,'higgsfield',2)", [project, company, JSON.stringify({kind: 'image', format: 'png', width: 96, height: 64, color: {mode: 'not_required'}}), JSON.stringify(gates), owner]);
      await query("INSERT INTO studio_shots(id,company_id,project_id,code,description,frame_start,frame_end,handles,disciplines,media_kind) VALUES($1,$2,$3,'SYNTHETIC','Metadata fixture',NULL,NULL,NULL,'[]','image')", [shot, company, project]);
      await query("INSERT INTO tasks(id,company_id,title,description,created_by,assignee_id) VALUES($1,$2,'Prepare a separate reference','Preserve original bytes',$3,$3)", [task, company, owner]);
      await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution,shot_id) VALUES($1,$2,$3,'preparation-api-fixture',$4,'references','ingest','agent',$5)", [work, company, project, task, shot]);
      await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)", [company, owner]);
      const actor = {companyId: company, userId: owner};
      const connection = (await transaction(db => createProjectStorageConnection(db, actor, {clientId: randomUUID(), name: 'Synthetic private storage', region: 'US-CA-2', volumeId: 'synthetic-volume', accessKeyId: 'user_syntheticaccess', secretAccessKey: 'rps_syntheticsecret'}))).connection;
      const binding = (await transaction(db => bindProjectStorage(db, actor, project, {clientId: randomUUID(), revision: 0, connectionId: connection.id}))).binding;
      await query('INSERT INTO project_storage_folders(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)', [folder, company, project, binding.id, 'Prepared images', owner]);
      await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)', [file, company, project, binding.id, 'original.png', owner]);
      const sourceBytes = 1000, sourceSha256 = hashToken(version), objectKey = 'coatria/companies/' + company + '/projects/' + project + '/objects/' + version;
      await query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'image/png',$7,$8)", [version, company, project, file, sourceBytes, sourceSha256, objectKey, owner]);
      await query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'private-fixture-etag',$6)", [company, project, version, sourceBytes, sourceSha256, randomUUID()]);
      const base = 'companies/' + company + '/image-preparations';
      const input = (patch: Record<string, unknown> = {}) => ({clientId: randomUUID(), projectId: project, projectRevision: 1, workItemId: work, sourceVersionId: version, sourceSha256, sourceBytes, destinationFolderId: folder, destinationName: 'prepared-' + randomUUID() + '.png', purpose: 'Review a separate synthetic reference', ...patch});
      async function api(path = base, options: RequestOptions = {}) {
        const method = options.method ?? 'GET', headers = new Headers(options.headers);
        const token = options.token === undefined ? sessions.owner : options.token;
        if (token !== null) headers.set('Cookie', 'coatria_session=' + token);
        if (method !== 'GET') { if (options.origin !== null) headers.set('Origin', options.origin ?? origin); headers.set('Content-Type', options.contentType ?? 'application/json'); }
        const request = new Request(origin + '/api/' + path, {method, headers, ...method !== 'GET' ? {body: options.raw ?? JSON.stringify(options.payload ?? {})} : {}});
        const response = await handleApi(request, path.split('?')[0].split('/')), value = await response.json();
        const serialized = JSON.stringify(value);
        for (const privateValue of [objectKey, 'private-fixture-etag', 'rps_syntheticsecret', 'user_syntheticaccess', ...Object.values(sessions)]) assert.ok(!serialized.includes(privateValue), 'Responses must not expose private storage or session material');
        assert.doesNotMatch(serialized, /"(?:objectKey|providerEtag|secret_envelope|leaseId|lease_token_hash)"/);
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert.ok(response.headers.get('X-Request-Id'));
        return {status: response.status, value};
      }
      const post = (payload: unknown = input(), options: RequestOptions = {}) => api(base, {...options, method: 'POST', payload});
      async function proposed() { const result = await post(); assert.equal(result.status, 201, JSON.stringify(result.value)); return result.value.preparation; }
      const approval = (row: {revision: number; requestHash: string}, patch: Record<string, unknown> = {}) => ({clientId: randomUUID(), revision: row.revision, requestHash: row.requestHash, processorId: randomUUID(), qualificationSha256: 'a'.repeat(64), expiresInMinutes: 30, maxCostMicrousd: 10000, processingConsent: true, derivativeWriteConsent: true, adoptionConsent: true, ...patch});
      async function agent(extraCapabilities:string[]=[],reserveTask=true) {
        const agentId=randomUUID(),token='ca_'+randomUUID()+randomUUID(),capabilities=['storage.read','studio.read','studio.write','tasks.write',...extraCapabilities];
        await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Synthetic preparation API agent','custom',$3,$4,'admins',$5)",[agentId,company,hashToken(token),owner,JSON.stringify(capabilities)]);
        await query("UPDATE studio_role_bindings SET agent_id=$2,human_id=NULL WHERE company_id=$1 AND role_key='ingest'",[company,agentId]);
        await query('UPDATE tasks SET assignee_id=NULL WHERE id=$1',[task]);
        const created=await api('companies/'+company+'/conversations/commons/runs',{method:'POST',payload:{clientId:randomUUID(),agentId,prompt:'Propose this exact verified original as a separate derivative; wait for human processing consent.'}});
        assert.equal(created.status,201,JSON.stringify(created.value));
        const runId=created.value.run.id;
        // Profile tests prove the production dispatch selects a single attempt;
        // this generic authenticated API fixture pins that same bound directly.
        await query('UPDATE agent_runs SET max_attempts=1 WHERE id=$1',[runId]);
        const headers={Authorization:'Bearer '+token};
        const claimed=await api('agent/runs/claim',{method:'POST',token:null,headers,payload:{claimId:randomUUID(),workerId:'offline-preparation-api'}});
        assert.equal(claimed.status,200,JSON.stringify(claimed.value));assert.equal(claimed.value.run.id,runId);
        const leaseToken=claimed.value.leaseToken;
        const tool=(name:string,args:unknown,requestId=randomUUID(),lease=leaseToken)=>api('agent/tools/'+name,{method:'POST',token:null,headers,payload:{runId,leaseToken:lease,requestId,arguments:args}});
        if(reserveTask){const taskRevision=(await query('SELECT revision FROM tasks WHERE id=$1',[task])).rows[0].revision;
        const reserved=await tool('tasks_claim',{taskId:task,revision:taskRevision});assert.equal(reserved.status,200,JSON.stringify(reserved.value));}
        return {agentId,token,headers,runId,leaseToken,tool};
      }
      return {company, owner, admin, member, project, task, work, folder, version, sessions, base, input, api, post, proposed, approval,agent};
    }
    await t.test('authenticated company metadata supports exact proposal replay and safe list/get', async () => {
      const f = await fixture(), input = f.input(), created = await f.post(input);
      assert.equal(created.status, 201, JSON.stringify(created.value)); const row = created.value.preparation;
      assert.equal(row.status, 'proposed'); assert.equal(row.attempt, 0); assert.equal(row.approval, null); assert.equal(row.derivation, null);
      assert.equal(row.continuationMode, 'exact_task_v1'); assert.equal(created.value.processing.enabled, false); assert.equal(created.value.processing.processor, null);
      const replay = await f.post(input); assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true); assert.equal(replay.value.preparation.id, row.id);
      assert.equal((await f.post({...input, purpose: 'Changed exact operation'})).status, 409);
      const listed = await f.api(f.base + '?projectId=' + f.project + '&limit=1', {token: f.sessions.member});
      assert.equal(listed.status, 200); assert.deepEqual(listed.value.preparations.map((x: {id: string}) => x.id), [row.id]);
      const detail = await f.api(f.base + '/' + row.id, {token: f.sessions.member}); assert.equal(detail.status, 200); assert.equal(detail.value.preparation.source.versionId, f.version);
    });
    await t.test('session and current membership are required for reads and writes', async () => {
      const f = await fixture(), row = await f.proposed();
      for (const token of [null, randomUUID()]) assert.equal((await f.api(f.base + '/' + row.id, {token})).status, 401);
      assert.equal((await f.api(f.base + '/' + row.id, {token: f.sessions.outsider})).status, 404);
      assert.equal((await f.api(f.base + '/' + row.id, {headers: {'X-Coatria-User': f.member}})).status, 409);
      await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f.member]);
      assert.equal((await f.api(f.base + '/' + row.id, {token: f.sessions.member})).status, 404);
      assert.equal((await f.post(f.input(), {token: f.sessions.member})).status, 404);
      await query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hashToken(f.sessions.admin)]);
      assert.equal((await f.api(f.base + '?projectId=' + f.project, {token: f.sessions.admin})).status, 401);
    });
    await t.test('Origin and exact JSON schemas reject untrusted authority before writing metadata', async () => {
      const f = await fixture();
      for (const options of [{origin: null}, {origin: 'https://unrelated.example.invalid'}, {headers: {'Sec-Fetch-Site': 'cross-site'}}]) assert.equal((await f.post(f.input(), options)).status, 403);
      assert.equal((await f.post(f.input(), {contentType: 'text/plain'})).status, 415);
      assert.equal((await f.post(undefined, {raw: '{'})).status, 400);
      for (const extra of [{processor: {qualified: true}}, {metadataRemoved: true}, {leaseId: randomUUID()}, {recipeSha256: '0'.repeat(64)}]) assert.equal((await f.post(f.input(extra))).status, 400);
      assert.equal((await f.api(f.base + '?projectId=' + f.project + '&unreviewed=true')).status, 400);
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparations WHERE company_id=$1', [f.company])).rows[0].n, 0);
    });
    await t.test('company, project, work, original and destination identifiers cannot cross tenants', async () => {
      const f = await fixture(), g = await fixture(), row = await f.proposed();
      assert.equal((await f.api(g.base + '?projectId=' + g.project)).status, 404);
      assert.equal((await g.api(g.base + '/' + row.id)).status, 404);
      assert.equal((await f.api(f.base + '?projectId=' + g.project)).status, 404);
      for (const patch of [{projectId: g.project}, {workItemId: g.work}, {sourceVersionId: g.version}, {destinationFolderId: g.folder}]) {
        const rejected = await f.post(f.input(patch)); assert.equal(rejected.status, 404, JSON.stringify(rejected.value));
      }
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparations WHERE company_id=$1', [f.company])).rows[0].n, 1);
    });
    await t.test('only current administrators may approve or revoke and default processor is unavailable', async () => {
      const f = await fixture(), row = await f.proposed(), approvePath = f.base + '/' + row.id + '/approve', revokePath = f.base + '/' + row.id + '/revoke';
      for (const path of [approvePath, revokePath]) assert.equal((await f.api(path, {method: 'POST', token: f.sessions.member, payload: path === approvePath ? f.approval(row) : {clientId: randomUUID(), revision: row.revision}})).status, 403);
      for (const patch of [{processingConsent: false}, {adoptionConsent: false}, {derivativeWriteConsent: false}, {expiresInMinutes: 61}, {runtime: {available: true}}]) assert.equal((await f.api(approvePath, {method: 'POST', payload: f.approval(row, patch)})).status, 400);
      const unavailable = await f.api(approvePath, {method: 'POST', token: f.sessions.admin, payload: f.approval(row)});
      assert.equal(unavailable.status, 503, JSON.stringify(unavailable.value)); assert.equal(unavailable.value.code, 'IMAGE_PREPARATION_UNAVAILABLE');
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparation_approvals WHERE company_id=$1', [f.company])).rows[0].n, 0);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1', [f.company])).rows[0].n, 0);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_versions WHERE company_id=$1', [f.company])).rows[0].n, 1);
      await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2", [f.company, f.admin]);
      assert.equal((await f.api(approvePath, {method: 'POST', token: f.sessions.admin, payload: f.approval(row)})).status, 403);
      const body = {clientId: randomUUID(), revision: row.revision, note: 'Stop before any processing'};
      const revoked = await f.api(revokePath, {method: 'POST', payload: body}); assert.equal(revoked.status, 200); assert.equal(revoked.value.preparation.status, 'revoked');
      const replay = await f.api(revokePath, {method: 'POST', payload: body}); assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true);
      assert.equal((await f.api(revokePath, {method: 'POST', payload: {...body, clientId: randomUUID()}})).status, 409);
    });
    await t.test('metadata API exposes no private claim, byte transport or execution route', async () => {
      const f = await fixture(), row = await f.proposed(), before = (await query('SELECT * FROM project_image_preparations WHERE id=$1', [row.id])).rows[0];
      for (const operation of ['claim', 'authorize', 'read', 'transform', 'complete', 'store', 'cleanup']) {
        const response = await f.api(f.base + '/' + row.id + '/' + operation, {method: 'POST', payload: {leaseId: randomUUID(), qualified: true}});
        assert.equal(response.status, 404, operation);
      }
      assert.equal((await f.api(f.base + '/' + row.id + '/lease')).status, 404);
      assert.deepEqual((await query('SELECT * FROM project_image_preparations WHERE id=$1', [row.id])).rows[0], before);
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1', [row.id])).rows[0].n, 0);
    });
    await t.test('availability reports only current qualified metadata and rechecks membership after resolution', async () => {
      const f = await fixture(), actor = {companyId:f.company,userId:f.owner};
      const processor:ProjectImagePreparationProcessor={id:randomUUID(),location:'Synthetic processor metadata only',qualificationSha256:'a'.repeat(64),releaseSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),closureSha256:'e'.repeat(64),transport:'linux_binary_v1',recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,expiresAt:new Date(Date.now()+3_600_000).toISOString()};
      const read = (runtime:preparations.ProjectImagePreparationOptions['runtime'])=>transaction(db=>projectImagePreparationAvailability(db,actor,f.project,{runtime}));
      assert.equal((await read(async()=>processor)).enabled,true);
      for(const patch of [{expiresAt:'2000-01-01T00:00:00.000Z'},{recipeSha256:'0'.repeat(64)}])assert.deepEqual((await read(async()=>({...processor,...patch}))).processor,null);
      await assert.rejects(read(async db=>{await db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner]);return processor;}),{code:'IMAGE_PREPARATION_MEMBERSHIP_REQUIRED'});
    });
    await t.test('external agent discovery, lease, grants and stable preparation receipts use the real HTTP pipeline',async()=>{
      const f=await fixture(),a=await f.agent(),discovery=await f.api('agent/tools',{token:null,headers:a.headers});
      assert.equal(discovery.status,200);
      const names=discovery.value.tools.map((tool:{name:string})=>tool.name);
      for(const name of ['project_image_preparations_list','project_image_preparation_get','project_image_preparation_propose'])assert(names.includes(name));
      assert(!names.includes('project_image_preparation_reference'),'No creative grants means no reference handoff tool');
      assert(!names.some((name:string)=>/^project_image_preparation_(approve|claim|transform|publish)$/.test(name)));
      const {clientId,...args}=f.input({continuation:'submitted_plan_v1'});
      assert.equal((await a.tool('project_image_preparation_propose',args,clientId,'wrong-live-lease-token-for-fixture')).status,409);
      const result=await a.tool('project_image_preparation_propose',args,clientId);assert.equal(result.status,200,JSON.stringify(result.value));
      const p=result.value.result.preparation;assert.equal(p.proposedAgentId,a.agentId);assert.equal(p.continuationMode,'submitted_plan_v1');assert.equal(p.status,'proposed');assert.equal(p.approval,null);
      const again=await a.tool('project_image_preparation_propose',args,clientId);assert.equal(again.status,200);assert.equal(again.value.replayed,true);assert.equal(again.value.result.preparation.id,p.id);
      assert.equal((await a.tool('project_image_preparation_propose',{...args,purpose:'Changed request'},clientId)).status,409);
      const list=await a.tool('project_image_preparations_list',{projectId:f.project,limit:1});assert.equal(list.status,200);assert.equal(list.value.result.preparations[0].id,p.id);
      assert.equal((await a.tool('project_image_preparation_get',{preparationId:p.id})).status,200);
      assert.equal((await a.tool('project_image_preparation_propose',{...args,metadataRemoved:true})).status,400);
      assert.equal((await a.tool('project_image_preparation_approve',{preparationId:p.id})).status,404);
      const foreign=await fixture(),foreignPreparation=await foreign.proposed();assert.equal((await a.tool('project_image_preparation_get',{preparationId:foreignPreparation.id})).status,404);
      await query("UPDATE agents SET capabilities=capabilities-'storage.read' WHERE id=$1",[a.agentId]);
      assert.equal((await a.tool('project_image_preparation_propose',args,clientId)).status,403);
      await query("UPDATE agents SET capabilities=capabilities||'[\"storage.read\"]'::jsonb WHERE id=$1",[a.agentId]);
      await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[f.company,f.owner]);
      const rejected=await a.tool('project_image_preparation_get',{preparationId:p.id});assert([401,403].includes(rejected.status),JSON.stringify(rejected.value));
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparation_approvals WHERE company_id=$1',[f.company])).rows[0].n,0);
    });
    await t.test('OpenAPI publishes metadata/consent routes and exact external agent tool schemas',()=>{
      const policy=(agentRuntimeOpenApi as any).components.schemas.StudioCoordinationPolicy;
      assert.deepEqual(policy.properties.referencePreparationProfile.enum,['prepared_image_v1','original_image_v1']);
      const paths=agentRuntimeOpenApi.paths as Record<string,any>;
      for(const suffix of ['', '/{preparationId}','/{preparationId}/approve','/{preparationId}/revoke','/{preparationId}/reference'])assert(paths['/api/companies/{companyId}/image-preparations'+suffix]);
      const operation=paths['/api/agent/tools/project_image_preparation_propose'].post,schema=operation.requestBody.content['application/json'].schema;
      assert.deepEqual(operation['x-coatria-required-capabilities'].slice().sort(),['storage.read','studio.read','studio.write','tasks.write']);
      assert(schema.properties.arguments.properties.continuation);assert(!schema.properties.arguments.properties.clientId);
      const handoff=paths['/api/agent/tools/project_image_preparation_reference'].post;
      assert(handoff['x-coatria-required-capabilities'].includes('creative.write'));
      assert(!paths['/api/agent/tools/project_image_preparation_approve']);
    });
    await t.test('reference handoff accepts only the exact ready derivative and never grants sharing permission', async () => {
      const f=await fixture(),actor={companyId:f.company,userId:f.owner},admin={companyId:f.company,userId:f.admin},p=await f.proposed();
      const body={clientId:randomUUID(),revision:p.revision,projectRevision:1,workItemId:f.work,role:'image',purpose:'Synthetic derivative handoff'};
      const endpoint=f.base+'/'+p.id+'/reference';
      assert.equal((await f.api(endpoint,{method:'POST',payload:body})).status,409);
      assert.equal((await f.api(endpoint,{method:'POST',payload:{...body,proxyVersionId:f.version}})).status,400);
      // These receipts are synthetic metadata fixtures. Actual conversion and
      // byte transport belong to the separate native worker acceptance suite.
      const processor:ProjectImagePreparationProcessor={id:randomUUID(),location:'Synthetic handoff fixture only',qualificationSha256:'a'.repeat(64),releaseSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),closureSha256:'e'.repeat(64),transport:'linux_binary_v1',recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,expiresAt:new Date(Date.now()+3_600_000).toISOString()},options={runtime:async()=>processor};
      await transaction(db=>preparations.approveProjectImagePreparation(db,admin,p.id,{...f.approval(p),processorId:processor.id},options));
      const lease=await transaction(db=>preparations.claimProjectImagePreparation(db,{companyId:f.company,projectIds:[f.project]},options));assert.ok(lease);
      const intent=await transaction(db=>preparations.beginProjectImagePreparationPhase(db,lease,'transform',options));
      await transaction(db=>preparations.completeProjectImagePreparationPhase(db,lease,intent.actionId,{operation:'transform',sourceVersionId:f.version,sourceSha256:p.source.sha256,sourceBytes:p.source.bytes,source:{format:'png',width:96,height:64,orientation:1},recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,processor,output:{format:'png',width:96,height:64,bytes:250,sha256:'f'.repeat(64),pixelFormat:'rgba8',metadataRemoved:true}},options));
      const out=await transaction(db=>preparationStorage.reserveProjectImagePreparationOutput(db,lease,options));
      for(const operation of ['initiate','part','complete'] as const){
        const action=await transaction(db=>preparationStorage.beginProjectImagePreparationStore(db,lease,operation,options));
        const result=operation==='initiate'?{operation,descriptor:{scope:hashToken(JSON.stringify(['US-CA-2','synthetic-volume',runpodProjectRoot(f.company,f.project)])),versionId:out.versionId,uploadId:'synthetic-upload',bytes:out.bytes,partBytes:out.partBytes}}:operation==='part'?{operation,part:{partNumber:1,bytes:out.bytes,etag:'synthetic-part'},sha256:out.sha256}:{operation,versionId:out.versionId,etag:'synthetic-stored'};
        await transaction(db=>preparationStorage.completeProjectImagePreparationStore(db,lease,action.actionId,result,options));
      }
      const ready=(await transaction(db=>preparationStorage.publishProjectImagePreparation(db,lease,{bytes:out.bytes,sha256:out.sha256,etag:'synthetic-stored',cleanupConfirmed:true},options))).preparation;
      const connection=randomUUID();await query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[f.company,connection,f.owner,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId:f.company,id:connection,purpose:'oauth-connection'}))]);
      const request={...body,revision:ready.revision},result=await f.api(endpoint,{method:'POST',payload:request});assert.equal(result.status,201,JSON.stringify(result.value));
      const r=result.value.reference;assert.equal(r.proxy.versionId,out.versionId);assert.equal(r.proxy.sha256,out.sha256);assert.equal(r.source.versionId,f.version);assert.equal(r.preparation.id,p.id);assert.equal(r.preparation.receiptSha256,ready.derivation!.receiptSha256);assert.equal(r.preparation.metadataRemoved,true);assert.equal(r.metadataRemoved,false);assert.equal(r.status,'proposed');assert.equal(r.approvedAt,null);assert.equal(r.providerConfirmed,false);
      assert.equal((await f.api(endpoint,{method:'POST',payload:request})).status,200);
      assert.equal((await f.api(endpoint,{method:'POST',payload:{...request,clientId:randomUUID(),revision:ready.revision-1}})).status,409);
      const other=await fixture();assert.equal((await other.api(endpoint,{method:'POST',payload:request})).status,404);
      const raw={clientId:randomUUID(),projectId:f.project,projectRevision:1,workItemId:f.work,proxyVersionId:out.versionId,proxySha256:out.sha256,proxyBytes:out.bytes,role:'image',purpose:'Do not hide recorded original'};
      assert.equal((await f.api('companies/'+f.company+'/higgsfield/references',{method:'POST',payload:raw})).status,409);
      // A fresh current generation agent may propose the prepared result for
      // its own task. It never borrows the original producer's ended identity.
      const downstream=await f.agent(['creative.read','creative.write'],false),downstreamTask=randomUUID(),downstreamWork=randomUUID();
      await query("INSERT INTO tasks(id,company_id,title,description,created_by) VALUES($1,$2,'Use prepared reference','Propose the exact derivative; sharing still needs human consent',$3)",[downstreamTask,f.company,f.owner]);
      await query("INSERT INTO studio_role_bindings(company_id,role_key,agent_id) VALUES($1,'comp',$2)",[f.company,downstream.agentId]);
      await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'downstream-reference',$4,'generation','comp','creative')",[downstreamWork,f.company,f.project,downstreamTask]);
      const taskClaim=await downstream.tool('tasks_claim',{taskId:downstreamTask,revision:1});assert.equal(taskClaim.status,200,JSON.stringify(taskClaim.value));
      const handoffRequest=randomUUID(),handoffArgs={preparationId:p.id,revision:ready.revision,projectRevision:1,workItemId:downstreamWork,role:'image',purpose:'Current downstream agent reference proposal'};
      const handed=await downstream.tool('project_image_preparation_reference',handoffArgs,handoffRequest);assert.equal(handed.status,200,JSON.stringify(handed.value));
      const agentReference=handed.value.result.reference;assert.equal(agentReference.proxy.versionId,out.versionId);assert.equal(agentReference.source.versionId,f.version);assert.equal(agentReference.workItemId,downstreamWork);assert.equal(agentReference.approvedAt,null);
      assert.equal((await downstream.tool('project_image_preparation_reference',handoffArgs,handoffRequest)).value.replayed,true);
      await query('UPDATE tasks SET agent_run_id=NULL WHERE id=$1',[downstreamTask]);
      assert.equal((await downstream.tool('project_image_preparation_reference',handoffArgs,handoffRequest)).status,403,'Cached reference cannot replace current task reservation');
      await query('UPDATE tasks SET agent_run_id=$2 WHERE id=$1',[downstreamTask,downstream.runId]);
      const revokeReference=await f.api('companies/'+f.company+'/higgsfield/references/'+agentReference.id+'/revoke',{method:'POST',payload:{clientId:randomUUID(),revision:agentReference.revision,note:'Synthetic reference revocation'}});assert.equal(revokeReference.status,200,JSON.stringify(revokeReference.value));
      assert.equal((await downstream.tool('project_image_preparation_reference',handoffArgs,handoffRequest)).status,409,'Cached reference cannot bypass reference revocation');
      await transaction(db=>preparations.revokeProjectImagePreparation(db,admin,p.id,{clientId:randomUUID(),revision:ready.revision,note:'No further handoff'}));
      assert.equal((await f.api(endpoint,{method:'POST',payload:{...request,clientId:randomUUID()}})).status,409);
      assert.equal((await downstream.tool('project_image_preparation_reference',handoffArgs,handoffRequest)).status,409,'Cached receipt cannot bypass preparation revocation');
      assert.equal((await query('SELECT count(*)::int n FROM higgsfield_references WHERE company_id=$1 AND approved_at IS NOT NULL',[f.company])).rows[0].n,0);
    });
    assert.equal(outbound, 0, 'Metadata routes cannot invoke storage, native transform or external providers');
  } finally {
    globalThis.fetch = oldFetch;
    try { const pool = (globalThis as {coatriaPool?: Pool}).coatriaPool; if (pool) await pool.end(); delete (globalThis as {coatriaPool?: Pool}).coatriaPool; await stop?.(); }
    finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  }
});
