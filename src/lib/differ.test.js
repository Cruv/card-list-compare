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
});
