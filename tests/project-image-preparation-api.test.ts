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
      return {company, owner, admin, member, project, work, folder, version, sessions, base, input, api, post, proposed, approval};
    }
    await t.test('authenticated company metadata supports exact proposal replay and safe list/get', async () => {
      const f = await fixture(), input = f.input(), created = await f.post(input);
      assert.equal(created.status, 201, JSON.stringify(created.value)); const row = created.value.preparation;
      assert.equal(row.status, 'proposed'); assert.equal(row.attempt, 0); assert.equal(row.approval, null); assert.equal(row.derivation, null);
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
    assert.equal(outbound, 0, 'Metadata routes cannot invoke storage, native transform or external providers');
  } finally {
    globalThis.fetch = oldFetch;
    try { const pool = (globalThis as {coatriaPool?: Pool}).coatriaPool; if (pool) await pool.end(); delete (globalThis as {coatriaPool?: Pool}).coatriaPool; await stop?.(); }
    finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  }
});
