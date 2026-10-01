import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {Pool, type PoolClient} from 'pg';
import {ApiError, hashToken} from '../src/lib/security';
import {createProjectStorageConnection, bindProjectStorage} from '../src/lib/project-storage';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import * as preparation from '../src/lib/project-image-preparations';
import * as storage from '../src/lib/project-image-preparation-storage';
import {runpodProjectRoot} from '../src/lib/project-storage-runpod';
import type {ProjectImagePreparationActor, ProjectImagePreparationLease, ProjectImagePreparationProcessor, ProjectImagePreparationTransformResult} from '../src/lib/project-image-preparations-protocol';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

type Row = Record<string, any>;
type Options = {runtime: (db: PoolClient, companyId: string, projectId: string, processorId?: string) => Promise<ProjectImagePreparationProcessor | null>};
const capabilities = ['storage.read', 'studio.read', 'studio.write', 'tasks.write'];
function denied(statuses = [400, 403, 404, 409, 503]) {
  return (error: unknown) => { assert.ok(error instanceof ApiError, 'Expected an intentional authority/admission rejection, not a SQL/runtime failure'); assert.ok(statuses.includes(error.status), `${error.status}: ${error.code}`); assert.doesNotMatch(error.message, /rps_synthetic|user_synthetic|private-etag|coatria\/companies\/|postgresql:/); return true; };
}

