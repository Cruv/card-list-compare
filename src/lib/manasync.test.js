import { describe, it, expect } from 'vitest';
import { parse } from './parser';
import { deckBridgeCards, printPlanBridgeCards, ownershipFor, withOriginalOwnership, shoppingText, manaPoolLink } from './manasync';
import { planPhysicalCopies } from '../../server/lib/printQueuePlan.js';

const card = { name: 'Sol Ring', scryfallId: 'print-a', oracleId: 'oracle-a', setCode: 'c21', collectorNumber: '263', finish: 'nonfoil', language: 'en' };
const original = { key: 'oracle-a', name: 'Sol Ring', realOwned: 1, incoming: 0, received: 1, available: 0, allocated: 1, proxies: 0, locations: [] };
const entries = [
  { key: 'a', quantity: 5, card },
  { key: 'b', quantity: 100, card: { ...card, scryfallId: 'other-print', setCode: 'cmm', collectorNumber: '410', finish: 'etched', language: 'de' } },
  { key: 'c', quantity: 3, card: { ...card, oracleId: null, scryfallId: null } },
];

describe('one-original ownership policy and shopping', () => {
  it('keeps disconnected and unresolved unmatched ownership unknown, not unowned', () => {
    expect(ownershipFor(card, [], false)).toBeNull();
    expect(ownershipFor({ name: 'Sol Ring' }, [], true)).toBeNull();
    expect(ownershipFor(card, [], true).hasOriginal).toBe(false);
    expect(shoppingText(withOriginalOwnership(entries, [], false))).toBe('');
    expect(shoppingText(withOriginalOwnership([{ key: 'unknown', quantity: 8, card: { name: 'Unknown name' } }], [], true))).toBe('');
  });

  it('allows unlimited copies, other printings and finishes, and reuse across separate decks from one allocated original', () => {
    const rows = withOriginalOwnership(entries, [original], true);
    expect(rows.map(row => row.ownership.hasOriginal)).toEqual([true, true, true]);
    expect(rows.map(row => row.quantity)).toEqual([5, 100, 3]);
    expect(shoppingText(rows)).toBe('');
    expect(withOriginalOwnership([{ ...entries[0], key: 'another-deck', quantity: 200 }], [original], true)[0].ownership.hasOriginal).toBe(true);
    expect(new Set(rows.map(row => row.shoppingKey)).size).toBe(1);
  });

  it('counts incoming originals as covered without adding incoming twice or treating proxies as originals', () => {
    const incoming = { ...original, realOwned: 1, received: 0, incoming: 1 };
    expect(ownershipFor(card, [incoming], true)).toMatchObject({ hasOriginal: true, incomingOnly: true });
    expect(shoppingText(withOriginalOwnership(entries, [incoming], true))).toBe('');
    expect(ownershipFor(card, [{ ...original, realOwned: 0, received: 0, proxies: 100 }], true).hasOriginal).toBe(false);
    expect(shoppingText(withOriginalOwnership(entries, [{ ...original, realOwned: 0, received: 0, proxies: 100 }], true))).toBe('1 Sol Ring');
    expect(ownershipFor(card, [{ ...original, realOwned: 0, received: 0, incoming: 5 }], true).hasOriginal).toBe(false);
  });

  it('offers one original per logical card even when many copies and printings are requested', () => {
    const rows = withOriginalOwnership(entries, [], true);
    expect(shoppingText(rows)).toBe('1 Sol Ring');
    expect(rows.map(row => row.quantity)).toEqual([5, 100, 3]);
    const selection = new Set([rows[0].shoppingKey]);
    expect(shoppingText(rows.filter(row => !selection.has(row.shoppingKey)))).toBe('');
    expect(entries.map(row => row.quantity)).toEqual([5, 100, 3]);
  });

  it('groups Oracle aliases and full/front Unicode spellings without requiring exact printing IDs', () => {
    const cards = [
      { key: 'one', quantity: 3, card: { name: 'Éowyn // Back', oracleId: 'eowyn' } },
      { key: 'two', quantity: 8, card: { name: 'Eowyn' } },
      { key: 'three', quantity: 1, card: { name: 'Alternate name', oracleId: 'eowyn' } },
    ];
    expect(shoppingText(withOriginalOwnership(cards, [], true))).toBe('1 Éowyn // Back');
    expect(ownershipFor({ name: 'Eowyn' }, [{ ...original, key: 'eowyn', name: 'Éowyn // Back' }], true).hasOriginal).toBe(true);
    const text = '1 Éowyn // Back\n1 Sol Ring';
    const url = new URL(manaPoolLink(text));
    expect(url.pathname).toBe('/add-deck');
    expect(Buffer.from(url.searchParams.get('deck'), 'base64').toString('utf8')).toBe(text);
  });

  it('shows only original locations without modifying remote inventory rows', () => {
    const inventory = [{ ...original, locations: [{ name: 'Deck', isProxy: false }, { name: 'Proxies', isProxy: true }] }];
    expect(ownershipFor(card, inventory, true).locations).toEqual([{ name: 'Deck', isProxy: false }]);
    expect(inventory[0].locations).toHaveLength(2);
  });
});

