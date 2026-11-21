# Current work checkpoint

## Explicit paste review and US Letter Dahle

- v2.68.2 uses 0.28 mm lime strip lines and 0.40 mm lime R3 arcs on A4 and Letter. The cut positions, corner clearance and 63 × 88 mm artwork scale carry forward from v2.68.1.
- v2.68.1 extends guided strip cuts to 3.2 mm from both paper sides. Each line keeps one width through the artwork and side margins. Marked Letter identification fits between the cuts in the side margin. Synthetic bleed skips the outermost source pixels when reflecting the artwork, avoiding a doubled edge line at the cut.
- v2.68.0 starts from `cf2063b`. Compare and standalone Print preserve native paste focus, caret and undo. The import report opens with **Review import**. The Library paste dialog and the URL and file imports retain their review steps.
- The PDF-only Letter preset fits nine 63 × 88 mm cards at 1.5 mm bleed per edge, with 215.9 × 91 mm strips, side labels and a vertical proof scale. Use the [Letter cut positions](DAHLE_A4_PUNCH.md#layout-and-hardware-evidence) and check the guide visibility on the intended stock before a batch.
- On November 20, 2026, local checks passed on Node 22 and the pinned Python worker runtime. They covered 1,568 JavaScript tests, 23 PDF worker tests, 290 portable companion tests, the production build, deployment contract and both dependency audits. Lint reported five existing warnings. Disposable Chrome checked paste, new batches, paper proofs and saved-batch regeneration. The real worker smoke covered both Dahle presets; physical proof remains pending.

## Wider Dahle bleed

- v2.67.4 gives new and regenerated Dahle PDFs and paper proofs 1.5 mm of bleed per edge. A4 still fits nine 63 × 88 mm R3 cards, with 3 mm between finished outlines and four cuts for 210 × 91 mm row strips. Earlier PDFs use the geometry printed on their sheets. See the [cutting measurements](DAHLE_A4_PUNCH.md#layout-and-hardware-evidence).
- The front lime arcs retain their die-relative clearance and the cyan cut lines follow the wider strips. The 91 mm feed, last-card grip and physical alignment still need a proof on the intended stock before sizing a fixed bushing.
- Disposable Chrome exercised new reviews, proofs and alternate layouts. The real worker rendered both proof variants and generated eight duplex copies with 66 × 91 mm artwork clips and mirrored backs. JavaScript, PDF worker and portable companion tests, the production build, deployment contract and both dependency audits passed. Lint reported five existing warnings.

## R3 die-window alignment

- v2.67.3 puts the lime arcs close enough to the finished outline for the die to hide them when centered. They print on fronts, where the operator looks through the opening. Cyan strip lines print on both faces. See the [procedure and clearances](DAHLE_A4_PUNCH.md#optional-strip-and-punch-guides).
- In a 2,400 dpi render with a nominal 63 × 88 mm R3 aperture, centered cards hid all lime. A 0.35 mm shift exposed lime in each of eight directions, including after a modeled 0.75 mm inward trim at both long strip edges. The v2.67.2 marks stayed hidden under the same shifts. The real die and stock still need their first proof.
- Worker checks kept unmarked and legacy PDF bytes, front and back artwork streams, and cyan cut positions. Disposable Chrome verified the proof and batch reviews. The real worker regenerated eight paired copies while preserving the original files and simulated receipts.

## Dahle guide visibility

- v2.67.2 changes the strip lines and margin end marks to cyan with dark outlines and increases the lime R3 stroke from 0.32 to 0.52 mm. The four strip cuts, 63 × 88 mm R3 trim and artwork placement match v2.67.1. See the [guide geometry](DAHLE_A4_PUNCH.md#optional-strip-and-punch-guides).
- On the same synthetic artwork at 600 dpi, the strip line center contrast against near-black rose from 1.12:1 to 12.16:1. The new arcs contained 44% more solid lime pixels. On that fixture, all solid lime survived clipping 0.75 mm inward from both long edges of each strip.
- Off and legacy output matched v2.67.1 byte for byte. Browser and PDF worker verification used disposable data, synthetic artwork and fake printer effects. Physical visibility and alignment still need a proof on the intended stock.

## Dahle strip and R3 punch guides

- v2.67.1 adds four straight guides for cutting 210 × 90 mm strips and rounded guides for centering each R3 punch to new Dahle reviews, regenerated batches, and proofs. Existing requests retain their original strip index marks. See the [guide dimensions and proof steps](DAHLE_A4_PUNCH.md#optional-strip-and-punch-guides).
- The PDF worker tests cover strip boundaries on partial sheets, matching artwork placement, mirrored corner guides and the 0.75 mm combined displacement model. Identical unmarked and legacy fixture inputs produced byte-identical PDFs against v2.67.0.
- The one-sheet proof shows four continuous black cut lines with bold end marks at 13.5, 103.5, 193.5 and 283.5 mm from the top. The R3 arcs use a lime center twice as wide as the original draft stroke. Nominal ink clearance is 0.78 mm from the straight trim and 0.80 mm from the R3 trim.
- Disposable Chrome verified new batches, regenerated PDFs, lost-response retry, per-recipe proof downloads and setup scroll on desktop and mobile. The real worker generated eight paired copies in the new layout. It preserved all five original batch files and six simulated print receipts, and no batch was sent to a printer.
- Local verification passed 1,554 JavaScript tests, 290 portable companion tests, 20 PDF worker tests, the production build and the deployment contract. Lint reported five existing warnings. Both dependency audits found zero vulnerabilities.
- The household stack was outside verification. Guide visibility and physical cut alignment still need the actual die and stock.

## Dahle die-cutter alignment marks

- v2.67.0 adds a default-off Dahle option to new batches, alternate layout reviews, and one-sheet proofs. Its strip index marks use the 2 mm scrap at card boundaries and stay at least 6 mm inside the long strip edges.
- Disposable Chrome and the real PDF worker checked new and regenerated batches and separate proof keys. Digital checks covered eight paired copies, a partial row and mirrored backs. Artwork streams, clip and placement transforms, and row-cut ticks matched the unmarked PDFs. The test confirmed preservation of the original batch files, simulated receipts, and confirmation record.
- Local verification passed 1,547 JavaScript tests, 290 portable companion tests, 17 PDF worker tests, the production build and the deployment contract. Lint reported five existing warnings. Both dependency audits found zero vulnerabilities.
- The household stack is outside this change. Physical alignment and guide visibility depend on the actual die and stock.

## Saved batch layouts and Print setup scroll

- v2.66.0 starts at `6ca35a3`. Alternate layout generation uses the owned batch’s frozen cards, artwork hashes, and paired faces. It creates a separate PDF batch and preserves the source confirmation and print receipts. See [Print workflow](PRINT_WORKFLOW.md#preparing-cards-and-following-batches).
- Chrome reproduced the static-content click jump from 3,674 to 58 px on desktop and 5,238 to 53 px on mobile. The fix kept the original positions. The [scroll fixture](../tests/browser/print-setup-scroll.mjs) also checks the layout picker, saving the default, keyboard focus, and intentional navigation.
- A Chrome run with disposable data and the real PDF worker changed eight paired copies from two US Letter packets to one Dahle A4 packet. It preserved both source artwork hashes, all five source files, six simulated print receipts, parked backs and the original confirmation plan. Household activation and physical printing require separate authorization.
- Local verification passed 1,538 JavaScript tests, 290 portable companion tests, 14 PDF worker tests, the production build and the deployment contract. Both dependency audits found zero vulnerabilities. Lint reported five existing warnings.

## v2.65.2 audit follow-up

- v2.65.3 addresses the three findings from `e461625` in one PR. See the [audit follow-up](ROADMAP.md#v2652-audit-follow-up) for reproductions and verification.
- Browser checks use intercepted APIs and disposable state. Household activation and physical acceptance require separate authorization.

## v2.65.1 audit follow-up

- v2.65.2 fixes the three findings from `569367b`. The [audit follow-up](ROADMAP.md#v2651-audit-follow-up) records the reproductions and verification. Earlier roadmap items remain separate.
- Browser fixtures check exact draft bytes, compact print polling, and shared sign-in state. Household activation and physical acceptance require separate authorization.

## Final v2.65.0 audit follow-up

- v2.65.1 fixes the five findings from `c0f95ae`. The [audit follow-up](ROADMAP.md#final-v2650-audit-follow-up) records the failures and evidence. The earlier roadmap items remain separate.
- Browser and HTTP fixtures use isolated state and fake external effects. Household activation and physical acceptance remain separate.

## November 18 audit implementation

- Started from `23e15f4`. [PR #21](https://github.com/Cruv/card-list-compare/pull/21)
  contains the integrity stage `6f0606d` and the performance and browser stage `7b02911`.
  The latter passed the PR workflow for both Docker architectures.
- The audit record in [ROADMAP](ROADMAP.md#november-18-2026-audit) tracks the fixtures,
  measurements and externally owned follow-up. Source changes and CI use disposable
  state and fake printer and provider effects. Physical proof and household activation
  require separate authorization.
- v2.65.0 passed the complete local release checks and paired HTTP verification with
  ManaSync `f6d4241`. PR and main workflow records track the exact hosted checks.
- Local `output/` is unrelated to the audit and remains outside Git.

## Branch consolidation and project review

- Dahle PDF support was already integrated through [PR #20](https://github.com/Cruv/card-list-compare/pull/20)
  at `2586601` (v2.63.0). The v2.64.0 merge brings the outstanding
  [ManaSync patches](https://github.com/Cruv/card-list-compare/pull/6) onto that baseline.
  It preserves exact print receipts and existing publication limits. Only canceled manual
  items without artwork, operations or pending plans can age out automatically.
- On 2026-11-18, the v2.64.0 code at `61b69fc` passed 1,419 JavaScript tests, 287 portable
  companion tests, 12 PDF worker tests, the production build and Compose contract.
  Both npm audits found zero advisories. Lint passed with five existing React warnings.
  Chrome covered confirmation retries, the etched comparison warning, Dahle PDF-only
  controls and public offline navigation. The scoped HTTP pairing with disposable
  ManaSync verified deck reads, proposal replay and the lost-receipt path.
  [The audit record](ROADMAP.md#november-18-2026-audit) tracks the findings and fixes.
- The source review used disposable databases, synthetic artwork and PDFs, and fake
  provider and printer responses. Physical Dahle feed, trim, punch and duplex acceptance
  require the separate proof in [the Dahle guide](DAHLE_A4_PUNCH.md#one-proof-before-a-batch).

## Bulk artwork changes in print review

Collect art choices across several cards and use **Review updated list** once.
Choices marked **Also save to this deck** share one checked deck update. The
same review refreshes the print plan using the saved version.

Tests cover atomic saves, simultaneous printing swaps, and conflict recovery.
Chrome verified three consecutive picks, a mixed deck and batch-only save,
and a failed preview retried without saving the deck twice.

## Save artwork from print review

The art picker can save a selected Scryfall printing in a new version of the
current tracked deck. The owner may clear the save checkbox to keep a batch-only
selection. The write uses the snapshot ID and text hash as its conflict check,
and the print review follows the newly saved version after a fresh review.
Chrome checks with fixture APIs covered the deck save, batch-only and historical
choices, concurrent saves, and recovery when snapshot retention removes a baseline.

## A4 grain direction

New batches offer Crowned A4 Portrait 3×3 and 3×2. In both layouts the
cards' short edges run parallel to the paper's 210 mm edge. New print
requests no longer offer Standard A4 Landscape or Crowned A4 Landscape 2×4.
Old browser preferences and editable drafts select Portrait 3×2. Exact
requests already sent and saved batches keep their original paper and recipe.

On 2026-11-16, the JavaScript and portable companion suites, production build,
deployment contract, and dependency audits passed. Chrome checks with fake APIs
covered the new picker, an old draft, a saved PDF and an exact request retry.

## Crowned A4 Portrait 3×2

CLC 2.60.0 adds a six-card portrait preset. It uses the two upper rows of the
Crowned A4 portrait grid and keeps cards off the trailing third of the sheet.
Existing batches keep the layouts and print settings they were created with.
The Mac companion 2.60.0 checks the installed Epson driver locally, so printer
discovery can no longer stall verification of its options.

The six-card layout needs its own physical Epson, Cameo registration and refeed
checks. The registration marks still use the full paper size.

## Saved Crowned A4 Landscape 2×4 batches

CLC 2.59.1 introduced the standard centered A4 v5 layout for Crowned Landscape.
The matching upstream Studio file contains four upright cards across and two rows down.
The alternative centered R13 DXF uses eight closed rounded rectangles. The Mac uses a
landscape A4 ticket through its rear feeder with Thick Paper and bidirectional printing off.
See [the print workflow and template downloads](PRINT_WORKFLOW.md#crowned-a4-landscape-24).

The shifted 2.59.0 PDFs keep their original layout and ticket. The centered layout
needs a separate physical Cameo registration and refeed check.

## Mixed print sheets and refeed labels

CLC and the Mac companion 2.59.0 add shared sheets for new mixed batches. Fronts with
backs print first with single-sided copies filling open slots. The front margin says
**REFEED FOR BACK** beside the packet label. The saved back page leaves the single-sided
positions blank. Older jobs keep their PDFs and saved pass order. See
[the print workflow](PRINT_WORKFLOW.md#double-faced-packets-and-flip-alerts).

Local verification covered JavaScript and native tests, browser preview and refeed
controls with fake external effects, and actual PDF generation against cached upstream
revision `0da09b729814` for Letter, A4 and Crowned A4. The Crowned 8+1 test produced
one sheet with nine fronts and one aligned reverse face. Physical feed and alignment
on this mixed layout still need a separate check.

The household verified server and companion 2.59.0 before the centered layout update.

## A4 and US Letter printing

The v2.58.0 source adds a browser default and a paper-size choice in print review. Each
batch keeps its size through PDF generation, physical claims, deferred backs and recovery.
Legacy batches retain Letter. Direct A4 printing requires companion 2.58.0 and a matching
local stock setting. Setup and separate A4 physical checks are in the
[Mac companion guide](../companion/mac/README.md#configure-without-printing).
The household cutover and physical A4 confirmation remain separate.

The Crowned A4 option adds nine-card portrait sheets and a separate Epson stock preset.
It uses the rear feeder, thick-paper mode and actual size. Verify registration on one
sheet and check the manual flip with a fully dried front before printing a batch.

## Repository and registry history

Repository-owned deployment and native publisher repairs are implemented. Source delivery
is tracked by [PR #7](https://github.com/Cruv/card-list-compare/pull/7) (integrated as `4d58f3e`)
and [PR #8](https://github.com/Cruv/card-list-compare/pull/8) (native publisher). On 2026-11-05
the owner authorized merge after passing CI and GHCR publication, holding Mac cutover.
The PR/main workflow and registry receipts own the changing publication status.

- **Repository contract:** canonical Compose consumes GHCR without implicit local builds;
  existing data/name/project/network/port/permissions/timezone and private settings are runtime
  inputs. Missing bind paths fail rather than initializing an empty database. Both Compose
  2.40.3 and 5.5.0 passed, including unsafe-bind rejection; independent review closed.
- **Publisher repair:** the first main publication (`42103840301`) was canceled after both
  ARM npm stages crashed under QEMU and stalled; no exact-main registry tag was present.
  Native AMD64/ARM64 jobs now verify their hardware, retain target dependencies and pass
  digest receipts to a guarded final manifest job. Both same-run/source results are required.
  PRs never publish. API failure fails closed; older reruns cannot move current main/latest.
  Existing tests/audits/lint remain mandatory and jobs have explicit time limits. No app,
  dependency, Dockerfile, native recipe or product-version change accompanies this CI repair.
- **Verification (2026-11-05):** actionlint, 16 synthetic publishing scenarios and 50 invariants
  passed. Native PR run `42109818823` for `2830659` passed hosted app/companion tests, audits,
  deployment checks, lint and both native image builds; publication was correctly skipped.
  Independent publication-boundary review closed. Documentation-only follow-up can reuse
  unchanged workflow/code evidence; exact selected main publication must still be verified.
- **Registry cutover:** on November 9 the owner applied the GHCR `latest` stack through
  Portainer. The deployed v2.57.5 image matched `d329647`. Local and public health,
  frontend bytes, database integrity and native reconnection passed. Keep the full
  data directory, keys, existing stack identity, private runtime values and native
  print receipts for later updates. See
  [the procedure](OPERATIONS.md#repository-deployment-and-registry-cutover).
- **Handles:** no active disposable local backend/browser tab. CI watches/logs are outside
  Git; canceled logs retain the QEMU diagnosis. No foreign or paused implementation edits.
