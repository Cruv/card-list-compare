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

Native CLC collections have been retired in favor of the optional ManaSync companion.
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

On macOS/OrbStack, keep the live data bind mount on the Docker host's local filesystem.
An SMB-backed scratch directory under the household's `/Volumes/Storage` share produced
open-file `.smbdelete*` tombstones held by OrbStack: upstream generated and validated its
PDF, but the adapter's final directory cleanup failed with `Directory not empty`. This
does not establish a problem with native local storage. The calibration succeeded using
container-local scratch and copying finalized artifacts to SMB. Use SMB for finalized
exports or backups, not this stack's live generation/cache/database directory. Do not
suppress cleanup errors or move production staging across filesystems without preserving
its atomic publication guarantees.

The adapter invokes upstream once per seven-card sheet at 600 PPI and merges ordinary
fronts into `fronts.pdf`. DFC sheets stay in numbered two-page packets
(`double-faced-001.pdf`, etc.), each holding at most seven copies. Jobs keep decks separate;
the maximum mixed job has 37 artifacts. Allow at least 2 GiB of container
memory for generation; disk usage depends on artwork and retained jobs. No Linux printer
driver is used. See [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) for the print API and Mac
companion work. Drying, lamination and cutting remain outside CLC.

### Household print jobs

#### Household installation checkpoint — 2026-09-11

The owner moved the permanent CLC stack to this Mac. Its `CardListCompare` container
belongs to the `mtg` Compose project, publishes host port 8080, and mounts
`/Users/cruv/docker/Stacks/mtg/cardlistcompare` at `/app/data`. The signed-in household
origin is `https://clc.blackbeardsvault.com/`. Keep this local data directory intact;
the repository's default `./data` is not the household deployment path.

The household server is now **v2.48.2**, deployed through the Mac's Docker CLI from
`codex/project-audit-print-workflow` at `9aeffde`. The local image is
`clc-household:2.48.2-9aeffde`; its saved service configuration lives at
`/Users/cruv/docker/Stacks/mtg/cardlistcompare-deployment/compose.yaml`. It retains the
existing `mtg` project/service, `CardListCompare` name, external `mtg_default` network,
UID/GID 1000, time zone, JWT secret and data mount. `pull_policy: never` keeps this local
build selected, and Watchtower is disabled for this container. Do not prune the image.
The registry's `latest` tag does not contain this feature branch yet.

Only CLC was stopped and recreated. A complete, private pre-upgrade backup was taken at
`/Users/cruv/docker/Backups/cardlistcompare/20260911T225536Z-before-2.48.1` while the old
container was stopped. Backup hashes, private prior-container settings and rollback
configuration are retained outside the live bind mount. Never run another backend
against the live database; an image rollback also requires reviewing/restoring its
matching data, after preserving any newer user changes.

The subsequent test-printing update has a complete stopped-container backup at
`/Users/cruv/docker/Backups/cardlistcompare/20260911T230744Z-before-2.48.2/data-complete`.
Preserve Linux venv symlinks as links when copying the generator cache on macOS; following
them would incorrectly resolve Linux interpreter paths against the Mac. The local
deployment folder also retains `rollback-2.48.1-compose.yaml` and the update checkpoint.

An isolated, network-disabled migration of a read-only database copy passed using the
tested v2.48.1 image. Core row counts were preserved, SQLite integrity remained `ok`,
and a second migration pass was idempotent. One pre-existing snapshot referencing a
missing deck remained unchanged; this check did not delete or repair household data.
The test never started schedulers, and its copied database was removed afterward.
After the actual deployment, integrity and core counts still matched the backup:
3 users, 2 tracked owners, 13 decks, 69 snapshots and 1 shared comparison. The existing
browser sign-in remained valid. Local and public health/station checks returned HTTP 200.

The native **v2.48.2 arm64 companion is installed** under
`~/Library/Application Support/CLC Print Station/app`, with private configuration in
`~/.config/clc-print-station`. Its server origin and `EPSON_ET_8550_Series` queue are
configured. The deployed service loads the matching station credential and
`PRINT_ENABLED=true` from the private `cardlistcompare-deployment/runtime.env` file.
The unused installation-only `print-station.env` was removed after verifying its copy
in the pre-upgrade backup. No additional household user grants have been added.

The Portainer agent is local, but Docker CLI deployment does not update the controller's
saved `mtg` stack. Before its next Portainer redeploy, merge the replacement CLC service
from `cardlistcompare-deployment/portainer-service.private.yaml` into that saved stack,
preserving its other services and network. This private fragment contains credentials
and an explicit environment, since the controller cannot read a Mac-local `env_file`.
Keep it and the runtime/rollback environment files out of Git, chat and logs. The local
deployment README has the service-only Compose command and recovery instructions;
do not use `down` or `--remove-orphans` with this partial stack definition.

