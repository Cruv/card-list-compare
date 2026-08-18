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

  it('keys specific-printing prices under the requested name, not the echoed one', async () => {
    mockScryfall([
      { name: 'Nazgûl', set: 'ltr', collector_number: '332', prices: { usd: '3.00', usd_foil: null } },
    ]);
    const map = await fetchSpecificPrintingPrices([
      { name: 'Nazgul', set: 'ltr', collectorNumber: '332' },
    ]);
    expect(map.get('nazgul')).toEqual({ priceUsd: 3, priceUsdFoil: null });
  });
});
