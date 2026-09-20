# Media decoder boundary and host qualification

The archive worker accepts a qualified Linux decoder object, never an arbitrary
command, container flag or caller-supplied `run()` implementation. Qualification
is specific to the executable closure, runtime code, kernel and delegated cgroup
configuration. A successful native Windows decode does not qualify a Linux host.
The new Linux CI lane must actually pass before its host/runtime is qualified;
writing these scripts is not that proof. Runpod is not qualified by this lane.

## What runs at the boundary

`higgsfield-media-sandbox.ts` validates an immutable root-owned manifest, exact
file lengths/hashes and the entire root filesystem, rejecting symlinks, writable
ancestors, extra files and unsupported settings. It checks the fixed launcher and
`/usr/bin/bwrap`, then runs both tools' seekable-FD capability check through the
same executor used for inspection. A private branded object authorizes the
inspector; a JSON claim or ordinary object cannot bypass qualification.

The unprivileged C helper validates a regular read-only input on FD0, joins an
already capped cgroup before any fork/exec, then waits for the supervisor's gate.
The supervisor verifies membership and limits before releasing it. The helper
sets parent-death SIGKILL, no-new-privileges and hard descriptor/core/file-size
limits, closes all extra handles and invokes fixed bubblewrap arguments.

The decoder sees the read-only manifest closure, read-only private procfs, minimal
devices and the input FD. It receives no provider/DB/keyring environment, host
storage, home directory or network interface other than isolated loopback. User,
mount, PID, network, IPC, UTS and cgroup namespaces are separate; capabilities are
dropped and nested user namespaces disabled. Full decoding still enforces format,
byte/hash, duration, pixel/sample and output budgets inside this OS boundary.

Every execution has `memory.max`, zero swap, group OOM handling, `pids.max` and
aggregate `cpu.max`. CPU bandwidth permits period bursts; wall time supplies the
separate deadline. On success, failure, abort or timeout, the supervisor kills the
whole cgroup and proves it empty before returning or deleting it. Cleanup failure
poisons the executor. Parent-death/PID-namespace cleanup must also work when the
supervisor is SIGKILLed and JavaScript cleanup cannot run.

## Reproducible CI preparation

The `media-sandbox-linux` job uses an Ubuntu 24.04 VM, not a job container. Root
preparation is explicit and separate from unprivileged qualification:

The package lives under a unique `/var/lib/coatria-media-ci-*` directory.
Preparation checks `/`, `/var`, `/var/lib` and the new package directory for
root ownership, canonical non-symlink paths, safe modes and denied write access
as the worker UID with supplementary groups cleared. It records the exact
uid/gid/mode/access results in `path-ancestors.json` before installing anything.
A shared runner-writable `/opt` is not an acceptable package ancestor; preparation
does not weaken runtime trust or change shared host-directory permissions.

- FFmpeg `n8.1.2-50-g1a748fe2cd`, archive SHA-256
  `7d6d93e9c39e0e461feb13c118e91e4eec2515e4da3a01d4ad6790996731bbee`.
- glibc/loader dependency closure copied from
  `node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`.
  ELF headers and transitive dependency names are checked without `ldd`;
  libraries are copied as regular files, never host-library bind mounts.
  Only `/bin/ffmpeg`, `/bin/ffprobe` and the kernel's exact ELF interpreter
  `/lib64/ld-linux-x86-64.so.2` receive mode0555. Ordinary DSOs, including the
  duplicate loader used as a library, remain0444. Setup records/checks each mode;
  runtime qualification checks the declared interpreter's execute permission.
