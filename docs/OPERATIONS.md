# Operations runbook

Procedures for the risky/rare operations. The quick verification runbook lives in
CLAUDE.md; this is the deep version. Mirrors WarSlate's `docs/operations.md`.

## §1 — Database backup & recovery

The DB is a single sql.js file at `DB_PATH` (`/app/data/cardlistcompare.db` in Docker,
bind-mounted to `./data` on the host). `persist()` writes it atomically (temp → fsync →
rename) and keeps `cardlistcompare.db.bak` refreshed at boot and on graceful shutdown.

**Back up (safe while running):** the atomic rename means the live file is never torn, so
`cp ./data/cardlistcompare.db backup-$(date +%F).db` is safe on the supported local
filesystem. Admin Dashboard also offers a database download. Verify important copies with
`sqlite3 backup-YYYY-MM-DD.db "PRAGMA integrity_check;"`. For a quiet restore point,
`docker compose stop` first. Keep independent dated copies; `.bak` is overwritten on normal
starts and stops and is not a versioned backup history.

**Recover:** `loadDatabase()` (`server/db.js`) already tries `DB_PATH`, then `.bak`, then
`.tmp` on boot, and **refuses to start** rather than overwrite a corrupt file with an empty
one. To restore manually: stop the container, replace `cardlistcompare.db` with a good copy
(or the `.bak`), start it. If boot logs "could not be loaded … refusing to start," the live
file is corrupt and no usable backup was found — restore from an external backup.

**Never** `getDb().run(...)` directly (bypasses persistence). Write through the `run()`
helper. See INVARIANTS.md #1.

The default data directory also contains `image-cache/` and `downloads/`. They are
regenerable image/ZIP artifacts; database backups do not include them. `IMAGE_CACHE_DIR`
and `DOWNLOADS_DIR` can override those paths. A database restore that references a missing
ZIP requires a new image download. Never run two backend processes against one `DB_PATH`:
each process owns an independent in-memory database and can overwrite the other's writes.

Native CLC collections have been retired in favor of the planned ManaSync companion.
The Collection UI and `/api/collection` routes are removed, but `collection_cards` schema
and rows are retained in database backups. There is no migration/export to ManaSync yet;
do not drop the table as cleanup. Review any eventual transfer against ManaSync's format.

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
   - **MPC Autofill** — `server/routes/mpcautofill.js` and `server/lib/mpcautofill.js`; the API has renamed fields twice
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

- CI requires passing client/server tests and zero ESLint errors, then builds the image.
  Pull requests build without publishing. Pushes to `main` publish
  `ghcr.io/cruv/card-list-compare:latest`, `:main`, `:sha-…`; requested `v*` tag pushes
  additionally publish semver tags. The published target is `linux/amd64`.
  The household deploy does **not** auto-pull — deploy deliberately.
- **Deploy:** ensure `JWT_SECRET` is set in the host `.env` (the container refuses to start
  without a strong one), then `docker compose pull && docker compose up -d`. Generate it
  with `openssl rand -hex 32`, store the output as the value, and retain it across updates.
  Rotating it logs everyone out. Compose reads the adjacent `.env`; it is not a shell script.
- **Smoke:** `curl http://localhost:8080/api/health`; load the UI; check the browser console
  for CSP violations if the release touched external resources.
- **Rollback:** pin the previous good image by its `:sha-…` tag in `docker-compose.yml` (or
  redeploy the prior commit). Take a database backup before deploying. Review migrations
  between versions before a rollback: migrations also repair stored data, so a blanket
  guarantee that any older code is compatible with a newer database is not valid. If a
  matching database restore is needed, stop the service first and account for newer writes.

## §5 — First-run / admin

First registered user (`id = 1`) becomes admin. In dev, register then restart the backend
once (admin promotion runs at startup). A fresh container installation needs the same
one-time restart (`docker compose restart`), followed by reloading or signing in again.
Admin panel: `#admin`.

Production has no default `JWT_SECRET`. Outside production, leaving it unset creates
`server/data/.jwt-dev-secret` (or beside a custom `DB_PATH`), so dev tokens normally survive
watch-mode restarts. If that directory is unwritable, the fallback is process-local.
Supplying a weak secret is an error even in development. The npm server scripts do not load
`.env`; export variables, or from the repository root run
`node --env-file=.env --watch server/index.js` after configuring a local `.env`.

## §6 — Image downloads and scheduled updates

