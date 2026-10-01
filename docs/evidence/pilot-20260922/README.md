# Bounded decoder qualification

`accepted-decoder-qualification.json` is the exact accepted receipt for the
September 22, 2026 pilot. Its SHA-256 is
`7f7a162ca57dd775ed19971f074339fec4ec14db014d333b072516fde57cd327`.
It expires September 23, 2026 at 23:29:45.345 UTC. An expired receipt must fail
runtime validation; publishing it does not extend its validity.

The evidence covers the pinned isolated decoder and its stated resource limits.
It does not certify the Runpod archive service, storage gateway, company workflow,
or production readiness of the complete platform. All 61 observed qualification
VMs and both trusted controllers were confirmed stopped. Three unused reservation
ordinals remain held; they are not available for further launches.

Provider resource identifiers are non-secret audit references. This receipt
contains no access credentials or customer media and grants no access or spending
authority. Runtime consumers must pin the immutable Git commit URL and verify the
complete byte hash, scope, limits, and expiry.
