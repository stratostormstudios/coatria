/** Direct database/Runpod composition retained for trusted local supervisors.
 * Credential-free hosts import worker-core instead; no SQL-over-RPC exists. */
import type {PoolClient} from 'pg';
import {transaction as defaultTransaction} from './db';
import {IMAGE_PREPARATION_POLICY as policy} from './higgsfield-image-preparation-policy';
import {authorizeProjectImagePreparation, beginProjectImagePreparationPhase, claimProjectImagePreparation, completeProjectImagePreparationPhase, failProjectImagePreparation, type ProjectImagePreparationOptions} from './project-image-preparations';
import {readProjectImagePreparationSource, reserveProjectImagePreparationOutput, beginProjectImagePreparationStore, completeProjectImagePreparationStore, publishProjectImagePreparation} from './project-image-preparation-storage';
import {createRunpodProjectStorage, type RunpodProjectStorage, type RunpodProjectStorageConfig} from './project-storage-runpod';
import {createProjectImagePreparationWorkerCore, ProjectImagePreparationWorkerError, type ProjectImagePreparationCoreOptions, type ProjectImagePreparationPorts, type ProjectImagePreparationOperationContext, type ProjectImagePreparationStoreIntent, type ProjectImagePreparationStoreReceipt} from './project-image-preparation-worker-core';
import type {ProjectImagePreparationLease} from './project-image-preparations-protocol';
export {ProjectImagePreparationWorkerError} from './project-image-preparation-worker-core';
export type {ProjectImagePreparationWorkerResult} from './project-image-preparation-worker-core';
type Transaction = <T>(run: (db: PoolClient) => Promise<T>) => Promise<T>;
export type ProjectImagePreparationProvider = RunpodProjectStorage & {drain(): Promise<void>};
export type ProjectImagePreparationWorkerOptions = Omit<ProjectImagePreparationCoreOptions, 'createPorts'> & {
 runtime?: ProjectImagePreparationOptions['runtime']; transaction?: Transaction;
 providerFactory?: (config: RunpodProjectStorageConfig) => ProjectImagePreparationProvider;
};
function fail(code: ConstructorParameters<typeof ProjectImagePreparationWorkerError>[0]): never {throw new ProjectImagePreparationWorkerError(code);}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const etag = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const uploadId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
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


/** This factory's per-attempt closure owns all credentials and provider handles.
 * The core receives only explicit safe projections and action-bound receipts. */
