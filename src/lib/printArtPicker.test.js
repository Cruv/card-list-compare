import { describe, it, expect, vi } from 'vitest';
import { printingChoice, loadPrintArtPage, filterPrintArt, MAX_ART_PAGES } from './printArtPicker';

const oracle = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const image = { normal: 'https://cards.scryfall.io/normal/front/test.jpg' };
const single = { id, oracle_id: oracle, name: 'Sol Ring', set: 'c21', set_name: 'Commander 2021', collector_number: '263', image_uris: image };

describe('print artwork choices', () => {
  it('returns an exact printing with its original identity and preview', () => {
    expect(printingChoice(single, oracle)).toMatchObject({ id, setCode: 'c21', collectorNumber: '263', faces: [{ face: 'front', url: image.normal }] });
  });
  it('keeps both DFC faces together and refuses an incomplete back', () => {
    const dfc = { ...single, image_uris: undefined, card_faces: [{ name: 'Front', image_uris: image }, { name: 'Back', image_uris: image }] };
    expect(printingChoice(dfc, oracle).faces.map(face => face.face)).toEqual(['front', 'back']);
    dfc.card_faces[1].image_uris = undefined;
    expect(printingChoice(dfc, oracle)).toBeNull();
    expect(printingChoice({ ...dfc, card_faces: [dfc.card_faces[0]] }, oracle)).toBeNull();
  });
  it('does not offer wrong-card, invalid-ID, digital or untrusted preview choices', () => {
    expect(printingChoice({ ...single, oracle_id: id }, oracle)).toBeNull();
    expect(printingChoice({ ...single, id: 'not-an-id' }, oracle)).toBeNull();
    expect(printingChoice({ ...single, digital: true }, oracle)).toBeNull();
    expect(printingChoice({ ...single, image_uris: { normal: 'https://example.com/image.jpg' } }, oracle)).toBeNull();
  });
  it('filters loaded artwork by set, collector or artist without changing the source', () => {
    const choice = printingChoice({ ...single, artist: 'Mark Tedin' }, oracle), values = [choice];
    for (const query of ['C21', '263', 'TEDIN']) expect(filterPrintArt(values, query)).toEqual(values);
    expect(filterPrintArt(values, 'none')).toEqual([]); expect(values).toEqual([choice]);
  });
  it('builds every page locally with a fixed oracle query and ignores remote next_page URLs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [single], has_more: true, total_cards: 176, next_page: 'https://example.com/steal' }) });
    const controller = new AbortController();
    expect(await loadPrintArtPage(oracle, 2, { fetchImpl, signal: controller.signal })).toMatchObject({ hasMore: true, total: 176, choices: [{ id }] });
    const [url, options] = fetchImpl.mock.calls[0], params = new URL(url, 'http://fixture').searchParams;
    expect(url.startsWith('/api/scryfall/cards/search?')).toBe(true);
    expect(params.get('q')).toBe(`oracleid:${oracle} game:paper lang:en`);
    expect(params.get('unique')).toBe('prints'); expect(params.get('page')).toBe('2');
    expect(options.signal).toBe(controller.signal);
  });
  it('rejects out-of-range requests before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(loadPrintArtPage('arbitrary query', 1, { fetchImpl })).rejects.toThrow('identity');
    await expect(loadPrintArtPage(oracle, MAX_ART_PAGES + 1, { fetchImpl })).rejects.toThrow('range');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('distinguishes empty searches from failed or malformed responses', async () => {
    expect(await loadPrintArtPage(oracle, 1, { fetchImpl: async () => ({ status: 404 }) })).toEqual({ choices: [], hasMore: false, total: 0 });
    await expect(loadPrintArtPage(oracle, 1, { fetchImpl: async () => ({ ok: false, status: 503 }) })).rejects.toThrow('could not load');
    await expect(loadPrintArtPage(oracle, 1, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{}] }) }) })).rejects.toThrow('incomplete');
  });
});
