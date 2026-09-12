import { MAX_IMAGE_BYTES } from './imageValidation.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCardImageUrls, downloadCardImages, downloadCardImagesWithCache, ImageCompletenessError,
} from './scryfallImages.js';

const cache = vi.hoisted(() => ({
  getCachedImage: vi.fn(), getCachedImageByName: vi.fn(), cacheImage: vi.fn(), cacheImageByName: vi.fn(),
}));
vi.mock('./imageCache.js', () => cache);

// A real 1x1 PNG keeps invalid/truncated response tests distinct from good bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const image = (body = PNG, type = 'image/png', status = 200) => new Response(body, { status, headers: { 'Content-Type': type } });
const card = (overrides = {}) => ({ displayName: 'Lightning Bolt', quantity: 1, setCode: 'm10', collectorNumber: '146', ...overrides });
const dataCard = (overrides = {}) => ({ name: 'Lightning Bolt', set: 'm10', collector_number: '146', image_uris: { png: 'https://images.test/bolt.png' }, ...overrides });
const resolved = (overrides = {}) => card({ imageUrls: { front: 'https://images.test/front.png' }, isDFC: false, ...overrides });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const getter of [cache.getCachedImage, cache.getCachedImageByName]) getter.mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Attach a rejection handler immediately so fake timers cannot create an unhandled rejection.
async function settle(promise) {
  const settled = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  return settled;
}
function metadata(data, not_found = []) {
  fetch.mockResolvedValue(new Response(JSON.stringify({ data, not_found }), { headers: { 'Content-Type': 'application/json' } }));
}

