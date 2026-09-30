# Reference worker deployment contract

The candidate implements the reference-service API, restricted broker role, worker, offline host package, disabled installer, credential-free qualification and separate operator registrar. A bundle is not a qualified or enrolled service. Production activation remains disabled until the actual installed host is qualified, its finite scope is enrolled, and the provider/storage workflow passes validation.

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
4. **Enroll once under separate registrar authority.** Use the compiled `reference-registrar` artifact and a reviewed scope file. The registrar revalidates accepted host evidence and locks current administrator sponsorship, exact project revisions and approvals, provider connection/catalog and storage binding/connection revisions. It inserts the service, project bindings and immutable enrollment identity in one transaction with a common deadline of at most 60 minutes. It creates the opaque credential locally, retains it in a root-only durable intent, and stores only its hash in the database. Independent reconciliation under the same transaction lock must confirm the complete tuple before `worker.env` is written. An unresolved outcome never authorizes another token or automatic insertion retry.
5. **Preflight, then start explicitly.** The worker must validate the immutable receipt and real sandbox and receive matching control-plane readiness before claiming. The normal application can list and revoke an exact service revision; it cannot enroll, extend, requalify or restart it. Keep concurrency one and stop admission on uncertain work or unconfirmed cleanup.

The registrar has a separate `coatria_higgsfield_reference_registrar_v1` LOGIN with metadata reads and bounded enrollment inserts. It cannot read provider/storage secrets or alter existing service authority. Its role provisioner verifies a fresh authenticated LOGIN; the PostgreSQL suite separately tests privileges, concurrent enrollment, lock waits and lost commit responses. Ordinary application and broker identities receive only the enrollment metadata reads they need. The service API requires the matching immutable enrollment, exact origin and current project/provider/storage revisions. Readiness trusts that database enrollment record; it does not independently authenticate a remote host or fabricate qualification evidence.

The host layout is `/var/lib/coatria-reference-releases/<host-bundle-hash>`, `/etc/coatria-reference/<service-id>` and `/var/lib/coatria-reference-worker/<service-id>`. The service parent is root-owned; private scratch and qualification directories are owned by the dedicated non-root identity. The runner accepts `--host <host.json> --bundle <host-bundle-hash> [--preflight]`; the old free-standing `--config` entry cannot bypass installed-host verification. The accepted v2 receipt binds the current boot, both UID and GID, both decoder profiles, all three unit definitions, qualifier invocation, host configuration and detailed evidence. The worker requires a separate root-owned enable marker and obtains current control-plane readiness before claiming.

## Operator enrollment

Build the separate `reference-registrar` entry from the same reviewed commit. Install its verified `bundle.json` and `runtime.mjs` under `/var/lib/coatria-reference-registrars/<registrar-bundle-hash>`. This is an operator artifact, excluded from the worker package. Use the installation's pinned Node executable; the CLI checks its own manifest, source/tree, dependency lock and runtime bytes against the qualified host.

The root-owned scope JSON has exactly `version: 1`, `enrolledBy`, `provider` and `projects`. Provider pins are `connectionId`, `connectionRevision` and the complete `catalogSha256`. Each project pins `projectId`, `projectRevision`, `storageBindingId`, `storageBindingRevision`, `storageConnectionId` and `storageConnectionRevision`. Its project order must match the installed host. Review these values and pin the exact scope file bytes with SHA-256; changing an approval or revision requires a new reviewed scope and finite service installation.

```text
<pinned-node> /var/lib/coatria-reference-registrars/<registrar-sha>/runtime.mjs plan \
  --host /etc/coatria-reference/<service-id>/host.json \
  --bundle <host-bundle-sha> --registrar-bundle <registrar-sha> \
  --scope /root/reviewed-scope.json --scope-sha256 <scope-sha>
```

`plan` is the default and does not connect to PostgreSQL or create a credential. Explicit `enroll` uses those same flags. Explicit `reconcile` uses only the host and two bundle flags, loading the exact retained intent even after expiry. Enrollment and reconciliation accept bounded JSON containing `connectionString` through a protected stdin stream, never command arguments or environment variables. The connection must authenticate as the dedicated registrar role, with verified TLS for remote Neon access. Keep credentials outside model context and logs.

The root-only `enrollment` directory retains `token`, `host.json`, `qualified.json`, `intent.json` and append-only outcome events. An OS-backed exclusive lock serializes host operations and releases on process death. Partial files remain for investigation; the CLI neither deletes nor replaces the credential. A lost commit response triggers a fresh LOGIN reconciliation under the original database lock. A missing tuple is conclusive only after that lock is acquired. Conflicting or partial tuples fail closed.

Only a complete, active database enrollment plus a fresh check of local qualification permits publishing the retained token to `worker.env`. Expiry, revocation, changed authority or stopped qualifier prevents publication. Reconciliation does not extend authority, create an enable marker or start/reload a service. No production service has been enrolled by the candidate implementation.

## Acceptance evidence

- Altered runtime, closure, profile, unit, configuration, receipt, scope, upload hosts, boot or service identity must fail before a claim or provider request.
- Real PNG, JPEG and WebP must pass exact-byte full decoding through the reference worker. Malformed, wrong-kind, animated and oversized inputs must fail before allocation or sharing.
- Successful processing, errors, cancellation, expiry and supervisor termination must leave no active decoder descendants or private scratch before another claim. A cleanup error must stop the worker, even if a remote terminal receipt was already committed.
- Actual PostgreSQL LOGIN tests must prove enrollment authority and deny enrollment, extension and un-revocation to application, broker, archive and gateway identities.
- The finite pilot must prove exact storage read, inspection, separate human sharing consent, allocation, unchanged-byte upload and confirmation. Lost provider outcomes remain uncertain and cannot be replayed automatically.

Synthetic API fixtures, native decoder checks and CI success provide bounded component evidence. They do not establish provider upload-contract compatibility, live storage access, installed-host qualification or end-to-end production activation. Reference inspection also does not transform images or remove their metadata.
