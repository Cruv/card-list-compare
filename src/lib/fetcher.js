/**
 * Fetches deck lists from supported sites by URL.
 *
 * Supported:
 *  - Archidekt: https://archidekt.com/decks/{id}/...
 *  - Moxfield:  https://www.moxfield.com/decks/{publicId}
 *
 * Returns { text: string } where text is a plain-text deck list
 * that our existing parser can handle, OR throws an Error with a
 * user-friendly message.
 */

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

  const res = await fetch(apiUrl);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Archidekt deck not found. Is the URL correct?');
    throw new Error(`Archidekt returned status ${res.status}`);
  }

  const data = await res.json();
  const { text } = archidektToText(data);
  return text;
}

function archidektToText(data) {
  const mainLines = [];
  const sideLines = [];
  const commanderLines = [];
  const commanderNames = [];

  const cards = data.cards || [];

  for (const entry of cards) {
    const name = entry.card?.oracleCard?.name || entry.card?.name || 'Unknown';
    const qty = entry.quantity || 1;
    const categories = (entry.categories || []).map((c) =>
      typeof c === 'string' ? c.toLowerCase() : (c.name || '').toLowerCase()
    );

    const line = `${qty} ${name}`;

    if (categories.includes('commander') || categories.includes('commanders')) {
      commanderLines.push(line);
      commanderNames.push(name);
    } else if (categories.includes('sideboard')) {
      sideLines.push(line);
    } else if (categories.includes('maybeboard') || categories.includes('considering')) {
      // Skip maybeboard cards
      continue;
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

  return { text, commanders: commanderNames };
}

// ---------------------------------------------------------------------------
// Moxfield
// ---------------------------------------------------------------------------

async function fetchMoxfield(url) {
  const match = url.match(MOXFIELD_RE);
  if (!match) throw new Error('Could not parse Moxfield deck ID from URL.');
  const deckId = match[1];

  const apiUrl = `/api/moxfield/v3/decks/all/${deckId}`;

  const res = await fetch(apiUrl);
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

  // Moxfield organizes cards by board name
  const boards = data.boards || {};

  for (const [boardName, board] of Object.entries(boards)) {
    const cards = board.cards || {};
    const target = boardName.toLowerCase();

    for (const [, cardEntry] of Object.entries(cards)) {
      const name = cardEntry.card?.name || 'Unknown';
      const qty = cardEntry.quantity || 1;
      const line = `${qty} ${name}`;

      if (target === 'commanders' || target === 'commander') {
        sections.commanders.push(line);
      } else if (target === 'sideboard' || target === 'side') {
        sections.sideboard.push(line);
      } else if (target === 'companions' || target === 'companion') {
        sections.companions.push(line);
      } else if (target === 'mainboard' || target === 'main' || target === 'deck') {
        sections.mainboard.push(line);
      } else if (target !== 'maybeboard' && target !== 'considering') {
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

  return text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a deck list from a URL.
 * Returns { text: string, site: string }
 * Throws Error with user-friendly message on failure.
 */
export async function fetchDeckFromUrl(url) {
  const site = detectSite(url);

  if (site === 'deckcheck') {
    throw new Error(
      'Deckcheck.co does not have a public API.\n\n' +
        'To import a Deckcheck deck:\n' +
        '1. Open your deck on deckcheck.co\n' +
        '2. Click the export/copy button in the deck builder\n' +
        '3. Paste the text list here'
    );
  }

  if (site === 'archidekt') {
    const text = await fetchArchidekt(url);
    return { text, site };
  }

  if (site === 'moxfield') {
    const text = await fetchMoxfield(url);
    return { text, site };
  }

  throw new Error(
    'Unsupported URL. Supported sites:\n' +
      '• Archidekt (archidekt.com/decks/...)\n' +
      '• Moxfield (moxfield.com/decks/...)\n\n' +
      'For other sites, export your deck list and paste it directly.'
  );
}