The Scryfall image worker processes one queued job at a time. There are at most two pending
jobs per user and twenty overall. Interrupted processing jobs return to `queued` at startup.
Completed ZIPs expire after 24 hours; cleanup runs at startup and hourly. Scryfall images
are cached on disk, cleaned after 30 days by file modification time, and subject to the
`max_image_cache_mb` server setting. Check `[DownloadQueue]` logs and free disk space when
downloads stall. A Scryfall job only completes after every requested copy and required
face has an image and the ZIP finishes writing. Progress is in image files, so a two-faced
card contributes two files per copy. Missing cards/faces and invalid or failed image responses
fail the job with details instead of exposing a partial ZIP. Regenerate old ZIP jobs marked
as predating completeness checks; old completed artifacts are not reused as verified results.
Each job is limited to 1,000 physical copies, 20 MiB per source image and 256 MiB of unique
image buffers. PNG validation checks structure, checksums and bounded decompression;
JPEG validation checks required segments and scan structure, not a full pixel decode.
Oversized/corrupt inputs fail with an actionable error; split large requests into smaller
decks. These limits protect the current in-memory ZIP worker and are separate from the
PDF generator's memory and disk limits below.
The MPC Autofill ZIP endpoint is a separate request-driven export and still needs its own
physical-copy/face adapter.

The server scheduler checks for deck changes, due auto-refreshes, and price alerts. Its
global interval defaults to six hours and is configurable in Admin Settings. Per-deck
auto-refresh intervals are 6, 12, 24, 48, or 168 hours; due work runs on the next scheduler
cycle. Email alerts require configured SMTP, a verified address, and enabled per-deck
notifications. Discord alerts use the configured per-deck webhook. Price alerts measure
dollar change from a persisted baseline, not crossing an absolute deck-price target.

### Silhouette runtime

The container prepares the real Silhouette Card Maker in the background on startup. The
working source, Python environment and offline wheel cache live in
`data/silhouette-card-maker/` in the existing bind mount. Each startup checks upstream main,
stages a candidate, checks the approved v6 geometry, generates ordinary and double-faced
smoke PDFs, and selects a successful installation atomically. A failed update leaves the
previous compatible installation usable. First boot without a usable cache and network
access leaves PDFs unavailable while the rest of CLC starts normally. Restart to retry.
Nginx resolves its fixed external proxy hosts on demand through the container's DNS
servers; an unavailable external site no longer prevents the local web app from starting.

`PRINT_ENABLED=false` disables preparation. For local Node development, install Python with
venv/pip support and Git, or use the Docker image; `PRINT_PYTHON` can select a local Python.
Do not copy a Windows or Mac venv into the Linux cache. Runtime compatibility is checked;
an offline rebuild succeeds only if compatible wheels are already stored. Back up the whole
data mount, including source and wheels, for offline recovery.

The adapter invokes upstream once per seven-card sheet at 600 PPI and merges completed
sheets. Double-faced cards remain a separate artifact. Allow at least 2 GiB of container
memory for generation; disk usage depends on artwork and retained jobs. No Linux printer
driver is used. See [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) for the print API and Mac
companion work. Drying, lamination and cutting remain outside CLC.

### Household print jobs

Open a tracked deck's Printing tab for plan review, PDF downloads and job status. Set a
separate random `PRINT_STATION_TOKEN` to enable physical queue requests; administrators
can queue by default, and `PRINT_ALLOWED_USER_IDS` grants access to other household accounts.
These environment variables are forwarded by the supplied Compose file. Keep the same
station credential on the Mac. Rotating it revokes the old credential; claim identities
use a separate `data/.print-claim-secret` so existing jobs can recover after rotation.
Back up that private file with the database and artifacts.

Install [companion/mac](../companion/mac/README.md) on the Mac outside Docker. Use its
`doctor` and local `dry-run` commands before configuring physical-proof flags. Its private
state directory contains the submission ledger and downloaded PDFs; preserve that state
across upgrades and do not run multiple independent stations against one household token.
The optional LaunchAgent is written on request and installed by the operator after proof.
The repository's automated tests use fake submissions and never configure a printer.

Jobs live under `data/print-jobs/`. The default quota is 10 GiB
(`PRINT_STORAGE_MAX_MB=10240`). Preparation requires 5 GiB of working headroom for the
retained job and temporary generation files. A retained job is capped at 2 GiB including
sources; one PDF can be at most 1 GiB. Saved MPC sources stream sequentially to disk with
a 1.5 GiB total limit and 20 MiB per image. A single worker processes at most 250 copies per job, with
two pending jobs per user and ten awaiting generation overall. Ready/terminal PDFs expire
after seven days. Active, queued and uncertain jobs never expire automatically. Use
**Remove PDFs** on a safe batch to release disk space while preserving its manifest/history.

Before sending, configure and prove the Mac's Epson queue, color options and manual DFC
recipe. Server queue acceptance does not mean the printer is ready. A Mac that is asleep
leaves jobs queued. A pass that may have reached the spooler holds the station until its
outcome is reconciled; do not delete database rows to bypass this hold. Inspect the Mac
queue and physical sheets, then resolve the pass or explicitly clear/abandon the batch.

Print state and event receipts use `runTransaction()` to persist together. Back up the
whole data directory before deployment/schema upgrades. Artifact expiry keeps private
snapshot text/art identity in the database; deleting an account purges that history and
its files after active physical submissions have been reconciled. Untracking or pruning
a source snapshot does not rewrite a frozen print job.
