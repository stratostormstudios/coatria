# Coatria 0.1 — release status

Status recorded 8 September 2026. The first-release application has been implemented and tested locally. A working production deployment is **not yet verified**. The database provider and Git deployment connection still require account-holder setup.

| Item | Current state |
| --- | --- |
| Repository | [stratostormstudios/coatria](https://github.com/stratostormstudios/coatria) exists |
| Vercel | Project `coatria` exists on the Coatria team; deployment is in progress |
| Domain | `coatria.com` is verified in the Vercel project; live application routing remains a deployment check |
| Production database | Neon provisioning awaits account-holder acceptance of provider terms; no configured production persistence is claimed |
| Git deployments | Vercel's GitHub login connection is pending; a repository alone does not enable automatic deployments |
| Scale | Small-team implementation with bounded polling and calls; no million-user load test has been completed |

This record separates implemented behavior from external service readiness. Update the deployment state and verification evidence after the live checks pass.

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

Automatic GitHub deployments additionally require the Vercel account's GitHub login connection. Direct Vercel deployments can be used independently.

Reliable media across restrictive networks requires a TURN service. Without it, calls use direct WebRTC connectivity. Calls are limited to the lower of room capacity and six participants.

- Presence normally refreshes every five seconds and expires after 45 seconds. This is a small-team transport; continuous low-latency global presence needs another scaling phase.
- Authenticated signaling polls approximately every 1.5 seconds. Capture and peers close after terminal access errors, on leaving the room, or when authorization cannot be refreshed for 45 seconds. Browser scheduling and network propagation mean this is not an instantaneous external-device erasure guarantee.
- An agent avatar requires active status and a recent observed heartbeat. Naming a harness does not install or run it, and reported tokens are not independently metered.
- The connector publishes metadata for at most 1,000 non-hidden files, with a directory-depth limit. It does not mount a drive, stream footage, synchronize files or provision a server. An incomplete index is not uploaded as a successful snapshot.
- Password changes require the current password. Verified email delivery, forgotten-password recovery and enterprise identity integrations are not enabled.
- Personal-vault access is separate from company membership. A reviewed company-to-personal skill export and the related licensing/continuity workflow remain later work; ordinary personal export does not establish employment IP ownership.
- Candidate acceptance issues an invitation to company membership in this release. Granular project-only guest engagements, contracts and marketplace payments remain future work.

## Validation evidence

The following evidence is local development validation, not a claim about the live Vercel environment:

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

The implementation plan in this directory defines the acceptance gates for these phases. Connection instructions describe what the current adapters actually do.
