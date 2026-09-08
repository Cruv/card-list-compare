import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse } from './parser.js';
import { computeDiff } from './differ.js';
import { cardIdentityKey } from './cardIdentity.js';
import { fetchCardData, clearCardCache, primaryType, collectDeckIdentifiers, collectCardIdentifiers, cardDataForEntry } from './scryfall.js';

const DFC_CARD = {
  name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki',
  type_line: 'Enchantment — Saga // Legendary Artifact Creature — Goblin',
  set: 'neo',
  collector_number: '141',
  card_faces: [
    { image_uris: { normal: 'https://img/front.jpg' }, mana_cost: '{2}{R}' },
    { type_line: 'Legendary Artifact Creature — Goblin Shaman' },
  ],
  prices: { usd: '5.00', usd_foil: '9.00' },
  color_identity: ['R'],
};

beforeEach(() => {
  clearCardCache();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [DFC_CARD], not_found: [] }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCardData DFC front-face aliasing (audit H6)', () => {
  it('populates the front-face key when a DFC is requested by its front name', async () => {
    const map = await fetchCardData(['Fable of the Mirror-Breaker']);
    const entry = map.get('fable of the mirror-breaker');
    expect(entry).toBeTruthy();
    expect(entry.type).toBe('Enchantment'); // not the 'Other' fallback
    expect(entry.imageUri).toBe('https://img/front.jpg');
    expect(entry.manaCost).toBe('{2}{R}');
  });

  it('also populates the full "front // back" key', async () => {
    const map = await fetchCardData(['Fable of the Mirror-Breaker // Reflection of Kiki-Jiki']);
    const entry = map.get('fable of the mirror-breaker // reflection of kiki-jiki');
    expect(entry?.type).toBe('Enchantment');
    expect(entry?.imageUri).toBe('https://img/front.jpg');
  });
});

describe('primaryType', () => {
  it('uses the front face of a DFC type_line', () => {
    expect(primaryType('Enchantment — Saga // Legendary Artifact Creature — Goblin')).toBe('Enchantment');
  });
  it('prioritizes Creature over Artifact/Enchantment', () => {
    expect(primaryType('Artifact Creature — Golem')).toBe('Creature');
  });
});

function mockCards(cards) {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ data: cards }) });
}

function bolt(set, image = set) {
  return { name: 'Lightning Bolt', set, collector_number: '146',
    type_line: 'Instant', image_uris: { normal: `https://img/${image}.jpg` },
    prices: { usd: set === 'm10' ? '2.00' : '4.00', usd_foil: '9.00' },
  };
}

