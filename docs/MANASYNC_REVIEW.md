# Review the ManaSync integration

PR #5 was merged into `codex/project-audit-print-workflow` at `8b31811`, bringing ManaSync
ownership, pending proxy artwork, deck creation/proposals, and protected provider refresh.
Its original base was v2.44.1; the integrated branch retains the Mac station dashboard,
managed installer/update/rollback and accepted Epson landscape/color recipe. CLC `7d75fef`
(v2.48.0) also includes labeled one-sheet DFC packets and explicit flip alerts.
The current v2.48.1 follow-up aligns large deck-creation/proposal text and transport limits with ManaSync
and accompanies its explicit rejection of unsupported etched publication.

The paired ManaSync server needs the scoped inventory/deck integration APIs, persistent
proxy artwork, and pending-proxy APIs described in [the bridge contract](MANASYNC_BRIDGE.md).
A server without the new endpoints leaves prepared batches waiting with an update message.

## Try the pending-print workflow

1. Connect CLC to ManaSync in Settings with `inventory:read` and `proxies:write`. Use the
   server-reachable domain/port; a bare hostname uses HTTPS. Keep both databases durable.
2. In a CLC deck's Printing tab, review a small list. Check ownership and the selected Mana
   Pool shortage link. Prepare a batch using saved front/back MPC art or Scryfall printings.
3. When its PDFs are ready, open ManaSync's **Proxy binder → Pending prints**. The prepared
   copies and actual artwork appear there automatically. Available inventory is unchanged.
4. For a three-copy batch, confirm one usable copy into a physical location. The Proxy binder
   now owns one copy; two remain pending. Open **View proxy confirmation** in CLC to see
   the same quantities, including the confirmation made in ManaSync.
5. Dismiss the remaining two as a failed/cancelled print. CLC shows quantity review complete,
   with one confirmed and two dismissed. The existing proxy remains in its chosen location.
6. Open the confirmed holding and flip its artwork. The stored front/back faces remain attached
   after native PDF cleanup, catalog enrichment, and a holding move or quantity adjustment.
   Faces already cached on the device can be viewed offline.

Opening the same batch repeatedly reuses its pending records. Generate a new batch for an
intentional reprint. If a response is lost, retry its saved decision. If another client changed
the pending quantities, refresh and review them before making a new decision. Existing saved
decisions retain their account and actor; changing accounts cannot move a batch's pending work.

## Other integration checks

- Review whole snapshots, changes between versions, and optional sideboard copies. Shopping
  uses that reviewed list; originals including incoming purchases reduce shortages once.
  Proxies and unknown ownership never turn into a false original-card shortage calculation.
- Create a local ManaSync deck; explicitly grant `decks:create` to create it in CLC. Existing
  deck edits arrive as proposals and require review before changing the digital snapshot.
- Refresh an Archidekt deck after accepting local changes. An unchanged source preserves
  those edits; changed source text offers keep-local, use-source, or merge review.
- Existing manual confirmation lists retain durable partial increments, disconnected saving,
  original-actor receipt recovery, and revision-checked holding corrections.

## Verification commands

```sh
npm ci
npm --prefix server ci
npm test
python3 -m unittest discover -s companion/mac -p 'test_*.py'
npm run lint
npm run build
npm audit
npm --prefix server audit
docker build -t clc-review .
```

