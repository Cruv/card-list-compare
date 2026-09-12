# CardListCompare

MTG deck comparison and tracking app. React 19 + Vite 7 SPA; Express 5 backend
with **sql.js** (NOT better-sqlite3 — see invariant #1); Docker/GHCR deploy.
Deck lists are stored as plain text with embedded printing metadata — that text
format is the product's core data contract: [docs/DECK_TEXT_FORMAT.md](docs/DECK_TEXT_FORMAT.md).

> This file is hard-capped at 150 lines. No changelog entries here — git log and
> WHATS_NEW are the record. Every addition must displace something.

## Commands

```bash
npm ci && npm --prefix server ci # Install BOTH dependency trees (Node 22+)
npm run dev              # Frontend ONLY (Vite, :5173, proxies /api → :3001)
cd server && npm run dev # Backend (node --watch, :3001) — separate terminal, required
npm test                 # Vitest client/server tests + invariant-sync tests
python3 -m unittest discover -s companion/mac -p 'test_*.py' # Fake-printer companion tests
npm run lint             # ESLint — errors block CI; warnings allowed (D6)
npm run build            # Vite production build
npm audit && npm --prefix server audit # Both dependency trees: release check (D3)
```

Dev defaults to `server/data/`; an unset JWT_SECRET gets a persisted random dev secret.
Production requires a strong secret; supplied weak values always fail startup. npm scripts
do not load `.env`: export settings, or run `node --env-file=.env --watch server/index.js`
from the repo root after configuring `.env.example` as `.env`. Never commit secrets/data.

## Module map

```
src/lib/parser.js        Deck text → { mainboard, sideboard } Maps + commanders string[]
src/lib/constants.js     Card-line/header regexes (LINE_PATTERNS)
src/lib/differ.js        Diff two parsed decks (DFC + multi-printing aware)
src/lib/formatter.js     Exports: changelog, Reddit, Archidekt, MPCFill, TTS, JSON
src/lib/fetcher.js       URL imports (Archidekt/Moxfield/Deckcheck/…) → deck text
src/lib/scryfall.js      Client Scryfall batch (images, types; exact printings)
src/lib/cardIdentity.js  Card name/set/collector/foil keys + DFC name normalization
src/lib/api.js           Client HTTP layer for all /api calls
src/lib/useHashRoute.js  Routing: #admin #settings #connections #guide #print-list #print-station #library #library/{id} #share/{id} #deck/{id}
src/lib/{powerLevel,recommendations,edhrec,analytics}.js  Deck analysis heuristics
server/db.js             sql.js init + migrations + run/get/all helpers + persist()
server/lib/deckToText.js       Server mirror of archidektToText()
server/lib/enrichDeckText.js   Adds printing metadata (carry-forward + Scryfall)
server/lib/scryfall.js         Server Scryfall batch (metadata, prices)
server/lib/               also: email, notificationScheduler, downloadQueue, priceCalculator, imageCache
server/lib/print{Generator,Queue,Workflow}*  Cached Silhouette runtime, PDF jobs, deferred backs/station protocol
companion/mac/           Native station/controls, versioned installer/updater, local Epson options/receipts
server/routes/           auth, owners, decks, snapshots, share, admin, integrations, print(-station-management)
server/lib/{manasyncBridge,deckProposals,sourceSync,sourceTracking}.js  Inventory, review, provider tracking
src/components/          Task UI; ActionMenu is the shared export/options disclosure; admin/ contains administration
```

## Invariants (top 5 — full catalog: [docs/INVARIANTS.md](docs/INVARIANTS.md))

1. **sql.js persistence**: every `run()` helper call rewrites the ENTIRE db file;
   direct `getDb().run()` writes are silently lost. `persist()` is atomic
   (temp+fsync+rename) with `.bak` recovery (v2.40.3) — keep it that way. Write
   via helpers only; `runTransaction()` persists related statements and restores memory on failure.
   Export only through `exportDatabase()` — raw sql.js export disables foreign-key cleanup.
2. **Card-line regex is single-sourced** — `CARD_LINE_PATTERN` in
   `src/lib/constants.js`, consumed by parser.js and server enrichment. Never
   fork a local copy (two forks drifted and corrupted data; test-guarded).
3. **Parser contract**: entries have `entry.displayName` — `entry.name` does not
   exist. `parsed.commanders` is a flat string array, not Map entries. Map keys
   come from `cardIdentityKey(entry)`: normalized name plus set/collector/finish when present.
4. (catalog #8) **Server imports from `src/lib/`; the Dockerfile COPYs a
   hardcoded list.** A new server-side `src/lib` import needs that COPY line
   updated or prod crashes while dev works (test-enforced, incl. dynamic imports).
5. (catalog #4) **Differ order**: `normalizeDFCKeys()` before `buildNameIndex()`
   in `diffSection()` — reordering silently breaks DFC matching.

#2–#5 are enforced or tripwired by `src/lib/invariants.test.js`; #1 also has
crash/recovery regression tests in `server/db.persist.test.js`. Direct writes
remain a review concern. Fix the coupling, never delete the test.

## Delivery protocol

Prefer the `/release` skill (.claude/skills/release) — it executes this.

- **User-visible change** ⇒ bump `APP_VERSION` in `src/App.jsx`, REPLACE the
  `WHATS_NEW` array (1–4 player-facing strings; toast shows the first two),
  sync `npm version X.Y.Z --no-git-tag-version --allow-same-version`, commit
  `vX.Y.Z: Description`, push.
- **Internal-only change** (docs, CI, refactor) ⇒ plain descriptive commit, no bump.
- Never commit on red tests or lint errors. CI gates Docker builds/publish on both.
- Pushing a `v*` git tag additionally publishes semver-tagged images — only on request.

## Guide sync

User-facing changes must update the matching section of
`src/components/GuidePage.jsx` (`SECTIONS`: getting-started, compare, decks,
printing, connections, account, reference; old topic hashes remain aliases) — or state "Guide: no impact" in the commit body.

## Verification runbook

1. `npm test`, `npm run lint`, `npm run build` — must pass; tests green before and after.
2. Two terminals: `npm run dev` + `cd server && npm run dev`; open
   http://localhost:5173. Admin promotion runs at server startup: register the
   first user, restart the backend once, then reload/sign in to become admin.
3. Exercise the changed surface: paste two deck lists → Compare for
   parser/differ/formatter changes; `#library` for tracker/snapshot changes;
   `#admin` for admin changes.
4. Docker smoke (deploy-affecting changes — Dockerfile, server deps, nginx):
   `docker compose up -d --build` → `curl http://localhost:8080/api/health` →
   spot-check the UI on :8080 → `docker compose down`.
5. External-API changes (Scryfall/Archidekt/MPC Autofill): test against the live
   API — fixtures can't catch their field renames, which are the #1 source of
   emergency releases.

## Doc-sync triggers

| You changed | Update |
| --- | --- |
| Card-line syntax / parser output shape | docs/DECK_TEXT_FORMAT.md + invariants tests |
| Anything in the invariants catalog | docs/INVARIANTS.md + its anchor table in invariants.test.js |
| Auth / security behavior | SECURITY.md |
| A settled approach (or you're diverging from one) | docs/DECISIONS.md (amend the D-entry) |
| Commands, protocols, module map | this file (respect the 150-line cap) |
| User-facing behavior / feature availability | GuidePage.jsx section + README.md |
| Deployment / runtime configuration | README.md + docs/OPERATIONS.md + .env.example as applicable |

## Where else things live

`docs/DECISIONS.md` (why, D-numbered) · `docs/OPERATIONS.md` (DB recovery, external-API
drift, deploy) · `docs/ROADMAP.md` (the committed backlog) · `SECURITY.md` (deploy + auth
model) · `docs/PRINT_WORKFLOW.md` (PDF jobs and native Mac station workflow).
`docs/MANASYNC_INTEGRATION.md` defines ManaSync as the inventory/purchase boundary (D8).
CLC has no native collections; legacy DB rows remain for a future deliberate migration.
`docs/MANASYNC_BRIDGE.md` + `docs/MANASYNC_PROPOSALS.md` define the optional bridge contract.
Check DECISIONS.md before changing an approach; amend it in the same commit.

## Concurrent sessions (the owner may run parallel Claude sessions here)

When an improvement is discovered outside the authorized task, propose a concrete plan
and ask the owner whether to implement it. Do not leave it as a passive observation or
silently expand the scope. Continue work already explicitly authorized.

Version any user-visible ship from `APP_VERSION` at HEAD, never from memory. Re-run
`git status` + `git log --oneline -3` immediately before every commit; stage explicit paths
(no blind `git add -A`) — unexpected dirty files may be another session's WIP: inspect, don't
debug ghosts. The SessionStart hook prints version / HEAD / dirty count at boot.

Sensitive-only plans may live in the untracked CLAUDE.local.md; the committed docs above are
the default and this file must stand alone without CLAUDE.local.md.
