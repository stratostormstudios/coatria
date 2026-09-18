# Controlled Blender execution

Coatria now has a working **procedural product-turntable** execution profile. It generates original geometry, materials, lighting and animation in Blender, saves a native `.blend`, renders an EXR image sequence, and produces a PNG review image. This is a small real rendering capability; it does not load arbitrary client scenes, composite supplied footage, or provide Nuke/Houdini integration.

The implementation is [renderer.mts](../scripts/vfx/renderer.mts), the reviewed [product_turntable.py](../scripts/vfx/product_turntable.py), and the scoped [execution worker](../scripts/vfx/worker.mts). Backend connector declarations use the canonical `EXECUTION_BUILTIN_PROFILES` entry in [studio-execution-protocol.ts](../src/lib/studio-execution-protocol.ts).

## Profile and output contract

`coatria-product-turntable-v1`, version 1, consumes **no external inputs**. Its company execution profile declares `inputKinds: []`; requests must contain no input references. An agent cannot supply a shell command, Python program, Blender executable, native file path, texture URL or output directory. The operator selects the executable and root directory outside the job JSON.

| Property | Implemented bound |
| --- | --- |
| Engine | Blender Cycles, CPU, two render threads |
| Frames | Inclusive range of at most 24; frame identities 0–10,000,000 |
| Image dimensions | 16–1,024 pixels on either axis |
| Aggregate image size | At most 8,000,000 pixels over the whole requested range |
| Frame rate | Exact numerator/denominator, effective rate 1–60 fps |
| Working space | Explicit `Linear Rec.709` or `ACEScg` |
| EXR output | RGBA, 16-bit floating-point, ZIP compression, scene-linear |
| Review PNG | sRGB display with AgX view transform; separate from EXR working space |
| Sampling | 1–64 locally; connector worker uses the reviewed value 16 |
| Process timeout | At most 600 seconds; connector also retains its approved profile timeout |
| Connector output limit | Canonical profile 512 MiB; verified before completion |

The output directory is `<operator-root>/<job-uuid>/attempts/0001/`. A successful attempt includes:

- `scene.blend`, the real editable scene containing the procedural geometry and animation.
- `frames/frame-0001.exr` and subsequent exact requested frame identities.
- `review.png`, a preview of the first requested frame.
- `blender-evidence.json`, the Blender version/build, actual working space, rational frame rate, successful decoded-frame checks, and bundled OCIO configuration/transform hashes.
- `manifest.json`, exact relative paths, byte lengths, SHA-256 values, dimensions and frame identities, plus the job and reviewed Python profile hash.
- `report.json`, the result, elapsed time and manifest digest. Private stdout/stderr logs accompany the attempt.

Blender reopens each generated EXR and checks its decoded dimensions and finite pixel data. The adapter independently checks the exact frame set, file headers, sizes and hashes. These checks detect missing or altered files and metadata mismatch. They do not establish creative quality, flicker-free animation, a correct client brief or an independent artistic review.

