import { constants, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchCardImageUrls, downloadCardImagesWithCache, fetchFrozenScryfallImage, ImageCompletenessError } from './scryfallImages.js';
import { imageFormat, MAX_IMAGE_BYTES } from './imageValidation.js';
import { MAX_PRINT_SOURCE_BYTES } from './printQueueLimits.js';
import { sha256, printError, savedPrintArt, MAX_PRINT_COPIES } from './printQueuePlan.js';

// Same fixed full-resolution proxy as the existing MPC client. This print path
// additionally bounds encoded/decoded bytes and rejects incomplete image data.
const MPC_IMAGE_PROXY = 'https://script.google.com/macros/s/AKfycbw8laScKBfxda2Wb0g63gkYDBdy8NWNxINoC4xDOwnCQ3JMFdruam1MdmNmN4wI5k4/exec';
async function mpcImage(identifier, signal) {
  if (!/^[a-zA-Z0-9_-]{10,120}$/.test(identifier || '')) throw printError('Missing or invalid saved MPC image identifier');
  const maxDecoded = MAX_IMAGE_BYTES;
  const maxEncoded = Math.ceil(maxDecoded / 3) * 4 + 512;
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(200 * (attempt + 1), undefined, { signal });
    try {
      const response = await fetch(`${MPC_IMAGE_PROXY}?id=${encodeURIComponent(identifier)}`, {
        headers: { 'User-Agent': 'CardListCompare/1.0' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
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
      signal?.throwIfAborted();
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

export function frozenManifest(source, expectedHash = source.manifest_sha256) {
  if (!source.manifest_json) throw printError('This batch has no saved artwork manifest', 409);
  if (source.manifest_sha256 !== expectedHash || sha256(source.manifest_json) !== expectedHash) {
    throw printError('The saved batch manifest changed or failed its checksum', 409);
  }
  let manifest;
  try { manifest = JSON.parse(source.manifest_json); }
  catch { throw printError('The saved batch manifest is unreadable', 409); }
  const copies = manifest?.copies;
  if (manifest?.jobId !== source.id || manifest.requesterId !== source.user_id || !Array.isArray(copies)
    || !copies.length || copies.length > MAX_PRINT_COPIES || copies.length !== manifest.plan?.totalCopies
    || copies.some(copy => typeof copy?.id !== 'string' || !copy.id || typeof copy.displayName !== 'string')
    || new Set(copies.map(copy => copy.id)).size !== copies.length
    || (Number.isInteger(manifest.plan.doubleFacedCopies) && copies.filter(copy => copy.back).length !== manifest.plan.doubleFacedCopies)) {
    throw printError('This batch does not have a complete frozen copy and face record', 409);
  }
  return manifest;
}

function validFrozenFace(image, face) {
  return image?.face === face && /^[a-f0-9]{64}$/.test(image.sha256) && ['png', 'jpg'].includes(image.format)
    && Number.isSafeInteger(image.size) && image.size > 0 && image.size <= MAX_IMAGE_BYTES;
}

function exactImage(buffer, image) {
  return buffer.length === image.size && sha256(buffer) === image.sha256 && imageFormat(buffer) === image.format;
}

async function readFrozenImage(directory, name, image) {
  // These paths are hash-addressed and never derived from provider identifiers.
  // Open the resolved file under this directory, with a bounded read.
  const path = join(directory, name);
  let file;
  try {
    const root = await realpath(directory);
    const actual = await realpath(path);
    if (!actual.startsWith(root + sep)) throw new Error('artwork path escaped its directory');
    file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size !== image.size) throw new Error('saved artwork size or type changed');
    const bytes = Buffer.allocUnsafe(image.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const buffer = bytes.subarray(0, size);
    if (!exactImage(buffer, image)) throw new Error('saved artwork failed its checksum');
    return buffer;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await file?.close(); }
}

const PRINTING_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function recoverFrozenImage(copy, image, resolvedCards, lookup, signal) {
  if (image.source === 'saved-mpc') return mpcImage(image.identifier, signal);
  if (image.source !== 'scryfall') throw new Error('no supported frozen artwork source');
  const id = PRINTING_ID.test(image.identifier) ? image.identifier.toLowerCase() : null;
  const frozenUrl = id && resolvedCards.find(card => card.scryfallId?.toLowerCase() === id)?.imageUrls?.[image.face];
  if (frozenUrl) {
    try {
      const buffer = await fetchFrozenScryfallImage(frozenUrl, signal);
      if (exactImage(buffer, image)) return buffer;
    } catch { signal?.throwIfAborted(); }
  }
  // Older manifests can have a set/collector identifier but no resolved URL.
  // Resolve that exact printing again, without a name-only default or cache.
  const exactSet = copy.setCode && copy.collectorNumber && image.identifier === `${copy.setCode}/${copy.collectorNumber}`;
  if (!id && !exactSet) throw new Error('no frozen exact Scryfall printing identifier');
  const key = id || image.identifier;
  if (!lookup.has(key)) lookup.set(key, fetchCardImageUrls([{
    displayName: copy.displayName, setCode: copy.setCode, collectorNumber: copy.collectorNumber, quantity: 1,
    ...(id ? { requestedScryfallId: id } : {}),
  }], { signal }));
  const [printing] = await lookup.get(key);
  const url = printing?.imageUrls?.[image.face];
  if (url === frozenUrl) throw new Error('the frozen Scryfall image is unavailable or its bytes changed');
  return fetchFrozenScryfallImage(url, signal);
}

async function frozenPrintImages(source, sourceDir, retainedDir, { destinationDir, expectedHash, onProgress, signal } = {}) {
  const { plan, copies } = frozenManifest(source, expectedHash);
  const groups = new Map(), failures = new Map(), lookup = new Map();
  function recordFailure(copy, face, reason) {
    const { displayName, setCode, collectorNumber } = copy;
    const key = JSON.stringify([displayName, setCode, collectorNumber, face, reason]);
    const known = failures.get(key);
    if (known) { known.quantity++; known.copyIds.push(copy.id); }
    else failures.set(key, { displayName, setCode, collectorNumber, face, reason, quantity: 1, copyIds: [copy.id] });
  }
  for (const copy of copies) for (const face of copy.back ? ['front', 'back'] : ['front']) {
    const image = copy[face];
    if (!validFrozenFace(image, face)) {
      recordFailure(copy, face, 'The original face has no verifiable saved artwork hash and size');
      continue;
    }
    const key = image.sha256;
    if (!groups.has(key)) groups.set(key, { image, entries: [] });
    const group = groups.get(key);
    if (group.image.format !== image.format || group.image.size !== image.size) {
      recordFailure(copy, face, 'The saved artwork hash has conflicting file metadata');
      continue;
    }
    group.entries.push({ copy, image });
  }
  const sourceBytes = [...groups.values()].reduce((sum, { image }) => sum + image.size, 0);
  if (sourceBytes > MAX_PRINT_SOURCE_BYTES) throw printError('Source artwork exceeds the 1.5 GiB print-job limit', 507);
  if (destinationDir) await mkdir(join(destinationDir, 'images'), { recursive: true });

  const total = copies.length + copies.filter(copy => copy.back).length;
  let completed = 0, cached = 0;
  for (const { image, entries } of groups.values()) {
    signal?.throwIfAborted();
    const name = `${image.sha256}.${image.format}`;
    const fileName = `images/${name}`;
    let buffer, unavailable = 'the original and retained files are missing';
    for (const [directory, file] of [[sourceDir, fileName], [retainedDir, name]]) {
      try { buffer = await readFrozenImage(directory, file, image); }
      catch { unavailable = 'a saved file failed verification'; }
      if (buffer) { cached += entries.length; break; }
    }
    if (!buffer) {
      const tried = new Set();
      let providerReason = 'no usable frozen provider reference';
      for (const { copy, image: candidate } of entries) {
        const key = JSON.stringify([candidate.source, candidate.identifier, candidate.face]);
        if (tried.has(key)) continue;
        tried.add(key);
        try {
          const downloaded = await recoverFrozenImage(copy, candidate, plan.resolvedCards || [], lookup, signal);
          if (exactImage(downloaded, image)) { buffer = downloaded; break; }
          providerReason = 'the provider returned different artwork bytes';
        } catch (error) { signal?.throwIfAborted(); providerReason = error.message; }
      }
      if (!buffer) for (const entry of entries) {
        recordFailure(entry.copy, entry.image.face, `Exact artwork could not be recovered because ${unavailable} and ${providerReason}`);
      }
    }
    if (buffer && destinationDir) await writeFile(join(destinationDir, fileName), buffer, { flag: 'wx', mode: 0o600, signal });
    if (buffer) completed += entries.length;
    onProgress?.({ phase: 'images', downloaded: completed, cached, total });
  }
  return { copies, failures: [...failures.values()] };
}

/** Verify the original per-copy artwork before allowing a different layout. */
export const inspectFrozenPrintArtwork = (source, sourceDir, retainedDir, signal) => frozenPrintImages(source, sourceDir, retainedDir, { signal });

export async function prepareFrozenPrintImages(source, sourceDir, retainedDir, destinationDir, onProgress, signal, expectedHash) {
  const timeout = AbortSignal.timeout(180_000);
  const recoverySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const { copies, failures } = await frozenPrintImages(source, sourceDir, retainedDir, {
    destinationDir, expectedHash, onProgress, signal: recoverySignal,
  }).catch(error => {
    if (timeout.aborted && !signal?.aborted) throw printError('Exact artwork recovery timed out. Review the original batch again before retrying.', 503);
    throw error;
  });
  if (failures.length) {
    const blocked = failures.map(({ displayName, face, reason }) => `${displayName}, ${face}: ${reason}`).join('; ');
    throw printError(`Cannot regenerate PDFs. ${blocked}`, 409);
  }
  const withPath = image => {
    const fileName = `images/${image.sha256}.${image.format}`;
    return { ...image, fileName, path: join(destinationDir, fileName) };
  };
  return copies.map(copy => ({ ...copy, front: withPath(copy.front), ...(copy.back ? { back: withPath(copy.back) } : {}) }));
}
