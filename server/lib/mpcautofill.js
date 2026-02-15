/**
 * Server-side MPC Autofill API client.
 * Searches for community-created proxy card images via the MPC Autofill backend
 * at mpcfill.com, and downloads full-resolution images via Google Apps Script proxy.
 *
 * Uses in-memory TTL caches (1hr for search results, 24hr for DFC pairs).
 */

const MPC_API = 'https://mpcfill.com';
const IMAGE_PROXY = 'https://script.google.com/macros/s/AKfycbw8laScKBfxda2Wb0g63gkYDBdy8NWNxINoC4xDOwnCQ3JMFdruam1MdmNmN4wI5k4/exec';
const USER_AGENT = 'CardListCompare/1.0';

const SEARCH_TTL = 60 * 60 * 1000;      // 1 hour
const CARD_TTL = 60 * 60 * 1000;         // 1 hour
const DFC_TTL = 24 * 60 * 60 * 1000;     // 24 hours
const META_TTL = 24 * 60 * 60 * 1000;    // 24 hours (sources, languages, tags)
const IMAGE_DELAY_MS = 200;              // Delay between image downloads
const MAX_CONCURRENT_DOWNLOADS = 5;

// ── TTL Cache ──────────────────────────────────────────────

const searchCache = new Map();
const cardCache = new Map();
let dfcCache = null;     // { data, ts }
let sourcesCache = null; // { data, ts }
let languagesCache = null;
let tagsCache = null;

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
 * Check if MPC Autofill backend is reachable and search engine is online.
 */
