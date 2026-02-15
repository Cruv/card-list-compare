/**
 * MPC Autofill routes — search for proxy card images and generate
 * XML project files or downloadable ZIP bundles.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { mpcLimiter } from '../middleware/rateLimit.js';
import {
  checkHealth,
  searchCards,
  fetchCardDetails,
  getDFCPairs,
  generateXml,
  downloadImages,
} from '../lib/mpcautofill.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/mpc/health — Check if MPC Autofill backend is reachable.
 */
router.get('/health', async (_req, res) => {
  try {
    const status = await checkHealth();
    res.json(status);
  } catch (err) {
    console.error('MPC health check error:', err);
    res.json({ online: false });
  }
});

/**
 * POST /api/mpc/search — Search for proxy card images.
 * Body: { cards: [{ name, quantity }] }
 * Returns: { results, dfcPairs, unmatchedCount }
 */
router.post('/search', mpcLimiter, async (req, res) => {
  try {
    const { cards } = req.body;
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'cards array is required' });
    }
    if (cards.length > 612) {
      return res.status(400).json({ error: 'Maximum 612 cards per request' });
    }

    const cardNames = cards.map(c => c.name).filter(Boolean);

    // Search and fetch DFC pairs in parallel
    const [searchResults, dfcPairs] = await Promise.all([
      searchCards(cardNames),
      getDFCPairs(),
    ]);

    // Collect first (best) identifier per card for detail fetching
    const firstIds = [];
    for (const [, identifiers] of searchResults) {
      if (identifiers.length > 0) {
        firstIds.push(identifiers[0]);
      }
    }

    // Fetch card details for the best match per card
    const cardDetails = firstIds.length > 0
      ? await fetchCardDetails(firstIds)
      : new Map();

    // Build results array
    const results = [];
    let unmatchedCount = 0;

    for (const card of cards) {
      const nameLower = card.name.toLowerCase();
      const identifiers = searchResults.get(nameLower) || [];
      const hasMatch = identifiers.length > 0;

      if (!hasMatch) {
        unmatchedCount++;
        results.push({
          name: card.name,
          quantity: card.quantity || 1,
          identifier: null,
          thumbnailUrl: null,
          dpi: null,
          sourceName: null,
          hasMatch: false,
          alternateCount: 0,
        });
        continue;
      }

      const bestId = identifiers[0];
      const details = cardDetails.get(bestId);

      results.push({
        name: card.name,
        quantity: card.quantity || 1,
        identifier: bestId,
        thumbnailUrl: details?.thumbnailUrl || `https://drive.google.com/thumbnail?sz=w400-h400&id=${bestId}`,
        dpi: details?.dpi || null,
        sourceName: details?.sourceName || null,
        extension: details?.extension || 'png',
        hasMatch: true,
        alternateCount: identifiers.length - 1,
      });
    }

    // Convert DFC pairs to serializable format
    const dfcPairsObj = {};
    for (const [front, back] of dfcPairs) {
      dfcPairsObj[front] = back;
    }

    res.json({
      results,
      dfcPairs: dfcPairsObj,
      unmatchedCount,
      totalCards: cards.length,
      matchedCards: cards.length - unmatchedCount,
    });
  } catch (err) {
    console.error('MPC search error:', err);
    res.status(500).json({ error: 'Failed to search MPC Autofill. The service may be unavailable.' });
  }
});

/**
 * POST /api/mpc/xml — Generate MPC Autofill XML project file.
 * Body: { cards: [{ name, quantity, identifier, extension }], cardstock?, foil? }
 * Returns: XML file download
 */
router.post('/xml', mpcLimiter, async (req, res) => {
  try {
    const { cards, cardstock, foil } = req.body;
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'cards array is required' });
    }

    // Filter to only cards with identifiers
    const validCards = cards.filter(c => c.identifier);
    if (validCards.length === 0) {
      return res.status(400).json({ error: 'No cards with valid identifiers' });
    }

    const xml = generateXml(validCards, { cardstock, foil });

    res.set({
      'Content-Type': 'application/xml',
      'Content-Disposition': 'attachment; filename="mpc-autofill-project.xml"',
    });
    res.send(xml);
  } catch (err) {
    console.error('MPC XML generation error:', err);
    res.status(500).json({ error: 'Failed to generate XML project file.' });
  }
});

/**
 * POST /api/mpc/download — Download card images as ZIP.
 * Body: { cards: [{ name, quantity, identifier, extension }] }
 * Returns: ZIP file download
 */
router.post('/download', mpcLimiter, async (req, res) => {
  try {
    const { cards } = req.body;
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'cards array is required' });
    }

    // Deduplicate by identifier (same image used for multiple copies)
    const seen = new Set();
    const uniqueCards = [];
    for (const card of cards) {
      if (!card.identifier) continue;
      if (seen.has(card.identifier)) continue;
      seen.add(card.identifier);
      uniqueCards.push(card);
    }

    if (uniqueCards.length === 0) {
      return res.status(400).json({ error: 'No cards with valid identifiers' });
    }

    // Download all images
    const images = await downloadImages(uniqueCards);

    if (images.length === 0) {
      return res.status(502).json({ error: 'Failed to download any images. The image service may be unavailable.' });
    }

    // Build ZIP using archiver
    const archiver = (await import('archiver')).default;
    const archive = archiver('zip', { zlib: { level: 1 } }); // Fast compression (images are already compressed)

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="mpc-card-images.zip"',
    });

    archive.pipe(res);

    // Add each image with numbered filename
    let idx = 1;
    for (const img of images) {
      const safeName = img.name.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');
      const filename = `${String(idx).padStart(3, '0')}_${safeName}.${img.extension}`;
      archive.append(img.buffer, { name: filename });
      idx++;
    }

    await archive.finalize();
  } catch (err) {
    console.error('MPC download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download card images.' });
    }
  }
});

export default router;
