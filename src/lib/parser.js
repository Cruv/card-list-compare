import {
  LINE_PATTERNS,
  SIDEBOARD_HEADER,
  MAINBOARD_HEADER,
  COMMANDER_HEADER,
  MAYBEBOARD_HEADER,
  ABOUT_HEADER,
  COMMENT_PREFIX,
  SB_PREFIX,
  COMMENT_LINE,
  ARCHIDEKT_FLAGS,
  MOXFIELD_TAG,
  PROVIDER_BRACKET,
  PRINTING_BRACKET_BODY,
  ETCHED_MARKER,
} from './constants.js';
import { cardIdentityKey } from './cardIdentity.js';

// NFC so a decomposed name (a macOS paste, some provider exporters) matches the composed spelling
// the catalogs use. NFC and not NFKC: compatibility folding would rename real cards.
// Mirrors normalizeCardName() in ManaSync's shared/deck-text.ts; the pair is pinned by the shared
// corpus in tests/fixtures/deck-lines/.
function normalizeName(name) {
  return name
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/['\u2018\u2019`\u2032]/g, "'")
    .trim();
}

// Deckcheck and Archidekt command-zone tags, including our own text export.
const INLINE_COMMANDER_RE = /\s*(?:\(Commander\)|\[Commander(?:\{[^}]*\})*\]|\*CMDR\*)\s*$/i;

/**
 * Peel trailing provider decorations off a line, right to left, before the card-line grammar runs.
 * Archidekt category brackets and colour flags and Moxfield tags all sit after the finish marker,
 * so without this every line of those exports reached the deck as one long card name.
 */
function stripDecorations(line) {
  let text = line;
  let isCommander = false;
  for (let guard = 0; guard < 16; guard += 1) {
    const flags = text.match(ARCHIDEKT_FLAGS);
    if (flags) {
      text = text.slice(0, flags.index).trimEnd();
      continue;
    }
    const tag = text.match(MOXFIELD_TAG);
    if (tag) {
      text = text.slice(0, tag.index).trimEnd();
      continue;
    }
    const commander = text.match(INLINE_COMMANDER_RE);
    if (commander) {
      isCommander = true;
      text = text.slice(0, commander.index).trimEnd();
      continue;
    }
    const bracket = text.match(PROVIDER_BRACKET);
    if (bracket) {
      // A printing number keeps its meaning; anything else is a provider category.
      if (PRINTING_BRACKET_BODY.test(bracket[1]) && /\d/.test(bracket[1])) break;
      text = text.slice(0, bracket.index).trimEnd();
      continue;
    }
    break;
  }
  return { text, isCommander };
}

/**
 * Lines this deck-text format cannot express. The only case today is the etched marker: ManaSync
 * writes `*E*`, CARD_LINE_PATTERN knows only `*F*`. Report them by line rather than letting the
 * marker become part of a card name.
 */
export function deckTextIncompatibilities(rawText) {
  const problems = [];
  for (const [index, rawLine] of String(rawText || '').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || COMMENT_LINE.test(line)) continue;
    const { text } = stripDecorations(line.replace(SB_PREFIX, ''));
    if (!ETCHED_MARKER.test(text)) continue;
    problems.push({
      line: index + 1,
      raw: rawLine,
      code: 'etched_unsupported',
      reason: `Line ${index + 1} is marked etched (*E*), which this card-line format cannot express.`,
    });
  }
  return problems;
}

export function parseLine(line) {
  if (COMMENT_LINE.test(line)) return null;

  // Check for SB: prefix — return with sideboard flag
  const sbMatch = line.match(SB_PREFIX);
  let isSB = false;
  if (sbMatch) {
    line = line.slice(sbMatch[0].length).trim();
    isSB = true;
  }

  // Strip provider decorations, including the inline (Commander)/[Commander{top}] tag.
  const decorated = stripDecorations(line);
  line = decorated.text;
  const isCommander = decorated.isCommander;

  // Refuse an etched line instead of reading "*E*" as part of the card name. Callers already treat
  // a line that yields nothing as unresolved, and deckTextIncompatibilities() names the reason.
  if (ETCHED_MARKER.test(line)) return null;

  for (const pattern of LINE_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      const quantity = parseInt(match[1], 10);
      const name = normalizeName(match[2]);
      const setCode = match[3] || '';
      // Collector number: group 4 (bracketed) or group 5 (bare after set code)
      const collectorNumber = match[4] || match[5] || '';
      const isFoil = !!match[6];
      if (Number.isSafeInteger(quantity) && quantity > 0 && name.length > 0) {
        return { name, quantity, isSB, isCommander, setCode, collectorNumber, isFoil };
      }
      return null; // Never reinterpret an invalid copy count as part of a card name.
    }
  }

  // Fallback: bare card name with quantity 1
  const trimmed = line.trim();
  if (/^[+-]?\d+(?:\.\d+)?\s*x?\s+/i.test(trimmed)) return null;
  if (trimmed.length > 0 && !/^\d+$/.test(trimmed)) {
    return { name: normalizeName(trimmed), quantity: 1, isSB, isCommander, setCode: '', collectorNumber: '', isFoil: false };
  }

  return null;
}

function isCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return false;
  const header = lines[0].toLowerCase();
  return (
    header.includes(',') &&
    (header.includes('quantity') ||
      header.includes('count') ||
      header.includes('name') ||
      header.includes('card'))
  );
}

// Quote-aware CSV field splitter: a comma inside "..." is part of the field, and
// "" is an escaped quote. Plain `split(',')` corrupted every quoted card name
// with a comma (e.g. "Atraxa, Praetors' Voice") — audit H4.
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  let fieldStart = true; // only a leading quote opens a quoted field
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
      fieldStart = true;
    } else {
      // A stray quote mid-field (e.g. 6" Golem) is literal, not a delimiter.
      cur += ch;
      if (ch !== ' ') fieldStart = false;
    }
  }
  if (inQuotes) {
    // Unterminated quote — the rest of the row would otherwise be swallowed into
    // one field. Degrade to a plain split like the pre-quote-aware parser did,
    // so a malformed row still yields usable columns.
    return line.split(',').map((f) => f.trim().replace(/"/g, ''));
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0].toLowerCase());

  const nameIdx = header.findIndex(
    (h) => h === 'name' || h === 'card' || h === 'card name' || h === 'cardname'
  );
  const qtyIdx = header.findIndex(
    (h) => h === 'quantity' || h === 'count' || h === 'qty' || h === 'amount'
  );
  const sectionIdx = header.findIndex(
    (h) => h === 'section' || h === 'board' || h === 'category' || h === 'type' || h === 'location'
  );
  const setIdx = header.findIndex(h => ['set', 'set code', 'setcode', 'edition code'].includes(h));
  const collectorIdx = header.findIndex(h => ['collector number', 'collector_number', 'collectornumber', 'cn'].includes(h));
  const foilIdx = header.findIndex(h => ['foil', 'isfoil', 'is foil', 'modifier', 'finish'].includes(h));

  if (nameIdx === -1) return null;

  const mainboard = new Map();
  const sideboard = new Map();
  const commanders = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const name = normalizeName(cols[nameIdx] || '');
    const quantity = qtyIdx !== -1 && cols[qtyIdx]?.trim() ? Number(cols[qtyIdx]) : 1;

    if (!name || !Number.isSafeInteger(quantity) || quantity <= 0) continue;

    let target = mainboard;
    if (sectionIdx !== -1) {
      const section = (cols[sectionIdx] || '').toLowerCase();
      if (section === 'maybeboard' || section === 'considering') continue;
      if (section.includes('side') || section === 'sb') {
        target = sideboard;
      }
      if (['commander', 'commanders', 'command zone'].includes(section) && !commanders.includes(name)) {
        commanders.push(name);
      }
    }

    const entry = {
      displayName: name,
      quantity,
      setCode: setIdx === -1 ? '' : cols[setIdx] || '',
      collectorNumber: collectorIdx === -1 ? '' : cols[collectorIdx] || '',
      isFoil: foilIdx !== -1 && ['foil', 'etched', 'true', 'yes', '1', '*f*'].includes((cols[foilIdx] || '').toLowerCase()),
    };
    const key = cardIdentityKey(entry);
    if (target.has(key)) {
      const existing = target.get(key);
      existing.quantity += quantity;
    } else {
      target.set(key, entry);
    }
  }

  return { mainboard, sideboard, commanders };
}

function splitSections(rawText) {
  const lines = rawText.split(/\r?\n/);
  // Commander exports often separate card groups with blank lines. Check the
  // whole list because some exports put the command zone after the mainboard.
  // ManaSync writes its board headers as comments ("# Commander"); Archidekt, MTGO and Arena write
  // the bare word. Test the marker-stripped spelling so both round-trip.
  const heading = (line) => line.trim().replace(COMMENT_PREFIX, '');
  const hasExplicitCommander = lines.some(line => COMMANDER_HEADER.test(heading(line)));
  const mainLines = [];
  const sideLines = [];
  const commanderLines = [];
  let currentTarget = mainLines;
  let foundExplicitSideboard = false;
  let blankLineCount = 0;
  let hasSeenContent = false;
  // Maybeboard cards are not in the deck, and Arena's About block is deck metadata, not cards.
  // Without this the header itself became a one-copy card through the bare-name fallback.
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const header = heading(line);

    if (COMMANDER_HEADER.test(header)) {
      skipping = false;
      currentTarget = commanderLines;
      continue;
    }

    if (SIDEBOARD_HEADER.test(header)) {
      skipping = false;
      currentTarget = sideLines;
      foundExplicitSideboard = true;
      continue;
    }

    if (MAINBOARD_HEADER.test(header)) {
      skipping = false;
      currentTarget = mainLines;
      continue;
    }

    if (MAYBEBOARD_HEADER.test(header) || ABOUT_HEADER.test(header)) {
      skipping = true;
      continue;
    }

    if (skipping) continue;

    if (trimmed === '') {
      if (hasSeenContent && !foundExplicitSideboard && !hasExplicitCommander) {
        blankLineCount++;
        if (blankLineCount >= 1 && currentTarget === mainLines && mainLines.length > 0) {
          currentTarget = sideLines;
        }
      }
      // If we were in commander section, switch to mainboard on blank line
      if (currentTarget === commanderLines && commanderLines.length > 0) {
        currentTarget = mainLines;
      }
      continue;
    }

    blankLineCount = 0;
    hasSeenContent = true;
    currentTarget.push(trimmed);
  }

  return { mainLines, sideLines, commanderLines };
}

