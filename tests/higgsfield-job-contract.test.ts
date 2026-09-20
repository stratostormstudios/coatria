import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeHiggsfieldSubmission as submission, normalizeHiggsfieldPoll as poll,
  HIGGSFIELD_JOB_CONTRACT, buildHiggsfieldPollArguments as pollArguments, type HiggsfieldJobKind} from '../src/lib/higgsfield-job-contract';

// Synthetic schema fixtures only: these IDs and locators are not live provider evidence.
const id1 = '11111111-1111-4111-8111-111111111111', id2 = '22222222-2222-4222-8222-222222222222';
const url = 'https://media.higgsfield.example/outputs/synthetic.png';
const envelope = (structuredContent: unknown) => ({content: [{type: 'text', text: 'untrusted provider prose'}], structuredContent});
const job = (type: HiggsfieldJobKind = 'image', patch: Record<string, unknown> = {}) => ({id: id1, type, model: 'synthetic_model', params: {prompt: 'synthetic test prompt'}, status: 'queued', ...patch});
const status = (patch: Record<string, unknown> = {}) => ({index: 0, job_id: id1, type: 'image', model: 'synthetic_model', status: 'queued', ...patch});
const waited = (jobs: unknown[], all_terminal = false, patch: Record<string, unknown> = {}) => envelope({jobs, all_terminal, summary: {active: all_terminal ? 0 : jobs.length, completed: all_terminal ? jobs.length : 0, failed: 0, errors: 0, total: jobs.length}, ...patch});

test('declared image/video/audio submissions preserve exact job identity with no fabricated output', () => {
  for (const type of ['image', 'video', 'audio'] as const) {
    const normalized = submission(envelope({results: [job(type)]}), type);
    assert.equal(normalized.contract, HIGGSFIELD_JOB_CONTRACT);
    assert.equal(normalized.supported, true); assert.equal(normalized.outcome, 'jobs');
    assert.deepEqual(normalized.jobs, [{providerJobId: id1, status: 'queued', providerStatus: 'queued', kind: type, model: 'synthetic_model', outputs: null}]);
  }
});

test('single submissions support returned multiple image/video jobs, but not batch or job-set formats', () => {
  assert.equal(submission({results: [job(), job('image', {id: id2})]}, 'image').jobs.length, 2);
  for (const body of [{job_id: id1}, {id: id1, jobs: [job()]}, {jobs: [{index: 0, job_id: id1, status: 'queued'}]}, {job_ids: [id1]}, {results: []}]) {
    assert.equal(submission(envelope(body), 'image').outcome, 'unsupported');
  }
  assert.equal(submission({results: [job('audio'), job('audio', {id: id2})]}, 'audio').supported, false);
});

test('completed raw locators use the same identity across submission and poll; signed query refresh is not a new output', () => {
  for (const type of ['image', 'video', 'audio'] as const) {
    const initial = submission(envelope({results: [job(type, {status: 'completed', results: {rawUrl: url + '?signature=private-one', minUrl: 'https://different.example/preview'}})]}), type);
    const refreshed = poll(waited([status({type, status: 'completed', result_url: url + '?signature=private-two', thumbnail_url: 'https://different.example/thumb'})], true), [id1]);
    assert.equal(initial.outcome, 'jobs'); assert.equal(refreshed.outcome, 'jobs');
    assert.equal(initial.jobs[0].outputs![0].identity, refreshed.jobs[0].outputs![0].identity);
    assert.match(initial.jobs[0].outputs![0].identity, /^[0-9a-f]{64}$/);
    assert.equal(initial.jobs[0].outputs!.length, 1);
    assert.equal(initial.jobs[0].outputs![0].ordinal, 0);
    assert.equal(initial.jobs[0].outputs![0].locator, url + '?signature=private-one');
    const changed = submission({results: [job(type, {status: 'completed', results: {rawUrl: url + '.new'}})]}, type);
    assert.notEqual(initial.jobs[0].outputs![0].identity, changed.jobs[0].outputs![0].identity);
  }
});

