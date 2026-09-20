# Generated media contract foundation

`src/lib/studio-generated-protocol.ts` defines an opt-in version 2 contract for
new Higgsfield projects. It is currently a shared validation and matching
library. Project creation, database rows, artifact registration, review and
client delivery still use the existing version 1 application flow; importing
this library does not enable a new production workflow.

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

The next integration must load source facts from a verified archive on the
server, enforce tenant/project/work/version authority, preserve original
producer and approver attribution, and atomically append immutable source and
manifest evidence. Caller-supplied URLs, hashes or probe results must not mint
verified artifacts. Existing frame-based project parsers, request digests and
DCC promotion records remain unchanged. Version 2 storage-backed client
delivery needs its own exact-file, account-bound download path before it can
be offered to users.
