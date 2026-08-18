import { describe, it, expect } from 'vitest';
import { isWeakSecret, resolveJwtSecret } from './jwtSecret.js';

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

  it('falls back to an ephemeral random secret outside production', () => {
    const { secret, ephemeral } = resolveJwtSecret({ NODE_ENV: 'development' });
    expect(ephemeral).toBe(true);
    expect(secret).toHaveLength(64); // 32 random bytes as hex
    // A second resolution yields a different random secret.
    const again = resolveJwtSecret({ NODE_ENV: 'development' });
    expect(again.secret).not.toBe(secret);
  });
});
