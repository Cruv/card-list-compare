import jwt from 'jsonwebtoken';
import { get } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-production';

// Short-TTL cache to avoid redundant DB queries on multi-request page loads.
// A single page load can trigger 5-10 authenticated API calls within milliseconds —
// caching for 5 seconds eliminates all but the first DB hit.
const authCache = new Map(); // userId -> { suspended, passwordChangedAt, cachedAt }
const AUTH_CACHE_TTL = 5000; // 5 seconds

/**
 * Invalidate cached auth state for a user. Call this after any mutation
 * that affects login validity: password change, suspend, unsuspend, force-logout.
 */
export function invalidateAuthCache(userId) {
  authCache.delete(userId);
}

export function createToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, isAdmin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { userId: payload.userId, username: payload.username, isAdmin: !!payload.isAdmin };

    // Check if user account still exists, is not suspended, and session is still valid
    const now = Date.now();
    let authInfo = authCache.get(payload.userId);
    if (!authInfo || now - authInfo.cachedAt > AUTH_CACHE_TTL) {
      const dbUser = get('SELECT suspended, password_changed_at FROM users WHERE id = ?', [payload.userId]);
      if (!dbUser) {
        authCache.delete(payload.userId);
        return res.status(401).json({ error: 'User not found' });
      }
      authInfo = { suspended: dbUser.suspended, passwordChangedAt: dbUser.password_changed_at, cachedAt: now };
      authCache.set(payload.userId, authInfo);
    }

    if (authInfo.suspended) {
      return res.status(403).json({ error: 'Account suspended' });
    }
    // Invalidate sessions issued before password change
    if (authInfo.passwordChangedAt) {
      const changedAtSeconds = Math.floor(new Date(authInfo.passwordChangedAt + 'Z').getTime() / 1000);
      if (payload.iat < changedAtSeconds) {
        return res.status(401).json({ error: 'Session invalidated — please log in again' });
      }
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Always verify admin status from DB, not just the token
  const user = get('SELECT is_admin FROM users WHERE id = ?', [req.user.userId]);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}
