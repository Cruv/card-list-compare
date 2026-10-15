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

## Working printing path and conditional physical checks

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
Reconcile Portainer's saved service definition before its next controller redeploy.
Neither item is a request to interrupt active household work or test with real jobs.

The historical orphaned snapshot was investigated and safely archived on 2026-10-15.
Its original owner/deck could not be proven; all text and metadata remain in a private recovery
archive, and the active database now passes foreign-key checks. See
[the repair record](OPERATIONS.md#historical-snapshot-repair--2026-10-15).

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
