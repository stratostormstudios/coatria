# Coatria 0.1 — security-update release status

Status recorded **2026-09-08**. The security update is deployed at [coatria.com](https://coatria.com). PostgreSQL CI passed all 38 tests, migration 004 is applied, the restricted production connection is verified, and 39 live API checks plus 16 production browser checks passed. Audit-fixture cleanup is complete. The [security review](SECURITY_REVIEW.md) records corrected issues and unresolved controls; historical first-release evidence is kept separately below.

| Item | Current state |
| --- | --- |
| Repository | [stratostormstudios/coatria](https://github.com/stratostormstudios/coatria) contains the application, migrations, tests and implementation plan |
| Reviewed source | `5592ed26a0d584da316c4cf28d03f958c157df1a` |
| Vercel | Security-update deployment `dpl_2EseivSFaWDinc7dJhZBok1wZcoA` is READY for source `5592ed26a0d584da316c4cf28d03f958c157df1a` |
| Domain | [coatria.com](https://coatria.com) returned HTTP 200 over HTTPS and health reported ready; live nonce-based CSP verified |
| Production database | Neon `coatria-production` preserved; all four numbered migrations applied. `coatria_runtime_v1` pooled login and restricted grants verified |
| Project environment | Only production `APP_URL` and sensitive Secret `DATABASE_URL`; no owner aliases or preview database credentials. Resource environment injection detached without deleting Neon |
| Git deployments | No Git repository connection is configured in Vercel; automatic Git deployment is not enabled |
| Deployment protection | Vercel reports `ssoProtection: all_except_custom_domains`; this does not invalidate old deployment credentials |
| Main branch | Read-only inspection reported unprotected `main` and no repository rulesets; administrator configuration remains open |
| Scale | Small-team implementation with bounded polling and calls; no million-user load test has been completed |

For this update, 39 live API checks and 16 production browser checks passed. Browser verification covered desktop/mobile layouts, the actual 3D office and persistent task/vault writes without JavaScript errors. Five temporary users and four companies were removed across audit QA using exact recorded IDs. Credential rotation and privileged historical deployments remain separate open gates after a healthy deployment.

## Implemented

- Personal account registration/login/logout, profile editing, secure password changes and server sessions.
- Company creation with a furnished or blank floor, company switching, invitations, member roles, ownership transfer and offboarding.
- A real low-poly 3D office with the optimized rigged character, shared presence, walking, camera controls, floor editing and an accessible room list. Occupants use stable IDs; stale people and agents without recent heartbeats are not displayed as live coworkers.
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

- Presence normally refreshes every five seconds and expires after 45 seconds. This is a small-team transport; continuous low-latency global presence needs another scaling phase.
- Authenticated signaling polls approximately every 1.5 seconds. Capture and peers close after terminal access errors, on leaving the room, or when authorization cannot be refreshed for 45 seconds. Browser scheduling and network propagation mean this is not an instantaneous external-device erasure guarantee.
- An agent avatar requires active status and a recent observed heartbeat. Naming a harness does not install or run it, and reported tokens are not independently metered.
- The connector publishes metadata for at most 1,000 non-hidden files, with a directory-depth limit. It does not mount a drive, stream footage, synchronize files or provision a server. An incomplete index is not uploaded as a successful snapshot.
- Password changes require the current password. Verified email delivery, forgotten-password recovery, MFA and enterprise SSO are not enabled. Public signup does not establish mailbox ownership. Email-restricted invitations require verified accounts; ordinary links are single-use bearer invitations, and hiring acceptance links are bound to the reviewed account.
- Offboarding blocks invitations issued before access removal. A newly issued invitation can restore access intentionally. Recorded task authors remain ineligible to approve that work after reopen/resubmit cycles.
- Tenant and private-vault authorization are application-enforced, without per-tenant PostgreSQL RLS. The runtime role limits administrative privileges but retains the application DML needed to operate accounts and companies.
- Personal-vault access is separate from company membership. A reviewed company-to-personal skill export and the related licensing/continuity workflow remain later work; ordinary personal export does not establish employment IP ownership.
- Candidate acceptance issues an invitation to company membership in this release. Granular project-only guest engagements, contracts and marketplace payments remain future work.

## Validation evidence

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
