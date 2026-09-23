# Generated-media continuation

**Application deployed; operational pilot still pending.** The verified
2026-09-20 release at source `41bbaf0` includes this default-off continuation,
with migrations 030–033 and application runtime grants verified in production.
[RELEASE_STATUS.md](RELEASE_STATUS.md) is the authority for deployment and test
evidence. Archive and storage-gateway execution remain disabled; their separate
service roles, host/storage qualification and an authorized provider-to-client
pilot are still outstanding. Existing policy approvals do not acquire this
capability automatically. See [STUDIO_GENERATED_MEDIA.md](STUDIO_GENERATED_MEDIA.md)
for the workflow boundaries.

## Historical gap and manual alternative

The following gap describes the architecture before migration 031. The
source-bound continuation documented below now addresses it; ordinary dispatch
and the legacy DCC follow-up retain their original meanings.

A specialist can claim a v2 generation task and prepare an exact Higgsfield
request, then stop for human credit approval. Provider execution and a
separately approved archive may finish after that specialist run ends.

The original coordinator dispatch could not resume that task against its verified archive:
`studio_work_dispatch` replays the original child for an already dispatched
work item; its continuation selector supports only DCC `executionJobId`.
Ordinary dispatch permits completed DCC work to resume, but a creative task
left `doing` remains blocked. Legacy creative-followup explicitly rejects v2;
its human-attested v1 receipt must not be repurposed as verified provenance.

In the current v2 implementation, a current owner/admin can register an exact
verified archive after the task's previous agent run is terminal. Alternatively,
a separately requested ordinary run of the currently assigned specialist can
claim the existing task after its previous reservation is succeeded, failed or
cancelled. With current gates, role, requester, sponsor, lease and grants, it
can register the archive and submit the task. If the exact source is already
registered, reuse that artifact. This is a manual authorized path, not an
automatic source-bound continuation. Registration, submission, independent
media QC and task acceptance remain separate operations.

## Smallest complete workflow

The implementation adds an explicit, default-off generated-continuation opt-in to the finite
coordination policy. A human administrator must review a new policy revision.
One eligible verified archive then permits one child of the original assigned
specialist to read its evidence, claim the existing task, register that archive
if necessary, and submit the task for independent review. The child cannot
generate, copy files, approve anything or delegate.

Eligibility requires the exact original `studio_coordination_dispatches` child
to have produced the request, a terminal source run, matching current assignment
and task reservation, approved business gates, completed dependencies, valid
policy/sponsors and no competing active child. A terminal failed or cancelled
source run is eligible only if the independently approved request and verified
archive establish its exact source; the run's text is never completion proof.

Use `loadVerifiedGeneratedSource(..., {requireAvailable:true})`, or
`loadStoredGeneratedArtifact(..., {requireAvailable:true})` for a pre-existing
registered artifact. Check current storage/source availability and exact
immutable evidence. A completed archive's historical lease expiry does not
invalidate its provenance or supply new authority.

## Data model

Migration `031_studio_generated_followups.sql` adds an immutable
`studio_generated_followups` table with:

- Company/project/work/task IDs; original source child; new parent coordinator
  run and specialist child; coordinator/specialist IDs; approved policy revision
  and administrator.
- Exact request/job/output/archive/storage-version IDs, specification SHA-256,
  measured file SHA-256/length, and strictly validated canonical source evidence
  plus its SHA-256. No provider locators, credentials or raw journals.
- Initial task revision and relevant gate/role fingerprint; optional exact
  pre-existing artifact ID/manifest hash. This immutable choice distinguishes
  reuse from registration by the child.
- Fixed claim, registration and submission request UUIDs; fixed registration
  name/notes; database creation time.

Use scoped composite foreign keys to existing tables and deferred relational
checks proving the initial dispatch, request, archive and child identities
agree. Separate foreign keys alone do not prove those relationships. Required
uniqueness includes `(company_id, work_item_id, source_child_run_id)`,
`(company_id, output_id)` and `(company_id, child_run_id)`; step request IDs must
also be company-unique. This prevents alternate archives of one original source
run from scheduling additional continuations. Runtime gets SELECT/INSERT only;
updates are rejected. Progress is derived from existing task, artifact and
immutable tool receipts, not by rewriting source evidence.

The policy opt-in defaults false and is included in new approvals. Preserve
legacy policy request hashes when the new field is omitted; preserve all v1
creative-followup and ordinary dispatch receipts unchanged.

## API, authority and replay

The separate `studio-generated-followups` service/protocol preserves
the meaning of existing dispatch selectors:

- Member GET `.../studio/projects/{id}/generated-followups`: bounded, independently paginated
  archive candidates (after/nextAfter) and history (historyAfter/historyNextAfter); no transfer URL.
- Agent read tool for the exact project and optional archive.
- `studio_generated_followup_dispatch` through the existing authenticated agent
  tool endpoint: `{projectId, workItemId, archiveId, projectRevision,
  policyRevision}`. Only the live, explicitly approved coordinator may call it.

