# Company hosted-service activation

Company runtime selections replace repeated environment changes and application deployments. Installing a selection does **not** approve spending, start a Pod, or certify that a service is healthy. Existing plan, approval, lifetime reservation, provider identity, reconciliation and stop controls still apply.

## Deployment order

1. Apply migrations 036–038 as the database administrator, then the reviewed application and storage-gateway permission scripts. The archive worker receives no executor-vault or platform-operator grants. Keep paid compute stopped during this transition.
2. Deploy the matching application release. Health now requires schema 038. The API catalog is version 1.16.0.
3. Compile and publish a new immutable gateway bundle and bootstrap from the reviewed source commit. It requires schema 037, `COATRIA_SERVICE_PROVISION_ID`, the signed identity endpoint, and gateway grant epochs. Do not overwrite or run frozen b205 gateway bytes with the new permission contract. Existing provision identity remains available for cleanup.
4. A database administrator grants a named human a short, finite `company_runtime:configure` platform grant. Company ownership alone cannot mint this authority. The operator must also currently administer the target company.
5. Use `/api/operator/companies/{companyId}/runtime-configurations/{kind}` to select the exact reviewed nonsecret preset, hash, revision and fixed deadline. Managed agents use a company-specific state volume. Project-scoped archive/gateway presets can be selected after the agent creates the project; this needs no deployment.
6. Install the short-lived executor credential through the write-only operator endpoint described below. Review the service plan and approve bounded charges separately. Start and reconcile each provision through the existing service APIs.
7. Once the gateway is running, POST its provision ID and expected prior binding ID to `/api/companies/{companyId}/studio/projects/{projectId}/gateway`. A signed nonce challenge must prove the exact company, project scope, provision, configuration, source and deadline. No caller-supplied URL is accepted.
8. Reload the Coatria page after a new gateway binding. Its CSP includes only exact gateway origins currently accessible to the signed-in member or external delivery recipient. The browser transfers bytes directly to the gateway.

## Short-lived executor credential

`GET` and `POST /api/operator/companies/{companyId}/runtime-configurations/archive/{configurationId}/executor-credentials` read metadata or install a token. POST accepts `clientId`, `expectedCredentialId` (null on first install) and `token`. Send it only through an authenticated private HTTPS form/request. Never put it in a preset, repository, query string, chat message or deployment log. It is encrypted with a purpose/company/configuration/credential/deadline-bound AES-GCM envelope and is never returned by these APIs.

The credential must be a Vercel OIDC JWT with an RSA signature verified against Vercel's fixed issuer JWKS, the exact reviewed team/project and a lifetime covering the service deadline plus one minute. The implementation follows [Vercel's verification documentation](https://vercel.com/docs/oidc/api) and [claim reference](https://vercel.com/docs/oidc/reference). This endpoint does not accept a broad Vercel personal API token. Credential replacement is forbidden while archive compute is active or uncertain. DELETE the exact `.../executor-credentials/{credentialId}` to revoke it; retain the metadata as audit history.

Revocation disables new work and requests reconciled shutdown. It does not claim that a remote process was killed, provider billing ended, or previously sent credentials vanished. Verify terminal provider state before concluding cleanup. A live archive is enabled only for its reviewed project scope, service phase, current runtime selection, matching installed executor hash, recent provider observation and finite deadline. New archive approvals cannot extend past that deadline.

## Routing and revocation

Member and external-client grants include the immutable gateway binding epoch and provision ID. The gateway checks current membership/share authority, runtime selection and service state before transfers and during streaming. Stopping, revoking, replacing or expiring the service/binding denies old grants. A durable runtime selection or historical managed binding permanently disables automatic legacy-environment fallback for that scope.

The 120-second provider-observation freshness window is a fail-closed availability check. It is not a provider spending cap. Keep bounded reconciliation running; stalled reconciliation deliberately disables transfers. Global `COATRIA_HIGGSFIELD_ARCHIVE_ENABLED=false` remains an emergency switch for new archive approvals. Existing per-request revocation and stored-identity service cleanup remain available.

## Validation boundary

Offline tests cover exact API contracts, signature/key limits, encrypted credential isolation, idempotency, expiry, grant revocation, configuration replacement, provider-response uncertainty, signed gateway identity, grant expiry clamping and full member/client byte-transfer rejection after revocation. PostgreSQL-specific concurrency and privilege tests run in CI; PGlite success does not substitute for them. A source release, green CI and an authenticated connection still do not constitute a completed live generation-to-client-delivery pilot.
