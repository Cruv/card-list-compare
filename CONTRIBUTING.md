# Contributing

This is the canonical development, verification and delivery procedure for humans and
AI clients. [AGENTS.md](AGENTS.md) supplies essential project boundaries and task routing;
[DECISIONS](docs/DECISIONS.md) explains architecture and policy history. Client adapters,
review agents and skills refer here rather than imposing their own release sequence.

## Setup and commands

Use Node 22+ and install both dependency trees: server tests import server dependencies.

```bash
npm ci
npm --prefix server ci
npm run dev                 # frontend :5173; proxies /api to :3001
npm --prefix server run dev # backend :3001, in another terminal
```

Development defaults to `server/data/cardlistcompare.db`. Register the first user, restart
the backend once, then reload/sign in for first-admin access. An unset development
`JWT_SECRET` gets a persisted random `.jwt-dev-secret`; supplied weak secrets are rejected,
and production requires a strong configured secret. npm scripts do not load `.env`:
export settings or configure `.env.example` as `.env` and run
`node --env-file=.env --watch server/index.js` from the root. Never commit real secrets/data.

| Command | Scope |
| --- | --- |
| `npm test` | All client/server JavaScript tests and cross-file invariants; Node environment, not visual browser proof |
| `npm test -- src/lib/parser.test.js src/lib/invariants.test.js` | Example focused test files; expand to affected consumers |
| `npm run test:watch` | JavaScript watch mode |
| `npm run lint` / `npx eslint <changed-js-paths>` | Full / focused lint; errors block affected delivery, warnings remain visible |
| `npm run build` | Production frontend, including generated offline-shell assets |
| `python3 -B -E -s -m unittest discover -s companion/mac -p 'test_*.py'` | Portable companion tests with fake printers/transports |
| `python3 -B -E -s -m unittest discover -s companion/mac -p 'test_printer_health.py'` | Example focused native tests |
| `npm audit` / `npm --prefix server audit` | Root / server dependency advisories; record unavailable checks separately |

