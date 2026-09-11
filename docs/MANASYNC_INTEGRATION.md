# ManaSync: inventory and purchasing integration context

**Current implementation:** the optional CLC bridge now provides scoped deck reads/creation,
reviewed proposals, original-ownership queries, and explicit physical-print reporting. See
[MANASYNC_BRIDGE.md](MANASYNC_BRIDGE.md) and [MANASYNC_PROPOSALS.md](MANASYNC_PROPOSALS.md)
for the implemented API and setup. The discussion below remains historical design context;
its proposed endpoints and companion stack do not define the shipped contract.

**Repository supplied 2026-09-11:** [dennysparking/manasync](https://github.com/dennysparking/manasync)
is now available at `/Users/cruv/GitProjects/manasync`. It uses its own current code and
database, not the FastAPI/SQLite stack proposed below. Pair its selected revision with CLC
using the explicit `CLC_SOURCE_PATH` setup in [MANASYNC_BRIDGE.md](MANASYNC_BRIDGE.md).
The dated conversation below is preserved rather than rewritten as implementation status.

**Owner policy update, 2026-09-11:** CLC checks whether the user owns at least one original
of any printing. That original covers unlimited proxies across all decks. CLC will not
add quantity-shortfall, allocation or exact-printing ownership requirements. Incoming
originals remain labeled as incoming and prevent duplicate buying. Shopping suggests one
original per missing card. Physical print quantities and ManaSync inventory reporting
still record actual produced copies. This supersedes the earlier inventory-reduction and
reservation ideas below for CLC; they remain historical context rather than CLC backlog.

Captured 2026-09-08 from the owner's supplied Discord proposal and ten conversation
screenshots (Photos 1–10). This note preserves the product discussion for future work;
it is not a shipped feature, finalized API contract, or verification of vendor capabilities.
"ManaSync" is a working name for the proposed companion app. The owner's later instruction
settles the CLC boundary: ManaSync handles collection management exclusively, and native
CLC collections and their expansion plans are removed. The vendor/reconciliation details
below remain proposals.

## Problem and intended outcome

Buying cards, maintaining Archidekt decks, scanning into ManaBox, and preparing proxies
currently require repeated manual bookkeeping. Separate orders make it easy to purchase
the same card again accidentally. Existing proxies are also hard to find/count, causing
unnecessary reprints. The goal is one per-user view of purchases, available real cards,
available proxies, and where those physical copies are stored or used.

Purchase records should eliminate rescanning known singles just to record ownership.
The owner would still explicitly confirm that mailed cards arrived. Pack openings and
other acquisitions without an order list can still use ManaBox scanning and CSV export.

## Proposed companion workflow

The Discord summary proposed a small self-hosted FastAPI + SQLite app, packaged in one
container with a PWA frontend, doing the following per user:

1. Poll Mana Pool for new orders through the user's account integration and resolve order
   lines to Scryfall printing IDs. Prefer that source to reading purchase emails.
2. Keep a purchase ledger, with manual entry for local game store purchases and other buys.
3. Generate ManaBox-compatible CSV batches for entries not yet transferred/imported.
4. Let a phone user hand the CSV to ManaBox through a share/import flow, avoiding scanning
   and retyping known purchases.
5. Accept ManaBox CSV exports back into the app to reconcile the ledger with the collection,
   including newly scanned pack pulls, rather than keeping only a purchase history.

This is a companion-app proposal, not a decision to replace CLC's React/Express/sql.js
stack. The exact CSV schema, mobile import flow, vendor authentication and polling behavior
must be checked against actual samples and current documentation before implementation.

## Direction established in the conversation

- **CLC and ManaSync cooperate.** CLC keeps deck comparison, artwork gathering and printing;
  the companion handles inventory and purchase history. The discussed division is for the
  owner to continue CLC while Denny starts ManaSync and shares its repository/backlog for
  coordinated work. No companion repository URL or access had been supplied when this
  discussion was captured on 2026-09-08; the 2026-09-11 update above supersedes that limitation.
- **Use ManaBox's scanner where useful.** Export an individual scan session as CSV with all
  its printing properties; import it through the PWA. A screenshot shows CSV described as
  exporting all properties, while text exports only card printing information.
- **PWA first.** Try the companion as a PWA and assess offline collection access and usability.
  Native iOS remains a possible later option if offline behavior or controls are inadequate;
  a PWA alternative may remain useful. Native implementation/distribution is not settled.
- **Separate real cards from proxies.** Track proxy quantities and potentially transfer them
  into a distinct **Proxies** binder in ManaBox. Show how many copies were printed and which
  decks currently use them. Reuse existing proxies when possible.
- **Track storage.** Label physical boxes/containers with names and QR codes. Scanning a box
  should open its contents in the app, so the user can locate cards without opening boxes.
- **Inventory informs deckbuilding.** Query ManaSync when comparing or editing a deck and
  show missing cards, available copies, and purchase/proxy options. Avoid unnecessary polling
  when the user is not working on a deck.
- **Help select purchases.** Show artwork and a Mana Pool link or compatible buy-list output.
  Desired policies include cheapest printing, preferred special/newer releases, and exact
  artwork matching. This discussion does not authorize automatic purchases.
- **Imports can be direct.** A Discord bot accepting CSV messages was brainstormed, tied to
  the submitting user. The discussion then recognized direct PWA input as sufficient; the
  bot is optional, not a requirement for the initial workflow.

## Inventory authority within the ManaSync/ManaBox workflow

The initial proposal treats ManaBox as the authoritative collection and ManaSync as its
backup/mirror plus purchase ledger. The later discussion leans toward a custom inventory
as the authoritative source, with ManaBox mainly serving as a scanner and lookup tool.
That preference is conditional on satisfactory offline collection browsing and sync.

CLC's responsibility is settled: it will not manage collections. Within the companion
workflow, decide whether ManaSync or ManaBox owns counts, edits and deletions before
implementing reconciliation. A hosted backup with
on-device offline data and reconnect synchronization is desired; the screenshots' claims
about ManaBox internals, uninstall behavior and TestFlight limits were conversation context,
not independently established technical facts.

Both participants discussed potentially rebuilding/rescanning their initial collections
because earlier records may be unreliable. Preserve this as an onboarding/reconciliation
option, not an instruction to delete existing data or require everyone to rescan.

## CLC integration shape discussed

The proposed read surface is an authenticated, per-user **`GET /owned`** on ManaSync.
CLC would compare its Archidekt deck requirements against that inventory. A separate write
operation would record CLC proxy batches in ManaSync; its URL/schema is not yet agreed.
The proxy entries could then be included in a ManaBox **Proxies** binder export.

Expected user experience: deck change → reuse a physical copy, buy, or proxy → track the
result in inventory without rescanning every card. Useful output includes "already ordered,"
"available in this box," and "you printed this many copies; these decks use them."

The former native CLC collection feature has been removed, including its tab, ownership
badges and API. Decision D8 in [DECISIONS.md](DECISIONS.md) now records ManaSync's exclusive
responsibility for collections. Legacy `collection_cards` rows/schema remain in CLC's
database and backups; no migration or export to ManaSync is implemented. If those records
are useful, agree on an explicit migration/reconciliation when ManaSync's format is ready.
Do not revive CLC's old matcher or collection manager as a parallel inventory system.

## Engineering implications to carry into design

These are implementation considerations inferred from the discussion, not approved endpoint
schemas or new standing decisions:

| Concern | Requirement for a reliable integration |
| --- | --- |
| Card identity | Keep stable Scryfall printing identity and relevant finish/language/condition data; separate card-level substitution from exact-art matching and preserve proxy artwork identity |
| Purchase state | Distinguish ordered/in-transit from received/usable; pending orders should prevent duplicate buying without claiming the cards are physically available |
| Inventory quantity | Separate real and proxy totals, unallocated copies, and copies assigned to decks or reserved for a pending job |
| Print history | A requested PDF or queued job is not an available proxy; define the confirmation event that credits successfully produced copies and handles failed/repeated prints |
| Allocation | Reconcile availability across decks so the same physical copy is not promised to several decks at once; moving a card should not create another copy |
| Repeat imports | Use stable order/line and import-batch identities; polling again or uploading the same CSV must not add quantities twice |
| CSV meaning | Distinguish an additive scan session from a full collection/binder snapshot; absence in a partial export must not delete other inventory |
| Export acknowledgments | Downloading/sharing a CSV does not prove ManaBox imported it; track prepared/exported/confirmed batches and use return exports to reconcile |
| Reconciliation | Show discrepancies and resolve conflicts deliberately, including sales, trades, corrections, partial receipts and lost/damaged proxies |
| User mapping | Link authenticated accounts using stable IDs; an optional Discord bridge must not assign collections by display name alone |
| Offline use | Define cached reads, pending edits, reconnect conflicts and hosted backup behavior before choosing an authoritative source |
| CLC print jobs | Freeze the inventory revision, selected copies/reservations and proxy-batch reference alongside the proposed immutable deck/art manifest |

## Vendor claims and questions still to validate

The Discord message reports ManaBox CSV import/export without an API, no Moxfield API for
this purpose, and an account-linked Mana Pool API with order access. Treat these as supplied
assumptions until checked. In particular, availability of a supported account/order API is
a different question from CLC's existing ability to import deck URLs.

Before integration, obtain the companion repo/backlog and agree on:

- ManaSync/ManaBox reconciliation authority, initial import/rescan strategy, and an explicit
  migration decision for any retained legacy CLC collection records.
- Actual ManaBox full-export, scan-session and proxy-binder CSV samples, including mobile
  import behavior, duplicate handling and preserved fields.
- Mana Pool credentials/scopes, order/line identifiers, status handling and printing matches.
- Per-user account linking, `/owned` response semantics, revision handling and idempotent
  proxy-batch writes; no shared database access is assumed.
- Inventory allocation/reuse and exact-printing policy, including purchases already on order.
- What event credits physical proxy inventory, independently of updating a paper-deck marker.
- Offline PWA expectations and criteria for revisiting native iOS.

## Relationship to the current printing plan

[PRINT_WORKFLOW.md](PRINT_WORKFLOW.md) remains the PDF/Epson/Silhouette plan. Add an
inventory-aware planning mode when ManaSync's contract is ready: first reuse available
real/proxy copies, account for pending orders/reservations, then generate the remaining buy
or print requirement. Keep a deliberate full-deck/reprint option.

The owner's follow-up requires the printing container to run Silhouette Card Maker's actual
code, clone/fetch the latest version, and retain a working installation in the bind mount
for fallback when upstream cannot be reached. The print plan records update/validation and
per-job version handling; this is still future implementation work.

**Drying tracking remains out of scope.** The household waits about an hour outside CLC;
this integration does not add drying, lamination or cutter-queue tracking. Logging produced
proxy copies is an inventory concern, and should not automatically advance the assembled
paper-deck snapshot marker.

The original context capture was documentation only. The owner's later instruction removes
native collection management from CLC; that removal preserves legacy stored rows. No
companion app, vendor connection, CSV integration, bot, native app, ManaSync inventory
mutation, PDF generator or printer submission is implemented in this milestone.
