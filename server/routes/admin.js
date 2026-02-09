import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, get, run, getDb } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// All admin routes require auth + admin
router.use(requireAuth);
router.use(requireAdmin);

// --- Stats Dashboard ---

router.get('/stats', (_req, res) => {
  const totalUsers = get('SELECT COUNT(*) as count FROM users');
  const totalDecks = get('SELECT COUNT(*) as count FROM tracked_decks');
  const totalSnapshots = get('SELECT COUNT(*) as count FROM deck_snapshots');
  const totalShares = get('SELECT COUNT(*) as count FROM shared_comparisons');

  const db = getDb();
  const dbData = db.export();
  const dbSizeBytes = dbData.length;

  res.json({
    totalUsers: totalUsers.count,
    totalTrackedDecks: totalDecks.count,
    totalSnapshots: totalSnapshots.count,
    totalSharedComparisons: totalShares.count,
    dbSizeBytes,
  });
});

// --- User Management ---

router.get('/users', (_req, res) => {
  const users = all(`
    SELECT
      u.id, u.username, u.email, u.is_admin, u.created_at,
      COUNT(DISTINCT d.id) as tracked_deck_count,
      COUNT(DISTINCT s.id) as snapshot_count
    FROM users u
    LEFT JOIN tracked_decks d ON d.user_id = u.id
    LEFT JOIN deck_snapshots s ON s.tracked_deck_id = d.id
    GROUP BY u.id
    ORDER BY u.created_at ASC
  `);

  res.json({ users });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Use Account Settings to change your own password' });
  }

  const user = get('SELECT id, username FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { newPassword } = req.body;
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'New password must be 8-128 characters' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);

  res.json({ success: true });
});

router.delete('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account from admin panel' });
  }

  const user = get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  run('DELETE FROM users WHERE id = ?', [userId]);
  res.json({ success: true });
});

router.patch('/users/:id/toggle-admin', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Cannot change your own admin status' });
  }

  const user = get('SELECT id, is_admin FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Prevent removing the last admin
  if (user.is_admin) {
    const adminCount = get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
    if (adminCount.count <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
  }

  const newStatus = user.is_admin ? 0 : 1;
  run('UPDATE users SET is_admin = ? WHERE id = ?', [newStatus, userId]);

  res.json({ success: true, isAdmin: !!newStatus });
});

// --- Server Settings ---

router.get('/settings', (_req, res) => {
  const settings = all('SELECT key, value FROM server_settings');
  const result = {};
  for (const s of settings) {
    result[s.key] = s.value;
  }
  res.json({ settings: result });
});

router.put('/settings/:key', (req, res) => {
  const allowedKeys = ['registration_enabled'];
  const { key } = req.params;
  const { value } = req.body;

  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: 'Unknown setting' });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'Value must be a string' });
  }

  run(
    `INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );

  res.json({ success: true });
});

// --- Shared Comparison Moderation ---

router.get('/shares', (_req, res) => {
  const shares = all(`
    SELECT id, title, created_at,
      LENGTH(before_text) as before_length,
      LENGTH(after_text) as after_length
    FROM shared_comparisons
    ORDER BY created_at DESC
  `);
  res.json({ shares });
});

router.delete('/shares/:id', (req, res) => {
  const { id } = req.params;
  const share = get('SELECT id FROM shared_comparisons WHERE id = ?', [id]);
  if (!share) return res.status(404).json({ error: 'Shared comparison not found' });

  run('DELETE FROM shared_comparisons WHERE id = ?', [id]);
  res.json({ success: true });
});

export default router;