test('image preparation storage preserves one exact derivative and reviewed write authority', {timeout: 180_000}, async t => {
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
  async function fixture() {
    const company = randomUUID(), owner = randomUUID(), admin = randomUUID(), member = randomUUID(), outsider = randomUUID(), agentSponsor = randomUUID(), storageSponsor = randomUUID(), project = randomUUID(), shot = randomUUID(), task = randomUUID(), work = randomUUID(), destination = randomUUID();
    for (const user of [owner, admin, member, outsider, agentSponsor, storageSponsor]) await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic preparation authority',$2,'not-a-login')", [user, user + '@example.invalid']);
    await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Offline preparation control fixture',$2,'blank')", [company, company]);
    await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($1,$5,'admin'),($1,$6,'admin')", [company, owner, admin, member, agentSponsor, storageSponsor]);
    await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)", [company, owner]);
    const gates = Object.fromEntries(['brief', 'estimate', 'production'].map(gate => [gate, {decision: 'approved', recordedBy: admin}]));
    await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Synthetic image preparation','Internal','Control metadata only; no media was transformed',$3,'allowed','production',$4,$5,'higgsfield',2)", [project, company, JSON.stringify({kind: 'image', format: 'png', width: 96, height: 64, color: {mode: 'not_required'}}), JSON.stringify(gates), owner]);
    await query("INSERT INTO studio_shots(id,company_id,project_id,code,description,frame_start,frame_end,handles,disciplines,media_kind) VALUES($1,$2,$3,'SYNTHETIC','Metadata fixture only',NULL,NULL,NULL,'[]','image')", [shot, company, project]);
    await query("INSERT INTO tasks(id,company_id,title,description,created_by,assignee_id) VALUES($1,$2,'Prepare one approved original','Keep the original intact and review a separate derivative',$3,$3)", [task, company, owner]);
    await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution,shot_id) VALUES($1,$2,$3,'preparation-fixture',$4,'references','ingest','agent',$5)", [work, company, project, task, shot]);
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
      await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic image preparation proposal',$8,'running','fixture',$9,clock_timestamp()+interval '1 hour')", [runId, company, agentId, owner, conversation, randomUUID(), '1'.repeat(64), JSON.stringify(capabilities), '2'.repeat(64)]);
      await query("UPDATE studio_role_bindings SET agent_id=$2,human_id=NULL WHERE company_id=$1 AND role_key='ingest'", [company, agentId]);
      await query("UPDATE tasks SET status='doing',agent_run_id=$2,assignee_id=NULL WHERE id=$1", [task, runId]);
      return {...actor, agentId, runId, tokenHash};
    }
    const safe = (value: unknown) => { const text = JSON.stringify(value); for (const secret of [source.objectKey, 'private-etag', 'rps_syntheticsecret', 'user_syntheticaccess']) assert.ok(!text.includes(secret)); assert.doesNotMatch(text, /"(?:objectKey|providerEtag|secret_envelope|leaseId|lease_token_hash)"/); };
    return {company, owner, admin, member, outsider, agentSponsor, storageSponsor, project, shot, task, work, destination, actor, adminActor, memberActor, outsiderActor, connection, binding, source, stored, input, propose, get, approval, approve, claim, authorize, begin, result, complete, approved, leased, agent, safe, options, originalProcessor, setProcessor: (value: ProjectImagePreparationProcessor | null) => { processor = value; }};
  }
  // Storage/result values below are synthetic metadata. These tests exercise
  // control authority and SQL integrity, not actual transformation or S3 bytes.
  async function prepared() {
    const f = await fixture(), lease = await f.leased(), intent = await f.begin(lease);
    await f.complete(lease, intent.actionId);
    const allocate = () => transaction(db => storage.reserveProjectImagePreparationOutput(db, lease, f.options));
    const begin = (operation: storage.ProjectImagePreparationStoreOperation) => transaction(db => storage.beginProjectImagePreparationStore(db, lease, operation, f.options));
    const complete = (actionId: string, value: unknown) => transaction(db => storage.completeProjectImagePreparationStore(db, lease, actionId, value, f.options));
    const publish = (value: unknown) => transaction(db => storage.publishProjectImagePreparation(db, lease, value, f.options));
    const descriptor = (out: storage.ProjectImagePreparationOutput) => ({scope: hashToken(JSON.stringify(['US-CA-2', 'synthetic-volume', runpodProjectRoot(f.company, f.project)])), versionId: out.versionId, uploadId: 'synthetic-multipart-' + out.uploadId, bytes: out.bytes, partBytes: out.partBytes});
    async function initiated() {
      const out = await allocate(), action = await begin('initiate');
      await complete(action.actionId, {operation: 'initiate', descriptor: descriptor(out)});
      return out;
    }
    async function partStored() {
      const out = await initiated(), action = await begin('part');
      await complete(action.actionId, {operation: 'part', part: {partNumber: 1, etag: '"synthetic-part-etag"', bytes: out.bytes}, sha256: out.sha256});
      return out;
    }
    async function verifying() {
      const out = await partStored(), action = await begin('complete');
      await complete(action.actionId, {operation: 'complete', versionId: out.versionId, etag: '"synthetic-final-etag"'});
      return out;
    }
    const publication = (out: storage.ProjectImagePreparationOutput) => ({bytes: out.bytes, sha256: out.sha256, etag: '"synthetic-final-etag"', cleanupConfirmed: true});
    async function snapshot() {
      const result: Row = {};
      for (const table of ['project_image_preparations', 'project_image_preparation_allocations', 'project_image_preparation_receipts', 'project_image_preparation_derivations', 'project_storage_files', 'project_storage_versions', 'project_storage_verifications', 'project_storage_uploads', 'project_storage_upload_parts', 'project_storage_bindings'])
        result[table] = (await query('SELECT row_to_json(r) AS value FROM ' + table + ' r WHERE company_id=$1 ORDER BY row_to_json(r)::text', [f.company])).rows;
      return result;
    }
    async function unchangedAfter(action: () => Promise<unknown>) { const before = await snapshot(); await assert.rejects(action(), denied()); assert.deepEqual(await snapshot(), before); }
    return {...f, lease, allocate, storeBegin: begin, storeComplete: complete, publish, descriptor, initiated, partStored, verifying, publication, snapshot, unchangedAfter};
  }
  try {
    await t.test('source read is private and exact; one allocation advances only its own binding revision', async () => {
      const f = await fixture(), lease = await f.leased();
      const read = await transaction(db => storage.readProjectImagePreparationSource(db, lease, f.options));
      assert.equal(read.versionId, f.source.version); assert.equal(read.bytes, f.source.bytes); assert.equal(read.sha256, f.source.sha); assert.equal(read.etag, 'private-etag');
      assert.equal(read.config.companyId, f.company); assert.equal(read.config.projectId, f.project); assert.equal(read.config.maxObjectBytes, 32 * 1024 ** 2);
      f.safe((await f.get(lease.preparationId)).preparation);
      const sourceBefore = (await query('SELECT row_to_json(v) value FROM project_storage_versions v WHERE id=$1', [f.source.version])).rows[0];
      const intent = await f.begin(lease); await f.complete(lease, intent.actionId);
      const before = (await query('SELECT revision FROM project_storage_bindings WHERE id=$1', [f.binding.id])).rows[0].revision;
      const out = await transaction(db => storage.reserveProjectImagePreparationOutput(db, lease, f.options));
      assert.notEqual(out.fileId, f.source.file); assert.notEqual(out.versionId, f.source.version); assert.equal(out.bytes, 250); assert.equal(out.sha256, 'f'.repeat(64));
      assert.equal((await query('SELECT revision FROM project_storage_bindings WHERE id=$1', [f.binding.id])).rows[0].revision, before + 1);
      const allocation = (await query('SELECT * FROM project_image_preparation_allocations WHERE preparation_id=$1', [lease.preparationId])).rows[0];
      assert.equal(allocation.binding_revision_before, before); assert.equal(allocation.binding_revision_after, before + 1);
      const replay = await transaction(db => storage.reserveProjectImagePreparationOutput(db, lease, f.options)); assert.deepEqual(replay, out);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_versions WHERE company_id=$1', [f.company])).rows[0].n, 2);
      assert.deepEqual((await query('SELECT row_to_json(v) value FROM project_storage_versions v WHERE id=$1', [f.source.version])).rows[0], sourceBefore);
      await assert.rejects(transaction(db => storage.readProjectImagePreparationSource(db, lease, f.options)), denied([409]));
    });
    await t.test('multipart submission has one immutable intent per phase and one exact part', async () => {
      const f = await prepared(), out = await f.allocate();
      await f.unchangedAfter(() => f.storeBegin('part')); await f.unchangedAfter(() => f.storeBegin('complete'));
      const initiate = await f.storeBegin('initiate');
      await f.unchangedAfter(() => f.storeBegin('initiate'));
      const initiated = {operation: 'initiate', descriptor: f.descriptor(out)};
      await f.storeComplete(initiate.actionId, initiated);
      await f.unchangedAfter(() => f.storeComplete(initiate.actionId, initiated));
      const part = await f.storeBegin('part'); assert.equal(part.descriptor?.versionId, out.versionId); assert.deepEqual(part.parts, []);
      await f.unchangedAfter(() => f.storeBegin('part'));
      const partResult = {operation: 'part', part: {partNumber: 1, etag: '"synthetic-part-etag"', bytes: out.bytes}, sha256: out.sha256};
      await f.storeComplete(part.actionId, partResult);
      await f.unchangedAfter(() => f.storeBegin('part')); await f.unchangedAfter(() => f.storeComplete(part.actionId, partResult));
      const finish = await f.storeBegin('complete');
      assert.deepEqual(finish.parts, [{partNumber: 1, bytes: out.bytes, etag: '"synthetic-part-etag"'}]);
      await f.unchangedAfter(() => f.storeBegin('complete'));
      await f.storeComplete(finish.actionId, {operation: 'complete', versionId: out.versionId, etag: '"synthetic-final-etag"'});
      await f.unchangedAfter(() => f.storeComplete(finish.actionId, {operation: 'complete', versionId: out.versionId, etag: '"synthetic-final-etag"'}));
      const counts = (await query("SELECT operation,phase,count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation LIKE 'store_%' GROUP BY operation,phase ORDER BY operation,phase", [f.lease.preparationId])).rows;
      assert.equal(counts.length, 6); assert.ok(counts.every(row => row.n === 1));
      assert.equal((await f.get(f.lease.preparationId)).preparation.status, 'verifying');
    });
    await t.test('crossed descriptor, result hash, part identity and invalid ETags cannot advance a write', async () => {
      const f = await prepared(), out = await f.allocate(), initiate = await f.storeBegin('initiate'), expected = f.descriptor(out);
      for (const patch of [{scope: '0'.repeat(64)}, {versionId: f.source.version}, {bytes: out.bytes + 1}, {partBytes: 1}])
        await f.unchangedAfter(() => f.storeComplete(initiate.actionId, {operation: 'initiate', descriptor: {...expected, ...patch}}));
      await f.unchangedAfter(() => f.storeComplete(randomUUID(), {operation: 'initiate', descriptor: expected}));
      await f.storeComplete(initiate.actionId, {operation: 'initiate', descriptor: expected});
      const part = await f.storeBegin('part'), result = {operation: 'part', part: {partNumber: 1, etag: '"synthetic-part-etag"', bytes: out.bytes}, sha256: out.sha256};
      for (const patch of [{partNumber: 2}, {bytes: out.bytes + 1}, {etag: '*'}, {etag: 'W/"weak"'}, {etag: 'unsafe,\nvalue'}])
        await f.unchangedAfter(() => f.storeComplete(part.actionId, {...result, part: {...result.part, ...patch}}));
      await f.unchangedAfter(() => f.storeComplete(part.actionId, {...result, sha256: f.source.sha}));
      await f.storeComplete(part.actionId, result);
      const finish = await f.storeBegin('complete');
      await f.unchangedAfter(() => f.storeComplete(finish.actionId, {operation: 'complete', versionId: f.source.version, etag: '"synthetic-final-etag"'}));
      await f.unchangedAfter(() => f.storeComplete(finish.actionId, {operation: 'complete', versionId: out.versionId, etag: '*'}));
      await f.storeComplete(finish.actionId, {operation: 'complete', versionId: out.versionId, etag: '"synthetic-final-etag"'});
      for (const patch of [{bytes: out.bytes + 1}, {sha256: f.source.sha}, {etag: '"crossed-other-output"'}]) await f.unchangedAfter(() => f.publish({...f.publication(out), ...patch}));
    });
    await t.test('publication requires exact stored evidence and literal cleanup; originals remain unchanged', async () => {
      const f = await prepared();
      const original = (await query('SELECT row_to_json(v) AS version,row_to_json(ok) AS verified FROM project_storage_versions v JOIN project_storage_verifications ok ON ok.version_id=v.id WHERE v.id=$1', [f.source.version])).rows[0];
      const out = await f.verifying(), value = f.publication(out);
      await f.unchangedAfter(() => f.publish({...value, cleanupConfirmed: false}));
      const {cleanupConfirmed: _, ...withoutCleanup} = value;
      await f.unchangedAfter(() => f.publish(withoutCleanup)); await f.unchangedAfter(() => f.publish({...value, qualified: true}));
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_verifications WHERE version_id=$1', [out.versionId])).rows[0].n, 0);
      const ready = await f.publish(value); assert.equal(ready.preparation.status, 'ready'); assert.ok(ready.preparation.cleanupConfirmedAt); f.safe(ready);
      assert.equal(ready.preparation.derivation?.sourceVersionId, f.source.version); assert.equal(ready.preparation.derivation?.outputVersionId, out.versionId); assert.equal(ready.preparation.derivation?.outputFileId, out.fileId);
      assert.equal(ready.preparation.derivation?.outputSha256, out.sha256); assert.equal(ready.preparation.derivation?.outputBytes, out.bytes);
      const verified = (await query('SELECT bytes,sha256,provider_etag FROM project_storage_verifications WHERE version_id=$1', [out.versionId])).rows[0];
      assert.equal(Number(verified.bytes), out.bytes); assert.equal(verified.sha256, out.sha256); assert.equal(verified.provider_etag, value.etag);
      assert.deepEqual((await query('SELECT row_to_json(v) AS version,row_to_json(ok) AS verified FROM project_storage_versions v JOIN project_storage_verifications ok ON ok.version_id=v.id WHERE v.id=$1', [f.source.version])).rows[0], original);
      await f.unchangedAfter(() => f.publish(value));
      const next = await f.leased(); assert.notEqual(next.preparationId, f.lease.preparationId, 'Confirmed cleanup permits the next separately approved attempt');
    });
    await t.test('ambiguous multipart submission cannot be replaced and retains the company slot', async () => {
      for (const operation of ['initiate', 'part', 'complete'] as const) {
        const f = await prepared();
        if (operation === 'initiate') await f.allocate(); else if (operation === 'part') await f.initiated(); else await f.partStored();
        const action = await f.storeBegin(operation);
        const failed = await transaction(db => preparation.failProjectImagePreparation(db, f.lease, 'PREPARATION_TIMEOUT'));
        assert.equal(failed.preparation.status, 'uncertain'); assert.equal(failed.preparation.cleanupConfirmedAt, null);
        const upload = (await query('SELECT action_id FROM project_storage_uploads WHERE id=$1', [action.output.uploadId])).rows[0]; assert.equal(upload.action_id, action.actionId);
        await f.unchangedAfter(() => f.storeBegin(operation)); await f.unchangedAfter(() => f.allocate());
        assert.equal(await f.claim(), null); assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1', [f.company])).rows[0].n, 1);
      }
    });
    await t.test('current principal revocation fences allocation, every multipart boundary and publication', async () => {
      const reading = await fixture(), sourceLease = await reading.leased();
      await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [reading.company, reading.admin]);
      await assert.rejects(transaction(db => storage.readProjectImagePreparationSource(db, sourceLease, reading.options)), denied([403]));
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1', [reading.company])).rows[0].n, 0);
      for (const stage of ['allocate', 'initiate-begin', 'initiate-result', 'part-begin', 'part-result', 'complete-begin', 'complete-result', 'publish'] as const) {
        const f = await prepared(); let action: () => Promise<unknown>;
        if (stage === 'allocate') action = f.allocate;
        else if (stage.startsWith('initiate')) {
          const out = await f.allocate();
          if (stage === 'initiate-begin') action = () => f.storeBegin('initiate');
          else { const intent = await f.storeBegin('initiate'); action = () => f.storeComplete(intent.actionId, {operation: 'initiate', descriptor: f.descriptor(out)}); }
        } else if (stage.startsWith('part')) {
          const out = await f.initiated();
          if (stage === 'part-begin') action = () => f.storeBegin('part');
          else { const intent = await f.storeBegin('part'); action = () => f.storeComplete(intent.actionId, {operation: 'part', part: {partNumber: 1, etag: '"synthetic-part-etag"', bytes: out.bytes}, sha256: out.sha256}); }
        } else if (stage.startsWith('complete')) {
          const out = await f.partStored();
          if (stage === 'complete-begin') action = () => f.storeBegin('complete');
          else { const intent = await f.storeBegin('complete'); action = () => f.storeComplete(intent.actionId, {operation: 'complete', versionId: out.versionId, etag: '"synthetic-final-etag"'}); }
        } else { const out = await f.verifying(); action = () => f.publish(f.publication(out)); }
        await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f.admin]);
        await f.unchangedAfter(action);
        assert.equal((await query('SELECT count(*)::int n FROM project_image_preparation_derivations WHERE company_id=$1', [f.company])).rows[0].n, 0, stage);
      }
    });
    await t.test('destination collisions and unrelated binding or credential revisions are never silently adopted', async () => {
      const collision = await prepared(), row = (await collision.get(collision.lease.preparationId)).preparation;
      await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), collision.company, collision.project, collision.binding.id, collision.destination, row.destinationName, row.destinationName.toLowerCase(), collision.owner]);
      await collision.unchangedAfter(collision.allocate);
      for (const mutation of ['binding-before', 'binding-after', 'credential'] as const) {
        const f = await prepared();
        if (mutation !== 'binding-before') await f.allocate();
        if (mutation === 'credential') await query('UPDATE project_storage_connections SET revision=revision+1 WHERE id=$1', [f.connection.id]);
        else await query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1', [f.binding.id]);
        await f.unchangedAfter(mutation === 'binding-before' ? f.allocate : () => f.storeBegin('initiate'));
      }
    });
    await t.test('046 SQL guards reject mutation, duplicate multipart intent and fabricated parts', async () => {
      const f = await prepared(), out = await f.allocate();
      // Keep deliberate SQL errors inside rolled-back transactions, so the
      // single-connection emulator does not race a discarded pool socket.
      const sqlRejected = (sql: string, values: unknown[]) => assert.rejects(transaction(db => db.query(sql, values)), (error: any) => ['23514', '23505'].includes(error?.code));
      await assert.rejects(transaction(db => db.query('UPDATE project_image_preparation_allocations SET binding_revision_after=binding_revision_after+1 WHERE preparation_id=$1', [f.lease.preparationId])), {code: '42501'});
      await sqlRejected("INSERT INTO project_image_preparation_receipts(company_id,project_id,preparation_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,'store_initiate','returned','{}')", [f.company, f.project, f.lease.preparationId, randomUUID()]);
      const intent = await f.storeBegin('initiate');
      await sqlRejected("INSERT INTO project_image_preparation_receipts(company_id,project_id,preparation_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,'store_initiate','intent','{}')", [f.company, f.project, f.lease.preparationId, randomUUID()]);
      await f.storeComplete(intent.actionId, {operation: 'initiate', descriptor: f.descriptor(out)});
      for (const [part, bytes, sha] of [[2, out.bytes, out.sha256], [1, out.bytes + 1, out.sha256], [1, out.bytes, f.source.sha]]) await sqlRejected('INSERT INTO project_storage_upload_parts(company_id,upload_id,part_number,bytes,sha256,provider_etag) VALUES($1,$2,$3,$4,$5,$6)', [f.company, out.uploadId, part, bytes, sha, '"synthetic-invalid-part"']);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_upload_parts WHERE upload_id=$1', [out.uploadId])).rows[0].n, 0);
      assert.equal((await query("SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation='store_initiate' AND phase='intent'", [f.lease.preparationId])).rows[0].n, 1);
    });
    assert.equal(outbound, 0, 'Storage control tests must never invoke a provider or decode native bytes');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.COATRIA_HOSTING_KEYRING; else process.env.COATRIA_HOSTING_KEYRING = oldKey;
    await stop();
  }
});
