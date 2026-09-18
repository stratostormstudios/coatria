# Higgsfield production and storage-only infrastructure

Coatria's current production direction is AI creative work through the **official Higgsfield MCP service**. Coatria owns company roles, briefs, permissions, reviewed requests and provenance. Higgsfield owns its available models, generation tools, provider jobs and credit balance. Large source footage, EXRs, caches and rendered originals remain on the company's existing local, NAS or cloud storage.

This document describes the implemented release candidate. It does not establish that its migration is deployed, that the company's OAuth connection is complete, or that every production workflow has passed a live acceptance trial.

## The official plugin connection

`src/lib/higgsfield-mcp.ts` is a client of `https://mcp.higgsfield.ai/mcp`. It uses OAuth discovery, PKCE, MCP initialization, tool discovery and `tools/call`; it does not recreate the provider's generation REST API or substitute another image service. The provider interface is the official service used for its plugin integration. The exact tools and schemas available to this separately authorized company connection still require authenticated discovery and compatibility verification.

A company administrator must complete a **separate Higgsfield OAuth consent**. Being signed into Higgsfield in ChatGPT does not give the Coatria server that session or permission to use it. The connection stores encrypted credentials on the server, bound to company and connection identity. Agents and browser responses do not receive those credentials. Existing agents do not inherit creative-plugin access: `creative.read` and `creative.write` are separately selected grants. Task-bound observation import additionally requires `studio.write`; storage metadata uses `infrastructure.read`. A planning reviewer with only studio read/review grants receives no creative-plugin tools. The UI asks the administrator to use a dedicated company account: provider workspace selection may change outside Coatria, and the current connection is not an independently isolated provider workspace.

Live verification on September 18, 2026 completed official OAuth discovery and public PKCE client registration. That verifies the public authorization bootstrap only: no company account consent, access token, authenticated tool inventory or generation was obtained by that check. Those remaining steps require the company's separate consent and subsequent acceptance testing.

The initial application allowlist contains `generate_image`, `generate_video` and `generate_audio`, plus selected read operations for balance, model discovery, estimates, workspace listing and job observation. Only tools returned by the authenticated official catalog are usable. This is a limited first integration, not every Higgsfield plugin feature or every installed ChatGPT skill. Batch generation, galleries/presets, uploads, brand/product kits and complete multi-step creative skills need their own reviewed integration and acceptance tests.

## Current client-to-delivery path

1. **Brief:** create a Studio project, record the client objective, target specification, rights and AI-use policy, and assign production roles. The Higgsfield project preset supplies planning defaults, not a guarantee that every generation model can produce those settings.
2. **References:** select material that may be shared with Higgsfield. The present panel accepts exact official tool arguments and exposes the discovered input schema. Existing provider media IDs or approved provider-supported references must already be available. A local filename, indexed drive entry or Coatria storage pointer does not upload a reference or grant Higgsfield access. A first-class reference upload/selection UI is not implemented yet.
3. **Generation:** save a proposed request with exact arguments, project revision and connection revision. Sending requires current administrator access, AI permission, approved brief/estimate/production gates, review of the saved arguments and explicit credit consent. The server commits a `dispatching` record before the one provider call. An uncertain submission is never automatically sent again; inspect provider history before proposing new work.
4. **Observe and review:** a returned provider response may contain a queued job, a request for a choice, or an error. `returned` means the provider responded; it does not mean a completed image or movie exists. Job IDs and subsequent observations can be recorded separately. Actual visual, temporal, technical and rights review still requires evidence and the appropriate independent reviewer.
5. **Delivery:** preserve the exact approved version and delivery manifest. A generation receipt, storage pointer or prepared manifest is not a transfer or client acceptance. Existing private-file client delivery supports its separately verified media path; it does not automatically accept Higgsfield URLs or files that remain on an external drive.

The Studio UI now prioritizes **Generations & references**. The current request editor is an explicit JSON/schema interface; model-aware forms, automatic status progression and reference selection remain follow-up UX work. Existing task/dependency records still use the established planning/VFX stages. Selecting the Higgsfield preset does not create a new backend execution engine, automatically replace those stages, or make their DCC tasks into Higgsfield jobs.

## Generation records and reference provenance

`database/023_studio_creative_assets.sql` adds immutable generation identity, append-only observation receipts, immutable external storage snapshots and idempotency receipts. They are separate from `studio_artifacts`, media verification, review and delivery tables.

Company APIs:

| Route below `/api/companies/{companyId}/studio/projects/{projectId}/creative-assets` | Operation |
|---|---|
| `GET /generations` | Page generation identities and latest imported observations |
| `GET /generations/{id}` | Read an exact identity and page its observation history |
| `POST /generations` | Import an official-tool job observation without calling the provider |
| `GET /storage-references` | Page pinned external file metadata and current index state |
| `GET /storage-references/{id}` | Read one immutable storage snapshot |
| `POST /storage-references` | Pin a matching current drive-index entry |

Generation records retain the reported provider job UUID, model, media kind, prompt and declared reference bindings. References identify another same-project generation, a same-project storage snapshot, or an uploaded Higgsfield media UUID. Binding a storage snapshot records provenance only; it does not assert that those bytes were supplied to the provider. A provider job cannot be rebound to another project, task, prompt, model or reference set. New observations append history; a terminal observation cannot silently become a different result.

These imported receipts are explicitly `evidenceSource: imported_report`, `providerVerified: false`, `bytesVerified: false` and `independentlyReviewed: false`. UUID validation cannot prove that a job exists or belongs to an account. The separately stored direct MCP response is evidence that a provider call returned, not independent verification of the resulting bytes or creative quality. There is no caller-set switch that upgrades imported evidence to provider verification.

