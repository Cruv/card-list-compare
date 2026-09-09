# Household PDF and printing workflow

Status: CLC v2.44.1 includes print planning, PDF generation, artifact downloads, the household
station API and a native Mac companion. Physical color, manual duplex and cutter calibration
still require the household proof below.

## Using the Printing tab

Open a tracked deck's **Printing** tab. Choose a whole snapshot or changes between an
explicit baseline and target. The paper-deck marker is the default baseline when present;
“latest” is resolved to a specific snapshot during review. Sideboards are optional and off
by default. Review the copy list, then **Generate PDFs** or, for an authorized household
account, **Generate and send to Mac**. Ready PDFs can also be queued later.

Ordinary cards produce `fronts.pdf`. Double-faced cards produce `double-faced.pdf` with
alternating front/back pages. Each artifact reports its sheets, pages and copies. A job
fails if required artwork or a face is missing; it never publishes a partial deck PDF.
Errors and previous batches remain visible after reloading. Downloads include the exact
batch manifest. **Remove PDFs** releases storage while retaining the batch record.

Printing does not advance the paper-deck marker or declare cards assembled. The household
handles drying, lamination and cutting outside CLC; drying tracking is explicitly excluded.

## Physical copies and artwork

The planner aggregates included zones before calculating positive quantity differences.
A two-to-five increase prints three copies; removals print none. Commanders are already in
the mainboard and are counted once. Set/collector changes can request replacement copies,
or the player can keep existing playable copies. Finish-only changes never request another
proxy. Full/front DFC names and accented aliases match; missing printing metadata does not
by itself establish a different physical card.

Choose **Scryfall** for the snapshot's printings, or **Saved MPC artwork**. In the MPC
artwork overlay, **Save art for home PDFs** freezes current matched defaults, custom choices
and back faces while retaining saved art from other snapshots. Saved-MPC preparation
requires every selected front and required back; it does not silently fall back to a new
search result or Scryfall artwork. Scryfall determines the required face pairing even when
MPC provides the pixels. Name-only snapshot entries use Scryfall's resolved printing;
record exact set/collector metadata when a particular printing matters.

The preview includes a plan hash. Creating a job pins source and target IDs, complete deck
texts and saved selections; a changed preview is rejected. An idempotency key identifies a
request retry. A deliberate reprint creates a new request. Later snapshot pruning or art
edits cannot rewrite a job. The manifest records input image identities/hashes, dimensions
and profile presence, copy/slot placement, recipe, generator revision/runtime, PDF hashes,
page counts and timestamps. Station steps separately record submission and spooler outcomes.

CLC does not infer available physical inventory from a snapshot difference. Real cards,
purchases, proxy counts and deck allocations belong to
[ManaSync](MANASYNC_INTEGRATION.md), whose API is a future integration. PDF creation or
spooler acceptance must not be treated as confirmed inventory production.

## Household recipe

The exact supplied Adobe and Epson settings, paper details and historical PDF measurements
are preserved in [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).

- Epson ET-8550, **Rear Paper Feeder**; Uinkit double-sided glossy Letter paper,
  200 gsm / 54 lb, listed as 9.5 mil.
- Silhouette Cameo 5 Alpha; approved **v6** layout with **three registration marks**.
  Adoption of v6 does not select four marks or prove the installed cutting template.
- Standard 63 × 88 mm cards, landscape Letter, **600 PPI**, quality **100**, crop **1 mm**,
  skipped zero-based slot **4**: seven cards per eight-position sheet.
- Ordinary cards use `--only_fronts`. DFCs use a separate invocation without that flag,
  paired filenames and no generic back. The current upstream fit mode is explicitly
  `stretch`, matching the earlier omitted default. Global CLC sheet labels identify chunks.

The historical Windows command was:

```bash
python create_pdf.py --card_size standard --ppi 600 --quality 100 --paper_size letter --crop 1mm --skip 4 --only_fronts
```

Preserve the owner's 1 mm crop rather than applying an unrelated MPC bleed recommendation.
Mixed artwork still needs physical inspection: increasing output PPI cannot add missing
source detail, and a single crop setting does not guarantee every source's bleed is correct.

## Generator updates and offline operation