Installation retained the previous manual-proof records and created a paused production
ledger. `~/Library/LaunchAgents/local.clc.print-station.plist` is loaded, and the
**v2.48.2 companion is running**, with KeepAlive and login startup enabled. The owner
unpaused it through CLC for interface testing; that command was applied and acknowledged.
Leave the station enabled as requested. Both physical-proof flags remain false, and the
separate `allow_unverified_printing: true` local setting now permits interface test jobs
without marking those proofs passed. The update restored Enabled before restarting the
worker and retained companion v2.48.1 as the rollback version.
CLC's Print Station dashboard reports **Online**, version **2.48.2**, station work
**Enabled**, and printer health **Ready**. Earlier HTTP 404 events remain
in its activity history from before the server upgrade; current heartbeats succeed.
Its read-only printer check passed all 66 configured driver options and reproduced the accepted
recipe fingerprint recorded in [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).
No sheet was submitted during installation or deployment, and no print job was created.
The dashboard also shows **Test printing enabled**. Queue test sheets using the normal
Printing tab; the exact-packet flip/reload confirmation still applies to every DFC back.
The real Silhouette runtime initialized successfully in the data bind mount at upstream
revision `4d4aa73a95e93b09676c863a1861765863398c63`, including its startup PDF checks.
Complete the v6 cutting and manual duplex proofs before enabling their respective flags,
then turn off the local test-printing opt-in. The 2.48.2 change passed 844 app/server tests,
111 native companion tests, lint, production builds and clean dependency audits.

#### Queue operation

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
The self-contained Mac installer includes Python and installs a user LaunchAgent, initially
paused. It can report setup health before proof flags are enabled. For source development,
the optional LaunchAgent writer remains available separately.
The repository's automated tests use fake submissions and never configure a printer.

For each deck job the station completes ordinary fronts, then each DFC packet's page 1
front pass, explicit flip/reload wait, and page 2 back pass before starting the next packet.
The printed front label `CLC <job-short-ID> DFC x/y` matches the packet shown in CLC and
its flip alert. All passes are one-sided; unused paper and older output must stay separate
from the sheet being reloaded. The household queue remains held until the packet is
resolved. Waiting packets surface even while paused, and dismissing an alert never submits
backs. An earlier immutable PDF may instead contain multiple sheets and no job label:
inspect its preview/all pages and match job, packet and sheet count before reloading.

Mac flip notifications and Glass sound default on. Configure `refeed_notifications` and
`refeed_sound` as JSON booleans in the private mode-0600 Mac config. Optional
`refeed_discord_webhook_url` and `refeed_discord_user_id` remain legacy local defaults.
For daily setup, an administrator opens **Print Station → Discord flip alerts**,
saves a webhook and optional user ID, waits for the Mac acknowledgement, then sends a test.
Disconnect writes a managed disabled setting that overrides any legacy destination.
Only the configured user may be mentioned. No webhook was configured or sent by this change.

