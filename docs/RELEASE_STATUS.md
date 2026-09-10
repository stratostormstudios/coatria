# Coatria 0.1 — fifty-person office and test lab

The 50-person studio and Test lab are prepared for release. The office has 50 independent workstations and 148 furnishings on a 30 × 20 metre floor. Administrators can apply it as an editable draft and run browser simulations with 10, 25 or 50 people. The isolated HTTP harness tests 50 authenticated sessions against a production Next build and fresh PostgreSQL service. See the [scale testing guide](SCALE_TESTING.md) for controls, evidence and capacity limits.

Renderer testing on Edge 152 with an AMD Radeon 890M at 1536 × 1000, DPR 1, measured 60.0 FPS with all 50 characters moving and 148 furnishings loaded in balanced quality; rendered-frame p95 was 16.8 ms. Low quality reached its 30 FPS cap, with frame p95 33.4 ms. These are device-specific steady-state samples, not general hardware or hosting guarantees. The full 60-second user-facing moving scenario also passed: average 59.96 FPS, worst sampled frame p95 17.1 ms, all assets loaded and no runtime errors.

[PostgreSQL CI reference run 34540216174](https://github.com/stratostormstudios/coatria/actions/runs/34540216174) passed for source `2eb14ac2b69cb73c0ff96bcef3867bd64aed35d3`: 50 sessions, 5,408 requests in 60.01 seconds, p95 13.8 ms, zero errors, all 14 checks and cleanup passed. This is isolated loopback CI, not Coatria.com capacity. The application job passed 95 of 96 tests; the only skip is private licensed-file inspection, verified locally. History credential scanning, audit (zero vulnerabilities), TypeScript, source-only CI build and licensed local build passed. Browser coverage includes 36 tester/navigation/synchronization/reference cases and 19 renderer regressions. Publication evidence follows after promotion.

## Earlier office-furniture release

The purchased ITHappy Office Rooms integration is prepared for release: 78 searchable furniture objects, real isometric and top-down previews, proportional furniture sizing, adjustable partitions/floor finishes, and authenticated private model delivery. Existing offices and character assets are preserved. See the [office asset guide](OFFICE_ASSETS.md) for preparation, deployment boundaries and compatibility.

Local verification passed 66 of 70 Node tests with zero failures and four PostgreSQL-only skips. Browser checks passed 11 furniture-editor fixtures, one real local database workflow, 15 legacy editor cases, six purchased-renderer cases and 10 renderer/character regressions. Both preview queue reproductions passed. The licensed build verified all 12 characters and 78 furniture objects. Scoped editor accessibility checks reported zero selected WCAG 2 A/AA and 2.1 AA violations at 1536 × 1100 and 390 × 844, without horizontal overflow; this is not certification.

Released at [coatria.com](https://coatria.com/#layout) from source `a1165b1498039b04c635ea083ae44a2f2b2d5e38`, Vercel deployment `dpl_DycyZ4khrLanfT7wPQ9wkhTuJPqg`. [PostgreSQL CI run 34370283330](https://github.com/stratostormstudios/coatria/actions/runs/34370283330) passed 69 tests with zero failures; its one skip is the purchased-file inspection in the source-only checkout. That inspection passed against the actual files locally, and the Vercel build verified all private assets. All PostgreSQL concurrency and runtime-role checks passed. The complete-history credential scan, dependency audit (zero reported vulnerabilities), TypeScript and production build passed.

The promoted site returned HTTPS 200 and ready database health. The live CSP browser check passed. Anonymous catalogue/model/preview/plan requests returned 401, and the private filesystem path returned 404. Published editor placement, proportional sizing, movement, previews and the actual 3D renderer passed with isolated browser API fixtures and no runtime errors. These live fixture checks did not write production data; real authenticated persistence was exercised locally. Screenshots and verification data remain outside the public repository in `C:/CODEX/Agent002/output/office-assets/`.

A compatible rollback must understand version 1 floor documents and purchased-asset items. The earlier releases below remain historical evidence, not rollback recommendations.

## Earlier floor-editor release

Status recorded **2026-09-09 UTC**. The direct-manipulation floor editor is deployed at [coatria.com](https://coatria.com/#layout). Administrators can drag furniture onto the plan, move and resize it with handles, adjust the floor, rotate/duplicate objects, and undo or redo changes. The 3D office uses the saved geometry. Atomic revision checks protect shared saves. The [floor editor guide](FLOOR_EDITOR.md) explains controls, compatibility and limits. This release stores a versioned document in the existing JSONB field; it needs no production SQL migration or broader runtime grants. The earlier [UX review](UX_REVIEW.md), [character pipeline](CHARACTERS.md) and [security review](SECURITY_REVIEW.md) remain applicable.

| Item | Current state |
| --- | --- |
| Repository | [stratostormstudios/coatria](https://github.com/stratostormstudios/coatria) contains the application, migrations, tests and implementation plan |
| Reviewed source | `72713f29466d5db255b068de6adf8e075888cdf5` |
| Vercel | Floor-editor deployment `dpl_3NDfVX3eCQRuumw5p7wyPXE9FdJo` is READY and promoted for reviewed source `72713f29466d5db255b068de6adf8e075888cdf5` |
| Domain | [coatria.com](https://coatria.com) returned HTTP 200 over HTTPS and health reported ready; live nonce-based CSP verified |
| Production database | Neon `coatria-production` preserved; all five numbered migrations applied. Runtime avatar INSERT/UPDATE allowed; email verification UPDATE and schema CREATE remain denied |
| Project environment | Only production `APP_URL` and sensitive Secret `DATABASE_URL`; no owner aliases or preview database credentials. Resource environment injection detached without deleting Neon |
| Git deployments | No Git repository connection is configured in Vercel; automatic Git deployment is not enabled |
| Deployment protection | Vercel reports `ssoProtection: all_except_custom_domains`; this does not invalidate old deployment credentials |
| Main branch | Read-only inspection reported unprotected `main` and no repository rulesets; administrator configuration remains open |
| Scale | Small-team implementation with bounded polling and calls; no million-user load test has been completed |

Floor-editor release validation: [CI run 34319224150](https://github.com/stratostormstudios/coatria/actions/runs/34319224150) passed **59 tests with zero failures or skips** on PostgreSQL, including competing floor saves and a membership demotion while waiting for the company lock. The complete-history credential scan, dependency audit (zero reported vulnerabilities), TypeScript and production build passed. The licensed local build verified all 12 private runtime characters.

**38 distinct local browser cases passed** across targeted runs: 15 floor-editor interactions, one real HTTP/database save–reload–3D workflow, six renderer cases, four character lifecycle cases, and 12 navigation/workplace/security regressions. The production CSP case then passed on the promoted custom domain. Automated axe checks of the furnished editor reported zero selected WCAG 2 A/AA and 2.1 AA violations at desktop and phone sizes, with no horizontal overflow. These are sampled checks, not accessibility certification.

The live domain returned HTTPS HTTP 200 and ready database health. Published editor assets rendered and handled mouse movement/undo using isolated in-browser API fixtures, with no browser runtime errors. Those live fixture checks did not write to production; authenticated persistence was exercised against the local database. Local test setup required applying existing migrations 004 and 005 to an outdated local database and binding the development host to the actual loopback origin. Production database state and credentials were unchanged.

**Compatible rollback:** after a versioned floor is saved, a rollback build must understand both legacy layout arrays and version 1 documents. Older array-only releases are not a compatible rollback target. The floor guide records this requirement and the remaining rectangular-floor/100-object limits.

## Earlier UX-release validation evidence

For source `c17e8e9fd9eaa977c3870289424818a00b9d873b` and deployment `dpl_Gt7FQXpEv1Dt6ECZMGZTVyj6PNnb`:

UX release validation: [CI run 34281690406](https://github.com/stratostormstudios/coatria/actions/runs/34281690406) passed **40 tests with zero failures or skips** on PostgreSQL 17.11, plus the complete-history credential scan, dependency audit (zero reported vulnerabilities), TypeScript and production build. The licensed local build verified all 12 runtime characters. **36 distinct local browser cases** passed across focused/regression runs, including real authenticated two-person collaboration and character/profile synchronization. The additional production CSP case passed on the promoted custom domain, bringing the exercised browser coverage to 37 cases.

Automated axe checks reported zero violations in 40 sampled page/dialog/auth states for the selected WCAG 2 A/AA and 2.1 AA rules. All 15 destinations were checked at desktop and phone sizes without horizontal overflow, including furnished layout labels. The office and infrastructure summaries were rechecked at both sizes after the final corrections. These checks are not accessibility certification.

The promoted domain returned HTTPS HTTP 200 and a ready database health response. Read-only live checks passed for password visibility, sign-in navigation, mobile overflow, public opportunity discovery/filtering and absence of browser runtime errors. Authenticated workflow regressions ran locally; no production test accounts or customer records were created or modified for this UX release. Local screenshots and machine-readable evidence remain outside the public repository in `C:/CODEX/Agent002/output/coatria-ux/`.

## Earlier character-release validation evidence

For source `8054156419b5adbb2cdd1bb4872f38f17ede2a09` and deployment `dpl_2cWJPenrZBDmNNAy2hdfoHagmV4T`:

Character release validation: [CI run 34271385417](https://github.com/stratostormstudios/coatria/actions/runs/34271385417) passed 40 tests with zero skips on PostgreSQL 17.11, plus audit, TypeScript and the source-only production build. Local licensed-asset builds passed. Thirteen distinct browser cases passed across production-build security/renderer tests and real-database development-service profile/collaboration tests; the authored-model motion suite additionally passed with adult and senior variants. An initial isolated-port test setup rejected three fixtures because its APP_URL named another port; those fixtures passed against the correctly configured local service. The two-tab regression confirms an untouched character field cannot overwrite a newer selection.

Live verification passed all 40 checks: authenticated catalog and portraits, all 12 model hashes and headers, saved-profile persistence, actual walking and return to idle, mobile layout, no browser errors, cross-site/stale-account rejection and model access ending after logout. One temporary user/company pair was removed by exact recorded IDs with email, slug and membership guards. Runtime credentials and Vercel environment scope were unchanged. Earlier security-release evidence appears below; its credential rotation and privileged historical deployment follow-ups remain open.

## Implemented

- Personal account registration/login/logout, profile editing, secure password changes and server sessions.
- Company creation with a furnished or blank floor, company switching, invitations, member roles, ownership transfer and offboarding.
- A real low-poly 3D office with 12 selectable purchased characters for human coworkers, authored idle/walk blending, smooth turning, shared presence, camera controls, floor editing and an accessible room list. Bots retain a distinct design. Occupants use stable IDs; stale people and agents without recent heartbeats are not displayed as live coworkers. Sitting/waving clips are prepared but their interaction controls are not yet implemented.
- Drag-and-drop floor editing with eight furniture resize handles, 8–40 metre floor dimensions, quarter-turn rotation, duplication, undo/redo, grid snapping, keyboard alternatives, and atomic revision-checked saves. Furniture keeps its physical size as the floor changes.
- Company and room chat, task assignment, contribution submission and independent acceptance. Accepted work is immutable.
- Private personal skill vaults, immutable skill versions and export independent of company membership.
- Scoped agent identities, real harness work/report APIs, pause/revoke controls and sponsor checks. The harness itself runs on the employee's infrastructure.
- BYO server metadata indexing with a downloadable outbound connector. Originals are not uploaded or served.
- Public job discovery, draft/published company openings, applications, candidate status and invitation on acceptance. No money is collected or paid.
- Small-room WebRTC audio and browser-consented screen sharing, with authenticated signaling, access expiry and capture cleanup.

## Deployment dependencies and limits

The Coatria Vercel project and domain configuration exist. A PostgreSQL database and its migrations are required for the application. Without a configured database, the app displays an explicit setup page and rejects account creation; it does not substitute browser storage or sample accounts. `/api/health` returns HTTP 503 until a database connection and the required migration records are available.

Automatic GitHub deployments additionally require the Vercel account's GitHub login connection. Direct Vercel deployments can be used independently, but must record their exact source and passing CI result. CI is not an enforced merge gate while main-branch protection is absent.

Production application requests use the restricted runtime connection. Future migrations use a direct owner connection obtained separately from the Neon dashboard and supplied only to the migration process; apply updated explicit runtime grants afterward when the schema changes. The provisioning helper is first-time setup only and refuses the already existing production role. Do not restore owner aliases to the Vercel application or delete the Neon resource to manage environment injection. Older deployments retain their original environment values and need their own retirement or credential invalidation plan.

Reliable media across restrictive networks requires a TURN service. Without it, calls use direct WebRTC connectivity. Calls are limited to the lower of room capacity and six participants.

- Presence polls every two seconds on Office, People and Rooms, while full workspace refreshes every five seconds. Presence expires after 45 seconds. This is a small-team transport; continuous low-latency global presence needs another scaling phase.
- Authenticated signaling polls approximately every 1.5 seconds. Capture and peers close after terminal access errors, on leaving the room, or when authorization cannot be refreshed for 45 seconds. Browser scheduling and network propagation mean this is not an instantaneous external-device erasure guarantee.
- An agent avatar requires active status and a recent observed heartbeat. Naming a harness does not install or run it, and reported tokens are not independently metered.
- The connector publishes metadata for at most 1,000 non-hidden files, with a directory-depth limit. It does not mount a drive, stream footage, synchronize files or provision a server. An incomplete index is not uploaded as a successful snapshot.
- Password changes require the current password. Verified email delivery, forgotten-password recovery, MFA and enterprise SSO are not enabled. Public signup does not establish mailbox ownership. Email-restricted invitations require verified accounts; ordinary links are single-use bearer invitations, and hiring acceptance links are bound to the reviewed account.
- Offboarding blocks invitations issued before access removal. A newly issued invitation can restore access intentionally. Recorded task authors remain ineligible to approve that work after reopen/resubmit cycles.
- Tenant and private-vault authorization are application-enforced, without per-tenant PostgreSQL RLS. The runtime role limits administrative privileges but retains the application DML needed to operate accounts and companies.
- Personal-vault access is separate from company membership. A reviewed company-to-personal skill export and the related licensing/continuity workflow remain later work; ordinary personal export does not establish employment IP ownership.
- Candidate acceptance issues an invitation to company membership in this release. Granular project-only guest engagements, contracts and marketplace payments remain future work.

## Earlier security-release validation evidence

For reviewed source [`5592ed26a0d584da316c4cf28d03f958c157df1a`](https://github.com/stratostormstudios/coatria/commit/5592ed26a0d584da316c4cf28d03f958c157df1a):

| Check | Current security-update evidence |
| --- | --- |
| PostgreSQL CI | [Run 34261862682](https://github.com/stratostormstudios/coatria/actions/runs/34261862682) passed on PostgreSQL 17.11: 38 tests passed, zero failed/skipped; audit, TypeScript and production build passed |
| Local Node suite | 36 of 38 passed, zero failed; two PostgreSQL-specific cases were skipped locally and subsequently passed in CI |
| Production-build browsers | Seven local checks passed: CSP, collaboration, workplace and four security-boundary cases |
| Media | Six local synthetic-media checks passed, including real audio packets/video frames and capture lifecycle boundaries |
| Database configuration | Migration 004 applied; runtime pooled login verified with role creation, database creation, RLS bypass, schema CREATE, migration UPDATE and email-verification UPDATE disabled |
| Production application | READY, health ready, HTTPS HTTP 200, live CSP, 39 API checks and 16 browser checks passed; all five audit users and four audit companies removed by exact recorded IDs |

Run `npm test` with the dedicated real local PostgreSQL test environment to include the security-audit and runtime-privilege cases. `npm run test:integration` is only the baseline API/signaling subset. Browser boundary fixtures run locally with `npx playwright test`; set `COATRIA_CSP_PRODUCTION=1` only when targeting a production build. Synthetic media requires `npm run test:media`. These checks do not establish public-network TURN coverage, capacity, restoration capability or independent penetration-test results.

## Historical first-release evidence

The record below belongs to the earlier source `80889682cce42c44ca5a598bd9dcaf3c3d0428cf` and deployment `dpl_6T2HFCxVdzhzJqt17Agm57t4cnMG`. It is retained for traceability and does not validate the security update.

[GitHub Actions run 34240295975](https://github.com/stratostormstudios/coatria/actions/runs/34240295975) passed for the deployed application commit: **20 tests passed, zero failed and zero skipped**, using PostgreSQL 17.11. All three migrations, 84 API responses, concurrent signaling and the PostgreSQL transaction-lock ordering test passed. The secret scan, TypeScript check and production build also passed.

After Neon activation, **35 live API checks** passed through `https://coatria.com`: secure session cookies, invitations and single-use enforcement, company isolation, shared chat and presence, task submission and independent approval, private vault isolation, agent token revocation, room signaling, offboarding and logout. Private skills remained accessible to their owner after company access was removed.

**14 production browser checks** passed at 1536 × 1000 and 390 × 844: signup and company creation through the UI, the actual 3D office, task and private-skill persistence after reload, personal export, and responsive layouts without JavaScript errors or horizontal overflow. All three temporary verification users and both temporary companies were deleted using exact recorded IDs and fixture-identity checks. No sample coworkers or test companies were left in production.

The additional evidence below is earlier local first-release validation:

| Check | Evidence |
| --- | --- |
| TypeScript | Full-project `tsc --noEmit` passed after integration |
| Build and collaboration | The final application build and local collaboration browser checks passed before deployment |
| Application security and database behavior | Tests cover password/session primitives, origins, validation, independent approvals, setup readiness and a real database-backed API workflow. The workflow exercises tenant isolation, invitations, tasks, skills, scoped agents, connector metadata and hiring |
| Room signaling | Local database tests passed for membership, forged origin, impersonation, recipient isolation, cross-room signaling, capacity, expiry, removal and leave cleanup |
| Connector | Boundary tests passed for HTTPS/local HTTP origins, junction and hidden-path exclusion, metadata-only output, exact file limits, depth limits and interruption |
| 3D office | Browser checks passed for actual occupants only, duplicate-name IDs, remote interpolation without remount, disconnection/expiry, the loaded rigged asset, movement, reduced motion, expanded-view cleanup and WebGL fallback; 390 px layout had no horizontal overflow |
| Media browser harness | Two isolated authenticated browsers exchanged actual WebRTC audio packets and decoded synthetic video frames. Tests passed for stop-sharing cleanup, stale picker rejection after changing rooms, revocation cleanup, authorization expiry and explicit leave |
| CI and production | Workflow configuration and a PostgreSQL concurrency test are included; the emulator skips that concurrency case. Record the actual CI run and deployed commit separately from the local evidence |

Run the media harness with `npm run test:media` against a dedicated local test database, or set `COATRIA_TEST_EMULATOR=1` to create its own isolated PGlite instance. It uses synthetic audio and canvas video, not a person's microphone or desktop. It validates local media flow and lifecycle; it does not validate TURN coverage, WAN quality or every browser's operating-system screen picker.

The intended release commands are `npm run check:secrets`, `npm run typecheck`, `npm test` and `npm run build`. Database integration tests require explicit test configuration. Inspect skips and failures. Migrations can be run from `.env.local` with `npm run db:migrate:local`, or from an already populated process environment with `npm run db:migrate`.

## Later production phases

- Managed storage/compute purchases, subscriptions, marketplace payments and billing reconciliation.
- Heavy media transfer, signed download permissions, edit proxies and production NAS integrations.
- SSO, verified email/recovery delivery, enterprise audit export and stronger account lifecycle controls.
- Agent task leasing, autonomous orchestration, per-run budgets, execution sandboxes and provider integrations.
- Verified contribution provenance and reputation, with fraud/appeal controls. Token expenditure is not a merit score.
- SFU conferencing and auditorium broadcasts; regional real-time services and tested scaling beyond small-team polling.
- Backups, restore drills, operator incident procedures, regional data policies and external security review before a broad commercial launch.
- Operational rate/spend budgets, abuse alerts and representative load/cost tests; platform DDoS protection does not replace these application-specific controls.

The implementation plan in this directory defines the acceptance gates for these phases. Connection instructions describe what the current adapters actually do.
