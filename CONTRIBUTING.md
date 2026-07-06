# Contributing

CardListCompare is a small, fast-moving project maintained primarily by one
developer plus AI coding agents. There is no PR ceremony, but there are hard
rules — they live in [CLAUDE.md](CLAUDE.md) and are enforced by the test suite.

## Setup

```bash
npm install
cd server && npm install && cd ..

# Two terminals:
npm run dev              # frontend — Vite on :5173, proxies /api to :3001
cd server && npm run dev # backend — Express on :3001
```

Node 22+. Admin promotion runs at backend startup: register the first user,
then restart the backend once to get admin access.

## Before you change anything

1. Read [CLAUDE.md](CLAUDE.md) — commands, invariants, delivery protocol.
2. Read [docs/INVARIANTS.md](docs/INVARIANTS.md) if you're touching parsing,
   diffing, enrichment, the database layer, or the Dockerfile.
3. `npm test` must be green before and after your change. The suite includes
   invariant-sync tests that enforce cross-file couplings — if one fails, fix
   the coupling it guards; do not delete the test.

Humans and AI agents follow the same delivery protocol and doc-sync triggers
described in CLAUDE.md. CI blocks the Docker publish on red tests.