The actual [ManaSync checkout](https://github.com/dennysparking/manasync)'s
`scripts/verify-clc-bridge.mjs` runs both real servers against
disposable databases. Set `CLC_BRIDGE_BROWSER=1` to include browser interaction, custom-art
checks, partial confirmation/dismissal across apps, and desktop/phone layout captures.
Its native print manifest uses synthetic images. The household Adobe color test and corrected
native landscape sheet have passed; v6 cutter geometry and manual DFC refeed alignment
still need physical proof. See [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).
Use the explicit sibling-checkout/`CLC_SOURCE_PATH` commands in
[MANASYNC_BRIDGE.md](MANASYNC_BRIDGE.md#source-checkouts-and-paired-verification); the old
nested companion path is not present in a fresh ManaSync clone.

## Integrated follow-up verification — 2026-09-10

The v2.47 integration retains the current Mac station controls and accepted household
recipe. Follow-up v2.47.1 addresses proposal draft/retry loss, provider collector-number
identity loss, manually assigned commander loss on source review, suspended-account
outbox delivery, and database exports disabling foreign-key cleanup. The integration also
permits authenticated artwork blob previews under the production image policy.

Validation: 784 app tests and 68 companion tests pass; lint has zero errors and seven
existing warnings; both dependency audits are clean. The production frontend and Docker
image build. An isolated container with disposable accounts and synthetic artwork passed
46 API checks for scoped access, account isolation, private artwork, and fake-station
pause/receipt replay. No real print job was claimed, queued, or submitted.

Browser checks verified private artwork under production CSP, draft retention through
refresh/switch, preservation during a concurrent-client change, explicit re-review, and
committing the reviewed digital snapshot without changing the paper marker. Recovery
regressions cover authentication failures, uncertain responses, malformed receipts, and
multiple saved operations. At this 2026-09-10 checkpoint the paired ManaSync harness was
outstanding because its repository was not yet available locally; these CLC fixtures did
not establish cross-app compatibility.

## Paired API and browser acceptance — 2026-09-11

The supplied ManaSync repository is now cloned at `/Users/cruv/GitProjects/manasync` from
`https://github.com/dennysparking/manasync.git`, with `main` baseline `ef22e79`. The selected
CLC checkout is `/Users/cruv/GitProjects/card-list-compare`, branch
`codex/project-audit-print-workflow`. Tested CLC application code is **`b520c5c` (v2.48.1)**,
following the initial `7d75fef` baseline. Tested ManaSync code and its verification harness
are committed at **`9658bbd`** on `codex/clc-bridge-verification`, including the etched-finish
fix from `c98f776`, based on `ef22e79`. Set `CLC_SOURCE_PATH` explicitly
so imports, child processes and browser checks use this same integrated CLC checkout.

The complete paired **HTTP and browser harness passed with exit 0 on 2026-09-11**, using
real CLC/ManaSync servers with disposable PostgreSQL 16 and CLC SQLite data. The harness
selects the explicit CLC source, uses corrected source fixtures and follows ManaSync's
current Settings UI. It was not a test of the unchanged starting baseline commits alone.

The run verified scoped account access; latest/paper separation; proposal submission,
review and replay; exact manual-deck creation and Cloud deck round trips; ownership and
shopping; partial proxy confirmation, cancellation and deliberate reprints; lost receipts
and replacement-token recovery; protected source refresh/review/merge; and shared pending
plans with retained custom artwork and confirmation/dismissal from both applications.
The positive source-sync fixture explicitly selects a supported normal finish while
retaining the original captured fixture. A separate real HTTP 502 test verifies that etched
upstream data is rejected without replacing the saved deck or changing holdings.

ManaSync's final regression run passed **1,160 tests across 155 files, with one test skipped**;
TypeScript checking, its production build and dependency audit also passed. CLC v2.48.1
passed **842 app tests across 50 files and 103 native-companion tests**, full ESLint and
its production build; both CLC npm dependency audits reported zero vulnerabilities.

A disposable ARM64 production Docker/nginx run passed **31 checks, including 26 HTTP
requests**. It accepted 500,000-code-point JSON-escaped creation text and a 12,000,145-byte
two-field proposal, committed/replayed the reviewed replacement once, and rejected missing
or insufficient authorization, one-code-point-over fields, an unrelated oversized JSON body,
and bodies above 12 MiB. Durable state remained one deck, two snapshots and one revised
proposal with paper state unchanged. The served UI was v2.48.1, security headers were
present, and the runtime used UID 1000. `PRINT_ENABLED=false` kept generation and physical
jobs disabled; the temporary container was removed.

The browser run exercised CLC settings, proposal receipts, protected source review,
ownership, Mana Pool shopping and print-queue UI at **1440, 393 and 320 px**. The real
ManaSync UI verified exact custom front/back art, partial confirmation and dismissal,
the default offline text view, and offline cached face flipping after opting into artwork
through **More → Settings → Appearance settings**. No fatal browser or unexpected API
errors were recorded. Local evidence is in `browser.log` under the disposable
`clc-manasync-paired-ol2e9b9r` run directory; screenshots are under ManaSync's
`test-results/clc-bridge-ui/`.

Earlier dated ManaSync verification remains historical. This acceptance did not merge
either branch to `main`, deploy an app, submit a physical printer job or operate the cutter.
Physical v6 cutting/DFC alignment and installed-iPhone acceptance remain separate.
