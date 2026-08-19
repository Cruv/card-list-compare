import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  get: vi.fn(() => ({ id: 1, snapshot_price: null })),
  run: vi.fn(),
}));
vi.mock('./scryfall.js', () => ({
  fetchCardPrices: vi.fn(),
  fetchSpecificPrintingPrices: vi.fn(),
}));

import { computeDeckPrices } from './priceCalculator.js';
import { fetchCardPrices, fetchSpecificPrintingPrices } from './scryfall.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeDeckPrices multi-printing (audit)', () => {
  it('counts every printing of a card toward the total', async () => {
    fetchCardPrices.mockResolvedValue(new Map([['sol ring', { priceUsd: 2, priceUsdFoil: null }]]));
    fetchSpecificPrintingPrices.mockResolvedValue(new Map([['sol ring', { priceUsd: 3, priceUsdFoil: null }]]));

    // Same card under two printings: 2 + 1 = 3 copies.
    const result = await computeDeckPrices(1, '2 Sol Ring (c21) 263\n1 Sol Ring (ltc) 284');

    expect(result.totalPrice).toBe(9); // 3 copies × $3 specific
    expect(result.budgetPrice).toBe(6); // 3 copies × $2 cheapest
    // Display aggregates to a single Sol Ring row with the summed quantity.
    const solRows = result.cards.filter(c => c.name === 'Sol Ring');
    expect(solRows).toHaveLength(1);
    expect(solRows[0].quantity).toBe(3);
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