Blender documents background rendering and command-line argument ordering. Its linear output conventions distinguish the working space from the display transform; OpenEXR retains scene-linear data. [Blender command-line rendering](https://docs.blender.org/manual/en/latest/advanced/command_line/render.html), [Blender color spaces](https://docs.blender.org/manual/en/5.0/render/color_management/color_spaces.html)

## Local execution

Requires Node.js with the repository dependencies and an operator-installed Blender 5.2. The tested Windows executable is `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`. No Blender download or paid render resource is provisioned by these scripts.

From the repository root, choose a private output directory and run:

```powershell
node --import tsx scripts/vfx/renderer.mts `
  --job scripts/vfx/example-job.json `
  --output-root C:\private\coatria-renders `
  --blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
```

Use a new UUID for a new job; changing parameters under an existing job UUID returns `JOB_CONFLICT`. The example selects four 384×384 ACEScg frames at 24000/1001 fps. An exact repeated request verifies the sealed manifest and every output before returning the existing result, without starting Blender.

Verify an existing successful attempt with:

```powershell
node --import tsx scripts/vfx/renderer.mts --verify C:\private\coatria-renders\JOB_UUID\attempts\0001
```

Paths in the result are relative to that job's operator-approved root. The result is not a public media URL and does not upload files to Vercel or a client destination.

## Company connector worker

Register and explicitly approve the company execution connector/profile through the execution API. The host uses its scoped `ce_` connector token, separate from human sessions and `ca_` agent credentials. Configure these private environment values on the operator-owned host:

| Environment variable | Meaning |
| --- | --- |
| `COATRIA_BASE_URL` | Bare HTTPS Coatria origin; loopback HTTP permitted for isolated testing |
| `COATRIA_EXECUTION_TOKEN` | Scoped execution connector credential; never committed or printed |
| `COATRIA_EXECUTION_WORKER_ID` | Stable host worker identity |
| `COATRIA_EXECUTION_OUTPUT_ROOT` | Absolute private output/state root |
| `COATRIA_BLENDER_PATH` | Absolute approved Blender executable |

`node --import tsx scripts/vfx/worker.mts --once` handles one bounded connector cycle. Omitting `--once` starts the operator-managed polling loop. The worker calls only `/api/execution/identity`, `jobs/claim`, job heartbeat, completion and failure. It never executes model-generated commands or contacts clients.

Each claim retains the server's company, project, work-item, profile and technical-spec snapshot. The worker validates the supported profile, input absence, EXR format, pixel/frame/rate bounds and working space before starting Blender. It renews the lease every 20 seconds; a renewal failure or cancellation aborts its owned process tree. API requests have a 10-second deadline and a streamed 1 MiB response bound. The completion references only verified files under the job directory. Its public status remains **connector-reported**; the backend and a human still need the separate version-review and acceptance gates.

The private `.connector-state` directory contains pending claim/receipt data, including lease material. State is bound to the worker ID and a digest of the exact origin and connector credential. It must not be served as media, copied between companies, committed, or logged. Changing the origin/token while a receipt is pending fails closed for operator reconciliation. The child Blender environment excludes Coatria/provider credentials.

## Publish completed outputs to private storage

After the API job has succeeded and its sealed local result remains in the same output root, run the separate [publisher](../scripts/vfx/publish.mts):

```powershell
node --import tsx scripts/vfx/publish.mts --job JOB_UUID
```

It uses the existing private `COATRIA_BASE_URL`, `COATRIA_EXECUTION_TOKEN`, and `COATRIA_EXECUTION_OUTPUT_ROOT` environment values. The server must have its private Blob store configured. The publisher does not start Blender, request inference, approve a version, or contact a client. The rendering loop does not invoke it automatically.

The publisher checks the complete local manifest and file bounds, then requests an exact upload grant for each completed output. Every file must be at most 20 MiB. Its storage PUT sends exactly these two matching headers from the approved grant:

```text
Content-Type: <the file's approved MIME type>
x-content-type: <the same approved MIME type>
```

`Content-Type` describes the request body; `x-content-type` selects the stored Blob MIME type. Both must match the signed `allowedContentTypes` grant. For example, an EXR uses `image/x-exr` for both. The `ce_` bearer credential is sent only to the Coatria API, never to the signed Blob URL. Redirects, unexpected storage destinations, mismatched paths, and mismatched headers are rejected.

After each write, the server reads and hashes the private stored bytes against the immutable completion manifest. A storage response alone is not accepted as verification. Rerunning the same command derives the same upload/verification request IDs and reconciles existing files without overwrite or duplicate file records; changed local outputs fail validation. No credentials or signed URLs are journalled. Success reports `verificationSource: server_bytes` and `independentlyReviewed: false`. Use the Studio UI to promote the whole verified sequence into a pending version, then obtain independent review before preparing a delivery manifest.

## Failure and recovery

The adapter uses an exclusive local execution lock. Successful job files and manifests are never overwritten by a retry. Known failed attempts retain a failure record and logs; a subsequent authorized attempt gets another directory. Corrupt committed files fail verification and do not silently trigger a replacement render. An interrupted attempt without a failure record requires explicit reconciliation.

The worker persists the exact completion request before posting it. If the response is lost, restart resends that same body and idempotency key before making another claim or rendering again. An uncertain/interrupted render fails closed and preserves its state. A stale host lock, reused PID, different hostname, live child process, or unknown completion requires operator investigation; this is not automatic fleet failover. Inspect the backend job, local child processes and sealed outputs before resetting any private lock/state. Do not delete output evidence to make a retry appear clean.

Timeout/cancellation targets only the process tree launched by this adapter. This is a process-lifecycle control, not an operating-system sandbox. `--disable-autoexec`, `--factory-startup` and `--offline-mode` do **not** make arbitrary `.blend` files or Python safe. Running external scenes would require a separate reviewed profile, input provenance and digest checks, constrained mounts, network isolation, resource quotas and an appropriate container/VM security boundary. External Blender inputs are rejected by this profile.

## Verification evidence

On 2026-09-17, installed Blender **5.2.0 LTS**, build `fbe6228777e7`, produced four actual 384×384 EXR frames, a native scene and a visually inspected PNG on the local CPU. The initial Linear Rec.709 run took 20.534 seconds. A later ACEScg run with decoded-frame verification took 19.775 seconds. Both used 24000/1001 fps, 16 samples and two CPU threads. These are small local measurements, not cloud throughput or a production SLA.

The recorded bundled OCIO config digest was `df5714c85d5afb5e9762281503a0c48a9f65dadb22d32a3aee50c454a0821f62`; each manifest also records the profile hash and every bundled transform hash used by its installed Blender distribution. Renderer determinism here means a fixed scene, seed and parameter contract. Bit-for-bit equivalence across Blender builds, CPU architectures or color bundles is not promised.

`tests/vfx-renderer.test.ts` checks bounds, hashes, dimensions, missing frames, sealed-result replay, uncertain-state refusal, subprocess timeout, cancellation, identity-bound receipt replay and streamed response limits. The default suite uses explicitly labeled header fixtures for verification logic; it skips the real Blender test. Set `COATRIA_TEST_BLENDER=1` and optionally `COATRIA_BLENDER_PATH` to exercise the installed renderer. The real test produces and verifies `.blend`, EXR and PNG outputs, including failed-start recovery. Company execution API tests separately cover authorization, leases and human review boundaries.

A subsequent integrated local workflow passed seven checks using the real React UI, HTTP API handlers, migrated PGlite, installed Blender, and a real private Vercel Blob store. It created and approved a four-frame ACEScg job, observed the leased renderer's heartbeat and completion, published and server-verified all seven output files, replayed publication without duplicate records, loaded the actual private preview in the browser, enforced independent review, and prepared an exact real-file delivery manifest. No browser page errors were recorded. This used a synthetic company; it ran no inference and performed no client transport. The test blobs were removed after validation. The local record is `.devdata/studio-media-evidence/evidence.json`.

Separately, the reviewed migrations013–016 were committed in Neon on `2026-09-18T00:27:38.310Z`. Read-back verification confirmed that expected media and verification evidence are not runtime-updatable, delivery status is updatable, and the delivery manifest is not. The operator record is `.devdata/studio-ops-neon-applied.json`. Database deployment does not establish that a cloud renderer or fleet is running.

The next operational gates are a separately deployed cloud renderer/host, observed cloud recovery and capacity, and authorized client transfer with an actual receipt. Multi-host recovery, arbitrary client scenes, NAS access, resumable heavy-file transfer, and additional DCC profiles remain separate work. See the [studio blueprint](VFX_STUDIO_BLUEPRINT.md) for those integration contracts.