describe('physical proxy records retain their printing identities and quantities', () => {
  it('never replaces selected printing metadata with a generic lookup', () => {
    const parsed = parse('1 Sol Ring (c21) 263\n1 Arcane Signet');
    const map = new Map([['sol ring', { scryfallId: 'wrong', oracleId: 'oracle-a', setCode: 'lea', collectorNumber: '1' }], ['arcane signet', { scryfallId: 'random', oracleId: 'oracle-b' }]]);
    let result = deckBridgeCards(parsed, map);
    expect(result[0].card).toMatchObject({ scryfallId: null, oracleId: 'oracle-a', setCode: 'c21', collectorNumber: '263' });
    expect(result[1].card.scryfallId).toBeNull();
    map.set('sol ring|c21|263|nonfoil', { scryfallId: 'exact', oracleId: 'oracle-a', setCode: 'c21', collectorNumber: '263' });
    result = deckBridgeCards(parsed, map);
    expect(result[0].card.scryfallId).toBe('exact');
  });

  it('retains original raw-line quantities, set and finish for physical reporting', () => {
    const text = '1 Sol Ring (CMM) 410\n2 Sol Ring (CMM) 410 *F*\n1 Sol Ring (LCC) 410';
    const map = new Map([
      ['sol ring|cmm|410|nonfoil', { scryfallId: 'cmm-id', oracleId: 'oracle-a', setCode: 'cmm', collectorNumber: '410' }],
      ['sol ring|cmm|410|foil', { scryfallId: 'cmm-id', oracleId: 'oracle-a', setCode: 'cmm', collectorNumber: '410' }],
      ['sol ring|lcc|410|nonfoil', { scryfallId: 'lcc-id', oracleId: 'oracle-a', setCode: 'lcc', collectorNumber: '410' }],
    ]);
    expect(deckBridgeCards(parse(text), map, text).map(row => [row.quantity, row.card.scryfallId, row.card.finish])).toEqual([[1, 'cmm-id', 'nonfoil'], [2, 'cmm-id', 'foil'], [1, 'lcc-id', 'nonfoil']]);
  });

  it('normalizes Unicode names and collector casing while preserving unresolved exact IDs', () => {
    const text = "1 Eowyn’s Sword (LTR) 4A *F*\n1 Sol Ring (C21) 263";
    const map = new Map([["eowyn's sword|ltr|4a|foil", { scryfallId: 'exact', oracleId: 'oracle-sword', setCode: 'ltr', collectorNumber: '4a' }], ['sol ring|c21|263|nonfoil', { type: 'Other' }], ['sol ring', { scryfallId: 'wrong', oracleId: 'oracle-ring', setCode: 'lea', collectorNumber: '1' }]]);
    for (const deckText of [text, undefined]) {
      const cards = deckBridgeCards(parse(text), map, deckText);
      expect(cards[0].card).toMatchObject({ scryfallId: 'exact', oracleId: 'oracle-sword', finish: 'foil' });
      expect(cards[1].card).toMatchObject({ scryfallId: null, oracleId: 'oracle-ring', setCode: 'C21', collectorNumber: '263' });
    }
  });

  it('preserves separate CSV printing rows and excludes maybeboard cards', () => {
    const text = 'Name,Quantity,Set,Collector Number,Finish,Board\nSol Ring,1,CMM,410,nonfoil,mainboard\nSol Ring,2,CMM,410,foil,sideboard\nSol Ring,3,CMM,410,nonfoil,maybeboard';
    expect(deckBridgeCards(parse(text), new Map(), text).map(row => [row.quantity, row.section, row.card.finish])).toEqual([[1, 'mainboard', 'nonfoil'], [2, 'sideboard', 'foil']]);
  });
});

describe('reviewed full and diff print lists', () => {
  const target = 'Commander\n1 Partner\n\n5 Sol Ring (CMM) 410\n2 Island\nSideboard\n2 Negate';
  const baseline = 'Commander\n1 Partner\n\n2 Sol Ring (CMM) 410\n2 Island\nSideboard\n1 Negate';
  const map = new Map(['Sol Ring', 'Island', 'Partner', 'Negate'].map(name => [name.toLowerCase(), { oracleId: name.toLowerCase() }]));

  it.each([
    ['full', false, [['Sol Ring', 5], ['Island', 2], ['Partner', 1]]],
    ['full', true, [['Sol Ring', 5], ['Island', 2], ['Partner', 1], ['Negate', 2]]],
    ['changes', false, [['Sol Ring', 3]]],
    ['changes', true, [['Sol Ring', 3], ['Negate', 1]]],
  ])('preserves %s physical quantities with sideboard=%s while shopping for one original each', (mode, includeSideboard, expected) => {
    const plan = { mode, includeSideboard, cards: planPhysicalCopies(target, mode === 'changes' ? baseline : null, { includeSideboard }) };
    const rows = printPlanBridgeCards(plan, map);
    expect(rows.map(row => [row.card.name, row.quantity])).toEqual(expected);
    expect(shoppingText(withOriginalOwnership(rows, [], true))).toBe(expected.map(([name]) => `1 ${name}`).join('\n'));
  });

  it('does not substitute the target deck for an empty reviewed change list', () => {
    const rows = printPlanBridgeCards({ cards: [], target: { text: target } }, map);
    expect(rows).toEqual([]);
    expect(shoppingText(withOriginalOwnership(rows, [], true))).toBe('');
  });

  it('uses resolved preview identities without changing physical nonfoil output', () => {
    const plan = { cards: planPhysicalCopies('1 Sol Ring (CMM) 410 *F*\n2 Sol Ring (CMM) 410'),
      resolvedCards: [{ oracleId: 'oracle-a', scryfallId: 'cmm-print' }] };
    const rows = printPlanBridgeCards(plan, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 3, card: { finish: 'nonfoil', scryfallId: 'cmm-print', oracleId: 'oracle-a' } });
    expect(shoppingText(withOriginalOwnership(rows, [original], true))).toBe('');
    expect(shoppingText(withOriginalOwnership(rows, [], true))).toBe('1 Sol Ring');
  });
});
