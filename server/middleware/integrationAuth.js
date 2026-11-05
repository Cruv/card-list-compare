import { createHash } from 'node:crypto';
import { get } from '../db.js';
import { requireAuth } from './auth.js';

export const INTEGRATION_SCOPES = ['decks:read', 'decks:propose', 'decks:create'];
const LEGACY_SESSION_SCOPES = ['decks:read', 'decks:propose'];
export const hashToken = token => createHash('sha256').update(token).digest('hex');

// Integration credentials are accepted only at explicitly scoped routes.
// Existing session routes keep their ordinary login-token behavior.
export function requireIntegration(scope) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token.startsWith('clc_')) {
      return requireAuth(req, res, () => {
        // Existing login-token integrations retain their former permissions.
        // Immediate creation requires a newly issued, explicitly scoped token.
        if (scope && !LEGACY_SESSION_SCOPES.includes(scope)) {
          return res.status(403).json({ error: 'insufficient_scope', requiredScope: scope });
        }
        req.integrationScopes = [...LEGACY_SESSION_SCOPES];
        next();
      });
    }
    const row = get(`SELECT t.*, u.username, u.suspended FROM integration_tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, [hashToken(token)]);
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Integration token is invalid, expired, or revoked.' });
    }
    if (row.suspended) return res.status(403).json({ error: 'account_suspended' });
    const scopes = JSON.parse(row.scopes);
    if (scope && !scopes.includes(scope)) {
      return res.status(403).json({ error: 'insufficient_scope', requiredScope: scope });
    }
    req.user = { userId: row.user_id, username: row.username, isAdmin: false };
    req.integrationScopes = scopes;
    req.integrationTokenId = row.id;
    next();
  };
}
