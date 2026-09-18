# Managed Studio host pilot

Coatria can enroll reviewed Studio agent installations into a company-scoped credential broker. The broker issues encrypted, revocable credentials to one leased supervisor. The companion `scripts/hosting/run-studio-host.mjs` runs the existing HTTP agent harness for those identities on a Runpod CPU Pod; its inference requests use the separately configured Runpod GPU endpoint.

Registering a host or enrolling identities does not create a Pod, start a worker, or call an inference provider. Starting the supervisor is a separate operator deployment. Once a supervisor is running, approved active missions and queued runs can consume inference under their existing limits. This is a bounded pilot, not an automatically provisioned production fleet.

## Supported scope

- One company per registered host, one current host binding per agent.
- At most three active, unexpired host registrations per company; one to eleven agent bindings per host.
- Absolute host expiry from one minute to 24 hours after registration. Restarts never extend it.
- Reviewed installation IDs and exact revisions; enrollment explicitly activates the selected identities and rotates their credentials. It does not add capabilities, alter model settings, or copy private skills.
- Broker validation supports curated HTTP provider adapters. CLI Codex and Claude Code installations require a separate executable runtime and are rejected by this host enrollment path.
- The shipped supervisor is narrower than the broker: its host must approve only `runpod`, every installation must use the curated `runpod` plugin, and the operator pins one model and endpoint. Other HTTP providers need a separately reviewed supervisor configuration.
- Supervisor concurrency defaults to one and is capped at two. Each agent retains its existing run lease, invocation policy, capabilities, and inference limits.

## Administrator workflow

Use an authenticated owner or administrator session. Company membership and current revisions are checked inside the write transaction.

| Endpoint | Operation |
| --- | --- |
| `GET /api/companies/{companyId}/studio/hosts` | List up to 50 recent host registrations and `encryptionConfigured`. |
| `POST /api/companies/{companyId}/studio/hosts` | Register a named host, capacity, provider allowlist, and absolute expiry. |
| `GET /api/companies/{companyId}/studio/hosts/{hostId}` | Read the host and credential binding metadata. |
| `POST /api/companies/{companyId}/studio/hosts/{hostId}/enroll` | Activate and enroll the exact reviewed installation revisions. |
| `POST /api/companies/{companyId}/studio/hosts/{hostId}/revoke` | Revoke the host and invalidate its currently issued agent credentials. |

Registration input:

```json
{
  "clientId": "<UUID>",
  "name": "Studio pilot",
  "maxAgents": 3,
  "providerIds": ["runpod"],
  "expiresAt": "<absolute ISO timestamp within 24 hours>"
}
```

The first successful response includes `hostToken`. It is a one-time `ch_` bearer secret: the database stores only its SHA-256 hash. A retry with the same request ID and body returns the registration with `hostToken: null`; it never recovers the secret. If the first response is lost, revoke the registration and create a replacement. Do not put the secret in source files, logs, URLs, or model context.

Enrollment input:

```json
{
  "clientId": "<UUID>",
  "revision": 1,
  "activateAgents": true,
  "installations": [
    { "installationId": "<UUID>", "revision": 1 }
  ]
}
```

Enrollment checks the host, installation, provider, model, sponsor, invocation policy, and capabilities before changing anything. It rotates each selected credential, increments the installation revision, caps the token expiry to the host expiry, and cancels the agent's old queued or running runs. Binding an agent to another host replaces its previous host binding. Installation or host revision conflicts require a fresh review; retries of the same completed request replay metadata without rotating again.

Responses expose names, IDs, versions, capabilities, and connection state. They do not expose encrypted token fields or agent plaintext credentials. `startsWorkers: false` and `startsInference: false` describe the enrollment operation itself, not the future behavior of a separately started supervisor.

Revocation input is `{ "clientId": "<UUID>", "revision": <current host revision> }`. Revocation remains available when the encryption key is unavailable or the host has already expired. It pauses, expires, and rotates agents whose current credentials still belong to that host and cancels their queued/running runs. An agent manually rotated out of managed hosting is left under that explicit manual configuration.

## Supervisor protocol

The host bearer is accepted only at the host endpoints; it is not an agent token or administrator session.

`GET /api/host/identity` returns `{ host, serverTime }`.

`POST /api/host/credentials` accepts:

```json
{ "supervisorId": "<durable UUID>", "leaseEpoch": 1 }
```

`leaseEpoch` can be omitted on the initial pull. The response contains:

```text
host: the pinned company host and absolute expiry
supervisor: { id, epoch, expiresAt }
credentials: [{
  agentId, installationId, name, credentialVersion,
  installationRevision, agentToken, expiresAt, capabilities,
  runtime: { pluginId, manifestVersion, runtimeConfig, character }
}]
unavailable: [{ agentId, reason }]
pollAfterSeconds: 20
```

Credential `expiresAt` is the absolute host expiry. Supervisor `expiresAt` is the independent, shorter lease deadline. Both must be enforced. A lease lasts at most 60 seconds and never passes the host expiry. Refresh every 20 seconds; the provided supervisor stops on an uncertain or rejected renewal and arms a hard deadline before lease expiration.

