# Higgsfield output archives

This implementation connects a completed adopted Higgsfield output to a separately
approved project-storage transfer. Provider completion, verified stored bytes,
technical QC, accepted production work and client acceptance are distinct states.

## Deployment state

Archive proposals, review screens and leased agent tools are implemented. The
transfer worker is a separate Node process, not a Vercel function. The default
`COATRIA_HIGGSFIELD_ARCHIVE_ENABLED` value is off: proposals and history remain
accessible, while new approvals return 503 `HIGGSFIELD_ARCHIVE_UNAVAILABLE`.
The processing field is configuration information, not a worker heartbeat.

Do not enable production approvals until the dedicated database role, reviewed
exact provider-host allowlist, isolated decoder runtime and actual Runpod S3
transfer have been qualified. Local native decoding and mocked S3 streams do not
prove production host isolation or a live storage connection. This feature does
not provision or purchase a volume and does not repurpose existing inference data.

## User and agent workflow

1. Open a project's **Generations & references** tab. A compatible completed job
   offers **Save … output … to project files**.
2. Select the linked storage folder, a new filename or an explicit existing file
   for a new version, and a maximum source size. Preparing records a proposal;
   it does not fetch bytes or contact the storage provider.
3. A current company administrator reviews the immutable source and destination,
   proposal fingerprint, current project/storage revisions, and 1–24 hour expiry.
   Explicit consent authorizes only this archive. Source-generation approval is
   separate and no paid generation is repeated.
4. The worker downloads, fully decodes and checks the source, records immutable
   measured facts, writes a version through multipart storage, then reads the
   complete stored object and compares its checksum and length.
5. Only matching stored evidence marks the archive and file version verified.
   Project files handles ordinary authenticated file access. Approval revocation
   stops future work; it does not promise deletion or retract downloaded bytes.

The source request, original approver, agent and run remain attributed. Archive
authority is its own durable human approval; the originating agent run does not
need an indefinitely renewed lease. Current provider account, administrators,
project approval gates, generation assignment, destination connection and folder
identity are rechecked throughout execution.

## API

The complete schemas are published at `/api/agent/openapi`.

| Operation | Session endpoint | Agent tool |
|---|---|---|
| Prepare exact destination | `POST /api/companies/:companyId/higgsfield/archives` | `higgsfield_archive_propose` |
| Page project history | `GET /api/companies/:companyId/higgsfield/archives?projectId=…&limit=20&after=…` | `higgsfield_archives_list` |
| Read archive | `GET /api/companies/:companyId/higgsfield/archives/:archiveId` | `higgsfield_archive_get` |
| Approve | `POST …/archives/:archiveId/approve` | Human administrator only |
| Revoke | `POST …/archives/:archiveId/revoke` | Human administrator only |

Agents need `creative.write` plus `storage.read` to propose, and `creative.read`
plus `storage.read` to inspect, within their actual authorized run. There are no
agent approval/revocation tools. Session mutations require the accepted origin
and current membership; approval and revocation require administrator authority.
All writes use client operation IDs. After an ambiguous response, replay the same
ID with identical arguments and read current status; do not create a new source
generation. Public responses never contain signed output URLs, encrypted secrets,
storage credentials or worker lease identifiers.

## Worker deployment prerequisites

Apply `029_higgsfield_archives.sql` and refresh runtime permissions before serving
the API. Provision the role in `higgsfield-archive-worker-permissions.sql` through
an administrator; inject its separate login secret and `COATRIA_HOSTING_KEYRING`
through the host secret manager. The worker cannot approve an archive or change
role assignments. Never give its database credentials to an agent or decoder.

Use Node 24 and the committed dependency lock. The standalone entry point is:

```sh
node --import tsx scripts/higgsfield-archive-worker.ts
```

Before enabling processing, run the same entry point with `--preflight`. This
checks configuration, the encryption keyring, service-owned accessible private
scratch, the actual decoder sandbox and the database connection, then exits
without claiming an archive. It works while the archive feature flag is off.
Startup requires both the session and current database identity to be the
dedicated archive LOGIN, rejects elevated attributes and role memberships,
requires migration entries through 029 and compares effective relation/column
privileges and grant options with the shipped worker grants. Unexpected schema
creation, ownership, sequence access or callable non-system SECURITY DEFINER
functions are rejected. These are point-in-time catalog checks; they do not
qualify storage connectivity or establish a complete database security audit.
The application and gateway still require their own current migration floor.

