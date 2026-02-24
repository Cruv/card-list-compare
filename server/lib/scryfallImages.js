/**
 * Scryfall image download module for proxy printing.
 * Two-phase process:
 *   1. Batch-query Scryfall /cards/collection for image URLs (set+collector or name)
 *   2. Sequentially download PNG images with rate limiting
 */

const SCRYFALL_API = 'https://api.scryfall.com';
const BATCH_SIZE = 75;
const BATCH_DELAY_MS = 100;
const IMAGE_DELAY_MS = 100;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Strip back-face name from DFC cards: "Sheoldred // The True Scriptures" → "Sheoldred" */
function dfcFrontFace(name) {
  const idx = name.indexOf(' // ');
  return idx >= 0 ? name.substring(0, idx) : name;
}

/** Build a filesystem-safe filename for a card image. */
function buildFilename(idx, displayName, setCode, collectorNumber, suffix = '') {
  const safeName = displayName.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');
  const setPart = setCode ? `_(${setCode})` : '';
  const collPart = collectorNumber ? `_${collectorNumber}` : '';
  const suffixPart = suffix ? `_${suffix}` : '';
  return `${String(idx).padStart(3, '0')}_${safeName}${setPart}${collPart}${suffixPart}.png`;
}

/**
 * Fetch image URLs for cards using Scryfall's /cards/collection endpoint.
 * @param {Array<{displayName, quantity, setCode?, collectorNumber?, isFoil?}>} cards
 * @returns {Array<{displayName, quantity, setCode, collectorNumber, isFoil, imageUrls: {front, back?}, isDFC}>}
 */
