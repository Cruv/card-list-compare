import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCardData, clearCardCache, primaryType } from './scryfall.js';

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
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [DFC_CARD], not_found: [] }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
