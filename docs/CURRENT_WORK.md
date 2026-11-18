# Current work checkpoint

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
