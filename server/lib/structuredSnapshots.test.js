import { describe, expect, it } from 'vitest';
import { structuredCards } from './structuredSnapshots.js';

describe('structured snapshot board boundaries', () => {
  it('ends an Archidekt commander block at its separator without classifying the mainboard as commanders', () => {
    const result = structuredCards('Commander\n1 Cloud, Ex-SOLDIER (fic) [2]\n\n1 Umezawa\'s Jitte (pza) [19]\n10 Plains (ecl) [269]\n\nSideboard\n2 Sol Ring (CMM) [410]');
    expect(result.unresolvedLines).toEqual([]);
    expect(result.cards.map(({ quantity, section, lineNumber }) => ({ quantity, section, lineNumber }))).toEqual([
      { quantity: 1, section: 'commander', lineNumber: 2 },
      { quantity: 1, section: 'mainboard', lineNumber: 4 },
      { quantity: 10, section: 'mainboard', lineNumber: 5 },
      { quantity: 2, section: 'sideboard', lineNumber: 8 },
    ]);
  });

  it('permits spacing before partners and keeps explicit per-card commander and sideboard markers', () => {
    const result = structuredCards('Commander\n\n1 First Partner\n1 Second Partner\n\n2 Main Card\n1 Marked Commander (Commander)\nSB: 3 Side Card\n1 More Main');
    expect(result.cards.map(({ quantity, section }) => [quantity, section])).toEqual([
      [1, 'commander'], [1, 'commander'], [2, 'mainboard'],
      [1, 'commander'], [3, 'sideboard'], [1, 'mainboard'],
    ]);
    expect(result.unresolvedLines).toEqual([]);
  });

  it('keeps Commander deck groups in mainboard even when the command zone appears last', () => {
    for (const text of ['Commander\n1 Partner\n\n1 Sol Ring\n\n2 Island', '1 Sol Ring\n\n2 Island\nCommander\n1 Partner']) {
      const {cards,unresolvedLines} = structuredCards(text);
      expect(cards.filter(row => row.section === 'mainboard').map(row => row.name)).toEqual(['Sol Ring','Island']);
      expect(cards.filter(row => row.section === 'commander').map(row => row.name)).toEqual(['Partner']);
      expect(unresolvedLines).toEqual([]);
    }
  });

  it('recognizes both legacy blank-line sideboards and Archidekt comment-style headers', () => {
    expect(structuredCards('2 Island\n\n1 Negate').cards.map(row => row.section)).toEqual(['mainboard','sideboard']);
    const result = structuredCards('Commander\n1 Partner\n\n1 Sol Ring\n# Sideboard\n2 Negate\n# Notes\n1 Dispel');
    expect(result.cards.map(row => row.section)).toEqual(['commander','mainboard','sideboard','sideboard']);
    expect(result.unresolvedLines).toEqual([]);
  });
});
