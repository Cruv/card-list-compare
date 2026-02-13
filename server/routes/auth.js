import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { get, run } from '../db.js';
import { createToken, requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { validatePassword } from '../middleware/validate.js';
import { isEmailConfigured, sendPasswordResetEmail, sendVerificationEmail } from '../lib/email.js';

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
    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
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

    // Account lockout check
    if (user.locked_until) {
      const lockTime = new Date(user.locked_until + 'Z').getTime();
      if (lockTime > Date.now()) {
        const minutesLeft = Math.ceil((lockTime - Date.now()) / 60000);
        return res.status(429).json({ error: `Account locked. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.` });
      }
      // Lock expired — reset counters
      run('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      if (attempts >= 5) {
        const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        run('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?', [attempts, lockUntil, user.id]);
        return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      run('UPDATE users SET failed_login_attempts = ? WHERE id = ?', [attempts, user.id]);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Successful login — reset lockout counters and track last login
    run("UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?", [user.id]);

    const token = createToken(user);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email || null, isAdmin: !!user.is_admin } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const user = get('SELECT id, username, email, is_admin, created_at, last_login_at, email_verified FROM users WHERE id = ?', [req.user.userId]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: { id: user.id, username: user.username, email: user.email || null, isAdmin: !!user.is_admin, createdAt: user.created_at, lastLoginAt: user.last_login_at || null, emailVerified: !!user.email_verified } });
});

// Change password (requires current password)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ error: pwError });
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
    run("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?", [hash, user.id]);

    // Issue a new token so the current session stays valid
    const freshUser = get('SELECT * FROM users WHERE id = ?', [user.id]);
    const token = createToken(freshUser);

    res.json({ success: true, token });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Update email
router.put('/email', requireAuth, async (req, res) => {
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

      run('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?', [email.toLowerCase(), req.user.userId]);

      // Send verification email if SMTP is configured
      if (isEmailConfigured()) {
        // Clean up old tokens for this user
        run('DELETE FROM email_verification_tokens WHERE user_id = ?', [req.user.userId]);
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
        run('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
          [req.user.userId, token, expiresAt]);
        await sendVerificationEmail(email.toLowerCase(), token);
      }
    } else {
      run('UPDATE users SET email = NULL, email_verified = 0 WHERE id = ?', [req.user.userId]);
    }

    const user = get('SELECT id, username, email, email_verified, created_at FROM users WHERE id = ?', [req.user.userId]);
    res.json({ user: { id: user.id, username: user.username, email: user.email || null, emailVerified: !!user.email_verified, createdAt: user.created_at } });
  } catch (err) {
    console.error('Update email error:', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// Verify email with token
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    const record = get(
      'SELECT * FROM email_verification_tokens WHERE token = ? AND expires_at > datetime("now")',
      [token]
    );
    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired verification link.' });
    }

    run('UPDATE users SET email_verified = 1 WHERE id = ?', [record.user_id]);
    run('DELETE FROM email_verification_tokens WHERE user_id = ?', [record.user_id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// Resend verification email
router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const user = get('SELECT id, email, email_verified FROM users WHERE id = ?', [req.user.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!user.email) {
      return res.status(400).json({ error: 'No email address on file' });
    }
    if (user.email_verified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }
    if (!isEmailConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on this server.' });
    }

    // Clean up old tokens and generate new one
    run('DELETE FROM email_verification_tokens WHERE user_id = ?', [user.id]);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    run('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, token, expiresAt]);
    await sendVerificationEmail(user.email, token);

    res.json({ success: true });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// Forgot password — send reset email
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (typeof email !== 'string' || email.length > 254) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    if (!isEmailConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on this server. Contact your admin to reset your password.' });
    }

    // Always return success to prevent email enumeration
    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (user && user.email_verified) {
      // Only send reset email if email is verified
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
    if (typeof token !== 'string' || token.length > 128) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const resetToken = get(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")',
      [token]
    );

    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    run("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?", [hash, resetToken.user_id]);
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
