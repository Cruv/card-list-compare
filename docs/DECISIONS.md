# CardListCompare — decision log

> The load-bearing "why"s. Each entry: what was decided, why, what it costs, and where it
> lives in code. These are **standing decisions** — revisit deliberately (talk to the
> owner), don't erode them incidentally. One flat file on purpose: searchable in one place.
> Mirrors the sibling app WarSlate's `docs/decisions.md` format so both repos read alike.

## D1 — sql.js for persistence (not better-sqlite3)

**Decision.** The database is **sql.js** (SQLite compiled to WASM, held fully in memory),
persisted to a single file. Not better-sqlite3, not a native module.
**Why.** Zero native build step — the image is a plain `node:22-alpine` with no compiler
toolchain, and the DB is one portable file that bind-mounts to the host for trivial backup.
**Cost.** Every write serializes the **entire** database to disk (`persist()` after each
`run()`), so there are no partial writes and no cross-statement transactions. The whole-file
rewrite is the accepted cost; it is made crash-safe by an atomic temp+fsync+rename with
`.bak` recovery (v2.40.3). See INVARIANTS.md #1 — the most dangerous code in the repo.
**Where.** `server/db.js` (`persist`, `loadDatabase`, `backupDb`, `run`); pinned by
`server/db.persist.test.js`.

## D2 — Deck text is the product's data contract

**Decision.** Decks are stored and exchanged as **plain text with embedded printing
metadata** (`4 Lightning Bolt (m10) [146] *F*`), not a structured schema. The card-line
grammar is single-sourced in `src/lib/constants.js` (`CARD_LINE_PATTERN`).
**Why.** It round-trips through every external source (Archidekt/Moxfield/paste), is
human-editable, diffable, and needs no migration when a field is added.
**Cost.** All correctness lives in one regex and the parser/differ around it; two past forks
of the regex corrupted data. Format spec: `docs/DECK_TEXT_FORMAT.md`; enforced by
`src/lib/invariants.test.js`.

## D3 — Express + a small dependency set (a deliberate divergence from WarSlate)

**Decision.** The server uses **Express 5** with a curated dependency set (helmet,
express-rate-limit, jsonwebtoken, bcryptjs, nodemailer, archiver, compression, sql.js).
This diverges from WarSlate's zero-dependency-server rule (WarSlate D1).
**Why.** This app started from the Express ecosystem and sql.js is itself load-bearing;
rewriting to Node built-ins would be a large, low-reward migration. The trade is accepted.
**Cost.** Supply-chain surface. Mitigations that this decision REQUIRES: `npm audit` is part
of the release check, dependency bumps are lockfile-only, and a **new server dependency needs
explicit justification** (prefer a Node built-in — e.g. `node:crypto` did the token hashing
in D7, `node:zlib`/compression, `archiver` only where a real zip is needed).
**Where.** `server/package.json`. Revisit only if supply-chain cost outweighs convenience.

## D4 — Version authority is APP_VERSION in code, not git tags

**Decision.** The single source of truth for the app version is `APP_VERSION` in
`src/App.jsx`, three-way-synced with `package.json` and the player-facing `WHATS_NEW` toast.
Stale `v1.x` git tags are historical and not authoritative.
**Why.** The version drives an in-app "What's new" toast keyed to `APP_VERSION`; a code
constant is what the UI reads. The sync is test-enforced, so it can't silently drift.
**Cost.** Unlike WarSlate (where the git tag is authority), tags here don't gate anything.
Lightweight release tags MAY be resumed to get pinnable GHCR images (see ROADMAP), but the
authority stays in code. **Where.** `src/App.jsx`; enforced by `invariants.test.js`.

## D5 — Publish the image on every push to main (:latest, :sha, :branch)

