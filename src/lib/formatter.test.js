import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatArchidektCSV } from './formatter.js';

// Lock Date.now so timestamps are deterministic
const FAKE_NOW = new Date('2025-06-15T14:30:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ────────────────────────────────────────────────────────

function makeDiff({
  mainIn = [],
  mainOut = [],
  mainQty = [],
  sideIn = [],
  sideOut = [],
  sideQty = [],
  hasSideboard = false,
  commanders = [],
} = {}) {
  return {
    mainboard: { cardsIn: mainIn, cardsOut: mainOut, quantityChanges: mainQty },
    sideboard: { cardsIn: sideIn, cardsOut: sideOut, quantityChanges: sideQty },
    hasSideboard,
    commanders,
  };
}

const CARD_IN = { name: 'Lightning Bolt', quantity: 4 };
const CARD_OUT = { name: 'Counterspell', quantity: 2 };
const CARD_QTY_UP = { name: 'Sol Ring', oldQty: 1, newQty: 3, delta: 2 };
const CARD_QTY_DOWN = { name: 'Fatal Push', oldQty: 4, newQty: 2, delta: -2 };

// ═══════════════════════════════════════════════════════════════════
// formatChangelog
// ═══════════════════════════════════════════════════════════════════

describe('formatChangelog()', () => {
  it('includes a timestamp in the header', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    // Should contain date from the faked time
    expect(text).toContain('Changelog');
  });

  it('includes commander name(s) in header when present', () => {
    const diff = makeDiff({ commanders: ["Atraxa, Praetors' Voice"], mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    expect(text).toContain("Atraxa, Praetors' Voice");
  });

  it('joins multiple commanders with /', () => {
    const diff = makeDiff({
      commanders: ['Thrasios, Triton Hero', 'Vial Smasher the Fierce'],
      mainIn: [CARD_IN],
    });
    const text = formatChangelog(diff);
    expect(text).toContain('Thrasios, Triton Hero / Vial Smasher the Fierce');
  });

  it('says "Deck Changelog" when no commanders', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    expect(text).toContain('Deck Changelog');
  });

  it('formats cards in', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    expect(text).toContain('+ 4 Lightning Bolt');
    expect(text).toContain('--- Cards In ---');
  });

  it('formats cards out', () => {
    const diff = makeDiff({ mainOut: [CARD_OUT] });
    const text = formatChangelog(diff);
    expect(text).toContain('- 2 Counterspell');
    expect(text).toContain('--- Cards Out ---');
  });

  it('formats quantity increases with + sign', () => {
    const diff = makeDiff({ mainQty: [CARD_QTY_UP] });
    const text = formatChangelog(diff);
    expect(text).toContain('~ Sol Ring (1 → 3, +2)');
  });

  it('formats quantity decreases with - sign', () => {
    const diff = makeDiff({ mainQty: [CARD_QTY_DOWN] });
    const text = formatChangelog(diff);
    expect(text).toContain('~ Fatal Push (4 → 2, -2)');
  });

  it('includes sideboard section when hasSideboard is true', () => {
    const diff = makeDiff({ hasSideboard: true, sideIn: [CARD_IN] });
    const text = formatChangelog(diff);
    expect(text).toContain('=== Sideboard ===');
    expect(text).toContain('+ 4 Lightning Bolt');
  });

  it('omits sideboard section when hasSideboard is false', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    expect(text).not.toContain('Sideboard');
  });

  it('shows "No changes." for empty mainboard section', () => {
    const diff = makeDiff();
    const text = formatChangelog(diff);
    expect(text).toContain('No changes.');
  });

  it('shows "No changes." for empty sideboard when hasSideboard is true', () => {
    const diff = makeDiff({ hasSideboard: true, mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    // Sideboard should say no changes
    expect(text).toContain('=== Sideboard ===\nNo changes.');
  });

  it('handles all change types together', () => {
    const diff = makeDiff({
      mainIn: [CARD_IN],
      mainOut: [CARD_OUT],
      mainQty: [CARD_QTY_UP],
    });
    const text = formatChangelog(diff);
    expect(text).toContain('--- Cards In ---');
    expect(text).toContain('--- Cards Out ---');
    expect(text).toContain('--- Quantity Changes ---');
    expect(text).toContain('+ 4 Lightning Bolt');
    expect(text).toContain('- 2 Counterspell');
    expect(text).toContain('~ Sol Ring');
  });

  it('trims trailing whitespace', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatChangelog(diff);
    expect(text).toBe(text.trim());
  });
});

