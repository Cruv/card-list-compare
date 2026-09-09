import { randomUUID } from 'node:crypto';
import { getDb, transaction, run, get } from '../db.js';

export function initIntegrationSchema() {
  transaction(() => {
    run(`CREATE TABLE IF NOT EXISTS integration_tokens (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
    )`);
    run(`CREATE TABLE IF NOT EXISTS deck_proposals (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      deck_id INTEGER NOT NULL REFERENCES tracked_decks(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      base_snapshot_id TEXT NOT NULL, base_text_hash TEXT NOT NULL, base_text TEXT NOT NULL,
      proposed_text TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
      result_snapshot_id TEXT, result_text_hash TEXT, reviewed_text TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, deck_id, operation_id)
    )`);
    run(`CREATE TABLE IF NOT EXISTS proposal_reviews (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES deck_proposals(id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL, receipt TEXT NOT NULL,
      PRIMARY KEY(user_id, operation_id)
    )`);
    // Keep the receipt if the deck is later deleted: replay must not resurrect it.
    run(`CREATE TABLE IF NOT EXISTS integration_deck_creations (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      deck_id INTEGER NOT NULL, receipt TEXT NOT NULL,
      PRIMARY KEY(user_id, operation_id)
    )`);
    const columns = getDb().exec('PRAGMA table_info(deck_snapshots)')[0].values;
    if (!columns.some(column => column[1] === 'origin_proposal_id')) {
      run('ALTER TABLE deck_snapshots ADD COLUMN origin_proposal_id TEXT');
    }
    run('CREATE INDEX IF NOT EXISTS idx_proposal_deck ON deck_proposals(deck_id, created_at)');
    run("INSERT OR IGNORE INTO server_settings (key, value) VALUES ('clc_instance_id', ?)", [randomUUID()]);
  });
}

export function getInstanceId() {
  return get("SELECT value FROM server_settings WHERE key = 'clc_instance_id'").value;
}
