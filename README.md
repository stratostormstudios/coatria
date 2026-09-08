# Coatria

A shared workplace for people and their AI coworkers: a low-poly office, real accounts and company membership, room conversations, reviewed contributions and a private personal skill vault.

This is the functional application built with Next.js, React and PostgreSQL. The office uses local Three.js assets and a curated rigged character. The repository is [stratostormstudios/coatria](https://github.com/stratostormstudios/coatria); deployment targets the **coatria** project on the Coatria Vercel team.

**The first release is deployed at [coatria.com](https://coatria.com), with account creation gated until database setup is complete.** The public page, HTTPS routing and assets have been verified. Neon database provisioning awaits the account holder's [terms acceptance](https://vercel.com/coatria/~/integrations/accept-terms/neon?source=cli). Git-triggered deployment additionally awaits the Vercel account's GitHub connection. See [release status](docs/RELEASE_STATUS.md) for the exact boundary between working code and configured services.

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

Create an account and a company, then copy an invitation link to a second test account. There are no seeded coworkers, active bots, messages or completed tasks. The first account becomes the company owner. Invitations do not send email.

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

For database integration, supply `COATRIA_INTEGRATION_DATABASE_URL` and `DATABASE_URL` for the same dedicated local test PostgreSQL database, apply migrations, and run `npm run test:integration`. The CI workflow provisions PostgreSQL 17 for these checks. It does not prove production capacity or provider configuration.

The opt-in media harness mounts the actual call component and signaling handlers, creates disposable test records, and uses synthetic media between two isolated browsers. It tests real RTP delivery, screen cleanup, a pending-picker room-change race, revocation and the authorization watchdog. It never needs your microphone or screen:

```sh
npx playwright install chromium
npm run test:media
```

This command requires a dedicated **local** test `DATABASE_URL`. Alternatively, set `COATRIA_TEST_EMULATOR=1` before the command to create a fresh in-memory PGlite instance with one connection. The emulator is a development convenience; it is not the production database or evidence of PostgreSQL concurrency under load. A locally installed browser can be selected with `COATRIA_BROWSER_PATH`. See the [validation details](docs/RELEASE_STATUS.md#validation-evidence) for what has actually been run.

## Deploy on Vercel

1. Complete the database provider setup and connect a dedicated production database to the Coatria project.
2. Configure `DATABASE_URL` and canonical `APP_URL=https://coatria.com` in the appropriate Vercel environment. Keep preview and production data separate.
3. Apply the repository migrations with the intended database credentials before enabling the app. Do not run migrations during every application request.
4. Deploy the source. A direct Vercel deployment is independent of the GitHub connection; automatic Git deployments require that connection to be completed.
5. Check `/api/health`, then verify signup, invitation, cross-account collaboration and access revocation on the deployed URL. Verify domain routing and HTTPS separately.

Keep all API credentials in ignored local environment files or Vercel environment settings. Never commit provider tokens or database URLs. The secret scan catches common credential patterns; it is not a guarantee that every possible secret format is detected.

The [implementation plan](docs/IMPLEMENTATION_PLAN.md) covers the remaining ownership, infrastructure, commercial and scaling phases. Production capability should be claimed only after the corresponding implementation and deployment checks pass.
