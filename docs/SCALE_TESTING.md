# Fifty-person office and test lab

Coatria now has two complementary test tools. The **Test lab** in company operations renders simulated coworkers in a browser. The separate local HTTP runner exercises independent authenticated sessions against an isolated application/database. Neither inserts simulated coworkers into a customer's company.

## Office design

The [50-person studio](OFFICE_50.md) is a 30 × 20 metre office with five teams of ten, a project lounge, welcome and quiet lounges, and shared commons. It contains 50 separate desk/chair pairs and 48 supporting objects. Seven geometry checks verify catalogue references, physical dimensions, non-overlapping solid furniture, chair orientation, approach clearance and routes from the entrance to every workstation and shared zone.

Administrators can open **Edit space → Office templates → Use 50-person studio**. This replaces only the current editor draft; Undo restores the previous plan. The existing revision-checked Save action publishes the draft. Applying furniture does not create conversation rooms, assign employees to desks or change memberships. The editor limit is now 180 items; older plans remain readable. A rollback must support that limit and purchased-asset items once larger plans are saved.

## Visual tester

Open **Company operations → Test lab** as a company owner or administrator. Choose 10, 25 or 50 people, a working-day, everyone-moving or disconnect/reconnect scenario, and a 30, 60 or 120 second run. The scene uses the licensed characters and furniture, the normal renderer, picking controls and collision/pathfinding code. A searchable accessible roster exposes people outside the camera.

The first ten seconds warm up the scene. Subsequent samples record rendered FPS, recent frame p95, draw calls, triangles and resource counts. Rendering inactivity and suspension are distinguished from slow frames. Hiding the tab pauses the test; local heartbeats keep the paused scene's simulated participants present. Returning to another test-lab tab pauses and unmounts the scene. Report export is bounded and includes device/viewport details, asset completeness and limitations.

A successful visual verdict requires sufficient samples, complete visible character and furniture models, at least 30 average FPS and worst sampled recent frame p95 no greater than 50 ms. These are explicit device-test targets, not a certification. A fast procedural fallback cannot qualify as a successful licensed-scene run. Measure representative hardware, viewport sizes and graphics settings; a phone-sized window on a desktop does not establish phone GPU performance.

## Synchronization and connection tests

The client no longer downloads the full workspace after every movement. Presence writes apply the returned roster directly and coalesce intermediate positions into one serialized write stream, at most once per second. Office, People and Rooms views poll the lightweight presence endpoint every two seconds. Full workspace updates remain on a five-second cadence. Slow polls cannot overlap, failed polls back off, and company/account changes abort the old loops. Request-order guards control roster additions/removals, while server row timestamps keep delayed reads from rolling back acknowledged positions. A late write can advance an existing row but cannot resurrect someone removed by a newer roster. Join/removal ordering remains eventually consistent; there is no global server snapshot revision.

This remains polling-based synchronization. Nominal movement visibility includes the write interval, peer polling interval, server latency and interpolation; it is not frame-synchronous multiplayer. Existing session reconciliation, membership checks and access expiry remain active. Shared floor saves still use atomic revision checks.

The [HTTP runner](LOCAL_HTTP_LOAD_TEST.md) supplies distinct real sessions, the actual 148-object preset, simultaneous message/task changes, roster/position visibility checks, denied cross-company requests, stale identity rejection, real presence expiry and reconnect. It also records latency percentiles, errors, throughput and payload volume. Test lab can load the published reference run, with its exact source commit and CI link, or import another report. All reports remain labelled with their environment. The production-build PostgreSQL CI job tests a fresh local service; it does not load-test Coatria.com.

## Evidence and remaining capacity work

Local application checks passed 92 of 96 Node tests with zero failures; the four skips require genuine PostgreSQL. Thirty-six coordinated browser cases passed, covering the new tester and template, incomplete-model verdicts, exported reports, presence ordering/coalescing, slow requests, switching/revocation, and existing navigation/workplace/security behavior. Sampled accessibility checks passed for all three tester panels at desktop and phone widths without horizontal overflow. These are sampled checks, not full accessibility certification.

An additional full 60-second run of the user-facing “Everyone moving” scenario against the local production build completed with all 50 characters and 148 furnishings loaded, 50 recorded post-warmup samples, average 59.96 FPS, worst sampled frame p95 17.1 ms, and no browser runtime errors. It met the visual target on the same Windows/Edge/AMD machine. The viewport was 1536 × 1100 at DPR 1. Its simulated route targets cross the furnished office; this is still a local browser measurement. The [renderer guide](RENDERER_SCALE.md) records shorter controlled comparisons and remaining cold shader costs.

The historical first connection run used development Next and single-connection PGlite, before the furnished preset was added to its payload. It completed 1,943 measured requests without unexpected errors; p95 was 3,014.67 ms, exceeding the later explicit 1,000 ms target. It is retained as an emulator baseline, not a production-capacity result. The final [PostgreSQL CI reference](https://github.com/stratostormstudios/coatria/actions/runs/34540216174) for source `2eb14ac2b69cb73c0ff96bcef3867bd64aed35d3` completed 5,408 measured requests in 60.01 seconds with 50 sessions, 148 furnishings in the workspace payload and one-second movement writes. Median latency was 6.75 ms, p95 13.8 ms, maximum 277.02 ms; all 14 checks and fixture cleanup passed. Simultaneous chat/task write p95 was 260.75/267.78 ms. The source application suite passed 95 of 96 tests; its only skip was private licensed-file inspection, which passed locally. The repeat for deployment source `b83babd27b3877677475d39feaa1351657470ffb` also passed: 5,417 requests, zero errors, p50 8.38 ms and p95 337.2 ms ([CI run](https://github.com/stratostormstudios/coatria/actions/runs/34540627679)). Both runs met the 1,000 ms p95 budget; the variation does not establish a fixed production latency. The report is shipped at `public/benchmarks/connections-reference.json` with its tested source and CI URL.

Decoded response bodies totalled 106,703,347 bytes during that minute, of which 59,761,577 bytes came from 600 full workspace reads. This is application-body volume, not compressed network-wire accounting, and excludes models/media. Incremental workspace events and a separately cached floor snapshot are priorities before scaling polling across many companies. Publication evidence is in [release status](RELEASE_STATUS.md).

Before making broader capacity promises, measure:

- Multiple concurrent companies and longer steady-state runs on representative hosting/database capacity.
- Geographic latency, reconnect storms, cold starts, cold licensed-asset downloads and egress cost.
- Actual lower-powered devices, browser memory/resource recovery and software graphics fallback.
- Shared work with realistic task/message history, not only small fresh fixtures.
- Real-time event delivery and regional fan-out before increasing polling populations substantially.
- Media separately: the current direct WebRTC implementation caps a call at six participants. Fifty-person all-hands meetings require an SFU/broadcast design and network/TURN testing.

The current tests establish a bounded 50-person baseline. They do not establish worldwide or million-user capacity.
