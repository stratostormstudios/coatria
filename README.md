# Coatria

A shared workplace for people and their AI coworkers: a low-poly office, real accounts and company membership, room conversations, reviewed contributions and a private personal skill vault.

This is the functional application built with Next.js, React and PostgreSQL. The office uses local Three.js assets and a curated rigged character. The repository is [stratostormstudios/coatria](https://github.com/stratostormstudios/coatria); deployment targets the **coatria** project on the Coatria Vercel team.

**The 8 September 2026 security update is deployed at [coatria.com](https://coatria.com).** PostgreSQL CI passed all 38 tests; 39 live API checks and 16 production browser checks passed using the restricted database connection. Migration 004, production-only Secret configuration and test-fixture cleanup are verified. Source fixes and remaining gates are recorded in the [security review](docs/SECURITY_REVIEW.md); [release status](docs/RELEASE_STATUS.md) separates this update from historical first-release evidence.

## Run locally

Use Node.js 22 or later and a dedicated PostgreSQL database. Install dependencies with the committed lockfile:

```sh
npm ci
```

Copy `.env.example` to `.env.local`, then replace its placeholder `DATABASE_URL` with the connection string for your development database. Keep `APP_URL=http://localhost:4180` for local use. Run:

```sh
npm run db:migrate:local
npm run dev
```

Open [localhost:4180](http://localhost:4180). The local migration command explicitly loads `.env.local`; `npm run db:migrate` instead uses environment variables already supplied by a deployment or CI system. The web app loads `.env.local` through Next.js.

Create an account and a company, then copy an invitation link directly to a second test account. There are no seeded coworkers, active bots, messages or completed tasks. The first account becomes the company owner. Signup does not verify email ownership; email-restricted invitations require verified accounts and are unavailable through the current public signup flow. Ordinary invitations are single-use bearer links. Invitations do not send email. Hiring acceptance binds its invitation to the reviewed account.

Without `DATABASE_URL`, the app shows setup status and does not accept account creation. [The health endpoint](http://localhost:4180/api/health) returns HTTP 503 until the database responds and required migrations are recorded. It returns HTTP 200 with `{"status":"ready","configured":true}` when those checks pass.

## What this release does

- Creates accounts, company memberships, expiring invitations, roles and ownership transfers.
- Renders the saved office layout and actual recent presence, with movement, graphics controls and an accessible rooms list.
- Supports persistent company/room chat, tasks, submissions and independent administrator acceptance.
- Provides small-room WebRTC audio and browser-consented screen sharing. Calls stop capture on leave or lost authorization.
- Keeps personal skills and versioned exports separate from company membership.
- Connects external agent harnesses through scoped work/report APIs; the harness executes on its owner's infrastructure.
- Indexes metadata from an approved company folder through an outbound connector, without uploading originals.
- Publishes openings, accepts applications and issues an invitation after candidate acceptance. It does not process payments.

Calls support the lower of the room capacity and six participants. Direct WebRTC may fail on restrictive networks; production relay configuration and validation are still needed. Presence uses small-team polling, not a tested global realtime service. See [connection instructions](docs/CONNECTIONS.md) for adapters and media configuration.

## Validation

```sh
npm run check:secrets
npm run typecheck
npm test
npm run build
```

The test suite contains input/session checks, database-readiness behavior, connector boundaries, and opt-in database integration tests. Database tests can be skipped when their environment is absent; inspect the test output rather than treating a skipped test as validation.

For database integration, supply `COATRIA_INTEGRATION_DATABASE_URL` and `DATABASE_URL` for the same dedicated local test PostgreSQL database, apply migrations, and run `npm test`. The runtime-privilege test needs a test administrator that can create a disposable role. `npm run test:integration` runs the narrower baseline API/signaling subset. The CI workflow provisions PostgreSQL 17; it does not prove production capacity or provider configuration.

The opt-in media harness mounts the actual call component and signaling handlers, creates disposable test records, and uses synthetic media between two isolated browsers. It tests real RTP delivery, screen cleanup, a pending-picker room-change race, revocation and the authorization watchdog. It never needs your microphone or screen:

```sh
npx playwright install chromium
npm run test:media
```

This command requires a dedicated **local** test `DATABASE_URL`. Alternatively, set `COATRIA_TEST_EMULATOR=1` before the command to create a fresh in-memory PGlite instance with one connection. The emulator is a development convenience; it is not the production database or evidence of PostgreSQL concurrency under load. A locally installed browser can be selected with `COATRIA_BROWSER_PATH`. See the [validation details](docs/RELEASE_STATUS.md#validation-evidence) for what has actually been run.

## Deploy on Vercel

1. Preserve the existing Neon production resource and keep preview/development data separate. Apply all four numbered migrations using a direct owner connection obtained from the Neon dashboard and supplied only to the migration process as `DATABASE_URL`. `npm run db:migrate` uses that process environment; the app runtime must not receive the owner connection.
2. **First-time setup only:** after migrations, an operator creates `coatria_runtime_v1` with [the provisioning helper](scripts/provision-runtime-role.mjs) and verifies its effective grants. Production already has this role. The helper accepts owner credentials and a new random password through JSON stdin and refuses an existing role. Do not repeat provisioning on routine releases; apply any updated explicit [runtime grants](database/runtime-permissions.sql) with the owner after future migrations, then recheck allowed/denied privileges. Builds never invoke provisioning.
3. Detach integration environment injection from the Vercel project while preserving the Neon resource. Remove owner-credential aliases, then manually configure the runtime connection as a production-only Secret `DATABASE_URL`, with canonical `APP_URL=https://coatria.com`. Future migrations use a separate owner process, not a deployed owner alias.
4. Require a passing CI result for the intended source and deploy it. Automatic Git deployments require the Vercel GitHub connection; direct deployment must record its exact source and deployment ID. Main-branch protection is an open administrator action in the security review.
5. Check `/api/health`, signup/login, invitation restrictions, collaboration, private skills, independent reviews, account switching, media cleanup and access revocation on the deployed URL. Verify domain routing and HTTPS separately. Complete credential rotation and the historical-deployment inventory; changing environment values does not remove old deployment credentials.

Keep API credentials in approved local secret storage or scoped Vercel Secret settings. Never commit provider tokens or database URLs. Vercel and Meshy credentials shared in the project conversation require rotation. The secret scan catches common credential patterns; it is not a guarantee that every possible secret format is detected.

Tenant and vault isolation are enforced by application authorization, not per-tenant database RLS. Email verification delivery, forgotten-password recovery, MFA and SSO remain unimplemented. Review the [open security gates](docs/SECURITY_REVIEW.md#open-release-gates-and-operational-work) before admitting sensitive company data or expanding beyond the initial release.

The [implementation plan](docs/IMPLEMENTATION_PLAN.md) covers the remaining ownership, infrastructure, commercial and scaling phases. Production capability should be claimed only after the corresponding implementation and deployment checks pass.
