/**
 * Scryfall card type lookup.
 *
 * Uses Scryfall's /cards/collection endpoint to batch-fetch card data
 * and extract the primary card type for sorting/grouping.
 *
 * Rate-limited: Scryfall allows 10 requests/sec — we batch 75 cards
 * per request (Scryfall max) so typically only 1-2 requests needed.
 */

const SCRYFALL_BATCH_SIZE = 75;

// Canonical type ordering for MTG cards
const TYPE_ORDER = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
  'Other',
];

/**
 * Extract the primary card type from a Scryfall type_line.
 * e.g. "Legendary Creature — Dragon" → "Creature"
 *      "Artifact Creature — Golem"  → "Creature" (Creature wins)
 *      "Legendary Enchantment"      → "Enchantment"
 */
export function primaryType(typeLine) {
  if (!typeLine) return 'Other';

  // Handle double-faced cards — use front face only
  const front = typeLine.split('//')[0].trim();

  // Check in priority order (Creature before Artifact/Enchantment)
  for (const type of TYPE_ORDER) {
    if (type === 'Other') continue;
    if (front.includes(type)) return type;
  }

  return 'Other';
}

/**
 * Given an array of card names, returns a Map<string, string>
 * mapping lowercased card name → primary type.
 *
 * Uses Scryfall Collection API to batch lookup.
 * Cards not found are mapped to 'Other'.
 */
export async function fetchCardTypes(cardNames) {
  const typeMap = new Map();
  if (!cardNames || cardNames.length === 0) return typeMap;

  // Deduplicate
  const unique = [...new Set(cardNames.map(n => n.toLowerCase()))];
  const nameToOriginal = new Map();
  for (const name of cardNames) {
    nameToOriginal.set(name.toLowerCase(), name);
  }

  // Batch into groups of 75
  const batches = [];
  for (let i = 0; i < unique.length; i += SCRYFALL_BATCH_SIZE) {
    batches.push(unique.slice(i, i + SCRYFALL_BATCH_SIZE));
  }

  for (const batch of batches) {
    const identifiers = batch.map(name => ({ name }));

    try {
      const res = await fetch('/api/scryfall/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers }),
      });

      if (!res.ok) {
        // On failure, mark all as Other and continue
        for (const name of batch) {
          typeMap.set(name, 'Other');
        }
        continue;
      }

      const data = await res.json();

      // Map found cards
      for (const card of (data.data || [])) {
        const key = card.name.toLowerCase();
        typeMap.set(key, primaryType(card.type_line));
      }

      // Mark not-found cards
      for (const nf of (data.not_found || [])) {
        const key = (nf.name || '').toLowerCase();
        if (key) typeMap.set(key, 'Other');
      }
    } catch {
      // Network error — mark batch as Other
      for (const name of batch) {
        typeMap.set(name, 'Other');
      }
    }
  }

  // Ensure all requested names have an entry
  for (const name of unique) {
    if (!typeMap.has(name)) {
      typeMap.set(name, 'Other');
    }
  }

  return typeMap;
}

/**
 * Collect all unique card names from a diff result.
 */
export function collectCardNames(diffResult) {
  const names = new Set();
  const { mainboard, sideboard } = diffResult;

  for (const section of [mainboard, sideboard]) {
    for (const card of section.cardsIn) names.add(card.name);
    for (const card of section.cardsOut) names.add(card.name);
    for (const card of section.quantityChanges) names.add(card.name);
  }

  return [...names];
}

/**
 * Group an array of card objects by their primary type.
 * Returns an array of { type, cards } in canonical type order.
 * Only includes types that have cards.
 */
export function groupByType(cards, typeMap) {
  const groups = new Map();

  for (const card of cards) {
    const type = typeMap.get(card.name.toLowerCase()) || 'Other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(card);
  }

  // Return in canonical order
  const result = [];
  for (const type of TYPE_ORDER) {
    if (groups.has(type)) {
      // Sort within group alphabetically
      const sorted = groups.get(type).sort((a, b) => a.name.localeCompare(b.name));
      result.push({ type, cards: sorted });
    }
  }

  return result;
}

export { TYPE_ORDER };