**Decision.** `.github/workflows/docker-publish.yml` builds and publishes to GHCR on every
push to `main`, gated on `npm test` and an error-free ESLint run. `:latest` tracks the default branch.
**Why.** Simple, hosted-runner CI; the household deploy pulls deliberately (no auto-pull),
so republishing `:latest` on an internal-only commit is harmless here.
**Cost.** `:latest` means "last push that passed tests and lint," not "last deliberate release." If
that ever matters, gate `:latest`/semver tags on a `v*` tag or a release-commit condition
(one workflow line) — recorded here so the choice is explicit, not accidental.
**Where.** `.github/workflows/docker-publish.yml`.

## D6 — Lint blocks CI (backlog cleared 2026-08)

**Decision.** `npm run lint` must exit clean; CI fails on any ESLint **error**. Warnings are
allowed and visible. The ~40-error backlog that made this advisory is gone.
**Why.** A gate only works if green means green. With zero errors, any new one is a real
signal instead of noise.
**Cost.** Two rules are deliberately tuned rather than obeyed literally, both documented in
`eslint.config.js`: `react-refresh/only-export-components` allows the provider+hook and
component+helper pairs this codebase uses on purpose, and `react-hooks/set-state-in-effect`
is a **warning** because every current hit is the standard fetch-on-mount pattern
(`useEffect(() => refresh(), [refresh])`) — restructuring data fetching across the admin
panels is a project, not lint cleanup.
**Where.** `.github/workflows/docker-publish.yml`, `eslint.config.js`.

## D7 — Auth: JWT bearer tokens, bcrypt passwords, hashed email/reset tokens

**Decision.** Sessions are stateless HS256 JWTs (7-day expiry) signed with a mandatory
`JWT_SECRET`; passwords are bcrypt; email-verification and password-reset tokens are stored
as **SHA-256 hashes** (raw token emailed).
**Why.** The server refuses to start on a weak/missing secret (v2.40.3), so a defaulted
secret can't sign forgeable tokens. Hashing the email tokens means a DB read can't replay
them. Session invalidation uses `password_changed_at` vs the token `iat`.
**Cost.** Rotating `JWT_SECRET` logs everyone out (intended on a leak). Token-in-localStorage
is mitigated by the CSP (v2.40.x infra). Full model: `SECURITY.md`.
**Where.** `server/lib/jwtSecret.js`, `server/lib/tokens.js`, `server/middleware/auth.js`,
`server/routes/auth.js`.

## D8 — ManaSync owns collection management (supersedes native CLC collections)

**Decision.** At the owner's request on 2026-09-08, collection management belongs exclusively
in ManaSync. CLC handles decks, comparisons, artwork and printing preparation, and uses
an optional scoped ManaSync bridge for inventory-aware buy/proxy planning (D10). Do not add a parallel CLC
collection manager or extend ownership coverage into deck overlap.
**Why.** Purchases, receipts, real/proxy counts, storage and allocations need one coordinated
inventory model. Duplicating it in CLC would create conflicting records and repeated work.
**Cost.** CLC's Collection tab, ownership badges, collection API and collection-only helpers
are removed. Existing `collection_cards` rows/schema are retained for recovery and a future
explicit migration; no ManaSync export or migration is implemented. The optional bridge contract is documented in [MANASYNC_BRIDGE.md](MANASYNC_BRIDGE.md);
legacy collection migration remains separate work.
**Where.** [MANASYNC_INTEGRATION.md](MANASYNC_INTEGRATION.md), [ROADMAP.md](ROADMAP.md),
`server/db.js` (retained legacy schema); collection routes are no longer mounted.

**Superseded history.** The earlier D8 keyed native ownership coverage by card name, summed
across printings/foils with DFC and accent normalization. Its implementation and tests were
removed with the native collection feature. Future ManaSync matching must deliberately
choose gameplay-level versus exact-printing semantics; the old matcher is not a contract.

## D9 — Generate PDFs in CLC; print through a native Mac companion

