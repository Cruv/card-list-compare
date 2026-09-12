const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const MAX_ART_PAGES = 5;

function previewUrl(uris) {
  const value = uris?.normal || uris?.large || uris?.png;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cards.scryfall.io' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Keep a printing's faces together; choices are exact IDs from one oracle. */
export function printingChoice(card, oracleId) {
  if (!UUID.test(card?.id || '') || card?.oracle_id !== oracleId || card.digital === true
    || typeof card.name !== 'string' || !card.name.trim()) return null;
  const sourceFaces = card.image_uris ? [{ name: card.name, image_uris: card.image_uris }] : card.card_faces;
  if (!Array.isArray(sourceFaces) || sourceFaces.length !== (card.image_uris ? 1 : 2)) return null;
  const faces = sourceFaces.map((face, index) => ({ name: face.name || card.name,
    face: index ? 'back' : 'front', url: previewUrl(face.image_uris) }));
  if (faces.some(face => !face.url)) return null;
  return { id: card.id, name: card.name, setName: card.set_name || card.set || '',
    setCode: card.set || '', collectorNumber: card.collector_number || '',
    artist: card.artist || card.card_faces?.map(face => face.artist).filter(Boolean).join(' / ') || '', faces };
}

export async function loadPrintArtPage(oracleId, page = 1, { signal, fetchImpl = fetch } = {}) {
  if (!UUID.test(oracleId || '')) throw new Error('Review this card again to resolve its identity before picking art.');
  if (!Number.isInteger(page) || page < 1 || page > MAX_ART_PAGES) throw new Error('Printing page is out of range.');
  const params = new URLSearchParams({ q: `oracleid:${oracleId} game:paper lang:en`, unique: 'prints',
    order: 'released', dir: 'desc', include_variations: 'true', page: String(page) });
  const response = await fetchImpl(`/api/scryfall/cards/search?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (response.status === 404) return { choices: [], hasMore: false, total: 0 };
  if (!response.ok) throw new Error('Scryfall printings could not load. Try again.');
  const data = await response.json();
  if (!Array.isArray(data.data) || data.data.length > 175 || typeof data.has_more !== 'boolean') {
    throw new Error('Scryfall returned an incomplete printing list. Try again.');
  }
  return { choices: data.data.map(card => printingChoice(card, oracleId)).filter(Boolean),
    hasMore: data.has_more, total: Number.isSafeInteger(data.total_cards) ? data.total_cards : null };
}

export function filterPrintArt(choices, query) {
  const value = query.trim().toLocaleLowerCase();
  return !value ? choices : choices.filter(card => `${card.name} ${card.setName} ${card.setCode} ${card.collectorNumber} ${card.artist}`.toLocaleLowerCase().includes(value));
}
