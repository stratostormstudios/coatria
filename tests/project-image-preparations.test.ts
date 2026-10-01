import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {Pool, type PoolClient} from 'pg';
import {ApiError, hashToken} from '../src/lib/security';
import {createProjectStorageConnection, bindProjectStorage} from '../src/lib/project-storage';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import * as preparation from '../src/lib/project-image-preparations';
import type {ProjectImagePreparationActor, ProjectImagePreparationLease, ProjectImagePreparationProcessor, ProjectImagePreparationTransformResult} from '../src/lib/project-image-preparations-protocol';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

type Row = Record<string, any>;
type Options = {runtime: (db: PoolClient, companyId: string, projectId: string, processorId?: string) => Promise<ProjectImagePreparationProcessor | null>};
const capabilities = ['storage.read', 'studio.read', 'studio.write', 'tasks.write'];
function denied(statuses = [400, 403, 404, 409, 503]) {
  return (error: unknown) => { assert.ok(error instanceof ApiError, 'Expected an intentional authority/admission rejection, not a SQL/runtime failure'); assert.ok(statuses.includes(error.status), `${error.status}: ${error.code}`); assert.doesNotMatch(error.message, /rps_synthetic|user_synthetic|private-etag|coatria\/companies\/|postgresql:/); return true; };
}

