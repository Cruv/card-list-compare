# Deck Text Format

The deck text format is CardListCompare's core data contract. Full deck lists are
stored as plain text in `deck_snapshots.deck_text`, one card per line — printing
metadata is embedded in the text itself rather than in database columns, so every
snapshot is self-contained and survives schema changes.

Everything that parses or emits this format must agree on it. The **normative
definition is executable**: `src/lib/invariants.test.js` ("card-line pattern
single source") pins the shared pattern's behavior on a canonical corpus and
guards against forked copies. This document explains the format; when the two
disagree, the tests win.

## Grammar

```
<qty>[x] <Card Name> [(SET)] [[COLLECTOR] | COLLECTOR] [*F*]
```

| Part | Meaning | Example |
| --- | --- | --- |
| `qty` | Positive safe-integer copy count, digits, optional `x`/`X` suffix | `4` or `4x` |
| `Card Name` | Verbatim card name; DFC names use ` // ` | `Sheoldred // The True Scriptures` |
| `(SET)` | Set/edition code, alphanumeric | `(m10)`, `(2xm)` |
| `[COLLECTOR]` | Bracketed collector number — CardListCompare's own format | `[227]`, `[136p]`, `[DDO-20]` |
| bare `COLLECTOR` | Unbracketed collector number, **only valid directly after a set code** — Arena/Archidekt style | `(C20) 215` |
| `*F*` | Foil marker | `*F*` |

Collector numbers are alphanumeric with hyphens (promos: `136p`, `DDO-20`, `2022-3`).

Structure lines (defined in `src/lib/constants.js`):

- Section headers: `Sideboard`/`SB`, `Mainboard`/`Main`/`Deck`, `Commander`/`Commanders`/`Command Zone` (optional trailing `:` or `.`); Archidekt's `# Sideboard` is also recognized
- Trailing commander tags: `(Commander)` and `[Commander{top}]` (also `[Commander]`)
- `SB:` line prefix marks a single card as sideboard
- Comments: lines starting with `//` or `#`, except the `# Sideboard` header
- CSV fallback: `4,Lightning Bolt` (quantity, name — no metadata)

A blank line ends a populated Commander section and returns to the mainboard.
When any explicit Commander header is present, later blank lines only separate
groups visually; use a `Sideboard`/`SB` header or `SB:` prefixes to identify the
sideboard. Without an explicit Commander header, a blank line after mainboard
content retains the legacy implicit-sideboard behavior.

### Examples

```
4 Lightning Bolt
4x Lightning Bolt
1 Snapcaster Mage (UMA) [63]
1 Nazgul (ltr) [336p]
1 Sol Ring (c21) [263] *F*
1 Sword of Dungeons // Dragons (H17) [DDO-20]
2 Atraxa (C20) 215 *F*

Sideboard
2 Fatal Push (2xm) [69]
```

## The card-line regex

The card-line regex has exactly **one normative home**:
**`CARD_LINE_PATTERN` in `src/lib/constants.js`** (also `LINE_PATTERNS[0]`).
Every consumer imports it — the client parser, and on the server both
`parseLine`-based code and `server/lib/enrichDeckText.js` (the Dockerfile ships
`constants.js` to the image). If you change deck-line syntax, change it there,
then update the behavior pins in `src/lib/invariants.test.js` and this document.

**Never fork a local copy.** Historical collection-import and enrichment forks
corrupted set-less multi-word names and drifted on collector-number handling.
Native collection management has been removed in favor of ManaSync; the shared
parser remains the contract for deck import and enrichment.

```
/^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+\[([\w-]+)\]|\s+([\w-]+))?)?(\s+\*F\*)?\s*$/i
```

| Group | Captures |
| --- | --- |
| 1 | quantity |
| 2 | card name |
| 3 | set code |
| 4 | bracketed collector number (nested — requires a preceding set code) |
| 5 | bare collector number (nested inside the set-code group) |
| 6 | foil marker |

Consumers that index groups directly (e.g. `enrichDeckText.js`) must use
`cn = m[4] || m[5]` and `foil = m[6]`.

### Why both collector alternatives nest inside the set-code group

Without a set code to anchor it, a trailing word like `Mox` or `215` in a card
name is indistinguishable from a collector number. Nesting the collector
alternatives inside the set-code group means they can only match after `(SET)`,
preventing the regex from eating the last word of ordinary card names. The
corollary: `1 Nazgul [336p]` (no set code) parses as a card literally named
`Nazgul [336p]` — set-less brackets are part of the name, everywhere, by design.

### Formerly drifted (resolved in v2.40.2)

For history: before unification the server enrichment fork disagreed on
`2 Atraxa (C20) 215 *F*` (folded `(C20) 215` into the name) and `1 Nazgul [336p]`
(extracted a set-less collector number). The unified behavior for both inputs is
pinned in `src/lib/invariants.test.js` and exercised by enrichment tests in
`server/lib/enrichDeckText.test.js`.

## Parser output contract

`parse(rawText)` in `src/lib/parser.js` returns:

```js
{
  mainboard: Map<key, entry>,
  sideboard: Map<key, entry>,
  commanders: string[],        // flat array of display names — NOT entry objects
}
```

Each entry is exactly:

```js
{
  displayName: string,      // original-case card name — there is NO entry.name
  quantity: number,
  setCode: string,          // '' when absent
  collectorNumber: string,  // '' when absent
  isFoil: boolean,
}
```

Map keys come from `cardIdentityKey` in `src/lib/cardIdentity.js`. A line without
set, collector number or foil metadata uses its normalized lowercase full name.
Otherwise the key is `name|set|collector|finish`, with `foil` or `nonfoil` as the
finish. Name whitespace/apostrophes and set/collector casing are normalized for
keys while the entry retains its displayed metadata. Set-only and foil-only
lines stay distinct from bare names. Equal collector numbers from different
sets and foil/nonfoil copies never merge.

Consumers should use entry fields and the shared identity helper rather than
reconstructing keys. Exact artwork lookups must not substitute generic bare-name
art for a missing selected printing. `src/lib/differ.js` reconciles bare vs.
printing-qualified names for logical deck comparison, normalizing accents and
full DFC names to their front face before indexing. Exact keys retain accented
spelling; this alias matching does not rewrite stored artwork identities.
Aliases of the same printing sum
their quantities, and comparing a bare total with many printings does not
invent artwork metadata for the aggregate. Snapshots remain plain text, so
this in-memory key change requires no stored-data migration.

This shape is pinned by the "parser entry contract" tests in `src/lib/invariants.test.js`.

### CSV imports and export round-trips

Header-based CSV imports recognize quantity/name aliases, board/category,
set/edition code, collector number, and foil/modifier/finish columns. Quoted
commas and doubled quotation marks are preserved. Commander rows belong to the
mainboard and populate `commanders`; sideboard rows remain separate; explicit
Maybeboard/Considering rows are excluded. Missing copy counts default to one;
invalid, zero, negative, fractional or unsafe counts are skipped.

The Archidekt CSV and text exporters round-trip printing metadata, commanders,
and board placement through the shared parser. Text carry-forward reserves
already explicit destination printings before distributing previous artwork
across bare lines, consuming copy counts across mainboard and sideboard.
Explicit foil markers survive both bare exports and metadata carry-forward.

## Consumers of the format

Main consumers (non-exhaustive — grep for `src/lib/parser` before assuming):

| Code | Role |
| --- | --- |
| `src/lib/parser.js` | Parses text → structured maps (client + server via Dockerfile-shipped copy) |
| `src/lib/constants.js` | Regexes for lines, headers, comments |
| `src/lib/cardIdentity.js` | Complete printing identity and DFC name normalization |
| `src/lib/formatter.js` | Emits changelogs/exports from diffs |
| `src/lib/fetcher.js` | Emits the format from Archidekt/Moxfield/etc. API responses |
| `server/lib/deckToText.js` | Server-side mirror of the Archidekt emitter |
| `server/lib/enrichDeckText.js` | Rewrites lines to add printing metadata (carry-forward + Scryfall) |
| `server/routes/decks.js`, `snapshots.js`, `shared-decks.js` | Parse snapshots via the shared parser |
| `server/lib/downloadQueue.js`, `priceCalculator.js`, `notificationScheduler.js` | Parse `deck_text` via the shared parser |
