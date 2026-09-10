/**
 * Resolve and download every requested card copy and face for proxy printing.
 * A successful lookup never omits cards. Callers must reject downloads with
 * failures before exposing an artifact (a DFC is unusable without both faces).
 */
import { imageFormat, MAX_IMAGE_COPIES, MAX_IMAGE_BYTES, MAX_JOB_IMAGE_BYTES } from './imageValidation.js';

const SCRYFALL_API = 'https://api.scryfall.com';
const BATCH_SIZE = 75;
const REQUEST_DELAY_MS = 100;
const MAX_ATTEMPTS = 3;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const frontFace = name => name.split(' // ')[0];
const normalizeName = name => String(name || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019`\u2032]/g, "'")
  .replace(/\s+/g, ' ').trim().toLowerCase();
const imageUrl = uris => uris?.png || uris?.large || uris?.normal || null;

function failure(card, face, reason) {
  return {
    displayName: card.displayName, setCode: card.setCode,
    collectorNumber: card.collectorNumber, quantity: card.quantity, face, reason,
  };
}

export class ImageCompletenessError extends Error {
  constructor(failures) {
    const details = failures.map(f => {
      const printing = f.setCode ? ` (${f.setCode}${f.collectorNumber ? ` #${f.collectorNumber}` : ''})` : '';
      return `${f.quantity}x ${f.displayName}${printing} — ${f.face}: ${f.reason}`;
    });
    super(`Image download incomplete; no ZIP was created. ${details.join('; ')}`);
    this.name = 'ImageCompletenessError';
    this.failures = failures;
  }
}

/** Retry transient responses/network errors, with rate limiting on every try. */
async function request(url, options, readResponse) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await delay(REQUEST_DELAY_MS * (attempt + 1));
    try {
      const response = await fetch(url, {
        ...options,
        headers: { 'User-Agent': 'CardListCompare/1.0', ...options?.headers },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        // Honor a reasonable Retry-After instead of immediately re-hitting a busy service.
        const retryAfter = response.headers?.get('retry-after');
        const seconds = Number(retryAfter);
        const retryMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (error.retryable && attempt < MAX_ATTEMPTS - 1 && retryMs > 0) {
          await delay(Math.min(retryMs, 30000));
        }
        throw error;
      }
      return await readResponse(response);
    } catch (error) {
      if (error.retryable === false || attempt === MAX_ATTEMPTS - 1) throw error;
    }
  }
}

function matches(identifier, card, requestedName) {
  if (identifier.set && identifier.set !== card.set?.toLowerCase()) return false;
  if (identifier.collector_number !== undefined) {
    if (String(identifier.collector_number).toLowerCase() !== String(card.collector_number).toLowerCase()) return false;
  }
  const requested = normalizeName(identifier.name || requestedName);
  return [card.name, ...(card.card_faces || []).map(face => face.name)]
    .some(name => normalizeName(name) === requested || normalizeName(frontFace(name || '')) === requested
      || normalizeName(name) === normalizeName(frontFace(requested)));
}

/**
 * Return all unique requested printings with resolved image URLs and quantities.
 * Throws ImageCompletenessError for missing cards, metadata failures, or faces.
 * Name and set-only requests resolve to actual set/collector keys for caching.
 */
export async function fetchCardImageUrls(cards) {
  if (!cards?.length) return [];
  validateCopies(cards);
  const entriesByKey = new Map();
  for (const card of cards) {
    const setCode = (card.setCode || '').toLowerCase();
    const collectorNumber = String(card.collectorNumber || '');
    if (collectorNumber && !setCode) {
      throw new ImageCompletenessError([failure(card, 'card', 'Collector number requires a set code; add the set to preserve the requested printing')]);
    }
    const key = JSON.stringify([normalizeName(card.displayName), setCode, collectorNumber.toLowerCase()]);
    if (entriesByKey.has(key)) {
      entriesByKey.get(key).quantity += card.quantity;
    } else {
      entriesByKey.set(key, { ...card, setCode, collectorNumber, imageUrls: null, isDFC: false });
    }
  }
  const entries = [...entriesByKey.values()];
  const queries = [];
  for (const entry of entries) {
    if (entry.setCode && entry.collectorNumber) {
      // Scryfall's collection lookup can require canonical collector casing
      // (PLST DDO-20), even though deck identity is case-insensitive.
      for (const collector of new Set([entry.collectorNumber, entry.collectorNumber.toLowerCase(), entry.collectorNumber.toUpperCase()])) {
        queries.push({ entry, identifier: { set: entry.setCode, collector_number: collector } });
      }
    } else {
      // DFC full names are not always accepted, but some split cards need theirs.
      for (const name of new Set([frontFace(entry.displayName), entry.displayName])) {
        queries.push({ entry, identifier: { name, ...(entry.setCode ? { set: entry.setCode } : {}) } });
      }
    }
  }

  const lookupErrors = new Map();
  for (let offset = 0; offset < queries.length; offset += BATCH_SIZE) {
    const batch = queries.slice(offset, offset + BATCH_SIZE);
    try {
      const result = await request(`${SCRYFALL_API}/cards/collection`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ identifiers: batch.map(q => q.identifier) }),
      }, async response => {
        const data = await response.json();
        if (!Array.isArray(data.data)) throw new Error('Invalid Scryfall collection response');
        return data;
      });
      for (const card of result.data) {
        // A single response can satisfy multiple requests (e.g. generic + exact).
        for (const { entry, identifier } of batch) {
          if (entry.imageUrls || !matches(identifier, card, entry.displayName)) continue;
          entry.setCode = card.set || entry.setCode;
          entry.collectorNumber = String(card.collector_number || entry.collectorNumber);
          entry.scryfallId = card.id;
          entry.oracleId = card.oracle_id || null;
          entry.faceNames = card.card_faces?.map(face => face.name) || [card.name];
          entry.isDFC = !card.image_uris && card.card_faces?.length >= 2;
          entry.imageUrls = entry.isDFC
            ? { front: imageUrl(card.card_faces[0]?.image_uris), back: imageUrl(card.card_faces[1]?.image_uris) }
            : { front: imageUrl(card.image_uris) };
        }
      }
    } catch (error) {
      for (const { entry } of batch) lookupErrors.set(entry, `Scryfall lookup failed (${error.message})`);
    }
  }

  const failures = [];
  for (const entry of entries) {
    if (!entry.imageUrls) {
      failures.push(failure(entry, 'card', lookupErrors.get(entry) || 'Card/printing not found on Scryfall'));
    } else {
      for (const face of entry.isDFC ? ['front', 'back'] : ['front']) {
        if (!entry.imageUrls[face]) failures.push(failure(entry, face, 'No image URL available'));
      }
    }
  }
  if (failures.length) throw new ImageCompletenessError(failures);
  return entries;
}

function filename(copyIndex, card, face, format) {
  const safe = value => String(value).replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');
  const printing = card.setCode ? `_(${safe(card.setCode)})` : '';
  const collector = card.collectorNumber ? `_${safe(card.collectorNumber)}` : '';
  // Paired faces share the physical copy index and sort front before back.
  const suffix = card.isDFC ? (face === 'front' ? '_1_front' : '_2_back') : '';
  return `${String(copyIndex).padStart(4, '0')}_${safe(card.displayName)}${printing}${collector}${suffix}.${format}`;
}

function validateCopies(cards) {
  let copies = 0;
  for (const card of cards) {
    if (!Number.isSafeInteger(card.quantity) || card.quantity < 1 || !card.displayName?.trim()) {
      throw new Error('Every requested card must have a name and a positive whole copy count');
    }
    copies += card.quantity;
    if (copies > MAX_IMAGE_COPIES) throw new Error(`Image downloads support at most ${MAX_IMAGE_COPIES} physical card copies per job; choose a smaller batch`);
  }
}

function resourceLimitError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

async function readImageBody(response, availableBytes) {
  const limit = Math.min(MAX_IMAGE_BYTES, availableBytes);
  const message = limit < MAX_IMAGE_BYTES
    ? 'Image data exceeds 256 MiB per job; download a smaller batch'
    : 'Image exceeds the 20 MiB download limit';
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > limit) {
    await response.body?.cancel();
    throw resourceLimitError(message);
  }
  if (!response.body) throw new Error('Empty image response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw resourceLimitError(message);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function fetchSingleImage(url, availableBytes) {
  if (!url) throw new Error('No image URL available');
  return request(url, { headers: { Accept: 'image/png,image/jpeg' } }, async response => {
    const contentType = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/jpg'].includes(contentType)) {
      const error = new Error(`Expected an image response, received ${contentType || 'no Content-Type'}`);
      error.retryable = false;
      throw error;
    }
    const buffer = await readImageBody(response, availableBytes);
    if (!imageFormat(buffer)) throw new Error('Invalid or truncated image data');
    return buffer;
  });
}

/**
 * Progress counts physical files, including both DFC faces and duplicate copies.
 * Successful disk/session cache hits count toward cachedImages. Only fully
 * downloaded cards enter images; failures prevent callers publishing the ZIP.
 */
async function downloadImages(cards, cache, progressCallback) {
  validateCopies(cards);
  const images = [];
  const failures = [];
  const totalCards = cards.reduce((sum, card) => sum + card.quantity, 0);
  const totalImages = cards.reduce((sum, card) => sum + card.quantity * (card.isDFC ? 2 : 1), 0);
  let copyIndex = 1;
  let downloadedCards = 0;
  let cachedCards = 0;
  let downloadedImages = 0;
  let cachedImages = 0;
  const sessionCache = new Map();
  const sessionFormats = new Map();
  let uniqueBytes = 0;

  for (const card of cards) {
    const buffers = {};
    const formats = {};
    let allCached = true;
    for (const face of card.isDFC ? ['front', 'back'] : ['front']) {
      const cacheFace = face === 'back' ? 'back' : null;
      const url = card.imageUrls?.[face];
      try {
        if (!url) throw new Error('No image URL available');
        const availableBytes = MAX_JOB_IMAGE_BYTES - uniqueBytes;
        if (availableBytes <= 0 && !sessionCache.has(url)) throw resourceLimitError('Image data exceeds 256 MiB per job; download a smaller batch');
        let buffer = sessionCache.get(url);
        const inSession = !!buffer;
        if (!buffer && cache) buffer = card.setCode && card.collectorNumber
          ? cache.getCachedImage(card.setCode, card.collectorNumber, cacheFace, availableBytes)
          : cache.getCachedImageByName(card.displayName, cacheFace, availableBytes);
        // Old caches could contain successful HTTP error pages. Treat them as misses.
        let format = inSession ? sessionFormats.get(url) : imageFormat(buffer);
        if (!format) buffer = null;

        const wasCached = !!buffer;
        if (!buffer) {
          allCached = false;
          buffer = await fetchSingleImage(url, availableBytes);
          format = imageFormat(buffer);
          if (cache) {
            if (card.setCode && card.collectorNumber) cache.cacheImage(card.setCode, card.collectorNumber, cacheFace, buffer);
            else cache.cacheImageByName(card.displayName, cacheFace, buffer);
          }
        }
        if (!inSession) {
          if (buffer.length > availableBytes) throw resourceLimitError('Image data exceeds 256 MiB per job; download a smaller batch');
          uniqueBytes += buffer.length;
          sessionCache.set(url, buffer);
          sessionFormats.set(url, format);
        }
        buffers[face] = buffer;
        formats[face] = format;
        downloadedImages += card.quantity;
        // The remaining copies reuse this image even when the first copy was fetched.
        cachedImages += wasCached ? card.quantity : card.quantity - 1;
      } catch (error) {
        allCached = false;
        failures.push(failure(card, face, error.message));
      }
      progressCallback?.(downloadedImages, cachedImages, totalImages);
    }

    if (buffers.front && (!card.isDFC || buffers.back)) {
      for (let copy = 0; copy < card.quantity; copy++) {
        for (const face of card.isDFC ? ['front', 'back'] : ['front']) {
          images.push({ filename: filename(copyIndex + copy, card, face, formats[face]), buffer: buffers[face] });
        }
      }
      downloadedCards += card.quantity;
      cachedCards += allCached ? card.quantity : card.quantity - 1;
    }
    copyIndex += card.quantity;
  }
  return { images, failures, totalCards, downloadedCards, cachedCards,
    failedCards: totalCards - downloadedCards, totalImages, downloadedImages, cachedImages };
}

/** Download without a persistent cache (also used by callers constructing artifacts). */
export async function downloadCardImages(cardsWithUrls, progressCallback) {
  return downloadImages(cardsWithUrls, null, progressCallback);
}

/** Download with the shared persistent disk cache. */
export async function downloadCardImagesWithCache(cardsWithUrls, progressCallback) {
  return downloadImages(cardsWithUrls, await import('./imageCache.js'), progressCallback);
}
