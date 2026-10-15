# Operations runbook

Procedures for risky/rare operations. [CONTRIBUTING.md](../CONTRIBUTING.md) owns
development/release procedure. Read the section
needed for the authorized operation; this runbook is not a mandatory startup checklist.
Dated installation/incident records are evidence at that time, not a live health read or
permission to repeat production actions. Active task resumption uses [CURRENT_WORK.md](CURRENT_WORK.md).

## §1 — Database backup & recovery

The DB is a single sql.js file at `DB_PATH` (`/app/data/cardlistcompare.db` in Docker,
bind-mounted to `./data` on the host). `persist()` writes it atomically (temp → fsync →
rename) and keeps `cardlistcompare.db.bak` refreshed at boot and on graceful shutdown.

**Back up (safe while running):** the atomic rename means the live file is never torn, so
`cp ./data/cardlistcompare.db backup-$(date +%F).db` is safe on the supported local
filesystem. Administration → System also offers a database download. Verify important copies with
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

#### Household server deployment checkpoint — 2026-10-15

The Mac's `CardListCompare` service now runs **v2.57.4**, source `00e89a4`, local arm64
image `clc-household:2.57.4-00e89a4`, image ID
`sha256:578b7017359b09d4e7dd32bb706db27a365f2aa147fef3c02583dfbeefde221e`.
Only CLC was recreated in the existing `mtg` project. Port 8080, data mount, network,
restart policy and all nine configured environment values were preserved. Watchtower
remains disabled and the image is pinned with `pull_policy: never`.

The stopped-container backup is
`/Users/cruv/docker/Backups/cardlistcompare/20261015T205943Z-before-2.57.4/data-complete`;
its sibling `deployment` directory retains private configuration and the previous container
description. Symlinks were preserved. Keep the prior `clc-household:2.57.3-f04ad3a` image.
Do not restore this backup over later user changes merely to roll back application code.

Database integrity passed. All **16 print jobs**, **16,738 print-job events**, 78 snapshots,
three users and two tracked owners were unchanged by full-row hashes. All 15 saved-art
records retained their original bytes; the new `mpc_art_revision` column starts at zero.
All 87 retained print artifact files (465,092,497 bytes) were byte-identical to the backup.
One pre-existing orphaned deck snapshot was present in both stopped and post-deploy copies;
the update introduced no new foreign-key violations and did not delete or reassign that row.
Its investigation is recorded in [ROADMAP](ROADMAP.md).

The native **v2.57.3** companion stayed running and unpaused. Its jobs, passes, recovery
receipts, settings, configuration/token hashes and selected version were unchanged. An
authenticated heartbeat returned HTTP 200 at **21:06:42 UTC**. No printer operations,
physical-proof changes or Discord tests were initiated.

An isolated offline image fixture verified migration, guarded saves, stale-reset 409,
unversioned 428, unauthorized 401 and persistence after restart. Localhost and household HTTPS
health passed; all **38 frontend files** matched the image at both origins (76 responses).
The browser visibly showed v2.57.4, its release notes and conflict-recovery guidance.
Reload older open tabs before saving artwork; unversioned clients are deliberately rejected.
The existing v2.57.4 application/release evidence is recorded in [CURRENT_WORK](CURRENT_WORK.md).

Normal startup refreshed the cached upstream generator from `b95e833926d70c29a62a56b2b96cc3bb783c47e0`
to `0da09b729814aa5aafde024b5a6059624fa87951`; the previous runtime remains available.
Only upstream workflow/requirements files changed. The PDF script, utilities, adapter and
v6 cutting template were byte-identical. The upstream requirements changed matplotlib
3.11.1→3.11.2 and pydantic 2.13.4→2.14.1; five worker tests passed in the activated environment.
The accepted printing recipe and existing PDFs were not changed; this was not a physical proof.

Private `verification-2.57.4.private.json`, `frontend-verification.private.json`, native and
generator receipts beside the backup retain the rollout evidence. The private Compose and
future Portainer service fragment both pin the new image. Portainer's saved controller stack
still needs that fragment merged before its next redeploy, as described below; this CLI
activation did not edit the controller. Disposable containers, build files and browser tabs
were removed after verification.

#### Household installation checkpoint — 2026-10-11

