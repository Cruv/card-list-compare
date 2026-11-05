import { afterEach, describe, expect, it, vi } from 'vitest';

// Scale only allocation limits to exercise aggregate exhaustion without allocating
// hundreds of MiB in the test runner. The structural validator remains real.
vi.mock('./imageValidation.js', async importOriginal => ({
  ...(await importOriginal()), MAX_IMAGE_BYTES: 256, MAX_JOB_IMAGE_BYTES: 512,
}));
import { downloadCardImages } from './scryfallImages.js';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('aggregate image byte budget', () => {
  it('fails when unique images exceed the job budget even though each image fits', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })));
    const cards = Array.from({ length: 8 }, (_, index) => ({
      displayName: `Card ${index}`, quantity: 1, imageUrls: { front: `https://images.test/${index}.png` },
    }));
    const resultPromise = downloadCardImages(cards);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.images).toHaveLength(7);
    expect(result.failures).toEqual([expect.objectContaining({ displayName: 'Card 7', reason: expect.stringContaining('256 MiB per job') })]);
    expect(fetch).toHaveBeenCalledTimes(8); // a byte-limit failure is not retried
  });
  it('charges reused image bytes only once across aliases and copies', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })));
    const resultPromise = downloadCardImages(Array.from({ length: 8 }, (_, index) => ({
      displayName: `Alias ${index}`, quantity: 3, imageUrls: { front: 'https://images.test/same.png' },
    })));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.failures).toEqual([]);
    expect(result.images).toHaveLength(24);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
