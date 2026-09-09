import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';

vi.mock('../db.js', () => ({ get: vi.fn() }));
const scryfall = vi.hoisted(() => ({ fetchCardImageUrls: vi.fn(), downloadCardImagesWithCache: vi.fn() }));
const limits = vi.hoisted(() => ({ sourceBytes: 1536 * 1024 * 1024 }));
vi.mock('./printQueueLimits.js', () => ({ get MAX_PRINT_SOURCE_BYTES() { return limits.sourceBytes; } }));
vi.mock('./imageValidation.js', async importOriginal => ({ ...(await importOriginal()), MAX_JOB_IMAGE_BYTES: 256 }));
vi.mock('./scryfallImages.js', async importOriginal => ({ ...(await importOriginal()), ...scryfall }));
import { preparePrintImages } from './printQueueImages.js';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const card = { displayName: 'Malakir Rebirth', quantity: 2, setCode: 'znr', collectorNumber: '111', scryfallId: 'resolved-card', isDFC: true, faceNames: ['Malakir Rebirth', 'Malakir Mire'] };
let dir;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  limits.sourceBytes = 1536 * 1024 * 1024;
  dir = mkdtempSync(join(tmpdir(), 'clc-print-art-'));
  scryfall.fetchCardImageUrls.mockResolvedValue([{ ...card }]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG.toString('base64'), { headers: { 'Content-Type': 'text/plain' } })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
async function settle(promise) {
  const result = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync(); return result;
}
function plan(overrides = {}) {
  return { cards: [card], totalCopies: 2, artSource: 'saved-mpc', savedArtwork: [
    ['Malakir Rebirth', { identifier: 'front-art-0123456789' }], ['Malakir Mire', { identifier: 'back-art-0123456789' }],
  ], ...overrides };
}
function distinctPng(index) {
  const data = Buffer.from(`fixture\0${index}`), type = Buffer.from('tEXt');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); type.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}
function manyArtworkPlan(count) {
  const cards = Array.from({ length: count }, (_, index) => ({ displayName: `Card ${index}`, quantity: 1, isDFC: false }));
  scryfall.fetchCardImageUrls.mockResolvedValue(cards);
  fetch.mockImplementation(async url => new Response(distinctPng(Number(new URL(url).searchParams.get('id').split('-').at(-1))).toString('base64')));
  return { cards, totalCopies: count, artSource: 'saved-mpc', savedArtwork: cards.map((card, index) => [card.displayName, { identifier: `saved-artwork-${index}` }]) };
}

describe('immutable print image preparation', () => {
  it('freezes selected MPC IDs and pairs every physical DFC copy without searching or fallback', async () => {
    const { value } = await settle(preparePrintImages(plan(), dir));
    expect(value).toHaveLength(2);
    expect(value.map(copy => copy.id)).toEqual(['0001', '0002']);
    expect(value[0].front).toMatchObject({ source: 'saved-mpc', identifier: 'front-art-0123456789', face: 'front' });
    expect(value[1].back).toMatchObject({ source: 'saved-mpc', identifier: 'back-art-0123456789', face: 'back' });
    expect(readFileSync(value[0].front.path)).toEqual(PNG);
    expect(readdirSync(join(dir, 'images'))).toHaveLength(1); // identical bytes stored once
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(scryfall.downloadCardImagesWithCache).not.toHaveBeenCalled();
  });
  it('fails missing saved DFC back art for all copies and does not substitute Scryfall', async () => {
    const { error } = await settle(preparePrintImages(plan({ savedArtwork: [['Malakir Rebirth', { identifier: 'front-art-0123456789' }]] }), dir));
    expect(error.failures).toEqual([expect.objectContaining({ displayName: 'Malakir Rebirth', face: 'back', quantity: 2, reason: expect.stringContaining('No saved back artwork') })]);
    expect(scryfall.downloadCardImagesWithCache).not.toHaveBeenCalled();
  });
  it('fails invalid or oversized MPC proxy bodies before accepting image bytes', async () => {
    fetch.mockImplementation(async () => new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } }));
    let result = await settle(preparePrintImages(plan(), dir));
    expect(result.error.failures).toHaveLength(2);
    expect(result.error.message).toContain('invalid image data');
    fetch.mockImplementation(async () => new Response('', { headers: { 'Content-Length': '999999999' } }));
    result = await settle(preparePrintImages(plan(), dir));
    expect(result.error.message).toContain('size limit');
    expect(readdirSync(join(dir, 'images'))).toEqual([]);
  });
  it('maps complete Scryfall pairs into immutable per-copy paths and hashes', async () => {
    scryfall.downloadCardImagesWithCache.mockResolvedValue({ failures: [], images: [
      '0001_Card_1_front.png', '0001_Card_2_back.png', '0002_Card_1_front.png', '0002_Card_2_back.png',
    ].map(filename => ({ filename, buffer: PNG })) });
    const { value } = await settle(preparePrintImages(plan({ artSource: 'scryfall' }), dir));
    expect(value).toHaveLength(2);
    expect(value.every(copy => copy.front.source === 'scryfall' && copy.back.identifier === 'resolved-card')).toBe(true);
    expect(value[0].front.sha256).toBe(value[1].back.sha256);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a missing physical-copy face even if a caller reports no download failures', async () => {
    scryfall.downloadCardImagesWithCache.mockResolvedValue({ failures: [], images: [{ filename: '0001_Card_1_front.png', buffer: PNG }] });
    const { error } = await settle(preparePrintImages(plan({ artSource: 'scryfall' }), dir));
    expect(error.message).toContain('Missing physical-copy face');
  });
  it('stages unique MPC art beyond the former buffer budget with a bounded disk budget', async () => {
    // Scale MiB to bytes: this exercises >256 without allocating a giant fixture.
    limits.sourceBytes = 1536;
    const { value, error } = await settle(preparePrintImages(manyArtworkPlan(6), dir));
    expect(error).toBeUndefined();
    expect(value).toHaveLength(6);
    expect(value.reduce((total, copy) => total + copy.front.size, 0)).toBeGreaterThan(256);
    expect(readdirSync(join(dir, 'images'))).toHaveLength(6);
    expect(value.every(copy => !Object.values(copy.front).some(Buffer.isBuffer))).toBe(true);
  });
  it('enforces the unique source disk budget without writing the overflowing image', async () => {
    limits.sourceBytes = distinctPng(0).length * 3;
    const { error } = await settle(preparePrintImages(manyArtworkPlan(4), dir));
    expect(error.message).toContain('Source artwork exceeds the 1.5 GiB');
    expect(readdirSync(join(dir, 'images'))).toHaveLength(3);
  });
});
