# Current work checkpoint

v2.57.5 ManaSync traffic and ZIP fixes are complete, pushed and deployed to the Mac's CLC
stack with owner approval on 2026-11-05. No active implementation work remains in this scope.

- **Source / ownership:** traffic fix `5720b83`; final ZIP/runtime source `4c6fd80` on
  `codex/project-audit-print-workflow`. All tracked changes belong to this task; no foreign
  edits. No tag/registry publication. Deployment documentation is the final delivery stage.
- **Outcome:** published records stay idle; bulk review is shared/throttled; hidden panels
  stop polling; uploads hold after six attempts or definitive rejection and retain an explicit
  safe retry. Archiver 8/scoped patched Minimatch clear audits. Stream failures/client
  disconnects abort ZIP work; file-close synchronization prevents leftover temporary ZIPs.
- **Verification (2026-11-05):** 1,305 final-input JavaScript tests, zero-error lint (five
  baseline warnings), production build and both audits (zero findings). Reused unchanged
  254 portable companion tests from the same date. Browser fixture timing/retry checks and
  focused independent reviews passed; 17 real ZIP/failure tests and a glob compatibility
  smoke passed. Offline arm64 Docker smoke verified exact ZIP bytes and 145 source/frontend
  files. Public/local origins each match all 38 shipped frontend files; Chrome shows v2.57.5
  release notes and print-record guidance.
- **Deployment:** image `clc-household:2.57.5-4c6fd80`; only CLC recreated. Complete stopped-data
  backup and private receipts are in
  `/Users/cruv/docker/Backups/cardlistcompare/20261105T181218Z-before-2.57.5`. Integrity/FKs
  pass; 37/38 table hashes unchanged, only normal rolling station events changed. Print/deck/
  ManaSync records and keys retained. Native v2.57.3 remains running/unpaused with identical
  jobs, passes, attempts, events, settings and config; heartbeat HTTP 200. No physical print
  operation, Discord test, native update or inventory confirmation. Generator version unchanged.
- **Live observation:** all 821 saved plans kept unchanged counters/schedules over 263 seconds.
  This does not attribute or count whole-zone requests. Reload older CLC tabs. Existing upstream
  permission/quota problems still require correction before explicit saved-plan retry.
- **Handles / next:** disposable fixture servers/containers/tabs and temporary QA image removed;
  private backup/verification receipts remain outside Git. See
  [the deployed checkpoint](OPERATIONS.md#household-server-deployment-checkpoint--2026-11-05).
- **Preserved pending work:** Portainer's private full candidate matches the new local pin,
  but the saved controller stack remains unsaved/unverified pending access. Existing roadmap
  product/physical follow-ups were not converted into deployment changes.
