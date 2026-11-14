# Current work checkpoint

## A4 and US Letter printing

The v2.58.0 source adds a browser default and a paper-size choice in print review. Each
batch keeps its size through PDF generation, physical claims, deferred backs and recovery.
Legacy batches retain Letter. Direct A4 printing requires companion 2.58.0 and a matching
local stock setting. Setup and separate A4 physical checks are in the
[Mac companion guide](../companion/mac/README.md#configure-without-printing).
The household cutover and physical A4 confirmation remain separate.

## Repository and registry history

Repository-owned deployment and native publisher repairs are implemented. Source delivery
is tracked by [PR #7](https://github.com/Cruv/card-list-compare/pull/7) (integrated as `4d58f3e`)
and [PR #8](https://github.com/Cruv/card-list-compare/pull/8) (native publisher). On 2026-11-05
the owner authorized merge after passing CI and GHCR publication, holding Mac cutover.
The PR/main workflow and registry receipts own the changing publication status.

- **Repository contract:** canonical Compose consumes GHCR without implicit local builds;
  existing data/name/project/network/port/permissions/timezone and private settings are runtime
  inputs. Missing bind paths fail rather than initializing an empty database. Both Compose
  2.40.3 and 5.5.0 passed, including unsafe-bind rejection; independent review closed.
- **Publisher repair:** the first main publication (`42103840301`) was canceled after both
  ARM npm stages crashed under QEMU and stalled; no exact-main registry tag was present.
  Native AMD64/ARM64 jobs now verify their hardware, retain target dependencies and pass
  digest receipts to a guarded final manifest job. Both same-run/source results are required.
  PRs never publish. API failure fails closed; older reruns cannot move current main/latest.
  Existing tests/audits/lint remain mandatory and jobs have explicit time limits. No app,
  dependency, Dockerfile, native recipe or product-version change accompanies this CI repair.
- **Verification (2026-11-05):** actionlint, 16 synthetic publishing scenarios and 50 invariants
  passed. Native PR run `42109818823` for `2830659` passed hosted app/companion tests, audits,
  deployment checks, lint and both native image builds; publication was correctly skipped.
  Independent publication-boundary review closed. Documentation-only follow-up can reuse
  unchanged workflow/code evidence; exact selected main publication must still be verified.
- **Registry cutover:** on November 9 the owner applied the GHCR `latest` stack through
  Portainer. The deployed v2.57.5 image matched `d329647`. Local and public health,
  frontend bytes, database integrity and native reconnection passed. Keep the full
  data directory, keys, existing stack identity, private runtime values and native
  print receipts for later updates. See
  [the procedure](OPERATIONS.md#repository-deployment-and-registry-cutover).
- **Handles:** no active disposable local backend/browser tab. CI watches/logs are outside
  Git; canceled logs retain the QEMU diagnosis. No foreign or paused implementation edits.
