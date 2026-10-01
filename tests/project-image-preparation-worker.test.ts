import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, realpath, rename, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {crc32, deflateSync, inflateSync} from 'node:zlib';
import {Pool, type PoolClient} from 'pg';
import {bindProjectStorage, createProjectStorageConnection} from '../src/lib/project-storage';
import {createRunpodProjectStorage} from '../src/lib/project-storage-runpod';
import {IMAGE_PREPARATION_RECIPE_HASH, prepareReferenceImage, type PreparedReferenceImage} from '../src/lib/higgsfield-image-preparation';
import {ImagePreparationError} from '../src/lib/higgsfield-image-preparation-policy';
import {createProjectImagePreparationWorker, type ProjectImagePreparationWorkerOptions} from '../src/lib/project-image-preparation-worker';
import * as preparation from '../src/lib/project-image-preparations';
import type {ProjectImagePreparationProcessor} from '../src/lib/project-image-preparations-protocol';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; };
const turn = () => new Promise<void>(done => setImmediate(done));
function chunk(name: string, bytes: Buffer) { const type = Buffer.from(name), header = Buffer.alloc(4), crc = Buffer.alloc(4); header.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([header, type, bytes, crc]); }
function png(metadataBytes = 64) {
  const width = 96, height = 64, ihdr = Buffer.alloc(13), rows = Buffer.alloc(height * (1 + width * 4));
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 4 + 1) + 1 + x * 4; rows[at] = x < 48 ? 230 : 40; rows[at + 1] = y < 32 ? 200 : 10; rows[at + 2] = x < 48 ? 60 : 220; rows[at + 3] = x < 48 && y < 32 ? 77 : 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('tEXt', Buffer.concat([Buffer.from('Description\0synthetic-private-metadata-'), Buffer.alloc(metadataBytes, 97)])), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function decode(bytes: Buffer) {
  const names: string[] = [], data: Buffer[] = []; let offset = 8;
  while (offset < bytes.length) { const length = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8); names.push(name); assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length)); if (name === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length)); offset += 12 + length; }
  assert.equal(offset, bytes.length); assert.equal(names[0], 'IHDR'); assert.equal(names.at(-1), 'IEND'); assert.ok(names.slice(1, -1).every(name => name === 'IDAT')); assert.equal(bytes[24], 8); assert.equal(bytes[25], 6);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), stride = width * 4, rows = inflateSync(Buffer.concat(data)), pixels = Buffer.alloc(stride * height);
  assert.equal(rows.length, (stride + 1) * height);
  const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) { const filter = rows[y * (stride + 1)]; assert.ok(filter <= 4); for (let x = 0; x < stride; x++) { const at = y * stride + x, a = x >= 4 ? pixels[at - 4] : 0, b = y ? pixels[at - stride] : 0, c = y && x >= 4 ? pixels[at - stride - 4] : 0; pixels[at] = rows[y * (stride + 1) + 1 + x] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]; } }
  return {width, height, pixels};
}