test('content and external metadata never become job IDs or outputs', () => {
  for (const body of [
    {content: [{type: 'text', text: JSON.stringify({results: [job('image', {status: 'completed', results: {rawUrl: url}})]})}]},
    {content: [{type: 'resource_link', uri: url}], _meta: {job_id: id1}},
    {content: [], structuredContent: 'not an object'},
    {content: [], results: [job()]},
  ]) assert.equal(submission(body, 'image').outcome, 'unsupported');
});

test('choices, rejection and MCP errors remain bounded diagnostics without reflecting provider prose', () => {
  const secret = 'private prompt and token=never-reflect';
  const cases = [
    [envelope({unlim_choice: {model: 'synthetic_model', message: secret, remaining: null}}), 'choice', 'HIGGSFIELD_CHOICE_REQUIRED'],
    [envelope({error: secret}), 'rejected', 'HIGGSFIELD_REQUEST_REJECTED'],
    [{content: [{type: 'text', text: secret}], isError: true}, 'rejected', 'HIGGSFIELD_TOOL_ERROR'],
  ] as const;
  for (const [input, outcome, code] of cases) {
    const normalized = submission(input, 'image');
    assert.equal(normalized.outcome, outcome); assert.equal(normalized.code, code);
    assert.equal(JSON.stringify(normalized).includes(secret), false);
  }
  for (const input of [
    envelope({error: secret, results: [job()]}), envelope({unlim_choice: {model: 'x', message: secret}, results: [job()]}),
    {...envelope({results: [job()]}), isError: true}, envelope({error: secret, unlim_choice: {model: 'x', message: secret}}),
  ]) assert.equal(submission(input, 'image').code, 'HIGGSFIELD_AMBIGUOUS_RESPONSE');
});

test('known provider phases map without confusing provider completion with deliverable availability', () => {
  for (const providerStatus of ['pending', 'waiting', 'queued']) assert.equal(submission({results: [job('image', {status: providerStatus})]}, 'image').jobs[0].status, 'queued');
  for (const providerStatus of ['dna', 'script', 'visuals', 'vision', 'flow', 'in_progress', 'ip_detect']) assert.equal(submission({results: [job('image', {status: providerStatus})]}, 'image').jobs[0].status, 'running');
  for (const providerStatus of ['failed', 'nsfw', 'ip_detected', 'canceled']) {
    const normalized = submission({results: [job('image', {status: providerStatus})]}, 'image');
    assert.equal(normalized.jobs[0].status, providerStatus === 'canceled' ? 'cancelled' : 'failed');
    assert(normalized.jobs[0].diagnosticCode); assert.equal(normalized.jobs[0].outputs, null);
  }
  for (const results of [undefined, {}, {thumbnailUrl: url}, {minUrl: url}, {rawUrl: ''}]) {
    const entry = job('image', {status: 'completed'}); if (results !== undefined) Object.assign(entry, {results});
    const normalized = submission({results: [entry]}, 'image');
    assert.equal(normalized.outcome, 'unsupported'); assert.equal(normalized.code, 'HIGGSFIELD_OUTPUT_UNAVAILABLE');
    assert.equal(normalized.jobs[0].providerJobId, id1); assert.equal(normalized.jobs[0].outputs, null);
  }
});

test('poll timeout and permanent/transient lookup failures preserve exact semantics', () => {
  const active = poll(waited([status()], false, {timed_out: true, aborted: true, poll_after_seconds: 2}), [id1]);
  assert.equal(active.outcome, 'jobs'); assert.equal(active.allTerminal, false); assert.equal(active.pollAfterSeconds, 2);
  for (const retryable of [true, false]) {
    const lookup = poll(waited([{index: 9, job_id: id1, status: 'lookup_failed', retryable, error: 'sensitive provider error'}], !retryable), [id1]);
    assert.equal(lookup.supported, true); assert.equal(lookup.allTerminal, !retryable);
    assert.equal(lookup.jobs[0].retryable, retryable); assert.equal(lookup.jobs[0].kind, undefined);
    assert.equal(JSON.stringify(lookup).includes('sensitive'), false);
  }
  assert.equal(poll(waited([{index: 0, job_id: id1, status: 'lookup_failed'}], true), [id1]).code, 'HIGGSFIELD_INVALID_JOB');
  assert.equal(poll(waited([{index: 0, job_id: id1, status: 'lookup_failed', retryable: false, error: {secret: 'unknown shape'}}], true), [id1]).code, 'HIGGSFIELD_INVALID_JOB');
  assert.equal(poll(waited([status()], true), [id1]).code, 'HIGGSFIELD_AMBIGUOUS_RESPONSE');
  assert.equal(poll(waited([status()], false, {error: 'conflicting provider envelope'}), [id1]).code, 'HIGGSFIELD_AMBIGUOUS_RESPONSE');
});

