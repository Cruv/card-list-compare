import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory, db, router, token;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'clc-admin-export-'));
  vi.stubEnv('DB_PATH', join(directory, 'test.db'));
  vi.stubEnv('JWT_SECRET', 'disposable-admin-export-test-secret');
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  (await import('../lib/integrationSchema.js')).initIntegrationSchema();
  (await import('../lib/manasyncBridge.js')).initBridgeSchema();
  db.run("INSERT INTO users(id,username,password_hash,is_admin) VALUES (1,'admin','unused',1)");
  db.run("INSERT INTO tracked_owners(id,user_id,archidekt_username) VALUES (1,1,'owner')");
  db.run("INSERT INTO tracked_decks(id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES (1,1,1,1,'Deck')");
  db.run("INSERT INTO deck_snapshots(tracked_deck_id,deck_text) VALUES (1,'1 Sol Ring')");
  db.run("INSERT INTO integration_tokens(id,user_id,name,token_hash,scopes,created_at) VALUES ('fixture-token',1,'fixture','unused','[]','now')");
  db.run("INSERT INTO manasync_connections(user_id,base_url,token_cipher,account_id,actor_id,username) VALUES (1,'https://example.test','unused','account','actor','fixture')");
  db.run("INSERT INTO manasync_print_items(id,user_id,deck_id,card_json,quantity,created_at) VALUES ('item',1,1,'{}',1,'now')");
  db.run("INSERT INTO manasync_print_operations(id,user_id,item_id,quantity,intent_json,status,created_at) VALUES ('operation',1,'item',1,'{}','pending','now')");
  token = (await import('../middleware/auth.js')).createToken({ id: 1, username: 'admin', is_admin: 1 });
  router = (await import('./admin.js')).default;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function request(url) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: { authorization: `Bearer ${token}` } };
    const headers = {};
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      set(value) { Object.assign(headers, value); return this; },
      json(body) { resolve({ status: this.statusCode, body, headers }); return this; },
      send(body) { resolve({ status: this.statusCode, body, headers }); return this; } };
    router.handle(req, res, error => error ? reject(error) : resolve({ status: 404 }));
  });
}

it.each(['/stats', '/backup'])('%s preserves foreign keys for the next account deletion', async path => {
  const result = await request(path);
  expect(result.status).toBe(200);
  if (path === '/stats') expect(result.body.dbSizeBytes).toBeGreaterThan(512);
  else {
    expect(result.headers['Content-Type']).toBe('application/octet-stream');
    expect(result.body.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
  }
  expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
  // No intervening write or transaction: the first destructive helper must
  // cascade, before persist() has a chance to repair connection pragmas.
  db.run('DELETE FROM users WHERE id = 1');
  for (const table of ['tracked_owners', 'tracked_decks', 'deck_snapshots', 'integration_tokens',
    'manasync_connections', 'manasync_print_items', 'manasync_print_operations']) {
    expect(db.get(`SELECT COUNT(*) AS count FROM ${table}`).count, table).toBe(0);
  }
});
