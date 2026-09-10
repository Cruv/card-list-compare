import { parseLine } from '../../src/lib/parser.js';
import { normalizedName } from '../../src/lib/cardIdentity.js';

const fail = (code = 'incomplete_source') => {
  const error = new Error(code === 'unsupported_finish' ? 'CLC cannot yet track etched source cards without changing their finish.' : 'The complete provider list cannot be represented safely. The saved deck is preserved.');
  error.code = code; throw error;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const cardLine = (name, quantity, card = {}, finish = 'nonfoil') => {
  if (typeof name !== 'string' || !name.trim() || /[\r\n]/.test(name) ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) fail();
  // CLC's current text contract has a foil marker but no distinct etched marker.
  // An unsupported finish must not silently become a different printing.
  if (typeof finish !== 'string') fail('unsupported_finish');
  finish = finish.toLowerCase();
  if (!['nonfoil', 'foil', ''].includes(finish)) fail('unsupported_finish');
  const set = card.set || '', collector = card.cn || '';
  if (set && (typeof set !== 'string' || !/^[a-z0-9]+$/i.test(set))) fail();
  if (collector && (typeof collector !== 'string' || !set || /[\]\s]/.test(collector))) fail();
  const line = `${quantity} ${name.trim()}${set ? ` (${set})` : ''}${collector ? ` [${collector}]` : ''}${finish === 'foil' ? ' *F*' : ''}`;
  // The shared text grammar can interpret unsupported collector punctuation as
  // part of the name. Reject any identity that cannot survive its round trip.
  const parsed = parseLine(line);
  if (!parsed || normalizedName(parsed.name) !== normalizedName(name) || parsed.quantity !== quantity ||
      parsed.setCode !== set || parsed.collectorNumber !== collector || parsed.isFoil !== (finish === 'foil')) fail();
  return line;
};

function result(name, commanders, main, side) {
  const text = [commanders.length ? `Commander\n${commanders.map(row => row.line).join('\n')}` : '',
    main.join('\n'), side.length ? `Sideboard\n${side.join('\n')}` : ''].filter(Boolean).join('\n\n');
  if (text.length > 500000) fail();
  return { rawText: text, name: typeof name === 'string' && name.trim() ? name.slice(0, 200) : null,
    commanders: commanders.map(row => row.name) };
}

export function moxfieldSource(data) {
  if (!object(data) || !object(data.boards)) fail();
  if (!Object.keys(data.boards).some(name => ['mainboard', 'main', 'deck'].includes(name.toLowerCase()))) fail();
  const main = [], side = [], commanders = [];
  for (const [boardName, board] of Object.entries(data.boards)) {
    if (!object(board) || !object(board.cards)) fail();
    const boardType = boardName.toLowerCase();
    if (['maybeboard', 'considering', 'tokens'].includes(boardType)) continue;
    if (!['commanders', 'commander', 'mainboard', 'main', 'deck', 'sideboard', 'side', 'companions', 'companion'].includes(boardType)) fail();
    for (const entry of Object.values(board.cards)) {
      if (!object(entry) || !object(entry.card)) fail();
      const line = cardLine(entry.card.name, entry.quantity, entry.card, entry.finish || (entry.isFoil ? 'foil' : 'nonfoil'));
      if (['commander', 'commanders'].includes(boardType)) commanders.push({ name: entry.card.name, line });
      else if (['sideboard', 'side'].includes(boardType)) side.push(line);
      else main.push(line);
    }
  }
  return result(data.name, commanders, main, side);
}

export function deckcheckSource(data, summary = {}) {
  if (!object(data) || !object(data.cards)) fail();
  const names = data.commanders ?? summary.commanders ?? [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim())) fail();
  const commanders = names.map(name => ({ name, line: cardLine(name, data.cards[name] ?? 1) }));
  const commandNames = new Set(names.map(name => name.toLowerCase()));
  const main = Object.entries(data.cards).filter(([name]) => !commandNames.has(name.toLowerCase())).map(([name, quantity]) => cardLine(name, quantity));
  const sideboard = data.sideboard ?? {};
  if (!object(sideboard)) fail();
  const side = Object.entries(sideboard).map(([name, quantity]) => cardLine(name, quantity));
  const companion = data.companion ?? summary.companion;
  if (companion != null && typeof companion !== 'string') fail();
  if (companion && !Object.keys(data.cards).some(name => name.toLowerCase() === companion.toLowerCase())) main.push(cardLine(companion, 1));
  return result(data.name || data.deck_name || summary.name || summary.deck_name, commanders, main, side);
}

async function readJson(url, signal) {
  const response = await fetch(url, { signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'CardListCompare/2.45 source-tracking' } });
  if (!response.ok) throw new Error(`Provider source unavailable (${response.status}).`);
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) fail();
  const reader = response.body?.getReader();
  if (!reader) fail();
  let length = 0; const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8 * 1024 * 1024) { await reader.cancel(); fail(); }
    parts.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function fetchTrackedProviderSource(source) {
  const signal = AbortSignal.timeout(20000);
  const id = encodeURIComponent(source.deckId);
  if (source.provider === 'moxfield') return moxfieldSource(await readJson(`https://api2.moxfield.com/v3/decks/all/${id}`, signal));
  if (source.provider === 'deckcheck') {
    const [cards, summary] = await Promise.all([
      readJson(`https://deckcheck.co/api/dc3/deck-cards/${id}`, signal),
      readJson(`https://deckcheck.co/api/dc3/deck-summary/${id}`, signal)
    ]);
    return deckcheckSource(cards, summary);
  }
  throw new Error('Unsupported source provider');
}
