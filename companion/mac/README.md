# Native Mac print station

This companion polls CLC for explicitly queued print jobs and submits their verified PDFs
to one locally configured Epson CUPS queue. It runs outside Docker, uses Python 3.9+ and
macOS's native `lp`, `lpstat`, `lpoptions` and `ipptool`, and needs no Python packages.
The managed installer bundles its own Python runtime; it does not require a Git checkout
or a separately installed Python. Source-based operation remains available for development.
Installing or running this code does not install an Epson driver or reproduce an Adobe
print preset. Physical printing requires `recipe_verified` or the explicit local test mode
described below.

CLC generates the PDFs with Silhouette Card Maker. The companion keeps the server's card
copies, 600 PPI, 1 mm crop, Letter v6 layout, skipped slot and registration geometry intact.
It submits one copy in landscape at actual size, with automatic duplex disabled. Each deck's
ordinary fronts run first. DFCs follow in numbered packets of at most seven copies, each
with one front page and one back page submitted separately. The local queue, media/color driver
options and page order are configured here; server data cannot supply executable paths,
printer destinations or CUPS options.

See the [household print recipe](../../docs/HOUSEHOLD_PRINT_RECIPE.md) for the working Windows
reference: Uinkit 200 gsm double-sided glossy Letter, ET-8550 rear paper feeder, Ultra
Premium Photo Paper Glossy, Best quality and printer-managed EPSON Vivid. The generated
DeviceRGB output is not an ICC-converted proof. The owner accepted the household Mac's
corrected companion sheet against Adobe on 2026-09-10. Keep its recorded settings fixed;
v6 cut geometry and manual duplex still need physical proof before enabling their flags.

## Install once, manage from CLC

Extract the `clc-print-station-macos-arm64.tar.gz` package on an Apple Silicon Mac, or the
`x86_64` package on an Intel Mac. Open **Install CLC Print Station.command** inside the
extracted `CLC-Print-Station` folder. The installer uses the included runtime, asks for the
CLC origin, installed Epson queue and hidden station token when no configuration exists,
and installs a user LaunchAgent. No administrator password is needed for this user service.
The Epson driver is a separate prerequisite. This package is not Developer-ID signed or
notarized; it does not remove macOS quarantine or bypass approval for downloaded software.

Printing starts **paused**. An existing private configuration is preserved, including its
driver options and proof flags. A new configuration leaves both proof flags off and requires
the actual local Epson recipe described below. The service can report setup health without
being able to print. Set the server's matching `PRINT_STATION_TOKEN` and household user grants
in the container configuration, then open **Print Station** in CLC for daily operation.

The default installation is:

| Location | Purpose |
| --- | --- |
| `~/.config/clc-print-station/config.json` and `station-token` | Private connection and print settings |
| `~/Library/Application Support/CLC Print Station/station.sqlite3` | Durable print and control receipts |
| `~/Library/Application Support/CLC Print Station/app/versions/` | Complete versioned code and Python runtimes |
| `app/current`, `app/previous` | Atomic current selection and retained rollback version |
| `~/Library/LaunchAgents/local.clc.print-station.plist` | Start at login and restart the stable launcher after failure |

The Mac must be awake and this user logged in. The downloaded installer folder may be moved
or removed after installation; the installed service uses its own copy. Keep configuration,
state and installed versions on the Mac's local disk, not an SMB share. Logs live beside the
ledger; at service startup, logs over 5 MiB rotate with three retained backups. The CLC page
shows bounded structured activity rather than exposing arbitrary local log files.

