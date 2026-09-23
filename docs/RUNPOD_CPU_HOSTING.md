# Runpod CPU hosting

The hosted pilot runs the Coatria HTTP agent worker on a Runpod CPU Pod. Vercel serves the company APIs and an independent compute cutoff. Neon stores company runs, permissions and committed task receipts. Qwen inference runs on the separate Runpod GPU endpoint. No customer desktop process is required.

The successful hosted workflow does not validate its research quality. The submitted brief was explicitly provisional and had no external research connector; review identified factual errors. Its contribution remains unaccepted and requires independent fact-checking.

## Deployed profile

- CPU: Secure Cloud `cpu3c`, 2 vCPU, 4 GB RAM; Runpod quoted $0.06/hour on 2026-09-17.
- State: a new 10 GB standard network volume mounted at `/state`; the worker uses private `/state/avery` with directory mode 0700 and files 0600.
- Runtime: official Node 24.19.0 image pinned by digest, three source files pinned to a reviewed Git commit and verified with SHA-256 before execution.
- Execution: one trusted Runpod HTTP installation, pinned company and agent UUIDs, Linux UID/GID 1000, cleared supplementary groups and an environment allowlist.
- Networking: outbound HTTPS; no exposed ports, SSH, Jupyter or global networking. The provider rejects even `globalNetworking: false` for CPU requests, so omit that GPU-only field.
- Bounds: fixed UTC expiry, at most 8 model steps, 8,192 output tokens per step, 80,000 total tokens and a 600-second model workflow deadline. The reviewed installation and cloud environment both carry the 8,192 output allowance; installation limits can shorten operator ceilings.

The bootstrap is `scripts/hosting/build-runpod-bootstrap.mjs`; the runner and required settings are documented in `scripts/hosting/README.md`. Runtime credentials are injected privately through the provider configuration. They are not Docker arguments, model context, repository files or public logs.

This is a dedicated company pilot using reviewed HTTP tools. It does not expose a shell or install arbitrary marketplace code. Before accepting untrusted code/browser harnesses, use the stronger isolation and credential-broker work described in [Managed harness hosting](MANAGED_HARNESS_HOSTING.md).

The initial 2,048-token completion ceiling was insufficient for a recovery response: Qwen used it entirely for reasoning and returned no final answer. Raising that allowance follows the separate deployed fix that removes floor geometry from the workspace overview. The total token, step, lifetime-cycle and deadline limits were not increased. A larger output allowance is not a completion guarantee.

## Independent cutoff

Vercel invokes `/api/internal/managed-pilot/reap` every minute. Only the production deployment can act; authenticated requests before expiry perform no provider operations. Configure these production-only sensitive environment variables:

| Variable | Value |
| --- | --- |
| `CRON_SECRET` | Independently generated random secret, at least 32 characters |
| `MANAGED_RUNPOD_API_KEY` | Operator credential for lifecycle control |
| `MANAGED_PILOT_CONFIG` | JSON containing exact `podId`, `podName`, `endpointId`, `endpointName`, fixed UTC CPU `expiresAt`, and optional separately reviewed `inferenceExpiresAt` |

The IDs come only from operator configuration. The caller cannot choose a resource. The reaper verifies provider IDs, names and CPU/GPU families, disables the selected GPU endpoint and stops the selected CPU Pod. It attempts both actions even when one fails. Later cron calls reconcile asynchronous stops and transient failures. It never deletes the state volume or an unrelated resource.

Without `inferenceExpiresAt`, the original `expiresAt` continues to govern both resources. An operator may explicitly hand the same endpoint to a bounded successor pilot by setting a separate fixed inference deadline at or after the original cutoff and no more than 24 hours into the future. The original CPU deadline and identity remain unchanged: cron still stops that exact old Pod while reporting inference as `waiting` until its separate deadline. At the inference deadline it sets the exact endpoint's minimum and maximum workers to zero. This path never enables workers, increases capacity, creates a host or authorizes inference. A malformed, earlier or unbounded override returns `REAPER_INVALID_INFERENCE_EXPIRY` and retains both original cleanup deadlines, so a rejected handoff cannot suppress CPU or GPU cleanup.

