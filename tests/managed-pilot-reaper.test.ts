import test from 'node:test';
import assert from 'node:assert/strict';
import { reapManagedPilot } from '../src/lib/managed-pilot-reaper';

const config = {
  podId: 'cpu-pilot', podName: 'coatria-worker-pilot',
  endpointId: 'gpu-pilot', endpointName: 'coatria-inference-pilot',
  expiresAt: '2026-09-17T18:00:00.000Z',
};
const secret = 'test-cron-secret-with-at-least-32-characters';
const providerKey = 'test-private-provider-key';
const env = {
  VERCEL_ENV: 'production', CRON_SECRET: secret,
  MANAGED_RUNPOD_API_KEY: providerKey, MANAGED_PILOT_CONFIG: JSON.stringify(config),
};
const request = (authorization = `Bearer ${secret}`, query = '') => new Request(`https://coatria.example/api/internal/managed-pilot/reap${query}`, { headers: { authorization } });
const now = () => Date.parse(config.expiresAt);
const endpoint = (min = 0, max = 1) => ({ id: config.endpointId, name: config.endpointName, gpu: { pools: ['TEST'], count: 1 }, workers: { min, max } });
const pod = (status = 'RUNNING', cost = 0.06) => ({ id: config.podId, name: config.podName, cpu: { id: 'cpu3c', vcpuCount: 2 }, status, cost, actions: ['stop'] });

