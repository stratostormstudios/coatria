# Generated-media continuation — planned

**Design only. Not implemented, deployed or authorized.** This document does
not approve inference, generation, transfers or migrations. Existing policy
approvals must not acquire the proposed capability automatically. The v2
generated-media workflow itself remains subject to its release gates in
[STUDIO_GENERATED_MEDIA.md](STUDIO_GENERATED_MEDIA.md).

## Current gap and manual path

A specialist can claim a v2 generation task and prepare an exact Higgsfield
request, then stop for human credit approval. Provider execution and a
separately approved archive may finish after that specialist run ends.

The coordinator cannot currently resume that task against its verified archive:
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

Add an explicit, default-off generated-continuation opt-in to the finite
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

## Proposed data model

The next migration after 030, provisionally
`031_studio_generated_followups.sql`, would add an immutable
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

Add a separate `studio-generated-followups` service/protocol rather than change
the meaning of existing dispatch selectors:

- Member GET `.../studio/projects/{id}/generated-followups`: bounded, paginated
  eligible identities, blockers and historical continuations; no transfer URL.
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
branches silently. Replays use the same step IDs and reviewed arguments. Derive
permitted post-claim/post-registration/post-submission states from exact receipts,
including this operation's own revisions. Check project revision at dispatch
and mutation; thereafter compare relevant gates/specification/role/source so
unrelated project work does not invalidate a legitimate continuation.

A repeated dispatch reauthorizes the caller/policy and returns the recorded
child without another budget increment. A changed archive for the same source
child conflicts. Failed or expired children cannot be automatically requeued.
Historical GET remains separate from permission to execute. Preserve original
producer and account attribution; record the new registrar independently.

## Database-time prerequisite

Current `studio-coordination.ts` uses host `Date.now()` for policy expiry and
creation bounds. Before adding this authority path, replace those decisions
with database time sampled after the relevant locks, including a final
pre-commit deadline check. A skewed host clock or a long lock wait must not
extend approval. This is a required narrow correction, not a relaxation of
expiry or a new approval.

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
