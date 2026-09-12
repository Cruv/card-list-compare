# UI organization and verification

Current source review: **2026-09-12**. This is the capability map for the reorganized UI,
not a history of old layouts. Earlier screenshots/checkpoints remain in Git history.
The owner authorized replacing prior tab decisions and requested browser verification
instead of iOS Simulator testing. Deployed versions are recorded in [Operations](OPERATIONS.md).

## Navigation and terminology

The main destinations are **Compare / Decks / Print**. Desktop uses the sidebar; phones
use Compare, Decks, Print and More. More contains Connections, Account settings, Guide
and Administration when permitted. Print contains **New print list / Printer**. Public
comparison and shared-deck views remain usable without authentication; private screens
show the login gate. Theme, authentication and What’s new remain in the common shell.

| Previous overlap | Current home |
| --- | --- |
| Snapshots, Changelog and Timeline tabs | Deck → Changes: one comparison and one chronological version list |
| Full Deck and Analytics tabs | Deck → Cards: artwork/list plus insights, prices and suggestions |
| Source/proposal panels above unrelated deck tabs | Review within Changes, compact attention link elsewhere |
| Repeated copy/export toolbar rows | Primary task actions plus one Export disclosure |
| Separate URL auto-save prompt and manual save panel | Compare has one Save version action; Load saved is read-only |
| Library import leading to Compare | Add decks dialog lists untracked decks and accepts pasted text or a source URL |
| Print studio and Print station as peer main tabs | Print → New print list / Printer |
| Choose/Review/Status plus history on one long page | Prepare (Choose/Review) and Batches, preserving drafts/recovery |
| Inventory-only “print queue” | Manual print records; generating/spooling remains a PDF-batch action |
| Queue visibility limited to a deck or standalone list | Printer consolidates all saved/queued/terminal batches across both; admins see every user and owners can open exact batches |
| Admin overview also owning maintenance and exports | Overview is informational; Users and System own their corresponding actions |

“Entries” means distinct selected card/printing rows. “Copies” means physical quantities.
Review explains whole-list versus changes mode, the baseline reduction, excluded basics
and manual removals. Display filters do not change the order. Pasting/importing a new
standalone list clears a previously carried comparison baseline. Existing jobs remain
immutable; a draft edit never rewrites already generated or queued PDFs.

## Route and capability matrix

| Route / surface | Capabilities and important states |
| --- | --- |
| `#` Compare | Before/After paste, URL/file imports, read-only saved-version picker, explicit Save version, Swap/Clear, captured results, exact art previews, copy/exports/share, print handoff, identical lists, empty/error/clipboard denial. Ctrl/Cmd+Enter is scoped to Compare and excludes dialogs. |
| `#share/{id}` | Public saved comparison, captured metadata/exports/printing; loading/missing/expired/error handling. |
| `#library` Decks | Search/filter/sort/group tracked decks, pin/tag, bulk refresh/export/untrack, cross-deck overlap and activity. Add decks shows untracked sources; account management remains available separately. |
| Add decks dialog | Untracked decks across configured accounts; direct source tracking; pasted manual list; supported URL source tracking or one-time import; per-user draft and exact pending-request recovery. No Before/After comparison form. |
| `#library/{id}` Cards | Default deck view; card list/gallery/search, commander/mainboard/sideboard, deck statistics, exact/budget prices, price history, suggestions, exports and MPCFill artwork. Ownership and manual print records retain their distinct roles. |
| Deck → Changes | Paper→Latest, Previous→Latest or selected versions; immutable captured comparison, print/export, unified version history with nickname/lock/paper/delete/inspect; source and ManaSync proposal review with protected local edits. Printing-only history changes are labeled. |
| Deck → Print | Whole-snapshot or positive-delta preparation, reviewed artwork/editing, that deck's Batches. Queue links open the exact owned batch, including outside the latest-50 history window. |
| Deck → Settings | Sharing, upstream check schedule and deck alerts; commander/tags/notes remain in the shared deck header. Destructive actions keep confirmations. |
| `#deck/{id}` | Read-only shared deck: Cards and Changes, selected version inspector and exports; no owner mutation controls. |
| Version details overlay | Captured Cards/Changes, preview/export, nested MPCFill artwork; modal dismissal restores the original launcher. |
| `#print-list` | Named ad-hoc lists or explicit Compare handoffs; account-scoped saved draft, selection review and standalone Batches. `?batch=UUID` opens an exact owned batch without overwriting the draft. |
| `#print-station` Printer | Current job and exact refeed card; all-status batch history (all users for admins, own history otherwise), readiness and stale/offline health; pause/resume controls only when authorized. Secondary settings contain Discord printer alerts, recipe/proofs, companion software, events and request receipts. |
| `#connections` | ManaSync collection access into CLC; separate optional CLC deck grant to ManaSync. Token entry/check/disconnect, unknown/offline/stale states and original-account recovery; secrets never enter local/session storage. |
| `#settings` | Profile/email verification, security/password, personal invitations when permitted and account deletion in a separate confirmed section. |
| `#admin/{section}` | Overview, Users, All invitations, App settings, Shared links, Audit log, System; deep links/Back, authorization and original confirmations retained. System owns backup/runtime/token cleanup/lockdown; Users owns user access/export. |
| `#guide/{topic}` | Getting started, Compare, Decks, Printing, Connections, Account, Reference. Old topic hashes redirect through aliases; Back/reload selects the correct topic. |
| Authentication/recovery | Login/register, verification, Forgot password, reset token routing, first-admin guidance, transient authentication failure without credential loss; private content remains gated until validation succeeds. |

