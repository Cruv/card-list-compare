# Current work checkpoint

Repository deployment contract is fixed and [PR #7](https://github.com/Cruv/card-list-compare/pull/7)
is merged as `4d58f3e`. Owner approved merge after CI and GHCR publication, holding Mac cutover.
Publication repair is active on `codex/native-container-builds`, based on that clean main.

- **Completed source:** canonical published-image Compose and configurable existing data/
  identity/network/private settings, fail-on-missing bind protection, synthetic/negative
  contract checks, docs and full branch integration. Both Compose 2.40.3 and 5.5.0 passed;
  independent review found no blocker. PR's final hosted tests/audits/lint/amd64+arm64 builds
  passed. Main app tests, deployment contract, portable companion tests, audits and lint passed.
- **Exact publication failure:** main run `42103840301`, job `127514066906`, spent roughly
  20 minutes stuck after both ARM64 npm stages emitted QEMU `Illegal instruction`/SIGILL.
  Apt and amd64 completed normally. The agent canceled that owned CI attempt to collect logs;
  the exact main full-SHA registry tag was absent. Do not describe that run as a published
  release. Public canceled logs retain the diagnosis; local copies are outside Git.
- **Owned active repair:** Docker workflow plus affected contribution/decision/operations/
  checkpoint guidance. Replace emulation with native amd64/arm64 jobs, preserve target-specific
  backend dependencies, publish by digest and combine only after both succeed. Keep all
  existing tests/audits/lint, PR no-push protection, latest-on-main policy and source labels;
  add job time limits. No application/dependency/version or native recipe change is needed.
- **Next:** verify actionlint and the native-build workflow, commit/push, open a focused PR,
  wait for hosted native builds, merge under the existing owner approval, and verify exact
  main publication plus both registry platforms/revision labels. Then report the preservation
  plan. Do not switch the household image or rotate credentials in this source/publication stage.
- **Preservation / live state:** Mac still runs local `clc-household:2.57.5-4c6fd80`, container
  `7c209134c46e...`, healthy and unchanged throughout repository work; companion stays enabled.
  Keep full data and hidden keys, original mtg/network/container/port identity, private runtime
  values and native ledger/config/token/artifacts/profile for the later cutover. See
  [the procedure](OPERATIONS.md#repository-deployment-and-registry-cutover).
- **Handles:** no active disposable local backend or browser tab. Canceled run watch/log
  files are outside Git; no production/private deployment file or physical work changed.
