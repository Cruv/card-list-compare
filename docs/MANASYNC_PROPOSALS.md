# ManaSync deck access and review

In CLC, open **Account Settings → ManaSync access to CLC**. Create a token with
deck reads and, if desired, **Allow deck proposals for review** and the separate
**Allow immediate creation of new decks**. Existing tokens keep their permissions. Copy the token
into ManaSync's CLC connection while signed into the intended ManaSync account.
The token is displayed once; CLC stores only its SHA-256 hash. Revoke it from the
same settings section to stop access immediately. Ordinary CLC login tokens
continue to work with the new read endpoints.
Legacy login tokens keep read/proposal access and do not gain immediate creation.

CLC and ManaSync keep separate accounts and databases. The connection identifies
the CLC instance and authenticated account explicitly; deck names and tracked
Archidekt usernames never select an account. CLC's integration token grants only
`decks:read` and optionally `decks:propose` or `decks:create`. It cannot review its own proposals,
change the paper marker, or call CLC's ordinary deck editing routes.

## Read contract

`GET /api/integrations/v1/context` returns:

```json
{
  "version": 1,
  "instanceId": "stable-instance-uuid",
  "accountId": "1",
  "capabilities": { "proposals": true, "deckCreation": true, "sourceLinks": true,
    "sourceTracking": ["archidekt", "moxfield", "deckcheck"] },
  "scopes": ["decks:read", "decks:propose"]
}
```

`GET /api/integrations/v1/decks` adds a `decks` array. Each deck has `id`, `name`,
`url`, `sourceLink`, `latestSnapshotId`, `paperSnapshotId`, and `snapshots`. `sourceLink`
is explicitly null for an unlinked manual deck, or `{provider, deckId, url}` for
Archidekt, Moxfield or DeckCheck. Tracked Archidekt IDs are read from the existing
tracker; manual decks retain only explicitly supplied source identities. URLs
are canonical HTTPS links, independent of presentation titles and share parameters.
The full account library is returned so callers can check all sources before
creating a new deck. A client that needs source deduplication must require
`capabilities.sourceLinks` and complete source metadata rather than treating a
legacy or failed read as an empty library. Every snapshot has
stable string `id` and `deckId`, exact `deckText`, SHA-256 `textHash`, independent
`isLatest`/`isPaper` flags, `createdAt`, `cards`, `unresolvedLines`, and `origin`.
Card entries retain per-line names, quantities, sections, printing metadata,
finish, and raw lines. Missing oracle/printing IDs stay null. Raw snapshot text
is authoritative and preserves notes and unrecognized lines.

Snapshots created in the same second remain distinct and are ordered by their
IDs as a tie-breaker. A missing paper marker is null. Deleted source decks do not
request deletion of ManaSync holdings. Invalid, expired, or revoked integration
credentials return 401; an insufficient scope returns 403; an inaccessible deck
or proposal returns 404.

Each deck also has `sourceTracking`: null for an untracked manual source, or
`{status, message}` for a native tracker. Status is `tracked` or `awaiting_source`;
a paused schedule has an explicit message. Provider access is separate from a
pending source-review decision. A failed read retains the last good snapshots
and paper marker and exposes its reason in CLC and the structured bundle.

## Automatically tracking a provider deck

`POST /api/integrations/v1/decks/track-source` requires `decks:create`. ManaSync
calls it when a TapTogether provider URL should also be tracked in CLC. Send:

```json
{
  "operationId": "durable-operation-uuid",
  "expectedInstanceId": "stable-instance-uuid",
  "expectedAccountId": "1",
  "sourceLink": { "provider": "archidekt", "deckId": "123", "url": "https://archidekt.com/decks/123" },
  "name": "Optional display name"
}
```

Canonical identity, deck and immutable intent persist before the provider fetch.
Repeated URLs and new operation IDs reuse one account-owned deck. A linked manual
deck is promoted in place, retaining current text, snapshots, paper marker and
notes. Native trackers keep their refresh preferences. New and promoted trackers
default to hourly refresh with an immediate first fetch. Archidekt retains its
numeric source ID; other providers use their explicit public ID and a negative
local legacy sentinel. Requests use fixed HTTPS endpoints, bounded reads and
deadlines. A partial or missing list never becomes an empty snapshot.

