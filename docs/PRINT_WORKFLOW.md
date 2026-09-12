# Household PDF and printing workflow

Status: CLC includes comparison-to-print handoff, editable artwork review, PDF generation, artifact downloads, the household
station API and a native Mac companion. The owner accepted the Mac Adobe color test and
corrected companion sheet; manual duplex and v6 cutter calibration still require the proof below.

## Print from comparison results

Choose **Print cards** from Compare, a deck changelog or snapshot comparison. The action
opens Print studio with the complete Before and After texts used for those displayed results.
It defaults to the positive physical-copy difference; choose the full After list to print
everything instead. Search filters in the changelog do not change this input. Even an
identical comparison can open review and switch to the full list.

The handoff survives sign-in in the same browser tab and is isolated from other signed-in
accounts. If a saved draft exists, choose whether to use the compared lists or keep the
draft; an unresolved batch request must be recovered before replacing its input. The
comparison becomes a standalone batch, with no new deck or snapshot. Both raw texts and
the comparison mode are frozen privately with the job; public summaries expose hashes.

## Standalone print lists

Open **Print studio** in the navigation to create an ad-hoc batch. Give it a name, then
paste cards, upload a text/CSV list, or import a supported deck URL. Importing here copies
the list without tracking the deck. Quantities and exact set/collector metadata use the
same card-list format as Compare. Include the sideboard when wanted, review the Scryfall
front/back artwork, then **Generate PDFs** or **Generate & print**.

The draft is saved per signed-in account in this browser. Prepared batches are kept in
that account’s Print studio history, including downloads and the same ManaSync pending-proxy
confirmation as deck batches. No tracked deck, snapshot or paper marker is created.
Standalone lists use Scryfall artwork; saved MPC artwork belongs to tracked decks.
The list name and exact reviewed text are frozen into the job. Later draft edits leave
existing batches unchanged. Uncertain creation requests retain the same key and exact list
across reloads, just like tracked-deck batches.

Ordinary fronts and double-faced packets follow the same recipe, labels, flip alerts and
explicit reload confirmation below. Separate batches never share a sheet.

## Using the Printing tab

The workflow has three steps: **Choose cards**, **Review & print**, and **Batch status**.
Review replaces the source form with a concise summary and an edit action. Card rows keep
front/back previews, quantities, ownership and edit controls together. Extra cards, removed
cards, detailed printer guidance and older batches are available in expandable sections.
The review footer keeps totals and generation actions together; active batches surface
their current status and next action.

Open a tracked deck's **Printing** tab. Choose a whole snapshot or changes between an
explicit baseline and target. The paper-deck marker is the default baseline when present;
“latest” is resolved to a specific snapshot during review. Sideboards are optional and off
by default. **Review print list** resolves the selected printing and displays its actual
front/back thumbnails, source, copy count and double-sided status. The summary separates
ordinary sheets from one-sheet double-faced packets. Missing faces, unresolved printings
and unsupported meld layouts block generation before a job is created. Then choose
**Generate PDFs** or, for an authorized household
account, **Generate & print**. Ready PDFs can also be queued later.

Each job produces `fronts.pdf` for ordinary cards, followed by one-sheet double-faced
packets: `double-faced-001.pdf`, `double-faced-002.pdf`, and so on. A packet holds at most
seven copies and exactly two pages: page 1 fronts, page 2 matching backs. It reports its
packet number/count, printed label, sheets, pages and copies. A job
fails if required artwork or a face is missing; it never publishes a partial batch PDF.
Errors and previous batches remain visible after reloading. Downloads include the exact
batch manifest. **Remove PDFs** releases storage while retaining the batch record.

Printing does not advance the paper-deck marker or declare cards assembled. The household
handles drying, lamination and cutting outside CLC; drying tracking is explicitly excluded.

## Editing the proposed list

**Replace copies when the set or printing changes** defaults off: a printing swap does not automatically
request another copy. **Exclude basic lands** defaults on in both workflows. Uncheck it
to print basics, including basic lands entered as extra cards.

