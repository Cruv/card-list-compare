import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { get, run } from '../db.js';
import { createToken, requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post('/register', authLimiter, async (req, res) => {
  try {
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

    const user = { id: result.lastInsertRowid, username: username.trim() };
    const token = createToken(user);

    res.status(201).json({ token, user: { id: user.id, username: user.username } });
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

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createToken(user);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const user = get('SELECT id, username, created_at FROM users WHERE id = ?', [req.user.userId]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: { id: user.id, username: user.username } });
});

export default router;
