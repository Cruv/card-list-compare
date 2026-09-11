import { describe, expect, it } from 'vitest';
import { parseDeckCheckId } from './deckcheck.js';

describe('shared DeckCheck URL identities', () => {
  it('accepts the reported builder link and equivalent view/share/embed routes', () => {
    for (const prefix of ['', 'app/']) {
      for (const route of ['deck', 'deckview', 'builder']) {
        for (const sharing of ['', 'share/', 'embed/']) {
          expect(parseDeckCheckId(`https://deckcheck.co/${prefix}${route}/${sharing}zynmTJxDKo28?tab=cards#list`)).toBe('zynmTJxDKo28');
        }
      }
    }
    expect(parseDeckCheckId('  http://www.deckcheck.co/app/builder/zynmTJxDKo28  ')).toBe('zynmTJxDKo28');
  });
  it('normalizes a UUID suffix while preserving case-sensitive opaque IDs', () => {
    expect(parseDeckCheckId('https://deckcheck.co/deck/slug-12345678-1234-ABCD-ABCD-123456789ABC')).toBe('12345678-1234-abcd-abcd-123456789abc');
    expect(parseDeckCheckId('https://deckcheck.co/deck/12345678-1234-ABCD-ABCD-123456789ABC')).toBe('12345678-1234-abcd-abcd-123456789abc');
    expect(parseDeckCheckId('https://deckcheck.co/deck/opaque550e8400-e29b-41d4-a716-446655440000')).toBe('opaque550e8400-e29b-41d4-a716-446655440000');
  });
  it.each([
    'https://deckcheck.co.evil.test/app/builder/zynmTJxDKo28',
    'https://evil.test/?url=https://deckcheck.co/app/builder/zynmTJxDKo28',
    'https://user:pass@deckcheck.co/app/builder/zynmTJxDKo28',
    'https://deckcheck.co:8080/app/builder/zynmTJxDKo28',
    'file://deckcheck.co/app/builder/zynmTJxDKo28',
    'https://deckcheck.co/app/power/zynmTJxDKo28',
    'https://deckcheck.co/app/builder/',
    'https://deckcheck.co/app/builder/%2Fother',
    'https://deckcheck.co/app/builder/%ZZ',
    'https://deckcheck.co/deck/' + 'x'.repeat(201),
    null,
  ])('rejects unsafe or unsupported source %s', url => {
    expect(parseDeckCheckId(url)).toBeNull();
  });
});
