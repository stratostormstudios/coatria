import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  podId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  podName: z.string().min(1).max(200),
  endpointId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  endpointName: z.string().min(1).max(200),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

type PilotConfig = z.infer<typeof configSchema>;
type Environment = Pick<NodeJS.ProcessEnv, 'VERCEL_ENV' | 'CRON_SECRET' | 'MANAGED_PILOT_CONFIG' | 'MANAGED_RUNPOD_API_KEY'>;
type ProviderObject = Record<string, unknown>;
type CleanupResult = { status: string; code?: string; hourlyQuoteUsd?: number; expiresAt?: string };
type Dependencies = { env?: Environment; fetch?: typeof fetch; now?: () => number };

const providerOrigin = 'https://api.runpod.io/v2';
const requestTimeoutMs = 10_000;
const activePodStates = new Set(['PROVISIONING', 'STARTING', 'RUNNING']);
const stoppedPodStates = new Set(['EXITED', 'TERMINATED']);

class ReaperError extends Error {
  constructor(readonly code: string) { super(code); }
}

function reply(body: object, status = 200) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

function isObject(value: unknown): value is ProviderObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function authenticated(request: Request, secret: string) {
  const authorization = request.headers.get('authorization') || '';
  if (authorization.length > 4096) return false;
  // Hash both values to fixed lengths before the constant-time comparison.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

function verifyResource(value: unknown, id: string, name: string, family: 'cpu' | 'gpu'): asserts value is ProviderObject {
  if (!isObject(value) || value.id !== id || value.name !== name || !isObject(value[family]) || value[family === 'cpu' ? 'gpu' : 'cpu'] != null) {
    throw new ReaperError('RESOURCE_IDENTITY_MISMATCH');
  }
}

function providerClient(fetcher: typeof fetch, key: string) {
  return async (path: string, method = 'GET', body?: object): Promise<unknown | null> => {
    try {
      const response = await fetcher(`${providerOrigin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 404 && method === 'GET') return null;
      if (!response.ok) throw new ReaperError('PROVIDER_REQUEST_FAILED');
      return await response.json();
    } catch (error) {
      if (error instanceof ReaperError) throw error;
      throw new ReaperError('PROVIDER_UNAVAILABLE');
    }
  };
}

type ProviderClient = ReturnType<typeof providerClient>;

async function disableInference(config: PilotConfig, client: ProviderClient): Promise<CleanupResult> {
  const path = `/serverless/${config.endpointId}`;
  const endpoint = await client(path);
  if (endpoint === null) return { status: 'absent' };
  verifyResource(endpoint, config.endpointId, config.endpointName, 'gpu');
  if (!isObject(endpoint.workers)) throw new ReaperError('INVALID_PROVIDER_RESPONSE');
  if (endpoint.workers.min === 0 && endpoint.workers.max === 0) return { status: 'disabled' };
  const updated = await client(path, 'PATCH', { workers: { min: 0, max: 0 } });
  verifyResource(updated, config.endpointId, config.endpointName, 'gpu');
  if (!isObject(updated.workers) || updated.workers.min !== 0 || updated.workers.max !== 0) {
    throw new ReaperError('INFERENCE_DISABLE_PENDING');
  }
  // This confirms the configured cap, not that every in-flight GPU has drained.
  return { status: 'disabled' };
}

async function stopHarness(config: PilotConfig, client: ProviderClient): Promise<CleanupResult> {
  const path = `/pods/${config.podId}`;
  const pod = await client(path);
  if (pod === null) return { status: 'absent' };
  verifyResource(pod, config.podId, config.podName, 'cpu');
  if (typeof pod.status !== 'string') throw new ReaperError('INVALID_PROVIDER_RESPONSE');
  if (stoppedPodStates.has(pod.status)) return stoppedHarness(pod);
  if (!activePodStates.has(pod.status) || !Array.isArray(pod.actions) || !pod.actions.includes('stop')) {
    throw new ReaperError('POD_STOP_UNAVAILABLE');
  }
  const updated = await client(`${path}/action`, 'POST', { action: 'stop' });
  verifyResource(updated, config.podId, config.podName, 'cpu');
  if (typeof updated.status !== 'string' || !stoppedPodStates.has(updated.status)) {
    throw new ReaperError('POD_STOP_PENDING');
  }
  return stoppedHarness(updated);
}

function stoppedHarness(pod: ProviderObject): CleanupResult {
  // Live CPU Pods retain their hourly quote after EXITED, despite the API docs.
  // Lifecycle state confirms stop; this field cannot certify current billing.
  return {
    status: 'stopped',
    ...(typeof pod.cost === 'number' && Number.isFinite(pod.cost) && pod.cost >= 0 ? { hourlyQuoteUsd: pod.cost } : {}),
  };
}

async function attempt(operation: () => Promise<CleanupResult>): Promise<CleanupResult> {
  try { return await operation(); }
  catch (error) {
    return { status: 'retry_required', code: error instanceof ReaperError ? error.code : 'REAPER_OPERATION_FAILED' };
  }
}

/** Private pilot cutoff. Targets come exclusively from production operator configuration. */
export async function reapManagedPilot(request: Request, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const cronSecret = env.CRON_SECRET;
  if (!cronSecret || cronSecret.length < 32) return reply({ code: 'REAPER_NOT_CONFIGURED' }, 503);
  if (!authenticated(request, cronSecret)) return reply({ code: 'UNAUTHORIZED' }, 401);
  if (env.VERCEL_ENV !== 'production') return reply({ code: 'REAPER_PRODUCTION_ONLY' }, 503);

  let config: PilotConfig;
  let inferenceExpiry: unknown;
  let hasInferenceExpiry = false;
  try {
    const raw = env.MANAGED_PILOT_CONFIG;
    if (!raw || raw.length > 8192) throw new Error();
    const decoded: unknown = JSON.parse(raw);
    if (!isObject(decoded)) throw new Error();
    const { inferenceExpiresAt, ...legacy } = decoded;
    config = configSchema.parse(legacy);
    hasInferenceExpiry = Object.hasOwn(decoded, 'inferenceExpiresAt');
    inferenceExpiry = inferenceExpiresAt;
  } catch { return reply({ code: 'REAPER_INVALID_CONFIG' }, 503); }

  const now = (dependencies.now ?? Date.now)();
  if (!Number.isFinite(now)) return reply({ code: 'REAPER_INVALID_CLOCK' }, 503);
  const cpuDeadline = Date.parse(config.expiresAt);
  let inferenceDeadline = cpuDeadline;
  let invalidInferenceExpiry = false;
  if (hasInferenceExpiry) {
    const parsed = z.iso.datetime({ offset: true }).safeParse(inferenceExpiry);
    const deadline = parsed.success ? Date.parse(parsed.data) : NaN;
    invalidInferenceExpiry = !Number.isFinite(deadline) || deadline < cpuDeadline || deadline > now + 86_400_000;
    if (!invalidInferenceExpiry) inferenceDeadline = deadline;
    // A malformed handoff cannot postpone either original cleanup. Keep the
    // old cutoff and report the rejected override even if cleanup succeeds.
  }
  if (now < cpuDeadline && now < inferenceDeadline) {
    return invalidInferenceExpiry
      ? reply({ code: 'REAPER_INVALID_INFERENCE_EXPIRY' }, 503)
      : reply({ status: 'waiting', expired: false });
  }
  const key = env.MANAGED_RUNPOD_API_KEY;
  if (!key || /[\r\n]/.test(key)) return reply({ code: 'REAPER_NOT_CONFIGURED' }, 503);

  const client = providerClient(dependencies.fetch ?? fetch, key);
  // Independent deadlines: a reviewed GPU handoff never postpones the old CPU
  // cutoff, and neither waiting nor cleanup can enable provider capacity.
  const inference: CleanupResult = now >= inferenceDeadline
    ? await attempt(() => disableInference(config, client))
    : { status: 'waiting', expiresAt: new Date(inferenceDeadline).toISOString() };
  const harness: CleanupResult = now >= cpuDeadline
    ? await attempt(() => stopHarness(config, client))
    : { status: 'waiting', expiresAt: config.expiresAt };
  const retryRequired = invalidInferenceExpiry || inference.status === 'retry_required' || harness.status === 'retry_required';
  return reply({
    status: retryRequired ? 'retry_required' : inference.status === 'waiting' ? 'inference_waiting' : 'cutoff_applied',
    expired: now >= cpuDeadline,
    billingVerified: false,
    ...(retryRequired ? { code: invalidInferenceExpiry ? 'REAPER_INVALID_INFERENCE_EXPIRY' : 'REAPER_CLEANUP_INCOMPLETE' } : {}),
    inference,
    harness,
  }, retryRequired ? 503 : 200);
}