export function createProjectImagePreparationLocalPorts(options: ProjectImagePreparationWorkerOptions): ProjectImagePreparationPorts | null {
 if (!options.runtime) return null;
 const transaction = options.transaction ?? defaultTransaction, runtime = {runtime: options.runtime};
 const factory = options.providerFactory ?? defaultProvider;
 let provider: ProjectImagePreparationProvider | undefined, source: Awaited<ReturnType<typeof readProjectImagePreparationSource>> | undefined, boundLease: string | undefined;
 type PrivateIntent = {lease: string; public: ProjectImagePreparationStoreIntent; stored: Awaited<ReturnType<typeof beginProjectImagePreparationStore>>; invoked: boolean; completed: boolean; receipt?: ProjectImagePreparationStoreReceipt; result?: Parameters<typeof completeProjectImagePreparationStore>[3]};
 const intents = new Map<string, PrivateIntent>();
 const leaseKey = (lease: ProjectImagePreparationLease) => JSON.stringify([lease.companyId,lease.projectId,lease.preparationId,lease.leaseId,lease.requestHash]);
 const commit = <T>(context: ProjectImagePreparationOperationContext, run: (db: PoolClient) => Promise<T>) => transaction(async db => {context.assertCurrent();const value = await run(db);context.assertCurrent();return value;});
 const selected = (lease: ProjectImagePreparationLease) => {if (!provider || boundLease !== leaseKey(lease)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');return provider;};
 const intentFor = (lease: ProjectImagePreparationLease, intent: ProjectImagePreparationStoreIntent, operation: ProjectImagePreparationStoreIntent['operation']) => {
  const value = intents.get(intent.actionId);
  if (!value || value.lease !== leaseKey(lease) || value.public.operation !== operation || JSON.stringify(value.public) !== JSON.stringify(intent) || value.invoked || value.completed) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
  value.invoked = true;return value;
 };
 const multipart = (adapter: ProjectImagePreparationProvider, value: unknown, output: ProjectImagePreparationStoreIntent['output']) => {
  const checked = adapter.validateMultipart(value);
  if (checked.versionId !== output.versionId || checked.bytes !== output.bytes || checked.partBytes !== output.partBytes || !sha(checked.scope) || !uploadId(checked.uploadId)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');return checked;
 };
 const save = <T extends ProjectImagePreparationStoreReceipt>(value: PrivateIntent, receipt: T, result: NonNullable<PrivateIntent['result']>): T => {value.receipt = structuredClone(receipt);value.result = result;return structuredClone(receipt);};
 return {
  control: {
   claim: (scope, context) => commit(context, db => claimProjectImagePreparation(db, {...scope, projectIds: [...scope.projectIds]}, runtime)),
   async authorize(lease, context) {await commit(context, db => authorizeProjectImagePreparation(db, lease, runtime));},
   async source(lease, context) {
    if (source || provider) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    const value = await commit(context, db => readProjectImagePreparationSource(db, lease, runtime));
    if (value.config.companyId !== lease.companyId || value.config.projectId !== lease.projectId) fail('PREPARATION_BYTES_CHANGED');
    source = value;boundLease = leaseKey(lease);
    provider = factory({...value.config, partBytes: 64*1024**2, maxObjectBytes: policy.sourceMaxBytes, timeoutMs: Math.min(30_000, options.deadlineMs ?? 120_000)});
    if (!provider || typeof provider.drain !== 'function') fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
    return {versionId: value.versionId, bytes: value.bytes, sha256: value.sha256, etag: value.etag, contentType: value.contentType};
   },
   beginTransform: (lease, context) => commit(context, db => beginProjectImagePreparationPhase(db, lease, 'transform', runtime)),
   async completeTransform(lease, actionId, result, context) {await commit(context, db => completeProjectImagePreparationPhase(db, lease, actionId, result, runtime));},
   reserveOutput: (lease, context) => commit(context, db => reserveProjectImagePreparationOutput(db, lease, runtime)),
   async beginStore(lease, operation, context) {
    const stored = await commit(context, db => beginProjectImagePreparationStore(db, lease, operation, runtime));
    const publicIntent = {actionId: stored.actionId, operation, output: {...stored.output}};
    if (intents.has(stored.actionId)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    if (operation === 'initiate' ? stored.descriptor || stored.parts.length : !stored.descriptor || stored.parts.length !== (operation === 'complete' ? 1 : 0)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    intents.set(stored.actionId, {lease: leaseKey(lease), public: structuredClone(publicIntent), stored, invoked: false, completed: false});return publicIntent;
   },
   async completeStore(lease, receipt, context) {
    const value = intents.get(receipt.actionId);
    if (!value || value.lease !== leaseKey(lease) || !value.invoked || value.completed || !value.result || !value.receipt || JSON.stringify(value.receipt) !== JSON.stringify(receipt)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    await commit(context, db => completeProjectImagePreparationStore(db, lease, receipt.actionId, value.result, runtime));value.completed = true;
   },
   async publish(lease, result, context) {const saved = await commit(context, db => publishProjectImagePreparation(db, lease, result, runtime));return {status: saved.preparation.status};},
   async fail(lease, code) {const saved = await transaction(db => failProjectImagePreparation(db, lease, code));return {status: saved.preparation.status};},
  },
  bytes: {
   async readSource(lease, value, context) {
    const adapter = selected(lease);
    if (!source || ['versionId','bytes','sha256','etag','contentType'].some(key => value[key as keyof typeof value] !== source![key as keyof typeof value])) fail('PREPARATION_BYTES_CHANGED');
    return adapter.get({versionId: value.versionId, ifMatch: value.etag, maxBytes: value.bytes, signal: context.signal});
   },
   async initiate(lease, intent, context) {
    const adapter = selected(lease), value = intentFor(lease, intent, 'initiate');
    const descriptor = multipart(adapter, await adapter.createMultipart({versionId: intent.output.versionId, bytes: intent.output.bytes, contentType: 'image/png', signal: context.signal}), intent.output);
    return save(value, {...intent, operation: 'initiate'}, {operation: 'initiate', descriptor});
   },
   async uploadPart(lease, intent, bytes, context) {
    const adapter = selected(lease), value = intentFor(lease, intent, 'part'), upload = multipart(adapter, value.stored.descriptor, intent.output);
    const part = await adapter.uploadPart({upload, partNumber: 1, body: bytes, signal: context.signal});
    if (part.partNumber !== 1 || part.bytes !== intent.output.bytes || !etag(part.etag)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    return save(value, {...intent, operation: 'part', partNumber: 1, bytes: part.bytes, sha256: intent.output.sha256}, {operation: 'part', part, sha256: intent.output.sha256});
   },
   async complete(lease, intent, context) {
    const adapter = selected(lease), value = intentFor(lease, intent, 'complete'), upload = multipart(adapter, value.stored.descriptor, intent.output), parts = value.stored.parts;
    const prior = [...intents.values()].find(item => item.public.operation === 'part' && item.completed && item.lease === leaseKey(lease));
    const actual = prior?.result as {operation?: string; part?: {etag: string}} | undefined;
    if (!actual?.part || parts.length !== 1 || parts[0].partNumber !== 1 || parts[0].bytes !== intent.output.bytes || parts[0].etag !== actual.part.etag) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    const completed = await adapter.completeMultipart({upload, parts, signal: context.signal});
    if (completed.versionId !== intent.output.versionId || !etag(completed.etag)) fail('IMAGE_PREPARATION_STORAGE_UNCERTAIN');
    return save(value, {...intent, operation: 'complete', etag: completed.etag}, {operation: 'complete', versionId: completed.versionId, etag: completed.etag});
   },
   readOutput: (lease, output, etag, context) => selected(lease).get({versionId: output.versionId, ifMatch: etag, maxBytes: output.bytes, signal: context.signal}),
   close() {provider?.close();},
   async drain() {await provider?.drain();},
  },
 };
}
export function createProjectImagePreparationWorker(options: ProjectImagePreparationWorkerOptions) {
 if (!options) fail('IMAGE_PREPARATION_WORKER_POLICY_INVALID');
 const {scope, scratchRoot, transform, deadlineMs, authorityIntervalMs} = options;
 return createProjectImagePreparationWorkerCore({scope, scratchRoot, transform, deadlineMs, authorityIntervalMs, createPorts: () => createProjectImagePreparationLocalPorts(options)});
}
