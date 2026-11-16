import {
  CARD_LINE_PATTERN,
  LINE_PATTERNS,
  SIDEBOARD_HEADER,
  MAINBOARD_HEADER,
  COMMANDER_HEADER,
  SB_PREFIX,
  COMMENT_LINE,
} from './constants.js';
import { cardIdentityKey } from './cardIdentity.js';
import { printCardKey } from './printSelection.js';

function normalizeName(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/['\u2018\u2019`\u2032]/g, "'")
    .trim();
}

// Deckcheck and Archidekt command-zone tags, including our own text export.
const INLINE_COMMANDER_RE = /\s*(?:\(Commander\)|\[Commander(?:\{top\})?\])\s*$/i;
const INDEXED_CARD_LINE = new RegExp(CARD_LINE_PATTERN, `${CARD_LINE_PATTERN.flags}d`);

export function parseLine(line) {
  if (COMMENT_LINE.test(line)) return null;

  // Check for SB: prefix — return with sideboard flag
  const sbMatch = line.match(SB_PREFIX);
  let isSB = false;
  if (sbMatch) {
    line = line.slice(sbMatch[0].length).trim();
    isSB = true;
  }

  // Check for inline (Commander) tag — strip it and flag the card
  let isCommander = false;
  if (INLINE_COMMANDER_RE.test(line)) {
    isCommander = true;
    line = line.replace(INLINE_COMMANDER_RE, '').trim();
  }

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
function splitCsvLine(line, rawFields) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  let fieldStart = true; // only a leading quote opens a quoted field
  let fieldOffset = 0;
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
      rawFields?.push(line.slice(fieldOffset, i));
      fieldOffset = i + 1;
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
    const values = line.split(',').map((f) => f.trim().replace(/"/g, ''));
    if (rawFields) {
      rawFields.length = 0;
      for (const value of values) rawFields.push(value);
    }
    return values;
  }
  fields.push(cur);
  rawFields?.push(line.slice(fieldOffset));
  return fields.map((f) => f.trim());
}

function csvColumns(line) {
  const header = splitCsvLine(line.trim().toLowerCase());
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
  return { nameIdx, qtyIdx, sectionIdx, setIdx, collectorIdx, foilIdx, width: header.length };
}

function csvCard(cols, { nameIdx, qtyIdx, sectionIdx, setIdx, collectorIdx, foilIdx }) {
  const name = normalizeName(cols[nameIdx] || '');
  const quantity = qtyIdx !== -1 && cols[qtyIdx]?.trim() ? Number(cols[qtyIdx]) : 1;
  const section = (cols[sectionIdx] || '').toLowerCase();
  if (!name || !Number.isSafeInteger(quantity) || quantity <= 0 || section === 'maybeboard' || section === 'considering') return null;
  return {
    entry: {
      displayName: name,
      quantity,
      setCode: cols[setIdx] || '',
      collectorNumber: cols[collectorIdx] || '',
      isFoil: ['foil', 'etched', 'true', 'yes', '1', '*f*'].includes((cols[foilIdx] || '').toLowerCase()),
    },
    sideboard: section.includes('side') || section === 'sb',
    commander: ['commander', 'commanders', 'command zone'].includes(section),
  };
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const columns = csvColumns(lines[0]);
  if (columns.nameIdx === -1) return null;

  const mainboard = new Map();
  const sideboard = new Map();
  const commanders = [];

  for (let i = 1; i < lines.length; i++) {
    const card = csvCard(splitCsvLine(lines[i]), columns);
    if (!card) continue;
    const { entry } = card;
    if (card.commander && !commanders.includes(entry.displayName)) commanders.push(entry.displayName);
    const target = card.sideboard ? sideboard : mainboard;
    const key = cardIdentityKey(entry);
    if (target.has(key)) {
      const existing = target.get(key);
      existing.quantity += entry.quantity;
    } else {
      target.set(key, entry);
    }
  }

  return { mainboard, sideboard, commanders };
}

function* sectionedLines(lines) {
  // Commander exports often separate card groups with blank lines. Check the
  // whole list because some exports put the command zone after the mainboard.
  const hasExplicitCommander = lines.some(line => COMMANDER_HEADER.test(line.trim()));
  let section = 'main';
  let hasMainLines = false;
  let hasCommanderLines = false;
  let foundExplicitSideboard = false;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();

    if (COMMANDER_HEADER.test(trimmed)) {
      section = 'commander';
      continue;
    }

    if (SIDEBOARD_HEADER.test(trimmed) || /^#\s*sideboard\s*$/i.test(trimmed)) {
      section = 'sideboard';
      foundExplicitSideboard = true;
      continue;
    }

    if (MAINBOARD_HEADER.test(trimmed)) {
      section = 'main';
      continue;
    }

    if (trimmed === '') {
      if (hasMainLines && section === 'main' && !foundExplicitSideboard && !hasExplicitCommander) section = 'sideboard';
      // If we were in commander section, switch to mainboard on blank line
      if (hasCommanderLines && section === 'commander') section = 'main';
      continue;
    }

    if (section === 'main') hasMainLines = true;
    if (section === 'commander') hasCommanderLines = true;
    yield { index, section, line: trimmed };
  }
}

export function rewriteDeckPrinting(text, selectionKey, printing, options) {
  return rewriteDeckPrintings(text, [{ ...printing, selectionKey }], options);
}

// Read each original row once so replacements cannot cascade when choices
// include two printings of the same card. Preserve unrelated lines and CSV cells.
export function rewriteDeckPrintings(text, choices, { includeSideboard = false } = {}) {
  if (!text?.trim() || !choices.length) return text;
  const printingsBySelectionKey = new Map(choices.map(choice => [choice.selectionKey, choice]));
  const parts = text.split(/(\r?\n)/);
  if (isCSV(text)) {
    const result = rewriteCsvPrintings(parts, printingsBySelectionKey, includeSideboard);
    if (result !== null) return result ? parts.join('') : text;
  }

  const lines = parts.filter((_, index) => index % 2 === 0);
  for (const { index, section, line } of sectionedLines(lines)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    // The deck parser excludes SB-prefixed entries inside the commander block.
    if (parsed.isSB && section === 'commander') continue;
    if (!includeSideboard && (parsed.isSB || section === 'sideboard')) continue;
    const printing = printingsBySelectionKey.get(printCardKey(parsed));
    if (!printing) continue;
    const part = index * 2;
    parts[part] = rewritePrintingLine(parts[part], parsed, printing);
  }
  return parts.join('');
}

function rewritePrintingLine(line, parsed, { setCode, collectorNumber }) {
  if (parsed.setCode === setCode && parsed.collectorNumber === collectorNumber) return line;
  const trimmed = line.trimEnd();
  const prefix = trimmed.match(SB_PREFIX)?.[0] ?? trimmed.slice(0, trimmed.length - trimmed.trimStart().length);
  const card = trimmed.slice(prefix.length);
  const commander = card.match(INLINE_COMMANDER_RE);
  const body = commander ? card.slice(0, commander.index) : card;
  const format = body.match(INDEXED_CARD_LINE);
  // Bare names and the older no-header CSV syntax need a count and space to
  // carry metadata under the shared card-line grammar.
  const nameAndQuantity = format
    ? body.slice(0, format.indices[2][1]).trimEnd()
    : `${parsed.quantity} ${body.match(LINE_PATTERNS[1])?.[2] ?? body}`;
  const collector = format?.[5] ? collectorNumber : `[${collectorNumber}]`;
  return `${prefix}${nameAndQuantity} (${setCode}) ${collector}${format?.[6] ?? ''}${commander?.[0] ?? ''}${line.slice(trimmed.length)}`;
}

function rewriteCsvPrintings(parts, printingsBySelectionKey, includeSideboard) {
  const headerIndex = parts.findIndex(line => line.trim());
  const columns = csvColumns(parts[headerIndex]);
  if (columns.nameIdx === -1) return null;

  const appendedHeaders = [];
  let { setIdx, collectorIdx } = columns;
  if (setIdx === -1) {
    setIdx = columns.width;
    appendedHeaders.push('set code');
  }
  if (collectorIdx === -1) {
    collectorIdx = columns.width + appendedHeaders.length;
    appendedHeaders.push('collector number');
  }
  const appendedFields = appendedHeaders.map(() => '');
  let changed = false;
  for (let index = headerIndex + 2; index < parts.length; index += 2) {
    const rawFields = [];
    const card = csvCard(splitCsvLine(parts[index], rawFields), columns);
    const printing = card && (!card.sideboard || includeSideboard)
      ? printingsBySelectionKey.get(printCardKey(card.entry)) : undefined;
    const replace = printing && (card.entry.setCode !== printing.setCode || card.entry.collectorNumber !== printing.collectorNumber);
    const shiftExtraFields = appendedFields.length && rawFields.length > columns.width;
    if (!replace && !shiftExtraFields) continue;
    if (shiftExtraFields) rawFields.splice(columns.width, 0, ...appendedFields);
    if (replace) {
      rawFields[setIdx] = printing.setCode;
      rawFields[collectorIdx] = printing.collectorNumber;
      changed = true;
    }
    parts[index] = rawFields.join(',');
  }
  if (changed && appendedHeaders.length) parts[headerIndex] += `,${appendedHeaders.join(',')}`;
  return changed;
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
    return { mainboard: new Map(), sideboard: new Map(), commanders: [] };
  }

  // Try CSV first
  if (isCSV(rawText)) {
    const result = parseCSV(rawText);
    if (result) return result;
  }

  const sections = { main: [], sideboard: [], commander: [] };
  for (const { line, section } of sectionedLines(rawText.split(/\r?\n/))) sections[section].push(line);
  const mainResult = parseLines(sections.main);
  const sideResult = parseLines(sections.sideboard);
  const cmdResult = parseLines(sections.commander);

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

  return { mainboard, sideboard, commanders };
}
