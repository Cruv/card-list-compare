import { describe, it, expect } from 'vitest';
import { buildOwnedIndex, ownedCount, collectionCoverage, allocateOwnedCopies, lineKey } from './collectionMatch.js';
import { parse } from './parser.js';

const collection = [
  { card_name: 'Sol Ring', quantity: 1 },
  { card_name: 'Lightning Bolt', set_code: 'm10', collector_number: '146', quantity: 2, is_foil: 0 },
  { card_name: 'Lightning Bolt', set_code: 'lea', collector_number: '161', quantity: 1, is_foil: 1 }, // different printing, same name
  { card_name: 'Nazgûl', quantity: 4 }, // accented
  { card_name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', quantity: 1 }, // DFC full name
];

describe('buildOwnedIndex / ownedCount', () => {
  const index = buildOwnedIndex(collection);

  it('sums copies across printings and foils of the same name', () => {
    expect(ownedCount('Lightning Bolt', index)).toBe(3);
  });

  it('matches accent-insensitively', () => {
    expect(ownedCount('Nazgul', index)).toBe(4);
    expect(ownedCount('Nazgûl', index)).toBe(4);
  });

  it('matches a DFC by front-face name and by full name', () => {
    expect(ownedCount('Fable of the Mirror-Breaker', index)).toBe(1);
    expect(ownedCount('Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', index)).toBe(1);
  });

  it('returns 0 for unowned cards and with no index', () => {
    expect(ownedCount('Counterspell', index)).toBe(0);
    expect(ownedCount('Sol Ring', null)).toBe(0);
  });
});

describe('collectionCoverage', () => {
  it('reports unique and copy coverage, capping owned at needed', () => {
    const index = buildOwnedIndex(collection);
    const deck = parse('4 Lightning Bolt\n1 Sol Ring\n1 Counterspell');
    const cov = collectionCoverage(deck, index);
    expect(cov.uniqueTotal).toBe(3);
    expect(cov.uniqueOwned).toBe(2); // bolt + sol ring owned, counterspell not
    expect(cov.copiesNeeded).toBe(6); // 4 + 1 + 1
    expect(cov.copiesOwned).toBe(4); // 3 of 4 bolts + 1 sol ring, counterspell 0
  });

  it('allocates owned copies across lines instead of double-counting them', () => {
    // Own 2 Sol Rings; the deck lists 2 printings needing 3 total. The badges
    // must add up to 2, not show "2 owned" on both lines.
    const index = buildOwnedIndex([{ card_name: 'Sol Ring', quantity: 2 }]);
    const deck = parse('2 Sol Ring (c21) [263]\n1 Sol Ring (ltc) [284]');
    const alloc = allocateOwnedCopies(deck, index);
    const first = alloc.get(lineKey('Mainboard', 'Sol Ring', '263'));
    const second = alloc.get(lineKey('Mainboard', 'Sol Ring', '284'));
    expect(first + second).toBe(2);
    expect(first).toBe(2); // the earlier line consumes the copies
    expect(second).toBe(0); // nothing left for the later one
  });

  it('does not let a sideboard copy reuse a copy already spent in the mainboard', () => {
    const index = buildOwnedIndex([{ card_name: 'Sol Ring', quantity: 1 }]);
    const deck = parse('1 Sol Ring\n\nSideboard\n1 Sol Ring');
    const alloc = allocateOwnedCopies(deck, index);
    expect(alloc.get(lineKey('Mainboard', 'Sol Ring', ''))).toBe(1);
    expect(alloc.get(lineKey('Sideboard', 'Sol Ring', ''))).toBe(0);
  });

  it('returns an empty allocation when there is no collection', () => {
    expect(allocateOwnedCopies(parse('1 Sol Ring'), null).size).toBe(0);
  });

  it('counts a card appearing in both boards once', () => {
    const index = buildOwnedIndex([{ card_name: 'Sol Ring', quantity: 1 }]);
    const deck = parse('1 Sol Ring\n\nSideboard\n1 Sol Ring');
    const cov = collectionCoverage(deck, index);
    expect(cov.uniqueTotal).toBe(1);
    expect(cov.copiesNeeded).toBe(2);
    expect(cov.copiesOwned).toBe(1);
  });
});