export async function checkHealth() {
  try {
    const res = await fetch(`${MPC_API}/2/searchEngineHealth/`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return { online: false };
    const data = await res.json();
    return { online: data.online === true };
  } catch {
    return { online: false };
  }
}

/**
 * Fetch double-faced card pairs from MPC Autofill.
 * Returns Map<frontName, backName> (lowercased keys).
 */
export async function getDFCPairs() {
  if (dfcCache && Date.now() - dfcCache.ts < DFC_TTL) {
    return dfcCache.data;
  }

  try {
    const res = await fetch(`${MPC_API}/2/DFCPairs/`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return new Map();
    const data = await res.json();

    const pairs = new Map();
    for (const [front, back] of data) {
      pairs.set(front.toLowerCase(), back);
    }
    dfcCache = { data: pairs, ts: Date.now() };
    return pairs;
  } catch (err) {
    console.error('MPC Autofill DFC pairs error:', err.message);
    return new Map();
  }
}

/**
 * Fetch available image sources from MPC Autofill.
 * Returns array of { pk, key, name, sourceType, description }.
 */
export async function getSources() {
  if (sourcesCache && Date.now() - sourcesCache.ts < META_TTL) {
    return sourcesCache.data;
  }
  try {
    const res = await fetch(`${MPC_API}/2/sources/`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const sources = Object.values(data.results || {})
      .map(s => ({
        pk: s.pk,
        key: s.key || '',
        name: s.name || '',
        sourceType: s.sourceType || '',
        description: s.description || '',
      }))
      .sort((a, b) => a.pk - b.pk);
    sourcesCache = { data: sources, ts: Date.now() };
    return sources;
  } catch (err) {
    console.error('MPC Autofill sources error:', err.message);
    return [];
  }
}

/**
 * Fetch available languages from MPC Autofill.
 * Returns array of { code, name }.
 */
export async function getLanguages() {
  if (languagesCache && Date.now() - languagesCache.ts < META_TTL) {
    return languagesCache.data;
  }
  try {
    const res = await fetch(`${MPC_API}/2/languages/`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const languages = (data.languages || []).map(l => ({
      code: l.code || '',
      name: l.name || '',
    }));
    languagesCache = { data: languages, ts: Date.now() };
    return languages;
  } catch (err) {
    console.error('MPC Autofill languages error:', err.message);
    return [];
  }
}

/**
 * Fetch available tags from MPC Autofill.
 * Returns flattened array of { name, parent, children } for simple UI rendering.
 */
export async function getTags() {
  if (tagsCache && Date.now() - tagsCache.ts < META_TTL) {
    return tagsCache.data;
  }
  try {
    const res = await fetch(`${MPC_API}/2/tags/`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return [];
    const data = await res.json();

    // Flatten tag tree into a simple list
    const tags = [];
    function walk(nodes, parentName) {
      for (const node of nodes) {
        const childNames = (node.children || []).map(c => c.name);
        tags.push({
          name: node.name,
          parent: parentName,
          children: childNames,
        });
        if (node.children && node.children.length > 0) {
          walk(node.children, node.name);
        }
      }
    }
    walk(data.tags || [], null);
    tagsCache = { data: tags, ts: Date.now() };
    return tags;
  } catch (err) {
    console.error('MPC Autofill tags error:', err.message);
    return [];
  }
}

/**
 * Create a simple hash of searchSettings for cache key differentiation.
 */
function settingsHash(searchSettings) {
  if (!searchSettings) return 'default';
  return JSON.stringify(searchSettings);
}

/**
 * Build default search settings (backward compatible with previous hardcoded values).
 */
function getDefaultSearchSettings() {
  return {
    searchTypeSettings: {
      fuzzySearch: false,
      filterCardbacks: false,
    },
    filterSettings: {
      minimumDPI: 0,
      maximumDPI: 1500,
      maximumSize: 30,
      languages: [],
      includesTags: [],
      excludesTags: ['NSFW'],
    },
    sourceSettings: {
      sources: [],
    },
  };
}

/**
 * Search for card images by name.
 * Accepts array of card name strings and optional searchSettings.
 * Returns Map<cardName, identifier[]> where identifiers are Google Drive file IDs.
 */
export async function searchCards(cardNames, searchSettings) {
  const result = new Map();
  if (!cardNames || cardNames.length === 0) return result;

  const unique = [...new Set(cardNames.map(n => n.toLowerCase()))];
  const sHash = settingsHash(searchSettings);

  // Check cache first (keyed by name + settings hash)
  const uncached = [];
  for (const name of unique) {
    const cacheKey = `${name}|${sHash}`;
    const cached = getCached(searchCache, cacheKey, SEARCH_TTL);
    if (cached !== null) {
      result.set(name, cached);
    } else {
      uncached.push(name);
    }
  }
  if (uncached.length === 0) return result;

  // Build search queries
  const queries = uncached.map(name => ({
    query: name,
    cardType: 'CARD',
  }));

  // Use provided settings or defaults
  const effectiveSettings = searchSettings || getDefaultSearchSettings();

  try {
    const res = await fetch(`${MPC_API}/2/editorSearch/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ queries, searchSettings: effectiveSettings }),
    });

    if (!res.ok) {
      console.error('MPC Autofill search failed:', res.status);
      return result;
    }

    const data = await res.json();

    // Response structure: { results: { [query]: { CARD: [identifier, ...] } } }
    // Or it may be an array of { query, results: { CARD: [...] } }
    if (data.results) {
      for (const [query, typeMap] of Object.entries(data.results)) {
        const nameLower = query.toLowerCase();
        const identifiers = typeMap.CARD || [];
        result.set(nameLower, identifiers);
        setCache(searchCache, `${nameLower}|${sHash}`, identifiers);
      }
    }

    // Also cache empty results for cards that weren't found
    for (const name of uncached) {
      if (!result.has(name)) {
        result.set(name, []);
        setCache(searchCache, `${name}|${sHash}`, []);
      }
    }
  } catch (err) {
    console.error('MPC Autofill search error:', err.message);
  }

  return result;
}

/**
 * Fetch card details for given identifiers (Google Drive file IDs).
 * Returns Map<identifier, { name, dpi, extension, sourceName, thumbnailUrl }>.
 */
export async function fetchCardDetails(identifiers) {
  const result = new Map();
  if (!identifiers || identifiers.length === 0) return result;

  const unique = [...new Set(identifiers)];

  // Check cache first
  const uncached = [];
  for (const id of unique) {
    const cached = getCached(cardCache, id, CARD_TTL);
    if (cached) {
      result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }
  if (uncached.length === 0) return result;

  try {
    const res = await fetch(`${MPC_API}/2/cards/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ identifiers: uncached }),
    });

    if (!res.ok) {
      console.error('MPC Autofill card details failed:', res.status);
      return result;
    }

    const data = await res.json();

    // Response structure: { results: { [identifier]: { name, dpi, ... } } }
    if (data.results) {
      for (const [id, card] of Object.entries(data.results)) {
        const entry = {
          name: card.name || '',
          dpi: card.dpi || 0,
          extension: card.extension || 'png',
          sourceName: card.source_name || card.sourceName || '',
          thumbnailUrl: `https://drive.google.com/thumbnail?sz=w400-h400&id=${id}`,
        };
        result.set(id, entry);
        setCache(cardCache, id, entry);
      }
    }
  } catch (err) {
    console.error('MPC Autofill card details error:', err.message);
  }

  return result;
}

/**
 * Download a single card image by its Google Drive file ID.
 * Uses the public Google Apps Script proxy (returns base64).
 * Returns { buffer: Buffer, extension: string } or null on failure.
 */
export async function downloadImage(identifier, extension = 'png') {
  try {
    const res = await fetch(`${IMAGE_PROXY}?id=${identifier}`, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.error(`MPC image download failed for ${identifier}: ${res.status}`);
      return null;
    }

    const text = await res.text();

    // The proxy returns base64-encoded image content
    // It may have a data URI prefix like "data:image/png;base64,"
    let base64 = text;
    const dataUriMatch = text.match(/^data:[^;]+;base64,(.+)$/s);
    if (dataUriMatch) {
      base64 = dataUriMatch[1];
    }

    const buffer = Buffer.from(base64, 'base64');
    return { buffer, extension };
  } catch (err) {
    console.error(`MPC image download error for ${identifier}:`, err.message);
    return null;
  }
}

/**
 * Download multiple images with rate limiting and concurrency control.
 * Accepts array of { identifier, name, extension }.
 * Returns array of { name, buffer, extension } (skips failures).
 */
export async function downloadImages(cards) {
  const results = [];
  const queue = [...cards];
  const active = [];

  async function processOne(card) {
    const result = await downloadImage(card.identifier, card.extension || 'png');
    if (result) {
      results.push({
        name: card.name,
        buffer: result.buffer,
        extension: result.extension,
      });
    }
  }

  while (queue.length > 0 || active.length > 0) {
    // Fill up to MAX_CONCURRENT_DOWNLOADS
    while (active.length < MAX_CONCURRENT_DOWNLOADS && queue.length > 0) {
      const card = queue.shift();
      const promise = processOne(card).then(() => {
        active.splice(active.indexOf(promise), 1);
      });
      active.push(promise);
      await delay(IMAGE_DELAY_MS);
    }

    // Wait for at least one to complete
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  return results;
}

/**
 * Generate MPC Autofill XML project file.
 * Accepts array of { name, quantity, identifier, extension }.
 * Returns XML string.
 */
export function generateXml(cards, options = {}) {
  const { cardstock = '(S30) Standard Smooth', foil = false } = options;

  // Calculate total quantity and assign slot numbers
  let totalQty = 0;
  const cardEntries = [];

  for (const card of cards) {
    if (!card.identifier) continue;
    const qty = card.quantity || 1;
    const slots = [];
    for (let i = 0; i < qty; i++) {
      slots.push(totalQty + i);
    }
    totalQty += qty;

    const ext = card.extension || 'png';
    const safeName = card.name.replace(/[<>&"']/g, '');

    cardEntries.push(
      `    <card>\n` +
      `      <id>${escapeXml(card.identifier)}</id>\n` +
      `      <slots>${slots.join(',')}</slots>\n` +
      `      <name>${escapeXml(safeName)}.${ext}</name>\n` +
      `      <query>${escapeXml(card.name)}</query>\n` +
      `    </card>`
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<order>\n` +
    `  <details>\n` +
    `    <quantity>${totalQty}</quantity>\n` +
    `    <stock>${escapeXml(cardstock)}</stock>\n` +
    `    <foil>${foil ? 'true' : 'false'}</foil>\n` +
    `  </details>\n` +
    `  <fronts>\n` +
    cardEntries.join('\n') + '\n' +
    `  </fronts>\n` +
    `  <backs/>\n` +
    `  <cardback/>\n` +
    `</order>`;

  return xml;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
