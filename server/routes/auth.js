import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { get, run } from '../db.js';
import { createToken, requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { isEmailConfigured, sendPasswordResetEmail } from '../lib/email.js';

const router = Router();

router.post('/register', authLimiter, async (req, res) => {
  try {
    // Check if registration is enabled
    const regSetting = get("SELECT value FROM server_settings WHERE key = 'registration_enabled'");
    if (regSetting && regSetting.value === 'false') {
      return res.status(403).json({ error: 'Registration is currently disabled. Contact an admin for an account.' });
    }

    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username.trim())) {
      return res.status(400).json({ error: 'Username may only contain letters, numbers, hyphens, and underscores' });
    }
    if (!password || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters' });
    }

    const existing = get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username.trim(), hash]);

    const user = { id: result.lastInsertRowid, username: username.trim(), is_admin: 0 };
    const token = createToken(user);

    res.status(201).json({ token, user: { id: user.id, username: user.username, email: null, isAdmin: false } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = get('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (user.suspended) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact an administrator.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Track last login time
    run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id]);

    const token = createToken(user);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email || null, isAdmin: !!user.is_admin } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const user = get('SELECT id, username, email, is_admin, created_at, last_login_at FROM users WHERE id = ?', [req.user.userId]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: { id: user.id, username: user.username, email: user.email || null, isAdmin: !!user.is_admin, createdAt: user.created_at, lastLoginAt: user.last_login_at || null } });
});

// Change password (requires current password)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8-128 characters' });
    }

    const user = get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Update email
router.put('/email', requireAuth, (req, res) => {
  try {
    const { email } = req.body;

    if (email !== null && email !== '') {
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      if (email.length > 254) {
        return res.status(400).json({ error: 'Email too long' });
      }

      const existing = get('SELECT id FROM users WHERE email = ? AND id != ?', [email.toLowerCase(), req.user.userId]);
      if (existing) {
        return res.status(409).json({ error: 'Email already in use by another account' });
      }

      run('UPDATE users SET email = ? WHERE id = ?', [email.toLowerCase(), req.user.userId]);
    } else {
      run('UPDATE users SET email = NULL WHERE id = ?', [req.user.userId]);
    }

    const user = get('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.user.userId]);
    res.json({ user: { id: user.id, username: user.username, email: user.email || null, createdAt: user.created_at } });
  } catch (err) {
    console.error('Update email error:', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// Forgot password — send reset email
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!isEmailConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on this server. Contact your admin to reset your password.' });
    }

    // Always return success to prevent email enumeration
    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (user) {
      // Invalidate any existing unused tokens for this user
      run('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0', [user.id]);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      run('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, token, expiresAt]);

      await sendPasswordResetEmail(email.toLowerCase(), token);
    }

    res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// Reset password with token
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8-128 characters' });
    }

    const resetToken = get(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")',
      [token]
    );

    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, resetToken.user_id]);
    run('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [resetToken.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Delete account
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { confirmUsername } = req.body;

    if (!confirmUsername) {
      return res.status(400).json({ error: 'Username confirmation is required' });
    }

    const user = get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (confirmUsername.toLowerCase() !== user.username.toLowerCase()) {
      return res.status(400).json({ error: 'Username does not match' });
    }

    run('DELETE FROM users WHERE id = ?', [user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Check if email is configured (public endpoint for UI)
router.get('/email-configured', (_req, res) => {
  res.json({ configured: isEmailConfigured() });
});

// Check if registration is open (public endpoint for UI)
router.get('/registration-status', (_req, res) => {
  const setting = get("SELECT value FROM server_settings WHERE key = 'registration_enabled'");
  const enabled = !setting || setting.value !== 'false';
  res.json({ registrationEnabled: enabled });
});

export default router;
