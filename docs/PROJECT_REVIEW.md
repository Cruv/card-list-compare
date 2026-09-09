# Project review — 2026-09-08

Reviewed the clean checkout against fetched `origin/main` at `f44958b` (v2.42.1).
The initial maintenance pass was versioned v2.42.2 on
`codex/project-audit-print-workflow`. Its verification below is historical; the follow-up
v2.43.0 completeness and collection-removal milestone has its own verification section.
This review covers code, documentation, automated checks and a local Docker smoke test;
it does not certify every live third-party integration or physical printer output.

## Current product

CLC is a React 19/Vite 7 application with an Express 5 API, an in-memory sql.js database
persisted atomically to disk, and nginx/Docker deployment. It compares imported deck text,
tracks Archidekt decks with snapshots and paper baselines, and provides deck/price analytics,
sharing, notifications and household account administration. Native collection management
has been removed at the owner's request; the planned ManaSync companion owns inventory.

Proxy preparation currently searches MPC artwork and exports XML/image ZIPs, or queues
Scryfall image ZIPs with caching. Household PDF composition, immutable jobs and the native
Mac station protocol shipped in v2.44.0, with the native Mac companion in v2.44.1. Verification is separate from
the pending physical color/cutter/duplex proof. See [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md).
Drying tracking remains excluded at the owner's request.

## Initial v2.42.2 maintenance corrections (historical)

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

The initial documentation pass explained actual first-admin startup behavior, development
secret persistence and environment loading, required lint/tests, atomic backups, the then-current
collection and notification behavior, supported import handlers, and image-export limitations.
README, Guide, contributor/convention docs, security model, operations, roadmap and the
local release checklist were checked together.

## Initial v2.42.2 verification (historical)

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

## v2.43.0: completeness before home printing

The owner requested completeness first, then printing, and assigned collection management
exclusively to ManaSync. This milestone implements those CLC prerequisites:

| Area | Current change |
| --- | --- |
| Printing identity | Canonical keys preserve card name, set, collector number and foil status; identical collector numbers in different sets and foil/nonfoil copies remain distinct |
| DFC aliases | Bare full names and printing-qualified front-face names reconcile through normalized card names |
| Display lookups | Exact printing artwork/prices use canonical keys and do not silently fall back to generic printing data; budget estimates remain a separate bare-name lookup |
| Scryfall completeness | Missing cards, missing required faces, invalid image data and failed downloads prevent ZIP completion and expose failure details |
| Image counts | Progress counts physical image files consistently, including repeated copies and both DFC faces; paired files share a copy index |
| Existing ZIP jobs | Legacy artifacts without completeness checks require regeneration rather than reuse as verified results |
| Native collections | Collection UI, ownership badges, client API, backend routes and collection-only helpers/tests are removed; deck overlap remains |
| Legacy data | Existing `collection_cards` schema/rows remain in database backups; no transfer to ManaSync is implemented |

The documentation and Guide distinguish these changes from the remaining MPC export and
home-printing work. [DECISIONS.md](DECISIONS.md) D8 supersedes native CLC collection matching;
[MANASYNC_INTEGRATION.md](MANASYNC_INTEGRATION.md) preserves the integration boundary and
open companion contract.

Final checks: **413 tests across 23 files pass**, ESLint reports **0 errors / 7 existing
warnings**, production frontend and `linux/amd64` Docker builds pass, and both dependency
audits report **zero vulnerabilities**. Regression coverage includes exact/alias printing
matching, copy/face completeness, corrupted image data, byte/copy budgets, failed-job cache
cleanup and atomic ZIP publication. JPEG validation checks structure rather than decoding
every pixel; actual PDF generation must still decode and verify source images.

Live Scryfall checks resolve exact Lightning Bolt artwork, unaccented Nazgul, a full-name
Malakir DFC, a five-part split card and case-normalized PLST collector numbers. Real PNG
front/back and JPEG downloads pass the stricter image checks. Client lookups preserve the
DFC land-back flag and keep generic requests separate from constrained printing requests.

