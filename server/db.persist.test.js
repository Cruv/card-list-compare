import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'fs';
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

const transactionHelpers = {
  transaction: (db, statements) => db.transaction(() => {
    for (const { sql, params = [] } of statements) db.run(sql, params);
  }),
  runTransaction: (db, statements) => db.runTransaction(statements),
};

describe.each(Object.entries(transactionHelpers))('%s durable transactions', (_name, transact) => {
  it('enforces foreign keys throughout the transaction and rolls back all statements on failure', async () => {
    const db = await import('./db.js');
    await db.initDb();
    const before = readFileSync(dbPath);

    expect(() => transact(db, [
      { sql: "INSERT INTO server_settings (key, value) VALUES ('atomic-probe', 'must-rollback')" },
      { sql: "INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (999, 'orphan')" },
    ])).toThrow(/FOREIGN KEY/);

    expect(db.get("SELECT value FROM server_settings WHERE key = 'atomic-probe'")).toBeNull();
    expect(db.all('SELECT * FROM tracked_owners')).toEqual([]);
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it('restores committed writes in memory when persistence fails and permits a durable retry', async () => {
    const db = await import('./db.js');
    await db.initDb();
    const before = readFileSync(dbPath);
    const statements = [
      { sql: "INSERT INTO server_settings (key, value) VALUES ('atomic-state', 'changed')" },
      { sql: "INSERT INTO server_settings (key, value) VALUES ('atomic-receipt', 'accepted')" },
    ];
    mkdirSync(`${dbPath}.tmp`);
    expect(() => transact(db, statements)).toThrow();

    expect(db.get("SELECT value FROM server_settings WHERE key = 'atomic-state'")).toBeNull();
    expect(db.get("SELECT value FROM server_settings WHERE key = 'atomic-receipt'")).toBeNull();
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    expect(readFileSync(dbPath)).toEqual(before);

    rmSync(`${dbPath}.tmp`, { recursive: true });
    transact(db, statements);
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    vi.resetModules();
    const restarted = await import('./db.js');
    await restarted.initDb();
    expect(restarted.get("SELECT value FROM server_settings WHERE key = 'atomic-state'")?.value).toBe('changed');
    expect(restarted.get("SELECT value FROM server_settings WHERE key = 'atomic-receipt'")?.value).toBe('accepted');
  });
});

describe('transaction() callback contract', () => {
  it('rejects a read export inside a transaction without discarding its writes', async () => {
    const db = await import('./db.js');
    await db.initDb();
    db.transaction(() => {
      db.run("INSERT INTO server_settings (key, value) VALUES ('before-export', 'preserved')");
      expect(() => db.exportDatabase()).toThrow('Cannot export the database during a transaction');
      db.run("INSERT INTO server_settings (key, value) VALUES ('after-export', 'preserved')");
    });
    expect(db.get("SELECT value FROM server_settings WHERE key = 'before-export'")?.value).toBe('preserved');
    expect(db.get("SELECT value FROM server_settings WHERE key = 'after-export'")?.value).toBe('preserved');
  });

  it('returns the callback result and persists helper writes together after the callback completes', async () => {
    const db = await import('./db.js');
    await db.initDb();
    const before = readFileSync(dbPath);
    const result = db.transaction(() => {
      const inserted = db.run("INSERT INTO users (username,password_hash) VALUES ('alice','h')");
      db.run('INSERT INTO tracked_owners (user_id,archidekt_username) VALUES (?, ?)', [inserted.lastInsertRowid, 'alice']);
      expect(readFileSync(dbPath)).toEqual(before);
      return inserted.lastInsertRowid;
    });

    expect(db.get('SELECT user_id FROM tracked_owners')?.user_id).toBe(result);
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    expect(readFileSync(dbPath)).not.toEqual(before);
  });

  it.each(Object.entries(transactionHelpers))('rejects nested %s calls without exporting the active transaction', async (_name, transact) => {
    const db = await import('./db.js');
    await db.initDb();
    db.transaction(() => {
      db.run("INSERT INTO server_settings (key, value) VALUES ('outer-write', 'survived')");
      expect(() => transact(db, [])).toThrow(/Nested transactions/);
      expect(db.get("SELECT value FROM server_settings WHERE key = 'outer-write'")?.value).toBe('survived');
    });
    expect(db.get("SELECT value FROM server_settings WHERE key = 'outer-write'")?.value).toBe('survived');
  });
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

  it('preserves foreign keys after persistence/backup and cascades account deletion through integrations', async () => {
    const db = await import('./db.js');
    await db.initDb();
    const { initIntegrationSchema } = await import('./lib/integrationSchema.js');
    initIntegrationSchema();
    const { initBridgeSchema } = await import('./lib/manasyncBridge.js');
    initBridgeSchema();
    db.run("INSERT INTO users (id,username,password_hash) VALUES (1,'alice','h')");
    db.run("INSERT INTO tracked_owners (id,user_id,archidekt_username) VALUES (1,1,'alice')");
    db.run("INSERT INTO tracked_decks (id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES (1,1,1,1,'Deck')");
    db.run("INSERT INTO deck_snapshots (tracked_deck_id,deck_text) VALUES (1,'1 Sol Ring')");
    db.run("INSERT INTO integration_tokens (id,user_id,name,token_hash,scopes,created_at) VALUES ('token',1,'ManaSync','hash','[]','now')");
    db.run(`INSERT INTO deck_proposals (id,user_id,deck_id,operation_id,payload_hash,base_snapshot_id,base_text_hash,base_text,proposed_text,status,created_at,updated_at)
      VALUES ('proposal',1,1,'operation','hash','1','hash','base','proposed','pending_review','now','now')`);
    db.run("INSERT INTO proposal_reviews (user_id,operation_id,proposal_id,payload_hash,receipt) VALUES (1,'review','proposal','hash','{}')");
    db.run("INSERT INTO manasync_connections (user_id,base_url,token_cipher,account_id,actor_id,username) VALUES (1,'http://app:8081','cipher','account','actor','alice')");
    db.run("INSERT INTO manasync_print_items (id,user_id,deck_id,card_json,quantity,created_at) VALUES ('item',1,1,'{}',2,'now')");
    db.run("INSERT INTO manasync_print_operations (id,user_id,item_id,quantity,intent_json,status,created_at) VALUES ('print',1,'item',2,'{}','pending','now')");
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    db.backupDb();
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    db.transaction(() => db.run('DELETE FROM users WHERE id = 1'));
    for (const table of ['tracked_owners','tracked_decks','deck_snapshots','integration_tokens','deck_proposals','proposal_reviews','manasync_connections','manasync_print_items','manasync_print_operations']) {
      expect(db.get(`SELECT COUNT(*) AS count FROM ${table}`).count,table).toBe(0);
    }
    db.run("INSERT INTO users (id,username,password_hash) VALUES (1,'replacement','h')");
    expect(db.get('SELECT * FROM manasync_connections WHERE user_id = 1')).toBeNull();
    expect(() => db.run("INSERT INTO integration_tokens (id,user_id,name,token_hash,scopes,created_at) VALUES ('orphan',999,'bad','orphan-hash','[]','now')")).toThrow(/FOREIGN KEY/);
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
