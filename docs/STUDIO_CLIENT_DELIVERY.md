# Authenticated client delivery

Coatria can grant a designated external client account private access to the exact files in an independently approved delivery package. The client can download the canonical package manifest, request short-lived links to individual files, and record an acknowledgement or change request. These are separate events: creating an invitation does not send it, opening the portal is not a media transfer, and issuing a download link does not prove that bytes reached the client.

## Operator and client flow

1. The client signs in or creates a personal account at `/delivery`. They do not create or join a company. The page displays their own account ID.
2. The studio confirms that exact ID directly with its intended client through an existing trusted communication channel. Email verification delivery is not currently enabled. The system records the administrator’s out-of-band confirmation and actual email verification flag; it does not verify legal identity or accept a display name/email address as proof.
3. The studio completes production and independent technical, creative and delivery-handoff review, then prepares an exact package. All linked tasks must be accepted before client access is issued. A reference URL without stored, verified media is insufficient.
4. An administrator opens **Client delivery portal**, selects a prepared package, enters the confirmed account ID, chooses an expiry within 30 days and reviews the invitation. The resulting `/delivery/{shareId}` link is copyable. Coatria sends no email or other message automatically.
5. Only the designated account can open that link. Any account with a membership history in the studio, or one that prepared, produced or sponsored the package, is ineligible as its external client. Different clients, company administrators and agent bearer credentials cannot impersonate the recipient.
6. The client reads the package, obtains individual file links, and explicitly acknowledges it or requests changes. An acknowledgement rechecks current approved versions, production authorization and accepted tasks before marking only the chosen package acknowledged and the project delivered. The client’s user ID, exact package hash and immutable receipt ID appear in gate provenance. A change request preserves versions and returns the project to review; follow-up work and spending still need their normal authorization.

## Evidence and lifecycle

| Record | What it establishes | What it does not establish |
| --- | --- | --- |
| Account-bound invitation | An administrator authorized one confirmed account for one immutable package | Invitation sent, legal identity verified, files transferred |
| `portal_opened` | The designated account made an authenticated portal-open request | Media inspected or downloaded |
| `download_access_issued` | Coatria issued a short-lived read URL for an exact granted file | Browser opened the URL, all bytes arrived, or client accepted work |
| `acknowledged` | The designated authenticated account explicitly acknowledged this exact package | Independent proof of download completion or contractual/legal acceptance beyond the recorded attestation |
| `changes_requested` | The client recorded requested changes against the exact package | Revised scope agreed or production/compute automatically authorized |

The original prepared delivery manifest remains immutable, including its historical `transportStatus: not_transferred`. Client access and response receipts describe subsequent events separately. `sourceManifestSha256` identifies the original internal manifest. `packageSha256` hashes the canonical client-visible snapshot, which exposes only the project/delivery information, approved artifact identities and granted file metadata. The client manifest download returns these exact canonical bytes and `X-Content-SHA256`.

Each read URL expires within 60 seconds and never outlives the invitation. Revocation, expiry, the issuer losing administrator authority or the recipient joining the company prevents new portal/file access. Already issued URLs can remain valid until their short expiry, and previously downloaded files cannot be recalled. URLs are never stored in durable request receipts, manifests or application logs. Provider signing happens outside a database transaction, followed by a fresh grant check before the URL is returned.

One immutable client response is allowed per invitation. Retries reuse `clientId` and identical request data; a changed body with the same ID fails. Current authentication and grant authority are checked before replay. Repeated file-access calls using one request ID can refresh the URL but retain one logical access receipt. Revocation preserves all historical receipts.

## Current implementation boundaries

- The first transport supports the existing server-verified private image-sequence promotions, up to 2,400 files per package and 20 MiB per file. Native scenes, arbitrary external URLs, archives, large-footage transfer, resumable bulk downloads and external transfer-provider receipts are not implemented by this portal.
- Frame SHA-256 and byte-size verification comes from the existing private-media service. Actual visual/creative acceptance remains an independent review responsibility. The portal itself does not decode EXR images or inspect every frame.
- A client account is authenticated; the administrator’s out-of-band identity confirmation is an attestation. Multi-factor authentication and automated email verification are not added by this feature.
- An invitation’s signature-free UUID is only a locator. There is no anonymous bearer-link mode, automatic invitation dispatch or owner-created synthetic acknowledgement in production.
- `studio.read` agents may inspect invitation/receipt metadata through `studio_client_deliveries_list`; grant issuance, revocation and client responses are never agent actions. Temporary private URLs must not be passed to a model.
- The pilot bounds invitations to 100 per project and access/open receipts to 5,000 per invitation. Final client responses and revocation remain available independently of the access-receipt ceiling. Beyond these bounds, provide measured pagination/transport capacity work rather than claiming general high-volume media delivery.

## API and deployment

`studioClientDeliveryRoute` is registered in the shared API dispatcher. Typed request schemas live in `studio-client-delivery-protocol.ts`; complete OpenAPI paths/schemas are exported from `studio-client-delivery-openapi.ts`.

- Company: `GET/POST /api/companies/{companyId}/studio/projects/{projectId}/client-deliveries`, `POST .../{shareId}/revoke`.
- Client: `GET /api/client-deliveries/identity`, `GET /api/client-deliveries/{shareId}`, `GET .../manifest`, `POST .../open`, `POST .../files/{fileId}/access`, `POST .../responses`.

Apply migration 020 and the matching runtime permission update before publishing. Grant `SELECT,INSERT` on the four new tables, with `UPDATE(status,revision,revoked_at)` only on `studio_client_deliveries`. Private files, snapshots, receipts and request records remain insert-only. Existing approved task, project/gate and delivery permissions are reused. Do not grant update privilege on immutable media tables merely to satisfy row locks; they are read without row locks.

## Verification evidence

`tests/studio-client-delivery.test.ts` exercises real service/API functions against an isolated database: exact external-account authorization, unverified email honesty, independent handoff prerequisites, verified-media requirements, two immutable package hashes, cross-file isolation, private URL lifecycle, revocation during signing, expiry, membership/sponsor changes, stale state, idempotency, exact-package acknowledgement and change-request provenance. It also verifies whole-company cleanup without allowing individual published artifact deletion.

The optional `COATRIA_CLIENT_DELIVERY_BROWSER=1` test runs actual React and Chromium against the same local API, including administrator review/create, an external account with no company onboarding, wrong-account denial, download-access issuance, change request, reload, revocation and mobile overflow. Its records and media are explicitly synthetic. It makes no cloud/provider mutations and does not establish that a real client accepted or received a production package. A separate real-PostgreSQL concurrency check verifies duplicate response fencing; it is explicitly skipped by PGlite.

To run the local fixture: `COATRIA_TEST_EMULATOR=1` plus optional `COATRIA_CLIENT_DELIVERY_BROWSER=1`, then `node --import tsx --test tests/studio-client-delivery.test.ts`. Browser screenshots and evidence are written under `.devdata/client-delivery-browser/`, outside the published repository artifacts.