test('trusted preparation worker transforms actual synthetic pixels through real M1 and offline signed S3 byte I/O', {timeout: 240_000}, async t => {
  const oldKey = process.env.COATRIA_HOSTING_KEYRING, oldFetch = globalThis.fetch;
  const ffmpegPath = await realpath(process.env.COATRIA_TEST_FFMPEG_PATH ?? 'C:/Users/pecem/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe');
  const native = {nativeTestMode: true as const, ffmpegPath, ffmpegSha256: hash(await readFile(ffmpegPath))};
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'coatria-worker-fixture-')));
  const integration = process.env.COATRIA_TEST_EMULATOR === '1' ? undefined : process.env.COATRIA_INTEGRATION_DATABASE_URL;
  const migrations = (await readdir('database')).filter(name => /^\d.*\.sql$/.test(name)).sort();
  let pool: Pool, stop: () => Promise<void>;
  if (integration) {
    const url = new URL(integration); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    const control = new Pool({connectionString: integration, max: 1}), name = 'coatria_preparation_worker_' + randomUUID().replaceAll('-', '');
    await control.query('CREATE DATABASE ' + name); url.pathname = '/' + name; pool = new Pool({connectionString: url.href, max: 5});
    stop = async () => { await pool.end(); try { await dropFixtureDatabase(control, name); } finally { await control.end(); } };
    try { for (const name of migrations) await pool.query(await readFile('database/' + name, 'utf8')); } catch (error) { await stop(); throw error; }
  } else {
    const {PGlite} = await import('@electric-sql/pglite'), {PGLiteSocketServer} = await import('@electric-sql/pglite-socket'), db = await PGlite.create();
    try { for (const name of migrations) await db.exec(await readFile('database/' + name, 'utf8')); } catch (error) { await db.close(); throw error; }
    const socket = new PGLiteSocketServer({db, host: '127.0.0.1', port: 0, maxConnections: 1}); await socket.start();
    pool = new Pool({connectionString: 'postgresql://postgres:postgres@' + socket.getServerConn() + '/postgres', max: 1}); stop = async () => { await pool.end(); await socket.stop(); await db.close(); };
  }
  process.env.COATRIA_HOSTING_KEYRING = JSON.stringify({activeKeyId: 'worker-fixture', keys: {'worker-fixture': randomBytes(32).toString('base64')}});
  let activeTransactions = 0, transactionCount = 0;
  let queryHook: ((sql: string) => Promise<void>) | undefined;
  const query = (sql: string, values: unknown[] = []) => pool.query(sql, values);
  async function transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect(); const original = db.query.bind(db);
    const proxy = new Proxy(db, {get(target, property) { if (property === 'query') return async (...args: unknown[]) => { if (typeof args[0] === 'string') await queryHook?.(args[0]); return (original as (...args: unknown[]) => Promise<unknown>)(...args); }; return Reflect.get(target, property); }});
    try { await db.query('BEGIN'); activeTransactions++; transactionCount++; const value = await run(proxy); await db.query('COMMIT'); return value; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { activeTransactions--; db.release(); }
  }
  type Call = {url: URL; init: RequestInit; operation: 'source' | 'initiate' | 'part' | 'complete' | 'stored'};
  type Hook = (call: Call) => Promise<Response | void>;
  const transports = new Map<string, (url: URL, init: RequestInit) => Promise<Response>>();
  globalThis.fetch = async (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, 'https://s3api-us-ca-2.runpod.io'); const reply = [...transports].find(([prefix]) => url.pathname.startsWith(prefix))?.[1]; assert.ok(reply, 'No network fallback exists for unregistered synthetic scope'); assert.equal(activeTransactions, 0, 'Provider I/O starts outside all caller transactions'); return reply(url, init!); };
  async function fixture(sourceBytes = png()) {
    const company = randomUUID(), project = randomUUID(), owner = randomUUID(), admin = randomUUID(), sponsor = randomUUID(), shot = randomUUID(), task = randomUUID(), work = randomUUID(), file = randomUUID(), version = randomUUID();
    for (const user of [owner, admin, sponsor]) await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic worker fixture',$2,'not-a-login')", [user, user + '@example.invalid']);
    await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Offline worker fixture',$2,'blank')", [company, company]);
    await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'admin')", [company, owner, admin, sponsor]);
    await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)", [company, owner]);
    const gates = Object.fromEntries(['brief', 'estimate', 'production'].map(gate => [gate, {decision: 'approved', recordedBy: admin}]));
    await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Synthetic actual pixel preparation','Internal','Offline synthetic pixels through real local decoder',$3,'allowed','production',$4,$5,'higgsfield',2)", [project, company, JSON.stringify({kind: 'image', format: 'png', width: 96, height: 64, color: {mode: 'not_required'}}), JSON.stringify(gates), owner]);
    await query("INSERT INTO studio_shots(id,company_id,project_id,code,description,frame_start,frame_end,handles,disciplines,media_kind) VALUES($1,$2,$3,'SYNTHETIC','Offline pixels',NULL,NULL,NULL,'[]','image')", [shot, company, project]);
    await query("INSERT INTO tasks(id,company_id,title,description,created_by,assignee_id) VALUES($1,$2,'Prepare original','Keep original intact and make separate derivative',$3,$3)", [task, company, owner]);
    await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution,shot_id) VALUES($1,$2,$3,'worker-fixture',$4,'references','ingest','agent',$5)", [work, company, project, task, shot]);
    await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)", [company, owner]);
    const actor = {companyId: company, userId: owner}, adminActor = {companyId: company, userId: admin};
    const connection = (await transaction(db => createProjectStorageConnection(db, {companyId: company, userId: sponsor}, {clientId: randomUUID(), name: 'Offline worker source', region: 'US-CA-2', volumeId: 'synthetic-volume', accessKeyId: 'user_syntheticaccess', secretAccessKey: 'rps_syntheticsecret'}))).connection;
    const binding = (await transaction(db => bindProjectStorage(db, actor, project, {clientId: randomUUID(), revision: 0, connectionId: connection.id}))).binding;
    const objectKey = `coatria/companies/${company}/projects/${project}/objects/${version}`, sourceHash = hash(sourceBytes);
    await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)', [file, company, project, binding.id, 'original.png', owner]);
    await query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'image/png',$7,$8)", [version, company, project, file, sourceBytes.length, sourceHash, objectKey, owner]);
    // Only this preexisting source and runtime/adoption are database fixtures.
    // They do not claim live processor qualification. The worker must actually
    // read these synthetic bytes, invoke pinned M1, upload and read them back.
    await query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'\"source-etag\"',$6)", [company, project, version, sourceBytes.length, sourceHash, randomUUID()]);
    const processor: ProjectImagePreparationProcessor = {id: randomUUID(), location: 'Offline test qualification fixture only', qualificationSha256: 'a'.repeat(64), releaseSha256: 'b'.repeat(64), profileSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), closureSha256: 'e'.repeat(64), transport: 'linux_binary_v1', recipeSha256: IMAGE_PREPARATION_RECIPE_HASH, expiresAt: new Date(Date.now() + 3_600_000).toISOString()};
    const runtime = async () => structuredClone(processor);
    const proposal = (await transaction(db => preparation.proposeProjectImagePreparation(db, actor, {clientId: randomUUID(), projectId: project, projectRevision: 1, workItemId: work, sourceVersionId: version, sourceSha256: sourceHash, sourceBytes: sourceBytes.length, destinationFolderId: null, destinationName: 'prepared.png', purpose: 'Offline worker byte flow test'}))).preparation;
    await transaction(db => preparation.approveProjectImagePreparation(db, adminActor, proposal.id, {clientId: randomUUID(), revision: proposal.revision, requestHash: proposal.requestHash, processorId: processor.id, qualificationSha256: processor.qualificationSha256, expiresInMinutes: 30, maxCostMicrousd: 10_000, processingConsent: true, derivativeWriteConsent: true, adoptionConsent: true}, {runtime}));
    const scratchRoot = join(sandbox, company); await mkdir(scratchRoot);
    const calls: Call[] = [], original = Buffer.from(sourceBytes); let stored: Buffer | undefined, destinationVersion: string | undefined, hook: Hook | undefined, transformed: PreparedReferenceImage | undefined, transforms = 0;
    const uploadedId = 'opaque-' + 'a'.repeat(300); // Valid contract: up to2048, separately from ETags.
    const xml = (text: string) => new Response(text, {headers: {'Content-Type': 'application/xml'}});
    const response = (bytes: Buffer, etag: string, chunkBytes = 4096) => { let offset = 0; return new Response(new ReadableStream<Uint8Array>({pull(controller) { if (offset === bytes.length) return controller.close(); const next = Math.min(bytes.length, offset + chunkBytes); controller.enqueue(Buffer.from(bytes.subarray(offset, next))); offset = next; }}), {headers: {'Content-Length': String(bytes.length), 'Content-Type': 'image/png', ETag: etag}}); };
    transports.set('/synthetic-volume/' + `coatria/companies/${company}/projects/${project}/objects/`, async (url, init) => {
      const selected = url.pathname.split('/').at(-1)!;
      const operation: Call['operation'] = init.method === 'GET' ? selected === version ? 'source' : 'stored' : url.searchParams.has('uploads') ? 'initiate' : init.method === 'PUT' ? 'part' : 'complete';
      const call = {url, init, operation}; calls.push(call);
      assert.match(new Headers(init.headers).get('authorization')!, /^AWS4-HMAC-SHA256 /); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(new Headers(init.headers).get('range'), null);
      const override = await hook?.(call); if (override) return override;
      if (operation === 'source') { assert.equal(new Headers(init.headers).get('if-match'), '"source-etag"'); return response(original, '"source-etag"'); }
      assert.notEqual(selected, version); destinationVersion = selected;
      if (operation === 'initiate') return xml(`<InitiateMultipartUploadResult><Bucket>synthetic-volume</Bucket><Key>${url.pathname.slice('/synthetic-volume/'.length)}</Key><UploadId>${uploadedId}</UploadId></InitiateMultipartUploadResult>`);
      if (operation === 'part') { assert.equal(url.searchParams.get('partNumber'), '1'); assert.equal(url.searchParams.get('uploadId'), uploadedId); stored = Buffer.from(await new Response(init.body).arrayBuffer()); assert.equal(new Headers(init.headers).get('content-length'), String(stored.length)); return new Response(null, {headers: {ETag: '"part-etag"'}}); }
      if (operation === 'complete') { assert.equal(url.searchParams.get('uploadId'), uploadedId); assert.match(String(init.body), /<PartNumber>1<\/PartNumber>/); return xml(`<CompleteMultipartUploadResult><Bucket>synthetic-volume</Bucket><Key>${url.pathname.slice('/synthetic-volume/'.length)}</Key><ETag>"stored-etag"</ETag></CompleteMultipartUploadResult>`); }
      assert.ok(stored); assert.equal(new Headers(init.headers).get('if-match'), '"stored-etag"'); return response(stored, '"stored-etag"');
    });
    const transform: ProjectImagePreparationWorkerOptions['transform'] = async (input, context) => {
      transforms++; assert.equal(activeTransactions, 0); assert.equal(hash(await readFile(input.path)), sourceHash);
      const text = JSON.stringify(context); for (const secret of [objectKey, 'source-etag', 'rps_syntheticsecret', 'user_syntheticaccess']) assert.ok(!text.includes(secret)); assert.deepEqual(Object.keys(input).sort(), ['expectedBytes', 'expectedSha256', 'path', 'signal']); assert.deepEqual(Object.keys(context), ['lease']);
      transformed = await prepareReferenceImage(input, native); return transformed;
    };
    const options: ProjectImagePreparationWorkerOptions = {scope: {companyId: company, projectIds: [project]}, scratchRoot, runtime, transform, transaction, authorityIntervalMs: 1000};
    const row = async () => (await query('SELECT * FROM project_image_preparations WHERE id=$1', [proposal.id])).rows[0];
    const count = async (table: string) => Number((await query(`SELECT count(*) n FROM ${table} WHERE company_id=$1`, [company])).rows[0].n);
    const revoke = async () => { const current = (await transaction(db => preparation.getProjectImagePreparation(db, adminActor, proposal.id))).preparation; await transaction(db => preparation.revokeProjectImagePreparation(db, adminActor, proposal.id, {clientId: randomUUID(), revision: current.revision, note: 'Stop synthetic worker'})); };
    return {company, project, admin, sponsor, file, version, objectKey, sourceHash, sourceBytes: original, processor, proposal, scratchRoot, options, calls, response, row, count, revoke, transform, get transforms() { return transforms; }, get transformed() { return transformed; }, get stored() { return stored; }, get destinationVersion() { return destinationVersion; }, setHook(value: Hook) { hook = value; }};
  }
  const noPublication = async (f: Awaited<ReturnType<typeof fixture>>) => { assert.notEqual((await f.row()).status, 'ready'); assert.equal(await f.count('project_image_preparation_derivations'), 0); assert.equal(await f.count('project_storage_verifications'), 1); assert.equal((await f.row()).cleanup_confirmed_at, null); };
  try {
    await t.test('actual pinned decoder, signed SDK multipart, complete readback and cleanup precede ready', async () => {
      const f = await fixture(), worker = createProjectImagePreparationWorker(f.options), before = transactionCount;
      const result = await worker.runNext(); assert.equal(result.status, 'ready', JSON.stringify(result));
      assert.deepEqual(f.calls.map(call => call.operation), ['source', 'initiate', 'part', 'complete', 'stored']); assert.equal(f.transforms, 1); assert.ok(f.stored && f.transformed); assert.deepEqual(f.stored, f.transformed.bytes);
      const actual = decode(f.stored); assert.equal(actual.width, 96); assert.equal(actual.height, 64); assert.deepEqual([...actual.pixels.subarray(0, 4)], [230, 200, 60, 77]); assert.deepEqual([...actual.pixels.subarray((63 * 96 + 95) * 4)], [40, 10, 220, 255]); assert.ok(!f.stored.includes(Buffer.from('synthetic-private-metadata')));
      assert.equal(hash(f.sourceBytes), f.sourceHash); assert.notEqual(f.destinationVersion, f.version); assert.equal(await f.count('project_storage_versions'), 2); assert.equal(await f.count('project_storage_verifications'), 2); assert.equal(await f.count('project_image_preparation_derivations'), 1); assert.ok((await f.row()).cleanup_confirmed_at); assert.deepEqual(await readdir(f.scratchRoot), []);
      assert.ok(transactionCount - before < 70); assert.equal((await worker.runNext()).status, 'idle');
      const source = (await query('SELECT sha256,bytes FROM project_storage_versions WHERE id=$1', [f.version])).rows[0]; assert.equal(source.sha256, f.sourceHash); assert.equal(Number(source.bytes), f.sourceBytes.length);
    });
    await t.test('8MiB of source metadata in 2048 chunks uses bounded authority work and real transformation', async () => {
      const f = await fixture(png(8 * 1024 ** 2)), before = transactionCount, start = Date.now();
      const result = await createProjectImagePreparationWorker(f.options).runNext(); assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(f.transforms, 1); assert.ok(f.stored!.length < 4096); decode(f.stored!);
      assert.ok(transactionCount - before < 70 + Math.ceil((Date.now() - start) / 1000) * 4, 'Authority round trips must follow time, not input chunks');
    });
    await t.test('missing runtime and invalid policy cannot read or transform an approved source', async () => {
      const f = await fixture(); assert.equal((await createProjectImagePreparationWorker({...f.options, runtime: undefined}).runNext()).status, 'disabled'); assert.equal(f.calls.length, 0); assert.equal(f.transforms, 0);
      for (const patch of [{scratchRoot: 'relative'}, {deadlineMs: 120001}, {authorityIntervalMs: 5001}, {transform: undefined}]) assert.throws(() => createProjectImagePreparationWorker({...f.options, ...patch} as ProjectImagePreparationWorkerOptions));
    });
    for (const mutation of ['etag', 'range', 'bytes', 'truncated'] as const) await t.test('source ' + mutation + ' mismatch stops before decoder/allocation', async () => {
      const f = await fixture(); f.setHook(async call => { if (call.operation !== 'source') return; const bytes = Buffer.from(f.sourceBytes); if (mutation === 'bytes') bytes[bytes.length - 1] ^= 1; if (mutation === 'truncated') return f.response(bytes.subarray(0, -1), '"source-etag"'); const response = f.response(bytes, mutation === 'etag' ? '"wrong-etag"' : '"source-etag"'); if (mutation === 'range') response.headers.set('Content-Range', `bytes 0-${bytes.length - 1}/${bytes.length}`); return response; });
      const result = await createProjectImagePreparationWorker(f.options).runNext(); assert.equal(result.status, 'failed'); assert.equal(f.transforms, 0); assert.equal(await f.count('project_storage_versions'), 1); await noPublication(f); assert.equal(f.calls.length, 1);
    });
    for (const mutation of ['source', 'recipe', 'output-hash', 'metadata', 'scratch-bytes'] as const) await t.test('independent supervisor rejects forged ' + mutation + ' after actual decoder', async () => {
      const f = await fixture(); const result = await createProjectImagePreparationWorker({...f.options, transform: async (input, context) => { const prepared = await f.transform(input, context); if (mutation === 'source') return {...prepared, source: {...prepared.source, orientation: 2}}; if (mutation === 'recipe') return {...prepared, recipeHash: '0'.repeat(64)}; if (mutation === 'output-hash') return {...prepared, output: {...prepared.output, sha256: '0'.repeat(64)}}; if (mutation === 'metadata') return {...prepared, bytes: f.sourceBytes, output: {...prepared.output, bytes: f.sourceBytes.length, sha256: f.sourceHash}}; const {writeFile} = await import('node:fs/promises'); await writeFile(input.path, Buffer.alloc(f.sourceBytes.length)); return prepared; }}).runNext();
      assert.equal(result.status, 'uncertain'); assert.equal(f.transforms, 1); assert.equal(f.calls.length, 1); assert.equal(await f.count('project_storage_versions'), 1); await noPublication(f);
    });
    for (const mutation of ['stored-bytes', 'stored-etag', 'lost-initiate', 'lost-part', 'lost-complete'] as const) await t.test(mutation + ' preserves uncertainty without retry or ready publication', async () => {
      const f = await fixture(); f.setHook(async call => { if (mutation === 'lost-' + call.operation) throw Error('synthetic lost response rps_syntheticsecret'); if (call.operation === 'stored') { if (mutation === 'stored-etag') return f.response(f.stored!, '"wrong-etag"'); if (mutation === 'stored-bytes') { const bytes = Buffer.from(f.stored!); bytes[bytes.length - 1] ^= 1; return f.response(bytes, '"stored-etag"'); } } });
      const worker = createProjectImagePreparationWorker(f.options), result = await worker.runNext(); assert.equal(result.status, 'uncertain', JSON.stringify(result)); assert.doesNotMatch(JSON.stringify(result), /rps_syntheticsecret/); await noPublication(f);
      const count = f.calls.length; await worker.runNext(); assert.equal(f.calls.length, count); assert.equal((await query('SELECT status FROM project_storage_uploads WHERE company_id=$1', [f.company])).rows[0].status, 'uncertain');
    });
    await t.test('revocation during provider mutation commits no returned receipt and performs no follow-on request', async () => {
      const f = await fixture(); f.setHook(async call => { if (call.operation === 'initiate') await f.revoke(); });
      const result = await createProjectImagePreparationWorker(f.options).runNext(); assert.equal(result.status, 'revoked'); assert.deepEqual(f.calls.map(c => c.operation), ['source', 'initiate']); await noPublication(f);
      assert.equal((await query("SELECT count(*)::int n FROM project_image_preparation_receipts WHERE preparation_id=$1 AND operation='store_initiate' AND phase='returned'", [f.proposal.id])).rows[0].n, 0);
    });
    await t.test('watchdog abort waits for an unsettled real transform adapter, retains bytes and rejects its late result', async () => {
      const f = await fixture(), started = deferred(), release = deferred(), aborted = deferred(); let settled = false;
      const worker = createProjectImagePreparationWorker({...f.options, authorityIntervalMs: 10, transform: async (input, context) => { const value = await f.transform(input, context); input.signal!.addEventListener('abort', () => aborted.resolve(), {once: true}); started.resolve(); await release.promise; return value; }});
      const pending = worker.runNext().then(value => { settled = true; return value; });
      try { await started.promise; await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f.admin]); await aborted.promise; await turn();
        assert.equal(settled, false); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal((await worker.runNext()).status, 'disabled');
      } finally { release.resolve(); await pending; }
      const result = await pending;
      assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'IMAGE_PREPARATION_AUTHORITY_CHANGED'); assert.equal(f.calls.length, 1); await noPublication(f);
    });
    await t.test('default SDK drain waits for a raw fetch returning after cancellation before removing source', async () => {
      const f = await fixture(), entered = deferred(), response = deferred<Response>(), cancelled = deferred(), cancelRelease = deferred(), controller = new AbortController(); let settled = false;
      f.setHook(async call => { if (call.operation === 'initiate') { entered.resolve(); return response.promise; } });
      const worker = createProjectImagePreparationWorker(f.options), pending = worker.runNext({signal: controller.signal}).then(value => { settled = true; return value; });
      try { await entered.promise; controller.abort(); await turn();
        assert.equal(settled, false); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal((await worker.runNext()).status, 'disabled');
        response.resolve(new Response(new ReadableStream({cancel: async () => { cancelled.resolve(); await cancelRelease.promise; }}))); await cancelled.promise; await turn(); assert.equal(settled, false); assert.equal((await readdir(f.scratchRoot)).length, 1);
      } finally { controller.abort(); response.resolve(new Response(null)); cancelRelease.resolve(); await pending; }
      const result = await pending; assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'PREPARATION_ABORTED'); await noPublication(f); assert.deepEqual(await readdir(f.scratchRoot), []);
    });
    await t.test('watchdog stops a stalled source read and waits for underlying cancellation', async () => {
      const f = await fixture(), entered = deferred(), cancelled = deferred(), release = deferred(); let settled = false;
      f.setHook(async call => { if (call.operation === 'source') return new Response(new ReadableStream<Uint8Array>({async pull() { entered.resolve(); await release.promise; }, async cancel() { cancelled.resolve(); await release.promise; }}, {highWaterMark: 0}), {headers: {'Content-Length': String(f.sourceBytes.length), 'Content-Type': 'image/png', ETag: '"source-etag"'}}); });
      const controller = new AbortController(), worker = createProjectImagePreparationWorker({...f.options, authorityIntervalMs: 10}), pending = worker.runNext({signal: controller.signal}).then(value => { settled = true; return value; });
      try { await entered.promise;
        await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f.sponsor]); await cancelled.promise; await turn();
        assert.equal(settled, false); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal((await worker.runNext()).status, 'disabled');
      } finally { controller.abort(); release.resolve(); await pending; }
      const result = await pending; assert.equal(result.status, 'failed'); assert.equal(result.code, 'IMAGE_PREPARATION_AUTHORITY_CHANGED'); assert.equal(f.transforms, 0); await noPublication(f);
    });
    await t.test('processor cleanup failure poisons supervisor and preserves original scratch', async () => {
      const f = await fixture(), worker = createProjectImagePreparationWorker({...f.options, transform: async () => { throw new ImagePreparationError('PREPARATION_CLEANUP_FAILED'); }}), result = await worker.runNext();
      assert.equal(result.code, 'PREPARATION_CLEANUP_FAILED'); assert.equal(result.status, 'uncertain'); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal((await worker.runNext()).status, 'disabled'); await noPublication(f);
    });
    await t.test('renamed and replaced scratch is never mistaken for removed source', async () => {
      const f = await fixture(); let moved: string | undefined;
      // Windows denies renaming a directory while the source descriptor is open.
      // Replace it during final drain, after descriptor close but before unlink.
      const worker = createProjectImagePreparationWorker({...f.options, providerFactory: config => ({...createRunpodProjectStorage(config, {fetch: globalThis.fetch}), drain: async () => { const original = join(f.scratchRoot, (await readdir(f.scratchRoot))[0]); moved = join(f.scratchRoot, 'retained-' + randomUUID()); await rename(original, moved); await mkdir(original); }})}), result = await worker.runNext();
      assert.equal(result.code, 'PREPARATION_CLEANUP_FAILED'); assert.equal(hash(await readFile(join(moved!, 'source'))), f.sourceHash); assert.equal((await worker.runNext()).status, 'disabled'); await noPublication(f);
    });
    await t.test('cleanup awaits explicit provider drain and publication cannot outrun it', async () => {
      const f = await fixture(), entered = deferred(), release = deferred(); let settled = false;
      const worker = createProjectImagePreparationWorker({...f.options, providerFactory: config => ({...createRunpodProjectStorage(config, {fetch: globalThis.fetch}), drain: async () => { entered.resolve(); await release.promise; }})});
      const pending = worker.runNext().then(value => { settled = true; return value; });
      try { await entered.promise; await turn(); assert.equal(settled, false); assert.equal((await f.row()).status, 'verifying'); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal(await f.count('project_image_preparation_derivations'), 0); }
      finally { release.resolve(); await pending; }
      assert.equal((await pending).status, 'ready'); assert.deepEqual(await readdir(f.scratchRoot), []);
    });
    await t.test('watchdog remains active during final drain and revocation prevents late publication', async () => {
      const f = await fixture(), entered = deferred(), release = deferred(), aborted = deferred(); let settled = false;
      const worker = createProjectImagePreparationWorker({...f.options, authorityIntervalMs: 10, transform: async (input, context) => { input.signal!.addEventListener('abort', () => aborted.resolve(), {once: true}); return f.transform(input, context); }, providerFactory: config => ({...createRunpodProjectStorage(config, {fetch: globalThis.fetch}), drain: async () => { entered.resolve(); await release.promise; }})});
      const pending = worker.runNext().then(value => { settled = true; return value; });
      try { await entered.promise;
        await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2', [f.company, f.admin]); await aborted.promise; await turn();
        assert.equal(settled, false); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal(await f.count('project_image_preparation_derivations'), 0);
      } finally { release.resolve(); await pending; }
      const result = await pending; assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'IMAGE_PREPARATION_AUTHORITY_CHANGED'); await noPublication(f);
    });
    await t.test('abort before publication transaction commit rolls back ready and still fences failed upload', async () => {
      const f = await fixture(), controller = new AbortController(); let intercepted = false;
      queryHook = async sql => { if (sql.startsWith('INSERT INTO project_image_preparation_derivations')) { intercepted = true; assert.deepEqual(await readdir(f.scratchRoot), []); controller.abort(); } };
      try { const result = await createProjectImagePreparationWorker(f.options).runNext({signal: controller.signal}); assert.equal(intercepted, true); assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'PREPARATION_ABORTED'); await noPublication(f); }
      finally { queryHook = undefined; }
    });
  } finally {
    globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.COATRIA_HOSTING_KEYRING; else process.env.COATRIA_HOSTING_KEYRING = oldKey;
    await stop(); const target = resolve(sandbox); assert.ok(target.startsWith(resolve(tmpdir()) + sep)); assert.match(target, /coatria-worker-fixture-/); await rm(target, {recursive: true, force: true});
  }
});