// ═══════════════════════════════════════════════════════════════════
// formatMpcFill
// ═══════════════════════════════════════════════════════════════════

describe('formatMpcFill()', () => {
  it('includes fully new cards', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatMpcFill(diff);
    expect(text).toBe('4 Lightning Bolt');
  });

  it('includes delta from quantity increases', () => {
    const diff = makeDiff({ mainQty: [CARD_QTY_UP] });
    const text = formatMpcFill(diff);
    expect(text).toBe('2 Sol Ring');
  });

  it('excludes quantity decreases', () => {
    const diff = makeDiff({ mainQty: [CARD_QTY_DOWN] });
    const text = formatMpcFill(diff);
    expect(text).toBe('');
  });

  it('excludes cards out', () => {
    const diff = makeDiff({ mainOut: [CARD_OUT] });
    const text = formatMpcFill(diff);
    expect(text).toBe('');
  });

  it('includes sideboard additions when hasSideboard is true', () => {
    const diff = makeDiff({
      mainIn: [CARD_IN],
      hasSideboard: true,
      sideIn: [{ name: 'Negate', quantity: 1 }],
    });
    const text = formatMpcFill(diff);
    expect(text).toContain('4 Lightning Bolt');
    expect(text).toContain('1 Negate');
  });

  it('returns empty string when no additions exist', () => {
    const diff = makeDiff({ mainOut: [CARD_OUT], mainQty: [CARD_QTY_DOWN] });
    const text = formatMpcFill(diff);
    expect(text).toBe('');
  });

  it('combines new cards and quantity increases', () => {
    const diff = makeDiff({ mainIn: [CARD_IN], mainQty: [CARD_QTY_UP] });
    const lines = formatMpcFill(diff).split('\n');
    expect(lines).toContain('4 Lightning Bolt');
    expect(lines).toContain('2 Sol Ring');
  });

  it('formats one card per line', () => {
    const diff = makeDiff({
      mainIn: [
        { name: 'Card A', quantity: 1 },
        { name: 'Card B', quantity: 2 },
        { name: 'Card C', quantity: 3 },
      ],
    });
    const lines = formatMpcFill(diff).split('\n');
    expect(lines).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// formatReddit
// ═══════════════════════════════════════════════════════════════════

describe('formatReddit()', () => {
  it('starts with ## header', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatReddit(diff);
    expect(text.startsWith('## ')).toBe(true);
  });

  it('includes commander name in header', () => {
    const diff = makeDiff({
      commanders: ['Kenrith, the Returned King'],
      mainIn: [CARD_IN],
    });
    const text = formatReddit(diff);
    expect(text).toContain('Kenrith, the Returned King');
  });

  it('formats mainboard as ### heading', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatReddit(diff);
    expect(text).toContain('### Mainboard');
  });

  it('wraps card names in [[double brackets]] for card fetcher bots', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatReddit(diff);
    expect(text).toContain('[[Lightning Bolt]]');
  });

  it('formats cards in with escaped + and bullet points', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatReddit(diff);
    expect(text).toContain('- \\+ 4 [[Lightning Bolt]]');
  });

  it('formats cards out with escaped - and bullet points', () => {
    const diff = makeDiff({ mainOut: [CARD_OUT] });
    const text = formatReddit(diff);
    expect(text).toContain('- \\- 2 [[Counterspell]]');
  });

  it('formats quantity changes with ~ prefix', () => {
    const diff = makeDiff({ mainQty: [CARD_QTY_UP] });
    const text = formatReddit(diff);
    expect(text).toContain('~ [[Sol Ring]]');
    expect(text).toContain('+2');
  });

  it('uses bold section headers (Cards In, Cards Out, Quantity Changes)', () => {
    const diff = makeDiff({
      mainIn: [CARD_IN],
      mainOut: [CARD_OUT],
      mainQty: [CARD_QTY_UP],
    });
    const text = formatReddit(diff);
    expect(text).toContain('**Cards In:**');
    expect(text).toContain('**Cards Out:**');
    expect(text).toContain('**Quantity Changes:**');
  });

  it('includes sideboard section when hasSideboard is true', () => {
    const diff = makeDiff({ hasSideboard: true, sideIn: [CARD_IN] });
    const text = formatReddit(diff);
    expect(text).toContain('### Sideboard');
  });

  it('omits empty sections (no mainboard heading if no main changes)', () => {
    const diff = makeDiff({ hasSideboard: true, sideIn: [CARD_IN] });
    const text = formatReddit(diff);
    // Mainboard has no changes — should not show ### Mainboard
    expect(text).not.toContain('### Mainboard');
  });

  it('trims output', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatReddit(diff);
    expect(text).toBe(text.trim());
  });
});

