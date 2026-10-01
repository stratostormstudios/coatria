/** Credential-free preparation orchestration. No database, provider credentials,
 * physical object keys, SQL transport, default native decoder or runtime activation.
 * Ports are trusted implementations; remote bytes belong on the finite gateway,
 * never in Vercel JSON, provider logs or model context. */
import {createHash, randomUUID} from 'node:crypto';
import {constants, type Stats} from 'node:fs';
import {lstat, mkdir, open, realpath, rm, type FileHandle} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {IMAGE_PREPARATION_RECIPE_HASH, type ImagePreparationInput, type PreparedReferenceImage} from './higgsfield-image-preparation';
import {IMAGE_PREPARATION_POLICY as policy, ImagePreparationError, preparationDimensions} from './higgsfield-image-preparation-policy';
import {inspectPreparationSource} from './higgsfield-image-preparation-source';
import {validatePreparedPng} from './higgsfield-image-preparation-png';
import type {ProjectImagePreparationLease, ProjectImagePreparationStatus, ProjectImagePreparationTransformResult} from './project-image-preparations-protocol';

export type ProjectImagePreparationOperationContext = {signal: AbortSignal; assertCurrent: () => void};
export type ProjectImagePreparationSourceRead = {versionId: string; bytes: number; sha256: string; etag: string; contentType: string};
export type ProjectImagePreparationOutput = {fileId: string; versionId: string; uploadId: string; bytes: number; sha256: string; partBytes: number};
export type ProjectImagePreparationStoreOperation = 'initiate' | 'part' | 'complete';
export type ProjectImagePreparationStoreIntent = {actionId: string; operation: ProjectImagePreparationStoreOperation; output: ProjectImagePreparationOutput};
export type ProjectImagePreparationStoreReceipt = ProjectImagePreparationStoreIntent & (
  {operation: 'initiate'} | {operation: 'part'; partNumber: 1; bytes: number; sha256: string} | {operation: 'complete'; etag: string}
);
export type ProjectImagePreparationByteRead = {stream: ReadableStream<Uint8Array>; bytes: number; totalBytes: number; etag: string; contentType: string | null; range: {start: number; end: number} | null; contentRange: string | null};
export type ProjectImagePreparationPublication = {bytes: number; sha256: string; etag: string; cleanupConfirmed: true};
export type ProjectImagePreparationControlPorts = {
  claim(scope: {companyId: string; projectIds: readonly string[]}, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationLease | null>;
  authorize(lease: ProjectImagePreparationLease, context: ProjectImagePreparationOperationContext): Promise<void>;
  source(lease: ProjectImagePreparationLease, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationSourceRead>;
  beginTransform(lease: ProjectImagePreparationLease, context: ProjectImagePreparationOperationContext): Promise<{actionId: string}>;
  completeTransform(lease: ProjectImagePreparationLease, actionId: string, result: ProjectImagePreparationTransformResult & {operation: 'transform'}, context: ProjectImagePreparationOperationContext): Promise<void>;
  reserveOutput(lease: ProjectImagePreparationLease, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationOutput>;
  beginStore(lease: ProjectImagePreparationLease, operation: ProjectImagePreparationStoreOperation, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationStoreIntent>;
  /** Resolve an action-bound, trusted byte-transport result. A remote server must
   * never turn a caller-supplied receipt into provider or stored-byte evidence. */
  completeStore(lease: ProjectImagePreparationLease, receipt: ProjectImagePreparationStoreReceipt, context: ProjectImagePreparationOperationContext): Promise<void>;
  publish(lease: ProjectImagePreparationLease, result: ProjectImagePreparationPublication, context: ProjectImagePreparationOperationContext): Promise<{status: ProjectImagePreparationStatus}>;
  /** Reconciliation remains possible after cancellation; it grants no new work. */
  fail(lease: ProjectImagePreparationLease, code: string): Promise<{status: ProjectImagePreparationStatus}>;
};
export type ProjectImagePreparationBytePorts = {
  /** Full exact read, <=32MiB. No ranges, caller-selected URL or physical key. */
  readSource(lease: ProjectImagePreparationLease, source: ProjectImagePreparationSourceRead, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationByteRead>;
  initiate(lease: ProjectImagePreparationLease, intent: ProjectImagePreparationStoreIntent, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationStoreReceipt & {operation: 'initiate'}>;
  /** One <=10MiB PNG part in the already reserved 64MiB-capacity upload. */
  uploadPart(lease: ProjectImagePreparationLease, intent: ProjectImagePreparationStoreIntent, bytes: Buffer, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationStoreReceipt & {operation: 'part'}>;
  complete(lease: ProjectImagePreparationLease, intent: ProjectImagePreparationStoreIntent, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationStoreReceipt & {operation: 'complete'}>;
  readOutput(lease: ProjectImagePreparationLease, output: ProjectImagePreparationOutput, etag: string, context: ProjectImagePreparationOperationContext): Promise<ProjectImagePreparationByteRead>;
  close(): void;
  /** Settle actual raw requests, reads, writes and cancellation. Early promise
   * rejection is not cleanup; failure retains scratch and poisons admission. */
  drain(): Promise<void>;
};
/** Every method must retain ownership until its underlying work settles, even
 * when cancellation ends the caller's useful operation. No port retries writes.
 * assertCurrent is local-only: remote services enforce their own commit fence. */
export type ProjectImagePreparationPorts = {control: ProjectImagePreparationControlPorts; bytes: ProjectImagePreparationBytePorts};
export type ProjectImagePreparationCoreOptions = {
  scope: {companyId: string; projectIds: readonly string[]}; scratchRoot: string;
  createPorts: () => ProjectImagePreparationPorts | null;
  /** A production composition must supply its actually qualified transform;
   * this core provides no fallback or claim of sandbox qualification. */
  transform: (input: ImagePreparationInput, context: {lease: ProjectImagePreparationLease}) => Promise<PreparedReferenceImage>;
  deadlineMs?: number; authorityIntervalMs?: number;
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
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

function assertPorts(ports: ProjectImagePreparationPorts) {
  if (!ports || !ports.control || !ports.bytes || ['claim','authorize','source','beginTransform','completeTransform','reserveOutput','beginStore','completeStore','publish','fail'].some(name => typeof ports.control[name as keyof ProjectImagePreparationControlPorts] !== 'function') || ['readSource','initiate','uploadPart','complete','readOutput','close','drain'].some(name => typeof ports.bytes[name as keyof ProjectImagePreparationBytePorts] !== 'function')) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
}

export function createProjectImagePreparationWorkerCore(options: ProjectImagePreparationCoreOptions) {
  if (!options || typeof options.scratchRoot !== 'string' || !isAbsolute(options.scratchRoot) || options.scratchRoot.includes('\0') || /^[\\/]{2}/.test(options.scratchRoot) || process.platform === 'win32' && options.scratchRoot.slice(2).includes(':') || !uuid(options.scope?.companyId) || !Array.isArray(options.scope.projectIds) || !options.scope.projectIds.length || options.scope.projectIds.length > 32 || options.scope.projectIds.some(id => !uuid(id)) || new Set(options.scope.projectIds).size !== options.scope.projectIds.length) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
  if (typeof options.transform !== 'function') fail('IMAGE_PREPARATION_WORKER_UNAVAILABLE');
  if (typeof options.createPorts !== 'function') fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
  const rootPath = resolve(options.scratchRoot), scope = {companyId: options.scope.companyId, projectIds: [...options.scope.projectIds]}, transform = options.transform;
  const deadlineMs = options.deadlineMs ?? 120_000, interval = options.authorityIntervalMs ?? 1000;
  if (!positive(deadlineMs, 120_000) || !positive(interval, 5000)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
  let busy = false, poisoned = false;
  return {async runNext(input: {signal?: AbortSignal} = {}): Promise<ProjectImagePreparationWorkerResult> {
    if (busy || poisoned) return {processed: false, status: 'disabled', code: 'IMAGE_PREPARATION_WORKER_UNAVAILABLE'};
    busy = true;
    const controller = new AbortController();
    const stop = (code: Code) => { if (!controller.signal.aborted) controller.abort(new ProjectImagePreparationWorkerError(code)); };
    const current = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    const externalAbort = () => stop('PREPARATION_ABORTED');
    input.signal?.addEventListener('abort', externalAbort, {once: true}); if (input.signal?.aborted) externalAbort();
    const deadline = setTimeout(() => stop('PREPARATION_TIMEOUT'), deadlineMs);
    let lease: ProjectImagePreparationLease | null = null, scratch: string | undefined, root: string | undefined, file: FileHandle | undefined, ports: ProjectImagePreparationPorts | undefined;
    let rootIdentity: Stats | undefined, scratchIdentity: Stats | undefined, processorCleanupFailed = false, lastAuthorityCheck = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, cancellation: Promise<void> | undefined, cancellationFailed = false, externalIntent = false;
    let queue: Promise<unknown> = Promise.resolve(), checkPending: Promise<void> | undefined;
    // Serialize control operations and watchdog checks. Local adapters also call
    // assertCurrent inside their transaction before commit; remote services must
    // enforce current lease/authority and their deadline at the server commit.
    const context: ProjectImagePreparationOperationContext = {signal: controller.signal, assertCurrent: current};
    const atomic = <T>(run: () => Promise<T>, reconciliation = false): Promise<T> => { const pending = queue.then(async () => { if (!reconciliation) current(); const value = await run(); if (!reconciliation) current(); return value; }); queue = pending.catch(() => {}); return pending; };
    const authorize = async (force = true) => {
      current(); if (!force && Date.now() - lastAuthorityCheck < interval) return;
      try { if (lease) await atomic(() => ports!.control.authorize(lease!, context)); }
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
    const consume = async (object: ProjectImagePreparationByteRead, expected: {bytes: number; sha256: string; etag: string; contentType: string}, write?: FileHandle) => {
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
      if (ports) { try { ports.bytes.close(); } catch { failed = true; } try { await ports.bytes.drain(); } catch { failed = true; } }
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
      ports = options.createPorts() ?? undefined;
      if (!ports) return {processed: false, status: 'disabled', code: 'IMAGE_PREPARATION_WORKER_UNAVAILABLE'};
      assertPorts(ports);
      const rootInfo = await lstat(rootPath); root = await realpath(rootPath);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || pathKey(root) !== pathKey(rootPath)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      rootIdentity = rootInfo;
      lease = await atomic(() => ports!.control.claim(scope, context)); current();
      if (!lease) return {processed: false, status: 'idle'};
      lease = structuredClone(lease);
      if (lease.companyId !== scope.companyId || !scope.projectIds.includes(lease.projectId) || !uuid(lease.preparationId) || !uuid(lease.leaseId) || !uuid(lease.source.versionId) || !positive(lease.source.bytes, policy.sourceMaxBytes) || !sha(lease.source.sha256) || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now() || lease.recipeSha256 !== IMAGE_PREPARATION_RECIPE_HASH) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      await authorize();
      scratch = join(root, randomUUID()); await mkdir(scratch, {mode: 0o700});
      scratchIdentity = await lstat(scratch);
      if (!scratchIdentity.isDirectory() || scratchIdentity.isSymbolicLink() || pathKey(await realpath(scratch)) !== pathKey(scratch)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      const path = join(scratch, 'source'); file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
      const source = await atomic(() => ports!.control.source(lease!, context)); current();
      if (source.versionId !== lease.source.versionId || source.bytes !== lease.source.bytes || source.sha256 !== lease.source.sha256 || source.contentType !== lease.source.contentType || !etag(source.etag)) fail('PREPARATION_BYTES_CHANGED');
      // Capture an obtained body even if abort occurred while get() was pending.
      const object = await io(async () => { const result = await ports!.bytes.readSource(lease!, source, context); reader = result.stream.getReader(); cancellation = undefined; return result; });
      reader!.releaseLock(); reader = undefined;
      await consume(object, source, file); await file.sync();
      const original = await snapshotSource(), actualSource = inspectPreparationSource(original);
      if ('image/' + actualSource.format !== source.contentType) fail('PREPARATION_BYTES_CHANGED');
      await authorize(); externalIntent = true;
      const action = await atomic(() => ports!.control.beginTransform(lease!, context)); current();
      if (!uuid(action?.actionId)) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
      const transformed = await io(() => transform({path, expectedBytes: source.bytes, expectedSha256: source.sha256, signal: controller.signal}, {lease: structuredClone(lease!)}));
      await snapshotSource();
      const rotated = actualSource.orientation >= 5, size = preparationDimensions(rotated ? actualSource.height : actualSource.width, rotated ? actualSource.width : actualSource.height);
      if (!transformed || !Buffer.isBuffer(transformed.bytes) || transformed.bytes.length > policy.outputMaxBytes || transformed.recipeHash !== lease.recipeSha256 || !transformed.source || ['format', 'width', 'height', 'orientation'].some(key => transformed.source[key as keyof typeof transformed.source] !== actualSource[key as keyof typeof actualSource])) fail('PREPARATION_OUTPUT_INVALID');
      const bytes = validatePreparedPng(Buffer.from(transformed.bytes), size), hash = digest(bytes), output = transformed.output;
      if (!output || output.bytes !== bytes.length || output.sha256 !== hash || output.width !== size.width || output.height !== size.height || output.format !== 'png' || output.pixelFormat !== 'rgba8' || output.metadataRemoved !== true) fail('PREPARATION_OUTPUT_INVALID');
      await atomic(() => ports!.control.completeTransform(lease!, action.actionId, {operation: 'transform', sourceVersionId: source.versionId, sourceBytes: source.bytes, sourceSha256: source.sha256, source: actualSource, recipeSha256: lease!.recipeSha256, processor: lease!.processor, output: {...size, bytes: bytes.length, sha256: hash, format: 'png', pixelFormat: 'rgba8', metadataRemoved: true}}, context)); current();
      const reserved = await atomic(() => ports!.control.reserveOutput(lease!, context)); current();
      if (!uuid(reserved.versionId) || !uuid(reserved.fileId) || !uuid(reserved.uploadId) || reserved.versionId === source.versionId || reserved.fileId === lease.source.fileId || reserved.bytes !== bytes.length || reserved.sha256 !== hash || reserved.partBytes !== 64 * 1024 ** 2) fail('PREPARATION_OUTPUT_INVALID');
      const sameOutput = (value: typeof reserved) => { if (!value || ['fileId', 'versionId', 'uploadId', 'bytes', 'sha256', 'partBytes'].some(key => value[key as keyof typeof value] !== reserved[key as keyof typeof reserved])) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN'); };
      const beginStore = async (operation: ProjectImagePreparationStoreOperation) => {
        const intent = await atomic(() => ports!.control.beginStore(lease!, operation, context)); current();
        sameOutput(intent.output); if (!uuid(intent.actionId) || intent.operation !== operation) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
        return intent;
      };
      const completeStore = async (intent: ProjectImagePreparationStoreIntent, receipt: ProjectImagePreparationStoreReceipt) => {
        sameOutput(receipt.output);
        if (receipt.actionId !== intent.actionId || receipt.operation !== intent.operation || receipt.operation === 'part' && (receipt.partNumber !== 1 || receipt.bytes !== bytes.length || receipt.sha256 !== hash) || receipt.operation === 'complete' && !etag(receipt.etag)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
        await atomic(() => ports!.control.completeStore(lease!, receipt, context)); current();
      };
      const initiate = await beginStore('initiate');
      await completeStore(initiate, await io(() => ports!.bytes.initiate(lease!, initiate, context)));
      const part = await beginStore('part');
      await completeStore(part, await io(() => ports!.bytes.uploadPart(lease!, part, Buffer.from(bytes), context)));
      const finish = await beginStore('complete');
      const completed = await io(() => ports!.bytes.complete(lease!, finish, context));
      await completeStore(finish, completed);
      const stored = await io(async () => { const result = await ports!.bytes.readOutput(lease!, reserved, completed.etag, context); reader = result.stream.getReader(); cancellation = undefined; return result; });
      reader!.releaseLock(); reader = undefined;
      try { await consume(stored, {bytes: bytes.length, sha256: hash, etag: completed.etag, contentType: 'image/png'}); } catch (error) { if (error instanceof ProjectImagePreparationWorkerError && error.code === 'PREPARATION_BYTES_CHANGED') fail('IMAGE_PREPARATION_STORED_BYTES_CHANGED'); throw error; }
      await authorize();
      await cleanup(); current();
      clearInterval(watchdog); await checkPending; await authorize();
      const published = await atomic(() => ports!.control.publish(lease!, {bytes: bytes.length, sha256: hash, etag: completed.etag, cleanupConfirmed: true}, context));
      return {processed: true, preparationId: lease.preparationId, status: published.status};
    } catch (error) {
      if (error instanceof ImagePreparationError && error.code === 'PREPARATION_CLEANUP_FAILED') { processorCleanupFailed = true; poisoned = true; }
      let code: string = controller.signal.aborted ? (controller.signal.reason as ProjectImagePreparationWorkerError).code : error instanceof ProjectImagePreparationWorkerError || error instanceof ImagePreparationError ? error.code : externalIntent ? 'IMAGE_PREPARATION_STORAGE_UNCERTAIN' : 'IMAGE_PREPARATION_WORKER_FAILED';
      try { await cleanup(); } catch { code = 'PREPARATION_CLEANUP_FAILED'; poisoned = true; }
      clearInterval(watchdog); await checkPending;
      if (!lease) return {processed: false, status: 'disabled', code};
      try { const saved = await atomic(() => ports!.control.fail(lease!, code), true); return {processed: true, preparationId: lease.preparationId, status: saved.status, code}; }
      catch { poisoned = true; return {processed: true, preparationId: lease.preparationId, status: externalIntent ? 'uncertain' : 'failed', code}; }
    } finally {
      clearTimeout(deadline); clearInterval(watchdog); input.signal?.removeEventListener('abort', externalAbort); controller.signal.removeEventListener('abort', abortRead); busy = false;
    }
  }};
}
