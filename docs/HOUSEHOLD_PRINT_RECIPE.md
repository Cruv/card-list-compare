# Household print reference — updated 2026-09-09

Status: the Windows process below is the accepted reference. CLC now implements PDF
generation and the native Mac companion. The Mac driver and a matching GUI preset were
configured on 2026-09-09. The first Mac page printed, but the owner rejected its colors;
color/cutter/duplex proof remains outstanding. See
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

Remaining operational inputs: the actual Studio cutting template, the opened two-sided
preset with its binding/page order/flip instructions, rear-feeder practical stack capacity,
and the intended CLC/printer-bridge hosts. These do not block image/comparison maintenance
or downloadable-PDF implementation.

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

Weak/missing magenta is a diagnostic possibility, not an established cause. Next run the
printer's own **Maintenance → Print Head Nozzle Check** using plain paper in lower
**Cassette 2**, inspecting every pattern, especially magenta. This separates ink delivery
from the Mac/PDF path before changing profiles or repeating a full card sheet.
[Epson ET-8550 nozzle-check instructions](https://files.support.epson.com/docid/cpd5/cpd59879/source/printers/source/ink_functions/tasks/et8500_8550_l8160_l8180/checking_nozzles_lcd_et8500_l8180.html)
If the pattern is complete, compare the renderer/color path next. No nozzle check,
cleaning or additional print has been performed as part of this diagnosis. Both companion
proof flags remain unapproved.

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
alignment proof remain required. No card PDF was submitted during this setup; Epson's
completed Supplies Levels query was the only observed spooler entry.
