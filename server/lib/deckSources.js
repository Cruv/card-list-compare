import { all, get } from '../db.js';

const UUID_SUFFIX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This wire identity matches ManaSync's shared/deck-sources contract. Presentation
// slugs, share query strings and www do not identify a different provider deck.
export function parseDeckSourceUrl(value) {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let provider, deckId;
    if (host === 'archidekt.com' && parts[0] === 'decks' && /^\d{1,40}$/.test(parts[1] || '')) {
      provider = 'archidekt'; deckId = BigInt(parts[1]).toString();
      if (deckId === '0') return null;
    } else if (host === 'moxfield.com' && parts[0] === 'decks' && /^[A-Za-z0-9_-]{1,200}$/.test(parts[1] || '')) {
      provider = 'moxfield'; deckId = parts[1];
    } else if (host === 'deckcheck.co') {
      if (parts[0] === 'app') parts.shift();
      if (!['deck', 'deckview', 'builder'].includes(parts.shift() || '')) return null;
      if (parts[0] === 'share' || parts[0] === 'embed') parts.shift();
      const raw = parts[0] || '';
      if (!/^[A-Za-z0-9-]{1,200}$/.test(raw)) return null;
      provider = 'deckcheck';
      const knownUuid = raw.match(UUID_SUFFIX);
      deckId = knownUuid ? knownUuid[0].toLowerCase() : raw;
    } else return null;
    const origin = provider === 'deckcheck' ? 'deckcheck.co/deck' : `${provider}.com/decks`;
    return { provider, deckId, url: `https://${origin}/${deckId}` };
  } catch { return null; }
}

export function normalizeDeckSourceLink(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.keys(input).some(key => !['provider', 'deckId', 'url'].includes(key)) ||
      typeof input.url !== 'string' || typeof input.deckId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(input.deckId)) return null;
  const parsed = parseDeckSourceUrl(input.url);
  if (!parsed || parsed.provider !== input.provider) return null;
  const idLink = parseDeckSourceUrl(`https://${parsed.provider === 'deckcheck' ? 'deckcheck.co/deck' : `${parsed.provider}.com/decks`}/${input.deckId}`);
  return idLink?.deckId === parsed.deckId ? parsed : null;
}

export function trackedDeckSourceLink(deck) {
  const binding = get('SELECT provider, source_deck_id, canonical_url FROM integration_deck_sources WHERE deck_id = ? AND user_id = ?', [deck.id, deck.user_id]);
  const explicit = binding && normalizeDeckSourceLink({ provider: binding.provider, deckId: binding.source_deck_id, url: binding.canonical_url });
  if (binding && !explicit) throw new Error('Invalid saved deck source identity');
  const tracked = deck.source_type === 'archidekt' && Number.isSafeInteger(deck.archidekt_deck_id) && deck.archidekt_deck_id > 0
    ? parseDeckSourceUrl(`https://archidekt.com/decks/${deck.archidekt_deck_id}`) : null;
  if (tracked && explicit && (tracked.provider !== explicit.provider || tracked.deckId !== explicit.deckId)) {
    throw new Error('Conflicting saved deck source identities');
  }
  return tracked || explicit || null;
}

export function findDecksBySource(userId, source) {
  // Include the native Archidekt tracker as well as explicitly linked manual
  // decks. A legacy duplicate is a conflict for review, never an implicit merge.
  return all(`SELECT DISTINCT d.* FROM tracked_decks d
    LEFT JOIN integration_deck_sources s ON s.deck_id = d.id AND s.user_id = d.user_id
    WHERE d.user_id = ? AND ((s.provider = ? AND s.source_deck_id = ?) OR
      (? = 'archidekt' AND d.source_type = 'archidekt' AND CAST(d.archidekt_deck_id AS TEXT) = ?))
    ORDER BY d.id`, [userId, source.provider, source.deckId, source.provider, source.deckId]);
}