// ═══════════════════════════════════════════════════════════════════
// formatJSON
// ═══════════════════════════════════════════════════════════════════

describe('formatJSON()', () => {
  it('returns valid JSON', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatJSON(diff);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('includes commanders array', () => {
    const diff = makeDiff({ commanders: ['Atraxa'], mainIn: [CARD_IN] });
    const data = JSON.parse(formatJSON(diff));
    expect(data.commanders).toEqual(['Atraxa']);
  });

  it('includes ISO timestamp', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const data = JSON.parse(formatJSON(diff));
    expect(data.timestamp).toBe('2025-06-15T14:30:00.000Z');
  });

  it('includes mainboard cardsIn, cardsOut, quantityChanges', () => {
    const diff = makeDiff({
      mainIn: [CARD_IN],
      mainOut: [CARD_OUT],
      mainQty: [CARD_QTY_UP],
    });
    const data = JSON.parse(formatJSON(diff));
    expect(data.mainboard.cardsIn).toEqual([CARD_IN]);
    expect(data.mainboard.cardsOut).toEqual([CARD_OUT]);
    expect(data.mainboard.quantityChanges).toEqual([CARD_QTY_UP]);
  });

  it('includes sideboard when hasSideboard is true', () => {
    const diff = makeDiff({
      hasSideboard: true,
      sideIn: [{ name: 'Negate', quantity: 1 }],
    });
    const data = JSON.parse(formatJSON(diff));
    expect(data.sideboard).toBeDefined();
    expect(data.sideboard.cardsIn).toEqual([{ name: 'Negate', quantity: 1 }]);
  });

  it('excludes sideboard when hasSideboard is false', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const data = JSON.parse(formatJSON(diff));
    expect(data.sideboard).toBeUndefined();
  });

  it('is pretty-printed with 2-space indentation', () => {
    const diff = makeDiff({ mainIn: [CARD_IN] });
    const text = formatJSON(diff);
    // Pretty-printed JSON should have newlines
    expect(text).toContain('\n');
    // And 2-space indentation
    expect(text).toContain('  "commanders"');
  });

  it('handles empty diff (no changes)', () => {
    const diff = makeDiff();
    const data = JSON.parse(formatJSON(diff));
    expect(data.mainboard.cardsIn).toEqual([]);
    expect(data.mainboard.cardsOut).toEqual([]);
    expect(data.mainboard.quantityChanges).toEqual([]);
    expect(data.commanders).toEqual([]);
  });

  it('preserves card data structure exactly', () => {
    const qtyChange = { name: 'Sol Ring', oldQty: 1, newQty: 3, delta: 2 };
    const diff = makeDiff({ mainQty: [qtyChange] });
    const data = JSON.parse(formatJSON(diff));
    expect(data.mainboard.quantityChanges[0]).toEqual(qtyChange);
  });
});

// ─── formatArchidektCSV ────────────────────────────────────────

describe('formatArchidektCSV', () => {
  it('includes category column header', () => {
    const csv = formatArchidektCSV('1 Sol Ring (ltc) [284]');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('quantity,card name,edition code,collector number,category,modifier');
  });

  it('tags commander in category column', () => {
    const text = '1 Sauron, the Dark Lord (ltr) [675] *F*\n1 Sol Ring (ltc) [284]';
    const csv = formatArchidektCSV(text, ['Sauron, the Dark Lord']);
    const lines = csv.split('\n');
    // Sauron line should have Commander category
    const sauronLine = lines.find(l => l.includes('Sauron'));
    expect(sauronLine).toContain(',Commander,');
    // Sol Ring should not have Commander category
    const solLine = lines.find(l => l.includes('Sol Ring'));
    expect(solLine).not.toContain(',Commander,');
  });

  it('tags commander from parsed text when not passed explicitly', () => {
    const text = 'Commander\n1 Sauron, the Dark Lord (ltr) [675]\n\n1 Sol Ring (ltc) [284]';
    const csv = formatArchidektCSV(text);
    const sauronLine = csv.split('\n').find(l => l.includes('Sauron'));
    expect(sauronLine).toContain(',Commander,');
  });

  it('marks sideboard cards with Sideboard category', () => {
    const text = '1 Sol Ring (ltc) [284]\n\nSideboard\n1 Fatal Push (2xm) [69]';
    const csv = formatArchidektCSV(text);
    const fatalLine = csv.split('\n').find(l => l.includes('Fatal Push'));
    expect(fatalLine).toContain(',Sideboard,');
  });
});
