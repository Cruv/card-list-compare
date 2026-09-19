// Regex patterns for parsing MTG card list lines
// Tried in order — first match wins

// "4 Lightning Bolt (M10) [227] *F*" — full metadata with set code, collector number, foil
// Group 1: quantity, Group 2: card name, Group 3: set code,
// Group 4: bracketed collector number [227] or [136p] or [DDO-20],
// Group 5: bare collector number (only after set code) e.g. "227" or "136p",
// Group 6: foil tag
// Collector numbers can be alphanumeric with hyphens and the star/dagger promo marks
// (e.g. 136p, DDO-20, 2022-3, 17★, 48†) — the same charset as ManaSync's shared/deck-text.ts
// Bare collector numbers are nested inside the set code group to avoid
// matching card name words when no set code is present.
//
// SINGLE SOURCE OF TRUTH for the card-line format — also consumed by
// server/lib/enrichDeckText.js. Never fork a local copy (two forks drifted
// and corrupted data before; see docs/DECK_TEXT_FORMAT.md).
export const CARD_LINE_PATTERN =
  /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+\[([\w★†‡-]+)\]|\s+([\w★†‡-]+))?)?(\s+\*F\*)?\s*$/i;

export const LINE_PATTERNS = [
  CARD_LINE_PATTERN,

  // CSV: "4,Lightning Bolt" or "4,"Lightning Bolt""
  /^(\d+)\s*,\s*"?([^"]+)"?\s*$/,

  // Simple: "4 Lightning Bolt" or "4x Lightning Bolt"
  /^(\d+)\s*x?\s+(.+)$/i,
];

export const SIDEBOARD_HEADER = /^\s*(sideboard|sb)\s*[:.]?\s*$/i;
export const MAINBOARD_HEADER = /^\s*(mainboard|main|deck)\s*[:.]?\s*$/i;
export const COMMANDER_HEADER = /^\s*(commander|commanders|command zone)\s*[:.]?\s*$/i;
export const SB_PREFIX = /^\s*SB:\s*/i;
export const COMMENT_LINE = /^\s*(\/\/|#)/;
export const MAYBEBOARD_HEADER = /^\s*(maybeboard|maybe board|considering)\s*[:.]?\s*$/i;
// MTG Arena opens an export with an `About` block holding `Name <deck name>`.
export const ABOUT_HEADER = /^\s*about\s*[:.]?\s*$/i;
// ManaSync writes its board headers as comments (`# Commander`). Strip the marker before a
// header test so its own export round-trips instead of losing the command zone.
export const COMMENT_PREFIX = /^\s*(?:\/\/|#)\s*/;

// Trailing provider decorations, stripped right to left BEFORE CARD_LINE_PATTERN runs.
// These are not card-line patterns and never capture a quantity or a name; the card-line
// grammar stays single-sourced in CARD_LINE_PATTERN above.
//
//   Archidekt: "1x Sol Ring (ltc) 284 [Artifact{noDeck}{noPrice}] ^Have,#7289da^"
//   Moxfield:  "1 Sol Ring (LTC) 284 *F* #Ramp"
//
// A trailing "[...]" is a decoration only when it cannot be read as a printing number, so
// "[227]", "[136p]" and "[DDO-20]" keep their meaning and a set-less "1 Nazgul [336p]" keeps
// the documented "the brackets are part of the name" behaviour.
export const ARCHIDEKT_FLAGS = /\s*\^[^^]*\^$/;
export const MOXFIELD_TAG = /\s+#[\w-]+$/;
export const PROVIDER_BRACKET = /\s+\[([^\]]*)\]$/;
export const PRINTING_BRACKET_BODY = /^[\w★†‡-]+$/;

// The grammar above expresses only *F*. ManaSync can emit *E* for etched printings, which this
// pattern would read as part of the card name — refuse those lines by name instead.
export const ETCHED_MARKER = /\s\*E\*\s*$/i;
