# Operations runbook

Procedures for the risky/rare operations. The quick verification runbook lives in
CLAUDE.md; this is the deep version. Mirrors WarSlate's `docs/operations.md`.

## §1 — Database backup & recovery

The DB is a single sql.js file at `DB_PATH` (`/app/data/cardlistcompare.db` in Docker,
bind-mounted to `./data` on the host). `persist()` writes it atomically (temp → fsync →
rename) and keeps `cardlistcompare.db.bak` refreshed at boot and on graceful shutdown.

**Back up (safe while running):** the atomic rename means the live file is never torn, so
`cp ./data/cardlistcompare.db backup-$(date +%F).db` is safe. For a guaranteed-quiet copy,
`docker compose stop` first.

**Recover:** `loadDatabase()` (`server/db.js`) already tries `DB_PATH`, then `.bak`, then
`.tmp` on boot, and **refuses to start** rather than overwrite a corrupt file with an empty
one. To restore manually: stop the container, replace `cardlistcompare.db` with a good copy
(or the `.bak`), start it. If boot logs "could not be loaded … refusing to start," the live
file is corrupt and no usable backup was found — restore from an external backup.

**Never** `getDb().run(...)` directly (bypasses persistence). Write through the `run()`
helper. See INVARIANTS.md #1.

## §2 — External-API drift (the #1 cause of emergency releases)

Scryfall / Archidekt / Moxfield / MPC Autofill rename fields without notice; fixtures can't
catch it. When an import, price, or proxy feature breaks in the field:

1. **Reproduce against the LIVE API**, not a fixture — `curl` the actual endpoint and inspect
   the current JSON shape. Name the exact field that changed.
2. Providers and where we depend on them:
   - **Archidekt** — `GET /api/decks/{id}/` via nginx `/api/archidekt/`; parsed in
     `src/lib/fetcher.js`. Respects deck-level `includedInDeck` category flags.
   - **Moxfield** — `/v3/decks/all/{id}` via `/api/moxfield/`.
   - **DeckCheck / TappedOut / Deckstats / MTGGoldfish / TCGPlayer** — each has an nginx
     proxy block (`nginx.conf`) and a parser branch in `fetcher.js`. **A new source needs
     BOTH** a nginx `location` and a vite dev proxy (they drifted once — MTGGoldfish/TCGPlayer
     404'd in prod because only the vite proxy existed).
   - **Scryfall** — `/cards/collection` (batch, 75 max). Client: `src/lib/scryfall.js`;
     server: `server/lib/scryfall.js`. Results are keyed by the **requested** deck-text name
     (front-face-normalized, accent-insensitive), NOT Scryfall's echoed canonical name — a
     drift here silently zeroes DFC/accented prices.
   - **MPC Autofill** — `server/routes/mpcautofill.js`; the API has renamed fields twice
     (`cardIdentifiers`, DFC pair shape) → those were emergency patches v2.39.5–.7.
3. Fix the **mechanism**, not the symptom (don't special-case one card). Add a regression
   test that pins the new shape.

## §3 — New API endpoint checklist

When adding a `server/routes/*` endpoint:
1. Auth: wrap in `requireAuth` / `requireAdmin` unless deliberately public; verify resource
   ownership (no IDOR — check `user_id` matches).
2. Rate limit: add or reuse a limiter from `middleware/rateLimit.js` for anything expensive or
   auth-adjacent.
3. Validation: reject bad input with 400 (don't let it 500); cap body size.
4. If it imports a `src/lib/*` file, add that file to the Dockerfile `COPY src/lib/…` list —
   enforced by `invariants.test.js`, or prod crashes while dev works.
5. Write through the `run()`/`get()`/`all()` DB helpers only.

## §4 — Deploy & rollback (GHCR)

- CI publishes on push to `main`: `ghcr.io/cruv/card-list-compare:latest`, `:main`, `:sha-…`.
  The household deploy does **not** auto-pull — deploy deliberately.
- **Deploy:** ensure `JWT_SECRET` is set in the host `.env` (the container refuses to start
  without a strong one), then `docker compose pull && docker compose up -d`.
- **Smoke:** `curl http://localhost:8080/api/health`; load the UI; check the browser console
  for CSP violations if the release touched external resources.
- **Rollback:** pin the previous good image by its `:sha-…` tag in `docker-compose.yml` (or
  redeploy the prior commit). The DB is forward-compatible (additive migrations only), so a
  rollback of code is safe against a newer DB file.

## §5 — First-run / admin

First registered user (`id = 1`) becomes admin. In dev, register then restart the backend
once (admin promotion runs at startup). Admin panel: `#admin`.