This is an operator-configured pilot handoff, not a general company or tenant endpoint lease. Retain the predecessor closure evidence, review the successor budget and fixed deadline, then verify the environment on the actual production deployment. Before starting a successor host, check readiness across more than one cron interval. Revoking the successor before its inference deadline still requires explicit endpoint cleanup; this reaper does not infer registry ownership or revoke model credentials. Do not extend the old CPU cutoff, delete the cron, or repeatedly re-enable capacity against an expired endpoint cutoff.

The runner's absolute deadline stops accepting work and allows bounded cancellation; restarting does not extend it. A process exiting does not stop provider billing. Vercel's separate cutoff remains necessary when the CPU runner fails. Scheduler or provider outages can delay cutoff, so this is a time boundary with reconciliation, not a guaranteed dollar limit. Operator alerts and a company spending ledger remain production work.

The live API returned `EXITED` while retaining the $0.06 hourly quote, despite API documentation describing zero cost for stopped Pods. The reaper therefore verifies lifecycle status and explicitly reports `billingVerified: false`. Verify actual spend separately. Storage remains billable while compute is stopped.

## Restart and recovery

The same Pod and volume logged `state-restored` at 16:30:48 UTC and, following the allowance update, at 16:43:02.795 UTC on 2026-09-17. The third cycle was manually dispatched at 16:44 UTC and succeeded at 16:53:13.544 UTC. The existing task and one contribution were submitted for independent review, with no duplicate task or acceptance. Its lifetime limit remains three, with no automatic fourth cycle authorized. A normally due scheduled follow-up was not verified in this pilot.

Use one worker supervisor for this volume. For a planned restart, wait for current work to finish, stop the Pod, confirm `EXITED`, then start it with the same volume, credentials, source revision and deadline. Check the worker's new API contact and complete a model connection test.

Worker state preserves claim IDs, lease state and pending completion. It does not persist the entire provider reasoning history or Runpod request lifecycle. After an uncertain interruption, reconcile committed tool receipts and any provider job before allowing new reasoning. The worker deliberately refuses to silently start that reasoning again.

The existing state lock uses process IDs. An unclean container restart can reuse a PID and leave a lock that requires operator reconciliation. Concurrent stale-lock cleanup is also unsuitable for multiple supervisors sharing one file. Never clear a lock merely because a different container cannot see its process. Automatic fleet recovery needs a tested advisory lock or controller-issued ownership fence, durable provider checkpoints and a reconciler.

## Verification

The release checks CPU bootstrap integrity, non-root execution, private environment filtering, expired starts, cooperative shutdown, fixed identity, credential authorization, provider identity mismatches and retryable cleanup. CI also exercises real PostgreSQL company authorization and the existing agent tool pipeline. The actual Pod launch is separately verified through provider logs and a real company request; fixture success alone does not establish a deployed worker.

CPU hosting does not remove Qwen's cold startup delay. Keep a small idle grace period between tool steps and let GPU capacity scale to zero between jobs. Continuously warm GPU capacity has a separate cost. At the quoted CPU rate, 730 hours is $43.80 before disk, network volume, inference, Vercel and database charges.

The deployed GPU configuration is minimum 0, maximum 1 and idle timeout 60 seconds. At 16:43:54 UTC between jobs, its worker summary showed zero running, initializing and idle workers, with three throttled historical entries. The account rate fell to approximately $0.077/hour for CPU and storage. That observation verifies an idle interval, not permanent GPU shutdown or zero billed spend; new admitted work can start another GPU. The independent cutoff remains fixed at 2026-09-17 18:11 UTC (11:11 a.m. Pacific).
