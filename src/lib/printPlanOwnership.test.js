import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePrintPlanOwnership } from './printPlanOwnership';
import { clearCardCache } from './scryfall';
import { shoppingText, withOriginalOwnership } from './manasync';

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
    expect(shoppingText(withOriginalOwnership(missing.cards, [], true))).toBe('');

    fetcher.mockImplementation(async () => new Response(JSON.stringify({ data: [{
      id: 'cmm-print', oracle_id: 'ring-oracle', name: 'Sol Ring', set: 'cmm', collector_number: '410',
    }] })));
    const recovered = await resolvePrintPlanOwnership(plan);
    expect(recovered.unresolved).toEqual([]);
    expect(recovered.cards[0]).toMatchObject({ quantity: 3, card: { scryfallId: 'cmm-print', oracleId: 'ring-oracle' } });
    expect(shoppingText(withOriginalOwnership(recovered.cards, [], true))).toBe('1 Sol Ring');
    expect(recovered.cards[0].key).toBe(missing.cards[0].key);
  });

  it('keeps bare unresolved identities unknown when no owned original matches by name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Temporary outage')));
    const result = await resolvePrintPlanOwnership({ cards: [{ displayName: 'Island', quantity: 1 }] });
    expect(result.unresolved).toHaveLength(1);
    expect(result.cards[0].card.scryfallId).toBeNull();
    expect(shoppingText(withOriginalOwnership(result.cards, [], true))).toBe('');
  });

  it('reuses frozen server identities without fetching different artwork or printing metadata', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = await resolvePrintPlanOwnership({ ...plan,
      resolvedCards: [{ scryfallId: 'frozen-print', oracleId: 'ring-oracle' }] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.cards[0]).toMatchObject({ quantity: 3, card: { scryfallId: 'frozen-print', oracleId: 'ring-oracle' } });
    expect(shoppingText(withOriginalOwnership(result.cards, [], true))).toBe('1 Sol Ring');
  });
});