The response is the normal deck bundle plus `operationId`, `linkedExisting`,
`replayed`, and `tracking:{status,provider,message}`. Receipts survive lost replies
and restarts; current source state is available through ordinary library reads.
Ambiguous sources return `409 source_identity_conflict`; changed operation
contents return `409 operation_conflict`; deleted results return
`410 tracked_deck_deleted`. Optional `deckText` bootstrap is at most 500,000
characters and only applies to a new deck with no acknowledged source baseline.
Normal callers omit it and fetch the provider's real list.

Provider edits remain on Archidekt, Moxfield or DeckCheck. CLC owns snapshots and
paper history; ManaSync owns storage and organization. Verified changes may
advance a source-following CLC head, while independent CLC edits require source
review. Tracking never changes holdings or the paper marker.

CLC's current text format cannot distinguish etched from ordinary foil. Explicit
etched source cards therefore return `awaiting_source` with an unsupported-finish
reason, retaining all last good snapshots and paper state. They are never mapped
to ordinary foil. Moxfield can deny public API reads with 403; this is also a
visible awaiting state, not a successful live sync. The existing CLC convention
excludes maybeboard/considering and token-only boards from playable snapshots.
Missing printing metadata remains unknown.

Live read verification used public decks without credentials or database writes:
Archidekt returned its card data and DeckCheck returned a parsed list. Moxfield
returned 403, validating the unavailable path. Fixture tests cover normal and foil
Moxfield parsing, malformed/partial data, etched refusal, and bounded transport.

## Creating a new deck

`POST /api/integrations/v1/decks` requires `decks:create`. Send:

```json
{
  "operationId": "durable-operation-uuid",
  "expectedInstanceId": "stable-instance-uuid",
  "expectedAccountId": "1",
  "name": "My new deck",
  "deckText": "1 Sol Ring\n"
}
```

The name is nonblank and at most 200 characters. Text may be empty and is at
most 500,000 characters. CLC preserves both exactly, including line endings.
The result is the read-contract bundle above with exactly one `decks` entry,
plus `operationId`, `replayed`, and `linkedExisting`. Status is 201 for creation
and 200 for replay or reuse of an existing source deck.
The deck has one initial digital snapshot, no paper marker, and no upstream URL.

Persist the operation ID, payload, and selected account/instance before sending.
Retries return the saved deck without creating another, including after rotating
to an explicitly authorized token for the same account. A changed payload gives
`409 operation_conflict`; different account/instance pins give
`409 connection_changed`. A deleted result gives `410 created_deck_deleted`
instead of recreating the deck. The deck, first snapshot, and receipt commit
atomically. Existing tokens do not gain creation access on upgrade.

These decks appear under **Manual decks** in CLC. Archidekt refresh, bulk refresh,
and scheduled refresh skip them. Creating a deck does not acquire, move, print,
or remove cards. Subsequent edits still use the reviewed proposal flow.

Creation optionally accepts `sourceLink`, for example
`{"provider":"archidekt","deckId":"123","url":"https://archidekt.com/decks/123"}`.
The provider, ID and URL must agree. If that account already tracks the source,
CLC returns its existing deck with `linkedExisting: true`; the submitted name and
text do not replace anything, and no snapshot or paper marker changes. Otherwise
the new manual deck and its source binding commit with the receipt. Different
operation IDs still resolve to the same saved source. The same provider deck may
belong independently to different accounts. An ambiguous legacy duplicate returns
`409 source_identity_conflict`, requiring review rather than an automatic merge.
Source claims are included in the immutable operation payload. Replays return the
original receipt, even if the owner later edits the deck.

If an Archidekt source first arrived as a manual deck, tracking that source through
CLC later promotes the same deck ID to its selected Archidekt owner. Existing
snapshots, current text, notes, and paper marker remain intact. Its first upstream
observation goes through the ordinary source review: a different list with no
acknowledged baseline is staged for review. Repeated tracking reuses the same
deck; ambiguous existing duplicates are rejected before any metadata changes.

## Delivering a proposal

`POST /api/decks/:deckId/proposals` requires `decks:propose` and this JSON shape:

```json
{
  "operationId": "durable-operation-uuid",
  "baseSnapshotId": "42",
  "baseTextHash": "sha256-of-exact-base-text",
  "baseText": "1 Sol Ring\n",
  "proposedText": "1 Sol Ring\n1 Arcane Signet\n"
}
```

The base hash covers the exact UTF-8 text, including line endings and final
whitespace. Keep the operation ID and payload together before sending. A repeat
with the same user, deck, operation ID, and payload returns the same proposal.
Changed payloads conflict. Replacing an integration token for the same account
does not change submission identity.

