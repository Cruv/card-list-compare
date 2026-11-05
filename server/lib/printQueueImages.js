import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCardImageUrls, downloadCardImagesWithCache, ImageCompletenessError } from './scryfallImages.js';
import { imageFormat, MAX_IMAGE_BYTES } from './imageValidation.js';
import { MAX_PRINT_SOURCE_BYTES } from './printQueueLimits.js';
import { sha256, printError, savedPrintArt } from './printQueuePlan.js';

// Same fixed full-resolution proxy as the existing MPC client. This print path
// additionally bounds encoded/decoded bytes and rejects incomplete image data.
const MPC_IMAGE_PROXY = 'https://script.google.com/macros/s/AKfycbw8laScKBfxda2Wb0g63gkYDBdy8NWNxINoC4xDOwnCQ3JMFdruam1MdmNmN4wI5k4/exec';
async function mpcImage(identifier) {
  if (!/^[a-zA-Z0-9_-]{10,120}$/.test(identifier || '')) throw printError('Missing or invalid saved MPC image identifier');
  const maxDecoded = MAX_IMAGE_BYTES;
  const maxEncoded = Math.ceil(maxDecoded / 3) * 4 + 512;
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    try {
      const response = await fetch(`${MPC_IMAGE_PROXY}?id=${encodeURIComponent(identifier)}`, {
        headers: { 'User-Agent': 'CardListCompare/1.0' }, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Object.assign(new Error(`MPC image HTTP ${response.status}`), { retry: response.status === 429 || response.status >= 500 });
      if (Number(response.headers.get('content-length')) > maxEncoded) {
        await response.body?.cancel();
        throw Object.assign(new Error('MPC image exceeds the image or job size limit'), { retry: false });
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('MPC returned an empty image');
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxEncoded) {
            await reader.cancel();
            throw Object.assign(new Error('MPC image exceeds the image or job size limit'), { retry: false });
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const encoded = Buffer.concat(chunks).toString('utf8').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Object.assign(new Error('MPC returned invalid image data'), { retry: false });
      const buffer = Buffer.from(encoded, 'base64');
      if (buffer.length > maxDecoded) throw Object.assign(new Error('MPC image exceeds the image or job size limit'), { retry: false });
      if (!imageFormat(buffer)) throw new Error('MPC returned invalid or truncated image data');
      return buffer;
    } catch (error) {
      if (error.retry === false || attempt === 2) throw error;
    }
  }
}

/** Fetch all art, then freeze one hash-addressed source image and per-copy pairing. */
export async function preparePrintImages(plan, jobDir, onProgress) {
  const resolved = plan.version >= 2 ? plan.resolvedCards : await fetchCardImageUrls(plan.cards);
  if (plan.version >= 2 && (!plan.readyToGenerate || !Array.isArray(resolved)
    || resolved.some(card => !card.scryfallId || card.errors?.length || card.faces?.some(face => face.status !== 'ready')))) {
    throw printError('Reviewed artwork is incomplete. Review a fresh print plan.');
  }
  // A queued preparation from an older app version may not have a resolved
  // review yet. It must not turn a meld card into an ordinary front-only copy.
  if (resolved.some(card => card.layout === 'meld' || (card.isDFC && card.faceNames?.length !== 2))) {
    throw printError('This multi-sided layout is not supported for printing. Review a fresh print plan.');
  }
  const copies = [];
  const sourceDir = join(jobDir, 'images');
  mkdirSync(sourceDir, { recursive: true });
  const written = new Set();
  const imageMetadata = new WeakMap();
  let sourceBytes = 0;
  const storeImage = (buffer, source, identifier, face) => {
    if (imageMetadata.has(buffer)) return { ...imageMetadata.get(buffer), source, identifier, face };
    const format = imageFormat(buffer);
    if (!format) throw printError('Invalid image after download');
    const hash = sha256(buffer);
    const fileName = `images/${hash}.${format}`;
    const path = join(jobDir, fileName);
    if (!written.has(hash)) {
      if (sourceBytes + buffer.length > MAX_PRINT_SOURCE_BYTES) throw printError('Source artwork exceeds the 1.5 GiB print-job limit; use a smaller batch', 507);
      writeFileSync(path, buffer, { flag: 'wx' }); written.add(hash); sourceBytes += buffer.length;
    }
    const metadata = { sha256: hash, size: buffer.length, fileName, format, path };
    imageMetadata.set(buffer, metadata);
    return { ...metadata, source, identifier, face };
  };
  const cardSource = card => card.artSource || card.faces?.[0]?.source || plan.artSource;
  if (resolved.some(card => !['scryfall', 'saved-mpc'].includes(cardSource(card)))) throw printError('Unsupported reviewed artwork source');
  const scryfallCards = resolved.filter(card => cardSource(card) === 'scryfall');
  const preparedScryfall = new Map();
  if (scryfallCards.length) {
    const result = await downloadCardImagesWithCache(scryfallCards, (downloaded, cached, total) => onProgress?.({ phase: 'images', downloaded, cached, total }));
    if (result.failures.length) throw new ImageCompletenessError(result.failures);
    const images = new Map();
    for (const image of result.images) {
      const index = Number(image.filename.slice(0, 4));
      const face = image.filename.includes('_2_back.') ? 'back' : 'front';
      images.set(`${index}:${face}`, image.buffer);
    }
    let index = 1;
    for (const card of scryfallCards) {
      const prepared = [];
      for (let quantity = 0; quantity < card.quantity; quantity++, index++) {
        const front = images.get(`${index}:front`), back = images.get(`${index}:back`);
        if (!front || (card.isDFC && !back)) throw printError(`Missing physical-copy face for ${card.displayName}`);
        prepared.push({ displayName: card.displayName, setCode: card.setCode, collectorNumber: card.collectorNumber,
          scryfallId: card.scryfallId || null, oracleId: card.oracleId || null,
          front: storeImage(front, 'scryfall', card.scryfallId || `${card.setCode}/${card.collectorNumber}`, 'front'),
          ...(card.isDFC ? { back: storeImage(back, 'scryfall', card.scryfallId || `${card.setCode}/${card.collectorNumber}`, 'back') } : {}),
        });
      }
      preparedScryfall.set(card, prepared);
    }
  }
  const artCache = new Map();
  const failures = [];
  for (const card of resolved) {
    if (cardSource(card) === 'scryfall') {
      for (const copy of preparedScryfall.get(card)) copies.push({ ...copy, id: String(copies.length + 1).padStart(4, '0') });
    } else {
      const faces = {};
      for (const face of card.isDFC ? ['front', 'back'] : ['front']) {
        const name = card.faceNames?.[face === 'front' ? 0 : 1];
        const art = plan.version >= 2 ? card.faces.find(item => item.face === face) : savedPrintArt(plan.savedArtwork, card, face);
        try {
          if (!art?.identifier) throw new Error(`No saved ${face} artwork selection${name ? ` for ${name}` : ''}`);
          // Cache paths/hashes, never image buffers: a whole deck of unique MPC
          // art can exceed a gigabyte. Each response is released after staging.
          let metadata = artCache.get(art.identifier);
          if (!metadata) {
            metadata = storeImage(await mpcImage(art.identifier), 'saved-mpc', art.identifier, face);
            artCache.set(art.identifier, metadata);
          }
          faces[face] = { ...metadata, face };
        } catch (error) {
          failures.push({ displayName: card.displayName, setCode: card.setCode, collectorNumber: card.collectorNumber, quantity: card.quantity, face, reason: error.message });
        }
      }
      if (faces.front && (!card.isDFC || faces.back)) {
        for (let quantity = 0; quantity < card.quantity; quantity++) copies.push({ id: String(copies.length + 1).padStart(4, '0'), displayName: card.displayName, setCode: card.setCode, collectorNumber: card.collectorNumber,
          scryfallId: card.scryfallId || null, oracleId: card.oracleId || null, ...faces });
      }
    }
    onProgress?.({ phase: 'images', downloaded: copies.length, total: plan.totalCopies });
  }
  if (failures.length) throw new ImageCompletenessError(failures);
  if (copies.length !== plan.totalCopies) throw printError(`Image copy count mismatch: expected ${plan.totalCopies}, received ${copies.length}`);
  return copies;
}
