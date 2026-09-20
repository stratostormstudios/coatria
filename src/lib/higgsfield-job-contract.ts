import {createHash} from 'node:crypto';
import {isIP} from 'node:net';

/** Declared installed connector schema, not proof that a company's MCP profile
 * emits this format. Unknown company responses must remain unresolved. */
export const HIGGSFIELD_JOB_CONTRACT = 'higgsfield-openai-profile-2026-09-20' as const;
export type HiggsfieldJobKind = 'image' | 'video' | 'audio';
export type HiggsfieldJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'lookup_failed';
export type HiggsfieldContractCode = 'HIGGSFIELD_UNSUPPORTED_SHAPE' | 'HIGGSFIELD_TOOL_ERROR' |
  'HIGGSFIELD_REQUEST_REJECTED' | 'HIGGSFIELD_CHOICE_REQUIRED' | 'HIGGSFIELD_AMBIGUOUS_RESPONSE' |
  'HIGGSFIELD_JOB_SET_MISMATCH' | 'HIGGSFIELD_INVALID_JOB' | 'HIGGSFIELD_UNKNOWN_STATUS' |
  'HIGGSFIELD_OUTPUT_UNAVAILABLE' | 'HIGGSFIELD_INVALID_LOCATOR' | 'HIGGSFIELD_JOB_FAILED' |
  'HIGGSFIELD_CONTENT_FILTERED' | 'HIGGSFIELD_IP_FILTERED' | 'HIGGSFIELD_JOB_CANCELLED' |
  'HIGGSFIELD_LOOKUP_RETRYABLE' | 'HIGGSFIELD_LOOKUP_UNRESOLVABLE';
export type NormalizedHiggsfieldOutput = {
  ordinal: number; kind: HiggsfieldJobKind;
  /** Private transport value. May contain a signed query: encrypt before storage,
   * never log or include in public DTOs, and never fetch without separate host review. */
  locator: string;
  /** Coatria-derived locator identity, NOT a provider media ID or content hash. */
  identity: string;
};
export type NormalizedHiggsfieldJob = {
  providerJobId: string; status: HiggsfieldJobStatus; providerStatus: string;
  // jobs_wait permits omitted type/model, notably for lookup failures.
  kind?: HiggsfieldJobKind; model?: string; outputs: NormalizedHiggsfieldOutput[] | null;
  retryable?: boolean; diagnosticCode?: HiggsfieldContractCode;
};
export type NormalizedHiggsfieldResult = {
  contract: typeof HIGGSFIELD_JOB_CONTRACT; supported: boolean;
  outcome: 'jobs' | 'choice' | 'rejected' | 'unsupported';
  jobs: NormalizedHiggsfieldJob[]; code?: HiggsfieldContractCode;
  allTerminal?: boolean; pollAfterSeconds?: number;
};

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v: Obj, key: string) => Object.prototype.hasOwnProperty.call(v, key);
const safeText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\s\u0000-\u001f\u007f]/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const kind = (v: unknown): v is HiggsfieldJobKind => v === 'image' || v === 'video' || v === 'audio';
const statusMap: Record<string, HiggsfieldJobStatus> = {
  pending: 'queued', waiting: 'queued', queued: 'queued', dna: 'running', script: 'running',
  visuals: 'running', vision: 'running', flow: 'running', in_progress: 'running', ip_detect: 'running',
  completed: 'completed', canceled: 'cancelled', failed: 'failed', nsfw: 'failed', ip_detected: 'failed',
  lookup_failed: 'lookup_failed',
};
const diagnosticMap: Record<string, HiggsfieldContractCode> = {
  failed: 'HIGGSFIELD_JOB_FAILED', nsfw: 'HIGGSFIELD_CONTENT_FILTERED',
  ip_detected: 'HIGGSFIELD_IP_FILTERED', canceled: 'HIGGSFIELD_JOB_CANCELLED',
};
function result(outcome: NormalizedHiggsfieldResult['outcome'], code?: HiggsfieldContractCode, jobs: NormalizedHiggsfieldJob[] = []): NormalizedHiggsfieldResult {
  return {contract: HIGGSFIELD_JOB_CONTRACT, supported: outcome !== 'unsupported', outcome, jobs, ...(code ? {code} : {})};
}
const unsupported = (code: HiggsfieldContractCode = 'HIGGSFIELD_UNSUPPORTED_SHAPE', jobs: NormalizedHiggsfieldJob[] = []) => result('unsupported', code, jobs);

/** Only structuredContent (or a supplied structured object) is interpreted.
 * Text blocks are never JSON-decoded or searched for IDs/URLs. */
