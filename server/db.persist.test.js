import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// db.js reads DB_PATH from the environment at import time and keeps a module-level
// singleton, so each test sets a fresh temp path and resets the module registry.
let dir;
let dbPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clc-db-'));
  dbPath = join(dir, 'test.db');
  process.env.DB_PATH = dbPath;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

describe('persist() atomic write (audit C3)', () => {
  it('writes the live file and leaves no temp file behind', async () => {
    const db = await import('./db.js');
    await db.initDb();
    db.run("INSERT INTO server_settings (key, value) VALUES ('probe', 'v1')");

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.tmp`)).toBe(false);
    expect(db.get("SELECT value FROM server_settings WHERE key = 'probe'").value).toBe('v1');
  });

  it('keeps a .bak backup that recovers data when the live file is corrupted', async () => {
    let db = await import('./db.js');
    await db.initDb();
    db.run("INSERT INTO server_settings (key, value) VALUES ('probe', 'survived')");
    db.backupDb();
    expect(existsSync(`${dbPath}.bak`)).toBe(true);

    // Simulate a torn / corrupt live file, then cold-start again.
    writeFileSync(dbPath, Buffer.from('this is not a sqlite database'));
    vi.resetModules();
    db = await import('./db.js');
    await db.initDb();

    const row = db.get("SELECT value FROM server_settings WHERE key = 'probe'");
    expect(row?.value).toBe('survived');
  });

  it('refuses to start (rather than wiping) when the live file is corrupt and no backup exists', async () => {
    const db = await import('./db.js');
    writeFileSync(dbPath, Buffer.from('garbage, not a database'));
    await expect(db.initDb()).rejects.toThrow(/could not be loaded/i);
  });

  it('recovers from .bak when the live file is ZERO BYTES (sql.js accepts an empty buffer)', async () => {
    let db = await import('./db.js');
    await db.initDb();
    db.run("INSERT INTO server_settings (key, value) VALUES ('probe', 'survived')");
    db.backupDb();

    // A truncating write that never delivered bytes: the file exists but is empty.
    writeFileSync(dbPath, Buffer.alloc(0));
    vi.resetModules();
    db = await import('./db.js');
    await db.initDb();

    expect(db.get("SELECT value FROM server_settings WHERE key = 'probe'")?.value).toBe('survived');
    // …and the good backup must still hold the data after recovery.
    db.backupDb();
    expect(existsSync(`${dbPath}.bak`)).toBe(true);
    expect(statSync(`${dbPath}.bak`).size).toBeGreaterThan(512);
  });

  it('recovers from .bak when the live file is a truncated prefix of a real database', async () => {
    let db = await import('./db.js');
    await db.initDb();
    db.run("INSERT INTO server_settings (key, value) VALUES ('probe', 'survived')");
    db.backupDb();

    // Valid SQLite header, but the file is cut short — the case a non-atomic
    // write used to produce.
    const good = readFileSync(dbPath);
    writeFileSync(dbPath, good.subarray(0, 1024));
    vi.resetModules();
    db = await import('./db.js');
    await db.initDb();

    expect(db.get("SELECT value FROM server_settings WHERE key = 'probe'")?.value).toBe('survived');
  });

  it('ignores a leftover zero-byte .tmp instead of loading it as an empty database', async () => {
    let db = await import('./db.js');
    await db.initDb();
    db.run("INSERT INTO server_settings (key, value) VALUES ('probe', 'survived')");

    writeFileSync(`${dbPath}.tmp`, Buffer.alloc(0)); // crashed mid-write
    vi.resetModules();
    db = await import('./db.js');
    await db.initDb();

    expect(db.get("SELECT value FROM server_settings WHERE key = 'probe'")?.value).toBe('survived');
  });
});
