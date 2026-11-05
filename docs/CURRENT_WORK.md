# Current work checkpoint

v2.57.5 ManaSync traffic and ZIP dependency fixes are implemented. The owner approved the
remaining upgrades and deployment on 2026-11-05; final Docker/deployment verification is underway.

- **Scope / ownership:** backend pending-plan scheduling/cache/retry, frontend confirmation
  refresh lifecycle and explicit retry UI, targeted tests, documentation and compatible
  dependency security updates. Baseline `945054f`; all tracked edits belong to this task.
- **Outcome:** published/terminal records make zero idle remote reads. Publications have a
  six-attempt automatic budget and immediate holds on definitive rejection/quota failure.
  Explicit retry requires the reviewed connection and reuses the same frozen plan/bytes.
  Remote review is one owner-scoped bulk read, shared/throttled for 60 seconds. UI timers
  read CLC only and stop behind closed disclosures, hidden views or hidden browser tabs.
- **Safety:** original account/backend, payload/operation IDs, revision/history monotonicity,
  inventory confirmation and lost-response recovery retained. Missing/invalid bulk records
  never become inferred confirmations/deletions. Cancellation uses its durable bounded
  dismissal outbox. No production database edit, deployment, print/Discord action or native
  companion pause/update.
- **Final verification:** 1,293 JavaScript tests (67 files), 254 companion tests, production
  build and lint (zero errors, five baseline warnings) passed. Independent review findings
  for cancellation pre-reads and hidden Batches panels were fixed and closed. Browser used
  a disposable app/fake remote: 403 fallback shows held/quota records; open/collapsed/hidden
  timing stays quiet remotely; restoring Batches refreshes once; explicit retry sends one
  scoped original-plan request and changes no physical/inventory quantities. Offline arm64
  Docker image starts with fresh tmpfs/network disabled, and all 38 frontend files match.
- **Dependencies:** compatible Vite/Vitest, Nodemailer and transitive patches plus the
  approved Archiver 8 migration of both ZIP exporters. Scoped readdir-glob/Minimatch override
  resolves its remaining advisory; a real glob/extracted-bytes compatibility smoke passed.
  Both audits report zero findings on 2026-11-05. MPC streaming errors/warnings and client
  disconnects close the response and abort remaining archive work. New HTTP ZIP tests verify
  complete structure/extracted bytes, deduplication, errors and interrupted downloads.
  Mid-output failure tests exposed a late file-open/cleanup race; waiting for output close
  before deletion fixes it, and both temporary/completed ZIPs are absent after failure.
  Independent review closed this finding; all 17 focused ZIP tests pass.
  Final-input JavaScript suite: 1,305 tests passed; lint zero errors/five baseline warnings,
  production build passed. Reuse the unchanged 254 portable companion tests from this date.
- **Evidence / handles:** diagnostic snapshots and scoped verification receipts stay private
  in the traffic investigation case; synthetic browser proofs/logs are outside Git. Owned
  browser tabs, disposable fixture server, smoke container/image and dependency scratch were removed.
- **Delivery / next:** traffic source `5720b83` is pushed; ZIP maintenance is ready for
  commit/push on the same feature branch. Build
  the exact source image, isolated runtime smoke, fresh idle recheck and stopped-data backup,
  then activate only CLC and verify preserved data/native settings plus public/local assets.
  No tag/registry publication is authorized or needed. The private deployment case is
  `/Users/cruv/docker/Backups/cardlistcompare/20261105T181218Z-before-2.57.5`; preflight has
  clean integrity/FKs, no active/uncertain server/native/CUPS work and an unpaused running
  native v2.57.3 station. Recheck this state immediately before recreation.
- **Preserved paused work:** Portainer reconciliation remains prepared but unsaved/unverified
  on its controller, as recorded in OPERATIONS/ROADMAP. Do not silently mark it complete.
