# One-job cloud renderer pilot

This runtime hosts the existing Coatria procedural Blender worker on a separate Linux CPU Pod. It executes only `coatria-product-turntable-v1` version 1, then publishes its sealed output through the private media API. It does not accept client scenes, arbitrary Python, shell commands, URLs, render engines or model-selected executables. Publication verifies stored bytes; it does not promote a studio version, approve creative quality, accept a task or contact a client.

The implementation and synthetic tests are available. **Linux Blender installation, cloud rendering, cloud cancellation/recovery and provider shutdown still require an observed trial.** Earlier real Blender evidence used local Windows 5.2.0; it is not evidence for this Linux 5.2.2 runtime.

## Operator contract

Use a dedicated company connector containing exactly the unmodified `EXECUTION_BUILTIN_PROFILES` product-turntable profile. Queue one human-approved pilot job on this connector, preferably four 384×384 EXR frames. Claims are connector-wide FIFO: there is no exact-job selector. Do not share this connector with other renderer processes or other queued work.

The only private runtime inputs are:

| Environment | Meaning |
|---|---|
| `COATRIA_RENDER_COMPANY_ID` | Exact company UUID |
| `COATRIA_RENDER_CONNECTOR_ID` | Exact execution connector UUID |
| `COATRIA_RENDER_EXPIRES_AT` | Absolute UTC deadline, at most 24 hours ahead |
| `COATRIA_EXECUTION_TOKEN` | That connector's `ce_` credential |

The origin is fixed to `https://coatria.com`. `COATRIA_BASE_URL`, if supplied directly to the wrapper, must match it exactly. Output is fixed to `/state/renderers/<company UUID>/<connector UUID>`; Blender is fixed to `/opt/coatria/blender-5.2.2/blender`. A fresh pilot should receive a fresh connector/namespace. The prior connector's state is retained for reconciliation, never reset to authorize another job.

The connector's expiry must cover the entire host deadline. The producing agent, sponsor, role and managed host must also remain authorized through rendering **and publication**; completed-job media APIs recheck producing authority. Keep the producing agent host alive until publication finishes. No Runpod lifecycle key, inference key, Blob credential, database URL or inherited `NODE_OPTIONS` enters the renderer child environment. Installer commands and Blender receive no connector credential.

## Build the reviewed bootstrap

After committing and pushing the exact reviewed source, call:

```js
import {buildRendererBootstrap} from './scripts/hosting/build-renderer-bootstrap.mjs';
const artifact = await buildRendererBootstrap({commit: '<full reviewed commit SHA>', root: process.cwd()});
// Store artifact.image, artifact.args, artifact.manifest and their hashes privately
// as the reviewed provider configuration. Building this object spends nothing.
```

The builder pins the existing official Node 24.19.0 bookworm-slim Linux/amd64 image digest, 12 exact source/dependency files and their LF-normalized SHA256 hashes. It preserves their module layout; combining the renderer, publisher and worker into one JS file would change their file-relative Python lookup and executable-main checks.

The dedicated lock installs only `tsx@4.23.13`, `zod@4.5.4` and their locked transitive dependencies with `npm ci --ignore-scripts --no-audit --no-fund`. Optional platform esbuild packages remain included, because the TypeScript loader resolves their binary without running the package install script. Next, React, database clients and provider SDKs are unnecessary.

The bootstrap streams this official archive, enforcing both exact size and SHA256 before extraction:

