# Current work checkpoint

Updated **2026-10-15**. Authorized Portainer stack reconciliation in progress.

- **Scope / ownership:** reconcile Portainer's saved CLC service with the working Mac
  deployment; preserve other services, data, credentials, network and the enabled native
  companion; update docs, commit and push. No product-code change or release.
- **Baseline:** repository `f62dfb0`; household CLC v2.57.4 / `00e89a4`, same healthy
  container/image/configuration as the completed repair. The orphan repair is recorded in
  [OPERATIONS](OPERATIONS.md#historical-snapshot-repair--2026-10-15).
- **Owner-supplied definition:** single CLC service still uses GHCR `latest`, five environment
  keys and the existing Mac data mount. Missing explicit print-station settings and deployment
  safeguards have been reconciled in a private full-stack candidate.
- **Prepared candidate:**
  `/Users/cruv/docker/Stacks/mtg/cardlistcompare-deployment/portainer-stack-reconciled.private.yaml`.
  Exact local image pin, nine original environment values, same port/mount/restart settings,
  explicit existing external network, no-pull and Watchtower safeguards. This file contains
  credentials: do not commit it or print its contents in chat/logs.
- **Verification:** resolved candidate service and network exactly match local deployment;
  all nine explicit environment values match live; Compose configuration hash exactly equals
  the live container label. Independent review and 32 documentation-link checks passed.
  All running container IDs/start times are unchanged; CLC is healthy and the native station
  remains running/unpaused. No server/native restart, deploy, pause or printing action.
- **Private case:** `/Users/cruv/docker/Backups/cardlistcompare/20261016T010010Z-portainer-reconciliation`.
  Owner-supplied source, private deployment backups, container identities and preparation
  receipts retained. The UTC directory date differs from the owner's local October 15 date.
- **Next / missing access:** controller URL/session has not been supplied. The private candidate
  is open for owner review/copy; Portainer's actual saved definition has NOT been changed.
  Standard Portainer stack update also applies the stack, so do not assume a save-only API.
  Obtain controller access or owner confirmation of manual save, compare/read back the saved
  file and environment, verify unchanged runtime, then finalize the dated reconciliation record.
  This commit records verified preparation only; it does not claim a controller save.
