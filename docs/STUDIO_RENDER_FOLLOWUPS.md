# Bounded post-render specialist follow-up

The coordinator can resume its original delegated specialist after an approved render completes, every recorded output file passes private storage verification, and a human promotes the verified image sequence into an immutable studio artifact. Human promotion selects the exact artifact; it does not approve image quality or replace independent technical and creative QC.

`studio_coordination_get` returns `renderFollowups` with the work item, execution job, original child run, assigned specialist, task, execution manifest hash and promoted artifact identity/hash. The coordinator supplies that exact `executionJobId` with the existing `projectId`, `workItemId`, `projectRevision` and `policyRevision` to `studio_work_dispatch`. All normal policy, sponsor, role, installation, business-gate and run-lease checks still apply.

A continuation requires:

- The original delegated child succeeded and produced this exact approved, successful image-sequence job. A failed, cancelled or uncertain child/job is never automatically retried.
- The current task still belongs to that source run, remains in progress, has accepted dependencies and retains its original assigned specialist. No competing renderer job may remain active.
- Every output in the immutable execution manifest has a matching server-byte verification receipt, including any native scene or report files. Sequence frame coverage must be complete.
- The human-promoted artifact preserves the original producing agent/run and exact manifest hash, remains the latest version and matches the current project specification and AI-use authorization.

Migration `022_studio_render_followups.sql` stores an immutable continuation receipt keyed to the company and execution job. It pins parent, source child, follow-up child, specialist, policy revision, manifest and artifact. Runtime permissions are `SELECT, INSERT` only. The child consumes one additional run from the existing non-resetting specialist allowance and shares its concurrency limit. It receives one attempt. Repeated requests return the same child, including after that child fails; creating a fresh request ID does not grant another attempt.

The continuation's run capabilities are restricted to `studio.read`, `studio.write`, and `tasks.write`. A server phase guard narrows these further to reading its exact work item, promoted artifact and execution job, then claiming and submitting only its existing task. Creating tasks, registering a duplicate artifact, proposing another renderer job, approving work and delegating more work are forbidden. Gate or artifact changes are rechecked before each action. A newer artifact version invalidates the continuation rather than silently changing which result it submits.

The prompt asks the specialist to inspect returned metadata, hashes and storage provenance and identify the existing artifact in its review summary. The metadata API does not inspect image pixels, so this step makes no artistic or technical QC claim. The task enters `review`; it is not accepted or delivered. The renderer's human approval, human media promotion and independent final review remain distinct.

The coordinator mission created by the UI includes this continuation branch. Existing saved missions are unchanged and need a deliberate objective update if they should discover these candidates. No mission is activated, no worker is provisioned and no provider inference is invoked merely by saving coordination settings or reading candidates.

Verification uses the real application handlers and isolated PGlite or an explicitly supplied loopback PostgreSQL test database. A fixture proposes a renderer job, records human approval, completes synthetic connector output, verifies actual synthetic bytes through the private-media APIs, promotes the artifact as a human, dispatches exactly one continuation and submits the original task for independent review. This proves control flow and authorization; it does not claim a real Blender render, cloud execution or model-output quality. An optional PostgreSQL test races distinct parent runs against the same continuation and budget.