Optional output navigation URLs must be unsigned HTTPS references; embedded credentials, query strings, fragments and local network addresses are rejected. A media UUID may be recorded without a URL. This API never downloads a reference. Expiring/signed output access requires a separate future access mechanism, not copying secrets into immutable receipts.

Reads require company membership or the appropriate authorized agent capability. Human writes require current administrator access. Agent writes require a currently authorized leased run with `studio.write`, an administrator requester, allowed AI policy, the exact assigned non-human task reserved by that run, and current project gates/dependencies. Unknown or stale project revisions fail. A recording does not submit, accept or approve the task. Idempotent retries return the original committed record; a changed payload under the same request ID conflicts.

Agent tools expose generation read/import and storage-pointer read/register operations. They remain ordinary scoped Coatria tools. The generation proposal tool prepares work for administrator approval; it does not give a model authority to spend credits or run arbitrary provider tools.

Creative-plugin access requires the separately granted `creative.read` or `creative.write` capability. Generation import also retains the existing `studio.write` task-authority checks; storage registration requires `studio.write` and `infrastructure.read`. Migration024 permits the new explicit grants but does not add them to existing agents or change any existing run's capability snapshot. An administrator must review and grant that access separately.

## Heavy storage stays external

The existing outbound-only `public/downloads/connector.mjs` scans an explicitly selected folder and reports relative paths, sizes and modification times. It does not read original file contents, follow symbolic links, upload originals, expose an absolute filesystem root, accept commands or open an inbound server. A mounted/synchronized cloud folder can be indexed through that same local filesystem interface; native remote-drive OAuth, browsing and file-access providers are not implied.

Storage snapshots pin `driveId`, relative path, size, modification time and index observation time from a non-revoked same-company drive. Registration compares the expected metadata under the drive lock used by heartbeat replacement, so a changed index cannot silently substitute another observation. Later index replacement or revocation leaves the historical snapshot intact and reports `unchanged`, `changed`, `missing` or `revoked`. `unchanged` only compares the last indexed metadata; it is not proof of current availability or unchanged bytes.

Every pointer states `verificationSource: metadata_only`, `bytesVerified: false`, `fileAccessGranted: false` and `uploadedToHiggsfield: false`. A pointer can describe a multi-gigabyte original without sending that file through Vercel or the model context. Coatria cannot currently open, stream, hash, copy or transfer that original through this connection. Users continue to access it using their approved storage tools. No client receives external file access merely by receiving a Coatria project or delivery record.

## Deferred execution and retained reasoning infrastructure

Blender/DCC execution, workstation control and render-server provisioning are deferred for this product increment. Existing legacy endpoints, artifacts, journals and the advanced turntable preset remain available for historical continuity; they are not the current Higgsfield production path. Do not activate the previous renderer bootstrap or infer permission to start workstation/server compute from the new reference workflow.

Managed CPU agent hosts and the bounded inference broker remain relevant to company reasoning: agents can plan, coordinate, maintain roles, draft production requests and use the authorized Coatria API. These reasoning services do not become media renderers or receive file access by virtue of running the company. Their existing lifecycle, spending and lease controls still apply.

## Acceptance matrix and remaining work

| Capability | Current implementation | Required acceptance before stronger claims |
|---|---|---|
| Official MCP transport | Fixed official destination, OAuth/PKCE, bounded MCP calls and tool discovery; live public discovery and PKCE client registration verified | Complete company consent and verify the actual exposed catalog, token refresh and account selection |
| Reviewed generation | Immutable proposed arguments, project/connection checks, explicit administrator credit consent, durable one-dispatch intent | One real authorized generation, returned job ID, terminal provider observation, uncertainty reconciliation and observed credit accounting |
| Same-plugin creative workflows | Initial generation/read tool allowlist | Review and exercise each required official preset, upload, reference and multi-step workflow; do not claim full ChatGPT skill parity |
| Reference inputs | Exact tool arguments; provider media IDs and declared provenance | Model-aware picker, explicit reference-sharing consent, bounded upload flow and reference-rights evidence |
| Imported observations | Immutable identity and append-only unverified reports | Link trusted provider-call provenance where available; independently inspect actual outputs |
| Storage metadata | Existing folder index and immutable project pointers | Native cloud-provider connectors and authenticated direct access, if requested; currently no file access or transfer |
| Large originals | Remain on external storage; no application byte proxy | Any future access must preserve source ACLs, version identity and direct storage transport without arbitrary filesystem commands |
| Production tasks | Existing scoped tasks, roles, gates and independent review rules | Explicit Higgsfield task stages and a tested completion bridge; provider status must never approve its own work |
| Review and delivery | Existing human review and manifest records; existing verified-private-file portal remains separate | Output/version integration, true media QC, approved storage-specific delivery and authenticated client receipt |
| Autonomous production | Agents can prepare scoped requests and record evidence | Bounded generation spending policy, scheduling, recovery and exact task/result binding before unattended production |
| Workstations and render servers | Legacy implementation retained, operational expansion deferred | Separate future product decision and reviewed execution/provisioning scope |

The creative-assets fixture exercises the actual route/session and leased-run authority with isolated PostgreSQL-compatible storage, synthetic job IDs and no outbound requests. It covers tenant isolation, unchanged replay/conflict, stale revisions, role/AI/grant/sponsor boundaries, a 4 GB metadata pointer, index replacement/revocation and company cascade cleanup. It establishes those application invariants; it does not establish a live Higgsfield generation, storage transfer or completed client production.
