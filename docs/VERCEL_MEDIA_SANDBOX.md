# Vercel media decoder boundary

Status: implemented adapter and separate remote archive entry, **disabled and
not accepted for production qualification**. Passing fixture tests or partial
live qualification runs does not establish all provider
isolation. The 2026-09-21 Vercel host screen found Ubuntu 26.04 without systemd
PID 1; that machine does not pass the existing Linux/AppArmor host profile.

This is a separate backend for the same media-inspection interface. Each
`ffprobe` or `ffmpeg` invocation gets a fresh Firecracker microVM. Full inspection
currently makes three invocations, so it creates and stops three microVMs. No
VM is reused between commands, media files, archive attempts or tenants. The
existing Linux backend and rejection of native production decoding remain.

Vercel describes the microVM and host-side network controls as its security
boundary, including against guest-root code. This backend relies on that
provider boundary rather than claiming systemd, bubblewrap or AppArmor operate
inside the guest. See [Vercel's security architecture](https://vercel.com/blog/one-million-dollar-hacker-challenge-for-vercel-sandbox)
and [deny-all networking](https://vercel.com/docs/sandbox/concepts/firewall).

## What enters the guest

Only a hash-verified executable closure, fixed launcher, constrained decoder
arguments and an exact copy of one already-open source file enter the guest.
The controller constructs a bounded tar.gz and sends it to the authenticated
control-plane file-write API. Paths are fixed under `/vercel/coatria`; caller
filenames, source URLs, bearer values and arbitrary command options are rejected.
The image is pinned to the observed digest:

`vercel/sandbox/universal@sha256:112a1b3ad9ae53b6f9a6afbd9a102b62bcc3017db0b8465fa35fe1e3aa386b6d`

The requested and returned policy must agree on `iad1`, 2 vCPU, 4096 MiB, the
bounded TTL, no persistence, no exposed routes, no source snapshot and deny-all
networking. No source checkout, drive, runtime download or credential injection
is requested. The command starts with an empty environment; the decoder only
inherits locale variables and its read-only source descriptor. The launcher
verifies every supplied file hash before starting the pinned decoder and bounds
stdout/stderr. A warning or nonzero decoder exit fails inspection.

The trusted controller retains all Vercel, database and storage credentials,
provider output URLs, authorization and storage writes. It must archive its own
verified source copy, never a file returned from the guest. Decoder output is
untrusted metadata, not evidence granting access or spending authority.

`closure.files` contains relative file paths, byte lengths and SHA-256 hashes,
including `bin/ffmpeg` and `bin/ffprobe`. Only the selected executable and shared
dependencies are transferred for each invocation. Static binaries can run
directly; a dynamically linked executable may use the loader and OS libraries
in the exact digest-pinned image. Alternatively, a bundle supplies an explicitly
pinned `loader` and `libraryDirectories`. Qualify the actual dependency route;
using the image's glibc does not prove a separately uploaded loader closure.
The adapter snapshots verified bytes at construction and hashes the full
manifest plus launcher into `qualificationBinding.closureSha256`.

## Qualification and activation

`createVercelMediaSandboxCandidate(options)` runs the same bounded lifecycle for
an explicitly authorized qualification exercise. It is always unbranded and
the production media inspector refuses it. An optional injected fetch exists
only for local tests and is rejected in `NODE_ENV=production`.

`createVercelMediaSandbox(options, {receiptPath, sha256})` accepts an installed
operator-reviewed receipt only on a nonroot Linux x64 controller. Receipt,
closure files and their ancestors must be root-owned, canonical and unwritable
by that controller. File pins, provider binding and limits must match exactly.
The receipt's lifetime is at most seven days and expiry is checked during each
invocation. A change to the image, launcher, decoder bundle or accepted limits
requires new evidence and a newly pinned receipt.

Receipt schema:

```ts
{
  version: 1,
  backend: 'vercel-firecracker',
  mode: 'live-provider',
  teamId, projectId, region: 'iad1', image, closureSha256,
  limits: {maxInputBytes, maxClosureBytes, timeoutMs,
           maxOutputBytes, maxStderrBytes},
  issuedAtMs, expiresAtMs,
  checks: { /* every VERCEL_MEDIA_CHECKS entry: true */ },
  evidence: [{sessionId, sha256}] // SHA-256 of retained live evidence
}
```

The receipt is an administrator acceptance record, **not remote attestation**.
Parsing boolean checks does not prove that they happened. Never create an
accepted receipt from fixtures or from the host compatibility screen. Retain
and review actual provider-session evidence for all exported checks: seven
formats, malformed media, denied network and external secrets, resource/output
bounds, normal and aborted descendant cleanup, TTL/controller loss, ambiguous
creation reconciliation and identity drift rejection. Where failure paths are
injected locally, label them as such; they supplement live boundary evidence.

A live exercise must prove actual behavior of file upload, the pinned decoder,
output capture, no public network/DNS/private-metadata access, cancellation,
detached descendants, exhausted resources and terminal session cleanup. Test
the controller's death separately so the provider TTL is exercised without a
successful controller stop. The production controller must still pass its
database, scratch, keyring and storage/gateway preflights.

## Durable authority and cost ownership

The adapter requires three asynchronous callbacks supplied by the trusted
controller, bound to the current company, archive attempt and live lease:

- `journal.reserve(intent)` atomically validates the spending/lease authority,
  reserves worst-case CPU, memory and bounded transfer cost, and durably stores
  the unique creation intent **before** the create request. Reject unresolved
  earlier attempts or exhausted company/pilot budgets. A no-op or in-memory
  journal is only suitable for fixtures.
- `journal.authorize(intent)` rechecks current authority before create, upload,
  command execution and result acceptance. Lease loss must also abort the
  supplied run signal promptly; do not wait for the next callback.
- `journal.record(event)` durably records returned IDs, ambiguity, cleanup
  intention and the confirmed terminal status. Never interpret a cleanup
  request or a local timeout as proof that a session stopped.

Callbacks use fixed metadata and never receive credentials. The token callback
supplies the control-plane bearer only to native fetch at `api.vercel.com`;
redirects and automatic request retries are disabled. The SDK's automatic
retries/resume behavior is not used.

A lost create response permits one read-only exact-name lookup with
`resume=false`; it never permits another create or continued decoding. A 404
does not prove that an asynchronous creation will never appear. The executor
is poisoned, the durable reservation remains pending reconciliation, and any
recovered exact session is stopped. A missing session ID or unconfirmed cleanup
also poisons the executor. A restarted controller must reconcile outstanding
intents before its journal permits new resources.

Cleanup uses a separate 15-second deadline even when the user signal or grant
is cancelled. One stop request is followed by exact-session readback until a
terminal status is observed. Journal failure cannot suppress the stop attempt;
it does prevent a successful result. The provider TTL is the independent final
cutoff. Never implicitly extend it, snapshot, resume or reuse a guest. Terminal
status proves session termination, not physical disk erasure or billing
settlement. Account for the full reserved envelope until reconciliation.

## Bounded composition

This initial adapter buffers its verified source, tar and gzip in controller
memory. Hard ceilings are 128 MiB per source, 256 MiB for the full closure, 64 MiB
stdout, 64 KiB stderr and 120 seconds per VM. Choose smaller pilot limits and
size controller memory for these copies. This is not a heavy-footage decoder
or a substitute for the separate large-file storage gateway.

The original archive entry point still constructs the Linux backend. The separate
`scripts/higgsfield-remote-archive-worker.ts` explicitly selects this adapter and
supplies database-backed callbacks bound to the archive and live lease. It requires
an immutable, hash-pinned operator configuration and reviewed qualification
receipt, scopes claims to the approved company and projects, and runs database,
scratch and recovery preflights before claiming work. Hosted activation and its
actual service preflight remain unverified; the separate entry does not enable
itself in the web deployment.

The remote entry aligns `maxBytes` with the accepted source limit and
`maxProbeBytes` with the accepted stdout limit. A smaller qualified
output limit does not silently override the inspector's 16 MiB default.
`sandboxTimeoutMs` can cap each remote invocation while the inspector's
`limits.timeoutMs` caps the entire three-command inspection. For example,
reviewed limits may allow 90 seconds per command inside a 300-second inspection
and a 120-second VM TTL; this is a configuration example, not a performance
qualification. All values must fit the accepted receipt.

Local lifecycle tests use synthetic transports and prove no provider runtime
properties. Complete real qualification, hosted composition verification,
scoped credentials and an actual archive-through-gateway acceptance run remain
before activation.
