# Project review — 2026-09-08

Reviewed the clean checkout against fetched `origin/main` at `f44958b` (v2.42.1).
Maintenance work is on `codex/project-audit-print-workflow`, versioned v2.42.2.
This review covers code, documentation, automated checks and a local Docker smoke test;
it does not certify every live third-party integration or physical printer output.

## Current product

CLC is a React 19/Vite 7 application with an Express 5 API, an in-memory sql.js database
persisted atomically to disk, and nginx/Docker deployment. It compares imported deck text,
tracks Archidekt decks with snapshots and paper baselines, provides deck/price analytics,
collection matching, sharing, notifications and household account administration.

Proxy preparation currently searches MPC artwork and exports XML/image ZIPs, or queues
Scryfall image ZIPs with caching. PDF composition and physical printing are not implemented.
The next-feature proposal is [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md), with drying tracking
excluded at the owner's request.

## Maintenance corrections

| Area | Correction |
| --- | --- |
| Commander input | Blank-separated mainboard groups no longer become an implicit sideboard when a Commander header exists; explicit sideboards still work |
| Artwork | Searches retain saved choices, including DFC backs; initial loads cannot overwrite newer edits and replacement writes are serialized |
| Reset Art | An intentionally empty saved selection is distinct from never-configured art, preventing a stale local cache from restoring reset choices |
| Snapshot selection | Timestamp ties are broken by ID consistently in lists, comparison, exports, overlap, notifications, prices and pruning |
| Paper baseline | A zero lock limit correctly means unlimited for automatic paper-snapshot locking |
| Image ZIPs | Expiry comparisons handle both ISO and SQLite UTC timestamps; job URLs must match their deck |
| Price alerts | Remove sends an explicit empty value instead of the previous input value |
| Docker builds | Nested dependency directories/environment files are excluded; the image defaults to the writable `/app/data` database path |
| Dependencies | Compatible lockfile updates remediate all advisories reported in both trees during this review |

Documentation now explains actual first-admin startup behavior, development secret
persistence and environment loading, required lint/tests, atomic backups, collection and
notification behavior, supported import handlers, and current image-export limitations.
README, Guide, contributor/convention docs, security model, operations, roadmap and the
local release checklist were checked together.

## Verification

Before changes: **340 tests passed**, frontend production build succeeded, ESLint reported
**0 errors / 10 warnings**. Dependency audits reported **12 affected packages in the root
tree** and **one in the server tree**; these were dependency findings, not proof of deployed
exploitability.

Regression tests reproduce Commander parsing failures, artwork synchronization/reset races,
same-second snapshot selection under an alternate query plan, zero-limit paper locking,
ZIP expiration/reuse/cleanup and deck-scoped download lookup. Tests use temporary databases
and a loopback HTTP server; they do not touch household data or image services.

The updated locks install with the normal Node 22/npm 10 environment using `npm ci` in both
trees. Final checks: **362 tests across 21 files pass**, Vite production build succeeds,
ESLint reports **0 errors / 9 warnings**, and both dependency audits report **zero
vulnerabilities**. The remaining lint warnings are recorded debt, not new errors.

The `linux/amd64` Docker image builds and starts with only a generated JWT secret, using its
default `/app/data/cardlistcompare.db`. Health and frontend responses return HTTP 200 with
the expected CSP. Browser smoke checks verify Commander additions remain in mainboard and
the refreshed Guide opens without console errors. Graceful container shutdown flushes the
database and exits successfully. The smoke container used fresh disposable data and was
removed afterward; no household deployment or printer queue was touched.

## Remaining work

[ROADMAP.md](ROADMAP.md) lists the unresolved printing-identity and DFC comparison cases,
partial image-download results/progress, MPC copy/back export limitations, concurrent
multi-device art edits, comparison-link revocation, invite expiry UI and live import checks.
The in-app guide and README no longer promise those cases work universally.

The print feature should use a dedicated physical-copy planner with immutable source/target
versions and artwork, rather than equating a display diff or completed ZIP with a complete
print job. Color profiles can be portable while application/driver recipes still require
validation; the proposal records the primary sources and concrete implementation stages.
