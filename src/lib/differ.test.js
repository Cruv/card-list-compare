import { describe, it, expect } from 'vitest';
import { computeDiff } from './differ.js';
import { parse } from './parser.js';

// Helper to build a parsed deck from simple text
function deck(text) {
  return parse(text);
}

// Helper to build a Map from entries like { "Lightning Bolt": 4 }
function buildMap(entries) {
  const m = new Map();
  for (const [name, qty] of Object.entries(entries)) {
    m.set(name.toLowerCase(), { displayName: name, quantity: qty, setCode: '', collectorNumber: '', isFoil: false });
  }
  return m;
}

// Helper to build a minimal parsed deck object from maps
function makeDeck(main = {}, side = {}, commanders = []) {
  return {
    mainboard: buildMap(main),
    sideboard: buildMap(side),
    commanders,
  };
}

describe('computeDiff()', () => {
  // ── No changes ───────────────────────────────────────────────────

  it('returns empty diff when both decks are identical', () => {
    const a = deck('4 Lightning Bolt\n2 Counterspell');
    const b = deck('4 Lightning Bolt\n2 Counterspell');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('returns empty diff when both decks are empty', () => {
    const a = deck('');
    const b = deck('');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  // ── Cards in ─────────────────────────────────────────────────────

  it('detects cards added to mainboard', () => {
    const a = deck('4 Lightning Bolt');
    const b = deck('4 Lightning Bolt\n2 Counterspell');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([
      expect.objectContaining({ name: 'Counterspell', quantity: 2 }),
    ]);
    expect(diff.mainboard.cardsOut).toEqual([]);
  });

  it('detects all cards as "in" when before is empty', () => {
    const a = deck('');
    const b = deck('4 Lightning Bolt\n2 Counterspell');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toHaveLength(2);
    expect(diff.mainboard.cardsIn.map(c => c.name).sort()).toEqual([
      'Counterspell',
      'Lightning Bolt',
    ]);
  });

  // ── Cards out ────────────────────────────────────────────────────

  it('detects cards removed from mainboard', () => {
    const a = deck('4 Lightning Bolt\n2 Counterspell');
    const b = deck('4 Lightning Bolt');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsOut).toEqual([
      expect.objectContaining({ name: 'Counterspell', quantity: 2 }),
    ]);
    expect(diff.mainboard.cardsIn).toEqual([]);
  });

  it('detects all cards as "out" when after is empty', () => {
    const a = deck('4 Lightning Bolt\n2 Counterspell');
    const b = deck('');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsOut).toHaveLength(2);
  });

  // ── Quantity changes ─────────────────────────────────────────────

  it('detects quantity increase', () => {
    const a = deck('2 Lightning Bolt');
    const b = deck('4 Lightning Bolt');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Lightning Bolt', oldQty: 2, newQty: 4, delta: 2 }),
    ]);
  });

  it('detects quantity decrease', () => {
    const a = deck('4 Lightning Bolt');
    const b = deck('2 Lightning Bolt');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Lightning Bolt', oldQty: 4, newQty: 2, delta: -2 }),
    ]);
  });

  // ── Sideboard ────────────────────────────────────────────────────

  it('detects sideboard changes', () => {
    const a = makeDeck(
      { 'Lightning Bolt': 4 },
      { 'Fatal Push': 3 }
    );
    const b = makeDeck(
      { 'Lightning Bolt': 4 },
      { 'Fatal Push': 2, 'Negate': 1 }
    );
    const diff = computeDiff(a, b);

    expect(diff.sideboard.cardsIn).toEqual([
      expect.objectContaining({ name: 'Negate', quantity: 1 }),
    ]);
    expect(diff.sideboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Fatal Push', oldQty: 3, newQty: 2, delta: -1 }),
    ]);
  });

  it('sets hasSideboard=true when before has sideboard', () => {
    const a = makeDeck({}, { 'Fatal Push': 2 });
    const b = makeDeck({}, {});
    const diff = computeDiff(a, b);
    expect(diff.hasSideboard).toBe(true);
  });

  it('sets hasSideboard=true when after has sideboard', () => {
    const a = makeDeck({}, {});
    const b = makeDeck({}, { 'Fatal Push': 2 });
    const diff = computeDiff(a, b);
    expect(diff.hasSideboard).toBe(true);
  });

  it('sets hasSideboard=false when neither has sideboard', () => {
    const a = makeDeck({ 'Lightning Bolt': 4 });
    const b = makeDeck({ 'Lightning Bolt': 4 });
    const diff = computeDiff(a, b);
    expect(diff.hasSideboard).toBe(false);
  });

  // ── Commanders ───────────────────────────────────────────────────

  it('passes through commanders from "after" deck', () => {
    const a = makeDeck({}, {}, ['Atraxa']);
    const b = makeDeck({}, {}, ['Kenrith']);
    const diff = computeDiff(a, b);
    expect(diff.commanders).toEqual(['Kenrith']);
  });

  it('uses empty array when after has no commanders', () => {
    const a = makeDeck({}, {}, ['Atraxa']);
    const b = makeDeck({});
    const diff = computeDiff(a, b);
    expect(diff.commanders).toEqual([]);
  });

  // ── Sorting ──────────────────────────────────────────────────────

  it('sorts cardsIn alphabetically by name', () => {
    const a = deck('');
    const b = deck('4 Zenith\n2 Alpha\n3 Mountain');
    const diff = computeDiff(a, b);
    const names = diff.mainboard.cardsIn.map(c => c.name);
    expect(names).toEqual(['Alpha', 'Mountain', 'Zenith']);
  });

  it('sorts cardsOut alphabetically by name', () => {
    const a = deck('4 Zenith\n2 Alpha\n3 Mountain');
    const b = deck('');
    const diff = computeDiff(a, b);
    const names = diff.mainboard.cardsOut.map(c => c.name);
    expect(names).toEqual(['Alpha', 'Mountain', 'Zenith']);
  });

  it('sorts quantityChanges alphabetically by name', () => {
    const a = deck('4 Zenith\n2 Alpha\n3 Mountain');
    const b = deck('3 Zenith\n1 Alpha\n4 Mountain');
    const diff = computeDiff(a, b);
    const names = diff.mainboard.quantityChanges.map(c => c.name);
    expect(names).toEqual(['Alpha', 'Mountain', 'Zenith']);
  });

  // ── Complex mixed changes ────────────────────────────────────────

  it('handles mixed adds, removes, and quantity changes', () => {
    const a = deck(`4 Lightning Bolt
2 Counterspell
3 Sol Ring
1 Swords to Plowshares`);

    const b = deck(`4 Lightning Bolt
3 Counterspell
1 Fatal Push
1 Swords to Plowshares`);

    const diff = computeDiff(a, b);

    // Sol Ring removed
    expect(diff.mainboard.cardsOut).toEqual([
      expect.objectContaining({ name: 'Sol Ring', quantity: 3 }),
    ]);

    // Fatal Push added
    expect(diff.mainboard.cardsIn).toEqual([
      expect.objectContaining({ name: 'Fatal Push', quantity: 1 }),
    ]);

    // Counterspell 2 → 3
    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Counterspell', oldQty: 2, newQty: 3, delta: 1 }),
    ]);
  });

  // ── Integration: parse → diff pipeline ───────────────────────────

  it('end-to-end: sideboard via explicit header', () => {
    const beforeText = `4 Lightning Bolt
2 Counterspell

Sideboard
3 Fatal Push`;

    const afterText = `4 Lightning Bolt
3 Counterspell

Sideboard
2 Fatal Push
1 Negate`;

    const a = parse(beforeText);
    const b = parse(afterText);
    const diff = computeDiff(a, b);

    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Counterspell', oldQty: 2, newQty: 3, delta: 1 }),
    ]);

    expect(diff.sideboard.cardsIn).toEqual([
      expect.objectContaining({ name: 'Negate', quantity: 1 }),
    ]);

    expect(diff.sideboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Fatal Push', oldQty: 3, newQty: 2, delta: -1 }),
    ]);

    expect(diff.hasSideboard).toBe(true);
  });

  it('end-to-end: commander change', () => {
    const beforeText = `Commander
1 Atraxa, Praetors' Voice

4 Sol Ring`;

    const afterText = `Commander
1 Kenrith, the Returned King

4 Sol Ring
2 Lightning Bolt`;

    const a = parse(beforeText);
    const b = parse(afterText);
    const diff = computeDiff(a, b);

    expect(diff.commanders).toEqual(['Kenrith, the Returned King']);
    expect(diff.mainboard.cardsIn.map(c => c.name)).toContain('Kenrith, the Returned King');
    expect(diff.mainboard.cardsIn.map(c => c.name)).toContain('Lightning Bolt');
    expect(diff.mainboard.cardsOut.map(c => c.name)).toContain("Atraxa, Praetors' Voice");
  });

  // ── Case insensitivity ───────────────────────────────────────────

  it('treats card names case-insensitively when diffing', () => {
    const a = deck('4 lightning bolt');
    const b = deck('4 Lightning Bolt');
    const diff = computeDiff(a, b);
    // Same card, just different casing — no changes
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  // ── Bare vs composite key matching ─────────────────────────────

  it('matches bare name (no set) against same card with set and collector number', () => {
    const a = deck('1 Lightning Bolt');
    const b = deck('1 Lightning Bolt (m10) [227]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('detects quantity change when before has bare name and after has metadata', () => {
    const a = deck('2 Lightning Bolt');
    const b = deck('4 Lightning Bolt (m10) [227]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Lightning Bolt', oldQty: 2, newQty: 4, delta: 2 }),
    ]);
  });

  it('matches bare name against metadata in the reverse direction', () => {
    const a = deck('1 Lightning Bolt (m10) [227]');
    const b = deck('1 Lightning Bolt');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('keeps distinct printings separate when both sides have collector numbers', () => {
    const a = deck('1 Nazgul (ltr) [551]\n1 Nazgul (ltr) [729]');
    const b = deck('1 Nazgul (ltr) [551]\n2 Nazgul (ltr) [729]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Nazgul', oldQty: 1, newQty: 2, delta: 1 }),
    ]);
  });

  // ── Multi-printing collapse (Nazgul) ──────────────────────────

  it('collapses multiple composite keys to match bare key with same total', () => {
    const a = deck('9 Nazgul');
    const b = deck(
      '1 Nazgul (ltr) [100]\n1 Nazgul (ltr) [101]\n1 Nazgul (ltr) [102]\n' +
      '1 Nazgul (ltr) [103]\n1 Nazgul (ltr) [104]\n1 Nazgul (ltr) [105]\n' +
      '1 Nazgul (ltr) [106]\n1 Nazgul (ltr) [107]\n1 Nazgul (ltr) [108]'
    );
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('detects quantity change when bare total differs from collapsed composites', () => {
    const a = deck('7 Nazgul');
    const b = deck(
      '1 Nazgul (ltr) [100]\n1 Nazgul (ltr) [101]\n1 Nazgul (ltr) [102]\n' +
      '1 Nazgul (ltr) [103]\n1 Nazgul (ltr) [104]\n1 Nazgul (ltr) [105]\n' +
      '1 Nazgul (ltr) [106]\n1 Nazgul (ltr) [107]\n1 Nazgul (ltr) [108]'
    );
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ name: 'Nazgul', oldQty: 7, newQty: 9, delta: 2 }),
    ]);
  });

  it('collapses composite keys in before when after has bare key', () => {
    const a = deck(
      '1 Nazgul (ltr) [100]\n1 Nazgul (ltr) [101]\n1 Nazgul (ltr) [102]'
    );
    const b = deck('3 Nazgul');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  // ── Double-faced card name matching ────────────────────────────

  it('matches DFC full name against front face only', () => {
    const a = deck('1 Sheoldred // The True Scriptures');
    const b = deck('1 Sheoldred');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('matches front face only against DFC full name', () => {
    const a = deck('1 Sheoldred');
    const b = deck('1 Sheoldred // The True Scriptures');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('detects quantity change between DFC full name and front face', () => {
    const a = deck('1 Sheoldred // The True Scriptures');
    const b = deck('2 Sheoldred');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toHaveLength(1);
    expect(diff.mainboard.quantityChanges[0]).toMatchObject({ oldQty: 1, newQty: 2, delta: 1 });
  });

  it('matches DFC with collector number against front face only', () => {
    const a = deck('1 Sheoldred // The True Scriptures (one) [123]');
    const b = deck('1 Sheoldred');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('matches front face only against DFC with collector number', () => {
    const a = deck('1 Sheoldred');
    const b = deck('1 Sheoldred // The True Scriptures (one) [123]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('matches DFC with collector number against front face with collector number', () => {
    const a = deck('1 Sheoldred // The True Scriptures (one) [123]');
    const b = deck('1 Sheoldred (one) [123]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  // ── Alphanumeric collector numbers (promos) ─────────────────────

  it('matches promo printing with alphanumeric collector number against bare name', () => {
    const a = deck('1 Dragon Tempest (pdtk) [136p]\n1 Sol Ring (ltc) [284]');
    const b = deck('1 Dragon Tempest\n1 Sol Ring');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('matches bare name against promo printing with alphanumeric collector number', () => {
    const a = deck('1 Dragon Tempest\n1 Mother of Runes');
    const b = deck('1 Dragon Tempest (pdtk) [136p]\n1 Mother of Runes (plst) [DDO-20]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('matches multiple promo printings against bare names', () => {
    const a = deck('1 Dragon Tempest (pdtk) [136p]\n1 Sephara, Sky\'s Blade (pm20) [36p]\n1 Nykthos, Shrine to Nyx (ppro) [2022-3]');
    const b = deck('1 Dragon Tempest\n1 Sephara, Sky\'s Blade\n1 Nykthos, Shrine to Nyx');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
  });

  // ── Printing changes ─────────────────────────────────────────────

  it('detects printing change when same card swaps collector number', () => {
    const a = deck('1 Terror of the Peaks (otj) [149]');
    const b = deck('1 Terror of the Peaks (m21) [164]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.printingChanges).toHaveLength(1);
    expect(diff.mainboard.printingChanges[0]).toMatchObject({
      name: 'Terror of the Peaks',
      quantity: 1,
      oldSetCode: 'otj',
      oldCollectorNumber: '149',
      newSetCode: 'm21',
      newCollectorNumber: '164',
    });
  });

  it('detects printing change when switching to different set', () => {
    const a = deck('1 Sol Ring (c21) [263]');
    const b = deck('1 Sol Ring (cmr) [252]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.printingChanges).toHaveLength(1);
    expect(diff.mainboard.printingChanges[0]).toMatchObject({
      name: 'Sol Ring',
      quantity: 1,
      oldSetCode: 'c21',
      oldCollectorNumber: '263',
      newSetCode: 'cmr',
      newCollectorNumber: '252',
    });
  });

  it('does not treat different quantities as printing change', () => {
    const a = deck('2 Lightning Bolt (m10) [227]');
    const b = deck('1 Lightning Bolt (m11) [149]');
    const diff = computeDiff(a, b);
    // Different quantities — should stay as cardsIn/cardsOut, not printing change
    expect(diff.mainboard.printingChanges).toEqual([]);
    expect(diff.mainboard.cardsOut).toHaveLength(1);
    expect(diff.mainboard.cardsIn).toHaveLength(1);
  });

  it('handles multiple printing changes in same diff', () => {
    const a = deck('1 Terror of the Peaks (otj) [149]\n1 Sol Ring (c21) [263]');
    const b = deck('1 Terror of the Peaks (m21) [164]\n1 Sol Ring (cmr) [252]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.printingChanges).toHaveLength(2);
    const names = diff.mainboard.printingChanges.map(c => c.name).sort();
    expect(names).toEqual(['Sol Ring', 'Terror of the Peaks']);
  });

  it('keeps genuine adds/removes separate from printing changes', () => {
    const a = deck('1 Terror of the Peaks (otj) [149]\n1 Counterspell');
    const b = deck('1 Terror of the Peaks (m21) [164]\n1 Lightning Bolt');
    const diff = computeDiff(a, b);
    // Terror swaps printing, Counterspell removed, Lightning Bolt added
    expect(diff.mainboard.printingChanges).toHaveLength(1);
    expect(diff.mainboard.printingChanges[0].name).toBe('Terror of the Peaks');
    expect(diff.mainboard.cardsOut).toEqual([
      expect.objectContaining({ name: 'Counterspell', quantity: 1 }),
    ]);
    expect(diff.mainboard.cardsIn).toEqual([
      expect.objectContaining({ name: 'Lightning Bolt', quantity: 1 }),
    ]);
  });

  it('returns empty printingChanges when no printing swaps exist', () => {
    const a = deck('4 Lightning Bolt');
    const b = deck('4 Lightning Bolt\n2 Counterspell');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.printingChanges).toEqual([]);
  });

  // ── Mixed bare + composite keys on one side (audit H5) ─────────────

  it('does not fabricate in/out rows when a side mixes bare and composite keys', () => {
    // before: 2 bare + 1 printing-tagged = 3 total; after: 3 bare = 3 total → no change
    const a = deck('2 Nazgul\n1 Nazgul (ltr) [100]');
    const b = deck('3 Nazgul');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toEqual([]);
  });

  it('still detects a printing swap when BOTH sides mix bare and composite keys', () => {
    // One copy re-sleeved into a different printing. Collapsing both sides to a
    // bare key would make this look like "no changes" at all.
    const a = deck('1 Sol Ring\n1 Sol Ring (c21) [263]');
    const b = deck('1 Sol Ring\n1 Sol Ring (ltc) [284]');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.printingChanges).toHaveLength(1);
    expect(diff.mainboard.printingChanges[0]).toMatchObject({
      name: 'Sol Ring',
      oldCollectorNumber: '263',
      newCollectorNumber: '284',
    });
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
  });

  it('reports totals without inventing aggregate artwork for a mixed side', () => {
    const a = deck('1 Sol Ring (c21) [263]\n1 Sol Ring');
    const b = deck('3 Sol Ring');
    const diff = computeDiff(a, b);
    expect(diff.mainboard.quantityChanges).toHaveLength(1);
    expect(diff.mainboard.quantityChanges[0]).toMatchObject({ oldQty: 2, newQty: 3, setCode: '', collectorNumber: '' });
  });

  it('reports only the true net change across mixed bare/composite keys', () => {
    const a = deck('3 Nazgul');
    const b = deck('2 Nazgul\n2 Nazgul (ltr) [100]'); // 4 total
    const diff = computeDiff(a, b);
    expect(diff.mainboard.cardsIn).toEqual([]);
    expect(diff.mainboard.cardsOut).toEqual([]);
    expect(diff.mainboard.quantityChanges).toHaveLength(1);
    expect(diff.mainboard.quantityChanges[0]).toMatchObject({ oldQty: 3, newQty: 4 });
  });
});

describe('complete printing identities and DFC aliases', () => {
  it.each([
    ['2 Nazgul', '2 Nazgûl'],
    ['2 Nazgul', '2 Nazgûl (ltr) [100]'],
    ['2 Nazgul (ltr) [100]', '2 Nazgûl'],
    ['2 Nazgul (ltr) [100]', '2 Nazgûl (ltr) [100]'],
  ])('matches accent aliases without phantom changes: %s / %s', (before, after) => {
    const result = computeDiff(deck(before), deck(after)).mainboard;
    expect(result.cardsIn).toEqual([]);
    expect(result.cardsOut).toEqual([]);
    expect(result.quantityChanges).toEqual([]);
    expect(result.printingChanges).toEqual([]);
    expect(result.totalUniqueCards).toBe(1);
    expect(result.unchangedCount).toBe(1);
  });

  it('sums accent aliases during comparison without changing parsed artwork identities', () => {
    const before = deck('1 Nazgul (ltr) [100]\n2 Nazgûl (ltr) [100]');
    const result = computeDiff(before, deck('4 Nazgûl (ltr) [100]')).mainboard;
    expect(result.cardsIn).toEqual([]);
    expect(result.cardsOut).toEqual([]);
    expect(result.quantityChanges).toEqual([expect.objectContaining({ oldQty: 3, newQty: 4, delta: 1 })]);
    expect([...before.mainboard.keys()]).toEqual(['nazgul|ltr|100|nonfoil', 'nazgûl|ltr|100|nonfoil']);
    expect([...before.mainboard.values()].map(entry => entry.quantity)).toEqual([1, 2]);
  });

  it('counts unique card names and unchanged names across multiple printings', () => {
    const before = deck('1 Sol Ring (c21) [263]\n1 Sol Ring (ltc) [263]\n1 Island');
    const after = deck('1 Sol Ring (c21) [263]\n1 Sol Ring (ltc) [263] *F*\n1 Island');
    const result = computeDiff(before, after).mainboard;
    expect(result.totalUniqueCards).toBe(2);
    expect(result.unchangedCount).toBe(1);
  });

  it('detects a set change even when the collector number stays the same', () => {
    const result = computeDiff(deck('1 Sol Ring (c21) [263]'), deck('1 Sol Ring (ltc) [263]')).mainboard;
    expect(result.printingChanges).toEqual([
      expect.objectContaining({ name: 'Sol Ring', oldSetCode: 'c21', newSetCode: 'ltc', quantity: 1 }),
    ]);
  });

  it('detects foil changes for the same set and collector number', () => {
    const result = computeDiff(deck('1 Sol Ring (c21) [263]'), deck('1 Sol Ring (c21) [263] *F*')).mainboard;
    expect(result.printingChanges).toEqual([
      expect.objectContaining({ oldIsFoil: false, newIsFoil: true, quantity: 1 }),
    ]);
  });

  it.each([false, true])('matches bare full DFC to a qualified front face (reverse=%s)', reverse => {
    const decks = [deck('2 Sheoldred // The True Scriptures'), deck('2 Sheoldred (mom) [125]')];
    const result = computeDiff(...(reverse ? decks.reverse() : decks)).mainboard;
    expect(result.cardsIn).toEqual([]);
    expect(result.cardsOut).toEqual([]);
    expect(result.quantityChanges).toEqual([]);
    expect(result.printingChanges).toEqual([]);
  });

  it('aggregates DFC aliases without dropping quantities or mutating inputs', () => {
    const before = deck('2 Sheoldred // The True Scriptures (mom) [125]\n3 Sheoldred (mom) [125]');
    const after = deck('4 Sheoldred (mom) [125]');
    const result = computeDiff(before, after).mainboard;
    expect(result.cardsIn).toEqual([]);
    expect(result.cardsOut).toEqual([]);
    expect(result.quantityChanges).toEqual([expect.objectContaining({ oldQty: 5, newQty: 4, delta: -1 })]);
    expect([...before.mainboard.values()].map(entry => entry.quantity)).toEqual([2, 3]);
  });

  it('detects DFC printing swaps when full-name spelling changes too', () => {
    const result = computeDiff(deck('1 Sheoldred // The True Scriptures (mom) [125]'), deck('1 Sheoldred (mom) [435]')).mainboard;
    expect(result.printingChanges).toHaveLength(1);
    expect(result.cardsIn).toEqual([]);
    expect(result.cardsOut).toEqual([]);
  });

  it('reports quantity changes independently for same-number printings in different sets', () => {
    const before = deck('2 Sol Ring (c21) [263]\n3 Sol Ring (ltc) [263]');
    const after = deck('1 Sol Ring (c21) [263]\n4 Sol Ring (ltc) [263]');
    const result = computeDiff(before, after).mainboard;
    expect(result.quantityChanges).toEqual([
      expect.objectContaining({ setCode: 'c21', oldQty: 2, newQty: 1, delta: -1 }),
      expect.objectContaining({ setCode: 'ltc', oldQty: 3, newQty: 4, delta: 1 }),
    ]);
  });
});

describe('printing metadata carried into bare imports', () => {
  it('keeps the finish with the set/collector when a bare quantity changes', () => {
    const result = computeDiff(parse('1 Lightning Bolt (m10) [146] *F*'), parse('2 Lightning Bolt'));
    expect(result.mainboard.quantityChanges).toEqual([
      expect.objectContaining({ oldQty: 1, newQty: 2, setCode: 'm10', collectorNumber: '146', isFoil: true }),
    ]);
  });
});
