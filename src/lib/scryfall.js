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
 * Each entry in batchEntries has { key, identifier } where identifier is
 * either { name } or { set, collector_number } for Scryfall's collection API.
 * Returns an array of { key, type, manaCost, imageUri } objects.
 */
async function fetchBatch(batchEntries) {
  const identifiers = batchEntries.map(e => e.identifier);
  const results = [];
  const fallback = { type: 'Other', manaCost: '', imageUri: '', priceUsd: null, priceUsdFoil: null, colorIdentity: [] };

  try {
    const res = await fetch('/api/scryfall/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    });

    if (!res.ok) {
      for (const e of batchEntries) {
        results.push({ key: e.key, ...fallback });
      }
      return results;
    }

    const data = await res.json();

    // Build a lookup from set+collector → entry key for matching results back
    const setCollectorToKey = new Map();
    for (const e of batchEntries) {
      if (e.identifier.set && e.identifier.collector_number) {
        setCollectorToKey.set(`${e.identifier.set}|${e.identifier.collector_number}`, e.key);
      }
    }

    // Map found cards
    for (const card of (data.data || [])) {
      // Check if back face is a land (for MDFC analytics classification)
      const backTypeLine = card.card_faces?.[1]?.type_line || '';
      const isBackLand = backTypeLine.includes('Land');
      const cardData = {
        type: primaryType(card.type_line),
        isBackLand,
        manaCost: getManaCost(card),
        imageUri: getImageUri(card),
        priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
        priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
        colorIdentity: card.color_identity || [],
      };

      // Try to match by set+collector first (for specific printing lookups)
      const scKey = `${card.set}|${card.collector_number}`;
      const compositeKey = setCollectorToKey.get(scKey);
      if (compositeKey) {
        results.push({ key: compositeKey, ...cardData });
        setCollectorToKey.delete(scKey); // prevent duplicate matching
      }

      // Always emit under the bare name key (for type grouping, mana cost)
      const nameKey = card.name.toLowerCase();
      results.push({ key: nameKey, ...cardData });
    }

    // Mark not-found cards
    for (const nf of (data.not_found || [])) {
      const key = (nf.name || '').toLowerCase();
      if (key) {
        results.push({ key, ...fallback });
      }
    }
  } catch {
    for (const e of batchEntries) {
      results.push({ key: e.key, ...fallback });
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
 * Given a Map of identifiers (from collectCardIdentifiers) or an array of card names,
 * returns a Map<string, { type, manaCost, imageUri }> mapping keys → card data.
 *
 * Keys can be bare lowercased names or composite "name|collectorNumber" keys.
 * When identifiers include set+collector_number, Scryfall returns the exact
 * printing's artwork. Results are stored under both composite and bare name keys.
 *
 * Uses Scryfall Collection API to batch lookup.
 * Batches are fetched in parallel using Promise.allSettled.
 * DFC names like "Sheoldred // The True Scriptures" are normalized to their
 * front face for the Scryfall query, and results are stored under both the
 * full DFC name and the front-face-only name.
 */
export async function fetchCardData(identifiersOrNames) {
  const cardMap = new Map();
  if (!identifiersOrNames) return cardMap;

  // Support both Map<string, {name, set?, collector_number?}> and string[]
  let identifierMap;
  if (identifiersOrNames instanceof Map) {
    identifierMap = identifiersOrNames;
  } else if (Array.isArray(identifiersOrNames)) {
    // Legacy: array of card name strings
    identifierMap = new Map();
    for (const name of identifiersOrNames) {
      const key = name.toLowerCase();
      if (!identifierMap.has(key)) {
        identifierMap.set(key, { name });
      }
    }
  } else {
    return cardMap;
  }

  if (identifierMap.size === 0) return cardMap;

  // Build batch entries: { key, identifier } for each unique lookup
  // Separate set+collector lookups (exact printing) from name-only lookups (DFC-normalized)
  const batchEntries = [];
  const allKeys = new Set(); // track all keys we need entries for
  const frontToOriginals = new Map(); // for DFC alias storage
  const addedNameLookups = new Set(); // track which front-face names already have a query

  for (const [key, info] of identifierMap) {
    allKeys.add(key);

    if (info.set && info.collector_number) {
      // Exact printing lookup — send set+collector to Scryfall
      batchEntries.push({
        key,
        identifier: { set: info.set, collector_number: info.collector_number },
      });
    } else {
      // Name-only lookup — normalize DFC to front face
      const nameLower = info.name.toLowerCase();
      const front = dfcFrontFace(nameLower);

      if (!frontToOriginals.has(front)) frontToOriginals.set(front, []);
      frontToOriginals.get(front).push(key);

      // Only add one Scryfall query per front-face name
      if (!addedNameLookups.has(front)) {
        addedNameLookups.add(front);
        batchEntries.push({
          key: front,
          identifier: { name: front },
        });
      }
    }
  }

  // Batch into groups of 75
  const batches = [];
  for (let i = 0; i < batchEntries.length; i += SCRYFALL_BATCH_SIZE) {
    batches.push(batchEntries.slice(i, i + SCRYFALL_BATCH_SIZE));
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
          priceUsd: entry.priceUsd,
          priceUsdFoil: entry.priceUsdFoil,
          colorIdentity: entry.colorIdentity,
        };
        // Store under the returned key (could be composite or bare name)
        cardMap.set(entry.key, data);
        // Also store under any original DFC names that mapped to this front face
        const originals = frontToOriginals.get(entry.key) || [];
        for (const orig of originals) {
          cardMap.set(orig, data);
        }
      }
    }
  }

  // Ensure all requested keys have an entry
  for (const key of allKeys) {
    if (!cardMap.has(key)) {
      cardMap.set(key, { type: 'Other', manaCost: '', imageUri: '', priceUsd: null, priceUsdFoil: null, colorIdentity: [] });
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
 * Collect card identifiers from a diff result, including printing metadata.
 * Returns Map<string, { name, set?, collector_number? }> where keys are either
 * bare lowercased names or composite "name|collectorNumber" keys.
 *
 * Cards with set+collector get a composite key entry (for exact artwork lookup)
 * plus a bare name entry (for type/mana cost lookup).
 */
export function collectCardIdentifiers(diffResult) {
  const identifiers = new Map();
  const { mainboard, sideboard } = diffResult;

  for (const section of [mainboard, sideboard]) {
    for (const list of [section.cardsIn, section.cardsOut, section.quantityChanges]) {
      for (const card of list) {
        const nameLower = card.name.toLowerCase();
        // If card has set+collector, store under composite key for per-printing lookup
        if (card.setCode && card.collectorNumber) {
          const compositeKey = `${nameLower}|${card.collectorNumber}`;
          if (!identifiers.has(compositeKey)) {
            identifiers.set(compositeKey, {
              name: card.name,
              set: card.setCode.toLowerCase(),
              collector_number: card.collectorNumber,
            });
          }
        }
        // Always store bare name for type/manaCost lookup
        if (!identifiers.has(nameLower)) {
          identifiers.set(nameLower, { name: card.name });
        }
      }
    }
  }

  return identifiers;
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
