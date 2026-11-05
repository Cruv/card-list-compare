# CardListCompare agent entrypoint

This is the canonical repository-local entrypoint for coding agents. [CONTRIBUTING.md](CONTRIBUTING.md)
owns development, verification, review, evidence reuse and delivery procedures. Client adapters
and skills route there; they do not add separate gates. Read relevant sections, not the entire
documentation tree. Explicit owner direction can supersede procedures; preserve substantive
security, privacy, data-integrity, compatibility and licensing safeguards.

## Project and hard boundaries

- React/Vite frontend (`src/`), Express backend (`server/`), **sql.js** persistence,
  Docker server and a native Mac Epson print companion (`companion/mac/`).
- Deck text with printing metadata is the data contract. Keep the single card-line grammar,
  exact printing identities and client/server couplings in [INVARIANTS](docs/INVARIANTS.md)
  and [DECK_TEXT_FORMAT](docs/DECK_TEXT_FORMAT.md). Parsed entries use `displayName`;
  commanders are strings. A new shared server import must ship in the Dockerfile.
- sql.js writes must use persistence/transaction helpers; preserve atomic replacement,
  rollback and `exportDatabase()` semantics. Never run competing backends on one database.
- ManaSync owns collections. One owned original of any printing permits unlimited proxy
  copies; unknown ownership stays unknown. PDF/spooler completion does not credit usable
  inventory or advance the assembled paper marker.
- Physical printing depends on durable exact-job/pass/attempt receipts and explicit paper
  checks. Preserve uncertain submissions; notifications never authorize retries or backs.
  Use disposable data and fake external effects for QA. See [security](SECURITY.md) and
  [printing](docs/PRINT_WORKFLOW.md) when those boundaries are affected.

## Owner preferences and scope

- Complete authorized work. Ask about unrelated improvements before implementing them;
  put concrete deferred findings in the [existing backlog](docs/ROADMAP.md).
- Commit and push at logical stages using owned paths. A cohesive user-visible outcome is
  a release boundary, not each file, subtask or agent result. Tags and publication have the
  separate authorization boundaries in [delivery](CONTRIBUTING.md#delivery-and-publication).
- Preserve foreign edits and paused work. Ask only when ownership, overlap or a consequential
  action cannot be resolved from existing authorization; unrelated dirty files alone do not
  require stopping.
- Verify UI in a browser; the owner replaced iOS Simulator acceptance on 2026-09-12.
  Browser checks do not establish physical printing, cutting or native-device proof.
- Leave the household companion running and enabled during ordinary interface work.
  Do not pause, cancel, retry or submit physical work, send Discord tests, or change production
  infrastructure unless that action is authorized. Normal managed-update safety guards still apply.
- Never commit credentials, private audit details, database/artifact data or deployment fragments.
  Existing dated household paths and rollout evidence are in [OPERATIONS](docs/OPERATIONS.md),
  not a grant to manipulate production.

## Start and resume

Inspect working-tree status, relevant recent history and the task's entrypoints. Use
[docs/CURRENT_WORK.md](docs/CURRENT_WORK.md) for the current scope, evidence, ownership and next
action on a substantial handoff; validate its revision before reusing it. Do not restart a
completed audit or rerun unaffected checks merely because context was compacted.

| Task | Read when relevant |
| --- | --- |
| Setup, commands, checks, release or resumption | [CONTRIBUTING](CONTRIBUTING.md) |
| Parser, identity, database, shared imports | [INVARIANTS](docs/INVARIANTS.md), [deck text](docs/DECK_TEXT_FORMAT.md) |
| Established product or architecture choice | Relevant entry in [DECISIONS](docs/DECISIONS.md) |
| Auth, privacy, permissions or update trust | Relevant section of [SECURITY](SECURITY.md) |
| PDF generation, queue/recovery, native station | [PRINT_WORKFLOW](docs/PRINT_WORKFLOW.md), [companion README](companion/mac/README.md) |
| ManaSync contracts | [bridge](docs/MANASYNC_BRIDGE.md), [proposals](docs/MANASYNC_PROPOSALS.md) |
| Operations or physical acceptance | Relevant [runbook](docs/OPERATIONS.md) / [household recipe](docs/HOUSEHOLD_PRINT_RECIPE.md) |
| Deferred work or historical evidence | [ROADMAP](docs/ROADMAP.md); follow dated review links only as needed |