function payload(value: unknown): {body?: Obj; failure?: NormalizedHiggsfieldResult} {
  if (!object(value)) return {failure: unsupported()};
  const wrapped = own(value, 'content') || own(value, 'structuredContent') || own(value, 'isError');
  if (own(value, 'isError') && typeof value.isError !== 'boolean') return {failure: unsupported()};
  const body = wrapped ? value.structuredContent : value;
  if (value.isError === true) {
    const ambiguous = object(body) && (own(body, 'results') || own(body, 'jobs') || own(body, 'job_ids'));
    return {failure: ambiguous ? unsupported('HIGGSFIELD_AMBIGUOUS_RESPONSE') : result('rejected', 'HIGGSFIELD_TOOL_ERROR')};
  }
  return object(body) ? {body} : {failure: unsupported()};
}

function output(locator: unknown, jobId: string, mediaKind: HiggsfieldJobKind): NormalizedHiggsfieldOutput | null {
  // This is syntax screening only. It makes no DNS, host ownership, content or
  // retrieval-safety claim. Signed queries remain private, out of the identity.
  if (!safeText(locator, 8192) || locator.includes('\\')) return null;
  try {
    const url = new URL(locator), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
      isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.') ||
      /(^|\.)(localhost|local|localdomain|internal)$/.test(host) || host === 'home.arpa' || host.endsWith('.home.arpa')) return null;
    const ordinal = 0;
    const identity = createHash('sha256').update(JSON.stringify([jobId, mediaKind, ordinal, url.origin, url.pathname])).digest('hex');
    return {ordinal, kind: mediaKind, locator: url.href, identity};
  } catch {return null;}
}

type ParsedJob = {job?: NormalizedHiggsfieldJob; code?: HiggsfieldContractCode};
function parseJob(value: unknown, poll: boolean, expectedKind?: HiggsfieldJobKind): ParsedJob {
  if (!object(value)) return {code: 'HIGGSFIELD_INVALID_JOB'};
  const id = poll ? value.job_id : value.id;
  if (!uuid(id)) return {code: 'HIGGSFIELD_INVALID_JOB'};
  if (typeof value.status !== 'string' || !own(statusMap, value.status) || (!poll && value.status === 'lookup_failed')) return {code: 'HIGGSFIELD_UNKNOWN_STATUS'};
  if ((!poll && !kind(value.type)) || (own(value, 'type') && !kind(value.type)) || (expectedKind && value.type !== expectedKind)) return {code: 'HIGGSFIELD_INVALID_JOB'};
  if ((!poll && !safeText(value.model, 160)) || (own(value, 'model') && !safeText(value.model, 160))) return {code: 'HIGGSFIELD_INVALID_JOB'};
  if (!poll && (!object(value.params) || typeof value.params.prompt !== 'string')) return {code: 'HIGGSFIELD_INVALID_JOB'};
  if (poll && own(value, 'error') && typeof value.error !== 'string') return {code: 'HIGGSFIELD_INVALID_JOB'};
  const job: NormalizedHiggsfieldJob = {providerJobId: id.toLowerCase(), status: statusMap[value.status], providerStatus: value.status, outputs: null};
  if (kind(value.type)) job.kind = value.type;
  if (typeof value.model === 'string') job.model = value.model;
  if (diagnosticMap[value.status]) job.diagnosticCode = diagnosticMap[value.status];
  if (value.status === 'lookup_failed') {
    if (typeof value.retryable !== 'boolean') return {code: 'HIGGSFIELD_INVALID_JOB'};
    job.retryable = value.retryable;
    job.diagnosticCode = value.retryable ? 'HIGGSFIELD_LOOKUP_RETRYABLE' : 'HIGGSFIELD_LOOKUP_UNRESOLVABLE';
  } else if (own(value, 'retryable')) return {code: 'HIGGSFIELD_INVALID_JOB'};
  if (!poll && own(value, 'results') && !object(value.results)) return {code: 'HIGGSFIELD_INVALID_JOB'};
  const locator = poll ? value.result_url : object(value.results) ? value.results.rawUrl : undefined;
  if (value.status !== 'completed') {
    if (locator !== undefined) return {code: 'HIGGSFIELD_AMBIGUOUS_RESPONSE'};
    return {job};
  }
  if (!job.kind || locator === undefined || locator === '') return {job, code: 'HIGGSFIELD_OUTPUT_UNAVAILABLE'};
  const parsed = output(locator, job.providerJobId, job.kind);
  if (!parsed) return {job, code: 'HIGGSFIELD_INVALID_LOCATOR'};
  job.outputs = [parsed];
  return {job};
}

/** Supports the declared single generate_image/video/audio results[] shape.
 * Batch/preset/job-set envelopes need separate adapters; no recursive ID search. */
