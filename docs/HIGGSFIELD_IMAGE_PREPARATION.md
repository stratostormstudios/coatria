# Verified image preparation for project references

## Status and intended result

This document specifies the next stage after [managed prepared-image references](HIGGSFIELD_REFERENCES.md). It is an architecture and acceptance contract, not evidence that automatic preparation is deployed, qualified on a live host, or enabled for a company. Existing reference sharing remains disabled without its separately qualified runtime. This work does not activate workers, provision resources, change existing agent grants, or authorize provider spending.

The intended result is: choose an exact original image already in project storage, create a bounded derivative with verified metadata removal, save it as a separate verified project-storage version, review that exact derivative, then use the existing finite Higgsfield sharing approval. The original remains unchanged. Preparing an image is not permission to share it with Higgsfield, approve its creative content, generate paid media, or accept a client delivery.

The source of truth for implementation status is the completed milestones and their recorded evidence, not a planned API name or a mocked successful response.

The accompanying prepared-image inspection work is a separate, earlier slice: an explicitly selected dispatch may establish bounded inspection authority for an image that is already prepared. It does not implement the transformation, metadata-removal proof, derivative storage publication, or processing authorization specified below. An inspection result still describes the selected bytes, and the later Higgsfield sharing consent still covers those bytes unchanged.

## Existing foundations and limits

| Existing contract | Reuse | Boundary that must remain explicit |
| --- | --- | --- |
| [`higgsfield-media-inspection.ts`](../src/lib/higgsfield-media-inspection.ts) | Regular private input, exact byte/hash checks, format sniffing, full decoding, pixel/stream/time limits | It inspects source bytes; it neither resizes nor strips metadata. The image branch accepts PNG/JPEG/WebP and requires one decoded frame. Its descriptor does not establish EXIF orientation handling or metadata absence. |
| [`higgsfield-media-sandbox.ts`](../src/lib/higgsfield-media-sandbox.ts), [`media-sandbox-launch.c`](../scripts/hosting/media-sandbox-launch.c) | Pinned closure, qualified executor identity, namespaces/cgroups, no inherited secrets, no network, bounded output and complete descendant cleanup | The current result is UTF-8 text. The read-only root and zero file-size limit must not be weakened merely to obtain a transformed file. A binary pipe can return bounded bytes to the trusted supervisor. |
| [`higgsfield-vercel-media-sandbox.ts`](../src/lib/higgsfield-vercel-media-sandbox.ts) | Finite reservation, exact guest identity, deny-all network, bounded input, independent cleanup and terminal readback | The current grammar allows inspection ending in null output. Its text output uses provider command logs. Do not put transformed images or decoded pixels into that log channel. A distinct bounded private binary-result transport and transform qualification are required. |
| [`higgsfield-reference-worker.ts`](../src/lib/higgsfield-reference-worker.ts) | Private scratch, bounded source reads, immutable lease snapshots, current authority checks and sanitized diagnostics | Its 10 MiB prepared-image limit and unchanged-byte semantics must not be silently widened to originals. |
| [`project-storage-runpod.ts`](../src/lib/project-storage-runpod.ts), [`project-storage-transfer.ts`](../src/lib/project-storage-transfer.ts), [`project-storage-gateway.ts`](../src/lib/project-storage-gateway.ts) | Scoped object keys, fixed provider transport, multipart state, current grant checks and full stored-object hashing | A successful PUT or multipart completion is not verified storage. An agent's read/organize grants do not authorize preparation writes. Existing generic upload grants remain tied to their current actor/run authority. |
| [`higgsfield-archive-worker.ts`](../src/lib/higgsfield-archive-worker.ts) | Durable storage intent before I/O, exact source hash, uncertain-outcome fences and read-back verification | It is bound to an approved Higgsfield output archive. Do not fabricate an archive to process a project original. Extract reviewed common mechanics or implement a preparation-specific adapter. |
| [`039_higgsfield_references.sql`](../database/039_higgsfield_references.sql), [`higgsfield-references-protocol.ts`](../src/lib/higgsfield-references-protocol.ts) | Exact proxy/source IDs, immutable scope, inspection and finite human sharing consent | A linked original does not prove derivation. `metadataRemoved:false` remains correct for the existing unchanged-byte workflow. |
| [`higgsfield-remote-media-controller.ts`](../src/lib/higgsfield-remote-media-controller.ts) | Reservation-before-create, bounded spending admission, exact source pin and recovery journal | The controller currently authorizes and journals archives only. Preparation requires its own authority/context, not a forged archive identity. |
| [`build-trusted-service-bundle.mjs`](../scripts/hosting/build-trusted-service-bundle.mjs), [`trusted-service-bootstrap-runtime.mjs`](../scripts/hosting/trusted-service-bootstrap-runtime.mjs) | Source/tree/lock/compiler pins, immutable release bytes, scoped environment and finite supervision | Build/service/bootstrap allowlists must explicitly support any preparation service. A valid bundle is not a qualified live deployment. |

