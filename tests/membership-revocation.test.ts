import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { handleApi } from '../src/lib/api';
import { requireMembership } from '../src/lib/auth';
import { memberMutation } from '../src/lib/company';
import { database, query } from '../src/lib/db';
import { ApiError, hashToken, secret } from '../src/lib/security';

// This always uses a disposable local database; it never accepts a live URL.
test('revoked membership blocks company reads and writes while preserving personal access', { timeout: 90000 }, async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  for (const file of (await readdir(resolve('database'))).filter(x => /^\d.*\.sql$/.test(x)).sort())
    await db.exec(await readFile(resolve('database', file), 'utf8'));
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 1 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
  process.env.DATABASE_POOL_MAX = '1';
  process.env.TRUST_PROXY = 'true';
  const origin = 'http://localhost:4180', company = randomUUID(), otherCompany = randomUUID();
  const actors = ['owner', 'admin', 'member'].map(role => ({ role, id: randomUUID(), token: secret() }));
  const request = (actor: typeof actors[number], path: string, method = 'GET', body?: unknown) =>
    new Request(`${origin}/api/${path}`, { method, headers: {
      Origin: origin, Cookie: `coatria_session=${actor.token}`, 'Content-Type': 'application/json',
      'x-forwarded-for': `revocation-${actor.id}`,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function call(actor: typeof actors[number], path: string, method = 'GET', body?: unknown) {
    const response = await handleApi(request(actor, path, method, body), path.split('/'));
    return { status: response.status, data: await response.json() };
  }
  try {
    for (const companyId of [company, otherCompany])
      await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Revocation fixture',$2,'blank')", [companyId, `revoke-${companyId}`]);
    for (const actor of actors) {
      await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)', [actor.id, actor.role, `${actor.id}@example.test`, 'test-fixture-only']);
      await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(actor.token), actor.id]);
      await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)', [company, actor.id, actor.role]);
    }
    const base = `companies/${company}`;
    const created = await call(actors[0], `${base}/tasks`, 'POST', { title: 'Retained task evidence' });
    assert.equal(created.status, 201);
    const task = created.data.task;
    const taskPath = `${base}/tasks/${task.id}`;

    await t.test('active access is company scoped and admin checks still apply', async () => {
      assert.equal((await call(actors[2], taskPath)).status, 200);
      assert.equal((await call(actors[2], `companies/${otherCompany}/tasks/${task.id}`)).status, 404);
      await assert.rejects(requireMembership(request(actors[2], taskPath), company, true), (error: unknown) => error instanceof ApiError && error.status === 403);
    });

    for (const actor of actors.slice(1)) {
      await t.test(`revoked ${actor.role} cannot read or mutate despite its retained role`, async () => {
        const cachedMembership = await requireMembership(request(actor, taskPath), company);
        await query('UPDATE memberships SET access_revoked_at=now() WHERE company_id=$1 AND user_id=$2', [company, actor.id]);
        assert.equal((await call(actor, taskPath)).status, 404);
        assert.equal((await call(actor, `${base}/workspace`)).status, 404);
        assert.equal((await call(actor, taskPath, 'PATCH', { expectedRevision: task.revision, title: 'Must never persist' })).status, 404);
        assert.equal((await call(actor, `${base}/tasks`, 'POST', { title: 'Must never exist' })).status, 404);
        let mutationRan = false;
        await assert.rejects(memberMutation(cachedMembership, actor.role === 'admin', async () => { mutationRan = true; }), (error: unknown) => error instanceof ApiError && error.status === 403);
        assert.equal(mutationRan, false, 'A membership cached before revocation must be rechecked inside the write transaction.');
        const session = await call(actor, 'session');
        assert.equal(session.status, 200);
        assert.equal(session.data.user.id, actor.id);
        assert.deepEqual(session.data.companies, []);
        assert.equal((await call(actor, 'vault')).status, 200);
        const retained = await call(actors[0], taskPath);
        assert.equal(retained.status, 200);
        assert.equal(retained.data.task.title, task.title);
        assert.equal(retained.data.task.revision, task.revision);
      });
    }
    await t.test('legacy removed role is denied even with a null revocation timestamp', async () => {
      await query("UPDATE memberships SET role='removed',access_revoked_at=NULL WHERE company_id=$1 AND user_id=$2", [company, actors[2].id]);
      assert.equal((await call(actors[2], taskPath)).status, 404);
      assert.deepEqual((await call(actors[2], 'session')).data.companies, []);
      assert.equal((await call(actors[0], 'session')).data.companies.length, 1);
    });
  } finally {
    await database().end();
    delete (globalThis as unknown as { coatriaPool?: unknown }).coatriaPool;
    await server.stop();
    await db.close();
  }
});
