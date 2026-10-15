# Current work checkpoint

Updated **2026-10-15**. Authorized household server deployment complete.

- **Outcome:** CLC v2.57.4 source `00e89a4` is healthy on the Mac at localhost:8080 and
  household HTTPS. Image `clc-household:2.57.4-00e89a4` has ID
  `sha256:578b7017359b09d4e7dd32bb706db27a365f2aa147fef3c02583dfbeefde221e`.
- **Scope / ownership:** server-only deployment from installed v2.57.3 / `f04ad3a`.
  Private Compose and future Portainer fragment image pins updated. Public edits are only
  OPERATIONS, ROADMAP and this checkpoint; no application changes or foreign tracked edits.
- **Evidence reused:** v2.57.4's 1,254 JavaScript and 254 companion tests, build/lint/audits
  and conflict browser/review evidence retain their original October 15 scope at `00e89a4`.
  Exact-archive arm64 Docker build and offline migration/save/reset/auth/restart smoke passed.
  Five worker tests passed in the activated generator environment. No physical jobs/Discord tests.
- **Deployment checks:** database integrity passed; 16 jobs, 16,738 job events, 78 snapshots,
  users/owners and 15 saved-art records unchanged. Revision column migrated correctly.
  All 87 retained print artifact files matched. All 38 frontend files matched both origins;
  browser Guide/release notes show v2.57.4. Native v2.57.3 stayed running/unpaused with identical
  jobs/passes/receipts/settings/configuration/token and successful authenticated heartbeat.
  Container environment, ports, mount, network and restart policy preserved.
- **Rollback:** complete stopped data/config backup and private verification receipts at
  `/Users/cruv/docker/Backups/cardlistcompare/20261015T205943Z-before-2.57.4`.
  Prior image retained. Details and generator refresh are in [OPERATIONS](OPERATIONS.md#household-print-jobs).
- **Limits / follow-ups:** one pre-existing orphan snapshot was present before and after;
  preserved without repair. Investigation and conservative orphan-art-draft cleanup remain in
  [ROADMAP](ROADMAP.md). Portainer's controller definition still needs the prepared fragment
  merged before its next redeploy. Reload older tabs before saving artwork.
- **Live handles / next action:** none; owned smoke container, build files and browser tab removed.
  Commit/push this deployment record. No deployment work remains; no tag or registry publication.