**Decision.** Adopt the owner's approved v6 layout with its matching cutting template.
CLC's Linux container runs Silhouette Card Maker and manages immutable PDF jobs; a
native Mac companion claims authorized print jobs and submits through the installed
Epson macOS driver and a validated local recipe. The initial registration mode remains
three marks; v6 layout adoption does not itself select four marks.
**Why.** PDF composition does not require a Linux printer driver. Keeping device rendering
and EPSON Vivid controls on the Mac permits validation against the owner's Adobe/Windows
output while CLC handles generation, storage and household requests.
**Cost.** The Mac must be awake/available to submit. Its automated rendering path needs a
color proof against Adobe; GUI presets cannot be assumed to transfer to CUPS. Double-faced
cards use separate one-sheet packets requiring manual flip/reload. Durable job IDs and submission
reconciliation are needed to avoid duplicate output after interrupted connections.
**Where.** [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md),
[HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md), and
[companion/mac](../companion/mac/README.md). The PDF/job API and Mac companion are implemented;
physical validation remains. The production runtime uses
Debian because the required upstream matplotlib wheel is unavailable for Alpine ARM64.
The adapter keeps 600 PPI while generating one sheet at a time and merging ordinary fronts.

**Standalone lists (2026-09-11).** Ad-hoc jobs reuse the print planner, artifact worker,
station protocol and ManaSync pending-proxy review. They store a named immutable card list
and a null tracked-deck ID; no placeholder deck or snapshot is created. Their authenticated
API and batch history are scoped to the owner. The nullable job-column migration preserves
existing jobs and request identities. Saved MPC artwork remains a tracked-deck feature;
standalone lists resolve Scryfall faces before review. Physical copy limits, separate DFC
packets, uncertain-request recovery and queue permissions apply unchanged. A reviewed
order can exclude suggested cards and add explicit copies without rewriting its source.
Changed-printing replacement defaults off and basic-land exclusion defaults on. The
review hash and durable creation request cover these choices; ownership does not silently
remove or limit any copies.

**One-sheet DFC packets (2026-09-10).** Keep each batch isolated and print its ordinary fronts
first. Each subsequent DFC artifact contains at most seven copies on exactly two pages:
front, then back. Partial sheets are intentional; easier paper handling takes priority over
filling every position. Numbered packet IDs and the printed `CLC <job-short-ID> DFC x/y`
label connect the physical sheet to its waiting pass. Labels use upstream's existing front
margin, preserving the v6 geometry, crop and registration marks. Legacy artifacts are not
rewritten; their multi-sheet layout and missing job labels require preview/all-page review.

After a front pass completes, hold the household queue and alert the operator. Only an
explicit confirmation for the exact waiting job/packet permits its one-sided back pass;
the next packet waits until that pass completes. The wait remains visible while paused.
Default Mac notifications with Glass sound and optional Discord delivery are reminders,
never print authorization. Dismissal and delivery failure cannot resume a job. Administrators
configure Discord from Print Station using fixed configure/test commands; delivery stays
on the Mac. Pending server secrets are encrypted, browser recovery stores only a UUID,
and the private Mac ledger atomically stores settings and command receipts. Disconnect
overrides older local config. Only the configured user ID can be mentioned. Tests bind to
the acknowledged settings revision and record intent before sending, without automatic
replay after an ambiguous response. No webhook was configured or sent during implementation.

**Artwork review (2026-09-11).** Resolve selected printings and physical faces before PDF
creation. Show actual thumbnails, source, exact printing, missing faces and separate DFC
packet counts in both full-snapshot and difference plans. Hash the resolved selections,
reject stale reviews, then generate from the pinned selections. Split/adventure images
remain single-sided; meld requires a dedicated layout and is explicitly unsupported.

The real cached generator passed offline rendering/pixel checks for one ordinary card and
eight DFCs split into seven-copy and one-copy packets. No paper was printed; the household
v6 cutting and manual duplex proofs remain separate pending work.

