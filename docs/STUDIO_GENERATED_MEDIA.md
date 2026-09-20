# Generated media workflow

`src/lib/studio-generated-protocol.ts` defines an opt-in version 2 contract for
new Higgsfield projects. The application connects typed project creation,
verified-archive registration, independent review, internal packaging and
authenticated external-client delivery. Source `41bbaf0`, migrations 030–033
and matching application runtime grants are verified in production as of
2026-09-20. See [RELEASE_STATUS.md](RELEASE_STATUS.md) for authoritative deployment
and CI evidence. Archive and storage-gateway execution remain disabled; their
separate service roles and actual host/storage qualification are outstanding.
Application deployment does not authorize paid generation or establish a
completed provider-to-client pilot.

Each project has one output kind. Image work units require one PNG, JPEG or
WebP with reviewed dimensions and an explicit color requirement. Video work
units require MP4 or MOV, a supported codec, dimensions, constant rational
frame rate, audio policy and an approved duration interval. Audio work units
require WAV or MP3, a supported codec, sample rate, channels and duration.
Image and audio units do not acquire invented frame ranges or VFX handles.

Observed media must come from full decoding of the exact archived bytes.
The matcher rejects unsupported or inconsistent facts and checks those facts
against the approved specification. Unknown color metadata is not inferred;
projects can explicitly waive the color check. Average frame rate does not
prove constant frame rate. Rounded video duration is accepted only when its
whole rounding interval fits the approved tolerance; audio duration is checked
from decoded sample counts. Embedded audio timing and synchronization still
need independent review.

`matchGeneratedArchiveMedia` additionally binds the observation to the required
storage byte length, SHA-256 and content type. The specification digest is a
separate canonical hash of the versioned specification and work unit. Neither
the digest nor a successful technical match constitutes creative QC or client
acceptance.

Registration loads source facts from an exact verified archive on the server,
enforces current tenant/project/work/role authority and agent leases, preserves
the original producer separately from registrar and archive approver, and
atomically appends immutable source and manifest evidence. Caller input selects
an archive and cannot supply media URLs, byte facts, probe results or authors.
Manifest SHA-256 identifies the canonical artifact manifest; `file.sha256`
identifies media bytes. They are distinct evidence fields.

Project creation requires `contractVersion:2` and `productionPath:'higgsfield'`.
Existing readers continue to see only v1 unless they explicitly request
`contractVersion=2`; filtering occurs before pagination. The generated artifact
route is `POST /api/companies/{company}/studio/projects/{project}/generated-artifacts`.
The corresponding agent tool is `studio_generated_artifact_register`, using
the same service and current authorization checks. Human reviewers use the
existing reviews route. The artifact manifest GET returns exact stored UTF-8
bytes and its manifest digest, with authenticated private/no-store access.

A review requires an independent current human administrator. The original
producer, agent sponsor, provider sponsor and registrar cannot review their
own contribution. An approval records exact specification/manifest hashes and
the technical match in an append-only companion. It does not accept a task.
Submission requires a verified generated artifact; task acceptance also needs
approval of that exact latest version. Internal packaging requires every final
work unit and its QC task to be accepted and includes the precise review
receipts. Its version 2 manifest reports `transportStatus:'not_transferred'`.

Historical project/manifest reads remain available when storage is offline or
an archive is revoked. New publication, submission, approval and packaging
revalidate current availability; historical provenance is never new access
authority. A completed archive's expired transfer lease is not reused as a
registration lease.

Existing frame-based parsers, v1 request digests and DCC promotion records stay
unchanged. [Generated client delivery](STUDIO_CLIENT_DELIVERY.md)
adds exact-version, external-account storage grants after independent delivery
handoff acceptance. Client-visible schema-v2 snapshots pin each generated file;
authenticated range downloads renew scoped access and verify complete bytes
before saving. Only the designated external account can acknowledge the package
or request changes. Internal manifests retain their historical `not_transferred`
state, and manual generated client-acceptance gates remain rejected. The older
creative-followup mechanism still rejects v2 rather than treating a human-attested
v1 pairing as verified generated evidence.

PostgreSQL CI has exercised concurrent registration, duplicate-source rejection,
lease expiry after lock waits, review revocation and restricted evidence grants.
Connected agent registration and legacy compatibility also have automated tests.
The deployed source passed all four CI jobs; exact counts and live checks are
recorded in [RELEASE_STATUS.md](RELEASE_STATUS.md).

The [generated-media workspace](GENERATED_MEDIA_WORKSPACE.md) now provides typed
creation, exact-source registration, independent review, internal packaging,
client invitations, checksum-verified downloads and read-only authenticated
client response provenance. Its browser lane uses synthetic API/storage fixtures.

The deployed application also includes default-off [bounded agent continuation](GENERATED_MEDIA_CONTINUATION_PLAN.md)
and human-applied [creative revision rounds](STUDIO_GENERATED_REVISIONS.md).
Remaining operational work includes the separately restricted archive/gateway
service roles, actual host and Runpod volume qualification, then an authorized
generation-to-client pilot with independent human QC and genuine client
acceptance. Local synthetic database fixtures prove authority rules; they do
not prove a real provider transfer or certify client media quality.
