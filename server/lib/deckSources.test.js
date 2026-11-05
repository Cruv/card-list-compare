import { describe, expect, it } from 'vitest';
import { normalizeDeckSourceLink, parseDeckSourceUrl } from './deckSources.js';

describe('canonical provider deck identities', () => {
  it('treats presentation URLs as one provider deck while preserving case-sensitive public IDs', () => {
    expect(parseDeckSourceUrl('http://www.archidekt.com/decks/000123/a-title?share=1#cards'))
      .toEqual({ provider: 'archidekt', deckId: '123', url: 'https://archidekt.com/decks/123' });
    expect(parseDeckSourceUrl('https://www.moxfield.com/decks/aBc_-D?utm_source=test'))
      .toEqual({ provider: 'moxfield', deckId: 'aBc_-D', url: 'https://moxfield.com/decks/aBc_-D' });
    for (const path of ['app/deckview', 'deck/share', 'builder/embed']) {
      expect(parseDeckSourceUrl(`https://deckcheck.co/${path}/deck-title-12345678-1234-ABCD-ABCD-123456789ABC`))
        .toEqual({ provider: 'deckcheck', deckId: '12345678-1234-abcd-abcd-123456789abc', url: 'https://deckcheck.co/deck/12345678-1234-abcd-abcd-123456789abc' });
    }
    expect(parseDeckSourceUrl('https://deckcheck.co/deck/opaque550e8400-e29b-41d4-a716-446655440000').deckId)
      .toBe('opaque550e8400-e29b-41d4-a716-446655440000');
  });

  it('rejects foreign hosts, credentials, ports, unsafe paths and contradictory source claims', () => {
    for (const url of ['https://archidekt.com.evil.test/decks/1', 'https://user:pass@archidekt.com/decks/1',
      'https://archidekt.com:8080/decks/1', 'file://archidekt.com/decks/1', 'https://archidekt.com/decks/0',
      'https://moxfield.com/decks/%2fother', 'https://deckcheck.co/deck/%ZZ']) expect(parseDeckSourceUrl(url)).toBeNull();
    for (const source of [
      { provider: 'moxfield', deckId: '1', url: 'https://archidekt.com/decks/1' },
      { provider: 'archidekt', deckId: '2', url: 'https://archidekt.com/decks/1' },
      { provider: 'archidekt', deckId: '1', url: 'https://archidekt.com/decks/1', account: 2 },
    ]) expect(normalizeDeckSourceLink(source)).toBeNull();
    expect(normalizeDeckSourceLink({ provider: 'archidekt', deckId: '001', url: 'https://archidekt.com/decks/1/title' }))
      .toEqual({ provider: 'archidekt', deckId: '1', url: 'https://archidekt.com/decks/1' });
  });

  it('tracks the reported DeckCheck builder URL under the same identity as its viewing and sharing links', () => {
    const expected = { provider: 'deckcheck', deckId: 'zynmTJxDKo28', url: 'https://deckcheck.co/deck/zynmTJxDKo28' };
    for (const path of ['app/builder', 'app/deckview', 'deck/share', 'builder/embed', 'deck']) {
      const url = `https://deckcheck.co/${path}/zynmTJxDKo28?tab=cards`;
      expect(parseDeckSourceUrl(url)).toEqual(expected);
      expect(normalizeDeckSourceLink({ provider: 'deckcheck', deckId: 'zynmTJxDKo28', url })).toEqual(expected);
    }
  });
});