describe('Scryfall lookup completeness', () => {
  it('resolves an explicit selected ID without falling back to the original printing', async () => {
    const requestedScryfallId = 'a1111111-1111-4111-8111-111111111111';
    metadata([dataCard({ id: requestedScryfallId, set: 'lea', collector_number: '161' })]);
    const { value } = await settle(fetchCardImageUrls([card({ requestedScryfallId, selectionKey: 'original-key', baseQuantity: 1 })]));
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers).toEqual([{ id: requestedScryfallId }]);
    expect(value[0]).toMatchObject({ selectionKey: 'original-key', baseQuantity: 1, requestedScryfallId, scryfallId: requestedScryfallId, setCode: 'lea', collectorNumber: '161' });
    metadata([dataCard({ id: 'b2222222-2222-4222-8222-222222222222' })]);
    const wrongId = await settle(fetchCardImageUrls([card({ requestedScryfallId })]));
    expect(wrongId.error.failures[0].reason).toContain('Selected printing');
    metadata([dataCard({ id: requestedScryfallId, name: 'Giant Growth' })]);
    const wrongCard = await settle(fetchCardImageUrls([card({ requestedScryfallId })]));
    expect(wrongCard.error.failures[0].reason).toContain('does not match');
  });
  it('resolves both faces of a selected ID requested through its back-face alias', async () => {
    const requestedScryfallId = 'a1111111-1111-4111-8111-111111111111';
    metadata([dataCard({ id: requestedScryfallId, name: 'Malakir Rebirth // Malakir Mire', set: 'znr', collector_number: '111', image_uris: undefined,
      card_faces: [{ name: 'Malakir Rebirth', image_uris: { png: 'front.png' } }, { name: 'Malakir Mire', image_uris: { png: 'back.png' } }] })]);
    const { value } = await settle(fetchCardImageUrls([card({ displayName: 'Malakir Mire', requestedScryfallId })]));
    expect(value[0]).toMatchObject({ requestedScryfallId, isDFC: true, imageUrls: { front: 'front.png', back: 'back.png' } });
  });
  it('fails the whole lookup with specific missing printing and copy count', async () => {
    metadata([dataCard()], [{ set: 'lea', collector_number: '999' }]);
    const { error } = await settle(fetchCardImageUrls([card(), card({ setCode: 'lea', collectorNumber: '999', quantity: 3 })]));
    expect(error).toBeInstanceOf(ImageCompletenessError);
    expect(error.failures).toEqual([expect.objectContaining({ setCode: 'lea', collectorNumber: '999', quantity: 3, face: 'card' })]);
    expect(error.message).toContain('3x Lightning Bolt (lea #999)');
  });

  it('rejects a printing whose set/collector identifies a different named card', async () => {
    metadata([dataCard({ name: 'Giant Growth' })]);
    const { error } = await settle(fetchCardImageUrls([card()]));
    expect(error).toBeInstanceOf(ImageCompletenessError);
    expect(error.failures[0]).toMatchObject({ displayName: 'Lightning Bolt', setCode: 'm10', collectorNumber: '146' });
  });

  it('rejects a collector number without a set rather than picking generic art', async () => {
    const { error } = await settle(fetchCardImageUrls([card({ setCode: '' })]));
    expect(error.message).toContain('Collector number requires a set code');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('matches alphanumeric collector numbers case-insensitively while preserving the resolved printing', async () => {
    metadata([dataCard({ name: 'Mother of Runes', set: 'plst', collector_number: 'DDO-20' })]);
    const { value } = await settle(fetchCardImageUrls([card({ displayName: 'Mother of Runes', setCode: 'PLST', collectorNumber: 'ddo-20' })]));
    expect(value[0]).toMatchObject({ displayName: 'Mother of Runes', setCode: 'plst', collectorNumber: 'DDO-20' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers).toContainEqual({ set: 'plst', collector_number: 'DDO-20' });
  });

  it('rejects more than 1000 aggregated copies before a lookup, including separate printings', async () => {
    const { error } = await settle(fetchCardImageUrls([card({ quantity: 600 }), card({ quantity: 401, collectorNumber: '147' })]));
    expect(error.message).toContain('at most 1000 physical card copies');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps generic and exact requests to the same returned card without dropping either', async () => {
    metadata([dataCard()]);
    const { value } = await settle(fetchCardImageUrls([card({ setCode: '', collectorNumber: '', quantity: 2 }), card({ quantity: 3 })]));
    expect(value.map(c => c.quantity)).toEqual([2, 3]);
    expect(value.every(c => c.setCode === 'm10' && c.collectorNumber === '146')).toBe(true);
  });

  it('does not substitute a name match for a missing specified printing', async () => {
    metadata([dataCard({ set: 'lea', collector_number: '161' })]);
    const { error } = await settle(fetchCardImageUrls([card()]));
    expect(error.failures[0].collectorNumber).toBe('146');
  });

  it('preserves set restrictions without a collector number and normalizes accents', async () => {
    metadata([dataCard({ name: 'Nazgûl', set: 'ltr', collector_number: '100' })]);
    const { value } = await settle(fetchCardImageUrls([card({ displayName: 'Nazgul', setCode: 'LTR', collectorNumber: '' })]));
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers).toEqual([{ name: 'Nazgul', set: 'ltr' }]);
    expect(value[0].collectorNumber).toBe('100');
  });

  it('queries full split and front-face DFC names and keeps their distinct face counts', async () => {
    metadata([
      dataCard({ name: 'Who // What // When // Where // Why', set: 'und', collector_number: '75' }),
      dataCard({ name: 'Malakir Rebirth // Malakir Mire', set: 'znr', collector_number: '111', image_uris: undefined,
        card_faces: [{ name: 'Malakir Rebirth', image_uris: { png: 'front' } }, { name: 'Malakir Mire', image_uris: { png: 'back' } }] }),
    ]);
    const requests = ['Who // What // When // Where // Why', 'Malakir Rebirth // Malakir Mire'].map(displayName => card({ displayName, setCode: '', collectorNumber: '' }));
    const { value } = await settle(fetchCardImageUrls(requests));
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers.map(i => i.name)).toEqual([
      'Who', 'Who // What // When // Where // Why', 'Malakir Rebirth', 'Malakir Rebirth // Malakir Mire',
    ]);
    expect(value.map(c => c.isDFC)).toEqual([false, true]);
  });

  it('reports an absent DFC back URL instead of throwing on missing image_uris', async () => {
    metadata([dataCard({ image_uris: undefined, card_faces: [{ image_uris: { png: 'front' } }, {}] })]);
    const { error } = await settle(fetchCardImageUrls([card({ quantity: 2 })]));
    expect(error.failures).toEqual([expect.objectContaining({ face: 'back', quantity: 2, reason: 'No image URL available' })]);
  });

  it('returns complete and unresolved review rows in order without weakening strict downloads', async () => {
    metadata([dataCard({ layout: 'normal' })]);
    const requested = [card(), card({ collectorNumber: '999', quantity: 2 }), card({ displayName: 'Sol Ring', setCode: '', collectorNumber: '1' })];
    const { value } = await settle(fetchCardImageUrls(requested, { allowIncomplete: true }));
    expect(value.map(item => item.quantity)).toEqual([1, 2, 1]);
    expect(value[0]).toMatchObject({ layout: 'normal', lookupFailures: [] });
    expect(value[1].lookupFailures[0].reason).toContain('not found');
    expect(value[2].lookupFailures[0].reason).toContain('Collector number requires a set');
    expect(JSON.parse(fetch.mock.calls[0][1].body).identifiers).not.toContainEqual({ name: 'Sol Ring' });
  });

  it('preserves actual meld layout and both DFC thumbnail identities for review', async () => {
    metadata([
      dataCard({ name: 'Bruna, the Fading Light', layout: 'meld' }),
      dataCard({ name: 'Malakir Rebirth // Malakir Mire', layout: 'modal_dfc', set: 'znr', collector_number: '111', image_uris: undefined,
        card_faces: [{ name: 'Malakir Rebirth', image_uris: { png: 'front.png', normal: 'front.jpg' } },
          { name: 'Malakir Mire', image_uris: { png: 'back.png', normal: 'back.jpg' } }] }),
    ]);
    const { value } = await settle(fetchCardImageUrls([
      card({ displayName: 'Bruna, the Fading Light' }), card({ displayName: 'Malakir Rebirth', setCode: 'znr', collectorNumber: '111' }),
    ], { allowIncomplete: true }));
    expect(value[0].layout).toBe('meld');
    expect(value[1]).toMatchObject({ isDFC: true, layout: 'modal_dfc', faceNames: ['Malakir Rebirth', 'Malakir Mire'],
      thumbnailUrls: { front: 'front.jpg', back: 'back.jpg' }, imageUrls: { front: 'front.png', back: 'back.png' } });
  });

  it('retries transient batch failures and lists every unresolved card if a batch stays unavailable', async () => {
    fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    const { error } = await settle(fetchCardImageUrls([card(), card({ collectorNumber: '147' })]));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error.failures).toHaveLength(2);
    expect(error.message).toContain('HTTP 503');
  });

  it('aborts Retry-After waits at the review deadline without retrying or starting later batches', async () => {
    fetch.mockImplementation(async () => new Response('busy', { status: 429, headers: { 'Retry-After': '30' } }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Review metadata deadline expired')), 1000);
    const { value } = await settle(fetchCardImageUrls(Array.from({ length: 76 }, (_, n) => card({ collectorNumber: String(n + 1) })), { allowIncomplete: true, signal: controller.signal }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(value).toHaveLength(76);
    expect(value.every(card => card.lookupFailures[0].reason.includes('deadline expired'))).toBe(true);
  });

  it('resolves all cards across batches of at most 75 identifiers', async () => {
    fetch.mockImplementation(async (_url, options) => {
      const { identifiers } = JSON.parse(options.body);
      expect(identifiers.length).toBeLessThanOrEqual(75);
      return new Response(JSON.stringify({ data: identifiers.map(i => dataCard({ collector_number: i.collector_number })) }));
    });
    const { value } = await settle(fetchCardImageUrls(Array.from({ length: 76 }, (_, n) => card({ collectorNumber: String(n + 1) }))));
    expect(value).toHaveLength(76);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('physical image and face completeness', () => {
  it('counts both DFC faces per copy, preserves pairs, and downloads each URL once', async () => {
    fetch.mockImplementation(async () => image());
    const progress = vi.fn();
    const { value } = await settle(downloadCardImages([
      resolved({ displayName: 'Front // Back', quantity: 2, isDFC: true, imageUrls: { front: 'https://images.test/front.png', back: 'https://images.test/back.png' } }),
      resolved(),
    ], progress));
    expect(value).toMatchObject({ totalCards: 3, totalImages: 5, downloadedCards: 3, downloadedImages: 5, cachedImages: 3, failures: [] });
    expect(value.images.map(i => i.filename)).toEqual([
      '0001_Front_Back_(m10)_146_1_front.png', '0001_Front_Back_(m10)_146_2_back.png',
      '0002_Front_Back_(m10)_146_1_front.png', '0002_Front_Back_(m10)_146_2_back.png',
      '0003_Lightning_Bolt_(m10)_146.png',
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(5, 3, 5);
  });

  it('applies the copy limit to direct downloads and sorts all 1000 allowed copies correctly', async () => {
    const { error } = await settle(downloadCardImages([resolved({ quantity: 1001 })]));
    expect(error.message).toContain('at most 1000 physical card copies');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockImplementation(async () => image());
    const { value } = await settle(downloadCardImages([resolved({ quantity: 1000 })]));
    const names = value.images.map(image => image.filename);
    expect(names).toEqual([...names].sort());
    expect(names.at(-1)).toContain('1000_');
  });

  it('rejects an oversized Content-Length without reading or retrying the response body', async () => {
    const pull = vi.fn(), cancel = vi.fn();
    fetch.mockImplementation(async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_IMAGE_BYTES + 1) },
    }));
    const { value } = await settle(downloadCardImages([resolved()]));
    expect(value.failures[0].reason).toContain('20 MiB');
    expect(value.images).toEqual([]);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds chunked image bodies even when the server omits Content-Length', async () => {
    const cancel = vi.fn();
    fetch.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); }, cancel,
    }), { headers: { 'Content-Type': 'image/png' } }));
    const { value } = await settle(downloadCardImages([resolved()]));
    expect(value.failures[0].reason).toContain('20 MiB');
    expect(value.images).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('withholds the front image for every copy when a DFC back download fails', async () => {
    fetch.mockImplementation(async url => url.endsWith('front.png') ? image() : image('missing', 'text/plain', 404));
    const { value } = await settle(downloadCardImages([resolved({ quantity: 3, isDFC: true, imageUrls: { front: 'https://images.test/front.png', back: 'https://images.test/back.png' } })]));
    expect(value).toMatchObject({ images: [], totalCards: 3, failedCards: 3, downloadedCards: 0, totalImages: 6, downloadedImages: 3 });
    expect(value.failures).toEqual([expect.objectContaining({ face: 'back', quantity: 3, reason: 'HTTP 404' })]);
  });

  it.each([
    ['HTML with a 200 response', '<html>CDN error</html>', 'text/html'],
    ['HTML mislabeled as PNG', '<html>CDN error</html>', 'image/png'],
    ['truncated PNG', PNG.subarray(0, PNG.length - 5), 'image/png'],
    ['empty image', Buffer.alloc(0), 'image/png'],
    ['empty JPEG marker pair', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'],
    ['PNG with bad CRC', Buffer.from(PNG).fill(0, PNG.length - 4), 'image/png'],
  ])('rejects %s', async (_description, body, type) => {
    fetch.mockImplementation(async () => image(body, type));
    const { value } = await settle(downloadCardImages([resolved()]));
    expect(value.images).toHaveLength(0);
    expect(value.failedCards).toBe(1);
    expect(value.failures[0].face).toBe('front');
  });

  it('retries network failure then accepts a complete image', async () => {
    fetch.mockRejectedValueOnce(new Error('connection reset')).mockImplementation(async () => image());
    const { value } = await settle(downloadCardImages([resolved()]));
    expect(value.images).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects stale cached error pages and replaces them with valid downloaded images', async () => {
    cache.getCachedImage.mockReturnValue(Buffer.from('<html>old error</html>'));
    fetch.mockImplementation(async () => image());
    const { value } = await settle(downloadCardImagesWithCache([resolved()]));
    expect(value).toMatchObject({ downloadedImages: 1, cachedImages: 0, failures: [] });
    expect(cache.cacheImage).toHaveBeenCalledWith('m10', '146', null, PNG);
  });

  it('uses both valid cached DFC faces with zero requests and consistent image counts', async () => {
    cache.getCachedImage.mockReturnValue(PNG);
    const { value } = await settle(downloadCardImagesWithCache([resolved({ quantity: 2, isDFC: true, imageUrls: { front: 'front', back: 'back' } })]));
    expect(value).toMatchObject({ downloadedImages: 4, cachedImages: 4, downloadedCards: 2, cachedCards: 2, failures: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.getCachedImage.mock.calls.map(args => args[2])).toEqual([null, 'back']);
  });
  it('never substitutes a set/collector cache entry for an explicitly selected printing ID', async () => {
    cache.getCachedImage.mockReturnValue(PNG);
    fetch.mockImplementation(async () => image());
    const requestedScryfallId = 'a1111111-1111-4111-8111-111111111111';
    const selected = resolved({ requestedScryfallId, quantity: 2 });
    const { value } = await settle(downloadCardImagesWithCache([resolved(), selected]));
    expect(value).toMatchObject({ totalCards: 3, failures: [], downloadedImages: 3, cachedImages: 2 });
    // The first row's ambiguous persistent hit must not poison the selected ID's
    // session cache either, even when its resolved image URL is identical.
    expect(cache.getCachedImage).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(selected.imageUrls.front);
    expect(cache.cacheImage).not.toHaveBeenCalled();
  });
});