describe('complete printing lookups', () => {
  it('keeps the same collector number across sets and both finishes distinct', async () => {
    const deck = parse('1 Lightning Bolt (m10) [146]\n1 Lightning Bolt (m11) [146]\n1 Lightning Bolt (m10) [146] *F*');
    mockCards([bolt('m10'), bolt('m11')]);
    const map = await fetchCardData(collectDeckIdentifiers(deck));
    for (const card of deck.mainboard.values()) {
      expect(cardDataForEntry(map, card)?.imageUri).toBe(`https://img/${card.setCode}.jpg`);
      expect(cardDataForEntry(map, card)?.priceUsdFoil).toBe(9);
    }
    expect(map.get('lightning bolt|m10|146|foil')).toBeTruthy();
    expect(map.get('lightning bolt|m10|146|nonfoil')).toBeTruthy();
  });

  it('requests both sides of a printing-only change', async () => {
    const diff = computeDiff(parse('1 Lightning Bolt (m10) [146]'), parse('1 Lightning Bolt (m11) [146] *F*'));
    const identifiers = collectCardIdentifiers(diff);
    expect(identifiers.has('lightning bolt|m10|146|nonfoil')).toBe(true);
    expect(identifiers.has('lightning bolt|m11|146|foil')).toBe(true);
    mockCards([bolt('m10'), bolt('m11')]);
    const map = await fetchCardData(identifiers);
    expect(map.get('lightning bolt|m11|146|foil').priceUsd).toBe(4);
  });

  it('keeps set-only lookups scoped to the requested set', async () => {
    const deck = parse('1 Lightning Bolt (m11)');
    mockCards([bolt('m10'), bolt('m11')]);
    const map = await fetchCardData(collectDeckIdentifiers(deck));
    expect(cardDataForEntry(map, [...deck.mainboard.values()][0]).imageUri).toBe('https://img/m11.jpg');
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers).toContainEqual({ name: 'Lightning Bolt', set: 'm11' });
  });

  it('does not fill a missing printing from a generic name or cache failures', async () => {
    const deck = parse('1 Lightning Bolt (m11) [146]');
    const card = [...deck.mainboard.values()][0];
    mockCards([bolt('m10')]);
    const map = await fetchCardData(collectDeckIdentifiers(deck));
    expect(map.get('lightning bolt').imageUri).toBeTruthy();
    expect(cardDataForEntry(map, card).imageUri).toBe('');
    expect(cardDataForEntry(new Map([['lightning bolt', bolt('m10')]]), card)).toBeUndefined();
    mockCards([bolt('m11')]);
    expect((await fetchCardData(collectDeckIdentifiers(deck))).get(cardIdentityKey(card)).imageUri).toBe('https://img/m11.jpg');
  });

  it('rejects a set/collector response for a different card name', async () => {
    mockCards([{ ...bolt('m10'), name: 'Grizzly Bears' }]);
    const deck = parse('1 Lightning Bolt (m10) [146]');
    const map = await fetchCardData(collectDeckIdentifiers(deck));
    expect(cardDataForEntry(map, [...deck.mainboard.values()][0]).imageUri).toBe('');
  });

  it('matches unaccented requested names to accented Scryfall responses without changing identity', async () => {
    mockCards([{ name: 'Nazgûl', set: 'ltr', collector_number: '100',
      type_line: 'Creature', image_uris: { normal: 'https://img/nazgul.jpg' },
      prices: { usd: '3.00' },
    }]);
    const deck = parse('1 Nazgul (ltr) [100]');
    const card = [...deck.mainboard.values()][0];
    const map = await fetchCardData(collectDeckIdentifiers(deck));
    expect(cardDataForEntry(map, card).imageUri).toBe('https://img/nazgul.jpg');
    expect(map.get('nazgul').priceUsd).toBe(3);
    expect(cardIdentityKey(card)).toBe('nazgul|ltr|100|nonfoil');
    expect(map.has('nazgûl|ltr|100|nonfoil')).toBe(false);
  });

  it('keeps generic name pricing separate from a requested expensive printing, including cache reuse', async () => {
    fetch.mockImplementation(async (_url, options) => {
      const { identifiers } = JSON.parse(options.body);
      return { ok: true, json: async () => ({ data: identifiers.map(identifier => identifier.set
        ? { ...bolt('m10'), prices: { usd: '100.00' } }
        : { ...bolt('clu'), prices: { usd: '1.00' } }),
      }) };
    });
    const deck = parse('1 Lightning Bolt (m10) [146]');
    const card = [...deck.mainboard.values()][0];
    const identifiers = collectDeckIdentifiers(deck);
    const map = await fetchCardData(identifiers);
    expect(cardDataForEntry(map, card).priceUsd).toBe(100);
    expect(map.get('lightning bolt').priceUsd).toBe(1);
    const calls = fetch.mock.calls.length;
    const cachedMap = await fetchCardData(identifiers);
    expect(cardDataForEntry(cachedMap, card).priceUsd).toBe(100);
    expect(cachedMap.get('lightning bolt').priceUsd).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('preserves land-back classification through lookup and cache', async () => {
    mockCards([{ ...DFC_CARD, card_faces: [DFC_CARD.card_faces[0], { type_line: 'Land' }] }]);
    const map = await fetchCardData([DFC_CARD.name]);
    expect(map.get(DFC_CARD.name.toLowerCase()).isBackLand).toBe(true);
    await fetchCardData([DFC_CARD.name]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries unresolved full DFC names by front name', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    const map = await fetchCardData([DFC_CARD.name]);
    expect(map.get(DFC_CARD.name.toLowerCase()).imageUri).toBeTruthy();
    expect(JSON.parse(fetch.mock.calls[1][1].body).identifiers[0].name).toBe('fable of the mirror-breaker');
  });

  it('does not shorten full split-card names that resolve successfully', async () => {
    const name = 'Who // What // When // Where // Why';
    mockCards([{ name, type_line: 'Instant', image_uris: { normal: 'https://img/split.jpg' } }]);
    expect((await fetchCardData([name])).get(name.toLowerCase()).imageUri).toBe('https://img/split.jpg');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers[0].name).toBe(name);
  });

  it('prefers a real single-faced card over a reversible front alias', async () => {
    mockCards([
      { name: 'Forest // Forest', image_uris: { normal: 'https://img/reversible.jpg' } },
      { name: 'Forest', image_uris: { normal: 'https://img/forest.jpg' } },
    ]);
    expect((await fetchCardData(['Forest'])).get('forest').imageUri).toBe('https://img/forest.jpg');
  });
});