PDF worker changes also need the following command using the worker's pypdf/Pillow
environment. This is not included in JavaScript or portable companion discovery.
See [PDF runtime setup](docs/OPERATIONS.md#silhouette-runtime).

```bash
python3 -B -E -s -m unittest discover -s server/lib -p 'test_print_generator_worker.py'
```

## Scope and ownership

Start with `git status --short --branch`, relevant history and the implementation/test
entrypoints. Read only affected sections of contracts, invariants and decisions. Code
establishes current behavior, not permission to change policy or remove a safeguard.
Record any material policy uncertainty, retain its protection and continue independent work.

Preserve unrelated changes and paused work. Distinguish owned paths from foreign edits;
coordinate only on overlapping/ambiguous work. Before committing, inspect current status,
HEAD and the staged diff; stage explicit owned paths. Existing authorization to commit/push
persists. Out-of-scope findings belong in the existing [ROADMAP](docs/ROADMAP.md), with a
concrete proposal for owner approval rather than silently expanding this task.

## Verification proportional to risk

Choose the union of affected risks below. A baseline full-suite run is useful for an
uncertain failure or broad change, not mandatory before every edit. Verify the final
cohesive result; do not release each subtask separately.

| Change / trigger | Failure being guarded against | Sufficient local evidence |
| --- | --- | --- |
| Documentation, AI instructions, skill metadata | Stale claims, broken routing, contradictory procedures | Review affected claims against code/history; check diffs, affected links/anchors/paths and metadata. Scenario-review materially changed procedures. No product version, app test/build, tag or deployment solely for prose. |
| Local behavior fix | Regression in the changed path or its callers | Reproduce the failure; use a meaningful regression when warranted; run affected test files and touched-file lint. Include shared consumers when coupled. |
| UI behavior or layout | Broken interaction, permissions, responsive layout or shipped assets | Affected logic tests and lint, production build, browser exercise of the changed surface and relevant keyboard/viewport/error states. A label-only edit may need only build and a focused visible check. |
| Shared parser, printing identity, formatter or import/export contract | Silent corruption/drift across representations | Complete relevant parser/differ/formatter/invariants corpus and affected enrichment, server, pricing or printing consumers; check exact-printing/DFC/foil/round-trip and adverse cases. Do not substitute one happy-path fixture. |
| Persistence, auth, permissions, public contracts or physical-print control | Data loss, unauthorized access, replay, duplicate printing or incompatible readers | Complete affected permission/transaction/migration/recovery/idempotency/compatibility tests, including adverse and lost-response cases; disposable state/fake hardware; independent review when it supplies material evidence. Preserve backups, keys, receipts and exact identities. |
| External provider contract | Fixtures pass while the provider's live shape changed | Relevant fixtures plus a bounded live read when available; record provider/date/scope. Live writes, Discord sends and physical printing need their own authorization. Unavailable live evidence remains explicitly unverified. |
| Dependency, Docker/shared-import or runtime/package change | Vulnerable resolution or dev-only success | Affected audits/tests, COPY/version invariants, isolated image/package build and runtime smoke as applicable. Native package smoke/hashes are not replaced by portable tests. |
| Product release | Incomplete integration or mismatched shipped bytes | The complete release gate below on final inputs, with scoped evidence reuse. CI/publisher results are separate evidence. |

Do not weaken assertions, rewrite expected approvals/hashes or remove invariant checks to
manufacture a pass. An intentional contract change requires its migration/compatibility
evidence and matching contract updates. A failing substantive check blocks claiming that
scope verified or publishing it. Preserve unrelated baseline failures with their provenance.

Use disposable databases, distinct test ports/projects and disabled/fake external effects.
Do not run the default Compose `up`/`down` as a generic smoke test: it binds `./data` and
can collide with real state. Build an isolated image and supply a temporary data mount,
separate container/project and port; tear down only those owned fixtures. Never use household
accounts, jobs or the live Epson queue as disposable QA. Browser tests with intercepted API
effects must exclude old service workers; test the real public offline shell separately.

## Evidence reuse and bounded review

Record the check, result, original date, revision or relevant file hashes, dependency/runtime
and configuration inputs, and tested scope. A check remains valid when those inputs and
its covered behavior remain unchanged. New relevant code/tests/contracts, lockfiles, build
inputs, environment/configuration or external-provider changes invalidate the affected
evidence, not every check. A static test may remain valid across a docs edit; a historical
live-provider or device observation is not proof of current availability. Audit results
are time-sensitive: check them again when shipping a new dependency/product release.

Prefer final edits before verification. If only release version/Guide bookkeeping follows
passing tests, rerun affected invariants and the final frontend build; reuse other unchanged
coverage. Preserve original dates/scopes. Pending CI, publisher or physical acceptance stays
pending; do not refresh approval records or describe an unrun check as complete.

Use one focused independent read-only review for a material security/data/printing boundary,
large cross-cutting change, or substantial instruction rewrite when available. Ordinary docs,
small fixes and copy changes need no universal second agent. Give the reviewer a concrete
diff, risk and evidence; additional reviewers/refutation/broader audits need a specific
unresolved finding or gap. Review completes when actionable findings are addressed and the
affected checks pass; do not demand boilerplate verdicts for unrelated invariants.

After two nonproductive attempts at the same tooling obstacle, use an available equivalent
or record the exact unavailable check and its consequence. Continue independent authorized
work. Do not repeat an unchanged check, disable a gate or claim substitute evidence proves
more than it does.

## Documentation routing

Update documents whose stated behavior or policy changed, in the same cohesive change.
No ceremonial edits or "Guide: no impact" commit text are needed when a document is accurate.

| Change | Canonical reference |
| --- | --- |
| Development, verification, review, delivery | This file; [AGENTS](AGENTS.md) keeps only essential routing/boundaries |
| Data grammar / parser contract / invariant | [DECK_TEXT_FORMAT](docs/DECK_TEXT_FORMAT.md), [INVARIANTS](docs/INVARIANTS.md) and affected executable guards |
| Established product/architecture decision | Relevant [DECISIONS](docs/DECISIONS.md) entry; mark superseded procedure explicitly |
| Security/privacy model | Relevant [SECURITY](SECURITY.md) section and adverse-case evidence |
| User instructions / feature availability | Affected [README](README.md) or Guide topic in `src/components/GuidePage.jsx` |
| Runtime/deployment configuration | Relevant [OPERATIONS](docs/OPERATIONS.md), `.env.example`, companion/printing reference |
| Unfinished work / active handoff | [ROADMAP](docs/ROADMAP.md) / [CURRENT_WORK](docs/CURRENT_WORK.md) |

Dated reviews, proof results and deployment checkpoints are historical evidence. Read their
scope/date first; link current contracts and runbooks rather than presenting completed
plans as new gates. Private exploit notes and deployment fragments remain untracked.

## Delivery and publication

Treat a cohesive outcome as the release unit. Documentation/procedure-only work and other
internal-only changes use a descriptive commit without a product version, build, tag or
deployment requirement. Executable changes still receive their affected checks above.

For a user-visible product release:

1. Determine the bump from `APP_VERSION` at HEAD: patch for fixes/copy/performance, minor
   for capability, major for breaking stored/public contracts. A breaking change needs
   explicit owner agreement and migration/compatibility planning. Historical commit titles
   or tags do not override the current version constants.
2. Complete the outcome, final versions and relevant docs. Replace `WHATS_NEW` with 1–4
   short player-facing strings; sync root `package.json`/lockfile with
   `npm version X.Y.Z --no-git-tag-version --allow-same-version`. If packaging the companion,
   its `COMPANION_VERSION`, package version and requested bundle version must match.
3. Establish passing `npm test`, portable companion tests, `npm run lint`, `npm run build`,
   and both dependency audits. Reuse still-valid evidence as above; do not run identical
   before/after suites by default. Review advisories and use compatible fixes; a major
   dependency migration is deliberate work, not incidental audit cleanup.
4. Inspect/stage owned paths and commit `vX.Y.Z: Description`, then push when authorized.
   Internal stages may be separate descriptive commits; they do not each trigger a version.

Publication is an external effect, separate from committing:

- Docker CI runs on pull requests, pushes to `main`, and `v*` tags. It gates Docker builds
  on JavaScript tests, portable Python tests and error-free lint; the image build compiles
  the frontend. PRs build only; main/tag pushes publish GHCR. This also happens for docs
  pushed to main; the local prose exemption does not disable CI or imply a production deploy.
- A feature-branch push without a PR does not trigger that workflow. When CI is expected,
  match the workflow/run to the pushed commit SHA (for example `gh run list --commit <SHA>`),
  inspect its conclusion, and report pending/unavailable truthfully. Do not mistake the
  latest unrelated run for this change or retry a push blindly.
- `v*` tags/semver publication are only on owner request. Do not infer merge, release
  publication or household deployment permission from a request to commit/push alone.
  Reuse explicit authorization already given for the concrete action; do not ask again.
- Native packages use the manual [Mac workflow](.github/workflows/mac-print-station.yml):
  matching requested versions, portable tests, native arm64/x86_64 smoke, archive/manifest
  hashes and contained-file checks. Attaching assets requires its explicit draft-release
  option; draft attachment is not publication. Preserve upstream licensing/notarization limits.
- Household activation follows the authorized [operations runbook](docs/OPERATIONS.md).
  Preserve data, keys, receipts and Epson settings. Unresolved physical work blocks normal
  managed updates. Historical one-off idle/offline recovery procedures are not blanket
  permission to bypass update guards or pause a working station.

## Resumption checkpoint

[docs/CURRENT_WORK.md](docs/CURRENT_WORK.md) is the single small active-work checkpoint.
Update it for a substantial handoff/compaction or material scope/evidence change, not every
command or routine small task. Keep only: objective/status; baseline/revision and owned/foreign
edits; checks with dates/inputs/scope; unresolved decisions; live handles and next action.
Do not put secrets, full logs or repeated history there; detailed evidence stays in its
original dated location. Deployment checkpoints describe installed software, not active tasks.

On resume, read that checkpoint and current status/HEAD/diff, confirm inputs/authorization,
then perform the next outstanding action. Read historical detail only to resolve a specific
gap. Completed work stays completed; valid checks and earlier owner authorization survive
compaction.