test('duplicate, conflicting, missing or unrequested identities invalidate the entire claimed job set', () => {
  for (const entries of [[job(), job()], [job(), job('image', {id: id1.toUpperCase(), status: 'failed'})]]) assert.equal(submission({results: entries}, 'image').code, 'HIGGSFIELD_JOB_SET_MISMATCH');
  for (const [input, expected] of [
    [waited([status({job_id: id2})]), [id1]], [waited([status(), status({index: 1})]), [id1, id2]],
    [waited([status(), status({job_id: id2})]), [id1, id2]], [waited([status()]), [id1, id2]],
    [waited([status()]), [id1, id1]], [waited([status()]), []],
  ] as const) {
    const normalized = poll(input, expected); assert.equal(normalized.supported, false); assert.deepEqual(normalized.jobs, []);
  }
});

test('malformed jobs, unfamiliar statuses, 3d and mismatching media kinds fail closed', () => {
  for (const patch of [{id: 'not-a-uuid'}, {id: id1 + '\n'}, {type: '3d'}, {type: 'audio'}, {status: 'future_status'}, {status: 'constructor'}, {status: 'lookup_failed'}, {params: null}, {model: {}}, {results: []}, {results: {rawUrl: url}}]) {
    const normalized = submission({results: [job('image', patch)]}, 'image'); assert.equal(normalized.outcome, 'unsupported');
  }
  for (const patch of [{summary: {}}, {summary: {active: 1, total: 1, completed: 0, failed: 0, errors: '0'}}, {poll_after_seconds: -1}, {poll_after_seconds: Infinity}, {timed_out: 'yes'}]) assert.equal(poll(waited([status()], false, patch), [id1]).supported, false);
  assert.equal(poll(waited([status({type: undefined, status: 'completed', result_url: url})], true), [id1]).supported, false);
});

test('unsafe locator syntax is never an output; accepted public-domain syntax is not a retrieval allowlist', () => {
  const unsafe = ['http://media.example/output', 'file:///tmp/output', 'https://user:pass@media.example/output',
    'https://127.0.0.1/output', 'https://[::1]/output', 'https://2130706433/output', 'https://0x7f000001/output',
    'https://localhost/output', 'https://foo.local/output', 'https://foo.internal/output', 'https://home.arpa/output',
    'https://media.example:444/output', 'https://media.example./output', 'https://media.example/output#private',
    'https://media.example/white space', 'https://media.example/\noutput', 'https://media.example\\@127.0.0.1/output'];
  for (const rawUrl of unsafe) {
    const normalized = submission({results: [job('image', {status: 'completed', results: {rawUrl}})]}, 'image');
    assert.equal(normalized.code, 'HIGGSFIELD_INVALID_LOCATOR', rawUrl); assert.equal(normalized.jobs[0].outputs, null);
  }
  const parsed = submission({results: [job('image', {status: 'completed', results: {rawUrl: 'https://unreviewed.example/output'}})]}, 'image');
  assert.equal(parsed.supported, true); // No I/O is performed; fetching needs separate exact-host review.
});

const pollSchema = (): any => ({type: 'object', properties: {
  jobs: {type: 'array', minItems: 1, maxItems: 8, items: {type: 'object', properties: {index: {type: 'number'}, job_id: {type: 'string'}}, required: ['index', 'job_id'], additionalProperties: false}},
  timeout_seconds: {type: 'number', minimum: 0, maximum: 15, default: 15},
}, required: ['jobs'], additionalProperties: false});

