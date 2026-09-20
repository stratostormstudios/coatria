# Generated-media revision rounds

The application closes the reviewed creative change-request loop for image, video and audio projects. Source `41bbaf0`, migrations 030–033 and matching application runtime grants are verified in production as of 2026-09-20. [RELEASE_STATUS.md](RELEASE_STATUS.md) is the authority for the deployment and passing CI evidence. Archive and storage-gateway execution remain disabled pending their separate service roles and actual host/storage qualification; a genuine provider-to-client pilot is still outstanding.

An authenticated external client first records `changes_requested` against an exact delivery package. The producer drafts a plan linked to that share, receipt and package digest. Every existing deliverable must be classified as **regenerate** or **keep its approved version**, with at least one regeneration. Regenerated items carry concrete correction instructions. Retained items pin the original artifact, independent review, storage version and hashes.

A current human administrator applies the exact saved plan digest at the reviewed project revision. The server creates a new immutable round and fresh planning, reference, generation, QC and delivery-handoff tasks. Accepted tasks, original media and client receipts remain unchanged. Coordinator approval is paused and its lifetime run counter is preserved. Fresh production gates and any paid provider requests require their separate approvals.

The replacement package contains the complete deliverable set: fresh independently reviewed outputs plus the exact retained versions. A new invitation identifies the revision round. Historical invitations retain their original snapshots and final responses; they cannot grant current-round downloads or accept the new package. The recipient must submit a new authenticated response to the replacement invitation.

## Interfaces

Company session routes use `/api/companies/{companyId}/studio/projects/{projectId}`:

| Method and suffix | Effect |
| --- | --- |
| `GET /generated-revisions` | Current change-request source and paged saved plan summaries |
| `GET /generated-revisions?planId=…` | Exact immutable plan |
| `POST /generated-revisions` | Draft a complete selective revision plan |
| `POST /generated-revisions/{planId}/apply` | Human administrator applies the reviewed plan hash |

External agents use the existing authenticated, leased tool API:

- `studio_generated_revisions_get` reads feedback and saved plans with bounded item pagination.
- `studio_generated_revision_draft` creates a draft from exact source identities. The transport request ID supplies the server operation ID.
- `studio_get` pages current work. Exact work reads can inspect prior rounds and explicitly identify them as historical.

There is no agent apply or production-approval tool. Client notes and correction text are project data and never grant permissions. Retry uncertain mutations with the identical request ID and body; changing the plan, source or approval revision requires a new reviewable operation.

## Coordinator missions

Newly scheduled generated-project coordinators use objective version 2. Before reporting that no work is ready, the objective instructs the coordinator to read the current change receipt, exhaust saved-plan and deliverable pages, and select an existing applicable draft or propose one complete selective draft. Immediately before drafting, it repeats the complete plan-summary pagination, checks the same source and project revision on every page, and selects any matching draft that appeared during that refresh. It then stops for human application. Ambiguous feedback, technical scope changes, insufficient context/steps, and uncertain writes remain blockers. This is an instruction to the model, not a uniqueness constraint preventing independently authorized humans or missions from drafting alternatives.

The stock objective fits the existing 3,000-character mission limit. Existing saved missions retain their exact reviewed text; an administrator must review any replacement or edit. A deterministic bridge fixture exercises real mission creation/activation, leases, the full tool catalog, paged reads, one draft, receipt replay, selection on the next cycle, a matching draft appearing on a later refresh page without a second draft, and a stale-source denial with no new round, generation or invitation. Synthetic model replies establish protocol behavior, not live model judgment or prompt-injection immunity.

## Limits and remaining scope

This slice preserves the existing approved technical specification and deliverable set. Changes to duration requirements, dimensions, codec, unit count, commercial terms or technical scope require a separate scope-change workflow. A studio approval is not a client's acceptance of changed commercial scope.

The pilot permits at most 20 applied rounds and 200 saved plans per project, alongside the existing artifact and package limits. It does not authorize automatic generation, credit spending, file transfer, client messaging or acceptance. The application/schema rollout is complete. Runpod live-storage conformance, the separately restricted archive/gateway services and actual host qualification, followed by an authorized generation with independent human QC and genuine client acceptance, remain operational acceptance steps.
