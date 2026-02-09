import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { archidektLimiter } from '../middleware/rateLimit.js';
import { requireIntParam } from '../middleware/validate.js';
import { fetchOwnerDecks } from '../lib/archidekt.js';

const router = Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const owners = all('SELECT * FROM tracked_owners WHERE user_id = ? ORDER BY added_at DESC', [req.user.userId]);
  res.json({ owners });
});

router.post('/', (req, res) => {
  const { archidektUsername } = req.body;

  if (!archidektUsername || typeof archidektUsername !== 'string' || archidektUsername.trim().length === 0 || archidektUsername.trim().length > 60) {
    return res.status(400).json({ error: 'Archidekt username is required (max 60 characters)' });
  }

  const name = archidektUsername.trim();

  const existing = get(
    'SELECT id FROM tracked_owners WHERE user_id = ? AND archidekt_username = ?',
    [req.user.userId, name]
  );
  if (existing) {
    return res.status(409).json({ error: 'You are already tracking this username' });
  }

  try {
    const result = run('INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (?, ?)', [req.user.userId, name]);
    const owner = get('SELECT * FROM tracked_owners WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json({ owner });
  } catch (err) {
    console.error('Add owner error:', err);
    res.status(500).json({ error: 'Failed to add owner' });
  }
});

router.delete('/:id', (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const owner = get('SELECT * FROM tracked_owners WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!owner) {
    return res.status(404).json({ error: 'Tracked owner not found' });
  }

  run('DELETE FROM tracked_owners WHERE id = ?', [id]);
  res.json({ success: true });
});

router.get('/:id/decks', archidektLimiter, async (req, res) => {
  const id = requireIntParam(req, res, 'id');
  if (id === null) return;

  const owner = get('SELECT * FROM tracked_owners WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!owner) {
    return res.status(404).json({ error: 'Tracked owner not found' });
  }

  try {
    const decks = await fetchOwnerDecks(owner.archidekt_username);

    const tracked = all(
      'SELECT archidekt_deck_id FROM tracked_decks WHERE user_id = ?',
      [req.user.userId]
    );
    const trackedIds = tracked.map(d => d.archidekt_deck_id);

    const decksWithStatus = decks.map(d => ({
      ...d,
      tracked: trackedIds.includes(d.id),
    }));

    res.json({ decks: decksWithStatus });
  } catch (err) {
    console.error('Fetch owner decks error:', err);
    res.status(502).json({ error: `Failed to fetch decks from Archidekt: ${err.message}` });
  }
});

export default router;