## Preparation contract

### Input and recipe

The caller selects one verified source version in the current company/project and supplies its exact ID, SHA-256 and byte count. It also selects a current eligible work item and an allowed destination folder. The server fixes the physical output object key. No public URL, local path, arbitrary filename-derived object key, FFmpeg argument, filter expression or arbitrary codec is accepted.

The proposed first acceptance profile is deliberately small; these are design bounds, not an enabled configuration:

| Bound | Version 1 proposal |
| --- | --- |
| Source | One PNG/JPEG/WebP, at most 32 MiB, 8192 pixels per dimension and 32 million pixels; one decoded frame |
| Derivative | PNG, maximum long edge 2048 pixels, original aspect ratio, no enlargement, at most 10 MiB |
| Pixels | Explicit 8-bit RGB/RGBA output; preserve supported alpha. Bake supported orientation into pixels; reject unsupported color/orientation cases. |
| Work | One transform attempt, at most 30 seconds of transform wall time and 120 seconds for the whole job; stricter executor/authority expiry wins |
| Concurrency | One active preparation per company initially, bounded queue admission; no unbounded automatic encode retries |

Input byte, pixel and dimension ceilings are a distinct versioned preparation policy and must be stricter than the decoder's absolute ceilings and selected executor limits. A concrete encoder/filter and supported color/orientation set must pass M1 before this recipe is accepted. Reject EXR, PSD, video, animation, unsupported profiles and unsupported orientation cases until each has an explicit tested recipe. Never silently select the first frame or relabel an unsupported input.

Recipe version 1 produces a single PNG, preserves aspect ratio, never enlarges the image, uses a fixed resize filter and explicit pixel/color/alpha rules, and satisfies the existing reference ceiling of 10 MiB, 4096 pixels per dimension and 16 million pixels. The product may choose a smaller target dimension. The exact chosen bounds, encoder flags and behavior belong in the recipe hash. If a result exceeds the byte limit, fail with a truthful smaller-image requirement or use a predeclared finite fallback recipe with its own cost bound; do not introduce an unbounded compression/retry loop.

Orientation must be baked into pixels before orientation tags are discarded. The profile must state whether alpha is preserved or composited onto a fixed background. Color handling must be defined and proven; stripping an ICC profile while leaving its encoded pixel values untouched is not proof of conversion to sRGB. Until supported, reject such cases rather than claim visual preservation.

### Authority and privacy

Preparation requires current source-read authority, explicit derivative-write/processing authority, project/task scope, active storage connection and a qualified finite processing runtime. Require current, non-revoked membership and sponsors at each authority checkpoint. Agents must have the relevant capabilities on both their identity and authenticated live run, with the correct task reservation. Existing staffing is unchanged: [`studio-staffing-protocol.ts`](../src/lib/studio-staffing-protocol.ts) gives ingest read/organize grants and comp creative/read grants, not general storage write or media processing.

A durable job must not silently turn a short-lived agent lease into indefinite background authority. The first implementation must either require the original run through preparation or define a separate finite human-approved preparation authorization that explicitly adopts the job. The latter must pin the exact original, recipe, destination, processing location and bounded cost before work may outlive the proposing run. Revocation, expiry or changed authority stops further reads, transform admission and publication. Cleanup and reconciliation remain possible after business authority ends.

For a remote processor, the original bytes leave project storage for that processor even though they are not sent to Higgsfield. Present the exact processing destination and obtain the appropriate processing authorization; do not describe remote preparation as keeping the original exclusively on the local server. The guest receives only the bounded original and pinned processing code, never storage/OAuth/database credentials or arbitrary host files. Input/output bytes, private paths and provider capability URLs must not appear in ordinary logs, agent metadata or receipts.

### Durable job and evidence

Use a company/project-scoped preparation record with immutable source facts, work/project authority snapshot, recipe identity, destination, processor qualification and proposing identity/run. A proposed phase model is `queued → reading → transforming → validating → storing → verifying → ready`, with explicit `blocked`, `failed`, `uncertain` and `revoked` outcomes. The final state model is authoritative only when implemented and tested.

