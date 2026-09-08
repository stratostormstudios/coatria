# Coatria — Functional implementation plan

Prepared 8 September 2026. This is an implementation contract for the Coatria application, not a claim that the features below have already shipped. Deployment evidence and a release checklist must state what is actually enabled.

## 1. Product decision

Coatria is a professional virtual workplace where people and explicitly identified agents occupy a shared office, collaborate in rooms, and contribute work that an accountable company reviewer can accept. Personal skills can remain private and portable while company data and work products remain governed by company access and agreements.

The first useful release must work for two real people in separate browsers. Creating an account, joining a company, moving through its office, talking, sharing a selected screen, discussing work, assigning a task, submitting a result, reviewing it and revoking access must change durable or live server state as appropriate. An attractive single-browser simulation does not pass this gate.

The selected brand is **Coatria** and the requested repository is **stratostormstudios/Coatria**. The intended domain is **coatria.com**. Domain ownership and DNS verification are separate from choosing the name; a Vercel deployment URL is the working address until both are verified.

The latest low-poly direction supersedes the older master plan's proposal to defer full 3D. Ship the existing lightweight office renderer with an equivalent accessible list; keep advanced world editing and unrestricted user-uploaded 3D assets for later gates. A room remains a usable workplace when WebGL is unavailable.

## 2. Starting point and reusable work

The source audit covered `commonspace-product/README.md`, `app.js`, `office-scene.js`, `office-bridge.js`, the route modules, `build.mjs`, and the ownership, architecture, rollout and harness sections of `VIRTUAL_WORKPLACE_PLAN.md`.

| Existing file or capability | Reuse decision | Required change |
| --- | --- | --- |
| `styles.css` | Preserve visual tokens, typography, spacing and component patterns | Rebrand; remove prototype controls and sample-only statistics; keep consistent error, empty and pending states |
| `office-scene.js` / `office-scene.css` | Reuse real Three.js geometry, camera, pathfinding, quality controls, focus handling and GPU cleanup | Accept stable principal IDs and current server-provided occupants; add incremental remote movement and join/leave updates; stop deriving authority from geometry |
| `office-bridge.js` | Reuse renderer lifecycle and curated GLB loading pattern | Replace global `CS` coupling with an application adapter; explicit room/desk IDs; send movement through a rate-limited presence client |
| `assets/characters/coworker-runtime.glb` | Reuse the optimized, rigged character for a first curated avatar | Preserve provenance and structural audit; validate reuse rights; do not run Meshy generation in the end-user browser |
| `vendor/` | Existing self-contained Three.js distribution can bootstrap scene integration | Keep one compatible Three.js version and its license; avoid duplicate engines from npm and vendor imports |
| `core.js` | Reuse room, desk, task and review interaction designs | Rebuild reads and mutations against authenticated APIs; acceptance belongs to the exact submission revision |
| `onboarding.js` | Reuse company setup, joining and personal-vault journeys | Replace sample account/company creation and local ownership flags with server transactions and separate personal authorization |
| `operations.js` | Reuse agent, permissions, infrastructure and offboarding designs | Replace simulated pairing, online health, billing and execution with observed provider states; unsupported operations must be visibly unavailable |
| `marketplace.js` | Reuse opening, application, candidate and engagement designs | Persist real records; enforce consent and scoped access; payment statuses may only reflect provider events |
| `app.js` | Extract icons, navigation and presentation conventions | Do not transplant its sample state, local role selector, direct `CS.save()` mutations or `localStorage` as production authority |
| 43-screen / 8-journey blueprint | Treat as a UX coverage inventory | Mark each screen functional, configuration-dependent or planned in release documentation |

The scene currently emits local movement when the avatar arrives, not a continuous multiplayer movement stream. Its public API supports mounting, disposal, walking, selection and character-model replacement; it does not currently supply a complete remote-occupant reconciliation API. That extension is a distinct integration task.

## 3. Practical deployment architecture

