/**
 * Server-side Scryfall client for batch card lookups.
 * Uses the /cards/collection endpoint to fetch set and collector number info.
 * Node 22 has built-in fetch — no extra dependencies needed.
 *
 * Includes in-memory TTL caches to avoid redundant API calls for
 * the same cards within a session (metadata 30m, prices 10m, printings 60m).
 */

const SCRYFALL_API = 'https://api.scryfall.com';
const BATCH_SIZE = 75; // Scryfall max per request
const DELAY_MS = 100; // Respect rate limit (~10 req/sec)

// ── TTL Cache ──────────────────────────────────────────────

const METADATA_TTL = 30 * 60 * 1000; // 30 minutes
const PRICE_TTL = 10 * 60 * 1000;    // 10 minutes
const PRINTING_TTL = 60 * 60 * 1000; // 60 minutes
const MAX_CACHE_ENTRIES = 2000;       // Per-cache entry limit

const metadataCache = new Map(); // key -> { data, ts }
const priceCache = new Map();
const printingCache = new Map();
const specificPriceCache = new Map();

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  // LRU: move to end on access
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

function setCache(cache, key, data) {
  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Name normalization for result matching (audit H7) ──────
// Scryfall echoes its canonical name: accents ("nazgul" → "Nazgûl") and full
// DFC names ("Fable…" → "Fable… // Reflection…"). Consumers look results up by
// the requested deck-text name, so we normalize both sides to a common form
// (front face, accent-stripped, lowercased) and map results back to the
// original requested name(s) instead of keying by the echoed name.

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function frontFaceName(name) {
  const slash = name.indexOf(' // ');
  return slash !== -1 ? name.slice(0, slash) : name;
}

function normName(s) {
  return frontFaceName(stripAccents(s.toLowerCase()));
}

// Build the Scryfall identifiers (query by front face so DFC + accented names
// match) and an index from normalized name → the requested lowercased keys that
// each result must populate.
function buildNameQuery(uncachedNames) {
  const normIndex = new Map();
  const frontSeen = new Set();
  const identifiers = [];
  for (const name of uncachedNames) {
    const norm = normName(name);
    if (!normIndex.has(norm)) normIndex.set(norm, []);
    normIndex.get(norm).push(name);
    const front = frontFaceName(name);
    if (!frontSeen.has(front)) {
      frontSeen.add(front);
      identifiers.push({ name: front });
    }
  }
  return { identifiers, normIndex };
}

// The requested lowercased keys a returned card should populate.
function requestersFor(card, normIndex) {
  return normIndex.get(normName(card.name || '')) || [];
}

/**
 * Shared name-based batch lookup. dedupes + caches by requested lowercased name,
 * queries Scryfall by front face, and stores each result under the requested
 * name(s) it satisfies (not the echoed canonical name). buildEntry(card) shapes
 * the cached value; onEntry(key, card, entry) is an optional extra cache write.
 */
async function fetchNameData(cardNames, cache, ttl, buildEntry, onEntry) {
  const result = new Map();
  if (!cardNames || cardNames.length === 0) return result;

  const unique = [...new Set(cardNames.map(n => n.toLowerCase()))];

  const uncached = [];
  for (const name of unique) {
    const cached = getCached(cache, name, ttl);
    if (cached) result.set(name, cached);
    else uncached.push(name);
  }
  if (uncached.length === 0) return result;

  const { identifiers, normIndex } = buildNameQuery(uncached);

  const batches = [];
  for (let i = 0; i < identifiers.length; i += BATCH_SIZE) {
    batches.push(identifiers.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delay(DELAY_MS);
    try {
      const res = await fetch(`${SCRYFALL_API}/cards/collection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CardListCompare/1.0',
        },
        body: JSON.stringify({ identifiers: batches[i] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const card of (data.data || [])) {
        const entry = buildEntry(card);
        for (const key of requestersFor(card, normIndex)) {
          if (result.has(key)) continue;
          result.set(key, entry);
          setCache(cache, key, entry);
          if (onEntry) onEntry(key, card, entry);
        }
      }
    } catch (err) {
      console.error('Scryfall fetch error:', err.message);
    }
  }

  return result;
}

/**
 * Fetch set and collector number info for an array of card names.
 * Returns Map<string, { set: string, collectorNumber: string }>
 * Keys are lowercased card names.
 */
export async function fetchCardPrintings(cardNames) {
  return fetchNameData(cardNames, printingCache, PRINTING_TTL, (card) => ({
    set: card.set || '',
    collectorNumber: card.collector_number || '',
  }));
}

/**
 * Fetch full card metadata for an array of card names.
 * Returns Map<string, { type, manaCost, colorIdentity, priceUsd, priceUsdFoil }>
 * Keys are lowercased card names.
 */
export async function fetchCardMetadata(cardNames) {
  return fetchNameData(
    cardNames,
    metadataCache,
    METADATA_TTL,
    (card) => {
      const typeLine = card.type_line || '';
      const front = typeLine.split('//')[0].trim();
      let type = 'Other';
      for (const t of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land']) {
        if (front.includes(t)) { type = t; break; }
      }
      return {
        type,
        manaCost: card.mana_cost || (card.card_faces?.[0]?.mana_cost) || '',
        colorIdentity: card.color_identity || [],
        priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
        priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
      };
    },
    // Prices come free with metadata — populate the price cache under the same key.
    (key, _card, entry) => {
      setCache(priceCache, key, { priceUsd: entry.priceUsd, priceUsdFoil: entry.priceUsdFoil });
    }
  );
}

/**
 * Fetch USD prices for an array of card names.
 * Returns Map<string, { priceUsd: number|null, priceUsdFoil: number|null }>
 * Keys are lowercased card names.
 */
export async function fetchCardPrices(cardNames) {
  return fetchNameData(cardNames, priceCache, PRICE_TTL, (card) => ({
    priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
    priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
  }));
}

/**
 * Fetch USD prices for specific card printings using set + collector number.
 * Accepts array of { name, set, collectorNumber } objects.
 * Returns Map<string, { priceUsd: number|null, priceUsdFoil: number|null }>
 * Keys are lowercased card names.
 * Cards without set+collectorNumber are skipped.
 */
export async function fetchSpecificPrintingPrices(cards) {
  const result = new Map();
  if (!cards || cards.length === 0) return result;

  // Only cards with printing metadata
  const withPrinting = cards.filter(c => c.set && c.collectorNumber);
  if (withPrinting.length === 0) return result;

  // Deduplicate by set+collector, and remember which requested name each
  // printing belongs to so results key by the REQUESTED name, not the echoed
  // canonical name (accents/DFC would otherwise mismatch — audit H7).
  const scKeyToName = new Map();
  const seen = new Set();
  const unique = [];
  for (const card of withPrinting) {
    const scKey = `${card.set.toLowerCase()}|${card.collectorNumber}`;
    scKeyToName.set(scKey, card.name.toLowerCase());
    if (seen.has(scKey)) continue;
    seen.add(scKey);

    const cached = getCached(specificPriceCache, scKey, PRICE_TTL);
    if (cached) {
      result.set(card.name.toLowerCase(), cached);
    } else {
      unique.push(card);
    }
  }
  if (unique.length === 0) return result;

  const batches = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    batches.push(unique.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delay(DELAY_MS);

    const identifiers = batches[i].map(c => ({
      set: c.set.toLowerCase(),
      collector_number: c.collectorNumber,
    }));

    try {
      const res = await fetch(`${SCRYFALL_API}/cards/collection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CardListCompare/1.0',
        },
        body: JSON.stringify({ identifiers }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) continue;

      const data = await res.json();

      for (const card of (data.data || [])) {
        const scKey = `${(card.set || '').toLowerCase()}|${card.collector_number}`;
        const entry = {
          priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
          priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
        };
        const nameKey = scKeyToName.get(scKey) || card.name.toLowerCase();
        result.set(nameKey, entry);
        setCache(specificPriceCache, scKey, entry);
      }
    } catch (err) {
      console.error('Scryfall specific price fetch error:', err.message);
    }
  }

  return result;
}