The final disposable Docker container returns healthy API/frontend responses; removed
collection routes return 404 and deck overlap remains authentication-protected. Browser
checks confirm printing/foil changes, accent and full/front DFC equivalence, logical-card
summary counts, and the refreshed Guide, without browser warnings/errors. SIGTERM reaches
the backend and flushes its database. The temporary container and browser tab were removed;
no household data, deployment or printer queue was changed.

A separate temporary Alpine/Python proof ran the actual latest Silhouette Card Maker source
with the owner's 600 PPI recipe, including fronts-only and DFC-only PDFs and offline
installation from cached wheels. This validates feasibility, not an integrated CLC PDF
feature. [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md) records the supplied Adobe/
Epson settings and sample reference; [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) records the
remaining integration work.

## v2.44.0: household PDFs and station protocol

CLC now freezes a full snapshot or physical positive delta into a reviewed print plan,
acquires every required face, and invokes the real Silhouette Card Maker v6 code. Ordinary
fronts and paired DFC pages are separate downloadable artifacts. Saved MPC selections can
be frozen from the artwork overlay. Default MPC searches now expand current source/language
metadata rather than accidentally asking the upstream service for no sources or languages.

The bind-mounted runtime updates from upstream main and retains a validated compatible
installation on failed updates. ARM64 and AMD64 container checks generated real PDFs and
restarted successfully without network access. Cached wheels also rebuilt a removed test
environment offline. A 100-card stress fixture generated 15 pages / 881.5 MiB under a 2 GiB
container memory limit; bounded merging and sequential source staging prevent keeping the
whole high-resolution deck in memory. Limits fail the job before partial publication.

Browser checks confirmed the paper baseline's eight-copy delta, the eleven-copy full deck
with optional sideboard, separate PDF artifacts and missing-artwork feedback. The station
API uses durable claims, submission events and explicit refeed/reconciliation states.
Tests cover ownership, stale plans, cancellation, artifact integrity, retention, interrupted
submissions, failed persistence and recovery. Validation: **486 tests passed**, zero lint
errors (seven existing warnings), successful production/container builds and zero findings
in both dependency audits. Native Mac delivery follows as a separate stage. Physical color,
duplex alignment and cutter proof remain household setup work.

## v2.44.1: native Mac companion

The companion uses native Mac printing with locally selected Epson options, verified PDF
streaming, private SQLite receipts and a durable submission/reconciliation protocol. It
provides read-only setup checks, a local dry run, pause/status/refeed controls and optional
LaunchAgent generation. Physical operation requires an accepted recipe; DFC proof is a
separate flag. Both flags default off.

All **32 companion tests pass on macOS/Python 3.9**. Linux runs 31 tests successfully and
skips the native `ipptool` fixture when that command is unavailable. CI runs the portable
suite before image publication. The native parser test uses a disposable loopback IPP
fixture, not the household spooler.

A separate end-to-end test used actual CLC HTTP jobs and generated PDF artifacts with an
injected fake CUPS implementation: eight copies, two PDFs, three pages and 40,085,052
verified bytes. Exactly three fake submissions covered ordinary fronts, DFC fronts and
manually resumed backs. An acceptance timeout, unknown history and a lost DFC completion
acknowledgement recovered safely. Repeated final polls stayed idle without duplicate
submissions. The harness rejected any actual printer command. No driver, household queue,
LaunchAgent or deployment was installed or changed during this review.

## Remaining work

[ROADMAP.md](ROADMAP.md) retains the MPC copy/back export limitations, concurrent multi-device
art edits, comparison-link revocation, invite expiry UI and live import checks. Inventory
features belong in ManaSync; CLC will consume an agreed API instead of rebuilding collections.

[PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) records the native Mac delivery and physical printer/
cutter proof. CLC does not claim a color match from software tests alone. Drying tracking
remains excluded.
