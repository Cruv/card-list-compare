import { Router } from 'express';
import crypto from 'crypto';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { archidektLimiter } from '../middleware/rateLimit.js';
import { requireIntParam, requireMaxLength } from '../middleware/validate.js';
import { fetchDeck } from '../lib/archidekt.js';
import { archidektToText } from '../lib/deckToText.js';
import { enrichDeckText } from '../lib/enrichDeckText.js';
import { pruneSnapshots } from '../lib/pruneSnapshots.js';

const router = Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const decks = all(`
    SELECT d.*,
      (SELECT MAX(s.created_at) FROM deck_snapshots s WHERE s.tracked_deck_id = d.id) as latest_snapshot_at,
      (SELECT COUNT(*) FROM deck_snapshots s WHERE s.tracked_deck_id = d.id) as snapshot_count,
      o.archidekt_username,
      sdv.id as share_id
    FROM tracked_decks d
    JOIN tracked_owners o ON d.tracked_owner_id = o.id
    LEFT JOIN shared_deck_views sdv ON sdv.tracked_deck_id = d.id
    WHERE d.user_id = ?
    ORDER BY d.pinned DESC, d.deck_name ASC
  `, [req.user.userId]);

  // Attach tags to each deck
  for (const deck of decks) {
    const tags = all('SELECT tag FROM deck_tags WHERE tracked_deck_id = ? ORDER BY tag ASC', [deck.id]);
    deck.tags = tags.map(t => t.tag);
  }

  res.json({ decks });
});

router.post('/', archidektLimiter, async (req, res) => {
  const { trackedOwnerId, archidektDeckId, deckName, deckUrl } = req.body;

  if (!trackedOwnerId || !archidektDeckId || !deckName) {
    return res.status(400).json({ error: 'trackedOwnerId, archidektDeckId, and deckName are required' });
  }
  if (typeof archidektDeckId !== 'number' || !Number.isInteger(archidektDeckId) || archidektDeckId <= 0) {
    return res.status(400).json({ error: 'archidektDeckId must be a positive integer' });
  }
  if (!requireMaxLength(res, deckName, 200, 'Deck name')) return;
  if (deckUrl && !requireMaxLength(res, deckUrl, 500, 'Deck URL')) return;

  const owner = get('SELECT * FROM tracked_owners WHERE id = ? AND user_id = ?', [trackedOwnerId, req.user.userId]);
  if (!owner) {
    return res.status(404).json({ error: 'Tracked owner not found' });
  }

  const existing = get(
    'SELECT id FROM tracked_decks WHERE user_id = ? AND archidekt_deck_id = ?',
    [req.user.userId, archidektDeckId]
  );
  if (existing) {
    return res.status(409).json({ error: 'You are already tracking this deck' });
  }

  try {
    const result = run(
      'INSERT INTO tracked_decks (user_id, tracked_owner_id, archidekt_deck_id, deck_name, deck_url) VALUES (?, ?, ?, ?, ?)',
      [req.user.userId, trackedOwnerId, archidektDeckId, deckName, deckUrl || null]
    );

    const deckId = result.lastInsertRowid;

    // Fetch initial snapshot and extract commanders
    try {
      const apiData = await fetchDeck(archidektDeckId);
      const { text, commanders } = archidektToText(apiData);
      // Enrich with Scryfall fallback for any cards missing metadata
      let enrichedText = text;
      try { enrichedText = await enrichDeckText(text, null); } catch { /* non-fatal */ }
      run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deckId, enrichedText]);
      pruneSnapshots(deckId);
      run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), commanders = ? WHERE id = ?',
        [JSON.stringify(commanders || []), deckId]);
    } catch (fetchErr) {
      console.error('Initial snapshot fetch failed:', fetchErr);
    }

    const deck = get('SELECT * FROM tracked_decks WHERE id = ?', [deckId]);
    res.status(201).json({ deck });
  } catch (err) {
    console.error('Track deck error:', err);
    res.status(500).json({ error: 'Failed to track deck' });
  }
});

