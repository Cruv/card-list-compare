import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, get, run, getDb } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validatePassword } from '../middleware/validate.js';

const router = Router();

// All admin routes require auth + admin
router.use(requireAuth);
router.use(requireAdmin);

// --- Audit Log Helper ---

function logAdminAction(adminUserId, adminUsername, action, targetUserId, targetUsername, details) {
  run(
    `INSERT INTO admin_audit_log (admin_user_id, admin_username, action, target_user_id, target_username, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [adminUserId, adminUsername, action, targetUserId || null, targetUsername || null, details || null]
  );
}

// --- Stats Dashboard ---

router.get('/stats', (_req, res) => {
  const totalUsers = get('SELECT COUNT(*) as count FROM users');
  const totalDecks = get('SELECT COUNT(*) as count FROM tracked_decks');
  const totalSnapshots = get('SELECT COUNT(*) as count FROM deck_snapshots');
  const totalShares = get('SELECT COUNT(*) as count FROM shared_comparisons');
  const suspendedUsers = get('SELECT COUNT(*) as count FROM users WHERE suspended = 1');
  const recentLogins = get("SELECT COUNT(*) as count FROM users WHERE last_login_at > datetime('now', '-7 days')");

  const db = getDb();
  const dbData = db.export();
  const dbSizeBytes = dbData.length;

  res.json({
    totalUsers: totalUsers.count,
    totalTrackedDecks: totalDecks.count,
    totalSnapshots: totalSnapshots.count,
    totalSharedComparisons: totalShares.count,
    suspendedUsers: suspendedUsers.count,
    recentLogins: recentLogins.count,
    dbSizeBytes,
  });
});

// --- User Management ---

// Whitelisted sort columns to prevent SQL injection
const SORT_COLUMNS = {
  username: 'u.username',
  created_at: 'u.created_at',
  last_login_at: 'u.last_login_at',
  tracked_deck_count: 'tracked_deck_count',
};

router.get('/users', (req, res) => {
  const search = req.query.search || '';
  const sortKey = req.query.sort || 'created_at';
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;

  const sortColumn = SORT_COLUMNS[sortKey] || 'u.created_at';

  // Build WHERE clause for search
  let whereClause = '';
  const params = [];
  if (search.trim()) {
    whereClause = 'WHERE (u.username LIKE ? OR u.email LIKE ?)';
    const pattern = `%${search.trim()}%`;
    params.push(pattern, pattern);
  }

  // Count total matching users
  const countRow = get(`SELECT COUNT(*) as count FROM users u ${whereClause}`, params);
  const total = countRow.count;

  // Fetch page of users
  const users = all(`
    SELECT
      u.id, u.username, u.email, u.is_admin, u.created_at,
      u.last_login_at, u.suspended, u.email_verified,
      u.failed_login_attempts, u.locked_until,
      COUNT(DISTINCT d.id) as tracked_deck_count,
      COUNT(DISTINCT s.id) as snapshot_count
    FROM users u
    LEFT JOIN tracked_decks d ON d.user_id = u.id
    LEFT JOIN deck_snapshots s ON s.tracked_deck_id = d.id
    ${whereClause}
    GROUP BY u.id
    ORDER BY ${sortColumn} ${order}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.json({ users, total, page, limit });
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
  const pwError = validatePassword(newPassword);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  run("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?", [hash, userId]);

  logAdminAction(req.user.userId, req.user.username, 'reset_password', userId, user.username, null);

  res.json({ success: true });
});

router.delete('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account from admin panel' });
  }

  const user = get('SELECT id, username FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  logAdminAction(req.user.userId, req.user.username, 'delete_user', userId, user.username, null);

  run('DELETE FROM users WHERE id = ?', [userId]);
  res.json({ success: true });
});

router.patch('/users/:id/toggle-admin', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Cannot change your own admin status' });
  }

  const user = get('SELECT id, username, is_admin FROM users WHERE id = ?', [userId]);
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

  const action = newStatus ? 'Promoted to admin' : 'Demoted from admin';
  logAdminAction(req.user.userId, req.user.username, 'toggle_admin', userId, user.username, action);

  res.json({ success: true, isAdmin: !!newStatus });
});

// --- Suspension ---

router.patch('/users/:id/suspend', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Cannot suspend your own account' });
  }

  const user = get('SELECT id, username, is_admin, suspended FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.is_admin) {
    return res.status(400).json({ error: 'Cannot suspend an admin. Remove admin status first.' });
  }

  if (user.suspended) {
    return res.status(400).json({ error: 'User is already suspended' });
  }

  run('UPDATE users SET suspended = 1 WHERE id = ?', [userId]);
  logAdminAction(req.user.userId, req.user.username, 'suspend_user', userId, user.username, null);

  res.json({ success: true });
});

router.patch('/users/:id/unsuspend', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const user = get('SELECT id, username, suspended FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.suspended) {
    return res.status(400).json({ error: 'User is not suspended' });
  }

  run('UPDATE users SET suspended = 0 WHERE id = ?', [userId]);
  logAdminAction(req.user.userId, req.user.username, 'unsuspend_user', userId, user.username, null);

  res.json({ success: true });
});

// --- Force Logout ---

router.patch('/users/:id/force-logout', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  if (userId === req.user.userId) {
    return res.status(400).json({ error: 'Cannot force-logout yourself' });
  }

  const user = get('SELECT id, username FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  run("UPDATE users SET password_changed_at = datetime('now') WHERE id = ?", [userId]);
  logAdminAction(req.user.userId, req.user.username, 'force_logout', userId, user.username, null);

  res.json({ success: true });
});

// --- Unlock Account ---

router.patch('/users/:id/unlock', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const user = get('SELECT id, username, locked_until FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  run('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [userId]);
  logAdminAction(req.user.userId, req.user.username, 'unlock_user', userId, user.username, null);

  res.json({ success: true });
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

  logAdminAction(req.user.userId, req.user.username, 'update_setting', null, null, `${key} = ${value}`);

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
  const share = get('SELECT id, title FROM shared_comparisons WHERE id = ?', [id]);
  if (!share) return res.status(404).json({ error: 'Shared comparison not found' });

  logAdminAction(req.user.userId, req.user.username, 'delete_share', null, null, share.title || share.id);

  run('DELETE FROM shared_comparisons WHERE id = ?', [id]);
  res.json({ success: true });
});

// --- Audit Log ---

router.get('/audit-log', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const action = req.query.action || '';

  let whereClause = '';
  const params = [];
  if (action.trim()) {
    whereClause = 'WHERE action = ?';
    params.push(action.trim());
  }

  const countRow = get(`SELECT COUNT(*) as count FROM admin_audit_log ${whereClause}`, params);
  const total = countRow.count;

  const entries = all(`
    SELECT id, admin_username, action, target_username, details, created_at
    FROM admin_audit_log
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.json({ entries, total, page, limit });
});

export default router;