test('poll arguments use only a compatible advertised indexed shape and a bounded immediate snapshot', () => {
  assert.deepEqual(pollArguments(pollSchema(), [id1, id2]), {jobs: [{index: 0, job_id: id1}, {index: 1, job_id: id2}], timeout_seconds: 0});
  const schema = pollSchema(); delete schema.properties.timeout_seconds;
  assert.deepEqual(pollArguments(schema, [id1]), {jobs: [{index: 0, job_id: id1}]});
  schema.properties.jobs.items.properties.index = {type: 'integer', minimum: 0, maximum: 7};
  schema.properties.jobs.items.properties.job_id = {type: 'string', format: 'uuid', minLength: 36, maxLength: 36};
  schema.properties.optional_unknown = {type: 'string'};
  assert.equal(pollArguments(schema, [id1])?.jobs.length, 1);
});

test('the complete captured company jobs_wait input schema is supported without raising the worker cap or accepting arbitrary patterns', () => {
  const captured = JSON.parse(readFileSync(new URL('./fixtures/higgsfield-company-jobs-wait.schema.json', import.meta.url), 'utf8'));
  assert.equal(captured.tool, 'jobs_wait'); assert.equal(captured.outputSchema, null);
  assert.equal(captured.inputSchema.properties.jobs.maxItems, 12);
  const ids = Array.from({length: 9}, (_, n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`);
  assert.deepEqual(pollArguments(captured.inputSchema, ids.slice(0, 8)), {
    jobs: ids.slice(0, 8).map((job_id, index) => ({index, job_id})), timeout_seconds: 0,
  });
  assert.equal(pollArguments(captured.inputSchema, ids), null);
  for (const invalid of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '11111111-1111-9111-8111-111111111111']) {
    assert.equal(pollArguments(captured.inputSchema, [invalid]), null); // App retains stricter actual-job UUID bounds.
  }
  const original = captured.inputSchema.properties.jobs.items.properties.job_id.pattern;
  for (const pattern of [original + '|.*', original.replace('[1-8]', '[1-9]'), '(a+)+$', 123, null]) {
    const schema = structuredClone(captured.inputSchema); schema.properties.jobs.items.properties.job_id.pattern = pattern;
    assert.equal(pollArguments(schema, [id1]), null);
  }
});

test('poll schema gating refuses alternate forms, unknown required fields and unsupported constraints', () => {
  const mutations = [
    (s: any) => {s.required.push('workspace_id'); s.properties.workspace_id = {type: 'string'};},
    (s: any) => {s.required.push('absent');},
    (s: any) => {s.required = [];},
    (s: any) => {s.$ref = '#/$defs/request';},
    (s: any) => {s.anyOf = [{required: ['other']}];},
    (s: any) => {s.properties.jobs.items = {type: 'string'};},
    (s: any) => {s.properties.jobs.type = 'object';},
    (s: any) => {s.properties.jobs.maxItems = 0;},
    (s: any) => {s.properties.jobs.minItems = 2;},
    (s: any) => {s.properties.jobs.items.required = ['job_id'];},
    (s: any) => {s.properties.jobs.items.properties.index = {type: 'string'};},
    (s: any) => {s.properties.jobs.items.properties.index.minimum = 1;},
    (s: any) => {s.properties.jobs.items.properties.job_id = {type: 'string', pattern: 'custom-provider-pattern'};},
    (s: any) => {s.properties.jobs.items.properties.job_id.maxLength = 20;},
    (s: any) => {s.properties.jobs.items.required.push('sync'); s.properties.jobs.items.properties.sync = {type: 'boolean'};},
    (s: any) => {s.properties.timeout_seconds.minimum = 1;},
    (s: any) => {s.properties.timeout_seconds = {type: 'string'};},
  ];
  for (const mutate of mutations) {const schema = pollSchema(); mutate(schema); assert.equal(pollArguments(schema, [id1]), null);}
  for (const ids of [[], [id1, id1], ['not-a-uuid'], Array.from({length: 9}, (_, n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`)]) assert.equal(pollArguments(pollSchema(), ids), null);
});
