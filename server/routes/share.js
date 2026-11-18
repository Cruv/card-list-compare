import { Router } from 'express';
import { all, get, run, transaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { shareLimiter } from '../middleware/rateLimit.js';
import { requireMaxLength } from '../middleware/validate.js';
import crypto from 'crypto';

const MAX_DECK_TEXT = 100_000; // ~100KB per text field
const UTC_EXPIRY = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

const router = Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function authenticateCreator(req, res, next) {
  if (/^Bearer(?:\s|$)/i.test(req.get('Authorization') || '')) return requireAuth(req, res, next);
  next();
}

function expireTime(expiresAt) {
  if (expiresAt === null) return null;
  if (typeof expiresAt !== 'string' || !UTC_EXPIRY.test(expiresAt)) return undefined;
  const time = Date.parse(expiresAt);
  const canonical = expiresAt.replace(/(?:\.(\d{1,3}))?Z$/, (_, ms = '') => `.${ms.padEnd(3, '0')}Z`);
  return time > Date.now() && new Date(time).toISOString() === canonical ? time : undefined;
}

const expiryError = { error: 'Expiry must be a future UTC timestamp or null' };
const notFound = { error: 'Shared comparison not found' };

// Guest creation still works. A validated CLC session owns newly created links.
router.post('/', shareLimiter, authenticateCreator, (req, res) => {
  const { beforeText, afterText, title, expiresAt = null } = req.body || {};

  if ([beforeText, afterText, title].some(value => value != null && typeof value !== 'string')) {
    return res.status(400).json({ error: 'Deck lists and title must be text' });
  }
  if (!beforeText && !afterText) {
    return res.status(400).json({ error: 'At least one deck list is required' });
  }
  if (!requireMaxLength(res, beforeText, MAX_DECK_TEXT, 'Before text')) return;
  if (!requireMaxLength(res, afterText, MAX_DECK_TEXT, 'After text')) return;
  if (!requireMaxLength(res, title, 200, 'Title')) return;
  const expires = expireTime(expiresAt);
  if (expires === undefined) return res.status(400).json(expiryError);

  const id = crypto.randomBytes(16).toString('base64url');

  try {
    transaction(() => run(
      'INSERT INTO shared_comparisons (id, before_text, after_text, title, owner_user_id, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [id, beforeText || '', afterText || '', title || null, req.user?.userId ?? null, expires]
    ));
    res.status(201).json({ id, url: `/share/${id}` });
  } catch (err) {
    console.error('Share error:', err);
    res.status(500).json({ error: 'Failed to create shared link' });
  }
});

router.get('/mine', requireAuth, (req, res) => {
  const shares = all(`
    SELECT id, title, created_at, expires_at_ms FROM shared_comparisons
    WHERE owner_user_id = ? ORDER BY created_at DESC, id DESC
  `, [req.user.userId]);
  res.json({ shares: shares.map(share => ({
    id: share.id,
    title: share.title,
    createdAt: share.created_at,
    expiresAt: share.expires_at_ms == null ? null : new Date(share.expires_at_ms).toISOString(),
  })) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const params = [req.params.id, req.user.userId];
  const owned = get('SELECT expires_at_ms FROM shared_comparisons WHERE id = ? AND owner_user_id = ?', params);
  if (!owned) return res.status(404).json(notFound);

  const body = req.body || {};
  const expires = expireTime(body.expiresAt);
  if (Object.keys(body).length !== 1 || expires === undefined) return res.status(400).json(expiryError);
  if (expires !== owned.expires_at_ms) {
    transaction(() => run('UPDATE shared_comparisons SET expires_at_ms = ? WHERE id = ? AND owner_user_id = ?', [expires, ...params]));
  }
  res.json({ expiresAt: expires === null ? null : new Date(expires).toISOString() });
});

router.delete('/:id', requireAuth, (req, res) => {
  const params = [req.params.id, req.user.userId];
  if (!get('SELECT id FROM shared_comparisons WHERE id = ? AND owner_user_id = ?', params)) {
    return res.status(404).json(notFound);
  }
  transaction(() => run('DELETE FROM shared_comparisons WHERE id = ? AND owner_user_id = ?', params));
  res.json({ success: true });
});

// Get a shared comparison — no auth required
router.get('/:id', (req, res) => {
  const comparison = get(`
    SELECT id, before_text, after_text, title, created_at FROM shared_comparisons
    WHERE id = ? AND (expires_at_ms IS NULL OR expires_at_ms > ?)
  `, [req.params.id, Date.now()]);
  if (!comparison) {
    return res.status(404).json(notFound);
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
