/**
 * Scryfall card data lookup.
 *
 * Uses Scryfall's /cards/collection endpoint to batch-fetch card data
 * and extract the primary card type, mana cost, and image URI.
 *
 * Rate-limited: Scryfall allows 10 requests/sec — we batch 75 cards
 * per request (Scryfall max) so typically only 1-2 requests needed.
 * Batches are fetched in parallel using Promise.allSettled.
 *
 * Includes a session-level in-memory cache so repeated lookups (e.g.
 * opening timeline then recommendations for the same deck) don't
 * re-fetch from Scryfall.
 */

import { cardIdentityKey, normalizedName, normalizeCardName } from './cardIdentity.js';

const SCRYFALL_BATCH_SIZE = 75;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// Covers need separate illustration crops; old printing images remain unchanged.
const STORAGE_KEY = 'clc-scryfall-cache-v4';
const STORAGE_WRITE_DEBOUNCE = 2000; // ms — batch writes to sessionStorage
const STORAGE_MAX_ENTRIES = 2000; // cap to ~400KB in sessionStorage

// Module-scope session cache: cacheKey → { data, ts }
const cardCache = new Map();

// Hydrate from sessionStorage on module load (survives page reload)
try {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored) {
    const entries = JSON.parse(stored);
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - entry.ts < CACHE_TTL) {
        cardCache.set(key, entry);
      }
    }
  }
} catch { /* sessionStorage unavailable or corrupt — start fresh */ }

let _storageDirty = false;
let _storageTimer = null;

function flushToStorage() {
  if (!_storageDirty) return;
  try {
    // Only persist entries that are still within TTL, capped by max entries
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of cardCache) {
      if (now - entry.ts < CACHE_TTL) {
        entries.push([key, entry]);
      }
    }
    // If over limit, keep only the most recently accessed entries
    if (entries.length > STORAGE_MAX_ENTRIES) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      entries.length = STORAGE_MAX_ENTRIES;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* quota exceeded — cache is in-memory only */ }
  _storageDirty = false;
}

function scheduleFlush() {
  _storageDirty = true;
  if (_storageTimer) return;
  _storageTimer = setTimeout(() => {
    _storageTimer = null;
    flushToStorage();
  }, STORAGE_WRITE_DEBOUNCE);
}

function getCached(key) {
  const entry = cardCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cardCache.delete(key); return null; }
  return entry.data;
}

function setCardCache(key, data) {
  cardCache.set(key, { data, ts: Date.now() });
  scheduleFlush();
}