After review, remove any proposed card you already have on hand, restore removed cards,
or add extra card-list lines with quantities. Review the revised selection before creating
the batch so artwork, copy counts and DFC packet totals reflect the final order. The edits
are part of the frozen plan and its hash; they never edit the source deck or snapshot.
The final selection still has the 250-copy limit, complete artwork validation, ownership
checks and ManaSync pending-proxy review. An unresolved creation locks these edits until
the original request is recovered.

Search, side/ownership filters and sorting operate on the reviewed artwork view. They
do not remove cards from the print order; use the explicit removal control for that.
The visible missing-card shopping list requests one original per logical card, deduplicated
across printings. Copy it or open the prepared list in Mana Pool to choose printings and
review pricing. Originals already owned or incoming are excluded. A disconnected or failed
ownership lookup stays unknown and cannot produce a missing-card claim. Shopping never
submits a purchase or changes physical print quantities.

## Physical copies and artwork

Use **Pick art** on a reviewed card to browse its Scryfall printings, including both faces
when applicable. Select an edition and collector number, then refresh the review before
generation; **Use original art** removes that row's override. The choice changes only the
print order, not the source list, snapshots or saved MPC selection. Each override preserves
the original row's quantity and removal identity. In a saved-MPC plan, only explicitly
overridden cards switch to Scryfall; all other cards retain their saved custom artwork.

The server accepts a Scryfall ID, verifies that it belongs to the requested logical card,
and resolves its required faces itself. Client image URLs are never authoritative. The
exact chosen ID and both face URLs are included in the plan hash and immutable manifest.
Double-sided grouping and sheet counts are calculated from the refreshed selections.

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

Archidekt URL imports and tracked Archidekt snapshots preserve the user's selected set
and collector number. The default Scryfall source resolves that exact printing, including
paired DFC faces; an unavailable exact printing blocks preparation instead of substituting
another edition. A reviewed **Pick art** override takes precedence.

The selected snapshot is the source of that identity. DeckCheck provides names and
quantities, so a later saved DeckCheck/plain-text import carries forward prior snapshot
metadata where possible and resolves newly added cards through Scryfall. Printing does
not fetch current Archidekt choices to replace that snapshot's art. Protected source
changes still go through source review. In changes mode, an art-only swap requests
replacement copies only when **Replace copies when the set or printing changes** is enabled.

The preview includes a plan hash covering resolved printing IDs, face URLs and saved MPC
identifiers. Creating a job revalidates those selections and pins source/target IDs,
complete deck texts and the reviewed faces; a changed preview is rejected. Generation uses
the pinned selections without performing another artwork lookup. A thumbnail transport
failure can be retried separately; source download failures still stop PDF publication. An idempotency key identifies a
request retry. The browser saves the creation request per account and deck before
sending it. If the result is uncertain, options stay locked across reloads and **Retry
same batch request** retrieves or finishes that request. A deliberate reprint after
resolution creates a new request. Later snapshot pruning or art
edits cannot rewrite a job. The manifest records input image identities/hashes, dimensions
and profile presence, copy/slot placement, recipe, generator revision/runtime, PDF hashes,
page counts and timestamps. Station steps separately record submission and spooler outcomes.

