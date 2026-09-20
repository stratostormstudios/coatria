# Generated-media persistence foundation (withheld)

Migration `030_studio_generated_media.sql` is **unreleased**. The current
checkout connects version-aware project reads, registration, QC and internal
packaging. Do not apply it to production until the full runtime slice and
PostgreSQL/rollout checks are qualified. The migration itself creates no
provider jobs, grants, files, client deliveries or autonomous work. Database
fixtures are synthetic authority tests, not generated media.

Existing projects/artifacts default to contract 1. Their JSON, frame values,
request receipts and manifest hashes are not rewritten. Legacy runtime writes
do not need access to either new evidence table. Explicit contract 2 requires
`production_path='higgsfield'` and one strict image/video/audio specification.
Its stored frame rate is the reduced rational emitted by the shared parser.

`studio_shots.media_kind` is `legacy_frames`, `image`, `video` or `audio`.
Legacy requires its original non-null frames/handles and no duration. Image
requires no frames, handles or duration; video/audio require bounded ordered
`duration_min_ms`/`duration_max_ms` and no frames/handles. Generated disciplines
must be `[]`. Project/shot kinds agree; generated specifications and work-unit
requirements are immutable. Generated work cannot enter DCC execution or DCC
media promotion. Existing services must still negotiate v2 explicitly before
listing or interpreting these rows: the migration does not filter their reads.

Every v2 artifact must have one deferred, transactionally complete row in
`studio_generated_artifact_sources`. Columns pin company/project/artifact/work,
archive/request/job/output/storage-version IDs, canonical specification hash,
exact manifest text/hash, frozen source attribution, observed media and verified
file facts. `archive_approved_by` preserves separate transport-approval
attribution; original generation requester/agent/sponsor/run/approver stays in
the frozen source snapshot and common artifact columns. Registrar identity is
separate. A completed archive's old lease/approval expiry is not used as new
registration authority.

Composite FKs and deferred checks require the exact verified archive/fetch,
ready archive upload, immutable version and stored-byte verification. Source
request/account/job/output/work relationships, original attribution, locator
identity, byte count, hash, content type and ETag must agree. Output, archive and
storage version are each single-use for this publication policy. Source evidence
is append-only while its project exists; whole-project/tenant deletion may
cascade. Artifacts and reviews in v2 cannot be rewritten.

The artifact URL is exactly:

```
/api/companies/{company}/studio/projects/{project}/generated-artifacts/{artifact}/manifest
```

Its common `sha256` hashes UTF-8 manifest bytes, not file bytes. Manifest JSON
must be an object with no duplicate keys, and its hash must equal the artifact
hash. Its authoritative projection is `schemaVersion:2`,
`kind:'verified_generated_media'`, `mediaKind`, `companyId`, `projectId`,
`artifactId`, `workItemId`, `archiveId`, `archiveApprovedBy`, `requestId`, `jobId`,
`outputId`, `storageVersionId`, `specSha256`, plus exact `source`, `media` and
`file` objects from the evidence row. Extra top-level fields are presently
permitted; the future service must define and validate the final strict wire
contract. They cannot replace the authoritative projection. Hashing/spec
canonicalization uses core PostgreSQL SHA-256, without an added extension.

Every v2 `studio_reviews` row must also have an append-only
`studio_generated_review_evidence` companion with its exact artifact/spec/
manifest hashes, attestation version 1 and technical-match object. Approval
requires a positive match and `technical_qc`. The reviewer must be a current
human admin, locked through commit, and must differ from the original producer,
agent sponsor, provider sponsor and registrar. Generation/archive approval
alone is not classified as creative production. This schema does not perform
creative QC, check whether media was actually viewed, or grant review authority
to a bot. Existing v1 review inserts cannot alone approve a v2 artifact.

The shared `studio-generated-protocol.ts` remains authoritative for runtime
observed-media shape and specification matching, including unknown color,
cadence and duration precision. SQL deliberately does not duplicate the decoder
schema. The registration service runs that matcher, authenticates the
caller and live agent lease/capabilities, validates current role/task/project
gates and storage availability, allocates versions, and saves idempotent receipts.
The database evidence joins do not replace those checks. QC enforces latest
artifact/work requirements and client delivery still needs its own external
account-bound storage transport. No new permissions are granted by 030;
`runtime-permissions.sql` separately adds evidence SELECT/INSERT only.

`tests/studio-generated-persistence.test.ts` uses an isolated PGlite database
when explicitly requested, and a dedicated local PostgreSQL database when
`COATRIA_INTEGRATION_DATABASE_URL` is configured. The real PostgreSQL cases test
competing source publication and revocation while review waits on a membership
lock. It never calls a provider or a production database.