Under the established transaction lock order, serialize the exact source/work
pair, recheck authority, create the child through the existing delegation
mechanism, narrow its capabilities, set `max_attempts=1`, insert the receipt and
increment the shared lifetime counter atomically. Initial, DCC-followup and new
generated-followup children must all count toward concurrency and lifetime
limits. Editing policy must not reset consumed budget. Exhaustion permits
historical replay of an existing child under otherwise valid authority, never
a new child.

Add child authority to claim, heartbeat, context, completion and tool execution.
The exact-tool guard must run **before cached tool receipt replay**. The allowed
union is `studio.read`, `studio.write`, `tasks.write`, `creative.read`,
`creative.write`, `storage.read`, constrained to exact v2 work/source/artifact
reads and the three pinned steps. Capability strings alone are insufficient:
the guard must reject unrelated tools sharing those capabilities, including
generation proposals, new archives, download tickets and delegation.

Allow only the pinned task claim and submission; registration must use the
pinned archive and fixed metadata. If another actor registers that source while
the registration branch is pending, stop for reconciliation rather than switch
branches silently. The model calls `studio_generated_followup_advance` with only projectId, workItemId and step (claim, register or submit). Server-owned inner operation IDs, revisions and fixed metadata remain stable even when Codex, Claude or the provider adapter creates a new transport UUID. Replays reuse the same committed step; models cannot substitute evidence or metadata. Derive
permitted post-claim/post-registration/post-submission states from exact receipts,
including this operation's own revisions. Check the caller project revision at dispatch and lock the current project for each mutation; thereafter compare relevant gates/specification/role/source so
unrelated project work does not invalidate a legitimate continuation.

A repeated dispatch reauthorizes the caller/policy and returns the recorded
child without another budget increment. A changed archive for the same source
child conflicts. Failed or expired children cannot be automatically requeued.
Historical GET remains separate from permission to execute. Preserve original
producer and account attribution; record the new registrar independently.

## Database-time authority

The implementation replaces coordinator approval decisions with database time sampled after relevant lock waits and at the end of authority checks. Legacy save request hashes stay unchanged when the optional generatedContinuations field is omitted. Expired exact pause remains available. The leased agent lifecycle refreshes its database clock after authority waits and before committing tool effects.

## Qualification and boundaries

Use synthetic verified-source fixtures; no paid provider calls are needed.
Required tests include all three media kinds through exact
claim/register/submit; existing-artifact reuse; concurrent duplicate dispatch;
alternate archives/outputs of the same source; shared budget exhaustion;
policy/sponsor/role/source/storage/token/lease revocation before actions and
cached replay; database expiry after lock waits and host skew; failed-child
no-retry; and wrong work/source/version/hash rejection. Exercise claim and
registration revision changes, a competing registrar and independent acceptance
after submission. Prove that initial and continuation children cannot recurse,
the continuation cannot reach any generation/approval/transfer tool, and legacy
receipt hashes remain unchanged. Run real PostgreSQL concurrency and restricted
role tests in addition to emulator coverage.

No new worker is required: the existing qualified agent host executes the scoped
child. Waking an ended coordinator is a separate approved mission/scheduling
concern; archive completion itself must not start inference or create authority.
The first slice allows one continuation per original source child. Further
corrections need explicit reconciliation or new reviewed work. Media QC, task
acceptance, provider/worker qualification and external client delivery keep
their existing independent boundaries. Metadata reads do not inspect pixels.


## Release qualification

The implementation includes full image/video/audio leased-tool fixtures, exact-source artifact reuse, different transport IDs at every step, current policy/source/storage/sponsor revocation, wrong coordinator requester rejection, scoped context and completion only after submission. A separate persistence fixture tests deferred source relationships, append-only runtime permissions and cross-column step uniqueness. Real PostgreSQL races run in the passing release CI recorded in [RELEASE_STATUS.md](RELEASE_STATUS.md); synthetic emulator coverage cannot replace them. Migration 031 and the matching application runtime grants are verified in production as part of migrations 030–033. Existing policies stay off until a current administrator explicitly enables a new revision.

The UI exposes that opt-in and identifies generated continuation history. New generated coordinator missions include archive candidate/history reads and exact dispatch instructions. Saving a policy or paused mission starts no work. Jev remains a separate optional advisory design in [JEV_DECISION_LAYER.md](JEV_DECISION_LAYER.md); it has no execution or approval authority here.


## Concurrent configuration changes

The specialist's own credential/grant changes and explicit policy pause serialize with its held authority rows. New actions after a committed company-role, profile or coordinator-plugin change fail the policy fingerprint check. An unrelated configuration edit may overlap one action already authorized in flight; the edit is not a universal cancellation barrier for that action. Busy production roles cannot be reassigned through studio setup. To stop workers, use explicit policy pause, request cancellation and host controls for that operational purpose.


## Storage gateway compatibility

Before activating the separately deployed gateway, apply its matching restricted grants transactionally and qualify the actual service login, host and storage. The application migration/runtime rollout does not qualify this disabled service. The gateway receives SELECT only on company_id and child_run_id of the continuation table, allowing it to reject generated-child transfers without reading source snapshots, artifact facts or canonical step IDs. Its dedicated stored-lease authorization path retains the existing membership, agent, run and legacy-policy checks. Managed inference continues through the full generated-source authority path. This separation is covered by both scoped continuation tests and the real restricted gateway login/transfer test.