/** Clear the session cache (for testing or manual reset). */
export function clearCardCache() {
  cardCache.clear();
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

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

const MISSING_CARD = Object.freeze({
  type: 'Other', isBackLand: false, manaCost: '', imageUri: '',
  priceUsd: null, priceUsdFoil: null, colorIdentity: [],
});

// Scryfall accepts unaccented names but returns their canonical accented spelling.
// Normalize only for response matching; deck identity and display names stay intact.
function lookupName(name) {
  return normalizedName(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function matchesIdentifier(card, identifier, requestedName) {
  if (identifier.set && card.set?.toLowerCase() !== identifier.set.toLowerCase()) return false;
  if (identifier.collector_number && String(card.collector_number).toLowerCase() !== String(identifier.collector_number).toLowerCase()) return false;
  // A mistyped set/collector must not display a different card's art or price.
  return normalizeCardName(lookupName(card.name)) === normalizeCardName(lookupName(requestedName));
}

function extractCardData(card) {
  return {
    scryfallId: card.id || null,
    oracleId: card.oracle_id || null,
    setCode: card.set || '',
    collectorNumber: card.collector_number || '',
    type: primaryType(card.type_line),
    isBackLand: (card.card_faces?.[1]?.type_line || '').includes('Land'),
    manaCost: getManaCost(card),
    imageUri: getImageUri(card),
    artCropUri: card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop || null,
    priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
    priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
    colorIdentity: card.color_identity || [],
  };
}

async function requestCards(entries) {
  const identifiers = [...new Map(entries.map(e => [JSON.stringify(e.identifier), e.identifier])).values()];
  const res = await fetch('/api/scryfall/cards/collection', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

/** Resolve every requested key, including multiple finishes of the same printing. */
async function fetchBatch(entries) {
  const result = new Map();
  function match(cards, requests) {
    for (const entry of requests) {
      const candidates = cards.filter(card => matchesIdentifier(card, entry.expected, entry.name));
      // A real Forest beats the front alias of a reversible Forest // Forest.
      const card = candidates.find(c => lookupName(c.name) === lookupName(entry.name)) || candidates[0];
      if (card) result.set(entry.key, extractCardData(card));
    }
  }
  try {
    match(await requestCards(entries), entries);
    // Collection lookup accepts some DFCs only by front name. Try the full name
    // first: split cards with three or more parts require that full spelling.
    const retry = entries.filter(e => !result.has(e.key) && e.identifier.name?.includes('//'))
      .map(e => ({ ...e, identifier: { ...e.identifier, name: normalizeCardName(e.name) } }));
    if (retry.length) match(await requestCards(retry), retry);
  } catch { /* Unknown cards remain visibly unresolved and can be retried. */ }
  return result;
}

/**
 * Fetch metadata/art keyed by cardIdentityKey, with bare names for generic lookup.
 * Exact printing misses never substitute another printing. Failed results are
 * not cached, so a transient API failure does not last for the session TTL.
 */
export async function fetchCardData(identifiersOrNames) {
  const cardMap = new Map();
  const identifiers = identifiersOrNames instanceof Map ? identifiersOrNames
    : new Map((Array.isArray(identifiersOrNames) ? identifiersOrNames : []).map(name => [normalizedName(name), { name }]));
  const entries = [];
  for (const [key, info] of identifiers) {
    const cached = getCached(key);
    if (cached && (!info.set || cached.setCode?.toLowerCase() === info.set.toLowerCase())
      && (!info.collector_number || String(cached.collectorNumber).toLowerCase() === String(info.collector_number).toLowerCase())) {
      cardMap.set(key, cached);
      continue;
    }
    const identifier = info.set && info.collector_number
      ? { set: info.set.toLowerCase(), collector_number: String(info.collector_number) }
      : { name: info.name, ...(info.set ? { set: info.set.toLowerCase() } : {}) };
    entries.push({ key, name: info.name, identifier, expected: info });
  }
  const batches = [];
  // A name-only response must not take the first exact printing returned for the
  // same card. Keep generic/budget requests separate from constrained printings.
  const constrained = entries.filter(entry => entry.expected.set || entry.expected.collector_number);
  const generic = entries.filter(entry => !entry.expected.set && !entry.expected.collector_number);
  for (const group of [constrained, generic]) {
    for (let i = 0; i < group.length; i += SCRYFALL_BATCH_SIZE) batches.push(group.slice(i, i + SCRYFALL_BATCH_SIZE));
  }
  const settled = await Promise.allSettled(batches.map(fetchBatch));
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const [key, data] of result.value) {
      cardMap.set(key, data);
      setCardCache(key, data);
    }
  }
  for (const key of identifiers.keys()) if (!cardMap.has(key)) cardMap.set(key, MISSING_CARD);
  return cardMap;
}

/** Look up the selected printing, without replacing missing art/price with a generic card. */
export function cardDataForEntry(cardMap, card) {
  return cardMap?.get(cardIdentityKey(card));
}

function addIdentifier(identifiers, card) {
  const name = card.displayName ?? card.name;
  identifiers.set(cardIdentityKey(card), {
    name,
    ...(card.setCode ? { set: card.setCode.toLowerCase() } : {}),
    ...(card.collectorNumber ? { collector_number: card.collectorNumber } : {}),
  });
  // Generic lookup is separate for budget comparisons and logical-card metadata.
  const bare = normalizedName(name);
  if (!identifiers.has(bare)) identifiers.set(bare, { name });
}

export function collectDeckIdentifiers(parsedDeck) {
  const identifiers = new Map();
  for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
    for (const card of section.values()) addIdentifier(identifiers, card);
  }
  return identifiers;
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

/** Collect both sides of a diff, including changes that only replace a printing. */
export function collectCardIdentifiers(diffResult) {
  const identifiers = new Map();
  for (const section of [diffResult.mainboard, diffResult.sideboard]) {
    for (const list of [section.cardsIn, section.cardsOut, section.quantityChanges]) {
      for (const card of list) addIdentifier(identifiers, card);
    }
    for (const card of section.printingChanges || []) {
      for (const prefix of ['old', 'new']) addIdentifier(identifiers, {
        name: card.name, setCode: card[`${prefix}SetCode`],
        collectorNumber: card[`${prefix}CollectorNumber`], isFoil: card[`${prefix}IsFoil`],
      });
    }
  }
  return identifiers;
}

export function collectCardNames(diffResult) {
  return [...new Set([...collectCardIdentifiers(diffResult).values()].map(c => c.name))];
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
    const entry = typeOrCardMap.get(normalizedName(card.name));
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
