# Review the ManaSync integration

PR #5 brings ManaSync ownership, pending proxy artwork, deck creation/proposals, and
protected provider refresh into `codex/project-audit-print-workflow`. Its original base was
v2.44.1; the integrated branch also retains the v2.46 Mac station dashboard, managed
installer/update/rollback, and the accepted Epson landscape/color recipe.

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

The paired ManaSync checkout's `scripts/verify-clc-bridge.mjs` runs both real servers against
disposable databases. Set `CLC_BRIDGE_BROWSER=1` to include browser interaction, custom-art
checks, partial confirmation/dismissal across apps, and desktop/phone layout captures.
Its native print manifest uses synthetic images. The household Adobe color test and corrected
native landscape sheet have passed; v6 cutter geometry and manual DFC refeed alignment
still need physical proof. See [HOUSEHOLD_PRINT_RECIPE.md](HOUSEHOLD_PRINT_RECIPE.md).

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
multiple saved operations. The paired ManaSync server harness remains outstanding until
its repository and matching API implementation are available; CLC fixtures are not proof
of cross-app compatibility.