CLC does not infer available physical inventory from a snapshot difference. Real cards,
purchases, proxy counts and deck allocations belong to
[ManaSync](MANASYNC_BRIDGE.md). Its optional bridge checks ownership for the reviewed print list, provides a Mana Pool
link for missing originals, and also offers ownership in Full Deck. One original of any
printing covers unlimited proxy copies across decks. Incoming originals prevent duplicate
buying, proxies do not establish original ownership, and unknown lookup results remain
unknown. Shopping requests one original per missing logical card, deduplicated across
printings. The print list remains
the user's selection; inventory never silently removes copies or prevents a deliberate
reprint. Once the immutable PDFs are prepared, CLC automatically sends their planned copies
and exact front/back artwork to **ManaSync → Proxy binder → Pending prints**. These plans are
excluded from available inventory. Confirm usable quantities or dismiss failed/cancelled
copies in ManaSync or CLC's **Confirm usable copies** panel. A partial confirmation leaves
the remainder pending; each decision updates both apps. Simultaneous decisions check the
same server revision before changing inventory. Disconnected batches retain their artwork
and wait for the connection. The native spooler state remains separate from this quantity review.

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
  `stretch`, matching the earlier omitted default. Ordinary sheets carry the job and sheet
  number; DFC sheets carry `CLC <first-eight-job-ID-characters> DFC <packet>/<total>`.
  Upstream draws this label in its existing right margin on the front, followed by its
  sheet/template text. Card positions, registration marks and crop are unchanged.

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

A single worker invokes upstream once per seven-card sheet, merging ordinary sheets into
one PDF and retaining each DFC sheet as its own two-page packet. Separate jobs are never combined
to fill a packet; a partly filled final sheet is intentional.
Limits are 250 physical copies, 20 MiB per source image, 1 GiB per PDF and 2 GiB per retained
job, including staged sources. Saved MPC images are downloaded sequentially to disk with
a 1.5 GiB source limit; Scryfall acquisition retains its 256 MiB unique-image limit.
Output limits are checked before merging too. At least 2 GiB of container memory is
recommended; a 100-card synthetic stress test produced 15 pages / 881.5 MiB under that limit,
with roughly 911 MiB merger peak RSS. Real artwork size and host workloads vary.

An offline synthetic check on 2026-09-10 generated one ordinary card and eight DFCs with
the real cached upstream runtime: one ordinary page, then packets of seven and one copies
with two pages each. All five pages were rendered and visually reviewed. Pixel checks
confirmed every copy/slot, blank unused positions, back-row swapping and 180-degree back
rotation at the unchanged 792 × 612 point / 6600 × 5100 pixel geometry. Labels were readable
outside the cards and three registration marks. This was software PDF validation; no paper
was printed, and it does not complete the physical cutting or duplex proof.

## Double-faced packets and flip alerts

The companion finishes the batch’s ordinary fronts first. For each DFC packet it submits
page 1 as one one-sided front pass, waits for confirmed spooler completion, then holds on
that exact job and packet ID. The Mac requests a flip alert and CLC shows the waiting
packet's printed label, copy count and sheet count. Match `CLC <job-short-ID> DFC x/y` on
the printed front to the waiting packet; set earlier output aside and remove unused blank
paper from the rear feeder before loading the matching printed sheet.

Flip and reload only that packet's printed sheet according to the physically proven feeder
procedure, then use **Confirm paper reload** in **Print Station**. Confirmation applies
only to the shown job/packet. Page 2 then runs as a separate one-sided back pass; it must
finish before the next packet starts. Return blank paper to the feeder after the backs
finish so the next front pass can print. Automatic duplex is disabled. The household CLC
queue stays held throughout the wait. Pausing does not hide an existing flip wait, and
confirmation does not override a pause. Opening or dismissing a notification never resumes
printing. Other applications can still print, so keep the Epson queue dedicated while a
packet is waiting for its back.

Local Mac notifications and their **Glass** sound default on. The private Mac configuration
accepts JSON booleans `refeed_notifications` and `refeed_sound` (both default `true`), plus
legacy `refeed_discord_webhook_url` and `refeed_discord_user_id` strings (both default
empty). Administrators can now connect Discord in **Print Station → Discord flip
alerts**, enter a canonical channel webhook and optional user ID, and save. The
panel shows pending delivery until the Mac acknowledges the settings. **Send test** uses
the acknowledged revision; **Disconnect** disables delivery even if legacy local config
contains a webhook. Both require a companion advertising Discord support.

