import { randomBytes } from 'crypto';

// Secrets that must never sign real tokens. Includes the historical
// docker-compose placeholder — a deploy that keeps a public default value can be
// forged, so it is refused here as well as by the compose fail-fast.
const KNOWN_WEAK_SECRETS = new Set([
  'dev-secret-do-not-use-in-production',
  'change-me-in-production',
  'secret',
  'changeme',
  'password',
  'jwt_secret',
]);

const MIN_SECRET_LENGTH = 16;

/**
 * A secret is weak if it is missing, too short, or a known placeholder.
 */
export function isWeakSecret(secret) {
  if (!secret || typeof secret !== 'string') return true;
  if (secret.length < MIN_SECRET_LENGTH) return true;
  return KNOWN_WEAK_SECRETS.has(secret);
}

/**
 * Resolve the JWT secret for the current environment.
 * - Strong secret set → use it.
 * - Weak/missing in production → throw (fatal; refuse to start).
 * - Weak/missing outside production → generate an ephemeral per-process random
 *   secret so dev works with no config and no hardcoded secret ever ships. Tokens
 *   do not survive a restart, which is the correct trade-off for local dev.
 *
 * Pure and env-injectable so the branch logic is unit-testable.
 */
export function resolveJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (isWeakSecret(secret)) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'JWT_SECRET must be set to a strong, unique value (at least ' +
          MIN_SECRET_LENGTH +
          ' chars, not a known default) in production. Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }
    return { secret: randomBytes(32).toString('hex'), ephemeral: true };
  }
  return { secret, ephemeral: false };
}

let cached = null;

/**
 * Memoized accessor used by the auth layer. Resolves once per process.
 * In production, first call throws if the secret is weak — index.js calls this
 * eagerly at startup so the failure is fatal-at-boot, not per-request.
 */
export function getJwtSecret() {
  if (cached) return cached;
  const { secret, ephemeral } = resolveJwtSecret();
  if (ephemeral) {
    console.warn(
      'WARNING: JWT_SECRET is unset or weak — using an ephemeral random secret. ' +
        'All sessions reset on restart. Set a strong JWT_SECRET before deploying.'
    );
  }
  cached = secret;
  return cached;
}

// Test-only: drop the memoized value so a test can re-resolve under a new env.
export function _resetJwtSecretCache() {
  cached = null;
}
