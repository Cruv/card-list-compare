import {
  CARD_LINE_PATTERN,
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
import { printCardKey } from './printSelection.js';

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
const INDEXED_CARD_LINE = new RegExp(CARD_LINE_PATTERN, `${CARD_LINE_PATTERN.flags}d`);
const INLINE_COMMANDER_RE = /\s*(?:\(Commander\)|\[Commander(?:\{[^}]*\})*\]|\*CMDR\*)\s*$/i;

/**
 * Peel trailing provider decorations off a line, right to left, before the card-line grammar runs.
 * Archidekt category brackets and colour flags and Moxfield tags all sit after the finish marker,
 * so without this every line of those exports reached the deck as one long card name.
 */
function stripDecorations(line) {
  let text = line.trimEnd();
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
      if (PRINTING_BRACKET_BODY.test(bracket[1])
        && (/\d/.test(bracket[1]) || text.match(CARD_LINE_PATTERN)?.[4])) break;
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
export function deckTextIncompatibilities(rawText, { includeSideboard = true } = {}) {
  const source = String(rawText || '');
  if (!/\*E\*/i.test(source)) return [];
  const lines = source.split(/\r?\n/);
  const problems = [];
  for (const { index, section, line } of sectionedLines(lines)) {
    if (!includeSideboard && (section === 'sideboard' || SB_PREFIX.test(line))) continue;
    const { text } = stripDecorations(line.replace(SB_PREFIX, ''));
    if (!ETCHED_MARKER.test(text)) continue;
    problems.push({
      line: index + 1,
      raw: lines[index],
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

export function* sectionedLines(lines, onSkipped) {
  // Explicit headers can be commented in ManaSync exports.
  const heading = line => line.trim().replace(COMMENT_PREFIX, '');
  const hasExplicitCommander = lines.some(line => COMMANDER_HEADER.test(heading(line)));
  let section = 'main';
  let hasMainLines = false;
  let hasCommanderLines = false;
  let foundExplicitSideboard = false;
  let skipping = '';

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const header = heading(line);
    if (COMMANDER_HEADER.test(header)) {
      section = 'commander';
      hasCommanderLines = false;
      skipping = '';
      continue;
    }
    if (SIDEBOARD_HEADER.test(header)) {
      section = 'sideboard';
      foundExplicitSideboard = true;
      skipping = '';
      continue;
    }
    if (MAINBOARD_HEADER.test(header)) {
      section = 'main';
      skipping = '';
      continue;
    }
    if (MAYBEBOARD_HEADER.test(header) || ABOUT_HEADER.test(header)) {
      skipping = MAYBEBOARD_HEADER.test(header) ? 'Maybeboard' : 'Deck information';
      continue;
    }
    if (COMMENT_LINE.test(trimmed)) continue;
    if (skipping) {
      if (trimmed) onSkipped?.({ index, reason: skipping });
      continue;
    }

    if (trimmed === '') {
      if (hasMainLines && section === 'main' && !foundExplicitSideboard && !hasExplicitCommander) section = 'sideboard';
      if (hasCommanderLines && section === 'commander') section = 'main';
      continue;
    }

    if (section === 'main') hasMainLines = true;
    if (section === 'commander') hasCommanderLines = true;
    yield { index, section, line: trimmed };
  }
}

const KNOWN_IMPORT_FINISHES = new Set(['', 'normal', 'nonfoil', 'regular', 'foil', '*f*', 'true', 'false', 'yes', 'no', '0', '1']);
export const unsupportedImportFinish = value => typeof value === 'string'
  && !KNOWN_IMPORT_FINISHES.has(value.trim().toLowerCase().replace(/[-\s]/g, ''));

function inspectImportRows(rawText, strictFinish = true) {
  const lines = rawText.split(/\r?\n/);
  const accepted = [], skipped = [], rejectedFinishes = [];
  const skip = (index, reason) => {
    const row = { line: index + 1, raw: lines[index], reason };
    skipped.push(row);
    return row;
  };
  const skipFinish = (index, finish) => rejectedFinishes.push(skip(index, `Unsupported finish (${finish})`));
  const add = (index, card, section, sourceSection = section, inlineCommander = false) => accepted.push({ line: index + 1,
    displayName: card.displayName ?? card.name, quantity: card.quantity, setCode: card.setCode,
    collectorNumber: card.collectorNumber, isFoil: card.isFoil, section, sourceSection, inlineCommander });
  const header = lines.findIndex(line => line.trim());
  const columns = isCSV(rawText) ? csvColumns(lines[header]) : null;
  if (columns && columns.nameIdx !== -1) {
    for (let index = header + 1; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      const cells = splitCsvLine(lines[index]);
      const section = cells[columns.sectionIdx]?.toLowerCase();
      const finish = cells[columns.foilIdx];
      if (['maybeboard', 'considering'].includes(section)) { skip(index, 'Maybeboard'); continue; }
      if (strictFinish && unsupportedImportFinish(finish)) { skipFinish(index, finish); continue; }
      const row = csvCard(cells, columns);
      if (row) add(index, row.entry, row.sideboard ? 'sideboard' : row.commander ? 'commander' : 'main');
      else skip(index, 'Missing card name or invalid quantity');
    }
    return { accepted, skipped, rejectedFinishes, lines, csvHeader: header };
  }

  for (const { index, section, line } of sectionedLines(lines, ({ index, reason }) => skip(index, reason))) {
    const card = parseLine(line);
    if (strictFinish) {
      const finish = stripDecorations(line).text.match(/(?:^|\s)(\*[a-z]+\*)\s*$/i)?.[1];
      if (unsupportedImportFinish(finish)) { skipFinish(index, finish); continue; }
    }
    if (!card) { skip(index, 'Invalid card row or quantity'); continue; }
    if (card.isSB && section === 'commander') { skip(index, 'Sideboard card in the commander section'); continue; }
    add(index, card, card.isSB ? 'sideboard' : section, section, card.isCommander);
  }
  skipped.sort((a, b) => a.line - b.line);
  return { accepted, skipped, rejectedFinishes, lines };
}

function previewAppliedRows(rows) {
  // The parser uses inline commander tags only when the explicit block has no
  // accepted commanders. Sideboard rows retain their placement.
  const explicit = rows.some(row => row.sourceSection === 'commander');
  return rows.map(({ sourceSection, inlineCommander, ...row }) => ({
    ...row, section: !explicit && sourceSection === 'main' && row.section === 'main' && inlineCommander ? 'commander' : row.section,
  }));
}

/** Report what a standalone import would use without changing the parser grammar. */
export function inspectDeckImport(rawText) {
  const { accepted, skipped, lines, csvHeader } = inspectImportRows(rawText);
  if (!skipped.length) return { accepted: previewAppliedRows(accepted), skipped, text: rawText };
  const separator = rawText.includes('\r\n') ? '\r\n' : '\n';
  if (csvHeader !== undefined) {
    const text = [lines[csvHeader], ...accepted.map(row => lines[row.line - 1])].join(separator);
    return { accepted: previewAppliedRows(accepted), skipped, text };
  }
  const included = [];
  let section;
  for (const row of accepted) {
    if (row.sourceSection !== section) {
      section = row.sourceSection;
      included.push({ main: 'Mainboard', commander: 'Commander', sideboard: 'Sideboard' }[section]);
    }
    included.push(lines[row.line - 1]);
  }
  return { accepted: previewAppliedRows(accepted), skipped, text: included.join(separator) };
}

function rawTextareaOffset(text, offset) {
  // A textarea uses LF indices even when a controlled draft still has CRLF.
  for (const match of text.matchAll(/\r\n/g)) {
    if (match.index >= offset) break;
    offset++;
  }
  return offset;
}

function changesBoundaryPrinting(draft, prefix, suffix, replacedText, insertion, appliedRows) {
  if (!insertion.trim()) return false;
  const before = prefix.slice(prefix.lastIndexOf('\n') + 1).trim();
  const [after] = suffix.split(/\r?\n/, 1);
  if (!before && !after.trim()) return false;
  const first = prefix.split('\n').length;
  const originalRows = inspectImportRows(draft, false).accepted;
  const boundaries = [
    { remains: before, originalLine: first, appliedLine: first },
    { remains: after.trim(), originalLine: first + replacedText.split('\n').length - 1, appliedLine: first + insertion.split('\n').length - 1 },
  ];
  return boundaries.some(({ remains, originalLine, appliedLine }) => {
    if (!remains) return false;
    const original = originalRows.find(card => card.line === originalLine);
    if (!original || !(original.setCode || original.collectorNumber || original.isFoil)) return false;
    const applied = appliedRows.find(card => card.line === appliedLine);
    return !applied || cardIdentityKey(applied) !== cardIdentityKey(original) || applied.quantity !== original.quantity;
  });
}

/** Review a textarea paste without writing outside the selected range. */
export function inspectDeckPaste(draft, pasted, selectionStart, selectionEnd) {
  const start = rawTextareaOffset(draft, selectionStart);
  const end = rawTextareaOffset(draft, selectionEnd);
  const prefix = draft.slice(0, start);
  const suffix = draft.slice(end);
  const pasteEnd = start + pasted.length;
  const candidate = prefix + pasted + suffix;
  const rejected = new Map(inspectImportRows(candidate).skipped.map(row => [row.line, row]));
  // Check clipboard finishes separately. A draft fragment can otherwise hide an
  // unsupported marker at a splice boundary, as when *E* runs into *F*.
  const lineOffset = prefix.split('\n').length - 1;
  for (const row of inspectImportRows(pasted).rejectedFinishes) {
    const line = lineOffset + row.line;
    rejected.set(line, { ...row, line });
  }
  const skipped = [], removed = [];
  let offset = 0, trimLastSeparator = false;
  const parts = candidate.split(/(\r?\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const line = i / 2 + 1;
    const rowEnd = offset + parts[i].length;
    const next = rowEnd + (parts[i + 1]?.length ?? 0);
    const row = rejected.get(line);
    const from = Math.max(start, offset);
    let to = Math.min(pasteEnd, rowEnd);
    if (row && from < to) {
      skipped.push({ ...row, raw: candidate.slice(from, to) });
      if (offset >= start && rowEnd <= pasteEnd) {
        // Remove the separator that arrived with a wholly pasted skipped row.
        // The last clipboard row can borrow its closing separator from the
        // original draft, in which case its preceding inserted separator goes.
        to = Math.min(next, pasteEnd);
        trimLastSeparator = to === pasteEnd && (next === rowEnd || next > pasteEnd);
      }
      const previous = removed.at(-1);
      if (previous?.end === from) previous.end = to;
      else removed.push({ start: from, end: to });
    }
    offset = next;
  }
  if (trimLastSeparator) {
    const last = removed.at(-1);
    if (candidate[last.start - 1] === '\n') {
      last.start = Math.max(start, last.start - (candidate[last.start - 2] === '\r' ? 2 : 1));
    }
  }
  const kept = [];
  let keptFrom = start;
  for (const range of removed) {
    kept.push(candidate.slice(keptFrom, range.start));
    keptFrom = range.end;
  }
  kept.push(candidate.slice(keptFrom, pasteEnd));
  const insertion = kept.join('');
  const replacedText = draft.slice(start, end);
  const proposed = prefix + insertion + suffix;
  const proposedRows = inspectImportRows(proposed, false).accepted;
  const changesPrinting = changesBoundaryPrinting(draft, prefix, suffix, replacedText, insertion, proposedRows);
  if (changesPrinting) {
    for (const raw of insertion.split(/\r?\n/)) {
      if (raw.trim()) skipped.push({ raw, reason: 'Would change an existing card printing. Paste at a line boundary or select the whole card row.' });
    }
  }
  const keepDraft = changesPrinting || (skipped.length > 0 && !insertion.trim());
  return { accepted: previewAppliedRows(keepDraft ? inspectImportRows(draft, false).accepted : proposedRows), skipped,
    text: keepDraft ? draft : proposed, replacedText: keepDraft ? '' : replacedText };
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
  const { text: body } = stripDecorations(card);
  const format = body.match(INDEXED_CARD_LINE);
  // Bare names and the older no-header CSV syntax need a count and space to
  // carry metadata under the shared card-line grammar.
  const nameAndQuantity = format
    ? body.slice(0, format.indices[2][1]).trimEnd()
    : `${parsed.quantity} ${body.match(LINE_PATTERNS[1])?.[2] ?? body}`;
  const collector = format?.[5] ? collectorNumber : `[${collectorNumber}]`;
  return `${prefix}${nameAndQuantity} (${setCode}) ${collector}${format?.[6] ?? ''}${card.slice(body.length)}${line.slice(trimmed.length)}`;
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
    return { mainboard: new Map(), sideboard: new Map(), commanders: [], problems: [] };
  }

  // Try CSV first
  if (isCSV(rawText)) {
    const result = parseCSV(rawText);
    if (result) return { ...result, problems: [] };
  }

  const problems = deckTextIncompatibilities(rawText);
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

  return { mainboard, sideboard, commanders, problems };
}
