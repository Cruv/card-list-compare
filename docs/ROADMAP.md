# Roadmap

The committed backlog — the only roadmap. Open work at the top; shipped items are kept
briefly for rationale, not as a queue. (Replaces the untracked `CLAUDE.local.md` roadmap,
which was nowhere on a fresh clone.) Private/sensitive plans may still live in
`CLAUDE.local.md`; the default belongs here.

## Next feature — household PDF generation and Epson printing

Design: [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md). Start with full-snapshot and physical-copy
delta planning, persisted artwork/face manifests, and downloadable PDFs produced by integrated
Silhouette Card Maker code. The container must clone/fetch the latest upstream main, keep a
working installation in the data bind mount, and use it if an update cannot be reached or
validated. Freeze the generator version per job. Then validate the household's paper, cutter template, color
recipe and front/back alignment before connecting a Mac or Windows print bridge.

The final experience is an authorized household user preparing and queueing the latest deck
or the copies needed since another snapshot. Drying tracking is explicitly out of scope;
the household handles its usual wait outside CLC. Printing does not advance the assembled
paper-deck marker. No PDF generation or printer submission is implemented yet.

## Planned companion integration — ManaSync

Context and open decisions: [MANASYNC_INTEGRATION.md](MANASYNC_INTEGRATION.md), captured
from the owner's Discord proposal and conversation screenshots. Coordinate CLC with a
per-user purchase/inventory companion: Mana Pool orders, manual buys, ManaBox scan-session
CSV imports and collection reconciliation, separate proxy counts, deck allocations and
QR-labeled storage. CLC should consult inventory to avoid duplicate purchases/reprints and
record proxy batches through an agreed API.

The working direction is PWA first with offline collection access; native iOS and a Discord
CSV bot are optional later ideas. Collection authority (ManaBox mirror versus ManaSync as
source), actual vendor/CSV capabilities, and the companion repo/API remain to be agreed.
Preserve the intended collaboration split: owner continues CLC; Denny starts the companion
and shares a repo/backlog. This is future integration context, not implemented functionality.

## Open — reviewed 2026-09-08

Earlier critical/high-priority work shipped in v2.40.3–v2.42.x. The current review is
summarized in [PROJECT_REVIEW.md](PROJECT_REVIEW.md); older detailed security audits remain local.

**Product / features**
- **Share links**: add owner-side revocation for comparison links and optional expiry for
  both link types. Tracked-deck links already have owner-side revocation.
- **Collection**: extend into the Overlap tab (owned coverage per deck) now that the deck
  views consume it; consider a "what do I still need to buy" per-deck view.
- MTGGoldfish/TCGPlayer imports: handlers are documented, but still need live end-to-end
  verification; source access restrictions may prevent individual imports.
- Invite-code expiry is checked but can't be set in the UI.

**Comparison and image correctness**
- Printing identity currently omits set and foil from composite keys. A set-only change
  with the same collector number or a foil-only change can report unchanged. Define the
  complete identity and update the parser/differ contract and invariants together.
- A bare full DFC name compared with a printing-qualified front-face name can report
  removal/addition instead of matching. Extend DFC key normalization with regression tests.
- Existing Scryfall jobs tolerate partial image/face results; progress mixes card-copy and
  image counts for DFCs. Report missing faces and consistent counts before reusing this
  pipeline for physical printing.
- MPC ZIPs deduplicate identifiers, XML exports do not encode paired DFC backs, and art
  overrides are per card name. The PDF adapter needs physical copy counts, explicit face
  pairing, source-specific bleed handling, and immutable art identity.
- Saved art choices currently use whole-record replacement and a 612-entry limit. The
  maintenance fixes preserve choices across searches and serialize saves within an overlay;
  multi-device concurrent edits still need versioning/conflict handling and history management.

**UI polish**
- Consider virtualizing the deck list for very large collections (not currently a
  measured problem).

**Housekeeping**
- Consider lightweight release tags (`vX.Y.Z`) so GHCR publishes pinnable semver images (D4).
  Needs the owner's go-ahead — it changes the "tags only on request" rule in CLAUDE.md.

## Direction

- Keep the app uniform with the sibling app **WarSlate** in engineering approach (docs
  structure, ship discipline, verified commits) — see the convention docs added 2026-08.
- Future: TapTogether/playgroup features were scaffolded then removed; revisit only with a
  concrete plan.

## Recently shipped (rationale kept briefly)

- v2.42.2 maintenance — Commander blank-line parsing; saved-art load/save/reset races and
  DFC back-art retention; consistent snapshot ordering and unlimited paper auto-locks;
  ZIP expiry/deck-scope checks; price-alert removal; Docker context exclusions and writable
  default database path; compatible
  dependency security updates; README, Guide and contributor/operations/security doc refresh.
  Household printing is a proposal, not part of this maintenance release.

- v2.42.x — shared modal layer (Escape/focus-trap/scroll lock across stacked overlays),
  auth-gated routes wait for the auth check and offer a sign-in screen; then a self-review
  pass fixed 30 regressions the earlier batches had introduced (per-printing pricing,
  price-alert zero guard, zero-byte DB recovery, container signal forwarding, collection
  badge allocation). ESLint backlog cleared and CI lint made blocking (D6).

- v2.41.x — Collection wired into deck views; TTS crash + multi-printing prices; notifications
  made real (price-alert baseline, verified-email gating + warning, rate limit, scheduler).
- v2.40.3–.5 — security criticals (JWT secret, atomic DB writes), data-loss fixes, core
  pipeline correctness (DFC/accents/CSV/differ). Plus infra (CSP, nginx) and token hashing.
