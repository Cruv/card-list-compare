// Shared deck-line corpus — the contract test for the card-line grammar.
//
// tests/fixtures/deck-lines/ is copied verbatim between this repo and ManaSync, and both test
// suites run it. CARD_LINE_PATTERN here stays normative; the corpus is how a change to it, or to
// ManaSync's shared/deck-text.ts, has to be agreed in both repos before either parser moves.
// See tests/fixtures/deck-lines/README.md for the record shape and the recorded divergences.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  COMMANDER_HEADER,
  SIDEBOARD_HEADER,
  MAINBOARD_HEADER,
  MAYBEBOARD_HEADER,
  ABOUT_HEADER,
  COMMENT_PREFIX,
  COMMENT_LINE,
  SB_PREFIX,
} from './constants.js';
import { parseLine, deckTextIncompatibilities } from './parser.js';

const CORPUS = new URL('../../tests/fixtures/deck-lines/', import.meta.url);
const cases = readdirSync(CORPUS)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();

// The corpus covers the line grammar and explicit section headers only, so this walk tracks
// headers the way splitSections() does and leaves the blank-line heuristics out of it.
function observed(text) {
  const etched = new Set(deckTextIncompatibilities(text).map((problem) => problem.line));
  const rows = [];
  let section = null;
  let skipping = false;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const header = trimmed.replace(COMMENT_PREFIX, '');
    if (COMMANDER_HEADER.test(header)) { section = 'commander'; skipping = false; continue; }
    if (SIDEBOARD_HEADER.test(header)) { section = 'sideboard'; skipping = false; continue; }
    if (MAINBOARD_HEADER.test(header)) { section = 'mainboard'; skipping = false; continue; }
    if (MAYBEBOARD_HEADER.test(header) || ABOUT_HEADER.test(header)) { skipping = true; continue; }
    if (skipping || COMMENT_LINE.test(trimmed)) continue;
    if (etched.has(line)) { rows.push({ line, unreadable: 'etched' }); continue; }
    const parsed = parseLine(trimmed);
    if (!parsed) { rows.push({ line, unreadable: 'line' }); continue; }
    rows.push({
      line,
      quantity: parsed.quantity,
      name: parsed.name,
      setCode: parsed.setCode.toLowerCase(),
      collectorNumber: parsed.collectorNumber,
      finish: parsed.isFoil ? 'foil' : 'nonfoil',
      section: parsed.isSB ? 'sideboard' : parsed.isCommander ? 'commander' : section,
    });
  }
  return rows;
}

// ManaSync distinguishes "no quantity" from "quantity out of range"; this parser reports neither,
// so any stated unreadable reason other than the etched refusal collapses to "line".
const stated = (entry) => {
  const { clc, ...base } = entry;
  const row = clc ?? base;
  return row.unreadable ? { line: row.line, unreadable: row.unreadable === 'etched' ? 'etched' : 'line' } : row;
};

describe('shared deck-line corpus', () => {
  it('has cases to run', () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  for (const name of cases) {
    it(`parses the ${name} fixture exactly as the corpus states`, () => {
      const text = readFileSync(new URL(`${name}.txt`, CORPUS), 'utf8');
      const expected = JSON.parse(readFileSync(new URL(`${name}.json`, CORPUS), 'utf8'));
      expect(expected.description).toBeTruthy();
      expect(observed(text)).toEqual(
        expected.lines.map(stated).sort((a, b) => a.line - b.line)
      );
    });
  }
});

describe('etched lines ManaSync can write and this grammar cannot read', () => {
  it('names the line instead of building a card called "Sol Ring (LTC) [284] *E*"', () => {
    const text = '1 Sol Ring (LTC) [284] *E*\n1 Arcane Signet (LTC) [285]\n';
    expect(deckTextIncompatibilities(text)).toEqual([
      {
        line: 1,
        raw: '1 Sol Ring (LTC) [284] *E*',
        code: 'etched_unsupported',
        reason: 'Line 1 is marked etched (*E*), which this card-line format cannot express.',
      },
    ]);
    expect(parseLine('1 Sol Ring (LTC) [284] *E*')).toBe(null);
    expect(parseLine('1 Sol Ring (LTC) [284] *F*')).toMatchObject({ name: 'Sol Ring', isFoil: true });
  });
});

describe('SB: prefixed lines still reach the sideboard through the decoration strip', () => {
  it('keeps the prefix meaning when a provider tag trails the line', () => {
    expect(parseLine('SB: 2 Duress (M19) 94 #Interaction')).toMatchObject({
      name: 'Duress',
      quantity: 2,
      isSB: true,
      setCode: 'M19',
      collectorNumber: '94',
    });
    expect(SB_PREFIX.test('SB: 2 Duress')).toBe(true);
  });
});
