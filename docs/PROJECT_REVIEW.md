# Project review — 2026-09-12

This document describes the current product and review findings. Historical milestone
reports remain in Git history. [Roadmap](ROADMAP.md) is the committed open backlog;
[Operations](OPERATIONS.md) distinguishes source implementation from household deployment.

## Current product and boundaries

CLC uses React 19/Vite 7, Express 5 and sql.js with atomic disk persistence. It compares
metadata-rich MTG lists, tracks provider decks and local saved versions, reviews source
changes/proposals, preserves assembled-paper baselines, and provides artwork, deck analysis,
sharing and household administration. Collection/purchase management belongs to ManaSync.
One owned original of any printing covers unlimited proxies; incoming originals suppress
repeat shopping and unavailable ownership is reported as unknown.

The actual cached Silhouette Card Maker v6 generates complete immutable PDFs in Docker.
The native Mac companion uses the Epson driver and local settings, reconciles durable CUPS
receipts, and stages ordinary fronts followed by labeled one-sheet DFC packets. The exact
packet must be reloaded before its backs. Generation/spooling does not credit inventory or
advance the assembled-paper marker. Drying/lamination/cutting tracking remains excluded.

## Current review findings and changes

| Finding | Result |
| --- | --- |
| Deck history spread over three tabs; insights split from cards | Cards, Changes, Print and Settings preserve the capabilities with one version list and captured comparison |
| Source/proposal reviews dominated unrelated tabs | Reviews live under Changes, with a compact attention link elsewhere |
| Library import required an unrelated Compare detour | Add decks lists untracked decks and accepts pasted lists or supported links directly |
| Repeated exports and save prompts | Accessible Export disclosures and one explicit Save version; saved-version loading is read-only |
| PDF jobs and inventory records both called a print queue | Batches represent PDFs; manual print records represent explicitly confirmed outside work |
| Waiting jobs appeared absent in another page's scoped history | Printer shows saved household queue summaries across decks and standalone lists, separately from CUPS submission |
| Fresh pasted list retained an old comparison baseline | Replacement paste/import detaches the baseline; review identifies the chosen mode and count reductions |
| 95-entry Jin Sakai list reported 94 copies/90 entries | Stored job had subtracted six shared copies against Swarmlord. Whole list is 100 copies/95 entries; exclude its eight basic copies and it is 92/92. The unexpected retained comparison was the bug |
| Plain trailing `F` foil imports lost printing metadata | Shared card-line grammar accepts plain `F` alongside `*F*`, with parser/planner regression coverage |
| Printing-only versions looked unchanged in timeline | Version summary includes printing changes |
| Late snapshot-picker responses could display another deck's versions | Picker responses are keyed to the latest request |
| Modal launchers disappeared when their export menu blurred | Menu stays mounted while its child modal owns focus, preserving Escape/launcher restoration |
| Printer errors had no notification path | Native structured CUPS status and active-pass checks send bounded Mac/optional Discord alerts with persisted duplicate suppression |
| Settings, admin maintenance and guidance had duplicate homes | Directional Connections, personal Account settings, seven focused admin areas and seven task-based Guide topics |

See [UI organization and verification](UI_REDESIGN_INVENTORY.md) for every route, overlay,
permission boundary and focused browser checks. This pass preserves public sharing,
exact-printing art, source protection, saved drafts, recovery identities, confirmations
and the optional ManaSync contracts.

## Remaining work and validation limits

The current open items are maintained in [Roadmap](ROADMAP.md), not duplicated here.
Physical v6 cutter geometry and manual DFC page order/flip/alignment still require the
household checks in [the print recipe](HOUSEHOLD_PRINT_RECIPE.md). Prior accepted color
and landscape proofs do not certify those remaining steps. Live vendor restrictions,
MPC XML/ZIP copy/back limitations and multi-device art-save conflicts remain documented.
Software/browser tests use disposable databases and mocked external effects; a new
companion feature is available on the household Mac only after its native runtime update.