## Print safety and recovery

- Exact card/printing identity, both DFC faces, art overrides, missing-art blocking,
  copy limits, basic-land defaults, sideboard options and manual additions/removals remain.
- Prepare/Batches changes presentation only. Pending creation, cancellation, queue and
  ManaSync confirmation requests retain their original identities across reload/account changes.
- The household queue comes from saved server jobs, not just the active Mac heartbeat.
  Waiting CLC batches remain separate from passes already submitted to CUPS. Authenticated queue
  summaries omit deck contents, artifact URLs, credentials and other users' private links.
- DFC packets keep printed labels and exact artifact/phase reload confirmation. No alert,
  dismissal, page navigation or printer recovery authorizes a back pass or a reprint.
- The Mac companion observes printer/active-pass errors and uses existing local/Discord
  transports with durable per-episode duplicate suppression. Reported CUPS status is the
  limit of hardware visibility; a Mac that is asleep cannot send a local alert.
- Real copies are credited only through an explicit usable-copy confirmation. One owned
  original of any printing permits unlimited proxies; incoming avoids duplicate shopping;
  unknown ownership stays unknown. The assembled paper marker is independent.

## Browser and automated verification

Use isolated static builds and synthetic API/artwork fixtures. Block service workers in
mocked application tests so intercepted requests cannot escape through a previous worker;
test the public offline shell separately. Never use household accounts/jobs as disposable
mutation fixtures. No real printer submissions, Discord sends, inventory changes or deck
edits are authorized by the QA harness.

The current pass covers desktop and 375px Chrome/WebKit, dark/light layouts, keyboard and
nested-modal focus, grouped export actions, captured comparisons, source loading races,
private user switches, durable request recovery, and error/offline/permission states.

Completed focused checks during implementation:

- Print organization: 202 Chrome/WebKit assertions covering standalone planning, paired
  art, Prepare/Batches preservation, station command recovery and manual records without PDF writes.
- Connections, Account, Administration and Guide: 64 assertions in each browser (128 total),
  including deep links, Back/reload, source-direction wording, maintenance placement and permissions.
- Decks, shared decks and Add decks dialog: 132 Chrome/WebKit assertions, including direct
  imports, source-review protection, captured comparisons and nested dialog focus.
- Fresh-list counts and exact owned batch links: 56 Chrome/WebKit assertions, including
  the supplied Jin Sakai fixture and identical-text paste detaching a stale baseline.
- Consolidated batch history: 62 Chrome/WebKit assertions covering all/own scope, an
  offline or inaccessible Mac, pagination, sorting, stale responses and cancellation races.
- Compare and common navigation: 62 Chrome/WebKit assertions covering captured print
  handoff, menu/dialog keyboard behavior, mobile layouts and shortcut scope.
- Library import endpoint: 15 real SQLite/router tests covering exact text, user scope,
  replay/conflict/deletion and unavailable/reused provider sources.

Release validation for v2.53.0: 1,106 JavaScript tests across 62 files and 150 native
companion tests passed. Production build and ESLint pass (five existing effect warnings);
both dependency audits report zero vulnerabilities. Native tests use fake CUPS and Discord
transports, including error deduplication and cancellation before a CUPS attempt.
The built Docker image preserves four synthetic queued/submitted/ready/canceled jobs
across restart and exposes their admin summaries. The arm64 package passes a repeat-install
check preserving ledger history and private configuration, with no launchd or print calls. Screenshots establish browser layout; they do not prove
native iOS keyboard behavior, printer color, cutter geometry or manual duplex alignment.
The accepted household color/landscape results and remaining physical tests are maintained
in [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).