The browser sends credentials once over the authenticated connection and keeps only the
request UUID for uncertain-request recovery. The server encrypts the pending webhook with
a private key beside the database and removes the ciphertext after settlement or expiry.
The Mac stores the active destination privately in its ledger; status and receipts never
return its URL. Only the configured user may be mentioned. No real destination or test
message is created by installing this feature. See the [Mac alert setup](../companion/mac/README.md#flip-alerts).

Notification permission, Focus or sound settings can suppress a Mac alert. Each configured
channel is attempted once per waiting packet; ambiguous or failed delivery is logged
without automatically retrying. Alert failure is nonfatal and cannot authorize backs:
the durable wait remains visible in CLC, even while paused.

Existing PDFs and manifests are immutable. A legacy `double-faced.pdf` may contain several
front/back page pairs and lack the job label above. Inspect its PDF preview and all pages,
match the exact waiting job/packet ID and physical sheet count, and reload the complete
matching stack in its tested order. A new job is required to obtain the new packet layout.

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
job status, `/queue`, `/cancel`, `/manifest` and `/artifacts/:artifactId`.
Standalone routes under `/api/print-lists` provide `POST /plan`, `GET/POST /jobs`, and the
same actions under `/jobs/:jobId`. Standalone requests carry `mode: "adhoc"`, `listName`
and `cardText`; their frozen `list` stores the name, full text and text hash, while public
previews omit the full text. Standalone jobs have a null `deckId`, `source` and `target`.
Comparison-backed standalone requests also carry `comparison: { beforeText, mode }`,
where mode is `changes` or `full`. Omit `comparison` for ordinary standalone lists.
Both modes accept `excludeBasicLands`, `excludedCards`, `additionalCardText` and
`printingOverrides: [{ selectionKey, scryfallId }]` alongside their existing options.
Overrides use stable original row keys and verified exact card IDs. Station endpoints
under `/api/print-station` are `/status`, `/claim`, and job status, reports and artifacts.
All are authenticated; PDF bytes are streamed without nginx disk buffering. See
[OPERATIONS.md](OPERATIONS.md) and [SECURITY.md](../SECURITY.md) for deployment details.
The station claim accepts a bounded `maxArtifacts` capability (1–37, default eight for
older clients). An oversized waiting job remains queued and reports an upgrade requirement
before a fresh claim; existing physical submissions must still be reconciled.

## Mac color and manual duplex acceptance

The [Mac companion setup guide](../companion/mac/README.md) covers private configuration,
station credentials, read-only driver checks, a local dry run, foreground operation and an
optional start-at-login agent. It uses Python 3.9+ with no extra Python packages. The example
leaves both physical-proof flags off and requires the actual installed queue/options.
The managed package bundles Python, installs its own copy outside the checkout, and starts
paused at login. Its versioned installer/update/rollback workflow is described in that guide;
software updates preserve the local print ledger and cannot interrupt an unresolved batch.

The companion streams and verifies PDFs, maintains a durable local SQLite submission ledger,
and reconciles exact CUPS titles/job IDs before reporting outcomes. `status`, `pause`,
`unpause` and `resume JOB_ID` control operation. Manual `release JOB_ID --paper-cleared`
abandons an unresolved batch only after the operator has inspected and cleared its paper.
Setup and dry-run commands do not print; `run` and `run --once` may submit authorized jobs.
The Mac must stay awake, with the user logged in when using the optional LaunchAgent.
Every pass explicitly requests landscape Letter at actual size; a landscape PDF alone does
not ensure the Mac command-line filter rotates it onto the loaded sheet. Fixed page settings
are included in the durable recipe fingerprint so they cannot change during an active batch.

### Station management in CLC

The **Print Station** page (`#print-station`) shows the companion's most recent heartbeat,
printer checks, active batch, proof flags, version, recent events and control receipts.
Only administrators and authorized household print users can view/control it. Version
changes are administrator-only and available only for a managed installation.

The Mac makes outbound authenticated heartbeat requests; no incoming Mac web service or
printer sharing is required. Heartbeats are live observations, not evidence that a page
printed. A station becomes offline after 20 seconds without a heartbeat, and server restart
starts offline until the next observation. Printer checks are cached for up to 60 seconds;
every actual pass still checks the configured queue before submission.

**Pause** stops new claims and submissions while existing spooler work continues.
**Confirm paper reload** is tied to the current job and back-pass artifact. It cannot
release a different batch or change print settings. Expiring commands carry durable IDs;
the Mac records a receipt atomically with local pause/refeed changes, so reconnects do not
repeat those actions. New physical submissions wait when the management connection is
unavailable. Existing passes continue through the original reconciliation logic.

The companion can run while its recipe is unverified to report setup health. By default,
it will not claim new jobs or print until local proof requirements pass. For deliberate
interface testing, the Mac's private configuration can set `allow_unverified_printing`
to the JSON boolean `true`. The dashboard displays **Test printing enabled** and retains
the actual proof results; ordinary and double-faced test jobs use the normal queue and
manual paper-reload sequence. This local opt-in does not unpause the station, create jobs,
or bypass printer/options checks, artifact verification or duplicate-submission protection.
Remote commands cannot change this setting. Turn it off after recording completed proofs.
Software updates and rollback require an idle local
ledger and preserve pause, configuration, PDFs and submission receipts. Uncertain outcomes
and manual DFC waits count as active batches, not idle time.

The Mac must be awake and use the actual Epson driver with explicitly tested local options.
The supplied Windows Adobe settings enable **Let printer determine colors**; Epson uses **EPSON
Vivid**, Ultra Premium Photo Paper Glossy, Best quality, rear feed and Actual Size. No
custom ICC profile is selected in the screenshots. The source PDF is untagged DeviceRGB.
The adapter preserves upstream's RGB composition without adding an ICC transform; the
manifest explicitly records that color was not normalized or assigned a printer profile.

Epson documents [EPSON Vivid on Mac](https://files.support.epson.com/docid/cpd5/cpd59879/source/printers/source/printing_software/mac_fy13/references/color_management_options_mac_fy13.html).
Its presence does not prove a Windows/Mac color match. Adobe GUI presets are not inherited
by `lp`; inspect the actual driver's options with [CUPS](https://www.cups.org/doc/options.html).
Keep manual Adobe printing available until the unattended path matches an accepted proof.
On this Mac, Reader 26.002.21901 forces Print As Image and disables Adobe's own color
controls. Its native Printer dialog still exposes EPSON Color Controls and the saved Vivid
preset. See the [verified Reader setup and comparison](HOUSEHOLD_PRINT_RECIPE.md#adobe-reader-on-the-mac--2026-09-09);
do not assume the Windows Adobe checkboxes can be reproduced on this Reader version.

Before enabling unattended printing:

1. The household Mac now has Epson driver 13.45, queue `EPSON_ET_8550_Series`, and the
   **CLC Uinkit 54lb - Fronts** preset. On another Mac, install/configure its queue first.
   See the [recorded Mac setup](HOUSEHOLD_PRINT_RECIPE.md#mac-installation-and-saved-preset--2026-09-09).
2. The owner accepted the Mac Adobe reference on 2026-09-09 after clearing nozzle clogs.
   Repeat this comparison if the reference driver, media or color settings change.
3. The owner accepted the corrected companion sheet on 2026-09-10 after 2.44.2 added
   explicit landscape. Preserve its recorded recipe and repeat the comparison if the
   renderer, source, quality, scaling or color settings change. This accepts visual
   color/orientation, not measured v6 cutting geometry.
4. Verify v6 cut geometry, registration/Studio settings and the 1 mm crop on actual stock.
5. Separately prove DFC front/back page order, flip direction, rotation and alignment.
   The supplied two-sided preset was visible but its settings were not opened.

DFC fronts and backs are separate spooler passes. Only an operator's flip/reload/resume
allows the back pass; other CLC batches wait meanwhile. The Mac does not inherit Windows
manual-duplex prompts. Confirm rear-feeder stack capacity for this stock. The named rear
paper feeder is distinct from Epson's one-sheet thick-media rear feed slot.
