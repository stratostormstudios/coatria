# Archive host deployment

Updated 2026-09-20. This is the operating contract for the host packaging
candidate. Check the exact candidate's systemd qualification result in
[PR #1](https://github.com/stratostormstudios/coatria/pull/1); this document does
not qualify a production archive host. CI proof applies to its tested VM and
code. Consult [release status](RELEASE_STATUS.md) and the
[media storage rollout record](MEDIA_STORAGE_ROLLOUT.md) for deployment evidence.

The archive host is a separate Linux CPU service. Vercel serves the application;
the storage gateway and selected Runpod S3 volume have their own deployment and
qualification. Installing this host neither provisions compute/storage nor starts
generation. The [archive workflow](HIGGSFIELD_ARCHIVES.md) still requires an exact
human-approved source and destination before any archive can run.

## Stages and authority

| Stage | Result | What remains disabled or unproved |
| --- | --- | --- |
| Offline runtime export | Pinned Node, dependencies, helper and decoder closure | No target-host qualification |
| Exact Git bundle | Source, runtime and file hashes in `bundle.json` | No installation or provider calls |
| Read-only plan | Reviewed paths, identities and complete unit contents | No host mutation |
| Explicit root install | Immutable release, profiles and three static units | No package installation, profile activation, daemon reload or service start |
| Systemd qualification and root acceptance | Per-run evidence and a bundle/boot-bound receipt | No credentials, provider transfers or worker activation |
| Database preflight | Current LOGIN, grants, scratch and decoder startup checks | No archive claimed; no S3 connectivity proof |
| Explicit worker start | One leased archive operation at a time | Application approvals and per-archive authority remain separate gates |

Runtime and bundle manifests include the empty `/proc` and `/dev` mount points
for both decoder profiles, with mode `0555`. Export, copy and installation
verify these directories as well as file contents. Rebuild earlier file-only
bundles: they omit mount points required after the decoder root becomes read-only.

## Prepare a suitable host

Use a Linux x64 VM with systemd as PID 1, systemd 254 or newer, unified cgroup v2
and working `cpu`, `memory` and `pids` delegation. The actual host must support
the namespaces, `close_range`, `cgroup.kill` and parent-death behavior exercised
by the [decoder canary](MEDIA_SANDBOX.md). An ordinary Runpod CPU Docker Pod is
not presumed to provide these facilities. No production VM has been selected here.

Before installation, an operator must separately prepare:

- An existing nonroot `coatria-archive` user and group, private service state and
  sufficient scratch disk for source inspection and stored-byte verification.
- The exact pinned Ubuntu bubblewrap package and executable, the reviewed ABI4
  AppArmor profile at `/etc/apparmor.d/coatria-bwrap-userns-restrict`, and both
  `bwrap` and `unpriv_bwrap` enforcing profiles. Keep the global unprivileged-userns
  restriction enabled. Follow the scoped [policy preparation](MEDIA_SANDBOX.md);
  do not disable AppArmor or replace an unknown loaded policy to make a test pass.
- `acl`/`getfacl`, and canonical root-owned package/configuration paths and ancestors
  without symlinks, worker write access, or extended/default ACLs. A shared writable
  checkout is not an installation source. The installer checks these conditions.

Exact Node/image, FFmpeg, bubblewrap and policy pins live in
[`archive-host-package.mjs`](../scripts/hosting/archive-host-package.mjs); the
[decoder guide](MEDIA_SANDBOX.md) records their acquisition and closure checks.
The service-wide cap is 2 GiB memory, no swap, 256 tasks and 200% CPU bandwidth.
Each decoder receives a smaller separately enforced cgroup. These are resource
ceilings, not throughput or available-disk guarantees.

## Produce and review an immutable bundle

Run the following on a reviewed Linux x64 builder. The capitalized shell variables
stand for operator-reviewed absolute paths or recorded digests; they contain no
credentials. `NODE` is a trusted builder Node executable. Both output directories
must be new, outside the source and input trees, with canonical parents.

```sh
"$NODE" "$SOURCE/scripts/hosting/export-archive-host-runtime.mjs" \
  "$SOURCE" "$PREPARATION_CONFIG" "$NPM_CACHE" "$NEW_RUNTIME"

"$NODE" "$SOURCE/scripts/hosting/build-archive-host-bundle.mjs" \
  "$SOURCE" "$EXACT_COMMIT" "$NEW_RUNTIME" "$RUNTIME_MANIFEST_SHA256" "$NEW_BUNDLE"

"$NODE" "$SOURCE/scripts/hosting/install-archive-host.mjs" \
  plan "$NEW_BUNDLE" "$BUNDLE_SHA256"
```

`PREPARATION_CONFIG` is the root-owned qualification configuration produced by
the explicit [media preparation](../scripts/hosting/prepare-media-sandbox-ci.mjs),
with its pinned setup evidence and real/conformance profiles. It is not a claim
that a target production host passed. The builder needs the exact Docker image
already cached and a complete npm tarball cache matching `package-lock.json`.

The [exporter](../scripts/hosting/export-archive-host-runtime.mjs) copies Node and
official npm from that cached image with `--pull never`; it does not run the
container. It installs dependencies into a fresh staging directory with
`npm ci --offline --ignore-scripts --include=dev`, and checks the prepared decoder
and helper hashes. A missing image or cache entry fails; there is no network
fallback or copy of a developer's mutable `node_modules`.

The [builder](../scripts/hosting/build-archive-host-bundle.mjs) reads the exact
40-character Git commit, verifies its dependency lock and helper/probe source
against the prepared runtime, and records the Git tree plus every installed file.
Record the returned runtime-manifest and bundle SHA-256 values independently.
Review the plan's source identity, destinations and unit contents. Transfer the
bundle through a trusted root-owned staging path and recheck its digest there.

## Install disabled, then qualify under systemd

Run the explicit installer using reviewed code and a trusted Node executable:

```sh
sudo "$NODE" "$SOURCE/scripts/hosting/install-archive-host.mjs" \
  install "$STAGED_BUNDLE" "$BUNDLE_SHA256"
sudo systemctl daemon-reload
sudo systemctl start coatria-archive-qualify.service
sudo systemctl show coatria-archive-qualify.service \
  --property=ActiveState,Result,ExecMainStatus,InvocationID
sudo journalctl -u coatria-archive-qualify.service --no-pager -n 30
```

Installation places the release at `/var/lib/coatria-archive-releases/<bundleSha256>`
and configuration under `/etc/coatria-archive`. The three units are
`coatria-archive-qualify.service`, `coatria-archive-preflight.service` and
`coatria-archive-worker.service`. They have no `[Install]` section, no automatic
restart and no automatic start. Installation refuses existing configuration or
unit files; it is not an in-place upgrade command.

The [systemd entry](../scripts/hosting/run-archive-host.mts) verifies the installed
bundle, executable, profiles, service identity and actual cgroup limits. Systemd
places the supervisor in its own delegated subgroup; decoders use capped sibling
groups. The host root cgroup is never delegated. Qualification receives no database
or provider credentials and runs ten hostile boundary/resource/cleanup cases plus
real PNG, JPEG, WebP, MP4, MOV, WAV and MP3 decoding through the installed boundary.

Each attempt writes a new directory:
`/var/lib/coatria-archive-state/qualification-<UUID>/`. Retain `qualification.json`
and `host-evidence.json`. The successful journal event gives the exact evidence
path and SHA-256. Review the companion proof hash, all test results, source/profile
hashes and current unit invocation before accepting:

```sh
sudo "$NODE" "$SOURCE/scripts/hosting/install-archive-host.mjs" \
  accept-qualification "$EVIDENCE_PATH" "$EVIDENCE_SHA256"
```

Acceptance requires the latest successful systemd invocation, current boot and
installed bundle. It creates root-owned `/etc/coatria-archive/qualified.json`;
it does not enable the worker. A failed canary or a standalone JSON assertion
cannot substitute for successful qualification.

After a reboot, or when deliberately renewing qualification, run the qualifier
again. Review the new evidence and supply the exact SHA-256 of the existing
`qualified.json` as the optional final argument to `accept-qualification`.
Replacement compares that digest and retains `qualified-<oldReceiptSha256>.json`.
An old-boot receipt is rejected. Preserve every attempt; an interrupted acceptance
can leave `accept.lock` and must be reconciled by the operator before proceeding.
Do not delete receipts or locks indiscriminately or reuse a receipt for new code.

## Configure secrets and run preflight

Have the host secret manager provision `/etc/coatria-archive/worker.env` as a
root-owned regular file, mode0600. Never place secrets in the bundle, journal,
shell command line or decoder environment. Systemd supplies the file to preflight
and worker units; the entry forwards only the required fields:

| Field | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated `coatria_higgsfield_archive_worker_v1` LOGIN, not an application/admin credential |
| `COATRIA_HOSTING_KEYRING` | Private decryption keyring matching encrypted provider/storage configuration |
| `COATRIA_HIGGSFIELD_OUTPUT_HOSTS` | Reviewed exact output-host allowlist, without wildcard or signed URLs |
| `COATRIA_ARCHIVE_MAX_SOURCE_BYTES`, `COATRIA_ARCHIVE_OPERATION_MS` | Optional bounded source-size and operation deadlines |
| `DATABASE_POOL_MAX` | Optional connection-pool limit |

The entry supplies fixed scratch, decoder profile/hash and delegated cgroup paths
from the installed bundle. It sets processing off for preflight and on only for
the separately gated worker mode; an environment value cannot bypass those gates.

Apply the reviewed migrations and
[dedicated worker permissions](../database/higgsfield-archive-worker-permissions.sql)
through a database administrator, then run:

```sh
sudo systemctl start coatria-archive-preflight.service
sudo systemctl show coatria-archive-preflight.service \
  --property=ActiveState,Result,ExecMainStatus
```

This invokes the actual worker's `--preflight`: it checks current/session LOGIN,
effective grants and ownership, migration entries through029, keyring, accessible
service-owned mode0700 scratch and real decoder startup, then closes its database
pool without claiming work. Unexpected elevated privileges fail. These are
point-in-time catalog checks; application/gateway migration floors, provider
connectivity and the complete database security model remain separate.

## Activate one reviewed pilot and operate it

Before activation, retain current host qualification and preflight evidence,
complete [selected-volume transport conformance](PROJECT_STORAGE_CONFORMANCE.md),
qualify the deployed gateway, and identify the exact current archive approval.
The [rollout record](MEDIA_STORAGE_ROLLOUT.md) tracks these remaining inputs.

Only after the operator authorizes processing, create the separate root-owned,
non-writable regular marker `/etc/coatria-archive/worker-enabled` and explicitly
start `coatria-archive-worker.service`. The application archive-approval feature
flag is a separate deployment decision. The marker, a passing health endpoint or
an enabled application flag is not evidence that a worker is running.

Use `systemctl stop coatria-archive-worker.service` to stop processing. SIGTERM
aborts the active operation; systemd's control-group cleanup covers descendants.
If a provider mutation may have happened, preserve its lease/receipt evidence and
reconcile it; do not restart uncertain multipart effects as new operations.
Stopping does not delete remote objects or end storage billing. Retire scratch
only after proving the exact attempt ended, with checked literal paths.

Units stay static across reboot. Requalify and accept the new boot, rerun preflight
and explicitly start again. For a new bundle or changed host policy/runtime,
stop the worker and prepare a separately reviewed replacement of the fixed units
and configuration; the current installer intentionally refuses silent upgrades.

The new [CI host qualifier](../scripts/hosting/qualify-archive-host-ci.mjs) is designed
to exercise actual systemd install-disabled behavior, two qualification runs,
receipt replacement, stale-boot rejection and the absent-marker start gate.
Require a passing result for the exact candidate. A synthetic stale boot is not
a physical reboot test; this lane has no database/provider credentials and proves neither
live preflight nor S3 transfer, production capacity, recovery or client delivery.
