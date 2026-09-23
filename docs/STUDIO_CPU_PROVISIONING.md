# Reviewed managed CPU provisioning

The managed CPU lifecycle turns an administrator's exact approval into a real Runpod Pod create operation. It is a bounded, company-allowlisted pilot. The service, API, cron reconciliation and UI are separate from registering a broker identity. A configured company can approve another bounded host without manually assembling a Pod payload; operator setup of the release, storage, credentials and spending allowance is still required.

The implementation is tested against real Coatria HTTP handlers and isolated PostgreSQL-compatible transactions with a simulated Runpod transport. These tests do not establish live provider allocation, capacity availability or billing accuracy. Deployment and a supervised live acceptance run remain separate release work.

## What an administrator approves

1. Select one to eleven existing Runpod installations at their exact revisions and a 15, 20, 30 or 60 minute window. The plan lists their names, grants, invocation and conversation access, personas and runtime settings.
2. Review the immutable plan hash, fixed CPU configuration, retained volume, source commit, model, CPU allowance reservation and current configuration readiness. The review expires after ten minutes and starts nothing.
3. Explicitly approve charges and agent activation. In one transaction, Coatria checks the current configuration, reserves the company CPU allowance, registers a fresh bounded host, enrolls the exact installations and encrypts its one-time host credential. Enrollment rotates credentials and cancels previous queued/running runs. Retries return metadata and cannot create duplicate registrations or reservations.
4. After that transaction commits, the route performs one bounded provider reconciliation. The read-only preflight checks the CPU catalog price, company volume/region, enabled inference endpoint and the approved transport credential’s health access. A disabled inference endpoint stops this attempt before any CPU create; this workflow never enables GPU capacity.
5. A durable `submitted_at` marker commits **before** the one allowed `POST /pods`. A missing response is an uncertain operation. Subsequent reconciliation scans the provider for its exact reserved name and checks the full approved identity; it never repeats the create call.

The supervisor can process already approved active missions and runs once connected. Inference can therefore begin without another interaction after this explicit activation. Existing task, tool, mission, human review and provider limits still apply. This CPU operation does not approve a Studio task, render, independent review, delivery or client acceptance.

## Fixed execution boundary

- Secure Cloud CPU flavor `cpu3c`, two vCPUs, four GB memory, 10 GB ephemeral container disk, concurrency one.
- The pinned official Node image digest in `STUDIO_CPU_IMAGE`; three fixed reviewed source paths and their SHA-256 hashes, fetched at the approved Git commit.
- One preapproved company-specific retained network volume at `/state`. Companies cannot share an approved volume in the preset.
- No exposed ports, SSH, Jupyter, caller-selected command, provider destination, image, model or volume. CPU-incompatible `globalNetworking` is omitted entirely.
- The bootstrap drops to UID/GID1000 after verifying the mount and sources. A new host uses `/state/studio/<company UUID>/<host UUID>`. Prior host journals, including historical files directly beneath `/state/studio`, are retained. An expired host is never renewed by rewriting its deadline or journal identity.
- Exact hashes of every submitted environment value (thirteen for direct inference, twelve for Coatria broker mode) are persisted before creation. Provider observations must match the reviewed origin, company, host, deadline, model, inference transport, concurrency, limits and private credentials; direct mode additionally pins the endpoint. Unexpected environment additions or changed values require operator reconciliation. Keys and command arguments containing credentials never appear in API receipts.

Each new approved window gets a new host identity and journal namespace on the retained volume. This isolates retry receipts across lifetimes; it does not automatically merge an expired agent's private recovery state into the replacement agent. Storage retention and eventual cleanup require an operator policy.

## Server configuration

Configure only on the Coatria server:

| Variable | Purpose |
| --- | --- |
| `COATRIA_MANAGED_CPU_PRESET` | Reviewed nonsecret JSON release and per-company storage/allowance map, described below. |
| `MANAGED_RUNPOD_API_KEY` | Runpod lifecycle credential. Used only by the server for fixed catalog, storage, endpoint and Pod operations and explicitly configured broker inference; never injected into a Pod. |
| `COATRIA_MANAGED_RUNPOD_INFERENCE_KEY` | Required only by direct-worker presets. Separate restricted credential for the exact approved endpoint, injected privately as `RUNPOD_API_KEY`. It must differ from the lifecycle credential. Direct mode never falls back to the lifecycle key. Explicit `coatria_broker_v1` presets inject neither this key nor an endpoint. |
| `COATRIA_HOSTING_KEYRING` | Existing managed-host AES-256-GCM keyring. The new provisioning row encrypts the one-time `ch_` token with authenticated company, provision, host and plan identity. |

For direct-worker presets, the server cannot infer a key's entire permission set from successful health access. The operator must create the inference credential with endpoint-restricted permissions. The preflight verifies health access to the pinned endpoint; it does not prove that the key has no additional permissions. Private Pod environment configuration is readable to authorized Runpod account administrators.

Prepare a nonsecret builder configuration with these exact fields:

```json
{
  "id": "studio-cpu-reviewed-release",
  "modelId": "<exact installed Runpod model ID>",
  "endpointId": "<existing approved Runpod endpoint ID>",
  "maxHourlyMicrousd": 100000,
  "maxSteps": 8,
  "maxOutputTokens": 8192,
  "maxTotalTokens": 80000,
  "timeoutSeconds": 600,
  "companies": [{
    "companyId": "<company UUID>",
    "volumeId": "<private retained volume ID>",
    "dataCenterId": "<matching Runpod data center>",
    "lifetimeAllowanceMicrousd": 500000
  }]
}
```

These numbers are review limits, not current provider prices or a recommended production budget. One million microusd is one US dollar. Every installation must use the exact model and remain within all four preset runtime ceilings. The current `cpu3c` catalog record must still report two GB per vCPU and a two-vCPU price within the approved ceiling; incompatible catalog changes fail closed.

To use server-owned inference, add this optional, exact object to the configuration:

```json
"inference": {
  "mode": "coatria_broker_v1",
  "maxJobs": 8,
  "maxHourlyMicrousd": 3000000,
  "lifetimeAllowanceMicrousd": 5000000
}
```

These are illustrative review limits, not a current rate quote. Broker mode keeps every Runpod credential on Coatria. The CPU sends only numbered requests under its current run lease; the server reconstructs prompts, personas, approved tools and tool-result history. The plan shows the separate inference allowance and prior reservations. Changing the transport or limits invalidates an earlier plan. A preset without this object retains direct-worker semantics and its restricted-key requirement. See [server inference](STUDIO_INFERENCE.md) for admission, cancellation and accounting.

After the runtime source is committed and reviewed, run from the repository:

```sh
node scripts/hosting/build-cpu-preset.mjs FULL_REVIEWED_COMMIT configuration.json new-preset.json
```

The builder compares the three runtime files to that Git commit, hashes the generated bootstrap and writes a new file without overwriting an existing one. Install its exact JSON as `COATRIA_MANAGED_CPU_PRESET` through the deployment's private environment-management path. The builder does not install settings, contact Runpod or provision anything. Never put credentials in the configuration JSON.

## API and durable states

All public operations require current human owner/admin membership, normal origin protection for writes and stable UUID client IDs. No agent/model lifecycle tool is provided.

| Endpoint | Result |
| --- | --- |
| `GET /api/companies/{companyId}/studio/host-provisions` | Latest 50 operations plus configuration readiness. |
| `POST /api/companies/{companyId}/studio/host-provisions` | Create or replay a reviewed plan. |
| `GET /api/companies/{companyId}/studio/host-provisions/{id}` | Exact current operation; no secrets. |
| `GET .../{id}/readiness` | Admin-only, read-only checks of management access and endpoint health using the server-held keys and exact stored endpoint. |
| `POST .../{id}/start` | Exact revision/hash plus `acknowledgeCharges: true` and `activateAgents: true`; commit then reconcile. |
| `POST .../{id}/stop` | Exact revision; request CPU stop. A failed start proven never submitted instead closes the failed operation and revokes its unused host credentials without contacting Runpod. |
| `POST .../{id}/reconcile` | Check one operation with a client ID; never authorizes a new plan or repeats an uncertain create. |

