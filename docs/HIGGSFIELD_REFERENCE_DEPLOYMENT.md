# Reference worker deployment contract

The reference-service API, restricted broker role, worker and offline bundle are implemented. A bundle is not a qualified or enrolled service. Production activation remains disabled until the dedicated installer, trusted qualification acceptance and enrollment path described here exist and pass actual-host validation.

The reference worker receives only its finite `rfs_` service credential. Do not add it to the archive/gateway bootstrap: that bootstrap supplies a database URL and shared credential keyring, which the reference runner must reject. The application control plane retains OAuth and storage credentials.

## Artifact identities

These hashes have different meanings and must not be substituted for one another.

| Identity | Bytes or structure covered | Consumer |
| --- | --- | --- |
| Bundle SHA-256 | Exact `bundle.json` bytes emitted by the trusted builder | Release verification; this is not the runner's `releaseSha256` |
| `releaseSha256` | Exact standalone `runtime.mjs` bytes | Runner configuration, qualification receipt and enrolled service |
| Command-line `--sha256` | Exact serialized configuration file bytes | Immutable runner startup |
| Receipt `configurationSha256` | `referenceRunnerConfigurationHash`: domain-separated canonical configuration excluding only the qualification locator/hash | Qualification receipt verification |
| `profileSha256` | Exact decoder profile bytes, which pin the native closure and limits | Sandbox loader and enrolled service |
| Qualification SHA-256 | Exact accepted reference receipt bytes | Configuration `qualification.sha256` and enrolled service `qualification_sha256` |

The receipt locator/hash is excluded from the configuration identity to avoid a circular digest. Scope, origin, upload hosts, runtime path, scratch path, decoder profile, cgroup and deadline remain covered. Root acceptance must compute the actual receipt byte hash; a caller-supplied `qualified: true` or an archive receipt cannot authorize enrollment.

## Required activation sequence

1. **Build and install immutable artifacts.** Build `reference` from the reviewed commit with `build-trusted-service-bundle.mjs`. A dedicated installer must also pin the Node executable, native decoder closure, launcher, bubblewrap/AppArmor policy, synthetic fixtures, qualifier and service unit definitions. Use a dedicated non-root identity and root-owned immutable release/configuration files. Installation must leave work disabled and supply no credentials.
2. **Run credential-free qualification.** Prove isolation, aggregate resource limits, descendant cleanup and real prepared-image processing in the actual installed service boundary. Bind the executing runtime, source, profile, configuration, current boot, UID/GID, service definition and delegated cgroup. The existing runner's `--preflight` cannot perform this initial qualification because it already requires a receipt and enrolled service.
3. **Accept evidence through a trusted operator path.** Validate the exact evidence hash and the current successful retained systemd qualification invocation. Reject running, failed, stale-boot or previous-invocation evidence. Receipt replacement must compare the exact previous receipt hash and retain its history. Acceptance must not automatically start work.
4. **Enroll once under separate registrar authority.** Validate trusted accepted evidence, current administrator sponsorship, exact company/projects, provider connection/catalog, storage binding/connection revisions and upload hosts. Insert the service and its project bindings atomically with one common deadline of at most 60 minutes. Create the opaque credential outside model context and store only its hash. An unresolved enrollment outcome requires reconciliation, not another service or token.
5. **Preflight, then start explicitly.** The worker must validate the immutable receipt and real sandbox and receive matching control-plane readiness before claiming. The normal application can list and revoke an exact service revision; it cannot enroll, extend, requalify or restart it. Keep concurrency one and stop admission on uncertain work or unconfirmed cleanup.

The registrar is not implemented by the ordinary application API or broker database role. Its future permissions and actual LOGIN tests must be reviewed independently. Readiness trusts the enrolled qualification identity; it does not independently authenticate a remote host or fabricate qualification evidence.

## Acceptance evidence

- Altered runtime, closure, profile, unit, configuration, receipt, scope, upload hosts, boot or service identity must fail before a claim or provider request.
- Real PNG, JPEG and WebP must pass exact-byte full decoding through the reference worker. Malformed, wrong-kind, animated and oversized inputs must fail before allocation or sharing.
- Successful processing, errors, cancellation, expiry and supervisor termination must leave no active decoder descendants or private scratch before another claim. A cleanup error must stop the worker, even if a remote terminal receipt was already committed.
- Actual PostgreSQL LOGIN tests must prove enrollment authority and deny enrollment, extension and un-revocation to application, broker, archive and gateway identities.
- The finite pilot must prove exact storage read, inspection, separate human sharing consent, allocation, unchanged-byte upload and confirmation. Lost provider outcomes remain uncertain and cannot be replayed automatically.

Synthetic API fixtures, native decoder checks and CI success provide bounded component evidence. They do not establish provider upload-contract compatibility, live storage access, installed-host qualification or end-to-end production activation. Reference inspection also does not transform images or remove their metadata.