**Interface testing (2026-09-11).** Keep an enabled companion running while the owner
tests through CLC. A private Mac-only `allow_unverified_printing: true` setting permits
explicitly queued test jobs before physical calibration is complete. It defaults false;
the station reports **Test printing enabled** without changing either proof result.
This resolves the circular requirement to prove a sheet before the interface can print
one. Pause, exact-packet reload, native printer checks, artifact integrity and durable
submission receipts still apply. Remote controls cannot activate this local opt-in.
The owner decides when the physical results are accepted; software never infers that
from a successful spooler submission.

**Management extension (2026-09-10).** Keep the validated native Epson submission path and
make CLC the station management interface. The Mac polls outbound for health/control work;
no shared CUPS listener or generic command endpoint is introduced. Household operators can
pause and acknowledge the exact DFC back batch; only administrators request managed version
changes. Version changes wait for an idle ledger, preserve durable receipts and leave the
station paused. This supplies centralized operation without replacing the accepted native
rendering path. Source checkouts remain supported for development; managed packaging uses
versioned installations instead of depending on a moving Git checkout.
The managed installer bundles a pinned standalone Python runtime. A stable launchd entry
selects the complete installed version; GitHub release assets from the fixed CLC publisher
are checksum-verified and startup-checked before switching. Network/update failure retains
the working version. No release is published automatically by a feature-branch push.

## D10 — Optional ManaSync bridge with a durable physical-print outbox

**Decision.** CLC remains responsible for artwork, printing plans,
Mana Pool purchase links, and reviewing deck proposals. ManaSync owns collection holdings,
locations, and the shared pending-print quantity review. Each CLC user explicitly connects a scoped ManaSync actor; CLC stores that token
with its own encryption key. Users configure any reachable HTTP(S) backend domain, port,
or reverse-proxy base path without an origin allowlist; scheme-less addresses use HTTPS.
Credentials, query strings, fragments, and redirects are rejected. Ownership unavailable
from ManaSync is unknown. Existing printing and comparisons continue independently.
An explicit `decks:create` grant also permits immediate creation of a new manual deck from
ManaSync. Existing-deck edits retain the reviewed proposal flow. Manual decks carry an
explicit source type; their legacy non-null Archidekt ID is a unique negative local sentinel,
never a fabricated upstream ID. Refresh routes and background jobs exclude them.

**Why.** Exports are not evidence that cards were printed. Persisting each actual increment
before sending an acquire command, with a UUID and immutable credential/payload, permits safe
retries after lost responses. A replacement token is a new actor, so old operations require
receipt/holding reconciliation rather than automatic re-submission. The virtual Proxy binder
is not a second physical destination. The owner's 2026-09-11 ownership policy is a boolean
check: one original in any printing covers unlimited proxy copies across all decks. CLC
does not consume ownership across rows, compare requested print counts with inventory,
require exact-printing ownership, or reserve originals for proxy eligibility. Incoming
originals prevent duplicate buying and are identified as incoming; proxies do not establish
original ownership. Unknown ownership remains unknown. Shopping offers one original per
missing logical card and never changes physical print quantities or confirmation counts.

Prepared native batches automatically publish their exact card/artwork plans to ManaSync's
Pending prints, outside inventory. The owner can confirm usable quantities or dismiss the
remainder in either app. ManaSync commits each decision and proxy acquisition atomically with
a current pending revision; CLC polls the result. This makes unfinished print reviews visible
without claiming planned copies were printed. A batch and account identify one immutable
pending plan, even after disconnects, restarts, source-art cleanup, or lost responses.

