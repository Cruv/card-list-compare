# Current work checkpoint

Repository deployment repair is implemented on `codex/project-audit-print-workflow`,
baseline `e479759`. The owner requested repository fixes first and a preservation plan
before changing the running installation. Live CLC and the native companion remain untouched.

- **Owned scope:** tracked Compose, environment example, deployment-contract checker/npm
  script, Docker CI and affected README/contribution/decision/operations/roadmap guidance.
  No foreign edits. Internal deployment work does not change the v2.57.5 application version.
- **Outcome:** canonical Compose consumes GHCR without implicit local building; existing
  image/data/name/port/UID/GID/timezone and optional printing/bridge/email values are runtime
  inputs. Missing bind paths fail rather than creating a fresh database. Explicit update
  safety and 30-second shutdown are retained. CI validates the contract, tests, audits and
  lint, builds amd64/arm64, and publishes only main/tag pushes. Full SHA tags/revision labels
  support exact source receipts; latest remains tied to main.
- **Verification (2026-11-05):** synthetic Compose defaults/existing-instance/digest fixtures
  passed; a disposable create-only proof rejected a missing directory without creating it,
  preserved an existing sentinel/mount and never started a backend. Workflow actionlint
  1.7.12 and all 50 existing invariants passed. Both dependency audits are clean. Touched
  checker/full lint passed with the five existing warnings. Independent deployment/preservation
  review found no blocker. Prior unchanged application verification is in
  [the deployed checkpoint](OPERATIONS.md#household-server-deployment-checkpoint--2026-11-05).
- **Delivery / next:** repository repair is pushed in `0f6ca9f` and
  [PR #7](https://github.com/Cruv/card-list-compare/pull/7) targets main. Its first hosted run
  passed all 1,305 app tests and audits, then exposed Compose v2 omitting false JSON fields.
  The checker now compares the same CLI’s explicit-false reference and rejects an unsafe
  auto-creating negative fixture across encodings. Both Compose 2.40.3 and 5.5.0 passed.
  Require replacement exact-commit hosted verification. A PR builds without publishing.
  Main integration, new GHCR publication/manifest verification
  and live stack cutover are separate steps, not implied completed by this checkpoint.
- **Preservation:** follow [the cutover procedure](OPERATIONS.md#repository-deployment-and-registry-cutover).
  Keep the existing full data directory and hidden keys, private runtime values, mtg stack/
  network/container identity and native ledger/config/token/artifacts/profile. Fresh backups
  and idle exact-job checks precede any later activation. No credential rotation performed.
- **Live state:** Mac still runs local `clc-household:2.57.5-4c6fd80`; native v2.57.3 remains
  separate. No production/private deployment edit, physical work or Discord test occurred.
  The historical private local-image Portainer candidate is superseded as the intended
  configuration model, but remains an unchanged rollback/evidence file until controlled cutover.
- **Handles:** disposable Compose proof containers/network/data and actionlint tooling were
  removed. No local fixture process remains; hosted PR checks are the next external evidence.
