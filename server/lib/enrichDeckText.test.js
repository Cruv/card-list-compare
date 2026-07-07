import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrichDeckText } from './enrichDeckText.js';

// Mock the Scryfall module
vi.mock('./scryfall.js', () => ({
  fetchCardPrintings: vi.fn(),
}));

import { fetchCardPrintings } from './scryfall.js';

beforeEach(() => {
  fetchCardPrintings.mockReset();
});

describe('enrichDeckText()', () => {
  // ── Already-enriched text passes through ────────────────────

  it('preserves lines that already have full metadata', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const text = '4 Lightning Bolt (m10) [227]\n1 Sol Ring (c21) [263] *F*';
    const result = await enrichDeckText(text, null);

    expect(result).toBe(text);
    // Should not have called Scryfall since all cards already have metadata
    expect(fetchCardPrintings).not.toHaveBeenCalled();
  });

  // ── Carry-forward from previous snapshot ────────────────────

  it('carries forward metadata from previous snapshot', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const previousText = '4 Lightning Bolt (m10) [227]';
    const newText = '4 Lightning Bolt';

    const result = await enrichDeckText(newText, previousText);
    expect(result).toBe('4 Lightning Bolt (m10) [227]');
  });

  it('carries forward foil status from previous snapshot', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const previousText = '1 Sol Ring (c21) [263] *F*';
    const newText = '1 Sol Ring';

    const result = await enrichDeckText(newText, previousText);
    expect(result).toBe('1 Sol Ring (c21) [263] *F*');
  });

  it('carries forward multiple printings of the same card', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const previousText = [
      '1 Nazgul (ltr) [551]',
      '1 Nazgul (ltr) [729] *F*',
    ].join('\n');
    const newText = '2 Nazgul';

    const result = await enrichDeckText(newText, previousText);
    const lines = result.split('\n');
    expect(lines).toContain('1 Nazgul (ltr) [551]');
    expect(lines).toContain('1 Nazgul (ltr) [729] *F*');
  });

  it('assigns remainder to first printing when new qty exceeds previous', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const previousText = '1 Nazgul (ltr) [551]';
    const newText = '3 Nazgul';

    const result = await enrichDeckText(newText, previousText);
    // Single printing with qty 1 → whole new quantity uses that printing's metadata
    expect(result).toBe('3 Nazgul (ltr) [551]');
  });

  // ── Unified card-line pattern (v2.40.2) ─────────────────────
  // enrichDeckText shares CARD_LINE_PATTERN with the client parser.

  it('recognizes Arena-style bare collector numbers as full metadata', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    // Previously the fork without bare-collector support folded "(C20) 215"
    // into the card name and re-enriched under the garbled key.
    const newText = '2 Atraxa (C20) 215 *F*';
    const result = await enrichDeckText(newText, '1 Atraxa (mom) [107]');

    expect(result).toBe(newText); // kept as-is: set + collector already present
    expect(fetchCardPrintings).not.toHaveBeenCalled();
  });

  it('passes through set-less bracketed lines unchanged (bracket is part of the name)', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    // Matches the client parser: without a set code, "[336p]" folds into the
    // name rather than being treated as a collector number. Previously the
    // fork extracted it and replaced it with the carried-forward printing.
    const previousText = '1 Nazgul (ltr) [551]';
    const newText = '1 Nazgul [336p]';

    const result = await enrichDeckText(newText, previousText);
    expect(result).toBe('1 Nazgul [336p]');
  });

  // ── Scryfall fallback ───────────────────────────────────────

  it('falls back to Scryfall for cards without previous metadata', async () => {
    fetchCardPrintings.mockResolvedValue(new Map([
      ['lightning bolt', { set: 'leb', collectorNumber: '162' }],
    ]));

    const newText = '4 Lightning Bolt';
    const result = await enrichDeckText(newText, null);

    expect(result).toBe('4 Lightning Bolt (leb) [162]');
    expect(fetchCardPrintings).toHaveBeenCalledWith(['Lightning Bolt']);
  });

  it('preserves original line when Scryfall has no data', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const newText = '1 Some Custom Card';
    const result = await enrichDeckText(newText, null);

    expect(result).toBe('1 Some Custom Card');
  });

  // ── Section headers and structure preservation ──────────────

  it('preserves section headers and blank lines', async () => {
    fetchCardPrintings.mockResolvedValue(new Map([
      ['lightning bolt', { set: 'leb', collectorNumber: '162' }],
      ['fatal push', { set: '2xm', collectorNumber: '69' }],
    ]));

    const newText = '4 Lightning Bolt\n\nSideboard\n2 Fatal Push';
    const result = await enrichDeckText(newText, null);

    expect(result).toBe('4 Lightning Bolt (leb) [162]\n\nSideboard\n2 Fatal Push (2xm) [69]');
  });

  it('preserves Commander section header', async () => {
    fetchCardPrintings.mockResolvedValue(new Map([
      ['atraxa, praetors\' voice', { set: 'cm2', collectorNumber: '10' }],
    ]));

    const newText = 'Commander\n1 Atraxa, Praetors\' Voice';
    const result = await enrichDeckText(newText, null);

    expect(result).toMatch(/^Commander\n1 Atraxa, Praetors' Voice \(cm2\) \[10\]$/);
  });

  // ── Mixed scenarios ─────────────────────────────────────────

  it('handles mix of enriched and plain cards', async () => {
    fetchCardPrintings.mockResolvedValue(new Map([
      ['dark ritual', { set: 'lea', collectorNumber: '18' }],
    ]));

    const newText = '4 Lightning Bolt (m10) [227]\n4 Dark Ritual';
    const result = await enrichDeckText(newText, null);

    expect(result).toBe('4 Lightning Bolt (m10) [227]\n4 Dark Ritual (lea) [18]');
  });

  it('prioritizes carry-forward over Scryfall', async () => {
    // Scryfall would return a different printing, but carry-forward should win
    fetchCardPrintings.mockResolvedValue(new Map([
      ['lightning bolt', { set: 'leb', collectorNumber: '162' }],
    ]));

    const previousText = '4 Lightning Bolt (m10) [227]';
    const newText = '4 Lightning Bolt';

    const result = await enrichDeckText(newText, previousText);
    // Should use carry-forward (m10/227), not Scryfall (leb/162)
    expect(result).toBe('4 Lightning Bolt (m10) [227]');
    // Should not even call Scryfall for this card
    expect(fetchCardPrintings).not.toHaveBeenCalled();
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('handles empty text', async () => {
    const result = await enrichDeckText('', null);
    expect(result).toBe('');
  });

  it('handles null text', async () => {
    const result = await enrichDeckText(null, null);
    expect(result).toBeNull();
  });

  it('handles alphanumeric collector numbers in carry-forward', async () => {
    fetchCardPrintings.mockResolvedValue(new Map());

    const previousText = '1 Lightning Bolt (plst) [136p]';
    const newText = '1 Lightning Bolt';

    const result = await enrichDeckText(newText, previousText);
    expect(result).toBe('1 Lightning Bolt (plst) [136p]');
  });
});