test('image preparation control plane binds finite adoption, immutable evidence and one fenced attempt', {timeout: 180_000}, async t => {
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
  try {
    await t.test('default runtime is unavailable and proposal grants perform no media or storage work', async () => {
      const f = await fixture(), row = (await f.propose()).preparation;
      assert.equal(row.status, 'proposed'); assert.equal(row.approval, null); assert.equal(row.derivation, null); f.safe(row);
      await assert.rejects(transaction(db => preparation.approveProjectImagePreparation(db, f.adminActor, row.id, f.approval(row))), denied([503]));
      assert.equal(await transaction(db => preparation.claimProjectImagePreparation(db, {companyId: f.company, projectIds: [f.project]})), null);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1', [f.company])).rows[0].n, 0);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_versions WHERE company_id=$1', [f.company])).rows[0].n, 1);
    });
    await t.test('proposal replay is exact and tenant/project IDs cannot cross source, destination or reads', async () => {
      const f = await fixture(), g = await fixture(), data = f.input(), first = await f.propose(data), replay = await f.propose(data);
      assert.equal(replay.preparation.id, first.preparation.id); assert.equal(replay.replayed, true);
      await assert.rejects(f.propose({...data, purpose: 'Changed request'}), {code: 'IDEMPOTENCY_CONFLICT'});
      for (const patch of [{projectId: g.project}, {workItemId: g.work}, {sourceVersionId: g.source.version, sourceSha256: g.source.sha}, {destinationFolderId: g.destination}]) await assert.rejects(f.propose(f.input(patch)), denied());
      await assert.rejects(g.get(first.preparation.id), denied([404]));
      await assert.rejects(f.get(first.preparation.id, f.outsiderActor), denied([403]));
      const listed = await transaction(db => preparation.listProjectImagePreparations(db, f.actor, {projectId: f.project, limit: 1}));
      assert.equal(listed.preparations.length, 1); assert.equal(listed.preparations[0].id, first.preparation.id); f.safe(listed);
    });
    await t.test('verified exact source and fixed source/output profile cannot be claimed by a caller', async () => {
      const f = await fixture();
      for (const patch of [{sourceSha256: '0'.repeat(64)}, {sourceBytes: f.source.bytes + 1}, {sourceBytes: 32 * 1024 ** 2 + 1}, {destinationName: 'not-png.jpg'}, {recipeSha256: '0'.repeat(64)}, {metadataRemoved: true}, {projectRevision: 2}]) await assert.rejects(f.propose(f.input(patch)), denied());
      for (const value of [await f.stored({verified: false}), await f.stored({contentType: 'image/gif'}), await f.stored({contentType: 'application/octet-stream'})]) await assert.rejects(f.propose(f.input({sourceVersionId: value.version, sourceSha256: value.sha, sourceBytes: value.bytes})), denied());
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparations WHERE company_id=$1', [f.company])).rows[0].n, 0);
    });
    await t.test('approval requires all explicit finite consents, current administrator and exact runtime identity', async () => {
      const f = await fixture(), row = (await f.propose()).preparation;
      for (const patch of [{processingConsent: false}, {derivativeWriteConsent: false}, {adoptionConsent: false}, {expiresInMinutes: 61}, {maxCostMicrousd: 1_000_001}, {processorId: randomUUID()}, {qualificationSha256: '0'.repeat(64)}, {requestHash: '0'.repeat(64)}, {revision: 2}]) await assert.rejects(f.approve(row, f.approval(row, patch)), denied());
      for (const actor of [f.memberActor, f.outsiderActor]) await assert.rejects(f.approve(row, f.approval(row), actor), denied([403]));
      const data = f.approval(row), accepted = await f.approve(row, data);
      assert.equal(accepted.preparation.status, 'queued'); assert.ok(accepted.preparation.approval); assert.equal(accepted.preparation.approval.approvedBy, f.admin); assert.equal(accepted.preparation.approval.maxCostMicrousd, 10_000); f.safe(accepted);
      assert.equal((await f.approve(row, data)).replayed, true);
      await assert.rejects(f.approve(row, {...data, maxCostMicrousd: 20_000}), {code: 'IDEMPOTENCY_CONFLICT'});
    });
    await t.test('invalid, expired and changed qualification never approves or admits transform work', async () => {
      for (const change of [null, {expiresAt: new Date(Date.now() - 1000).toISOString()}, {recipeSha256: '0'.repeat(64)}, {transport: 'native_test'}, {profileSha256: 'bad'}]) {
        const f = await fixture(), row = (await f.propose()).preparation;
        f.setProcessor(change === null ? null : {...f.originalProcessor, ...change} as ProjectImagePreparationProcessor);
        await assert.rejects(f.approve(row), denied());
        assert.equal(await f.claim(), null);
      }
      const f = await fixture(), lease = await f.leased();
      for (const patch of [{qualificationSha256: 'f'.repeat(64)}, {releaseSha256: 'f'.repeat(64)}, {profileSha256: 'f'.repeat(64)}, {closureSha256: 'f'.repeat(64)}, {sourceCommit: 'f'.repeat(40)}, {location: 'Changed processing location'}, {expiresAt: new Date(Date.now() - 1000).toISOString()}]) { f.setProcessor({...f.originalProcessor, ...patch}); await assert.rejects(f.authorize(lease), denied()); await assert.rejects(f.begin(lease), denied()); }
    });
    await t.test('one company admits only one active claim and expiry alone does not release its processing slot', async () => {
      const f = await fixture(), first = await f.approved(), second = await f.approved();
      const claims = await Promise.all([f.claim(), f.claim()]); assert.equal(claims.filter(Boolean).length, 1);
      const lease = claims.find(Boolean)!; assert.ok([first.id, second.id].includes(lease.preparationId)); assert.equal(await f.claim(), null);
      await query("UPDATE project_image_preparations SET lease_expires_at=claimed_at+interval '1 microsecond' WHERE id=$1", [lease.preparationId]);
      assert.equal(await f.claim(), null); assert.equal(await f.claim(), null);
      assert.ok(['blocked', 'failed'].includes((await f.get(lease.preparationId)).preparation.status));
    });
    await t.test('a stale unclaimed queue head is terminalized so the current proposal can progress', async () => {
      const f = await fixture(), stale = await f.approved();
      await query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1', [f.project]);
      const fresh = (await f.propose(f.input({projectRevision: 2}))).preparation; await f.approve(fresh);
      let lease = await f.claim(); if (!lease) lease = await f.claim(); assert.ok(lease); assert.equal(lease.preparationId, fresh.id);
      assert.ok(['blocked', 'failed'].includes((await f.get(stale.id)).preparation.status));
    });
    await t.test('transform intent commits once and synthetic completion stops at validating without storage publication', async () => {
      const f = await fixture(), lease = await f.leased(), action = await f.begin(lease);
      for (const patch of [{companyId: randomUUID()}, {projectId: randomUUID()}, {leaseId: randomUUID()}, {requestHash: '0'.repeat(64)}, {recipeSha256: '0'.repeat(64)}, {source: {...lease.source, bytes: lease.source.bytes + 1}}, {processor: {...lease.processor, id: randomUUID()}}]) await assert.rejects(f.authorize({...lease, ...patch}), denied());
      await assert.rejects(f.begin(lease), denied());
      await assert.rejects(f.complete(lease, randomUUID()), denied());
      for (const patch of [{sourceSha256: '0'.repeat(64)}, {recipeSha256: '0'.repeat(64)}, {output: {...f.result().output, metadataRemoved: false}}, {output: {...f.result().output, width: 4096}}, {output: {...f.result().output, bytes: 10 * 1024 ** 2 + 1}}]) await assert.rejects(f.complete(lease, action.actionId, f.result(patch)), denied());
      const returned = await f.complete(lease, action.actionId); assert.equal(returned.preparation.status, 'validating'); assert.equal(returned.preparation.derivation, null); f.safe(returned);
      await assert.rejects(f.begin(lease), denied());
      assert.equal((await query("SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation='transform' AND phase='intent'", [lease.preparationId])).rows[0].n, 1);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_versions WHERE company_id=$1', [f.company])).rows[0].n, 1);
      assert.equal((await query('SELECT count(*)::int n FROM project_storage_uploads WHERE company_id=$1', [f.company])).rows[0].n, 0);
    });
    await t.test('unknown transform outcome stays uncertain without automatic replacement', async () => {
      const f = await fixture(), lease = await f.leased(); await f.begin(lease);
      await transaction(db => preparation.failProjectImagePreparation(db, lease, 'PREPARATION_TIMEOUT'));
      assert.equal((await f.get(lease.preparationId)).preparation.status, 'uncertain'); assert.equal(await f.claim(), null); await assert.rejects(f.begin(lease), denied());
      const g = await fixture(), active = await g.leased(); await g.begin(active);
      await query("UPDATE project_image_preparations SET lease_expires_at=claimed_at+interval '1 microsecond' WHERE id=$1", [active.preparationId]);
      assert.equal(await g.claim(), null); assert.equal((await g.get(active.preparationId)).preparation.status, 'uncertain'); assert.equal(await g.claim(), null);
    });
    await t.test('revocation and lease expiry reject a pending completion without transform evidence', async () => {
      for (const revoke of [true, false]) {
        const f = await fixture(), lease = await f.leased(), action = await f.begin(lease);
        if (revoke) { const row = (await f.get(lease.preparationId)).preparation; await transaction(db => preparation.revokeProjectImagePreparation(db, f.adminActor, row.id, {clientId: randomUUID(), revision: row.revision, note: 'Stop synthetic work'})); }
        else await query("UPDATE project_image_preparations SET lease_expires_at=claimed_at+interval '1 microsecond' WHERE id=$1", [lease.preparationId]);
        await assert.rejects(f.complete(lease, action.actionId), denied());
        assert.equal((await query("SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation='transform' AND phase='returned'", [lease.preparationId])).rows[0].n, 0);
        assert.equal((await query('SELECT transform_result FROM project_image_preparations WHERE id=$1', [lease.preparationId])).rows[0].transform_result, null);
      }
    });
    await t.test('requester, approver and storage sponsor revocation fence every current authority checkpoint', async () => {
      for (const principal of ['owner', 'admin', 'storageSponsor'] as const) {
        const f = await fixture(), lease = await f.leased(), action = await f.begin(lease);
        await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f[principal]]);
        await assert.rejects(f.authorize(lease), denied()); await assert.rejects(f.complete(lease, action.actionId), denied());
      }
    });
    await t.test('removing and reinviting the same principal cannot resurrect an earlier preparation approval', async () => {
      for (const principal of ['owner', 'admin', 'storageSponsor'] as const) {
        const f = await fixture(), lease = await f.leased();
        await transaction(async db => {
          const prior = (await db.query('DELETE FROM memberships WHERE company_id=$1 AND user_id=$2 RETURNING role,joined_at::text AS joined_at', [f.company, f[principal]])).rows[0];
          const current = (await db.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3) RETURNING joined_at::text AS joined_at', [f.company, f[principal], prior.role])).rows[0];
          assert.notEqual(current.joined_at, prior.joined_at, 'The reinvitation creates a new membership epoch');
        });
        await assert.rejects(f.authorize(lease), denied()); await assert.rejects(f.begin(lease), denied());
      }
    });
    await t.test('authority is checked again after an awaited runtime resolution before accepting completion', async t => {
      for (const change of ['lease', 'membership'] as const) await t.test(change, async () => {
        const f = await fixture(), lease = await f.leased(), action = await f.begin(lease);
        const late: Options = {runtime: async db => {
          if (change === 'lease') await db.query("UPDATE project_image_preparations SET lease_expires_at=claimed_at+interval '1 microsecond' WHERE id=$1", [lease.preparationId]);
          else await db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f.admin]);
          return f.originalProcessor;
        }};
        await assert.rejects(f.complete(lease, action.actionId, f.result(), late), denied());
        assert.equal((await query("SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation='transform' AND phase='returned'", [lease.preparationId])).rows[0].n, 0);
      });
    });
    await t.test('source, storage, project, destination, task and role drift fences an approved lease', async () => {
      const mutations: ((f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>)[] = [
        f => query('UPDATE project_storage_connections SET revision=revision+1 WHERE id=$1', [f.connection.id]),
        f => query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1', [f.binding.id]),
        f => query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1', [f.project]),
        f => query("UPDATE tasks SET description='Changed content' WHERE id=$1", [f.task]),
        f => query("UPDATE studio_role_bindings SET human_id=$2 WHERE company_id=$1 AND role_key='ingest'", [f.company, f.admin]),
        f => query("UPDATE project_storage_verifications SET provider_etag='changed-etag' WHERE version_id=$1", [f.source.version]),
        f => query("UPDATE project_storage_verifications SET sha256=repeat('0',64) WHERE version_id=$1", [f.source.version]),
        f => query("UPDATE project_storage_folders SET name='Moved destination',name_key='Moved destination' WHERE id=$1", [f.destination]),
      ];
      for (const mutate of mutations) { const f = await fixture(), lease = await f.leased(); await mutate(f); await assert.rejects(f.authorize(lease), denied()); await assert.rejects(f.begin(lease), denied()); }
    });
    await t.test('agent proposal needs all live run grants and the exact reserved role', async () => {
      for (const capability of capabilities) for (const target of ['agents', 'agent_runs']) {
        const f = await fixture(), actor = await f.agent();
        await query('UPDATE ' + target + ' SET capabilities=$2 WHERE id=$1', [target === 'agents' ? actor.agentId : actor.runId, JSON.stringify(capabilities.filter(value => value !== capability))]);
        await assert.rejects(f.propose(f.input(), actor), denied([403]));
      }
      for (const mutate of [async (f: Awaited<ReturnType<typeof fixture>>, actor: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['agent']>>) => query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [actor.runId]), async (f: Awaited<ReturnType<typeof fixture>>) => query('UPDATE tasks SET agent_run_id=NULL WHERE id=$1', [f.task])]) {
        const f = await fixture(), actor = await f.agent(); await mutate(f, actor); await assert.rejects(f.propose(f.input(), actor), denied());
      }
      const f = await fixture(), actor = await f.agent(), row = (await f.propose(f.input(), actor)).preparation;
      assert.equal(row.proposedAgentId, actor.agentId); assert.equal(row.status, 'proposed'); assert.equal(await f.claim(), null);
      await assert.rejects(f.approve(row, f.approval(row), actor), denied([403]));
    });
    await t.test('explicit administrator adoption can outlive the proposing run but not agent identity or sponsorship', async () => {
      const f = await fixture(), actor = await f.agent(), row = (await f.propose(f.input(), actor)).preparation;
      await f.approve(row);
      await query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE id=$1", [actor.runId]);
      const lease = await f.claim(); assert.ok(lease); await f.authorize(lease);
      await query('UPDATE agents SET token_hash=$2 WHERE id=$1', [actor.agentId, hashToken(randomUUID())]);
      await assert.rejects(f.authorize(lease), denied());
      const g = await fixture(), other = await g.agent(), proposed = (await g.propose(g.input(), other)).preparation; await g.approve(proposed);
      await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [g.company, g.agentSponsor]);
      assert.equal(await g.claim(), null); assert.ok(['blocked', 'failed'].includes((await g.get(proposed.id)).preparation.status));
    });
    await t.test('database guards preserve immutable proposal, approval and receipts and reject fabricated readiness', async () => {
      const f = await fixture(), row = await f.approved(), lease = (await f.claim())!, action = await f.begin(lease); await f.complete(lease, action.actionId);
      for (const sql of ["UPDATE project_image_preparations SET source_snapshot=jsonb_set(source_snapshot,'{sha256}',to_jsonb(repeat('0',64))) WHERE id=$1", "UPDATE project_image_preparations SET request_hash=repeat('0',64) WHERE id=$1", "UPDATE project_image_preparations SET recipe_sha256=repeat('0',64) WHERE id=$1", "UPDATE project_image_preparations SET destination_name='replacement.png' WHERE id=$1", "UPDATE project_image_preparations SET transform_result='{}'::jsonb WHERE id=$1", "UPDATE project_image_preparations SET status='ready' WHERE id=$1"]) await assert.rejects(transaction(db => db.query(sql, [row.id])), error => { assert.ok(['42501', '23514', '23503'].includes((error as {code: string}).code)); return true; });
      await assert.rejects(transaction(db => db.query("UPDATE project_image_preparation_approvals SET max_cost_microusd=max_cost_microusd+1 WHERE preparation_id=$1", [row.id])), {code: '42501'});
      await assert.rejects(transaction(db => db.query("UPDATE project_image_preparation_receipts SET detail='{\"forged\":true}'::jsonb WHERE preparation_id=$1", [row.id])), {code: '42501'});
      await assert.rejects(transaction(db => db.query("UPDATE project_image_preparation_requests SET response='{\"forged\":true}'::jsonb WHERE company_id=$1", [f.company])), {code: '42501'});
      assert.equal((await f.get(row.id)).preparation.status, 'validating');
      assert.equal((await query('SELECT count(*)::int n FROM project_image_preparation_derivations WHERE preparation_id=$1', [row.id])).rows[0].n, 0);
      // Deliberate owner-level metadata fixtures reach the database's final
      // publication guard; none of these statements represent real media I/O.
      await query("UPDATE project_image_preparations SET status='storing' WHERE id=$1", [row.id]);
      await query("UPDATE project_image_preparations SET status='verifying' WHERE id=$1", [row.id]);
      await assert.rejects(transaction(db => db.query('UPDATE project_image_preparations SET cleanup_confirmed_at=clock_timestamp() WHERE id=$1', [row.id])), {code: '23514'});
      await query("INSERT INTO project_image_preparation_receipts(company_id,project_id,preparation_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,'cleanup','returned','{\"syntheticControlFixture\":true}')", [f.company, f.project, row.id, randomUUID()]);
      await query('UPDATE project_image_preparations SET cleanup_confirmed_at=clock_timestamp() WHERE id=$1', [row.id]);
      await assert.rejects(transaction(db => db.query("UPDATE project_image_preparations SET status='ready' WHERE id=$1", [row.id])), {code: '23514'});
      assert.equal((await f.get(row.id)).preparation.status, 'verifying');
    });
    await t.test('database guards reject a transform without intent and prohibit extending an expired attempt', async () => {
      const f = await fixture(), lease = await f.leased();
      await assert.rejects(transaction(db => db.query("UPDATE project_image_preparations SET status='transforming' WHERE id=$1", [lease.preparationId])), {code: '23514'});
      await query("UPDATE project_image_preparations SET lease_expires_at=claimed_at+interval '1 microsecond' WHERE id=$1", [lease.preparationId]);
      await assert.rejects(transaction(db => db.query("UPDATE project_image_preparations SET lease_expires_at=clock_timestamp()+interval '10 seconds' WHERE id=$1", [lease.preparationId])), {code: '23514'});
    });
    await t.test('native PostgreSQL outer run lock and worker company lock return busy without a deadlock', {skip: !integration, timeout: 15_000}, async () => {
      const f = await fixture(), actor = await f.agent(), row = (await f.propose(f.input(), actor)).preparation; await f.approve(row);
      const outer = await pool.connect(), worker = await pool.connect(); let pending: Promise<ProjectImagePreparationLease | null> | undefined;
      try {
        await outer.query('BEGIN'); await outer.query("SET LOCAL statement_timeout='5s'");
        await outer.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [actor.runId]);
        const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = (async () => { await worker.query('BEGIN'); await worker.query("SET LOCAL statement_timeout='5s'"); try { const lease = await preparation.claimProjectImagePreparation(worker, {companyId: f.company, projectIds: [f.project]}, f.options); await worker.query('COMMIT'); return lease; } catch (error) { await worker.query('ROLLBACK'); throw error; } })();
        void pending.catch(() => {}); // The original promise is awaited below, including teardown on failure.
        // Observe an actual backend lock; the emulator's single connection is
        // intentionally not presented as evidence for this concurrency edge.
        const deadline = performance.now() + 3_000; let observed = false;
        while (performance.now() < deadline) {
          observed = (await query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted) AS held", [pid])).rows[0].held;
          if (observed) break; await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(observed, 'Worker owns the company lock while the authenticated caller owns its run row');
        await assert.rejects(preparation.proposeProjectImagePreparation(outer, actor, f.input()), {code: 'IMAGE_PREPARATION_BUSY'});
        await outer.query('ROLLBACK');
        assert.ok(await pending, 'Worker completes after the outer run lock is released'); pending = undefined;
      } finally {
        await outer.query('ROLLBACK');
        try { if (pending) await pending; } finally { outer.release(); worker.release(); }
      }
    });
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.COATRIA_HOSTING_KEYRING; else process.env.COATRIA_HOSTING_KEYRING = oldKey;
    await stop();
  }
});
