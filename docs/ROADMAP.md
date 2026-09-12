# Roadmap

The committed backlog — the only roadmap. Open work at the top; shipped items are kept
briefly for rationale, not as a queue. (Replaces the untracked `CLAUDE.local.md` roadmap,
which was nowhere on a fresh clone.) Private/sensitive plans may still live in
`CLAUDE.local.md`; the default belongs here.

## Next — physical cutter/duplex proof and native rollout

Source implements the current [print workflow](PRINT_WORKFLOW.md): exact snapshot/delta
or standalone plans, editable paired artwork, actual cached Silhouette v6 generation,
immutable PDFs and durable native receipts. The workspace is Compare / Decks / Print;
Cards / Changes / Print / Settings inside a deck. Library imports start tracking directly.
Prepare and Batches preserve drafts; Printer shows all household waiting/spooled batches.
Fresh pasted lists no longer inherit an unrelated comparison baseline, and review explains
entries, copies, baseline reductions and exclusions. Inventory-only work is called manual
print records. [UI organization](UI_REDESIGN_INVENTORY.md) is the current capability map.

The new native source reports printer/active-pass faults through Mac and optional Discord
alerts with durable duplicate suppression; it does not pause, resume or retry prints.
The deployed server/native versions are separately recorded in
[the household checkpoint](OPERATIONS.md#household-installation-checkpoint--2026-09-11).
A companion update must wait for its active physical work to finish; preserve Enabled and
all private receipts/settings during the household rollout. Never pause the running
household station for interface testing. Reconcile Portainer's saved service definition
before its next controller redeploy.

The Epson 13.45 driver and Uinkit fronts recipe have accepted color (after nozzle cleaning)
and companion landscape output. Remaining physical work is **v6 cutter geometry** and
**manual DFC page order, flip and alignment**. A real-generator offline fixture verified
labels and geometry for one ordinary card plus eight DFCs in separate packets, without
printing paper. The owner's 600 PPI, 1 mm crop and Epson Vivid settings are preserved in
[HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).

Ordinary fronts run first, followed by numbered DFC packets of at most seven copies on
one front/back sheet. The queue waits for that exact sheet to be reloaded; its backs
complete before the next packet. The Mac must be awake. Earlier unlabeled/multi-sheet PDFs
stay immutable and need careful matching. Drying, lamination and cutting tracking remain
excluded. Printing never advances the assembled paper-deck marker automatically.

## Optional companion integration — ManaSync

The bridge now implements explicit user-scoped connections, one-original ownership checks
and shopping, durable confirmed-print reporting, structured deck snapshots, optional manual
deck creation, and reviewed deck proposals. Archidekt source changes are reviewed separately
when local edits exist. Setup and contracts are in [MANASYNC_BRIDGE.md](MANASYNC_BRIDGE.md)
and [MANASYNC_PROPOSALS.md](MANASYNC_PROPOSALS.md).

ManaSync exclusively owns collection management (D8). CLC's PDF/Mac printing workflow and
ManaSync physical-print confirmations remain explicit separate actions: generating or
spooling sheets does not credit inventory or advance the paper marker. Legacy collection
rows remain in backups with no automatic migration. Broader vendor, ManaBox, and offline
companion work belongs in ManaSync; [the original discussion](MANASYNC_INTEGRATION.md)
remains historical context.

### Next bridge work

- Paired API/browser acceptance passed on 2026-09-11 using `CLC_SOURCE_PATH`, real servers,
  disposable PostgreSQL/SQLite and synthetic artwork. The actual
  [ManaSync repository](https://github.com/dennysparking/manasync) was supplied on 2026-09-11:
  its verification branch is based on `main` at `ef22e79`, paired with CLC v2.48.1 on
  `codex/project-audit-print-workflow`. See [source setup](MANASYNC_BRIDGE.md#source-checkouts-and-paired-verification)
  and [dated results](MANASYNC_REVIEW.md) for exact application/harness revisions and final
  checks. Repeat acceptance when either contract changes; deployment remains separate.
- Ownership is a yes/no check: one original of any printing covers unlimited proxies across
  all decks. Incoming originals prevent duplicate shopping and remain labeled as incoming.
  CLC suggests one original only for cards with none owned or incoming; it does not reduce
  print quantities, require exact-printing ownership, or plan quantity/reservation checks.
  ManaSync retains its inventory quantities and physical-copy reporting responsibilities.

## Open — reviewed 2026-09-12

Earlier critical/high-priority work shipped in v2.40.3–v2.42.x. The current review is
summarized in [PROJECT_REVIEW.md](PROJECT_REVIEW.md); older detailed security audits remain local.

**Product / features**
- **Share links**: add owner-side revocation for comparison links and optional expiry for
  both link types. Tracked-deck links already have owner-side revocation.
- MTGGoldfish/TCGPlayer imports: handlers are documented, but still need live end-to-end
  verification; source access restrictions may prevent individual imports.
- Invite-code expiry is checked but can't be set in the UI.

**Comparison and image correctness**
- MPC ZIPs deduplicate identifiers, XML exports do not encode paired DFC backs, and art
  overrides are per card name. The dedicated PDF adapter now preserves physical copies, face
  pairing and immutable art identity. Source-specific crop/bleed calibration remains part
  of the physical proof; the initial adapter preserves the owner’s 1 mm crop.
- Saved art choices currently use whole-record replacement and a 612-entry limit. The
  maintenance fixes preserve choices across searches and serialize saves within an overlay;
  multi-device concurrent edits still need versioning/conflict handling and history management.

**UI polish**
- Large authenticated PDF downloads currently become browser blobs before saving. Consider
  streamed browser downloads for memory-constrained phones; the native station streams now.
- Consider virtualizing the deck list for very large deck lists (not currently a
  measured problem).

**Housekeeping**
- Consider lightweight release tags (`vX.Y.Z`) so GHCR publishes pinnable semver images (D4).
  Needs the owner's go-ahead — it changes the "tags only on request" rule in CLAUDE.md.

## Direction

- Keep the app uniform with the sibling app **WarSlate** in engineering approach (docs
  structure, ship discipline, verified commits) — see the convention docs added 2026-08.
- Future: TapTogether/playgroup features were scaffolded then removed; revisit only with a
  concrete plan.

## Completed prerequisite — v2.43.0 completeness

- Canonical card identity includes name, set, collector number and foil status, with DFC
  aliases preserved across metadata-rich and bare inputs. Comparisons and display lookups
  use that identity; absent exact printing data is not replaced by generic art/prices.
- Scryfall ZIP jobs require every requested copy and face, report failures, count image
  files consistently, and require regeneration of legacy ZIPs that lack completeness checks.
- Native collection management is removed from CLC; ManaSync owns that responsibility.
  Deck overlap remains. Existing collection database data is preserved.
- Verified with 413 tests, zero lint errors (7 existing warnings), production/Docker builds,
  live Scryfall checks and disposable browser/API smoke tests. See
  [PROJECT_REVIEW.md](PROJECT_REVIEW.md). This was the prerequisite for the v2.44 PDF work.

## Recently shipped (historical rationale)

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
  badge allocation, before native collections were retired). ESLint backlog cleared and CI lint made blocking (D6).

- v2.41.x — Native Collection wired into deck views (now retired); TTS crash + multi-printing prices; notifications
  made real (price-alert baseline, verified-email gating + warning, rate limit, scheduler).
- v2.40.3–.5 — security criticals (JWT secret, atomic DB writes), data-loss fixes, core
  pipeline correctness (DFC/accents/CSV/differ). Plus infra (CSP, nginx) and token hashing.
