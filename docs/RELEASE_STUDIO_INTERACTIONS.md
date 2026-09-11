# Studio generator and character interactions release

Released on 2026-09-11 UTC at [coatria.com](https://coatria.com/#layout) from source `c2f256792fe0c97c29d637d73318d8158be7f231`, Vercel deployment `dpl_82KcRDweSBTSu2aYZfZ14AX8Dnkj`.

## Scope

Four additional furnished presets, plus a deterministic generator for 1–60 workstation pairs and 0–8 open meeting nooks. Courtyard, Neighborhoods and Gallery layouts preserve exact requested counts within 180 objects and 40 m per side. Preview, seed replay, variation, draft apply, undo and shared save are separate steps.

Movement now uses 2.1 m/s walking and 3.8 m/s running with the authored Run clip. Double left-click runs; double right-click teleports to valid open floor. Character actions exposes keyboard/touch equivalents, Wave, Dance and six expiring emoji reactions. Four audited chair models support shared exclusive seating, approach routing and authored Sit.

## Local evidence

- Generator: all 3,240 supported settings fit; 17 generator/preset tests, including padded route and runtime seat-approach connectivity.
- Generator UI: 11 browser cases pass, desktop and 390 px reviewed.
- Actual generated 3D: 24-person 85-object and 60-person 180-object scenes load all licensed geometry; 30/76 usable seats and 117 clear route checks.
- Renderer: 8 new interaction cases plus 16 prior character/floor/furniture regressions pass. Four chair models at four rotations, adult/senior Run and Dance, and initially seated model replacement verified.
- Presence UI: 13 cases pass, including serialized movement/actions, stale chair acknowledgements, seated hydration, leaving the office and an availability-change race.
- Full local Node suite: 126 tests, 121 passed, 0 failed, 5 PostgreSQL-only skips. The exact-source CI subsequently passed all real PostgreSQL lock and privilege checks.
- Two real browser sessions: 79 successful authenticated HTTP responses; shared seat/reaction/wave/run/teleport and seated reload pass; exact fixture cleanup verified.
- Full React test lab: 50 people, 148 furnishings, balanced graphics, 60 seconds; average 59.53 FPS and worst sampled frame p95 17.1 ms across 50 post-warmup samples. All models loaded, zero browser errors. Edge 152 / Radeon 890M / 1536×1100 / DPR 1, Next development server. This measures local rendering, not server capacity.
- Fifty-character renderer regression: moving sample 59.999 FPS, frame p95 16.8 ms, CPU work p95 4.2 ms, balanced graphics. 49 queued routes drained in 1.156 s. Short samples from this local Edge/device, not a production concurrency or global latency claim.
- Licensed bundle: 12 self-contained 44-joint characters, all 6 declared clips, 10,932,112 total GLB bytes; 78 office models (~5.0 MiB). Paid binaries remain excluded from Git and served through authenticated endpoints.

## Release checks

[Exact-source CI run 34578519789](https://github.com/stratostormstudios/coatria/actions/runs/34578519789) passed both application and scale jobs. The application job passed 125 of 126 tests with zero failures; the sole skip is private licensed-file inspection, verified locally and by the Vercel build. PostgreSQL seat contention, full-precision event timestamps, runtime privileges, history credential scanning, dependency audit (zero vulnerabilities), TypeScript and the production build passed.

The isolated 50-session PostgreSQL/production Next test completed 5,415 measured HTTP requests with zero unexpected errors, median 8.67 ms and p95 16.99 ms. All 14 checks passed, including shared movement/tasks/messages, tenant isolation, real presence expiry, reconnect and exact fixture cleanup. This measures an isolated CI service, not Vercel capacity or internet latency.

The promoted Vercel candidate verified 12 private rigged characters and 78 office objects. The custom-domain alias matches the deployment above. Live HTTPS and database health return 200 ready; anonymous character/furniture catalog, model, preview and plan requests return 401; direct private filesystem access returns 404. The live CSP browser test passed nonce rotation and blocked injected inline scripts and handlers. HTTP evidence is retained outside public source in `C:/CODEX/Agent002/output/coatria-studio-live/`.

Published UI verification passed 11 checks: all four new preset previews; a 12-workstation/2-nook gallery preview; stale-settings protection; draft apply/undo; 390 px controls without overflow; authored Wave/Dance, heart reaction, and Sit/Stand through the real React transport. The published renderer bytes match the reviewed source. No page, console or CSP errors occurred. These checks used isolated browser API fixtures and licensed local models, with every API request intercepted and no production accounts or layout writes. Real authenticated synchronization was exercised separately in the local two-browser test. Screenshots and machine-readable evidence remain in `C:/CODEX/Agent002/output/coatria-published-interactions-smoke/`.

## Production database

Migration 006 applied through Neon SQL Editor to existing coatria-production/main/neondb under neondb_owner, with transaction/advisory lock, bounded lock timeout, and schema_migrations record. Existing coatria_runtime_v1 column access confirmed; schema CREATE remains denied. No runtime credential or grant changes. Existing live health remained 200 ready after migration. The additive schema is compatible with the previous application.

## Rollback

The previous public deployment is `dpl_J6eQg3hea6fUdzYbXvfqMmZsJayW`, source `b83babd27b3877677475d39feaa1351657470ffb`. Roll back source and private character bundle together; retain additive schema 006. Existing company floors remain unchanged until an administrator applies a template to the draft and saves it.
