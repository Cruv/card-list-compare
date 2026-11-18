import { parseLine } from './parser.js';
import { COMMANDER_HEADER, MAINBOARD_HEADER, SIDEBOARD_HEADER, COMMENT_LINE, COMMENT_PREFIX, ABOUT_HEADER, MAYBEBOARD_HEADER } from './constants.js';

// Ownership and print reporting retain each original line's printing and finish,
// even when the comparison parser combines identical entries across source lines.
// Return null for CSV tables so callers can use the existing CSV parser there.
export function deckBridgeLines(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const first = text.trim().split(/\r?\n/, 1)[0];
  if (first.includes(',') && /(?:^|,)\s*"?(?:quantity|count|name|card(?: name)?)"?\s*(?:,|$)/i.test(first)) return null;
  const sourceLines = text.split(/\r?\n/);
  const heading = line => line.trim().replace(COMMENT_PREFIX, '');
  const hasExplicitCommander = sourceLines.some(line => COMMANDER_HEADER.test(heading(line)));
  const entries = [];
  let section = 'mainboard';
  let seenExplicitSideboard = false;
  let seenContent = false;
  let sectionHasCards = false;
  let skipping = false;
  for (const [index, rawLine] of sourceLines.entries()) {
    const line = rawLine.trim();
    const header = heading(rawLine);
    if (COMMANDER_HEADER.test(header)) { section = 'commander'; sectionHasCards = false; skipping = false; continue; }
    if (MAINBOARD_HEADER.test(header)) { section = 'mainboard'; sectionHasCards = false; skipping = false; continue; }
    if (SIDEBOARD_HEADER.test(header)) { section = 'sideboard'; seenExplicitSideboard = true; sectionHasCards = false; skipping = false; continue; }
    if (MAYBEBOARD_HEADER.test(header)) { section = 'maybeboard'; sectionHasCards = false; skipping = false; continue; }
    if (ABOUT_HEADER.test(header)) { skipping = true; continue; }
    if (skipping) continue;
    if (!line) {
      if (section === 'commander' && sectionHasCards) section = 'mainboard';
      else if (section === 'mainboard' && seenContent && sectionHasCards && !seenExplicitSideboard && !hasExplicitCommander) section = 'sideboard';
      sectionHasCards = false;
      continue;
    }
    if (COMMENT_LINE.test(line)) continue;
    // Preserve other explicit section names without turning their headings into
    // one-copy cards. Their numbered/bare card lines retain that section below.
    if (/^\[.+\]$|^[\w\s]+:$/.test(line)) {
      section = line.replace(/^\[|\]$|:$/g, '').toLowerCase();
      sectionHasCards = false;
      continue;
    }
    const parsed = parseLine(line);
    if (!parsed) continue;
    const actualSection = parsed.isSB ? 'sideboard' : parsed.isCommander ? 'commander' : section;
    entries.push({ key: `${actualSection}:line:${index + 1}`, quantity: parsed.quantity,
      section: actualSection, card: { name: parsed.name, setCode: parsed.setCode || '',
        collectorNumber: parsed.collectorNumber || '', finish: parsed.isFoil ? 'foil' : 'nonfoil', language: 'en' } });
    sectionHasCards = true;
    seenContent = true;
  }
  return entries;
}
