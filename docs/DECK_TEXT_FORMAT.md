# Deck Text Format

The deck text format is CardListCompare's core data contract. Full deck lists are
stored as plain text in `deck_snapshots.deck_text`, one card per line — printing
metadata is embedded in the text itself rather than in database columns, so every
snapshot is self-contained and survives schema changes.

Everything that parses or emits this format must agree on it. The **normative
definition is executable**: `src/lib/invariants.test.js` ("card-line regex parity")
asserts client and server agree on a canonical corpus of card lines (a subset of
the examples below; the known-drift inputs are covered by pinned-divergence tests
instead). This document explains the format; when the two disagree, the tests win.

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
2 Atraxa (C20) 215 *F*    <- bare collector: client-only today, see Known drift

Sideboard
2 Fatal Push (2xm) [69]
```

## The two regexes

The card-line regex exists in **two normative places**. If you change deck-line
syntax you must update both, then update the parity tests and this document.
Never add a third: collection import once carried a hand-rolled copy that
silently corrupted set-less multi-word names (fixed in v2.40.1 by delegating to
the shared `parseLine`, with a startup data repair in `server/db.js`).

**Client — `LINE_PATTERNS[0]` in `src/lib/constants.js`** (6 capture groups):

```
/^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+\[([\w-]+)\]|\s+([\w-]+))?)?(\s+\*F\*)?\s*$/
```

| Group | Captures |
| --- | --- |
| 1 | quantity |
| 2 | card name |
| 3 | set code |
| 4 | bracketed collector number (also nested — requires a preceding set code) |
| 5 | bare collector number (nested inside the set-code group) |
| 6 | foil marker |

Note: on the client, **both** collector alternatives (groups 4 and 5) live inside
the set-code group — a collector number can only match after `(SET)`. This is
exactly why `1 Nazgul [336p]` is a pinned client/server divergence below.

**Server — `CARD_LINE_RE` in `server/lib/enrichDeckText.js`** (5 capture groups):

```
/^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\))?(?:\s+\[([\w-]+)\])?(\s+\*F\*)?\s*$/
```

| Group | Captures |
| --- | --- |
| 1 | quantity |
| 2 | card name |
| 3 | set code |
| 4 | bracketed collector number (independent of set code) |
| 5 | foil marker |

### Why the bare collector number nests inside the set-code group (client)

Without a set code to anchor it, a trailing word like `Mox` or `215` in a card
name is indistinguishable from a collector number. Nesting the bare-collector
alternative inside the set-code group means it can only match after `(SET)`,
preventing the regex from eating the last word of ordinary card names.

### Known drift (pinned, do not extend)

The two regexes currently **disagree** on two inputs. These divergences are
pinned in `src/lib/invariants.test.js` so any further drift fails the suite:

| Input | Client | Server |
| --- | --- | --- |
| `2 Atraxa (C20) 215 *F*` | name `Atraxa`, set `C20`, cn `215` | name `Atraxa (C20) 215`, no set/cn |
| `1 Nazgul [336p]` (no set) | name `Nazgul [336p]`, no cn | name `Nazgul`, cn `336p` |

Planned fix: export a single regex from `src/lib/constants.js` and import it in
`server/lib/enrichDeckText.js` (the Dockerfile already ships `constants.js` to the
server). When that lands, replace the pinned-divergence tests with plain parity
assertions.

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