- Ubuntu signed APT package `bubblewrap=0.9.0-1ubuntu0.3`; missing pins fail the
  build. The baseline includes the symlink fix documented in
  [USN-8779-1](https://ubuntu.com/security/notices/USN-8779-1).
- Original C helper/probe built statically with warnings treated as errors.
  Exact compiler/libc package versions and every resulting file hash are saved.

There is no runtime download. Root CI setup downloads only the exact official
Noble `apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.7` package from signed APT
indexes and checks its SHA-256
`bdac5b74d884643653565c52ed7483c9582e646ff72cce8d95d0eb8467a3139c`.
It extracts only the reviewed ABI4 `bwrap-userns-restrict` profile (1,936 bytes,
SHA-256 `11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9`).
Other package profiles are not installed. This follows Ubuntu's
[purpose-built bubblewrap policy guidance](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)
and the tagged [upstream ABI4 profile](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/profiles/apparmor/profiles/extras/bwrap-userns-restrict).

Only `/usr/bin/bwrap` and its capability-denied child profile are activated.
Setup refuses any already loaded target profile (disk bytes cannot establish
kernel-policy identity), conflicting or symlinked policy files, local rule
overrides and disabled/complain overrides. It adds the pair without replacing
loaded policy. It verifies both profiles are enforcing and that global
AppArmor/user-namespace settings remain unchanged, with the restriction still
enabled. No generic unconfined exception, shared networking or NNP change is
used. The original probe must observe the enforcing `unpriv_bwrap` child stack
while still proving zero capabilities and denied nested namespace creation.

Preparation creates one capped service subtree with sibling `supervisor` and
`decoders` groups. The CI root launcher enters `supervisor`, clears supplementary
groups, drops UID/GID and launches the canary with a minimal environment. Only
that service subtree is delegated. Its common-ancestor `cgroup.procs` must permit
migration between these siblings; never delegate the host root cgroup. The
aggregate service caps also include Node and all simultaneous decoder groups.
These constraints follow the kernel's
[cgroup v2 delegation rules](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

## Required evidence

`media-sandbox-linux-canary.mts` has no successful skip path. Its separately pinned
conformance profile replaces both decoder names with an original hostile test
ELF; that ELF is never in the production profile. The canary verifies:

- A host-only key is readable outside and denied inside; a local TCP listener is
  reachable outside and denied inside. Namespace IDs differ from the supervisor;
  inside there is only loopback and no routable default. Unreachable TEST-NET
  probes are supplementary evidence, not proof by themselves.
- The root mount is actually read-only (`statvfs`), writes fail, FD0 is read-only,
  inherited handles/credential canaries are absent and nested userns fails.
- Actual cgroup membership and configured limits; descriptor exhaustion, a PID
  limit event, and group OOM from three children holding 32 MiB each against a
  combined 64 MiB cap. Two CPU-busy children share the 20% bandwidth cap.
- No surviving decoder descendants after normal exit, deadline, abort or abrupt
  supervisor SIGKILL, including children using `setsid()` and ignoring SIGTERM.
- PNG/JPEG/WebP, MP4/MOV and WAV/MP3 fully decode through the real pinned sandbox,
  with exact source SHA/length and observed media facts.

Artifacts are `.devdata/media-sandbox-linux/evidence/path-ancestors.json`,
`setup.json` and `qualification.json`. They retain profiles, closure pins, runtime/helper/canary
source hashes, kernel/namespace evidence and numeric resource events. They contain
no real credentials or provider calls. Only the completed canary sets
`qualified:true`; preparation alone records `qualified:false`.
`apparmor-policy.json` also records the exact reviewed policy and before/after
enforcement/global-setting evidence. Root CI observation after the canary saves
`apparmor-kernel-denials.json`: bounded categories for relevant synthetic-process
denials, without kernel message text, arbitrary profile names or file paths.
The root collector creates its report exclusively under the protected package
directory, then drops UID/GID/groups before an exclusive no-follow artifact write.

Startup failures retain numeric resource events even before the first test.
In CI only, a separate startup diagnostic runs the selected pinned conformance
probe or real decoder's fixed FD-help command through the same capped
helper/ready/gate flow. Input is its known executable, never arbitrary media. It records
static phases, fixed helper exit-stage codes, numeric exit/signal data and
allowlisted setup-error categories. Raw stderr and arbitrary paths/tokens are
discarded. Host user-namespace/AppArmor policy is observed without changing it.
This diagnostic always records `qualified:false`; it cannot substitute for or
turn a failed qualification into success.

## Deployment boundary

Production needs the exact reviewed closure and manifest, a nonroot worker,
qualified kernel/userns/close_range/cgroup-kill features, correctly delegated
empty decoder subtree, and service-wide memory/CPU/task caps. Configure
`COATRIA_MEDIA_SANDBOX_PROFILE`, `COATRIA_MEDIA_SANDBOX_PROFILE_SHA256` and
`COATRIA_MEDIA_CGROUP_ROOT`. The worker does not fall back to bare FFmpeg or trust
an environment flag that declares isolation. Native execution is explicit test
mode only and rejected under `NODE_ENV=production`.

A VM CI pass qualifies that tested environment; an actual production host still
needs equivalent conformance against its exact installed code and profile. An
ordinary Runpod CPU Docker pod must not be assumed to expose delegated cgroups
or user namespaces: Runpod documents that its CPU Docker runtime
[does not support Docker-in-Docker](https://www.runpod.io/blog/enhanced-cpu-pods-docker-network).
No Runpod host isolation or storage-provider proof is claimed here. Separate
provider conformance and independent media QC/client-delivery contracts remain
required before enabling production archive approval.
