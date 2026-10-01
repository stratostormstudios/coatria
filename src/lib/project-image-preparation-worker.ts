/** Trusted M3 composition only: no public execution route, native fallback or
 * runtime qualification. Credentials remain in this supervisor. Every external
 * mutation follows a committed intent, and an attempt is never retried here. */
import {createHash, randomUUID} from 'node:crypto';
import {constants, type Stats} from 'node:fs';
import {lstat, mkdir, open, realpath, rm, type FileHandle} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import type {PoolClient} from 'pg';
import {transaction as defaultTransaction} from './db';
import {IMAGE_PREPARATION_RECIPE_HASH, type ImagePreparationInput, type PreparedReferenceImage} from './higgsfield-image-preparation';
import {IMAGE_PREPARATION_POLICY as policy, ImagePreparationError, preparationDimensions} from './higgsfield-image-preparation-policy';
import {inspectPreparationSource} from './higgsfield-image-preparation-source';
import {validatePreparedPng} from './higgsfield-image-preparation-png';
import {authorizeProjectImagePreparation, beginProjectImagePreparationPhase, claimProjectImagePreparation, completeProjectImagePreparationPhase, failProjectImagePreparation, type ProjectImagePreparationOptions} from './project-image-preparations';
import {readProjectImagePreparationSource, reserveProjectImagePreparationOutput, beginProjectImagePreparationStore, completeProjectImagePreparationStore, publishProjectImagePreparation} from './project-image-preparation-storage';
import type {ProjectImagePreparationLease, ProjectImagePreparationStatus} from './project-image-preparations-protocol';
import {createRunpodProjectStorage, type RunpodProjectStorage, type RunpodProjectStorageConfig, type RunpodObjectRead} from './project-storage-runpod';

type Transaction = <T>(run: (db: PoolClient) => Promise<T>) => Promise<T>;
export type ProjectImagePreparationProvider = RunpodProjectStorage & {
  /** Settle raw transport reads/writes and asynchronous body cancellation after
   * close(). A rejected drain is not evidence that remote processing stopped. */
  drain(): Promise<void>;
};
export type ProjectImagePreparationWorkerOptions = {
  scope: {companyId: string; projectIds: readonly string[]};
  scratchRoot: string;
  runtime?: ProjectImagePreparationOptions['runtime'];
  /** Must settle only after processor execution AND descendant cleanup settle.
   * This callback receives no storage credentials, ETags or physical keys. */
  transform: (input: ImagePreparationInput, context: {lease: ProjectImagePreparationLease}) => Promise<PreparedReferenceImage>;
  transaction?: Transaction;
  providerFactory?: (config: RunpodProjectStorageConfig) => ProjectImagePreparationProvider;
  deadlineMs?: number;
  authorityIntervalMs?: number;
};
type Code = 'IMAGE_PREPARATION_WORKER_UNAVAILABLE' | 'IMAGE_PREPARATION_WORKER_POLICY_INVALID' |
  'IMAGE_PREPARATION_AUTHORITY_CHANGED' | 'PREPARATION_TIMEOUT' | 'PREPARATION_ABORTED' |
  'PREPARATION_BYTES_CHANGED' | 'PREPARATION_OUTPUT_INVALID' | 'PREPARATION_CLEANUP_FAILED' |
  'IMAGE_PREPARATION_STORAGE_UNCERTAIN' | 'IMAGE_PREPARATION_STORED_BYTES_CHANGED' | 'IMAGE_PREPARATION_WORKER_FAILED';
export class ProjectImagePreparationWorkerError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'ProjectImagePreparationWorkerError'; }
}
export type ProjectImagePreparationWorkerResult = {processed: boolean; preparationId?: string; status: ProjectImagePreparationStatus | 'disabled' | 'idle'; code?: string};
const fail = (code: Code): never => { throw new ProjectImagePreparationWorkerError(code); };
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
const etag = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const uploadId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

/** The existing SDK adapter races cancellation internally. Track its raw fetch
 * and body promises so an early rejected SDK promise cannot certify cleanup. */
