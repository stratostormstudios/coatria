# Machine review of studio planning

Implemented in migration `018_studio_review_policy.sql`, `studio-review-policy.ts`, and its strict protocol schemas. This is an explicit, administrator-approved **machine planning review** capability. It is not independent human review, media inspection, commercial approval, production authorization, or client acceptance.

## Approval and execution

An owner or administrator selects one coordinator and a different reviewer for one project. Both must have current same-company plugin installations, active credentials, valid administrator sponsorship, and the approved exact configuration. The coordinator must be assigned the producer or coordinator studio role. Its run requires `studio.read` and `studio.write`. The reviewer needs the separate opt-in `studio.review` capability and `studio.read`; the policy does not add grants, change provider limits, start a worker, or create inference infrastructure.

Approval covers an explicit subset of `estimate`, `breakdown`, and `ingest`, only when the work item actually uses `execution=agent`. The current template creates human ingest work, so listing `ingest` in a policy does not convert it into autonomous work. Enabling agent ingest in a future project mode requires an explicit product and API change. Any eligible ingest review captures at most 32 exact immutable input-reference records and labels them as provenance metadata; no footage is downloaded or decoded by the review service.

The policy expires within 24 hours and permits 1–100 reviewer runs over its lifetime. The counter is reserved in the same transaction that creates the reviewer request. Failed, cancelled, and uncertain attempts remain charged to that **number-of-runs** allowance; it is not a dollar budget. Reapproval never resets usage. Reviewer requests have one attempt, with no automatic inference retry after failure or lease expiry. This allowance is separate from the specialist coordination allowance and the coordinator's own inference limits.

The default disallows a reviewer with the same human sponsor as the producing agent, or whose sponsor previously authored the task. An administrator may explicitly enable `allowSharedSponsor` for machine review. This never permits the same agent to review its own current or historical contribution, and never represents the result as independent human review.

## Exact submission and outcome

The coordinator queues a review with the project, work item, current submitted task revision, and exact policy revision. The source must be a completed agent run by the currently assigned producer, with a nonempty submitted contribution. Current studio gates and dependencies must permit the work. The server stores an immutable bounded snapshot of the approved brief, technical specification, task submission, producing agent/run, and relevant input references, plus its SHA-256 checksum. A review is unique to the exact submission revision and producer run; duplicate requests return the same reviewer request without consuming another reservation.

The reviewer must call `studio_review_read` on its exact live assigned review run. That call persists an immutable attestation that the run received the snapshot. It does not prove that a model understood the contents. The decision tool requires the returned checksum and policy revision, and rechecks current task revision, brief, producer assignment, gates, credentials, and policy before writing.

| Decision | Durable task effect |
| --- | --- |
| `approve` | Marks the task done, records `approvedAgentId` and `machineReviewId`, leaves `approvedBy` null, and unlocks dependencies that require accepted planning work. |
| `changes_requested` | Returns the task to todo and releases its old producer reservation. Dependencies remain blocked. |
| `reject` | Keeps the task in review and records the rejection. Dependencies remain blocked. A revision edit alone cannot request another review of the same producer submission. |

Every decision is immutable and includes an explanatory note. A different decision cannot overwrite it. A new producer pass is required for another submission. Existing coordination allows one specialist child per work item, so automatic specialist rework is a separate future increment; an administrator can explicitly dispatch a new producer pass after appropriate task state changes. Human review remains available through the existing task controls and follows its existing conflict rules.

Changing or pausing approval fences queued and running reviewer requests. Worker heartbeat handling aborts the active harness when the server reports `STUDIO_REVIEW_AUTHORITY_ENDED`; cancellation is cooperative, not instantaneous rollback of prior committed actions. An exact status-only pause remains available even when the configured agent is unavailable or approval has expired. Already committed terminal completion receipts can still be replayed with their original identity, lease proof and request hash after policy expiry; this cannot authorize new decisions.

## API and agent tools

All paths below are under `/api`. Human policy writes require current owner/admin membership and a `clientId` idempotency key. Exact historical review reads require current company membership.

| Route | Contract |
| --- | --- |
| `GET /companies/:companyId/studio/projects/:projectId/review-policy` | Policy, effective authority, lifetime usage, and up to 100 compact review receipts. The policy itself allows no more than 100 reviews. |
| `PUT /companies/:companyId/studio/projects/:projectId/review-policy` | Exact revision, coordinator/reviewer IDs, allowed stages, shared-sponsor choice, maxReviews, status and absolute expiresAt. No agent policy writes. |
| `GET /companies/:companyId/studio/projects/:projectId/planning-reviews/:reviewId` | Exact immutable submission and its recorded outcome. |

| Tool | Required scope | Arguments |
| --- | --- | --- |
| `studio_review_policy_get` | `studio.read` | `projectId`, optional `workItemId`, `after`, `limit` (default 10, maximum 50). |
| `studio_review_dispatch` | `studio.write` | `projectId`, `workItemId`, `taskRevision`, `policyRevision` |
| `studio_review_read` | `studio.review` | `reviewId`; persists the read attestation and a standard tool receipt. |
| `studio_review_decide` | `studio.review` | `reviewId`, `policyRevision`, `submissionSha256`, `decision`, `note` |

The agent policy overview caps each note at 160 Unicode code points and labels truncated notes. It returns at most 32,000 serialized bytes, reducing the number of rows if needed and exposing `page.hasMore` and `page.nextAfter`; callers must retain `workItemId` when continuing a filtered page. Exact cursor ownership is checked against the company, project and work filter. Full submission snapshots are not included in this overview. Human history retains complete notes.

All mutations use the existing live run/lease authorization and durable tool-receipt envelope. Reviewer and specialist child runs cannot schedule further reviews. Prompt instructions cannot confer reviewer authority. The reviewer instruction generated by the server explicitly requires reading the snapshot before deciding and forbids claiming media inspection, performing the work, authorizing business gates, or scheduling additional agents.

## Validation and production boundaries

`tests/studio-review-policy.test.ts` uses actual HTTP handlers and PostgreSQL-compatible fixtures for the producer→submission→review workflow, no mocked model success. It checks tenant/admin policy boundaries, explicit same-sponsor approval, current/historical self-review denial, exact read/hash/revision matching, rework and rejection, unchanged human gates, one-attempt uncertainty, finite lifetime usage, revoked or stale configuration, safety pause, and terminal receipt replay. Three additional PostgreSQL-only tests exercise completion versus manual dispatch, decision versus policy pause, and distinct parent transactions deduplicating a single review reservation. Run those against real PostgreSQL before release; the emulator cannot validate row-lock concurrency.

No live model quality or judgment accuracy is established by these database tests. Production rollout must migrate and grant the new tables, deploy the API and worker authority handling together, pin hosted workers to the reviewed release, explicitly grant the reviewer capability, and obtain the project policy approval. The human business gates, DCC job approval, final media QC, and delivery/client approval paths remain governed by their existing controls.
