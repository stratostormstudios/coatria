# Trusted archive and storage service packages

These tools produce separate Linux x64 CPU service artifacts. They do not
provision a Pod, publish files, enable a service, or qualify a decoder. Both
services use the reviewed Node 24.19.0 image digest already used by managed
workers. Their fixed 10 GB container disk holds temporary installation and
archive scratch data; they require no network volume. PostgreSQL retains
authority, spending reservations and uncertain outcomes. Media stays in S3.

## Build and publish

Use a clean, reviewed checkout and dependencies installed from its exact lock
with `npm ci --ignore-scripts`. After committing the reviewed source, run:

```text
node scripts/hosting/build-trusted-service-bundle.mjs <repo> <40-character-source-commit> archive <new-archive-output>
node scripts/hosting/build-trusted-service-bundle.mjs <repo> <40-character-source-commit> gateway <new-gateway-output>
```

Each output contains `runtime.mjs` and `bundle.json`. The manifest records the
source commit/tree, exact lock hash, compiler version, every source/dependency
byte hash actually supplied to the compiler, and the final bundle hash. The
builder rejects changed application inputs and external package imports.
Only Node builtins remain external; pg-native is explicitly disabled. The CPU
host runs neither npm nor tsx and downloads no runtime dependencies.

The same builder accepts `media-qualification` for the fixed
`qualify-vercel-media-service.mts` entry. The service bootstrap and backend
presets reject this kind; it is an opt-in qualification artifact only.

Publish these small, nonsecret artifacts at immutable URLs, for example
`public/downloads/trusted-services/<source-commit>/<service>/` in a separate
artifact commit. The publishing commit may differ from the recorded source
commit. Review and retain the bundle manifest SHA-256; a successful build is
not an accepted service or media-qualification receipt.

Import `buildTrustedServiceBootstrap` from
`scripts/hosting/build-trusted-service-bootstrap.mjs` and pass:

```ts
{
  root, bundleDirectory, bundleSha256,
  configuration, assetsBaseUrl,
  mode: 'preflight', // switch to 'service' only in the reviewed service preset
  archive: { // archive service only
    receiptPath, closureRoot,
    urls: { 'closure/bin/ffmpeg': pinnedUrl, 'closure/bin/ffprobe': pinnedUrl },
    auth: { 'closure/bin/ffmpeg': 'vercel-project-oidc',
            'closure/bin/ffprobe': 'vercel-project-oidc' }
  }
}
```

The function is offline and returns the image, command, command hash,
configuration hash and artifact manifest. It validates local bundle, receipt
and decoder bytes. `archive.urls` also permits an explicit public URL for
`qualification.json`; otherwise that file is relative to `assetsBaseUrl`.
Authenticated downloads are restricted to archive closure files on the exact
dedicated decoder-artifact private Blob hostname
`w3g7pnchlhdmqpb5.private.blob.vercel-storage.com`. The archive-only project OIDC
token supplies that request's bearer. No credentials enter URLs, manifests,
commands, public artifacts or gateway configuration. Redirects and retries
are disabled; every downloaded artifact must match its exact size and hash.

## Immutable service configuration

The backend's trusted-service preset is the authoritative schema and scope.
Its private environment projection supplies `COATRIA_SERVICE_CONFIGURATION`,
its canonical SHA-256, the service kind, source commit and absolute expiry.
The bootstrap checks those against its embedded pins and writes the nonsecret
configuration into its root-owned immutable release. It passes only each
service's dedicated database LOGIN and required credential vault to the child;
the archive additionally receives the project-scoped Vercel executor token.
It strips lifecycle credentials, `NODE_OPTIONS`, proxy variables and unrelated
provider secrets from the child's environment.

Archive configuration paths are fixed:

```text
/opt/coatria/trusted-services/archive/<source-commit>/closure
/opt/coatria/trusted-services/archive/<source-commit>/qualification.json
/var/lib/coatria-archive-scratch
```

The entry and complete bundle are root-owned; the child runs as uid/gid 1000.
The archive constructor independently checks its immutable closure and accepted
receipt before work. Decoder files are only read for upload to Vercel; untrusted
media is never decoded by the CPU controller. The gateway entry reads its
immutable configuration and enforces company/project scope for transfers and
verification claims. It receives no decoder, Vercel token or agent enrollment.

## Deadlines and verification

The root supervisor enforces a fixed absolute expiry at most 24 hours away,
including bootstrap time. It gives the service process group 35 seconds to
finish cleanup and then 5 seconds for forced termination. Leader exit alone
does not prove group termination. Unconfirmed termination is reported as a
failure; durable database/provider reconciliation remains necessary. Stopping
the child is also not evidence that the Pod stopped billing: the provider
lifecycle controller must confirm the actual Pod state.

`mode: 'preflight'` performs database LOGIN/grant and service configuration checks
without claiming work or opening the gateway listener. Real Linux filesystem,
service identity, TLS/proxy routing and archive-through-gateway acceptance must
still be verified on the selected provider. Local tests establish configuration,
bundling, secret separation and lifecycle behavior; they cannot establish a
hosted boundary or replace the Vercel media qualification evidence.

## Branded inspector smoke

After reviewing the complete live-provider qualification evidence, stage its
provisional acceptance receipt, pinned closure, bundle manifest and one exact
reviewed PNG as immutable root-owned files on the disposable Linux controller.
Run the `media-qualification` bundle as uid 1000 with `--config` and `--sha256`.
The config schema is exported by the fixed entry and requires
`purpose: 'qualification-only'`, the exact backend source hash, fixed limits,
three consecutive pre-reserved global ordinals within 1–64, and an expiry
between six minutes and one hour away. Only the 111-byte or 12,586,943-byte
reviewed PNG is accepted. The only provider credential needed is the project
token in `COATRIA_VERCEL_MEDIA_TOKEN`; do not supply database or keyring secrets.

Prepare `/var/lib/coatria-media-qualification/<reservation-id>` as a private
uid-1000 directory. The exclusive, fsynced journal prevents replay on the same
host, allows exactly `ffprobe`, `ffmpeg`, `ffprobe`, and requires confirmed
terminal cleanup before each next launch. The root operator must reserve all
three global slots before starting the CPU host and retain/reconcile the journal
before removing it. A fresh host is not authorization to replay an uncertain
attempt. This is a real branded factory and inspector invocation, with no native
decoder fallback. Its report always says `productionAccepted: false`; the
operator must review that evidence separately before service activation.
