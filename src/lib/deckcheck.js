/**
 * DeckCheck Power Calculator integration.
 *
 * Opens DeckCheck's power calculator in a new tab.
 * The user can use DeckCheck's Import feature to load their deck.
 */

export const DECKCHECK_POWER_URL = 'https://deckcheck.co/app/power';

const UUID_SUFFIX = /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Share one DeckCheck identity parser between pasted imports and tracked sources. */
export function parseDeckCheckId(value) {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || url.hostname.toLowerCase().replace(/^www\./, '') !== 'deckcheck.co') return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'app') parts.shift();
    if (!['deck', 'deckview', 'builder'].includes(parts.shift() || '')) return null;
    if (parts[0] === 'share' || parts[0] === 'embed') parts.shift();
    const raw = parts[0] || '';
    if (!/^[A-Za-z0-9-]{1,200}$/.test(raw)) return null;
    const knownUuid = raw.match(UUID_SUFFIX);
    return knownUuid ? knownUuid[1].toLowerCase() : raw;
  } catch { return null; }
}
