# AI production Studio: implemented pilot

Implementation inventory, 2026-09-18. This describes the current repository. Applying migrations, deploying the website, configuring private storage, and starting a reviewed host are separate operational steps. This document is not evidence that a live fleet, a production render, or a client delivery has occurred.

Coatria now connects a company structure to real agent identities, bounded agent work, a controlled Blender renderer, private output verification, and independent review. The useful unit of progress is an accepted task or an exact version with evidence. Office characters, a queued job, and a model's completion message do not establish production completion.

## The concrete workflow

| Step | Implemented behavior | Required authority or connection |
| --- | --- | --- |
| Design the company | Choose the VFX template, company brief, requested agent count, disciplines, provider, and optional independent reviewer. Review the actual specialist grouping, roles, personas, shared skills, grants, and model limits. | An administrator applies the exact proposal revision and plan hash. An authorized harness can propose a plan but cannot apply it. |
| Create or bind specialists | Apply the reviewed staffing plan atomically. New specialists are real plugin installations and agent identities; selected existing agents retain their disclosed grants and configuration. | New identities start paused and unconnected. No worker or inference starts. Existing-agent changes invalidate the plan. |
| Connect a bounded host | Register a company-scoped host, enroll exact installation revisions, and explicitly activate the chosen identities. A separately deployed supervisor retrieves encrypted credentials through a short lease. | Server keyring, an approved endpoint/model, and either a privately configured host or an explicitly approved managed CPU plan. |
| Plan the project | Save client brief, rational frame rate, dimensions, color space, format, AI-use policy, shots, handles, and disciplines. Coatria creates tasks with dependencies and business gates. | Humans approve scope and production. Unknown AI-use permission blocks AI media work. |
| Execute assigned work | Dispatch planning tasks to the assigned agent. For DCC work, an explicitly permissioned specialist can propose a bounded connector job against the existing task. | Agent run lease and grants; `studio.execute` is a separate opt-in. A human approves the exact renderer job before it queues. |
| Verify and review media | The renderer records native scene/frame output evidence. Separate private-media APIs upload declared files and hash stored bytes. A complete verified sequence can become a pending Studio version. | Connected renderer, configured private Blob store, explicit media transport, then independent technical and creative review. |
| Prepare delivery | Seal approved exact versions, grant a designated external account access to verified private files, and record its authenticated acknowledgement or change request. | Current independent approvals and out-of-band client identity confirmation. Access issuance is separate from file receipt; creating an invitation sends no message. |

## Staffing is an access plan

The curated structure contains eleven responsibilities, including a human QC role. The staffing planner accepts a requested count of one to eleven agents but creates only the useful non-QC specialist groups for the selected disciplines; the full current template has ten machine-assignable roles. The returned actual count is explicit. Small teams combine adjacent departments such as production/coordinating/delivery or lighting/compositing. A harness can propose custom groupings that cover every required role exactly once; it cannot invent administrator privileges or replace human QC with an agent.

Applying a proposal creates actual scoped installations, not placeholder profile cards. New identities receive `studio.read`, `studio.write`, and `tasks.write`, administrator-only invocation, no direct conversation-posting grant, and a role-specific persona referencing the curated shared skills. Creation does not issue usable plaintext credentials, launch workers, add `studio.execute`, or copy an employee's private skill vault. Existing identities keep their exact disclosed settings and permissions.

A sole owner can set up the company and generate draft work with QC unassigned. Final media review remains blocked until a suitable independent administrator joins. A separately authorized, distinct reviewer agent can accept bounded planning submissions under an exact expiring policy; it does not approve media or business gates. The person who produced or sponsored an output cannot independently approve it. Adding more agent characters does not satisfy that separation.

Plans expire, carry exact profile/installation snapshots, and use immutable application receipts. Reusing a successful request returns the same application rather than duplicate identities. If agent authority, membership, a reviewed grant, or the Studio structure changes, generate a fresh plan.

## Host execution and autonomy

The [managed host broker](STUDIO_HOSTING.md) binds a supervisor to one company and up to eleven reviewed agents. Registrations expire within 24 hours; the pilot allows up to three active registrations per company. A one-time host secret is stored only as a hash. Agent credentials are encrypted at rest, bound to host/company/agent/configuration/epoch, and returned only to the current host lease. Manual plugin rotation, pause, configuration changes, sponsor loss, host revocation, and expiry remain authoritative.

