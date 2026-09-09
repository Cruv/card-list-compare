# Review the ManaSync integration

This branch starts from `codex/project-audit-print-workflow` at
`f527e0ac34e0dbdcf854693d0407381d0a5717e0` (v2.44.1). It carries forward the local
ManaSync ownership, print confirmation, deck creation/proposal, and protected Archidekt
refresh work while retaining the native PDF/Mac print workflow and full printing identity.

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
Its native print manifest uses synthetic images; physical Epson printing and cutting still
need a hardware proof.
