import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

vi.mock('../db.js', () => ({ get: vi.fn() }));
const scryfall = vi.hoisted(() => ({ fetchCardImageUrls: vi.fn(), downloadCardImagesWithCache: vi.fn() }));
const limits = vi.hoisted(() => ({ sourceBytes: 1536 * 1024 * 1024 }));
vi.mock('./printQueueLimits.js', () => ({ get MAX_PRINT_SOURCE_BYTES() { return limits.sourceBytes; } }));
vi.mock('./imageValidation.js', async importOriginal => ({ ...(await importOriginal()), MAX_JOB_IMAGE_BYTES: 256 }));
vi.mock('./scryfallImages.js', async importOriginal => ({ ...(await importOriginal()), ...scryfall }));
import { inspectFrozenPrintArtwork, prepareFrozenPrintImages, preparePrintImages } from './printQueueImages.js';
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
  it('generates saved MPC faces from the reviewed selections without another identity lookup', async () => {
    scryfall.fetchCardImageUrls.mockRejectedValue(new Error('Later metadata must not select different art'));
    const frozen = plan({ version: 2, readyToGenerate: true, resolvedCards: [{ ...card, errors: [], faces: [
      { face: 'front', identifier: 'reviewed-front-art', status: 'ready' },
      { face: 'back', identifier: 'reviewed-back-art', status: 'ready' },
    ] }], savedArtwork: [['Malakir Rebirth', { identifier: 'changed-front-art' }]] });
    const { value, error } = await settle(preparePrintImages(frozen, dir));
    expect(error).toBeUndefined();
    expect(value).toHaveLength(2);
    expect(value[0].front.identifier).toBe('reviewed-front-art');
    expect(value[0].back.identifier).toBe('reviewed-back-art');
    expect(scryfall.fetchCardImageUrls).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('id'))).toEqual(['reviewed-front-art', 'reviewed-back-art']);
  });
  it('downloads the exact reviewed Scryfall printing without re-resolving a generic name', async () => {
    const selected = { ...card, imageUrls: { front: 'reviewed-front.png', back: 'reviewed-back.png' }, errors: [],
      faces: [{ face: 'front', status: 'ready' }, { face: 'back', status: 'ready' }] };
    scryfall.downloadCardImagesWithCache.mockResolvedValue({ failures: [], images: [
      '0001_Card_1_front.png', '0001_Card_2_back.png', '0002_Card_1_front.png', '0002_Card_2_back.png',
    ].map(filename => ({ filename, buffer: PNG })) });
    const { value } = await settle(preparePrintImages(plan({ version: 2, artSource: 'scryfall', readyToGenerate: true, resolvedCards: [selected] }), dir));
    expect(value).toHaveLength(2);
    expect(scryfall.downloadCardImagesWithCache.mock.calls[0][0]).toEqual([selected]);
    expect(scryfall.fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it('keeps unselected MPC art and original card order around a selected Scryfall DFC', async () => {
    const selectedId = 'a1111111-1111-4111-8111-111111111111';
    const mpc = { ...card, displayName: 'Lightning Bolt', quantity: 1, isDFC: false, faceNames: ['Lightning Bolt'], artSource: 'saved-mpc',
      errors: [], faces: [{ face: 'front', identifier: 'keep-bolt-front-art', source: 'saved-mpc', status: 'ready' }] };
    const selected = { ...card, requestedScryfallId: selectedId, scryfallId: selectedId, artSource: 'scryfall', errors: [],
      imageUrls: { front: 'chosen-front.png', back: 'chosen-back.png' },
      faces: [{ face: 'front', identifier: selectedId, source: 'scryfall', status: 'ready' }, { face: 'back', identifier: selectedId, source: 'scryfall', status: 'ready' }] };
    const last = { ...mpc, displayName: 'Counterspell', faces: [{ ...mpc.faces[0], identifier: 'keep-counter-front-art' }] };
    scryfall.downloadCardImagesWithCache.mockResolvedValue({ failures: [], images: [
      '0001_Card_1_front.png', '0001_Card_2_back.png', '0002_Card_1_front.png', '0002_Card_2_back.png',
    ].map(filename => ({ filename, buffer: PNG })) });
    const frozen = plan({ version: 2, totalCopies: 4, readyToGenerate: true, resolvedCards: [mpc, selected, last] });
    const { value, error } = await settle(preparePrintImages(frozen, dir));
    expect(error).toBeUndefined();
    expect(value.map(copy => [copy.id, copy.displayName, copy.front.source])).toEqual([
      ['0001', 'Lightning Bolt', 'saved-mpc'], ['0002', 'Malakir Rebirth', 'scryfall'],
      ['0003', 'Malakir Rebirth', 'scryfall'], ['0004', 'Counterspell', 'saved-mpc'],
    ]);
    expect(value[0].front.identifier).toBe('keep-bolt-front-art');
    expect(value[1].front.identifier).toBe(selectedId);
    expect(value[1].back.identifier).toBe(selectedId);
    expect(value[3].front.identifier).toBe('keep-counter-front-art');
    expect(scryfall.downloadCardImagesWithCache.mock.calls[0][0]).toEqual([selected]);
    expect(scryfall.fetchCardImageUrls).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('id'))).toEqual(['keep-bolt-front-art', 'keep-counter-front-art']);
  });
  it('refuses an incomplete reviewed plan before downloading any artwork', async () => {
    const { error } = await settle(preparePrintImages(plan({ version: 2, readyToGenerate: false, resolvedCards: [{ ...card }] }), dir));
    expect(error.message).toContain('Reviewed artwork is incomplete');
    expect(fetch).not.toHaveBeenCalled();
    expect(scryfall.fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it('does not silently generate an ordinary meld front from a legacy pending plan', async () => {
    scryfall.fetchCardImageUrls.mockResolvedValue([{ ...card, isDFC: false, layout: 'meld', faceNames: ['Bruna, the Fading Light'] }]);
    const { error } = await settle(preparePrintImages(plan(), dir));
    expect(error.message).toContain('multi-sided layout is not supported');
    expect(fetch).not.toHaveBeenCalled();
  });
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
  it('pairs canonical front and back art for a legacy pending back-alias request', async () => {
    scryfall.fetchCardImageUrls.mockResolvedValue([{ ...card, displayName: 'Malakir Mire' }]);
    const { value, error } = await settle(preparePrintImages(plan(), dir));
    expect(error).toBeUndefined();
    expect(value[0].front.identifier).toBe('front-art-0123456789');
    expect(value[0].back.identifier).toBe('back-art-0123456789');
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

describe('frozen artwork for an alternate layout', () => {
  beforeEach(() => vi.useRealTimers());
  const digest = value => createHash('sha256').update(value).digest('hex');
  const originalFront = distinctPng(1), originalBack = distinctPng(2);
  const id = '8f9aa28a-267a-40d9-a12e-4a0f9b7a15f9';
  const urls = { front: 'https://cards.scryfall.io/front/fixture.png', back: 'https://cards.scryfall.io/back/fixture.png' };
  const face = (name, bytes, source = 'scryfall', identifier = id) => ({
    face: name, sha256: digest(bytes), size: bytes.length, fileName: 'images/' + digest(bytes) + '.png', format: 'png', source, identifier,
  });
  function fixture({ saved = true, retained = false, frontSource = 'scryfall' } = {}) {
    const original = join(dir, 'original'), cache = join(dir, 'retained'), copyDir = join(dir, 'new');
    mkdirSync(join(original, 'images'), { recursive: true });
    mkdirSync(cache);
    const front = face('front', originalFront, frontSource, frontSource === 'saved-mpc' ? 'fixture-pinned-art' : id);
    const back = face('back', originalBack);
    if (saved) {
      writeFileSync(join(original, front.fileName), originalFront);
      writeFileSync(join(original, back.fileName), originalBack);
    }
    if (retained) writeFileSync(join(cache, back.sha256 + '.png'), originalBack);
    const copies = ['0001', '0002'].map(id => ({ id, scryfallId: front.identifier,
      displayName: 'Malakir Rebirth', setCode: 'znr', collectorNumber: '111', front, back }));
    const manifest_json = JSON.stringify({
      jobId: 'source-fixture', requesterId: 17, copies,
      plan: { totalCopies: 2, doubleFacedCopies: 2, resolvedCards: [{ scryfallId: id, imageUrls: urls }] },
    });
    const row = { id: 'source-fixture', user_id: 17, manifest_json, manifest_sha256: digest(manifest_json) };
    return { row, original, cache, copyDir, copies };
  }
  it('verifies and restages identical ordered pairs without touching the source or provider', async () => {
    const { row, original, cache, copyDir, copies } = fixture();
    const preview = await inspectFrozenPrintArtwork(row, original, cache);
    expect(preview).toEqual({ copies, failures: [] });
    const progress = vi.fn();
    const prepared = await prepareFrozenPrintImages(row, original, cache, copyDir, progress, undefined, row.manifest_sha256);
    expect(prepared.map(({ id, front, back }) => [id, front.sha256, back.sha256])).toEqual(copies.map(({ id, front, back }) => [id, front.sha256, back.sha256]));
    for (const [face, bytes] of [['front', originalFront], ['back', originalBack]]) {
      expect(readFileSync(prepared[0][face].path)).toEqual(bytes);
      expect(readFileSync(join(original, prepared[0][face].fileName))).toEqual(bytes);
    }
    expect(readdirSync(join(copyDir, 'images'))).toHaveLength(2);
    expect(progress).toHaveBeenLastCalledWith({ phase: 'images', downloaded: 4, cached: 4, total: 4 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('recovers a missing pair from owner-retained bytes and the frozen provider face', async () => {
    const { row, original, cache, copyDir } = fixture({ saved: false, retained: true });
    fetch.mockResolvedValue(new Response(originalFront, { headers: { 'Content-Type': 'image/png' } }));
    const prepared = await prepareFrozenPrintImages(row, original, cache, copyDir);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(urls.front, expect.objectContaining({ redirect: 'error' }));
    expect(readFileSync(prepared[0].front.path)).toEqual(originalFront);
    expect(readFileSync(prepared[0].back.path)).toEqual(originalBack);
    expect(readdirSync(join(original, 'images'))).toEqual([]);
  });
  it('rejects different bytes from the exact MPC identifier and reports the affected face', async () => {
    const { row, original, cache, copyDir, copies } = fixture({ saved: false, retained: true, frontSource: 'saved-mpc' });
    fetch.mockImplementation(async () => new Response(distinctPng(3).toString('base64')));
    const value = await inspectFrozenPrintArtwork(row, original, cache);
    expect(value.failures).toEqual([{ displayName: 'Malakir Rebirth', setCode: 'znr', collectorNumber: '111',
      face: 'front', quantity: 2, copyIds: copies.map(copy => copy.id), reason: expect.stringContaining('provider returned different artwork bytes') }]);
    await expect(prepareFrozenPrintImages(row, original, cache, copyDir)).rejects.toThrow('Malakir Rebirth, front');
    expect(scryfall.fetchCardImageUrls).not.toHaveBeenCalled();
    expect(readdirSync(join(copyDir, 'images'))).toEqual([copies[0].back.sha256 + '.png']);
  });
  it('never accepts truncated original bytes or a manifest changed after review', async () => {
    const { row, original, cache, copyDir, copies } = fixture({ retained: true });
    writeFileSync(join(original, copies[0].back.fileName), 'truncated');
    const preview = await inspectFrozenPrintArtwork(row, original, cache);
    expect(preview.failures).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(original, copies[0].back.fileName), 'utf8')).toBe('truncated');
    await expect(prepareFrozenPrintImages(row, original, cache, copyDir, undefined, undefined, 'f'.repeat(64))).rejects.toThrow('manifest changed');
    await expect(inspectFrozenPrintArtwork({ ...row, user_id: 18 }, original, cache)).rejects.toThrow('complete frozen copy');
  });
});