The permanent `CardListCompare` container belongs to the `mtg` Compose project,
publishes port 8080 and mounts `/Users/cruv/docker/Stacks/mtg/cardlistcompare` at
`/app/data`. The household origin is `https://clc.blackbeardsvault.com/`. The
repository's `./data` is not the household deployment path.

At that checkpoint, the deployed server was **v2.57.3**, source `f04ad3a`, local image
`clc-household:2.57.3-f04ad3a`, image ID
`sha256:cdbab96a76d795a17162d8d98534088859c90dd24f92c1833c4ba586fade882b`.
Private configuration lives in
`/Users/cruv/docker/Stacks/mtg/cardlistcompare-deployment/compose.yaml` and
`runtime.env`. It preserves the container name, external `mtg_default` network,
UID/GID, timezone, signing secret and data mount. `pull_policy: never` selects the
local image; Watchtower is disabled for CLC. The registry's `latest` does not
contain this feature branch. Do not prune its image.

The healthy server rollout verified all **16 print jobs** unchanged by full-row hashes,
and database integrity passed. The prior checkpoint recorded
three users, two tracked-deck owners, 15 tracked decks and 78 snapshots. All 38 frontend
files match the image through localhost and household HTTPS (76 responses). The in-app
browser's household Guide visibly shows v2.57.3 and the new voice-pool wording while signed
out; authenticated recovery UI checks used disposable data and fake printer effects.
At **04:36:00 UTC on October 11**, the authenticated live API showed native v2.57.3 online,
unpaused, with no active job and known ready health; its last heartbeat was 04:35:55 UTC.
No additional printing or Discord test was initiated during the v2.57.3 rollout.

The complete stopped-container backup is
`/Users/cruv/docker/Backups/cardlistcompare/20261011T043320Z-before-2.57.3/data-complete`;
the sibling `deployment` directory retains the private deployment-fragment backup.
The earlier v2.57.0 rollout verification encountered a SQLite read error during atomic
sql.js persistence and restored the previous server image without restoring the
live database. A fresh captured-export integrity check passed; the subsequent
backed-up rollout verified all original jobs. For read-only inspection of the
server database while running, inspect a captured file export rather than letting
SQLite reopen the live bind-mounted path across sql.js atomic replacements.

The **v2.57.3 arm64 native companion** is installed under
`~/Library/Application Support/CLC Print Station/app`, with private configuration
in `~/.config/clc-print-station`. The current version is `versions/2.57.3`; previous
is `versions/2.57.2`. `~/Library/LaunchAgents/local.clc.print-station.plist` keeps it
running at login. It uses `EPSON_ET_8550_Series` and the saved **66 Epson driver
options**. Configuration/token files, 14 native jobs, all 14 pass records, the archived
recovery attempt and CUPS history were preserved exactly. At **04:32:43 UTC on October 11**,
the installed companion was verified running and unpaused.
**Leave it running and unpaused.** Both physical-proof
flags remain false; the existing local `allow_unverified_printing: true` permits
user jobs without claiming proof. Color/orientation results and remaining
cutting/duplex checks are in [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).

The installed package is
`~/Downloads/CLC Print Station 2.57.3/CLC-Print-Station`; adjacent archive
`clc-print-station-macos-arm64.tar.gz` has SHA-256
`000c6b533889867df68397faf8aa9ae05a0e9bce3892e7cb849cf69328e06d7e`.
The 1,666-file manifest, bundled runtime self-check and source-file parity passed.
The native backup is
`/Users/cruv/docker/Backups/cardlistcompare/20261011T043237Z-native-before-2.57.3`.
The guarded native update required no active physical work,
stopped the idle worker, held both worker and manager locks, and backed up full state
and configuration before switching versions. The unpaused bit was never changed; this
guarded idle update avoided the installer's normal pause. Earlier recovery-code updates
preserved the uncertain incident after proving exact CUPS23 terminal cancellation.
No ledger was cleared or recovery confirmation bypassed. No background upgrade watcher
is installed.