The shipped supervisor is Runpod-specific: it uses one operator-pinned model/endpoint, defaults to one concurrent inference run, and caps concurrency at two. It persists per-agent receipt journals privately and stops on lost broker authority. The HTTP worker does not receive arbitrary shell commands or executable plugin code from the model. CLI Codex/Claude Code hosting requires a different reviewed runtime; their presence elsewhere in the plugin catalog does not make this supervisor a CLI host.

Studio can create a paused coordinator mission using the existing bounded mission engine. The human reviews and activates it; connected workers advance only their approved missions and assigned work. Cycles, cadence, run leases, task revisions, and per-run inference bounds are enforced. Agent messages and task context cannot grant permissions, change provider budgets, hire identities, or start paid hosts. Only a distinct authorized reviewer run can accept an exact planning submission; final media and business approvals remain human.

This is supervised autonomous execution within explicit permissions. It is not a general business operator that independently signs contracts, buys compute, hires a fleet, invoices clients, or makes final creative and commercial decisions. A long list of active missions is also not a company-wide dollar budget: the managed CPU reservation allowance excludes inference, storage, and invoice reconciliation.

## Rendering is a specific connector capability

The implemented DCC profile is [a procedural Blender product turntable](VFX_EXECUTION.md). It creates its own geometry, materials, lighting, animation, native `.blend`, linear EXR sequence, and PNG review image. Its fixed profile accepts no external scene, script, texture URL, arbitrary command, or client footage. An operator supplies the approved Blender executable and private output directory; the worker cannot choose them through a model response.

The current profile caps a job at 24 frames, 1,024 pixels per axis, and 8 million aggregate pixels. It supports bounded rational frame rates and explicit Linear Rec.709 or ACEScg output. Local renderer checks inspect frame identities, dimensions, decoded pixel validity, file sizes, and SHA-256 values. The backend validates the connector's immutable output declaration but labels it `connector_reported` until the separate storage-verification path reads actual bytes.

The connector has its own scoped credential and leases. Uncertain expired work becomes `failed_uncertain` and is not automatically rendered again. Completion retries use the original durable request. A human must review or reconcile interrupted work. Process cancellation targets the worker's own renderer tree; it is not an operating-system sandbox or evidence that all external charges have stopped.

Nuke, Houdini, arbitrary Blender scenes, existing filmed footage, editorial conform/retime, temporal compositing checks, simulation farms, and asset publishing require additional reviewed profiles or integrations. Registering an input reference records pinned metadata; it does not mount storage or transfer the input. The current procedural profile deliberately does not consume those references.

## Private media and evidence

The private-media API uses a configured private Vercel Blob store. It accepts only exact paths already declared by a succeeded connector job. Coatria generates the storage path and issues a narrowly scoped upload URL; provider/agent credentials are never sent to the storage URL. The pilot limit is **20 MiB per file**, with upload grants lasting at most five minutes and member-authorized read URLs lasting at most one minute.

After upload, the server reads the private stored bytes and verifies exact byte length and SHA-256 against the immutable output manifest. Upload success alone is not verification. An incomplete sequence cannot be promoted. Native scenes and caches remain separate files; they are not presented as image-sequence evidence.

A human administrator can promote a fully verified sequence into an immutable pending Studio version. Its artifact URL identifies a stable, member-authenticated canonical sequence manifest with per-frame hashes and access paths. It preserves the original requester, agent, run, and sponsors. Promotion does not impersonate a producer, accept the task, approve the image, or deliver the package. Server byte equality does not prove that the model fulfilled the brief, that EXR color interpretation is correct, or that animation passes creative QC.