Both modes close the database pool on startup failure. Errors report bounded
codes, never raw connection diagnostics or credentials.

Configure these only on the dedicated worker:

- `COATRIA_ARCHIVE_SCRATCH_ROOT`: existing private absolute directory, mode0700
  on Linux, restricted to the service account on Windows. Each attempt gets a
  random child directory and exclusive source file. Reserve scratch capacity,
  monitor space and clean abandoned directories only after proving their leases
  have ended. No company-controlled filename becomes a scratch path.
- `COATRIA_HIGGSFIELD_OUTPUT_HOSTS`: reviewed comma-separated exact media hosts.
  No wildcard, private address, alternate port, redirect or proxy is accepted.
  Determine these from actual provider outputs privately; never publish signed
  URLs. An expired URL requires investigation, not another paid generation.
- `COATRIA_MEDIA_SANDBOX_PROFILE`: immutable root-owned Linux decoder manifest;
  `COATRIA_MEDIA_SANDBOX_PROFILE_SHA256`: its independently configured digest;
  `COATRIA_MEDIA_CGROUP_ROOT`: empty delegated decoder subtree. The worker checks
  the closure and exercises the actual namespace/cgroup boundary before claiming
  work. There is no bare-decoder or arbitrary-wrapper fallback.
- `COATRIA_ARCHIVE_MAX_SOURCE_BYTES`: deployment ceiling, default512MiB; source
  download and inspection use this ceiling even if a proposal allows more.
- `COATRIA_ARCHIVE_OPERATION_MS`: complete attempt deadline, default30minutes,
  maximum2hours. Concurrency is one per process; database leases arbitrate replicas.

The Linux boundary uses a pinned read-only dependency closure, isolated
namespaces, a clean environment and inherited read-only media FD. A pre-exec
helper joins an aggregate-capped cgroup before launching any decoder; completion
requires killing/draining all descendants. The service itself also needs aggregate
cgroup limits. [Media sandbox qualification](MEDIA_SANDBOX.md) documents exact
installation pins and the hostile-process plus seven-format CI lane. Only actual
passing evidence qualifies that tested host; CI configuration alone and an
ordinary Runpod container do not qualify production deployment.

Stop the service with SIGTERM/SIGINT. It aborts its active operation and records
an uncertain outcome if a provider write might have happened. A failed read can
resume within its finite approval; an uncertain multipart mutation is quarantined
and never repeated automatically. Receipts and the exact provider operation must
be reconciled by an operator. Retained multipart uploads may need manual cleanup;
the platform must not claim cleanup or deletion without provider evidence.

## Validation and limits

The joined tests exercise real scratch streams, multipart recovery, exact stored
SHA-256, cross-company isolation, authority changes, revocation, ended source
agent runs and expired archive leases. Native fixtures cover PNG/JPEG/WebP,
MP4/MOV, WAV/MP3, truncated files, variable cadence and embedded audio. Browser
fixtures check human/agent-facing permissions, exact review arguments, stale
approval handling, folder selection, pagination and mobile layout.

CI prepares a checksum-pinned FFmpeg build with
`scripts/hosting/prepare-media-inspector-ci.mjs`, then tests actual decoding.
This script is never called by the production worker. Locally configure
`COATRIA_TEST_FFPROBE_PATH` and `COATRIA_TEST_FFMPEG_PATH` before `npm test`.
Those explicit native unit tests do not prove host isolation. The independent
`media-sandbox-linux` job must pass its actual adversarial and real-media checks;
it never skips to success when required kernel or cgroup features are absent.

An archive is source evidence, not a production artifact or client package.
Migrations 030–032 and the [generated-media workflow](STUDIO_GENERATED_MEDIA.md)
implement typed image/video/audio registration, independent media QC, immutable
artifact/package manifests and authenticated external-client delivery receipts.
Those separate actions require their current authority and qualified storage;
no archive operation itself marks a task, project or client delivery complete.
