# Runpod storage transport qualification

`scripts/verify-project-storage-provider.ts` tests the real Coatria S3 adapter
against a selected Runpod volume. It is an operator tool, separate from company
authorization and the storage gateway. Passing it does **not** enable transfers
or establish production readiness.

First select a dedicated existing test volume. The retained inference volume
`k4mj9x0yas` is explicitly rejected. The tool never buys a volume, starts a Pod,
lists unrelated files or deletes completed objects. It sends 5 MiB + 128 KiB of
synthetic data, retains one 5 MiB + 64 KiB object and aborts a second small
multipart upload. There are no original media files in the test.

Prepare an offline plan in a new absolute directory whose parent already exists:

```sh
node --import tsx scripts/verify-project-storage-provider.ts prepare VOLUME_ID US-NC-2 /private/conformance/new-run
```

Review `plan.json`, the selected volume and its returned SHA-256. Synthetic
company, project and version UUIDs select a fresh prefix; they do not create
Coatria database records. Configure `COATRIA_CONFORMANCE_S3_ACCESS_KEY_ID` and
`COATRIA_CONFORMANCE_S3_SECRET_ACCESS_KEY` through a private environment or secret
manager. These are Runpod **S3** credentials, separate from the compute API key.
Never put them in startup arguments, terminal history, evidence or this file.

```sh
node --import tsx scripts/verify-project-storage-provider.ts run /private/conformance/new-run EXACT_PLAN_SHA256
```

The run first requires a signed `HeadBucket` response with HTTP 200 for the
selected existing volume, then checks that both selected object keys are absent.
An object HEAD returning 404 does not establish that credentials were accepted;
it cannot replace the known-volume check. `HeadBucket` confirms the provider
accepted that read and the volume exists. It does not prove write permissions,
Coatria company authorization, or tenant isolation. A denied or unavailable
known-volume check stops the run before any provider mutation intent.

When copying S3 credentials from the console, use the complete access-key and
secret fields in the creation dialog. Truncated table previews are not usable
credentials. Do not infer a fixed credential length or extract the first
credential-shaped substring from a page containing multiple keys.

Before each create,
part upload, completion and abort, it writes and syncs an intent to the private
`mutation-journal.jsonl`. Returned descriptors and parts are retained for
reconciliation. It recreates the adapter between parts, completes two parts,
checks HEAD, reads the entire file and compares SHA-256, reads a range crossing
the part boundary, confirms that the adapter rejects a stale ETag and verifies
a separate multipart abort acknowledgement. An absent completed object after
that acknowledgement does not prove that the provider reclaimed all uploaded
parts; part reclamation is explicitly outside this report. It never retries a mutation, including after a
timeout. An existing mutation journal prevents another run in that directory.

If interrupted or failed, inspect the exact journal and reconcile the provider
operation. Do not create a replacement plan merely to bypass uncertainty. The
tool does not automatically abort an uncertain operation or delete retained
objects. A private upload descriptor may need operator/provider investigation.

A later process can independently verify the completed object with reads only:

```sh
node --import tsx scripts/verify-project-storage-provider.ts verify /private/conformance/new-run EXACT_PLAN_SHA256
```

Successful reports state their limits. Stale ETag rejection proves the adapter
refuses changed evidence; it does not by itself prove that Runpod enforced the
conditional header server-side. A fresh adapter is not a process-crash recovery
test. Tenant isolation, account-bound downloads, grant revocation, host
isolation, backup/retention, actual media, gateway restart and authenticated
client delivery require the separate application acceptance tests. Runpod has
no bucket policy, object lock, versioning or presigned-URL support in its current
[S3 compatibility reference](https://docs.runpod.io/storage/s3-api).

The CLI rejects network/device paths, symlink or junction directories and
nonregular, linked or oversized plan files. Intent writes handle partial OS
writes and sync the complete record before provider I/O. Abort is checked again
after that sync. File syncing and exclusive journal creation are not proof of
directory-entry durability across power loss; power-loss recovery remains
unqualified. Do not copy a plan to bypass its existing journal.

Keep plan/journal files private. They contain target identities and multipart
descriptors, but the runner never writes credentials or raw provider errors.
Leave the synthetic object until its evidence has been reviewed; cleanup is a
separate, explicitly scoped operator action.