function defaultProvider(config: RunpodProjectStorageConfig): ProjectImagePreparationProvider {
  const pending = new Set<Promise<unknown>>(), bodies = new Set<() => Promise<void>>();
  let closed = false, cancellationFailed = false;
  const track = <T>(promise: Promise<T>) => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const transport: typeof fetch = async (input, init) => {
    const response = await track(fetch(input, init));
    if (!response.body) return response;
    if (closed || init?.signal?.aborted) {
      try { await track(response.body.cancel()); } catch { cancellationFailed = true; }
      return new Response(null, {status: response.status, statusText: response.statusText, headers: response.headers});
    }
    const reader = response.body.getReader(); let cancelled: Promise<void> | undefined, ended = false;
    const cancel = () => cancelled ??= track((async () => {
      try { await reader.cancel(); } catch { cancellationFailed = true; }
      finally { ended = true; bodies.delete(cancel); try { reader.releaseLock(); } catch { cancellationFailed = true; } }
    })());
    bodies.add(cancel);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) { controller.close(); return; }
        try { const part = await track(reader.read()); if (ended) { controller.close(); return; } if (part.done) { ended = true; bodies.delete(cancel); reader.releaseLock(); controller.close(); } else controller.enqueue(part.value); }
        catch (error) { controller.error(error); await cancel(); }
      },
      cancel,
    }, {highWaterMark: 0});
    return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
  };
  const adapter = createRunpodProjectStorage(config, {fetch: transport}), close = adapter.close.bind(adapter);
  return {...adapter, close() { closed = true; close(); for (const cancel of bodies) void cancel(); }, async drain() {
    for (const cancel of bodies) void cancel();
    while (pending.size) await Promise.allSettled([...pending]);
    if (bodies.size || cancellationFailed) fail('PREPARATION_CLEANUP_FAILED');
  }};
}

