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
<qty>[x] <Card Name> [(SET)] [[COLLECTOR] | COLLECTOR] [*F* | F]
```

| Part | Meaning | Example |
| --- | --- | --- |
| `qty` | Positive safe-integer copy count, digits, optional `x`/`X` suffix | `4` or `4x` |
| `Card Name` | Verbatim card name; DFC names use ` // ` | `Sheoldred // The True Scriptures` |
| `(SET)` | Set/edition code, alphanumeric | `(m10)`, `(2xm)` |
| `[COLLECTOR]` | Bracketed collector number — CardListCompare's own format | `[227]`, `[136p]`, `[DDO-20]` |
| bare `COLLECTOR` | Unbracketed collector number, **only valid directly after a set code** — Arena/Archidekt style | `(C20) 215` |
| `*F*` or trailing `F` | Foil marker; exports emit `*F*` | `*F*`, `(sld) [731] F` |

Collector numbers accept letters, digits, underscores, hyphens, and the promo marks `★`, `†`, and `‡`.

Structure lines (defined in `src/lib/constants.js`):

- Board headers include `Sideboard`/`SB`, `Mainboard`/`Main`/`Deck`, and `Commander`/`Commanders`/`Command Zone`. They accept an optional trailing `:` or `.` and an optional `#` or `//` prefix.
- Trailing commander tags include `(Commander)`, `[Commander]`, `[Commander{top}]`, and `*CMDR*`.
- Trailing Archidekt categories and color flags and Moxfield tags are stripped before card parsing.
- The comparison parser skips Maybeboard and Arena About blocks until the next board header.
- `SB:` line prefix marks a single card as sideboard
- Other lines starting with `//` or `#` are comments.
- CSV fallback: `4,Lightning Bolt` (quantity, name — no metadata)

A blank line ends a populated Commander section and returns to the mainboard.
When any explicit Commander header is present, later blank lines only separate
groups visually; use a `Sideboard`/`SB` header or `SB:` prefixes to identify the
sideboard. Without an explicit Commander header, a blank line after mainboard
content retains the legacy implicit-sideboard behavior.

In the Compare and Print text boxes, pasting inserts editable text at the current
selection. Choose **Review import** to preview the result. If the pasted text is
still the latest edit, the preview shows the replaced draft text and skipped
clipboard rows. It checks clipboard finishes and both partial-row boundaries.
Applying that preview preserves the draft text outside the pasted range,
including comments, ignored blocks and line endings. To fix a partial-row
printing conflict, paste at a line boundary or select the whole card row.
After further edits, **Review import** checks the current list as a whole.
Cancel keeps the text in the box, where you can edit it or use the browser’s undo.

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
/^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+\[([\w★†‡-]+)\]|\s+([\w★†‡-]+))?)?(\s+(?:\*F\*|F))?\s*$/i
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
  commanders: string[],        // flat array of display names
  problems: Array<{ line: number, raw: string, code: string, reason: string }>,
}
```

The parser reports `*E*` as an unsupported etched finish and excludes the affected line.
The shared [ManaSync deck-line fixtures](../tests/fixtures/deck-lines/) exercise the interchange grammar.

Each entry has the following fields.

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

A Scryfall printing saved from print review updates the matching set and collector
number in a new deck snapshot. The operation matches the reviewed printing before
metadata resolution and retains each matching row's quantity, section and finish.
Sideboard rows are included when the review includes the sideboard.

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
