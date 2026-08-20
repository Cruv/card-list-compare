import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
 * Dev-only fallback secret, persisted next to the database so it survives the
 * restarts of `node --watch`. A per-process random value would log the developer
 * out on every file save; a hardcoded value must never exist in the repo.
 */
function devSecret() {
  try {
    const dbPath = process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'x.db');
    const dir = dirname(dbPath);
    const file = join(dir, '.jwt-dev-secret');
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing.length >= MIN_SECRET_LENGTH) return existing;
    }
    const generated = randomBytes(32).toString('hex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Read-only filesystem or similar — fall back to a per-process secret.
    return randomBytes(32).toString('hex');
  }
}

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
    const supplied = typeof secret === 'string' && secret.length > 0;
    if (env.NODE_ENV === 'production' || supplied) {
      // A secret the operator actually supplied is never silently replaced — a
      // random substitute would invalidate every session on each restart while
      // looking like it worked. Too weak is an error to fix, not to paper over.
      throw new Error(
        (supplied ? 'JWT_SECRET is too weak' : 'JWT_SECRET must be set') +
          ' — use at least ' + MIN_SECRET_LENGTH +
          ' chars and not a known default. Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }
    return { secret: devSecret(), ephemeral: true };
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