function parseLines(lines) {
  const cards = new Map();
  const sbCards = new Map();
  const inlineCommanders = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (parsed.isCommander) {
      inlineCommanders.push(parsed.name);
    }

    const target = parsed.isSB ? sbCards : cards;
    const key = cardIdentityKey(parsed);

    if (target.has(key)) {
      const existing = target.get(key);
      existing.quantity += parsed.quantity;
      if (!existing.setCode && parsed.setCode) existing.setCode = parsed.setCode;
      if (!existing.collectorNumber && parsed.collectorNumber) existing.collectorNumber = parsed.collectorNumber;
      if (!existing.isFoil && parsed.isFoil) existing.isFoil = parsed.isFoil;
    } else {
      target.set(key, {
        displayName: parsed.name,
        quantity: parsed.quantity,
        setCode: parsed.setCode || '',
        collectorNumber: parsed.collectorNumber || '',
        isFoil: parsed.isFoil || false,
      });
    }
  }

  return { cards, sbCards, inlineCommanders };
}

export function parse(rawText) {
  if (!rawText || !rawText.trim()) {
    return { mainboard: new Map(), sideboard: new Map(), commanders: [], problems: [] };
  }

  // Try CSV first
  if (isCSV(rawText)) {
    const result = parseCSV(rawText);
    if (result) return { ...result, problems: [] };
  }

  const { mainLines, sideLines, commanderLines } = splitSections(rawText);

  // Surfaced rather than silently dropped: parseLine() refuses an etched line instead of reading
  // the marker as part of the card name, so the caller needs the reason to show the sender.
  const problems = deckTextIncompatibilities(rawText);
  const mainResult = parseLines(mainLines);
  const sideResult = parseLines(sideLines);
  const cmdResult = parseLines(commanderLines);

  // Merge: any SB:-prefixed cards from mainLines go to sideboard
  const mainboard = mainResult.cards;
  const sideboard = sideResult.cards;

  // Commander cards go into mainboard too (they're part of the deck)
  // but we also extract their names for display
  const commanders = [];

  // 1. Commanders from explicit "Commander" section header
  for (const [key, value] of cmdResult.cards) {
    commanders.push(value.displayName);
    if (mainboard.has(key)) {
      const existing = mainboard.get(key);
      existing.quantity += value.quantity;
      if (!existing.setCode && value.setCode) existing.setCode = value.setCode;
      if (!existing.collectorNumber && value.collectorNumber) existing.collectorNumber = value.collectorNumber;
      if (!existing.isFoil && value.isFoil) existing.isFoil = value.isFoil;
    } else {
      mainboard.set(key, value);
    }
  }

  // 2. Commanders from inline "(Commander)" tags (e.g. Deckcheck exports)
  //    These cards are already in mainboard from parseLines, just grab their names
  if (commanders.length === 0 && mainResult.inlineCommanders.length > 0) {
    commanders.push(...mainResult.inlineCommanders);
  }

  // Merge SB-prefixed cards from main section into sideboard
  for (const [key, value] of mainResult.sbCards) {
    if (sideboard.has(key)) {
      const existing = sideboard.get(key);
      existing.quantity += value.quantity;
      if (!existing.setCode && value.setCode) existing.setCode = value.setCode;
      if (!existing.collectorNumber && value.collectorNumber) existing.collectorNumber = value.collectorNumber;
      if (!existing.isFoil && value.isFoil) existing.isFoil = value.isFoil;
    } else {
      sideboard.set(key, value);
    }
  }

  // Also merge SB-prefixed cards from side section
  for (const [key, value] of sideResult.sbCards) {
    if (sideboard.has(key)) {
      const existing = sideboard.get(key);
      existing.quantity += value.quantity;
      if (!existing.setCode && value.setCode) existing.setCode = value.setCode;
      if (!existing.collectorNumber && value.collectorNumber) existing.collectorNumber = value.collectorNumber;
      if (!existing.isFoil && value.isFoil) existing.isFoil = value.isFoil;
    } else {
      sideboard.set(key, value);
    }
  }

  return { mainboard, sideboard, commanders, problems };
}
