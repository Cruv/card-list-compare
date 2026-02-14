import { describe, it, expect } from 'vitest';
import { _moxfieldToText, _archidektToText, _deckcheckToText, _tcgPlayerToText, detectSite } from './fetcher.js';

// ── Moxfield metadata extraction ─────────────────────────────

describe('moxfieldToText()', () => {
  it('extracts set code, collector number, and foil status', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'abc123': {
              card: { name: 'Lightning Bolt', set: 'm10', cn: '227' },
              quantity: 4,
              finish: 'nonFoil',
              isFoil: false,
            },
          },
        },
      },
    };
    const { text, stats } = _moxfieldToText(data);
    expect(text).toBe('4 Lightning Bolt (m10) [227]');
    expect(stats.totalCards).toBe(4);
    expect(stats.cardsWithMeta).toBe(4);
  });

  it('marks foil cards from finish field', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'abc': {
              card: { name: 'Black Market Connections', set: 'acr', cn: '161' },
              quantity: 1,
              finish: 'foil',
              isFoil: false,
            },
          },
        },
      },
    };
    const { text } = _moxfieldToText(data);
    expect(text).toBe('1 Black Market Connections (acr) [161] *F*');
  });

  it('marks foil cards from isFoil field', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'abc': {
              card: { name: 'Sol Ring', set: 'c21', cn: '263' },
              quantity: 1,
              finish: 'nonFoil',
              isFoil: true,
            },
          },
        },
      },
    };
    const { text } = _moxfieldToText(data);
    expect(text).toBe('1 Sol Ring (c21) [263] *F*');
  });

  it('marks etched finish as foil', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'abc': {
              card: { name: 'Arcane Signet', set: 'cmr', cn: '297' },
              quantity: 1,
              finish: 'etched',
              isFoil: false,
            },
          },
        },
      },
    };
    const { text } = _moxfieldToText(data);
    expect(text).toContain('*F*');
  });

  it('handles multiple printings of the same card', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'naz1': {
              card: { name: 'Nazgul', set: 'ltr', cn: '551' },
              quantity: 1,
              finish: 'nonFoil',
              isFoil: false,
            },
            'naz2': {
              card: { name: 'Nazgul', set: 'ltr', cn: '729' },
              quantity: 1,
              finish: 'foil',
              isFoil: false,
            },
          },
        },
      },
    };
    const { text, stats } = _moxfieldToText(data);
    expect(text).toContain('1 Nazgul (ltr) [551]');
    expect(text).toContain('1 Nazgul (ltr) [729] *F*');
    expect(stats.totalCards).toBe(2);
    expect(stats.cardsWithMeta).toBe(2);
  });

  it('places commanders under Commander header', () => {
    const data = {
      boards: {
        commanders: {
          cards: {
            'cmd1': {
              card: { name: 'Atraxa, Praetors\' Voice', set: 'cm2', cn: '10' },
              quantity: 1,
              finish: 'nonFoil',
              isFoil: false,
            },
          },
        },
        mainboard: {
          cards: {
            'abc': {
              card: { name: 'Sol Ring', set: 'c21', cn: '263' },
              quantity: 1,
              finish: 'nonFoil',
              isFoil: false,
            },
          },
        },
      },
    };
    const { text, commanders } = _moxfieldToText(data);
    expect(text).toMatch(/^Commander\n1 Atraxa/);
    expect(commanders).toContain('Atraxa, Praetors\' Voice');
  });

  it('skips maybeboard cards', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'abc': {
              card: { name: 'Sol Ring', set: 'c21', cn: '263' },
              quantity: 1,
              finish: 'nonFoil',
              isFoil: false,
            },
          },
        },
        maybeboard: {
          cards: {
            'xyz': {
              card: { name: 'Mana Crypt', set: '2xm', cn: '270' },
              quantity: 1,
              finish: 'nonFoil',
              isFoil: false,
            },
          },
        },
      },
    };
    const { text, stats } = _moxfieldToText(data);
    expect(text).not.toContain('Mana Crypt');
    expect(stats.totalCards).toBe(1);
  });

  it('handles cards without metadata gracefully', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'abc': {
              card: { name: 'Lightning Bolt' },
              quantity: 4,
            },
          },
        },
      },
    };
    const { text, stats } = _moxfieldToText(data);
    expect(text).toBe('4 Lightning Bolt');
    expect(stats.totalCards).toBe(4);
    expect(stats.cardsWithMeta).toBe(0);
  });

  it('reports correct stats with partial metadata', () => {
    const data = {
      boards: {
        mainboard: {
          cards: {
            'a': {
              card: { name: 'Lightning Bolt', set: 'm10', cn: '227' },
              quantity: 4,
              finish: 'nonFoil',
            },
            'b': {
              card: { name: 'Dark Ritual' },
              quantity: 4,
            },
          },
        },
      },
    };
    const { stats } = _moxfieldToText(data);
    expect(stats.totalCards).toBe(8);
    expect(stats.cardsWithMeta).toBe(4);
  });
});

// ── Archidekt metadata stats ─────────────────────────────────

