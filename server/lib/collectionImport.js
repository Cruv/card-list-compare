import { parseLine } from '../../src/lib/parser.js';

// Section headers to ignore during collection import. Broader than the deck
// parser's own header set on purpose: collection pastes often include
// maybeboard/companion sections whose HEADER lines are noise (the cards under
// them are still owned cards and are imported).
const SECTION_HEADER_RE = /^(sideboard|commander|mainboard|maybeboard|companion)/i;

// Lines must lead with an explicit positive quantity (optionally behind an
// SB: prefix). The shared parseLine() falls back to treating any bare text as
// a qty-1 card — right for deck comparison, wrong for a collection: junk
// lines (or "0 Island") would become permanent rows. This guard preserves the
// import's strict semantics.
const LEADING_QTY_RE = /^(?:SB:\s*)?(\d+)/i;

const MAX_IMPORT_QTY = 999; // same bound as the single-card add route

/**
 * Parse collection-import text into card rows using the shared deck-text
 * parser (docs/DECK_TEXT_FORMAT.md is the format contract — do NOT add a
 * local card-line regex here; that caused real data corruption once).
 *
 * Returns { cards: [{ cardName, setCode, collectorNumber, quantity, isFoil }], skipped }.
 * Cards are NOT aggregated — one entry per input line, matching the route's
 * per-line upsert behavior.
 */
export function parseCollectionImportText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));

  const cards = [];
  let skipped = 0;

  for (const line of lines) {
    if (SECTION_HEADER_RE.test(line)) continue;
    const qtyMatch = line.match(LEADING_QTY_RE);
    if (!qtyMatch || parseInt(qtyMatch[1], 10) < 1) {
      skipped++;
      continue;
    }

    const card = parseLine(line);
    if (!card || card.quantity < 1) {
      skipped++;
      continue;
    }

    cards.push({
      cardName: card.name,
      setCode: card.setCode || null,
      collectorNumber: card.collectorNumber || null,
      quantity: Math.min(MAX_IMPORT_QTY, card.quantity),
      isFoil: card.isFoil ? 1 : 0,
    });
  }

  return { cards, skipped };
}
