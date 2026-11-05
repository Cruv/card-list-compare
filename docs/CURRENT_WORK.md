# Current work checkpoint

v2.57.5 ManaSync traffic fix is implemented and functionally verified. Source delivery is
separate from a household deployment; the Archiver major-upgrade decision remains pending.

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
- **Dependencies / audit limit:** compatible Vite/Vitest, Nodemailer and transitive patches
  applied; unrelated lint dependency versions retained. Root audit is clean. Server audit
  still reports five moderate entries in the existing Archiver 7 / glob / minimatch chain.
  Archiver 8 needs a separate owner-approved migration of two ZIP exporters and regression
  checks. The owner question is pending; do not claim the full dependency/release gate clean
  or publish/deploy this candidate while that decision remains unresolved.
- **Evidence / handles:** diagnostic snapshots and scoped verification receipts stay private
  in the traffic investigation case; synthetic browser proofs/logs are outside Git. Owned
  browser tabs, disposable fixture server, smoke container/image and dependency scratch were removed.
- **Delivery / next:** this commit records the verified traffic fix on the existing feature
  branch; no tag/registry publication. Obtain the outstanding ZIP-upgrade decision, then finalize that
  separate maintenance stage as authorized. Household still needs an explicitly authorized
  deployment to activate this source fix and reduce its live traffic.
- **Preserved paused work:** Portainer reconciliation remains prepared but unsaved/unverified
  on its controller, as recorded in OPERATIONS/ROADMAP. Do not silently mark it complete.
