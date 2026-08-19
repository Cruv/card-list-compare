import crypto from 'crypto';

/** A URL-safe random token (32 bytes → 64 hex chars). Emailed to the user raw. */
export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * SHA-256 of a token. Only the hash is stored, so a DB read (or admin backup)
 * can't replay a live email-verification or password-reset token — lookups hash
 * the incoming value and compare (audit). No salt needed: the token itself has
 * 256 bits of entropy.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
