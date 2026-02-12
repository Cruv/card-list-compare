/**
 * Server-side Scryfall client for batch card lookups.
 * Uses the /cards/collection endpoint to fetch set and collector number info.
 * Node 22 has built-in fetch — no extra dependencies needed.
 */

const SCRYFALL_API = 'https://api.scryfall.com';
const BATCH_SIZE = 75; // Scryfall max per request
const DELAY_MS = 100; // Respect rate limit (~10 req/sec)

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

  const batches = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    batches.push(unique.slice(i, i + BATCH_SIZE));
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
      });

      if (!res.ok) continue;

      const data = await res.json();

      for (const card of (data.data || [])) {
        const key = card.name.toLowerCase();
        if (!result.has(key)) {
          result.set(key, {
            set: card.set || '',
            collectorNumber: card.collector_number || '',
          });
        }
      }
    } catch (err) {
      console.error('Scryfall batch fetch error:', err.message);
    }
  }

  return result;
}
