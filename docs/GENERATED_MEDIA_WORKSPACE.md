# Generated-media workspace — release candidate

The Studio UI now supports the opt-in version 2 image, video and audio contract alongside existing frame-based VFX projects. This is an unreleased candidate; migrations 030–031 and their restricted runtime grants must be deployed with the matching server version. Creating a project does not start provider generation or approve spending.

## Production flow

1. **New project → AI media production.** Review a brief, exact delivery requirements and named deliverables before creation. Visual media requires an explicit color policy. Video uses a rational constant frame rate and an explicit embedded-audio policy. Video/audio durations are inclusive millisecond ranges; images have no invented frame range.
2. **Generations & references.** The panel reads the current project with `contractVersion=2`, restricts tools to its media kind and requires an exact generation task. Failed or stale project reads remove credit consent. The existing separate provider and archive approvals remain necessary.
3. **Register verified output.** A company administrator chooses a verified archive whose exact returned request belongs to the chosen generation task. The server reads immutable source/file/inspection evidence; the browser submits only the archive/work identities, reviewed project revision, name and notes. Registration preserves the original producer and records the registrar separately.
4. **Independent review.** A different human administrator inspects the actual archived version, records findings and explicitly attests technical QC. The producer, agent sponsor, provider sponsor and registrar cannot approve that version. A technical mismatch permits a changes-request decision, not approval. Registration and review do not accept tasks.
5. **Work acceptance and internal package.** After planning, generation and QC work is separately accepted, packaging selects the latest independently approved generation final for each deliverable through its exact QC dependency. The package pins specification, file/version and review evidence. Its status remains `not_transferred`; this candidate cannot share generated packages through the client portal or record their client acceptance.

The project overview negotiates both contract versions explicitly, including pagination. Existing VFX editing, shot views, artifact review and client delivery remain on their existing version 1 paths. Unsupported legacy execution and creative-follow-up controls are hidden from version 2 projects.

## Downloads and interrupted actions

Downloads request the registered immutable storage version, not the current file head. Access must match the approved gateway origin, exact version path, byte count, media type and file SHA-256. The browser incrementally hashes the received stream and commits the disk writer or returns a saveable Blob only when its digest and length match. There is no automatic network retry. Browsers without a save picker retain the existing 128 MiB Blob limit. Role/account/project changes and cancellation abort the transfer.

Registration, review and package retries keep the same reviewed body and request ID. Review/package evidence displayed after an uncertain response stays pinned even if a newer project snapshot arrives. A changed project revision before the first submission requires reopening the dialog. The server remains authoritative for current permissions, gates, storage, sources and idempotency.

All controls use the existing authenticated APIs and published agent contracts. UI availability does not broaden worker scopes or authorize provider charges. The browser never receives private provider locators or credentials from the archive picker.

## Validation and remaining work

The browser fixtures exercise the real React components with locally intercepted API/storage responses and strict production request schemas. Coverage includes all three media contracts, exact archive association, member and reviewer restrictions, stale data, interrupted retries, checksum corruption, work/package boundaries, mobile layout and preserved VFX views. The same browser lane runs against a production Next build in CI, alongside server/PostgreSQL, isolated media decoding, renderer and 50-session checks. Synthetic browser media is not evidence of provider output quality or live storage connectivity.

Before release: qualify the actual archive worker and separately supplied Runpod storage, apply the controlled database/runtime rollout, and verify live permissions and operational recovery. External-account generated-file delivery and acknowledgement remain unfinished. The candidate includes an explicitly approved [generated continuation](GENERATED_MEDIA_CONTINUATION_PLAN.md), default off, which lets a coordinator resume one stopped specialist against an exact verified archive within the existing run allowance. This still requires deployment qualification and a newly reviewed policy. None of those capabilities is implied by a prepared internal package.
