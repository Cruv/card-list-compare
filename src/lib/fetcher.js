/**
 * Fetches deck lists from supported sites by URL.
 *
 * Supported:
 *  - Archidekt:  https://archidekt.com/decks/{id}/...
 *  - Moxfield:   https://www.moxfield.com/decks/{publicId}
 *  - DeckCheck:  https://deckcheck.co/app/deckview/{hash}
 *
 * Returns { text: string, site: string, commanders: string[] }
 * where text is a plain-text deck list that our parser can handle,
 * OR throws an Error with a user-friendly message.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT = 10_000; // 10 seconds

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  return fetch(url, { ...options, signal: controller.signal })
    .catch(err => {
      if (err.name === 'AbortError') {
        throw new Error('Request timed out. The site may be slow — try again later.');
      }
      throw new Error('Network error. Check your connection and try again.');
    })
    .finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// URL pattern detection
// ---------------------------------------------------------------------------

const ARCHIDEKT_RE = /archidekt\.com\/decks\/(\d+)/i;
const MOXFIELD_RE = /moxfield\.com\/decks\/([\w-]+)/i;
const DECKCHECK_RE = /deckcheck\.co\/(app\/)?deckview\/([\w]+)/i;

export function detectSite(url) {
  if (ARCHIDEKT_RE.test(url)) return 'archidekt';
  if (MOXFIELD_RE.test(url)) return 'moxfield';
  if (DECKCHECK_RE.test(url)) return 'deckcheck';
  return null;
}

// ---------------------------------------------------------------------------
// Archidekt
// ---------------------------------------------------------------------------

async function fetchArchidekt(url) {
  const match = url.match(ARCHIDEKT_RE);
  if (!match) throw new Error('Could not parse Archidekt deck ID from URL.');
  const deckId = match[1];

  // Use the Vite proxy in dev, or direct URL with CORS headers in production
  const apiUrl = `/api/archidekt/decks/${deckId}/`;

  const res = await fetchWithTimeout(apiUrl);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Archidekt deck not found. Is the URL correct?');
    throw new Error(`Archidekt returned status ${res.status}`);
  }

  const data = await res.json();
  return archidektToText(data);
}

function archidektToText(data) {
  const mainLines = [];
  const sideLines = [];
  const commanderLines = [];
  const commanderNames = [];
  let totalCards = 0;
  let cardsWithMeta = 0;

  const cards = data.cards || [];

  for (const entry of cards) {
    const name = entry.card?.oracleCard?.name || entry.card?.name || 'Unknown';
    const qty = entry.quantity || 1;
    const setCode = entry.card?.edition?.editioncode || '';
    const collectorNumber = entry.card?.collectorNumber || '';
    const modifier = entry.modifier || 'Normal';
    const categories = (entry.categories || []).map((c) =>
      typeof c === 'string' ? c.toLowerCase() : (c.name || '').toLowerCase()
    );

    if (categories.includes('maybeboard') || categories.includes('considering')) {
      continue;
    }

    totalCards += qty;
    if (setCode && collectorNumber) cardsWithMeta += qty;

    let line = `${qty} ${name}`;
    if (setCode) line += ` (${setCode})`;
    if (collectorNumber) line += ` [${collectorNumber}]`;
    if (modifier === 'Foil') line += ` *F*`;

    if (categories.includes('commander') || categories.includes('commanders')) {
      commanderLines.push(line);
      commanderNames.push(name);
    } else if (categories.includes('sideboard')) {
      sideLines.push(line);
    } else {
      mainLines.push(line);
    }
  }

  let text = '';

  if (commanderLines.length > 0) {
    // Put commander under explicit header so parser can detect it
    text += 'Commander\n' + commanderLines.join('\n') + '\n\n';
  }

  text += mainLines.join('\n');

  if (sideLines.length > 0) {
    text += '\n\nSideboard\n' + sideLines.join('\n');
  }

  return { text, commanders: commanderNames, stats: { totalCards, cardsWithMeta } };
}

// ---------------------------------------------------------------------------
// Moxfield
// ---------------------------------------------------------------------------

async function fetchMoxfield(url) {
  const match = url.match(MOXFIELD_RE);
  if (!match) throw new Error('Could not parse Moxfield deck ID from URL.');
  const deckId = match[1];

  const apiUrl = `/api/moxfield/v3/decks/all/${deckId}`;

  const res = await fetchWithTimeout(apiUrl);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Moxfield deck not found. Is the URL correct?');
    if (res.status === 403)
      throw new Error(
        'Moxfield blocked the request. Try exporting your deck from Moxfield and pasting it instead.'
      );
    throw new Error(`Moxfield returned status ${res.status}`);
  }

  const data = await res.json();
  return moxfieldToText(data);
}

function moxfieldToText(data) {
  const sections = {
    commanders: [],
    mainboard: [],
    sideboard: [],
    companions: [],
  };
  const commanderNames = [];
  let totalCards = 0;
  let cardsWithMeta = 0;

  // Moxfield organizes cards by board name
  const boards = data.boards || {};

  for (const [boardName, board] of Object.entries(boards)) {
    const cards = board.cards || {};
    const target = boardName.toLowerCase();

    if (target === 'maybeboard' || target === 'considering') continue;

    for (const [, cardEntry] of Object.entries(cards)) {
      const name = cardEntry.card?.name || 'Unknown';
      const qty = cardEntry.quantity || 1;
      const setCode = cardEntry.card?.set || '';
      const collectorNumber = cardEntry.card?.cn || '';
      const finish = cardEntry.finish || '';
      const isFoil = cardEntry.isFoil || finish === 'foil' || finish === 'etched';

      totalCards += qty;
      if (setCode && collectorNumber) cardsWithMeta += qty;

      let line = `${qty} ${name}`;
      if (setCode) line += ` (${setCode})`;
      if (collectorNumber) line += ` [${collectorNumber}]`;
      if (isFoil) line += ` *F*`;

      if (target === 'commanders' || target === 'commander') {
        sections.commanders.push(line);
        commanderNames.push(name);
      } else if (target === 'sideboard' || target === 'side') {
        sections.sideboard.push(line);
      } else if (target === 'companions' || target === 'companion') {
        sections.companions.push(line);
      } else if (target === 'mainboard' || target === 'main' || target === 'deck') {
        sections.mainboard.push(line);
      } else {
        // Unknown board — treat as mainboard
        sections.mainboard.push(line);
      }
    }
  }

  let text = '';

  if (sections.commanders.length > 0) {
    text += 'Commander\n' + sections.commanders.join('\n') + '\n\n';
  }
  if (sections.companions.length > 0) {
    text += sections.companions.join('\n') + '\n';
  }

  text += sections.mainboard.join('\n');

  if (sections.sideboard.length > 0) {
    text += '\n\nSideboard\n' + sections.sideboard.join('\n');
  }

  return { text, commanders: commanderNames, stats: { totalCards, cardsWithMeta } };
}

// ---------------------------------------------------------------------------
// DeckCheck
// ---------------------------------------------------------------------------

async function fetchDeckcheck(url) {
  const match = url.match(DECKCHECK_RE);
  if (!match) throw new Error('Could not parse DeckCheck deck ID from URL.');
  const hash = match[2];

  const apiUrl = `/api/deckcheck/dc3/deck-cards/${hash}`;

  const res = await fetchWithTimeout(apiUrl);
  if (!res.ok) {
    if (res.status === 404) throw new Error('DeckCheck deck not found. Is the URL correct?');
    throw new Error(`DeckCheck returned status ${res.status}`);
  }

  const data = await res.json();
  return deckcheckToText(data);
}

function deckcheckToText(data) {
  const commanderNames = data.commanders || [];
  const cards = data.cards || {};

  let text = '';

  if (commanderNames.length > 0) {
    const commanderLines = commanderNames.map(name => `1 ${name}`);
    text += 'Commander\n' + commanderLines.join('\n') + '\n\n';
  }

  // Build mainboard from the cards map (name → quantity)
  // Exclude commanders from the mainboard
  const commanderSet = new Set(commanderNames.map(n => n.toLowerCase()));
  const mainLines = [];

  for (const [name, qty] of Object.entries(cards)) {
    if (commanderSet.has(name.toLowerCase())) continue;
    mainLines.push(`${qty} ${name}`);
  }

  text += mainLines.join('\n');

  let totalCards = commanderNames.length;
  for (const [, qty] of Object.entries(cards)) {
    if (typeof qty === 'number') totalCards += qty;
  }
  return { text, commanders: commanderNames, stats: { totalCards, cardsWithMeta: 0 } };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a deck list from a URL.
 * Returns { text, site, commanders, stats? }
 * stats: { totalCards: number, cardsWithMeta: number } — metadata coverage info
 * Throws Error with user-friendly message on failure.
 */
export async function fetchDeckFromUrl(url) {
  const site = detectSite(url);

  if (site === 'archidekt') {
    const { text, commanders, stats } = await fetchArchidekt(url);
    return { text, site, commanders, stats };
  }

  if (site === 'moxfield') {
    const { text, commanders, stats } = await fetchMoxfield(url);
    return { text, site, commanders, stats };
  }

  if (site === 'deckcheck') {
    const { text, commanders, stats } = await fetchDeckcheck(url);
    return { text, site, commanders, stats };
  }

  throw new Error(
    'Unsupported URL. Supported sites:\n' +
      '• Archidekt (archidekt.com/decks/...)\n' +
      '• Moxfield (moxfield.com/decks/...)\n' +
      '• DeckCheck (deckcheck.co/app/deckview/...)\n\n' +
      'For other sites, export your deck list and paste it directly.'
  );
}

// Exported for testing
export { archidektToText as _archidektToText, moxfieldToText as _moxfieldToText, deckcheckToText as _deckcheckToText };
