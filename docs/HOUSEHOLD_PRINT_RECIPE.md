# Household print reference — updated 2026-09-11

Status: the Windows process below is the accepted reference. CLC now implements PDF
generation and the native Mac companion. The Mac driver and a matching GUI preset were
configured on 2026-09-09. The first Mac page printed, but the owner rejected its colors;
the owner subsequently cleared the yellow/magenta clogs and **accepted the Adobe Mac color
test and corrected companion sheet**. The v6 cutter and manual duplex proofs remain
outstanding. See
[PRINT_WORKFLOW.md](PRINT_WORKFLOW.md). Preserve this reference across upgrades.

**Updated decision:** the owner has approved adopting **v6** for the new integration.
Use the matching v6 Studio cutting template and verify a first sheet; reproducing v4 is
no longer a requirement. The container generates PDFs, and a native Mac companion is the
implemented Epson submission path. The Windows settings below remain the color reference.

## Equipment and workflow

- Epson ET-8550, **Rear Paper Feeder** (the driver's exact source name).
- Uinkit double-sided glossy inkjet paper, Letter 8.5 × 11 inches, 200 gsm / 54 lb;
  the product listing supplied by the owner states 9.5 mil thickness.
- Silhouette Cameo 5 Alpha. Existing command uses the generator's default three marks;
  retain that recipe until its Studio template/machine selection is verified.
- Print ordinary cards as fronts only. Generate double-faced cards separately with both
  faces, then manually flip/reload through the rear feeder as the printer instructs.
- Drying, lamination and cutting stay outside CLC. No drying tracking is requested.

## PDF generation

```bash
python create_pdf.py --card_size standard --ppi 600 --quality 100 --paper_size letter --crop 1mm --skip 4 --only_fronts
```

For the separate DFC batch, omit `--only_fronts`, retain the other options and supply
matching specific fronts/backs. Ordinary cards do not need generic backs. Slot 4 is a
zero-based skipped position; the inspected standard Letter layout has eight slots, leaving
seven usable cards per sheet. The 1 mm crop is the owner's known recipe; source-specific
bleed still needs checking before mixing artwork providers.

## Adobe print dialog

Source: `AdobePrintSettings_1.png` and `_2.png`. The owner prints through Adobe for the
preferred output. Exact Acrobat/Reader product/version is not visible in these screenshots.

| Setting | Captured value |
| --- | --- |
| Printer | EPSON ET-8550 Series |
| Copies / pages | 1 / All |
| Page sizing | Actual size (100%; no Fit or Shrink) |
| Orientation | Auto; preview is 11 × 8.5 inches landscape |
| Choose paper source by PDF page size | Off |
| Print on both sides | Off for this ordinary-card preset |
| Grayscale / save ink or toner | Both off |
| Comments & Forms | Document and Markups |
| Advanced: Let printer determine colors | On |
| Treat grays as K-only / Preserve Black / Preserve CMYK Primaries | All off |
| Print As Image / Simulate Overprinting / Print to File | All off |
| Discolored background correction | Off |

PostScript controls are disabled in the screenshot; do not interpret those disabled defaults
as an active PostScript pipeline. The captured color path delegates color management to
the Epson driver. No custom ICC profile selection is shown.

## Epson ordinary-card preset

Source: `AdobePrintSettings_3.png` through `_6.png`. Selected preset:
**Uinkit Non Foil 54lb**. A separate **Uinkit Non Foil 54lb - 2 Sided** preset is visible,
but its settings are not opened in the supplied screenshots.

| Setting | Captured value |
| --- | --- |
| Paper source | Rear Paper Feeder |
| Document size / output paper | Letter (8.5 × 11 in) / Same as Document Size |
| Orientation / borderless | Landscape / Off |
| Paper type | Ultra Premium Photo Paper Glossy |
| Color / quality | Color / Best |
| 2-Sided Printing / Multi-Page | Off / Off |
| Copies / Collate / Reverse Order | 1 / On / On |
| Quiet Mode / Print Preview / Job Arranger Lite | All off |
| Reduce/Enlarge Document | Off; Fit to Page, Zoom and Center inactive |
| Color Correction | Custom → Advanced → Color Controls |
| Color Mode | EPSON Vivid |
| Color adjustment method | Color Circle |
| Brightness / contrast / saturation / density | All 0 |
| Color-circle horizontal / vertical | Both 0 |
| Rotate 180° / Mirror Image | Both off |
| Bidirectional Printing | On |
| Image Options: Color Universal Print | None (disabled) |
| Emphasize Text / Emphasize Thin Lines | Emphasize More / On |
| Edge Smoothing / Fix Red-Eye | Both off |

Use the stated paper type as a driver setting, not a claim that the Uinkit stock is Epson
paper. Preserve reverse order deliberately and validate its interaction with the manual
duplex preset; page reordering in both the application and bridge could undo it.

## Color and portability implications

The current reference uses printer-managed **EPSON Vivid**, rather than a selected custom
ICC conversion. An ICC file alone cannot reproduce the entire preset. Epson documents
EPSON Color Controls and EPSON Vivid for this model's Mac printing software, which gives
us a corresponding mode to test; it does not establish an identical Windows/Mac result.
[Epson Mac color options](https://files.support.epson.com/docid/cpd5/cpd59879/source/printers/source/printing_software/mac_fy13/references/color_management_options_mac_fy13.html)

First compare the same PDF at Actual Size in Adobe on the target machine using the full
Epson driver and the captured media/color settings. Then verify the automated rendering
path against that output. A generic CUPS submission or another PDF renderer must not be
assumed to inherit Adobe's settings or reproduce its output. Keep only one color-conversion
stage; do not add a printer ICC transform before an already active Vivid driver transform.

The permanent CLC container and native printer companion now reside on the household Mac.
The container's local data directory is `/Users/cruv/docker/Stacks/mtg/cardlistcompare`;
the companion connects through `https://clc.blackbeardsvault.com/`. See the
[installation checkpoint](OPERATIONS.md#household-installation-checkpoint--2026-09-11)
for the installed companion and connected v2.49.0 household server. Test printing is
enabled locally for interface testing; physical proof results remain unverified.

Remaining physical checks are the matching v6 Studio cutting template, manual rear-feeder
flip direction and back alignment, and safe packet handling with earlier output present.
The opened Windows two-sided preset can help establish the original binding/flip sequence;
the new companion submits each face as a separate one-sided pass.

## Supplied sample

The owner supplied `Sauron.pdf` (37,794,079 bytes), SHA-256
`c9c1e448b75f978b9652f6cba011c59a8cd7ad935a6b921f2a504802461eca08`.
The original PDF and six screenshots stay outside the repository; this document stores
the settings needed for future integration without redistributing the card artwork.

Inspection confirms two ordinary-front pages, seven cards each, with the lower-left slot
omitted. Pages are 792 × 612 points (11 × 8.5 inches), each containing a 6600 × 5100 JPEG
page image at 600 PPI, DeviceRGB, 8 bits/component. There is no embedded ICC profile in the
PDF/JPEG, OutputIntent or profile metadata identifying a source/printer profile or rendering
intent. This cannot establish whether individual source images had earlier pixel edits.
Both pages are fronts, so the sample does not validate duplex alignment.

### Cutting compatibility: v4 versus latest v6

The sample footer reads **letter_standard_v4**; the latest inspected upstream generates
**letter-standard-v6**. Thresholded registration-mark pixels in the sample match the
historical v4 asset at upstream commit `fd03d1bd77fa3cceec4ded9ab31275fea8b16e51` in all
three tested mark regions. This identifies the raster template, not the actual Studio
cutting file currently loaded on the owner's machine.

| Geometry at upstream's nominal 300 PPI | Historical v4 | Latest v6 |
| --- | --- | --- |
| Card width × height, pixels | 743 × 1038 | 744 × 1039 |
| Column origins, pixels | 140, 899, 1658, 2417 | Same |
| Row origins, pixels | 231, 1280 | 228, 1282 |

The nominal card image boxes grow by about 0.085 mm each. These measurements describe
printed layout geometry, not verified Studio cutting paths. The upper row shifts upward
0.254 mm and the lower row downward 0.169 mm. Latest L-shaped registration mark bounds are
also roughly 0.42 mm larger in the thresholded raster; antialiasing affects this measurement.
The footer moves from the bottom to the right margin. Matching page size and card count
therefore do not establish compatibility with the existing cutting file.

The latest CLI has no v4 selector. `SCM_EXTRA_LAYOUTS` adds named sizes/layouts, but the
inspected schema neither replaces existing names nor accepts absolute card-slot coordinates.
Do not claim that passing the same flags restores v4. The owner has now chosen v6, so use
its matching cutting template instead of building v4 compatibility. Retain these v4
measurements as historical context. Adopting v6 does not automatically select four-point
registration: the initial v6 recipe retains `--registration 3` from the tested workflow.
Future generator updates must still validate geometry against the approved v6 recipe.

## Mac installation and saved preset — 2026-09-09

Installed Epson's signed/notarized ET-8550 driver **13.45** on macOS **26.5.2**, after the
owner accepted its license and completed local administrator authorization. The PDF/raster
filters and printer-dialog plugin include native arm64 and x86_64 code. Added the directly
advertised printer using Epson's installed software; the local queue is
`EPSON_ET_8550_Series`, with driver/PPD version 13.45, idle and accepting jobs. Printer sharing
is off. The earlier 2026-09-08 check with no queues is now historical.

The native preset **CLC Uinkit 54lb - Fronts** is saved for this printer. It was configured
through Preview's print dialog using the supplied Sauron PDF, then the dialog was canceled
without printing. This does not establish that Preview matches Adobe's rendering.

| Setting | Saved native selection |
| --- | --- |
| Size / orientation / scaling | US Letter, landscape, 100%, one page per sheet, no scale-to-fit |
| Paper | Rear Paper Feeder; Ultra Premium Photo Paper Glossy |
| Quality / color | Best Quality; Color; EPSON Color Controls; Manual Settings → EPSON Vivid |
| Corrections | Brightness, contrast, saturation, cyan, magenta, yellow all zero; red-eye/mirror off |
| Sheet handling | Reverse order, collate, all pages; automatic duplex off |
| Driver options | Bidirectional printing on; quiet mode off |

The saved preset and advertised CUPS options provide an exact starting point for the
[13.45 driver-options example](../companion/mac/epson-et8550-13.45-driver-options.example.json).
Copy this object's contents into the companion's `driver_options` only when using that
installed driver and queue. It contains advertised options, not credentials, machine-specific
print-ticket data or an installed companion configuration. Run `doctor` after copying it;
keep both proof flags false until the actual output is accepted.
The companion's read-only doctor check validated all 66 captured options against this
installed queue, confirmed it accepts requests, and read its job history successfully.
The 32 companion tests also passed. No station credentials or background worker were installed.

### First front-only Mac test — 2026-09-09

The owner loaded paper and authorized one front-only page. Submitted page 1 of the supplied
`Sauron.pdf` once through Preview with **CLC Uinkit 54lb - Fronts**, one copy and automatic
duplex off. This uses the historical v4 sample to compare rendering; it does not validate
the new v6 cutting template or the companion's command-line rendering path.

The job initially stalled at **Looking for printer** because macOS was waiting for Local
Network permission for **EPSON Printer (rastertoescpII)**. Setup and supply-level helpers
already had their own permissions; direct IPPS status queries also worked. After the owner
answered the local prompt, pausing and resuming the same unprinted job restored the
connection. No second submission was created, and no driver/color settings were changed.
See the [first-use permission guidance](../companion/mac/README.md#configure-without-printing).

Local job 3 completed at 21:16:28 local time with one impression and one sheet. The owner
confirmed the physical output and **rejected its colors**: reds/purples in the source PDF
appear yellow/green on the photographed print, while blues remain prominent. The print
ticket confirms RGB, Best quality, glossy media, rear feeder, vendor color matching,
EPSON Vivid and zero color adjustments. Job completion does not approve this recipe.

The owner then checked the nozzles and reported **yellow partially clogged and magenta
completely clogged**. This confirms an ink-delivery fault; the first sheet cannot establish
whether the Mac color recipe matches the Windows reference. The owner subsequently
reported completing nozzle cleaning and confirmed that **magenta and yellow now print
fine**. The subsequent Adobe color test was accepted, as recorded below. Keep the existing
driver/color settings for the companion comparison.
The owner also reports crushed blacks/shadow detail on Gothmog and agreed to reassess
after cleaning. Preserve this as a separate quality check; restoring magenta/yellow does
not by itself establish acceptable shadow detail. The owner authorized installing Adobe
Acrobat Reader on the Mac for a subsequent comparison with the Windows/Adobe reference.

A repeat of the same single front page with the same Preview preset would isolate the
effect of restoring ink delivery. The next submitted test instead uses Adobe, as recorded
below, so any improvement cannot be attributed to the renderer alone. Epson's nozzle
check procedure uses **Maintenance → Print Head Nozzle Check** and plain paper in lower
**Cassette 2**.
[Epson ET-8550 nozzle-check instructions](https://files.support.epson.com/docid/cpd5/cpd59879/source/printers/source/ink_functions/tasks/et8500_8550_l8160_l8180/checking_nozzles_lcd_et8500_l8180.html)
The owner handled cleaning. Both companion proof flags remain unapproved.

The GUI explicitly saved `EPIJ_CCor=3` for Vivid (the PPD default 12 has the same label),
media 92, Best quality 307, rear source 0, custom mode 3, and `Resolution=720x720dpi`.
That driver raster resolution does not change the generator's 600 PPI recipe. Media 92
is named Ultra Premium Photo Paper Glossy in Epson's US resources and Epson Ultra Glossy
in its alternate regional PPD.

The same GUI preset saved `EPIJProfileSpec=2`, `EPIJ_OSColMat=1`, `EPIJ_OSCMProf=1`, and
`EPIJ_HdofClSp=0`, alongside native `AP_ColorMatchingMode=AP_VendorColorMatching` and
`APCustomColorMatchingProfile=sRGB` metadata. These are observed Epson/Apple settings, not
evidence that a custom Windows ICC was exported or that ColorSync was chosen in the UI.
The two AP fields are not advertised CUPS options and are excluded from the example.
Do not assume CLI rendering inherits the native preset or reproduces its color processing.

Windows text emphasis, thin-line emphasis, edge smoothing and general density have no
verified equivalent in this driver's advertised controls. Do not substitute the unrelated
duplex/B&W density controls. Physical comparisons with Adobe and a separate DFC flip/order/
alignment proof remain required. No card PDF was submitted during the initial preset
configuration; the single-page test recorded above followed that setup.

## Adobe Reader on the Mac — 2026-09-09

Installed free **Adobe Acrobat Reader 26.002.21901** from Adobe's official Mac download,
after the owner completed local administrator authorization. Installer and installed app
signatures identify Adobe Inc.; notarization and deep code-signature verification passed.
The app includes native arm64 and x86_64 executables, and its package receipts match the
installed version. Reader launched successfully; no subscription or trial was started.

The installed Reader's Advanced Print Setup forces **Print As Image** on and disables its
control, with the message "Only Print As Image is currently supported from MacOS14 onwards."
**Let printer determine colors** is unchecked and disabled. The grays/Preserve Black
controls are also disabled; their displayed defaults are not evidence of active processing.
This Mac dialog cannot reproduce the Windows Adobe settings verbatim. The observed UI is
the evidence for this installed version; do not generalize older Adobe instructions to it.

Reader's **Printer…** dialog still exposes the native Epson controls. Verified **EPSON
Color Controls** selected and ColorSync unselected, with **CLC Uinkit 54lb - Fronts**,
Rear Paper Feeder, Ultra Premium Photo Paper Glossy, Best Quality, the saved Manual/Vivid
settings, zero brightness/contrast/saturation/color adjustments and duplex Off. Adobe's
image mode does not by itself establish that Epson color processing is bypassed, nor do
these selections prove Windows-equivalent output. The saved driver resolution and the
PDF's source PPI do not establish Adobe's intermediate rasterization resolution.

### Post-cleaning Adobe front-page test — 2026-09-09

After the owner confirmed nozzle recovery, submitted page **1** of the unchanged Sauron
PDF from Reader at **Actual size**, Auto orientation, one copy, grayscale off, using the
native fronts preset above. Both Adobe's page selection and the native range were set to
1–1. The native dialog's Print button returned to Adobe without creating a CUPS job;
the subsequent Adobe Print click created **local job 6 at 22:48:07**. Only one new card
job was submitted. Its receipt identifies Acrobat Reader and one rendered impression,
one copy, one-sided, RGB, rear feed, glossy media 92, Best quality 307, Vivid 3, vendor color
matching and zero color adjustments. The printer connected and began processing the job.
Local job 6 completed at **22:53:22**, with **one impression and one sheet**. The owner then
reported **"color test passed"** and requested the next phase. This establishes the accepted
Mac Adobe color reference after nozzle recovery; no additional brightness/contrast change
was needed or requested. The earlier Gothmog concern stays in the history rather than
being treated as a confirmed driver fault. Compare the companion's output with this
accepted sheet, including its reds, purples and shadow detail. This v4 sample still does
not validate v6 cut geometry or the companion's rendering path. Both companion proof flags
remain false pending their separate physical checks.

### Companion rendering comparison — 2026-09-09

After accepting the Adobe color test, the owner requested the next phase. Prepared a
single-page calibration using the companion's unchanged `Cups.args()` / `Cups.submit()`
path, the same original Sauron PDF/hash, `frontPages: [1]`, one copy and the 66 validated
driver options above. The queue was idle before submission. A separate private calibration
ledger recorded the fixed title, PDF hash, exact arguments and submission intent before
the one allowed submission; retries only reconcile its title/job ID. Neither the server
worker nor station credentials were needed, and both proof flags stayed false.

Submitted **local job 7** at **23:00:51**, titled
`CLC-PROOF-sauron-companion-20260909`. It connected and began printing. The receipt confirms
page range 1–1, one copy, one-sided Letter, no scaling, rear feeder, glossy media, Best,
RGB/720 dpi, Vivid, vendor color matching, profile 2 and zero color corrections, matching
the core Epson settings in the accepted Adobe job. It completed at **23:05:30** with one
impression and one sheet. The owner rejected its **orientation**: the landscape artwork
printed on a portrait sheet, leaving a large blank top area and clipping the right-hand
cards. Color equivalence was not separately accepted. Matching media/color options alone
does not approve the companion's rendering. Its then-current 32 automated tests passed
before submission but did not cover the missing orientation setting.

The matching upstream `cutting_templates/letter-standard-v6.studio3` was prepared locally
with its license for the next geometry proof (SHA-256
`01acc200500ac4280d072e47890aef24b56af5ff37a40127fad50deebc6087c7`). Upstream documents selecting
**Cameo 5** in Studio to use three registration marks on the Cameo 5 Alpha. This template
belongs with newly generated v6 PDFs, not the historical Sauron v4 color sheet. Original
card images are needed to validate the 1 mm crop; extracting already cropped Sauron tiles
and cropping them again would not prove the configured recipe. No cutter was operated.

### Landscape correction — v2.44.2

The companion previously supplied Letter media and no scaling without requesting landscape.
It now fixes `orientation-requested=4` on ordinary and DFC passes, as defined by
[CUPS orientation options](https://www.cups.org/doc/options.html#ORIENTATION). The `landscape`
alias and orientation overrides are reserved. Fixed page options are included in the recipe
fingerprint, preventing an upgrade from silently rotating the remaining pages of an active
batch. Epson color, paper, quality and scale settings are unchanged. Regression coverage
now checks every pass's orientation and rejects orientation changes during an active job.
An offline run through the Mac's `cgpdftoraster` with the installed Epson PPD and corrected
options produced a full-size rotated sheet containing all seven cards and three registration
marks. Decoding and visually inspecting the raster confirmed the result; its portrait-shaped
feed raster and debug log alone did not describe the artwork's actual rotation. This check
sent no printer job. The app's 486 tests, 35 companion tests, lint (zero errors), build and
both dependency audits passed for the correction.
The physical orientation/color comparison must pass before advancing to v6 cutting proof.

The offline baseline without orientation reproduced the clipped right column. The corrected
raster contained exactly one page at 100% scale; adding the alternative `landscape=true`
rotated it in the opposite direction, so retain only `orientation-requested=4`.

After the corrected preflight, submitted one fresh page-1/front-only comparison as
**local job 8 at 23:26:16**, titled `CLC-PROOF-sauron-landscape-20260909`, from the same
original Sauron PDF. It uses a new durable calibration identity and leaves job 7's receipt
intact; the failed physical proof was not retried under its old identity. The queue accepted
the job and connected to the printer. It completed at **23:32:04 on 2026-09-09** with one
impression and one sheet. On 2026-09-10, after being asked to compare orientation and color
with the Adobe reference, the owner reported **"The sheet looks good"**. The corrected
companion sheet is accepted as the visual color/orientation proof. Precise physical card
measurements and v6 cutting alignment remain separate checks; this reference is still v4.

The accepted native recipe fingerprint is
`7a917073e9373eb27f7827f06a2fa323bec64c9b01f1ac4d19b1c8c7155b6ee8`
(the recorded Epson options plus v2.44.2's fixed landscape/actual-size settings and pass
orders). Keep these settings unchanged for the v6 proof. The production worker remains
unconfigured and both proof flags remain false until v6 geometry and, separately, manual
duplex are verified.

### v6 cutting proof prepared — 2026-09-10

Generated `CLC-v6-cutting-proof.pdf` with the unchanged CLC adapter and actual cached
Silhouette Card Maker revision `4d4aa73a95e93b09676c863a1861765863398c63`. It contains one
792 × 612 point page, one 6600 × 5100 DeviceRGB image, seven fronts, three registration
marks and skipped slot 4, using the configured 600 PPI, quality 100 and 1 mm crop.
SHA-256: `7681547230ce72172b70f397f76e10d374fec9ecf48fb574a2fd4ec2c6d6d0bb`;
size: 18,216,200 bytes. Strict validation and a rendered visual review passed.

The seven names match the historical sample, but these are original name-resolved Scryfall
printings, not tiles extracted from that already cropped PDF: Demolition Field (FDN 687),
Terror of the Peaks (OTJ 149), Academy Ruins (2XM 309), Buster Sword (FIN 255), Conqueror's
Flail (2X2 302), Gleaming Overseer (MIC 151), and Gothmog, Morgul Lieutenant (LTR 87).
Source bytes, exact Scryfall IDs, URLs, hashes, copy/slot assignments, generator details
and matching Studio template hash are retained in the local proof manifest. Scryfall marks
the Gothmog source low-resolution; the 600 PPI output does not add missing source detail.
This sheet tests the v6 recipe and cutting geometry rather than matching every historical
art variant.

The proof PDF, matching Studio file, upstream license, manifest and cutting instructions
are in the household's `CLC Print Calibration/v6` folder on Storage. Its SMB mount caused
a first-attempt scratch cleanup failure after PDF validation; a fresh invocation succeeded
with container-local scratch and the final files were copied to the share. See
[the storage guidance](OPERATIONS.md#silhouette-runtime). The native print pass reads a
hash-verified private local copy, matching the companion's normal local-spool workflow.

Submitted one front-only sheet as **local job 9**, titled `CLC-PROOF-v6-cutting-20260910`,
using the accepted landscape recipe and a new durable calibration receipt. The cut proof
still needs physical measurement (63 × 88 mm), usual drying/lamination, and registration/
cut checks across both rows using `letter-standard-v6.studio3`. Use the existing proven
laminated-stock cut settings and the matching physical mat setup; no blade/force/pass
values were invented or changed. The Alpha's three-mark workflow uses the upstream's
Cameo 5 Studio selection. No cutter has been operated; manual duplex remains a later test.
