import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';

// Helper: convert a Map to a plain object keyed by lowercase card name
function mapToObj(map) {
  const obj = {};
  for (const [key, val] of map) {
    obj[key] = { displayName: val.displayName, quantity: val.quantity };
  }
  return obj;
}

describe('parse()', () => {
  // ── Empty / blank input ──────────────────────────────────────────

  it('returns empty deck for empty string', () => {
    const result = parse('');
    expect(result.mainboard.size).toBe(0);
    expect(result.sideboard.size).toBe(0);
    expect(result.commanders).toEqual([]);
  });

  it('returns empty deck for whitespace-only input', () => {
    const result = parse('   \n\n  \t  ');
    expect(result.mainboard.size).toBe(0);
    expect(result.sideboard.size).toBe(0);
  });

  it('returns empty deck for null/undefined', () => {
    expect(parse(null).mainboard.size).toBe(0);
    expect(parse(undefined).mainboard.size).toBe(0);
  });

  // ── Simple "qty name" format ─────────────────────────────────────

  it('parses "4 Lightning Bolt"', () => {
    const result = parse('4 Lightning Bolt');
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt']).toEqual({ displayName: 'Lightning Bolt', quantity: 4 });
  });

  it('parses "4x Lightning Bolt" (x separator)', () => {
    const result = parse('4x Lightning Bolt');
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  it('parses "4X Lightning Bolt" (uppercase X)', () => {
    const result = parse('4X Lightning Bolt');
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  it('parses a bare card name with implicit quantity 1', () => {
    const result = parse('Lightning Bolt');
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(1);
  });

  it('ignores bare numbers', () => {
    const result = parse('42');
    expect(result.mainboard.size).toBe(0);
  });

  // ── Arena/MTGO format with set code + collector number ───────────

  it('parses Arena format "4 Lightning Bolt (M10) 123" with bare collector number', () => {
    const result = parse('4 Lightning Bolt (M10) 123');
    // Arena bare collector numbers are now captured as metadata
    const entry = result.mainboard.get('lightning bolt|123');
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe('Lightning Bolt');
    expect(entry.quantity).toBe(4);
    expect(entry.setCode).toBe('M10');
    expect(entry.collectorNumber).toBe('123');
  });

  it('parses Arena format with just set code "2 Counterspell (MH2)"', () => {
    const result = parse('2 Counterspell (MH2)');
    const main = mapToObj(result.mainboard);
    expect(main['counterspell'].quantity).toBe(2);
  });

  // ── Alphanumeric collector numbers (promos, special printings) ───

  it('parses bracketed alphanumeric collector number "1 Dragon Tempest (pdtk) [136p]"', () => {
    const result = parse('1 Dragon Tempest (pdtk) [136p]');
    const entry = result.mainboard.get('dragon tempest|136p');
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe('Dragon Tempest');
    expect(entry.setCode).toBe('pdtk');
    expect(entry.collectorNumber).toBe('136p');
  });

  it('parses collector number with hyphen "1 Mother of Runes (plst) [DDO-20]"', () => {
    const result = parse('1 Mother of Runes (plst) [DDO-20]');
    const entry = result.mainboard.get('mother of runes|DDO-20');
    expect(entry).toBeDefined();
    expect(entry.setCode).toBe('plst');
    expect(entry.collectorNumber).toBe('DDO-20');
  });

  it('parses year-style collector number "1 Nykthos, Shrine to Nyx (ppro) [2022-3]"', () => {
    const result = parse('1 Nykthos, Shrine to Nyx (ppro) [2022-3]');
    const entry = result.mainboard.get('nykthos, shrine to nyx|2022-3');
    expect(entry).toBeDefined();
    expect(entry.setCode).toBe('ppro');
    expect(entry.collectorNumber).toBe('2022-3');
  });

  it('parses bare alphanumeric collector number after set code "1x Dragon Tempest (pdtk) 136p"', () => {
    const result = parse('1x Dragon Tempest (pdtk) 136p');
    const entry = result.mainboard.get('dragon tempest|136p');
    expect(entry).toBeDefined();
    expect(entry.setCode).toBe('pdtk');
    expect(entry.collectorNumber).toBe('136p');
  });

  // ── CSV format ───────────────────────────────────────────────────

  it('parses CSV with quantity,name header', () => {
    const csv = `quantity,name
4,Lightning Bolt
2,Counterspell
1,Sol Ring`;
    const result = parse(csv);
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
    expect(main['counterspell'].quantity).toBe(2);
    expect(main['sol ring'].quantity).toBe(1);
  });

  it('parses CSV with card,count header', () => {
    const csv = `card,count
Lightning Bolt,4
Counterspell,2`;
    const result = parse(csv);
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  it('parses CSV with section/board column', () => {
    const csv = `name,quantity,section
Lightning Bolt,4,mainboard
Fatal Push,2,sideboard`;
    const result = parse(csv);
    const main = mapToObj(result.mainboard);
    const side = mapToObj(result.sideboard);
    expect(main['lightning bolt'].quantity).toBe(4);
    expect(side['fatal push'].quantity).toBe(2);
  });

  it('parses CSV with "sb" section value', () => {
    const csv = `name,quantity,board
Lightning Bolt,4,main
Fatal Push,2,sb`;
    const result = parse(csv);
    expect(mapToObj(result.sideboard)['fatal push'].quantity).toBe(2);
  });

  it('returns null for CSV without name column', () => {
    const csv = `quantity,foo
4,bar`;
    // Falls through to text parsing
    const result = parse(csv);
    // Should still parse something (falls back to text parsing)
    expect(result).toBeDefined();
  });

  it('handles CSV with quoted values', () => {
    const csv = `quantity,name
4,"Lightning Bolt"
2,"Sol Ring"`;
    const result = parse(csv);
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  it('aggregates duplicate card names in CSV', () => {
    const csv = `name,quantity
Lightning Bolt,2
Lightning Bolt,2`;
    const result = parse(csv);
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  // ── Comment lines ────────────────────────────────────────────────

  it('ignores // comment lines', () => {
    const text = `// This is a comment
4 Lightning Bolt
// Another comment
2 Counterspell`;
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    expect(Object.keys(main)).toHaveLength(2);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  it('ignores # comment lines', () => {
    const text = `# Header
4 Lightning Bolt`;
    const result = parse(text);
    expect(result.mainboard.size).toBe(1);
  });

  // ── Sideboard detection ──────────────────────────────────────────

  it('splits sideboard via "Sideboard" header', () => {
    const text = `4 Lightning Bolt
2 Counterspell

Sideboard
3 Fatal Push
1 Negate`;
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    const side = mapToObj(result.sideboard);
    expect(main['lightning bolt'].quantity).toBe(4);
    expect(side['fatal push'].quantity).toBe(3);
    expect(side['negate'].quantity).toBe(1);
  });

  it('splits sideboard via "Sideboard:" header (with colon)', () => {
    const text = `4 Lightning Bolt
Sideboard:
3 Fatal Push`;
    const result = parse(text);
    expect(mapToObj(result.sideboard)['fatal push'].quantity).toBe(3);
  });

  it('splits sideboard via "SB" header', () => {
    const text = `4 Lightning Bolt
SB
3 Fatal Push`;
    const result = parse(text);
    expect(mapToObj(result.sideboard)['fatal push'].quantity).toBe(3);
  });

  it('splits sideboard via blank line (implicit)', () => {
    const text = `4 Lightning Bolt
2 Counterspell

3 Fatal Push
1 Negate`;
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    const side = mapToObj(result.sideboard);
    expect(Object.keys(main)).toHaveLength(2);
    expect(Object.keys(side)).toHaveLength(2);
  });

  it('handles SB: prefix on individual lines', () => {
    const text = `4 Lightning Bolt
SB: 3 Fatal Push
2 Counterspell`;
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    const side = mapToObj(result.sideboard);
    expect(main['lightning bolt'].quantity).toBe(4);
    expect(main['counterspell'].quantity).toBe(2);
    expect(side['fatal push'].quantity).toBe(3);
  });

  // ── Mainboard header ────────────────────────────────────────────

  it('handles "Mainboard" header', () => {
    const text = `Mainboard
4 Lightning Bolt
Sideboard
3 Fatal Push`;
    const result = parse(text);
    expect(mapToObj(result.mainboard)['lightning bolt'].quantity).toBe(4);
    expect(mapToObj(result.sideboard)['fatal push'].quantity).toBe(3);
  });

  it('handles "Deck" header as mainboard', () => {
    const text = `Deck
4 Lightning Bolt`;
    const result = parse(text);
    expect(mapToObj(result.mainboard)['lightning bolt'].quantity).toBe(4);
  });

  // ── Commander detection ──────────────────────────────────────────

  it('detects commanders from "Commander" section header', () => {
    const text = `Commander
1 Atraxa, Praetors' Voice

4 Lightning Bolt
2 Counterspell`;
    const result = parse(text);
    expect(result.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    // Commander cards also appear in mainboard
    const main = mapToObj(result.mainboard);
    expect(main["atraxa, praetors' voice"].quantity).toBe(1);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  it('detects commanders from "Command Zone" header', () => {
    const text = `Command Zone
1 Kenrith, the Returned King

Deck
4 Sol Ring`;
    const result = parse(text);
    expect(result.commanders).toContain('Kenrith, the Returned King');
  });

  it('detects partner commanders', () => {
    const text = `Commander
1 Thrasios, Triton Hero
1 Vial Smasher the Fierce

4 Lightning Bolt`;
    const result = parse(text);
    expect(result.commanders).toHaveLength(2);
    expect(result.commanders).toContain('Thrasios, Triton Hero');
    expect(result.commanders).toContain('Vial Smasher the Fierce');
  });

  it('detects inline (Commander) tag (Deckcheck format)', () => {
    const text = `1 Atraxa, Praetors' Voice (Commander)
4 Lightning Bolt
2 Counterspell`;
    const result = parse(text);
    expect(result.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    const main = mapToObj(result.mainboard);
    expect(main["atraxa, praetors' voice"].quantity).toBe(1);
  });

  it('prefers section-header commanders over inline tags', () => {
    const text = `Commander
1 Kenrith, the Returned King

1 Some Card (Commander)
4 Lightning Bolt`;
    const result = parse(text);
    // Section header takes precedence, inline commander not added
    expect(result.commanders).toEqual(['Kenrith, the Returned King']);
  });

  // ── Name normalization ───────────────────────────────────────────

  it('normalizes fancy apostrophes', () => {
    const result = parse('1 Atraxa, Praetors\u2019 Voice');
    const main = mapToObj(result.mainboard);
    expect(main["atraxa, praetors' voice"]).toBeDefined();
  });

  it('normalizes extra whitespace', () => {
    const result = parse('4  Lightning   Bolt');
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].displayName).toBe('Lightning Bolt');
  });

  // ── Duplicate aggregation ────────────────────────────────────────

  it('aggregates duplicate card entries', () => {
    const text = `2 Lightning Bolt
2 Lightning Bolt`;
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
  });

  // ── Multi-section full deck ──────────────────────────────────────

  it('parses a full EDH deck with commander, mainboard, sideboard', () => {
    const text = `Commander
1 Atraxa, Praetors' Voice

Deck
4 Sol Ring
4 Lightning Bolt
2 Counterspell

Sideboard
3 Fatal Push
1 Negate`;
    const result = parse(text);
    expect(result.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    const main = mapToObj(result.mainboard);
    const side = mapToObj(result.sideboard);
    expect(Object.keys(main)).toHaveLength(4); // Atraxa + 3 cards
    expect(Object.keys(side)).toHaveLength(2);
  });

  // ── Windows line endings ─────────────────────────────────────────

  it('handles Windows \\r\\n line endings', () => {
    const text = '4 Lightning Bolt\r\n2 Counterspell\r\n\r\n3 Fatal Push';
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    const side = mapToObj(result.sideboard);
    expect(main['lightning bolt'].quantity).toBe(4);
    expect(side['fatal push'].quantity).toBe(3);
  });

  // ── Mixed formats ────────────────────────────────────────────────

  it('handles mixed quantity formats in same list', () => {
    const text = `4 Lightning Bolt
2x Counterspell
Sol Ring
3 Fatal Push (MH2) 45`;
    const result = parse(text);
    expect(result.mainboard.get('lightning bolt').quantity).toBe(4);
    expect(result.mainboard.get('counterspell').quantity).toBe(2);
    expect(result.mainboard.get('sol ring').quantity).toBe(1);
    // Fatal Push with bare collector number gets composite key
    const fatalPush = result.mainboard.get('fatal push|45');
    expect(fatalPush).toBeDefined();
    expect(fatalPush.quantity).toBe(3);
    expect(fatalPush.setCode).toBe('MH2');
    expect(fatalPush.collectorNumber).toBe('45');
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it('handles trailing/leading whitespace on lines', () => {
    const text = `  4 Lightning Bolt
  2 Counterspell  `;
    const result = parse(text);
    expect(result.mainboard.size).toBe(2);
  });

  it('handles single-card deck', () => {
    const result = parse('1 Sol Ring');
    expect(result.mainboard.size).toBe(1);
  });

  it('SB: prefix in sideboard section merges to sideboard', () => {
    const text = `4 Lightning Bolt

SB: 2 Fatal Push
3 Negate`;
    const result = parse(text);
    const side = mapToObj(result.sideboard);
    expect(side['fatal push'].quantity).toBe(2);
    expect(side['negate'].quantity).toBe(3);
  });

  it('maps are case-insensitive but preserve display name', () => {
    const text = `2 lightning bolt
2 Lightning Bolt`;
    const result = parse(text);
    const main = mapToObj(result.mainboard);
    expect(main['lightning bolt'].quantity).toBe(4);
    // Display name should be from one of the entries
    expect(main['lightning bolt'].displayName).toBeDefined();
  });
});
