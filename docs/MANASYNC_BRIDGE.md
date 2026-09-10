# Connect CLC, ManaSync, and Mana Pool

Use this CLC branch with the updated ManaSync server. Each application keeps its own
accounts, database, and secrets. An explicit user-granted connection maps each account.

## Operator setup

Run the CLC backend with a durable `DB_PATH` and its existing `JWT_SECRET`. CLC generates a
separate `.manasync-bridge-key` beside the database. Back up the database and this private key;
for managed secrets, set `MANASYNC_BRIDGE_KEY` to a base64 encoded 32-byte key instead. Keep
this key separate from ManaSync keys and JWT signing secrets.

Enter the ManaSync URL reachable from the CLC server in Settings. Any HTTP(S) domain or
port works without a server allowlist, including custom reverse-proxy paths. For example,
`https://manasync.example.com`, `http://192.168.1.10:9090`, or
`https://cards.example.com/manasync`. A bare domain defaults to HTTPS; include `http://`
for an HTTP-only LAN service. Credentials, query strings, and fragments are not part of
the backend URL, and redirects are not followed.
In ManaSync's disposable Docker integration stack, the browser opens CLC at
`http://localhost:8080` and ManaSync at `http://localhost:8081`, but CLC's outbound connection
uses **`http://app:8081`**. ManaSync's CLC connection uses **`http://clc`**.

## Paused account delivery

Suspending a CLC account pauses its ManaSync requests, including queued confirmations,
dismissals, and artwork uploads. The outbox keeps its original operation IDs, credentials,
and payloads. Reinstating the account lets those same operations resume; it does not create
new inventory increments. A request already sent before suspension may finish remotely,
so receipt recovery still uses the original identity.

## Connect your accounts

1. In ManaSync, create a dedicated API token with `inventory:read` and `proxies:write` only.
2. In CLC, open Settings → Account → ManaSync collection connection. Enter the server-reachable
   ManaSync backend URL and that token. The saved view shows the explicit account ID and name.
3. To import CLC decks into ManaSync, create a separate token in CLC's integration-access
   settings with `decks:read`. Add `decks:propose` only if sending edits back for review.
   Enter that token in ManaSync's CLC connection. See [proposal workflow](MANASYNC_PROPOSALS.md).

## Ownership and buying originals

After **Review print list** in the Printing tab, the selected print list shows ManaSync
ownership and a **Review in Mana Pool** link for missing originals. Whole-snapshot, changes,
and sideboard choices use the reviewed print quantities. Printing remains available whether
you own the cards or choose to shop. The same check is available in Full Deck under
**ManaSync ownership and Mana Pool shopping**.
Choose interchangeable printings or exact printing and finish. CLC shows free originals,
originals allocated to decks, incoming originals, reusable proxies, and physical locations.
It also displays the time of the last successful ownership refresh. A failed connection or
unresolved exact ID is shown as unknown; shopping never treats unknown as zero.

Select the shortage rows and click **Review in Mana Pool**, or copy the displayed text.
The link uses Mana Pool's `/add-deck?deck=` UTF-8/base64 prefill. Long lists use the copy/paste
fallback. Printing preference is retained in the text when known. Review Mana Pool's parsed
list and foil/language options before buying; CLC does not submit an order. `realOwned` already includes
incoming originals, so incoming is not subtracted a second time. Proxies do not reduce the
original-card shopping shortage. Multiple entries for one card share one ownership budget.

## Physical printing

Prepared native PDF batches automatically appear in **ManaSync → Proxy binder → Pending
prints**, with planned quantities and the exact artwork. These records are outside inventory:
they do not reduce shopping shortages, satisfy deck allocations, or count as reusable proxies.
CLC retains the images and publishes the plan when its connected ManaSync account is reachable.

After printing, confirm usable copies and a physical destination in ManaSync, or open the
batch's **View proxy confirmation** panel in CLC. Both apps use the same pending record.
Confirming eight of ten adds eight proxies and leaves two pending. **Dismiss remaining**
closes those two as failed/cancelled without removing the eight already confirmed. CLC
refreshes the result and stops requesting quantities that were resolved in ManaSync.
Lost responses replay the same saved decision. Conflicting decisions from two clients require
fresh review of the current pending revision before any further inventory mutation.

### Separate manual confirmation lists

