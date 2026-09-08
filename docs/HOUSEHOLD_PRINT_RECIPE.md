# Household print reference — 2026-09-08

Status: captured from the owner's working Windows process, not an implemented CLC print
feature or a validated macOS preset. See [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) for the
integration plan. Preserve this reference when testing new generator or printer versions.

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
Do not claim that passing the same flags restores v4. Keep the existing v4 cutting file as
a reference and deliberately validate the v6 cutting template, or implement and verify a
v4-compatible adapter. Automatic fetch/update must not silently activate new geometry for
an already approved recipe.

Local Mac readiness check on 2026-09-08: CUPS reports no installed printer destinations
and no default destination. The Epson queue/driver still needs configuring on this Mac
before printer-bridge proof; no printer settings were changed during the review.
