import {
  LINE_PATTERNS,
  SIDEBOARD_HEADER,
  MAINBOARD_HEADER,
  COMMANDER_HEADER,
  SB_PREFIX,
  COMMENT_LINE,
} from './constants.js';

function normalizeName(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/['\u2018\u2019`\u2032]/g, "'")
    .trim();
}

// Matches an inline "(Commander)" tag at the end of a card line (e.g. Deckcheck export)
const INLINE_COMMANDER_RE = /\s*\(Commander\)\s*$/i;

function parseLine(line) {
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
      if (quantity > 0 && name.length > 0) {
        return { name, quantity, isSB, isCommander };
      }
    }
  }

  // Fallback: bare card name with quantity 1
  const trimmed = line.trim();
  if (trimmed.length > 0 && !/^\d+$/.test(trimmed)) {
    return { name: normalizeName(trimmed), quantity: 1, isSB, isCommander };
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

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/"/g, ''));

  const nameIdx = header.findIndex(
    (h) => h === 'name' || h === 'card' || h === 'card name' || h === 'cardname'
  );
  const qtyIdx = header.findIndex(
    (h) => h === 'quantity' || h === 'count' || h === 'qty' || h === 'amount'
  );
  const sectionIdx = header.findIndex(
    (h) => h === 'section' || h === 'board' || h === 'type' || h === 'location'
  );

  if (nameIdx === -1) return null;

  const mainboard = new Map();
  const sideboard = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/"/g, ''));
    const name = normalizeName(cols[nameIdx] || '');
    const quantity = qtyIdx !== -1 ? parseInt(cols[qtyIdx], 10) || 1 : 1;

    if (!name) continue;

    let target = mainboard;
    if (sectionIdx !== -1) {
      const section = (cols[sectionIdx] || '').toLowerCase();
      if (section.includes('side') || section === 'sb') {
        target = sideboard;
      }
    }

    const key = name.toLowerCase();
    if (target.has(key)) {
      const existing = target.get(key);
      existing.quantity += quantity;
    } else {
      target.set(key, { displayName: name, quantity });
    }
  }

  return { mainboard, sideboard };
}

function splitSections(rawText) {
  const lines = rawText.split(/\r?\n/);
  const mainLines = [];
  const sideLines = [];
  const commanderLines = [];
  let currentTarget = mainLines;
  let foundExplicitSideboard = false;
  let foundExplicitCommander = false;
  let blankLineCount = 0;
  let hasSeenContent = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (COMMANDER_HEADER.test(trimmed)) {
      currentTarget = commanderLines;
      foundExplicitCommander = true;
      continue;
    }

    if (SIDEBOARD_HEADER.test(trimmed)) {
      currentTarget = sideLines;
      foundExplicitSideboard = true;
      continue;
    }

    if (MAINBOARD_HEADER.test(trimmed)) {
      currentTarget = mainLines;
      continue;
    }

    if (trimmed === '') {
      if (hasSeenContent && !foundExplicitSideboard) {
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
    const key = parsed.name.toLowerCase();

    if (target.has(key)) {
      target.get(key).quantity += parsed.quantity;
    } else {
      target.set(key, { displayName: parsed.name, quantity: parsed.quantity });
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
    if (result) return { ...result, commanders: [] };
  }

  const { mainLines, sideLines, commanderLines } = splitSections(rawText);

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
      mainboard.get(key).quantity += value.quantity;
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
      sideboard.get(key).quantity += value.quantity;
    } else {
      sideboard.set(key, value);
    }
  }

  // Also merge SB-prefixed cards from side section
  for (const [key, value] of sideResult.sbCards) {
    if (sideboard.has(key)) {
      sideboard.get(key).quantity += value.quantity;
    } else {
      sideboard.set(key, value);
    }
  }

  return { mainboard, sideboard, commanders };
}
