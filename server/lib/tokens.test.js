import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateToken, hashToken } from './tokens.js';

describe('token hashing (audit: plaintext tokens)', () => {
  it('generates 64-hex-char tokens and hashes deterministically', () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe('abc');
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('DB round-trip', () => {
    let dir;
    let db;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'clc-tok-'));
      process.env.DB_PATH = join(dir, 'test.db');
      vi.resetModules();
      db = await import('../db.js');
      await db.initDb();
      db.run("INSERT INTO users (username, password_hash) VALUES ('u', 'h')");
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.DB_PATH;
    });

    it('stores only the hash — findable by hashed lookup, never by the raw token', () => {
      const raw = generateToken();
      const expires = new Date(Date.now() + 3600_000).toISOString();
      db.run('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (1, ?, ?)', [hashToken(raw), expires]);

      // The raw token is nowhere in the table.
      expect(db.get('SELECT * FROM password_reset_tokens WHERE token = ?', [raw])).toBe(null);
      // But the hashed lookup (what reset-password does) finds it.
      const found = db.get('SELECT * FROM password_reset_tokens WHERE token = ?', [hashToken(raw)]);
      expect(found).toBeTruthy();
      expect(found.user_id).toBe(1);
    });
  });
});
