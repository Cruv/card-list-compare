# Roadmap

The committed product backlog. [CURRENT_WORK.md](CURRENT_WORK.md) is the small task
checkpoint; [CONTRIBUTING.md](../CONTRIBUTING.md) owns workflow, verification and release
procedure. This backlog does not authorize deployment or physical printing. Historical
results are linked below rather than repeated as work to do.

## Saved artwork — conflict protection implemented

Tracked-deck artwork saves now check a durable revision; stale edits and resets cannot
silently overwrite newer choices. The overlay retains an unsaved draft and offers explicit
conflict recovery. Existing generated jobs keep their frozen artwork. See
[the saved-art contract](DECISIONS.md#d9--generate-pdfs-in-clc-print-through-a-native-mac-companion).
Saved-art history and the 612-entry limit remain separate follow-ups.

## ManaSync traffic — implemented in v2.57.5

Published print plans stay idle instead of being checked individually every 15 seconds.
Visible confirmation panels use local timers; explicit/opening refreshes share one private
bulk read. Publications stop after six automatic attempts or a definitive rejection and
retain an explicit saved-plan retry. See [refresh and delivery limits](MANASYNC_BRIDGE.md#refresh-and-delivery-limits).
The Mac deployment and clean dependency audits were verified on 2026-11-05; see
[the deployment checkpoint](OPERATIONS.md#household-server-deployment-checkpoint--2026-11-05).
Existing failed uploads still need their reported permissions/storage problem resolved before
an explicit retry. The Archiver 8 migration and ZIP interruption/cleanup fixes are complete.

## Working printing path and conditional physical checks

CLC v2.58.0 adds A4 alongside US Letter. The review choice is saved with the batch and
the Mac uses it for fronts, deferred backs and recovery. Physical acceptance for the
A4 layout and flip remains separate. See the [print workflow](PRINT_WORKFLOW.md#household-recipe).

On **2026-10-15**, the owner reported several dozen pages printed successfully through the
current workflow. Source and the running container already specify `household-letter-v6` /
`letter-standard-v6`; the worker validates layout version 6 and its approved geometry.
There is no pending v6 migration. Repeating front-print calibration is not the next task
for this working, unchanged recipe. Preserve the accepted 600 PPI, 1 mm crop, Epson Vivid
and landscape settings in [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).

Cutting/registration and manual DFC flip/alignment results have not been separately
reported in this update. Keep their existing proof records/flags unchanged; check those
specific paths when first using an unproven path or changing its recipe/template. This
is conditional acceptance work, not a reason to replace or interrupt successful printing.
Use [PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) for exact-packet selection, reload and paper-reset
requirements. Printing never credits usable copies or advances the paper-deck marker
by itself. Drying, lamination and cutting tracking remain excluded.

## Household follow-ups

The [dated household checkpoint](OPERATIONS.md#household-print-jobs) owns installed versions,
completed recovery and operational safeguards. At its 2026-10-11 checkpoint, incoming Discord
commands still needed application/operator setup; the existing webhook was connected.
Repository deployment repair now makes the tracked Compose file and published GHCR image
the intended configuration source, delivered through
[PR #7](https://github.com/Cruv/card-list-compare/pull/7). A later Portainer cutover must verify
the selected published revision and preserve the current data/native state; see
[the preservation procedure](OPERATIONS.md#repository-deployment-and-registry-cutover).
The older private local-image candidate is historical preparation, not the desired final stack.
Neither item is a request to interrupt active household work or test with real jobs.

The historical orphaned snapshot was investigated and safely archived on 2026-10-15.
Its original owner/deck could not be proven; all text and metadata remain in a private recovery
archive, and the active database now passes foreign-key checks. See
[the repair record](OPERATIONS.md#historical-snapshot-repair--2026-10-15).

## Open — reviewed 2026-11-18

Reviewed the React client, Express routes, sql.js persistence, ManaSync integration, PDF
worker, Mac station and delivery checks. The findings below are open. Reproductions used
disposable databases, fixture APIs, synthetic PDFs and fake printer responses.

### Correctness and recovery

- **P1 · Account expiry and lockout.** Login writes an ISO timestamp and appends another
  timezone suffix on read, which prevents enforcement of the account lock. Concurrent
  failures can overwrite one another's counts. Password-reset and verification queries
  compare unlike timestamp formats, allowing same-day expired links. Make counters and
  single-use token consumption atomic and compare a single timestamp representation.
  [Auth routes](../server/routes/auth.js)
- **P1 · Failed deck updates can commit partial changes.** A disposable PATCH returned
  HTTP 400 after saving notes and replacing the existing tags with only the first new tag.
  Validate the whole patch first and commit all field and tag changes together.
  [Deck PATCH](../server/routes/decks.js#L152)
- **P1 · A canceled CUPS job can keep the station reserved.** Removing an exact canceled
  job from the fake spooler's history left the station in `awaiting_clearance`. Both paper
  clearance and the documented release failed. Add an explicitly confirmed recovery for
  missing history that preserves the original submission and clearance receipts.
  [Mac station](../companion/mac/clc_print_station.py#L1129)
- **P2 · A missing PDF can block the whole print queue.** With a missing first artifact
  and a valid second job, consecutive claim requests returned 410 for the same first job.
  Isolate proven unsubmitted failures and expose an explicit recovery for reserved or
  uncertain jobs. [Claim logic](../server/lib/printQueue.js#L555)
- **P2 · Price refresh can stamp a newer version with an older price.** A delayed fixture
  priced Lightning Bolt, then stored its result on the newer Counterspell snapshot. Attach
  price results to the captured snapshot ID and update the deck summary only if that
  snapshot is still current. A separate fixture also saved $750 as a full price after
  the final $10 card lookup failed. Require complete results before saving totals or
  sending price alerts. [Price calculator](../server/lib/priceCalculator.js#L117)
- **P2 · Browser responses can overwrite or expose stale state.** Chrome fixtures reproduced
  a wrong current password logging the user out, a delayed URL import replacing a newer
  manual edit, and a missing share still displaying a previous share's results. Scope
  session invalidation, imports and shared views to the request that still owns the UI.
  [API client](../src/lib/api.js#L53), [import](../src/components/DeckInput.jsx#L99),
  [shared comparison](../src/App.jsx#L171)
- **P3 · Cached artwork counts twice in generation progress.** Two cache hits gave
  `completed: 4` for a two-image job. Count each successful face once.
  [Image preparation](../server/lib/scryfallImages.js#L335),
  [progress serialization](../server/lib/printBatchHistory.js#L16)

### Performance

- **P1 · Large valid print comparisons monopolize the Node event loop.** Two disjoint
  5,000-line lists inside the standalone request size limit took about 7 seconds in the
  local planning function. Index existing copies by normalized name before matching
  quantities. Preserve the exact-printing matches and the existing consumption order.
  [Print planning](../server/lib/printQueuePlan.js#L33)
- **P2 · PDF verification and heartbeats stall unrelated requests.** A synchronous 1 GiB
  artifact check blocked the event loop for about 410 ms. A native heartbeat on a
  67.5 MB disposable database took 43–52 ms and added a permanent event per poll.
  Move artifact hashing to a bounded asynchronous path with state rechecks. Coalesce
  lease renewals while preserving durable physical decisions.
  [Artifact validation](../server/lib/printQueue.js#L89),
  [station reports](../server/lib/printQueue.js#L612),
  [database persistence](../server/db.js#L707)
- **P2 · Prepare polls full print history every four seconds.** A ManaSync fixture error
  temporarily hid a successful print-history response. Poll an active-job summary while
  the view is visible, fetch history on demand, and handle the two sources independently.
  Show when ManaSync confirmation quantities were last refreshed so the one-minute
  remote-read cache is visible when a confirmation was made in the other app.
  [Print panel](../src/components/PrintPanel.jsx#L193),
  [ManaSync refresh limits](MANASYNC_BRIDGE.md#refresh-and-delivery-limits)
- **P2 · Deck details fetch the entire library and wait for Scryfall.** Opening a deck
  also serializes unrelated decks, tags and snapshot metadata. A Chrome fixture delayed
  Scryfall by 2.5 seconds and held back saved card text for the full delay. Use a
  deck-scoped read and render saved text immediately while metadata loads.
  [Deck detail](../src/components/DeckPage.jsx#L164), [library API](../server/routes/decks.js#L20)
- **P2 · Large PDFs have a high memory cost.** The worker retains compressed pages for
  the whole artifact. An eight-sheet fixture produced a 149 MB PDF with about 185 MB
  peak worker RSS. The browser also buffers an authenticated PDF before starting the
  download. Investigate disk-backed or smaller artifacts and authenticated native
  browser downloads with progress.
  [PDF worker](../server/lib/printGeneratorWorker.py#L485),
  [download](../src/lib/api.js#L528)
- **P3 · The legacy ManaSync deck listing scales with all history.** In a seeded
  100-deck fixture with 25 snapshots and 100 card lines per snapshot, serialization
  produced about 57 MiB of JSON in 299 ms and used about 125 MiB of additional heap.
  On the same fixture, the new `include=latest` response was 0.32 MiB in 10 ms.
  Use that option for routine mirroring and keep the full response for history readers.
  [Integration deck listing](../server/routes/structuredDecks.js),
  [snapshot serialization](../server/lib/structuredSnapshots.js)

### Product enhancements

- Preview URL and paste imports before applying them. Show the included and ignored
  rows, exact versions, unsupported finishes and a summary of changes. Offer undo.
- Offer a one-sheet proof download for each paper preset, with crop and bleed checks
  and a short setup checklist. Keep proof confirmation tied to the exact paper recipe.
- Give print operators one place to inspect recent progress, identify why the queue
  stopped and select the exact safe recovery already available for each job.
- Add owner controls for comparison share links, including revocation and optional expiry.

## Open — reviewed 2026-09-12

These items were recorded by the 2026-09-12 review; reassess the relevant source before
starting one. [PROJECT_REVIEW.md](PROJECT_REVIEW.md) preserves that review's findings;
older detailed security audits remain local.

**Product / features**

- **Share links**: add owner-side revocation for comparison links and optional expiry for
  both link types. Tracked-deck links already have owner-side revocation.
- MTGGoldfish/TCGPlayer imports: handlers are documented, but still need live end-to-end
  verification; source access restrictions may prevent individual imports.
- Invite-code expiry is checked but can't be set in the UI.

**Comparison and image correctness**

- MPC ZIPs deduplicate identifiers, XML exports do not encode paired DFC backs, and art
  overrides are per card name. The dedicated PDF adapter now preserves physical copies, face
  pairing and immutable art identity. Source-specific crop/bleed calibration remains part
  of the physical proof; the initial adapter preserves the owner’s 1 mm crop.
- Saved-art history and the 612-entry limit remain separate follow-ups; conflict-safe saves
  are implemented above. Pending drafts belonging to other editors are retained conservatively
  so recovery cannot erase active work. A fresh tab can offer an older orphan draft again;
  add explicit draft selection/cleanup with history work rather than guessing another tab is closed.

**UI polish**

- Large authenticated PDF downloads currently become browser blobs before saving. Consider
  streamed browser downloads for memory-constrained phones; the native station streams now.
- Consider virtualizing the deck list for very large deck lists (not currently a
  measured problem).

**Housekeeping**

- Consider an owner-approved routine for release tags (`vX.Y.Z`). The workflow already
  publishes semver images for requested tags; changing the default tagging practice would
  be a policy decision. Follow [CONTRIBUTING.md](../CONTRIBUTING.md).

## Direction

- Engineering conventions originally borrowed from WarSlate now follow CLC's own
  [contribution procedure](../CONTRIBUTING.md); sibling-project rules are not independent gates.
- Future: TapTogether/playgroup features were scaffolded then removed; revisit only with a
  concrete plan.

ManaSync owns collection management, purchases, locations and allocations. CLC's one-original
ownership policy does not reduce print quantities or introduce reservations/exact-printing
ownership requirements. Generating/spooling and confirming usable copies remain separate.
Legacy collection rows are retained without an automatic migration; any migration needs a
deliberate plan. See D8/D10 in [DECISIONS.md](DECISIONS.md) and the implemented
[bridge](MANASYNC_BRIDGE.md) / [deck proposal](MANASYNC_PROPOSALS.md) contracts.
Vendor, ManaBox and offline companion work belongs in ManaSync; the
[original conversation](MANASYNC_INTEGRATION.md) is historical context.

## Completed work and evidence

- [Project review](PROJECT_REVIEW.md): v2.43.0 completeness prerequisite and the September 12
  review; earlier maintenance/security releases remain in Git history and the decision log.
- [UI capability map](UI_REDESIGN_INVENTORY.md): task organization and dated September 12
  browser results, with no native-iOS or physical-print proof implied.
- [ManaSync acceptance](MANASYNC_REVIEW.md): completed September 11 paired HTTP/browser
  checks, exact revisions and scope. Repeat relevant paired verification when a contract
  changes; the successful historical run is not a standing task or a deployment claim.
- [Operations](OPERATIONS.md#household-print-jobs): household rollout/recovery evidence and
  current operational procedure, separately from source feature availability.