Use a typed web application on Vercel with server-side API handlers, a relational database and a narrow domain service layer. A single application and database are appropriate for the initial measured pilot; keep service boundaries explicit so presence, media, jobs and storage can scale independently.

```text
Browser
  ├─ Coatria UI + curated low-poly scene ─── Vercel static delivery
  ├─ authenticated application requests ─── Vercel server handlers
  │                                           ├─ PostgreSQL
  │                                           ├─ private object storage
  │                                           └─ durable job/event delivery
  ├─ office presence / room events ──────── realtime transport + shared state
  └─ microphone / selected screen ───────── WebRTC media infrastructure

Employee harness / company connector
  └─ scoped, outbound authenticated API ─── Coatria command gateway
                                             └─ permitted company resources
```

PostgreSQL is not assumed to exist yet. Provision a dedicated provider resource, place it near the application write region, use a pooled application connection and a separately scoped migration identity, and keep production separate from preview/test data. Vercel Marketplace currently provides Postgres integrations and can provision resources with `vercel install`; provider plan and region availability must be checked on the actual account. [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage)

The application must fail clearly when its database is unavailable or unconfigured. It must not silently switch to localStorage, a process-global map, or temporary server files and present that as a working production service.

For a first deployed pilot, a bounded authenticated incremental polling transport can provide genuine synchronization while a realtime provider is being configured. Advertise its actual refresh interval. Pause unnecessary polling in hidden tabs, fetch changes by cursor and use expiry for stale presence. Do not describe this as proven large-scale realtime. For continuous movement and low-latency room events, use a shared pub/sub service or a validated WebSocket implementation with durable state outside the function. Current Vercel guidance says WebSocket connections have function-duration and reconnection considerations; verify the supported runtime and plan with a deployed reconnection test. [Vercel WebSocket guidance](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)

Room audio and screen sharing have their own media path. A two-person WebRTC implementation can establish the initial working flow; robust internet operation requires tested TURN relay coverage, and larger rooms need an SFU or managed equivalent. Do not route filmed originals, live video or long-running agent processes through ordinary application request bodies.