Back up `.print-station-notifications-key` beside the server database along with the
private Mac ledger. The key is user-owned mode 0600 and encrypts pending webhook commands;
without it a pending connection must be entered again. Completed/expired commands remove
the ciphertext, but ordinary database backups may retain encrypted older commands. The
browser retains only a request UUID for recovery, never the webhook. Status and command
history do not expose the URL. The companion makes the actual Discord request; a successful
test confirms Discord accepted it, not that the recipient saw a notification. Ambiguous
tests are not replayed automatically; send another only as a deliberate new test.
Mac notification permission/Focus can suppress delivery. Alert failures are logged and
nonfatal; they leave the same explicit reload wait in place, with no silent printing or
automatic alert retry. See [Mac flip alerts](../companion/mac/README.md#flip-alerts).

The **Print Station** page centralizes health, version, event history, pause/unpause and
batch-specific DFC reload controls. It requires the same household authorization as
physical queue requests; only administrators may request version checks/changes. Install
matching server and companion versions for the heartbeat/control protocol. A companion
advertises its artifact capacity when claiming (37 from v2.48.0 onward; eight for older clients).
A larger queued job requires the newer companion and remains unclaimed until it connects;
the server does not skip the waiting job or create a physical recovery record. A companion
that cannot contact this protocol stops new submissions while retaining its ledger for
reconciliation. Starting an unverified companion is supported for setup/telemetry and does
not enable physical printing. A source checkout reports managed updates as unavailable.

Live health is kept in server memory to avoid rewriting the entire sql.js database every
five seconds. Server restart correctly resets the station to offline. Control intents and
receipts are durable database rows; the Mac also retains local idempotency records. Commands
expire after five minutes if not applied. A late receipt can still settle a command that
was delivered in time; expiry is not proof that its action did not occur. Do not recreate
an uncertain request without inspecting its receipt and the current station state.

Managed code/runtime versions live under the local state directory's `app/versions`, with
`current` and `previous` selections. The installer preserves an existing config/token/ledger
and refuses to migrate an active station. Restarting launchd selects a complete installed
version through a stable launcher; moving the original checkout or extracted installer
does not affect it. Keep these paths on local Mac storage. Back up the entire state and
private configuration together. Do not restore just an old ledger over newer print receipts.

Companion updates come from stable published GitHub release assets in the fixed CLC repo.
The updater checks archive/manifest digests, path containment and startup self-check before
activation. It retains the prior version and does not switch on download/validation failure.
Updates and rollback wait for no active local job; ambiguous submissions and DFC waits block
them. They preserve the current ledger/config and leave the station paused. Log files rotate
at launch when over 5 MiB, keeping three backups. A package's first installation has no
rollback version. See the companion README for installer migration and the explicit
build/draft-publication workflow; pushing a feature branch does not publish an update.

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
The one-ordinary/eight-DFC offline rendering check verified packet labels, five PDF pages
and unchanged v6 slot geometry without physical output. Household v6 cutting and DFC
flip/alignment proof remain pending; do not enable those proof flags from software QA alone.

Print state and event receipts use `runTransaction()` to persist together. Back up the
whole data directory before deployment/schema upgrades. Artifact expiry keeps private
snapshot text/art identity in the database; deleting an account purges that history and
its files after active physical submissions have been reconciled. Untracking or pruning
a source snapshot does not rewrite a frozen print job.

## §9 — ManaSync connection recovery

The actual companion source is [dennysparking/manasync](https://github.com/dennysparking/manasync),
supplied on 2026-09-11. For local paired verification use separate clones and explicitly set
`CLC_SOURCE_PATH` to the integrated `codex/project-audit-print-workflow` CLC checkout.
It selects ManaSync's harness imports/processes and Compose build context; it does not
configure either running app's API URL. The old `companions/clc` path remains only a fallback.
See [source selection and disposable verification](MANASYNC_BRIDGE.md#source-checkouts-and-paired-verification)
for install/build commands and database isolation. Record both tested revisions. A passing
HTTP/browser harness neither deploys these branches nor validates physical printer/cutter
behavior; a CLC `main` merge and production activation require their own release steps.

Large ManaSync deck transfers use a scoped transport exception: each creation `deckText`,
proposal `baseText`, `proposedText` or revised `reviewedText` field can contain 500,000
Unicode code points. These four POST paths allow 12 MiB JSON, including escaped text:

- `/api/integrations/v1/decks` and `/api/integrations/v1/decks/track-source`, requiring an
  explicit `decks:create` token before larger-body parsing.
- `/api/decks/:deckId/proposals`, requiring proposal access before parsing.
- `/api/decks/:deckId/proposals/:proposalId/review`, requiring a CLC login session before parsing.

Express also checks the global API rate limit first. Unrelated routes keep `512kb`;
nginx's `12m` exception covers only those four paths, with its default 1 MiB elsewhere.
Configure an external reverse proxy consistently for the same paths rather than raising
every endpoint's limit. See [deck-transfer limits](MANASYNC_PROPOSALS.md#delivering-a-proposal).

An etched-finish deck rejected by ManaSync with `422 unsupported_clc_finish` has not been
converted to CLC's simpler foil notation. Preserve the local deck/draft and use its export
or explicitly choose a supported finish before sending. Do not remove `*E*` automatically
or alter the payload of an uncertain saved operation to force a retry.

CLC encrypts saved ManaSync credentials, including the original credential retained by each
pending print report. Back up `.manasync-bridge-key` beside `DB_PATH` as well as the database,
or retain the separately managed `MANASYNC_BRIDGE_KEY`. A database-only admin export does
not contain the key. Restore the matching key before retrying operations.

Enter the server-reachable ManaSync URL and user integration token in CLC Settings.
Custom domains, ports, and reverse-proxy base paths need no server allowlist. Compose
forwards only the optional managed encryption key for this connection.
See [MANASYNC_BRIDGE.md](MANASYNC_BRIDGE.md) for connection and receipt recovery. Token
rotation must reconcile uncertain reports against the original actor's receipts; do not
resubmit them with replacement operation IDs or credit inventory from print-station status.

Native batches staged for inventory reporting retain exact source faces under
`manasync-artwork/<userId>/` beside `DB_PATH`. Back up this directory along with the database
and bridge encryption key. Native print-job expiry does not remove these retained faces.
Once reported, ManaSync stores its own account-owned image bytes in PostgreSQL and its usual
database backups. Do not substitute current MPC artwork for a pending batch’s saved hashes.
