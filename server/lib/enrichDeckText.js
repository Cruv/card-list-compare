/**
 * Enrich deck text with set codes and collector numbers.
 *
 * Priority:
 * 1. If the card already has set + collector number → keep as-is
 * 2. If a previous snapshot has metadata for this card → carry forward
 * 3. Fall back to Scryfall's latest printing
 *
 * Returns enriched deck text string.
 */

import { parse } from '../../src/lib/parser.js';
import { fetchCardPrintings } from './scryfall.js';

/**
 * Build a metadata lookup from parsed deck data.
 * Returns Map<string(lowercased name), Array<{ setCode, collectorNumber, isFoil, quantity }>>
 * Stores all printings per card name to support multi-printing cards (e.g. Nazgul).
 */
function buildMetadataLookup(parsed) {
  const lookup = new Map();

  function addEntries(map) {
    for (const [, entry] of map) {
      const key = entry.displayName.toLowerCase();
      if (entry.setCode && entry.collectorNumber) {
        if (!lookup.has(key)) lookup.set(key, []);
        lookup.get(key).push({
          setCode: entry.setCode,
          collectorNumber: entry.collectorNumber,
          isFoil: entry.isFoil || false,
          quantity: entry.quantity,
        });
      }
    }
  }

  addEntries(parsed.mainboard);
  addEntries(parsed.sideboard);
  return lookup;
}

/**
 * Rebuild a card line with full metadata.
 */
function buildLine(qty, name, setCode, collectorNumber, isFoil) {
  let line = `${qty} ${name}`;
  if (setCode) line += ` (${setCode})`;
  if (collectorNumber) line += ` [${collectorNumber}]`;
  if (isFoil) line += ` *F*`;
  return line;
}

/**
 * Enrich deck text with printing metadata.
 *
 * @param {string} newText - The new deck text to enrich
 * @param {string|null} previousText - Previous snapshot text (for carry-forward), or null
 * @returns {Promise<string>} Enriched deck text
 */
export async function enrichDeckText(newText, previousText) {
  if (!newText || !newText.trim()) return newText;

  const newParsed = parse(newText);
  const prevLookup = previousText ? buildMetadataLookup(parse(previousText)) : new Map();

  // Collect card names that need Scryfall lookup
  const needsLookup = [];

  function checkEntries(map) {
    for (const [, entry] of map) {
      if (entry.setCode && entry.collectorNumber) continue; // already has full metadata
      const key = entry.displayName.toLowerCase();
      if (prevLookup.has(key)) continue; // will carry forward from previous
      needsLookup.push(entry.displayName);
    }
  }

  checkEntries(newParsed.mainboard);
  checkEntries(newParsed.sideboard);

  // Fetch from Scryfall for cards without any metadata source
  const scryfallData = needsLookup.length > 0
    ? await fetchCardPrintings(needsLookup)
    : new Map();

  // Rebuild the text line by line, preserving sections and structure
  const lines = newText.split(/\r?\n/);
  const result = [];

  // Regex to parse a card line: qty name (set) [num] *F*
  // Collector numbers can be alphanumeric with hyphens (e.g. 136p, DDO-20, 2022-3)
  // Capture groups: 1=qty, 2=name, 3=setCode, 4=collectorNumber, 5=foil
  const CARD_LINE_RE = /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\))?(?:\s+\[([\w-]+)\])?(\s+\*F\*)?\s*$/;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Pass through section headers, blank lines, comments
    if (!trimmed || /^\s*(sideboard|sb|mainboard|main|deck|commander|commanders|command zone)\s*[:.]?\s*$/i.test(trimmed) || /^\s*(\/\/|#)/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    // Try to match as a card line
    const match = trimmed.match(CARD_LINE_RE);
    if (!match) {
      result.push(rawLine);
      continue;
    }

    const qty = parseInt(match[1], 10);
    const rawName = match[2].trim();
    // Normalize name for lookup
    const key = rawName.toLowerCase().replace(/\s+/g, ' ').replace(/['\u2018\u2019`\u2032]/g, "'");

    // Extract metadata directly from regex groups (avoids re-parsing each line)
    const lineSetCode = match[3] || null;
    const lineCollectorNumber = match[4] || null;
    const lineIsFoil = !!match[5];

    const hasFullMeta = lineSetCode && lineCollectorNumber;
    if (hasFullMeta) {
      // Already enriched — keep as-is
      result.push(rawLine);
      continue;
    }

    // Try carry-forward from previous snapshot
    const prevPrintings = prevLookup.get(key);
    if (prevPrintings && prevPrintings.length > 0) {
      if (prevPrintings.length === 1) {
        // Single printing — apply to the whole quantity
        const p = prevPrintings[0];
        const isFoil = lineIsFoil || p.isFoil;
        result.push(buildLine(qty, rawName, p.setCode, p.collectorNumber, isFoil));
      } else {
        // Multiple printings — expand into separate lines, matching previous quantities.
        // If the new total differs from the previous total, distribute: use previous
        // quantities for as many as we can, then assign any remainder to the first printing.
        let remaining = qty;

        for (const p of prevPrintings) {
          if (remaining <= 0) break;
          const lineQty = Math.min(p.quantity, remaining);
          result.push(buildLine(lineQty, rawName, p.setCode, p.collectorNumber, p.isFoil));
          remaining -= lineQty;
        }

        // If new quantity exceeds previous total, add remainder to first printing
        if (remaining > 0) {
          const p = prevPrintings[0];
          result.push(buildLine(remaining, rawName, p.setCode, p.collectorNumber, p.isFoil));
        }
      }
      continue;
    }

    // Try Scryfall fallback
    const sfMeta = scryfallData.get(key);
    if (sfMeta) {
      result.push(buildLine(qty, rawName, sfMeta.set, sfMeta.collectorNumber, lineIsFoil));
      continue;
    }

    // No metadata available — keep original line
    result.push(rawLine);
  }

  return result.join('\n');
}
