# Studio generator and character interactions release

Status: implementation verified locally; production migration 006 applied. Application promotion pending.

## Scope

Four additional furnished presets, plus a deterministic generator for 1–60 workstation pairs and 0–8 open meeting nooks. Courtyard, Neighborhoods and Gallery layouts preserve exact requested counts within 180 objects and 40 m per side. Preview, seed replay, variation, draft apply, undo and shared save are separate steps.

Movement now uses 2.1 m/s walking and 3.8 m/s running with the authored Run clip. Double left-click runs; double right-click teleports to valid open floor. Character actions exposes keyboard/touch equivalents, Wave, Dance and six expiring emoji reactions. Four audited chair models support shared exclusive seating, approach routing and authored Sit.

## Local evidence

- Generator: all 3,240 supported settings fit;17 generator/preset tests, including padded route and runtime seat-approach connectivity.
- Generator UI:11 browser cases pass, desktop and 390 px reviewed.
- Actual generated 3D:24-person 85-object and 60-person 180-object scenes load all licensed geometry;30/76 usable seats and 117 clear route checks.
- Renderer:8 new interaction cases plus 16 prior character/floor/furniture regressions pass. Four chair models at four rotations, adult/senior Run and Dance, and initially seated model replacement verified.
- Presence UI:13 cases pass, including serialized movement/actions, stale chair acknowledgements, seated hydration, leaving the office and an availability-change race.
- Full local Node suite:126 tests,121 passed,0 failed,5 PostgreSQL-only skips. CI must run the real PostgreSQL lock and privilege checks before promotion.
- Two real browser sessions:79 successful authenticated HTTP responses; shared seat/reaction/wave/run/teleport and seated reload pass; exact fixture cleanup verified.
- Fifty-character renderer regression: moving sample 59.999 FPS, frame p95 16.8 ms, CPU work p95 4.2 ms, balanced graphics.49 queued routes drained in 1.156 s. Short samples from this local Edge/device, not a production concurrency or global latency claim.
- Licensed bundle:12 self-contained 44-joint characters, all 6 declared clips,10,932,112 total GLB bytes;78 office models (~5.0 MiB). Paid binaries remain excluded from Git and served through authenticated endpoints.

## Production database

Migration 006 applied through Neon SQL Editor to existing coatria-production/main/neondb under neondb_owner, with transaction/advisory lock, bounded lock timeout, and schema_migrations record. Existing coatria_runtime_v1 column access confirmed; schema CREATE remains denied. No runtime credential or grant changes. Existing live health remained 200 ready after migration. The additive schema is compatible with the previous application.

## Rollout

Publish the reviewed source, pass GitHub application and 50-session PostgreSQL load jobs, build a candidate from the licensed checkout, and promote only the checked candidate. Confirm coatria.com health, authenticated private assets, studio controls and committed source/deployment identifiers. Roll back source and private character bundle together; retain additive schema 006.
