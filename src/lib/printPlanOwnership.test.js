import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePrintPlanOwnership } from './printPlanOwnership';
import { clearCardCache } from './scryfall';
import { shoppingText, withShortages } from './manasync';

beforeEach(() => clearCardCache());
afterEach(() => vi.unstubAllGlobals());

describe('print review identity recovery', () => {
  const plan = { cards: [{ displayName: 'Sol Ring', setCode: 'CMM', collectorNumber: '410', isFoil: false, quantity: 3 }] };

  it('detects swallowed transport errors and resolves the same reviewed list on retry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Temporary Scryfall outage'));
    vi.stubGlobal('fetch', fetcher);
    const missing = await resolvePrintPlanOwnership(plan);
    expect(missing.unresolved).toHaveLength(1);
    expect(missing.cards[0].card.scryfallId).toBeNull();
    expect(shoppingText(withShortages(missing.cards, [], 'printing', true), true)).toBe('');

    fetcher.mockImplementation(async () => new Response(JSON.stringify({ data: [{
      id: 'cmm-print', oracle_id: 'ring-oracle', name: 'Sol Ring', set: 'cmm', collector_number: '410',
    }] })));
    const recovered = await resolvePrintPlanOwnership(plan);
    expect(recovered.unresolved).toEqual([]);
    expect(recovered.cards[0]).toMatchObject({ quantity: 3, card: { scryfallId: 'cmm-print', oracleId: 'ring-oracle' } });
    expect(shoppingText(withShortages(recovered.cards, [], 'printing', true), true)).toBe('3 Sol Ring (CMM) 410');
    expect(recovered.cards[0].key).toBe(missing.cards[0].key);
  });

  it('does not label cards without selected printing metadata as failed exact requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Temporary outage')));
    const result = await resolvePrintPlanOwnership({ cards: [{ displayName: 'Island', quantity: 1 }] });
    expect(result.unresolved).toEqual([]);
    expect(result.cards[0].card.scryfallId).toBeNull();
  });
});
