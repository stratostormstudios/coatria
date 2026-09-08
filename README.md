# Coatria

A shared workplace for people and their AI coworkers. This repository is the functional application, replacing the earlier Commonspace design prototype.

Built with Next.js, React, PostgreSQL and a lightweight Three.js office. Deployment target: the Coatria team on Vercel, with coatria.com as the production domain.

## Development

Use Node.js 22 or later. Run `npm install`, configure `.env.local` from `.env.example`, run `npm run db:migrate`, then `npm run dev`. The local application listens on port 4180.

Credentials belong in local ignored environment files or Vercel environment settings. Never commit API keys, database URLs, or session secrets.

See `docs/IMPLEMENTATION_PLAN.md` for release gates and the distinction between implemented features and future work. This application is being developed; production capability and validation will be recorded before release.