Use deployment environment variables for secrets. Public client configuration must contain only explicitly public values. Preview deployments receive a test database and test-provider credentials. Preserve migrations, lockfiles, build commands and deployment configuration in the repository. The GitHub organization connection depends on the Vercel account plan; Vercel documents a restriction on linking organization repositories to Hobby teams. [Vercel Git repository limits](https://vercel.com/docs/limits#connecting-a-project-to-a-git-repository)

## 4. Delivery phases and explicit gates

Phases describe dependency order, not guaranteed calendar dates. Work on separate modules can overlap after their API and data contracts are fixed.

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| 0 — Repository and deployment foundation | Coatria source, repeatable build, environment schema, database migration mechanism, Vercel preview, health endpoint, branded shell | Clean checkout builds; unauthenticated health contains no secrets; deployed database write/read survives a separate invocation; repository contains no credentials |
| 1 — Identity and company core | Accounts, sessions, profile, create/join company, roles, expiring invitations, office template, people administration | Two accounts in separate browser contexts join one company; a third account cannot fetch its data; sessions and invitations revoke correctly |
| 2 — Shared workplace | Persistent rooms/layout/desks, actual presence, text chat, task lifecycle, activity, accessible office list | Two browsers observe genuine changes; reload preserves records; room access and membership revocation are enforced server-side; no sample people appear as real users |
| 3 — Communication and contribution slice | Audio, selected-screen share, room leave/disconnect handling, scoped agent API, reference worker, artifact review | Two participants exchange media; sharing stops on leave; reference worker claims authorized work and submits a versioned result; reviewer accepts the version and records contribution |
| 4 — Private skills and useful infrastructure | Separate personal vault, versioned skills, reviewed export, resource directory, one outbound company-server connector | A removed employee retains personal skills but loses company data; company retains accepted outputs; connector can list/read only its approved root and can be revoked |
| 5 — Curated hiring and commercial services | Openings, human/agent applications, agreement, scoped engagement, managed storage purchase and billing integration when configured | Hiring grants only contracted project access; webhook replay does not duplicate payment/provisioning; zero-fee terms show permitted infrastructure costs separately |
| 6 — Public launch and regional growth | Recovery, abuse controls, provider reliability, operational monitoring, independent security review, measured load envelope | Restore drill, incident drill, cross-tenant suite, noisy-tenant and reconnect load tests, cost reconciliation and documented launch limits pass |

Phases 1–3 form the working collaboration release. Phase 4 proves the product's ownership and infrastructure distinction. Phases 5–6 are required before presenting the entire public marketplace and commercial infrastructure vision as available. The interface should expose completed features and explain configuration requirements where appropriate; it must not offer successful-looking simulated purchases, calls or agent runs.

## 5. Functional user journeys and acceptance criteria

### A. Account and arrival

1. A person creates an account, establishes a secure session and chooses a display name/avatar.
2. The person creates a company or accepts a one-time, expiring invitation.
3. The company owner selects a template, names rooms, sets a company timezone and chooses initial access rules.
4. Invited members choose their profile and arrive at an assigned or available desk.

Accept when refresh, logout/login and a second device preserve the account and company. Invitation redemption must be atomic, bound to its intended scope, and reject revoked, expired or already-consumed single-use links. Job title is separate from authorization role. The owner cannot accidentally remove the last owner. Do not require users to understand database regions or internal resource IDs to enter the office.

If email verification and recovery are not configured, disclose that limitation and restrict public signup accordingly; do not invent a successful verification or password-reset email. A copyable invite link is useful before outbound email is configured.

### B. Office, room and workstation

1. The office loads only rooms and people the member may discover.
2. The member can use the scene or an equivalent keyboard-accessible list.
3. Movement updates the local view immediately and synchronizes an authorized presence record.
4. Selecting a room opens its discussion, participants and join controls; selecting a desk opens its owner and available work.
5. An owner can edit valid layout geometry and desk assignments, then publish a new revision.

Accept when two browser contexts see independent occupants and update after arrival/leave. Reject coordinates outside the configured office; movement does not grant room access. Treat presence as ephemeral with expiry and device/session ownership. Conflicting layout saves return a visible conflict instead of overwriting changes silently. A low-performance or WebGL-disabled device retains all essential operations.

### C. Chat, audio and selected-screen share

1. A member can read and post authorized room messages, load older messages and see pending or failed delivery.
2. A member chooses Join audio and grants browser device consent; microphone state is visible.
3. The member selects a screen/window through the browser picker and sees the audience before sharing.
4. Stopping, leaving, changing audience or losing membership stops local tracks and revokes grants.

Accept when text from browser A appears in B without reload, persists, and is not duplicated after a retry. Audio and screen share must be tested with two real sessions; success means actual remote tracks, not a changing icon. Denying consent, unplugging a device, reconnecting and browser-ended sharing each have clear recoverable states. Unauthorized users cannot request signaling or media access for a private room. Screen sharing never starts automatically at an assigned desk.

### D. Task and contribution

1. A member creates a task with a description, permitted assignee, completion criteria and optional deadline.
2. The human or authorized agent claims/starts work and submits an artifact or protected link with evidence.
3. A designated reviewer requests changes or accepts a particular immutable submission version.
4. Acceptance records the contributor, accountable reviewer, accepted version, evidence and timestamp.

Use a server-enforced transition model: `ready → in_progress → submitted → accepted`, with `submitted → changes_requested → in_progress`, plus explicit cancellation. An ordinary task update cannot bypass submission review. Acceptance of a stale version fails. A contributor cannot award their own acceptance unless a specifically recorded company policy permits that role overlap; agent credentials never gain human reviewer authority. Display tokens as measured resource usage, not a productivity or talent score.

### E. Bring an agent or harness

1. A sponsor registers an agent with a visible bot identity, declared harness, purpose and requested capabilities.
2. An administrator approves a bounded grant, expiry and budget policy.
3. A reference adapter authenticates, discovers only allowed work, claims a task and submits an actual result.
4. The company sees observed heartbeats, action receipts and failure states, and can pause, take over or revoke access.

The first adapter can use a simple public HTTP contract; Hermes compatibility is enabled only after an actual adapter handshake and workflow test. A dropdown is not an integration. Store token hashes where bearer-token verification permits; reveal a new worker token once. Commands require idempotency keys and revision checks. Report requested, accepted, executing, succeeded, failed and cancellation-unconfirmed separately. Revocation blocks new company actions immediately; external actions already dispatched require reconciliation.

### F. Private skill ownership and leaving a company

1. The employee creates a versioned personal skill in their own vault and can export an authorized package.
2. A company can license execution of a pinned skill version without receiving its private source.
3. Company-derived learning enters a company review process before an approved, explicitly scoped export becomes personal.
4. On removal from the company, membership, agent grants, resource grants and live subscriptions are revoked.

Accept when the former employee still sees their personal vault, cannot access company messages/files/tasks, and the company still sees accepted work. Company administrators cannot query private vault contents merely because the owner is an employee. Preserve license/provenance/classification fields and a review receipt. Technical access control does not decide employment IP ownership; published ownership terms must match the actual agreements and jurisdictional review.

### G. Shared storage and company-owned infrastructure

1. An administrator adds a resource as managed storage or a company-owned server, with a named data owner and policy.
2. A company-owned server pairs using a one-time code and an outbound connector; no universal LAN credential is sent to browsers.
3. The administrator approves specific roots, allowed operations, file types and audiences.
4. Members browse metadata and explicitly authorized proxies/downloads; originals stay on the company server unless replication is enabled.

First implement a read-only approved-root connector before native mounting, writes, sync or general VM control. Verify path normalization, traversal rejection, symlink escape rejection, file-size limits, read authorization and grant revocation. Never let a browser-supplied URL turn a Vercel handler into an unrestricted proxy to private networks. Health is the timestamp of a verified connector heartbeat, not a stored `Online` label. Heavy original footage should move through a purpose-built authorized data path with range/resume support, not a JSON API.

Managed storage must show actual provisioned capacity and usage. Server rental requires provider product selection, a displayed price/limit, idempotent provisioning, failure reconciliation and cancellation. An unconfigured rental provider produces a configuration requirement, never a successful purchase receipt.

### H. Opening, application and engagement

1. A company publishes a scoped opening with human/agent eligibility, paid or zero-fee terms, deliverables and permitted resource costs.
2. Applicants select exactly which profile and contribution evidence to disclose.
3. The company evaluates candidates and agrees on terms before granting project access.
4. An engagement records milestones, revisions, acceptance and disputes separately from payment settlement.

An application grants no company membership. Rejected candidates cannot read private company data. Agents require an accountable sponsor and a pinned offered version. Accepted engagement access expires or revokes without removing the person's other companies or private skills. A public score requires an abuse-resistant evidence model; launch with understandable contribution records before claiming a validated ranking formula.

## 6. Data model and transaction boundaries

Use stable opaque IDs. Scope company records with `company_id`; use composite foreign keys where feasible so a task in company A cannot reference a room, member or artifact in company B. Derive the acting user or agent from verified credentials rather than trusting request identity fields.

| Domain | Core entities | Important invariants |
| --- | --- | --- |
| Identity | users, sessions, account credentials, verification/recovery tokens | Session secrets hashed or strongly protected; expiry and revocation; normalized unique login identifiers |
| Organization | companies, memberships, invitations | One active membership per company/principal; role from server; one-time invite redemption; at least one active owner |
| Workplace | offices, layout_versions, rooms, room_grants, desks | Current published revision; assignment and room ACLs are authoritative; geometry is presentation |
| Communication | messages, attachments, room_sessions | Cursor pagination; author belongs to authorized scope; deduplication key; media grant expiry |
| Presence | session presence and movement state | Ephemeral TTL, sequence/revision, room/office scope, server timestamp; never an attendance score |
| Work | tasks, task_events, submissions, acceptance_records | Valid transitions; immutable submission versions; review bound to version; atomic acceptance/event recording |
| Agent control | agents, harness_connections, grants, runs, command_receipts, approvals | Separate bot identity; sponsor and tenant; expiry, revocation, scope, idempotency, controller lease |
| Personal skills | personal_skills, skill_versions, license_grants | Owner scope independent of membership; private source excluded from company reads; immutable version hash |
| Portability | export_requests, approved_exports | Company review binds exact content/version; revoked or changed request cannot reuse approval |
| Infrastructure | resources, connectors, resource_grants, transfer_jobs | Verified health; approved root and operation set; access checked at issuance and execution |
| Hiring | openings, applications, agreements, engagements | No implied membership; explicit disclosure; scoped and expiring engagement grants |
| Operations | audit_events, outbox_events, usage_ledger, billing_events | Append-only receipts where appropriate; idempotent processing; provider-confirmed state; no secret payload logging |

Important transactions include company + first owner + office creation, invitation redemption + membership, task acceptance + contribution receipt, membership revocation + descendant grant invalidation, and provider webhook deduplication + state transition. Use an outbox or equivalent durable handoff where a database mutation must cause an external event; a successful local commit is not proof of successful external delivery.

## 7. Authorization and data ownership boundaries

| Data or action | Employee | Company administrator | Agent / harness |
| --- | --- | --- | --- |
| Own private skill source | Owner access | No default access | Only explicitly licensed/versioned execution access |
| Company room messages | Authorized membership/room grant | According to company room policy | Only explicit read/post scopes |
| Company artifacts | Task/project grant | Company retention and access policy | Task-limited read or staged submission |
| Other members' roles | Read permitted directory fields | Grant/revoke within owner safeguards | No inherited administration |
| Accept contribution | Designated reviewer | If assigned reviewer authority | No human acceptance authority |
| Start screen capture | Browser user action | Cannot remotely force capture | Cannot bypass browser consent |
| Export company-derived learning | Request reviewed scope | Approve exact eligible content | No automatic private memory export |
| Provision paid resource | Authorized billing role and explicit price | According to spending policy | Approval-bound, budgeted request only |

Each protected handler authenticates, resolves current membership or grant, authorizes the resource, validates input and performs a scoped query. SQL row policies can add defense in depth, but testing must use the real application's database role; privileged connections may bypass policies. Add explicit cross-tenant negative tests even when an ORM automatically attaches a filter.

Use secure, HTTP-only cookies for browser sessions, appropriate SameSite behavior, CSRF protection/origin checks for cookie-authenticated writes, modern password hashing if passwords are supported, rate limits for authentication and invitation endpoints, and parameterized database queries. Validate WebSocket origin and authorization too. Never expose database, Vercel, model-provider, Meshy or connector secrets to client bundles.

No client role switch, hidden navigation item, bot label, object path or user-supplied `company_id` grants permission. Private responses should not enter shared public caches. Authentication failures, validation errors and server failures must use distinct HTTP responses without disclosing another tenant's existence or secret details.

## 8. Concrete engineering work packages

1. **Foundation:** create the Coatria application, pin dependencies, add ignored environment templates, build/type checks, migration runner, health checks and deployment documentation.
2. **Auth and tenancy:** implement identity/session primitives, company transaction, memberships, invitation redemption and reusable server authorization helpers before feature CRUD.
3. **Domain APIs:** define typed request/response schemas for rooms, messages, layouts, tasks, submissions and people; implement pagination, validation and concurrency handling.
4. **Functional UI:** bring across the visual language, replace sample data with API hooks, handle loading/empty/error/offline states, and build the complete arrival-to-acceptance flow.
5. **Scene adapter:** map current account and server occupants to stable character IDs; incrementally reconcile presence, dispose on navigation, throttle movement and retain the list alternative.
6. **Media:** implement actual capture/signaling, room grants, lifecycle cleanup and multi-browser verification; configure production TURN/SFU before promising reliable group calls.
7. **Worker gateway:** implement pairing/grants, heartbeats, task claim/submit, idempotent commands, pause/revoke and a runnable reference worker with a documented contract.
8. **Ownership proof:** build separately scoped vault and export review, then automate the remove-member scenario against all associated resources.
9. **Infrastructure proof:** deliver a constrained outbound connector and protected resource browser before managed provisioning or native file mounts.
10. **Release verification:** test cross-tenant access, real two-account workflows, failure recovery, secret absence, production build and deployed smoke checks; publish an accurate enabled-feature inventory.

## 9. Verification that matters

Do not replace meaningful tests with snapshots of the implementation's own labels. The initial release needs:

- An integration suite that creates two companies and attempts cross-company reads, writes, room joins, agent commands, file grants and personal-vault access.
- A real database test for invitation races, stale task acceptance, last-owner removal, idempotent worker submissions and revocation during an active session.
- Browser tests in isolated sessions for signup/login, company invitation, persisted chat, independent office presence, task submission/review and logout.
- A media test proving remote audio/video tracks, denied consent, stop sharing, room change and disconnect cleanup; a deployed relay test before claiming broad-network reliability.
- A reference worker test against the same deployed public API used by customer harnesses, including a denied command and revoked credential.
- UI checks at narrow mobile and desktop widths, keyboard operation, reduced motion, loading/error states and WebGL-disabled fallback.
- A build/source/artifact scan for credentials and accidental sample-state success paths.
- A database restore into an isolated environment and a documented rollback/migration recovery procedure before public customer data is accepted at scale.

Store test results with the deployment commit and environment. A successful static page load is not evidence that authentication, persistence, media or tenant isolation works.

## 10. Operating model and growth

For the first pilot, explicitly cap tenant size, active office occupants, media participants, agent concurrency, upload size and retention. Choose initial limits after testing; the figures below are measurement milestones, not supported-capacity claims:

| Growth gate | Workload to measure | Architectural response when needed |
| --- | --- | --- |
| First working release | Two independent accounts, one office, one controlled worker, real media | Fix correctness and recovery before expanding scope |
| Team pilot | Tens of active people per office, realistic chat/task activity, repeated reconnects | Optimize payloads, indexes, caching and presence fan-out; add provider observability |
| Multi-company beta | Hundreds/thousands of active sessions across isolated companies | Dedicated realtime state, durable queues, per-tenant quotas, noisy-tenant controls and separate media scaling |
| Regional service | Larger concurrent population with measured tenant distribution | Partition by tenant/cell, place data and workers deliberately, test failover and restore |
| Global service | Millions of registered accounts with separately measured concurrent people, calls and runs | Regional cells, routing directory, isolation boundaries, capacity reservations and residency-aware operations |

Registered accounts, daily activity, concurrent office presence, active calls, running agents and connected storage throughput are different dimensions. Publish capacity only against a tested workload and geography. Avoid a global all-to-all office channel; each office/room receives its authorized and relevant subset. Keep movement ephemeral and interpolate remotely; never perform a database write or model invocation for every animation frame.

Observe request latency/error rate, database saturation, event lag, reconnect rate, media loss/jitter, worker queue age, connector health, permission denials and cost per tenant. Separate media, agent and storage budgets so a footage transfer or runaway worker cannot consume the office's entire operating budget. Alert on provider outage and budget exhaustion; make degradation visible rather than inventing healthy states.

## 11. Release record template

Every deployed release should include a short factual record:

```text
Release / commit:
Repository:
Vercel project / deployment:
Working URL:
Custom-domain status:
Database provider / region / migration:
Authentication and recovery enabled:
Presence transport and observed refresh:
Media provider / TURN validation:
Working worker/connector adapters:
Enabled functional journeys:
Configuration-dependent or planned features:
Tests and measured limits:
Known operational limitations:
Rollback procedure:
```

The delivery is complete only for the capabilities proven in that record. The long-term product remains ambitious, but each user-visible promise must correspond to a working, authorized and observable implementation.
