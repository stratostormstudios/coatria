# Fifty-person renderer verification

## Scope

This benchmark renders 50 simultaneous human occupants using the licensed City Characters rigs in the furnished **50-person studio**: a 30 × 20 metre floor, 148 placed objects, 25 distinct Office Rooms models, and 12 distinct character models. It runs one browser scene with explicit synthetic presence snapshots. It creates no accounts, memberships, server connections, calls, or production records. It does not establish backend capacity for 50 connections or a worldwide concurrency limit.

The normal office still renders only its viewer and occupants present in authenticated workspace snapshots. Bots retain their separate procedural appearance and AI labels. The tester does not make offline company members appear in a normal office.

## Measured result

Measured on 10 September 2026 with headless Edge 152 on Windows, a 1536 × 1000 viewport, and device pixel ratio 1. A separate probe of the same browser configuration reported **ANGLE / AMD Radeon 890M / Direct3D 11**, with 24 logical processors. No software-renderer override was used. These are short samples from this device, not a hardware-independent frame-rate guarantee.

The final benchmark waits for all private models, observes the quality transition separately, then records approximately four seconds of steady operation per mode. Moving samples alternate 49 remote targets by 0.7 metres every second. The local viewer remains present throughout.

| Final furnished preset | Rendered FPS | Rendered interval p95 | CPU work p50 / p95 | Animation p95 | Renderer submission p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Balanced, authored idle clips | 60.0 | 16.8 ms | 4.6 / 7.0 ms | 0.7 ms | 6.3 ms |
| Balanced, remote walking | 60.0 | 16.8 ms | 6.0 / 9.0 ms | 1.0 ms | 7.4 ms |
| Low, remote walking | 30.0 | 33.4 ms | 4.4 / 5.5 ms | 0.9 ms | 4.2 ms |

Balanced frames submit 109 main-pass calls and 521,910 triangles. Shadow refresh frames peak at 213 calls and 1,042,470 triangles; the shadow pass runs less often than the main pass. Low mode has no shadow pass. These are renderer submission counts, including duplicated triangles between passes, not unique mesh triangle totals.

The loaded fixture reports 74 skinned primitives, **50 independent skeletons and 2,200 unique bones**, 27 static furniture instance batches, 94 renderer geometries, 93 textures, 13 shader programs, and 189 picking proxies. Program and texture counts can change after another quality mode compiles or shadow targets are released.

### Before/after comparison

An earlier controlled fixture used the same 50 rigs with 50 identical desks and 50 identical chairs. It isolates the renderer work from subsequent changes to the furnished preset.

| 100-object comparison, balanced walking | Before | After batching and animation budget |
| --- | ---: | ---: |
| Rendered FPS | 51.9 | 59.9 |
| Frame interval p95 | 25.1 ms | 16.8 ms |
| CPU work p50 / p95 | 8.5 / 9.8 ms | 5.2 / 7.7 ms |
| Main-pass calls | 182 | 84 |
| Calls on a shadow frame | 362 | 166 |
| Independent skeleton buffers | 74 | 50 |

The final 148-object sample and this 100-object comparison are separate fixtures. Their frame-rate and draw-call values should not be combined into one before/after claim.

### Movement burst and transition costs

An additional test directs the 49 remote occupants to the opposite aisle in their own ten-person neighborhood. Previously this computed every detour synchronously and took about 142 ms in one snapshot callback. The final snapshot callback took **0.7 ms** and queued the routes; polling observed the queue empty after approximately **676 ms**. All 49 requests completed, with a maximum single route calculation of **7.9 ms**. Queue-drain timing includes polling granularity and depends on the obstacle layout.

The first low-mode transition compiled new shader variants. In the final run its longest renderer call was **311 ms**; another cold run reached approximately 538 ms. This cost is retained in the report's `transition` observations, not included in the steady-state table. Quality changes should therefore be occasional user actions. Low mode must not be toggled automatically every few frames.

Visual verification also found an existing shadow-quality transition defect: changing the global shadow flag did not invalidate the vendored renderer's material programs, leaving materials sampling a disposed shadow texture. The renderer now invalidates each shared material once when the shadow mode changes. The tests verify visible canvas geometry in **balanced → low → balanced**, rather than treating draw counts as proof of visible content.

## Runtime budgets

- **Repeated furniture:** rigid geometry and materials are shared through `InstancedMesh` batches. Each placed item retains its own exact transform, collision bounds, selection proxy, and source-resource lease. Static matrices are frozen after world transforms are established. Removing a scene disposes instance buffers before releasing the library's source resources.
- **Character ownership:** each person receives an independent cloned bone hierarchy. Multiple primitives within one person share a skeleton only when their cloned bone identities and inverse bind matrices are identical. Skeletons are never shared between people; animation, leaving, and replacement remain independent.
- **Pose work:** visible humans receive up to 24 full-rate pose updates at 60 Hz in balanced mode, or 12 at 30 Hz in low mode. Additional visible walkers update poses at 20 / 15 Hz and additional idle occupants at 8 / 5 Hz respectively. The viewer, selected person, and moving people receive priority. Root movement, acceleration, turning, and collision paths continue at the main loop rate, independently of pose cadence.
- **Camera visibility:** character spheres are checked against the camera frustum at most every 200 ms, or sooner after camera changes. Off-camera human meshes and mixer work are culled. Presence, expiry, and navigation continue. Zooming can therefore give the remaining visible people a larger animation budget.
- **Shadows:** balanced shadows refresh at up to 15 Hz, or 30 Hz while the local viewer walks, with immediate refresh after structural/model changes. Low mode disables shadows. Shader invalidation occurs only when the shadow mode changes.
- **Remote routing:** only the newest queued target per person is retained. Each loop starts at most four routes, with a soft 3 ms budget before starting another. One route is not preempted and can exceed that budget. The route starts at the person's current position when processed. Existing legal movement continues while queued. Local click-to-walk remains immediate. Removal, expiry, large correction, and disposal clear obsolete jobs.
- **Labels:** projected full-name rectangles are accepted only when they do not overlap previously accepted labels. Focus, hover, selection, the viewer, and rooms receive priority. Other visible names become compact human/AI markers with their full accessible name and title intact. Keyboard focus promotes a compact marker to a full name; the tester's separate roster can call `selectEntity(id)`. Off-camera labels remain hidden, so applications should retain an accessible People/List view.