export function normalizeHiggsfieldSubmission(value: unknown, expectedKind: HiggsfieldJobKind): NormalizedHiggsfieldResult {
  if (!kind(expectedKind)) return unsupported();
  const decoded = payload(value); if (decoded.failure) return decoded.failure;
  const body = decoded.body!;
  if (own(body, 'error') || own(body, 'unlim_choice')) {
    if (own(body, 'results') || (own(body, 'error') && own(body, 'unlim_choice'))) return unsupported('HIGGSFIELD_AMBIGUOUS_RESPONSE');
    if (own(body, 'error')) return typeof body.error === 'string' && body.error.length > 0 ? result('rejected', 'HIGGSFIELD_REQUEST_REJECTED') : unsupported();
    const choice = body.unlim_choice;
    return object(choice) && typeof choice.message === 'string' && safeText(choice.model, 160)
      ? result('choice', 'HIGGSFIELD_CHOICE_REQUIRED') : unsupported();
  }
  if (!Array.isArray(body.results) || body.results.length < 1 || body.results.length > (expectedKind === 'audio' ? 1 : 4)) return unsupported();
  const jobs: NormalizedHiggsfieldJob[] = [], seen = new Set<string>(); let issue: HiggsfieldContractCode | undefined;
  for (const entry of body.results) {
    const parsed = parseJob(entry, false, expectedKind);
    if (!parsed.job) return unsupported(parsed.code);
    if (seen.has(parsed.job.providerJobId)) return unsupported('HIGGSFIELD_JOB_SET_MISMATCH');
    seen.add(parsed.job.providerJobId); jobs.push(parsed.job); issue ??= parsed.code;
  }
  return issue ? unsupported(issue, jobs) : result('jobs', undefined, jobs);
}

/** Validates the exact requested set, independently of provider summaries.
 * allTerminal is derived; timed_out/aborted never turn an active job into failure. */
export function normalizeHiggsfieldPoll(value: unknown, expectedJobIds: readonly string[]): NormalizedHiggsfieldResult {
  if (!Array.isArray(expectedJobIds) || expectedJobIds.length < 1 || expectedJobIds.length > 8 || !expectedJobIds.every(uuid)) return unsupported('HIGGSFIELD_JOB_SET_MISMATCH');
  const expected = new Set(expectedJobIds.map(id => id.toLowerCase()));
  if (expected.size !== expectedJobIds.length) return unsupported('HIGGSFIELD_JOB_SET_MISMATCH');
  const decoded = payload(value); if (decoded.failure) return decoded.failure;
  const body = decoded.body!;
  if (own(body, 'error') || own(body, 'unlim_choice')) return unsupported('HIGGSFIELD_AMBIGUOUS_RESPONSE');
  if (!Array.isArray(body.jobs) || body.jobs.length !== expected.size || typeof body.all_terminal !== 'boolean' || !object(body.summary)) return unsupported();
  if (!['active', 'completed', 'errors', 'failed', 'total'].every(key => Number.isSafeInteger(body.summary && (body.summary as Obj)[key]) && Number((body.summary as Obj)[key]) >= 0) || body.summary.total !== expected.size) return unsupported();
  if (['timed_out', 'aborted'].some(key => own(body, key) && typeof body[key] !== 'boolean')) return unsupported();
  const jobs: NormalizedHiggsfieldJob[] = [], seen = new Set<string>(), indexes = new Set<number>(); let issue: HiggsfieldContractCode | undefined;
  for (const entry of body.jobs) {
    if (!object(entry) || typeof entry.index !== 'number' || !Number.isSafeInteger(entry.index) || indexes.has(entry.index)) return unsupported('HIGGSFIELD_JOB_SET_MISMATCH');
    indexes.add(entry.index);
    const parsed = parseJob(entry, true);
    if (!parsed.job) return unsupported(parsed.code);
    if (!expected.has(parsed.job.providerJobId) || seen.has(parsed.job.providerJobId)) return unsupported('HIGGSFIELD_JOB_SET_MISMATCH');
    seen.add(parsed.job.providerJobId); jobs.push(parsed.job); issue ??= parsed.code;
  }
  const allTerminal = jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.status) || (job.status === 'lookup_failed' && job.retryable === false));
  if (body.all_terminal !== allTerminal) return unsupported('HIGGSFIELD_AMBIGUOUS_RESPONSE');
  if (own(body, 'poll_after_seconds') && (typeof body.poll_after_seconds !== 'number' || !Number.isFinite(body.poll_after_seconds) || body.poll_after_seconds < 0 || body.poll_after_seconds > 3600)) return unsupported();
  const normalized = issue ? unsupported(issue, jobs) : result('jobs', undefined, jobs);
  return {...normalized, allTerminal, ...(typeof body.poll_after_seconds === 'number' ? {pollAfterSeconds: body.poll_after_seconds} : {})};
}

