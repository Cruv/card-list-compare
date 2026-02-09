import { Router } from 'express';
import { get, run } from '../db.js';
import { shareLimiter } from '../middleware/rateLimit.js';
import { requireMaxLength } from '../middleware/validate.js';
import crypto from 'crypto';

const MAX_DECK_TEXT = 100_000; // ~100KB per text field

const router = Router();

// Create a shared comparison — no auth required
router.post('/', shareLimiter, (req, res) => {
  const { beforeText, afterText, title } = req.body;

  if (!beforeText && !afterText) {
    return res.status(400).json({ error: 'At least one deck list is required' });
  }
  if (!requireMaxLength(res, beforeText, MAX_DECK_TEXT, 'Before text')) return;
  if (!requireMaxLength(res, afterText, MAX_DECK_TEXT, 'After text')) return;
  if (!requireMaxLength(res, title, 200, 'Title')) return;

  const id = crypto.randomBytes(6).toString('base64url'); // ~8 chars, URL-safe

  try {
    run(
      'INSERT INTO shared_comparisons (id, before_text, after_text, title) VALUES (?, ?, ?, ?)',
      [id, beforeText || '', afterText || '', title || null]
    );
    res.status(201).json({ id, url: `/share/${id}` });
  } catch (err) {
    console.error('Share error:', err);
    res.status(500).json({ error: 'Failed to create shared link' });
  }
});

// Get a shared comparison — no auth required
router.get('/:id', (req, res) => {
  const comparison = get('SELECT * FROM shared_comparisons WHERE id = ?', [req.params.id]);
  if (!comparison) {
    return res.status(404).json({ error: 'Shared comparison not found' });
  }
  res.json({
    id: comparison.id,
    beforeText: comparison.before_text,
    afterText: comparison.after_text,
    title: comparison.title,
    createdAt: comparison.created_at,
  });
});

export default router;
