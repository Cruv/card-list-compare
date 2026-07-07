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
| `qty` | Copy count, digits, optional `x` suffix | `4` or `4x` |
| `Card Name` | Verbatim card name; DFC names use ` // ` | `Sheoldred // The True Scriptures` |
| `(SET)` | Set/edition code, alphanumeric | `(m10)`, `(2xm)` |
| `[COLLECTOR]` | Bracketed collector number — CardListCompare's own format | `[227]`, `[136p]`, `[DDO-20]` |
| bare `COLLECTOR` | Unbracketed collector number, **only valid directly after a set code** — Arena/Archidekt style | `(C20) 215` |
| `*F*` | Foil marker | `*F*` |

Collector numbers are alphanumeric with hyphens (promos: `136p`, `DDO-20`, `2022-3`).

Structure lines (defined in `src/lib/constants.js`):

- Section headers: `Sideboard`/`SB`, `Mainboard`/`Main`/`Deck`, `Commander`/`Commanders`/`Command Zone` (optional trailing `:` or `.`)
- `SB:` line prefix marks a single card as sideboard
- Comments: lines starting with `//` or `#`
- CSV fallback: `4,Lightning Bolt` (quantity, name — no metadata)

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

**Never fork a local copy.** It happened twice and both forks caused real bugs:
`server/routes/collection.js` corrupted set-less multi-word names (fixed
v2.40.1, with a startup data repair in `server/db.js`), and
`server/lib/enrichDeckText.js` drifted on collector-number handling (unified
v2.40.2). The invariants suite now fails if a card-line-shaped regex literal
reappears in server code.

```
/^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+\[([\w-]+)\]|\s+([\w-]+))?)?(\s+\*F\*)?\s*$/
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

Map keys (see `cardKey` in `parser.js`): `name.toLowerCase()` when there is no
collector number, otherwise the composite `name.toLowerCase() + '|' + collectorNumber`.
Composite keys let the same card name appear once per printing (e.g. nine Nazgul
artworks). Any code that looks up composite-keyed maps must fall back to the bare
name — only `src/lib/differ.js` reconciles bare-vs-composite mismatches.

This shape is pinned by the "parser entry contract" tests in `src/lib/invariants.test.js`.

## Consumers of the format

Main consumers (non-exhaustive — grep for `src/lib/parser` before assuming):

| Code | Role |
| --- | --- |
| `src/lib/parser.js` | Parses text → structured maps (client + server via Dockerfile-shipped copy) |
| `src/lib/constants.js` | Regexes for lines, headers, comments |
| `src/lib/formatter.js` | Emits changelogs/exports from diffs |
| `src/lib/fetcher.js` | Emits the format from Archidekt/Moxfield/etc. API responses |
| `server/lib/deckToText.js` | Server-side mirror of the Archidekt emitter |
| `server/lib/enrichDeckText.js` | Rewrites lines to add printing metadata (carry-forward + Scryfall) |
| `server/routes/decks.js`, `snapshots.js`, `shared-decks.js` | Parse snapshots via the shared parser |
| `server/lib/downloadQueue.js`, `priceCalculator.js`, `notificationScheduler.js` | Parse `deck_text` via the shared parser |
| `server/lib/collectionImport.js` | Collection import via the shared `parseLine` (strict: requires a leading quantity) |
