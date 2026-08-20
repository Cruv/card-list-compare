import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isWeakSecret, resolveJwtSecret } from './jwtSecret.js';

// The dev-secret fallback persists a file next to DB_PATH — point it at a temp
// dir so the suite never writes into the repo.
let secretDir;
beforeAll(() => {
  secretDir = mkdtempSync(join(tmpdir(), 'clc-jwt-'));
  process.env.DB_PATH = join(secretDir, 'test.db');
});
afterAll(() => {
  rmSync(secretDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

describe('isWeakSecret', () => {
  it('rejects missing, empty, and non-string secrets', () => {
    expect(isWeakSecret(undefined)).toBe(true);
    expect(isWeakSecret('')).toBe(true);
    expect(isWeakSecret(null)).toBe(true);
    expect(isWeakSecret(12345)).toBe(true);
  });

  it('rejects the docker-compose placeholder and other known defaults', () => {
    expect(isWeakSecret('change-me-in-production')).toBe(true);
    expect(isWeakSecret('dev-secret-do-not-use-in-production')).toBe(true);
    expect(isWeakSecret('secret')).toBe(true);
    expect(isWeakSecret('changeme')).toBe(true);
    expect(isWeakSecret('password')).toBe(true);
    expect(isWeakSecret('jwt_secret')).toBe(true);
  });

  it('rejects too-short secrets', () => {
    expect(isWeakSecret('short')).toBe(true);
    expect(isWeakSecret('123456789012345')).toBe(true); // 15 chars
  });

  it('accepts a strong secret', () => {
    expect(isWeakSecret('a'.repeat(16))).toBe(false);
    expect(isWeakSecret('f3a9c1e0b7d24e6f8a0c1b2d3e4f5a6b')).toBe(false);
  });
});

describe('resolveJwtSecret', () => {
  it('throws in production when the secret is weak or missing', () => {
    expect(() => resolveJwtSecret({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() =>
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'change-me-in-production' })
    ).toThrow(/JWT_SECRET/);
    expect(() =>
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'short' })
    ).toThrow(/JWT_SECRET/);
  });

  it('uses a strong production secret as-is', () => {
    const strong = 'f3a9c1e0b7d24e6f8a0c1b2d3e4f5a6b';
    const { secret, ephemeral } = resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: strong });
    expect(secret).toBe(strong);
    expect(ephemeral).toBe(false);
  });

  it('falls back to a generated dev secret when none is set outside production', () => {
    const { secret, ephemeral } = resolveJwtSecret({ NODE_ENV: 'development' });
    expect(ephemeral).toBe(true);
    expect(secret).toHaveLength(64); // 32 random bytes as hex
  });

  it('reuses the same dev secret across restarts so `node --watch` does not log you out', () => {
    const first = resolveJwtSecret({ NODE_ENV: 'development' }).secret;
    const second = resolveJwtSecret({ NODE_ENV: 'development' }).secret;
    expect(second).toBe(first);
  });

  it('refuses a supplied-but-weak secret instead of silently substituting one', () => {
    // Silently swapping in a random value would invalidate every session on each
    // restart while looking like the configured secret was honored.
    expect(() => resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'short' })).toThrow(/too weak/i);
  });
});
