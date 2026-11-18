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

## November 18, 2026 audit

The original findings are recorded at [`23e15f4`](https://github.com/Cruv/card-list-compare/blob/23e15f4/docs/ROADMAP.md). The fixes and product work are in [PR #21](https://github.com/Cruv/card-list-compare/pull/21). Reproductions and comparisons used disposable databases, fake providers and printers, and synthetic artwork.

### Account, data and print recovery

| Original failure | Fix and verification |
| --- | --- |
| A saved lock allowed a correct password, concurrent failures lost counts, and same-day expired links or repeated reset use were accepted. | Account expiry comparisons use UTC and handle old SQLite timestamps. Concurrent checks re-read current login state, and token use commits with the password or verification update. HTTP tests cover lockout, expiry, replay and rollback. |
| A wrong current password and an old 401 both removed the browser session. | Credential failures keep the current session. An invalid-session response can clear only the exact token sent by its request. API fixtures cover late and current responses. |
| A rejected deck PATCH saved notes and only part of the requested tag replacement. | Full validation precedes the transaction. HTTP tests cover rejected input, combined updates and rollback after a simulated write failure. |
| A delayed price was written to a newer deck version. An incomplete lookup saved $750 where the complete fixture totals $760. | Pricing uses the captured version and exact available printings. Only complete data for a still-current snapshot updates the deck summary and alert baseline. Tests cover changed versions, failed and incomplete lookup batches, and alert suppression. |
| Missing CUPS history kept a canceled job reserved after paper clearance. | The companion can explicitly clear the same canceled job when a fresh active lookup proves its exact CUPS ID absent. The operator still clears the feeder and confirms paper. Fake station tests cover unavailable or active CUPS evidence, exact command binding, and retained submission and clearance receipts. |
| A missing or corrupt queued PDF repeatedly blocked the next job. | The queue isolates missing or corrupt artifacts only when the batch has no station claim or submission evidence. Reserved, uncertain and saved-back cases require exact-job handling. HTTP tests cover later valid work, preserved backs and explicit clearance. |
| Delayed URL import overwrote an edit, and an invalid share kept the prior share visible. | Import requests lose control after a newer edit. Shared comparisons show their own loading or error state and replace both texts together. Chrome reproduced both failures and verified the corrected transitions. |

### Performance and browser behavior

| Fixture | Before | After |
| --- | --- | --- |
| Two disjoint print lists, 5,000 rows each, within request limits | 6,569–6,946 ms | 16–23 ms. Matching still reserves exact printings first and consumes interchangeable copies in order. |
| Five exact checks of a 1 GiB PDF | 351–353 ms per check, with a 5 ms timer delayed 346–348 ms | 367–403 ms per check, with timer lateness of 1–2 ms. A bounded worker hashes the file. Transitions recheck the file, state and authorization. |
| Five routine heartbeats on a 67,563,520-byte database | 44.31–52.98 ms each, five database replacements and five event rows | 0.12–0.66 ms each, with zero replacements or event rows inside the renewal window. Physical intent and outcomes retain durable receipts. |
| Eight sheets and 151,728,774 PDF bytes | 188.6 MB peak worker RSS, 0.10 s merge | 74.5 MB peak RSS, 0.26 s merge. Encoded artwork streams, page boxes and drawing content matched. Chrome started the new native download during transfer and verified the finished file hash. |
| Prepare in Chrome for 4.4 s with active work | Two full history reads and one ManaSync ledger read | Activity summaries only. History loads on opening Batches or choosing Refresh batches, and a failed ManaSync read leaves print results visible. The confirmation panel shows the timestamp of the actual ManaSync read, including a cached result. |
| Deck detail in Chrome, 100-deck library and a 2.5 s Scryfall delay | Saved cards visible after 3,377 ms, 27,595-byte library response | Saved cards visible after 834 ms, 282-byte deck response. Metadata enriches the same cards in the background. A mobile Scryfall failure kept saved text and search usable. |
| Integration listing, 100 decks × 25 snapshots × 100 lines | Full history, 58,896,886 bytes, 266 ms, 129 MB additional heap | Existing `include=latest` option verified at 630,491 bytes, 12 ms and 1.9 MB additional heap. The full-history default retains parsed cards and exact text. |

Each comparison used the same input before and after. Timings are local observations, and PDF worker memory is peak RSS. Two cached artwork faces now show two completed faces instead of four. The focused queue fixtures also cover state and file changes during verification.

Paired HTTP checks with ManaSync `f6d4241` verified identical normalized current and paper lists from the compact and legacy APIs. They also covered proposal and print receipt replay, one-original ownership, exact saved artwork, partial confirmation, dismissal and cached quantity refresh timestamps. [Bridge contract and setup](MANASYNC_BRIDGE.md)

The v2.65.0 source passed 1,479 JavaScript tests, 290 portable companion tests, 14 PDF worker tests, the production build and the isolated Compose deployment check. Lint reported five existing React warnings and zero errors. Both dependency audits reported zero advisories. Chrome fixtures covered the changed views and private downloads. All 11 proof layout and registration-mark combinations rendered for digital checks. The isolated ARM64 image smoke used a temporary database and verified health and private PDF access denial.

### Product changes

- Paste, file and URL imports show exact available printings, skipped rows, unsupported finishes and the change summary before applying. Undo restores the prior editor contents. In the library, tracking a reviewed URL saves the reviewed text and preserves the established source review checks.
- Print offers a one-sheet proof for each paper preset, including Dahle. The proof uses the production geometry and shows a scale check and setup checklist. A browser stores the operator's check against the exact recipe and generator revision.
- Printer shows why a specific batch stopped, with its known pass and receipt details. Recovery actions are available when the exact job and current permissions allow them.
- Signed-in owners can set expiry and revoke their comparison links. HTTP and Chrome checks cover expiring links, revocation, non-owner denial and legacy anonymous links.

### Still open

- Adopt `include=latest` for routine mirroring in the [ManaSync repository](https://github.com/dennysparking/manasync). The checked-out ManaSync client still asks for full history. Its decoder already accepts the compact response.
- Complete physical Epson and cutter acceptance for the relevant recipes. Generated proof sheets and fake printers verify the software path. [Physical checks](#working-printing-path-and-conditional-physical-checks)
- A canceled submission with no acknowledged CUPS ID stays reserved if the station cannot recover the exact job from CUPS. Preserve the receipts for manual investigation. [Print recovery](PRINT_WORKFLOW.md)
- Legacy session invalidation uses second-resolution JWT issue times. A separate hardening change can bind new sessions more precisely to password changes made in the same second.

## Open — reviewed 2026-09-12

These items were recorded by the 2026-09-12 review; reassess the relevant source before
starting one. [PROJECT_REVIEW.md](PROJECT_REVIEW.md) preserves that review's findings;
older detailed security audits remain local.

**Product / features**

- **Public deck links**: add optional expiry to tracked-deck links. Both share types have owner-side revocation, and comparison links support expiry.
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
