# AI production Studio: tested candidate

Implementation inventory, 2026-09-20, source `d5978ee`. All four jobs in [CI run 35515485495](https://github.com/stratostormstudios/coatria/actions/runs/35515485495) passed, including 1,063 application tests with 4 explicit skips, 62 production-build browser cases and 17 deterministic agent-harness checks. Current public deployment observations are recorded in [release status](RELEASE_STATUS.md); tested source is not proof of the deployed commit, migrations, service flags or running compute. The actual archive host and selected storage transport still require qualification.

Coatria connects reviewed company structure to real agent identities, bounded work, official Higgsfield generation, verified project-storage versions, independent media review and authenticated client delivery. The useful unit of progress is an accepted task or exact version with evidence. Provider completion, verified bytes, QC, work acceptance and client acknowledgement remain separate states. The controlled Blender path is retained for legacy VFX projects.

## The concrete workflow

| Step | Implemented behavior | Required authority or connection |
| --- | --- | --- |
| Design the company | Choose the AI creative production or retained VFX template, brief, team size, provider and optional separate planning reviewer. Review actual role grouping, personas, shared skills, grants and model limits. | An administrator applies the exact proposal revision and plan hash. A harness may propose a plan but cannot apply it or grant itself authority. |
| Create or bind specialists | Apply the reviewed staffing plan atomically. New specialists are real plugin installations and agent identities; selected existing agents retain their disclosed grants and configuration. | New identities start paused and unconnected. No worker or inference starts. Existing-agent changes invalidate the plan. |
| Connect a bounded host | Register a company-scoped host, enroll exact installation revisions, and explicitly activate the chosen identities. A separately deployed supervisor retrieves encrypted credentials through a short lease. | Server keyring, an approved endpoint/model, and either a privately configured host or an explicitly approved managed CPU plan. |
| Plan the project | Choose one image, video or audio kind, an explicit specification and named deliverables. Version 2 creates reference, generation, QC and delivery tasks with dependencies and business gates; old VFX projects keep frame-based contracts. | Humans approve scope, AI use and production. Desired output settings must fit the selected provider/model. |
| Execute assigned work | Scoped agents handle ready work and propose exact task-bound Higgsfield requests. Compatible jobs expose provider status and adopted outputs. | Current run/role/grants and human credit consent. Unknown submission results are not automatically sent again. |
| Archive and register | A separately approved archive fully decodes one exact adopted output, verifies its stored version and supplies immutable facts to generated artifact registration. | Qualified storage gateway/volume and isolated archive host; explicit source/destination approval. A URL or provider status alone cannot register verified media. |
| Review and submit | A new finite policy may resume the original specialist from its verified archive to claim/register/submit. Humans independently review exact media and accept the separate tasks. | Continuation is default off and adds no generation, transfer or approval authority. A producer, sponsor or registrar cannot independently approve their output. |
| Prepare and deliver | Seal approved exact versions, accept delivery handoff, invite one designated external account and record that account's acknowledgement or change request. | Current independent approvals and out-of-band identity confirmation. Verified client downloads and authenticated responses are separate; creating an invitation sends no message. |

## Staffing is an access plan

The AI-production structure has seven responsibilities: producer, coordinator, creative director, reference/provenance specialist, generation specialist, human QC and delivery producer. Its six non-QC responsibilities may be grouped across fewer agents. The retained VFX template has eleven responsibilities, ten machine-assignable. The planner accepts one to eleven requested agents and returns the useful actual count rather than manufacturing extra positions. A harness may propose groupings that cover required roles exactly once; it cannot invent administrator privileges or replace human QC with an agent.

Applying a proposal creates actual scoped installations. New production identities receive `studio.read`, `studio.write` and `tasks.write`, administrator-only invocation and role instructions referencing shared skills. Reviewed AI generation roles additionally receive creative read/write; reference roles receive creative/infrastructure read; coordinator, reference and delivery roles receive storage read/organize. These grants do not authorize uploads, provider spending or client sharing. Existing identities must already hold required grants and keep their disclosed settings; staffing never upgrades them automatically. Creation starts no worker, adds no DCC execution authority and copies no private employee skill vault.

Ordinary human role assignments confer responsibility for linked tasks and update unstarted work when the structure is saved. In-progress or review work blocks reassignment until reconciled; completed attribution is preserved. The QC selector permits human owners/administrators only and does not promote a member. Each actual review still checks independence from that version's producer, agent sponsor, provider sponsor and registrar.

The optional separate planning reviewer consumes one slot within the total requested count (at least two identities), with exact `studio.read` and `studio.review` grants and no production or human QC role binding. The reviewed v1 planning instructions are embedded in the saved installation persona; this is not an additional private-vault skill. It is a new paused identity with separate host enrollment and project policy approval. New production and reviewer agents share the applying administrator as sponsor, so any shared-sponsor machine review requires explicit policy consent. Omitting the option preserves the existing v1 plan shape and hash inputs. The API exposes `planningReviewer` separately from `specialists` in both the immutable plan and creation receipt; the same strict optional name/style input is available to the staffing proposal tool.

A sole owner can set up the company and generate draft work with QC unassigned. Final media review remains blocked until a suitable independent administrator joins. A separately authorized, distinct reviewer agent can accept bounded planning submissions under an exact expiring policy; it does not approve media or business gates. The person who produced or sponsored an output cannot independently approve it. Adding more agent characters does not satisfy that separation.

Plans expire, carry exact profile/installation snapshots, and use immutable application receipts. Reusing a successful request returns the same application rather than duplicate identities. If agent authority, membership, a reviewed grant, or the Studio structure changes, generate a fresh plan.

## Host execution and autonomy

The [managed host broker](STUDIO_HOSTING.md) binds a supervisor to one company and up to eleven reviewed agents. Registrations expire within 24 hours; the pilot allows up to three active registrations per company. A one-time host secret is stored only as a hash. Agent credentials are encrypted at rest, bound to host/company/agent/configuration/epoch, and returned only to the current host lease. Manual plugin rotation, pause, configuration changes, sponsor loss, host revocation, and expiry remain authoritative.

The shipped supervisor is Runpod-specific: it uses one operator-pinned model/endpoint, defaults to one concurrent inference run, and caps concurrency at two. It persists per-agent receipt journals privately and stops on lost broker authority. An explicitly reviewed `coatria_broker_v1` CPU preset keeps Runpod credentials on the server; each numbered inference step is built from authoritative context and immutable tool receipts, with durable submission fencing, cancellation and separate finite token/job/monetary admission limits. Direct-worker presets retain their restricted-key requirement. The HTTP worker does not receive arbitrary shell commands or executable plugin code from the model. CLI Codex/Claude Code hosting requires a different reviewed runtime; their presence elsewhere in the plugin catalog does not make this supervisor a CLI host.

Studio can create a paused coordinator mission using the existing bounded mission engine. The human reviews and activates it; connected workers advance only their approved missions and assigned work. Cycles, cadence, run leases, task revisions, and per-run inference bounds are enforced. Agent messages and task context cannot grant permissions, change provider budgets, hire identities, or start paid hosts. Only a distinct authorized reviewer run can accept an exact planning submission; final media and business approvals remain human.

This is supervised autonomous execution within explicit permissions. It is not a general business operator that independently signs contracts, buys compute, hires a fleet, invoices clients, or makes final creative and commercial decisions. A long list of active missions is also not a company-wide dollar budget: the managed CPU reservation allowance excludes inference, storage, and invoice reconciliation.

## Generated media and verified project files

New generated projects opt into `contractVersion:2`. Image, video and audio specifications have distinct format, dimension, timing, codec, audio and color requirements. Registration selects an exact verified archive for the assigned generation work; the server loads source facts, checks the approved specification and stores separate file, specification and artifact-manifest digests. It never accepts caller-supplied probe facts or substitutes legacy DCC promotion evidence.

[Project files](PROJECT_STORAGE.md) provides an editable folder catalog and immutable versions backed by a separately operated Runpod S3 gateway. Administrators connect an existing volume and review an additive folder plan; no volume purchase or compute startup is implied. Native/local drive indexing remains metadata-only. Company file access, external-client access and provider reference sharing have separate authority; a catalog entry does not upload a reference to Higgsfield.

[Archive workers](HIGGSFIELD_ARCHIVES.md) require an exact approved provider source/destination and an isolated decoder runtime. They download and inspect bounded content, write the approved version and read the stored object to verify its complete length/hash. Current source, sponsor and storage authority are rechecked throughout. The Linux CI boundary has passed real adversarial/resource tests and all seven supported formats; the actual production host and Runpod transport must pass their own qualification before activation.

Generated media QC requires an independent human administrator and exact technical attestation. Task acceptance is a separate decision. Packaging pins the latest approved final for every deliverable and its review receipts; its internal manifest remains `not_transferred`. After accepted delivery handoff, a designated external account can download the exact stored versions and respond. Browser range verification, local save success and authenticated client acknowledgement are distinct evidence. A change request does not create an autonomous rework cycle. See [generated media](STUDIO_GENERATED_MEDIA.md), [bounded continuation](GENERATED_MEDIA_CONTINUATION_PLAN.md) and [client delivery](STUDIO_CLIENT_DELIVERY.md).

## Retained VFX: rendering is a specific connector capability

The implemented DCC profile is [a procedural Blender product turntable](VFX_EXECUTION.md). It creates its own geometry, materials, lighting, animation, native `.blend`, linear EXR sequence, and PNG review image. Its fixed profile accepts no external scene, script, texture URL, arbitrary command, or client footage. An operator supplies the approved Blender executable and private output directory; the worker cannot choose them through a model response.

The current profile caps a job at 24 frames, 1,024 pixels per axis, and 8 million aggregate pixels. It supports bounded rational frame rates and explicit Linear Rec.709 or ACEScg output. Local renderer checks inspect frame identities, dimensions, decoded pixel validity, file sizes, and SHA-256 values. The backend validates the connector's immutable output declaration but labels it `connector_reported` until the separate storage-verification path reads actual bytes.

The connector has its own scoped credential and leases. Uncertain expired work becomes `failed_uncertain` and is not automatically rendered again. Completion retries use the original durable request. A human must review or reconcile interrupted work. Process cancellation targets the worker's own renderer tree; it is not an operating-system sandbox or evidence that all external charges have stopped.

Nuke, Houdini, arbitrary Blender scenes, existing filmed footage, editorial conform/retime, temporal compositing checks, simulation farms, and asset publishing require additional reviewed profiles or integrations. Registering an input reference records pinned metadata; it does not mount storage or transfer the input. The current procedural profile deliberately does not consume those references.

## Retained VFX: private sequence media and evidence

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
| Server-owned managed inference | `POST /api/agent/runs/{runId}/inference`, leased status and cancellation |
| Leased host credential delivery | `/api/host/identity`, `/api/host/credentials` |
| Connector profiles, input references, renderer jobs | `/api/companies/{companyId}/studio/execution/...` |
| Renderer claims, heartbeats, evidence, upload and verification | `/api/execution/...` |
| Member-authorized private media and sequence manifests | `/api/companies/{companyId}/studio/media/...` and execution job media routes |
| Generated project contracts, artifact registration and source-bound continuation | Version 2 Studio reads/create, `.../generated-artifacts` and `.../generated-followups` |
| Higgsfield requests, tracked jobs and approved archives | `/api/companies/{companyId}/higgsfield/...` |
| Project file catalog, versions and access | `/api/companies/{companyId}/studio/projects/{projectId}/files/...` |
| Authenticated client packages and responses | Company `.../client-deliveries` and `/api/client-deliveries/...`; exact generated bytes use the separate gateway |
| Harness tool discovery and calls | `/api/agent/tools` and `/api/agent/tools/{toolName}` |

The agent surface includes staffing proposal/read tools, Studio context and planning, role-bound tasks, artifact registration, and execution proposal/read tools. Those are API-accessible using a live authorized run. Human setup, grant changes, staffing application, host lifecycle, business approval, media promotion, independent acceptance, and delivery authority remain distinct. Model access to a public API description does not bypass those checks.

## Deployment and evidence

Project delegation adds [017 coordination](../database/017_studio_coordination.sql), with an administrator-approved coordinator, exact agent/role snapshots, a finite expiry, persistent specialist run allowance and immutable parent/child handoff receipts. The `studio_coordination_get` and `studio_work_dispatch` tools expose the same controls to external harnesses. Policy changes fence queued/running children; terminal receipt replay remains available to an authorized worker. A child has one attempt and cannot delegate again. The allowance excludes coordinator cycles and manually created runs; it is not a monetary ledger. See the [operator guide](STUDIO_OPERATOR_GUIDE.md).

Migration [021 inference](../database/021_studio_inference.sql) adds durable model steps, retained monetary reservations and immutable tool-result evidence. Runtime updates are restricted to reconciliation state; approved request bodies, destinations, authority and limits cannot be rewritten.

The earlier schema changes are [013 execution](../database/013_studio_execution.sql), [014 staffing](../database/014_studio_staffing.sql), [015 hosting](../database/015_studio_hosting.sql), and [016 media](../database/016_studio_media.sql), following the Studio schema in migration012. Apply the reviewed runtime permission file in the same controlled deployment. Immutable artifacts, reviews, manifests, staffing application receipts, and private-media evidence have append-only runtime privileges; a delivery's acknowledgement status is the only updatable delivery field.

Historical schema evidence: the v1 operator bundle in `.devdata/studio-ops-production-migration.sql` was committed in Neon on `2026-09-18T00:27:38.310Z`. Its read-back confirmed migration016, immutable expected/verified media and status-only delivery updates; `.devdata/studio-ops-neon-applied.json` records that observation. It is not a current migration inventory or the migration procedure for this candidate.

Repository tests exercise real API handlers on isolated database fixtures, leased tools, enrollment encryption, host revocation, rendering contracts, and media verification. Actual local Blender tests are opt-in and separate from synthetic file fixtures. A successful build does not establish deployed credentials, a live inference response, private-storage connectivity, or delivered client media. Keep production rollout and live operational evidence in the release/deployment record.

Migrations 018–029 add planning review, managed provisioning, client delivery, creative/job records, project storage and archives. Migrations 030–032 add generated contracts/evidence, source-bound continuation and external-client stored-version grants. Use the current migration runner and matching runtime, archive-worker and gateway permission files; verify actual grants and service versions before enabling the separate workers. Existing policies do not gain generated-continuation authority; that option remains off until explicitly reapproved. Applying schema starts no provider work.

Remaining work is a qualified live generation-to-client pilot, autonomous revision planning after client changes, native NAS/workstation and general VFX connectors, resumable/bulk client transfer, live recovery and capacity exercises, hiring/commerce execution and comprehensive company budgets. The 50-session office test does not establish million-user capacity or model-fleet throughput. The [operator guide](STUDIO_OPERATOR_GUIDE.md) and [acceptance matrix](STUDIO_ACCEPTANCE.md) describe the actionable next steps.