The container runs the actual [Silhouette Card Maker](https://github.com/Alan-Cha/silhouette-card-maker)
code. At startup it checks the latest upstream main in the background. Source, compatible
Python environments and binary wheels persist under `data/silhouette-card-maker/` in the
existing bind mount. Git fetches have bounded timeouts. A candidate must install its
headless dependencies, match the approved v6 geometry, and pass real ordinary/DFC PDF
smoke checks before `active.json` selects it atomically. Upstream licensing stays in its
source checkout. No printer driver runs in the container.

A failed fetch, dependency installation or validation preserves the last compatible
installation. Cached source and wheels can rebuild a compatible environment offline.
An offline first boot without a usable cache leaves PDFs unavailable and the web app
running. `PRINT_ENABLED=false` disables preparation; restart to retry a failed update.
A changed Python/CPU/platform may require new wheels and cannot be declared offline-ready
until compatibility is checked. Nginx also resolves external proxy hosts on demand so
unavailable external sites do not prevent local startup.

Each generation captures an immutable runtime. Unused versions/wheels can be pruned while
preserving the active, previous, in-use and retained job versions. The production runtime
uses Debian for ARM64/AMD64 binary-wheel compatibility. The inspected upstream reference
was `4d4aa73a95e93b09676c863a1861765863398c63`; it is not a permanent source pin.

A single worker invokes upstream once per seven-card sheet and merges the compressed PDFs.
Limits are 250 physical copies, 20 MiB per source image, 1 GiB per PDF and 2 GiB per retained
job, including staged sources. Saved MPC images are downloaded sequentially to disk with
a 1.5 GiB source limit; Scryfall acquisition retains its 256 MiB unique-image limit.
Output limits are checked before merging too. At least 2 GiB of container memory is
recommended; a 100-card synthetic stress test produced 15 pages / 881.5 MiB under that limit,
with roughly 911 MiB merger peak RSS. Real artwork size and host workloads vary.

## Queue, access and retention

PDF preparation and downloads require a user session and ownership. Physical queue access
requires a configured `PRINT_STATION_TOKEN` and either administrator status or a user ID in
`PRINT_ALLOWED_USER_IDS`. The station credential is separate from JWT sessions and grants
access only to authorized queued jobs and their reporting/download protocol. Rotate it on
both server and Mac. It does not permit editing decks or reading arbitrary users' data.

A native companion polls the station API and claims a job. It verifies downloaded hashes,
records local submission intent durably, gets server authorization for that pass, submits
to its fixed local queue, then reports the spooler ID. No request can supply shell commands,
executable paths or printer destinations. A durable station claim prevents interleaving;
lease expiry is not permission to repeat a physical submission. Interrupted or ambiguous
submissions require reconciliation rather than blind retry. A canceled CLC batch cannot
cancel paper already submitted to Epson; cancellation is restricted before submission.

States distinguish preparing, ready, queued, claimed, submitting, submitted, awaiting
refeed, completed, uncertain, failed, canceled and expired. “Completed” means confirmed
spooler completion, not proof that usable cards emerged or were cut and assembled.

Ready and terminal artifacts expire after seven days; queued, active, uncertain and
refeed-waiting batches are protected. Default retained-job storage is 10 GiB, configurable
with `PRINT_STORAGE_MAX_MB`; preparation reserves 5 GiB for the retained job plus temporary
sheet images and PDF parts. Remove old PDFs if that working space is unavailable. The manifest
and event history remain after artifact expiry. Account deletion purges its jobs and files,
but requires active physical submissions to be reconciled first.

User endpoints under `/api/decks/:deckId` include `POST print-plan`, `POST/GET print-jobs`,
job status, `/queue`, `/cancel`, `/manifest` and `/artifacts/:artifactId`. Station endpoints
under `/api/print-station` are `/status`, `/claim`, and job status, reports and artifacts.
All are authenticated; PDF bytes are streamed without nginx disk buffering. See
[OPERATIONS.md](OPERATIONS.md) and [SECURITY.md](../SECURITY.md) for deployment details.

## Mac color and manual duplex acceptance

The [Mac companion setup guide](../companion/mac/README.md) covers private configuration,
station credentials, read-only driver checks, a local dry run, foreground operation and an
optional start-at-login agent. It uses Python 3.9+ with no extra Python packages. The example
leaves both physical-proof flags off and requires the actual installed queue/options.

The companion streams and verifies PDFs, maintains a durable local SQLite submission ledger,
and reconciles exact CUPS titles/job IDs before reporting outcomes. `status`, `pause`,
`unpause` and `resume JOB_ID` control operation. Manual `release JOB_ID --paper-cleared`
abandons an unresolved batch only after the operator has inspected and cleared its paper.
Setup and dry-run commands do not print; `run` and `run --once` may submit authorized jobs.
The Mac must stay awake, with the user logged in when using the optional LaunchAgent.

The Mac must be awake and use the actual Epson driver with explicitly tested local options.
The supplied Adobe settings enable **Let printer determine colors**; Epson uses **EPSON
Vivid**, Ultra Premium Photo Paper Glossy, Best quality, rear feed and Actual Size. No
custom ICC profile is selected in the screenshots. The source PDF is untagged DeviceRGB.
The adapter preserves upstream's RGB composition without adding an ICC transform; the
manifest explicitly records that color was not normalized or assigned a printer profile.

Epson documents [EPSON Vivid on Mac](https://files.support.epson.com/docid/cpd5/cpd59879/source/printers/source/printing_software/mac_fy13/references/color_management_options_mac_fy13.html).
Its presence does not prove a Windows/Mac color match. Adobe GUI presets are not inherited
by `lp`; inspect the actual driver's options with [CUPS](https://www.cups.org/doc/options.html).
Keep manual Adobe printing available until the unattended path matches an accepted proof.

Before enabling unattended printing:

1. Install/configure the Mac Epson queue. It had no printer destinations during the review.
2. Print the same reference PDF from Adobe on Mac and compare with the Windows result.
3. Compare the companion's rendering with that Mac Adobe proof, keeping PDF bytes, paper,
   source, quality, scaling and color settings fixed. Record the approved local recipe.
4. Verify v6 cut geometry, registration/Studio settings and the 1 mm crop on actual stock.
5. Separately prove DFC front/back page order, flip direction, rotation and alignment.
   The supplied two-sided preset was visible but its settings were not opened.

DFC fronts and backs are separate spooler passes. Only an operator's flip/reload/resume
allows the back pass; other CLC batches wait meanwhile. The Mac does not inherit Windows
manual-duplex prompts. Confirm rear-feeder stack capacity for this stock. The named rear
paper feeder is distinct from Epson's one-sheet thick-media rear feed slot.