function transport(responses: Array<unknown | Error | Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    assert.equal(new URL(String(url)).origin, 'https://api.runpod.io');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${providerKey}`);
    assert(responses.length, 'Unexpected provider request');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  };
  return { calls, fetcher, responses };
}

test('missing, incorrect, prefixed and oversized authentication fail closed without provider calls', async () => {
  for (const authorization of ['', 'Bearer incorrect', `Bearer ${secret}extra`, `Basic ${secret}`, 'x'.repeat(5000)]) {
    const mock = transport([]);
    const response = await reapManagedPilot(request(authorization), { env, now, fetch: mock.fetcher });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: 'UNAUTHORIZED' });
    assert.equal(mock.calls.length, 0);
  }
  for (const CRON_SECRET of [undefined, '', 'short']) {
    const response = await reapManagedPilot(request(), { env: { ...env, CRON_SECRET }, now, fetch: transport([]).fetcher });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'REAPER_NOT_CONFIGURED' });
  }
});

test('preview and development deployments cannot clean up production resources', async () => {
  for (const VERCEL_ENV of ['preview', 'development', undefined]) {
    const mock = transport([]);
    const response = await reapManagedPilot(request(), { env: { ...env, VERCEL_ENV }, now, fetch: mock.fetcher });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'REAPER_PRODUCTION_ONLY' });
    assert.equal(mock.calls.length, 0);
  }
});

test('invalid private configuration never reaches Runpod', async () => {
  for (const value of [null, {}, { ...config, podId: '../another' }, { ...config, endpointId: 'https://elsewhere.test' }, { ...config, expiresAt: 'never' }, { ...config, extra: true }]) {
    const mock = transport([]);
    const response = await reapManagedPilot(request(), { env: { ...env, MANAGED_PILOT_CONFIG: JSON.stringify(value) }, now, fetch: mock.fetcher });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'REAPER_INVALID_CONFIG' });
    assert.equal(mock.calls.length, 0);
  }
});

test('before the exact expiry boundary the reaper makes no provider calls', async () => {
  const mock = transport([]);
  const response = await reapManagedPilot(request(), { env, now: () => now() - 1, fetch: mock.fetcher });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'waiting', expired: false });
  assert.equal(mock.calls.length, 0);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('expiry disables the exact GPU endpoint then stops the exact CPU Pod, ignoring caller targets', async () => {
  const mock = transport([endpoint(), endpoint(0, 0), pod(), pod('EXITED', 0)]);
  const response = await reapManagedPilot(request(undefined, '?podId=unrelated&endpointId=unrelated&expiresAt=2099-01-01'), { env, now, fetch: mock.fetcher });
  assert.equal(response.status, 200);
  assert.deepEqual(mock.calls.map(call => [new URL(call.url).pathname, call.init.method]), [
    ['/v2/serverless/gpu-pilot', 'GET'], ['/v2/serverless/gpu-pilot', 'PATCH'],
    ['/v2/pods/cpu-pilot', 'GET'], ['/v2/pods/cpu-pilot/action', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(String(mock.calls[1].init.body)), { workers: { min: 0, max: 0 } });
  assert.deepEqual(JSON.parse(String(mock.calls[3].init.body)), { action: 'stop' });
  assert.deepEqual(await response.json(), { status: 'cutoff_applied', expired: true, billingVerified: false, inference: { status: 'disabled' }, harness: { status: 'stopped', hourlyQuoteUsd: 0 } });
});

test('an already disabled endpoint and stopped or missing CPU are idempotent', async () => {
  for (const existing of [pod('EXITED', 0), pod('TERMINATED', 0), new Response(null, { status: 404 })]) {
    const mock = transport([endpoint(0, 0), existing]);
    const response = await reapManagedPilot(request(), { env, now, fetch: mock.fetcher });
    assert.equal(response.status, 200);
    assert(mock.calls.every(call => call.init.method === 'GET'));
  }
});

test('stopped CPU Pods retaining a nonzero hourly quote finish cleanup without claiming verified billing', async () => {
  for (const status of ['EXITED', 'TERMINATED']) {
    const stopped = { ...pod(status, 0.06), actions: ['start', 'terminate'] };
    const readOnly = transport([endpoint(0, 0), stopped]);
    const response = await reapManagedPilot(request(), { env, now, fetch: readOnly.fetcher });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.harness, { status: 'stopped', hourlyQuoteUsd: 0.06 });
    assert.equal(result.billingVerified, false);
    assert(readOnly.calls.every(call => call.init.method === 'GET'));

    const transition = transport([endpoint(0, 0), pod(), stopped]);
    const stoppedResponse = await reapManagedPilot(request(), { env, now, fetch: transition.fetcher });
    assert.equal(stoppedResponse.status, 200);
    assert.deepEqual((await stoppedResponse.json()).harness, { status: 'stopped', hourlyQuoteUsd: 0.06 });
  }
});

test('wrong GPU identity or compute family blocks its mutation but CPU cleanup still runs', async () => {
  for (const invalid of [{ ...endpoint(), id: 'other' }, { ...endpoint(), name: 'unrelated' }, { ...endpoint(), gpu: null }, { ...endpoint(), cpu: {} }]) {
    const mock = transport([invalid, pod(), pod('EXITED', 0)]);
    const response = await reapManagedPilot(request(), { env, now, fetch: mock.fetcher });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.inference.code, 'RESOURCE_IDENTITY_MISMATCH');
    assert.equal(result.harness.status, 'stopped');
    assert.equal(mock.calls.filter(call => call.init.method === 'PATCH').length, 0);
  }
});

test('wrong CPU identity or compute family cannot stop any Pod', async () => {
  for (const invalid of [{ ...pod(), id: 'other' }, { ...pod(), name: 'other' }, { ...pod(), cpu: null }, { ...pod(), gpu: {} }]) {
    const mock = transport([endpoint(0, 0), invalid]);
    const response = await reapManagedPilot(request(), { env, now, fetch: mock.fetcher });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).harness.code, 'RESOURCE_IDENTITY_MISMATCH');
    assert(mock.calls.every(call => call.init.method === 'GET'));
  }
});

test('provider timeout, HTTP errors and sensitive errors are sanitized while independent CPU cleanup proceeds', async () => {
  for (const failure of [new Error(`private ${providerKey}`), new DOMException('private response', 'TimeoutError'), new Response(`private ${providerKey}`, { status: 503 })]) {
    const mock = transport([failure, pod(), pod('EXITED', 0)]);
    const response = await reapManagedPilot(request(), { env, now, fetch: mock.fetcher });
    assert.equal(response.status, 503);
    const output = await response.text();
    for (const hidden of [providerKey, secret, config.podId, config.podName, config.endpointId, 'private response']) assert(!output.includes(hidden));
    assert.equal(JSON.parse(output).harness.status, 'stopped');
  }
});

test('failed GPU PATCH still stops CPU and a repeated cron can finish cleanup', async () => {
  const first = transport([endpoint(), new Response(null, { status: 500 }), pod(), pod('EXITED', 0)]);
  const response = await reapManagedPilot(request(), { env, now, fetch: first.fetcher });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).harness.status, 'stopped');
  const second = transport([endpoint(), endpoint(0, 0), pod('EXITED', 0)]);
  assert.equal((await reapManagedPilot(request(), { env, now, fetch: second.fetcher })).status, 200);
});

test('expiry also stops provisioning and starting CPU Pods when provider permits stop', async () => {
  for (const status of ['PROVISIONING', 'STARTING']) {
    const mock = transport([endpoint(0, 0), pod(status), pod('EXITED', 0)]);
    assert.equal((await reapManagedPilot(request(), { env, now, fetch: mock.fetcher })).status, 200);
    assert.equal(mock.calls.at(-1)?.init.method, 'POST');
  }
});

test('unavailable or still-pending stop stays retryable and never terminates resources', async () => {
  for (const existing of [pod('ERROR'), { ...pod(), actions: [] }]) {
    const mock = transport([endpoint(0, 0), existing]);
    const response = await reapManagedPilot(request(), { env, now, fetch: mock.fetcher });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).harness.status, 'retry_required');
    assert(mock.calls.every(call => call.init.method === 'GET'));
  }
  const pending = transport([endpoint(0, 0), pod(), pod()]);
  const response = await reapManagedPilot(request(), { env, now, fetch: pending.fetcher });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).harness.code, 'POD_STOP_PENDING');
  assert(pending.calls.every(call => call.init.method !== 'DELETE'));
});

test('malformed or unconfirmed provider mutation responses do not report success', async () => {
  const mock = transport([endpoint(), endpoint(), pod('EXITED', 0)]);
  const response = await reapManagedPilot(request(), { env, now, fetch: mock.fetcher });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).inference.code, 'INFERENCE_DISABLE_PENDING');
  const malformed = transport([new Response('{', { status: 200 }), pod('EXITED', 0)]);
  assert.equal((await reapManagedPilot(request(), { env, now, fetch: malformed.fetcher })).status, 503);
});