The renderer worker writes local files and its completion manifest. The separate [publisher CLI](VFX_EXECUTION.md#publish-completed-outputs-to-private-storage) uploads and verifies those exact completed outputs. An operator can also opt the renderer worker into automatic private publication: acknowledged renders enter a durable publishing phase before new claims, with bounded retries and server verification. The integrated local browser/HTTP/Blender/private-Blob workflow passed all seven checks, including seven verified files, duplicate-free publication replay, independent review, and an exact delivery manifest. It used a synthetic company, ran no inference, and sent no client delivery. Signed storage links are bearer grants until they expire, so removing a company member cannot recall an already issued URL immediately. Keep the grants short and avoid persisting or logging them.

## APIs and authority boundaries

The application documents the current contracts in its [runtime OpenAPI implementation](../src/lib/agent-runtime-openapi.ts) and [Studio operation extensions](../src/lib/studio-operations-openapi.ts). The relevant resource groups are:

| Resource | Route family |
| --- | --- |
| Studio template, company, projects, gates, versions, review, delivery | `/api/companies/{companyId}/studio/...` |
| Reviewed staffing plans | `/api/companies/{companyId}/studio/staffing/proposals/...` |
| Managed host administration | `/api/companies/{companyId}/studio/hosts/...` |
| Leased host credential delivery | `/api/host/identity`, `/api/host/credentials` |
| Connector profiles, input references, renderer jobs | `/api/companies/{companyId}/studio/execution/...` |
| Renderer claims, heartbeats, evidence, upload and verification | `/api/execution/...` |
| Member-authorized private media and sequence manifests | `/api/companies/{companyId}/studio/media/...` and execution job media routes |
| Harness tool discovery and calls | `/api/agent/tools` and `/api/agent/tools/{toolName}` |

The agent surface includes staffing proposal/read tools, Studio context and planning, role-bound tasks, artifact registration, and execution proposal/read tools. Those are API-accessible using a live authorized run. Human setup, grant changes, staffing application, host lifecycle, business approval, media promotion, independent acceptance, and delivery authority remain distinct. Model access to a public API description does not bypass those checks.

## Deployment and evidence

Project delegation adds [017 coordination](../database/017_studio_coordination.sql), with an administrator-approved coordinator, exact agent/role snapshots, a finite expiry, persistent specialist run allowance and immutable parent/child handoff receipts. The `studio_coordination_get` and `studio_work_dispatch` tools expose the same controls to external harnesses. Policy changes fence queued/running children; terminal receipt replay remains available to an authorized worker. A child has one attempt and cannot delegate again. The allowance excludes coordinator cycles and manually created runs; it is not a monetary ledger. See the [operator guide](STUDIO_OPERATOR_GUIDE.md).

The earlier schema changes are [013 execution](../database/013_studio_execution.sql), [014 staffing](../database/014_studio_staffing.sql), [015 hosting](../database/015_studio_hosting.sql), and [016 media](../database/016_studio_media.sql), following the Studio schema in migration012. Apply the reviewed runtime permission file in the same controlled deployment. Immutable artifacts, reviews, manifests, staffing application receipts, and private-media evidence have append-only runtime privileges; a delivery's acknowledgement status is the only updatable delivery field.

The reviewed operator bundle in `.devdata/studio-ops-production-migration.sql` uses a single transaction, the existing migration advisory lock, exact migration-ledger guards, required prior schema/runtime role checks, and effective privilege assertions. Repeating it skips applied schema and restores reviewed grants. Its local evidence covers fresh/partial/repeat application, append-only permissions, and rollback on a late conflict. The bundle was separately committed in Neon on `2026-09-18T00:27:38.310Z`; read-back checks confirmed migration016, immutable expected/verified media, and status-only delivery updates. The operator evidence is `.devdata/studio-ops-neon-applied.json`. This schema deployment does not start or verify a cloud worker fleet.

Repository tests exercise real API handlers on isolated database fixtures, leased tools, enrollment encryption, host revocation, rendering contracts, and media verification. Actual local Blender tests are opt-in and separate from synthetic file fixtures. A successful build does not establish deployed credentials, a live inference response, private-storage connectivity, or delivered client media. Keep production rollout and live operational evidence in the release/deployment record.

Migrations 018–020 add explicit machine planning review, reviewed single-company CPU provisioning with expiry reconciliation, and account-bound private client delivery. See the [operator guide](STUDIO_OPERATOR_GUIDE.md), [CPU contracts](STUDIO_CPU_PROVISIONING.md), and [client delivery contracts](STUDIO_CLIENT_DELIVERY.md). The remaining production work includes live provider/worker verification, cross-host recovery, heavy-file resumable transfer, NAS connectivity, annotated client review, company-wide spending reservations, and measured multi-company concurrency. The current pilot has explicit limits; it does not establish million-user capacity or fully unattended end-to-end business operation.