describe('archidektToText() stats', () => {
  it('reports metadata coverage', () => {
    const data = {
      cards: [
        {
          card: { oracleCard: { name: 'Lightning Bolt' }, edition: { editioncode: 'm10' }, collectorNumber: '227' },
          quantity: 4,
          modifier: 'Normal',
          categories: [],
        },
        {
          card: { oracleCard: { name: 'Dark Ritual' } },
          quantity: 4,
          modifier: 'Normal',
          categories: [],
        },
      ],
    };
    const { stats } = _archidektToText(data);
    expect(stats.totalCards).toBe(8);
    expect(stats.cardsWithMeta).toBe(4);
  });
});

// ── DeckCheck stats (no metadata) ────────────────────────────

describe('deckcheckToText() stats', () => {
  it('reports zero metadata coverage', () => {
    const data = {
      commanders: ['Atraxa, Praetors\' Voice'],
      cards: { 'Sol Ring': 1, 'Lightning Bolt': 4 },
    };
    const { stats } = _deckcheckToText(data);
    expect(stats.totalCards).toBe(6); // 1 commander + 1 sol ring + 4 bolts
    expect(stats.cardsWithMeta).toBe(0);
  });
});

// ── detectSite() URL detection ──────────────────────────────

describe('detectSite()', () => {
  it('detects Archidekt URLs', () => {
    expect(detectSite('https://archidekt.com/decks/12345')).toBe('archidekt');
    expect(detectSite('https://www.archidekt.com/decks/12345/my-deck')).toBe('archidekt');
  });

  it('detects Moxfield URLs', () => {
    expect(detectSite('https://www.moxfield.com/decks/abc-123')).toBe('moxfield');
    expect(detectSite('https://moxfield.com/decks/xYz_456')).toBe('moxfield');
  });

  it('detects DeckCheck URLs', () => {
    expect(detectSite('https://deckcheck.co/app/deckview/abc123')).toBe('deckcheck');
    expect(detectSite('https://deckcheck.co/deckview/abc123')).toBe('deckcheck');
  });

  it('detects TappedOut URLs', () => {
    expect(detectSite('https://tappedout.net/mtg-decks/my-cool-deck/')).toBe('tappedout');
    expect(detectSite('https://tappedout.net/mtg-decks/atraxa-edh-1/')).toBe('tappedout');
  });

  it('detects Deckstats URLs', () => {
    expect(detectSite('https://deckstats.net/decks/12345/67890')).toBe('deckstats');
    expect(detectSite('https://deckstats.net/decks/12345/67890-my-deck/en')).toBe('deckstats');
  });

  it('detects MTGGoldfish URLs', () => {
    expect(detectSite('https://www.mtggoldfish.com/deck/12345')).toBe('mtggoldfish');
    expect(detectSite('https://mtggoldfish.com/deck/67890')).toBe('mtggoldfish');
  });

  it('detects TCGPlayer URLs', () => {
    expect(detectSite('https://infinite.tcgplayer.com/magic/deck/My-Deck/12345')).toBe('tcgplayer');
    expect(detectSite('https://infinite.tcgplayer.com/api/v1/decks/12345')).toBe('tcgplayer');
  });

  it('returns null for plain text', () => {
    expect(detectSite('4 Lightning Bolt')).toBeNull();
    expect(detectSite('Sol Ring')).toBeNull();
    expect(detectSite('')).toBeNull();
  });

  it('returns null for unsupported URLs', () => {
    expect(detectSite('https://google.com')).toBeNull();
    expect(detectSite('https://scryfall.com/card/m10/227')).toBeNull();
  });
});

// ── TCGPlayer conversion ──────────────────────────────────────

describe('tcgPlayerToText()', () => {
  it('converts basic deck with mainboard and sideboard', () => {
    const data = {
      entries: [
        { name: 'Lightning Bolt', quantity: 4, boardType: 'main' },
        { name: 'Sol Ring', quantity: 1, boardType: 'main' },
        { name: 'Fatal Push', quantity: 2, boardType: 'sideboard' },
      ],
    };
    const { text, commanders, stats } = _tcgPlayerToText(data);
    expect(text).toContain('4 Lightning Bolt');
    expect(text).toContain('1 Sol Ring');
    expect(text).toContain('Sideboard\n2 Fatal Push');
    expect(commanders).toEqual([]);
    expect(stats.totalCards).toBe(7);
  });

  it('handles commander board type', () => {
    const data = {
      entries: [
        { name: 'Atraxa, Praetors\' Voice', quantity: 1, boardType: 'commander' },
        { name: 'Sol Ring', quantity: 1, boardType: 'main' },
      ],
    };
    const { text, commanders } = _tcgPlayerToText(data);
    expect(text).toContain('Commander\n1 Atraxa');
    expect(commanders).toEqual(['Atraxa, Praetors\' Voice']);
  });

  it('handles empty entries', () => {
    const { text, stats } = _tcgPlayerToText({ entries: [] });
    expect(text).toBe('');
    expect(stats.totalCards).toBe(0);
  });
});