The cron route `/api/internal/studio-hosts/reconcile` processes a bounded batch each minute using the same reconciler. It is independent of the earlier single-pilot reaper configuration. One reconcile shares a 25-second network deadline across all its requests and uses a 45-second durable claim; concurrent pollers do not both submit. Discovery reads up to ten paginated lists within that deadline and retains uncertainty if it cannot complete the scan.

`planned → approved → submitting → provisioning → running` is the normal path. `uncertain` requires provider discovery; `needs_attention` preserves mismatched or duplicate provider identities for an operator. New compute approval is blocked while any company operation is unresolved or active. An administrator stop, lost host sponsor, revoked host, or absolute expiry requests `stopping`; only a matching provider `EXITED`/`TERMINATED` observation confirms the stop. A cancellation before submission can confirm that no compute was started.

The crash window after the submitted marker but before the actual HTTP call intentionally stays uncertain. Zero discovered Pods cannot prove that no create reached the provider. An operator must establish provider state before replacing such an operation; there is no blind retry/reset API.

The manual readiness check makes at most two independent GET requests, including a health check when workers are disabled or management access fails. Each has a ten-second deadline and a two-MiB response limit; redirects and retries are disabled. The response contains fixed status categories, numeric worker facts and a separate current-configuration state. Historical checks remain available for a revoked configuration, but `authorizesStart` is always false. A successful check establishes endpoint connectivity and response shape, not model initialization, inference success or permission to reuse an expired plan. Current administrator access is checked before and after provider I/O. Responses are private/no-store, limited to four requests per minute per company administrator, and never include credentials, provider environments, URLs or raw errors.

## Cost, shutdown and remaining limits

Reservations equal the approved maximum CPU hourly rate times the requested window **plus five minutes of reconciliation margin**, rounded upward. A company's lifetime reserved sum never resets or refunds automatically. The operator must reconcile actual charges before raising its preset allowance. Immutable reservation and request-receipt tables have only SELECT/INSERT runtime privileges.

This is a CPU allowance gate, **not a provider billing cap**. GPU inference, retained storage and provider timing/rounding are separate. The response always reports `billingVerified: false`. An unreachable provider, missing lifecycle key, unavailable database or delayed cron can prevent timely shutdown; a process exiting by itself does not stop Pod billing. Broker presets add a separate finite lifetime inference reservation allowance and a per-provision job limit. Production rollout still needs an independent provider-side watchdog, durable billing reconciliation and monitoring. The application never deletes a retained volume.

CPU stop immediately closes new broker inference admission; server reconciliation cancels exact known provider jobs when host authority ends. CPU stop and host revocation remain distinct after provider submission. `credentialsRevoked` reports the current host identity and credential state; an unsubmitted failed-start cleanup closes both in one transaction. Restarting a stopped compute operation is not supported by a hidden action; review a new bounded plan and host identity. A matching old Pod can still be stopped after encryption-key removal because provider identity is checked against persisted environment hashes rather than decrypting a secret.

The existing broker maximum of three active unexpired host registrations still applies. Stopping CPU does not retire the registration; explicitly revoke unused registrations or let their original absolute deadlines expire before creating more. There is no automatic volume creation, unrestricted account-wide provisioning, autonomous budget increase or production fleet scheduler in this increment.

Provider contracts: [Runpod REST v2 overview](https://docs.runpod.io/api-reference-v2/overview), [create Pod](https://docs.runpod.io/api-reference-v2/pods/create-a-pod), [Pod transitions](https://docs.runpod.io/api-reference-v2/pods/trigger-a-pod-state-transition), and the [official OpenAPI schema](https://api.runpod.io/v2/openapi.json).

## Verification

```sh
COATRIA_TEST_EMULATOR=1 node --import tsx --test tests/studio-host-provisioning.test.ts tests/studio-host-supervisor.test.ts
```

The fixture covers actual HTTP admin/origin/tenant gates, exact reviewed revisions and grants, replay without duplicate enrollment, late transaction rollback, one-submit uncertainty, discovery, independent repeated stop, expiry/revocation, key and ciphertext failures, disabled inference, exact environment identity, non-resetting quota and host journal namespaces. Provider transport is simulated; no keys from a real deployment or paid resources are used.
