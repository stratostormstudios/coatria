# Bounded Coatria company worker

This Node 22+ runner hosts one approved Runpod installation for one company. It uses the existing durable worker and HTTP provider bridge. It does not install a coding CLI, expose a shell to a model, or serve incoming HTTP requests.

Place these three files at the same relative paths in the container:

```text
/opt/coatria/scripts/hosting/run-company-worker.mjs
/opt/coatria/public/downloads/agent-worker.mjs
/opt/coatria/public/downloads/provider-adapter.mjs
```

No npm installation is required. Use the reviewed source files and verify their hashes when preparing the container. Start Node as the main process so it receives SIGTERM:

```sh
exec node /opt/coatria/scripts/hosting/run-company-worker.mjs
```

Inject these values through the hosting provider's private environment configuration:

| Setting | Purpose |
| --- | --- |
| `COATRIA_AGENT_TOKEN` | This installation's scoped agent token |
| `RUNPOD_API_KEY` | Private inference credential |
| `COATRIA_RUNPOD_ENDPOINT_ID` | Approved queue endpoint |
| `COATRIA_URL` | `https://coatria.com` |
| `COATRIA_HOST_COMPANY_ID` | Exact company UUID |
| `COATRIA_HOST_AGENT_ID` | Exact installation agent UUID |
| `COATRIA_HOST_EXPIRES_AT` | Required fixed UTC timestamp, no more than 24 hours in the future |
| `COATRIA_HOST_STATE_DIR` | Private durable mount; defaults to `/state` |

Operator model ceilings remain available through `COATRIA_MAX_STEPS`, `COATRIA_MAX_OUTPUT_TOKENS`, `COATRIA_MAX_TOTAL_TOKENS`, and `COATRIA_TIMEOUT_SECONDS`. The installation also supplies its approved model and limits. Never place credentials in startup arguments, logs, model prompts, a Dockerfile or committed environment files. The runtime needs outbound HTTPS and no public inbound ports.

During trusted setup, call `GET /api/agent/identity` with the installation's bearer token. Its response is `{agent:{id,companyId,name,status,capabilities}}`; pin the returned IDs in the host configuration. The endpoint uses current agent/sponsor authentication, returns no credentials, accepts no company selector, and requires no run lease. It is described in `/api/agent/openapi`.

Mount private writable storage at `/state` and use a dedicated operating-system identity. The runner sets directory mode 0700 and creates state/status files with mode 0600 on Linux. One process owns the credential-bound state lock. Preserve the mount across restarts; termination that deletes its storage also deletes recovery evidence.

SIGTERM, SIGINT and the absolute deadline abort pending work and allow bounded provider cancellation to settle. The runner preserves its private state rather than repeating uncertain inference. Authentication/authorization or fatal host errors stop the process. Safe Coatria transport retries retain their original keys; they remain bounded by the host deadline. Do not configure infinite container restarts. An unchanged expired deadline performs no network work, even if the container is restarted.

`/state/host-status.json` contains only status, pinned identity, timestamps and exit metadata. Logs contain allowlisted event names and timestamps. Neither contains prompts, tool arguments, responses, lease credentials or provider keys. The existing `worker-private.json` contains sensitive recovery data and must stay private.

`runHostedWorker` exports a bounded `onShutdown(summary, signal)` callback for trusted hosting-controller integration. The CLI does not accept arbitrary shutdown commands or URLs. **Process exit is not a provider billing stop.** The hosting controller must stop/delete the Runpod CPU Pod and independently verify lifecycle state; configure an external watchdog against the same absolute deadline. GPU inference lifecycle is also separate. This runner performs no cloud control-plane mutations.

Tests use injected clients and adapters and make no provider requests:

```sh
node --import tsx --test tests/hosted-worker.test.ts
```
