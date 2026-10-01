/** Exact source closure whose bytes accompany every native qualification.
 * Keeping the producer and receipt validator on one explicit list prevents a
 * capability addition from silently dropping a source pin at installation. */
export const MEDIA_SANDBOX_SOURCE_FILES=Object.freeze([
 ...['media-sandbox-launch.c','media-sandbox-probe.c','prepare-media-sandbox-ci.mjs',
  'run-media-sandbox-ci.mjs','media-sandbox-linux-canary.mts','media-sandbox-startup-diagnostic.mts',
  'prepare-media-apparmor-ci.mjs','collect-media-apparmor-ci.mjs','reference-worker-linux-canary.mts',
  'media-sandbox-cgroup-observer.mjs','image-preparation-linux-canary.mts','media-sandbox-source-files.mjs'
 ].map(path=>'scripts/hosting/'+path),
 ...['higgsfield-media-sandbox.ts','higgsfield-media-inspection.ts','higgsfield-reference-worker.ts',
  'higgsfield-references-protocol.ts','higgsfield-reference-transport.ts','higgsfield-image-preparation.ts',
  'higgsfield-image-preparation-policy.ts','higgsfield-image-preparation-source.ts',
  'higgsfield-image-preparation-png.ts','project-image-preparation-sandbox.ts'
 ].map(path=>'src/lib/'+path)
]);
