import { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { hashToken, INTEGRATION_SCOPES } from '../middleware/integrationAuth.js';

const router = Router();
router.use(requireAuth);

function publicToken(row) {
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes),
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

router.get('/', (req, res) => {
  res.json({ tokens: all('SELECT * FROM integration_tokens WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.userId]).map(publicToken) });
});

router.post('/', (req, res) => {
  const { name, scopes, expiresAt = null } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
      !Array.isArray(scopes) || !scopes.length || scopes.some(scope => !INTEGRATION_SCOPES.includes(scope)) ||
      (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))) {
    return res.status(400).json({ error: 'invalid_token_settings' });
  }
  const token = `clc_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  run(`INSERT INTO integration_tokens (id,user_id,name,token_hash,scopes,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?)`, [id, req.user.userId, name.trim(), hashToken(token), JSON.stringify([...new Set(scopes)].sort()),
    expiresAt === null ? null : new Date(expiresAt).toISOString(), new Date().toISOString()]);
  res.status(201).json({ token, ...publicToken(get('SELECT * FROM integration_tokens WHERE id = ?', [id])) });
});

router.delete('/:tokenId', (req, res) => {
  const row = get('SELECT * FROM integration_tokens WHERE id = ? AND user_id = ?', [req.params.tokenId, req.user.userId]);
  if (!row) return res.status(404).json({ error: 'token_not_found' });
  run('UPDATE integration_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [new Date().toISOString(), row.id]);
  res.json({ revoked: true, id: row.id });
});

export default router;