Use **Queue full deck for printing** or a per-card Queue button to keep a confirmation list
in CLC across restarts. Prepare PDFs and native Mac jobs in the separate Print panel, or use
the image/MPCFill tools. This confirmation list does not submit a physical print job.
Downloading images, generating XML/ZIP/PDF files, queueing jobs, and Mac spooler completion
never acquire inventory. Confirm only usable physical copies after checking the output.

After printing, enter only the quantity physically printed and choose a destination
(default Unassigned). Confirming two of five persists one two-card increment before delivery;
confirming three later persists a second increment. Cancelling remaining plans leaves confirmed
prints intact. A deliberate reprint starts another queue item and receives new operation IDs.
Disconnected confirmations stay in CLC and can later be explicitly reported to the shown account.

Each connected increment freezes its UUID, exact command, card metadata, destination, original
encrypted token, account, and backend. Known printing/oracle IDs are preserved. A lost response
retries identical bytes with the original actor. Only a valid ManaSync receipt marks it reported;
its lot identity is retained. Transport/server errors retry with backoff, capped at six automatic
attempts; **Retry original operation** uses the same UUID after that. Authentication problems
request reconnection, malformed/scope failures stay visible, and conflicts require review.

If the connection changes, old increments stop delivering. **Inspect receipt and holding** uses
the current token to read the same account's historical receipt for the original actor and
current holdings. A valid receipt resolves an uncertain delivery without acquiring again.
Missing receipts or changed holdings require review; CLC never sends the original acquisition
through a replacement actor just because a receipt is absent.

A reported holding can be inspected and adjusted to an explicitly reviewed total with a reason,
or moved to a physical location. These use new durable operation IDs and the displayed lot
revision. A concurrent inventory change fails visibly and requires inspecting/reviewing again.
The Proxy binder remains a virtual view across these physical locations.

## Keep the actual proxy artwork

When a native batch's immutable PDFs are ready, CLC retains verified copies of the exact
front/back images and publishes its pending plan automatically. **View proxy confirmation**
opens the shared review and retries staging if required. Confirming usable quantities adds
those images to the new proxy holdings; a deliberate reprint uses a new native print batch.

CLC groups copies by card identity and front/back image hashes. Reopening the same batch
reuses its confirmation items, including after native PDF/artifact cleanup. Automatic staging
retains the images before cleanup. An older batch whose images were already deleted cannot
be reconstructed from its checksum. The retained `manasync-artwork/` directory beside `DB_PATH` must be backed up
with the database and bridge key while confirmations remain pending.

Before publishing a pending plan, CLC uploads each retained JPEG/PNG face using
`PUT /api/v1/proxy-art/:sha256` with the original scoped token and expected account. The
response is `{ sha256, url, contentType, bytes }`. Each face is capped at 20 MiB and its
SHA-256, type, byte count, and returned account-specific URL must match. The unchanged
pending plan includes `card.proxyArtwork: { front, back? }`, referencing those URLs;
Scryfall/oracle card identity remains separate. Upload retries deduplicate by account/hash.
Only an acknowledged inventory receipt marks a confirmed increment reported.

The pending-plan API is `PUT /api/v1/pending-proxies/:id` with an immutable
`{source:'clc',sourceRef:jobId,card,quantity,label?}` body. Repeating that ID and payload
returns the same plan. `GET` of the item returns current confirmed, dismissed, and remaining
quantities plus confirmation history. `POST /:id/confirm` uses
`{operationId,quantity,containerId,expectedRevision}`; `POST /:id/dismiss` uses
`{operationId,expectedRevision,reason?}`. Confirming and acquiring proxy inventory happen in
one ManaSync transaction. Planned card/artwork metadata stays immutable across both decisions.

ManaSync stores the image bytes in its database, so its backups and proxy holdings retain
artwork independently of CLC. The Proxy binder displays this art, including its back face;
normal catalog enrichment does not replace it with Scryfall images. Previously queued manual
confirmations without a print-manifest attachment keep their normal card artwork. A ManaSync
version without the artwork/pending endpoints leaves the batch waiting with an update
message; CLC never silently discards the art or changes its operation ID. Native pending
decisions require a connection to the originally selected account and backend.

## Validation

Run `npm test`, `npm run lint`, and `npm run build` in CLC. Bridge regression tests cover
scope/account isolation, encrypted credentials, offline and partial confirmations, duplicate
requests, lost replies, immutable retries, credential rotation and historical receipts,
correction revisions, ownership unknowns, exact printings, UTF-8 purchase links, and batched queues.
ManaSync's `scripts/verify-clc-bridge.mjs` exercises both actual servers using disposable state.
