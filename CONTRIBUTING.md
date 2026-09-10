# Contributing

CardListCompare is a small, fast-moving project maintained primarily by one
developer plus AI coding agents. There is no PR ceremony, but there are hard
rules — they live in [CLAUDE.md](CLAUDE.md) and are enforced by the test suite.

## Setup

```bash
npm ci
npm --prefix server ci

# Two terminals:
npm run dev              # frontend — Vite on :5173, proxies /api to :3001
cd server && npm run dev # backend — Express on :3001
```

Node 22+. Admin promotion runs at backend startup: register the first user,
then restart the backend once and reload or sign in again to get admin access.
The development database defaults to `server/data/cardlistcompare.db`.

With `JWT_SECRET` unset outside production, a random development signing secret
is saved beside the database as `.jwt-dev-secret`. An explicitly supplied weak
secret is rejected. Production requires a strong configured secret. The npm
scripts do not load `.env`; export settings in the backend shell, or copy and
configure `.env.example` and run `node --env-file=.env --watch server/index.js`
from the repository root. Keep all real secrets and data out of commits.

## Before you change anything

1. Read [CLAUDE.md](CLAUDE.md) — commands, invariants, delivery protocol.
2. Read [docs/INVARIANTS.md](docs/INVARIANTS.md) if you're touching parsing,
   diffing, enrichment, the database layer, or the Dockerfile.
3. Read [docs/DECISIONS.md](docs/DECISIONS.md) before changing an established approach.
4. `npm test` must be green before and after your change. The suite includes
   invariant-sync tests that enforce cross-file couplings — if one fails, fix
   the coupling it guards; do not delete the test.

Humans and AI agents follow the same delivery protocol and doc-sync triggers
described in CLAUDE.md. Verify with `npm test`, `npm run lint`, and
`npm run build`. Tests cover client/server logic and cross-file invariants;
they are not a substitute for exercising the changed UI or a Docker smoke test
when deployment changes. ESLint errors block CI; warnings remain visible and
are allowed. Run `npm audit` and `npm --prefix server audit` for release checks.

CI runs tests and lint for pull requests and main/tag pushes, then builds the
Docker image. It publishes to GHCR on main/tag pushes; pull requests only build.
The native PDF/Mac print workflow and explicit ManaSync inventory confirmation
are documented in [docs/PRINT_WORKFLOW.md](docs/PRINT_WORKFLOW.md).