export async function fetchCardImageUrls(cards) {
  if (!cards || cards.length === 0) return [];

  // Deduplicate by composite key (set+collector) or bare name
  const seen = new Map(); // key → card entry
  const entries = []; // ordered unique entries with Scryfall identifiers

  for (const card of cards) {
    const nameLower = card.displayName.toLowerCase();
    const key = card.collectorNumber
      ? `${nameLower}|${card.setCode?.toLowerCase() || ''}|${card.collectorNumber}`
      : nameLower;

    if (seen.has(key)) {
      // Accumulate quantity for duplicate entries
      seen.get(key).quantity += card.quantity;
      continue;
    }

    const entry = {
      displayName: card.displayName,
      quantity: card.quantity,
      setCode: card.setCode || '',
      collectorNumber: card.collectorNumber || '',
      isFoil: card.isFoil || false,
      imageUrls: null,
      isDFC: false,
      key,
    };

    // Build Scryfall identifier
    if (card.setCode && card.collectorNumber) {
      entry.identifier = {
        set: card.setCode.toLowerCase(),
        collector_number: String(card.collectorNumber),
      };
    } else {
      entry.identifier = { name: dfcFrontFace(card.displayName) };
    }

    seen.set(key, entry);
    entries.push(entry);
  }

  // Batch query Scryfall
  const batches = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    if (b > 0) await delay(BATCH_DELAY_MS);

    const batch = batches[b];
    const identifiers = batch.map(e => e.identifier);

    try {
      const res = await fetch(`${SCRYFALL_API}/cards/collection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CardListCompare/1.0',
        },
        body: JSON.stringify({ identifiers }),
      });

      if (!res.ok) {
        console.error(`Scryfall batch ${b + 1}/${batches.length} failed: ${res.status}`);
        continue;
      }

      const data = await res.json();

      for (const card of (data.data || [])) {
        // Match result back to our entry
        const matchEntry = findMatchingEntry(batch, card);
        if (!matchEntry) continue;

        // Determine if DFC: top-level image_uris missing means per-face images
        if (card.image_uris) {
          // Single-faced (or shared image like adventure/split)
          matchEntry.imageUrls = {
            front: card.image_uris.png || card.image_uris.large || card.image_uris.normal,
          };
          matchEntry.isDFC = false;
        } else if (card.card_faces && card.card_faces.length >= 2
          && card.card_faces[0].image_uris) {
          // True DFC: each face has its own image
          matchEntry.imageUrls = {
            front: card.card_faces[0].image_uris.png
              || card.card_faces[0].image_uris.large
              || card.card_faces[0].image_uris.normal,
            back: card.card_faces[1].image_uris.png
              || card.card_faces[1].image_uris.large
              || card.card_faces[1].image_uris.normal,
          };
          matchEntry.isDFC = true;
        }
      }

      if (data.not_found?.length > 0) {
        for (const nf of data.not_found) {
          console.warn('Scryfall not found:', nf.name || `${nf.set}/${nf.collector_number}`);
        }
      }
    } catch (err) {
      console.error(`Scryfall batch ${b + 1} error:`, err.message);
    }
  }

  // Return only entries that got image URLs
  return entries.filter(e => e.imageUrls?.front);
}

/** Match a Scryfall response card object back to our batch entry. */
function findMatchingEntry(batch, card) {
  // Try set+collector match first (most specific)
  if (card.set && card.collector_number) {
    const match = batch.find(e =>
      e.identifier.set === card.set
      && String(e.identifier.collector_number) === String(card.collector_number)
    );
    if (match) return match;
  }

  // Fall back to name match
  const cardNameLower = card.name.toLowerCase();
  const frontFaceLower = dfcFrontFace(cardNameLower);
  return batch.find(e => {
    const entryName = (e.identifier.name || e.displayName).toLowerCase();
    return entryName === cardNameLower
      || entryName === frontFaceLower
      || dfcFrontFace(entryName) === frontFaceLower;
  });
}

/**
 * Download all card images and build the file list for ZIP creation.
 * One file per card copy. DFC cards produce front + back files per copy.
 * @param {Array} cardsWithUrls — output of fetchCardImageUrls()
 * @returns {{ images: Array<{filename, buffer}>, totalCards: number, downloadedCards: number, failedCards: number }}
 */
export async function downloadCardImages(cardsWithUrls) {
  const images = [];
  let idx = 1;
  let downloadedCards = 0;
  let failedCards = 0;
  const totalCards = cardsWithUrls.reduce((sum, c) => sum + c.quantity, 0);

  // Pre-download unique images to avoid re-fetching duplicates (same URL)
  const imageCache = new Map(); // url → buffer

  for (const card of cardsWithUrls) {
    for (let copy = 0; copy < card.quantity; copy++) {
      // Download front
      const frontBuf = await getImage(card.imageUrls.front, imageCache);
      if (!frontBuf) {
        failedCards++;
        continue;
      }

      const suffix = card.isDFC ? 'front' : '';
      images.push({
        filename: buildFilename(idx, card.displayName, card.setCode, card.collectorNumber, suffix),
        buffer: frontBuf,
      });
      idx++;

      // Download back face if DFC
      if (card.isDFC && card.imageUrls.back) {
        const backBuf = await getImage(card.imageUrls.back, imageCache);
        if (backBuf) {
          images.push({
            filename: buildFilename(idx, card.displayName, card.setCode, card.collectorNumber, 'back'),
            buffer: backBuf,
          });
          idx++;
        }
      }

      downloadedCards++;
    }
  }

  return { images, totalCards, downloadedCards, failedCards };
}

/**
 * Download all card images using a persistent disk cache.
 * Checks disk cache before fetching from Scryfall, stores new downloads to cache.
 * @param {Array} cardsWithUrls — output of fetchCardImageUrls()
 * @param {Function} [progressCallback] — (downloaded, cached, total) called after each card
 * @returns {{ images: Array<{filename, buffer}>, totalCards, downloadedCards, cachedCards, failedCards }}
 */
export async function downloadCardImagesWithCache(cardsWithUrls, progressCallback) {
  const { getCachedImage, getCachedImageByName, cacheImage, cacheImageByName } = await import('./imageCache.js');

  const images = [];
  let idx = 1;
  let downloadedCards = 0;
  let cachedCards = 0;
  let failedCards = 0;
  const totalCards = cardsWithUrls.reduce((sum, c) => sum + c.quantity, 0);

  // In-memory URL dedup within this job (avoids re-fetching same URL)
  const sessionCache = new Map();

  for (const card of cardsWithUrls) {
    // Resolve front image (disk cache → session cache → Scryfall)
    let frontBuf = null;
    let frontWasCached = false;

    if (card.setCode && card.collectorNumber) {
      frontBuf = getCachedImage(card.setCode, card.collectorNumber, null);
    } else {
      frontBuf = getCachedImageByName(card.displayName, null);
    }
    frontWasCached = !!frontBuf;

    if (!frontBuf) {
      frontBuf = sessionCache.get(card.imageUrls.front);
      if (!frontBuf) {
        frontBuf = await fetchSingleImage(card.imageUrls.front);
        if (frontBuf) {
          sessionCache.set(card.imageUrls.front, frontBuf);
          // Cache to disk
          if (card.setCode && card.collectorNumber) {
            cacheImage(card.setCode, card.collectorNumber, null, frontBuf);
          } else {
            cacheImageByName(card.displayName, null, frontBuf);
          }
        }
      }
    }

    if (!frontBuf) {
      failedCards += card.quantity;
      if (progressCallback) progressCallback(downloadedCards, cachedCards, totalCards);
      continue;
    }

    // Resolve back face for DFC
    let backBuf = null;
    let backWasCached = false;
    if (card.isDFC && card.imageUrls.back) {
      if (card.setCode && card.collectorNumber) {
        backBuf = getCachedImage(card.setCode, card.collectorNumber, 'back');
      } else {
        backBuf = getCachedImageByName(card.displayName, 'back');
      }
      backWasCached = !!backBuf;

      if (!backBuf) {
        backBuf = sessionCache.get(card.imageUrls.back);
        if (!backBuf) {
          backBuf = await fetchSingleImage(card.imageUrls.back);
          if (backBuf) {
            sessionCache.set(card.imageUrls.back, backBuf);
            if (card.setCode && card.collectorNumber) {
              cacheImage(card.setCode, card.collectorNumber, 'back', backBuf);
            } else {
              cacheImageByName(card.displayName, 'back', backBuf);
            }
          }
        }
      }
    }

    // Add one file per card copy
    for (let copy = 0; copy < card.quantity; copy++) {
      const suffix = card.isDFC ? 'front' : '';
      images.push({
        filename: buildFilename(idx, card.displayName, card.setCode, card.collectorNumber, suffix),
        buffer: frontBuf,
      });
      idx++;

      if (card.isDFC && backBuf) {
        images.push({
          filename: buildFilename(idx, card.displayName, card.setCode, card.collectorNumber, 'back'),
          buffer: backBuf,
        });
        idx++;
      }

      downloadedCards++;
      if (frontWasCached && (!card.isDFC || backWasCached)) cachedCards++;
    }

    if (progressCallback) progressCallback(downloadedCards, cachedCards, totalCards);
  }

  return { images, totalCards, downloadedCards, cachedCards, failedCards };
}

/**
 * Fetch a single image from a Scryfall CDN URL with rate limiting.
 * @returns {Buffer|null}
 */
async function fetchSingleImage(url) {
  await delay(IMAGE_DELAY_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CardListCompare/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`Image download failed (${res.status}): ${url}`);
      return null;
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('Image download error:', err.message);
    return null;
  }
}

/**
 * Download an image URL, using an in-memory cache to avoid re-fetching identical URLs.
 * @deprecated Use downloadCardImagesWithCache for persistent caching.
 */
async function getImage(url, cache) {
  if (cache.has(url)) return cache.get(url);

  const buffer = await fetchSingleImage(url);
  if (buffer) cache.set(url, buffer);
  return buffer;
}