The response is a flat receipt: `proposalId`, `operationId`,
`proposalRevision`, `status`, `baseSnapshotId`, `baseTextHash`, `baseText`,
`proposedText`, `reviewedText`, `currentLatestSnapshotId`, `currentLatestTextHash`,
`currentLatestText`, `resultSnapshotId`, `resultTextHash`, `createdAt`, and
`updatedAt`. Result fields are null until an accepted or revised decision.
Submission does not create a deck snapshot or change a paper marker.

Poll `GET /api/decks/:deckId/proposals/:proposalId` with proposal access for the
current receipt. Status is `pending_review`, `needs_rebase`, `accepted`,
`revised`, or `rejected`. A changed or pruned basis becomes `needs_rebase` and
increments the proposal revision. The submitted base and proposed text remain
available even when old snapshots are pruned.

## Reviewing in CLC

Open the deck's **ManaSync proposals** section. Select the proposal and compare
the saved base, proposed deck, and current digital latest. Accept the proposal,
commit explicitly reviewed replacement text, or reject it. When the basis has
changed, review all three texts and use **Commit reviewed revision** or reject.
The original proposed text is preserved as evidence.

Only a CLC login session can list and review proposals. The review endpoint is
`POST /api/decks/:deckId/proposals/:proposalId/review`:

```json
{
  "operationId": "durable-review-operation-uuid",
  "expectedProposalRevision": 1,
  "expectedLatestSnapshotId": "42",
  "expectedLatestTextHash": "sha256-of-current-digital-latest",
  "action": "revise",
  "reviewedText": "1 Sol Ring\n1 Arcane Signet\n"
}
```

Actions are `accept`, `revise`, and `reject`. Send `reviewedText` only for
`revise`. When there is no current snapshot, the expected latest ID and hash
must both be null. A concurrent decision returns `409 proposal_changed`; a
concurrent digital edit returns `409 latest_changed`. Neither creates a
snapshot. Refresh the review and choose again.

CLC saves a review operation before sending it from the browser. If its response
is uncertain, **Retry saved review** reuses the exact operation and payload.
The decision, resulting snapshot, and durable receipt are committed atomically.
Replaying a successful review returns its original receipt without creating
another snapshot. The new snapshot's `origin` identifies `source: "manasync"`,
the `proposalId`, and the submission `operationId`, so polling can acknowledge
the delivered draft without echoing it back.

Accepted or revised text becomes one digital snapshot. An unchanged Archidekt
refresh preserves that version. If Archidekt later changes while the current
deck differs from the last reviewed source, its new list waits for an owner
decision in the source review panel. The proposal receipt still identifies
its own resulting snapshot. Proposal decisions do not acquire,
move, print, or remove inventory. Update the paper marker separately after
making the corresponding physical deck changes.

## Reconciling Archidekt changes

The deck page shows source status above its normal snapshot views. **Local edits
protected** means the current digital deck differs from the reviewed source;
**Archidekt changes need review** means a new source version is waiting. Library
badges expose the same distinction. Review the previous source, current CLC deck,
and latest source; keep the current deck, use the source, or save a reviewed merge.
Keeping acknowledges that source version without creating a digital snapshot.
Unchanged subsequent fetches do not reopen that review. Source-only decks can
continue updating automatically. A legacy deck without a known source baseline
requires review before a different fetched list can replace its current deck.

`GET /api/decks/:deckId/source-sync` requires an owner login session and returns
`status`, `revision`, `baseText`, `sourceText`, `currentText`, `currentSnapshotId`,
`currentTextHash`, `checkedAt`, and `pending`. Source and baseline fields can be
null before the first observation. Baseline text is stored separately from
snapshot history and survives pruning.

`POST /api/decks/:deckId/source-sync/review` takes `operationId`, `expectedRevision`,
`expectedCurrentSnapshotId`, `expectedCurrentTextHash`, and `action` (`keep`,
`source`, or `merge`). Include `reviewedText` only for `merge`. It returns the
resulting state plus `resultSnapshotId` and `replayed`. A different source or
current digital snapshot rejects a stale decision. The browser preserves the
exact decision before sending so a lost response can be recovered after reload;
an acknowledged review updates the baseline atomically with its result/receipt.
Integration tokens cannot make these decisions, and no review writes to Archidekt.

## Local checks

Run `npm ci` in both the repository root and `server`, then `npm test`,
`npm run lint`, and `npm run build` in the root. Proposal tests use disposable
databases and exercise account isolation, scope enforcement, immediate
revocation, same-second snapshots, immutable bases, concurrent versions,
transaction rollback, and receipt replay across a database restart.
