# Dedicated media storage and archive host rollout

Updated 2026-09-20. The user approved the dedicated volume and synthetic test.
The volume was created and its identity verified through the Runpod API:
`65dfq9bykj`, `coatria-stratostorm-media-pilot`, 10 GB in `US-NC-2`.
No compute was started. The transport test is prepared and the user has signed
in to the console. Runpod's creation dialog grants an S3 key read/write access
to every account network volume. The temporary key
`coatria-media-pilot-conformance` is prepared but has not been created; approval
for that broader credential scope is pending. The proposed key will be used
only for the new volume's synthetic test and revoked afterward.

## Observed account state

An authenticated read of the Runpod network-volume inventory returned an
unrelated 150 GB model volume in US-NE-1 and the retained 10 GB Coatria worker-state
volume in US-NC-2. Neither is a selected media test destination. This was the
inventory before creation; the approved dedicated volume above now exists.

The public Coatria health endpoint returned ready and its published agent API
reported version 1.11.1. These reads do not establish its source commit, database
migration ledger, archive flag, host configuration or credential grants.

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

## Missing inputs

- Separate Runpod S3 access credentials.
- An accessible production Linux VM or a reviewed provider/account choice and
  hosting allowance. No suitable host has been selected or qualified.
- The specific source output, project destination and current human archive
  approval for the final live media canary.

The prepared transport plan is pinned to the actual created volume and fresh
synthetic object identities. Its SHA-256 is
`efd91e7d7f2a6dcdcef922b0411e806aa7e82fcb5b5197bc3301cc7594abd353`.
The plan and create/readback receipts are in the local operator evidence folder
`output/coatria-generated-v2/media-storage-live-20260920` outside this repository.
No provider write for the synthetic test has been attempted yet.

## Provider references

- [Network-volume pricing](https://docs.runpod.io/storage/network-volumes).
- [Runpod S3 API and supported regions](https://docs.runpod.io/storage/s3-api).
- [Network-volume creation API](https://docs.runpod.io/api-reference/network-volumes/POST/networkvolumes).

Runpod documents S3 access without starting a Pod. The archive process is a
separate CPU host requirement; no GPU is required for copying and validating an
already generated output.