**Cost.** The CLC database contains encrypted credential copies on pending operations and a
small print outbox. Account suspension pauses each remote request and worker retry, preserving
original operation identities for reinstatement. The separate CLC key must survive database restores. Six automatic attempts
use exponential backoff; users can retry the same operation or inspect a blocked receipt.
Corrections require explicit quantities, reasons where applicable, and current lot revisions.
Manual creation stores an immutable receipt per account and operation ID so token rotation
can recover a lost response. The receipt survives deck deletion to prevent resurrection and
is removed with its account. Account and instance pins prevent creation in a changed connection.
Canonical provider identities now connect tracked Archidekt decks and explicitly linked
manual Moxfield, DeckCheck, or Archidekt decks across the bridge. Creation reuses one existing
source deck without changing its name, history, or paper marker. Ambiguous legacy duplicates
stop for review; source identities never authorize an overwrite or infer card ownership.
Native Archidekt tracking also reuses an explicitly linked manual deck, promoting its
provider metadata and owner in place. Initial fetched content passes through D11's unknown
baseline review, preserving the current digital deck, paper marker, and all history.
The explicit `decks:create` grant also permits native provider tracking from
TapTogether through ManaSync. Identity and intent commit before network work;
Archidekt, Moxfield and DeckCheck share source review and scheduled refresh.
Provider failures have a per-deck status while retaining the last good snapshot.
Explicit etched finishes remain unavailable until the text/identity contract
can preserve them; they are never silently mapped to ordinary foil.

**Cross-app text compatibility (2026-09-11).** Match ManaSync at 500,000 Unicode code points
per creation `deckText` and proposal base/proposed/reviewed text field while preserving exact
bytes for hashes and replay. Only the two integration creation/source-tracking POST paths
and proposal/review POST paths accept a 12 MiB JSON envelope, allowing worst-case escaping
of two full proposal texts. Rate limiting and the original explicit creation grant,
proposal scope or review-session authentication precede the larger parser; ordinary Express
routes retain `512kb`, with matching path-specific nginx exceptions. Raising every route's
limit would unnecessarily expand unauthenticated parsing work. The review editor preserves
an oversized paste for correction and blocks commit instead of truncating UTF-16 units.

ManaSync retains its richer etched notation locally. Its outbound publication/submission
guard returns `422 unsupported_clc_finish` before sending unsupported deck text to CLC,
including newly delivered queued drafts. Local editing and export remain available.
Silently stripping the marker would change finish; treating it as a name suffix would
change card identity. An explicit user edit can select a supported finish, while uncertain
operations keep their original payload and receipt identity for reconciliation.

**Where.** `server/lib/manasyncBridge.js`, `server/routes/manasync.js`,
`src/components/ManaSyncOwnership.jsx`, `src/components/PrintQueue.jsx`,
`docs/MANASYNC_BRIDGE.md`. Structured deck reads and proposals are described in
`docs/MANASYNC_PROPOSALS.md`.

## D11 — Separate Archidekt history from the current digital deck

**Decision.** Keep a durable reviewed Archidekt baseline and the latest observed source
separate from digital snapshots. An unchanged source never replaces local CLC or accepted
ManaSync edits. A changed source advances the current deck automatically only when it still
matches the reviewed baseline. Otherwise the source is staged for an owner review: keep the
current deck, use the source, or commit explicitly merged text. Every Archidekt fetch path
uses the same coordinator. Older decks with an unknown baseline are handled conservatively.

**Why.** Comparing Archidekt only with the newest digital snapshot treated an accepted local
edit as a source change, then undid that edit on refresh. A separate baseline distinguishes
new upstream changes from intentional local differences and survives snapshot pruning.

**Cost.** Each tracked deck stores baseline/candidate text plus a revision. Review decisions
pin both that revision and the current digital snapshot; operation receipts allow exact retry
after a lost response. Source reviews do not write to Archidekt, set paper markers, or change
ManaSync holdings. The source panel explains the distinction and exposes the three texts.

**Where.** `server/lib/sourceSync.js`, `server/routes/sourceSync.js`,
`src/components/SourceSyncReview.jsx`, and `src/lib/sourceSync.js`.
The real two-server bridge harness also checks refresh after accepted ManaSync changes.
