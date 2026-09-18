# Managed inference broker

An explicitly reviewed CPU preset can use `coatria_broker_v1`. Its hosted supervisor receives Coatria host and leased agent credentials; it receives no Runpod key or endpoint. Vercel alone holds `MANAGED_RUNPOD_API_KEY`. Existing direct presets retain their separate restricted inference-key requirement. There is no fallback from broker mode to direct provider access.

This implementation uses the existing Runpod endpoint and model pinned in the approved preset. It does not create or enable GPU workers. CPU preflight still checks that the endpoint is enabled and usable. The implementation and isolated integration tests are complete; a new live broker deployment and paid pilot need their own release evidence.

## Public contract

All three endpoints require the exact agent bearer credential, its live run lease, a live managed supervisor lease, current enrollment/configuration, and an active approved CPU provision with no stop request.

| Endpoint | Request |
| --- | --- |
| `POST /api/agent/runs/{runId}/inference` | `{leaseToken, requestId, step}`; UUID request ID, zero-based step, no other fields |
| `GET /api/agent/runs/{runId}/inference/{inferenceId}` | `X-Coatria-Run-Lease` header |
| `POST /api/agent/runs/{runId}/inference/{inferenceId}/cancel` | `{leaseToken, requestId}` |

Responses contain `inference` with its UUID, run ID, step, status, creation time, absolute deadline, sanitized error code, reserved/used tokens and `billingVerified:false`. Only `succeeded` contains a validated bounded OpenAI chat completion in `output`. States are `submitting`, `queued`, `running`, `succeeded`, `failed`, `uncertain`, `cancel_requested`, `cancelled`, and `expired`. A cancellation request is idempotent; cancellation cannot undo completed provider work or committed tool actions.

The worker uses `stableRequestId(runId, 'inference:'+step)` and tool receipts use `stableRequestId(runId, 'provider:'+step+':'+callId)`. A complete step with no requested tools ends reasoning; it cannot be followed by another inference step. The worker executes requested tools through the ordinary leased API, then completes its run separately.

## Trusted model context

The server constructs the system policy and installed company persona, verified run prompt, scoped conversation messages, approved tool catalog, model and limits. Conversation text remains explicitly untrusted. Callers cannot supply prompts, messages, tool definitions, provider URLs, models, credentials, model responses or tool results to the broker.

Each next step reconstructs history from the previous stored request/completion and exact tool receipts committed by the ordinary API. Receipt identity binds the inference, run, agent, requested tool and canonical raw arguments. A failed or mismatched mutation rolls back in its existing transaction. Read results have separate immutable evidence without inflating legacy mutation-receipt counts. For `workspace_get`, model evidence omits floor geometry and identifies the omitted item count; `layout_get` remains the explicit geometry tool. Ordinary tool HTTP responses retain their full existing shape. On a repeated read, model history uses the first recorded projection, even if the current HTTP read returns newer state.

The broker validates completion state, strict provider job ID, requested tool schemas, output size, reported token usage, at most eight calls per batch and 64 per run. It rejects reused model call IDs, missing usage, partial/length-limited output and error-bearing completions. Persona guidance does not grant business approval, private-vault access or execution capabilities. Existing independent review and business gates still apply to every tool mutation.

## Durable execution and accounting

Migration `021_studio_inference.sql` adds jobs, immutable monetary reservations and immutable model tool receipts. Runtime permissions allow inserts and reads for all three; updates are restricted to mutable job lifecycle/result columns. Runtime credentials cannot rewrite stored request context, authority, endpoint, approved limits or deadline, nor delete evidence.

Admission locks company and `studio-cpu-control:{companyId}` before existing host, sorted membership, agent and run authority. CPU start/stop and inference admission share that control lock. The receipt hook never takes it after an existing run lock. Reconciliation rechecks live authority before submission and before saving a provider result. Committed cancellation, host stop, expiry and authority loss suppress late output; paid work may already have finished before cancellation is observed.

A durable `submitted_at` fence commits before Runpod `/run`. The broker never sends a second paid submission for that record, even if the response or process is lost. Known IDs use `/status` and `/cancel`. Transient status-read failures retain known pending state for later polling. Unknown submission outcomes remain `uncertain`; a missing provider ID cannot be cancelled directly and is bounded by the submitted provider TTL and recorded deadline. Internal cron calls `reconcileStudioInferenceJobs(2)` independently of the worker to discover ended authority and cancel known jobs. Individual calls are capped at 10 seconds and a reconciliation at 25 seconds, including uncooperative body streams. Reconciliation is protected by a durable polling lease.

Before each step, token accounting reserves a conservative UTF-8 request-size bound plus output allowance and overhead. Valid successful provider-reported usage settles that token reservation; unresolved outcomes retain the bound. Admission counts previous settled usage, unresolved reservations and the new bound against the run's effective limit. This prevents a large tool catalog from permanently consuming its byte estimate after each successful step.

The approved preset's `inference` object contains:

```json
{
  "mode": "coatria_broker_v1",
  "maxJobs": 12,
  "maxHourlyMicrousd": 600000,
  "lifetimeAllowanceMicrousd": 2000000
}
```

`maxJobs` limits all reasoning jobs admitted by one CPU provision. The lifetime monetary allowance is summed across the company's retained inference reservations. Each job reserves the approved hourly estimate multiplied by its remaining run time plus a 60-second margin. These monetary reservations are never silently refunded. They are conservative application admission controls, not actual measured charges or a Runpod-enforced billing cap. CPU, storage, existing endpoint idle time and unrelated provider usage have separate accounting. The plan UI discloses CPU and inference reservations separately.

## Verification and operational limits

Run `COATRIA_TEST_EMULATOR=1 node --import tsx --test tests/studio-inference.test.ts` with the environment variable syntax appropriate to your shell, or use an isolated migrated PostgreSQL fixture through `COATRIA_INTEGRATION_DATABASE_URL`. Tests make no paid/provider calls. They cover actual HTTP handlers, installed personas, managed enrollment, lease authority, exact tool evidence, three-step execution through the downloadable adapter, independent task review, replay, money/token/job limits, late cancellation/stop/expiry, missing/error-bearing completions, uncooperative streams and status retries.

The test proves transport, authority and workflow state, not semantic quality of a model-written estimate. Live Runpod availability, provider billing, cold-start latency, global fleet capacity, malicious-input resistance and business-output quality still require separate operational monitoring and evaluated production trials. Retained context and receipts contain company data and need the company's eventual retention policy. A broker deployment does not create autonomous permission to spend, alter staffing, start workers, approve client deliverables or access private employee skills.