Idempotency binds company, actor, client ID and the complete immutable request hash. Reusing that ID with changed inputs is a conflict. Concurrent claims need exact lease/action fences and a single published derivative. Only read-only recovery may be repeated automatically; an unknown guest creation or storage mutation is reconciled before a replacement is permitted. Expired or invalid queue heads must terminalize safely instead of starving later jobs.

The immutable derivation receipt must bind:

- Company, project, work item and preparation ID.
- Exact original version ID, SHA-256, bytes and observed format/dimensions.
- Recipe/version/hash, processor source/build/closure/profile hashes and qualification identity.
- Resulting format, dimensions, pixel/color/alpha policy, byte count, SHA-256 and metadata validation policy/result.
- Exact derivative file/version/upload identities and matching immutable storage verification.
- Acting/sponsoring identities, phase receipts and timestamps sufficient for replay/recovery decisions, without secret material.

Composite database relationships must prevent cross-company/project source, output or receipt substitutions. Source, recipe and successful derivation evidence are append-only; a new recipe or output requires a new version/record. Public clients and ordinary agent tools cannot insert successful transform evidence, supply a `metadataRemoved:true` assertion, or certify storage verification.

### Transformation and publication

1. Validate the exact source and finite job authority; acquire the current lease. Read the verified version with its saved ETag into an exclusively created private scratch file, enforce exact length and hash, and reject partial/range responses.
2. Fully decode within the qualified boundary and reject unsupported content. Execute only the fixed transform recipe. Collect binary output under a strict byte bound; UTF-8 string conversion is forbidden for image bytes.
3. Validate the complete output container. For a fixed true-color PNG profile, use an explicit allowed chunk set, valid lengths/order/CRCs and no trailing bytes. Reject or explicitly remove forbidden metadata chunks; validate the final exact bytes again. Full decode must prove one complete image with the expected format/dimensions/pixel policy. A successful process exit or `-map_metadata -1` alone is not metadata-removal proof.
4. Hash the final validated bytes and reserve a separate derivative file/version. Never append the derivative as a replacement version of the original file. Preserve any destination-name collision rather than overwrite it.
5. Durably record each storage-changing intent before provider I/O. Preserve unknown outcomes. On successful completion, fetch the entire object with the returned ETag, compare exact length and SHA-256, and record storage verification only under current authority.
6. Publish `ready` only when the transform evidence, output version and stored-byte verification agree in one fenced transaction. Recheck authority at this final boundary and clean scratch/guest state on all outcomes.

Storage allocation currently increments `project_storage_bindings.revision`. Preparation must account for its own exact allocation transition atomically, while rejecting unrelated binding changes. Do not broadly ignore binding revisions. Create the subsequent Higgsfield reference proposal against the current binding only after the derivative is ready; carrying a pre-allocation binding pin into sharing would invalidate the job's own result.

## Handoff to managed references

The prepared result exposes safe internal IDs and derivation facts. The next reference proposal uses the verified derivative as `proxyVersionId` and the exact original as `sourceVersionId`. A trusted relation must establish that these IDs belong to the same recorded preparation; association alone is insufficient. The UI previews the derivative's exact verified bytes and clearly identifies the unchanged original.

Retain the existing separate human review and finite sharing approval. The sharing worker continues to send the selected proxy bytes unchanged. Add truthful preparation evidence to the reference view rather than globally changing the existing `bytesSharedUnchanged:true` / `metadataRemoved:false` contract. Metadata removal does not remove visible confidential content or establish sharing rights. Generation, archive, independent QC, delivery and client acceptance remain subsequent independent operations.

## Bounded milestones

