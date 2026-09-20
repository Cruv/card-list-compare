# Shared deck-line corpus

The deck-line grammar is a contract between ManaSync and CLC, and CLC's `CARD_LINE_PATTERN`
(`companions/clc/src/lib/constants.js`) is its normative statement. The two parsers are separate
implementations, so this directory is the artifact that keeps them honest: every case is run by
`tests/deck-text.test.ts` here and by `src/lib/deckLineCorpus.test.js` in CLC.

## Layout

Each case is a pair of files:

- `<case>.txt` — the deck text exactly as a person would paste it.
- `<case>.json` — what both parsers must make of it.

```jsonc
{
  "source": "archidekt",
  "description": "why this case exists",
  "lines": [
    {
      "line": 1, // 1-based line number in the .txt
      "quantity": 1,
      "name": "Sol Ring", // normalized: NFC, straight apostrophe, collapsed whitespace
      "setCode": "ltc", // lower-case, "" when the line names no printing
      "collectorNumber": "284", // as printed, "" when absent
      "finish": "nonfoil", // "nonfoil" | "foil" | "etched"
      "section": null, // null | "commander" | "mainboard" | "sideboard" | "maybeboard" | ...
    },
    { "line": 4, "unreadable": "count" }, // "quantity" | "count" | "name" | "etched"
  ],
}
```

Only card lines and unreadable lines appear in `lines`. Blank lines, comments, section headers and
Arena's `About` block produce nothing and are simply absent.

A line may carry a `"clc"` key holding a **complete replacement record** for the CLC side. That is
how a deliberate, known divergence is recorded rather than discovered in production — for example
CLC's "a bare line is one copy" fallback, its lack of ManaSync's 1,000,000-copy ceiling, and its
refusal of the `*E*` etched marker that ManaSync can express but CLC's grammar cannot.

## Scope

The corpus covers the **line grammar and explicit section headers**. It deliberately does not cover
either app's blank-line heuristics (CLC infers a sideboard from a blank line in some shapes), so
every card line in every case follows an explicit header or has no section at all.

## Changing it

A new accepted form, a new provider export, or a fixed mis-parse belongs here first, in both repos,
before either parser changes. Copy the whole directory across — the files are plain text and JSON on
purpose, so the copy is verifiable by `diff`.
