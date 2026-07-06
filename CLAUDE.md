# CardListCompare

MTG deck comparison and tracking app. React 19 + Vite 7 SPA; Express 5 backend
with **sql.js** (NOT better-sqlite3 — see invariant #1); Docker/GHCR deploy.
Deck lists are stored as plain text with embedded printing metadata — that text
format is the product's core data contract: [docs/DECK_TEXT_FORMAT.md](docs/DECK_TEXT_FORMAT.md).

> This file is hard-capped at 150 lines. No changelog entries here — git log and
> WHATS_NEW are the record. Every addition must displace something.

## Commands

```bash
npm run dev              # Frontend ONLY (Vite, :5173, proxies /api → :3001)
cd server && npm run dev # Backend (node --watch, :3001) — separate terminal, required
npm test                 # Vitest (~240 tests, <1s) — includes invariant-sync tests
npm run lint             # ESLint — advisory, has pre-existing debt; don't ADD errors
npm run build            # Vite production build
```

## Module map

```
src/lib/parser.js        Deck text → { mainboard, sideboard } Maps + commanders string[]
src/lib/constants.js     Card-line/header regexes (LINE_PATTERNS)
src/lib/differ.js        Diff two parsed decks (DFC + multi-printing aware)
src/lib/formatter.js     Exports: changelog, Reddit, Archidekt, MPCFill, TTS, JSON
src/lib/fetcher.js       URL imports (Archidekt/Moxfield/Deckcheck/…) → deck text
src/lib/scryfall.js      Client Scryfall batch (images, types; exact printings)
src/lib/api.js           Client HTTP layer for all /api calls
src/lib/useHashRoute.js  Routing: #admin #settings #guide #library #library/{id} #share/{id} #deck/{id}
src/lib/{powerLevel,recommendations,edhrec,analytics}.js  Deck analysis heuristics
server/db.js             sql.js init + migrations + run/get/all helpers + persist()
server/lib/deckToText.js       Server mirror of archidektToText()
server/lib/enrichDeckText.js   Adds printing metadata (carry-forward + Scryfall)
server/lib/scryfall.js         Server Scryfall batch (metadata, prices)
server/lib/               also: email, notificationScheduler, downloadQueue, prices
server/routes/           auth, owners, decks, snapshots, share, shared-decks, admin, collection, mpc
src/components/          UI components; admin/ subdir is the full-page admin panel
```

## Invariants (top 5 — full catalog: [docs/INVARIANTS.md](docs/INVARIANTS.md))

1. **sql.js persistence**: every `run()` helper call rewrites the ENTIRE db file;
   direct `getDb().run()` writes are silently lost; no atomic write. Never
   "optimize" `persist()` without temp+rename. Write via helpers only.
2. **Card-line regex lives in TWO places** — `LINE_PATTERNS[0]` in
   `src/lib/constants.js` and `CARD_LINE_RE` in `server/lib/enrichDeckText.js`
   (they have known pinned divergences). Change both or `npm test` fails.
3. **Parser contract**: entries have `entry.displayName` — `entry.name` does not
   exist. `parsed.commanders` is a flat string array, not Map entries. Map keys:
   `name.toLowerCase()` or `name.toLowerCase()+'|'+collectorNumber`.
4. (catalog #8) **Server imports from `src/lib/`; the Dockerfile COPYs a
   hardcoded list.** A new server-side `src/lib` import needs that COPY line
   updated or prod crashes while dev works (test-enforced, incl. dynamic imports).
5. (catalog #4) **Differ order**: `normalizeDFCKeys()` before `buildNameIndex()`
   in `diffSection()` — reordering silently breaks DFC matching.

#2–#5 are enforced or tripwired by `src/lib/invariants.test.js`; #1 is
convention (only its symbol anchors are checked). Fix the coupling, never
delete the test.

## Delivery protocol

Prefer the `/release` skill (.claude/skills/release) — it executes this.

- **User-visible change** ⇒ bump `APP_VERSION` in `src/App.jsx`, REPLACE the
  `WHATS_NEW` array (1–4 player-facing strings; toast shows the first two),
  sync `npm version X.Y.Z --no-git-tag-version --allow-same-version`, commit
  `vX.Y.Z: Description`, push.
- **Internal-only change** (docs, CI, refactor) ⇒ plain descriptive commit, no bump.
- Never commit on red tests. CI blocks the Docker publish if `npm test` fails.
- Pushing a `v*` git tag additionally publishes semver-tagged images — only on request.

## Guide sync

User-facing changes must update the matching section of
`src/components/GuidePage.jsx` (`SECTIONS`: getting-started, deck-comparison,
importing-decks, deck-library, deck-analytics, proxy-printing, export-formats,
recommendations, faq) — or state "Guide: no impact" in the commit body.

## Verification runbook

1. `npm test` — must be green before and after.
2. Two terminals: `npm run dev` + `cd server && npm run dev`; open
   http://localhost:5173. Admin promotion runs at server startup: register the
   first user, then restart the backend once to become admin.
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
| Commands, protocols, module map | this file (respect the 150-line cap) |
| User-facing behavior | GuidePage.jsx section |

Private context (roadmap, integration plans) lives in the untracked
CLAUDE.local.md — this file must stand alone without it.
