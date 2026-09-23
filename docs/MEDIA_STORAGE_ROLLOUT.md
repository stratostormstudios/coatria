# Dedicated media storage and archive host rollout

Updated 2026-09-22. The user approved the dedicated volume and synthetic test,
and subsequently authorized a USD 100 cap for new pilot spending.
The volume was created and its identity verified through the Runpod API:
`65dfq9bykj`, `coatria-stratostorm-media-pilot`, 10 GB in `US-NC-2`.
The final synthetic transport test passed on source `120c6a8`. It verified
5,308,416 stored bytes through full SHA-256 readback and a range crossing the
multipart boundary. Two synthetic objects remain, totaling 10,616,832 bytes;
four earlier empty multipart uploads were confirmed aborted. No compute was
started. The user authorized temporary account-wide S3 credentials for the
named-volume test, and both temporary keys were revoked afterward. Fresh
private credentials will be needed for a separately qualified trusted service.

## Observed account state

An authenticated read of the Runpod network-volume inventory returned an
unrelated 150 GB model volume in US-NE-1 and the retained 10 GB Coatria worker-state
volume in US-NC-2. Neither is a selected media test destination. This was the
inventory before creation; the approved dedicated volume above now exists.

The production domain was verified after promotion on 2026-09-22 at source
`7162fb1`, deployment `dpl_9eB6HGU5Jd4qMNdDFawBfD5gco9m`, with migrations through
034 and published agent API **1.13.0 / 175 paths**. It now contains the tested
storage fixes from runtime `120c6a8`; 12 staged and 12 live checks passed. A new
main-database deployment was used; the isolated preview was not promoted. Archive and gateway
activation remain disabled; their production service logins, actual host
qualification and authenticated application transport are still outstanding.
See [release evidence](RELEASE_STATUS.md).

## Approved storage resource

| Field | Approved configuration |
| --- | --- |
| Provider | Existing Runpod account |
| Name | `coatria-stratostorm-media-pilot` |
| Type | Standard network volume |
| Region | `US-NC-2` |
| Allocated size | 10 GB |
| Published storage estimate | $0.70/month at $0.07/GB/month; verify the account quote before purchase |
| Compute | None provisioned or started by this proposal |
| Access | Runpod S3 API, separate access key and secret supplied privately |
| First write | Synthetic transport qualification only |

The reviewed creation payload was:

```json
{
  "name": "coatria-stratostorm-media-pilot",
  "dataCenterId": "US-NC-2",
  "size": 10
}
```

The cost estimate covers storage only and is not a billing cap. Storage remains
billable while compute is stopped; deletion or later expansion requires its own
specific resource decision. Check inventory again before creation. If a matching
resource already exists, reconcile its identity instead of creating a duplicate.
After an ambiguous creation response, inspect inventory and provider evidence;
do not retry a chargeable creation blindly.

## Qualification sequence

1. Confirm the resource choice, create or select the dedicated volume and record
   the returned provider identity and actual region/size. Never invent a volume ID.
2. Supply separate Runpod S3 credentials through private operator configuration.
   A Runpod compute API key cannot substitute for these credentials.
3. Prepare the existing [transport qualification](PROJECT_STORAGE_CONFORMANCE.md)
   plan using that actual volume ID. Review its exact plan hash, then execute it.
   It uploads 5 MiB + 128 KiB, retains one 5 MiB + 64 KiB synthetic object and
   aborts a second small multipart upload. Preserve the mutation journal.
4. Select a Linux x64 VM with systemd delegation, the pinned decoder closure,
   supported AppArmor/bubblewrap policy and private scratch. Install the archive
   service disabled and qualify its actual isolation boundary. An ordinary
   Runpod container or a passing GitHub runner does not qualify that VM.
5. Configure separate restricted archive-worker and gateway database logins,
   current migrations, a private encryption keyring and exact provider-host
   allowlist. Validate HTTPS ingress and Coatria origin policy for the gateway.
6. With one existing approved Higgsfield output and an exact archive approval,
   execute one bounded archive. Verify stored length/hash, independent media
   review and an authenticated external-client download through the gateway.
   Exercise revocation and interrupted transfer before enabling normal traffic.

The initial volume is a small qualification destination. It is not a capacity,
backup, retention, disaster-recovery or million-user commitment. Account S3
credentials stay in trusted services; Coatria's gateway supplies tenant and
project authorization. The transport test alone does not prove these boundaries.

## Remaining live inputs

- Fresh private Runpod S3 credentials for the qualified service; test credentials
  were revoked and must not be reused.
- An accessible production Linux VM or a reviewed provider/account choice and
  hosting allowance. No suitable host has been selected or qualified.
- The specific source output, project destination and current human archive
  approval for the final live media canary.

The passing final plan is pinned to the created volume and exact synthetic
object identities. Its SHA-256 is
`0ab50ae84a59d11469b44f8b97027ec26a7e42fb97aac2b7731c83a10fee8141`.
The plan, report and journal are in the local operator evidence folder
`output/coatria-generated-v2/media-storage-live-20260920/conformance-final`
outside this repository. The report establishes provider transport, not gateway
authorization, tenant isolation, production media, backup/retention, or host
qualification. Earlier failed attempts and reconciliations remain retained.

## Provider references

- [Network-volume pricing](https://docs.runpod.io/storage/network-volumes).
- [Runpod S3 API and supported regions](https://docs.runpod.io/storage/s3-api).
- [Network-volume creation API](https://docs.runpod.io/api-reference/network-volumes/POST/networkvolumes).

Runpod documents S3 access without starting a Pod. The archive process is a
separate CPU host requirement; no GPU is required for copying and validating an
already generated output.