## Diagnostics contract

The public instance retains `scene`, `camera`, and `renderer` for local inspection and provides:

```js
const stats = instance.diagnostics;
instance.resetPerformance();
instance.selectEntity(personId); // true when an entity is present
```

The React wrapper samples diagnostics once per second. Reading diagnostics does not download models or change presence.

`performance` contains:

- `state`: `active`, `idle`, `suspended`, or `disposed`. Authored visible idle animation is active rendering. `idle` means a demand-rendered scene without continuing motion. Hidden documents and fully off-viewport stages are suspended; suspended/disposed FPS values are zero.
- `sampleCount`, `renderedSampleCount`, `windowSeconds`: at most 300 accepted loop samples. The initial interval after a reset or suspension is excluded because there is no previous timestamp.
- `fps`: rendered calls per elapsed sample time. `loopFps`: accepted scheduler ticks per elapsed sample time. Demand-rendered idle scenes can have a healthy scheduler and few render calls; that is not a rendering failure.
- `frameMs`: actual time between rendered frames. `loopFrameMs`: intervals between accepted scheduler ticks. Each timing object includes `p50`, `p95`, and `max`. Suspensions reset timestamps instead of being reported as slow frames.
- `workMs`, `animationMs`, `renderMs`, `labelsMs`: synchronous CPU wall-clock observations for the loop, mixer work, Three.js renderer call, and DOM label projection. These are **not GPU timestamps**. `renderMs` may include driver/shader work and can differ across browser backends.
- `drawCalls`, `triangles`: latest rendered frame, plus `peakDrawCalls`, `peakTriangles`, and `shadowUpdates` for the bounded observation window.

`animation` reports visible, full-rate, reduced-rate, and culled human counts, the full-rate budget, and mixers updated in the last loop. `resources` reports renderer geometries/textures/programs, loaded models, skinned primitives, distinct skeletons/bones, instance batches, and picking proxies. These are counts, not estimated memory bytes. `pathfinding` reports request count, last/max single-route time, pending queue size, routes processed in the last loop, and last processing duration. `labels` reports full, compact, hidden, and total labels.

## Reproduction and regression coverage

Run against a local app with the licensed, ignored `.runtime-assets/city-characters` and `.runtime-assets/office-models` files installed. The browser tests intercept authenticated model reads using those exact local GLBs. Each request must carry the expected viewer identity. Paid files are not copied into a public directory or committed.

```powershell
$env:COATRIA_TEST_URL = 'http://127.0.0.1:4180'
$env:COATRIA_BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:COATRIA_SCALE_LABEL = 'local-50-person-sample'
node node_modules/@playwright/test/cli.js test tests/browser/office-scale.spec.ts
```

Set `COATRIA_SCALE_GRID_FIXTURE=1` to reproduce the earlier 100-object grid instead of the 148-object preset. Remove it or set it to `0` for the final preset. The opposite-aisle test runs only against the final preset.

The final focused verification passed **19 browser tests**:

- `office-scale.spec.ts` (3): real models and identity-pinned deduplicated downloads; steady motion and quality transitions; name overlap and focus promotion; frustum budgets; 50 → 25 → 50 removal/reconnect; complete disposal/remount; explicit idle/suspension/resume; queued opposite-aisle routing.
- `office-asset-renderer.spec.ts` (6): real model transforms, floor finishes, shared lease disposal, bounded download concurrency/cache, retries, unsafe/excessive model rejection, identity change, and late parse disposal.
- `floor-renderer.spec.ts` (6): 8 × 8, 20 × 16, 40 × 40, 8 × 40, and 32 × 12 geometry, camera framing, rotation, safe paths, resize/remount, and legacy defaults.
- `characters.spec.ts` (4): independent rigs, calibrated blended locomotion, remote interpolation, member removal, late model replacement, teardown, and accessible procedural fallback.

TypeScript `--noEmit` and JavaScript syntax checks also passed. Reports and visually inspected balanced/low screenshots were saved outside the repository under `C:/CODEX/Agent002/output/coatria-scale-final-verified`; character regressions are under `C:/CODEX/Agent002/output/coatria-scale-character-regression`.

The measurements do not cover mobile thermals, long-running memory growth, browser video decoding, 50 live media streams, real network latency, or server fan-out. Those require separate device and service tests. Software-rendered CI is useful for behavior and visual regression checks; its frame rate should not be compared directly with the hardware-backed device sample above.