export function createProjectImagePreparationWorker(options: ProjectImagePreparationWorkerOptions) {
  if (!options || typeof options.scratchRoot !== 'string' || !isAbsolute(options.scratchRoot) || options.scratchRoot.includes('\0') || /^[\\/]{2}/.test(options.scratchRoot) || process.platform === 'win32' && options.scratchRoot.slice(2).includes(':') || !uuid(options.scope?.companyId) || !Array.isArray(options.scope.projectIds) || !options.scope.projectIds.length || options.scope.projectIds.length > 32 || options.scope.projectIds.some(id => !uuid(id)) || new Set(options.scope.projectIds).size !== options.scope.projectIds.length) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
  if (typeof options.transform !== 'function') fail('IMAGE_PREPARATION_WORKER_UNAVAILABLE');
  const rootPath = resolve(options.scratchRoot), scope = {companyId: options.scope.companyId, projectIds: [...options.scope.projectIds]}, runtime = {runtime: options.runtime}, transform = options.transform;
  const transaction = options.transaction ?? defaultTransaction, providerFactory = options.providerFactory ?? defaultProvider;
  const deadlineMs = options.deadlineMs ?? 120_000, interval = options.authorityIntervalMs ?? 1000;
  if (!positive(deadlineMs, 120_000) || !positive(interval, 5000)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
  let busy = false, poisoned = false;
  return {async runNext(input: {signal?: AbortSignal} = {}): Promise<ProjectImagePreparationWorkerResult> {
    if (busy || poisoned || !runtime.runtime) return {processed: false, status: 'disabled', code: 'IMAGE_PREPARATION_WORKER_UNAVAILABLE'};
    busy = true;
    const controller = new AbortController();
    const stop = (code: Code) => { if (!controller.signal.aborted) controller.abort(new ProjectImagePreparationWorkerError(code)); };
    const current = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    const externalAbort = () => stop('PREPARATION_ABORTED');
    input.signal?.addEventListener('abort', externalAbort, {once: true}); if (input.signal?.aborted) externalAbort();
    const deadline = setTimeout(() => stop('PREPARATION_TIMEOUT'), deadlineMs);
    let lease: ProjectImagePreparationLease | null = null, scratch: string | undefined, root: string | undefined, file: FileHandle | undefined, provider: ProjectImagePreparationProvider | undefined;
    let rootIdentity: Stats | undefined, scratchIdentity: Stats | undefined, processorCleanupFailed = false, lastAuthorityCheck = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, cancellation: Promise<void> | undefined, cancellationFailed = false, externalIntent = false;
    let queue: Promise<unknown> = Promise.resolve(), checkPending: Promise<void> | undefined;
    // Serialize supervisor transactions; watchdog authorization must not contend
    // with this same worker's committed phase transition or lease snapshot.
    const atomic = <T>(run: (db: PoolClient) => Promise<T>, reconciliation = false): Promise<T> => { const pending = queue.then(() => transaction(async db => { if (!reconciliation) current(); const value = await run(db); if (!reconciliation) current(); return value; })); queue = pending.catch(() => {}); return pending; };
    const authorize = async (force = true) => {
      current(); if (!force && Date.now() - lastAuthorityCheck < interval) return;
      try { if (lease) await atomic(db => authorizeProjectImagePreparation(db, lease!, runtime)); }
      catch { current(); stop('IMAGE_PREPARATION_AUTHORITY_CHANGED'); current(); }
      current(); lastAuthorityCheck = Date.now();
    };
    const watchdog = setInterval(() => { if (!checkPending && lease && !controller.signal.aborted) checkPending = authorize().catch(() => stop('IMAGE_PREPARATION_AUTHORITY_CHANGED')).finally(() => { checkPending = undefined; }); }, interval);
    const io = async <T>(run: () => Promise<T>) => { await authorize(); const value = await run(); current(); await authorize(); return value; };
    // Chunk boundaries check cancellation immediately, but do not multiply the
    // full authority transaction by the number of 64KiB writes. The watchdog
    // remains active while a read, decoder or cleanup promise is stalled.
    const streamIO = async <T>(run: () => Promise<T>) => { await authorize(false); const value = await run(); current(); await authorize(false); return value; };
    const cancelReader = () => {
      if (!reader) return Promise.resolve();
      const selected = reader;
      return cancellation ??= selected.cancel().catch(() => { cancellationFailed = true; });
    };
    const abortRead = () => { void cancelReader(); };
    controller.signal.addEventListener('abort', abortRead);
    const finishReader = async () => { if (!reader) return; await cancelReader(); try { reader.releaseLock(); } catch { cancellationFailed = true; } reader = undefined; cancellation = undefined; if (cancellationFailed) fail('PREPARATION_CLEANUP_FAILED'); };
    const consume = async (object: RunpodObjectRead, expected: {bytes: number; sha256: string; etag: string; contentType: string}, write?: FileHandle) => {
      if (!object || !object.stream || typeof object.stream.getReader !== 'function') fail('PREPARATION_BYTES_CHANGED');
      reader = object.stream.getReader(); cancellation = undefined;
      try {
        current();
        if (object.bytes !== expected.bytes || object.totalBytes !== expected.bytes || object.etag !== expected.etag || object.contentType !== expected.contentType || object.range !== null || object.contentRange !== null) fail('PREPARATION_BYTES_CHANGED');
        const hash = createHash('sha256'); let count = 0;
        while (true) {
          const part = await streamIO(() => reader!.read()); if (part.done) break;
          if (!(part.value instanceof Uint8Array) || count + part.value.byteLength > expected.bytes) fail('PREPARATION_BYTES_CHANGED');
          for (let offset = 0; offset < part.value.byteLength; offset += 65_536) {
            const chunk = Buffer.from(part.value.subarray(offset, offset + 65_536));
            current();
            if (write) for (let written = 0; written < chunk.length;) { const saved = await streamIO(() => write.write(chunk, written, chunk.length - written, count + written)); if (!saved.bytesWritten) fail('PREPARATION_BYTES_CHANGED'); written += saved.bytesWritten; }
            hash.update(chunk); count += chunk.length;
          }
        }
        if (count !== expected.bytes || hash.digest('hex') !== expected.sha256) fail('PREPARATION_BYTES_CHANGED');
      } finally { await finishReader(); }
    };
    const snapshotSource = async () => {
      const before = await file!.stat(); if (!before.isFile() || before.nlink !== 1 || before.size !== lease!.source.bytes) fail('PREPARATION_BYTES_CHANGED');
      const bytes = Buffer.alloc(lease!.source.bytes);
      for (let position = 0; position < bytes.length;) { const value = await streamIO(() => file!.read(bytes, position, Math.min(65_536, bytes.length - position), position)); if (!value.bytesRead) fail('PREPARATION_BYTES_CHANGED'); position += value.bytesRead; }
      const after = await file!.stat(), named = await lstat(join(scratch!, 'source'));
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || named.isSymbolicLink() || named.ino !== after.ino || named.dev !== after.dev || named.nlink !== 1 || digest(bytes) !== lease!.source.sha256) fail('PREPARATION_BYTES_CHANGED');
      return bytes;
    };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= (async () => {
      let failed = processorCleanupFailed;
      try { await finishReader(); } catch { failed = true; }
      if (file) { try { await file.close(); file = undefined; } catch { failed = true; } }
      if (provider) { try { provider.close(); } catch { failed = true; } try { await provider.drain(); } catch { failed = true; } }
      // A failed close/drain cannot prove it is safe to unlink bytes still owned
      // by a processor or transport. Retain scratch and the durable claim slot.
      if (!failed && scratch) {
        try {
          if (!root || !rootIdentity || !scratchIdentity || dirname(scratch) !== root || !uuid(scratch.slice(root.length + 1))) throw new ProjectImagePreparationWorkerError('PREPARATION_CLEANUP_FAILED');
          const currentRoot = await lstat(root), currentScratch = await lstat(scratch);
          if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino || !currentScratch.isDirectory() || currentScratch.isSymbolicLink() || currentScratch.dev !== scratchIdentity.dev || currentScratch.ino !== scratchIdentity.ino || pathKey(await realpath(root)) !== pathKey(root) || pathKey(await realpath(scratch)) !== pathKey(scratch)) fail('PREPARATION_CLEANUP_FAILED');
          await rm(scratch, {recursive: true, force: false}); scratch = undefined;
        } catch { failed = true; }
      }
      if (failed) { poisoned = true; fail('PREPARATION_CLEANUP_FAILED'); }
    })();
    try {
      current();
      const rootInfo = await lstat(rootPath); root = await realpath(rootPath);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || pathKey(root) !== pathKey(rootPath)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      rootIdentity = rootInfo;
      lease = await atomic(db => claimProjectImagePreparation(db, scope, runtime)); current();
      if (!lease) return {processed: false, status: 'idle'};
      lease = structuredClone(lease);
      if (lease.companyId !== scope.companyId || !scope.projectIds.includes(lease.projectId) || !uuid(lease.preparationId) || !uuid(lease.leaseId) || !uuid(lease.source.versionId) || !positive(lease.source.bytes, policy.sourceMaxBytes) || !sha(lease.source.sha256) || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now() || lease.recipeSha256 !== IMAGE_PREPARATION_RECIPE_HASH) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      await authorize();
      scratch = join(root, randomUUID()); await mkdir(scratch, {mode: 0o700});
      scratchIdentity = await lstat(scratch);
      if (!scratchIdentity.isDirectory() || scratchIdentity.isSymbolicLink() || pathKey(await realpath(scratch)) !== pathKey(scratch)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      const path = join(scratch, 'source'); file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
      const source = await atomic(db => readProjectImagePreparationSource(db, lease!, runtime)); current();
      if (source.versionId !== lease.source.versionId || source.bytes !== lease.source.bytes || source.sha256 !== lease.source.sha256 || source.contentType !== lease.source.contentType || !etag(source.etag) || source.config.companyId !== lease.companyId || source.config.projectId !== lease.projectId) fail('PREPARATION_BYTES_CHANGED');
      provider = providerFactory({...source.config, partBytes: 64 * 1024 ** 2, maxObjectBytes: policy.sourceMaxBytes, timeoutMs: Math.min(30_000, deadlineMs)});
      if (!provider || typeof provider.drain !== 'function') fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      // Capture an obtained body even if abort occurred while get() was pending.
      const object = await io(async () => { const result = await provider!.get({versionId: source.versionId, ifMatch: source.etag, maxBytes: source.bytes, signal: controller.signal}); reader = result.stream.getReader(); cancellation = undefined; return result; });
      reader!.releaseLock(); reader = undefined;
      await consume(object, source, file); await file.sync();
      const original = await snapshotSource(), actualSource = inspectPreparationSource(original);
      if ('image/' + actualSource.format !== source.contentType) fail('PREPARATION_BYTES_CHANGED');
      await authorize(); externalIntent = true;
      const action = await atomic(db => beginProjectImagePreparationPhase(db, lease!, 'transform', runtime)); current();
      const transformed = await io(() => transform({path, expectedBytes: source.bytes, expectedSha256: source.sha256, signal: controller.signal}, {lease: structuredClone(lease!)}));
      await snapshotSource();
      const rotated = actualSource.orientation >= 5, size = preparationDimensions(rotated ? actualSource.height : actualSource.width, rotated ? actualSource.width : actualSource.height);
      if (!transformed || !Buffer.isBuffer(transformed.bytes) || transformed.bytes.length > policy.outputMaxBytes || transformed.recipeHash !== lease.recipeSha256 || !transformed.source || ['format', 'width', 'height', 'orientation'].some(key => transformed.source[key as keyof typeof transformed.source] !== actualSource[key as keyof typeof actualSource])) fail('PREPARATION_OUTPUT_INVALID');
      const bytes = validatePreparedPng(Buffer.from(transformed.bytes), size), hash = digest(bytes), output = transformed.output;
      if (!output || output.bytes !== bytes.length || output.sha256 !== hash || output.width !== size.width || output.height !== size.height || output.format !== 'png' || output.pixelFormat !== 'rgba8' || output.metadataRemoved !== true) fail('PREPARATION_OUTPUT_INVALID');
      await atomic(db => completeProjectImagePreparationPhase(db, lease!, action.actionId, {operation: 'transform', sourceVersionId: source.versionId, sourceBytes: source.bytes, sourceSha256: source.sha256, source: actualSource, recipeSha256: lease!.recipeSha256, processor: lease!.processor, output: {...size, bytes: bytes.length, sha256: hash, format: 'png', pixelFormat: 'rgba8', metadataRemoved: true}}, runtime)); current();
      const reserved = await atomic(db => reserveProjectImagePreparationOutput(db, lease!, runtime)); current();
      if (!uuid(reserved.versionId) || !uuid(reserved.fileId) || !uuid(reserved.uploadId) || reserved.versionId === source.versionId || reserved.fileId === lease.source.fileId || reserved.bytes !== bytes.length || reserved.sha256 !== hash || reserved.partBytes !== 64 * 1024 ** 2) fail('PREPARATION_OUTPUT_INVALID');
      const sameOutput = (value: typeof reserved) => { if (!value || ['fileId', 'versionId', 'uploadId', 'bytes', 'sha256', 'partBytes'].some(key => value[key as keyof typeof value] !== reserved[key as keyof typeof reserved])) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN'); };
      const multipart = (value: Parameters<RunpodProjectStorage['validateMultipart']>[0]) => {
        const checked = provider!.validateMultipart(value);
        if (checked.versionId !== reserved.versionId || checked.bytes !== bytes.length || checked.partBytes !== reserved.partBytes || !sha(checked.scope) || !uploadId(checked.uploadId)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
        return checked;
      };
      const initiate = await atomic(db => beginProjectImagePreparationStore(db, lease!, 'initiate', runtime)); current();
      sameOutput(initiate.output); if (!uuid(initiate.actionId) || initiate.descriptor || initiate.parts.length) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
      const descriptor = multipart(await io(() => provider!.createMultipart({versionId: reserved.versionId, bytes: bytes.length, contentType: 'image/png', signal: controller.signal})));
      await atomic(db => completeProjectImagePreparationStore(db, lease!, initiate.actionId, {operation: 'initiate', descriptor}, runtime)); current();
      const part = await atomic(db => beginProjectImagePreparationStore(db, lease!, 'part', runtime)); current();
      sameOutput(part.output); if (!uuid(part.actionId) || !part.descriptor || part.parts.length) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
      const partUpload = multipart(part.descriptor);
      const uploaded = await io(() => provider!.uploadPart({upload: partUpload, partNumber: 1, body: Buffer.from(bytes), signal: controller.signal}));
      if (uploaded.partNumber !== 1 || uploaded.bytes !== bytes.length || !etag(uploaded.etag)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
      await atomic(db => completeProjectImagePreparationStore(db, lease!, part.actionId, {operation: 'part', part: uploaded, sha256: hash}, runtime)); current();
      const finish = await atomic(db => beginProjectImagePreparationStore(db, lease!, 'complete', runtime)); current();
      sameOutput(finish.output); if (!uuid(finish.actionId) || !finish.descriptor || finish.parts.length !== 1 || finish.parts[0].partNumber !== 1 || finish.parts[0].bytes !== bytes.length || finish.parts[0].etag !== uploaded.etag) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
      const completionUpload = multipart(finish.descriptor);
      const completed = await io(() => provider!.completeMultipart({upload: completionUpload, parts: finish.parts, signal: controller.signal}));
      if (completed.versionId !== reserved.versionId || !etag(completed.etag)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
      await atomic(db => completeProjectImagePreparationStore(db, lease!, finish.actionId, {operation: 'complete', versionId: completed.versionId, etag: completed.etag}, runtime)); current();
      const stored = await io(async () => { const result = await provider!.get({versionId: reserved.versionId, ifMatch: completed.etag, maxBytes: bytes.length, signal: controller.signal}); reader = result.stream.getReader(); cancellation = undefined; return result; });
      reader!.releaseLock(); reader = undefined;
      try { await consume(stored, {bytes: bytes.length, sha256: hash, etag: completed.etag, contentType: 'image/png'}); } catch (error) { if (error instanceof ProjectImagePreparationWorkerError && error.code === 'PREPARATION_BYTES_CHANGED') fail('IMAGE_PREPARATION_STORED_BYTES_CHANGED'); throw error; }
      await authorize();
      await cleanup(); current();
      clearInterval(watchdog); await checkPending; await authorize();
      const published = await atomic(async db => { current(); const value = await publishProjectImagePreparation(db, lease!, {bytes: bytes.length, sha256: hash, etag: completed.etag, cleanupConfirmed: true}, runtime); current(); return value; });
      return {processed: true, preparationId: lease.preparationId, status: published.preparation.status};
    } catch (error) {
      if (error instanceof ImagePreparationError && error.code === 'PREPARATION_CLEANUP_FAILED') { processorCleanupFailed = true; poisoned = true; }
      let code: string = controller.signal.aborted ? (controller.signal.reason as ProjectImagePreparationWorkerError).code : error instanceof ProjectImagePreparationWorkerError || error instanceof ImagePreparationError ? error.code : externalIntent ? 'IMAGE_PREPARATION_STORAGE_UNCERTAIN' : 'IMAGE_PREPARATION_WORKER_FAILED';
      try { await cleanup(); } catch { code = 'PREPARATION_CLEANUP_FAILED'; poisoned = true; }
      clearInterval(watchdog); await checkPending;
      if (!lease) return {processed: false, status: 'disabled', code};
      try { const saved = await atomic(db => failProjectImagePreparation(db, lease!, code), true); return {processed: true, preparationId: lease.preparationId, status: saved.preparation.status, code}; }
      catch { poisoned = true; return {processed: true, preparationId: lease.preparationId, status: externalIntent ? 'uncertain' : 'failed', code}; }
    } finally {
      clearTimeout(deadline); clearInterval(watchdog); input.signal?.removeEventListener('abort', externalAbort); controller.signal.removeEventListener('abort', abortRead); busy = false;
    }
  }};
}
