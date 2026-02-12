/**
 * Scryfall card data lookup.
 *
 * Uses Scryfall's /cards/collection endpoint to batch-fetch card data
 * and extract the primary card type, mana cost, and image URI.
 *
 * Rate-limited: Scryfall allows 10 requests/sec — we batch 75 cards
 * per request (Scryfall max) so typically only 1-2 requests needed.
 * Batches are fetched in parallel using Promise.allSettled.
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
 * Get the best image URI from a Scryfall card object.
 * Prefers the 'normal' size from image_uris, falls back to front face.
 */
function getImageUri(card) {
  if (card.image_uris) {
    return card.image_uris.normal || card.image_uris.small || '';
  }
  // Double-faced cards store images per face
  if (card.card_faces && card.card_faces[0]?.image_uris) {
    return card.card_faces[0].image_uris.normal || card.card_faces[0].image_uris.small || '';
  }
  return '';
}

/**
 * Get the mana cost string from a Scryfall card object.
 * Returns something like "{2}{U}{B}" or "" for lands.
 */
function getManaCost(card) {
  if (card.mana_cost) return card.mana_cost;
  // Double-faced cards store mana cost on front face
  if (card.card_faces && card.card_faces[0]?.mana_cost) {
    return card.card_faces[0].mana_cost;
  }
  return '';
}

/**
 * Fetch a single batch of cards from Scryfall.
 * Returns an array of { key, type, manaCost, imageUri } objects.
 */
async function fetchBatch(batch) {
  const identifiers = batch.map(name => ({ name }));
  const results = [];

  try {
    const res = await fetch('/api/scryfall/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    });

    if (!res.ok) {
      // On failure, mark all as Other with no extra data
      for (const name of batch) {
        results.push({ key: name, type: 'Other', manaCost: '', imageUri: '' });
      }
      return results;
    }

    const data = await res.json();

    // Map found cards
    for (const card of (data.data || [])) {
      const key = card.name.toLowerCase();
      results.push({
        key,
        type: primaryType(card.type_line),
        manaCost: getManaCost(card),
        imageUri: getImageUri(card),
      });
    }

    // Mark not-found cards
    for (const nf of (data.not_found || [])) {
      const key = (nf.name || '').toLowerCase();
      if (key) {
        results.push({ key, type: 'Other', manaCost: '', imageUri: '' });
      }
    }
  } catch {
    // Network error — mark batch as Other
    for (const name of batch) {
      results.push({ key: name, type: 'Other', manaCost: '', imageUri: '' });
    }
  }

  return results;
}

/**
 * Extract front face from a double-faced card name.
 * "Sheoldred // The True Scriptures" → "Sheoldred"
 */
function dfcFrontFace(name) {
  const slash = name.indexOf(' // ');
  return slash !== -1 ? name.slice(0, slash) : name;
}

/**
 * Given an array of card names, returns a Map<string, { type, manaCost, imageUri }>
 * mapping lowercased card name → card data.
 *
 * Uses Scryfall Collection API to batch lookup.
 * Batches are fetched in parallel using Promise.allSettled.
 * DFC names like "Sheoldred // The True Scriptures" are normalized to their
 * front face for the Scryfall query, and results are stored under both the
 * full DFC name and the front-face-only name.
 */
export async function fetchCardData(cardNames) {
  const cardMap = new Map();
  if (!cardNames || cardNames.length === 0) return cardMap;

  // Deduplicate and normalize DFC names for lookup
  const originalNames = [...new Set(cardNames.map(n => n.toLowerCase()))];

  // Build mapping: front-face name → all original names that map to it
  const frontToOriginals = new Map();
  for (const name of originalNames) {
    const front = dfcFrontFace(name);
    if (!frontToOriginals.has(front)) frontToOriginals.set(front, []);
    frontToOriginals.get(front).push(name);
  }

  // Use front-face names for Scryfall queries
  const lookupNames = [...frontToOriginals.keys()];

  // Batch into groups of 75
  const batches = [];
  for (let i = 0; i < lookupNames.length; i += SCRYFALL_BATCH_SIZE) {
    batches.push(lookupNames.slice(i, i + SCRYFALL_BATCH_SIZE));
  }

  // Fetch all batches in parallel
  const settled = await Promise.allSettled(batches.map(fetchBatch));

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      for (const entry of result.value) {
        const data = {
          type: entry.type,
          manaCost: entry.manaCost,
          imageUri: entry.imageUri,
        };
        // Store under the Scryfall key (front face)
        cardMap.set(entry.key, data);
        // Also store under any original DFC names that mapped to this front face
        const originals = frontToOriginals.get(entry.key) || [];
        for (const orig of originals) {
          cardMap.set(orig, data);
        }
      }
    }
  }

  // Ensure all requested names have an entry
  for (const name of originalNames) {
    if (!cardMap.has(name)) {
      cardMap.set(name, { type: 'Other', manaCost: '', imageUri: '' });
    }
  }

  return cardMap;
}

/**
 * Legacy wrapper: returns a Map<string, string> mapping lowercased name → primary type.
 * Uses fetchCardData under the hood.
 */
export async function fetchCardTypes(cardNames) {
  const cardMap = await fetchCardData(cardNames);
  const typeMap = new Map();
  for (const [key, data] of cardMap) {
    typeMap.set(key, data.type);
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
 *
 * Accepts either a typeMap (Map<string, string>) or a cardMap (Map<string, { type, ... }>).
 */
export function groupByType(cards, typeOrCardMap) {
  const groups = new Map();

  for (const card of cards) {
    const entry = typeOrCardMap.get(card.name.toLowerCase());
    // Support both Map<string, string> and Map<string, { type, ... }>
    const type = typeof entry === 'string' ? entry : (entry?.type || 'Other');
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