The **getting right with paper** batch resumed with a remaining-sheet attempt after the
operator confirmed one complete sheet, loaded paper and a cleared printer panel. Recovery command
`c40a9ae6-44a4-489e-b17c-70c78a1054e7` was applied for physical sheet 2 of the original
interrupted attempt. It queued the remaining **17 front sheets**, PDF pages 1–17 in
reverse physical order 17 through 1, preserving the already printed PDF page 18.
At **22:47:46 UTC on October 10**, exact CUPS submission `EPSON_ET_8550_Series-25`, title
`CLC-787d3212a14a5ba6dcce635e0854533d`, was completed (state 9); the matching native/server
recovery attempt was completed too. All 17 remaining fronts finished in the spooler,
with no backs required. The temporary completion monitor was removed. The original failed
CUPS23 receipt remains archived intact. This confirms completed printing passes;
physical card quality and cutting/duplex proof remain separate. A startup alert about
old canceled CUPS23 preceded recovery and did not describe the new attempt.

The existing Discord webhook remains connected. Incoming `/proxy` commands are implemented
but **not configured**: the operator must create/link a Discord application under Printer
settings. The webhook alone cannot receive commands.
Native v2.57.3 print webhooks use short sourced Rocky excerpts with visible film/speaker
attribution and stable event-specific selection. Factual details, mention rules and
delivery guards are unchanged. No real Discord test was sent during this update.

Source `f04ad3a` passed **1,200 JavaScript tests** and **254 native tests** (1,454 total),
lint (zero errors, five existing warnings), production build and both dependency audits
(zero findings). A focused independent review also passed 98 tests.
Nodemailer 10.0.16 is included; live email testing was omitted at
the owner's request. Browser tests verified sheet-order mapping, confirmation reset
on an attempt change, request payload and Discord setup controls. Isolated Docker
restart/security smoke checks use disposable data and no household credentials.
This feature-branch push does not trigger main/PR/tag CI, so these local checks
are not a claim of a passing GitHub workflow.

Private dated `update-*.json`, `native-update-*.json` and `verification-*.json` retain
the rollout evidence and rollback paths. `recovery-7acd98db-fronts.json` and
`recovery-7acd98db-verification.json` retain the authorized recovery receipt and observation.
Older 2.57.2, 2.57.1, 2.57.0, 2.56.0 and 2.53.3 packages/backups remain available. Preserve generator-cache
symlinks as links when copying Linux venvs on the Mac. Take a fresh backup before
another update, including newer jobs and user changes; never restore an older
database over newly queued work just to roll back frontend code. Never run two
backends against the live database. Recreate only CLC; do not use `down` or
`--remove-orphans` against the partial household Compose definition.

Saved backs, packet reservations, exact paper clearance, unmentioned completion
announcements and queued-job messages remain active. Completion waits for every
required pass, including backs. Existing PDFs stay immutable; requester/batch/page
identification applies to new PDFs. Alert delivery is best effort and does not
block the next front job. Physical cutter/duplex proof remains pending.

The initial cached generator was verified at upstream
`4d4aa73a95e93b09676c863a1861765863398c63`; normal startup still checks for a compatible newer
version. The original arm64 package is `~/Downloads/CLC Print Station 2.49.0`, archive
SHA-256 `2284b655758133927bb41e274bbb4fdb4826abd69c7cb7fa000769d9636ed8f7`.
Run bundled Python with `-B -E -s`; writing bytecode inside an installed bundle changes its
manifest and correctly fails verification. Private receipts/configuration survive updates.

Docker CLI deployment does not update Portainer's saved controller stack. Before its next
Portainer redeploy, merge `cardlistcompare-deployment/portainer-service.private.yaml` into
the saved `mtg` stack, preserving the other services/network. That private fragment contains
credentials because the controller cannot read the Mac-local `env_file`. Keep it and all
runtime/rollback environment files out of Git, chat and logs. No Portainer login is needed
for service-only deployment from this Mac.

At the v2.52.1 checkpoint, all 34 frontend files matched the image through localhost and the
public origin, existing sign-in survived, database integrity passed, and native v2.49.0
remained Enabled. Browser/automated checks use disposable data and fake side effects;
actual household prints after that checkpoint are user work, not disposable QA fixtures.
Do not interrupt active sheets or update the native runtime while its ledger owns a job.

#### Queue operation

