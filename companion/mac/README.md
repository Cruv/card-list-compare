# Native Mac print station

This companion polls CLC for explicitly queued print jobs and submits their verified PDFs
to one locally configured Epson CUPS queue. It runs outside Docker, uses Python 3.9+ and
macOS's native `lp`, `lpstat`, `lpoptions` and `ipptool`, and needs no Python packages.
Installing or running this code does not install an Epson driver or reproduce an Adobe
print preset. Physical printing is disabled until `recipe_verified` is explicitly enabled.

CLC generates the PDFs with Silhouette Card Maker. The companion keeps the server's card
copies, 600 PPI, 1 mm crop, Letter v6 layout, skipped slot and registration geometry intact.
It submits one copy in landscape at actual size, with automatic duplex disabled. Ordinary fronts and
DFC front/back passes are separate submissions. The local queue, media/color driver
options and page order are configured here; server data cannot supply executable paths,
printer destinations or CUPS options.

See the [household print recipe](../../docs/HOUSEHOLD_PRINT_RECIPE.md) for the working Windows
reference: Uinkit 200 gsm double-sided glossy Letter, ET-8550 rear paper feeder, Ultra
Premium Photo Paper Glossy, Best quality and printer-managed EPSON Vivid. The generated
DeviceRGB output is not an ICC-converted proof. The owner accepted the household Mac's
corrected companion sheet against Adobe on 2026-09-10. Keep its recorded settings fixed;
v6 cut geometry and manual duplex still need physical proof before enabling their flags.

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

## Dry run and normal operation

After creating the private configuration above, this command uses a local example manifest
and displays the exact argument arrays. It
never contacts CLC, claims jobs, downloads PDFs or invokes the spooler. The example hashes
and PDF paths are placeholders, not downloadable artifacts.

```bash
python3 companion/mac/clc_print_station.py dry-run --manifest companion/mac/dry-run.example.json
```

After the printer proof and configuration are complete, foreground operation is:

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
manual refeed. It records the operator's explicit confirmation that this batch has been
flipped and reloaded. The worker reports that confirmation to CLC before submitting the
back pages. No other CLC batch can interleave during this wait. Independent applications
can still submit to the printer, so keep the queue dedicated during a DFC refeed.

This adds no drying, lamination, collection or cutting tracking, and never changes a deck's
paper-snapshot marker.

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

## Optional start at login

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
