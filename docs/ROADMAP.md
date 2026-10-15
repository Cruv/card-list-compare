# Roadmap

The committed product backlog. [CURRENT_WORK.md](CURRENT_WORK.md) is the small task
checkpoint; [CONTRIBUTING.md](../CONTRIBUTING.md) owns workflow, verification and release
procedure. This backlog does not authorize deployment or physical printing. Historical
results are linked below rather than repeated as work to do.

## Next — physical cutter/duplex proof

The Epson 13.45 driver and Uinkit fronts recipe have accepted color (after nozzle cleaning)
and companion landscape output. Remaining physical work is **v6 cutter geometry** and
**manual DFC page order, flip and alignment**. A real-generator offline fixture verified
labels and geometry for one ordinary card plus eight DFCs in separate packets, without
printing paper. The owner's 600 PPI, 1 mm crop and Epson Vivid settings are preserved in
[HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md). Software QA and completed spooler
passes cannot establish these physical results or enable their proof flags.

Use the implemented [print workflow](PRINT_WORKFLOW.md) for exact-packet reload,
deferred backs and paper-reset requirements. Drying, lamination and cutting tracking remain
excluded. Printing never credits usable copies or advances the assembled paper-deck marker
automatically.

## Household follow-ups

The [dated household checkpoint](OPERATIONS.md#household-print-jobs) owns installed versions,
completed recovery and operational safeguards. At its 2026-10-11 checkpoint, incoming Discord
commands still needed application/operator setup; the existing webhook was connected.
Reconcile Portainer's saved service definition before its next controller redeploy.
Neither item is a request to interrupt active household work or test with real jobs.

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
- Saved art choices currently use whole-record replacement and a 612-entry limit. The
  maintenance fixes preserve choices across searches and serialize saves within an overlay;
  multi-device concurrent edits still need versioning/conflict handling and history management.

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
