import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchCardPrintings,
  fetchCardPrices,
  fetchSpecificPrintingPrices,
} from './scryfall.js';

function mockScryfall(cards) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: cards, not_found: [] }),
  }));
}

/** The identifiers sent in the most recent Scryfall request. */
function sentIdentifiers() {
  return JSON.parse(global.fetch.mock.calls.at(-1)[1].body).identifiers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('server Scryfall keying (audit H7)', () => {
  it('keys accented cards under the requested (unaccented) name', async () => {
    // Deck text says "Nazgul"; Scryfall echoes the canonical "Nazgûl".
    mockScryfall([{ name: 'Nazgûl', set: 'ltr', collector_number: '100' }]);
    const map = await fetchCardPrintings(['Nazgul']);
    expect(map.get('nazgul')).toEqual({ set: 'ltr', collectorNumber: '100' });
  });

  it('keys a full "front // back" DFC price under the requested full name', async () => {
    mockScryfall([
      { name: 'Malakir Rebirth // Malakir Mire', prices: { usd: '2.50', usd_foil: '5.00' } },
    ]);
    const map = await fetchCardPrices(['Malakir Rebirth // Malakir Mire']);
    expect(map.get('malakir rebirth // malakir mire')).toEqual({ priceUsd: 2.5, priceUsdFoil: 5 });
  });

  it('keys a DFC price under a front-face-only request', async () => {
    mockScryfall([
      { name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', prices: { usd: '4.00', usd_foil: null } },
    ]);
    const map = await fetchCardPrices(['Fable of the Mirror-Breaker']);
    expect(map.get('fable of the mirror-breaker')).toEqual({ priceUsd: 4, priceUsdFoil: null });
  });

  it('queries the front face AND the full name, so split cards are not dropped', async () => {
    // Scryfall knows no card called "Who" — a front-face-only query loses this
    // card entirely. The full name must be asked for too.
    mockScryfall([
      { name: 'Who // What // When // Where // Why', prices: { usd: '1.00', usd_foil: null } },
    ]);
    const map = await fetchCardPrices(['Who // What // When // Where // Why']);
    const names = sentIdentifiers().map(i => i.name);
    expect(names).toContain('who // what // when // where // why');
    expect(map.get('who // what // when // where // why')).toEqual({ priceUsd: 1, priceUsdFoil: null });
  });

  it('sends the front face for a plain double-faced name', async () => {
    mockScryfall([{ name: 'Malakir Rebirth // Malakir Mire', prices: { usd: '2.00', usd_foil: null } }]);
    await fetchCardPrices(['Malakir Rebirth']);
    expect(sentIdentifiers()).toEqual([{ name: 'malakir rebirth' }]);
  });

  it('keys specific-printing prices by PRINTING so each printing keeps its own price', async () => {
    // Two printings of one card at very different prices. Keying by name would
    // collapse them and charge both at whichever came back last.
    mockScryfall([
      { name: 'Nazgûl', set: 'ltr', collector_number: '332', prices: { usd: '3.00', usd_foil: null } },
      { name: 'Nazgûl', set: 'ltc', collector_number: '408', prices: { usd: '250.00', usd_foil: null } },
    ]);
    const map = await fetchSpecificPrintingPrices([
      { name: 'Nazgul', set: 'ltr', collectorNumber: '332' },
      { name: 'Nazgul', set: 'ltc', collectorNumber: '408' },
    ]);
    expect(map.get('ltr|332')).toEqual({ priceUsd: 3, priceUsdFoil: null });
    expect(map.get('ltc|408')).toEqual({ priceUsd: 250, priceUsdFoil: null });
    expect(map.get('nazgul')).toBeUndefined(); // never name-keyed
  });
});
