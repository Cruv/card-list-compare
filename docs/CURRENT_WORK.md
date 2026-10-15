# Current work checkpoint

Updated **2026-10-15**. Authorized orphan-snapshot investigation and safe repair complete.

- **Outcome:** the inaccessible historical snapshot is preserved in a private recovery
  archive. Its original owner/deck could not be proven; no association was guessed.
  The active database has 77 snapshots plus one archived record, integrity OK and zero
  foreign-key violations. All unrelated table rows/schema and 87 print artifacts were unchanged.
- **Scope / ownership:** one offline data repair and owned edits to OPERATIONS, ROADMAP
  and this checkpoint. No product-code change, version bump or release. Baseline `59a915e`;
  household CLC remains v2.57.4 / `00e89a4` in the same container/image and configuration.
- **Provenance:** all 48 inspected database copies across 24 dated directories already
  contained the unchanged orphan and lacked its parent. No exact duplicate or surviving
  paper-marker, proposal, image-job, print-plan or integration receipt identified an owner.
  Historical deletion time/cause remain unknown; current code enforces foreign keys.
- **Verification:** 52 persistence/deck-lifecycle tests at `59a915e`; independent history/code
  and helper review; ten disposable repair cases, including changed-data/reference/extra-FK
  and repeat refusal; final rehearsal on fresh stopped bytes. The exact deployed sql.js
  transaction ran offline without workers/network. Independent all-table/schema comparison
  and post-restart domain/integrity/FK checks passed. Localhost and household HTTPS are healthy.
- **Preservation / rollback:** complete fresh stopped data/config backup, fsynced full-row
  archive with exact text/schema/hashes and restoration instructions, and private receipts at
  `/Users/cruv/docker/Backups/cardlistcompare/20261015T223359Z-orphan-snapshot-repair`.
  Do not commit/publish this data or restore the whole backup over later user writes.
- **Native station:** v2.57.3 stayed running and unpaused; jobs, passes, receipts, settings,
  configuration/token and selected version were unchanged. Authenticated heartbeat succeeded
  at 22:52:47 UTC. No print operation, native update or Discord test.
- **Delivery / next:** this commit records the completed repair and documentation. No live
  handles or repair work remain.
  See [OPERATIONS](OPERATIONS.md#historical-snapshot-repair--2026-10-15) for the dated record;
  unrelated artwork-history/Portainer follow-ups remain in [ROADMAP](ROADMAP.md).
