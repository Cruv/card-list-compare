import { describe, it, expect } from 'vitest';
import { parseCollectionImportText } from './collectionImport.js';

function single(text) {
  const { cards, skipped } = parseCollectionImportText(text);
  expect(skipped).toBe(0);
  expect(cards).toHaveLength(1);
  return cards[0];
}

describe('parseCollectionImportText', () => {
  // Regression: the old hand-rolled regex captured the last word of set-less
  // multi-word names as the collector number ("Lightning" cn "Bolt").
  it('keeps multi-word card names intact without a set code', () => {
    expect(single('4 Lightning Bolt')).toEqual({
      cardName: 'Lightning Bolt',
      setCode: null,
      collectorNumber: null,
      quantity: 4,
      isFoil: 0,
    });
  });

  it('keeps long names with punctuation intact', () => {
    expect(single("1 Atraxa, Praetors' Voice").cardName).toBe("Atraxa, Praetors' Voice");
    expect(single('1 Sheoldred // The True Scriptures').cardName).toBe(
      'Sheoldred // The True Scriptures'
    );
  });

  // Regression: the old regex had no x? after the quantity.
  it('accepts 4x-style quantities', () => {
    const card = single('4x Lightning Bolt');
    expect(card.cardName).toBe('Lightning Bolt');
    expect(card.quantity).toBe(4);
  });

  it('parses set code with bracketed collector number', () => {
    expect(single('1 Snapcaster Mage (UMA) [63]')).toEqual({
      cardName: 'Snapcaster Mage',
      setCode: 'UMA',
      collectorNumber: '63',
      quantity: 1,
      isFoil: 0,
    });
  });

  it('parses bare collector number after a set code (Arena/Archidekt style)', () => {
    const card = single('2 Atraxa (C20) 215');
    expect(card.cardName).toBe('Atraxa');
    expect(card.setCode).toBe('C20');
    expect(card.collectorNumber).toBe('215');
  });

  it('parses foil markers', () => {
    expect(single('1 Sol Ring (c21) [263] *F*').isFoil).toBe(1);
    expect(single('2 Nazgul *F*')).toEqual({
      cardName: 'Nazgul',
      setCode: null,
      collectorNumber: null,
      quantity: 2,
      isFoil: 1,
    });
  });

  it('parses alphanumeric promo collector numbers', () => {
    expect(single('1 Nazgul (ltr) [336p]').collectorNumber).toBe('336p');
  });

  it('imports SB:-prefixed lines as cards', () => {
    const card = single('SB: 2 Fatal Push');
    expect(card.cardName).toBe('Fatal Push');
    expect(card.quantity).toBe(2);
  });

  it('imports CSV-style quantity,name rows', () => {
    const card = single('4,Lightning Bolt');
    expect(card.cardName).toBe('Lightning Bolt');
    expect(card.quantity).toBe(4);
  });

  it('skips section headers without counting them', () => {
    const { cards, skipped } = parseCollectionImportText(
      ['Commander', '1 Atraxa', '', 'Sideboard', '2 Duress', 'Maybeboard', '1 Opt', 'Companion'].join('\n')
    );
    expect(skipped).toBe(0);
    expect(cards.map((c) => c.cardName)).toEqual(['Atraxa', 'Duress', 'Opt']);
  });

  it('skips comments and blank lines silently', () => {
    const { cards, skipped } = parseCollectionImportText('# my collection\n\n// notes\n1 Opt');
    expect(skipped).toBe(0);
    expect(cards).toHaveLength(1);
  });

  it('counts junk lines without a leading quantity as skipped (no qty-1 fallback)', () => {
    const { cards, skipped } = parseCollectionImportText('random text here\nBrainstorm\n1 Opt');
    expect(cards.map((c) => c.cardName)).toEqual(['Opt']);
    expect(skipped).toBe(2);
  });

  it('skips zero-quantity lines', () => {
    const { cards, skipped } = parseCollectionImportText('0 Island');
    expect(cards).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('clamps absurd quantities to 999 (same bound as single-card add)', () => {
    expect(single('4000 Island').quantity).toBe(999);
  });

  it('handles CRLF line endings', () => {
    const { cards, skipped } = parseCollectionImportText('1 Opt\r\n2 Duress\r\n');
    expect(skipped).toBe(0);
    expect(cards).toHaveLength(2);
  });

  it('does not aggregate duplicate lines (route upserts per line)', () => {
    const { cards } = parseCollectionImportText('1 Opt\n1 Opt');
    expect(cards).toHaveLength(2);
  });
});