| Milestone | Deliverable | Acceptance boundary |
| --- | --- | --- |
| M1: policy and pure transform | Versioned source/output limits, fixed recipe, binary transform interface and strict output validator | Real local fixture transforms prove resized pixels and metadata absence. Native execution, if used by tests, remains unavailable in production. No storage/provider or agent execution is enabled. |
| M2: durable preparation control plane | Exact proposal/read/status contract, lease/phase state, immutable derivation schema and restricted grants | Database tests prove tenant isolation, conflicting replay, concurrency, expiry/revocation, queue progress and immutable evidence. No synthetic receipt is presented as real transform proof. |
| M3: scoped storage worker | Exact source reader, transform adapter and derivative publication using existing provider mechanics | Real transform plus isolated storage/DB integration proves original preservation, new verified version, read-back equality and uncertain-mutation fencing. Credentials remain outside the decoder. |
| M4: UI and agent handoff | Prepared result preview, exact original/proxy provenance, progress and failure states, explicit agent tool/profile/grant review | Browser/agent tests prove no premature sharing, no hidden original substitution and only ready verified derivative IDs handed to reference proposal. Existing identities are not silently upgraded. |
| M5: runtime qualification | Source-pinned service build, dedicated preparation role, reviewed processor transport and actual-host qualification evidence | The exact deployed binary-transform boundary passes isolation/resource/cleanup tests. All older inspection-only qualification is distinguished. Defaults remain disabled until this evidence and finite company/project authorization exist. |
| M6: bounded end-to-end pilot | Approved synthetic original → derivative → reference consent → confirmed reference → generation and later studio gates | Separate operator authorization covers any real remote processing/spending. Exact-source evidence and unresolved limitations are recorded. A mocked end-to-end fixture or CI pass does not satisfy live provider qualification. |

## Required acceptance tests

### Real transformation and truthful metadata evidence

- Use actual pinned decoder/encoder binaries on fixtures with known pixel regions. An oversized source yields the exact recipe dimensions and aspect ratio; a smaller source is not enlarged. Decode the output pixels and compare expected regions/orientation, not merely a changed hash or mocked descriptor.
- JPEG EXIF orientation fixtures, transparent PNG/WebP fixtures and supported color-profile fixtures prove the stated orientation/color/alpha behavior. Unsupported cases are explicitly rejected. Animated, multi-frame and mixed-stream inputs cannot become a silent first-frame proxy.
- Sources contain real EXIF/GPS/XMP, PNG text/profile/EXIF chunks, WebP metadata and appended payload. Inspect the output structure independently and prove forbidden chunks/tags/trailing bytes are absent. Include a malicious encoder fixture that returns source bytes or falsely reports successful sanitization; it must fail output validation.
- Verify binary round trips containing non-UTF-8 bytes. Enforce source/output byte, dimension, decoded-pixel, allocation, stderr and deadline bounds. Truncation, malformed containers, decompression bombs, output overflow and process warnings fail without a success receipt.
- Read and hash the original before and after the test; it remains identical. Full output decoding must pass on the exact bytes subsequently published.

### Storage, authority and recovery

- One real transform creates one separate derivative version with a distinct storage object key and immutable source/recipe receipt. Full read-back equals the exact transform output. Corruption, truncation, changed ETag, wrong version and cross-company storage rows never produce `ready`.
- Test revocation/expiry after claim, during source read, before transform admission, before storage mutation, during read-back and before final publication. Business revocation cannot suppress guest/scratch cleanup.
- Simulate source replacement, task reassignment, changed project content, destination move/collision, connection credential rotation and unrelated binding revision changes. The worker's own allocation revision transition succeeds exactly once; unrelated changes do not.
- Concurrent claims and identical request retries produce one derivative. Conflicting replay is rejected. Lost create/part/complete responses retain uncertainty; no automatic mutation replacement occurs. Safe read recovery cannot switch source/recipe/output bytes.
- Real PostgreSQL role tests prove the dedicated worker's exact required grants and denial of source rewriting, approval fabrication, OAuth access and unrelated task/role changes. Test existing agent grants unchanged and explicit preparation-grant denial.

### Isolation and user-visible behavior

- Extend the Linux/Vercel conformance tests for the actual transform operation: denied network/host secrets, exact input only, resource exhaustion, output bounds, normal/abort/timeout/controller-loss descendant cleanup and no result publication before cleanup is confirmed.
- Ensure remote binary output is absent from command logs and that neither bytes nor credentials appear in metadata endpoints, errors or phase receipts. Changed build/profile/guest identity cannot reuse old qualification.
- The UI previews the exact verified derivative hash, labels the original separately, exposes disabled/unqualified/uncertain states truthfully and never presents preparation as Higgsfield sharing consent. A caller cannot inject an arbitrary prepared-version/metadata-removal claim.
- Agent discovery and task handoff return internal IDs and verified facts only. An ended run cannot gain a new read/write grant unless a separately implemented finite adoption contract explicitly authorizes it. Approval, generation spend and client acceptance remain distinct.

Tests of pure parsers, mocked provider transport and local native transforms are useful evidence for their respective layers. They do not establish production sandbox isolation, a live Runpod/Vercel service, Higgsfield compatibility, or worldwide capacity.
