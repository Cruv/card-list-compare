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

const metadataCache = new Map(); // key -> { data, ts }
const priceCache = new Map();
const printingCache = new Map();
const specificPriceCache = new Map();

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(cache, key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch set and collector number info for an array of card names.
 * Returns Map<string, { set: string, collectorNumber: string }>
 * Keys are lowercased card names.
 */
export async function fetchCardPrintings(cardNames) {
  const result = new Map();
  if (!cardNames || cardNames.length === 0) return result;

  const unique = [...new Set(cardNames.map(n => n.toLowerCase()))];

  // Check cache first
  const uncached = [];
  for (const name of unique) {
    const cached = getCached(printingCache, name, PRINTING_TTL);
    if (cached) {
      result.set(name, cached);
    } else {
      uncached.push(name);
    }
  }
  if (uncached.length === 0) return result;

  const batches = [];
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    batches.push(uncached.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delay(DELAY_MS);

    const identifiers = batches[i].map(name => ({ name }));

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
        const key = card.name.toLowerCase();
        if (!result.has(key)) {
          const entry = {
            set: card.set || '',
            collectorNumber: card.collector_number || '',
          };
          result.set(key, entry);
          setCache(printingCache, key, entry);
        }
      }
    } catch (err) {
      console.error('Scryfall batch fetch error:', err.message);
    }
  }

  return result;
}

/**
 * Fetch full card metadata for an array of card names.
 * Returns Map<string, { type, manaCost, colorIdentity, priceUsd, priceUsdFoil }>
 * Keys are lowercased card names.
 */
export async function fetchCardMetadata(cardNames) {
  const result = new Map();
  if (!cardNames || cardNames.length === 0) return result;

  const unique = [...new Set(cardNames.map(n => n.toLowerCase()))];

  // Check cache first
  const uncached = [];
  for (const name of unique) {
    const cached = getCached(metadataCache, name, METADATA_TTL);
    if (cached) {
      result.set(name, cached);
    } else {
      uncached.push(name);
    }
  }
  if (uncached.length === 0) return result;

  const batches = [];
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    batches.push(uncached.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delay(DELAY_MS);

    const identifiers = batches[i].map(name => ({ name }));

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
        const key = card.name.toLowerCase();
        if (!result.has(key)) {
          // Extract primary type from type_line
          const typeLine = card.type_line || '';
          const front = typeLine.split('//')[0].trim();
          let type = 'Other';
          for (const t of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land']) {
            if (front.includes(t)) { type = t; break; }
          }

          const priceUsd = card.prices?.usd ? parseFloat(card.prices.usd) : null;
          const priceUsdFoil = card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null;

          const entry = {
            type,
            manaCost: card.mana_cost || (card.card_faces?.[0]?.mana_cost) || '',
            colorIdentity: card.color_identity || [],
            priceUsd,
            priceUsdFoil,
          };
          result.set(key, entry);
          setCache(metadataCache, key, entry);

          // Also populate price cache from same response (prices come free)
          setCache(priceCache, key, { priceUsd, priceUsdFoil });
        }
      }
    } catch (err) {
      console.error('Scryfall metadata fetch error:', err.message);
    }
  }

  return result;
}

/**
 * Fetch USD prices for an array of card names.
 * Returns Map<string, { priceUsd: number|null, priceUsdFoil: number|null }>
 * Keys are lowercased card names.
 */
export async function fetchCardPrices(cardNames) {
  const result = new Map();
  if (!cardNames || cardNames.length === 0) return result;

  const unique = [...new Set(cardNames.map(n => n.toLowerCase()))];

  // Check cache first
  const uncached = [];
  for (const name of unique) {
    const cached = getCached(priceCache, name, PRICE_TTL);
    if (cached) {
      result.set(name, cached);
    } else {
      uncached.push(name);
    }
  }
  if (uncached.length === 0) return result;

  const batches = [];
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    batches.push(uncached.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delay(DELAY_MS);

    const identifiers = batches[i].map(name => ({ name }));

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
        const key = card.name.toLowerCase();
        if (!result.has(key)) {
          const entry = {
            priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
            priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
          };
          result.set(key, entry);
          setCache(priceCache, key, entry);
        }
      }
    } catch (err) {
      console.error('Scryfall price fetch error:', err.message);
    }
  }

  return result;
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

  // Deduplicate by set+collector
  const seen = new Set();
  const unique = [];
  for (const card of withPrinting) {
    const scKey = `${card.set.toLowerCase()}|${card.collectorNumber}`;
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
        const nameKey = card.name.toLowerCase();
        const scKey = `${card.set}|${card.collector_number}`;
        const entry = {
          priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
          priceUsdFoil: card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null,
        };
        result.set(nameKey, entry);
        setCache(specificPriceCache, scKey, entry);
      }
    } catch (err) {
      console.error('Scryfall specific price fetch error:', err.message);
    }
  }

  return result;
}
