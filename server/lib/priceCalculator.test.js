import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  get: vi.fn(() => ({ id: 1, snapshot_price: null })),
  run: vi.fn(),
}));
vi.mock('./scryfall.js', () => ({
  fetchCardPrices: vi.fn(),
  fetchSpecificPrintingPrices: vi.fn(),
  // Real implementation — the key format is the contract under test here.
  printingKey: (set, cn) => `${String(set || '').toLowerCase()}|${cn}`,
}));

import { computeDeckPrices } from './priceCalculator.js';
import { fetchCardPrices, fetchSpecificPrintingPrices } from './scryfall.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeDeckPrices multi-printing (audit)', () => {
  it('prices each printing at ITS OWN price and sums them', async () => {
    fetchCardPrices.mockResolvedValue(new Map([['sol ring', { priceUsd: 2, priceUsdFoil: null }]]));
    // Keyed by printing (set|collectorNumber), with genuinely different prices —
    // a name-keyed map would collapse these and charge one price for both.
    fetchSpecificPrintingPrices.mockResolvedValue(new Map([
      ['c21|263', { priceUsd: 3, priceUsdFoil: null }],
      ['ltc|284', { priceUsd: 30, priceUsdFoil: null }],
    ]));

    // Same card under two printings: 2 cheap copies + 1 expensive copy.
    const result = await computeDeckPrices(1, '2 Sol Ring (c21) 263\n1 Sol Ring (ltc) 284');

    expect(result.totalPrice).toBe(36); // 2×$3 + 1×$30 — not 3×$30 or 3×$3
    expect(result.budgetPrice).toBe(6); // 3 copies × $2 cheapest printing
    // Display aggregates to a single Sol Ring row with the summed quantity.
    const solRows = result.cards.filter(c => c.name === 'Sol Ring');
    expect(solRows).toHaveLength(1);
    expect(solRows[0].quantity).toBe(3);
    // The row's unit price stays consistent with its own total.
    expect(solRows[0].total).toBe(36);
    expect(solRows[0].price * solRows[0].quantity).toBeCloseTo(36, 6);
  });

  it('falls back to the cheapest price when a printing has no specific price', async () => {
    fetchCardPrices.mockResolvedValue(new Map([['sol ring', { priceUsd: 2, priceUsdFoil: null }]]));
    fetchSpecificPrintingPrices.mockResolvedValue(new Map()); // e.g. printing not found
    const result = await computeDeckPrices(1, '2 Sol Ring (c21) 263');
    expect(result.totalPrice).toBe(4);
  });

  it('does not double-price a commander that also appears in the mainboard', async () => {
    fetchCardPrices.mockResolvedValue(new Map([['atraxa', { priceUsd: 10, priceUsdFoil: null }]]));
    fetchSpecificPrintingPrices.mockResolvedValue(new Map());

    // Inline (Commander) tag: the card is in the mainboard AND named in
    // commanders[], so the commander loop must skip it (already priced once).
    const result = await computeDeckPrices(1, '1 Atraxa (Commander)');

    expect(result.totalPrice).toBe(10); // priced once, not twice
  });
});
