# Managed project references

This implementation connects exact project-storage image versions to company Higgsfield generations. It is a prepared-image workflow: PNG, JPEG or WebP, at most 10 MiB, 4096 pixels per dimension and 16 million pixels. These are Coatria policy limits, not claims about provider limits.

The original file may be linked separately for provenance. It is never substituted for the prepared image. Inspection fully decodes the prepared image and checks its hash; it does not resize, re-encode or remove embedded metadata. The approval explicitly covers all unchanged bytes. Automatic proxy preparation remains separate unfinished work.

## Authority and execution

1. A member or assigned, leased agent proposes an exact version, hash, byte count, role and purpose against a current project and reference/generation task.
2. A qualified worker reads that version into private bounded scratch storage, verifies all bytes, and records full image inspection. No Higgsfield upload occurs at this stage.
3. An administrator reviews the exact image and grants finite sharing permission. Inspection and archive approval do not confer this permission. Agents have no approve/revoke tools.
4. The worker rechecks source, storage, project, task, sponsor, provider connection and approval. A server broker keeps company OAuth private and records a durable intent before allocating an upload, sending bytes or confirming it.
5. Each provider-changing phase is once-only. Lost responses, lease loss after an intent, or failed receipt commits retain an uncertain outcome. They are never automatically replayed.
6. Generation proposals select internal `referenceIds`. The server resolves confirmed approved roles/media IDs, stores the immutable reference snapshot in the generation hash, and revalidates it before cost preflight and paid dispatch. Raw media arguments cannot be combined with this managed path.

Revocation stops future work at the next authority check. It cannot undo bytes already disclosed. Provider confirmation proves the supported receipt was observed, not that generated media, creative review or client delivery is complete.

Inspection, approval and transfer pin both the exact project revision and its immutable semantic snapshot. There is one consumption-only exception: a confirmed reference from an accepted, unchanged reference task may remain usable by its direct generation successor on the same shot after a bookkeeping revision change. The complete normalized project row must still match, excluding only `revision` and `updated_at`; brief, specification, gates, status, client and all other fields remain pinned. The task content, role, shot, current production round, source, storage, provider connection, sponsors and finite approval are revalidated. The generation request separately pins its current project revision.

For agent proposals, inspection requires the original proposing run to remain running with a live lease and its current grants until inspection has been recorded. If that run finishes or expires first, the worker blocks the proposal; it does not silently acquire a durable file-read grant. A fresh authorized proposal is then required. Finite human approval after inspection adopts the transfer, so that transfer may outlive the originating run while all other current authority checks still apply. Durable inspection sponsorship after a run ends is not implemented.

## Interfaces

Session endpoints are under `/api/companies/{companyId}/higgsfield/references`: paged list/proposal, `/candidates`, exact `/{referenceId}`, and administrator `/{referenceId}/approve` and `/revoke`.

Leased agents use `higgsfield_reference_propose`, `higgsfield_reference_candidates_list`, `higgsfield_references_list` and `higgsfield_reference_get`. Current storage, studio and creative capabilities are checked. No endpoint exposes OAuth, upload locators, worker leases, arbitrary provider calls or original file bytes.

The first-slice backend requires `creative.read`, `creative.write`, `studio.read`, `studio.write`, `tasks.write` and `storage.read` on the agent and authenticated run, together with its task reservation. Existing AI-production ingest staffing includes `creative.read` but does not include `creative.write`, so those existing ingest identities cannot use this reference workflow without a separately reviewed grant change. This implementation does not expand existing identities or staffing grants. Metadata reads may inspect references from another role under the reader's own current project task; proposal and generation-use authority remain bound to the exact relevant task.

The server-owned generation profiles expose `higgsfield_references_list` after the assigned task is reserved. Its paged metadata lets the harness discover confirmed internal IDs and pass them as generation `referenceIds`; the server still validates finite approval, exact task/dependency and provenance. The narrower coordinator-generation child replaces its two storage-browsing tools with this project-bound discovery tool and remains within its existing catalog byte limit. Ordinary generation specialists retain storage browsing for archive destinations. Neither profile gains reference approval or upload powers.

The existing reference-stage dispatch profile still omits reference proposal and candidate-discovery tools. Registering these tools in the general leased-agent API does not make them available to that restricted harness profile. Together with the existing ingest grant and live-run inspection requirements above, this remains a separate autonomous preparation gap; the generation consumption path assumes an already inspected, human-approved and confirmed reference.

## Activation status

The reference worker is disabled by default. This change does not deploy a worker, create a host, grant a database role, enable a credential, migrate production or spend provider credits. Activation requires qualification of the actual company catalog and receipt shape, exact upload hosts, bounded storage reader, isolated decoder and finite company/project runtime. A matching ChatGPT plugin schema is supporting information, not evidence of the company's MCP contract.

The first adapter accepts `media_upload` with a single generated filename, content type and `method: upload_url`; it accepts one structured PUT allocation and one structured image confirmation with status `confirmed`. Unknown schemas and receipt shapes fail closed and need adapter review. Synthetic fixtures prove the local state machine, not live compatibility.

Managed generation arguments must satisfy the entire supported tool schema, including required fields, scalar and array bounds, and media item constraints. The applicable `params` schema branch must bind the selected model through `model.const` or a one-value `model.enum`, and explicitly advertise each selected reference role. A generic model string and broad role enum do not prove per-model support and are deliberately rejected. A future reviewed per-model descriptor adapter is needed if the company catalog supplies only generic schemas. Unknown assertions, schema references and provider regex patterns are rejected rather than evaluated or ignored; this may reject otherwise valid provider models until their compatibility is reviewed.

The broader goal still needs automatic proxy preparation and a live reference → generation → archive → independent QC → delivery → client acceptance verification.