export type HiggsfieldPollArguments = {jobs: {index: number; job_id: string}[]; timeout_seconds?: number};
const schemaAnnotations = ['title', 'description', 'default', 'examples', 'deprecated', '$comment', '$schema', '$id'];
function schemaKeys(schema: Obj, supported: string[]): boolean {
  return Object.keys(schema).every(key => schemaAnnotations.includes(key) || supported.includes(key));
}
function objectSchema(schema: unknown): schema is Obj & {properties: Obj; required: string[]} {
  return object(schema) && schema.type === 'object' && object(schema.properties) && Array.isArray(schema.required) &&
    schema.required.every(key => typeof key === 'string' && own(schema.properties as Obj, key)) &&
    new Set(schema.required).size === schema.required.length &&
    (!own(schema, 'additionalProperties') || typeof schema.additionalProperties === 'boolean') &&
    schemaKeys(schema, ['type', 'properties', 'required', 'additionalProperties']);
}
function numberSchemaAccepts(schema: unknown, value: number): boolean {
  if (!object(schema) || !['number', 'integer'].includes(String(schema.type)) ||
      !schemaKeys(schema, ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])) return false;
  for (const field of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (own(schema, field) && (typeof schema[field] !== 'number' || !Number.isFinite(schema[field]))) return false;
  }
  return (!own(schema, 'minimum') || value >= Number(schema.minimum)) &&
    (!own(schema, 'maximum') || value <= Number(schema.maximum)) &&
    (!own(schema, 'exclusiveMinimum') || value > Number(schema.exclusiveMinimum)) &&
    (!own(schema, 'exclusiveMaximum') || value < Number(schema.exclusiveMaximum)) &&
    (!own(schema, 'multipleOf') || (Number(schema.multipleOf) > 0 && Number.isInteger(value / Number(schema.multipleOf))));
}
// Exact UUID constraint observed in the company jobs_wait catalog. Compare the
// schema literal only: never compile/evaluate an arbitrary provider expression.
const companyUuidPattern = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
function idSchema(schema: unknown): boolean {
  if (!object(schema) || schema.type !== 'string' || !schemaKeys(schema, ['type', 'format', 'pattern', 'minLength', 'maxLength']) ||
      (own(schema, 'format') && schema.format !== 'uuid') || (own(schema, 'pattern') && schema.pattern !== companyUuidPattern)) return false;
  return (!own(schema, 'minLength') || (Number.isSafeInteger(schema.minLength) && Number(schema.minLength) >= 0 && Number(schema.minLength) <= 36)) &&
    (!own(schema, 'maxLength') || (Number.isSafeInteger(schema.maxLength) && Number(schema.maxLength) >= 36));
}

/** Builds only the declared indexed jobs_wait wire form from an actually
 * advertised compatible input schema. No schema/description guessing, refs,
 * unions, arbitrary patterns or unknown required properties are supported.
 * The 0-second snapshot avoids holding a worker through a provider long poll. */
export function buildHiggsfieldPollArguments(inputSchema: unknown, providerJobIds: readonly string[]): HiggsfieldPollArguments | null {
  if (!Array.isArray(providerJobIds) || providerJobIds.length < 1 || providerJobIds.length > 8 || !providerJobIds.every(uuid) ||
      new Set(providerJobIds.map(id => id.toLowerCase())).size !== providerJobIds.length || !objectSchema(inputSchema) ||
      !inputSchema.required.includes('jobs') || inputSchema.required.some(key => !['jobs', 'timeout_seconds'].includes(key))) return null;
  const jobsSchema = inputSchema.properties.jobs;
  if (!object(jobsSchema) || jobsSchema.type !== 'array' || !schemaKeys(jobsSchema, ['type', 'items', 'minItems', 'maxItems', 'uniqueItems']) ||
      (own(jobsSchema, 'uniqueItems') && typeof jobsSchema.uniqueItems !== 'boolean') ||
      (own(jobsSchema, 'minItems') && (!Number.isSafeInteger(jobsSchema.minItems) || Number(jobsSchema.minItems) < 0 || Number(jobsSchema.minItems) > providerJobIds.length)) ||
      (own(jobsSchema, 'maxItems') && (!Number.isSafeInteger(jobsSchema.maxItems) || Number(jobsSchema.maxItems) < providerJobIds.length))) return null;
  const item = jobsSchema.items;
  if (!objectSchema(item) || !item.required.includes('index') || !item.required.includes('job_id') ||
      item.required.some(key => !['index', 'job_id'].includes(key)) || !idSchema(item.properties.job_id) ||
      !providerJobIds.every((_id, index) => numberSchemaAccepts(item.properties.index, index))) return null;
  const args: HiggsfieldPollArguments = {jobs: providerJobIds.map((job_id, index) => ({index, job_id: job_id.toLowerCase()}))};
  if (own(inputSchema.properties, 'timeout_seconds')) {
    if (!numberSchemaAccepts(inputSchema.properties.timeout_seconds, 0)) return null;
    args.timeout_seconds = 0;
  }
  return args;
}