Only one supervisor owns a live lease. Another supervisor receives `HOST_LEASE_HELD`; a stale supplied epoch from the current supervisor receives `HOST_LEASE_LOST`. A takeover after expiry advances the epoch, rotates still-valid credentials, increments their installation revisions, and cancels old work. The first credential pull also advances from the enrollment epoch to the first leased epoch. The supervisor must use returned credential versions and installation revisions rather than assume enrollment metadata is still current.

Same-supervisor, same-epoch renewals preserve tokens. The supervisor persists its identity, epoch, original deadline, and per-agent receipt journals on private storage. It validates the run context against each returned installation ID, revision, provider configuration, persona, company, agent, and approved capabilities before invoking inference. A rotated credential gets a separate durable journal; previous uncertain receipts are retained for reconciliation.

The broker does not send provider keys. Supply the approved Runpod key and endpoint privately to the CPU Pod. The supervisor does not accept arbitrary commands, downloaded plugins, shell tools, or model-selected provider URLs through broker responses.

## Authority and revocation

Every pull freshly verifies the host creator, enrollment administrator, agent sponsor, membership, installation revision, configuration digest, credential hash, agent status, and expiries. A paused installation, disabled invocation, changed configuration, or manual rotation is reported as unavailable. The broker never silently repairs those settings or reactivates them during renewal; a fresh explicit enrollment is required.

Managed agent authentication also requires a matching live host binding and supervisor lease. This is enforced on ordinary agent authentication and again inside transactional run, conversation, mission, tool, and staffing authority checks. Those transactions include the host creator and enrollment administrator in their sorted membership locks before locking the agent. A cached agent identity alone cannot authorize a later write after its host authority has ended.

Authority reads hold a shared company host-control advisory lock before discovering these principals. Enrollment, rehosting, credential takeover, and revocation take the exclusive form. This keeps the binding stable between principal discovery and the final transactional authority check while allowing independent agent transactions to proceed concurrently.

Manual plugin token rotation changes the current agent hash, making the old managed copy unusable. The new manually issued token follows ordinary agent authority. Host revocation deliberately does not revoke that separate manually issued token. Pausing or changing plugin configuration invalidates the old hosted binding; simply resuming the plugin does not restore a stale binding.

Missing keys or ciphertext integrity failure cause the credential transaction to roll back, including lease renewal and token rotations. Previously issued tokens can retain authority only until the existing lease deadline, at most 60 seconds; encryption configuration failure is not an instantaneous global revoke. Use the revoke endpoint for the explicit kill switch.

## Encryption configuration and operations

Set `COATRIA_HOSTING_KEYRING` as a private server environment variable:

```json
{
  "activeKeyId": "v1",
  "keys": {
    "v1": "<canonical base64 encoding of 32 cryptographically random bytes>"
  }
}
```

The parser accepts one to five keys. Key IDs contain only letters, digits, underscores, and hyphens. There is no generated fallback. The application must fail closed when this configuration is absent, invalid, or lacks a required historical key.

Tokens use AES-256-GCM with fresh 12-byte nonces and 16-byte authentication tags. Authenticated additional data binds the ciphertext to company, host, agent, credential version, installation ID/revision, supervisor epoch, and exact approved configuration digest. A database ciphertext transplant or metadata alteration cannot produce a credential for a different binding. Plaintext agent tokens are returned only to the freshly authenticated leased host; activity and replay receipts contain metadata only.

To rotate an encryption key, add the new key while retaining the old one, set the new `activeKeyId`, and explicitly re-enroll the selected installations at current revisions. Verify the new credentials are working and all affected rows use the new key before removing the old key. Re-enrollment cancels old work, so coordinate it with the operator. Keep recovery key material outside the repository and database. Losing an old key makes its remaining encrypted credentials unusable; revocation and replacement enrollment remain the recovery path.

## Deployment and verification

Apply `database/015_studio_hosting.sql` and its runtime database grants before deploying code that queries `agents.managed_token_hash`. Deploy the broker, API routing, and all managed-agent authority predicates together. Configure the server keyring before enrollment. The host bootstrap must use reviewed immutable source hashes, private persistent state, explicit origin/company/host/model/deadline, and no public inbound ports.

The host tests exercise migrated database state and the real HTTP handlers, including tenant isolation, exact-revision enrollment rollback, one-time registration, encrypted replay safety, same-epoch renewal, lease takeover, ciphertext/AAD failure, missing keys, manual rotation/pause, sponsor loss, expiry, cached authority rejection, staffing source revalidation, and revocation. A separate real-PostgreSQL subtest checks shared/exclusive host-control fencing and principal membership locks; it is skipped under PGlite because one connection does not prove concurrent lock scheduling. Supervisor tests separately exercise scheduling, hard lease/deadline stops, configuration binding, durable state, and inference cancellation with injected transports; they do not call a billed provider.

Remaining production work includes automated provisioning and reaping, reviewed immutable worker images, managed secret injection, fleet cost and concurrency quotas, operational monitoring, failover/load tests against real PostgreSQL, and a durable operator key-rotation procedure. Provider-side cancellation and Pod shutdown remain separate from revoking Coatria authority; a process stop must not be described as proof that every external provider charge has ended.
