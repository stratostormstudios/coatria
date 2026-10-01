import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {deflateSync} from 'node:zlib';
import {build} from 'esbuild';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import {createProjectImagePreparationWorkerCore, type ProjectImagePreparationCoreOptions, type ProjectImagePreparationPorts, type ProjectImagePreparationByteRead, type ProjectImagePreparationStoreReceipt} from '../src/lib/project-image-preparation-worker-core';
import type {ProjectImagePreparationLease} from '../src/lib/project-image-preparations-protocol';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes: Buffer) {let n = 0xffffffff; for (const byte of bytes) {n ^= byte; for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;} return (n ^ 0xffffffff) >>> 0;}
function chunk(name: string, bytes: Buffer) {const out = Buffer.alloc(12 + bytes.length); out.writeUInt32BE(bytes.length); out.write(name, 4); bytes.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + bytes.length)), 8 + bytes.length); return out;}
function png(metadata: boolean) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...metadata ? [chunk('tEXt', Buffer.from('Note\0synthetic fixture'))] : [], chunk('IDAT', deflateSync(Buffer.from([0, 210, 40, 10, 77, 10, 30, 220, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};

/** This fixture proves orchestration and byte verification through named ports.
 * The transform is a synthetic descriptor/PNG fixture, not a decoder, sandbox,
 * qualification, provider or database integration proof. The unchanged M3
 * worker test separately exercises actual native conversion and signed SDK I/O. */
async function fixture() {
  const scratchRoot = await realpath(await mkdtemp(join(tmpdir(), 'coatria-preparation-ports-'))), companyId = randomUUID(), projectId = randomUUID();
  const original = png(true), outputBytes = png(false), expiresAt = new Date(Date.now() + 120000).toISOString();
  const lease: ProjectImagePreparationLease = {companyId, projectId, preparationId: randomUUID(), leaseId: randomUUID(), requestHash: 'a'.repeat(64), claimedAt: new Date().toISOString(), expiresAt, recipeSha256: IMAGE_PREPARATION_RECIPE_HASH,
    source: {versionId: randomUUID(), fileId: randomUUID(), name: 'original.png', version: 1, bytes: original.length, sha256: hash(original), contentType: 'image/png'},
    processor: {id: randomUUID(), location: 'Synthetic port fixture only', qualificationSha256: 'b'.repeat(64), releaseSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64), sourceCommit: 'e'.repeat(40), closureSha256: 'f'.repeat(64), transport: 'linux_binary_v1', recipeSha256: IMAGE_PREPARATION_RECIPE_HASH, expiresAt}};
  const source = {versionId: lease.source.versionId, bytes: original.length, sha256: hash(original), contentType: 'image/png', etag: '"source"'};
  const output = {fileId: randomUUID(), versionId: randomUUID(), uploadId: randomUUID(), bytes: outputBytes.length, sha256: hash(outputBytes), partBytes: 64 * 1024 ** 2};
  const calls: string[] = [], receipts: ProjectImagePreparationStoreReceipt[] = []; let claimed = false, failedCode: string | undefined, published = false, authorityEnded = false;
  const read = (bytes: Buffer, etag: string): ProjectImagePreparationByteRead => ({stream: new ReadableStream({start(c) {c.enqueue(Buffer.from(bytes)); c.close();}}), bytes: bytes.length, totalBytes: bytes.length, contentType: 'image/png', etag, range: null, contentRange: null});
  const ports: ProjectImagePreparationPorts = {
    control: {
      async claim(scope, context) {context.assertCurrent(); assert.deepEqual(scope, {companyId, projectIds: [projectId]}); calls.push('claim'); if (claimed) return null; claimed = true; return structuredClone(lease);},
      async authorize(actual, context) {context.assertCurrent(); assert.equal(actual.leaseId, lease.leaseId); if (authorityEnded) throw new Error('private authority details must not escape');},
      async source(actual, context) {context.assertCurrent(); assert.equal(actual.source.versionId, source.versionId); calls.push('source'); return {...source};},
      async beginTransform(_lease, context) {context.assertCurrent(); calls.push('begin-transform'); return {actionId: randomUUID()};},
      async completeTransform(_lease, actionId, result, context) {context.assertCurrent(); assert.match(actionId, /^[a-f0-9-]{36}$/); assert.equal(result.output.sha256, output.sha256); calls.push('complete-transform');},
      async reserveOutput(_lease, context) {context.assertCurrent(); calls.push('reserve'); return {...output};},
      async beginStore(_lease, operation, context) {context.assertCurrent(); calls.push('begin-' + operation); return {actionId: randomUUID(), operation, output: {...output}};},
      async completeStore(_lease, receipt, context) {context.assertCurrent(); calls.push('complete-' + receipt.operation); receipts.push(structuredClone(receipt));},
      async publish(_lease, actual, context) {context.assertCurrent(); calls.push('publish'); assert.deepEqual(actual, {bytes: output.bytes, sha256: output.sha256, etag: '"stored"', cleanupConfirmed: true}); assert.deepEqual(await readdir(scratchRoot), []); context.assertCurrent(); published = true; return {status: 'ready'};},
      async fail(_lease, code) {calls.push('fail'); failedCode = code; return {status: 'uncertain'};},
    },
    bytes: {
      async readSource(_lease, actual, context) {context.assertCurrent(); calls.push('read-source'); assert.deepEqual(actual, source); return read(original, source.etag);},
      async initiate(_lease, intent, context) {context.assertCurrent(); calls.push('bytes-initiate'); return {...intent, operation: 'initiate'};},
      async uploadPart(_lease, intent, bytes, context) {context.assertCurrent(); calls.push('bytes-part'); assert.deepEqual(bytes, outputBytes); return {...intent, operation: 'part', partNumber: 1, bytes: bytes.length, sha256: hash(bytes)};},
      async complete(_lease, intent, context) {context.assertCurrent(); calls.push('bytes-complete'); return {...intent, operation: 'complete', etag: '"stored"'};},
      async readOutput(_lease, actual, etag, context) {context.assertCurrent(); calls.push('read-output'); assert.deepEqual(actual, output); return read(outputBytes, etag);},
      close() {calls.push('close');},
      async drain() {calls.push('drain');},
    },
  };
  const options: ProjectImagePreparationCoreOptions = {scope: {companyId, projectIds: [projectId]}, scratchRoot, createPorts: () => ports, authorityIntervalMs: 20,
    async transform(input, context) {calls.push('transform'); assert.deepEqual(await readFile(input.path), original); assert.equal(input.expectedSha256, source.sha256); assert.deepEqual(Object.keys(context), ['lease']); assert.deepEqual(context.lease, lease); return {bytes: Buffer.from(outputBytes), source: {format: 'png', width: 2, height: 1, orientation: 1}, recipeHash: IMAGE_PREPARATION_RECIPE_HASH, output: {width: 2, height: 1, bytes: outputBytes.length, sha256: output.sha256, format: 'png', pixelFormat: 'rgba8', metadataRemoved: true}};}};
  return {scratchRoot, lease, source, output, original, outputBytes, options, ports, calls, receipts, read, endAuthority() {authorityEnded = true;}, get published() {return published;}, get failedCode() {return failedCode;}, async dispose() {const target = resolve(scratchRoot); assert.ok(target.startsWith(resolve(tmpdir()) + sep)); assert.match(target, /coatria-preparation-ports-/); await rm(target, {recursive: true, force: true});}};
}

test('core import graph has no database, provider adapter, credential vault or local composition', async () => {
  const result = await build({entryPoints: ['src/lib/project-image-preparation-worker-core.ts'], bundle: true, platform: 'node', target: 'node24', write: false, metafile: true, logLevel: 'silent'});
  for (const name of Object.keys(result.metafile!.inputs)) assert.doesNotMatch(name.replaceAll('\\', '/'), /(?:\/node_modules\/(?:pg|@aws-sdk)\/|\/db\.ts$|project-storage(?:-runpod)?\.ts$|project-image-preparation-worker\.ts$|project-image-preparations\.ts$|hosting-vault)/);
});

test('named ports preserve ordered intents, exact binary reads, separate derivative and cleanup-before-publication', async () => {
  const f = await fixture(); try {
    assert.equal((await createProjectImagePreparationWorkerCore(f.options).runNext()).status, 'ready');
    assert.deepEqual(f.calls, ['claim','source','read-source','begin-transform','transform','complete-transform','reserve','begin-initiate','bytes-initiate','complete-initiate','begin-part','bytes-part','complete-part','begin-complete','bytes-complete','complete-complete','read-output','close','drain','publish']);
    assert.equal(f.receipts.length, 3); assert.doesNotMatch(JSON.stringify(f.receipts), /descriptor|provider_upload|objectKey|credentials|accessKey|secret|config/);
    assert.notEqual(f.output.versionId, f.source.versionId); assert.equal(hash(f.original), f.source.sha256); assert.equal(f.published, true);
  } finally {await f.dispose();}
});

test('changed action or output receipts stop before the next provider phase without retry', async t => {
  for (const change of ['action','output','bytes','etag'] as const) await t.test(change, async () => {
    const f = await fixture(); try {
      if (change === 'action' || change === 'output') {const original = f.ports.bytes.initiate; f.ports.bytes.initiate = async (...args) => {const value = await original(...args); return change === 'action' ? {...value, actionId: randomUUID()} : {...value, output: {...value.output, versionId: randomUUID()}};};}
      if (change === 'bytes') {const original = f.ports.bytes.uploadPart; f.ports.bytes.uploadPart = async (...args) => ({...await original(...args), bytes: 1});}
      if (change === 'etag') {const original = f.ports.bytes.complete; f.ports.bytes.complete = async (...args) => ({...await original(...args), etag: ''});}
      const result = await createProjectImagePreparationWorkerCore(f.options).runNext(); assert.equal(result.code, 'IMAGE_PREPARATION_STORAGE_UNCERTAIN'); assert.equal(f.published, false);
      assert.equal(f.calls.filter(c => c === 'bytes-initiate').length, 1); assert.ok(!f.calls.includes('read-output'));
      if (change === 'action' || change === 'output') assert.ok(!f.calls.includes('bytes-part'));
      if (change === 'bytes') assert.ok(!f.calls.includes('bytes-complete'));
    } finally {await f.dispose();}
  });
});

test('invalid transform action stops before the injected transformer', async () => {
  const f = await fixture(); try {f.ports.control.beginTransform = async () => ({actionId: 'not-an-action'}); const result = await createProjectImagePreparationWorkerCore(f.options).runNext(); assert.equal(result.code, 'IMAGE_PREPARATION_WORKER_POLICY_INVALID'); assert.ok(!f.calls.includes('transform')); assert.ok(!f.calls.includes('reserve'));} finally {await f.dispose();}
});

test('readback corruption cannot publish the claimed derivative', async () => {
  const f = await fixture(); try {f.ports.bytes.readOutput = async () => f.read(Buffer.alloc(f.output.bytes), '"stored"'); const result = await createProjectImagePreparationWorkerCore(f.options).runNext(); assert.equal(result.code, 'IMAGE_PREPARATION_STORED_BYTES_CHANGED'); assert.equal(f.published, false);} finally {await f.dispose();}
});

test('watchdog abort cannot outrun raw byte-port drain or remove its scratch', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let settled = false;
  try {
    f.ports.bytes.drain = async () => {f.calls.push('drain'); entered.resolve(); await release.promise;};
    const pending = createProjectImagePreparationWorkerCore(f.options).runNext().then(value => {settled = true; return value;});
    await entered.promise; f.endAuthority(); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(settled, false); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal(f.published, false);
    release.resolve(); const result = await pending; assert.equal(result.code, 'IMAGE_PREPARATION_AUTHORITY_CHANGED'); assert.deepEqual(await readdir(f.scratchRoot), []); assert.equal(f.published, false);
  } finally {release.resolve(); await f.dispose();}
});

test('publication context preserves precommit cancellation and unguarded failure reconciliation', async () => {
  const f = await fixture(), stop = new AbortController(); let committed = false;
  try {
    f.ports.control.publish = async (_lease, _result, context) => {context.assertCurrent(); stop.abort(); await Promise.resolve(); context.assertCurrent(); committed = true; return {status: 'ready'};};
    const result = await createProjectImagePreparationWorkerCore(f.options).runNext({signal: stop.signal});
    assert.equal(committed, false); assert.equal(result.code, 'PREPARATION_ABORTED'); assert.equal(f.failedCode, 'PREPARATION_ABORTED'); assert.equal(f.calls.filter(c => c === 'fail').length, 1);
  } finally {await f.dispose();}
});

test('drain failure retains scratch, fences the attempt and disables subsequent admission', async () => {
  const f = await fixture(); try {
    f.ports.bytes.drain = async () => {throw new Error('synthetic unresolved transport');}; const worker = createProjectImagePreparationWorkerCore(f.options);
    assert.equal((await worker.runNext()).code, 'PREPARATION_CLEANUP_FAILED'); assert.equal((await readdir(f.scratchRoot)).length, 1); assert.equal(f.published, false);
    assert.equal((await worker.runNext()).status, 'disabled'); assert.equal(f.calls.filter(c => c === 'claim').length, 1);
  } finally {await f.dispose();}
});