router.post('/refresh-all', archidektLimiter, async (req, res) => {
  const decks = all(
    'SELECT * FROM tracked_decks WHERE user_id = ?',
    [req.user.userId]
  );

  if (decks.length === 0) {
    return res.json({ results: [], summary: { total: 0, changed: 0, failed: 0 } });
  }

  const results = [];

  for (const deck of decks) {
    try {
      const apiData = await fetchDeck(deck.archidekt_deck_id);
      const { text, commanders } = archidektToText(apiData);

      const latest = get(
        'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
        [deck.id]
      );

      // Enrich with carry-forward from previous snapshot + Scryfall fallback
      let enrichedText = text;
      try { enrichedText = await enrichDeckText(text, latest?.deck_text || null); } catch { /* non-fatal */ }

      if (latest && latest.deck_text === enrichedText) {
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now") WHERE id = ?', [deck.id]);
        results.push({ deckId: deck.id, deckName: deck.deck_name, changed: false });
      } else {
        run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deck.id, enrichedText]);
        pruneSnapshots(deck.id);
        // Update commanders if detected (don't blank out user-set values)
        const cmdsJson = commanders && commanders.length > 0 ? JSON.stringify(commanders) : null;
        if (cmdsJson) {
          run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, commanders = ? WHERE id = ?',
            [apiData.name || deck.deck_name, cmdsJson, deck.id]);
        } else {
          run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ? WHERE id = ?',
            [apiData.name || deck.deck_name, deck.id]);
        }
        results.push({ deckId: deck.id, deckName: deck.deck_name, changed: true });
      }
    } catch (err) {
      console.error(`Refresh failed for deck ${deck.id}:`, err.message);
      results.push({ deckId: deck.id, deckName: deck.deck_name, error: err.message });
    }
  }

  const summary = {
    total: results.length,
    changed: results.filter(r => r.changed).length,
    failed: results.filter(r => r.error).length,
  };

  res.json({ results, summary });
});

router.delete('/:id', (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!deck) {
    return res.status(404).json({ error: 'Tracked deck not found' });
  }

  run('DELETE FROM tracked_decks WHERE id = ?', [id]);
  res.json({ success: true });
});

// Update deck metadata (commanders, notes, pinned, tags, etc.)
router.patch('/:id', (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!deck) {
    return res.status(404).json({ error: 'Tracked deck not found' });
  }

  const { commanders, notifyOnChange, notes, pinned, tags, discordWebhookUrl } = req.body;
  if (commanders !== undefined) {
    if (!Array.isArray(commanders) || !commanders.every(c => typeof c === 'string')) {
      return res.status(400).json({ error: 'Commanders must be an array of strings' });
    }
    if (commanders.length > 5) {
      return res.status(400).json({ error: 'Too many commanders' });
    }
    const cleaned = commanders.map(c => c.trim()).filter(Boolean);
    run('UPDATE tracked_decks SET commanders = ? WHERE id = ?', [JSON.stringify(cleaned), id]);
  }
  if (notifyOnChange !== undefined) {
    run('UPDATE tracked_decks SET notify_on_change = ? WHERE id = ?', [notifyOnChange ? 1 : 0, id]);
  }
  if (notes !== undefined) {
    if (notes !== null && typeof notes !== 'string') {
      return res.status(400).json({ error: 'Notes must be a string or null' });
    }
    if (notes && notes.length > 2000) {
      return res.status(400).json({ error: 'Notes must be under 2000 characters' });
    }
    run('UPDATE tracked_decks SET notes = ? WHERE id = ?', [notes?.trim() || null, id]);
  }
  if (pinned !== undefined) {
    run('UPDATE tracked_decks SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
      return res.status(400).json({ error: 'Tags must be an array of strings' });
    }
    if (tags.length > 10) {
      return res.status(400).json({ error: 'Too many tags (max 10)' });
    }
    // Replace all tags: delete existing, insert new
    run('DELETE FROM deck_tags WHERE tracked_deck_id = ?', [id]);
    const cleaned = [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
    for (const tag of cleaned) {
      if (tag.length > 30) {
        return res.status(400).json({ error: 'Each tag must be under 30 characters' });
      }
      run('INSERT INTO deck_tags (tracked_deck_id, tag) VALUES (?, ?)', [id, tag]);
    }
  }
  if (discordWebhookUrl !== undefined) {
    if (discordWebhookUrl !== null && typeof discordWebhookUrl !== 'string') {
      return res.status(400).json({ error: 'Discord webhook URL must be a string or null' });
    }
    if (discordWebhookUrl && !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(discordWebhookUrl)) {
      return res.status(400).json({ error: 'Invalid Discord webhook URL' });
    }
    run('UPDATE tracked_decks SET discord_webhook_url = ? WHERE id = ?', [discordWebhookUrl?.trim() || null, id]);
  }

  const updated = get('SELECT * FROM tracked_decks WHERE id = ?', [id]);
  // Attach tags
  const updatedTags = all('SELECT tag FROM deck_tags WHERE tracked_deck_id = ? ORDER BY tag ASC', [id]);
  updated.tags = updatedTags.map(t => t.tag);
  res.json({ deck: updated });
});

