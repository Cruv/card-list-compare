import { afterEach, expect, it, vi } from 'vitest';
import { moxfieldSource, deckcheckSource, fetchTrackedProviderSource } from './trackedProviderSource.js';
import { parse } from '../../src/lib/parser.js';
afterEach(() => vi.unstubAllGlobals());
const mox = () => ({ name: 'Mox source', boards: {
  commanders: { cards: { a: { quantity: 1, finish: 'foil', card: { name: 'Commander', set: 'ABC', cn: '1' } } } },
  mainboard: { cards: { b: { quantity: 2, finish: 'nonFoil', card: { name: 'Island', set: 'ABC', cn: '2' } } } },
  sideboard: { cards: { c: { quantity: 1, card: { name: 'Negate' } } } }
} });
it('preserves playable boards, exact supplied printing metadata and foil, and permits a verified empty source', () => {
  expect(moxfieldSource(mox())).toMatchObject({ commanders: ['Commander'], rawText: 'Commander\n1 Commander (ABC) [1] *F*\n\n2 Island (ABC) [2]\n\nSideboard\n1 Negate' });
  expect(moxfieldSource({ boards: { mainboard: { cards: {} } } }).rawText).toBe('');
  expect(deckcheckSource({ cards: { Leader: 1, Island: 2 }, commanders: ['Leader'], sideboard: { Negate: 1 } })).toMatchObject({ commanders: ['Leader'], rawText: 'Commander\n1 Leader\n\n2 Island\n\nSideboard\n1 Negate' });
  expect(deckcheckSource({ cards: {}, commanders: [] }).rawText).toBe('');
});
it('rejects missing lists, unsupported finishes and malformed quantities instead of creating a false empty or foil snapshot', () => {
  const etched = mox(); etched.boards.mainboard.cards.b.finish = 'etched';
  expect(() => moxfieldSource(etched)).toThrow('etched');
  for (const data of [{}, { boards: {} }, { boards: { mainboard: {} } }, { boards: { unknown: { cards: {} } } }]) expect(() => moxfieldSource(data)).toThrow();
  for (const data of [{}, { cards: { Island: 0 } }, { cards: { Island: 1.5 } }, { cards: { 'Fake\n1 Card': 1 } }]) expect(() => deckcheckSource(data)).toThrow();
});
it.each(['123★', '123/456', '123.4', '123[4', '123\\4'])('rejects collector %s before the shared parser can lose its identity', collector => {
  const data = mox(); data.boards.mainboard.cards.b.card.cn = collector;
  expect(() => moxfieldSource(data)).toThrow(expect.objectContaining({ code: 'incomplete_source' }));
});
it.each(['136p', 'DDO-20', '2022-3', 'A_12'])('preserves supported collector %s through the shared parser', collector => {
  const data = mox(); data.boards.mainboard.cards.b.card.cn = collector;
  const parsed = parse(moxfieldSource(data).rawText);
  const island = [...parsed.mainboard.values()].find(card => card.displayName === 'Island');
  expect(island).toMatchObject({ quantity: 2, setCode: 'ABC', collectorNumber: collector, isFoil: false });
});
it('uses bounded, fixed provider endpoints and refuses redirects and unreadable responses', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(mox()), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  await fetchTrackedProviderSource({ provider: 'moxfield', deckId: 'AbC_-', url: 'https://evil.invalid' });
  expect(fetcher).toHaveBeenCalledWith('https://api2.moxfield.com/v3/decks/all/AbC_-', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  fetcher.mockResolvedValue(new Response('private', { status: 403 }));
  await expect(fetchTrackedProviderSource({ provider: 'moxfield', deckId: 'AbC_-' })).rejects.toThrow('unavailable');
  fetcher.mockResolvedValue(new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }));
  await expect(fetchTrackedProviderSource({ provider: 'moxfield', deckId: 'AbC_-' })).rejects.toThrow();
});
