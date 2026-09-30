# Reference worker deployment contract

The reference-service API, restricted broker role, worker, offline host package, disabled installer and credential-free qualification path are implemented in the candidate. A bundle is not a qualified or enrolled service. Production activation remains disabled until installed-host evidence is accepted, the separate registrar path exists, and the actual provider/storage workflow passes validation.

The reference worker receives only its finite `rfs_` service credential. Do not add it to the archive/gateway bootstrap: that bootstrap supplies a database URL and shared credential keyring, which the reference runner must reject. The application control plane retains OAuth and storage credentials.

## Artifact identities

These hashes have different meanings and must not be substituted for one another.

| Identity | Bytes or structure covered | Consumer |
| --- | --- | --- |
| Standalone bundle SHA-256 | Exact worker or qualifier `bundle.json` bytes emitted by the trusted builder | Component verification; this is not the runner's `releaseSha256` |
| Host bundle SHA-256 | Exact reference-host `bundle.json` bytes, including both standalone manifests and native/source inputs | Immutable release path and unit command `--bundle` |
| `releaseSha256` | Exact standalone `runtime.mjs` bytes | Runner configuration, qualification receipt and enrolled service |
| `hostConfigurationSha256` | Exact root-owned `host.json` bytes | Scope, UID/GID, profiles, units and installed component identities |
| Receipt `configurationSha256` | `referenceRunnerConfigurationHash`: domain-separated canonical configuration excluding only the qualification locator/hash | Qualification receipt verification |
| `profileSha256` | Exact decoder profile bytes, which pin the native closure and limits | Sandbox loader and enrolled service |
| Qualification SHA-256 | Exact accepted reference receipt bytes | Configuration `qualification.sha256` and enrolled service `qualification_sha256` |

The receipt locator/hash is excluded from the configuration identity to avoid a circular digest. Scope, origin, upload hosts, runtime path, scratch path, decoder profile, worker cgroup and deadline remain covered. Unit commands use a stable host path and host bundle hash; neither depends on final receipt bytes. Root acceptance computes the actual receipt byte hash. A caller-supplied `qualified: true` or an archive receipt cannot authorize enrollment.

## Required activation sequence

1. **Build and install immutable artifacts.** Build `reference` and `reference-qualification` from the same reviewed commit with `build-trusted-service-bundle.mjs`. `build-reference-host-bundle.mjs` combines those components with a verified native runtime export, pinned Node, decoder closure, launcher, source and original synthetic fixtures. It excludes runtime `node_modules`. `install-reference-host.mjs` defaults to a read-only plan and requires explicit root installation with hash-pinned scope. Installation requires prepared systemd, bubblewrap, enforcing AppArmor and an unused dedicated account; it does not install packages, add credentials or start services. One reference service is supported per host until per-service OS identities exist.
2. **Run credential-free qualification.** Explicitly start the installed service-specific qualifier. It verifies installed artifacts, actual Node path, UID/GID, loaded unit and delegated aggregate limits before running real isolation, resource, cleanup and prepared-image cases. A compiled child exercises supervisor death without a source loader. Qualification uses synthetic authority/storage and makes no provider requests. The worker's `--preflight` remains separate because it requires accepted evidence and an enrolled token.
3. **Accept evidence through a trusted operator path.** Run the compiled qualifier's root-only acceptance command with the exact reviewed evidence hash. Acceptance checks the full detailed report, immutable host identity and current successful retained systemd invocation, including its trusted journal emission. It rejects running, failed, stopped, stale-boot or previous-invocation evidence. Receipt replacement compares the exact previous receipt hash and retains history and detailed reports. Acceptance does not enroll or start work.
4. **Enroll once under separate registrar authority.** Validate trusted accepted evidence, current administrator sponsorship, exact company/projects, provider connection/catalog, storage binding/connection revisions and upload hosts. Insert the service and its project bindings atomically with one common deadline of at most 60 minutes. Create the opaque credential outside model context and store only its hash. An unresolved enrollment outcome requires reconciliation, not another service or token.
5. **Preflight, then start explicitly.** The worker must validate the immutable receipt and real sandbox and receive matching control-plane readiness before claiming. The normal application can list and revoke an exact service revision; it cannot enroll, extend, requalify or restart it. Keep concurrency one and stop admission on uncertain work or unconfirmed cleanup.

The registrar is not implemented by the ordinary application API or broker database role. Its future permissions and actual LOGIN tests must be reviewed independently. Readiness trusts the enrolled qualification identity; it does not independently authenticate a remote host or fabricate qualification evidence.

The host layout is `/var/lib/coatria-reference-releases/<host-bundle-hash>`, `/etc/coatria-reference/<service-id>` and `/var/lib/coatria-reference-worker/<service-id>`. The service parent is root-owned; private scratch and qualification directories are owned by the dedicated non-root identity. The runner accepts `--host <host.json> --bundle <host-bundle-hash> [--preflight]`; the old free-standing `--config` entry cannot bypass installed-host verification. The accepted v2 receipt binds the current boot, both UID and GID, both decoder profiles, all three unit definitions, qualifier invocation, host configuration and detailed evidence. The worker requires a separate root-owned enable marker and obtains current control-plane readiness before claiming.

## Acceptance evidence

- Altered runtime, closure, profile, unit, configuration, receipt, scope, upload hosts, boot or service identity must fail before a claim or provider request.
- Real PNG, JPEG and WebP must pass exact-byte full decoding through the reference worker. Malformed, wrong-kind, animated and oversized inputs must fail before allocation or sharing.
- Successful processing, errors, cancellation, expiry and supervisor termination must leave no active decoder descendants or private scratch before another claim. A cleanup error must stop the worker, even if a remote terminal receipt was already committed.
- Actual PostgreSQL LOGIN tests must prove enrollment authority and deny enrollment, extension and un-revocation to application, broker, archive and gateway identities.
- The finite pilot must prove exact storage read, inspection, separate human sharing consent, allocation, unchanged-byte upload and confirmation. Lost provider outcomes remain uncertain and cannot be replayed automatically.

Synthetic API fixtures, native decoder checks and CI success provide bounded component evidence. They do not establish provider upload-contract compatibility, live storage access, installed-host qualification or end-to-end production activation. Reference inspection also does not transform images or remove their metadata.