router.post('/:id/refresh', archidektLimiter, async (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!deck) {
    return res.status(404).json({ error: 'Tracked deck not found' });
  }

  try {
    const apiData = await fetchDeck(deck.archidekt_deck_id);
    const { text, commanders } = archidektToText(apiData);

    const latest = get(
      'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
      [deck.id]
    );

    // Enrich with carry-forward from previous snapshot + Scryfall fallback
    let enrichedText = text;
    try { enrichedText = await enrichDeckText(text, latest?.deck_text || null); } catch { /* non-fatal */ }

    if (latest && latest.deck_text === enrichedText) {
      run('UPDATE tracked_decks SET last_refreshed_at = datetime("now") WHERE id = ?', [deck.id]);
      return res.json({ changed: false, message: 'Deck is up to date' });
    }

    run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deck.id, enrichedText]);
    pruneSnapshots(deck.id);
    // Update commanders if detected (don't blank out user-set values)
    const cmdsJson = commanders && commanders.length > 0 ? JSON.stringify(commanders) : null;
    if (cmdsJson) {
      run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, commanders = ? WHERE id = ?',
        [apiData.name || deck.deck_name, cmdsJson, deck.id]);
    } else {
      run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ? WHERE id = ?',
        [apiData.name || deck.deck_name, deck.id]);
    }

    res.json({ changed: true, message: 'New snapshot saved' });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(502).json({ error: `Failed to refresh from Archidekt: ${err.message}` });
  }
});

// Batch export (for bulk operations)
router.post('/export-batch', (req, res) => {
  const { deckIds } = req.body;
  if (!Array.isArray(deckIds) || deckIds.length === 0) {
    return res.status(400).json({ error: 'deckIds must be a non-empty array' });
  }
  if (deckIds.length > 100) {
    return res.status(400).json({ error: 'Too many decks (max 100)' });
  }

  const results = [];
  for (const deckId of deckIds) {
    const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, req.user.userId]);
    if (!deck) continue;

    const snap = get(
      'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
      [deck.id]
    );

    let cmds = '';
    try { cmds = JSON.parse(deck.commanders || '[]').join(' / '); } catch { /* ignore */ }

    results.push({
      id: deck.id,
      name: deck.deck_name,
      commanders: cmds,
      text: snap?.deck_text || '',
    });
  }

  res.json({ decks: results });
});

// Share a deck (create shared view)
router.post('/:id/share', (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!deck) {
    return res.status(404).json({ error: 'Tracked deck not found' });
  }

  // Check if already shared
  const existing = get('SELECT id FROM shared_deck_views WHERE tracked_deck_id = ?', [id]);
  if (existing) {
    return res.json({ shareId: existing.id });
  }

  // Generate unique 8-char ID
  const shareId = crypto.randomBytes(6).toString('base64url');

  run(
    'INSERT INTO shared_deck_views (id, tracked_deck_id, user_id) VALUES (?, ?, ?)',
    [shareId, id, req.user.userId]
  );

  res.status(201).json({ shareId });
});

// Unshare a deck (remove shared view)
router.delete('/:id/share', (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!deck) {
    return res.status(404).json({ error: 'Tracked deck not found' });
  }

  run('DELETE FROM shared_deck_views WHERE tracked_deck_id = ? AND user_id = ?', [id, req.user.userId]);
  res.json({ success: true });
});

export default router;