**Paper-out recovery (v2.57.0+).** New native submissions set the job-scoped
`job-error-policy=stop-printer` and `job-cancel-after=2147483647` (about 68 years)
instead of inheriting the household Mac's three-hour cancellation timer. No global
CUPS scheduler setting changes. Do not substitute explicit `job-cancel-after=0`:
Apple CUPS adds an explicitly supplied value to the current time, so zero can mean
immediate cancellation. See [CUPS timeout settings](https://www.cups.org/doc/man-cupsd.conf.html)
and [Apple scheduler source](https://github.com/apple/cups/blob/v2.3.3/scheduler/job.c).

The October 10 incident (`getting right with paper`, batch
`7acd98db-0771-4bf1-be3a-2f4b4d109f14`) had no CLC cancellation request. CUPS job 23
was submitted at 03:10 local time, reported paper out at 03:22, and was canceled at
06:22 with `job-cancel-after=10800`. CUPS' generic `job-canceled-by-user` reason does
not identify a human cancellation. The operator confirmed one complete sheet printed.
The original interrupted pass had 18 sheets in reverse order; its recovery selected
physical sheet 2, PDF page 17, followed by pages 16 through 1. CUPS reported zero completed
impressions for that failed job, so its counters did not override the physical checkpoint.
That completed recovery attempt contained only those 17 remaining sheets. A later recovery
always uses positions within its interrupted attempt, not the original whole batch.

Resolve device faults before using **Printer → Continue printer job** or
**Print remaining sheets**. Owner/admin recovery is bound to the exact batch, pass,
CUPS title/ID and attempt. A canceled/stopped attempt requires the first unprinted
sheet ordinal **within that interrupted attempt**, preserving the frozen PDF and
old receipt while creating a distinct remaining-pages attempt. Recovering backs
also needs an explicit matching-front-sheet reload confirmation. Unknown or conflicting
CUPS history fails closed. A manually stopped Mac queue still needs operator attention
on the Mac; recovery does not enable the whole queue or restart a job from page one.

**Stale paper status correction (companion v2.57.1).** An idle, accepting local CUPS queue
may retain its earlier paper-needed/empty/Epson paper error after the device itself is
ready. The companion can make a read-only direct device check only when every job in that
queue is terminal and no other local fault is present. The device must return fresh idle,
healthy status and the same printer UUID as the configured DNS-SD queue. Paused/rejecting
queues, driver/storage errors, unknown status and identity mismatches remain blocked. This check
does not clear CUPS history, change queue settings or resume a job; the operator still
confirms the exact interrupted attempt and first unprinted sheet. This describes the
correction's behavior; the installation checkpoint above records what is deployed.

**Idle scheduler status (companion v2.57.2).** After CUPS25 completed, macOS cupsd exited
cleanly while idle. Its launchd service owns `/private/var/run/cupsd`; a localhost TCP
health poll alone did not wake it. The companion now uses that fixed Unix socket for
local print commands and a read-only queue probe before IPP health polling. Failed reads
remain unknown and preserve completion evidence. Idle failures stay in CLC's status/log.
Two consecutive failures with a pending, already-spooled pass may send a deduplicated
**Print status unavailable** monitoring alert with job/pass/ID and an operator mention;
that alert does not establish a physical fault, retry printing or change job state.
Confirmed paper, ink and stopped-queue faults keep their alerts.

Incoming Discord commands require a Discord application in addition to the alert
webhook. Configure **Printer settings → Discord printer commands**, set the public
HTTPS interaction endpoint shown there, install the application commands, and register
them using a one-time token. Only the configured Discord operator/server/channel and
current CLC administrator may issue `/proxy continue batch:<UUID> [sheet:<ordinal>]`.
It acknowledges a durable request; the Mac must still validate and apply it. Saved
bot settings contain no token. Do not put a bot token or webhook in logs or Git.

Normal companion updates remain blocked while a physical job is unresolved. To
install recovery code for an already canceled legacy pass, a one-time offline update
may be performed only after proving its exact CUPS title/ID is terminal, proving no
other physical jobs are active, stopping and locking the worker, and backing up its
ledger, artifacts, configuration and current version. Preserve the uncertain job and
Enabled state; never mark it failed/completed or clear its ledger to bypass the guard.
Verify the original receipts/configuration and unchanged CUPS history after restart.

Open **Print → New print list** for a standalone batch, or a tracked deck's Print tab for snapshot
plans. Both show artwork review, editable card selections, PDF downloads and job status.
Standalone jobs store a null tracked-deck ID; startup migrates the old non-null column
while retaining existing job IDs, requests, manifests and events. Set a
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

For new work claimed by companion v2.55.0+, all ordinary and DFC fronts finish first.
Matching backs become **Backs for later** and other batches continue. Pending backs and
their PDFs remain stored until printed or canceled; they are not marked completed to
release the queue. Newly generated pages include the frozen requester and batch label,
plus the sheet/packet ID and side. The exact `CLC <job-short-ID> DFC x/y` identity remains
the link between each sheet, saved artifact and alert.

Select one saved packet to request the printer when its current work finishes. Leave blank
paper loaded until CLC says that exact packet is ready to reload. Then match and reload
only that packet, confirm its checkbox and print its backs. This reservation holds other
CLC work. After the back pass completes, remove printed output, load blank paper and confirm
again to release the queue. Each confirmation is bound to the exact packet or cancellation;
an old browser tab cannot clear a later sheet. Opening or dismissing an alert never submits
anything. Owners can cancel their remaining job or backs; admins can do so across users.
Native cancellation targets only a uniquely matched CUPS title/ID and needs paper clearance
after active printing. Existing printed-pass receipts are retained. An ambiguous CUPS outcome
stays held for reconciliation instead of being treated as canceled.

Already-claimed legacy jobs keep their original alternating sequence. An earlier immutable
PDF may contain multiple sheets and no job label: inspect all its pages and match job,
packet and sheet count before reloading. Upgrading does not rewrite those PDFs.

Mac flip notifications and Glass sound default on. Configure `refeed_notifications` and
`refeed_sound` as JSON booleans in the private mode-0600 Mac config. Optional
`refeed_discord_webhook_url` and `refeed_discord_user_id` remain legacy local defaults.
For daily setup, an administrator opens **Print → Printer → Discord printer alerts**,
saves a webhook and optional user ID, waits for the Mac acknowledgement, then sends a test.
Disconnect writes a managed disabled setting that overrides any legacy destination.
On native v2.54.0+, only help-needed alerts (paper flips and printer faults) mention the
configured user. Completion announcements include the saved job name and batch ID without
any mentions; delivery tests also contain no mentions. Completion means every print pass
finished in the spooler, not that drying, lamination or cutting is complete. Existing
completed jobs are not announced retrospectively. No webhook was configured or sent by
this release's validation.
Native v2.55.0 adds unmentioned fronts-finished messages explaining that backs are saved.
Only a selected packet asks for a flip; returning blank paper after its backs is also a
help-needed alert. Canceling backs never produces a false whole-job completion message.

Native v2.56.0 adds unmentioned **Print job queued** messages for newly accepted batches.
Both Generate & print and queueing a ready PDF create one durable notice, atomically with
the queue transition. The frozen batch/requester labels, copy count, queue time and job ID
travel through the authenticated management heartbeat, independently of active printing
or pause state. PDF-only generation, queue retries and saved-back requests do not create
another notice. Preserve the server outbox and native delivery receipts with their usual
database backups. Existing jobs are not backfilled. Events observed while Discord is
disconnected are skipped; an offline Mac delays delivery. Failed or uncertain sends are
not automatically retried and never authorize or block a physical print pass.

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

The **Print → Printer** page centralizes health, version, event history, pause/unpause and
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
Updates and rollback wait for no active local job; ambiguous submissions, loaded-paper
reservations and paper-clearance waits block them. Safe saved backs do not prevent a newer
compatible update; finish or cancel them before rolling back below v2.55.0. They preserve
the current ledger/config and leave the station paused. Log files rotate
at launch when over 5 MiB, keeping three backups. A package's first installation has no
rollback version. See the companion README for installer migration and the explicit
build/draft-publication workflow; pushing a feature branch does not publish an update.

Jobs live under `data/print-jobs/`. The default quota is 10 GiB
(`PRINT_STORAGE_MAX_MB=10240`). Preparation requires 5 GiB of working headroom for the
retained job and temporary generation files. A retained job is capped at 2 GiB including
sources; one PDF can be at most 1 GiB. Saved MPC sources stream sequentially to disk with
a 1.5 GiB total limit and 20 MiB per image. A single worker processes at most 250 copies per job, with
two pending jobs per user and ten awaiting generation overall. Ready/terminal PDFs expire
after seven days. Active, queued, uncertain and saved-back jobs never expire automatically. Use
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

Open **Connections** (under **More** on phones). `https://manasync.net` is prefilled; enter a custom server address only when needed. Create the default CLC personal app token in ManaSync’s **More → Integration access**, then paste it into CLC. Use **Check connection** to verify a saved grant without an inventory write.
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
