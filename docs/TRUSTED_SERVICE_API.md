# Trusted archive and gateway CPU services

These operator APIs create fixed, separately scoped archive and gateway services. They do not enroll agents, start inference endpoints, accept arbitrary images, commands, URLs, environment variables or credentials, or grant agent spending authority. The source remains disabled until reviewed presets, dedicated LOGIN roles, immutable bootstrap artifacts and server credentials are installed. A running Pod alone does not verify a working service.

All public paths are under `/api/companies/{companyId}/studio/trusted-services`. Every read and mutation requires an authenticated human company owner or administrator; mutations require the normal same-origin and optional `X-Coatria-User` identity assertion. Authority is checked again inside database transactions. Agent bearer tokens have no route into this API. Mutation rate is 12 requests per user/company per minute.

| Method and suffix | Strict body | Result |
| --- | --- | --- |
| `GET /` | None | `{provisions, readiness:{archive,gateway}}`, newest 50 |
| `POST /` | `{clientId:UUID, service:"archive"|"gateway"}` | `{provision,replayed}`, 201 new / 200 replay; no provider effect |
| `GET /{id}` | None | `{provision}` |
| `POST /{id}/start` | `{clientId:UUID,revision:integer,planHash:SHA256,acknowledgeCharges:true}` | `{provision,replayed}`; exact reviewed approval commits before provider I/O |
| `POST /{id}/stop` | `{clientId:UUID,revision:integer}` | `{provision,replayed}`; durable stop intent; provider readback must confirm termination |
| `POST /{id}/reconcile` | `{clientId:UUID}` | `{provision}`; repeats observation/stop safely; never retries an ambiguous create |

Use one client ID per logical plan/start/stop request and preserve it across network retries. Changed payloads with the same ID return `409 IDEMPOTENCY_CONFLICT`. Reconciliation IDs are validated request identifiers, not execution receipts; reconciliation is itself safe to repeat. Stale revisions or hashes return `409 SERVICE_PLAN_CONFLICT`. Approval expires after ten minutes or at the installed absolute service deadline, whichever comes first. Plan creation requires that deadline to be between one minute and 24 hours away. A plan is not an approval.

The public provision projection contains `id`, `companyId`, `service`, `revision`, `phase`, `plan`, `planHash`, `podId`, `providerStatus`, `expiresAt`, `stopRequestedAt`, `submittedAt`, `lastReconciledAt`, `errorCode`, `createdAt`, `computeStopped`, `serviceVerified`, `billingVerified`, `credentialsRevoked`, and `readiness`. It excludes private environment values and hashes, raw preset/bootstrap/configuration contents and credentials. `serviceVerified`, `billingVerified` and `credentialsRevoked` remain false; independent operational evidence must establish them. `computeStopped` describes only this requested compute lifecycle, not storage deletion or billing settlement.

Phases are `planned`, `approved`, `submitting`, `uncertain`, `provisioning`, `running`, `stopping`, `stopped`, `failed`, and `needs_attention`. One active service of each kind per company is allowed. The stored source/bootstrap/configuration hashes, ephemeral disk, region, CPU profile and approved plan are immutable to the application database role. Create intent is committed before the sole provider POST. Missing or lost responses require bounded discovery and full provider identity/environment-hash verification. An absent discovery result never authorizes a replacement. Identity mismatch requires operator investigation; it never authorizes stopping foreign compute.

Services use separate ephemeral 10 GB container disks with no network/persistent volumes. Archive scratch is temporary; durable authority and journals live in PostgreSQL and media stays on existing S3 storage.

The finite CPU reservation covers remaining deadline time plus five minutes at the reviewed maximum hourly price. Reservations are never refunded or reset by stopping, retrying, changing preset IDs or renewing expiry. The allowance is per company/service across retained history and is capped at $5 per service in configuration. This is an admission budget, not a guaranteed cloud billing cap. Storage, decoder VMs and inference are explicitly excluded. Absolute process cutoff plus the lifecycle reconciler are required; provider failures can delay stopped-state confirmation.

`GET /api/internal/trusted-services/reconcile` requires the exact server-only `CRON_SECRET` bearer value. It handles at most two leased services per call, prioritizing stop requests and expired deadlines. The lifecycle key stays on the application server. Only the archive receives the separate executor token; the gateway receives neither provider key. Both receive the existing encryption keyring and their own dedicated database LOGIN credential. Credentials are injected directly in server memory and only hashes are stored in lifecycle rows. Database roles are not created by this API.

The gateway's public URL is configured separately after verified provider identity and HTTP checks. No custom DNS or TLS is assumed. Stored readiness checks configuration presence, not network reachability, migration/role preflight success, receipt qualification, transfer conformance or end-to-end archive success.

Runtime grants: `trusted_service_provisions` SELECT/INSERT plus UPDATE only lifecycle columns; `trusted_service_reservations` and `trusted_service_requests` SELECT/INSERT only. No DELETE grants. Neither the archive nor gateway LOGIN receives these provisioning tables. Deployment, migration, credential installation, provider provisioning and production conformance remain separate reviewed release steps.