Administrators can **Check for updates**, install the displayed newer version, or roll back
to the retained version. Updates use published stable packages from the fixed
[`Cruv/card-list-compare` GitHub repository](https://github.com/Cruv/card-list-compare/releases).
App releases without companion assets are skipped. Network failure preserves the current
installation. The manager verifies GitHub asset digests, the release manifest, archive size,
contained paths/links and every bundled file, then runs a no-print runtime self-check before
selecting a version. This trusts the repository publisher over HTTPS; it is not an Apple
code-signing guarantee. CLC cannot choose a different publisher or send executable code.

An update requires an idle ledger and leaves the station paused. Active prints, uncertain
outcomes and DFC refeed waits block version changes. An explicitly abandoned/reconciled
terminal batch retains its receipt history without blocking future updates. Code/runtime
rollback preserves configuration, the token, PDFs and the ledger. The first installation
has no previous version to roll back to. No version change prints a test sheet automatically.

For migration from a running checkout, pause it and unload its existing LaunchAgent first.
Move that old plist to a backup path before installing; a conflicting existing LaunchAgent
is rejected. Do not erase the print ledger to make installation succeed. To use a nondefault
existing configuration, invoke the extracted installer with `--config /absolute/config.json`.
`--no-launch` installs paused and writes the plist without loading the service.

## Build and publish packages

On a Mac, from the repository root, build a package for its native architecture:

```bash
python3 companion/mac/build_bundle.py --output /tmp/clc-station-package
```

The builder requires matching app/companion versions, downloads a pinned SHA-256-verified
Python standalone runtime into a local cache, includes its license notices and source
metadata, and refuses to overwrite an existing package output. It does not publish or print.
The pinned runtime is CPython 3.13.15 from the
[python-build-standalone 20260901 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20260901).
Build archives and runtime caches stay outside Git.

The manually dispatched **Build Mac Print Station Packages** workflow tests/builds each
native architecture and assembles `clc-print-station-manifest.json`. Its default only
uploads CI artifacts. The optional draft upload requires an already-existing matching
`vX.Y.Z` draft release and does not create a tag or publish that draft. After explicit
release approval, publish the matching draft with both archives and the combined manifest;
only then can installed companions discover that release. Ordinary branch pushes do not
publish companion packages or silently update household Macs.

## Configure without printing

From the repository root:

```bash
mkdir -p "$HOME/.config/clc-print-station"
chmod 700 "$HOME/.config/clc-print-station"
cp companion/mac/config.example.json "$HOME/.config/clc-print-station/config.json"
chmod 600 "$HOME/.config/clc-print-station/config.json"
python3 companion/mac/clc_print_station.py set-token --file "$HOME/.config/clc-print-station/station-token"
```

The hidden prompt accepts the same scoped `PRINT_STATION_TOKEN` configured on the CLC
server. It is saved as a user-owned mode-600 file, never placed in command arguments or
logs. The station token serves the household station API, not ordinary account login.
Configuration and state must also belong to the current Mac user; state lives in a
mode-700 directory. Use HTTPS for a remote CLC server. Plain HTTP on a trusted LAN requires
an explicit `"allow_http": true` in local configuration; loopback HTTP is supported.

Edit `config.json` to set the reachable CLC origin and exact installed Epson queue. Find
destinations and their actual supported options with these read-only commands:

```bash
lpstat -h localhost -e
lpoptions -h localhost -p YOUR_EPSON_QUEUE -l
python3 companion/mac/clc_print_station.py doctor
```

`driver_options` is a local map of advertised option keywords to advertised values. Add the
actual media, quality, rear-feed and color-control choices offered by the full Epson Mac
driver. Their names vary by installed driver; this repository deliberately contains no
invented universal Epson option names. `doctor` rejects unadvertised configured values,
checks queue availability and tests read-only job reconciliation. It reports the chosen
recipe fingerprint and proof flags. A successful report is not a color or alignment proof.

For the household's installed **ET-8550 driver 13.45**, the
[driver-options example](epson-et8550-13.45-driver-options.example.json) captures the
advertised options saved by the native **CLC Uinkit 54lb - Fronts** preset. Copy its object
into `driver_options` and use the installed queue name `EPSON_ET_8550_Series`. This is an
unproved automation starting point, not a ready-to-run configuration: set the server/token
locally and retain both proof flags as false until their respective physical checks pass. The
[recorded Mac setup](../../docs/HOUSEHOLD_PRINT_RECIPE.md#mac-installation-and-saved-preset--2026-09-09)
explains the observed color/profile flags and Windows controls without verified equivalents.

On first use, macOS may request Local Network access separately for **EPSON Printer
(rastertoescpII)**, the actual print filter. Allow it locally. Permissions for Epson's
setup or supply-level helpers do not cover this filter. A queue can remain at **Looking
for printer** even when `doctor` and direct printer status queries succeed. Check
**System Settings → Privacy & Security → Local Network** and any pending permission
prompt before changing the queue or its color settings.
[Epson documents this filter-specific permission](https://epson.com/faq/SPT_SEQUOIA-NS~faq-0000b89-macos_15).

If granting permission leaves an existing job stuck, reconcile its status and the
printer's status before pausing/resuming that same job in Print Center. Do not submit a
second copy to test connectivity. The household's first test needed this resume after
permission was granted; the existing job then connected successfully.

The companion fixes `media=Letter`, `orientation-requested=4` (landscape), `sides=one-sided`,
`number-up=1`, `print-scaling=none`, `fit-to-page=false` and one copy per pass. Landscape must
be explicit: the native Mac command-line path can otherwise place a landscape PDF on a
portrait Letter sheet and clip its right edge. Do not add these reserved options or the
`landscape` alias to `driver_options`. The default ordinary output order is `reverse`, matching the supplied
Windows reference. The two DFC output-order settings are independent and remain unverified
defaults until the actual rear-feeder flip/reload sequence is tested. Never enable automatic
duplex or reverse pages in two different layers to compensate without checking the proof.

Only `household-letter-v6` is approved in the example. After verifying the actual-size,
color and cutting proof with the configured native rendering path, set
`"recipe_verified": true`. Enable `"duplex_verified": true` separately after checking DFC
back alignment, front/back page order, flip direction and rear-feeder stack capacity.
These flags require JSON booleans; quoted strings such as `"false"` are rejected.
Ordinary cards can run with the duplex proof disabled; a claimed DFC batch will wait.

### Printing physical test sheets through CLC

To test the workflow before its physical proofs are complete, the owner can explicitly set
`"allow_unverified_printing": true` in the private Mac configuration and restart the companion
to load it. This local option defaults to false and requires a JSON boolean. It allows queued
ordinary and DFC test jobs even when `recipe_verified` and `duplex_verified` remain false;
it does not change those flags or record a successful physical proof. The station reports
`testPrintingEnabled` separately so CLC can identify this mode.

Test mode still requires an enabled station, an authorized CLC job, the locally approved
recipe, valid PDFs, and working native printer settings. Every DFC packet still stops for
the operator to flip and reload its matching printed sheet before explicitly confirming
the back pass. Pause, cancellation, durable submission receipts and recovery checks keep
their normal behavior. Changing this option does not change the recipe fingerprint or
erase print history. After testing, disable it to restore proof requirements, or record
each proof flag only after its physical result has been checked.

## Dry run and normal operation

After creating the private configuration above, this command uses a local example manifest
and displays the exact argument arrays. It
never contacts CLC, claims jobs, downloads PDFs or invokes the spooler. The example hashes
and PDF paths are placeholders, not downloadable artifacts.

```bash
python3 companion/mac/clc_print_station.py dry-run --manifest companion/mac/dry-run.example.json
```

After configuring verified printing or explicitly enabling local test mode, foreground operation is:

```bash
python3 companion/mac/clc_print_station.py run
```

`run --once` performs one real worker cycle and **may print** an authorized job. It is not
a dry run. Physical `run` requires macOS. The worker obtains an exclusive file lock so two
instances using the same state directory cannot submit simultaneously. Keep one household
station and retain its state directory across upgrades.

Local controls can run in a separate terminal:

```bash
python3 companion/mac/clc_print_station.py status
python3 companion/mac/clc_print_station.py pause
python3 companion/mac/clc_print_station.py unpause
python3 companion/mac/clc_print_station.py resume JOB_ID
```

`pause` stops new claims/submissions; existing CUPS jobs continue and are monitored. `resume`
is only accepted when the current DFC front pass has completed and the station is awaiting
manual refeed. Match the exact waiting job and packet before using it. It records the
operator's explicit confirmation that the indicated paper has been flipped and reloaded.
The worker reports that confirmation to CLC before submitting the back page. Confirmation
does not override a pause. No other CLC batch can interleave during this wait. Independent applications
can still submit to the printer, so keep the queue dedicated during a DFC refeed.

This adds no drying, lamination, collection or cutting tracking, and never changes a deck's
paper-snapshot marker.

### DFC packet sequence

New jobs keep ordinary cards in `fronts.pdf`; each DFC sheet is a separate two-page PDF:
`double-faced-001.pdf`, `double-faced-002.pdf`, and so on. Page 1 contains at most seven
fronts, and page 2 contains their matching backs. An underfilled final sheet is intentional.
The front's existing margin carries `CLC <first-eight-job-ID-characters> DFC x/y`, followed
by upstream's sheet/template text. That label also appears in the waiting packet and alert.
The layout, three marks, crop and front/back transforms are unchanged.

The companion completes ordinary fronts, then handles each packet in this order:

1. Print page 1 as a one-sided pass and confirm its spooler completion.
2. Hold the exact job/packet and show the flip alert. Match its printed label and keep
   unused paper, other decks and previously printed packets separate.
3. Remove unused blank paper from the rear feeder. Flip/reload only that packet's printed sheet using the physically verified procedure,
   then **Confirm paper reload** in CLC Print Station (or use the local `resume` control).
4. Print page 2 as another one-sided pass. Its completion permits the next packet.
   Return blank paper to the rear feeder after the back pass finishes. If the feeder is
   empty, Epson waits for paper for the next front pass; CLC also identifies that front pass.

The household CLC queue stays held while waiting. The wait and alert can surface while
paused; neither notification dismissal nor a reload confirmation unpauses the station.

Old PDFs and manifests stay immutable. A legacy `double-faced.pdf` can contain several
alternating front/back pairs and no job-specific printed label. Preview it and inspect all
pages; match the waiting job/packet ID and physical sheet count before reloading the
complete corresponding stack in its tested order. New packet labels cannot be assumed
to exist on older output.

### Flip alerts

The Mac requests a notification with the **Glass** sound when a DFC front pass has completed
and its back is waiting for reload. Notifications are reminders only: opening or dismissing
one never authorizes printing. CLC Print Station remains the persistent place to inspect
and confirm the exact waiting packet, including while paused.

These options belong in the current Mac user's private mode-0600 `config.json`:

```json
{
  "refeed_notifications": true,
  "refeed_sound": true,
  "refeed_discord_webhook_url": "",
  "refeed_discord_user_id": ""
}
```

Merge those fields into the existing configuration; do not replace its server, token,
driver or state settings. The two flags require JSON booleans and default to `true` when
omitted. Set `refeed_sound` to `false` for a silent Mac notification or
`refeed_notifications` to `false` to disable Mac notifications.

Administrators can connect Discord from **CLC → Print Station → Discord flip alerts**.
Save a channel webhook and optional user ID, wait for the Mac to acknowledge the settings,
then use **Send test**. **Disconnect** stores an explicit disabled override so an older
webhook in `config.json` cannot reactivate it. The Mac ledger stores managed settings
privately; keep it in the existing protected state directory and include it in backups.
The server only delivers fixed configuration/test commands; the Mac sends the notification.
An ambiguous test is not automatically replayed. A new button click is a deliberate new test.
Older companions show setup as unavailable until updated. Rolling back below 2.49.0
also ignores managed overrides: an older webhook still present in `config.json` would
become active again. Remove that legacy value before a rollback when delivery must stay
disconnected. The current household config has no legacy Discord destination.

Without managed settings, Discord uses the legacy config below and is disabled while its
webhook URL is empty. A configured canonical
`https://discord.com/api/webhooks/id/token` URL receives the waiting packet details and CLC
link. A nonempty `refeed_discord_user_id` must be a Discord user ID; the message can mention
only that configured user, with role/everyone mentions disabled. Omitting the user ID sends
the message without a mention. Use a normal text-channel webhook; forum/thread query
options are not supported. Keep the webhook out of environment variables, repositories and
logs. CLC encrypts a pending setup command and never returns its URL in public status or
receipts; the browser retains only a recovery request UUID. Active managed credentials
stay in the private Mac ledger and are not included in station telemetry. No Discord
webhook was configured or message sent during this implementation.

Allow notification delivery for the Mac notification sender in System Settings. Notification
permissions, Focus and sound settings can suppress display or sound even when the request
succeeds. Each enabled channel is attempted once per job/packet wait, with durable records
to avoid repeated messages after a restart. Failed or ambiguous delivery is logged without
exposing the webhook, is nonfatal, and is not automatically retried. The explicit reload
hold remains in place; alert failure never silently prints the backs.

The real cached generator was checked offline with one ordinary card and eight synthetic
DFCs on 2026-09-10. All five pages of the ordinary PDF and two DFC packets were rendered,
and labels, paired slots, empty positions and unchanged v6 dimensions were verified.
No paper was printed. Physical v6 cutting and manual duplex proof are still required.

Upgrade the companion before large packet jobs. The claim request advertises its supported
artifact count (37 in v2.48.0); older clients default to eight. A larger waiting job stays
queued with an upgrade error before a new durable claim or print attempt is made.

## Restart, reconciliation and failures

The SQLite ledger uses full synchronous durability and stores immutable job IDs, each pass,
the local recipe fingerprint, submission intent, event IDs and spooler IDs. Before `lp`:

1. Download to a private temporary file with a bounded streaming read; check declared size,
   PDF signature and SHA-256, fsync and atomically rename it.
2. Commit local submission intent, then record `submitting` with CLC.
3. Only a fresh server acknowledgement permits one `lp` invocation. A replayed submission
   acknowledgement enters reconciliation instead of printing.
4. Record the returned CUPS job ID locally before reporting acceptance to CLC. Report
   completion only when CUPS explicitly supplies completed state 9.

A crash or lost response around submission leaves an uncertain outcome. The worker searches
CUPS for the exact deterministic unique title and checks the recorded job ID. macOS
`lpstat` does not reliably display job titles, so the companion cross-checks its queue IDs
with native `ipptool`'s structured, read-only Get-Jobs result. A missing record, expired
history, multiple matching titles or conflicting job ID stops the station; absence is never
treated as success or permission to reprint. Keep CUPS job history available long enough
for recovery. [Apple CUPS source](https://github.com/apple/cups/blob/master/systemv/lpstat.c)

Canceled/aborted CUPS jobs also block the station for paper inspection. After checking the
physical output, clearing the feeder and manually canceling any remaining unsafe CUPS jobs,
stop the foreground worker (or unload its login agent) and explicitly release the blocked job:

```bash
python3 companion/mac/clc_print_station.py release JOB_ID --paper-cleared
```

This records an abandoned reconciliation with explicit paper clearance and releases the
station; it never resubmits the uncertain job. A rejected request with no physical passes
is recorded as a pre-submission failure. Any replacement printing must be an
explicit new CLC request after inspecting what actually
printed. Network/report retries reuse durable event IDs. Recipe or queue changes during an
active job are rejected; restore the original settings to finish that job consistently.
The fingerprint includes the companion's fixed page settings as well as local driver
options. Finish or reconcile active batches before updating the companion. Versions before
2.44.2 omitted landscape and fixed settings from the fingerprint; old in-flight records
will stop under the new code rather than silently change orientation. Use the prior version
to reconcile those batches first; never erase receipts or rewrite fingerprints to resume.

PDF limits default to 1 GiB per artifact and 2 GiB per job. Hashing and downloading stream
in 256 KiB blocks. Completed/failed local PDF directories expire after seven days; active,
uncertain and awaiting-refeed files are retained. Job/pass/event tombstones remain in the
ledger to prevent duplicate submission. Do not delete the ledger to retry a print.

## Optional start at login for a source checkout

Use an absolute Python executable and keep this checkout/path stable. The following command
only writes a user LaunchAgent plist; it does not load launchd or contact the printer:

```bash
python3 companion/mac/clc_print_station.py write-launch-agent --output "$HOME/.config/clc-print-station/local.clc.print-station.plist"
```

Review the generated file after completing the proof. To enable it yourself:

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp "$HOME/.config/clc-print-station/local.clc.print-station.plist" "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.clc.print-station.plist"
```

To stop it:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.clc.print-station.plist"
```

The agent runs when this Mac user is logged in. Sleep/offline time leaves jobs queued on
CLC. Logs are in the configured private state directory; rotate them as part of local
maintenance. Changing the checkout location requires regenerating the plist.

## Protocol and tests

The companion uses Bearer station authentication on `/api/print-station`: `POST /claim`,
artifact `GET`s from same-origin URLs, and idempotent `POST /jobs/:id/report` events.
Claims include immutable manifest SHA-256, recipe ID, PDF sizes/hashes/page maps and durable
pass states. A PDF download-only job is never claimed. Lease heartbeats retain the claim;
submission/manual-refeed/uncertain states are never automatically requeued for printing.
The companion refuses external download origins and all HTTP redirects, keeping its token
on the configured CLC origin. [CUPS command options](https://www.cups.org/doc/options.html)

### CLC station controls

Open **Print Station** in CLC to see this Mac's heartbeat, printer check, version, proof
flags, active batch and recent events. Authorized household print users can pause/unpause
and confirm the exact waiting DFC batch has been flipped and reloaded. Administrators have
version controls when a managed installation is available; a source checkout reports those
as unsupported. The existing CLI controls remain available.

`run` now reports setup health even with `recipe_verified: false`. It does not claim jobs
or submit pages until the local recipe is verified and the station is unpaused. A failed
management heartbeat blocks fresh claims/submissions; submitted jobs retain their original
reconciliation path. The Mac has no inbound control listener and does not enable printer
sharing. Proof flags, queue and Epson options cannot be changed remotely.

Controls arrive through `POST /api/print-station/heartbeat` alongside status, recent bounded
events and durable receipts. Pause/refeed changes and their receipts commit together in the
local ledger. Replays never reapply a control, and changed payloads under the same ID are
rejected. Refeed includes the current job and back-pass artifact. Controls expire after
five minutes; a delivered control's late receipt still records what actually happened.
The local ledger retains control tombstones and the latest 200 diagnostic events. Version
changes require no active local batch, preserve the ledger/configuration and leave printing
paused until an operator unpauses. Never remove receipts to force an update or reprint.

```bash
python3 -m unittest discover -s companion/mac -p 'test_*.py'
```

Tests use fake HTTP responses, a fake spooler and temporary ledgers. They cover crashes at
the submission boundary, replayed authorization, lost acknowledgements, unknown history,
duplicate titles, DFC refeed, process locking, exact options, hash/size checks and token
permissions. Where `ipptool` exists, one test runs only that read-only command against a
disposable loopback IPP fixture to validate the actual native plist contract. No test sends
anything to cupsd or a real printer. The suite also runs on Linux CI without CUPS installed;
the native IPP test is skipped when `/usr/bin/ipptool` is unavailable or not executable.
