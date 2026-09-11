# Coatria 0.1 — durable conversations and external agent API

The conversation pipeline is live at [coatria.com](https://coatria.com/#chat), released on **2026-09-11 UTC** from source `13e2cfd892ded023bef17020afd861e48ad1e9b0`, Vercel deployment `dpl_8kbeg5PESsED3JJoAP27fqv5fEww`. The custom-domain alias was checked against that exact deployment after promotion. This release replaces workspace-snapshot chat synchronization with paginated conversation history and durable, ordered event replay. Messages, threads, edits, deletion, reactions and personal read markers share one authorized service for people and external agents. Stable client UUIDs prevent duplicate database effects after uncertain sends; optimistic revisions reject conflicting edits.

External harnesses can use the published [API guide](https://coatria.com/downloads/CONVERSATIONS.md), [OpenAPI 3.1 contract](https://coatria.com/api/conversations/openapi) and [standalone JavaScript client](https://coatria.com/downloads/conversation-client.mjs). Agent conversation access defaults to `none`; a company administrator must grant `read` or `write`. These grants cover Company commons and all current company-visible room conversations, not a private-room allowlist. Agent authors are labeled; agent read markers do not act as their sponsor's read markers. See [conversation behavior and state boundaries](CONVERSATIONS.md).

[Exact-source CI run 34617522648](https://github.com/stratostormstudios/coatria/actions/runs/34617522648) passed both jobs. The application job passed **147 of 148 tests with zero failures**; the only skip was licensed-file inspection in the source-only checkout. Eight real PostgreSQL concurrency cases exercised commit ordering, rollback, independent conversations, bootstrap consistency and authorization changes. Restricted-runtime permission checks, TypeScript, the production build, the complete-history credential scanner and dependency audit (zero reported vulnerabilities) passed. Vercel separately verified all 12 private character rigs and 78 office objects before building the candidate.

The isolated PostgreSQL/production-Next load job ran **50 distinct authenticated sessions and 6,955 measured requests**, with **zero unexpected errors and all 20 checks passing**. Aggregate median was 76.69 ms and p95 926.56 ms; the 50 message writes had p95 515.58 ms. The 60-second measured workload included durable event catch-up, simultaneous writes and retries; a further real 47-second expiry interval verified presence expiry and reconnect from saved conversation cursors. All clients observed the 50 message creation events without gaps, and retries returned the original IDs. Revision conflicts, reactions, personal read privacy, tenant isolation, session expiry and exact-fixture cleanup passed. The [load artifact](https://github.com/stratostormstudios/coatria/actions/runs/34617522648/artifacts/10270988635) is retained by CI for 14 days. These numbers describe isolated CI, not public Vercel latency, a supported production capacity or worldwide availability.

Local browser verification passed 25 conversation reliability cases, seven existing workplace/security regressions and 11 operations cases across targeted runs. Six scoped accessibility views covering full conversations, threads and the office dock at desktop and 390 px reported zero selected WCAG violations, no horizontal overflow and no browser errors; these are sampled checks, not certification. Reports are retained outside public source under `C:/CODEX/Agent002/output/coatria-conversation-pipeline-visual/` and the conversation release-check directories.

All **10 published UI smoke checks passed**. They exercised two actual licensed rigs and seven furniture placements, continuous office rendering through dock resizing, uncertain-send retries without duplicates or lost newer drafts, agent threads, edits/reactions, per-channel drafts, mobile composer/Escape behavior and company switching. All 57 API requests were intercepted with isolated fixtures; no production accounts, messages or layouts were changed. There were no unexpected browser errors or CSP violations. The one intentional 503 simulated a lost send response. Evidence and screenshots are retained in `C:/CODEX/Agent002/output/coatria-conversation-pipeline-live/`; consolidated deployment evidence is in `C:/CODEX/Agent002/output/coatria-conversation-pipeline-release/release.json`.

Additive migration **007_conversations.sql** and explicit CRUD grants for its five new tables were applied in one owner transaction before promotion. Its LF-normalized SHA-256 is `8151b6ce13a4746848986e8146b3de1596b3cc9be121859327c38fdc15008506`. Verification found five materialized conversations, zero messages without a conversation, and zero automatically granted agents. The runtime role can access event/retry records but cannot create schema objects; the legacy compatibility trigger remains security invoker. The production application credential was not changed. Live health returns `200 ready`; the schema, guide and client are public, while anonymous conversation/agent and licensed-asset endpoints reject access. Direct private model paths remain unavailable. The temporary Vercel preview credential used for candidate verification was revoked, and deployment protection was preserved.

**Compatible application rollback:** deployment `dpl_xhV3XJADWh3o6ykAso6mHW9bE4Uu`, source `fcf202229264af295d369d59b4ebc00b27608fb8`. Keep migration 007, its grants, event history and receipts in place; do not reverse the database migration or erase accepted messages. Its compatibility trigger records legacy message inserts. An older application temporarily lacks the new external conversation endpoints and collaboration controls, so rollback requires communicating that feature interruption.

This is a tested durable foundation, **not Slack parity or a service-level agreement**. Delivery currently uses bounded cursor polling. Managed realtime distribution, the proposed 200-client/30-minute staging capacity run, alert delivery, restore/failover drills and measured recovery objectives remain open. Private conversations, full-text search, attachments, notifications and enterprise retention also need separate implementations. The [reliability plan](CONVERSATION_RELIABILITY_PLAN.md) records the research, design and remaining acceptance gates.

## Earlier integrated conversation shell release

Conversations are live at [coatria.com](https://coatria.com/#chat), released on 2026-09-11 UTC from source `fcf202229264af295d369d59b4ebc00b27608fb8`, Vercel deployment `dpl_xhV3XJADWh3o6ykAso6mHW9bE4Uu`. They occupy the full main frame, with the channel list in the existing left sidebar. Office chat opens in a side panel and expands into the full view; selected channels, drafts, delivery status and reading position survive those transitions. The narrow-screen panel contains keyboard focus and supports Escape. See [conversation controls and state boundaries](CONVERSATIONS.md). No message API, database, runtime credential or grant changes were made.

Local validation: 12 new conversation-shell cases and eight existing chat/navigation regressions passed; TypeScript passed. The full Node suite passed 121 of 126 tests, with five real-PostgreSQL-only skips. Four scoped WCAG 2 A/AA and 2.1 AA scans (full and docked, desktop and 390 px) reported zero selected violations. These are sampled checks, not certification. Screenshots and reports are retained in `C:/CODEX/Agent002/output/coatria-conversation-shell/`.

[Exact-source CI run 34611317519](https://github.com/stratostormstudios/coatria/actions/runs/34611317519) passed both jobs: 125 application tests passed with the sole private-asset inspection skipped in source-only CI, and 50 authenticated HTTP sessions completed 5,407 measured requests with zero unexpected errors, median 8.99 ms and p95 17.4 ms. All 14 load checks, including simultaneous messages, isolation, expiry, reconnect and cleanup, passed. These results describe isolated CI, not public-site latency or capacity. The credential/history scan, audit (zero vulnerabilities), TypeScript and production build passed. Vercel verified all 12 private characters and 78 office objects before promotion.

The promoted custom-domain alias matches the deployment above. Live page and database health return 200 ready; anonymous asset catalog/model/preview/plan access returns 401 and direct private filesystem access returns 404. The published CSP nonce/injection check passed. Live evidence is retained outside public source in `C:/CODEX/Agent002/output/coatria-conversation-live/`. The previous deployment `dpl_82KcRDweSBTSu2aYZfZ14AX8Dnkj` remains the rollback target; this release needs no database rollback.

Eight published UI checks passed using isolated API fixtures and private local models. Two actual licensed character rigs and seven furnishings remained rendered while the office dock resized the same canvas/renderer instance; closing restored its dimensions. Fixture message sending, full sidebar, per-channel drafts through expand/dock/close, mobile composer, Escape/focus and unchanged physical room/status passed. No page, console or CSP errors occurred. All API requests were intercepted; no production accounts, messages or layouts were changed by these checks.

## Earlier studio generator and character interactions release

The studio generator and shared character interactions are live at [coatria.com](https://coatria.com/#layout), released on 2026-09-11 UTC from source `c2f256792fe0c97c29d637d73318d8158be7f231`, deployment `dpl_82KcRDweSBTSu2aYZfZ14AX8Dnkj`. Four new studio presets and a seeded generator support 1–60 workstations, 0–8 furnished meeting nooks, three arrangements and wider aisles. Faster walking, double-click running, double-right-click teleporting, authored Wave/Dance, six emoji reactions and shared exclusive seating are available in the office. Audio rooms remain separately configured. See the [generator guide](OFFICE_GENERATOR.md), [interaction controls](CHARACTER_INTERACTIONS.md) and [release evidence](RELEASE_STUDIO_INTERACTIONS.md).

Exact-source PostgreSQL CI passed both jobs: 125 application tests passed with one private-file skip, and 50 independent sessions completed 5,415 measured requests with zero unexpected errors and p95 16.99 ms. All concurrency, isolation, expiry, reconnect and cleanup checks passed. The full 60-second React renderer run with 50 moving people averaged 59.53 FPS on the measured local device. These isolated tests do not establish public-site or worldwide capacity. The licensed Vercel build and live health, CSP and anonymous private-asset boundary checks passed. Additive migration 006 is applied; runtime credentials and grants are unchanged. Existing floors are preserved until a new draft is saved.

## Earlier fifty-person office and test lab release

The 50-person studio and Test lab are live at [coatria.com](https://coatria.com/#tester). The office has 50 independent workstations and 148 furnishings on a 30 × 20 metre floor. Administrators can apply it as an editable draft and run browser simulations with 10, 25 or 50 people. The isolated HTTP harness tests 50 authenticated sessions against a production Next build and fresh PostgreSQL service. See the [scale testing guide](SCALE_TESTING.md) for controls, evidence and capacity limits.

Renderer testing on Edge 152 with an AMD Radeon 890M at 1536 × 1000, DPR 1, measured 60.0 FPS with all 50 characters moving and 148 furnishings loaded in balanced quality; rendered-frame p95 was 16.8 ms. Low quality reached its 30 FPS cap, with frame p95 33.4 ms. These are device-specific steady-state samples, not general hardware or hosting guarantees. The full 60-second user-facing moving scenario also passed: average 59.96 FPS, worst sampled frame p95 17.1 ms, all assets loaded and no runtime errors.

[PostgreSQL CI reference run 34540216174](https://github.com/stratostormstudios/coatria/actions/runs/34540216174) passed for source `2eb14ac2b69cb73c0ff96bcef3867bd64aed35d3`: 50 sessions, 5,408 requests in 60.01 seconds, p95 13.8 ms, zero errors, all 14 checks and cleanup passed. This is isolated loopback CI, not Coatria.com capacity. The application job passed 95 of 96 tests; the only skip is private licensed-file inspection, verified locally. History credential scanning, audit (zero vulnerabilities), TypeScript, source-only CI build and licensed local build passed. Browser coverage includes 36 tester/navigation/synchronization/reference cases and 19 renderer regressions.

Released from source `b83babd27b3877677475d39feaa1351657470ffb`, Vercel deployment `dpl_J6eQg3hea6fUdzYbXvfqMmZsJayW`. [Exact-source CI run 34540627679](https://github.com/stratostormstudios/coatria/actions/runs/34540627679) passed both application and scale jobs. Its repeated 50-session run completed 5,417 requests with zero unexpected errors, median 8.38 ms and p95 337.2 ms; correctness, latency budget and cleanup passed. The difference from the earlier 13.8 ms reference p95 illustrates run-to-run variation; neither is a live-site latency guarantee.

The Vercel build verified all 12 private characters and 78 office objects. The promoted domain returned HTTPS 200 and ready database health. The published reference report matched its recorded source and checks. The live CSP test passed; anonymous catalogue/model/preview/plan access returned 401 and private filesystem access returned 404. Live browser fixture verification loaded all 50 rigs and 148 furnishings, displayed the reference, and reported no runtime errors. Scoped accessibility checks across three panels at 1536 × 1100 and 390 × 844 reported no selected WCAG 2 A/AA or 2.1 AA violations and no overflow. These UI checks used isolated browser API fixtures and licensed local files; they did not create production users or load-test Vercel.

Existing company floors are preserved. Applying the 50-person studio changes the editor draft until saved; compatible rollbacks must support version 1 floor documents, purchased items and the 180-object limit. No database migration or runtime grant change was needed. Live verification artifacts are retained outside public source in `C:/CODEX/Agent002/output/coatria-scale-live/`.

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