- [Blender 5.2.2 Linux x64](https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz): 383,295,504 bytes.
- [Published checksum](https://download.blender.org/release/Blender5.2/blender-5.2.2.sha256): `84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168`.

It installs a fixed list of Debian runtime library names, checks `ldd` for unresolved libraries, starts Blender headlessly to check version/Cycles availability, and checks that the worker modules import. These are startup checks, not a rendered-frame canary. Debian package versions are recorded in `renderer-runtime-packages.txt`; they are resolved from the image's signed repositories at installation time, **not version-frozen**. For repeatable production startup, build and validate this runtime into a separate image, review the package inventory and pin that final image digest. Never claim the bootstrap is a fully reproducible container image.

Installation is bounded to 10 minutes and the absolute host deadline. An interrupted archive/extraction or unexpected existing source fails closed rather than replacing evidence. Initial installation may consume enough of a short paid window that the wrapper deliberately declines a new claim.

On a retained container layer, the bootstrap checks the archive receipt and executable digest before reusing Blender. It trusts the rest of the previously extracted root-owned tree; it does not rehash every cached library or color file. The renderer records the actual OCIO bundle hashes in each output manifest. Suspected root-level modification requires discarding/rebuilding the container layer while retaining the separate private state volume.

## Pod and independent cutoff

Provision a separate secure CPU Pod; the existing agent-host 2-vCPU/4-GB preset is not this renderer preset. A starting test allocation is 4 vCPUs/8 GB with current two-thread rendering, subject to observed capacity and price verification. Blender's [Linux requirements](https://www.blender.org/download/requirements/) specify SSE4.2 and glibc 2.28 or newer. The bootstrap rejects a host without SSE4.2. No GPU, X server or open port is required for this [headless CPU render](https://docs.blender.org/manual/en/latest/advanced/command_line/render.html).

Use an approved network volume mounted at `/state`, container disk large enough for the compressed/extracted distribution and dependencies (10 GB is a starting allocation), `ports: []`, `startSsh: false`, `startJupyter: false`, and the exact reviewed image/start arguments. The bootstrap rejects a symlink or root-filesystem `/state` mount and drops the worker to UID/GID 1000. State/output directories use 0700 and private journals 0600. A network volume survives Pod replacement; container disk is not durable evidence. [Runpod storage](https://docs.runpod.io/pods/storage/types)

**Process exit is not a verified billing stop.** Before any trial, an independent Coatria server reaper must hold the exact Pod ID, reviewed configuration hash, company/connector identity and immutable expiry. It must reconcile creation uncertainty without repeating an unproven create, verify the returned resource matches the reviewed CPU/image/volume/environment, issue a provider stop at expiry or terminal completion, and read back the provider state. Provider credentials stay on that server. Reserve startup/render/grace CPU allowance explicitly; storage is separate and a time/price reservation is not proof of an invoice cap. This runtime contains no provider lifecycle calls and supplies no UI provisioning subsystem.

## Single-job and recovery semantics

`run-renderer-host.mts` persists a hash binding of origin/company/connector/credential plus the immutable deadline before any request. It verifies current connector identity, expiry and the exact reviewed profile. It persists the first claimed job before exposing its lease to the renderer. Completion/failure ends this host; restart of a terminal journal performs no HTTP request. A crash between worker completion and the wrapper's final journal cannot cause another job claim: absent exact pending evidence, it stops for reconciliation.

The wrapper admits a new job only with at least 15 minutes left, allowing the fixed profile's maximum 600-second render and an initial publication window. This is admission headroom, not an upload latency guarantee. The hard expiry can interrupt a job or upload. A typical first host window is 30 minutes to include cold installation; keep actual pricing approval separate.

Pending publication stays bound to the original job and uses the worker's existing durable, finite retry budget. The wrapper waits for its saved retry time before trying that same journal again. It never clears interrupted renderer state or requeues uncertain work. `SIGTERM`, `SIGINT`, operator abort and the deadline abort the worker; the renderer terminates its owned process tree. Cleanup has a bounded wait. If cleanup is unconfirmed, the private host lock remains and the process exits with failure; the server must stop the Pod. Stale locks and interrupted `rendering`/`uncertain` states require operator reconciliation, not automatic fleet failover.

The root bootstrap separately supervises shutdown: it sends `SIGTERM`, escalates to `SIGKILL` after eight seconds and allows two further seconds to confirm exit. If the child still does not report exit, the root parent returns failure rather than waiting indefinitely. It never clears the child's private journal or lock after forced termination. The provider reaper remains required even with this parent-process bound.

## Verification and release gate

`tests/renderer-host.test.ts` covers fake-transport/cycle lifecycle boundaries plus the actual worker's failed-start protocol. It checks one-job persistence/restart, publication wait/retry, identity and credential binding, forbidden origin, expiry, cancellation, incomplete cleanup, bounded response/archive bodies, exact archive digest/size, and bootstrap/dependency pins. Those tests perform no provider calls and do not establish Linux compatibility.

The independent `renderer-linux` CI job uses the same pinned official Node Debian container, the exact official Blender archive size/hash, fixed runtime library names and the isolated locked dependency tree. `prepare-renderer-canary.mjs` records the source hashes, installed package versions and linked libraries. `renderer-linux-canary.mts` then renders four actual 128×128 ACEScg EXR frames at 24000/1001 fps, checks the native `.blend`, PNG preview, decoded finite pixels, Blender build and OCIO evidence, and replays the sealed job without a second render. Its `coatria-linux-renderer-<run ID>` artifact retains `canary.json`, source/setup evidence, the actual synthetic native scene, EXRs and preview for 14 days. No company connector, Coatria endpoint, provider API or client material is used. CI success establishes this small Linux render, not Runpod host provisioning, storage recovery, publication or billing shutdown. Treat the new job as pending until its actual result and artifact are observed.

Before calling this operational, run the reviewed Linux runtime with the small approved four-frame job and observe:

1. Exact company/connector claim, live heartbeat and one render attempt.
2. Blender 5.2.2/Cycles CPU evidence, decoded finite EXR frames, native scene, preview, OCIO hashes and rational frame metadata.
3. All seven output files uploaded and server-verified, with no duplicate publication records after receipt replay.
4. Private preview access and preserved human promotion/review boundaries.
5. Controlled cancellation, durable pending-publication restart and refusal to run a second job.
6. The independent reaper's exact provider stop/readback and retained private volume.
